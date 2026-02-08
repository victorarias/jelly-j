const SOURCE_DATE = "2026-02-08";
const SOURCE_REPOS = [
  "zellij-org/zellij@97744ad0 (branch: main)",
  "zellij-org/zellij.dev@551eb88 (branch: main)",
];
const SOURCE_SCOPE_NOTE =
  "Snapshot from upstream main branches; behavior may differ from your installed zellij version.";

const KEYBIND_MODES = [
  "normal",
  "locked",
  "resize",
  "pane",
  "move",
  "tab",
  "scroll",
  "search",
  "entersearch",
  "renametab",
  "renamepane",
  "session",
  "tmux",
] as const;

const PLUGIN_PERMISSIONS = [
  "ReadApplicationState",
  "ChangeApplicationState",
  "OpenFiles",
  "RunCommand",
  "OpenTerminalsOrPlugins",
  "WriteToStdin",
  "Reconfigure",
  "FullHdAccess",
  "StartWebServer",
  "InterceptInput",
] as const;

const DOC_PAGE_INDEX = [
  "SUMMARY.md",
  "changing-modifiers.md",
  "cli-actions.md",
  "cli-commands.md",
  "cli-plugins.md",
  "command-line-options.md",
  "commands.md",
  "compact-bar-alias.md",
  "compatibility.md",
  "configuration-options.md",
  "configuration.md",
  "controlling-zellij-through-cli.md",
  "creating-a-layout.md",
  "faq.md",
  "filepicker-alias.md",
  "installation.md",
  "integration.md",
  "introduction.md",
  "keybinding-presets.md",
  "keybindings-binding.md",
  "keybindings-examples.md",
  "keybindings-keys.md",
  "keybindings-modes.md",
  "keybindings-overriding.md",
  "keybindings-possible-actions.md",
  "keybindings-shared.md",
  "keybindings.md",
  "layout-examples.md",
  "layouts-templates.md",
  "layouts-with-config.md",
  "layouts.md",
  "legacy-themes.md",
  "migrating-yaml-config.md",
  "migrating-yaml-layouts.md",
  "options.md",
  "overview.md",
  "plugin-aliases.md",
  "plugin-api-commands.md",
  "plugin-api-configuration.md",
  "plugin-api-events.md",
  "plugin-api-file-system.md",
  "plugin-api-logging.md",
  "plugin-api-permissions.md",
  "plugin-api-workers.md",
  "plugin-api.md",
  "plugin-dev-env.md",
  "plugin-development.md",
  "plugin-examples.md",
  "plugin-lifecycle.md",
  "plugin-loading.md",
  "plugin-other-languages.md",
  "plugin-other.md",
  "plugin-overview",
  "plugin-overview.md",
  "plugin-pipes.md",
  "plugin-rust.md",
  "plugin-system-status.md",
  "plugin-ui-rendering.md",
  "plugin-upgrade-0.38.0.md",
  "plugin-upgrading.md",
  "plugin-writing.md",
  "plugin-zig.md",
  "plugins.md",
  "rebinding-keys.md",
  "session-manager-alias.md",
  "session-resurrection.md",
  "status-bar-alias.md",
  "strider-alias.md",
  "swap-layouts.md",
  "tab-bar-alias.md",
  "theme-gallery.md",
  "theme-list.md",
  "themes.md",
  "web-client.md",
  "welcome-screen-alias.md",
  "zellij-edit.md",
  "zellij-pipe.md",
  "zellij-plugin.md",
  "zellij-run.md",
] as const;

