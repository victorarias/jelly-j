import type { ModelAlias } from "./commands.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";

const COLOR_CODES = {
  muted: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  success: "\x1b[32m",
  error: "\x1b[31m",
  meta: "\x1b[34m",
} as const;

const SPINNER_FRAMES = ["-", "\\", "|", "/"];

export type UiState = "idle" | "thinking" | "tool" | "error";

type TranscriptPrefix = "you" | "jj" | "tool" | "note" | "error";

type HeaderContext = {
  model: ModelAlias;
  sessionId?: string;
  state: UiState;
};

type DisplayFn = (text: string) => void;

function colorize(text: string, color: keyof typeof COLOR_CODES): string {
  return `${COLOR_CODES[color]}${text}${ANSI_RESET}`;
}

function bold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

function padPrefix(prefix: TranscriptPrefix): string {
  return prefix.padEnd(5, " ");
}

function formatPrefix(prefix: TranscriptPrefix): string {
  if (prefix === "error") return colorize(padPrefix(prefix), "error");
  if (prefix === "note") return colorize(padPrefix(prefix), "muted");
  if (prefix === "tool") return colorize(padPrefix(prefix), "muted");
  if (prefix === "you") return colorize(padPrefix(prefix), "meta");
  return colorize(padPrefix(prefix), "info");
}

let spinnerIndex = 0;

function stateBadge(state: UiState): string {
  if (state === "idle") return colorize("idle", "success");
  if (state === "error") return colorize("error", "error");

  spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  const label = `${SPINNER_FRAMES[spinnerIndex]} ${state}`;
  return colorize(label, "warn");
}

function shortSessionId(sessionId?: string): string {
  if (!sessionId) return "new";
  return sessionId.slice(0, 6);
}

export function renderHeader(ctx: HeaderContext): string {
  const app = bold(colorize("Jelly J", "info"));
  const modelLabel = `${colorize("model:", "muted")} ${colorize(ctx.model, "meta")}`;
  const sessionLabel = `${colorize("session:", "muted")} ${colorize(shortSessionId(ctx.sessionId), "meta")}`;
  const stateLabel = `${colorize("state:", "muted")} ${stateBadge(ctx.state)}`;

  return `${app}  ${modelLabel}  ${sessionLabel}  ${stateLabel}`;
}

export function printTranscriptLine(
  prefix: TranscriptPrefix,
  message: string,
  display: DisplayFn
): void {
  const lines = message.split("\n");
  for (const line of lines) {
    display(`${formatPrefix(prefix)} ${line}\n`);
  }
}

export function formatToolUse(
  name: string,
  input: Record<string, unknown>
): string {
  const args = Object.entries(input)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");

  return args ? `${name} ${args}` : name;
}

export class PrefixedStreamWriter {
  private atLineStart = true;

  constructor(
    private readonly prefix: TranscriptPrefix,
    private readonly display: DisplayFn
  ) {}

  write(text: string): void {
    for (const char of text) {
      if (this.atLineStart) {
        this.display(`${formatPrefix(this.prefix)} `);
        this.atLineStart = false;
      }

      this.display(char);

      if (char === "\n") {
        this.atLineStart = true;
      }
    }
  }

  flushLine(): void {
    if (!this.atLineStart) {
      this.display("\n");
      this.atLineStart = true;
    }
  }
}
