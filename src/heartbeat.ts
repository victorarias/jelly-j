import { heartbeatQuery } from "./agent.js";
import { logHeartbeatError, logHeartbeatInfo } from "./logging.js";
import { getButlerState, ZellijPipeError } from "./zellijPipe.js";
import { zellijAction } from "./zellij.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let busy = false;

async function check(): Promise<void> {
  if (busy) {
    logHeartbeatInfo("tick skipped: busy");
    return; // skip while user is actively chatting
  }

  logHeartbeatInfo("tick start");

  try {
    const state = await getButlerState();
    const tabs = state.tabs
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((tab) => `${tab.position}:${tab.name}${tab.active ? " (active)" : ""}`)
      .join(", ");

    const layout = JSON.stringify(state, null, 2);

    const suggestion = await heartbeatQuery(layout, tabs);
    logHeartbeatInfo(`tick result: ${suggestion || "(empty)"}`);

    if (suggestion && suggestion !== "NOTHING" && !busy) {
      await showPopup(suggestion);
      logHeartbeatInfo("popup shown");
    }
  } catch (err) {
    if (err instanceof ZellijPipeError && err.code === "not_ready") {
      logHeartbeatInfo("tick skipped: butler not ready");
      return;
    }
    // Silently skip in UI — Zellij might not be available or we're in a weird state.
    const message = err instanceof Error ? err.message : String(err);
    logHeartbeatError(`tick failed: ${message}`);
  }
}

async function showPopup(message: string): Promise<void> {
  // Use bun -e with JSON.stringify to avoid shell injection.
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
    "bun",
    "-e",
    script
  );
}

export function setBusy(value: boolean): void {
  busy = value;
  logHeartbeatInfo(`busy=${value}`);
}

export function startHeartbeat(): void {
  logHeartbeatInfo(
    `started initial_delay_ms=${INITIAL_DELAY_MS} interval_ms=${HEARTBEAT_INTERVAL_MS}`
  );
  delayTimer = setTimeout(() => {
    delayTimer = null;
    logHeartbeatInfo("initial delay elapsed; running first tick");
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
  logHeartbeatInfo("stopped");
}
