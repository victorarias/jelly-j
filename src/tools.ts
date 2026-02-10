import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { zellijAction } from "./zellij.js";
import {
  clearButlerTrace,
  getButlerState,
  getButlerTrace,
  hidePaneById,
  renamePaneById,
  renameTabByPosition,
  showPaneById,
} from "./zellijPipe.js";
import {
  getInstalledZellijVersion,
  getZellijConfigInfo,
  getZellijConfigRoots,
  resolveZellijConfigPath,
} from "./zellijConfig.js";
import {
  ZELLIJ_KNOWLEDGE_GUIDE,
  searchZellijKnowledge,
} from "./zellijKnowledge.js";

// --- Workspace state tools ---

const getLayout = tool(
  "get_layout",
  "Dump the full current layout as KDL. Shows all tabs, panes, their IDs, running commands, cwd, and positions.",
  {},
  async () => {
    const { stdout } = await zellijAction("dump-layout");
    return { content: [{ type: "text", text: stdout }] };
  }
);

const listTabs = tool(
  "list_tabs",
  "List all tab names in the current session.",
  {},
  async () => {
    const { stdout } = await zellijAction("query-tab-names");
    return { content: [{ type: "text", text: stdout }] };
  }
);

const listClients = tool(
  "list_clients",
  "List connected clients, their focused pane IDs, and running commands.",
  {},
  async () => {
    const { stdout } = await zellijAction("list-clients");
    return { content: [{ type: "text", text: stdout }] };
  }
);

const getButlerStateTool = tool(
  "get_butler_state",
  "Return the Jelly J butler cached workspace state (tabs and panes) via plugin pipe IPC.",
  {},
  async () => {
    const state = await getButlerState();
    return {
      content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
    };
  }
);

const getButlerTraceTool = tool(
  "get_butler_trace",
  "Return recent Jelly J butler trace entries (state transitions and plugin actions).",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Maximum number of trace entries to return"),
  },
  async (args) => {
    const entries = await getButlerTrace(args.limit);
    return {
      content: [{ type: "text", text: JSON.stringify({ entries }, null, 2) }],
    };
  }
);

const clearButlerTraceTool = tool(
  "clear_butler_trace",
  "Clear the in-memory Jelly J butler trace buffer.",
  {},
  async () => {
    await clearButlerTrace();
    return { content: [{ type: "text", text: "Butler trace cleared" }] };
  }
);

// --- Tab management tools ---

