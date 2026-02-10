import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".jelly-j");
const STATE_PATH = path.join(STATE_DIR, "state.json");

export interface JellyState {
  sessionId?: string;
  zellijSession?: string;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