const CLI_ACTIONS = [
  "close-pane",
  "close-tab",
  "dump-screen",
  "edit",
  "dump-layout",
  "edit-scrollback",
  "focus-next-pane",
  "focus-previous-pane",
  "go-to-next-tab",
  "go-to-previous-tab",
  "go-to-tab",
  "go-to-tab-name",
  "half-page-scroll-down",
  "half-page-scroll-up",
  "launch-or-focus-plugin",
  "list-clients",
  "move-focus",
  "move-focus-or-tab",
  "move-pane",
  "new-pane",
  "new-tab",
  "page-scroll-down",
  "page-scroll-up",
  "rename-pane",
  "rename-tab",
  "resize",
  "scroll-down",
  "scroll-to-bottom",
  "scroll-up",
  "start-or-reload-plugin",
  "switch-mode",
  "toggle-active-sync-tab",
  "toggle-floating-panes",
  "toggle-fullscreen",
  "toggle-pane-embed-or-floating",
  "toggle-pane-frames",
  "undo-rename-pane",
  "undo-rename-tab",
  "query-tab-names",
  "write",
  "write-chars",
  "toggle-pane-pinned",
  "stack-panes",
  "change-floating-pane-coordinates",
] as const;

const KEYBIND_ACTIONS = [
  "Clear",
  "CloseFocus",
  "CloseTab",
  "Detach",
  "DumpScreen",
  "EditScrollback",
  "FocusNextPane",
  "FocusPreviousPane",
  "GoToNextTab",
  "GoToPreviousTab",
  "GoToTab",
  "HalfPageScrollDown",
  "HalfPageScrollUp",
  "LaunchOrFocusPlugin",
  "MessagePlugin",
  "MoveFocus",
  "MoveFocusOrTab",
  "MovePane",
  "MoveTab",
  "NextSwapLayout",
  "NewPane",
  "NewTab",
  "PageScrollDown",
  "PageScrollUp",
  "PreviousSwapLayout",
  "Quit",
  "Resize",
  "Run",
  "ScrollDown",
  "ScrollToBottom",
  "ScrollUp",
  "ScrollToTop",
  "Search",
  "SearchToggleOption",
  "SwitchToMode",
  "ToggleActiveSyncTab",
  "ToggleFloatingPanes",
  "ToggleFocusFullscreen",
  "ToggleMouseMode",
  "TogglePaneEmbedOrFloating",
  "TogglePaneFrames",
  "ToggleTab",
  "UndoRenamePane",
  "UndoRenameTab",
  "Write",
  "WriteChars",
] as const;

