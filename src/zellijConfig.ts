import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SETUP_CHECK_TIMEOUT_MS = 5000;

type ConfigSource = "setup-check" | "fallback";

export interface ZellijConfigInfo {
  source: ConfigSource;
  zellijVersion?: string;
  configDir: string;
  configFile: string;
  layoutDir: string;
  cacheDir?: string;
  dataDir?: string;
  pluginDir?: string;
  setupOutput?: string;
}

let configInfoPromise: Promise<ZellijConfigInfo> | undefined;
let zellijVersionPromise: Promise<string | undefined> | undefined;

function stripAnsi(input: string): string {
  return input
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isInsidePath(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function canonicalizePath(candidatePath: string): Promise<string> {
  const resolvedPath = path.resolve(candidatePath);
  let current = resolvedPath;
  const unresolvedSuffix: string[] = [];

  while (true) {
    try {
      const realCurrent = await fs.realpath(current);
      if (unresolvedSuffix.length === 0) {
        return realCurrent;
      }
      return path.resolve(realCurrent, ...unresolvedSuffix.reverse());
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolvedPath;
    }

    unresolvedSuffix.push(path.basename(current));
    current = parent;
  }
}

async function pathIsDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function fallbackConfigDirCandidates(): string[] {
  const home = os.homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [
    process.env.ZELLIJ_CONFIG_DIR,
    path.join(xdgConfigHome, "zellij"),
    path.join(home, "Library", "Application Support", "org.Zellij-Contributors.Zellij"),
    "/etc/zellij",
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function detectConfigDirFallback(): Promise<string> {
  const [firstCandidate, ...restCandidates] = fallbackConfigDirCandidates();
  if (!firstCandidate) return path.join(os.homedir(), ".config", "zellij");

  if (process.env.ZELLIJ_CONFIG_DIR) {
    return path.resolve(firstCandidate);
  }

  for (const candidate of [firstCandidate, ...restCandidates]) {
    if (await pathIsDirectory(candidate)) {
      return path.resolve(candidate);
    }
  }

  return path.resolve(firstCandidate);
}

function parseSetupCheckOutput(stdout: string): Record<string, string> {
  const cleaned = stripAnsi(stdout);
  const parsed: Record<string, string> = {};

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^\[([^\]]+)\]:\s*(.*)$/);
    if (!match) continue;
    parsed[match[1].trim()] = stripWrappingQuotes(match[2]);
  }

  return parsed;
}

async function detectFromSetupCheck(): Promise<ZellijConfigInfo | null> {
  try {
    const { stdout } = await execFileAsync("zellij", ["setup", "--check"], {
      timeout: SETUP_CHECK_TIMEOUT_MS,
    });

    const parsed = parseSetupCheckOutput(stdout);
    const configDir = parsed["CONFIG DIR"];
    const configFile = parsed["LOOKING FOR CONFIG FILE FROM"];

    if (!configDir || !configFile) {
      return null;
    }

    const resolvedConfigDir = path.resolve(configDir);
    const resolvedConfigFile = path.resolve(configFile);

    return {
      source: "setup-check",
      zellijVersion: parsed["Version"],
      configDir: resolvedConfigDir,
      configFile: resolvedConfigFile,
      layoutDir: parsed["LAYOUT DIR"]
        ? path.resolve(parsed["LAYOUT DIR"])
        : path.join(resolvedConfigDir, "layouts"),
      cacheDir: parsed["CACHE DIR"] ? path.resolve(parsed["CACHE DIR"]) : undefined,
      dataDir: parsed["DATA DIR"] ? path.resolve(parsed["DATA DIR"]) : undefined,
      pluginDir: parsed["PLUGIN DIR"] ? path.resolve(parsed["PLUGIN DIR"]) : undefined,
      setupOutput: stripAnsi(stdout).trim(),
    };
  } catch {
    return null;
  }
}

async function detectConfigInfo(): Promise<ZellijConfigInfo> {
  const fromSetup = await detectFromSetupCheck();
  if (fromSetup) return fromSetup;

  const configDir = await detectConfigDirFallback();
  const configFile = process.env.ZELLIJ_CONFIG_FILE
    ? path.resolve(process.env.ZELLIJ_CONFIG_FILE)
    : path.join(configDir, "config.kdl");

  return {
    source: "fallback",
    configDir,
    configFile,
    layoutDir: path.join(configDir, "layouts"),
  };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

export async function getZellijConfigInfo(): Promise<ZellijConfigInfo> {
  if (!configInfoPromise) {
    configInfoPromise = detectConfigInfo();
  }
  return configInfoPromise;
}

export function getZellijConfigRoots(info: ZellijConfigInfo): string[] {
  return uniquePaths([info.configDir, path.dirname(info.configFile), info.layoutDir]);
}

export async function getCanonicalZellijConfigRoots(
  info: ZellijConfigInfo
): Promise<string[]> {
  const roots = getZellijConfigRoots(info);
  const canonicalRoots = await Promise.all(roots.map((root) => canonicalizePath(root)));
  return uniquePaths(canonicalRoots);
}

export async function getZellijAdditionalDirectories(
  info: ZellijConfigInfo
): Promise<string[]> {
  const home = os.homedir();
  const preferredRoots = getZellijConfigRoots(info);
  const optionalCandidates = uniquePaths([
    path.join(home, ".config", "zellij"),
    path.join(home, "Library", "Application Support", "org.Zellij-Contributors.Zellij"),
    "/etc/zellij",
  ]);

  const existing: string[] = [];
  for (const candidate of optionalCandidates) {
    if (await pathIsDirectory(candidate)) {
      existing.push(candidate);
    }
  }

  return uniquePaths([...preferredRoots, ...existing]);
}

export async function resolveZellijConfigPath(
  info: ZellijConfigInfo,
  requestedPath: string | undefined
): Promise<string> {
  const roots = getZellijConfigRoots(info);
  const primaryRoot = roots[0] ?? path.dirname(info.configFile);
  const normalized = requestedPath?.trim() ?? "";
  const resolvedPath =
    normalized === ""
      ? path.resolve(info.configFile)
      : path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(primaryRoot, normalized);

  const [canonicalResolvedPath, canonicalConfigFile, canonicalRoots] = await Promise.all([
    canonicalizePath(resolvedPath),
    canonicalizePath(info.configFile),
    getCanonicalZellijConfigRoots(info),
  ]);

  const isAllowed = canonicalRoots.some((root) =>
    isInsidePath(canonicalResolvedPath, root)
  );
  if (!isAllowed && canonicalResolvedPath !== canonicalConfigFile) {
    throw new Error(
      `Refusing to access path outside zellij config roots: ${canonicalResolvedPath}`
    );
  }

  return canonicalResolvedPath;
}

export async function getInstalledZellijVersion(): Promise<string | undefined> {
  if (!zellijVersionPromise) {
    zellijVersionPromise = (async () => {
      try {
        const { stdout } = await execFileAsync("zellij", ["--version"], {
          timeout: SETUP_CHECK_TIMEOUT_MS,
        });
        const normalized = stdout.trim();
        if (!normalized) return undefined;

        // Common output shape: "zellij 0.43.1"
        const match = normalized.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
        return match?.[1] ?? normalized;
      } catch {
        return undefined;
      }
    })();
  }
  return zellijVersionPromise;
}
