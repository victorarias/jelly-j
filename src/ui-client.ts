import { createConnection, type Socket } from "node:net";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { handleSlashCommand, type ModelAlias } from "./commands.js";
import { DAEMON_SOCKET_PATH } from "./state.js";
import {
  printError,
  printNote,
  printToolUse,
  renderTurnEnd,
  renderWelcome,
  Spinner,
  StreamWriter,
} from "./ui.js";
import {
  encodeMessage,
  type ClientToDaemonMessage,
  type DaemonToClientMessage,
  type HistoryEntry,
  type ZellijEnvContext,
} from "./protocol.js";
import { detectZellijBinary } from "./zellij.js";

const EXIT_ALIASES = new Set(["exit", "bye", "quit", "q"]);
const DAEMON_REGISTRATION_TIMEOUT_MS = 2_500;

type UiSessionState = {
  currentModel: ModelAlias;
  activeRequestId?: string;
  spinner?: Spinner;
  writer: StreamWriter;
  readlinePaused: boolean;
  sawAssistantText: boolean;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rolePrefix(role: HistoryEntry["role"]): string {
  if (role === "user") return "you";
  if (role === "assistant") return "jelly";
  if (role === "error") return "error";
  return "note";
}

function formatHistoryEntry(entry: HistoryEntry): string {
  const sessionPart = entry.session ? ` [${entry.session}]` : "";
  return `${rolePrefix(entry.role)}${sessionPart}: ${entry.text}`;
}

function send(socket: Socket, message: ClientToDaemonMessage): void {
  socket.write(encodeMessage(message));
}

function stopSpinner(state: UiSessionState): void {
  if (state.spinner?.isRunning()) {
    state.spinner.stop();
  }
}

function restorePrompt(
  rl: ReturnType<typeof createInterface>,
  state: UiSessionState,
  display: (text: string) => void
): void {
  stopSpinner(state);
  state.writer.flushLine();
  display(renderTurnEnd(state.currentModel));
  if (state.readlinePaused) {
    rl.resume();
    state.readlinePaused = false;
  }
  state.activeRequestId = undefined;
  state.sawAssistantText = false;
  rl.prompt();
}

function renderHistory(entries: HistoryEntry[], display: (text: string) => void): void {
  if (entries.length === 0) return;
  printNote("replayed history:", display);
  for (const entry of entries) {
    display(`  ${formatHistoryEntry(entry)}\n`);
  }
  printNote("end replay", display);
}

export async function runUiClient(): Promise<void> {
  const display = (text: string) => process.stdout.write(text);
  const clientId = `ui-${process.pid}-${Date.now().toString(36)}`;
  const zellijSession = normalizeString(process.env.ZELLIJ_SESSION_NAME);
  const zellijBinary = await detectZellijBinary(zellijSession);
  const zellijEnv: ZellijEnvContext = {
    ZELLIJ: normalizeString(process.env.ZELLIJ),
    ZELLIJ_SESSION_NAME: zellijSession,
    zellijBinary,
  };

  const socket = createConnection(DAEMON_SOCKET_PATH);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let state: UiSessionState = {
    currentModel: "opus",
    writer: new StreamWriter(display),
    readlinePaused: false,
    sawAssistantText: false,
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  send(socket, {
    type: "register_client",
    clientId,
    zellijSession,
    zellijEnv,
    cwd: process.cwd(),
    hostname: os.hostname(),
    pid: process.pid,
  });

  let started = false;
  let shuttingDown = false;
  let lastSigintAtMs = 0;
  let buffer = "";
  let registrationTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    printError(
      "daemon is connected but did not complete startup handshake. restart with: npm run ops:restart",
      display
    );
    socket.destroy();
    process.exit(1);
  }, DAEMON_REGISTRATION_TIMEOUT_MS);

  function parseIncoming(line: string): DaemonToClientMessage | undefined {
    try {
      return JSON.parse(line) as DaemonToClientMessage;
    } catch {
      return undefined;
    }
  }

  function handleIncoming(message: DaemonToClientMessage): void {
    switch (message.type) {
      case "registered": {
        if (registrationTimer) {
          clearTimeout(registrationTimer);
          registrationTimer = undefined;
        }
        state.currentModel = message.model;
        if (!started) {
          started = true;
          display(renderWelcome(state.currentModel));
          rl.prompt();
        }
        break;
      }
      case "history_snapshot": {
        renderHistory(message.entries, display);
        break;
      }
      case "status_note": {
        state.writer.flushLine();
        printNote(message.message, display);
        if (!state.activeRequestId) {
          rl.prompt();
        }
        break;
      }
      case "chat_start": {
        if (state.activeRequestId !== message.requestId) break;
        if (!state.spinner) {
          state.spinner = new Spinner("thinking", display);
          state.spinner.start();
        }
        break;
      }
      case "chat_delta": {
        if (state.activeRequestId !== message.requestId) break;
        stopSpinner(state);
        state.sawAssistantText = true;
        state.writer.write(message.text);
        break;
      }
      case "tool_use": {
        if (state.activeRequestId !== message.requestId) break;
        stopSpinner(state);
        state.writer.flushLine();
        printToolUse(message.name, display);
        break;
      }
      case "result_error": {
        if (state.activeRequestId !== message.requestId) break;
        stopSpinner(state);
        state.writer.flushLine();
        printError(`[${message.subtype}] ${message.errors.join("; ")}`, display);
        break;
      }
      case "chat_end": {
        if (state.activeRequestId !== message.requestId) break;
        restorePrompt(rl, state, display);
        break;
      }
      case "model_updated": {
        state.currentModel = message.alias;
        printNote(`model changed: ${message.alias}`, display);
        if (!state.activeRequestId) {
          rl.prompt();
        }
        break;
      }
      case "error": {
        state.writer.flushLine();
        printError(message.message, display);
        if (message.requestId && state.activeRequestId === message.requestId) {
          restorePrompt(rl, state, display);
        } else if (!state.activeRequestId) {
          rl.prompt();
        }
        break;
      }
      case "pong": {
        break;
      }
      default:
        break;
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;

      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      const parsed = parseIncoming(line);
      if (!parsed) {
        printError("received invalid daemon message", display);
        continue;
      }

      handleIncoming(parsed);
    }
  });

  socket.on("error", (error) => {
    if (shuttingDown) return;
    if (registrationTimer) {
      clearTimeout(registrationTimer);
      registrationTimer = undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    printError(`daemon connection error: ${message}`, display);
    process.exit(1);
  });

  socket.on("close", () => {
    if (shuttingDown) return;
    if (registrationTimer) {
      clearTimeout(registrationTimer);
      registrationTimer = undefined;
    }
    printError("daemon disconnected", display);
    process.exit(1);
  });

  rl.on("line", (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (state.activeRequestId) {
      printNote("still processing previous request", display);
      rl.prompt();
      return;
    }

    if (EXIT_ALIASES.has(input.toLowerCase())) {
      printNote('exit/quit is disabled. Use Alt+j to hide/show Jelly J.', display);
      rl.prompt();
      return;
    }

    const commandResult = handleSlashCommand(input, state.currentModel);
    if (commandResult.handled) {
      if (commandResult.isError) {
        printError(commandResult.message, display);
      } else {
        printNote(commandResult.message, display);
      }

      if (!commandResult.isError && commandResult.nextModel !== state.currentModel) {
        const requestId = randomUUID();
        send(socket, {
          type: "set_model",
          requestId,
          clientId,
          alias: commandResult.nextModel,
        });
      }

      if (!commandResult.isError && commandResult.resetSession) {
        const requestId = randomUUID();
        send(socket, {
          type: "new_session",
          requestId,
          clientId,
          zellijSession,
        });
      }

      rl.prompt();
      return;
    }

    display("\n");
    rl.pause();
    state.readlinePaused = true;

    const requestId = randomUUID();
    state.activeRequestId = requestId;
    state.spinner = new Spinner("thinking", display);
    state.spinner.start();

    send(socket, {
      type: "chat_request",
      requestId,
      clientId,
      text: input,
      zellijSession,
      zellijEnv,
    });
  });

  const handleSigint = () => {
    const now = Date.now();
    if (now - lastSigintAtMs < 120) {
      return;
    }
    lastSigintAtMs = now;
    display("\n");
    printNote("Ctrl-C does not exit Jelly J. Use Alt+j to hide/show.", display);
    rl.prompt();
  };

  rl.on("SIGINT", handleSigint);
  process.on("SIGINT", handleSigint);

  rl.on("close", () => {
    shuttingDown = true;
    if (registrationTimer) {
      clearTimeout(registrationTimer);
      registrationTimer = undefined;
    }
    socket.end();
    process.exit(0);
  });
}
