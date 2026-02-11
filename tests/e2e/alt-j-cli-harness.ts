import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

type CmdResult = {
  stdout: string;
  stderr: string;
  status: number;
};

type TimedCmdResult = CmdResult & {
  durationMs: number;
};

type FloatingPaneStats = {
  totalFloatingPanes: number;
  nonPluginFloatingPanes: number;
  jellyLikeFloatingPanes: number;
  blankFloatingPanes: number;
};

type ButlerPaneState = {
  id: number;
  tab_index: number;
  title: string;
  terminal_command?: string | null;
  is_plugin: boolean;
  is_floating: boolean;
  is_suppressed?: boolean;
  exited?: boolean;
};

type ButlerTabState = {
  position: number;
  name: string;
  active: boolean;
};

type ButlerWorkspaceState = {
  tabs?: ButlerTabState[];
  panes: ButlerPaneState[];
  butler?: {
    jelly_pane_id?: number | null;
  };
};

type DaemonProbeResult = {
  ok: boolean;
  daemonPid?: number;
  error?: string;
  durationMs: number;
};

type DaemonChatProbeResult = {
  ok: boolean;
  assistantText: string;
  statusNotes: string[];
  resultErrors: string[];
  error?: string;
  durationMs: number;
};

const ZELLIJ_BIN = process.env.ZELLIJ_BIN ?? "zellij";
const SESSION_PREFIX = process.env.JJ_CLI_HARNESS_PREFIX ?? "jj-cli-harness";
const ITERATIONS = Number.parseInt(process.env.JJ_CLI_HARNESS_ITERATIONS ?? "8", 10);
const SLEEP_MS = Number.parseInt(process.env.JJ_CLI_HARNESS_SLEEP_MS ?? "250", 10);
const DEFAULT_PLUGIN_URL =
  process.env.JJ_PLUGIN_URL ??
  `file:${process.env.HOME ?? ""}/.config/zellij/plugins/jelly-j.wasm`;
const COPY_PLUGIN_FOR_RUN = process.env.JJ_CLI_HARNESS_COPY_PLUGIN !== "0";
const REQUIRED_PERMISSIONS = [
  "ReadApplicationState",
  "ChangeApplicationState",
  "OpenTerminalsOrPlugins",
  "WriteToStdin",
  "ReadCliPipes",
];
const DAEMON_SOCKET_PATH = path.join(os.homedir(), ".jelly-j", "daemon.sock");
const CHAT_PROBE_ENABLED = process.env.JJ_CLI_HARNESS_CHAT_PROBE !== "0";
const CHAT_PROBE_TIMEOUT_MS = Number.parseInt(
  process.env.JJ_CLI_HARNESS_CHAT_TIMEOUT_MS ?? "90000",
  10,
);
let ACTIVE_PLUGIN_URL = DEFAULT_PLUGIN_URL;

function run(args: string[], allowFailure = false, timeoutMs = 10_000): CmdResult {
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

function runTimed(args: string[], allowFailure = false, timeoutMs = 10_000): TimedCmdResult {
  const start = Date.now();
  const result = run(args, allowFailure, timeoutMs);
  return { ...result, durationMs: Date.now() - start };
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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function zellijPermissionsCachePath(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Caches",
      "org.Zellij-Contributors.Zellij",
      "permissions.kdl",
    );
  }
  return path.join(os.homedir(), ".cache", "org.Zellij-Contributors.Zellij", "permissions.kdl");
}

function normalizePluginPath(pluginUrl: string): string | null {
  if (!pluginUrl) return null;
  if (pluginUrl.startsWith("file:")) {
    try {
      return new URL(pluginUrl).pathname;
    } catch {
      return pluginUrl.slice("file:".length);
    }
  }
  return pluginUrl;
}

function pluginUrlToPath(pluginUrl: string): string | null {
  if (pluginUrl.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(pluginUrl).pathname);
    } catch {
      return pluginUrl.slice("file:".length);
    }
  }
  if (path.isAbsolute(pluginUrl)) {
    return pluginUrl;
  }
  return null;
}

