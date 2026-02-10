use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};
use zellij_tile::prelude::*;

const PANE_NAME: &str = "Jelly J";
const COMMAND: &str = "jelly-j";
const TRACE_LIMIT: usize = 200;
const TOGGLE_DEDUP_WINDOW_MS: u128 = 100;

#[derive(Default)]
struct State {
    panes: Option<PaneManifest>,
    tabs: Option<Vec<TabInfo>>,
    ready: bool,
    permission_result_seen: bool,
    permission_denied: bool,
    pending_toggle: bool,
    awaiting_pane: bool,
    awaiting_tab: Option<usize>,
    awaiting_updates: u16,
    awaiting_write_to_new_pane: bool,
    known_terminal_ids: HashSet<u32>,
    relocating_pane_id: Option<u32>,
    relocating_target_tab: Option<usize>,
    relocating_waiting_for_suppressed: bool,
    relocating_updates: u16,
    launch_command: Option<String>,
    pane_update_count: u64,
    tab_update_count: u64,
    seen_pane_update: bool,
    seen_tab_update: bool,
    last_cli_toggle_pipe_id: Option<String>,
    trace_seq: u64,
    trace: VecDeque<String>,
    last_toggle_epoch_ms: Option<u128>,
    trace_start_epoch_ms: Option<u128>,
    sticky_jelly_pane_id: Option<u32>,
    sticky_reveal_attempts: u8,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum ButlerRequest {
    Ping,
    GetState,
    GetTrace {
        limit: Option<usize>,
    },
    ClearTrace,
    RenameTab {
        position: usize,
        name: String,
    },
    RenamePane {
        pane_id: u32,
        name: String,
    },
    HidePane {
        pane_id: u32,
    },
    ShowPane {
        pane_id: u32,
        should_float_if_hidden: Option<bool>,
        should_focus_pane: Option<bool>,
    },
}

#[derive(Serialize)]
struct ButlerTabState {
    position: usize,
    name: String,
    active: bool,
    selectable_tiled_panes_count: usize,
    selectable_floating_panes_count: usize,
}

#[derive(Serialize)]
struct ButlerPaneState {
    id: u32,
    tab_index: usize,
    title: String,
    terminal_command: Option<String>,
    is_plugin: bool,
    is_focused: bool,
    is_floating: bool,
    is_suppressed: bool,
    exited: bool,
}

#[derive(Serialize)]
struct ButlerWorkspaceState {
    tabs: Vec<ButlerTabState>,
    panes: Vec<ButlerPaneState>,
    butler: ButlerRuntimeState,
}

#[derive(Serialize)]
struct ButlerRuntimeState {
    ready: bool,
    permission_result_seen: bool,
    permission_denied: bool,
    pending_toggle: bool,
    awaiting_pane: bool,
    awaiting_tab: Option<usize>,
    awaiting_updates: u16,
    awaiting_write_to_new_pane: bool,
    known_terminal_ids: usize,
    relocating_pane_id: Option<u32>,
    relocating_target_tab: Option<usize>,
    relocating_waiting_for_suppressed: bool,
    relocating_updates: u16,
    pane_update_count: u64,
    tab_update_count: u64,
    trace_len: usize,
    last_cli_toggle_pipe_id: Option<String>,
    launch_command: String,
}

register_plugin!(State);

impl ZellijPlugin for State {
    fn load(&mut self, configuration: BTreeMap<String, String>) {
        if let Some(launch_command) = configuration.get("launch_command").map(|s| s.trim()) {
            if !launch_command.is_empty() {
                self.launch_command = Some(launch_command.to_owned());
            }
        }
        self.push_trace(format!("load launch_command={}", self.launch_command()));

        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::PermissionRequestResult,
        ]);
        self.push_trace("subscribed to PaneUpdate/TabUpdate/PermissionRequestResult");
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::OpenTerminalsOrPlugins,
            PermissionType::WriteToStdin,
            PermissionType::ReadCliPipes,
        ]);
        self.push_trace("requested permissions");
        request_plugin_state_snapshot();
        self.push_trace("requested initial plugin state snapshot");
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PermissionRequestResult(PermissionStatus::Granted) => {
                self.permission_result_seen = true;
                self.permission_denied = false;
                self.ready = true;
                self.push_trace("permission granted");
                request_plugin_state_snapshot();
                self.push_trace("requested plugin state snapshot after permission grant");
                self.try_run_toggle();
            }
            Event::PermissionRequestResult(PermissionStatus::Denied) => {
                self.permission_result_seen = true;
                self.permission_denied = true;
                self.ready = false;
                self.push_trace("permission denied");
            }
            Event::PaneUpdate(manifest) => {
                self.pane_update_count = self.pane_update_count.saturating_add(1);
                if !self.seen_pane_update {
                    self.seen_pane_update = true;
                    self.push_trace("first PaneUpdate received");
                }
                self.panes = Some(manifest);
                if let Some((_, pane)) = self.all_jelly_panes().first() {
                    self.sticky_jelly_pane_id = Some(pane.id);
                    self.sticky_reveal_attempts = 0;
                }
                self.infer_cached_permission_grant();
                if self.awaiting_pane {
                    self.bind_new_jelly_pane();
                } else if self.relocating_pane_id.is_some() {
                    self.continue_relocation();
                }
                self.try_run_toggle();
            }
            Event::TabUpdate(tab_infos) => {
                self.tab_update_count = self.tab_update_count.saturating_add(1);
                if !self.seen_tab_update {
                    self.seen_tab_update = true;
                    self.push_trace("first TabUpdate received");
                }
                self.tabs = Some(tab_infos);
                self.infer_cached_permission_grant();
                self.try_run_toggle();
            }
            _ => {}
        }
        true
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        match pipe_message.name.as_str() {
            "toggle" => {
                let source = pipe_message.source;
                let now_epoch_ms = Self::now_epoch_millis();
                if self.toggle_within_dedup_window(now_epoch_ms) {
                    self.push_trace(format!(
                        "pipe toggle dedup_window_ignored source={:?}",
                        source
                    ));
                    Self::respond_to_cli(
                        &source,
                        Some(Self::ok_response(json!({ "ok": true, "dedup_window": true }))),
                    );
                    return false;
                }
                if let PipeSource::Cli(pipe_id) = &source {
                    if self.last_cli_toggle_pipe_id.as_deref() == Some(pipe_id.as_str()) {
                        self.push_trace(format!(
                            "pipe toggle duplicate_ignored source={:?}",
                            source
                        ));
                        Self::respond_to_cli(
                            &source,
                            Some(Self::ok_response(json!({ "ok": true, "duplicate": true }))),
                        );
                        return false;
                    }
                    self.last_cli_toggle_pipe_id = Some(pipe_id.clone());
                }
                self.push_trace(format!("pipe toggle source={:?}", source));
                self.pending_toggle = true;
                self.try_run_toggle();
                if let PipeSource::Cli(_) = source {
                    Self::respond_to_cli(&source, Some(Self::ok_response(json!({ "ok": true }))));
                }
            }
            "request" => {
                self.push_trace("pipe request");
                self.handle_request_pipe(pipe_message);
            }
            _ => {}
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        hide_self();
    }
}

