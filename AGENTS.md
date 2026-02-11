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

Three components: a **Bun UI client**, a **Bun daemon backend**, and a **Rust WASM plugin** (the persistent butler).

## Mandatory Reference For Plugin Work

Before changing any plugin/keybind behavior, read:
- @docs/zellij-plugin-scripting-guide.md

Maintenance rule:
- If you find any statement in that guide is wrong, update it as part of your change.
- Treat the currently pinned dependency target as canonical. Right now this repo targets local Zellij `main` via path dependency; if that changes, update the guide in the same change.

### Bun Runtime (`src/`)

```
index.ts      → Entry point: mode parsing (`daemon`, `ui`, default), daemon bootstrap
daemon.ts     → Global singleton backend (socket server, chat execution queue, shared model/session state)
ui-client.ts  → Session-local readline frontend connected to daemon over Unix socket
protocol.ts   → Newline-delimited JSON message contracts for daemon/UI IPC
history.ts    → Global chat history store (`~/.jelly-j/history.jsonl`) + snapshot replay
agent.ts      → Claude Agent SDK integration: chat() + heartbeatQuery()
tools.ts      → MCP tools (zellij actions + butler IPC helpers)
zellij.ts     → Thin wrapper: execFile("zellij", ["action", ...args]) with timeout
zellijPipe.ts → Thin wrapper: execFile("zellij", ["pipe", ...args]) for butler RPC
state.ts      → Read/write `~/.jelly-j/state.json`, daemon lock `~/.jelly-j/agent.lock.json`, socket path
heartbeat.ts  → Every 5min, asks butler for cached state, asks Haiku if tidying is needed
```

Data flow:
- User types in UI client
- UI sends request to daemon
- Daemon calls `chat()` via Agent SDK
- Claude calls MCP tools
- Tools use either `zellij action` (direct) or butler pipe RPC (`zellij pipe`)
- Results stream back through daemon to the requesting UI client

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
- Atomic `launch_terminal_pane(..., stdin_write=Some(\"jelly-j ui\\n\"), ...)` for launch + command injection.
- Pipe IPC (`zellij pipe`) for no-focus-switch tab/pane operations.
- Global conversation continuity in `~/.jelly-j/state.json` (intentional, shared across zellij sessions).
- Global singleton daemon lock in `~/.jelly-j/agent.lock.json` (one jelly-j backend per computer).
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
   - Reliable path here: `launch_terminal_pane(..., stdin_write=Some(\"jelly-j ui\\n\"), ...)`.
   - Avoid `awaiting_pane`/`relocating_*` loops unless a future regression proves they are needed.

6. Harness runs must seed plugin permission cache for URL variants.
   - Cache file: macOS `~/Library/Caches/org.Zellij-Contributors.Zellij/permissions.kdl`
   - Seed both path and URL forms (`/path`, `file:/path`, `file:///path`, etc.) to avoid prompt-driven nondeterminism.

7. Always test against the deployed wasm artifact, not just local build output.
   - After plugin build, copy `plugin/target/wasm32-wasip1/release/jelly-j.wasm` to `~/.config/zellij/plugins/jelly-j.wasm` before harness/e2e.

8. Use butler trace/state as first-line diagnostics.
   - Capture `get_trace` and `get_state` before cleanup in failing harness runs.
   - Prefer trace evidence over assumptions about zellij event ordering.

9. Preserve global singleton semantics in runtime process management.
   - The daemon owns the global lock; UI clients must never fail just because lock exists.
   - Default startup must be: ensure daemon running, then start UI.
   - Daemon shutdown/fatal paths must release lock and socket best-effort.
   - `Ctrl-C` must not terminate the UI client.
   - `exit`/`quit` input must stay disabled (single global backend semantics).
   - UI close should leave daemon alive; reopening via `Alt+j` must reconnect.

10. Never use raw `zellij pipe` for ops/restart flows without a timeout.
   - `zellij pipe` can block if a plugin-side CLI pipe is never unblocked.
   - For operational restart, use `npm run ops:restart` (timeout-bounded, lock-aware, no unbounded pipe wait).
   - In code, map pipe timeouts to explicit `ZellijPipeError` with `code="timeout"` and surface actionable errors.

11. Keybind-delivered toggle pipes can be duplicated in tight succession.
   - Keep a short dedup window in the plugin toggle handler to avoid hide-then-show on a single Alt+j press.
   - Do not rely only on CLI pipe-id dedup; keybind sources have no pipe id.

