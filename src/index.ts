import { emitKeypressEvents } from "node:readline";
import { AgentSession } from "./agent-session.js";
import {
  handleSlashCommand,
  type ModelAlias,
} from "./commands.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";
import {
  cleanToolName,
  createWelcomeEntries,
  DifferentialRenderer,
  type TranscriptEntry,
  type UiState,
} from "./ui.js";

type Keypress = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

function isExitCommand(input: string): boolean {
  const value = input.toLowerCase();
  return value === "exit" || value === "bye" || value === "quit" || value === "q";
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Jelly J requires an interactive terminal (TTY).");
    process.exit(1);
  }

  process.stdout.write("\x1b]0;Jelly J\x07");

  const renderer = new DifferentialRenderer();
  let model: ModelAlias = "opus";
  let state: UiState = "idle";
  let busy = false;
  let queueLength = 0;
  let sessionId: string | undefined;
  const entries: TranscriptEntry[] = createWelcomeEntries(model);

  let input = "";
  let cursor = 0;
  let activeAssistantIndex: number | undefined;

  const inputHistory: string[] = [];
  let historyIndex = -1;
  let historyDraft = "";

  let shuttingDown = false;

  const render = (): void => {
    renderer.render({
      model,
      sessionId,
      state,
      queueLength,
      entries,
      input,
      cursor,
    });
  };

  const session = new AgentSession(model);
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "state":
        model = event.model;
        sessionId = event.sessionId;
        state = event.uiState;
        busy = event.busy;
        queueLength = event.queueLength;
        break;
      case "queued":
        if (busy) {
          entries.push({
            kind: "note",
            text: `queued message (${event.queueLength})`,
          });
        }
        break;
      case "turn_start":
        activeAssistantIndex = undefined;
        entries.push({ kind: "you", text: event.input });
        break;
      case "text":
        if (
          activeAssistantIndex === undefined ||
          activeAssistantIndex < 0 ||
          activeAssistantIndex >= entries.length ||
          entries[activeAssistantIndex]?.kind !== "jj"
        ) {
          entries.push({ kind: "jj", text: "" });
          activeAssistantIndex = entries.length - 1;
        }
        entries[activeAssistantIndex].text += event.text;
        break;
      case "tool_use":
        activeAssistantIndex = undefined;
        entries.push({
          kind: "tool",
          text: cleanToolName(event.event.name),
        });
        break;
      case "turn_error":
        activeAssistantIndex = undefined;
        entries.push({ kind: "error", text: event.message });
        break;
      case "turn_end":
        activeAssistantIndex = undefined;
        sessionId = event.sessionId ?? sessionId;
        break;
    }
    render();
  });

  const shutdown = (message?: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    session.stop();
    unsubscribe();
    stopHeartbeat();

    process.stdout.off("resize", render);
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    process.stdin.pause();

    renderer.stop();

    if (message) {
      process.stdout.write(`${message}\n`);
    }

    process.exit(0);
  };

  const submitInput = (): void => {
    const rawInput = input;
    const message = rawInput.trim();

    input = "";
    cursor = 0;
    historyIndex = -1;
    historyDraft = "";

    render();

    if (!message.length) return;

    if (isExitCommand(message)) {
      shutdown("See you!");
      return;
    }

    if (inputHistory[inputHistory.length - 1] !== message) {
      inputHistory.push(message);
    }

    const commandResult = handleSlashCommand(message, model);
    if (commandResult.handled) {
      model = commandResult.nextModel;
      session.setModel(model);
      entries.push({
        kind: commandResult.isError ? "error" : "note",
        text: commandResult.message,
      });
      render();
      return;
    }

    session.enqueue(message);
  };

  const insertText = (text: string): void => {
    const safe = text.replace(/[\r\n]+/g, " ");
    if (!safe.length) return;
    input = `${input.slice(0, cursor)}${safe}${input.slice(cursor)}`;
    cursor += safe.length;
  };

  const selectHistory = (delta: -1 | 1): void => {
    if (!inputHistory.length) return;

    if (historyIndex === -1) {
      historyDraft = input;
      historyIndex = inputHistory.length;
    }

    historyIndex = Math.max(0, Math.min(inputHistory.length, historyIndex + delta));

    if (historyIndex === inputHistory.length) {
      input = historyDraft;
    } else {
      input = inputHistory[historyIndex] ?? "";
    }
    cursor = input.length;
  };

  const onKeypress = (str: string, key: Keypress): void => {
    if (key.ctrl && key.name === "c") {
      shutdown();
      return;
    }

    if (key.ctrl && key.name === "d" && input.length === 0) {
      shutdown();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      submitInput();
      return;
    }

    if (key.name === "backspace") {
      if (cursor > 0) {
        input = `${input.slice(0, cursor - 1)}${input.slice(cursor)}`;
        cursor -= 1;
      }
      render();
      return;
    }

    if (key.name === "delete") {
      if (cursor < input.length) {
        input = `${input.slice(0, cursor)}${input.slice(cursor + 1)}`;
      }
      render();
      return;
    }

    if (key.name === "left") {
      cursor = Math.max(0, cursor - 1);
      render();
      return;
    }

    if (key.name === "right") {
      cursor = Math.min(input.length, cursor + 1);
      render();
      return;
    }

    if (key.name === "home") {
      cursor = 0;
      render();
      return;
    }

    if (key.name === "end") {
      cursor = input.length;
      render();
      return;
    }

    if (key.name === "up") {
      selectHistory(-1);
      render();
      return;
    }

    if (key.name === "down") {
      selectHistory(1);
      render();
      return;
    }

    if (key.name === "escape") {
      input = "";
      cursor = 0;
      historyIndex = -1;
      historyDraft = "";
      render();
      return;
    }

    if (!key.ctrl && !key.meta && str && !/[\x00-\x1f\x7f]/.test(str)) {
      insertText(str);
      render();
    }
  };

  renderer.start();

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", onKeypress);

  process.stdout.on("resize", render);

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  startHeartbeat();
  render();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
