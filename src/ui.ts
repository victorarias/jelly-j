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

const TOOL_BG = "\x1b[48;2;40;40;50m";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const JELLYFISH = ["      .~~~.", "     ( ◠‿◠ )", "      /|||\\", "       |||"] as const;

export type UiState = "idle" | "thinking" | "tool" | "error";

export type TranscriptKind = "you" | "jj" | "tool" | "note" | "error" | "banner";

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
  transcriptScroll: number;
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
    case "banner":
      return "info";
  }
}

function colorForState(state: UiState): keyof typeof COLOR_CODES {
  switch (state) {
    case "idle":
      return "muted";
    case "thinking":
      return "warn";
    case "tool":
      return "info";
    case "error":
      return "error";
  }
}

export function cleanToolName(name: string): string {
  return name.replace(/^mcp__zellij__/, "");
}

export function createWelcomeEntries(model: ModelAlias): TranscriptEntry[] {
  const banner = JELLYFISH.map((line) => ({ kind: "banner" as const, text: line }));
  return [
    ...banner,
    {
      kind: "note",
      text: `Jelly J ready · model ${model}`,
    },
    {
      kind: "note",
      text: '/model switch · /new reset session · persistent mode',
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
    const spinner =
      snapshot.state === "thinking" || snapshot.state === "tool"
        ? `${SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length]} `
        : "";
    const stateText = `${spinner}${snapshot.state}`;
    const headerPlain = `Jelly J  model:${snapshot.model}  session:${sessionShort}  state:${stateText}`;
    const header = `${bold(colorize(truncate(headerPlain, width), "info"))}`;
    const separator = colorize("─".repeat(width), "muted");

    const transcriptHeight = Math.max(1, height - 5);
    const transcriptLines = this.renderTranscript(snapshot.entries, width);
    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    const clampedScroll = Math.max(0, Math.min(snapshot.transcriptScroll, maxScroll));
    const end = Math.max(0, transcriptLines.length - clampedScroll);
    const start = Math.max(0, end - transcriptHeight);
    const visibleTranscript = transcriptLines.slice(start, end);
    while (visibleTranscript.length < transcriptHeight) {
      visibleTranscript.unshift("");
    }

    const inputSeparator = colorize("─".repeat(width), "muted");
    const inputLine = this.renderInputLine(snapshot.input, snapshot.cursor, width);
    const hintPlain =
      snapshot.queueLength > 0
        ? `queued: ${snapshot.queueLength} | PgUp/PgDn scroll | Enter send | Ctrl+C stays open`
        : "PgUp/PgDn scroll | Enter send | /model /new | Ctrl+C stays open";
    const statePlain = `state: ${stateText}`;
    const composedHintPlain = `${hintPlain} | ${statePlain}`;
    const hintLine =
      composedHintPlain.length <= width
        ? `${colorize(hintPlain, "muted")} ${colorize("|", "muted")} ${colorize(statePlain, colorForState(snapshot.state))}`
        : colorize(truncate(hintPlain, width), "muted");

    const lines = [header, separator, ...visibleTranscript, inputSeparator, inputLine.line, hintLine];

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
      if (entry.kind === "banner") {
        lines.push(colorize(truncate(entry.text, width), "info"));
        continue;
      }

      if (entry.kind === "tool") {
        const rawLabel = "tool ".padEnd(labelWidth, " ");
        const label = colorize(rawLabel, colorForKind(entry.kind));
        const toolText = truncate(`◦ ${entry.text}`, Math.max(1, textWidth - 2));
        lines.push(`${label} ${TOOL_BG}${COLOR_CODES.muted} ${toolText} ${ANSI_RESET}`);
        continue;
      }

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
