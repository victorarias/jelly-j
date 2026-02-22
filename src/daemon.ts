import { createServer, type Socket } from "node:net";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { chat } from "./agent.js";
import { modelIdForAlias, type ModelAlias } from "./commands.js";
import { appendHistoryEntry, readHistorySnapshot } from "./history.js";
import { startHeartbeat, stopHeartbeat, setBusy, updateHeartbeatZellijEnv } from "./heartbeat.js";
import { logTranscriptTurn } from "./logging.js";
import {
  acquireAgentLock,
  DAEMON_SOCKET_PATH,
  readState,
  releaseAgentLock,
  STATE_DIR,
  writeState,
} from "./state.js";
import {
  encodeMessage,
  type ClientToDaemonMessage,
  type DaemonToClientMessage,
  type ZellijEnvContext,
} from "./protocol.js";
import { setActiveZellijEnv } from "./zellij.js";

type ClientConnection = {
  socket: Socket;
  clientId?: string;
  zellijSession?: string;
  zellijEnv?: ZellijEnvContext;
};

type PendingChatRequest = {
  requestId: string;
  clientId: string;
  text: string;
  zellijSession?: string;
  zellijEnv?: ZellijEnvContext;
};

const TRACE_PATH = path.join(STATE_DIR, "daemon.trace.log");
const TRACE_ENABLED = process.env.JELLY_J_DAEMON_TRACE === "1";

const traceQueue: { current: Promise<void> } = { current: Promise.resolve() };

