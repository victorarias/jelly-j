use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};
use zellij_tile::prelude::*;

const PANE_NAME: &str = "Jelly J";
const COMMAND: &str = "jelly-j ui";
const TRACE_LIMIT: usize = 200;
const TOGGLE_DEDUP_WINDOW_MS: u128 = 100;
const TRACKED_PANE_MISSING_GRACE_MS: u128 = 1_500;

#[derive(Default)]
struct State {
    panes: Option<PaneManifest>,
    tabs: Option<Vec<TabInfo>>,
    ready: bool,
    permission_result_seen: bool,
    permission_denied: bool,
    pending_toggle: bool,
    jelly_pane_id: Option<u32>,
    launch_command: Option<String>,
    pane_update_count: u64,
    tab_update_count: u64,
    seen_pane_update: bool,
    seen_tab_update: bool,
    last_cli_toggle_pipe_id: Option<String>,
    trace_seq: u64,
    trace: VecDeque<String>,
    last_toggle_epoch_ms: Option<u128>,
    tracked_pane_missing_since_ms: Option<u128>,
    trace_start_epoch_ms: Option<u128>,
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
    pane_update_count: u64,
    tab_update_count: u64,
    trace_len: usize,
    jelly_pane_id: Option<u32>,
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
                if let Some(pane_id) = self.jelly_pane_id {
                    if self.find_terminal_pane_by_id(pane_id).is_none() {
                        let now_ms = Self::now_epoch_millis();
                        match self.tracked_pane_missing_since_ms {
                            None => {
                                self.tracked_pane_missing_since_ms = Some(now_ms);
                                self.push_trace(format!(
                                    "tracked_jelly_pane_temporarily_missing id={}",
                                    pane_id
                                ));
                            }
                            Some(since_ms)
                                if now_ms.saturating_sub(since_ms)
                                    > TRACKED_PANE_MISSING_GRACE_MS =>
                            {
                                self.push_trace(format!(
                                    "tracked_jelly_pane_missing_timeout_clear id={}",
                                    pane_id
                                ));
                                self.jelly_pane_id = None;
                                self.tracked_pane_missing_since_ms = None;
                            }
                            _ => {}
                        }
                    } else {
                        self.tracked_pane_missing_since_ms = None;
                    }
                }
                self.infer_cached_permission_grant();
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
        // We don't render UI; rendering only calls hide_self(). Returning true on every
        // state event creates a feedback loop of render/hide/update cycles.
        false
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
                        Some(Self::ok_response(
                            json!({ "ok": true, "dedup_window": true }),
                        )),
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

    fn not_ready_response() -> Value {
        Self::error_response("not_ready", "butler permissions not granted yet")
    }

    fn ensure_ready(&self) -> Result<(), Value> {
        if self.ready {
            Ok(())
        } else {
            Err(Self::not_ready_response())
        }
    }

    fn tab_position_exists(&self, position: usize) -> bool {
        self.tabs
            .as_ref()
            .is_some_and(|tabs| tabs.iter().any(|tab| tab.position == position))
    }

    fn terminal_pane_exists(&self, pane_id: u32) -> bool {
        self.find_terminal_pane_by_id(pane_id).is_some()
    }

    fn ensure_tab_position_available(&self, position: usize) -> Result<(), Value> {
        self.ensure_ready()?;
        if self.tab_position_exists(position) {
            Ok(())
        } else {
            Err(Self::error_response(
                "tab_not_found",
                format!("tab at position {} was not found", position),
            ))
        }
    }

    fn ensure_terminal_pane_available(&self, pane_id: u32) -> Result<(), Value> {
        self.ensure_ready()?;
        if self.terminal_pane_exists(pane_id) {
            Ok(())
        } else {
            Err(Self::error_response(
                "pane_not_found",
                format!("pane id {} was not found", pane_id),
            ))
        }
    }

