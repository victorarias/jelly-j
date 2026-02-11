import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryEntry, HistoryRole } from "./protocol.js";
import { STATE_DIR } from "./state.js";

const HISTORY_PATH = path.join(STATE_DIR, "history.jsonl");
const MAX_SNAPSHOT_ENTRIES = 80;

const writeQueue: { current: Promise<void> } = { current: Promise.resolve() };

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRole(value: unknown): HistoryRole {
  if (value === "user" || value === "assistant" || value === "note" || value === "error") {
    return value;
  }
  return "note";
}

export async function appendHistoryEntry(entry: {
  role: HistoryRole;
  text: string;
  session?: string;
  timestamp?: string;
}): Promise<void> {
  const payload: HistoryEntry = {
    timestamp: entry.timestamp ?? nowIso(),
    session: normalizeString(entry.session),
    role: entry.role,
    text: entry.text,
  };

  const line = `${JSON.stringify(payload)}\n`;
  writeQueue.current = writeQueue.current
    .then(async () => {
      await mkdir(STATE_DIR, { recursive: true });
      await appendFile(HISTORY_PATH, line, "utf8");
    })
    .catch(() => {
      // Best effort only.
    });

  await writeQueue.current;
}

export async function readHistorySnapshot(limit = MAX_SNAPSHOT_ENTRIES): Promise<HistoryEntry[]> {
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const parsed: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const timestamp = normalizeString(value.timestamp) ?? nowIso();
        const text = normalizeString(value.text);
        if (!text) continue;

        parsed.push({
          timestamp,
          session: normalizeString(value.session),
          role: normalizeRole(value.role),
          text,
        });
      } catch {
        // Ignore malformed lines.
      }
    }

    return parsed.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}
