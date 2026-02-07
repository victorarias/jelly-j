import { createInterface } from "node:readline";
import { chat } from "./agent.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";

const GREETING = `  Jelly J here! What can I help you with?
  (type "exit" or "bye" to close)
`;

async function main(): Promise<void> {
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
      console.log("\n  See you! 🪼\n");
      shutdown(rl);
      return;
    }

    try {
      const result = await chat(input, sessionId);
      sessionId = result.sessionId;
      // Ensure we end on a newline before the next prompt
      process.stdout.write("\n\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  [error] ${msg}\n`);
    }

    rl.prompt();
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
