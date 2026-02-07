import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10_000;

export interface ZellijResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a `zellij action` subcommand and return stdout/stderr.
 * Throws on non-zero exit code or timeout (10s).
 */
export async function zellijAction(
  ...args: string[]
): Promise<ZellijResult> {
  const { stdout, stderr } = await execFileAsync(
    "zellij",
    ["action", ...args],
    { timeout: TIMEOUT_MS }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