const goToTab = tool(
  "go_to_tab",
  "Switch to a tab by index (1-based) or by name. If create is true and the tab doesn't exist, creates it.",
  {
    index: z.number().int().min(1).optional().describe("1-based tab index"),
    name: z.string().optional().describe("Tab name to navigate to"),
    create: z
      .boolean()
      .optional()
      .describe("Create the tab if it doesn't exist (only with name)"),
  },
  async (args) => {
    if (args.index) {
      await zellijAction("go-to-tab", String(args.index));
      return {
        content: [{ type: "text", text: `Switched to tab ${args.index}` }],
      };
    }
    if (args.name) {
      try {
        await zellijAction("go-to-tab-name", args.name);
        return {
          content: [{ type: "text", text: `Switched to tab "${args.name}"` }],
        };
      } catch {
        if (args.create) {
          await zellijAction("new-tab", "--name", args.name);
          return {
            content: [
              {
                type: "text",
                text: `Tab "${args.name}" didn't exist, created it`,
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: `Tab "${args.name}" not found` },
          ],
          isError: true,
        };
      }
    }
    return {
      content: [{ type: "text", text: "Provide either index or name" }],
      isError: true,
    };
  }
);

const newTab = tool(
  "new_tab",
  "Create a new tab with optional name, cwd, and layout.",
  {
    name: z.string().optional().describe("Tab name"),
    cwd: z.string().optional().describe("Working directory"),
    layout: z.string().optional().describe("Layout file path"),
  },
  async (args) => {
    const flags: string[] = [];
    if (args.name) flags.push("--name", args.name);
    if (args.cwd) flags.push("--cwd", args.cwd);
    if (args.layout) flags.push("--layout", args.layout);
    await zellijAction("new-tab", ...flags);
    return {
      content: [
        {
          type: "text",
          text: `Created new tab${args.name ? ` "${args.name}"` : ""}`,
        },
      ],
    };
  }
);

const closeTab = tool(
  "close_tab",
  "Close the currently focused tab.",
  {},
  async () => {
    await zellijAction("close-tab");
    return { content: [{ type: "text", text: "Tab closed" }] };
  }
);

const renameTab = tool(
  "rename_tab",
  "Rename a tab. If position is provided (0-based), uses butler IPC without changing focus. Otherwise renames the currently focused tab.",
  {
    name: z.string().describe("New tab name"),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based tab position (from get_butler_state)"),
  },
  async (args) => {
    if (typeof args.position === "number") {
      await renameTabByPosition(args.position, args.name);
      return {
        content: [
          {
            type: "text",
            text: `Tab at position ${args.position} renamed to "${args.name}"`,
          },
        ],
      };
    }

    await zellijAction("rename-tab", args.name);
    return {
      content: [{ type: "text", text: `Tab renamed to "${args.name}"` }],
    };
  }
);

// --- Pane management tools ---

const newPane = tool(
  "new_pane",
  `Open a new pane. Common patterns:
- Simple split: new_pane()
- Floating pane: new_pane(floating=true)
- Run a command: new_pane(command=["htop"])
- Floating with command: new_pane(floating=true, command=["kubectl", "logs", "-f", "pod/foo"])
Notes: direction is for tiled panes only. x/y/width/height/pinned are for floating panes only.`,
  {
    direction: z
      .enum(["left", "right", "up", "down"])
      .optional()
      .describe("Direction for tiled pane (not used with floating)"),
    floating: z.boolean().optional().describe("Open as floating pane"),
    stacked: z.boolean().optional().describe("Open as stacked pane"),
    command: z
      .array(z.string())
      .optional()
      .describe("Command and args to run in the pane"),
    cwd: z.string().optional().describe("Working directory"),
    name: z.string().optional().describe("Pane name"),
    close_on_exit: z
      .boolean()
      .optional()
      .describe("Close pane when command exits"),
    pinned: z.boolean().optional().describe("Pin floating pane on top (floating only)"),
    width: z.string().optional().describe("Width, e.g. '50%' or '80' (floating only)"),
    height: z.string().optional().describe("Height, e.g. '50%' or '24' (floating only)"),
    x: z.string().optional().describe("X position, e.g. '10%' or '5' (floating only)"),
    y: z.string().optional().describe("Y position, e.g. '10%' or '5' (floating only)"),
  },
  async (args) => {
    const flags: string[] = [];
    if (args.direction) flags.push("--direction", args.direction);
    if (args.floating) flags.push("--floating");
    if (args.stacked) flags.push("--stacked");
    if (args.cwd) flags.push("--cwd", args.cwd);
    if (args.name) flags.push("--name", args.name);
    if (args.close_on_exit) flags.push("--close-on-exit");
    if (args.pinned) flags.push("--pinned", "true");
    if (args.width) flags.push("--width", args.width);
    if (args.height) flags.push("--height", args.height);
    if (args.x) flags.push("--x", args.x);
    if (args.y) flags.push("--y", args.y);
    if (args.command) flags.push("--", ...args.command);
    await zellijAction("new-pane", ...flags);
    return {
      content: [
        {
          type: "text",
          text: `Created new pane${args.name ? ` "${args.name}"` : ""}${args.command ? ` running: ${args.command.join(" ")}` : ""}`,
        },
      ],
    };
  }
);

const closePane = tool(
  "close_pane",
  "Close the currently focused pane.",
  {},
  async () => {
    await zellijAction("close-pane");
    return { content: [{ type: "text", text: "Pane closed" }] };
  }
);

const renamePane = tool(
  "rename_pane",
  "Rename a pane. If pane_id is provided, uses butler IPC without changing focus. Otherwise renames the currently focused pane.",
  {
    name: z.string().describe("New pane name"),
    pane_id: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Terminal pane ID (from get_layout/get_butler_state)"),
  },
  async (args) => {
    if (typeof args.pane_id === "number") {
      await renamePaneById(args.pane_id, args.name);
      return {
        content: [
          {
            type: "text",
            text: `Pane ${args.pane_id} renamed to "${args.name}"`,
          },
        ],
      };
    }

    await zellijAction("rename-pane", args.name);
    return {
      content: [{ type: "text", text: `Pane renamed to "${args.name}"` }],
    };
  }
);

const hidePaneByIdTool = tool(
  "hide_pane_by_id",
  "Hide (suppress) a pane by ID through butler IPC without changing focus.",
  {
    pane_id: z.number().int().min(1).describe("Terminal pane ID"),
  },
  async (args) => {
    await hidePaneById(args.pane_id);
    return {
      content: [{ type: "text", text: `Pane ${args.pane_id} hidden` }],
    };
  }
);

const showPaneByIdTool = tool(
  "show_pane_by_id",
  "Show (unsuppress) a pane by ID through butler IPC.",
  {
    pane_id: z.number().int().min(1).describe("Terminal pane ID"),
    should_float_if_hidden: z
      .boolean()
      .optional()
      .describe("If true, restore as floating when hidden"),
    should_focus_pane: z
      .boolean()
      .optional()
      .describe("If true, focus pane when showing"),
  },
  async (args) => {
    await showPaneById(
      args.pane_id,
      args.should_float_if_hidden ?? true,
      args.should_focus_pane ?? true
    );
    return {
      content: [{ type: "text", text: `Pane ${args.pane_id} shown` }],
    };
  }
);

const moveFocus = tool(
  "move_focus",
  "Move focus to the pane in the specified direction.",
  {
    direction: z.enum(["left", "right", "up", "down"]).describe("Direction"),
  },
  async (args) => {
    await zellijAction("move-focus", args.direction);
    return {
      content: [{ type: "text", text: `Moved focus ${args.direction}` }],
    };
  }
);

const movePane = tool(
  "move_pane",
  "Move the focused pane in the specified direction.",
  {
    direction: z
      .enum(["left", "right", "up", "down"])
      .optional()
      .describe("Direction (omit to rotate forward)"),
  },
  async (args) => {
    if (args.direction) {
      await zellijAction("move-pane", args.direction);
    } else {
      await zellijAction("move-pane");
    }
    return {
      content: [
        {
          type: "text",
          text: `Moved pane ${args.direction ?? "forward"}`,
        },
      ],
    };
  }
);

const resizePane = tool(
  "resize_pane",
  "Resize the focused pane. Specify increase/decrease and a direction.",
  {
    resize: z
      .enum(["increase", "decrease"])
      .describe("Whether to increase or decrease"),
    direction: z
      .enum(["left", "right", "up", "down"])
      .optional()
      .describe("Border direction to resize"),
  },
  async (args) => {
    const cmdArgs: string[] = [args.resize];
    if (args.direction) cmdArgs.push(args.direction);
    await zellijAction("resize", ...cmdArgs);
    return {
      content: [
        {
          type: "text",
          text: `Resized pane: ${args.resize}${args.direction ? ` ${args.direction}` : ""}`,
        },
      ],
    };
  }
);

const toggleFloatingPanes = tool(
  "toggle_floating_panes",
  "Toggle visibility of all floating panes in the current tab.",
  {},
  async () => {
    await zellijAction("toggle-floating-panes");
    return { content: [{ type: "text", text: "Toggled floating panes" }] };
  }
);

const togglePaneEmbedOrFloating = tool(
  "toggle_pane_embed_or_floating",
  "Convert a floating pane to tiled or a tiled pane to floating.",
  {},
  async () => {
    await zellijAction("toggle-pane-embed-or-floating");
    return {
      content: [{ type: "text", text: "Toggled pane embed/floating" }],
    };
  }
);

const togglePanePinned = tool(
  "toggle_pane_pinned",
  "Toggle whether a floating pane is pinned (always on top).",
  {},
  async () => {
    await zellijAction("toggle-pane-pinned");
    return { content: [{ type: "text", text: "Toggled pane pinned state" }] };
  }
);

const toggleFullscreen = tool(
  "toggle_fullscreen",
  "Toggle fullscreen for the focused pane.",
  {},
  async () => {
    await zellijAction("toggle-fullscreen");
    return { content: [{ type: "text", text: "Toggled fullscreen" }] };
  }
);

const changeFloatingPaneCoordinates = tool(
  "change_floating_pane_coordinates",
  "Change position, size, or pinned state of a floating pane by its ID.",
  {
    pane_id: z
      .string()
      .describe(
        "Pane ID (e.g. 'terminal_1', 'plugin_2', or bare int like '3')"
      ),
    x: z.string().optional().describe("X position (e.g. '10%' or '5')"),
    y: z.string().optional().describe("Y position (e.g. '10%' or '5')"),
    width: z.string().optional().describe("Width (e.g. '50%' or '80')"),
    height: z.string().optional().describe("Height (e.g. '50%' or '24')"),
    pinned: z.boolean().optional().describe("Pin on top"),
  },
  async (args) => {
    const flags = ["--pane-id", args.pane_id];
    if (args.x) flags.push("--x", args.x);
    if (args.y) flags.push("--y", args.y);
    if (args.width) flags.push("--width", args.width);
    if (args.height) flags.push("--height", args.height);
    if (args.pinned !== undefined)
      flags.push("--pinned", String(args.pinned));
    await zellijAction("change-floating-pane-coordinates", ...flags);
    return {
      content: [
        { type: "text", text: `Updated coordinates for pane ${args.pane_id}` },
      ],
    };
  }
);

const writeToPane = tool(
  "write_to_pane",
  "Write characters to the currently focused terminal pane. Useful for sending commands to other panes.",
  {
    text: z.string().describe("Text to write to the terminal"),
  },
  async (args) => {
    await zellijAction("write-chars", args.text);
    return {
      content: [{ type: "text", text: `Wrote to pane: ${args.text}` }],
    };
  }
);

// --- Config and docs tools ---

async function backupFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    await fs.access(filePath);
  } catch {
    return undefined;
  }

  const backupPath = `${filePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function listFilesUnder(
  rootDir: string,
  maxEntries: number,
  includeHidden: boolean,
  seenAbsPaths: Set<string>
): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ abs: string; rel: string }> = [{ abs: rootDir, rel: "" }];

  while (queue.length > 0 && results.length < maxEntries) {
    const current = queue.shift();
    if (!current) break;

    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      if (!includeHidden && dirent.name.startsWith(".")) continue;
      const relPath = current.rel
        ? path.posix.join(current.rel, dirent.name)
        : dirent.name;
      const absPath = path.join(current.abs, dirent.name);
      const normalizedAbsPath = path.resolve(absPath);
      if (seenAbsPaths.has(normalizedAbsPath)) continue;
      seenAbsPaths.add(normalizedAbsPath);
      if (dirent.isDirectory()) {
        results.push(`${relPath}/`);
        if (results.length >= maxEntries) break;
        queue.push({ abs: absPath, rel: relPath });
      } else {
        results.push(relPath);
        if (results.length >= maxEntries) break;
      }
    }
  }

  return results;
}

function utf8SequenceLength(firstByte: number): number {
  if ((firstByte & 0b1000_0000) === 0) return 1;
  if ((firstByte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((firstByte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((firstByte & 0b1111_1000) === 0b1111_0000) return 4;
  return 1;
}

function safeUtf8SliceEnd(buffer: Buffer, maxBytes: number): number {
  if (maxBytes <= 0) return 0;
  if (maxBytes >= buffer.length) return buffer.length;

  let end = maxBytes;

  // If maxBytes lands in a multi-byte continuation range, back up to the lead byte.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  if (end === 0) return 0;

  const lead = buffer[end];
  const seqLen = utf8SequenceLength(lead);
  if (end + seqLen > maxBytes) {
    return end;
  }

  return maxBytes;
}

function truncateUtf8ToBytes(
  buffer: Buffer,
  maxBytes: number
): { text: string; returnedBytes: number; truncated: boolean } {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), returnedBytes: buffer.length, truncated: false };
  }

  const safeEnd = safeUtf8SliceEnd(buffer, maxBytes);
  const slice = buffer.subarray(0, safeEnd);
  return {
    text: slice.toString("utf8"),
    returnedBytes: slice.length,
    truncated: true,
  };
}

const getZellijConfigInfoTool = tool(
  "get_zellij_config_info",
  "Return detected zellij config locations (config file, config dir, layouts, cache, plugins) using `zellij setup --check` when available.",
  {},
  async () => {
    const info = await getZellijConfigInfo();
    const installedVersion = await getInstalledZellijVersion();
    const roots = getZellijConfigRoots(info);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              installed_zellij_version: installedVersion ?? null,
              setup_check_zellij_version: info.zellijVersion ?? null,
              source: info.source,
              config_dir: info.configDir,
              config_file: info.configFile,
              layout_dir: info.layoutDir,
              cache_dir: info.cacheDir ?? null,
              data_dir: info.dataDir ?? null,
              plugin_dir: info.pluginDir ?? null,
              config_roots: roots,
              setup_check_output: info.setupOutput ?? null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const listZellijConfigFilesTool = tool(
  "list_zellij_config_files",
  "List files under the active zellij config roots so you can inspect and edit config/layout/theme/plugin alias files.",
  {
    max_entries: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum number of files/directories to return (default 300)"),
    include_hidden: z
      .boolean()
      .optional()
      .describe("Include dotfiles and dot-directories"),
  },
  async (args) => {
    const info = await getZellijConfigInfo();
    const roots = getZellijConfigRoots(info);
    const maxEntries = args.max_entries ?? 300;
    const includeHidden = args.include_hidden ?? false;
    const seenAbsPaths = new Set<string>();
    let remainingEntries = maxEntries;

    const lines: string[] = [];
    for (const root of roots) {
      lines.push(`ROOT ${root}`);
      if (remainingEntries <= 0) {
        lines.push("(entry budget exhausted)");
        lines.push("");
        continue;
      }

      const entries = await listFilesUnder(
        root,
        remainingEntries,
        includeHidden,
        seenAbsPaths
      );
      if (entries.length === 0) {
        lines.push("(no readable entries)");
      } else {
        lines.push(...entries.map((entry) => `- ${entry}`));
      }
      remainingEntries -= entries.length;
      lines.push("");
    }

    lines.push(`TOTAL_RETURNED ${maxEntries - remainingEntries}`);
    if (remainingEntries <= 0) {
      lines.push(`ENTRY_BUDGET_EXHAUSTED max_entries=${maxEntries}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n").trim() }],
    };
  }
);

