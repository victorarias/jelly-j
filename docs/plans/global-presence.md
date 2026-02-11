# Global Presence Plan (One Jelly J Backend Per Computer)

Status: `planned`  
Owner: Jelly J agents  
Last updated: 2026-02-11

## Goal

Implement true "one Jelly J per computer" semantics:
- one global Jelly J backend process for the machine
- accessible from any Zellij session
- shared conversation context across sessions
- explicit session-switch awareness when user messages from another session
- cross-session scrollback replay when opening UI in a new session

## Clarified Semantics

- This is **not** "only one Zellij session can use Jelly J".
- This **is** "one backend process, many session-local frontends".
- `Alt+j` in any session should open/hide that session's Jelly J pane and connect to the same backend.

## Current Gap

Today `src/index.ts` enforces a global lock for the **UI process** itself.  
Result: opening Jelly J in another session can fail with "already running" instead of connecting to the same backend.

## Target Architecture

## 1) Split runtime into backend + frontend

- `jelly-j daemon`
  - single global process
  - owns Claude session resume state, model state, and tool execution
  - stores global runtime data under `~/.jelly-j/`
- `jelly-j ui` (session-local pane client)
  - lightweight TTY frontend
  - sends user input to daemon and renders streamed output
  - can exist in multiple sessions; daemon remains singleton

`jelly-j` (no args):
- if daemon exists: start `ui`
- if daemon missing: start daemon, then start `ui`

## 2) Local IPC protocol (machine-local)

- Transport: Unix domain socket (eg. `~/.jelly-j/daemon.sock`)
- Encoding: newline-delimited JSON frames
- Request/response + stream events:
  - `register_client`
  - `history_snapshot`
  - `chat_start`
  - `chat_delta`
  - `tool_use`
  - `chat_end`
  - `error`
  - `heartbeat_note`
- Security:
  - socket mode `0600`
  - reject non-owner socket path and stale pid/socket mismatch

## 3) Session awareness

Each UI sends:
- `zellijSession` (`$ZELLIJ_SESSION_NAME`)
- client metadata (pid, cwd, hostname, startedAt)

Daemon tracks:
- `lastActiveSession`
- `activeClientId`

On first message from a different session:
- daemon injects system context note to the model:
  - "User switched from session A to session B; workspace may differ."
- emits a visible UI note in that client.

## 3b) Cross-session scrollback model

When a UI connects from any session, it should immediately receive prior Jelly J scrollback,
including turns produced while user was in other sessions.

V1 (required):
- daemon maintains canonical chat event log (append-only, global).
- on `register_client`, daemon sends `history_snapshot` (bounded window, eg last 300-500 lines).
- UI renders snapshot before accepting new input.
- snapshot entries include source session metadata.

V2 (optional later):
- workspace scrollback federation (pane content summaries from multiple sessions) via butler APIs.
- this is separate from Jelly chat transcript replay and may require additional Zellij/plugin support.

## 4) Butler/plugin relationship

- Keep current per-session butler plugin model.
- `Alt+j` remains session-local toggle UI action.
- UI pane command becomes `jelly-j ui` (never owns singleton lock).
- Backend remains independent of pane lifetime.

## 5) Locking model changes

- Replace current global lock meaning:
  - old: "only one `jelly-j` UI process may run"
  - new: "only one daemon may run"
- Keep lock file (`~/.jelly-j/agent.lock.json`) but redefine owner to daemon pid.
- UI should never fail with "already running"; it should connect.

## Implementation Phases

## Phase A: Control-plane skeleton (`in_progress` once started)

1. Add `src/daemon.ts` with singleton lock ownership and IPC server.
2. Add `src/ui-client.ts` to connect and stream events to terminal.
3. Add CLI mode parsing (`daemon`, `ui`, default).
4. Preserve existing REPL rendering behavior in UI client.

Exit criteria:
- two separate terminals can run `jelly-j ui` concurrently
- both connect to same daemon pid

## Phase B: Move chat execution to daemon

1. Move `chat()` calls and session persistence (`state.json`) into daemon.
2. Keep one global `sessionId` in daemon state.
3. Route streaming events from daemon to requesting UI only.
4. Keep model-switch commands global (or explicitly session-scoped, choose one policy).

Exit criteria:
- conversation continues seamlessly from any session UI
- daemon survives UI pane close/reopen

## Phase B2: Scrollback replay (required for global presence UX)

1. Introduce structured global history store (eg `~/.jelly-j/history.jsonl`).
2. Write chat events with `session`, `role`, `text`, `timestamp`.
3. Implement `history_snapshot` server event on UI registration.
4. Render snapshot in UI with clear "replayed history" boundary marker.

Exit criteria:
- opening Jelly J in Session B immediately shows recent turns from Session A
- no duplicate replay on reconnect unless explicitly requested

## Phase C: Session-switch context behavior

1. Add daemon session tracker (`lastActiveSession`).
2. Inject session-change context note on first message in new session.
3. Add trace entry + user-visible note for debuggability.

Exit criteria:
- message in session B after session A yields explicit context-switch note

## Phase D: Integrate with Alt+j UX

1. Update plugin launch command from `jelly-j` to `jelly-j ui`.
2. Keep hide/show logic unchanged.
3. Ensure pressing Alt+j in different sessions opens UI connected to same daemon.

Exit criteria:
- no "already running" error pane
- per-session toggle works, global backend remains one process

## Phase E: Hardening + observability

1. Add daemon health command (`jelly-j status`).
2. Add restart command (`jelly-j restart-daemon`).
3. Add daemon logs ring buffer and retrieval command.
4. Add socket/lock stale cleanup and clear error messages.

Exit criteria:
- predictable restart/recovery after crashes or stale sockets

## Testing Plan

## Automated

- Unit:
  - lock ownership transitions
  - stale lock/socket recovery
  - session-switch detection/injection logic
- Integration:
  - spawn daemon + two UI clients with different `ZELLIJ_SESSION_NAME`
  - assert same daemon pid and shared conversation id
  - assert session-switch note only on session changes
- Existing harness:
  - retain Alt+j toggle latency/failure checks

## Manual acceptance

1. Open Session A, `Alt+j`, send prompt.
2. Open Session B, `Alt+j`, send prompt.
3. Verify:
   - no "already running" error
   - response references same ongoing conversation
   - session switch note appears once when switching
   - Session B UI shows replayed recent scrollback produced in Session A

## Risks / Tradeoffs

- Multi-client concurrent prompts:
  - define serialization policy (queue globally vs per-client cancellation).
- Shared model state:
  - global model changes affect all UIs unless scoped.
- IPC complexity:
  - requires robust stream lifecycle handling and reconnection.

## Open Decisions

1. Concurrency policy: queue one prompt globally, or allow parallel prompts with cancellation?
2. Model scope: global model selection or per-client model selection?
3. Background lifetime: keep daemon always-on, or add idle timeout auto-shutdown?

## Upstream/Zellij Note

This architecture solves cross-session singleton semantics **at Jelly J app level**.  
It does not require additional Zellij API changes beyond what is already in the fork.
