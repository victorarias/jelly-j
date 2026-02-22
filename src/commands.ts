import type { ChatModel } from "./agent.js";

export type ModelAlias = "opus" | "haiku";

const MODEL_ALIAS_TO_ID: Record<ModelAlias, ChatModel> = {
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export type SlashCommandResult =
  | { handled: false }
  | {
      handled: true;
      nextModel: ModelAlias;
      message: string;
      isError: boolean;
      resetSession?: boolean;
    };

export function modelIdForAlias(alias: ModelAlias): ChatModel {
  return MODEL_ALIAS_TO_ID[alias];
}

export function handleSlashCommand(
  input: string,
  currentModel: ModelAlias
): SlashCommandResult {
  if (!input.startsWith("/")) {
    return { handled: false };
  }

  const tokens = input.slice(1).trim().split(/\s+/).filter(Boolean);
  const command = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);

  if (!command) {
    return {
      handled: true,
      nextModel: currentModel,
      isError: true,
      message: "empty command. use /model, /model <opus|haiku>, or /new",
    };
  }

  if (command === "new") {
    if (args.length > 0) {
      return {
        handled: true,
        nextModel: currentModel,
        isError: true,
        message: "usage: /new",
      };
    }

    return {
      handled: true,
      nextModel: currentModel,
      isError: false,
      resetSession: true,
      message: "starting a fresh Claude session for new turns",
    };
  }

  if (command !== "model") {
    return {
      handled: true,
      nextModel: currentModel,
      isError: true,
      message: `unknown command: /${command}. supported: /model, /new`,
    };
  }

  if (args.length === 0) {
    return {
      handled: true,
      nextModel: currentModel,
      isError: false,
      message: `model current: ${currentModel} (${modelIdForAlias(currentModel)}) | available: opus, haiku`,
    };
  }

  if (args.length > 1) {
    return {
      handled: true,
      nextModel: currentModel,
      isError: true,
      message: "usage: /model <opus|haiku>",
    };
  }

  const alias = args[0].toLowerCase();
  if (alias !== "opus" && alias !== "haiku") {
    return {
      handled: true,
      nextModel: currentModel,
      isError: true,
      message: `invalid model alias: ${args[0]}. valid aliases: opus, haiku`,
    };
  }

  const nextModel = alias as ModelAlias;
  if (nextModel === currentModel) {
    return {
      handled: true,
      nextModel,
      isError: false,
      message: `model already set: ${nextModel} (${modelIdForAlias(nextModel)})`,
    };
  }

  return {
    handled: true,
    nextModel,
    isError: false,
    message: `model changed: ${nextModel} (${modelIdForAlias(nextModel)})`,
  };
}
