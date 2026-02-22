import { heartbeatQuery } from "./agent.js";
import { logHeartbeatError, logHeartbeatInfo } from "./logging.js";
import {
  getButlerState,
  ZellijPipeError,
  type ButlerState,
} from "./zellijPipe.js";
import { setActiveZellijEnv, getActiveZellijEnv, zellijAction } from "./zellij.js";
import type { ZellijEnvContext } from "./protocol.js";

const HEARTBEAT_INTERVAL_MS = 1 * 60 * 1000; // 1 minute (testing)
const INITIAL_DELAY_MS = 30 * 1000; // 30 seconds (testing)

/** Zellij default tab name pattern: "Tab #1", "Tab #2", etc. */
const DEFAULT_TAB_NAME = /^Tab #\d+$/;

let delayTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/**
 * Known Zellij envs keyed by session name.
 * The daemon runs detached without ZELLIJ env vars, so the heartbeat borrows
 * the env from connected UI clients. Multiple sessions can be tracked
 * simultaneously so the heartbeat checks all of them each tick.
 */
const knownSessions = new Map<string, ZellijEnvContext>();

/**
 * Called by the daemon when a UI client registers or sends a chat request.
 * Updates the env for that session so the heartbeat can reach it.
 */
export function updateHeartbeatZellijEnv(env: ZellijEnvContext | undefined): void {
  if (!env?.ZELLIJ_SESSION_NAME) return;
  knownSessions.set(env.ZELLIJ_SESSION_NAME, env);
  logHeartbeatInfo(
    `session registered: ${env.ZELLIJ_SESSION_NAME} ZELLIJ=${env.ZELLIJ ?? "(unset)"} binary=${env.zellijBinary ?? "(unset)"}`
  );
}

/**
 * Called by the daemon when a session is known to be gone (optional cleanup).
 */
export function removeHeartbeatSession(sessionName: string): void {
  knownSessions.delete(sessionName);
}

// ── Heartbeat prompt ────────────────────────────────────────────────

function buildHeartbeatPrompt(state: ButlerState, tabNames: string): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

  // Build a per-tab summary of running commands for the LLM.
  const tabPaneSummaries = state.tabs
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((tab) => {
      const panes = state.panes.filter(
        (p) => p.tab_index === tab.position && !p.is_plugin && !p.exited
      );
      const cmds = panes
        .map((p) => p.terminal_command || p.title)
        .filter(Boolean);
      return `  Tab ${tab.position} "${tab.name}": ${cmds.length > 0 ? cmds.join(", ") : "(empty)"}`;
    })
    .join("\n");

  return `Current Zellij workspace state:

Current local time: ${now.toISOString()} (${tz})

Tab names: ${tabNames}

Per-tab commands:
${tabPaneSummaries}

Full layout:
${JSON.stringify(state, null, 2)}

You are a workspace organization assistant. Analyze the workspace and respond with a JSON object containing two fields:

1. "renames": an array of tab rename actions. Each entry: { "position": <number>, "name": "<new name>" }.
   - Only rename tabs that have the default name pattern "Tab #N".
   - Choose short, descriptive names (1-3 words) based on the running commands/titles in that tab.
   - Examples: "dev server", "editor", "git", "logs", "docker", "tests", "docs"
   - If a tab has no commands or only a bare shell, name it based on the working directory if visible, or skip it.

2. "suggestion": a SHORT one-liner (max 80 chars) about other improvements, or null if nothing to suggest. Consider:
   - Overcrowded tabs (>4 panes → suggest splitting)
   - Similar panes across tabs (same command type → suggest grouping)
   - Empty/idle tabs that could be closed

Respond ONLY with valid JSON, no other text. Example:
{"renames": [{"position": 1, "name": "editor"}, {"position": 3, "name": "logs"}], "suggestion": "Tab 2 has 6 panes — consider splitting dev and test panes"}

If nothing to do: {"renames": [], "suggestion": null}`;
}

// ── Heartbeat result parsing ────────────────────────────────────────

interface HeartbeatResult {
  renames: Array<{ position: number; name: string }>;
  suggestion: string | null;
}

function parseHeartbeatResult(raw: string): HeartbeatResult {
  // Strip markdown code fences if the LLM wraps it.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as HeartbeatResult;
    if (!Array.isArray(parsed.renames)) {
      return { renames: [], suggestion: null };
    }
    // Validate each rename entry.
    const renames = parsed.renames.filter(
      (r) =>
        typeof r.position === "number" &&
        typeof r.name === "string" &&
        r.name.trim().length > 0
    );
    const suggestion =
      typeof parsed.suggestion === "string" && parsed.suggestion.trim().length > 0
        ? parsed.suggestion.trim()
        : null;
    return { renames, suggestion };
  } catch {
    // Fall back: treat as old-style text suggestion.
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "NOTHING") {
      return { renames: [], suggestion: null };
    }
    return { renames: [], suggestion: trimmed };
  }
}

// ── Per-session tick ────────────────────────────────────────────────