function prepareHarnessPluginUrl(basePluginUrl: string): {
  pluginUrl: string;
  cleanup: () => void;
} {
  if (!COPY_PLUGIN_FOR_RUN) {
    return { pluginUrl: basePluginUrl, cleanup: () => {} };
  }

  const sourcePath = pluginUrlToPath(basePluginUrl);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { pluginUrl: basePluginUrl, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jelly-j-plugin-"));
  const copiedPath = path.join(tempDir, "jelly-j.wasm");
  fs.copyFileSync(sourcePath, copiedPath);
  const fileUrl = new URL(`file://${copiedPath}`).toString();

  return {
    pluginUrl: fileUrl,
    cleanup: () => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function ensurePermissionsCached(pluginUrl: string): void {
  const cachePath = zellijPermissionsCachePath();
  const pluginPath = normalizePluginPath(pluginUrl);
  if (!pluginPath) return;

  const keyVariants = new Set<string>([
    pluginUrl,
    pluginPath,
    `file:${pluginPath}`,
    `file://${pluginPath}`,
    `file:///${pluginPath.replace(/^\//, "")}`,
  ]);

  let existing = "";
  try {
    existing = fs.readFileSync(cachePath, "utf8");
  } catch {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  }

  const additions: string[] = [];
  for (const key of keyVariants) {
    if (!key) continue;
    const marker = `"${key}" {`;
    if (existing.includes(marker)) continue;
    const perms = REQUIRED_PERMISSIONS.map((p) => `    ${p}`).join("\n");
    additions.push(`${marker}\n${perms}\n}\n`);
  }

  if (additions.length > 0) {
    const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
    fs.appendFileSync(cachePath, `${prefix}${additions.join("")}`);
  }
}

function startAttachedClient(session: string): number | null {
  const transcript = `/tmp/${session}.typescript`;
  const attachCommand =
    process.platform === "darwin"
      ? `script -q ${shQuote(transcript)} ${shQuote(ZELLIJ_BIN)} attach ${shQuote(session)}`
      : `script -q -c ${shQuote(`${ZELLIJ_BIN} attach ${session}`)} ${shQuote(transcript)}`;
  const pidRaw = runShell(`${attachCommand} >/dev/null 2>&1 & echo $!`);
  const pid = Number.parseInt(pidRaw, 10);
  return Number.isNaN(pid) ? null : pid;
}

function stopAttachedClient(pid: number | null): void {
  if (pid === null) return;
  runShell(`kill -TERM -${pid} >/dev/null 2>&1 || kill -TERM ${pid} >/dev/null 2>&1 || true`);
}

function approvePluginPermissions(session: string): void {
  run(["--session", session, "action", "write-chars", "y"], true);
  run(["--session", session, "action", "write", "13"], true);
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

function extractFloatingPaneBlocks(layout: string): string[] {
  const runtimeLayout = layout.split("\n    new_tab_template")[0] ?? layout;
  const sections: string[] = [];

  let cursor = 0;
  while (true) {
    const floatingIdx = runtimeLayout.indexOf("floating_panes", cursor);
    if (floatingIdx === -1) break;
    const openIdx = runtimeLayout.indexOf("{", floatingIdx);
    if (openIdx === -1) break;
    const closeIdx = findMatchingBrace(runtimeLayout, openIdx);
    if (closeIdx === -1) break;
    sections.push(runtimeLayout.slice(openIdx + 1, closeIdx));
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

function parseFloatingPaneStats(layout: string): FloatingPaneStats {
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

function parseFloatingPaneStatsFromButlerState(state: ButlerWorkspaceState): FloatingPaneStats {
  let nonPlugin = 0;
  let jellyLike = 0;
  let blank = 0;
  let total = 0;

  for (const pane of state.panes) {
    if (!pane.is_floating) continue;
    total += 1;
    const command = pane.terminal_command ?? "";
    const isJelly = pane.title === "Jelly J" || command.includes("jelly-j");
    if (!pane.is_plugin) nonPlugin += 1;
    if (isJelly) jellyLike += 1;
    if (!pane.is_plugin && pane.title.trim() === "" && command.trim() === "") blank += 1;
  }

  return {
    totalFloatingPanes: total,
    nonPluginFloatingPanes: nonPlugin,
    jellyLikeFloatingPanes: jellyLike,
    blankFloatingPanes: blank,
  };
}

function isJellyPane(pane: ButlerPaneState): boolean {
  const command = pane.terminal_command ?? "";
  return pane.title === "Jelly J" || command.includes("jelly-j");
}

function activeTabPosition(state: ButlerWorkspaceState): number | undefined {
  return state.tabs?.find((tab) => tab.active)?.position;
}

function goToTab(session: string, position: number, tabName?: string): void {
  if (tabName) {
    run(
      [
        "--session",
        session,
        "action",
        "go-to-tab-name",
        tabName,
      ],
      true,
    );
  }
  run(
    ["--session", session, "action", "go-to-tab", String(position)],
    true,
  );
}

function toggleFromHarness(session: string): TimedCmdResult {
  return runTimed(
    [
      "--session",
      session,
      "pipe",
      "--name",
      "toggle",
      "--plugin",
      ACTIVE_PLUGIN_URL,
      "--",
      "toggle",
    ],
    true,
    3_500,
  );
}

async function runCrossTabFloatingCheck(session: string): Promise<{
  ok: boolean;
  reason?: string;
  activeTab?: number;
  jellyOnActive?: number;
  jellyFloatingOnActive?: number;
}> {
  const secondTabName = `jj-harness-tab-${Date.now().toString(36)}`;

  goToTab(session, 1);
  await sleep(120);

  // Ensure we have a live Jelly pane before switching tabs.
  toggleFromHarness(session);
  await sleep(220);
  let state = queryButlerState(session);
  if (!state) {
    return { ok: false, reason: "cross_tab_state_unavailable_after_toggle_1" };
  }
  const activeTabAfterFirstToggle = activeTabPosition(state);
  const jellyVisibleOnActiveAfterFirstToggle =
    activeTabAfterFirstToggle !== undefined &&
    state.panes.some(
      (pane) =>
        pane.tab_index === activeTabAfterFirstToggle &&
        isJellyPane(pane) &&
        !pane.is_suppressed
    );
  if (!jellyVisibleOnActiveAfterFirstToggle) {
    toggleFromHarness(session);
    await sleep(220);
    state = queryButlerState(session);
    if (!state) {
      return { ok: false, reason: "cross_tab_state_unavailable_after_toggle_2" };
    }
  }

  run(["--session", session, "action", "new-tab", "--name", secondTabName], true);
  await sleep(120);
  goToTab(session, 2, secondTabName);
  await sleep(120);
  // Some Zellij versions treat go-to-tab as zero-based.
  goToTab(session, 1, secondTabName);
  await sleep(120);

  const stateAfterTabSwitch = queryButlerState(session);
  if (!stateAfterTabSwitch) {
    return { ok: false, reason: "cross_tab_state_unavailable_after_tab_switch" };
  }
  const activeAfterTabSwitch = activeTabPosition(stateAfterTabSwitch);
  if (activeAfterTabSwitch === undefined || activeAfterTabSwitch === 0) {
    return {
      ok: false,
      reason: "cross_tab_failed_to_focus_second_tab",
      activeTab: activeAfterTabSwitch,
    };
  }

  const toggleResult = toggleFromHarness(session);
  if (toggleResult.status !== 0) {
    return {
      ok: false,
      reason: `cross_tab_toggle_failed:${toggleResult.status}`,
    };
  }
  await sleep(260);

  const finalState = queryButlerState(session);
  if (!finalState) {
    return { ok: false, reason: "cross_tab_state_unavailable_after_tab2_toggle" };
  }

  let lastActiveTab = activeTabPosition(finalState);
  let lastJellyOnActive = 0;
  let lastJellyFloatingOnActive = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = queryButlerState(session);
    if (!state) {
      await sleep(120);
      continue;
    }

    const activeTab = activeTabPosition(state);
    if (activeTab === undefined) {
      await sleep(120);
      continue;
    }

    const trackedJellyPaneId = state.butler?.jelly_pane_id ?? undefined;
    const jellyOnActive = state.panes.filter((pane) => {
      if (pane.tab_index !== activeTab || pane.is_plugin || pane.exited) return false;
      if (isJellyPane(pane)) return true;
      return trackedJellyPaneId !== undefined && pane.id === trackedJellyPaneId;
    });
    const jellyFloatingOnActive = jellyOnActive.filter((pane) => pane.is_floating);

    lastActiveTab = activeTab;
    lastJellyOnActive = jellyOnActive.length;
    lastJellyFloatingOnActive = jellyFloatingOnActive.length;

    if (jellyOnActive.length === 0) {
      await sleep(120);
      continue;
    }
    if (jellyFloatingOnActive.length === 0) {
      return {
        ok: false,
        reason: "cross_tab_jelly_not_floating",
        activeTab,
        jellyOnActive: jellyOnActive.length,
        jellyFloatingOnActive: jellyFloatingOnActive.length,
      };
    }

    return {
      ok: true,
      activeTab,
      jellyOnActive: jellyOnActive.length,
      jellyFloatingOnActive: jellyFloatingOnActive.length,
    };
  }

  return {
    ok: false,
    reason: "cross_tab_no_jelly_on_active_tab",
    activeTab: lastActiveTab,
    jellyOnActive: lastJellyOnActive,
    jellyFloatingOnActive: lastJellyFloatingOnActive,
  };
}

function queryButlerState(session: string): ButlerWorkspaceState | null {
  const request = run(
    [
      "--session",
      session,
      "pipe",
      "--name",
      "request",
      "--plugin",
      ACTIVE_PLUGIN_URL,
      "--",
      JSON.stringify({ op: "get_state" }),
    ],
    true,
    3_500,
  );
  if (request.status !== 0) return null;

  try {
    const parsed = JSON.parse(request.stdout) as {
      ok?: boolean;
      result?: ButlerWorkspaceState;
      code?: string;
    };
    if (parsed.ok !== true || !parsed.result) return null;
    return parsed.result;
  } catch {
    return null;
  }
}

function queryButlerTrace(session: string, limit = 80): string[] {
  const request = run(
    [
      "--session",
      session,
      "pipe",
      "--name",
      "request",
      "--plugin",
      ACTIVE_PLUGIN_URL,
      "--",
      JSON.stringify({ op: "get_trace", limit }),
    ],
    true,
    3_500,
  );
  if (request.status !== 0) return [];

  try {
    const parsed = JSON.parse(request.stdout) as {
      ok?: boolean;
      result?: { entries?: string[] };
    };
    if (parsed.ok !== true) return [];
    return Array.isArray(parsed.result?.entries) ? parsed.result.entries : [];
  } catch {
    return [];
  }
}

function listSessions(): string[] {
  const listed = run(["list-sessions"], true);
  return stripAnsi(listed.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(" ")[0])
    .filter(Boolean);
}

function deleteSession(session: string): void {
  run(["kill-session", session], true);
  run(["delete-session", session], true);
}

function deleteSessionsByPrefix(prefix: string): void {
  for (const session of listSessions()) {
    if (session.startsWith(prefix)) {
      deleteSession(session);
    }
  }
}

function serverPidForSession(session: string): number | null {
  const raw = runShell(`pgrep -f "zellij --server .*${session}" || true`);
  const first = raw.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) return null;
  const pid = Number.parseInt(first, 10);
  return Number.isNaN(pid) ? null : pid;
}

function rssKbForPid(pid: number): number | null {
  const raw = runShell(`ps -o rss= -p ${pid} 2>/dev/null || true`).trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

async function probeDaemonProtocol(timeoutMs = 2_000): Promise<DaemonProbeResult> {
  const start = Date.now();
  const clientId = `harness-${process.pid}-${Date.now().toString(36)}`;
  const requestId = randomUUID();

  return await new Promise<DaemonProbeResult>((resolve) => {
    const socket = createConnection(DAEMON_SOCKET_PATH);
    let settled = false;
    let buffer = "";
    let daemonPid: number | undefined;

    const finish = (result: Omit<DaemonProbeResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      resolve({
        ...result,
        durationMs: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: "daemon_protocol_timeout", daemonPid });
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "register_client",
          clientId,
          zellijSession: "harness",
          cwd: process.cwd(),
          hostname: os.hostname(),
          pid: process.pid,
        })}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        try {
          const parsed = JSON.parse(line) as { type?: string; daemonPid?: number; requestId?: string; message?: string };
          if (parsed.type === "registered") {
            daemonPid = parsed.daemonPid;
            socket.write(
              `${JSON.stringify({
                type: "ping",
                requestId,
                clientId,
              })}\n`,
            );
            continue;
          }
          if (parsed.type === "pong" && parsed.requestId === requestId) {
            finish({ ok: true, daemonPid: parsed.daemonPid ?? daemonPid });
            return;
          }
          if (parsed.type === "error") {
            finish({
              ok: false,
              daemonPid,
              error: parsed.message ?? "daemon_error_message",
            });
            return;
          }
        } catch {
          // Ignore malformed lines and keep waiting until timeout.
        }
      }
    });

    socket.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      finish({
        ok: false,
        error: err.code ? `daemon_socket_${err.code}` : "daemon_socket_error",
      });
    });
  });
}

