# Zellij Assistant Reference (Condensed)
Generated from upstream docs on 2026-02-08.
Sources: zellij-org/zellij@97744ad0 (branch: main); zellij-org/zellij.dev@551eb88 (branch: main)
Note: Snapshot from upstream main branches; behavior may differ from your installed zellij version.

## Config File Resolution
Zellij resolves config in this precedence order:
- --config-dir flag
- ZELLIJ_CONFIG_DIR env var
- $HOME/.config/zellij
- platform default (macOS often uses ~/Library/Application Support/org.Zellij-Contributors.Zellij)
- system location /etc/zellij
Config file override:
- zellij --config /path/to/config.kdl
- ZELLIJ_CONFIG_FILE env var
Useful discovery command:
- zellij setup --check

## Core CLI Model
Main forms:
- zellij [subcommand]
- zellij action [action] [...args] (control current session)
- zellij --session <name> action ... (control another session)
- zellij run -- <command...> (new command pane)
- zellij edit <file> (open file in editor pane)
- zellij plugin -- <url> (load plugin)
- zellij pipe [--name ...] -- <payload-or-stdin>

## Session Commands
Attach/list/kill lifecycle:
- attach, list-sessions (ls), kill-sessions (k), kill-all-sessions (ka)
- options (startup overrides), setup (config/layout/completion helpers)

## Configuration Model
Config language: KDL.
Hot reload: running sessions watch active config file; many fields apply immediately.
Important root blocks:
- keybinds, themes, plugins, load_plugins, ui, env
- top-level scalar options (see list below)

## Config Options (from docs/options.md)
- on_force_close, simplified_ui, default_shell, pane_frames, theme, default_layout, default_mode
- mouse_mode, scroll_buffer_size, copy_command, copy_clipboard, copy_on_select, scrollback_editor, mirror_session
- layout_dir, theme_dir, env, rounded_corners, hide_session_name, auto_layout, styled_underlines
- session_serialization, pane_viewport_serialization, scrollback_lines_to_serialize, serialization_interval, disable_session_metadata, stacked_resize, show_startup_tips
- show_release_notes, post_command_discovery_hook, web_server, web_server_ip, web_server_port, web_server_cert, web_server_key
- enforce_https_on_localhost, web_client, advanced_mouse_actions

## CLI Startup Options (zellij options)
These override config file values for that invocation:
- --attach-to-session <ATTACH_TO_SESSION>, --copy-clipboard <COPY_CLIPBOARD>, --copy-command <COPY_COMMAND>, --copy-on-select <COPY_ON_SELECT>, --default-layout <DEFAULT_LAYOUT>, --default-mode <DEFAULT_MODE>
- --default-shell <DEFAULT_SHELL>, --disable-mouse-mode, --layout-dir <LAYOUT_DIR>, --mirror-session <MIRROR_SESSION>, --mouse-mode <MOUSE_MODE>, --no-pane-frames
- --on-force-close <ON_FORCE_CLOSE>, --pane-frames <PANE_FRAMES>, --scroll-buffer-size <SCROLL_BUFFER_SIZE>, --scrollback-editor <SCROLLBACK_EDITOR>, --session-name <SESSION_NAME>, --simplified-ui <SIMPLIFIED_UI>
- --theme <THEME>, --theme-dir <THEME_DIR>

## Keybindings
Keybinding structure:
- keybinds { <mode> { bind "Key" { Action; ... } } }
- shared/shared_except/shared_among apply cross-mode binds
- unbind supports global or mode-specific unbinding
- clear-defaults=true can reset all or one mode
Modes:
- normal, locked, resize, pane, move, tab, scroll, search
- entersearch, renametab, renamepane, session, tmux
Preset model:
- default preset: direct mode access
- unlock-first preset: reduced collisions; unlock then action

## Keybinding Actions
- Clear, CloseFocus, CloseTab, Detach, DumpScreen, EditScrollback, FocusNextPane, FocusPreviousPane
- GoToNextTab, GoToPreviousTab, GoToTab, HalfPageScrollDown, HalfPageScrollUp, LaunchOrFocusPlugin, MessagePlugin, MoveFocus
- MoveFocusOrTab, MovePane, MoveTab, NextSwapLayout, NewPane, NewTab, PageScrollDown, PageScrollUp
- PreviousSwapLayout, Quit, Resize, Run, ScrollDown, ScrollToBottom, ScrollUp, ScrollToTop
- Search, SearchToggleOption, SwitchToMode, ToggleActiveSyncTab, ToggleFloatingPanes, ToggleFocusFullscreen, ToggleMouseMode, TogglePaneEmbedOrFloating
- TogglePaneFrames, ToggleTab, UndoRenamePane, UndoRenameTab, Write, WriteChars

