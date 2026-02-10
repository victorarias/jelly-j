# Jelly J Butler Architecture

## Context

Jelly J today is an ephemeral launcher plugin + Node.js REPL that communicate only indirectly (pane title matching). This limits what the system can do seamlessly — operations like renaming tabs require focus switching, the heartbeat polls every 5 min via CLI, conversation history is lost when the REPL exits, and nothing survives across zellij sessions.

The target state is a single persistent butler experience:
- no separate "launcher mode" fallback
- global conversation continuity across zellij sessions
- Bun runtime instead of Node.js

## Locked Decisions

1. Single experience only: the old ephemeral launcher behavior is removed.
2. Naming stays `jelly-j` everywhere (plugin artifact, crate/package naming, docs).
3. Conversation memory is intentionally global (`~/.jelly-j/state.json`) and shared across sessions/clients.
4. Plugin API implementation target is local Zellij `main` (path dependency).
   - On `main`, `show_pane_with_id` takes 3 args.
   - On `0.43.1`, `show_pane_with_id` takes 2 args.
   - If we downgrade/retarget, all `show_pane_with_id` call sites must be updated in the same change.

## Three Workstreams

### 1. Persistent Butler Plugin (Rust WASM)

**What changes**: The ephemeral launcher (`close_self()` after each Alt+j) is replaced by a persistent background plugin that stays alive for the session, caches workspace state from events, and accepts commands via zellij pipes.

**Keybinding**: `LaunchOrFocusPlugin` → `MessagePlugin`
```kdl
bind "Alt j" {
    MessagePlugin "file:~/.config/zellij/plugins/jelly-j.wasm" {
        name "toggle"
        floating true
    }
}
```

`MessagePlugin` launches the plugin on first message if not running, messages it thereafter. Do not set `launch_new true`; singleton behavior is required.

**State machine change**:
```
Current: load → permission → first PaneUpdate → toggle → close_self()
Butler:  load → permission → idle (caching PaneUpdate + TabUpdate)
         pipe("toggle") → toggle → idle
         pipe("request") → execute → respond → idle
```

The toggle sub-state-machine (awaiting_pane, relocating) stays identical. The only structural change is removing `done`/`close_self()` and adding `pipe()`.

**Focused tab detection**: Currently relies on finding a focused plugin pane (the launcher itself). Won't work for a background plugin. Prefer `TabUpdate` (`TabInfo.active`) and keep pane-focus fallback when `TabUpdate` is absent in headless/background runs:
```rust
fn active_tab_index(&self) -> Option<usize> {
    self.tabs
        .as_ref()
        .and_then(|tabs| tabs.iter().find(|t| t.active).map(|t| t.position))
        .or_else(|| /* pane focus fallback */)
}
```

**Pipe readiness**: on cold start, a pipe can arrive before caches are primed by events. For `request` messages, return a retryable "not ready" response until `PaneUpdate` cache is available. Do not hard-require `TabUpdate` for toggle execution.

**IPC protocol**: Node.js sends JSON via `zellij pipe --plugin <url> --name request -- '{"op":"rename_tab",...}'`. Butler parses, executes using native plugin API, responds via `cli_pipe_output()`. The `zellij pipe` CLI blocks until response, giving synchronous semantics from the REPL side.

Operations available through pipe:
| op | plugin API call | why it matters |
|---|---|---|
| `rename_tab` | `rename_tab(position, name)` | no focus switch |
| `rename_pane` | `rename_pane_with_id(pane_id, name)` | no focus switch |
| `hide_pane` | `hide_pane_with_id(pane_id)` | |
| `show_pane` | `show_pane_with_id(pane_id, should_float_if_hidden, should_focus_pane)` | main signature |
| `get_state` | return cached tabs + pane summary | single call, no polling |
| `ping` | return ok | health check |

**New permission**: `ReadCliPipes` (in addition to existing 4).

**New dependency**: `serde_json = "1"` in Cargo.toml for JSON serialization.

**Files**:
- `plugin/src/main.rs` — rewrite (~350 lines, toggle logic reused)
- `plugin/Cargo.toml` — add serde_json, rename package from launcher naming to `jelly-j`
- remove/rename legacy launcher references (`jelly-j-launcher`) from tests/docs/config examples

### 2. Cross-Session Persistence

**What changes**: Conversation history survives REPL restarts and zellij session changes. The LLM knows which zellij session it's in.

**Session ID persistence**: Currently `sessionId` is an in-memory variable in `index.ts` (lost on exit). The Agent SDK already persists session data to `~/.claude/projects/` — we just need to remember the session UUID.

This is intentionally global, not per zellij session.
- single file path: `~/.jelly-j/state.json`
- last writer wins by design

