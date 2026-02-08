import { createInterface } from "node:readline";
import { chat } from "./agent.js";
import { startHeartbeat, stopHeartbeat, setBusy } from "./heartbeat.js";

const GREETING = `
       ___
      (o o)
     ( (_) )
      /| |\\
     / | | \\
        ~ ~
       __     ____             __
      / /__  / / /_  __       / /
 __  / / _ \\/ / / / / /  __  / /
/ /_/ /  __/ / / /_/ /  / /_/ /
\\____/\\___/_/_/\\__, /   \\____/
              /____/

  What can I help you with?
  (type "exit" or "bye" to close)
`;

const display = (text: string) => process.stdout.write(text);

async function main(): Promise<void> {
  // Set terminal title so the Zellij launcher plugin can find this pane
  process.stdout.write("\x1b]0;Jelly J\x07");
  console.log(GREETING);

  startHeartbeat();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "❯ ",
  });

  let sessionId: string | undefined;

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (["exit", "bye", "quit", "q"].includes(input.toLowerCase())) {
      console.log("\n  See you!\n");
      shutdown(rl);
      return;
    }

    // Pause readline to prevent concurrent queries from rapid input.
    // Buffered input will be processed after resume.
    rl.pause();
    setBusy(true);

    try {
      const result = await chat(input, sessionId, display);
      sessionId = result.sessionId;
      display("\n\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  [error] ${msg}\n`);
    } finally {
      setBusy(false);
      rl.resume();
      rl.prompt();
    }
  });

  rl.on("close", () => {
    shutdown(rl);
  });
}

function shutdown(rl: ReturnType<typeof createInterface>): void {
  stopHeartbeat();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