const readZellijConfigFileTool = tool(
  "read_zellij_config_file",
  "Read a zellij config-related file from the active config roots. Paths can be relative to config dir or absolute.",
  {
    path: z
      .string()
      .optional()
      .describe("Relative path from config dir or absolute path (default: active config.kdl)"),
    max_bytes: z
      .number()
      .int()
      .min(512)
      .max(1_000_000)
      .optional()
      .describe("Max UTF-8 bytes to return before truncation (default 200000)"),
  },
  async (args) => {
    const info = await getZellijConfigInfo();
    const filePath = await resolveZellijConfigPath(info, args.path);
    const bytes = await fs.readFile(filePath);
    const byteLength = bytes.length;
    const maxBytes = args.max_bytes ?? 200_000;
    const truncated = truncateUtf8ToBytes(bytes, maxBytes);

    const header = [
      `PATH ${filePath}`,
      `BYTES ${byteLength}`,
      `RETURNED_BYTES ${truncated.returnedBytes}`,
      truncated.truncated ? `TRUNCATED true (max_bytes=${maxBytes})` : "TRUNCATED false",
      "",
    ].join("\n");

    return {
      content: [{ type: "text", text: `${header}${truncated.text}` }],
    };
  }
);

const writeZellijConfigFileTool = tool(
  "write_zellij_config_file",
  "Write full file content to a zellij config-related file (config, layouts, themes, plugin aliases, etc).",
  {
    path: z
      .string()
      .optional()
      .describe("Relative path from config dir or absolute path (default: active config.kdl)"),
    content: z.string().describe("Full file content to write"),
    create_backup: z
      .boolean()
      .optional()
      .describe("Create timestamped .bak copy first if file exists (default true)"),
  },
  async (args) => {
    const info = await getZellijConfigInfo();
    const filePath = await resolveZellijConfigPath(info, args.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const backup = args.create_backup === false ? undefined : await backupFileIfExists(filePath);
    await fs.writeFile(filePath, args.content, "utf8");

    return {
      content: [
        {
          type: "text",
          text: backup
            ? `Wrote ${filePath}\nBackup: ${backup}`
            : `Wrote ${filePath}`,
        },
      ],
    };
  }
);

const editZellijConfigFileTool = tool(
  "edit_zellij_config_file",
  "Edit a zellij config file via exact text replacement (safe deterministic patching).",
  {
    path: z
      .string()
      .optional()
      .describe("Relative path from config dir or absolute path (default: active config.kdl)"),
    old_string: z.string().describe("Exact string to replace"),
    new_string: z.string().describe("Replacement string (must differ)"),
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace all matches instead of first match"),
    create_backup: z
      .boolean()
      .optional()
      .describe("Create timestamped .bak copy first if file exists (default true)"),
  },
  async (args) => {
    if (args.old_string === args.new_string) {
      return {
        content: [{ type: "text", text: "old_string and new_string must differ" }],
        isError: true,
      };
    }

    const info = await getZellijConfigInfo();
    const filePath = await resolveZellijConfigPath(info, args.path);
    const content = await fs.readFile(filePath, "utf8");

    if (!content.includes(args.old_string)) {
      return {
        content: [{ type: "text", text: `old_string not found in ${filePath}` }],
        isError: true,
      };
    }

    const occurrences = content.split(args.old_string).length - 1;
    const nextContent = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);

    const backup = args.create_backup === false ? undefined : await backupFileIfExists(filePath);
    await fs.writeFile(filePath, nextContent, "utf8");

    return {
      content: [
        {
          type: "text",
          text: [
            `Edited ${filePath}`,
            `Replacements: ${args.replace_all ? occurrences : 1}`,
            backup ? `Backup: ${backup}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }
);

const getZellijKnowledgeTool = tool(
  "get_zellij_knowledge",
  "Return Jelly J's bundled concise-yet-comprehensive Zellij reference compiled from zellij and zellij.dev docs.",
  {},
  async () => {
    const info = await getZellijConfigInfo();
    const installedVersion = await getInstalledZellijVersion();

    const headerLines = [
      `LOCAL_ZELLIJ_VERSION ${installedVersion ?? "unknown"}`,
      info.zellijVersion
        ? `SETUP_CHECK_ZELLIJ_VERSION ${info.zellijVersion}`
        : undefined,
      installedVersion &&
      info.zellijVersion &&
      installedVersion !== info.zellijVersion
        ? "VERSION_WARNING Installed zellij version differs from setup --check output."
        : undefined,
      "",
    ].filter((line): line is string => Boolean(line));

    return {
      content: [{ type: "text", text: `${headerLines.join("\n")}${ZELLIJ_KNOWLEDGE_GUIDE}` }],
    };
  }
);

const searchZellijKnowledgeTool = tool(
  "search_zellij_knowledge",
  "Search Jelly J's bundled Zellij reference by topic and return the most relevant sections.",
  {
    query: z.string().describe("Search query, eg. 'layout cwd precedence'"),
    max_sections: z
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe("Maximum sections to return (default 6)"),
  },
  async (args) => {
    return {
      content: [
        {
          type: "text",
          text: searchZellijKnowledge(args.query, args.max_sections ?? 6),
        },
      ],
    };
  }
);

// --- Escape hatch ---

const zellijActionTool = tool(
  "zellij_action",
  "Run any arbitrary `zellij action` subcommand. Use this for commands not covered by other tools.",
  {
    args: z
      .array(z.string())
      .describe("Arguments to pass to `zellij action`"),
  },
  async (toolArgs) => {
    const { stdout, stderr } = await zellijAction(...toolArgs.args);
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: output || "Action completed" }] };
  }
);

// --- MCP Server ---

export const zellijMcpServer = createSdkMcpServer({
  name: "zellij",
  version: "0.1.0",
  tools: [
    // Workspace state
    getLayout,
    listTabs,
    listClients,
    getButlerStateTool,
    getButlerTraceTool,
    clearButlerTraceTool,
    // Tab management
    goToTab,
    newTab,
    closeTab,
    renameTab,
    // Pane management
    newPane,
    closePane,
    renamePane,
    hidePaneByIdTool,
    showPaneByIdTool,
    moveFocus,
    movePane,
    resizePane,
    toggleFloatingPanes,
    togglePaneEmbedOrFloating,
    togglePanePinned,
    toggleFullscreen,
    changeFloatingPaneCoordinates,
    writeToPane,
    // Config and docs
    getZellijConfigInfoTool,
    listZellijConfigFilesTool,
    readZellijConfigFileTool,
    writeZellijConfigFileTool,
    editZellijConfigFileTool,
    getZellijKnowledgeTool,
    searchZellijKnowledgeTool,
    // Escape hatch
    zellijActionTool,
  ],
});
