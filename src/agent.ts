import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultError,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { zellijMcpServer } from "./tools.js";
import {
  getZellijAdditionalDirectories,
  getZellijConfigInfo,
  getZellijConfigRoots,
  isInsidePath,
  type ZellijConfigInfo,
} from "./zellijConfig.js";

const BASE_SYSTEM_PROMPT = `You are Jelly J, a friendly Zellij workspace assistant. You live in a
floating pane and help the user organize their terminal workspace.

Your personality:
- Friendly, concise, helpful — like a good colleague
- Show what you're doing so the user picks up Zellij naturally
- Proactive: suggest better organization when you see opportunities
- Never complain about what you can't do — just find a way or offer alternatives

Output format:
- You are in a plain terminal. NEVER use markdown formatting (no **bold**, no #headings,
  no \`backticks\`, no bullet markers like "- "). Just write plain text.
- Use short paragraphs and line breaks for readability.
- Emojis are fine sparingly.

How you work:
1. For LIVE session changes, ALWAYS start by checking current workspace state
   (get_layout and list_tabs) before acting
2. For CONFIG file changes, inspect config files first, then patch surgically
3. Explain briefly what you're about to do, then do it
4. After changes, verify the result
5. When relevant, mention the Zellij keybinding for what you just did
   (so the user learns over time)

You can:
- Create, rename, close, and organize tabs
- Create panes (tiled, floating, pinned, stacked) running any command
- Move and resize panes within a tab
- Help the user find things in their workspace
- Read/edit Zellij config/layout/theme/plugin files
- Use full Claude Code tools (Read/Edit/Write/Grep/Glob/Bash/Task/etc.) when helpful
- Answer Zellij conceptual questions using search_zellij_knowledge/get_zellij_knowledge

For complex reorganizations (like "sort everything by project"), work
step by step: understand the current state, make a plan, execute it,
then confirm the result.`;

function buildSystemPrompt(configInfo: ZellijConfigInfo): string {
  return `${BASE_SYSTEM_PROMPT}

Local zellij config context:
- Active config dir: ${configInfo.configDir}
- Active config file: ${configInfo.configFile}
- Active layout dir: ${configInfo.layoutDir}
- Discovery source: ${configInfo.source}

If you are unsure about Zellij behavior details, call search_zellij_knowledge before answering.
If asked to change config, use config-aware tools first (get_zellij_config_info, list/read/edit/write_zellij_config_file).

Permission policy in this session:
- Bash commands require explicit user approval
- File modifications outside Zellij config roots require explicit user approval`;
}

export type ChatModel = "claude-opus-4-6" | "claude-haiku-4-5-20251001";

export type ToolUseEvent = {
  name: string;
  input: Record<string, unknown>;
};

export type ChatEvents = {
  onText?: (text: string) => void;
  onToolUse?: (event: ToolUseEvent) => void;
  onResultError?: (subtype: string, errors: string[]) => void;
  onPermissionRequest?: (toolName: string, reason: string) => void;
};

const BASH_TOOL_NAMES = new Set(["Bash"]);
const WRITE_TOOL_NAMES = new Set([
  "FileEdit",
  "FileWrite",
  "NotebookEdit",
  "Edit",
  "Write",
  "MultiEdit",
]);
const WRITE_TOOL_NAME_PATTERN = /(Edit|Write)/;

function inputPathForTool(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "NotebookEdit") {
    const notebookPath = input.notebook_path;
    return typeof notebookPath === "string" ? notebookPath : undefined;
  }

  const filePath = input.file_path;
  return typeof filePath === "string" ? filePath : undefined;
}

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_NAMES.has(toolName) || WRITE_TOOL_NAME_PATTERN.test(toolName);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

async function askPermissionPrompt(
  message: string,
  allowAllLabel: string
): Promise<"yes" | "no" | "all"> {
  if (!processStdin.isTTY || !processStdout.isTTY) {
    return "no";
  }

  const rl = createInterface({
    input: processStdin,
    output: processStdout,
  });

  try {
    while (true) {
      const answer = (
        await rl.question(
          `${message}${os.EOL}Allow? [y]es / [n]o / [a]ll (${allowAllLabel}): `
        )
      )
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return "yes";
      if (answer === "n" || answer === "no" || answer === "") return "no";
      if (answer === "a" || answer === "all") return "all";
      processStdout.write("Please answer y, n, or a." + os.EOL);
    }
  } finally {
    rl.close();
  }
}

