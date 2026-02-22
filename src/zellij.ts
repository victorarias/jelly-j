import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { ZellijEnvContext } from "./protocol.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

export interface ZellijResult {
  stdout: string;
  stderr: string;
}

/**
 * Active Zellij env context, updated per chat turn from the requesting UI client.
 * This is necessary because the daemon is a long-lived detached process whose own
 * environment may not have the ZELLIJ IPC socket vars, or may have stale ones from
 * the session that originally spawned it.
 */
let activeZellijEnv: ZellijEnvContext | undefined;

/**
 * Set the active Zellij env context for subsequent zellij commands.
 * Called by the daemon before each chat turn with the requesting client's env.
 */
export function setActiveZellijEnv(env: ZellijEnvContext | undefined): void {
  activeZellijEnv = env;
}

/**
 * Get the current active Zellij env context.
 */
export function getActiveZellijEnv(): ZellijEnvContext | undefined {
  return activeZellijEnv;
}

export function buildZellijEnv(): NodeJS.ProcessEnv {
  if (!activeZellijEnv) return process.env;
  const env = { ...process.env };
  if (activeZellijEnv.ZELLIJ) {
    env.ZELLIJ = activeZellijEnv.ZELLIJ;
  }
  if (activeZellijEnv.ZELLIJ_SESSION_NAME) {
    env.ZELLIJ_SESSION_NAME = activeZellijEnv.ZELLIJ_SESSION_NAME;
  }
  return env;
}

/**
 * Resolve the zellij binary path.
 *
 * Priority:
 * 1. JELLY_J_ZELLIJ_PATH env var (explicit override)
 * 2. zellijBinary from the active ZellijEnvContext (auto-detected by UI client)
 * 3. "zellij" (fall back to PATH lookup)
 *
 * The auto-detection is important because the user may have multiple zellij
 * versions installed (e.g. 0.43.1 from Nix and 0.44.0 from a local build).
 * The CLI must match the server version or `zellij action` fails with
 * "There is no active session!".
 */
export function resolveZellijBinary(): string {
  const explicit = process.env.JELLY_J_ZELLIJ_PATH?.trim();
  if (explicit) return explicit;
  if (activeZellijEnv?.zellijBinary) return activeZellijEnv.zellijBinary;
  return "zellij";
}

/**
 * Run a `zellij action` subcommand and return stdout/stderr.
 * Throws on non-zero exit code or timeout (10s).
 */
export async function zellijAction(
  ...args: string[]
): Promise<ZellijResult> {
  const { stdout, stderr } = await execFileAsync(
    resolveZellijBinary(),
    ["action", ...args],
    { timeout: TIMEOUT_MS, env: buildZellijEnv() }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Auto-detect the zellij binary for a running session by finding the server
 * process via /proc. Returns the binary path or undefined if not found.
 */
export async function detectZellijBinary(
  sessionName: string | undefined
): Promise<string | undefined> {
  if (!sessionName) return undefined;
  if (process.platform !== "linux") return undefined;

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", `zellij.*--server.*${sessionName}`], {
      timeout: 3_000,
    });
    const pid = stdout.trim().split("\n")[0]?.trim();
    if (!pid || !/^\d+$/.test(pid)) return undefined;

    const binary = await readlink(`/proc/${pid}/exe`);
    return binary || undefined;
  } catch {
    return undefined;
  }
}
