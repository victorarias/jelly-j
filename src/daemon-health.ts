import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import os from "node:os";
import { DAEMON_SOCKET_PATH } from "./state.js";
import {
  encodeMessage,
  type ClientToDaemonMessage,
  type DaemonToClientMessage,
} from "./protocol.js";

export type DaemonHealthProbeResult = {
  ok: boolean;
  daemonPid?: number;
  error?: string;
};

function send(socket: ReturnType<typeof createConnection>, message: ClientToDaemonMessage): void {
  socket.write(encodeMessage(message));
}

export async function probeDaemonHealth(
  timeoutMs = 1_200
): Promise<DaemonHealthProbeResult> {
  const clientId = `health-${process.pid}-${Date.now().toString(36)}`;
  const requestId = randomUUID();

  return await new Promise<DaemonHealthProbeResult>((resolve) => {
    const socket = createConnection(DAEMON_SOCKET_PATH);
    let settled = false;
    let buffer = "";
    let sawRegistered = false;
    let daemonPid: number | undefined;

    const finish = (result: DaemonHealthProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: sawRegistered
          ? "timeout waiting for daemon pong"
          : "timeout waiting for daemon registration",
      });
    }, timeoutMs);

    socket.once("connect", () => {
      send(socket, {
        type: "register_client",
        clientId,
        zellijSession: process.env.ZELLIJ_SESSION_NAME,
        cwd: process.cwd(),
        hostname: os.hostname(),
        pid: process.pid,
      });
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;

        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let parsed: DaemonToClientMessage | undefined;
        try {
          parsed = JSON.parse(line) as DaemonToClientMessage;
        } catch {
          continue;
        }

        if (parsed.type === "registered") {
          sawRegistered = true;
          daemonPid = parsed.daemonPid;
          send(socket, {
            type: "ping",
            requestId,
            clientId,
          });
          continue;
        }

        if (parsed.type === "pong" && parsed.requestId === requestId) {
          finish({
            ok: true,
            daemonPid: parsed.daemonPid ?? daemonPid,
          });
          return;
        }

        if (parsed.type === "error") {
          finish({
            ok: false,
            daemonPid,
            error: parsed.message,
          });
          return;
        }
      }
    });

    socket.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      finish({
        ok: false,
        error: err.code ? `${err.code}: ${err.message}` : String(error),
      });
    });
  });
}