async function probeDaemonProtocolWithRetry(retries = 2): Promise<DaemonProbeResult> {
  let last = await probeDaemonProtocol();
  for (let i = 0; i < retries && !last.ok; i += 1) {
    await sleep(120);
    last = await probeDaemonProtocol();
  }
  return last;
}

async function probeDaemonChat(text: string): Promise<DaemonChatProbeResult> {
  const start = Date.now();
  const clientId = `chat-harness-${process.pid}-${Date.now().toString(36)}`;
  const requestId = randomUUID();

  return await new Promise<DaemonChatProbeResult>((resolve) => {
    const socket = createConnection(DAEMON_SOCKET_PATH);
    let settled = false;
    let buffer = "";
    let assistantText = "";
    let errorMessage: string | undefined;
    let chatRequestSent = false;
    const statusNotes: string[] = [];
    const resultErrors: string[] = [];

    const finish = (result: Omit<DaemonChatProbeResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      resolve({
        ...result,
        durationMs: Date.now() - start,
      });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        assistantText,
        statusNotes,
        resultErrors,
        error: "chat_probe_timeout",
      });
    }, CHAT_PROBE_TIMEOUT_MS);

    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "register_client",
          clientId,
          zellijSession: "cli-harness",
          cwd: process.cwd(),
          hostname: os.hostname(),
          pid: process.pid,
        })}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            requestId?: string;
            text?: string;
            message?: string;
            subtype?: string;
            errors?: string[];
            ok?: boolean;
          };
          if (parsed.type === "history_snapshot" && !chatRequestSent) {
            chatRequestSent = true;
            socket.write(
              `${JSON.stringify({
                type: "chat_request",
                requestId,
                clientId,
                text,
                zellijSession: "cli-harness",
              })}\n`,
            );
            continue;
          }
          if (parsed.type === "status_note" && typeof parsed.message === "string") {
            statusNotes.push(parsed.message);
            continue;
          }
          if (
            parsed.type === "chat_delta" &&
            parsed.requestId === requestId &&
            typeof parsed.text === "string"
          ) {
            assistantText += parsed.text;
            continue;
          }
          if (
            parsed.type === "result_error" &&
            parsed.requestId === requestId &&
            typeof parsed.subtype === "string" &&
            Array.isArray(parsed.errors)
          ) {
            resultErrors.push(`[${parsed.subtype}] ${parsed.errors.join("; ")}`);
            continue;
          }
          if (
            parsed.type === "error" &&
            parsed.requestId === requestId &&
            typeof parsed.message === "string"
          ) {
            errorMessage = parsed.message;
            continue;
          }
          if (parsed.type === "chat_end" && parsed.requestId === requestId) {
            const ok = parsed.ok === true && !errorMessage;
            finish({
              ok,
              assistantText: assistantText.trim(),
              statusNotes,
              resultErrors,
              error: ok ? undefined : errorMessage ?? "chat_end_not_ok",
            });
            return;
          }
        } catch {
          // Ignore malformed lines and keep waiting until timeout.
        }
      }
    });

    socket.once("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      finish({
        ok: false,
        assistantText,
        statusNotes,
        resultErrors,
        error: err.code ? `daemon_socket_${err.code}` : "daemon_socket_error",
      });
    });
  });
}

