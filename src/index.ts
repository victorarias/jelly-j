import { createInterface } from "node:readline";
import { chat } from "./agent.js";
import {
  handleSlashCommand,
  modelIdForAlias,
  type ModelAlias,
} from "./commands.js";
import { startHeartbeat, stopHeartbeat, setBusy } from "./heartbeat.js";
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
    const writer = new StreamWriter(display);

    try {
      const result = await chat(input, sessionId, modelIdForAlias(currentModel), {
        onText: (text) => {
          if (spinner.isRunning()) spinner.stop();
          uiState = "thinking";
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
          writer.flushLine();
          uiState = "error";
          printError(`[${subtype}] ${errors.join("; ")}`, display);
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
      printError(msg, display);
    } finally {
      if (spinner.isRunning()) spinner.stop();
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