function trace(message: string): void {
  if (!TRACE_ENABLED) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  traceQueue.current = traceQueue.current
    .then(async () => {
      await mkdir(STATE_DIR, { recursive: true });
      await appendFile(TRACE_PATH, line, "utf8");
    })
    .catch(() => {
      // best effort
    });
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function send(socket: Socket, message: DaemonToClientMessage): void {
  if (socket.destroyed) return;
  socket.write(encodeMessage(message));
}

function requestTimeContext(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  return `Current local time for this request: ${now.toISOString()} (${tz}).`;
}

function isStaleResumeError(text: string): boolean {
  return /no conversation found with session id/i.test(text);
}

function hasOnlyStaleResumeErrors(errors: string[]): boolean {
  return errors.length > 0 && errors.every((entry) => isStaleResumeError(entry));
}

function isRecoverableResumeResultError(params: {
  sessionId?: string;
  assistantText: string;
  resultError: string;
}): boolean {
  if (!params.sessionId) return false;
  if (params.assistantText.trim().length > 0) return false;
  return isStaleResumeError(params.resultError);
}

function shouldRetryWithFreshSession(params: {
  errorMessage: string;
  sessionId?: string;
  assistantText: string;
  resultErrors: string[];
}): boolean {
  if (!params.sessionId) return false;
  if (params.assistantText.trim().length > 0) return false;
  const staleResumeErrors = hasOnlyStaleResumeErrors(params.resultErrors);
  if (staleResumeErrors) return true;

  if (/claude code process exited with code 1/i.test(params.errorMessage)) {
    return params.resultErrors.length === 0 || staleResumeErrors;
  }

  return false;
}

export async function runDaemon(): Promise<void> {
  const lockStatus = await acquireAgentLock(undefined);
  if (!lockStatus.acquired) {
    // Daemon already running.
    trace("lock_not_acquired");
    return;
  }
  trace(`daemon_started pid=${process.pid}`);

  const persistedState = await readState();
  let sessionId: string | undefined = persistedState.sessionId;
  let lastActiveSession: string | undefined = persistedState.zellijSession;
  let currentModel: ModelAlias = "opus";

  const clientsBySocket = new Map<Socket, ClientConnection>();
  const clientsById = new Map<string, ClientConnection>();
  const queue: PendingChatRequest[] = [];
  let processing = false;
  let cleaningUp = false;

  async function cleanupAndExit(exitCode = 0): Promise<void> {
    if (cleaningUp) return;
    cleaningUp = true;
    trace(`cleanup exitCode=${exitCode}`);
    stopHeartbeat();
    try {
      server.close();
    } catch {
      // best effort
    }

    try {
      await unlink(DAEMON_SOCKET_PATH);
    } catch {
      // best effort
    }

    await releaseAgentLock();
    process.exit(exitCode);
  }

  function sendToClientId(clientId: string, message: DaemonToClientMessage): void {
    const connection = clientsById.get(clientId);
    if (!connection) return;
    send(connection.socket, message);
  }

  function broadcast(message: DaemonToClientMessage): void {
    for (const connection of clientsBySocket.values()) {
      send(connection.socket, message);
    }
  }

  async function persistDaemonState(session: string | undefined): Promise<void> {
    await writeState({
      sessionId,
      zellijSession: session,
    });
  }

  async function processQueue(): Promise<void> {
    if (processing) return;
    const next = queue.shift();
    if (!next) return;
    processing = true;
    setBusy(true);

    let assistantText = "";
    let hadError = false;
    const resultErrors: string[] = [];

    const client = clientsById.get(next.clientId);
    const currentSession = normalizeString(next.zellijSession) ?? normalizeString(client?.zellijSession);

    // Set the active Zellij env context so zellij action/pipe commands use the
    // correct IPC socket from the requesting client's Zellij session.
    const zellijEnv = next.zellijEnv ?? client?.zellijEnv;
    setActiveZellijEnv(zellijEnv);
    trace(`zellij_env ZELLIJ=${zellijEnv?.ZELLIJ ?? "(unset)"} session=${zellijEnv?.ZELLIJ_SESSION_NAME ?? "(unset)"}`);

    const sessionContextNotes = [requestTimeContext()];
    if (currentSession && lastActiveSession && currentSession !== lastActiveSession) {
      sessionContextNotes.push(
        `You are now in zellij session "${currentSession}" (previously "${lastActiveSession}"). Tab and pane state may have changed.`
      );
    }
    const sessionContextNote =
      sessionContextNotes.length > 0 ? sessionContextNotes.join("\n") : undefined;
    const sessionSwitched =
      currentSession && lastActiveSession && currentSession !== lastActiveSession
        ? true
        : false;

    if (sessionSwitched) {
      sendToClientId(next.clientId, {
        type: "status_note",
        message: `session switched: ${lastActiveSession ?? "unknown"} -> ${currentSession}`,
      });
    }

    sendToClientId(next.clientId, {
      type: "chat_start",
      requestId: next.requestId,
      model: currentModel,
      queuedAhead: 0,
    });

    await appendHistoryEntry({
      role: "user",
      text: next.text,
      session: currentSession,
    });

    try {
      const streamEvents = {
        onText: (text: string) => {
          assistantText += text;
          sendToClientId(next.clientId, {
            type: "chat_delta",
            requestId: next.requestId,
            text,
          });
        },
        onToolUse: ({ name }: { name: string }) => {
          sendToClientId(next.clientId, {
            type: "tool_use",
            requestId: next.requestId,
            name,
          });
        },
        onResultError: (subtype: string, errors: string[]) => {
          hadError = true;
          const formatted = `[${subtype}] ${errors.join("; ")}`;
          resultErrors.push(formatted);
          if (
            isRecoverableResumeResultError({
              sessionId,
              assistantText,
              resultError: formatted,
            })
          ) {
            trace("buffered_recoverable_resume_result_error");
            return;
          }
          sendToClientId(next.clientId, {
            type: "result_error",
            requestId: next.requestId,
            subtype,
            errors,
          });
        },
        onPermissionRequest: (toolName: string, reason: string) => {
          sendToClientId(next.clientId, {
            type: "status_note",
            message: `permission requested: ${toolName} (${reason})`,
          });
        },
      };

      const runChatAttempt = async (resumeSessionId: string | undefined) => {
        return await chat(
          next.text,
          resumeSessionId,
          modelIdForAlias(currentModel),
          sessionContextNote,
          streamEvents,
          { nonInteractive: true }
        );
      };

      const resetAttemptState = () => {
        assistantText = "";
        hadError = false;
        resultErrors.length = 0;
      };

      let result: { sessionId?: string };
      try {
        result = await runChatAttempt(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          shouldRetryWithFreshSession({
            errorMessage: message,
            sessionId,
            assistantText,
            resultErrors,
          })
        ) {
          trace("resume_failed_retrying_fresh_session");
          sendToClientId(next.clientId, {
            type: "status_note",
            message:
              "previous Claude session could not be resumed; retrying with a fresh session",
          });
          sessionId = undefined;
          resetAttemptState();
          result = await runChatAttempt(undefined);
        } else {
          throw error;
        }
      }

      if (
        hadError &&
        shouldRetryWithFreshSession({
          errorMessage: "",
          sessionId,
          assistantText,
          resultErrors,
        })
      ) {
        trace("resume_result_error_retrying_fresh_session");
        sendToClientId(next.clientId, {
          type: "status_note",
          message: "stale Claude session detected; retrying with a fresh session",
        });
        sessionId = undefined;
        resetAttemptState();
        result = await runChatAttempt(undefined);
      }

      sessionId = result.sessionId;
      lastActiveSession = currentSession;
      await persistDaemonState(lastActiveSession);

      if (!hadError) {
        await appendHistoryEntry({
          role: "assistant",
          text: assistantText.trimEnd() || "(no text)",
          session: currentSession,
        });
      } else {
        await appendHistoryEntry({
          role: "error",
          text: resultErrors.join("\n"),
          session: currentSession,
        });
      }

      logTranscriptTurn({
        model: currentModel,
        user: next.text,
        assistant: assistantText,
        error: resultErrors.length > 0 ? resultErrors.join("\n") : undefined,
      });

      sendToClientId(next.clientId, {
        type: "chat_end",
        requestId: next.requestId,
        ok: !hadError,
        model: currentModel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hadError = true;
      await appendHistoryEntry({
        role: "error",
        text: message,
        session: currentSession,
      });
      sendToClientId(next.clientId, {
        type: "error",
        requestId: next.requestId,
        message,
      });
      sendToClientId(next.clientId, {
        type: "chat_end",
        requestId: next.requestId,
        ok: false,
        model: currentModel,
      });
    } finally {
      processing = false;
      setBusy(false);
      void processQueue();
    }
  }

  async function handleRegister(connection: ClientConnection, message: Extract<ClientToDaemonMessage, { type: "register_client" }>): Promise<void> {
    trace(`register clientId=${message.clientId} session=${message.zellijSession ?? ""}`);
    connection.clientId = message.clientId;
    connection.zellijSession = normalizeString(message.zellijSession);
    connection.zellijEnv = message.zellijEnv;
    updateHeartbeatZellijEnv(message.zellijEnv);
    clientsById.set(message.clientId, connection);

    send(connection.socket, {
      type: "registered",
      clientId: message.clientId,
      daemonPid: process.pid,
      model: currentModel,
      busy: processing,
    });

    const history = await readHistorySnapshot();
    trace(`register history_entries=${history.length}`);
    send(connection.socket, {
      type: "history_snapshot",
      entries: history,
    });
  }

  function parseMessage(raw: string): ClientToDaemonMessage | undefined {
    try {
      const parsed = JSON.parse(raw) as ClientToDaemonMessage;
      if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function handleMessage(connection: ClientConnection, message: ClientToDaemonMessage): Promise<void> {
    switch (message.type) {
      case "register_client": {
        await handleRegister(connection, message);
        break;
      }
      case "chat_request": {
        queue.push({
          requestId: message.requestId,
          clientId: message.clientId,
          text: message.text,
          zellijSession: normalizeString(message.zellijSession),
          zellijEnv: message.zellijEnv,
        });
        const queuedAhead = Math.max(0, queue.length - 1 + (processing ? 1 : 0));
        if (queuedAhead > 0) {
          sendToClientId(message.clientId, {
            type: "status_note",
            message: `request queued (${queuedAhead} ahead)`,
          });
        }
        void processQueue();
        break;
      }
      case "set_model": {
        currentModel = message.alias;
        broadcast({
          type: "model_updated",
          requestId: message.requestId,
          alias: currentModel,
        });
        break;
      }
      case "new_session": {
        if (processing || queue.length > 0) {
          sendToClientId(message.clientId, {
            type: "error",
            requestId: message.requestId,
            message: "cannot start a new session while requests are in progress",
          });
          break;
        }

        sessionId = undefined;
        const requestedSession = normalizeString(message.zellijSession);
        if (requestedSession) {
          lastActiveSession = requestedSession;
        }
        await persistDaemonState(lastActiveSession);

        sendToClientId(message.clientId, {
          type: "status_note",
          message: "new Claude session created (future turns start fresh)",
        });
        break;
      }
      case "ping": {
        sendToClientId(message.clientId, {
          type: "pong",
          requestId: message.requestId,
          daemonPid: process.pid,
        });
        break;
      }
      default: {
        send(connection.socket, {
          type: "error",
          message: "unsupported message type",
        });
      }
    }
  }

  const server = createServer((socket) => {
    trace("socket_connected");
    const connection: ClientConnection = { socket };
    clientsBySocket.set(socket, connection);

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const parsed = parseMessage(line);
        if (!parsed) {
          trace("invalid_json_message");
          send(socket, {
            type: "error",
            message: "invalid json message",
          });
          continue;
        }

        trace(`message type=${parsed.type}`);
        void handleMessage(connection, parsed);
      }
    });

    socket.on("close", () => {
      trace("socket_closed");
      clientsBySocket.delete(socket);
      if (connection.clientId) {
        clientsById.delete(connection.clientId);
      }
    });

    socket.on("error", () => {
      // best effort; close handler cleans maps
    });
  });

  server.on("error", (error) => {
    trace(`server_error code=${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
    // If another daemon won the race and bound first, just exit.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      void cleanupAndExit(0);
      return;
    }
    void cleanupAndExit(1);
  });

  await mkdir(STATE_DIR, { recursive: true });
  try {
    await unlink(DAEMON_SOCKET_PATH);
  } catch {
    // ignore stale or missing socket
  }

  await new Promise<void>((resolve) => {
    server.listen(DAEMON_SOCKET_PATH, resolve);
  });
  trace(`listening socket=${DAEMON_SOCKET_PATH}`);

  startHeartbeat();

  process.on("SIGTERM", () => {
    void cleanupAndExit(0);
  });

  process.on("SIGINT", () => {
    void cleanupAndExit(0);
  });

  process.on("SIGHUP", () => {
    void cleanupAndExit(0);
  });

  process.on("uncaughtException", () => {
    void cleanupAndExit(1);
  });

  process.on("unhandledRejection", () => {
    void cleanupAndExit(1);
  });
}