Store at `~/.jelly-j/state.json`:
```json
{
  "sessionId": "67cf7ec5-95f0-4ced-9cc7-7690ca78a470",
  "zellijSession": "main"
}
```

On startup:
1. Read `state.json`
2. Read `ZELLIJ_SESSION_NAME` env var (set by zellij in all child processes)
3. If session ID exists, pass to Agent SDK via `options.resume`
4. If zellij session name changed from stored value, prepend a system-level context message: "Note: you are now in zellij session 'foo' (previously 'bar'). Tab and pane state may have changed."
5. On each successful chat turn, write current sessionId + zellijSession back to state.json

On exit (SIGINT, `quit`, etc.):
1. Write final state to `state.json`

This means: close a zellij session, open a new one, press Alt+j — the LLM picks up where it left off and knows the session context changed.

**Files**:
- `src/index.ts` — load/save state, pass resume to chat()
- `src/agent.ts` — accept session change context, include in system prompt
- New `src/state.ts` — read/write `~/.jelly-j/state.json`

### 3. Bun Migration

**What changes**: Replace Node.js with Bun as the runtime. Bun 1.3.0 is already installed on this machine.

**Why**: Bun runs TypeScript natively (no tsx), starts faster, has a built-in bundler (no tsup), and aligns with the project being a personal tool rather than a widely-distributed npm package.

**Compatibility**: All APIs used (readline, child_process, fs/promises, path) are fully supported in Bun. The Agent SDK spawns subprocesses which work identically.

**Changes**:
| Current | Bun |
|---|---|
| `node --import tsx src/index.ts` | `bun src/index.ts` |
| `tsup` build | `bun build src/index.ts --outfile dist/index.js --target bun` |
| `#!/usr/bin/env node` shebang | `#!/usr/bin/env bun` |
| `"node", "-e", script` in heartbeat popup | `"bun", "-e", script` (or detect runtime) |
| `node --import tsx tests/e2e/alt-j-cli-harness.ts` | `bun tests/e2e/alt-j-cli-harness.ts` |

**Removed dev dependencies**: `tsx`, `tsup` (Bun handles both natively).

**npm distribution note**: The shebang change means `npx jelly-j` requires Bun. For personal use this is fine. If npm distribution matters later, a wrapper script can auto-detect.

**Files**:
- `package.json` — update scripts (`start`, `build`, `test:harness:cli`), remove tsx/tsup from devDeps, update runtime engine declaration
- `src/heartbeat.ts` — change `"node"` to `"bun"` in popup command
- `tsup.config.ts` (if exists) — remove, replaced by bun build

## Implementation Order

### Phase 1: Bun migration
Lowest risk, unblocks faster dev cycle. Swap runtime and scripts first.

### Phase 2: Cross-session persistence
Small change, high value. Persist global session ID to disk + read `ZELLIJ_SESSION_NAME`.

### Phase 3: Persistent butler plugin (toggle only)
Rewrite launcher into persistent plugin. Pipe-based toggle replaces ephemeral cycle. No IPC yet — only toggle path.

### Phase 4: Butler IPC
Add request/response pipe handler (`request`/`cli_pipe_output`). New `zellijPipe.ts` on REPL side. Add butler-powered MCP tools.

### Phase 5: Heartbeat via butler
Replace polling `zellijAction` calls with `zellijPipe({op:"get_state"})`. Add `renameUnnamedTabs()` using `zellijPipe({op:"rename_tab"})` — the original motivation.

### Phase 6: Remove legacy surface area
Delete/rename remaining launcher-era names, defaults, and docs so only butler behavior exists.

### Phase 7: Reactive behaviors (future)
Butler reacts to `TabUpdate`/`PaneUpdate` proactively. Auto-name tabs on creation. Event-driven instead of polling.

## Verification

- **Bun**: `bun src/index.ts` starts REPL, chat works, heartbeat popup appears
- **Persistence (global)**: Exit REPL, relaunch anywhere — conversation resumes globally. Change zellij session — LLM acknowledges the change.
- **Butler toggle**: `Alt+j` creates/toggles Jelly J pane. No plugin pane accumulation. Cross-tab relocation works. Plugin survives multiple presses without restarting.
- **Butler IPC**: `zellij pipe --plugin file:.../jelly-j.wasm --name request -- '{"op":"ping"}'` returns `{"ok":true}`. From REPL, rename a tab by position — no visible focus switch.
- **Heartbeat rename**: Wait for tick with unnamed tabs — they get renamed silently.
- **Legacy removal**: no `jelly-j-launcher` references remain in keybind docs, harness defaults, or plugin artifact names.
