import { zellijAction } from "./zellij.js";
import { heartbeatQuery } from "./agent.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function check(): Promise<void> {
  if (busy) return; // skip while user is actively chatting

  try {
    const [layout, tabs] = await Promise.all([
      zellijAction("dump-layout"),
      zellijAction("query-tab-names"),
    ]);

    const suggestion = await heartbeatQuery(layout.stdout, tabs.stdout);

    if (suggestion && suggestion !== "NOTHING" && !busy) {
      await showPopup(suggestion);
    }
  } catch {
    // Silently skip — Zellij might not be available or we're in a weird state
  }
}

async function showPopup(message: string): Promise<void> {
  // Use node -e with JSON.stringify to avoid shell injection.
  // zellij passes args directly to the process (no shell), and
  // JSON.stringify safely encodes any LLM output.
  const script = [
    `const m = ${JSON.stringify(message)};`,
    `console.log("");`,
    `console.log("  " + m);`,
    `console.log("");`,
    `console.log("  (auto-closes in 30s — press Alt+j to chat)");`,
    `setTimeout(() => {}, 30000);`,
  ].join(" ");

  await zellijAction(
    "new-pane",
    "--floating",
    "--close-on-exit",
    "--name",
    "Jelly J",
    "--width",
    "50%",
    "--height",
    "5",
    "--x",
    "25%",
    "--y",
    "2",
    "--",
    "node",
    "-e",
    script
  );
}

export function setBusy(value: boolean): void {
  busy = value;
}

export function startHeartbeat(): void {
  delayTimer = setTimeout(() => {
    delayTimer = null;
    check();
    intervalTimer = setInterval(check, HEARTBEAT_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}

export function stopHeartbeat(): void {
  if (delayTimer) {
    clearTimeout(delayTimer);
    delayTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