async function probeDaemonChatWithRetry(text: string, retries = 1): Promise<DaemonChatProbeResult> {
  let last = await probeDaemonChat(text);
  for (let i = 0; i < retries && !last.ok; i += 1) {
    await sleep(180);
    last = await probeDaemonChat(text);
  }
  return last;
}

async function main(): Promise<void> {
  const session = `${SESSION_PREFIX}-${Date.now().toString(36)}`;
  const rssSamples: number[] = [];
  const floatingSamples: FloatingPaneStats[] = [];
  let attachedClientPid: number | null = null;
  let toggleFailures = 0;
  let permissionApproveAttempts = 0;
  const toggleDurationsMs: number[] = [];
  let lastButlerState: ButlerWorkspaceState | null = null;
  let traceBeforeCleanup: string[] = [];
  let daemonProbeFailures = 0;
  const daemonProbeDurationsMs: number[] = [];
  let chatProbe: DaemonChatProbeResult | undefined;
  let crossTabCheck:
    | {
        ok: boolean;
        reason?: string;
        activeTab?: number;
        jellyOnActive?: number;
        jellyFloatingOnActive?: number;
      }
    | undefined;

  deleteSessionsByPrefix(SESSION_PREFIX);
  const preparedPlugin = prepareHarnessPluginUrl(DEFAULT_PLUGIN_URL);
  ACTIVE_PLUGIN_URL = preparedPlugin.pluginUrl;
  ensurePermissionsCached(ACTIVE_PLUGIN_URL);

  console.log(
    JSON.stringify({
      phase: "start",
      session,
      iterations: ITERATIONS,
      sleepMs: SLEEP_MS,
      pluginUrl: ACTIVE_PLUGIN_URL,
    }),
  );

  run(["attach", "--create-background", session]);
  attachedClientPid = startAttachedClient(session);
  await sleep(400);

  try {
    for (let i = 1; i <= ITERATIONS; i += 1) {
      let toggleResult = toggleFromHarness(session);
      if (toggleResult.status !== 0) {
        permissionApproveAttempts += 1;
        approvePluginPermissions(session);
        await sleep(150);
        toggleResult = toggleFromHarness(session);
      }
      if (toggleResult.status !== 0) {
        toggleFailures += 1;
      }
      toggleDurationsMs.push(toggleResult.durationMs);
      run(["--session", session, "action", "switch-mode", "normal"], true);
      await sleep(SLEEP_MS);

      const butlerState = queryButlerState(session);
      if (butlerState) lastButlerState = butlerState;
      const stats = butlerState
        ? parseFloatingPaneStatsFromButlerState(butlerState)
        : parseFloatingPaneStats(run(["--session", session, "action", "dump-layout"], true).stdout);
      floatingSamples.push(stats);

      const pid = serverPidForSession(session);
      const rssKb = pid ? rssKbForPid(pid) : null;
      if (rssKb !== null) rssSamples.push(rssKb);
      const daemonProbe = await probeDaemonProtocolWithRetry(i === 1 ? 12 : 3);
      daemonProbeDurationsMs.push(daemonProbe.durationMs);
      if (!daemonProbe.ok) {
        daemonProbeFailures += 1;
      }

      console.log(
        JSON.stringify({
          phase: "sample",
          iteration: i,
          toggleStatus: toggleResult.status,
          toggleDurationMs: toggleResult.durationMs,
          toggleStderr: toggleResult.status === 0 ? undefined : toggleResult.stderr.trim(),
          serverPid: pid,
          rssKb,
          daemonProbeOk: daemonProbe.ok,
          daemonProbeDurationMs: daemonProbe.durationMs,
          daemonProbePid: daemonProbe.daemonPid,
          daemonProbeError: daemonProbe.ok ? undefined : daemonProbe.error,
          ...stats,
        }),
      );
    }

    crossTabCheck = await runCrossTabFloatingCheck(session);
    if (CHAT_PROBE_ENABLED) {
      chatProbe = await probeDaemonChatWithRetry("Reply with exactly: ok", 1);
    }
  } finally {
    traceBeforeCleanup = queryButlerTrace(session, 120);
    stopAttachedClient(attachedClientPid);
    deleteSession(session);
    await sleep(200);
    deleteSessionsByPrefix(SESSION_PREFIX);
    preparedPlugin.cleanup();
  }

  const minRssKb = rssSamples.length ? Math.min(...rssSamples) : null;
  const maxRssKb = rssSamples.length ? Math.max(...rssSamples) : null;
  const rssDeltaKb =
    minRssKb !== null && maxRssKb !== null ? Math.max(0, maxRssKb - minRssKb) : null;

  const maxNonPluginFloating = floatingSamples.length
    ? Math.max(...floatingSamples.map((s) => s.nonPluginFloatingPanes))
    : 0;
  const maxJellyLikeFloating = floatingSamples.length
    ? Math.max(...floatingSamples.map((s) => s.jellyLikeFloatingPanes))
    : 0;
  const maxBlankFloating = floatingSamples.length
    ? Math.max(...floatingSamples.map((s) => s.blankFloatingPanes))
    : 0;

  const survivorsRaw = runShell(`pgrep -fal "zellij --server" || true`);
  const survivors = survivorsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => new RegExp(`/zellij --server .*${SESSION_PREFIX}`).test(line));
  const hasSurvivors = survivors.length > 0;

  const failures: string[] = [];
  const maxToggleDurationMs = toggleDurationsMs.length ? Math.max(...toggleDurationsMs) : null;
  const minToggleDurationMs = toggleDurationsMs.length ? Math.min(...toggleDurationsMs) : null;
  const maxDaemonProbeDurationMs = daemonProbeDurationsMs.length
    ? Math.max(...daemonProbeDurationsMs)
    : null;
  const minDaemonProbeDurationMs = daemonProbeDurationsMs.length
    ? Math.min(...daemonProbeDurationsMs)
    : null;
  if (maxJellyLikeFloating < 1) {
    failures.push("no_jelly_like_floating_pane_observed");
  }
  if (maxNonPluginFloating < 1) {
    failures.push("no_non_plugin_floating_pane_observed");
  }
  if (hasSurvivors) {
    failures.push("harness_sessions_survived_cleanup");
  }
  if (attachedClientPid === null) {
    failures.push("failed_to_attach_pseudo_client");
  }
  if (toggleFailures > 0) {
    failures.push("toggle_pipe_failed");
  }
  if (daemonProbeFailures > 0) {
    failures.push("daemon_protocol_unhealthy");
  }
  if (!crossTabCheck?.ok) {
    failures.push(`cross_tab_check_failed:${crossTabCheck?.reason ?? "unknown"}`);
  }
  if (CHAT_PROBE_ENABLED) {
    if (!chatProbe?.ok) {
      failures.push(`chat_probe_failed:${chatProbe?.error ?? "unknown"}`);
    } else if (!/\bok\b/i.test(chatProbe.assistantText)) {
      failures.push("chat_probe_unexpected_text");
    }
  }

  console.log(
    JSON.stringify({
      phase: "summary",
      samples: rssSamples.length,
      minRssKb,
      maxRssKb,
      rssDeltaKb,
      maxNonPluginFloating,
      maxJellyLikeFloating,
      maxBlankFloating,
      minToggleDurationMs,
      maxToggleDurationMs,
      minDaemonProbeDurationMs,
      maxDaemonProbeDurationMs,
      toggleFailures,
      daemonProbeFailures,
      crossTabCheck,
      chatProbeEnabled: CHAT_PROBE_ENABLED,
      chatProbe,
      permissionApproveAttempts,
      lastButlerState,
      traceBeforeCleanup,
      survivors,
      failures,
    }),
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