    fn show_pane_options(
        should_float_if_hidden: Option<bool>,
        should_focus_pane: Option<bool>,
    ) -> (bool, bool) {
        (
            should_float_if_hidden.unwrap_or(true),
            should_focus_pane.unwrap_or(true),
        )
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
                if let Err(not_ready) = self.ensure_ready() {
                    return not_ready;
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
                if let Err(err) = self.ensure_tab_position_available(position) {
                    return err;
                }
                self.push_trace(format!("rename_tab position={} name={}", position, name));
                // Zellij's rename_tab API takes a 1-based tab index, but butler
                // state reports 0-based positions. Convert accordingly.
                rename_tab((position + 1) as u32, name);
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::RenamePane { pane_id, name } => {
                if let Err(err) = self.ensure_terminal_pane_available(pane_id) {
                    return err;
                }
                self.push_trace(format!("rename_pane pane_id={} name={}", pane_id, name));
                rename_pane_with_id(PaneId::Terminal(pane_id), name);
                Self::ok_response(json!({ "ok": true }))
            }
            ButlerRequest::HidePane { pane_id } => {
                if let Err(err) = self.ensure_terminal_pane_available(pane_id) {
                    return err;
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
                if let Err(err) = self.ensure_terminal_pane_available(pane_id) {
                    return err;
                }
                let (float_if_hidden, focus_pane) =
                    Self::show_pane_options(should_float_if_hidden, should_focus_pane);
                self.push_trace(format!(
                    "show_pane pane_id={} float_if_hidden={} focus={}",
                    pane_id, float_if_hidden, focus_pane
                ));
                show_pane_with_id(PaneId::Terminal(pane_id), float_if_hidden, focus_pane);
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
            pane_update_count: self.pane_update_count,
            tab_update_count: self.tab_update_count,
            trace_len: self.trace.len(),
            jelly_pane_id: self.jelly_pane_id,
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
        if !self.pending_toggle || !self.ready || self.panes.is_none() {
            return;
        }
        self.pending_toggle = false;
        self.launch_or_toggle();
    }

    fn is_jelly_pane(&self, pane: &PaneInfo) -> bool {
        let launch_command = self.launch_command();
        let launch_executable = launch_command
            .split_whitespace()
            .next()
            .unwrap_or(launch_command);
        !pane.exited
            && !pane.is_plugin
            && (pane.title == PANE_NAME
                || pane.terminal_command.as_deref().is_some_and(|command| {
                    command.contains(launch_command) || command.contains(launch_executable)
                }))
    }

    fn active_tab_index(&self) -> Option<usize> {
        if let Some(tabs) = self.tabs.as_ref() {
            if let Some(tab) = tabs.iter().find(|tab| tab.active) {
                return Some(tab.position);
            }
        }

        let manifest = self.panes.as_ref()?;
        if let Some((tab_index, _)) = manifest.panes.iter().find(|(_, panes)| {
            panes.iter().any(|pane| {
                pane.is_focused && !pane.exited && !pane.is_plugin && !self.is_jelly_pane(pane)
            })
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

        manifest.panes.keys().min().copied()
    }

    fn focusable_non_jelly_terminal_in_tab(&self, tab_index: usize) -> Option<u32> {
        self.panes
            .as_ref()?
            .panes
            .get(&tab_index)?
            .iter()
            .find(|pane| !pane.is_plugin && !pane.exited && !self.is_jelly_pane(pane))
            .map(|pane| pane.id)
    }

    fn all_jelly_panes(&self) -> Vec<(usize, PaneInfo)> {
        self.panes
            .as_ref()
            .map(|manifest| {
                manifest
                    .panes
                    .iter()
                    .flat_map(|(tab_index, panes)| {
                        panes.iter().filter_map(|pane| {
                            if self.is_jelly_pane(pane) {
                                Some((*tab_index, pane.clone()))
                            } else {
                                None
                            }
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    fn find_terminal_pane_by_id(&self, pane_id: u32) -> Option<(usize, PaneInfo)> {
        self.panes
            .as_ref()?
            .panes
            .iter()
            .find_map(|(tab_index, panes)| {
                panes
                    .iter()
                    .find(|pane| pane.id == pane_id && !pane.is_plugin && !pane.exited)
                    .cloned()
                    .map(|pane| (*tab_index, pane))
            })
    }

    fn launch_or_toggle(&mut self) {
        let current_tab = self.active_tab_index().unwrap_or(0);
        self.push_trace(format!("launch_or_toggle current_tab={}", current_tab));

        let mut jelly_panes = self.all_jelly_panes();
        if let Some(tracked_pane_id) = self.jelly_pane_id {
            if let Some((tracked_tab, tracked_pane)) =
                self.find_terminal_pane_by_id(tracked_pane_id)
            {
                if !jelly_panes
                    .iter()
                    .any(|(_, pane)| pane.id == tracked_pane_id)
                {
                    self.push_trace(format!(
                        "using_tracked_jelly_pane id={} tab={} despite_title_or_command_drift",
                        tracked_pane_id, tracked_tab
                    ));
                    jelly_panes.push((tracked_tab, tracked_pane));
                }
            }
        }
        if !jelly_panes.is_empty() {
            self.push_trace(format!(
                "found_existing_jelly_panes count={}",
                jelly_panes.len()
            ));

            let keep_idx = jelly_panes
                .iter()
                .position(|(_, pane)| self.jelly_pane_id == Some(pane.id))
                .or_else(|| jelly_panes.iter().position(|(tab, _)| *tab == current_tab))
                .or_else(|| jelly_panes.iter().position(|(_, pane)| pane.is_focused))
                .unwrap_or(0);
            let (keep_tab, keep_pane) = jelly_panes.remove(keep_idx);
            self.jelly_pane_id = Some(keep_pane.id);

            for (_, extra_pane) in jelly_panes {
                self.push_trace(format!("closing_extra_jelly_pane id={}", extra_pane.id));
                close_terminal_pane(extra_pane.id);
            }

            let keep_ref = PaneId::Terminal(keep_pane.id);
            let visible_in_current_tab = keep_tab == current_tab && !keep_pane.is_suppressed;
            if visible_in_current_tab {
                if keep_pane.is_focused {
                    if let Some(target_focus_id) =
                        self.focusable_non_jelly_terminal_in_tab(current_tab)
                    {
                        focus_terminal_pane(target_focus_id, true, false);
                        self.push_trace(format!(
                            "hiding_jelly shifted_focus_to={}",
                            target_focus_id
                        ));
                    }
                }
                self.push_trace(format!("hiding_jelly_pane id={}", keep_pane.id));
                hide_pane_with_id(keep_ref);
            } else if keep_tab != current_tab {
                self.push_trace(format!(
                    "moving_jelly_to_current_tab_via_hidden_break id={} old_tab={} new_tab={}",
                    keep_pane.id, keep_tab, current_tab
                ));
                hide_pane_with_id(keep_ref);
                break_panes_to_tab_with_index(&[keep_ref], current_tab, false);
                self.push_trace(format!(
                    "re_float_jelly_after_break id={} to_tab={}",
                    keep_pane.id, current_tab
                ));
                toggle_pane_embed_or_eject_for_pane_id(keep_ref);
                show_pane_with_id(keep_ref, true, true);
            } else {
                self.push_trace(format!(
                    "showing_jelly_pane id={} from_tab={} to_tab={} via_show_pane_with_id",
                    keep_pane.id, keep_tab, current_tab
                ));
                show_pane_with_id(keep_ref, true, true);
            }
            return;
        }

        self.launch_new_jelly_terminal();
    }

    fn launch_new_jelly_terminal(&mut self) {
        self.push_trace(format!(
            "launching_new_jelly_terminal atomically command={}",
            self.launch_command()
        ));
        if let Some(pane_id) = self.jelly_pane_id {
            self.push_trace(format!(
                "launch_skipped_tracked_jelly_pending id={}",
                pane_id
            ));
            return;
        }
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
                self.jelly_pane_id = Some(pane_id);
                request_plugin_state_snapshot();
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
    }
}