impl State {
    fn now_epoch_millis() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    }

    fn toggle_within_dedup_window(&mut self, now_epoch_ms: u128) -> bool {
        if let Some(last_epoch_ms) = self.last_toggle_epoch_ms {
            if now_epoch_ms.saturating_sub(last_epoch_ms) <= TOGGLE_DEDUP_WINDOW_MS {
                return true;
            }
        }
        self.last_toggle_epoch_ms = Some(now_epoch_ms);
        false
    }

    fn infer_cached_permission_grant(&mut self) {
        if self.ready
            || self.permission_result_seen
            || self.permission_denied
            || self.panes.is_none()
        {
            return;
        }
        self.ready = true;
        self.push_trace("permission inferred via cached grant (no result event)");
    }

    fn launch_command(&self) -> &str {
        self.launch_command.as_deref().unwrap_or(COMMAND)
    }

    fn push_trace(&mut self, message: impl Into<String>) {
        let now_ms = Self::now_epoch_millis();
        let start_ms = self.trace_start_epoch_ms.get_or_insert(now_ms);
        let delta_ms = now_ms.saturating_sub(*start_ms);
        self.trace_seq = self.trace_seq.saturating_add(1);
        if self.trace.len() >= TRACE_LIMIT {
            self.trace.pop_front();
        }
        self.trace.push_back(format!(
            "{:04} +{}ms {}",
            self.trace_seq,
            delta_ms,
            message.into()
        ));
    }

    fn trace_snapshot(&self, limit: Option<usize>) -> Vec<String> {
        let wanted = limit.unwrap_or(self.trace.len()).min(self.trace.len());
        self.trace
            .iter()
            .skip(self.trace.len().saturating_sub(wanted))
            .cloned()
            .collect()
    }

    fn ok_response(result: Value) -> Value {
        json!({
            "ok": true,
            "result": result,
        })
    }

    fn error_response(code: &str, message: impl Into<String>) -> Value {
        json!({
            "ok": false,
            "code": code,
            "error": message.into(),
        })
    }

    fn respond_to_cli(source: &PipeSource, response: Option<Value>) {
        if let PipeSource::Cli(pipe_id) = source {
            if let Some(response) = response {
                cli_pipe_output(pipe_id, &response.to_string());
            }
            unblock_cli_pipe_input(pipe_id);
        }
    }

    fn handle_request_pipe(&mut self, pipe_message: PipeMessage) {
        let source = pipe_message.source;
        let Some(payload) = pipe_message.payload else {
            Self::respond_to_cli(
                &source,
                Some(Self::error_response(
                    "invalid_request",
                    "missing request payload",
                )),
            );
            return;
        };

        let parsed = serde_json::from_str::<ButlerRequest>(&payload);
        let response = match parsed {
            Ok(request) => self.execute_request(request),
            Err(err) => Self::error_response(
                "invalid_request",
                format!("failed to parse request JSON: {}", err),
            ),
        };

        Self::respond_to_cli(&source, Some(response));
    }

    fn execute_request(&mut self, request: ButlerRequest) -> Value {
        match request {
            ButlerRequest::Ping => Self::ok_response(json!({ "ok": true })),
            ButlerRequest::GetState => {
                if !self.ready {
                    return Self::error_response("not_ready", "butler permissions not granted yet");
                }
                let Some(state) = self.workspace_state_snapshot() else {
                    request_plugin_state_snapshot();
                    return Self::error_response(
                        "not_ready",
                        "workspace cache is not ready yet (waiting for PaneUpdate)",
                    );
                };
                Self::ok_response(serde_json::to_value(state).unwrap_or_else(|_| json!({})))
            }
            ButlerRequest::GetTrace { limit } => {
                let entries = self.trace_snapshot(limit);
                Self::ok_response(json!({ "entries": entries }))
            }
            ButlerRequest::ClearTrace => {
                self.trace.clear();
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::RenameTab { position, name } => {
                if !self.ready {
                    return Self::error_response("not_ready", "butler permissions not granted yet");
                }
                self.push_trace(format!("rename_tab position={} name={}", position, name));
                rename_tab(position as u32, name);
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::RenamePane { pane_id, name } => {
                if !self.ready {
                    return Self::error_response("not_ready", "butler permissions not granted yet");
                }
                self.push_trace(format!("rename_pane pane_id={} name={}", pane_id, name));
                rename_pane_with_id(PaneId::Terminal(pane_id), name);
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::HidePane { pane_id } => {
                if !self.ready {
                    return Self::error_response("not_ready", "butler permissions not granted yet");
                }
                self.push_trace(format!("hide_pane pane_id={}", pane_id));
                hide_pane_with_id(PaneId::Terminal(pane_id));
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::ShowPane {
                pane_id,
                should_float_if_hidden,
                should_focus_pane,
            } => {
                if !self.ready {
                    return Self::error_response("not_ready", "butler permissions not granted yet");
                }
                self.push_trace(format!(
                    "show_pane pane_id={} float_if_hidden={} focus={}",
                    pane_id,
                    should_float_if_hidden.unwrap_or(true),
                    should_focus_pane.unwrap_or(true)
                ));
                show_pane_with_id(
                    PaneId::Terminal(pane_id),
                    should_float_if_hidden.unwrap_or(true),
                    should_focus_pane.unwrap_or(true),
                );
                Self::ok_response(json!({ "ok": true }))
            }
        }
    }

    fn workspace_state_snapshot(&self) -> Option<ButlerWorkspaceState> {
        let tabs = self
            .tabs
            .as_ref()
            .map(|tabs| {
                tabs.iter()
                    .map(|tab| ButlerTabState {
                        position: tab.position,
                        name: tab.name.clone(),
                        active: tab.active,
                        selectable_tiled_panes_count: tab.selectable_tiled_panes_count,
                        selectable_floating_panes_count: tab.selectable_floating_panes_count,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let panes = self
            .panes
            .as_ref()?
            .panes
            .iter()
            .flat_map(|(tab_index, pane_infos)| {
                pane_infos.iter().map(|pane| ButlerPaneState {
                    id: pane.id,
                    tab_index: *tab_index,
                    title: pane.title.clone(),
                    terminal_command: pane.terminal_command.clone(),
                    is_plugin: pane.is_plugin,
                    is_focused: pane.is_focused,
                    is_floating: pane.is_floating,
                    is_suppressed: pane.is_suppressed,
                    exited: pane.exited,
                })
            })
            .collect::<Vec<_>>();

        let butler = ButlerRuntimeState {
            ready: self.ready,
            permission_result_seen: self.permission_result_seen,
            permission_denied: self.permission_denied,
            pending_toggle: self.pending_toggle,
            awaiting_pane: self.awaiting_pane,
            awaiting_tab: self.awaiting_tab,
            awaiting_updates: self.awaiting_updates,
            awaiting_write_to_new_pane: self.awaiting_write_to_new_pane,
            known_terminal_ids: self.known_terminal_ids.len(),
            relocating_pane_id: self.relocating_pane_id,
            relocating_target_tab: self.relocating_target_tab,
            relocating_waiting_for_suppressed: self.relocating_waiting_for_suppressed,
            relocating_updates: self.relocating_updates,
            pane_update_count: self.pane_update_count,
            tab_update_count: self.tab_update_count,
            trace_len: self.trace.len(),
            last_cli_toggle_pipe_id: self.last_cli_toggle_pipe_id.clone(),
            launch_command: self.launch_command().to_owned(),
        };

        Some(ButlerWorkspaceState {
            tabs,
            panes,
            butler,
        })
    }

    fn try_run_toggle(&mut self) {
        if !self.pending_toggle
            || !self.ready
            || self.panes.is_none()
            || self.awaiting_pane
            || self.relocating_pane_id.is_some()
        {
            return;
        }

        self.pending_toggle = false;
        self.launch_or_toggle();
    }

    fn is_jelly_pane(&self, p: &PaneInfo) -> bool {
        let launch_command = self.launch_command();
        !p.exited
            && !p.is_plugin
            && (p.title == PANE_NAME
                || p.terminal_command
                    .as_deref()
                    .map_or(false, |c| c.contains(launch_command)))
    }

    fn active_tab_index(&self) -> Option<usize> {
        let manifest = self.panes.as_ref()?;
        if let Some((tab_index, _)) = manifest.panes.iter().find(|(_, panes)| {
            panes
                .iter()
                .any(|pane| pane.is_focused && !pane.exited && !pane.is_plugin && !self.is_jelly_pane(pane))
        }) {
            return Some(*tab_index);
        }
        if let Some((tab_index, _)) = manifest.panes.iter().find(|(_, panes)| {
            panes
                .iter()
                .any(|pane| pane.is_focused && !pane.exited && !pane.is_plugin)
        }) {
            return Some(*tab_index);
        }

        if let Some(tabs) = self.tabs.as_ref() {
            if let Some(tab) = tabs.iter().find(|tab| tab.active) {
                return Some(tab.position);
            }
        }

        manifest.panes.keys().min().copied()
    }

    fn focused_visible_jelly_pane(&self) -> Option<(usize, PaneInfo)> {
        self.panes
            .as_ref()?
            .panes
            .iter()
            .find_map(|(tab_index, panes)| {
                panes
                    .iter()
                    .find(|pane| {
                        self.is_jelly_pane(pane) && pane.is_focused && !pane.is_suppressed
                    })
                    .cloned()
                    .map(|pane| (*tab_index, pane))
            })
    }

    fn all_jelly_panes(&self) -> Vec<(usize, PaneInfo)> {
        self.panes
            .as_ref()
            .map(|m| {
                m.panes
                    .iter()
                    .flat_map(|(tab_index, panes)| {
                        panes.iter().filter_map(|p| {
                            if self.is_jelly_pane(p) {
                                Some((*tab_index, p.clone()))
                            } else {
                                None
                            }
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    fn reset_awaiting(&mut self) {
        self.awaiting_pane = false;
        self.awaiting_tab = None;
        self.awaiting_updates = 0;
        self.awaiting_write_to_new_pane = false;
        self.known_terminal_ids.clear();
    }

    fn reset_relocation(&mut self) {
        self.relocating_pane_id = None;
        self.relocating_target_tab = None;
        self.relocating_waiting_for_suppressed = false;
        self.relocating_updates = 0;
    }

    fn complete_cycle(&mut self) {
        self.push_trace("complete_cycle");
        self.reset_awaiting();
        self.reset_relocation();
        self.try_run_toggle();
    }

    fn find_pane_by_id(&self, pane_id: u32) -> Option<(usize, PaneInfo)> {
        self.panes
            .as_ref()?
            .panes
            .iter()
            .find_map(|(tab_index, panes)| {
                panes
                    .iter()
                    .find(|p| p.id == pane_id && !p.exited && !p.is_plugin)
                    .cloned()
                    .map(|pane| (*tab_index, pane))
            })
    }

    fn continue_relocation(&mut self) {
        let Some(pane_id) = self.relocating_pane_id else {
            return;
        };
        let Some(target_tab) = self.relocating_target_tab else {
            self.complete_cycle();
            return;
        };

        let Some((current_tab, pane)) = self.find_pane_by_id(pane_id) else {
            self.relocating_updates = self.relocating_updates.saturating_add(1);
            if self.relocating_updates % 100 == 0 {
                self.push_trace(format!(
                    "relocating_waiting_for_pane id={} updates={}",
                    pane_id, self.relocating_updates
                ));
            }
            if self.relocating_updates > 1200 {
                self.complete_cycle();
            }
            return;
        };

        if current_tab != target_tab {
            self.relocating_updates = self.relocating_updates.saturating_add(1);
            if self.relocating_updates % 100 == 0 {
                self.push_trace(format!(
                    "relocating_waiting_for_target_tab id={} current={} target={} updates={}",
                    pane_id, current_tab, target_tab, self.relocating_updates
                ));
            }
            if self.relocating_updates > 1200 {
                self.complete_cycle();
            }
            return;
        }

        let pane_ref = PaneId::Terminal(pane_id);
        if self.relocating_waiting_for_suppressed {
            if pane.is_suppressed {
                show_pane_with_id(pane_ref, true, true);
                self.complete_cycle();
            } else {
                self.relocating_updates = self.relocating_updates.saturating_add(1);
                if self.relocating_updates % 30 == 0 {
                    hide_pane_with_id(pane_ref);
                }
                if self.relocating_updates > 1200 {
                    self.complete_cycle();
                }
            }
            return;
        }

        if pane.is_suppressed {
            show_pane_with_id(pane_ref, true, true);
            self.complete_cycle();
        } else if pane.is_floating {
            show_pane_with_id(pane_ref, true, true);
            self.complete_cycle();
        } else {
            // Pane arrived tiled. Suppress first, then restore as floating.
            hide_pane_with_id(pane_ref);
            self.relocating_waiting_for_suppressed = true;
            self.relocating_updates = 0;
        }
    }

    fn launch_or_toggle(&mut self) {
        if let Some((tab_index, focused_jelly)) = self.focused_visible_jelly_pane() {
            self.push_trace(format!(
                "focused_jelly_fast_hide id={} tab={}",
                focused_jelly.id, tab_index
            ));
            self.sticky_jelly_pane_id = Some(focused_jelly.id);
            self.sticky_reveal_attempts = 0;
            hide_pane_with_id(PaneId::Terminal(focused_jelly.id));
            self.complete_cycle();
            return;
        }

        let current_tab = self.active_tab_index().unwrap_or(0);
        self.push_trace(format!("launch_or_toggle current_tab={}", current_tab));

        let mut jelly_panes = self.all_jelly_panes();
        if !jelly_panes.is_empty() {
            self.push_trace(format!(
                "found_existing_jelly_panes count={}",
                jelly_panes.len()
            ));
            // Keep exactly one Jelly J pane per session to prevent pane/process buildup.
            let keep_idx = jelly_panes
                .iter()
                .position(|(tab, _)| *tab == current_tab)
                .or_else(|| jelly_panes.iter().position(|(_, pane)| pane.is_focused))
                .unwrap_or(0);
            let (_, keep_pane) = jelly_panes.remove(keep_idx);
            self.sticky_jelly_pane_id = Some(keep_pane.id);
            self.sticky_reveal_attempts = 0;
            for (_, extra_pane) in jelly_panes {
                self.push_trace(format!("closing_extra_jelly_pane id={}", extra_pane.id));
                close_terminal_pane(extra_pane.id);
            }

            let pane_id = PaneId::Terminal(keep_pane.id);
            if keep_pane.is_suppressed {
                // Keep toggles responsive: request move + show immediately, no update-loop waiting.
                self.push_trace(format!(
                    "showing_jelly_pane id={} move_to_tab={}",
                    keep_pane.id, current_tab
                ));
                break_panes_to_tab_with_index(&[pane_id], current_tab, false);
                show_pane_with_id(pane_id, true, true);
            } else {
                self.push_trace(format!("hiding_jelly_pane id={}", keep_pane.id));
                hide_pane_with_id(pane_id);
            }
            self.complete_cycle();
        } else {
            if let Some(sticky_pane_id) = self.sticky_jelly_pane_id {
                if self.sticky_reveal_attempts < 2 {
                    self.sticky_reveal_attempts = self.sticky_reveal_attempts.saturating_add(1);
                    self.push_trace(format!(
                        "revealing_sticky_jelly_pane id={} attempt={}",
                        sticky_pane_id, self.sticky_reveal_attempts
                    ));
                    show_pane_with_id(PaneId::Terminal(sticky_pane_id), true, true);
                    self.complete_cycle();
                    return;
                }
                self.push_trace(format!(
                    "sticky_jelly_reveal_exhausted id={} attempts={}",
                    sticky_pane_id, self.sticky_reveal_attempts
                ));
            }
            // Atomic host API: launch + optional stdin write in a single command.
            self.push_trace(format!(
                "launching_new_jelly_terminal atomically command={}",
                self.launch_command()
            ));
            match launch_terminal_pane(
                Some(FileToOpen::new(".")),
                Some(PANE_NAME.to_owned()),
                Some(format!("{}\n", self.launch_command())),
                None,
                false,
                true,
                false,
            ) {
                Ok(PaneId::Terminal(pane_id)) => {
                    self.push_trace(format!("launched_new_jelly_terminal pane_id={}", pane_id));
                    self.sticky_jelly_pane_id = Some(pane_id);
                    self.sticky_reveal_attempts = 0;
                    show_pane_with_id(PaneId::Terminal(pane_id), true, true);
                }
                Ok(pane_id) => {
                    self.push_trace(format!(
                        "launched_unexpected_pane_kind pane_id={:?}",
                        pane_id
                    ));
                }
                Err(error) => {
                    self.push_trace(format!("launch_terminal_pane_failed error={}", error));
                }
            }
            self.complete_cycle();
        }
    }

    fn bind_new_jelly_pane(&mut self) {
        let panes_by_tab = match self.panes.as_ref() {
            Some(manifest) => manifest.panes.clone(),
            None => return,
        };

        let target_tab = self.awaiting_tab.or_else(|| self.active_tab_index());

        let all_new_terminals: Vec<(usize, PaneInfo)> = panes_by_tab
            .iter()
            .flat_map(|(tab_index, panes)| {
                panes.iter().filter_map(|p| {
                    if !p.is_plugin && !p.exited && !self.known_terminal_ids.contains(&p.id) {
                        Some((*tab_index, p.clone()))
                    } else {
                        None
                    }
                })
            })
            .collect();

        let candidate = if let Some(target_tab) = target_tab {
            all_new_terminals
                .iter()
                .find(|(tab_index, pane)| {
                    *tab_index == target_tab && pane.is_floating && self.is_jelly_pane(pane)
                })
                .or_else(|| {
                    all_new_terminals
                        .iter()
                        .find(|(_, pane)| pane.is_floating && self.is_jelly_pane(pane))
                })
                .or_else(|| {
                    all_new_terminals
                        .iter()
                        .find(|(tab_index, pane)| *tab_index == target_tab && pane.is_floating)
                })
                .or_else(|| {
                    if self.awaiting_updates >= 4 {
                        all_new_terminals
                            .iter()
                            .find(|(tab_index, _)| *tab_index == target_tab)
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    if self.awaiting_updates >= 6 {
                        all_new_terminals.first()
                    } else {
                        None
                    }
                })
                .cloned()
        } else {
            all_new_terminals
                .iter()
                .find(|(_, pane)| pane.is_floating && self.is_jelly_pane(pane))
                .or_else(|| all_new_terminals.iter().find(|(_, pane)| pane.is_floating))
                .or_else(|| {
                    if self.awaiting_updates >= 6 {
                        all_new_terminals.first()
                    } else {
                        None
                    }
                })
                .cloned()
        };

        if let Some((created_in_tab, pane)) = candidate {
            let id = pane.id;
            self.push_trace(format!(
                "bound_new_pane id={} tab={} floating={} title={} cmd={:?}",
                id, created_in_tab, pane.is_floating, pane.title, pane.terminal_command
            ));
            if let Some(target_tab) = target_tab {
                if created_in_tab != target_tab {
                    self.push_trace(format!(
                        "moving_new_pane_to_target_tab id={} from={} to={}",
                        id, created_in_tab, target_tab
                    ));
                    break_panes_to_tab_with_index(&[PaneId::Terminal(id)], target_tab, false);
                    self.relocating_pane_id = Some(id);
                    self.relocating_target_tab = Some(target_tab);
                    self.relocating_waiting_for_suppressed = false;
                    self.relocating_updates = 0;
                }
            }
            rename_terminal_pane(id, PANE_NAME);
            if self.awaiting_write_to_new_pane {
                self.push_trace(format!(
                    "writing_command_to_new_pane id={} command={}",
                    id,
                    self.launch_command()
                ));
                write_chars_to_pane_id(
                    &format!("{}\n", self.launch_command()),
                    PaneId::Terminal(id),
                );
            }
            show_pane_with_id(PaneId::Terminal(id), true, true);
            self.complete_cycle();
        } else {
            // Recover if no matching pane arrives after enough manifest updates.
            self.awaiting_updates = self.awaiting_updates.saturating_add(1);
            if self.awaiting_updates % 100 == 0 {
                self.push_trace(format!(
                    "awaiting_new_pane updates={} candidates={}",
                    self.awaiting_updates,
                    all_new_terminals.len()
                ));
            }
            if self.awaiting_updates > 1200 {
                self.push_trace("awaiting_new_pane timed_out");
                self.complete_cycle();
            }
        }
    }
}
