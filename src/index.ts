import { createInterface } from "node:readline";
import { chat } from "./agent.js";
import {
  handleSlashCommand,
  modelIdForAlias,
  type ModelAlias,
} from "./commands.js";
import { startHeartbeat, stopHeartbeat, setBusy } from "./heartbeat.js";
import { logTranscriptTurn } from "./logging.js";
import {
  StreamWriter,
  Spinner,
  printToolUse,
  printNote,
  printError,
  renderWelcome,
  renderTurnEnd,
  type UiState,
} from "./ui.js";

const display = (text: string) => process.stdout.write(text);

async function main(): Promise<void> {
  process.stdout.write("\x1b]0;Jelly J\x07");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  let sessionId: string | undefined;
  let currentModel: ModelAlias = "opus";
  let uiState: UiState = "idle";
  let shuttingDown = false;

  display(renderWelcome(currentModel));

  startHeartbeat();
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (["exit", "bye", "quit", "q"].includes(input.toLowerCase())) {
      printNote("See you!", display);
      rl.close();
      return;
    }

    const commandResult = handleSlashCommand(input, currentModel);
    if (commandResult.handled) {
      currentModel = commandResult.nextModel;
      if (commandResult.isError) {
        printError(commandResult.message, display);
      } else {
        printNote(commandResult.message, display);
      }
      rl.prompt();
      return;
    }

    display("\n");
    rl.pause();
    setBusy(true);

    uiState = "thinking";
    const spinner = new Spinner("thinking", display);
    spinner.start();

    let hadError = false;
    let assistantText = "";
    const resultErrors: string[] = [];
    let caughtErrorMessage: string | undefined;
    const writer = new StreamWriter(display);

    try {
      const result = await chat(input, sessionId, modelIdForAlias(currentModel), {
        onText: (text) => {
          if (spinner.isRunning()) spinner.stop();
          uiState = "thinking";
          assistantText += text;
          writer.write(text);
        },
        onToolUse: ({ name }) => {
          if (spinner.isRunning()) spinner.stop();
          writer.flushLine();
          uiState = "tool";
          printToolUse(name, display);
        },
        onResultError: (subtype, errors) => {
          if (spinner.isRunning()) spinner.stop();
          hadError = true;
          const formatted = `[${subtype}] ${errors.join("; ")}`;
          resultErrors.push(formatted);
          writer.flushLine();
          uiState = "error";
          printError(formatted, display);
        },
        onPermissionRequest: (toolName, reason) => {
          if (spinner.isRunning()) spinner.stop();
          writer.flushLine();
          uiState = "thinking";
          printNote(`permission required: ${toolName} (${reason})`, display);
        },
      });

      writer.flushLine();
      sessionId = result.sessionId;

      if (!hadError) {
        uiState = "idle";
      }
    } catch (err) {
      hadError = true;
      writer.flushLine();
      uiState = "error";
      const msg = err instanceof Error ? err.message : String(err);
      caughtErrorMessage = msg;
      printError(msg, display);
    } finally {
      if (spinner.isRunning()) spinner.stop();
      const error =
        resultErrors.length > 0 ? resultErrors.join("\n") : caughtErrorMessage;
      logTranscriptTurn({
        model: currentModel,
        user: input,
        assistant: assistantText,
        error,
      });
      setBusy(false);
      display(renderTurnEnd(currentModel));
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
