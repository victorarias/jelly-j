import { spawn } from "node:child_process";
import { probeDaemonHealth } from "./daemon-health.js";
import { runDaemon } from "./daemon.js";
import { DAEMON_SOCKET_PATH, processIsAlive, readAgentLockOwner } from "./state.js";
import { runUiClient } from "./ui-client.js";

const DAEMON_BOOT_TIMEOUT_MS = 8_000;
const DAEMON_POLL_INTERVAL_MS = 120;
const DAEMON_STOP_TIMEOUT_MS = 2_000;
const DAEMON_PROBE_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function daemonHealthWithRetries(): Promise<{
  ok: boolean;
  daemonPid?: number;
  error?: string;
}> {
  let last: { ok: boolean; daemonPid?: number; error?: string } = { ok: false };
  for (let attempt = 0; attempt <= DAEMON_PROBE_RETRIES; attempt += 1) {
    last = await probeDaemonHealth();
    if (last.ok) return last;
    if (attempt < DAEMON_PROBE_RETRIES) {
      await sleep(80);
    }
  }
  return last;
}

async function stopDaemonFromLock(): Promise<void> {
  const owner = await readAgentLockOwner();
  const pid = owner?.pid;
  if (!pid || !processIsAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(80);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

function spawnDetachedDaemon(): void {
  const runtime = process.argv[0];
  const entrypoint = process.argv[1];
  if (!runtime || !entrypoint) {
    throw new Error("Unable to determine runtime/entrypoint for daemon spawn.");
  }

  const child = spawn(runtime, [entrypoint, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      JELLY_J_DAEMON_MODE: "1",
    },
  });
  child.unref();
}

async function ensureDaemonRunning(): Promise<void> {
  const initialHealth = await daemonHealthWithRetries();
  if (initialHealth.ok) return;

  await stopDaemonFromLock();

  spawnDetachedDaemon();

  const deadline = Date.now() + DAEMON_BOOT_TIMEOUT_MS;
  let lastError = initialHealth.error;
  while (Date.now() < deadline) {
    const health = await daemonHealthWithRetries();
    if (health.ok) return;
    lastError = health.error;
    await sleep(DAEMON_POLL_INTERVAL_MS);
  }

  const detail = lastError ? ` (last error: ${lastError})` : "";
  throw new Error(
    `Timed out waiting for healthy Jelly J daemon at ${DAEMON_SOCKET_PATH}${detail}`
  );
}

async function main(): Promise<void> {
  const mode = process.argv[2]?.trim().toLowerCase();

  if (mode === "daemon") {
    await runDaemon();
    return;
  }

  if (mode === "ui") {
    process.stdout.write("\x1b]0;Jelly J\x07");
    await ensureDaemonRunning();
    await runUiClient();
    return;
  }

  process.stdout.write("\x1b]0;Jelly J\x07");
  await ensureDaemonRunning();
  await runUiClient();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal: ${message}\n`);
  process.exit(1);
});
