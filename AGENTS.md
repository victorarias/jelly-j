# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Development (Bun runtime)
npm start

# Type-check
npm run typecheck

# Build for distribution (produces dist/index.js with shebang)
npm run build

# Run the built version
bun dist/index.js

# Build the Zellij butler plugin (requires wasm32-wasip1 target)
cd plugin && cargo build --release --target wasm32-wasip1

# Copy plugin to Zellij plugins directory
cp plugin/target/wasm32-wasip1/release/jelly-j.wasm ~/.config/zellij/plugins/
```

## Architecture

Two components: a **Bun REPL** (the assistant) and a **Rust WASM plugin** (the persistent butler).

## Mandatory Reference For Plugin Work

Before changing any plugin/keybind behavior, read:
- @docs/zellij-plugin-scripting-guide.md

Maintenance rule:
- If you find any statement in that guide is wrong, update it as part of your change.
- Treat the currently pinned dependency target as canonical. Right now this repo targets local Zellij `main` via path dependency; if that changes, update the guide in the same change.

### Bun REPL (`src/`)

```
index.ts      → Readline REPL loop, terminal title, global session resume/save
agent.ts      → Claude Agent SDK integration: chat() + heartbeatQuery()
tools.ts      → MCP tools (zellij actions + butler IPC helpers)
zellij.ts     → Thin wrapper: execFile("zellij", ["action", ...args]) with timeout
zellijPipe.ts → Thin wrapper: execFile("zellij", ["pipe", ...args]) for butler RPC
state.ts      → Read/write ~/.jelly-j/state.json + enforce global process lock (~/.jelly-j/agent.lock.json)
heartbeat.ts  → Every 5min, asks butler for cached state, asks Haiku if tidying is needed
```

Data flow:
- User types in REPL
- `chat()` sends to Claude Opus via Agent SDK
- Claude calls MCP tools
- Tools use either `zellij action` (direct) or butler pipe RPC (`zellij pipe`)
- Results stream back to REPL

Agent SDK details:
- Each `query()` call spawns a Claude Code subprocess.
- Session continuity is maintained via `resume` + persisted `sessionId`.
- SDK MCP servers require async-generator input mode.

Heartbeat:
- Uses Haiku for cost efficiency.
- Skips checks while the user is actively chatting (`setBusy`).
- Reads workspace state from butler cache (`get_state`) instead of polling raw action commands.

### Zellij Butler Plugin (`plugin/`)

A WASM plugin using `zellij-tile` (local `main`) that provides persistent `Alt+j` behavior and IPC:

- Lives for the whole session (does not close itself per keypress)
- Handles `toggle` pipe messages for show/hide/focus behavior
- Handles `request` pipe messages for control ops (`ping`, `get_state`, rename/show/hide)
- Hides its own pane in `render()` so no plugin pane is visible

State machine:
1. Load: request permissions + subscribe (`PaneUpdate`, `TabUpdate`, `PermissionRequestResult`)
2. Idle: cache pane/tab state continuously
3. Pipe `toggle`: run toggle cycle
4. Pipe `request`: parse JSON request, execute API call, respond via `cli_pipe_output`

Key flags:
- `ready` (permissions granted)
- `pending_toggle` (coalesced toggle requests)
- `pane_update_count` / `tab_update_count` (event-flow observability)

## Key Design Decisions

- Persistent butler: single long-lived plugin instance.
- `MessagePlugin` keybind for `Alt+j` toggle delivery.
- Atomic `launch_terminal_pane(..., stdin_write=Some(\"jelly-j\\n\"), ...)` for launch + command injection.
- Pipe IPC (`zellij pipe`) for no-focus-switch tab/pane operations.
- Global conversation continuity in `~/.jelly-j/state.json` (intentional, shared across zellij sessions).
- Global singleton process lock in `~/.jelly-j/agent.lock.json` (one jelly-j process per computer).
- Bun runtime and bundling (`bun build ... --target bun`).
- Plain text output: system prompt forbids markdown because REPL is raw terminal.

## Agent Guardrails (Main Branch Reality)

These are implementation constraints agents should treat as hard-won invariants unless they intentionally redesign and re-validate.

1. Subscription ordering is not optional.
   - In plugin `load()`, call `subscribe(...)` before `request_permission(...)`.
   - If permission is requested first, `PermissionRequestResult` can be missed in fast/cached flows.

2. Do not gate toggle logic on `TabUpdate`.
   - On local Zellij `main`, headless/background runs may emit `PaneUpdate` without `TabUpdate`.
   - Toggle and `get_state` readiness should require pane cache readiness; tab cache is best-effort.

3. Assume permission result events can be absent when permissions are cached.
   - If pane cache is live and no explicit denial occurred, infer readiness.
   - Keep denial handling explicit if `PermissionRequestResult::Denied` arrives.

4. Deduplicate CLI `toggle` pipes by pipe ID.
   - `zellij pipe --name toggle` may deliver duplicate events for the same CLI request.
   - Store last CLI pipe id and no-op duplicates to avoid double-toggle flicker.

5. Prefer atomic terminal launch with inline stdin write over multi-step launch state machines.
   - Reliable path here: `launch_terminal_pane(..., stdin_write=Some(\"jelly-j\\n\"), ...)`.
   - Avoid `awaiting_pane`/`relocating_*` loops unless a future regression proves they are needed.

6. Harness runs must seed plugin permission cache for URL variants.
   - Cache file: macOS `~/Library/Caches/org.Zellij-Contributors.Zellij/permissions.kdl`
   - Seed both path and URL forms (`/path`, `file:/path`, `file:///path`, etc.) to avoid prompt-driven nondeterminism.

7. Always test against the deployed wasm artifact, not just local build output.
   - After plugin build, copy `plugin/target/wasm32-wasip1/release/jelly-j.wasm` to `~/.config/zellij/plugins/jelly-j.wasm` before harness/e2e.

8. Use butler trace/state as first-line diagnostics.
   - Capture `get_trace` and `get_state` before cleanup in failing harness runs.
   - Prefer trace evidence over assumptions about zellij event ordering.

9. Preserve global singleton semantics in REPL process management.
   - Startup must acquire the global lock before initializing interactive loop.
   - Shutdown/fatal paths must release lock best-effort.
   - `Ctrl-C` must not terminate Jelly J.
   - `exit`/`quit` input must stay disabled (single global agent semantics).
   - Unexpected stdin close/signals should relaunch Jelly J in a fresh pane.

10. Never use raw `zellij pipe` for ops/restart flows without a timeout.
   - `zellij pipe` can block if a plugin-side CLI pipe is never unblocked.
   - For operational restart, use `npm run ops:restart` (timeout-bounded, lock-aware, no unbounded pipe wait).
   - In code, map pipe timeouts to explicit `ZellijPipeError` with `code="timeout"` and surface actionable errors.

11. Keybind-delivered toggle pipes can be duplicated in tight succession.
   - Keep a short dedup window in the plugin toggle handler to avoid hide-then-show on a single Alt+j press.
   - Do not rely only on CLI pipe-id dedup; keybind sources have no pipe id.

## npm Distribution

Published as `jelly-j` on npm. Build output is ESM with `#!/usr/bin/env bun` shebang and `dist/` is the published payload.
