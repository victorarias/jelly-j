import { createInterface } from "node:readline";
import { chat } from "./agent.js";
import {
  handleSlashCommand,
  modelIdForAlias,
  type ModelAlias,
} from "./commands.js";
import { startHeartbeat, stopHeartbeat, setBusy } from "./heartbeat.js";
import {
  PrefixedStreamWriter,
  formatToolUse,
  printTranscriptLine,
  renderHeader,
  type UiState,
} from "./ui.js";

const display = (text: string) => process.stdout.write(text);

async function main(): Promise<void> {
  process.stdout.write("\x1b]0;Jelly J\x07");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "❯ ",
  });

  let sessionId: string | undefined;
  let currentModel: ModelAlias = "opus";
  let uiState: UiState = "idle";
  let shuttingDown = false;

  const printHeader = () => {
    display(`${renderHeader({ model: currentModel, sessionId, state: uiState })}\n`);
  };

  const setState = (next: UiState) => {
    if (uiState === next) return;
    uiState = next;
    printHeader();
  };

  printTranscriptLine("note", "Type /model to view or switch model.", display);
  printTranscriptLine("note", 'Type "exit" or "bye" to close.', display);
  printHeader();

  startHeartbeat();
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      printHeader();
      rl.prompt();
      return;
    }

    if (["exit", "bye", "quit", "q"].includes(input.toLowerCase())) {
      printTranscriptLine("note", "See you!", display);
      rl.close();
      return;
    }

    const commandResult = handleSlashCommand(input, currentModel);
    if (commandResult.handled) {
      currentModel = commandResult.nextModel;
      printTranscriptLine(
        commandResult.isError ? "error" : "note",
        commandResult.message,
        display
      );
      printHeader();
      rl.prompt();
      return;
    }

    display("\n");
    printTranscriptLine("you", input, display);

    rl.pause();
    setBusy(true);
    setState("thinking");

    let hadError = false;
    const assistantWriter = new PrefixedStreamWriter("jj", display);

    try {
      const result = await chat(input, sessionId, modelIdForAlias(currentModel), {
        onText: (text) => {
          if (uiState !== "thinking") {
            setState("thinking");
          }
          assistantWriter.write(text);
        },
        onToolUse: ({ name, input: toolInput }) => {
          assistantWriter.flushLine();
          setState("tool");
          printTranscriptLine("tool", formatToolUse(name, toolInput), display);
        },
        onResultError: (subtype, errors) => {
          hadError = true;
          assistantWriter.flushLine();
          setState("error");
          printTranscriptLine("error", `[${subtype}] ${errors.join("; ")}`, display);
        },
      });

      assistantWriter.flushLine();
      sessionId = result.sessionId;

      if (!hadError) {
        uiState = "idle";
      }
    } catch (err) {
      hadError = true;
      assistantWriter.flushLine();
      uiState = "error";
      const msg = err instanceof Error ? err.message : String(err);
      printTranscriptLine("error", msg, display);
    } finally {
      setBusy(false);
      display("\n");
      printHeader();
      rl.resume();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopHeartbeat();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