## Layouts (KDL)
Core nodes:
- layout (root)
- pane (can be terminal, command, editor, plugin, or logical container)
- tab (explicit tabs)
- floating_panes (overlay panes with x/y/width/height)
- pane_template / tab_template / default_tab_template / new_tab_template
Common pane attrs:
- split_direction, size, borderless, focus, name, cwd, command, args, close_on_exit, start_suspended, edit, plugin, stacked, expanded
Swap layouts:
- swap_tiled_layout and swap_floating_layout with min_panes/max_panes/exact_panes constraints
- can be inline in layout.kdl or separate layout-name.swap.kdl
CWD composition precedence for relative cwd:
- pane -> tab -> global layout cwd -> shell cwd where command was run
Security note:
- remote layouts suspend commands behind an explicit run prompt

## CLI Actions (zellij action ...)
Canonical user-facing actions from docs:
- close-pane, close-tab, dump-screen, edit, dump-layout, edit-scrollback, focus-next-pane
- focus-previous-pane, go-to-next-tab, go-to-previous-tab, go-to-tab, go-to-tab-name, half-page-scroll-down, half-page-scroll-up
- launch-or-focus-plugin, list-clients, move-focus, move-focus-or-tab, move-pane, new-pane, new-tab
- page-scroll-down, page-scroll-up, rename-pane, rename-tab, resize, scroll-down, scroll-to-bottom
- scroll-up, start-or-reload-plugin, switch-mode, toggle-active-sync-tab, toggle-floating-panes, toggle-fullscreen, toggle-pane-embed-or-floating
- toggle-pane-frames, undo-rename-pane, undo-rename-tab, query-tab-names, write, write-chars, toggle-pane-pinned
- stack-panes, change-floating-pane-coordinates

## Plugin System
Plugin URL schemes:
- file:/absolute/path/plugin.wasm
- zellij:<builtin>
- http(s)://...
- bare alias (from plugins {} config)
Lifecycle:
- load -> update(event) -> render(rows, cols)
- update returns bool to request render
Permissions are explicit and user-granted via request_permission.
- ReadApplicationState, ChangeApplicationState, OpenFiles, RunCommand, OpenTerminalsOrPlugins
- WriteToStdin, Reconfigure, FullHdAccess, StartWebServer, InterceptInput
Pipes:
- zellij pipe can target one plugin or broadcast
- pipe source can be CLI, keybinding, or plugin
- CLI pipes support backpressure via block/unblock commands

## Plugin Events
- ModeUpdate, TabUpdate, PaneUpdate, SessionUpdate, Key, Mouse
- Timer, CopyToClipboard, SystemClipboardFailure, InputReceived, Visible, CustomMessage
- FileSystemCreate, FileSystemRead, FileSystemUpdate, FileSystemDelete, RunCommandResult, WebRequestResult, CommandPaneOpened, CommandPaneExited, PaneClosed
- EditPaneOpened, EditPaneExited, CommandPaneReRun, FailedToWriteConfigToDisk, ListClients, PastedText
- ConfigWasWrittenToDisk, WebServerStatus, FailedToStartWebServer, BeforeClose, InterceptedKeyPress

## Plugin API Commands
- subscribe, unsubscribe, request_permission, set_selectable, get_plugin_ids, get_zellij_version
- open_file, open_file_floating, open_file_in_place, open_file_with_line, open_file_with_line_floating, open_file_near_plugin
- open_file_floating_near_plugin, open_file_in_place_of_plugin, open_terminal, open_terminal_floating, open_terminal_in_place, open_terminal_near_plugin
- open_terminal_floating_near_plugin, open_terminal_in_place_of_plugin, open_command_pane, open_command_pane_floating, open_command_pane_in_place, open_command_pane_near_plugin
- open_command_pane_floating_near_plugin, open_command_pane_in_place_of_plugin, run_command, web_request, switch_tab_to, set_timeout
- hide_self, show_self, switch_to_input_mode, new_tabs_with_layout, new_tabs_with_layout_info, new_tab
- go_to_next_tab, go_to_previous_tab, resize_focused_pane, resize_focused_pane_with_direction, focus_next_pane, focus_previous_pane
- move_focus, move_focus_or_tab, detach, edit_scrollback, write, write_chars
- toggle_tab, move_pane, move_pane_with_direction, clear_screen, scroll_up, scroll_down
- scroll_to_top, scroll_to_bottom, page_scroll_up, page_scroll_down, toggle_focus_fullscreen, toggle_pane_frames
- toggle_pane_embed_or_eject, close_focus, toggle_active_tab_sync, close_focused_tab, quit_zellij, previous_swap_layout
- next_swap_layout, go_to_tab_name, focus_or_create_tab, post_message_to, post_message_to_plugin, close_terminal_pane
- close_plugin_pane, focus_terminal_pane, focus_plugin_pane, rename_terminal_pane, rename_plugin_pane, rename_tab
- switch_session, switch_session_with_focus, switch_session_with_layout, block_cli_pipe_input, unblock_cli_pipe_input, cli_pipe_output
- pipe_message_to_plugin, delete_dead_session, delete_all_dead_sessions, rename_session, disconnect_other_clients, kill_sessions
- scan_host_folder, dump_session_layout, close_self, reconfigure, hide_pane_with_id, show_pane_with_id
- open_command_pane_background, rerun_command_pane, resize_pane_with_id, edit_scrollback_for_pane_with_id, write_to_pane_id, write_chars_to_pane_id
- move_pane_with_pane_id, move_pane_with_pane_id_in_direction, clear_screen_for_pane_id, scroll_up_in_pane_id, scroll_down_in_pane_id, scroll_to_top_in_pane_id
- scroll_to_bottom, page_scroll_up_in_pane_id, page_scroll_down_in_pane_id, toggle_pane_id_fullscreen, toggle_pane_embed_or_eject_for_pane_id, close_tab_with_index
- break_panes_to_new_tab, break_panes_to_tab_with_index, reload_plugin, load_new_plugin, rebind_keys, list_clients
- change_host_folder, set_floating_pane_pinned, stack_panes, change_floating_panes_coordinates, group_and_ungroup_panes, highlight_and_unhighlight_panes
- close_multiple_panes, float_multiple_panes, embed_multiple_panes, start_web_server, stop_web_server, share_current_session
- stop_sharing_current_session, query_web_server_status, generate_web_login_token, revoke_web_login_token, revoke_all_web_login_tokens, list_web_login_tokens
- rename_web_login_token, intercept_key_presses, clear_key_presses_intercepts, replace_pane_with_existing_pane

