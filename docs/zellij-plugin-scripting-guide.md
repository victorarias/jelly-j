# Zellij Plugin and Scripting Guide for Jelly J

IMPORTANT: If you find any information outlined here is wrong, correct it immediately in this document.

This guide documents the Zellij behaviors that matter for Jelly J's persistent butler plugin.

Scope:
- Persistent plugin lifecycle and event ordering
- Keybinding semantics for `MessagePlugin`
- Pipe protocol (`toggle` + `request`) and response contracts
- Deterministic toggle invariants for single-pane behavior
- Test strategy for `Alt+j` stability

Version notes:
- Jelly J currently compiles against local Zellij `main` via `zellij-tile = { path = "../../../zellij/zellij-tile" }`.
- Verified source reference: `zellij-org/zellij` commit `97744ad0`.
- On this target, `show_pane_with_id` takes 3 args:
  `show_pane_with_id(pane_id, should_float_if_hidden, should_focus_pane)`.
- If the project returns to `v0.43.1`, update all 3-arg call sites to the 2-arg form.

## 1) Lifecycle Rules

Zellij plugins implement `ZellijPlugin` with `load`, `update`, `pipe`, and `render`.

Operational assumptions:
- Events are asynchronous and not strictly ordered.
- `PermissionRequestResult` may arrive after `PaneUpdate`/`TabUpdate`.
- Pipe requests can arrive before caches are populated.
- On `main`, some headless/background harness runs emit `PaneUpdate` without `TabUpdate`.

Practical rule for Jelly J:
- Gate stateful actions behind permission readiness and pane-cache readiness.
- Do not require `TabUpdate` for toggle execution; fall back to focused pane heuristics.

## 2) Permissions and Subscriptions

Persistent butler requires:
- `ReadApplicationState`
- `ChangeApplicationState`
- `OpenTerminalsOrPlugins`
- `WriteToStdin`
- `ReadCliPipes`

Event subscriptions:
- `PaneUpdate`
- `TabUpdate`
- `PermissionRequestResult`

## 3) Keybinding Model (Canonical)

Jelly J uses `MessagePlugin` for `Alt+j`.

```kdl
bind "Alt j" {
    MessagePlugin "file:~/.config/zellij/plugins/jelly-j.wasm" {
        name "toggle"
        floating true
    }
}
```

Guidelines:
- Do not use `LaunchOrFocusPlugin` for Jelly J anymore.
- Do not set `launch_new true` for this bind (singleton behavior is required).

## 4) Pipe Protocol

Two names are reserved:
- `toggle`: keybinding-triggered open/hide/focus cycle.
- `request`: JSON RPC-like operation channel (CLI/Node side).

CLI form:
- `zellij pipe --plugin file:.../jelly-j.wasm --name request -- '{"op":"ping"}'`

Response contract (via `cli_pipe_output`):
- Success: `{ "ok": true, "result": ... }`
- Error: `{ "ok": false, "code": "...", "error": "..." }`

Required error code:
- `not_ready`: plugin is loaded but not yet ready to serve stateful requests.

## 5) Butler State Machine

High-level flow:
- `load -> subscribe + request_permission`
- `update(PermissionGranted) -> ready`
- `update(PaneUpdate/TabUpdate) -> refresh caches`
- `update(PaneUpdate) with no permission event -> infer cached grant readiness`
- `pipe(toggle) -> schedule toggle cycle`
- `pipe(request) -> parse/execute/respond`

The plugin is persistent:
- Keep `hide_self()` in `render()`.
- Do not call `close_self()` after each toggle.

## 6) Focus and Tab Resolution

Because plugin panes are hidden and not used as focus anchors:
- Prefer `TabUpdate` (`TabInfo.active`) for focused tab.
- Fallback to pane focus in `PaneManifest` if needed.

This avoids stale-target toggles in multi-tab sessions.

## 7) Deterministic Toggle Invariant

Toggle behavior must avoid multi-event wait loops:
1. Snapshot pane manifest.
2. Keep exactly one Jelly pane; close extras.
3. If Jelly is visible in the current tab, hide it.
4. Otherwise move it to the current tab (if needed) and reveal via `focus_terminal_pane(..., true, false)`.
5. If none exists, launch atomically with `launch_terminal_pane(..., stdin_write=Some("jelly-j\\n"), floating=true, ...)`.

Why:
- Prevents stale `awaiting_*` / `relocating_*` state.
- Keeps `Alt+j` responsiveness bounded to a single toggle pass.
- Enforces one Jelly pane per session.

## 8) Request Ops

Current request operations:
- `ping`
- `get_state`
- `get_trace`
- `clear_trace`
- `rename_tab`
- `rename_pane`
- `hide_pane`
- `show_pane`

All state-changing ops require permissions to be granted.
`get_state` requires `PaneUpdate` cache readiness.

## 9) Regression Checklist

If users report `Alt+j` instability:
1. Verify keybind uses `MessagePlugin` and `name "toggle"`.
2. Verify plugin remains persistent (`hide_self` only, no per-toggle `close_self`).
3. Verify toggle path does not depend on `awaiting_*` / `relocating_*` loops.
4. Verify reveal path uses `focus_terminal_pane(..., true, false)` and keeps one Jelly pane.
5. Re-run multi-tab e2e stress tests and inspect `dump-layout` output.

## 10) Test Requirements

e2e harnesses should assert:
- First `Alt+j` opens Jelly J in focused tab as floating.
- Repeated `Alt+j` does not create blank floating panes.
- Session keeps at most one Jelly-like assistant pane.
- Hidden-in-tab-A then first-open-in-tab-B restores floating (not docked).
- Pipe IPC `ping` and `get_state` return valid JSON envelopes.

## 11) Sources

Primary references:
- Zellij plugin lifecycle: https://zellij.dev/documentation/plugin-lifecycle
- Zellij plugin API overview: https://zellij.dev/documentation/plugin-api
- Zellij plugin events: https://zellij.dev/documentation/plugin-api-events.html
- Zellij plugin commands: https://zellij.dev/documentation/plugin-api-commands
- Zellij keybinding actions (`MessagePlugin`): https://zellij.dev/documentation/keybindings-possible-actions.html
- `zellij-tile` crate docs: https://docs.rs/zellij-tile/latest/zellij_tile/
- `break_panes_to_tab_with_index`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.break_panes_to_tab_with_index.html
- `hide_pane_with_id`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.hide_pane_with_id.html
- `show_pane_with_id`: https://zellij.dev/documentation/plugin-api-commands
- `focus_terminal_pane`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.focus_terminal_pane.html
- `launch_terminal_pane`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.launch_terminal_pane.html
- Zellij source inspected locally: `/Users/victor.arias/projects/zellij` (commit `97744ad0`, branch `main`)

## 12) Maintenance Workflow

Before changing Jelly J plugin behavior:
1. Re-verify invariants against the actual dependency target (currently local `main`).
2. If target changes to a tagged release (eg. `v0.43.1`), update this guide in the same change.
3. Keep at least one e2e scenario that exercises hide/relocate/show across tabs.
4. Update this guide immediately whenever a source-backed claim changes.
