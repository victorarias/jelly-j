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

// 24-bit ANSI background inspired by pi-mono dark theme
const TOOL_BG = "\x1b[48;2;40;40;50m";

export type UiState = "idle" | "thinking" | "tool" | "error";

type DisplayFn = (text: string) => void;

function colorize(text: string, color: keyof typeof COLOR_CODES): string {
  return `${COLOR_CODES[color]}${text}${ANSI_RESET}`;
}

function bold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

const INDENT = "  ";
const DOT = colorize("·", "muted");

// ── Startup banner ──

const JELLYFISH = [
  "      .~~~.",
  "     ( ◠‿◠ )",
  "      /|||\\",
  "       |||",
];

export function renderWelcome(model: ModelAlias): string {
  const jelly = JELLYFISH.map((l) => colorize(l, "info")).join("\n");
  const name = bold(colorize("Jelly J", "info"));
  const modelBadge = colorize(model, "meta");
  const hints = colorize('/model to switch · "exit" to close', "muted");
  return `\n${jelly}\n\n${INDENT}${name} ${DOT} ${modelBadge}\n${INDENT}${hints}\n`;
}

// ── Animated spinner (inspired by pi-mono Loader) ──

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private currentFrame = 0;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private message: string,
    private display: DisplayFn
  ) {}

  start(): void {
    this.render();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
  }

  private render(): void {
    const frame = colorize(SPINNER_FRAMES[this.currentFrame], "info");
    const msg = colorize(this.message, "muted");
    // \r returns cursor to start of line, \x1b[K clears to end
    this.display(`\r${INDENT}${frame} ${msg}\x1b[K`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.display(`\r\x1b[K`);
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }
}

// ── Transcript formatting ──

function cleanToolName(name: string): string {
  return name.replace(/^mcp__zellij__/, "");
}

export function printToolUse(rawName: string, display: DisplayFn): void {
  const name = cleanToolName(rawName);
  const fg = COLOR_CODES.muted;
  display(`${INDENT}${TOOL_BG}${fg} ◦ ${name} ${ANSI_RESET}\n`);
}

export function printNote(message: string, display: DisplayFn): void {
  display(`${INDENT}${colorize(message, "muted")}\n`);
}

export function printError(message: string, display: DisplayFn): void {
  display(`${INDENT}${colorize(message, "error")}\n`);
}

// ── End-of-turn separator ──

export function renderTurnEnd(model: ModelAlias): string {
  const label = colorize(model, "muted");
  const line = colorize("───────", "muted");
  return `\n${INDENT}${line} ${label}\n`;
}

// ── Stream writer for assistant text ──

export class StreamWriter {
  private atLineStart = true;

  constructor(private readonly display: DisplayFn) {}

  write(text: string): void {
    for (const char of text) {
      if (this.atLineStart) {
        if (char === "\n") {
          this.display("\n");
          continue;
        }
        this.display(INDENT);
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