## Session Resurrection
Defaults:
- sessions serialize to cache and can be resurrected
- resurrected commands are guarded behind Enter-to-run prompts
Key options:
- session_serialization
- pane_viewport_serialization
- scrollback_lines_to_serialize
- serialization_interval
- post_command_discovery_hook

## Web Client
Basics:
- optional built-in web server (off by default)
- start via share plugin or CLI (zellij web)
- token-based login (token shown once, then hashed)
- default URL http://127.0.0.1:8082
Security:
- HTTPS required when binding non-localhost interfaces
- recommended: reverse proxy when Internet-exposed
- authenticated users are treated as trusted local-user-equivalent

## Themes
Built-in theme names:
- ansi, ao, atelier-sulphurpool, ayu_mirage, ayu_dark, catppuccin-frappe, catppuccin-macchiato, cyber-noir
- blade-runner, retro-wave, dracula, everforest-dark, gruvbox-dark, iceberg-dark, kanagawa, lucario
- menace, molokai-dark, night-owl, nightfox, nord, one-half-dark, onedark, solarized-dark
- tokyo-night-dark, tokyo-night-storm, tokyo-night, vesper, ayu_light, catppuccin-latte, everforest-light, gruvbox-light
- iceberg-light, dayfox, pencil-light, solarized-light, tokyo-night-light
Theme definitions are KDL and can be inline in config or loaded from theme_dir.

## Compatibility Highlights
Known practical issues:
- missing glyphs/fonts -> use nerd fonts or simplified_ui
- macOS Alt mapping depends on terminal emulator settings
- OSC52 clipboard support varies by terminal; copy_command is fallback
- mouse_mode can be temporarily bypassed by holding Shift
- styled_underlines can cause color issues in some apps

## Documentation Page Index (All Pages from zellij.dev/docs/src)
- SUMMARY.md
- changing-modifiers.md
- cli-actions.md
- cli-commands.md
- cli-plugins.md
- command-line-options.md
- commands.md
- compact-bar-alias.md
- compatibility.md
- configuration-options.md
- configuration.md
- controlling-zellij-through-cli.md
- creating-a-layout.md
- faq.md
- filepicker-alias.md
- installation.md
- integration.md
- introduction.md
- keybinding-presets.md
- keybindings-binding.md
- keybindings-examples.md
- keybindings-keys.md
- keybindings-modes.md
- keybindings-overriding.md
- keybindings-possible-actions.md
- keybindings-shared.md
- keybindings.md
- layout-examples.md
- layouts-templates.md
- layouts-with-config.md
- layouts.md
- legacy-themes.md
- migrating-yaml-config.md
- migrating-yaml-layouts.md
- options.md
- overview.md
- plugin-aliases.md
- plugin-api-commands.md
- plugin-api-configuration.md
- plugin-api-events.md
- plugin-api-file-system.md
- plugin-api-logging.md
- plugin-api-permissions.md
- plugin-api-workers.md
- plugin-api.md
- plugin-dev-env.md
- plugin-development.md
- plugin-examples.md
- plugin-lifecycle.md
- plugin-loading.md
- plugin-other-languages.md
- plugin-other.md
- plugin-overview
- plugin-overview.md
- plugin-pipes.md
- plugin-rust.md
- plugin-system-status.md
- plugin-ui-rendering.md
- plugin-upgrade-0.38.0.md
- plugin-upgrading.md
- plugin-writing.md
- plugin-zig.md
- plugins.md
- rebinding-keys.md
- session-manager-alias.md
- session-resurrection.md
- status-bar-alias.md
- strider-alias.md
- swap-layouts.md
- tab-bar-alias.md
- theme-gallery.md
- theme-list.md
- themes.md
- web-client.md
- welcome-screen-alias.md
- zellij-edit.md
- zellij-pipe.md
- zellij-plugin.md
- zellij-run.md
