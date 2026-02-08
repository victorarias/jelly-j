import { chat, type ToolUseEvent } from "./agent.js";
import { modelIdForAlias, type ModelAlias } from "./commands.js";
import { setBusy } from "./heartbeat.js";
import type { UiState } from "./ui.js";

export type AgentSessionEvent =
  | {
      type: "state";
      model: ModelAlias;
      sessionId?: string;
      uiState: UiState;
      busy: boolean;
      queueLength: number;
    }
  | { type: "queued"; queueLength: number }
  | { type: "turn_start"; input: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; event: ToolUseEvent }
  | { type: "turn_error"; message: string }
  | { type: "turn_end"; hadError: boolean; sessionId?: string };

type Listener = (event: AgentSessionEvent) => void;

export class AgentSession {
  private readonly listeners = new Set<Listener>();
  private readonly queue: string[] = [];

  private processing = false;
  private stopped = false;
  private sessionId: string | undefined;
  private model: ModelAlias = "opus";
  private uiState: UiState = "idle";

  constructor(initialModel: ModelAlias = "opus") {
    this.model = initialModel;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshotState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  setModel(model: ModelAlias): void {
    this.model = model;
    this.emit(this.snapshotState());
  }

  enqueue(input: string): void {
    if (this.stopped) return;
    this.queue.push(input);
    this.emit({ type: "queued", queueLength: this.queue.length });
    this.emit(this.snapshotState());
    if (!this.processing) {
      void this.processQueue();
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    setBusy(true);
    this.emit(this.snapshotState());

    try {
      while (this.queue.length > 0 && !this.stopped) {
        const input = this.queue.shift();
        if (!input) continue;

        this.uiState = "thinking";
        this.emit(this.snapshotState());
        this.emit({ type: "turn_start", input });

        let hadError = false;

        try {
          const result = await chat(input, this.sessionId, modelIdForAlias(this.model), {
            onText: (text) => {
              this.uiState = "thinking";
              this.emit(this.snapshotState());
              this.emit({ type: "text", text });
            },
            onToolUse: (event) => {
              this.uiState = "tool";
              this.emit(this.snapshotState());
              this.emit({ type: "tool_use", event });
            },
            onResultError: (subtype, errors) => {
              hadError = true;
              this.uiState = "error";
              this.emit(this.snapshotState());
              this.emit({
                type: "turn_error",
                message: `[${subtype}] ${errors.join("; ")}`,
              });
            },
          });

          this.sessionId = result.sessionId ?? this.sessionId;

          if (!hadError) {
            this.uiState = "idle";
          }
        } catch (error) {
          hadError = true;
          this.uiState = "error";
          const message = error instanceof Error ? error.message : String(error);
          this.emit(this.snapshotState());
          this.emit({ type: "turn_error", message });
        }

        this.emit({ type: "turn_end", hadError, sessionId: this.sessionId });
        this.emit(this.snapshotState());
      }
    } finally {
      this.processing = false;
      setBusy(false);
      if (this.uiState !== "error") {
        this.uiState = "idle";
      }
      this.emit(this.snapshotState());
    }
  }

  private snapshotState(): AgentSessionEvent {
    return {
      type: "state",
      model: this.model,
      sessionId: this.sessionId,
      uiState: this.uiState,
      busy: this.processing,
      queueLength: this.queue.length,
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
