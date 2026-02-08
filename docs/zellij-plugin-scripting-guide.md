# Zellij Plugin and Scripting Guide for Jelly J

IMPORTANT: If you find any information outlined here is wrong, correct it immediately in this document.

This guide documents the Zellij plugin behaviors that matter for Jelly J, especially around `Alt+j` toggling and floating-pane stability.

Scope:
- Zellij plugin lifecycle and event ordering
- Keybinding actions and their runtime semantics
- Pane state transitions (floating, suppressed, moved across tabs)
- Implementation rules to avoid stacked panes and docked regressions
- Test strategy for multi-tab toggle regressions

Version notes:
- Jelly J currently targets `zellij-tile = 0.43.1`.
- In `0.43.1`, `show_pane_with_id` takes 2 args (`pane_id`, `should_float_if_hidden`).
- On Zellij `main` (post-0.43.1), `show_pane_with_id` includes an extra `should_focus_pane` arg.

## 1) Lifecycle Rules You Must Assume

Zellij plugins implement `ZellijPlugin` with `load`, `update`, and `render`.

Important behavior:
- Events are asynchronous and not guaranteed to arrive in a strict order.
- `PermissionRequestResult` can arrive after other events.
- Plugin logic must gate state-changing actions behind permission readiness and current state availability.

Practical rule for Jelly J:
- Never perform launch/toggle actions until both permissions are granted and pane state has been observed (`PaneUpdate`).

## 2) Permission and Event Minimums for Launcher Plugins

For launcher behavior like Jelly J, the plugin generally needs:
- `ReadApplicationState`
- `ChangeApplicationState`
- `OpenTerminalsOrPlugins`
- `WriteToStdin`

Common event subscriptions:
- `PaneUpdate` for current pane manifest and ID discovery
- `PermissionRequestResult` for activation gating

## 3) Keybinding Action Semantics (Critical)

### `LaunchOrFocusPlugin`
- Launches plugin if not loaded in session.
- Focuses existing plugin if already loaded.
- Good default for singleton-like launcher behavior.

### `MessagePlugin`
- Sends a pipe message and can launch plugin if not running.
- Supports options like `launch_new`, `floating`, payload/name/cwd.
- Useful for message-driven workflows, but easier to accidentally fan out plugin instances depending on bind strategy.

Working guidance for Jelly J:
- Prefer `LaunchOrFocusPlugin` for `Alt+j` toggling.
- Use `MessagePlugin` only if explicit multi-instance/message semantics are intended.

## 4) Pane Command Semantics That Affect Toggle UX

Commands and implications:
- `hide_self`: suppresses plugin pane from UI.
- `close_self`: closes plugin pane instance; if it is the only selectable pane, session can exit.
- `hide_pane_with_id`: suppresses target pane.
- `show_pane_with_id(pane_id, should_float_if_hidden)`: unsuppresses, focuses, and can re-float when hidden.
- `break_panes_to_tab_with_index`: moves pane(s) to tab index.

Observed Jelly J invariant (source-backed, Zellij `v0.43.1`):
- `break_panes_to_tab_with_index` preserves floating only when `pane_id_is_floating(...)` is true in the source tab.
- `pane_id_is_floating` only checks the floating pane collection (suppressed panes are not considered floating).
- If you suppress before break, the moved pane can be re-added as tiled (docked split) in the target tab.

Safer relocation sequence for "always floating":
1. `break_panes_to_tab_with_index`
2. `hide_pane_with_id`
3. `show_pane_with_id(..., true)`

This sequence forces restored floating state in the destination tab, even after prior suppress/hide cycles.

## 5) Recommended Launcher State Machine Pattern

Use a single-cycle ephemeral plugin:
- On load:
1. Request permissions.
2. Subscribe to needed events.
- On update:
1. Cache latest pane manifest.
2. Wait until ready.
3. Execute one toggle cycle.
4. `close_self()` to avoid accumulating hidden plugin panes.

Why:
- Avoids long-lived hidden plugin instances and repeated-trigger fan-out.
- Keeps each `Alt+j` press deterministic.

## 6) Tab and Focus Resolution Strategy

When deciding target tab for toggle:
- Prefer tab containing focused plugin pane (invocation tab for `LaunchOrFocusPlugin` keybinds).
- Fallback to focused non-Jelly pane tab.
- Last fallback to any focused pane.

Why:
- Prevents stale focus data from causing toggles on the wrong tab.

## 7) Regression Checklist for “Opens as Vertical Split”

