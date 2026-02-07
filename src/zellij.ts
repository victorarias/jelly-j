import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ZellijResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a `zellij action` subcommand and return stdout/stderr.
 * Throws on non-zero exit code.
 */
export async function zellijAction(
  ...args: string[]
): Promise<ZellijResult> {
  const { stdout, stderr } = await execFileAsync("zellij", [
    "action",
    ...args,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Run a top-level `zellij` subcommand (e.g. `zellij list-sessions`).
 */
export async function zellijCommand(
  ...args: string[]
): Promise<ZellijResult> {
  const { stdout, stderr } = await execFileAsync("zellij", args);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
