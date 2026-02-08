import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultError,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { zellijMcpServer } from "./tools.js";

const SYSTEM_PROMPT = `You are Jelly J, a friendly Zellij workspace assistant. You live in a
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
1. ALWAYS start by checking the current workspace state (get_layout, list_tabs)
   before making any changes
2. Explain briefly what you're about to do, then do it
3. After changes, verify the result
4. When relevant, mention the Zellij keybinding for what you just did
   (so the user learns over time)

You can:
- Create, rename, close, and organize tabs
- Create panes (tiled, floating, pinned, stacked) running any command
- Move and resize panes within a tab
- Help the user find things in their workspace

For complex reorganizations (like "sort everything by project"), work
step by step: understand the current state, make a plan, execute it,
then confirm the result.`;

export type ChatModel = "claude-opus-4-6" | "claude-haiku-4-5-20251001";

export type ToolUseEvent = {
  name: string;
  input: Record<string, unknown>;
};

export type ChatEvents = {
  onText?: (text: string) => void;
  onToolUse?: (event: ToolUseEvent) => void;
  onResultError?: (subtype: string, errors: string[]) => void;
};

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
    systemPrompt: SYSTEM_PROMPT,
    model,
    mcpServers: { zellij: zellijMcpServer },
    allowedTools: ["mcp__zellij__*"],
    maxTurns: 20,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

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
