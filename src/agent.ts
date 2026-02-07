import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultSuccess,
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
- Write automation scripts for repetitive tasks
- Help the user find things in their workspace

For complex reorganizations (like "sort everything by project"), work
step by step: understand the current state, make a plan, execute it,
then confirm the result.

When saving scripts, always include a comment header explaining what
the script does.`;

/**
 * Send a user message and stream assistant response to the console.
 * Uses the Agent SDK with the zellij MCP server.
 * Returns the assistant's text response.
 */
export async function chat(
  userMessage: string,
  sessionId?: string
): Promise<{ text: string; sessionId?: string }> {
  let resultText = "";
  let newSessionId: string | undefined;

  async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: {
        role: "user",
        content: userMessage,
      },
      parent_tool_use_id: null,
      session_id: sessionId ?? "",
    };
  }

  const options: Options = {
    systemPrompt: SYSTEM_PROMPT,
    model: "claude-opus-4-6",
    mcpServers: {
      zellij: zellijMcpServer,
    },
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
    handleMessage(message);

    if (message.type === "system" && "subtype" in message && message.subtype === "init") {
      newSessionId = (message as SDKSystemMessage).session_id;
    }

    if (message.type === "result") {
      if ("result" in message) {
        resultText = (message as SDKResultSuccess).result ?? "";
      } else {
        resultText = `[Error: ${(message as SDKResultError).subtype}]`;
      }
    }
  }

  return { text: resultText, sessionId: newSessionId ?? sessionId };
}

function handleMessage(message: SDKMessage): void {
  if (message.type === "assistant") {
    const assistantMsg = message as SDKAssistantMessage;
    const content = assistantMsg.message?.content;

    if (content) {
      for (const block of content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          const inputStr = Object.entries(input)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" ");
          process.stdout.write(`\n  [zellij] ${block.name} ${inputStr}\n`);
        }
      }
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
  };

  for await (const message of query({ prompt, options })) {
    if (message.type === "result" && "result" in message) {
      result = (message as SDKResultSuccess).result ?? "NOTHING";
    }
  }

  return result.trim();
}
