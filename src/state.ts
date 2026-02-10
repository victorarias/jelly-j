import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".jelly-j");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const AGENT_LOCK_PATH = path.join(STATE_DIR, "agent.lock.json");

export interface JellyState {
  sessionId?: string;
  zellijSession?: string;
}

export interface AgentLockOwner {
  pid?: number;
  startedAt?: string;
  hostname?: string;
  zellijSession?: string;
  cwd?: string;
}

export interface AgentLockStatus {
  acquired: boolean;
  owner?: AgentLockOwner;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const asInt = Math.trunc(value);
  return asInt > 0 ? asInt : undefined;
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

function currentLockOwner(zellijSession?: string): AgentLockOwner {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    zellijSession: normalizeString(zellijSession),
    cwd: process.cwd(),
  };
}

async function readAgentLock(): Promise<AgentLockOwner | undefined> {
  try {
    const raw = await readFile(AGENT_LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      pid: normalizeNumber(parsed.pid),
      startedAt: normalizeString(parsed.startedAt),
      hostname: normalizeString(parsed.hostname),
      zellijSession: normalizeString(parsed.zellijSession),
      cwd: normalizeString(parsed.cwd),
    };
  } catch {
    return undefined;
  }
}

async function createAgentLock(owner: AgentLockOwner): Promise<void> {
  const handle = await open(AGENT_LOCK_PATH, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function acquireAgentLock(
  zellijSession?: string
): Promise<AgentLockStatus> {
  await mkdir(STATE_DIR, { recursive: true });
  const owner = currentLockOwner(zellijSession);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await createAgentLock(owner);
      return { acquired: true, owner };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
    }

    const existingOwner = await readAgentLock();
    if (existingOwner?.pid === process.pid) {
      return { acquired: true, owner: existingOwner };
    }
    if (existingOwner?.pid && processIsAlive(existingOwner.pid)) {
      return { acquired: false, owner: existingOwner };
    }

    try {
      await unlink(AGENT_LOCK_PATH);
    } catch {
      // stale lock cleanup is best-effort
    }
  }

  return { acquired: false, owner: await readAgentLock() };
}

export async function releaseAgentLock(): Promise<void> {
  const existingOwner = await readAgentLock();
  if (existingOwner?.pid && existingOwner.pid !== process.pid) {
    return;
  }
  try {
    await unlink(AGENT_LOCK_PATH);
  } catch {
    // already removed
  }
}

export async function readState(): Promise<JellyState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sessionId: normalizeString(parsed.sessionId),
      zellijSession: normalizeString(parsed.zellijSession),
    };
  } catch {
    return {};
  }
}

export async function writeState(state: JellyState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });

  const payload: JellyState = {};
  if (state.sessionId) payload.sessionId = state.sessionId;
  if (state.zellijSession) payload.zellijSession = state.zellijSession;

  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, STATE_PATH);
}
