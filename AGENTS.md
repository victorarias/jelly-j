# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Development (uses tsx for live TypeScript execution)
npm start

# Type-check
npm run typecheck

# Build for distribution (produces dist/index.js with shebang)
npm run build

# Run the built version
node dist/index.js

# Build the Zellij launcher plugin (requires wasm32-wasip1 target)
cd plugin && cargo build --release --target wasm32-wasip1

# Copy plugin to Zellij plugins directory
cp plugin/target/wasm32-wasip1/release/jelly-j-launcher.wasm ~/.config/zellij/plugins/
```

## Architecture

Two components: a **Node.js REPL** (the assistant) and a **Rust WASM plugin** (the launcher).

## Mandatory Reference For Plugin Work

Before changing any launcher/plugin/keybind behavior, read:
- @docs/zellij-plugin-scripting-guide.md

Maintenance rule:
- If you find any statement in that guide is wrong, update it as part of your change.
- Treat `v0.43.1` behavior as canonical unless we intentionally upgrade Zellij; if you inspect `main`, call out version drift explicitly in the guide.

### Node.js REPL (`src/`)

```
index.ts  →  Readline REPL loop, sets terminal title to "Jelly J" (used by launcher to find the pane)
agent.ts  →  Claude Agent SDK integration: chat() for conversations, heartbeatQuery() for background checks
tools.ts  →  20 MCP tools wrapping zellij action subcommands, exported as a single SDK MCP server
zellij.ts →  Thin wrapper: execFile("zellij", ["action", ...args]) with 10s timeout
heartbeat.ts → Every 5min, dumps workspace state, asks Haiku if anything needs tidying, shows popup
```

**Data flow**: User types in REPL → `chat()` sends to Claude Opus 4.6 via Agent SDK → Claude calls MCP tools → tools run `zellij action` subcommands → results stream back to REPL.

The Agent SDK spawns a Claude Code subprocess per `query()` call. Session continuity is maintained via `resume` with a session ID. MCP servers require the async generator input form.

The heartbeat uses a separate Haiku model for cost efficiency (~$0.10/day). It skips checks while the user is actively chatting (`setBusy` flag).

### Zellij Launcher Plugin (`plugin/`)

A WASM plugin using `zellij-tile` 0.43.1 that provides launch-or-focus behavior for `Alt+j`:

- **First press**: Opens a floating terminal, writes `jelly-j\n` to it via `write_chars_to_pane_id`
- **Subsequent presses**: Finds the existing pane by title ("Jelly J") or command name, focuses it
- **Immediately hides itself** via `hide_self()` in `render()` — the plugin pane should never be visible

Uses a two-phase approach because `open_terminal_floating` is async:
1. Phase 1 (`launch_or_focus`): Opens the floating terminal, sets `awaiting_pane = true`
2. Phase 2 (`write_command_to_new_pane`): On next `PaneUpdate`, finds the new floating terminal by filtering for floating + non-plugin + not-yet-named panes, writes the command to it by pane ID

State machine flags: `ready` (permissions granted), `done` (action completed this cycle), `awaiting_pane` (waiting for phase 2).

## Key Design Decisions

- **`write_chars_to_pane_id` instead of `write_chars`**: The unfocused `write_chars` would target the wrong pane (the tiled shell instead of the new floating terminal). Writing by pane ID is reliable.
- **Terminal title escape code** (`\x1b]0;Jelly J\x07` in index.ts): Sets the pane title so the launcher plugin can find it on subsequent presses. Also checked via `terminal_command` as fallback.
- **No `open_command_pane_floating`**: Zellij command panes start suspended (user must press Enter). Using `open_terminal_floating` + `write_chars_to_pane_id` avoids this.
- **Agent SDK `permissionMode: "bypassPermissions"`**: Tools only run `zellij action` subcommands — no file access, no shell commands.
- **Plain text output**: The system prompt explicitly forbids markdown since the REPL runs in a raw terminal.

## npm Distribution

Published as `jelly-j` on npm. `tsup` builds a single ESM file with `#!/usr/bin/env node` shebang. Only `dist/` is included in the package (`files` field).
