import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelAlias } from "./commands.js";

const LOG_DIR = path.join(os.homedir(), ".jelly-j");
const HEARTBEAT_LOG_PATH = path.join(LOG_DIR, "heartbeat.log");
const TRANSCRIPT_LOG_PATH = path.join(LOG_DIR, "transcript.log");

const writeQueues = new Map<string, Promise<void>>();

function timestamp(): string {
  return new Date().toISOString();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function appendQueued(filePath: string, payload: string): void {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(filePath, payload, "utf8");
    })
    .catch(() => {
      // Best-effort logging only; never disrupt chat flow.
    });

  writeQueues.set(filePath, next);
}

export function logHeartbeatInfo(message: string): void {
  appendQueued(HEARTBEAT_LOG_PATH, `${timestamp()} [INFO] ${oneLine(message)}\n`);
}

export function logHeartbeatError(message: string): void {
  appendQueued(HEARTBEAT_LOG_PATH, `${timestamp()} [ERROR] ${oneLine(message)}\n`);
}

export function logTranscriptTurn(params: {
  model: ModelAlias;
  user: string;
  assistant: string;
  error?: string;
}): void {
  const header = `${timestamp()} model=${params.model}`;
  const userText = params.user.trimEnd() || "(empty)";
  const assistantText = params.assistant.trimEnd() || "(no text)";
  const errorSection = params.error ? `\nERROR:\n${params.error.trimEnd()}` : "";
  const payload = `${header}\nUSER:\n${userText}\nASSISTANT:\n${assistantText}${errorSection}\n\n`;
  appendQueued(TRANSCRIPT_LOG_PATH, payload);
}
