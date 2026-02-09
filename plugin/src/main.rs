use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use zellij_tile::prelude::*;

const PANE_NAME: &str = "Jelly J";
const COMMAND: &str = "jelly-j";

#[derive(Default)]
struct State {
    panes: Option<PaneManifest>,
    ready: bool,
    done: bool,
    awaiting_pane: bool,
    awaiting_tab: Option<usize>,
    awaiting_updates: u8,
    known_terminal_ids: HashSet<u32>,
    relocating_pane_id: Option<u32>,
    relocating_target_tab: Option<usize>,
    relocating_waiting_for_suppressed: bool,
    relocating_updates: u8,
}

register_plugin!(State);

impl ZellijPlugin for State {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::OpenTerminalsOrPlugins,
            PermissionType::WriteToStdin,
        ]);
        subscribe(&[EventType::PaneUpdate, EventType::PermissionRequestResult]);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PermissionRequestResult(PermissionStatus::Granted) => {
                self.ready = true;
                self.try_run();
            }
            Event::PaneUpdate(manifest) => {
                self.panes = Some(manifest);
                if self.awaiting_pane {
                    self.write_command_to_new_pane();
                } else if self.relocating_pane_id.is_some() {
                    self.continue_relocation();
                } else {
                    self.try_run();
                }
            }
            _ => {}
        }
        true
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        if !self.done {
            hide_self();
        }
    }
}

impl State {
    fn try_run(&mut self) {
        if self.done
            || !self.ready
            || self.panes.is_none()
            || self.awaiting_pane
            || self.relocating_pane_id.is_some()
        {
            return;
        }
        self.launch_or_toggle();
    }

    fn is_jelly_pane(p: &PaneInfo) -> bool {
        !p.exited
            && !p.is_plugin
            && (p.title == PANE_NAME
                || p.terminal_command
                    .as_deref()
                    .map_or(false, |c| c.contains(COMMAND)))
    }