const PLUGIN_API_COMMANDS = [
  "subscribe",
  "unsubscribe",
  "request_permission",
  "set_selectable",
  "get_plugin_ids",
  "get_zellij_version",
  "open_file",
  "open_file_floating",
  "open_file_in_place",
  "open_file_with_line",
  "open_file_with_line_floating",
  "open_file_near_plugin",
  "open_file_floating_near_plugin",
  "open_file_in_place_of_plugin",
  "open_terminal",
  "open_terminal_floating",
  "open_terminal_in_place",
  "open_terminal_near_plugin",
  "open_terminal_floating_near_plugin",
  "open_terminal_in_place_of_plugin",
  "open_command_pane",
  "open_command_pane_floating",
  "open_command_pane_in_place",
  "open_command_pane_near_plugin",
  "open_command_pane_floating_near_plugin",
  "open_command_pane_in_place_of_plugin",
  "run_command",
  "web_request",
  "switch_tab_to",
  "set_timeout",
  "hide_self",
  "show_self",
  "switch_to_input_mode",
  "new_tabs_with_layout",
  "new_tabs_with_layout_info",
  "new_tab",
  "go_to_next_tab",
  "go_to_previous_tab",
  "resize_focused_pane",
  "resize_focused_pane_with_direction",
  "focus_next_pane",
  "focus_previous_pane",
  "move_focus",
  "move_focus_or_tab",
  "detach",
  "edit_scrollback",
  "write",
  "write_chars",
  "toggle_tab",
  "move_pane",
  "move_pane_with_direction",
  "clear_screen",
  "scroll_up",
  "scroll_down",
  "scroll_to_top",
  "scroll_to_bottom",
  "page_scroll_up",
  "page_scroll_down",
  "toggle_focus_fullscreen",
  "toggle_pane_frames",
  "toggle_pane_embed_or_eject",
  "close_focus",
  "toggle_active_tab_sync",
  "close_focused_tab",
  "quit_zellij",
  "previous_swap_layout",
  "next_swap_layout",
  "go_to_tab_name",
  "focus_or_create_tab",
  "post_message_to",
  "post_message_to_plugin",
  "close_terminal_pane",
  "close_plugin_pane",
  "focus_terminal_pane",
  "focus_plugin_pane",
  "rename_terminal_pane",
  "rename_plugin_pane",
  "rename_tab",
  "switch_session",
  "switch_session_with_focus",
  "switch_session_with_layout",
  "block_cli_pipe_input",
  "unblock_cli_pipe_input",
  "cli_pipe_output",
  "pipe_message_to_plugin",
  "delete_dead_session",
  "delete_all_dead_sessions",
  "rename_session",
  "disconnect_other_clients",
  "kill_sessions",
  "scan_host_folder",
  "dump_session_layout",
  "close_self",
  "reconfigure",
  "hide_pane_with_id",
  "show_pane_with_id",
  "open_command_pane_background",
  "rerun_command_pane",
  "resize_pane_with_id",
  "edit_scrollback_for_pane_with_id",
  "write_to_pane_id",
  "write_chars_to_pane_id",
  "move_pane_with_pane_id",
  "move_pane_with_pane_id_in_direction",
  "clear_screen_for_pane_id",
  "scroll_up_in_pane_id",
  "scroll_down_in_pane_id",
  "scroll_to_top_in_pane_id",
  "scroll_to_bottom",
  "page_scroll_up_in_pane_id",
  "page_scroll_down_in_pane_id",
  "toggle_pane_id_fullscreen",
  "toggle_pane_embed_or_eject_for_pane_id",
  "close_tab_with_index",
  "break_panes_to_new_tab",
  "break_panes_to_tab_with_index",
  "reload_plugin",
  "load_new_plugin",
  "rebind_keys",
  "list_clients",
  "change_host_folder",
  "set_floating_pane_pinned",
  "stack_panes",
  "change_floating_panes_coordinates",
  "group_and_ungroup_panes",
  "highlight_and_unhighlight_panes",
  "close_multiple_panes",
  "float_multiple_panes",
  "embed_multiple_panes",
  "start_web_server",
  "stop_web_server",
  "share_current_session",
  "stop_sharing_current_session",
  "query_web_server_status",
  "generate_web_login_token",
  "revoke_web_login_token",
  "revoke_all_web_login_tokens",
  "list_web_login_tokens",
  "rename_web_login_token",
  "intercept_key_presses",
  "clear_key_presses_intercepts",
  "replace_pane_with_existing_pane",
] as const;

const PLUGIN_EVENTS = [
  "ModeUpdate",
  "TabUpdate",
  "PaneUpdate",
  "SessionUpdate",
  "Key",
  "Mouse",
  "Timer",
  "CopyToClipboard",
  "SystemClipboardFailure",
  "InputReceived",
  "Visible",
  "CustomMessage",
  "FileSystemCreate, FileSystemRead, FileSystemUpdate, FileSystemDelete",
  "RunCommandResult",
  "WebRequestResult",
  "CommandPaneOpened",
  "CommandPaneExited",
  "PaneClosed",
  "EditPaneOpened",
  "EditPaneExited",
  "CommandPaneReRun",
  "FailedToWriteConfigToDisk",
  "ListClients",
  "PastedText",
  "ConfigWasWrittenToDisk",
  "WebServerStatus",
  "FailedToStartWebServer",
  "BeforeClose",
  "InterceptedKeyPress",
] as const;