If Jelly reappears docked:
1. Confirm keybind uses `LaunchOrFocusPlugin`, not `MessagePlugin`.
2. Confirm relocation path does **not** suppress before `break_panes_to_tab_with_index`.
3. Confirm re-show uses `show_pane_with_id(..., true)`.
4. Confirm plugin cycle ends with `close_self()`.
5. Re-run multi-tab stress test.

## 8) Test Harness Requirements for This Project

The e2e harness should assert all of these:
- First press on a new tab places Jelly in focused tab.
- First press on a new tab shows Jelly as floating.
- First press on a new tab does not show Jelly docked in focused tab.
- Repeated presses do not create blank floating panes.
- Session never has more than one Jelly-like assistant pane.

## 9) Sources

Primary references used:
- Zellij plugin lifecycle: https://zellij.dev/documentation/plugin-lifecycle
- Zellij plugin API overview: https://zellij.dev/documentation/plugin-api
- Zellij plugin events: https://zellij.dev/documentation/plugin-api-events.html
- Zellij plugin commands: https://zellij.dev/documentation/plugin-api-commands
- Zellij keybinding actions (`LaunchOrFocusPlugin`, `MessagePlugin`): https://zellij.dev/documentation/keybindings-possible-actions.html
- `zellij-tile` crate docs: https://docs.rs/zellij-tile/latest/zellij_tile/
- `break_panes_to_tab_with_index`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.break_panes_to_tab_with_index.html
- `hide_pane_with_id`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.hide_pane_with_id.html
- `show_pane_with_id` (command description): https://zellij.dev/documentation/plugin-api-commands
- `write_chars_to_pane_id`: https://docs.rs/zellij-tile/latest/zellij_tile/shim/fn.write_chars_to_pane_id.html
- Event enum including `PermissionRequestResult`: https://docs.rs/zellij-tile/latest/zellij_tile/prelude/enum.Event.html
- Zellij source inspected locally: `/tmp/zellij` (commit `97744ad`, tag `v0.43.1` compared with `main`)

## 10) Source-Backed Invariants (v0.43.1)

These are the implementation facts this project should treat as ground truth until re-verified on a newer tag:

1. Suppress/focus path:
- `hide_pane_with_id` maps to `ScreenInstruction::SuppressPane(...)`.
- `show_pane_with_id` maps to `ScreenInstruction::FocusPaneWithId(...)`.
- Relevant code: `zellij-server/src/plugins/zellij_exports.rs`.

2. `FocusPaneWithId` and floating restore:
- `Tab::focus_pane_with_id` restores suppressed panes as floating only when `should_float_if_hidden = true`.
- Relevant code: `zellij-server/src/tab/mod.rs` (`focus_pane_with_id`).

3. `break_panes_to_tab_with_index` and floating preservation:
- During move, floating is preserved only if `pane_id_is_floating(...)` is true before extraction.
- `pane_id_is_floating` only checks current floating pane collection, not suppressed panes.
- Therefore, if pane is suppressed first, move may reinsert as tiled.
- Relevant code: `zellij-server/src/screen.rs` (`break_multiple_panes_to_tab_with_index`) and `zellij-server/src/tab/mod.rs` (`pane_id_is_floating`).

4. Suppressed extraction semantics:
- `suppress_pane` calls `extract_pane(..., true)` and stores pane in `suppressed_panes`.
- Relevant code: `zellij-server/src/tab/mod.rs` (`suppress_pane`, `extract_pane`).

5. API drift on `main`:
- On `main`, `show_pane_with_id` in `zellij-tile` includes `should_focus_pane`.
- On `v0.43.1`, it only takes `should_float_if_hidden`.
- This repo compiles against `0.43.1`, so examples must use the 2-arg form.

## 11) Debug Playbook for Alt+j Drift

If users report intermittent “opens as vertical split”:
1. Verify keybind config first:
- Ensure `Alt j` uses `LaunchOrFocusPlugin` with `floating true` and `move_to_focused_tab true`.
2. Verify relocation command order in plugin:
- Must be `break -> hide -> show`, not `hide -> break -> show`.
3. Verify plugin remains ephemeral:
- One cycle then `close_self()`.
4. Reproduce with stress pattern:
- Open/hide in tab A, switch tabs repeatedly, press `Alt+j` across tabs.
5. Check layout truth, not only UI screenshot:
- Use `dump-layout` and inspect floating blocks plus focused tab placement.

## 12) Maintenance Workflow

Before changing launcher logic:
1. Re-verify invariants against current target tag (`v0.43.1` unless dependency is upgraded).
2. If reading `main`, explicitly mark which behaviors are not yet in our target tag.
3. Update this guide in the same PR/commit whenever a claim changes.
4. Keep at least one e2e regression that simulates:
- hide in one tab
- first open in another tab
- assertion: Jelly is floating, not docked
