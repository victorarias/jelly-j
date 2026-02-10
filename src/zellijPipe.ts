import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 8_000;
const TOGGLE_TIMEOUT_MS = 3_000;

const DEFAULT_PLUGIN_URL = `file:${path.join(
  os.homedir(),
  ".config",
  "zellij",
  "plugins",
  "jelly-j.wasm"
)}`;

type PipeResponse<T> =
  | {
      ok: true;
      result: T;
    }
  | {
      ok: false;
      code?: string;
      error: string;
    };

export class ZellijPipeError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ZellijPipeError";
  }
}

function pipeExecError(error: unknown, timeoutMs: number): ZellijPipeError {
  if (error instanceof Error) {
    const maybeErr = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
      timedOut?: boolean;
    };
    if (maybeErr.code === "ETIMEDOUT" || maybeErr.signal === "SIGTERM" || maybeErr.timedOut) {
      return new ZellijPipeError(
        `Butler pipe timed out after ${timeoutMs}ms`,
        "timeout"
      );
    }
    return new ZellijPipeError(maybeErr.message, maybeErr.code);
  }
  return new ZellijPipeError(String(error));
}

export interface ButlerTab {
  position: number;
  name: string;
  active: boolean;
  selectable_tiled_panes_count: number;
  selectable_floating_panes_count: number;
}

export interface ButlerPane {
  id: number;
  tab_index: number;
  title: string;
  terminal_command?: string;
  is_plugin: boolean;
  is_focused: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  exited: boolean;
}

export interface ButlerState {
  tabs: ButlerTab[];
  panes: ButlerPane[];
}

type ButlerRequest =
  | { op: "ping" }
  | { op: "get_state" }
  | { op: "get_trace"; limit?: number }
  | { op: "clear_trace" }
  | { op: "rename_tab"; position: number; name: string }
  | { op: "rename_pane"; pane_id: number; name: string }
  | { op: "hide_pane"; pane_id: number }
  | {
      op: "show_pane";
      pane_id: number;
      should_float_if_hidden?: boolean;
      should_focus_pane?: boolean;
    };

function pluginUrl(): string {
  return process.env.JELLY_J_PLUGIN_URL?.trim() || DEFAULT_PLUGIN_URL;
}

async function pipeRequest<T>(payload: ButlerRequest): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "zellij",
      [
        "pipe",
        "--plugin",
        pluginUrl(),
        "--name",
        "request",
        "--",
        JSON.stringify(payload),
      ],
      { timeout: REQUEST_TIMEOUT_MS }
    ));
  } catch (error) {
    throw pipeExecError(error, REQUEST_TIMEOUT_MS);
  }

  const raw = stdout.trim();
  if (!raw) {
    throw new ZellijPipeError("Butler pipe returned an empty response.");
  }

  let parsed: PipeResponse<T>;
  try {
    parsed = JSON.parse(raw) as PipeResponse<T>;
  } catch (error) {
    throw new ZellijPipeError(
      `Butler pipe returned invalid JSON: ${raw}`,
      error instanceof Error ? error.name : "parse_error"
    );
  }

  if (!parsed.ok) {
    throw new ZellijPipeError(parsed.error, parsed.code);
  }

  return parsed.result;
}

export async function pingButler(): Promise<void> {
  await pipeRequest<{ ok: true }>({ op: "ping" });
}

export async function getButlerState(): Promise<ButlerState> {
  return await pipeRequest<ButlerState>({ op: "get_state" });
}

export async function getButlerTrace(limit?: number): Promise<string[]> {
  const result = await pipeRequest<{ entries: string[] }>({
    op: "get_trace",
    limit,
  });
  return result.entries;
}

export async function clearButlerTrace(): Promise<void> {
  await pipeRequest<{ ok: true }>({ op: "clear_trace" });
}

export async function renameTabByPosition(position: number, name: string): Promise<void> {
  await pipeRequest<{ ok: true }>({ op: "rename_tab", position, name });
}

export async function renamePaneById(paneId: number, name: string): Promise<void> {
  await pipeRequest<{ ok: true }>({ op: "rename_pane", pane_id: paneId, name });
}

export async function hidePaneById(paneId: number): Promise<void> {
  await pipeRequest<{ ok: true }>({ op: "hide_pane", pane_id: paneId });
}

export async function showPaneById(
  paneId: number,
  shouldFloatIfHidden = true,
  shouldFocusPane = true
): Promise<void> {
  await pipeRequest<{ ok: true }>({
    op: "show_pane",
    pane_id: paneId,
    should_float_if_hidden: shouldFloatIfHidden,
    should_focus_pane: shouldFocusPane,
  });
}

export async function toggleButler(): Promise<void> {
  try {
    await execFileAsync(
      "zellij",
      ["pipe", "--plugin", pluginUrl(), "--name", "toggle", "--", "toggle"],
      { timeout: TOGGLE_TIMEOUT_MS }
    );
  } catch (error) {
    throw pipeExecError(error, TOGGLE_TIMEOUT_MS);
  }
}
