import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

type RegisteredMessage = {
  type: "registered";
  daemonPid: number;
  model: "opus" | "haiku";
};

type HistorySnapshotMessage = {
  type: "history_snapshot";
  entries: Array<{ text: string }>;
};

type PongMessage = {
  type: "pong";
  requestId: string;
  daemonPid: number;
};

const SOCKET_WAIT_TIMEOUT_MS = 6_000;
const CLIENT_TIMEOUT_MS = 6_000;
const CHAT_TIMEOUT_MS = 90_000;
const SHUTDOWN_WAIT_MS = 2_000;
const SKIP_CHAT_PROBE = process.env.JJ_SKIP_CHAT_PROBE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  daemonState: { exitCode: number | null; signal: NodeJS.Signals | null },
  readDaemonLog: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemonState.exitCode !== null || daemonState.signal !== null) {
      throw new Error(
        `daemon exited before socket became ready (exitCode=${daemonState.exitCode}, signal=${daemonState.signal}): ${readDaemonLog()}`
      );
    }
    try {
      const socketStat = await stat(socketPath);
      if (socketStat.isSocket()) {
        return;
      }
    } catch {
      // best effort
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for daemon socket: ${socketPath}; daemonLog=${readDaemonLog()}`
  );
}

async function connectClient(params: {
  socketPath: string;
  clientId: string;
  zellijSession: string;
}): Promise<{
  registered: RegisteredMessage;
  historySnapshot: HistorySnapshotMessage;
  pong: PongMessage;
}> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(params.socketPath);
    let buffer = "";
    let registered: RegisteredMessage | undefined;
    let historySnapshot: HistorySnapshotMessage | undefined;
    let pong: PongMessage | undefined;
    const requestId = `${params.clientId}-ping`;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for daemon responses for ${params.clientId}`));
    }, CLIENT_TIMEOUT_MS);

    const done = () => {
      if (!registered || !historySnapshot || !pong) return;
      clearTimeout(timeout);
      socket.end();
      resolve({ registered, historySnapshot, pong });
    };

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "register_client",
          clientId: params.clientId,
          zellijSession: params.zellijSession,
          cwd: process.cwd(),
          hostname: os.hostname(),
          pid: process.pid,
        })}\n`
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        const message = JSON.parse(line) as { type?: string; requestId?: string };

        if (message.type === "registered") {
          registered = message as RegisteredMessage;
          socket.write(
            `${JSON.stringify({
              type: "ping",
              requestId,
              clientId: params.clientId,
            })}\n`
          );
        } else if (message.type === "history_snapshot") {
          historySnapshot = message as HistorySnapshotMessage;
        } else if (message.type === "pong" && message.requestId === requestId) {
          pong = message as PongMessage;
        }

        done();
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runChatProbe(params: {
  socketPath: string;
  clientId: string;
  zellijSession: string;
  text: string;
}): Promise<{
  ok: boolean;
  assistantText: string;
  errorMessage?: string;
  statusNotes: string[];
}> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(params.socketPath);
    let buffer = "";
    const requestId = `${params.clientId}-chat`;
    const statusNotes: string[] = [];
    let assistantText = "";
    let errorMessage: string | undefined;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for chat probe response for ${params.clientId}`));
    }, CHAT_TIMEOUT_MS);

    const finish = (ok: boolean) => {
      clearTimeout(timeout);
      socket.end();
      resolve({
        ok,
        assistantText: assistantText.trim(),
        errorMessage,
        statusNotes,
      });
    };

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "register_client",
          clientId: params.clientId,
          zellijSession: params.zellijSession,
          cwd: process.cwd(),
          hostname: os.hostname(),
          pid: process.pid,
        })}\n`
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        const message = JSON.parse(line) as {
          type?: string;
          requestId?: string;
          text?: string;
          ok?: boolean;
          message?: string;
        };

        if (message.type === "history_snapshot") {
          socket.write(
            `${JSON.stringify({
              type: "chat_request",
              requestId,
              clientId: params.clientId,
              text: params.text,
              zellijSession: params.zellijSession,
            })}\n`
          );
        } else if (message.type === "status_note" && typeof message.message === "string") {
          statusNotes.push(message.message);
        } else if (
          message.type === "chat_delta" &&
          message.requestId === requestId &&
          typeof message.text === "string"
        ) {
          assistantText += message.text;
        } else if (
          message.type === "error" &&
          message.requestId === requestId &&
          typeof message.message === "string"
        ) {
          errorMessage = message.message;
        } else if (message.type === "chat_end" && message.requestId === requestId) {
          finish(message.ok === true);
        }
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(50);
  }
  child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..", "..");
  const entrypoint = path.join(repoRoot, "src", "index.ts");
  const tempRoot = await mkdtemp("/tmp/jellyj-global-presence-");
  const stateDir = path.join(tempRoot, ".jelly-j");
  const socketPath = path.join(stateDir, "daemon.sock");
  const historyPath = path.join(stateDir, "history.jsonl");
  const statePath = path.join(stateDir, "state.json");

  await mkdir(stateDir, { recursive: true });
  await appendFile(
    historyPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      role: "note",
      session: "seed-session",
      text: "seed-history-entry",
    })}\n`,
    "utf8"
  );
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        sessionId: "00000000-0000-0000-0000-000000000000",
        zellijSession: "seed-session",
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const daemon = spawn(process.execPath, [entrypoint, "daemon"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JELLY_J_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  const daemonState: { exitCode: number | null; signal: NodeJS.Signals | null } = {
    exitCode: null,
    signal: null,
  };
  daemon.on("exit", (code, signal) => {
    daemonState.exitCode = code;
    daemonState.signal = signal;
  });
  daemon.stdout?.on("data", (chunk) => {
    daemonLog += chunk.toString("utf8");
  });
  daemon.stderr?.on("data", (chunk) => {
    daemonLog += chunk.toString("utf8");
  });

  try {
    await waitForSocket(socketPath, SOCKET_WAIT_TIMEOUT_MS, daemonState, () =>
      daemonLog.trim().slice(-500)
    );

    const a = await connectClient({
      socketPath,
      clientId: `harness-a-${Date.now().toString(36)}`,
      zellijSession: "session-a",
    });
    const b = await connectClient({
      socketPath,
      clientId: `harness-b-${Date.now().toString(36)}`,
      zellijSession: "session-b",
    });
    const chatProbe = SKIP_CHAT_PROBE
      ? undefined
      : await runChatProbe({
          socketPath,
          clientId: `harness-chat-${Date.now().toString(36)}`,
          zellijSession: "session-a",
          text: "Reply with exactly: ok",
        });

    const sameDaemonPid =
      a.registered.daemonPid === b.registered.daemonPid &&
      a.pong.daemonPid === b.pong.daemonPid;
    const hasSharedHistory =
      a.historySnapshot.entries.some((entry) => entry.text === "seed-history-entry") &&
      b.historySnapshot.entries.some((entry) => entry.text === "seed-history-entry");
    const chatRecoveredFromStaleSession = SKIP_CHAT_PROBE
      ? true
      : chatProbe !== undefined &&
        chatProbe.ok &&
        /\bok\b/i.test(chatProbe.assistantText);

    if (!sameDaemonPid || !hasSharedHistory || !chatRecoveredFromStaleSession) {
      throw new Error(
        [
          "global-presence assertions failed:",
          `sameDaemonPid=${sameDaemonPid}`,
          `hasSharedHistory=${hasSharedHistory}`,
          `chatRecoveredFromStaleSession=${chatRecoveredFromStaleSession}`,
          `chatProbeSkipped=${SKIP_CHAT_PROBE}`,
          `chatProbeOk=${chatProbe?.ok ?? "n/a"}`,
          `chatProbeError=${chatProbe?.errorMessage ?? "none"}`,
          `chatProbeText=${JSON.stringify(chatProbe?.assistantText ?? "")}`,
          `chatProbeStatusNotes=${JSON.stringify(chatProbe?.statusNotes ?? [])}`,
        ].join(" ")
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        phase: "summary",
        ok: true,
        daemonPid: a.registered.daemonPid,
        historyEntriesClientA: a.historySnapshot.entries.length,
        historyEntriesClientB: b.historySnapshot.entries.length,
        chatProbeSkipped: SKIP_CHAT_PROBE,
        chatProbeOk: chatProbe?.ok ?? null,
        chatProbeText: chatProbe?.assistantText ?? null,
        chatProbeStatusNotes: chatProbe?.statusNotes ?? [],
      })}\n`
    );
  } finally {
    await stopChild(daemon);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ phase: "error", message })}\n`);
  process.exit(1);
});