    fn focused_tab_index(&self) -> Option<usize> {
        let manifest = self.panes.as_ref()?;

        // For LaunchOrFocusPlugin keybinds, the plugin pane itself is focused in the invocation tab.
        // Prefer it to avoid acting on stale focus data from another tab.
        manifest
            .panes
            .iter()
            .find_map(|(tab_index, panes)| {
                if panes.iter().any(|p| p.is_plugin && p.is_focused) {
                    Some(*tab_index)
                } else {
                    None
                }
            })
            .or_else(|| {
                manifest.panes.iter().find_map(|(tab_index, panes)| {
                    if panes.iter().any(|p| p.is_focused && !Self::is_jelly_pane(p)) {
                        Some(*tab_index)
                    } else {
                        None
                    }
                })
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
    }

    fn find_jelly_in_tab(&self, tab_index: usize) -> Option<PaneInfo> {
        self.panes
            .as_ref()?
            .panes
            .get(&tab_index)?
            .iter()
            .find(|p| Self::is_jelly_pane(p))
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
                            if Self::is_jelly_pane(p) {
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
        self.known_terminal_ids.clear();
    }

    fn reset_relocation(&mut self) {
        self.relocating_pane_id = None;
        self.relocating_target_tab = None;
        self.relocating_waiting_for_suppressed = false;
        self.relocating_updates = 0;
    }

    fn finish(&mut self) {
        self.reset_awaiting();
        self.reset_relocation();
        self.done = true;
        close_self();
    }

    fn find_pane_by_id(&self, pane_id: u32) -> Option<(usize, PaneInfo)> {
        self.panes.as_ref()?.panes.iter().find_map(|(tab_index, panes)| {
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
            self.finish();
            return;
        };

        let Some((current_tab, pane)) = self.find_pane_by_id(pane_id) else {
            self.relocating_updates = self.relocating_updates.saturating_add(1);
            if self.relocating_updates > 24 {
                self.finish();
            }
            return;
        };

        if current_tab != target_tab {
            self.relocating_updates = self.relocating_updates.saturating_add(1);
            if self.relocating_updates > 24 {
                self.finish();
            }
            return;
        }

        let pane_ref = PaneId::Terminal(pane_id);
        if self.relocating_waiting_for_suppressed {
            if pane.is_suppressed {
                show_pane_with_id(pane_ref, true, true);
                self.finish();
            } else {
                self.relocating_updates = self.relocating_updates.saturating_add(1);
                if self.relocating_updates % 3 == 0 {
                    hide_pane_with_id(pane_ref);
                }
                if self.relocating_updates > 24 {
                    self.finish();
                }
            }
            return;
        }

        if pane.is_suppressed {
            show_pane_with_id(pane_ref, true, true);
            self.finish();
        } else if pane.is_floating {
            show_pane_with_id(pane_ref, true, true);
            self.finish();
        } else {
            // Pane arrived tiled. Suppress first, then restore as floating.
            hide_pane_with_id(pane_ref);
            self.relocating_waiting_for_suppressed = true;
            self.relocating_updates = 0;
        }
    }

    fn launch_or_toggle(&mut self) {
        let Some(current_tab) = self.focused_tab_index() else {
            self.finish();
            return;
        };

        let mut jelly_panes = self.all_jelly_panes();
        if !jelly_panes.is_empty() {
            // Keep exactly one Jelly J pane per session to prevent pane/process buildup.
            let keep_idx = jelly_panes
                .iter()
                .position(|(tab, _)| *tab == current_tab)
                .or_else(|| jelly_panes.iter().position(|(_, pane)| pane.is_focused))
                .unwrap_or(0);
            let (_, keep_pane) = jelly_panes.remove(keep_idx);
            for (_, extra_pane) in jelly_panes {
                close_terminal_pane(extra_pane.id);
            }

            let pane_id = PaneId::Terminal(keep_pane.id);
            let pane_in_current_tab = self.find_jelly_in_tab(current_tab);

            if let Some(pane) = pane_in_current_tab {
                // Deterministic toggle behavior:
                // if it's visible in this tab, hide it; otherwise show it.
                if !pane.is_suppressed {
                    hide_pane_with_id(pane_id);
                } else {
                    show_pane_with_id(pane_id, true, true);
                }
            } else {
                // Host the assistant in the currently focused tab so it's always one keypress away.
                break_panes_to_tab_with_index(&[pane_id], current_tab, false);
                self.relocating_pane_id = Some(keep_pane.id);
                self.relocating_target_tab = Some(current_tab);
                self.relocating_waiting_for_suppressed = false;
                self.relocating_updates = 0;
                hide_self();
                return;
            }
            self.finish();
        } else if self.panes.is_some() {
            // Phase 1: open a floating terminal.
            // Phase 2 runs in write_command_to_new_pane when PaneUpdate arrives.
            self.awaiting_tab = Some(current_tab);
            self.awaiting_updates = 0;
            self.known_terminal_ids = self.terminal_ids_snapshot();
            open_terminal_floating(PathBuf::from("."), None);
            self.awaiting_pane = true;
        }
    }

    fn write_command_to_new_pane(&mut self) {
        let Some(manifest) = self.panes.as_ref() else {
            return;
        };

        let target_tab = self
            .awaiting_tab
            .or_else(|| self.focused_tab_index());

        let mut all_new_floating_terminals: Vec<(usize, u32)> = manifest
            .panes
            .iter()
            .flat_map(|(tab_index, panes)| {
                panes.iter().filter_map(|p| {
                    if p.is_floating
                        && !p.is_plugin
                        && !p.exited
                        && !self.known_terminal_ids.contains(&p.id)
                    {
                        Some((*tab_index, p.id))
                    } else {
                        None
                    }
                })
            })
            .collect();

        let candidate = if let Some(target_tab) = target_tab {
            if let Some(idx) = all_new_floating_terminals
                .iter()
                .position(|(tab_index, _)| *tab_index == target_tab)
            {
                Some(all_new_floating_terminals.remove(idx))
            } else {
                all_new_floating_terminals.into_iter().next()
            }
        } else {
            all_new_floating_terminals.into_iter().next()
        };

        if let Some((created_in_tab, id)) = candidate {
            if let Some(target_tab) = target_tab {
                if created_in_tab != target_tab {
                    break_panes_to_tab_with_index(&[PaneId::Terminal(id)], target_tab, false);
                }
            }
            write_chars_to_pane_id(
                &format!("{}\n", COMMAND),
                PaneId::Terminal(id),
            );
            rename_terminal_pane(id, PANE_NAME);
            show_pane_with_id(PaneId::Terminal(id), true, true);
            self.finish();
        } else {
            // Recover if no matching pane arrives after enough manifest updates.
            self.awaiting_updates = self.awaiting_updates.saturating_add(1);
            if self.awaiting_updates > 20 {
                self.finish();
            }
        }
    }
}
