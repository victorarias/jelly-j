import { zellijAction } from "./zellij.js";
import { heartbeatQuery } from "./agent.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let timer: ReturnType<typeof setInterval> | null = null;

async function check(): Promise<void> {
  try {
    const [layout, tabs] = await Promise.all([
      zellijAction("dump-layout"),
      zellijAction("query-tab-names"),
    ]);

    const suggestion = await heartbeatQuery(layout.stdout, tabs.stdout);

    if (suggestion && suggestion !== "NOTHING") {
      await showPopup(suggestion);
    }
  } catch (err) {
    // Silently skip — Zellij might not be available or we're in a weird state
  }
}

async function showPopup(message: string): Promise<void> {
  // Show a small floating pane with the suggestion that auto-closes after 30s
  const escapedMessage = message.replace(/'/g, "'\\''");
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
    "bash",
    "-c",
    `echo ''; echo '  ${escapedMessage}'; echo ''; echo '  (auto-closes in 30s — press Alt+j to chat)'; sleep 30`
  );
}

export function startHeartbeat(): void {
  // Run first check after 2 minutes (give user time to settle in)
  setTimeout(() => {
    check();
    timer = setInterval(check, HEARTBEAT_INTERVAL_MS);
  }, 2 * 60 * 1000);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
