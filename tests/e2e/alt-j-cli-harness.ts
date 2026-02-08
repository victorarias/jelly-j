import { execFileSync } from "node:child_process";

type CmdResult = {
  stdout: string;
  stderr: string;
  status: number;
};

type FloatingPaneStats = {
  totalFloatingPanes: number;
  nonPluginFloatingPanes: number;
  jellyLikeFloatingPanes: number;
  blankFloatingPanes: number;
};

const ZELLIJ_BIN = process.env.ZELLIJ_BIN ?? "zellij";
const SESSION_PREFIX = process.env.JJ_CLI_HARNESS_PREFIX ?? "jj-cli-harness";
const ITERATIONS = Number.parseInt(process.env.JJ_CLI_HARNESS_ITERATIONS ?? "8", 10);
const SLEEP_MS = Number.parseInt(process.env.JJ_CLI_HARNESS_SLEEP_MS ?? "250", 10);
const PLUGIN_URL =
  process.env.JJ_PLUGIN_URL ??
  `file:${process.env.HOME ?? ""}/.config/zellij/plugins/jelly-j-launcher.wasm`;

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

async function main(): Promise<void> {
  const session = `${SESSION_PREFIX}-${Date.now().toString(36)}`;
  const rssSamples: number[] = [];
  const floatingSamples: FloatingPaneStats[] = [];

  deleteSessionsByPrefix(SESSION_PREFIX);

  console.log(
    JSON.stringify({
      phase: "start",
      session,
      iterations: ITERATIONS,
      sleepMs: SLEEP_MS,
      pluginUrl: PLUGIN_URL,
    }),
  );

  run(["attach", "--create-background", session]);

  try {
    for (let i = 1; i <= ITERATIONS; i += 1) {
      run(
        [
          "--session",
          session,
          "action",
          "launch-or-focus-plugin",
          "--floating",
          "--move-to-focused-tab",
          PLUGIN_URL,
        ],
        true,
      );
      run(["--session", session, "action", "switch-mode", "normal"], true);
      await sleep(SLEEP_MS);

      const layout = run(["--session", session, "action", "dump-layout"], true).stdout;
      const stats = parseFloatingPaneStats(layout);
      floatingSamples.push(stats);

      const pid = serverPidForSession(session);
      const rssKb = pid ? rssKbForPid(pid) : null;
      if (rssKb !== null) rssSamples.push(rssKb);

      console.log(
        JSON.stringify({
          phase: "sample",
          iteration: i,
          serverPid: pid,
          rssKb,
          ...stats,
        }),
      );
    }
  } finally {
    deleteSession(session);
    await sleep(200);
    deleteSessionsByPrefix(SESSION_PREFIX);
  }

  const minRssKb = rssSamples.length ? Math.min(...rssSamples) : null;
  const maxRssKb = rssSamples.length ? Math.max(...rssSamples) : null;
  const rssDeltaKb =
    minRssKb !== null && maxRssKb !== null ? Math.max(0, maxRssKb - minRssKb) : null;

  const maxNonPluginFloating = floatingSamples.length
    ? Math.max(...floatingSamples.map((s) => s.nonPluginFloatingPanes))
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

  console.log(
    JSON.stringify({
      phase: "summary",
      samples: rssSamples.length,
      minRssKb,
      maxRssKb,
      rssDeltaKb,
      maxNonPluginFloating,
      maxBlankFloating,
      survivors,
    }),
  );

  if (hasSurvivors) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