const CONFIG_OPTIONS = [
  "on_force_close",
  "simplified_ui",
  "default_shell",
  "pane_frames",
  "theme",
  "default_layout",
  "default_mode",
  "mouse_mode",
  "scroll_buffer_size",
  "copy_command",
  "copy_clipboard",
  "copy_on_select",
  "scrollback_editor",
  "mirror_session",
  "layout_dir",
  "theme_dir",
  "env",
  "rounded_corners",
  "hide_session_name",
  "auto_layout",
  "styled_underlines",
  "session_serialization",
  "pane_viewport_serialization",
  "scrollback_lines_to_serialize",
  "serialization_interval",
  "disable_session_metadata",
  "stacked_resize",
  "show_startup_tips",
  "show_release_notes",
  "post_command_discovery_hook",
  "web_server",
  "web_server_ip",
  "web_server_port",
  "web_server_cert",
  "web_server_key",
  "enforce_https_on_localhost",
  "web_client",
  "advanced_mouse_actions",
] as const;

const CLI_OPTIONS = [
  "        --attach-to-session <ATTACH_TO_SESSION>",
  "        --copy-clipboard <COPY_CLIPBOARD>",
  "        --copy-command <COPY_COMMAND>",
  "        --copy-on-select <COPY_ON_SELECT>",
  "        --default-layout <DEFAULT_LAYOUT>",
  "        --default-mode <DEFAULT_MODE>",
  "        --default-shell <DEFAULT_SHELL>",
  "        --disable-mouse-mode",
  "        --layout-dir <LAYOUT_DIR>",
  "        --mirror-session <MIRROR_SESSION>",
  "        --mouse-mode <MOUSE_MODE>",
  "        --no-pane-frames",
  "        --on-force-close <ON_FORCE_CLOSE>",
  "        --pane-frames <PANE_FRAMES>",
  "        --scroll-buffer-size <SCROLL_BUFFER_SIZE>",
  "        --scrollback-editor <SCROLLBACK_EDITOR>",
  "        --session-name <SESSION_NAME>",
  "        --simplified-ui <SIMPLIFIED_UI>",
  "        --theme <THEME>",
  "        --theme-dir <THEME_DIR>",
] as const;

const BUILT_IN_THEMES = [
  "ansi",
  "ao",
  "atelier-sulphurpool",
  "ayu_mirage",
  "ayu_dark",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cyber-noir",
  "blade-runner",
  "retro-wave",
  "dracula",
  "everforest-dark",
  "gruvbox-dark",
  "iceberg-dark",
  "kanagawa",
  "lucario",
  "menace",
  "molokai-dark",
  "night-owl",
  "nightfox",
  "nord",
  "one-half-dark",
  "onedark",
  "solarized-dark",
  "tokyo-night-dark",
  "tokyo-night-storm",
  "tokyo-night",
  "vesper",
  "ayu_light",
  "catppuccin-latte",
  "everforest-light",
  "gruvbox-light",
  "iceberg-light",
  "dayfox ",
  "pencil-light",
  "solarized-light",
  "tokyo-night-light",
] as const;

function chunk(items: readonly string[], size: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size).join(", "));
  }
  return rows;
}

function sectionList(
  title: string,
  items: readonly string[],
  size = 8
): string[] {
  return [`## ${title}`, ...chunk(items, size).map((row) => `- ${row}`), ""];
}

