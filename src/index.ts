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
  acquireAgentLock,
  readState,
  releaseAgentLock,
  writeState,
} from "./state.js";
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
  const currentZellijSession = process.env.ZELLIJ_SESSION_NAME?.trim() || undefined;

  const lockStatus = await acquireAgentLock(currentZellijSession);
  if (!lockStatus.acquired) {
    const pidText = lockStatus.owner?.pid ? `pid ${lockStatus.owner.pid}` : "another process";
    const sessionText = lockStatus.owner?.zellijSession
      ? ` in zellij session "${lockStatus.owner.zellijSession}"`
      : "";
    printNote(
      `Jelly J is already running (${pidText}${sessionText}). Global singleton mode allows only one process per computer.`,
      display
    );
    printNote("Use the existing Jelly J pane, or stop that process first.", display);
    return;
  }

  const persistedState = await readState();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  let sessionId: string | undefined = persistedState.sessionId;
  let pendingSessionContextNote: string | undefined;
  let currentModel: ModelAlias = "opus";
  let uiState: UiState = "idle";
  let shuttingDown = false;

  if (
    persistedState.zellijSession &&
    currentZellijSession &&
    persistedState.zellijSession !== currentZellijSession
  ) {
    pendingSessionContextNote =
      `You are now in zellij session "${currentZellijSession}" (previously "${persistedState.zellijSession}"). ` +
      "Tab and pane state may have changed.";
  }

  async function persistState(): Promise<void> {
    await writeState({
      sessionId,
      zellijSession: currentZellijSession,
    });
  }

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    stopHeartbeat();
    try {
      await persistState();
    } catch {
      // best effort only
    }
    try {
      await releaseAgentLock();
    } catch {
      // best effort only
    }
    process.exit(exitCode);
  }

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
      const result = await chat(
        input,
        sessionId,
        modelIdForAlias(currentModel),
        pendingSessionContextNote,
        {
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
        }
      );

      writer.flushLine();
      sessionId = result.sessionId;
      pendingSessionContextNote = undefined;
      await persistState();

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
    void shutdown(0);
  });

  const handleSigint = () => {
    display("\n");
    printNote('Ctrl-C does not exit Jelly J. Type "exit" to close it.', display);
    rl.prompt();
  };

  // Bun/Node can surface Ctrl-C via readline or process signal paths.
  // Trap both so Ctrl-C is consistently non-fatal for the singleton agent.
  rl.on("SIGINT", handleSigint);
  process.on("SIGINT", handleSigint);

  process.on("SIGTERM", () => {
    rl.close();
  });
}

main().catch((err) => {
  void releaseAgentLock();
  console.error("Fatal:", err);
  process.exit(1);
});
