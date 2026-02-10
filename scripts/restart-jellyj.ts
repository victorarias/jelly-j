import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCK_PATH = path.join(os.homedir(), ".jelly-j", "agent.lock.json");
const TERM_WAIT_MS = 2_000;
const CMD_TIMEOUT_MS = 5_000;

type LockOwner = {
  pid?: number;
  zellijSession?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

async function readLockOwner(): Promise<LockOwner | undefined> {
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      zellijSession:
        typeof parsed.zellijSession === "string" ? parsed.zellijSession : undefined,
    };
  } catch {
    return undefined;
  }
}

async function stopExistingAgentFromLock(): Promise<{ stoppedPid?: number; forced: boolean }> {
  const owner = await readLockOwner();
  if (!owner?.pid) return { forced: false };

  const pid = owner.pid;
  if (!processIsAlive(pid)) {
    try {
      await unlink(LOCK_PATH);
    } catch {
      // best effort stale-lock cleanup
    }
    return { forced: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { forced: false };
  }

  const deadline = Date.now() + TERM_WAIT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return { stoppedPid: pid, forced: false };
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
    return { stoppedPid: pid, forced: true };
  } catch {
    return { stoppedPid: pid, forced: false };
  }
}

async function relaunchJellyJPane(): Promise<void> {
  await execFileAsync(
    "zellij",
    ["run", "-f", "--name", "Jelly J", "--", "jelly-j"],
    { timeout: CMD_TIMEOUT_MS }
  );
}

async function main(): Promise<void> {
  const stopResult = await stopExistingAgentFromLock();
  await relaunchJellyJPane();

  if (stopResult.stoppedPid) {
    const mode = stopResult.forced ? "SIGKILL" : "SIGTERM";
    process.stdout.write(`Restarted Jelly J (stopped pid ${stopResult.stoppedPid} via ${mode}).\n`);
  } else {
    process.stdout.write("Started Jelly J in a new floating pane.\n");
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`restart failed: ${message}\n`);
  process.exit(1);
});
