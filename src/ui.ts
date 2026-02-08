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

export type UiState = "idle" | "thinking" | "tool" | "error";

export type TranscriptKind = "you" | "jj" | "tool" | "note" | "error";

export type TranscriptEntry = {
  kind: TranscriptKind;
  text: string;
};

export type UiSnapshot = {
  model: ModelAlias;
  sessionId?: string;
  state: UiState;
  queueLength: number;
  entries: TranscriptEntry[];
  input: string;
  cursor: number;
};

function colorize(text: string, color: keyof typeof COLOR_CODES): string {
  return `${COLOR_CODES[color]}${text}${ANSI_RESET}`;
}

function bold(text: string): string {
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

function sanitizeText(text: string): string {
  return text.replace(/\r/g, "").replace(/\t/g, "  ");
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];

  const lines: string[] = [];
  const paragraphs = sanitizeText(text).split("\n");

  for (const paragraph of paragraphs) {
    if (!paragraph.length) {
      lines.push("");
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(" ", width);
      if (splitAt <= 0) splitAt = width;
      lines.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }
    lines.push(remaining);
  }

  return lines.length ? lines : [""];
}

function colorForKind(kind: TranscriptKind): keyof typeof COLOR_CODES {
  switch (kind) {
    case "you":
      return "meta";
    case "jj":
      return "info";
    case "tool":
      return "muted";
    case "note":
      return "muted";
    case "error":
      return "error";
  }
}

export function cleanToolName(name: string): string {
  return name.replace(/^mcp__zellij__/, "");
}

export function createWelcomeEntries(model: ModelAlias): TranscriptEntry[] {
  return [
    {
      kind: "note",
      text: `Jelly J ready. model: ${model}`,
    },
    {
      kind: "note",
      text: 'Type /model to switch models. Type "exit" to close.',
    },
  ];
}

export class DifferentialRenderer {
  private running = false;
  private previousLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private inputScroll = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.previousLines = [];
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  render(snapshot: UiSnapshot): void {
    if (!this.running) return;

    const width = Math.max(20, process.stdout.columns || 80);
    const height = Math.max(8, process.stdout.rows || 24);

    const frame = this.buildFrame(snapshot, width, height);
    const needsFullRedraw =
      this.previousLines.length === 0 ||
      this.previousWidth !== width ||
      this.previousHeight !== height ||
      this.previousLines.length !== frame.lines.length;

    let buffer = "\x1b[?2026h\x1b[?25l";

    if (needsFullRedraw) {
      buffer += "\x1b[2J";
      for (let row = 0; row < frame.lines.length; row++) {
        buffer += `\x1b[${row + 1};1H\x1b[2K${frame.lines[row]}`;
      }
    } else {
      for (let row = 0; row < frame.lines.length; row++) {
        if (frame.lines[row] === this.previousLines[row]) continue;
        buffer += `\x1b[${row + 1};1H\x1b[2K${frame.lines[row]}`;
      }
    }

    buffer += `\x1b[${frame.cursorRow + 1};${frame.cursorCol + 1}H\x1b[?25h\x1b[?2026l`;
    process.stdout.write(buffer);

    this.previousLines = frame.lines;
    this.previousWidth = width;
    this.previousHeight = height;
  }

  private buildFrame(
    snapshot: UiSnapshot,
    width: number,
    height: number
  ): { lines: string[]; cursorRow: number; cursorCol: number } {
    const sessionShort = snapshot.sessionId ? snapshot.sessionId.slice(0, 8) : "new";
    const headerPlain = `Jelly J  model:${snapshot.model}  session:${sessionShort}  state:${snapshot.state}`;
    const header = `${bold(colorize(truncate(headerPlain, width), "info"))}`;
    const separator = colorize("─".repeat(width), "muted");

    const transcriptHeight = Math.max(1, height - 5);
    const transcriptLines = this.renderTranscript(snapshot.entries, width);
    const visibleTranscript = transcriptLines.slice(-transcriptHeight);
    while (visibleTranscript.length < transcriptHeight) {
      visibleTranscript.unshift("");
    }

    const inputSeparator = colorize("─".repeat(width), "muted");
    const inputLine = this.renderInputLine(snapshot.input, snapshot.cursor, width);
    const hintPlain =
      snapshot.queueLength > 0
        ? `queued: ${snapshot.queueLength} | Enter send | Ctrl+C exit`
        : "Enter send | /model | Ctrl+C exit";
    const hint = colorize(truncate(hintPlain, width), "muted");

    const lines = [header, separator, ...visibleTranscript, inputSeparator, inputLine.line, hint];

    return {
      lines,
      cursorRow: lines.length - 2,
      cursorCol: inputLine.cursorCol,
    };
  }

  private renderTranscript(entries: TranscriptEntry[], width: number): string[] {
    if (entries.length === 0) {
      return [colorize("note  say hi and I will organize your workspace", "muted")];
    }

    const lines: string[] = [];
    const labelWidth = 5;
    const textWidth = Math.max(1, width - labelWidth - 1);

    for (const entry of entries) {
      const wrapped = wrapText(entry.text, textWidth);
      const rawLabel = entry.kind.padEnd(labelWidth, " ");
      const label = colorize(rawLabel, colorForKind(entry.kind));

      wrapped.forEach((line, index) => {
        const prefix = index === 0 ? label : " ".repeat(labelWidth);
        lines.push(`${prefix} ${truncate(line, textWidth)}`);
      });
    }

    return lines;
  }

  private renderInputLine(
    input: string,
    cursor: number,
    width: number
  ): { line: string; cursorCol: number } {
    const prompt = colorize("> ", "info");
    const plainPrompt = "> ";
    const safeInput = sanitizeText(input).replace(/\n/g, " ");
    const clampedCursor = Math.max(0, Math.min(cursor, safeInput.length));

    const available = Math.max(1, width - plainPrompt.length);

    if (clampedCursor < this.inputScroll) {
      this.inputScroll = clampedCursor;
    }
    if (clampedCursor >= this.inputScroll + available) {
      this.inputScroll = clampedCursor - available + 1;
    }
    if (safeInput.length <= available) {
      this.inputScroll = 0;
    } else {
      this.inputScroll = Math.max(0, Math.min(this.inputScroll, safeInput.length - available));
    }

    const visibleInput = safeInput.slice(this.inputScroll, this.inputScroll + available);
    const padded = visibleInput.padEnd(available, " ");
    const line = `${prompt}${padded}`;

    const inputCursor = Math.max(0, clampedCursor - this.inputScroll);
    const cursorCol = Math.min(width - 1, plainPrompt.length + inputCursor);

    return { line, cursorCol };
  }
}
