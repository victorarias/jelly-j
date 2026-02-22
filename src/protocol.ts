import type { ModelAlias } from "./commands.js";

export type HistoryRole = "user" | "assistant" | "note" | "error";

export interface HistoryEntry {
  timestamp: string;
  session?: string;
  role: HistoryRole;
  text: string;
}

/**
 * Zellij environment context captured by the UI client.
 * Contains the env vars needed for `zellij action` / `zellij pipe` to work.
 */
export interface ZellijEnvContext {
  /** ZELLIJ env var — IPC socket path required by `zellij action` / `zellij pipe`. */
  ZELLIJ?: string;
  /** ZELLIJ_SESSION_NAME env var — session name. */
  ZELLIJ_SESSION_NAME?: string;
  /** Resolved path to the zellij binary that matches the running server version. */
  zellijBinary?: string;
}

export type ClientToDaemonMessage =
  | {
      type: "register_client";
      clientId: string;
      zellijSession?: string;
      zellijEnv?: ZellijEnvContext;
      cwd?: string;
      hostname?: string;
      pid?: number;
    }
  | {
      type: "chat_request";
      requestId: string;
      clientId: string;
      text: string;
      zellijSession?: string;
      zellijEnv?: ZellijEnvContext;
    }
  | {
      type: "set_model";
      requestId: string;
      clientId: string;
      alias: ModelAlias;
    }
  | {
      type: "new_session";
      requestId: string;
      clientId: string;
      zellijSession?: string;
    }
  | {
      type: "restart_daemon";
      requestId: string;
      clientId: string;
    }
  | {
      type: "ping";
      requestId: string;
      clientId: string;
    };

export type DaemonToClientMessage =
  | {
      type: "registered";
      clientId: string;
      daemonPid: number;
      model: ModelAlias;
      busy: boolean;
    }
  | {
      type: "history_snapshot";
      entries: HistoryEntry[];
    }
  | {
      type: "status_note";
      message: string;
    }
  | {
      type: "chat_start";
      requestId: string;
      model: ModelAlias;
      queuedAhead: number;
    }
  | {
      type: "chat_delta";
      requestId: string;
      text: string;
    }
  | {
      type: "tool_use";
      requestId: string;
      name: string;
    }
  | {
      type: "result_error";
      requestId: string;
      subtype: string;
      errors: string[];
    }
  | {
      type: "chat_end";
      requestId: string;
      ok: boolean;
      model: ModelAlias;
    }
  | {
      type: "model_updated";
      requestId: string;
      alias: ModelAlias;
    }
  | {
      type: "pong";
      requestId: string;
      daemonPid: number;
    }
  | {
      type: "new_session_result";
      requestId: string;
      ok: boolean;
      message: string;
    }
  | {
      type: "restart_result";
      requestId: string;
      ok: boolean;
      message: string;
    }
  | {
      type: "error";
      requestId?: string;
      message: string;
    };

export function encodeMessage(message: ClientToDaemonMessage | DaemonToClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}
