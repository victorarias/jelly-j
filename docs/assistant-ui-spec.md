# Jelly J Assistant UI Spec (v1)

Date: 2026-02-08
Scope: differential-rendered terminal UI (`src/index.ts` path), one slash command (`/model`), one dark theme.

## 1) Goals

1. Make the assistant state legible at a glance (model, session, busy/idle).
2. Improve scanability of responses and tool activity without leaving plain terminal output.
3. Keep interaction keyboard-first and fast.
4. Avoid adding a broad command system for v1.

## 2) Non-Goals

1. No light mode or theme switching.
2. No slash commands besides `/model`.
3. No mouse interaction.
4. No markdown rendering engine.

## 3) Inputs From Current Shell Theme

Source files:
- `~/.config/ghostty/config`
- `~/.config/fish/conf.d/04-colors.fish`

Observed effective Ghostty defaults and ANSI palette (via `ghostty +show-config --default`):
- Background: `#282c34`
- Foreground: `#ffffff`
- ANSI black (bright): `#666666`
- ANSI red: `#cc6666`
- ANSI green: `#b5bd68`
- ANSI yellow: `#f0c674`
- ANSI blue: `#81a2be`
- ANSI magenta: `#b294bb`
- ANSI cyan: `#8abeb7`

Fish semantic colors align with ANSI names:
- command/operator -> cyan
- option/redirection -> yellow
- quote -> green
- error -> red
- escape -> magenta
- autosuggestion/comment -> bright black

Design rule: prefer ANSI semantic colors (not hardcoded RGB in runtime output) so Jelly J follows the active terminal theme while matching your current palette.

## 4) Information Architecture

Three persistent zones in the REPL:

1. Header (single line, always visible when prompt returns)
- App label: `Jelly J`
- Active model alias: `opus` or `haiku`
- Session indicator: short session ID or `new`
- State badge: `idle`, `thinking`, `tool`, `error`

2. Transcript (scrolling)
- User turns
- Assistant text stream
- Tool call lines
- System notices (model changed, errors)

3. Input line (custom raw-key input editor)
- Prompt symbol: `❯`
- Slash command entry and normal chat input

## 5) Layout Wireframe

```txt
Jelly J  model: opus  session: a1b2c3  state: idle

you  name my tabs based on commands
jj   I'll inspect your workspace and name tabs by dominant command.
tool get_layout
tool list_tabs
tool rename_tab name="logs"
jj   Done. Renamed 3 tabs: logs, dev, deploy.

❯
```

## 6) Visual Tokens

ANSI semantic mapping for v1:

1. `ui.base` -> default fg/bg (terminal default; Ghostty currently `#ffffff` on `#282c34`)
2. `ui.muted` -> bright black (`#666666`) for metadata and separators
3. `ui.info` -> cyan (`#8abeb7`) for labels and command affordances
4. `ui.warn` -> yellow (`#f0c674`) for in-progress states
5. `ui.success` -> green (`#b5bd68`) for completion notices
6. `ui.error` -> red (`#cc6666`) for errors/failures
7. `ui.meta` -> blue (`#81a2be`) for session/model metadata

Formatting rules:
- Bold only for the header label (`Jelly J`) and never for full paragraphs.
- No full-screen clearing between turns.
- One blank line between conversation turns.

## 7) Interaction Spec

### 7.1 Prompt and Turn Lifecycle

1. Idle:
- Header state badge: `idle` (muted/info).
- Prompt active: `❯ `

2. On submit:
- Readline pauses.
- Header state badge flips to `thinking`.
- Spinner animation in header badge (single glyph frame update).

3. While assistant streams:
- Assistant text prints as `jj   <text>`
- Tool-use blocks print as `tool <name> <args>` in muted/info style.
- If tool call starts, header state badge becomes `tool`.

4. Completion:
- Header state returns to `idle`.
- Prompt restored.

5. Error:
- Print one-line error notice prefixed `error`.
- Header state set to `error` until next input.

### 7.2 Slash Commands

Only one command is supported:

`/model`
- `/model` -> shows current model and available aliases.
- `/model <alias>` -> switches model for future chat turns in current REPL session.
- Valid aliases for v1:
  - `opus` -> `claude-opus-4-6` (default)
  - `haiku` -> `claude-haiku-4-5-20251001`
- Invalid alias returns inline error with valid options.

Output examples:
- `model current: opus (claude-opus-4-6)`
- `model changed: haiku (claude-haiku-4-5-20251001)`

### 7.3 Transcript Prefixes

Fixed prefixes for scanability:

- `you` for user input echo
- `jj` for assistant text
- `tool` for MCP tool calls
- `note` for local system notices
- `error` for failures

## 8) Technical Design

### 8.1 Minimal New Modules

1. `src/ui.ts`
- ANSI helpers and semantic color functions
- differential line renderer (only changed rows are repainted)
- bottom-anchored prompt box renderer and transcript layout

2. `src/commands.ts`
- parse slash commands
- `/model` execution and validation

3. `src/agent-session.ts`
- queued, event-driven agent session orchestration
- model/session state and streaming event fanout to UI

### 8.2 Changes to Existing Files

1. `src/index.ts`
- maintain `currentModel` in process state (default `opus`)
- route `/model` input before enqueueing prompts
- handle raw keyboard input/history and keep prompt anchored at bottom
- subscribe to agent-session events and update transcript

2. `src/agent.ts`
- accept model override in `chat(...)`
- keep tool-use callback behavior but add structured prefix hooks for `tool` lines

## 9) Acceptance Criteria (v1)

1. Header always shows model + state before each prompt.
2. `/model` works as query and setter, with validation.
3. Assistant turns are visibly separated into `you/jj/tool/error` prefixed lines.
4. Busy and tool states are visible during long responses.
5. UI output remains plain terminal text and works inside Zellij floating pane.
6. No regressions to exit commands (`exit`, `bye`, `quit`, `q`) or heartbeat behavior.

## 10) Out of Scope Follow-up (v2+)

1. Additional slash commands.
2. Split-view tool log pane.
3. Theme toggles.
