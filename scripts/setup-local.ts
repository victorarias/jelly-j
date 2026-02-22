import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PatchResult =
  | { kind: "already"; nextContent: string; message: string }
  | { kind: "patched"; nextContent: string; message: string }
  | { kind: "manual"; nextContent: string; message: string };

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipBuild = args.has("--no-build");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const pluginDir = path.join(repoRoot, "plugin");
const builtWasmPath = path.join(pluginDir, "target", "wasm32-wasip1", "release", "jelly-j.wasm");
const zellijPluginDir = path.join(os.homedir(), ".config", "zellij", "plugins");
const installedWasmPath = path.join(zellijPluginDir, "jelly-j.wasm");
const configPath = path.join(os.homedir(), ".config", "zellij", "config.kdl");
const pluginUrl = `file:${installedWasmPath}`;

function altJBinding(indent: string): string {
  const inner = `${indent}    `;
  const leaf = `${inner}    `;
  return [
    `${indent}bind "Alt j" {`,
    `${inner}MessagePlugin "${pluginUrl}" {`,
    `${leaf}name "toggle"`,
    `${leaf}floating true`,
    `${inner}}`,
    `${indent}}`,
  ].join("\n");
}

function manualSnippet(): string {
  return [
    "keybinds {",
    "    shared {",
    "        bind \"Alt j\" {",
    `            MessagePlugin \"${pluginUrl}\" {`,
    "                name \"toggle\"",
    "                floating true",
    "            }",
    "        }",
    "    }",
    "}",
  ].join("\n");
}

function patchConfig(content: string): PatchResult {
  let next = content;
  let updatedTildePath = false;

  if (next.includes('file:~/.config/zellij/plugins/jelly-j.wasm')) {
    next = next.replaceAll('file:~/.config/zellij/plugins/jelly-j.wasm', pluginUrl);
    updatedTildePath = true;
  }

  const existingAltJBlock = /^([ \t]*)bind "Alt j"\s*\{[\s\S]*?^\1\}/m;
  if (existingAltJBlock.test(next)) {
    const replaced = next.replace(existingAltJBlock, (_match, indent: string) => altJBinding(indent));
    if (replaced === content) {
      return {
        kind: "already",
        nextContent: replaced,
        message: "Alt+j binding already points to Jelly J.",
      };
    }
    return {
      kind: "patched",
      nextContent: replaced,
      message: "Replaced existing Alt+j block with Jelly J MessagePlugin binding.",
    };
  }

  const oneLineAltJ = /^([ \t]*)bind "Alt j"\s*\{[^\n]*\}\s*$/m;
  if (oneLineAltJ.test(next)) {
    const replaced = next.replace(oneLineAltJ, (_match, indent: string) => altJBinding(indent));
    return {
      kind: "patched",
      nextContent: replaced,
      message: "Replaced one-line Alt+j binding with Jelly J MessagePlugin binding.",
    };
  }

  if (updatedTildePath) {
    return {
      kind: "patched",
      nextContent: next,
      message: "Updated Jelly J plugin URL to absolute path in existing config.",
    };
  }

  return {
    kind: "manual",
    nextContent: next,
    message: "Could not safely auto-patch Alt+j in config.kdl.",
  };
}

async function run(cmd: string, cmdArgs: string[], cwd: string): Promise<void> {
  if (dryRun) {
    process.stdout.write(`[dry-run] ${cmd} ${cmdArgs.join(" ")} (cwd: ${cwd})\n`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function tryReconfigure(): Promise<void> {
  if (dryRun) {
    process.stdout.write("[dry-run] Would run `zellij action reconfigure`.\n");
    return;
  }

  try {
    await run("zellij", ["action", "reconfigure"], repoRoot);
    process.stdout.write("Reloaded Zellij config via `zellij action reconfigure`.\n");
  } catch {
    process.stdout.write("Skipping `zellij action reconfigure` (no active session or command unavailable).\n");
  }
}

async function main(): Promise<void> {
  process.stdout.write("Setting up Jelly J local environment...\n");

  if (!skipBuild) {
    await run("cargo", ["build", "--release", "--target", "wasm32-wasip1"], pluginDir);
  } else {
    process.stdout.write("Skipping plugin build (--no-build).\n");
  }

  await mkdir(zellijPluginDir, { recursive: true });
  if (!dryRun) {
    await copyFile(builtWasmPath, installedWasmPath);
  }
  process.stdout.write(`${dryRun ? "[dry-run] Would copy" : "Copied"} plugin to ${installedWasmPath}\n`);

  let configContent: string;
  try {
    configContent = await readFile(configPath, "utf8");
  } catch {
    process.stdout.write(`No config found at ${configPath}.\n`);
    process.stdout.write("Create that file, then add this block:\n\n");
    process.stdout.write(`${manualSnippet()}\n`);
    return;
  }

  const patchResult = patchConfig(configContent);

  if (patchResult.kind === "patched") {
    const backupPath = `${configPath}.jelly-j.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (!dryRun) {
      await writeFile(backupPath, configContent, "utf8");
      await writeFile(configPath, patchResult.nextContent, "utf8");
    }
    process.stdout.write(`${patchResult.message}\n`);
    process.stdout.write(`${dryRun ? "[dry-run] Would write" : "Wrote"} backup: ${backupPath}\n`);
    await tryReconfigure();
    return;
  }

  if (patchResult.kind === "already") {
    process.stdout.write(`${patchResult.message}\n`);
    await tryReconfigure();
    return;
  }

  process.stdout.write(`${patchResult.message}\n`);
  process.stdout.write("Please add this snippet manually:\n\n");
  process.stdout.write(`${manualSnippet()}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`setup failed: ${message}\n`);
  process.exit(1);
});
