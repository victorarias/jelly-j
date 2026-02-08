import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

type CmdResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export type FloatingPaneStats = {
  totalFloatingPanes: number;
  nonPluginFloatingPanes: number;
  jellyLikeFloatingPanes: number;
  blankFloatingPanes: number;
};

export type TabState = {
  focusedTabIndex: number | null;
  jellyTabIndices: number[];
  jellyDockedInFocusedTab: boolean;
  jellyFloatingInFocusedTab: boolean;
};

const ZELLIJ_BIN = process.env.ZELLIJ_BIN ?? "zellij";
const WEB_BASE_URL = process.env.ZELLIJ_WEB_BASE_URL ?? "http://127.0.0.1:8082";

function run(args: string[], allowFailure = false, timeoutMs = 15_000): CmdResult {
  try {
    const stdout = execFileSync(ZELLIJ_BIN, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      status?: number;
    };
    const stdout = String(err.stdout ?? "");
    const stderr = String(err.stderr ?? "");
    const status = err.status ?? 1;
    if (!allowFailure) {
      throw new Error(
        `zellij ${args.join(" ")} failed (${status})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    return { stdout, stderr, status };
  }
}

function runShell(cmd: string, timeoutMs = 10_000): string {
  return execFileSync("zsh", ["-lc", cmd], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  }).trim();
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function extractFloatingPaneBlocksFromText(text: string): string[] {
  const sections: string[] = [];

  let cursor = 0;
  while (true) {
    const floatingIdx = text.indexOf("floating_panes", cursor);
    if (floatingIdx === -1) break;
    const openIdx = text.indexOf("{", floatingIdx);
    if (openIdx === -1) break;
    const closeIdx = findMatchingBrace(text, openIdx);
    if (closeIdx === -1) break;
    sections.push(text.slice(openIdx + 1, closeIdx));
    cursor = closeIdx + 1;
  }

  const paneBlocks: string[] = [];
  for (const section of sections) {
    let sectionCursor = 0;
    while (true) {
      const paneIdx = section.indexOf("pane", sectionCursor);
      if (paneIdx === -1) break;
      const before = section[paneIdx - 1];
      const after = section[paneIdx + 4];
      if ((before && /[\w-]/.test(before)) || (after && /[\w-]/.test(after))) {
        sectionCursor = paneIdx + 4;
        continue;
      }
      const openIdx = section.indexOf("{", paneIdx);
      if (openIdx === -1) break;
      const closeIdx = findMatchingBrace(section, openIdx);
      if (closeIdx === -1) break;
      paneBlocks.push(section.slice(paneIdx, closeIdx + 1));
      sectionCursor = closeIdx + 1;
    }
  }
  return paneBlocks;
}

function extractFloatingPaneBlocks(layout: string): string[] {
  const runtimeLayout = layout.split("\n    new_tab_template")[0] ?? layout;
  return extractFloatingPaneBlocksFromText(runtimeLayout);
}

function stripFloatingPaneSectionsFromText(text: string): string {
  let cursor = 0;
  let output = "";

  while (cursor < text.length) {
    const floatingIdx = text.indexOf("floating_panes", cursor);
    if (floatingIdx === -1) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, floatingIdx);
    const openIdx = text.indexOf("{", floatingIdx);
    if (openIdx === -1) {
      output += text.slice(floatingIdx);
      break;
    }
    const closeIdx = findMatchingBrace(text, openIdx);
    if (closeIdx === -1) {
      output += text.slice(floatingIdx);
      break;
    }
    cursor = closeIdx + 1;
  }

  return output;
}

export function parseFloatingPaneStats(layout: string): FloatingPaneStats {
  const blocks = extractFloatingPaneBlocks(layout);
  let nonPlugin = 0;
  let jellyLike = 0;
  let blank = 0;

  for (const block of blocks) {
    const isPlugin = /plugin location=/.test(block);
    const hasName = /\bname=/.test(block);
    const hasCommand = /\bcommand=/.test(block);
    const isJelly = /name="Jelly J"|command="[^"]*jelly-j[^"]*"/.test(block);
    if (!isPlugin) nonPlugin += 1;
    if (isJelly) jellyLike += 1;
    if (!isPlugin && !hasName && !hasCommand) blank += 1;
  }

  return {
    totalFloatingPanes: blocks.length,
    nonPluginFloatingPanes: nonPlugin,
    jellyLikeFloatingPanes: jellyLike,
    blankFloatingPanes: blank,
  };
}

export function ensureWebServerRunning(): void {
  run(["web", "--start", "--daemonize"], true);
}

export function restartWebServerClean(): void {
  run(["web", "--stop"], true, 8_000);
  run(["web", "--start", "--daemonize"], true, 12_000);
}

export function stopWebServer(): void {
  run(["web", "--stop"], true, 8_000);
}

export function createWebToken(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const created = run(["web", "--create-token"], true);
    const tokenMatch = created.stdout.match(/token_[^:]+:\s*([a-f0-9-]+)/i);
    if (tokenMatch) return tokenMatch[1];
  }
  throw new Error("Could not create or parse zellij web token after retries.");
}

export function createSession(prefix = "jj-harness"): string {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  run(["attach", "--create-background", name, "options", "--web-sharing", "on"]);
  return name;
}

export function deleteSession(session: string): void {
  // Active sessions require kill-session; delete-session only removes dead sessions.
  run(["kill-session", session], true);
  run(["delete-session", session], true);
}

export function deleteHarnessSessions(prefix = "jj-harness"): void {
  const listed = run(["list-sessions"], true);
  const clean = stripAnsi(listed.stdout);
  const names = clean
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.split(" ")[0])
    .filter(Boolean);
  for (const session of names) {
    deleteSession(session);
  }
}

export function countEstablishedWebConnections(port = 8082): number {
  const raw = runShell(
    `lsof -nP -iTCP:${port} -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | wc -l || true`,
  );
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(value) ? 0 : value;
}

export function ensureNormalMode(session: string): void {
  run(["--session", session, "action", "switch-mode", "normal"], true);
}

export function closeAboutTipIfFocused(session: string): void {
  const clients = run(["--session", session, "action", "list-clients"], true);
  if (clients.stdout.includes("zellij:about")) {
    run(["--session", session, "action", "close-pane"], true);
  }
}

export function dumpLayout(session: string): string {
  return run(["--session", session, "action", "dump-layout"]).stdout;
}

export function action(session: string, ...args: string[]): void {
  run(["--session", session, "action", ...args], true);
}

function extractTopLevelTabBlocks(layout: string): Array<{ index: number; header: string; body: string }> {
  const runtimeLayout = layout.split("\n    new_tab_template")[0] ?? layout;
  const tabs: Array<{ index: number; header: string; body: string }> = [];

  let cursor = 0;
  let tabIndex = 0;
  while (true) {
    const tabStart = runtimeLayout.indexOf("\n    tab ", cursor);
    if (tabStart === -1) break;
    const openIdx = runtimeLayout.indexOf("{", tabStart);
    if (openIdx === -1) break;
    const closeIdx = findMatchingBrace(runtimeLayout, openIdx);
    if (closeIdx === -1) break;

    const header = runtimeLayout.slice(tabStart, openIdx);
    const body = runtimeLayout.slice(openIdx + 1, closeIdx);
    tabs.push({ index: tabIndex, header, body });
    tabIndex += 1;
    cursor = closeIdx + 1;
  }

  return tabs;
}

export function parseTabState(layout: string): TabState {
  const tabs = extractTopLevelTabBlocks(layout);
  let focusedTabIndex: number | null = null;
  const jellyTabIndices: number[] = [];
  let jellyDockedInFocusedTab = false;
  let jellyFloatingInFocusedTab = false;
  const jellyPattern = /name="Jelly J"|command="[^"]*jelly-j[^"]*"/;

  for (const tab of tabs) {
    if (/focus=true/.test(tab.header)) {
      focusedTabIndex = tab.index;
      const floatingBlocks = extractFloatingPaneBlocksFromText(tab.body);
      jellyFloatingInFocusedTab = floatingBlocks.some((block) => jellyPattern.test(block));
      const nonFloatingBody = stripFloatingPaneSectionsFromText(tab.body);
      jellyDockedInFocusedTab = jellyPattern.test(nonFloatingBody);
    }
    if (jellyPattern.test(tab.body)) {
      jellyTabIndices.push(tab.index);
    }
  }

  return {
    focusedTabIndex,
    jellyTabIndices,
    jellyDockedInFocusedTab,
    jellyFloatingInFocusedTab,
  };
}

export async function waitForStableLayout(session: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableHits = 0;

  while (Date.now() < deadline) {
    const current = dumpLayout(session);
    if (current === previous) {
      stableHits += 1;
      if (stableHits >= 2) return current;
    } else {
      stableHits = 0;
      previous = current;
    }
    await sleep(200);
  }
  return dumpLayout(session);
}

export const harnessConfig = {
  webBaseUrl: WEB_BASE_URL,
  altKey: process.env.JJ_HARNESS_KEY ?? "Alt+j",
};