function buildGuide(): string {
  const lines: string[] = [];

  lines.push("# Zellij Assistant Reference (Condensed)");
  lines.push(`Generated from upstream docs on ${SOURCE_DATE}.`);
  lines.push(`Sources: ${SOURCE_REPOS.join("; ")}`);
  lines.push(`Note: ${SOURCE_SCOPE_NOTE}`);
  lines.push("");

  lines.push("## Config File Resolution");
  lines.push("Zellij resolves config in this precedence order:");
  lines.push("- --config-dir flag");
  lines.push("- ZELLIJ_CONFIG_DIR env var");
  lines.push("- $HOME/.config/zellij");
  lines.push("- platform default (macOS often uses ~/Library/Application Support/org.Zellij-Contributors.Zellij)");
  lines.push("- system location /etc/zellij");
  lines.push("Config file override:");
  lines.push("- zellij --config /path/to/config.kdl");
  lines.push("- ZELLIJ_CONFIG_FILE env var");
  lines.push("Useful discovery command:");
  lines.push("- zellij setup --check");
  lines.push("");

  lines.push("## Core CLI Model");
  lines.push("Main forms:");
  lines.push("- zellij [subcommand]");
  lines.push("- zellij action [action] [...args] (control current session)");
  lines.push("- zellij --session <name> action ... (control another session)");
  lines.push("- zellij run -- <command...> (new command pane)");
  lines.push("- zellij edit <file> (open file in editor pane)");
  lines.push("- zellij plugin -- <url> (load plugin)");
  lines.push("- zellij pipe [--name ...] -- <payload-or-stdin>");
  lines.push("");

  lines.push("## Session Commands");
  lines.push("Attach/list/kill lifecycle:");
  lines.push("- attach, list-sessions (ls), kill-sessions (k), kill-all-sessions (ka)");
  lines.push("- options (startup overrides), setup (config/layout/completion helpers)");
  lines.push("");

  lines.push("## Configuration Model");
  lines.push("Config language: KDL.");
  lines.push("Hot reload: running sessions watch active config file; many fields apply immediately.");
  lines.push("Important root blocks:");
  lines.push("- keybinds, themes, plugins, load_plugins, ui, env");
  lines.push("- top-level scalar options (see list below)");
  lines.push("");

  lines.push(...sectionList("Config Options (from docs/options.md)", CONFIG_OPTIONS, 7));

  lines.push("## CLI Startup Options (zellij options)");
  lines.push("These override config file values for that invocation:");
  lines.push(
    ...chunk(
      CLI_OPTIONS.map((option) => option.trim()),
      6
    ).map((row) => `- ${row}`)
  );
  lines.push("");

  lines.push("## Keybindings");
  lines.push("Keybinding structure:");
  lines.push("- keybinds { <mode> { bind \"Key\" { Action; ... } } }");
  lines.push("- shared/shared_except/shared_among apply cross-mode binds");
  lines.push("- unbind supports global or mode-specific unbinding");
  lines.push("- clear-defaults=true can reset all or one mode");
  lines.push("Modes:");
  lines.push(...chunk(KEYBIND_MODES, 8).map((row) => `- ${row}`));
  lines.push("Preset model:");
  lines.push("- default preset: direct mode access");
  lines.push("- unlock-first preset: reduced collisions; unlock then action");
  lines.push("");

  lines.push(...sectionList("Keybinding Actions", KEYBIND_ACTIONS, 8));

  lines.push("## Layouts (KDL)");
  lines.push("Core nodes:");
  lines.push("- layout (root)");
  lines.push("- pane (can be terminal, command, editor, plugin, or logical container)");
  lines.push("- tab (explicit tabs)");
  lines.push("- floating_panes (overlay panes with x/y/width/height)");
  lines.push("- pane_template / tab_template / default_tab_template / new_tab_template");
  lines.push("Common pane attrs:");
  lines.push("- split_direction, size, borderless, focus, name, cwd, command, args, close_on_exit, start_suspended, edit, plugin, stacked, expanded");
  lines.push("Swap layouts:");
  lines.push("- swap_tiled_layout and swap_floating_layout with min_panes/max_panes/exact_panes constraints");
  lines.push("- can be inline in layout.kdl or separate layout-name.swap.kdl");
  lines.push("CWD composition precedence for relative cwd:");
  lines.push("- pane -> tab -> global layout cwd -> shell cwd where command was run");
  lines.push("Security note:");
  lines.push("- remote layouts suspend commands behind an explicit run prompt");
  lines.push("");

  lines.push("## CLI Actions (zellij action ...)");
  lines.push("Canonical user-facing actions from docs:");
  lines.push(...chunk(CLI_ACTIONS, 7).map((row) => `- ${row}`));
  lines.push("");

  lines.push("## Plugin System");
  lines.push("Plugin URL schemes:");
  lines.push("- file:/absolute/path/plugin.wasm");
  lines.push("- zellij:<builtin>");
  lines.push("- http(s)://...");
  lines.push("- bare alias (from plugins {} config)");
  lines.push("Lifecycle:");
  lines.push("- load -> update(event) -> render(rows, cols)");
  lines.push("- update returns bool to request render");
  lines.push("Permissions are explicit and user-granted via request_permission.");
  lines.push(...chunk(PLUGIN_PERMISSIONS, 5).map((row) => `- ${row}`));
  lines.push("Pipes:");
  lines.push("- zellij pipe can target one plugin or broadcast");
  lines.push("- pipe source can be CLI, keybinding, or plugin");
  lines.push("- CLI pipes support backpressure via block/unblock commands");
  lines.push("");

  lines.push(...sectionList("Plugin Events", PLUGIN_EVENTS, 6));
  lines.push(...sectionList("Plugin API Commands", PLUGIN_API_COMMANDS, 6));

  lines.push("## Session Resurrection");
  lines.push("Defaults:");
  lines.push("- sessions serialize to cache and can be resurrected");
  lines.push("- resurrected commands are guarded behind Enter-to-run prompts");
  lines.push("Key options:");
  lines.push("- session_serialization");
  lines.push("- pane_viewport_serialization");
  lines.push("- scrollback_lines_to_serialize");
  lines.push("- serialization_interval");
  lines.push("- post_command_discovery_hook");
  lines.push("");

  lines.push("## Web Client");
  lines.push("Basics:");
  lines.push("- optional built-in web server (off by default)");
  lines.push("- start via share plugin or CLI (zellij web)");
  lines.push("- token-based login (token shown once, then hashed)");
  lines.push("- default URL http://127.0.0.1:8082");
  lines.push("Security:");
  lines.push("- HTTPS required when binding non-localhost interfaces");
  lines.push("- recommended: reverse proxy when Internet-exposed");
  lines.push("- authenticated users are treated as trusted local-user-equivalent");
  lines.push("");

  lines.push("## Themes");
  lines.push("Built-in theme names:");
  lines.push(
    ...chunk(
      BUILT_IN_THEMES.map((theme) => theme.trim()),
      8
    ).map((row) => `- ${row}`)
  );
  lines.push("Theme definitions are KDL and can be inline in config or loaded from theme_dir.");
  lines.push("");

  lines.push("## Compatibility Highlights");
  lines.push("Known practical issues:");
  lines.push("- missing glyphs/fonts -> use nerd fonts or simplified_ui");
  lines.push("- macOS Alt mapping depends on terminal emulator settings");
  lines.push("- OSC52 clipboard support varies by terminal; copy_command is fallback");
  lines.push("- mouse_mode can be temporarily bypassed by holding Shift");
  lines.push("- styled_underlines can cause color issues in some apps");
  lines.push("");

  lines.push("## Documentation Page Index (All Pages from zellij.dev/docs/src)");
  lines.push(...DOC_PAGE_INDEX.map((page) => `- ${page}`));
  lines.push("");

  return lines.join("\n");
}

export const ZELLIJ_KNOWLEDGE_GUIDE = buildGuide();

export function searchZellijKnowledge(query: string, maxSections = 6): string {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return "Provide a non-empty query.";
  }

  const boundedMaxSections = Math.max(1, Math.min(12, maxSections));

  const sectionChunks = ZELLIJ_KNOWLEDGE_GUIDE.split(/\n(?=## )/g);
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const scored = sectionChunks
    .map((section) => {
      const lower = section.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) {
          score += lower.startsWith(`## ${term}`) ? 6 : 2;
          score += lower.split(term).length - 1;
        }
      }
      if (lower.includes(normalized)) score += 4;
      return { section, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, boundedMaxSections)
    .map((item) => item.section.trim());

  if (scored.length === 0) {
    return [
      `No section match found for: ${query}`,
      "Call get_zellij_knowledge to inspect the full reference.",
    ].join("\n");
  }

  return scored.join("\n\n");
}