function buildPermissionHooks(
  configInfo: ZellijConfigInfo,
  events: ChatEvents
): NonNullable<Options["hooks"]> {
  const configRoots = getZellijConfigRoots(configInfo).map((root) => path.resolve(root));
  let allowAllBash = false;
  let allowAllOutsideConfigWrites = false;
  const approvedOutsideConfigWritePaths = new Set<string>();

  return {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          async (input) => {
            const toolName =
              typeof (input as { tool_name?: unknown }).tool_name === "string"
                ? (input as { tool_name: string }).tool_name
                : "unknown";
            const toolInput = asRecord((input as { tool_input?: unknown }).tool_input);

            if (BASH_TOOL_NAMES.has(toolName)) {
              if (allowAllBash) {
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              }

              const command =
                typeof toolInput.command === "string" ? toolInput.command : "(unknown)";
              events.onPermissionRequest?.(toolName, "bash command");
              const decision = await askPermissionPrompt(
                [
                  "",
                  "Jelly J requests Bash execution.",
                  `Tool: ${toolName}`,
                  `Command: ${command}`,
                ].join(os.EOL),
                "all bash this run"
              );

              if (decision === "all") {
                allowAllBash = true;
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              }
              if (decision === "yes") {
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                  },
                };
              }

              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason:
                    "Bash execution denied by user. Ask for approval before retrying.",
                },
              };
            }

            if (!isWriteTool(toolName)) {
              return { continue: true };
            }

            const maybePath = inputPathForTool(toolName, toolInput);
            if (!maybePath) {
              return { continue: true };
            }

            const resolvedPath = path.resolve(maybePath);
            const insideConfigRoots = configRoots.some((root) =>
              isInsidePath(resolvedPath, root)
            );

            if (insideConfigRoots) {
              return { continue: true };
            }

            if (
              allowAllOutsideConfigWrites ||
              approvedOutsideConfigWritePaths.has(resolvedPath)
            ) {
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                },
              };
            }

            events.onPermissionRequest?.(toolName, "write outside zellij config roots");
            const decision = await askPermissionPrompt(
              [
                "",
                "Jelly J requests file modification outside Zellij config roots.",
                `Tool: ${toolName}`,
                `Path: ${resolvedPath}`,
                `Allowed roots: ${configRoots.join(", ")}`,
              ].join(os.EOL),
              "all outside-config writes this run"
            );

            if (decision === "all") {
              allowAllOutsideConfigWrites = true;
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                },
              };
            }

            if (decision === "yes") {
              approvedOutsideConfigWritePaths.add(resolvedPath);
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "allow",
                },
              };
            }

            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason:
                  "File modification outside zellij config roots denied by user. Ask for approval before retrying.",
              },
            };
          },
        ],
      },
    ],
  };
}

/**
 * Send a user message and stream assistant response via event callbacks.
 *
 * Each call spawns a new Claude Code subprocess. The SDK's v2 session API
 * (unstable_v2_createSession) would avoid per-turn subprocess overhead, but
 * it doesn't support mcpServers or systemPrompt yet — so we use query()
 * with resume for now.
 *
 * SDK MCP servers require streaming input mode (AsyncGenerator), which is
 * why we use the generator form even for a single message.
 */
export async function chat(
  userMessage: string,
  sessionId: string | undefined,
  model: ChatModel,
  events: ChatEvents = {}
): Promise<{ sessionId?: string }> {
  let newSessionId: string | undefined;
  const zellijConfigInfo = await getZellijConfigInfo();
  const additionalDirectories = await getZellijAdditionalDirectories(
    zellijConfigInfo
  );

  // SDK MCP servers require streaming input mode (async generator).
  // session_id is required by the type but only meaningful for resumed sessions.
  // For new sessions the SDK assigns a real session_id on init.
  async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: userMessage },
      parent_tool_use_id: null,
      session_id: sessionId ?? "",
    };
  }

  const options: Options = {
    systemPrompt: buildSystemPrompt(zellijConfigInfo),
    model,
    tools: { type: "preset", preset: "claude_code" },
    mcpServers: { zellij: zellijMcpServer },
    maxTurns: 20,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    hooks: buildPermissionHooks(zellijConfigInfo, events),
  };

  if (additionalDirectories.length > 0) {
    options.additionalDirectories = additionalDirectories;
  }

  if (sessionId) {
    options.resume = sessionId;
  }

  for await (const message of query({
    prompt: generateMessages(),
    options,
  })) {
    renderMessage(message, events);

    if (message.type === "system" && "subtype" in message && message.subtype === "init") {
      newSessionId = (message as SDKSystemMessage).session_id;
    }

    if (message.type === "result" && message.subtype !== "success") {
      const err = message as SDKResultError;
      events.onResultError?.(err.subtype, err.errors);
    }
  }

  return { sessionId: newSessionId ?? sessionId };
}

function renderMessage(message: SDKMessage, events: ChatEvents): void {
  if (message.type !== "assistant") return;

  const assistantMsg = message as SDKAssistantMessage;
  const content = assistantMsg.message?.content;
  if (!content) return;

  for (const block of content) {
    if (block.type === "text") {
      events.onText?.(block.text);
      continue;
    }

    if (block.type === "tool_use") {
      events.onToolUse?.({
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }
}

/**
 * One-shot query for the heartbeat system using Haiku.
 */
export async function heartbeatQuery(
  layoutDump: string,
  tabNames: string
): Promise<string> {
  const prompt = `Current Zellij workspace state:

Tab names: ${tabNames}

Layout dump:
${layoutDump}

You are a workspace organization assistant. Look at this workspace state and determine if there's anything worth suggesting to the user. Consider:
- Unnamed tabs (>3 unnamed → suggest naming based on running commands)
- Overcrowded tabs (>4 panes in one tab → suggest splitting)
- Similar panes across tabs (same command type → suggest grouping)
- Empty/idle tabs
- Disorganized layouts

If there's a useful suggestion, respond with a SHORT one-liner suggestion (max 80 chars).
If nothing worth suggesting, respond with exactly: NOTHING`;

  let result = "";

  const options: Options = {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 1,
    tools: [],
    persistSession: false,
  };

  for await (const message of query({ prompt, options })) {
    if (message.type === "result" && message.subtype === "success") {
      result = message.result ?? "NOTHING";
    }
  }

  return result.trim();
}
