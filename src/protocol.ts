import type { ModelAlias } from "./commands.js";

export type HistoryRole = "user" | "assistant" | "note" | "error";

export interface HistoryEntry {
  timestamp: string;
  session?: string;
  role: HistoryRole;
  text: string;
}

export type ClientToDaemonMessage =
  | {
      type: "register_client";
      clientId: string;
      zellijSession?: string;
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
    }
  | {
      type: "set_model";
      requestId: string;
      clientId: string;
      alias: ModelAlias;
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
      type: "error";
      requestId?: string;
      message: string;
    };

export function encodeMessage(message: ClientToDaemonMessage | DaemonToClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}