12. Do not render on every plugin state event for hidden-control plugins.
   - For Jelly J, `render()` only calls `hide_self()`. If `update()` returns `true` on every `PaneUpdate`/`TabUpdate`, Zellij can enter a render/hide/update feedback loop.
   - Keep `update()` returning `false` unless a real UI repaint is required.
   - Symptom of violation: toggle latency grows with each press (eg. 50ms → seconds) while client/plugin counts stay flat.

13. Use staged isolation before changing Zellij internals.
   - Split regressions into 3 loops and measure each independently:
     1) message delivery latency (`zellij pipe` round-trip time),
     2) plugin-instance fanout (client/plugin counts),
     3) pane open/hide action latency.
   - If latency grows while client/plugin counts remain flat, prioritize plugin event/render feedback loops before host routing changes.
   - Watch butler counters (`pane_update_count`, `tab_update_count`): runaway growth over a short interval is a strong signal of an update/render loop.
   - Instrument harnesses with per-iteration timing (`toggleDurationMs`) and keep min/max summaries in output.
   - Only escalate to Zellij host changes after reproducing the issue in a minimal isolated loop and ruling out plugin-local causes.

14. Clarify "one Jelly J per computer" semantics before implementation.
   - Desired behavior: one global Jelly J backend process, accessible from every Zellij session.
   - This does not mean "only one session can host Jelly J UI".
   - If a second session invokes Jelly J, it should connect to the existing backend and emit a session-switch context signal, not fail with "already running".
   - If behavior currently contradicts this, treat it as an architecture gap (missing global IPC/control-plane), not a lock-policy success.

15. Validate daemon behavior in an isolated HOME when possible.
   - Prefer `npm run test:harness:global` for daemon/socket smoke checks.
   - Avoid killing or mutating the live daemon while debugging unless explicitly requested.
   - Isolation avoids false negatives caused by user-local locks/history.

16. For Unix socket readiness, do not rely on `Bun.file(path).exists()`.
   - In Bun, `Bun.file(...).exists()` can return false for active Unix domain sockets.
   - Use `fs.stat(...).isSocket()` or an actual connect probe to verify daemon readiness.

17. Alt+j harness must validate daemon protocol health, not just pane toggling.
   - A passing toggle loop can still hide a dead/unresponsive daemon.
   - Require protocol-level success (`register_client` + `ping/pong`) during harness runs.

18. Global-presence harness must exercise a real chat turn, not only register/ping.
   - Pure socket health checks can pass while Claude resume state is broken.
   - Seed a stale `sessionId` and assert daemon recovery (fresh-session retry) with a successful reply.
   - Treat `"No conversation found with session ID ..."` and follow-on `code 1` as a recoverable resume failure path.
   - `JJ_SKIP_CHAT_PROBE=1` is only for offline debugging; default verification keeps chat probe enabled.

19. For daemon/chat harness isolation, prefer `JELLY_J_STATE_DIR` over `HOME` overrides.
   - Changing `HOME` can hide Claude auth and produce false negatives (`Not logged in · Please run /login`).
   - Keep user HOME/auth intact; isolate only Jelly J runtime files (`state.json`, `history.jsonl`, lock, socket, logs).

20. Cross-tab relocation requires explicit re-float after `break_panes_to_tab_with_index`.
   - On current Zellij `main`, moving Jelly across tabs can re-materialize it as tiled (vertical split).
   - Required sequence: hide -> `break_panes_to_tab_with_index` -> `toggle_pane_embed_or_eject_for_pane_id` -> `show_pane_with_id(..., true, true)`.
   - Keep a harness assertion that opening Jelly from another tab yields a floating pane on the active tab.

21. Alt+j CLI harness must include a real chat turn by default.
   - Toggle + daemon ping checks can pass while assistant execution is broken (`Claude Code process exited with code 1`, stale resume loops, bad runtime path).
   - Keep one end-to-end daemon chat probe in `test:harness:cli` and fail if it does not complete with expected text.
   - Allow opt-out only via explicit env flag (`JJ_CLI_HARNESS_CHAT_PROBE=0`) for offline debugging.

22. Harness plugin URL must be cache-busted per run when verifying new wasm behavior.
   - Long-lived Zellij servers can keep an older plugin instance cached for a stable URL.
   - For `test:harness:cli`, copy the wasm to a per-run temp path and use that `file:` URL so checks run against current code.
   - Only disable this explicitly (`JJ_CLI_HARNESS_COPY_PLUGIN=0`) when diagnosing URL/path issues.

## npm Distribution

Published as `jelly-j` on npm. Build output is ESM with `#!/usr/bin/env bun` shebang and `dist/` is the published payload.
