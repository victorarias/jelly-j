use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use zellij_tile::prelude::*;

const PANE_NAME: &str = "Jelly J";
const COMMAND: &str = "jelly-j";
const TRACE_LIMIT: usize = 200;

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
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PermissionRequestResult(PermissionStatus::Granted) => {
                self.permission_result_seen = true;
                self.permission_denied = false;
                self.ready = true;
                self.push_trace("permission granted");
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
        self.trace_seq = self.trace_seq.saturating_add(1);
        if self.trace.len() >= TRACE_LIMIT {
            self.trace.pop_front();
        }
        self.trace
            .push_back(format!("{:04} {}", self.trace_seq, message.into()));
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
        if let Some(tabs) = self.tabs.as_ref() {
            if let Some(tab) = tabs.iter().find(|tab| tab.active) {
                return Some(tab.position);
            }
        }

        let manifest = self.panes.as_ref()?;
        manifest
            .panes
            .iter()
            .find_map(|(tab_index, panes)| {
                if panes.iter().any(|p| p.is_focused && !self.is_jelly_pane(p)) {
                    Some(*tab_index)
                } else {
                    None
                }
            })
            .or_else(|| {
                manifest.panes.iter().find_map(|(tab_index, panes)| {
                    if panes.iter().any(|p| p.is_focused) {
                        Some(*tab_index)
                    } else {
                        None
                    }
                })
            })
            .or_else(|| manifest.panes.keys().min().copied())
    }

    fn find_jelly_in_tab(&self, tab_index: usize) -> Option<PaneInfo> {
        self.panes
            .as_ref()?
            .panes
            .get(&tab_index)?
            .iter()
            .find(|p| self.is_jelly_pane(p))
            .cloned()
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

    fn terminal_ids_snapshot(&self) -> HashSet<u32> {
        self.panes
            .as_ref()
            .map(|m| {
                m.panes
                    .values()
                    .flatten()
                    .filter(|p| !p.is_plugin)
                    .map(|p| p.id)
                    .collect::<HashSet<u32>>()
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
            for (_, extra_pane) in jelly_panes {
                self.push_trace(format!("closing_extra_jelly_pane id={}", extra_pane.id));
                close_terminal_pane(extra_pane.id);
            }

            let pane_id = PaneId::Terminal(keep_pane.id);
            let pane_in_current_tab = self.find_jelly_in_tab(current_tab);

            if let Some(pane) = pane_in_current_tab {
                // Deterministic toggle behavior:
                // if it's visible in this tab, hide it; otherwise show it.
                if !pane.is_suppressed {
                    self.push_trace(format!("hiding_jelly_pane id={}", keep_pane.id));
                    hide_pane_with_id(pane_id);
                } else {
                    self.push_trace(format!("showing_jelly_pane id={}", keep_pane.id));
                    show_pane_with_id(pane_id, true, true);
                }
                self.complete_cycle();
            } else {
                // Host the assistant in the currently focused tab so it's always one keypress away.
                self.push_trace(format!(
                    "relocating_jelly_pane id={} to_tab={}",
                    keep_pane.id, current_tab
                ));
                break_panes_to_tab_with_index(&[pane_id], current_tab, false);
                self.relocating_pane_id = Some(keep_pane.id);
                self.relocating_target_tab = Some(current_tab);
                self.relocating_waiting_for_suppressed = false;
                self.relocating_updates = 0;
            }
        } else {
            // Phase 1: open floating terminal pane for Jelly J.
            // Phase 2 runs in bind_new_jelly_pane when PaneUpdate arrives.
            self.awaiting_tab = Some(current_tab);
            self.awaiting_updates = 0;
            self.awaiting_write_to_new_pane = true;
            self.known_terminal_ids = self.terminal_ids_snapshot();
            self.push_trace(format!(
                "opening_new_jelly_terminal command={}",
                self.launch_command()
            ));
            open_terminal_floating(".", None);
            self.awaiting_pane = true;
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