async function checkSession(sessionName: string, env: ZellijEnvContext): Promise<void> {
  logHeartbeatInfo(
    `[${sessionName}] checking (binary=${env.zellijBinary ?? "default"} ZELLIJ=${env.ZELLIJ ?? "(unset)"})`
  );

  // Set the Zellij env so pipe/action commands target this session.
  setActiveZellijEnv(env);

  try {
    const state = await getButlerState();

    // Quick check: any unnamed tabs?
    const unnamedTabs = state.tabs.filter((t) => DEFAULT_TAB_NAME.test(t.name));
    const overcrowded = state.tabs.some(
      (t) => t.selectable_tiled_panes_count + t.selectable_floating_panes_count > 4
    );

    if (unnamedTabs.length === 0 && !overcrowded) {
      logHeartbeatInfo(`[${sessionName}] skip: no unnamed tabs, nothing overcrowded`);
      return;
    }

    const tabNames = state.tabs
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(
        (tab) =>
          `${tab.position}:${tab.name}${tab.active ? " (active)" : ""}`
      )
      .join(", ");

    const prompt = buildHeartbeatPrompt(state, tabNames);
    const rawResult = await heartbeatQuery(prompt);
    logHeartbeatInfo(`[${sessionName}] raw result: ${rawResult.slice(0, 200)}`);

    const result = parseHeartbeatResult(rawResult);

    // ── Auto-rename tabs ──
    if (result.renames.length > 0 && !busy) {
      // Re-set env in case an LLM call took a while and something else changed it.
      setActiveZellijEnv(env);

      // Build position→id map once from `zellij action list-tabs`.
      // Uses rename-tab-by-id to avoid changing the user's focused tab.
      const tabIdMap = new Map<number, number>();
      try {
        const { stdout } = await zellijAction("list-tabs");
        for (const line of stdout.split("\n")) {
          const match = line.match(/^(\d+)\s+(\d+)\s+/);
          if (match) {
            tabIdMap.set(Number(match[2]), Number(match[1])); // position -> id
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logHeartbeatError(`[${sessionName}] list-tabs failed: ${msg}`);
      }

      for (const rename of result.renames) {
        // Safety: only rename tabs that still have default names.
        const tab = state.tabs.find((t) => t.position === rename.position);
        if (!tab || !DEFAULT_TAB_NAME.test(tab.name)) {
          logHeartbeatInfo(
            `[${sessionName}] rename skip: tab ${rename.position} already named "${tab?.name ?? "?"}"`
          );
          continue;
        }
        const tabId = tabIdMap.get(rename.position);
        if (tabId == null) {
          logHeartbeatInfo(
            `[${sessionName}] rename skip: no tab ID found for position ${rename.position}`
          );
          continue;
        }
        try {
          await zellijAction("rename-tab-by-id", String(tabId), rename.name.trim());
          logHeartbeatInfo(
            `[${sessionName}] renamed tab ${rename.position} (id=${tabId}): "${tab.name}" -> "${rename.name}"`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logHeartbeatError(`[${sessionName}] rename failed tab ${rename.position}: ${msg}`);
        }
      }
    }

    // ── Show suggestion popup (split/group recommendations) ──
    if (result.suggestion && !busy) {
      setActiveZellijEnv(env);
      await showPopup(result.suggestion);
      logHeartbeatInfo(`[${sessionName}] popup shown`);
    }
  } catch (err) {
    if (err instanceof ZellijPipeError && err.code === "not_ready") {
      logHeartbeatInfo(`[${sessionName}] skipped: butler not ready`);
      return;
    }
    if (err instanceof ZellijPipeError && err.code === "timeout") {
      // Session may have been closed — remove it so we don't keep retrying.
      const tmsg = err instanceof Error ? err.message : String(err);
      logHeartbeatInfo(`[${sessionName}] timed out: ${tmsg}`);
      knownSessions.delete(sessionName);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/no active session/i.test(message)) {
      logHeartbeatInfo(`[${sessionName}] no active session, removing stale session`);
      knownSessions.delete(sessionName);
      return;
    }
    logHeartbeatError(`[${sessionName}] tick failed: ${message}`);
  }
}

// ── Core tick (iterates all sessions) ───────────────────────────────

async function check(): Promise<void> {
  if (busy) {
    logHeartbeatInfo("tick skipped: busy");
    return;
  }

  if (knownSessions.size === 0) {
    logHeartbeatInfo("tick skipped: no sessions registered");
    return;
  }

  logHeartbeatInfo(`tick start (${knownSessions.size} session(s))`);

  const previousEnv = getActiveZellijEnv();

  try {
    // Snapshot the sessions map so mutations during iteration are safe.
    const sessions = [...knownSessions.entries()];

    for (const [sessionName, env] of sessions) {
      if (busy) {
        logHeartbeatInfo("tick interrupted: busy");
        break;
      }
      await checkSession(sessionName, env);
    }
  } finally {
    setActiveZellijEnv(previousEnv);
  }

  logHeartbeatInfo("tick done");
}

// ── Popup (for suggestions only) ───────────────────────────────────

async function showPopup(message: string): Promise<void> {
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

// ── Public API ──────────────────────────────────────────────────────

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
