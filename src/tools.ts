import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { zellijAction } from "./zellij.js";

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
  "Rename the currently focused tab.",
  {
    name: z.string().describe("New tab name"),
  },
  async (args) => {
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
  "Rename the currently focused pane.",
  {
    name: z.string().describe("New pane name"),
  },
  async (args) => {
    await zellijAction("rename-pane", args.name);
    return {
      content: [{ type: "text", text: `Pane renamed to "${args.name}"` }],
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
    // Tab management
    goToTab,
    newTab,
    closeTab,
    renameTab,
    // Pane management
    newPane,
    closePane,
    renamePane,
    moveFocus,
    movePane,
    resizePane,
    toggleFloatingPanes,
    togglePaneEmbedOrFloating,
    togglePanePinned,
    toggleFullscreen,
    changeFloatingPaneCoordinates,
    writeToPane,
    // Escape hatch
    zellijActionTool,
  ],
});
