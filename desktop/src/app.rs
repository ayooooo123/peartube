//! Root application controller: library filtering, watch-history persistence,
//! "Under the Hood" progressive disclosure, seamless Cast handoff, and fullscreen cinema playback.

use std::collections::{HashMap, HashSet};
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{IconName, Sizable as _, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::{Settings, SourceSpec};
use peartube::soundfont;
use peartube::worker::{CastStatus, DATA_DIR, DiscoveredSource, Entry, Event, Status, worker};
use serde::{Deserialize, Serialize};

use crate::cast_screen::CastSheetForm;
use crate::play::{PlayEvent, PlayScreen};
use crate::settings_screen::SettingsForm;
use crate::theme::{BG, INK};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LibraryFilter {
    All,
    Movies,
    Series,
    OnDevice,
    Source(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchProgress {
    pub entry_key: String,
    pub id: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub updated_at: u64,
}

pub enum Screen {
    List,
    Settings(SettingsForm),
    Play(Entity<PlayScreen>),
}
pub struct Bank {
    pub selected: bool,
    pub busy: bool,
    pub error: Option<SharedString>,
    pub task: Option<Task<()>>,
}

#[derive(Clone)]
pub struct ActiveDownload {
    pub downloaded: Arc<AtomicU64>,
    pub total: u64,
    pub cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct DownloadNotice {
    pub message: SharedString,
    pub saved_path: Option<PathBuf>,
}

pub struct PearTube {
    pub settings: Settings,
    pub status: Option<Status>,
    pub identity: Option<peartube::worker::IdentityInfo>,
    pub entries: Vec<Entry>,
    pub error: Option<SharedString>,
    pub screen: Screen,
    pub cast_modal: Option<CastSheetForm>,
    pub cast: CastStatus,
    pub search: Entity<InputState>,
    pub bank: Bank,
    pub filter: LibraryFilter,
    pub visible_limit: usize,
    pub expanded_series: HashSet<String>,
    pub selected_seasons: HashMap<String, u32>,
    pub hood_open: bool,
    pub hood_engine_open: bool,
    pub watch_history: HashMap<String, WatchProgress>,
    pub downloads: HashMap<String, ActiveDownload>,
    pub notice: Option<DownloadNotice>,
    pending_watch: Option<(Entry, u64)>,
    start: Option<Task<()>>,
    player_events: Option<Subscription>,
    _worker: Task<()>,
    _urls: Task<()>,
    _search: Subscription,
}

fn load_watch_history() -> HashMap<String, WatchProgress> {
    std::fs::read(DATA_DIR.join("watch-history.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_watch_history(map: &HashMap<String, WatchProgress>) {
    let file = DATA_DIR.join("watch-history.json");
    let tmp = file.with_extension("json.tmp");
    let _ = std::fs::create_dir_all(&*DATA_DIR);
    if let Ok(bytes) = serde_json::to_vec(map)
        && std::fs::write(&tmp, bytes).is_ok()
    {
        let _ = std::fs::rename(&tmp, &file);
    }
}


impl PearTube {
    pub fn new(url_rx: UnboundedReceiver<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = Settings::load();
        let watch_history = load_watch_history();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Find something to watch…"));
        let search_sub = cx.subscribe_in(&search, window, |this, state, event: &InputEvent, window, cx| match event {
            InputEvent::Change => {
                this.visible_limit = 80;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                let raw = state.read(cx).value().to_string();
                let trimmed = raw.trim();
                // Links and keys open; any other text is a search, already filtering as it is typed.
                let is_key = trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
                if trimmed.to_ascii_lowercase().starts_with("peartube:") || is_key {
                    let uri = trimmed.to_string();
                    state.update(cx, |inp, cx| inp.set_value("", window, cx));
                    this.open_uri_or_key(uri, cx);
                }
            }
            _ => {}
        });
        let screen = if !settings.has_sources() {
            Screen::Settings(SettingsForm::new(&settings, window, cx))
        } else {
            Screen::List
        };
        PearTube {
            settings,
            status: None,
            identity: None,
            entries: Vec::new(),
            error: None,
            screen,
            cast_modal: None,
            cast: CastStatus::default(),
            search,
            bank: Bank { selected: soundfont::path().is_some(), busy: false, error: None, task: None },
            filter: LibraryFilter::All,
            visible_limit: 80,
            expanded_series: HashSet::new(),
            selected_seasons: HashMap::new(),
            hood_open: false,
            hood_engine_open: false,
            watch_history,
            downloads: HashMap::new(),
            notice: None,
            pending_watch: None,
            start: None,
            player_events: None,
            _worker: cx.spawn(async move |this, cx| follow(this, cx).await),
            _urls: cx.spawn(async move |this, cx| follow_urls(this, url_rx, cx).await),
            _search: search_sub,
        }
    }

    pub fn start(&mut self, settings: Settings, cx: &mut Context<Self>) {
        self.start = Some(cx.spawn(async move |this, cx| {
            let started = match worker() {
                Ok(w) => w.start(&settings).await.map(drop),
                Err(err) => Err(err),
            };
            match started {
                Ok(()) => {
                    refresh(&this, cx).await;
                    peartube::worker::release_unused_memory();
                }
                Err(err) => {
                    let _ = this.update(cx, |this, cx| this.fail(err, cx));
                }
            }
        }));
    }

    fn fail(&mut self, error: String, cx: &mut Context<Self>) {
        self.error = Some(error.into());
        cx.notify();
    }

    pub fn resume_position_for(&self, entry: &Entry) -> u64 {
        let Some(prog) = self.watch_history.get(&entry.id) else { return 0 };
        if prog.duration_ms == 0 || prog.position_ms < 15_000 {
            return 0;
        }
        let ratio = prog.position_ms as f64 / prog.duration_ms as f64;
        if (0.03..0.93).contains(&ratio) { prog.position_ms } else { 0 }
    }

    pub fn record_watch_progress(&mut self, id: String, entry_key: String, position_ms: u64, duration_ms: u64) {
        if duration_ms == 0 {
            return;
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.watch_history.insert(id.clone(), WatchProgress { entry_key, id, position_ms, duration_ms, updated_at: now });
        save_watch_history(&self.watch_history);
    }


    pub fn subscribe_discovered(&mut self, disc: DiscoveredSource, cx: &mut Context<Self>) {
        let uri = format!("peartube://{}/{}?name={}", disc.kind, disc.key, disc.title);
        self.open_uri_or_key(uri, cx);
    }

    pub fn remove_subscribed_source(&mut self, key: String, cx: &mut Context<Self>) {
        self.settings.sources.retain(|s| s.key != key);
        if matches!(&self.filter, LibraryFilter::Source(k) if k == &key) {
            self.filter = LibraryFilter::All;
        }
        let _ = self.settings.save();
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.remove_source(&key).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
    }

    pub fn select_filter(&mut self, target: LibraryFilter, cx: &mut Context<Self>) {
        if let LibraryFilter::Source(key) = &target {
            let k = key.clone();
            cx.spawn(async move |this, cx| {
                if let Ok(w) = worker() {
                    let _ = w.focus_source(&k).await;
                    refresh(&this, cx).await;
                }
            })
            .detach();
        }
        self.filter = target;
        self.visible_limit = 80;
        cx.notify();
    }

    pub fn open_uri_or_key(&mut self, raw: String, cx: &mut Context<Self>) {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let had_sources = self.settings.has_sources();
        let pending_cast = self.cast_modal.as_ref().and_then(|f| f.pending_entry.clone());
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            match w.open_uri(&trimmed).await {
                Ok(res) => {
                    let receiver_id = res.receiver.as_ref().and_then(|v| v.get("id")).and_then(|v| v.as_str()).map(String::from);
                    let is_rec = res.action == "receiver";
                    let mut needs_start = false;
                    let _ = this.update(cx, |this, cx| {
                        if let Some(src) = res.source {
                            this.settings.add_or_update_source(SourceSpec { key: src.key, kind: src.kind, alias: src.alias });
                            let _ = this.settings.save();
                            this.hood_open = false;
                            this.show_list(cx);
                            if !had_sources {
                                needs_start = true;
                            }
                        }
                        if let Some(entry) = res.entry {
                            let resume = this.resume_position_for(&entry);
                            this.pending_watch = Some((entry, resume));
                        }
                        cx.notify();
                    });
                    if needs_start {
                        let _ = this.update(cx, |this, cx| {
                            let next = this.settings.clone();
                            this.start(next, cx);
                        });
                    }
                    if is_rec {
                        if let (Some(rec_id), Some((key, _, start_pos))) = (receiver_id, pending_cast) {
                            if let Ok(st) = w.cast_play(&rec_id, &key, "auto", start_pos).await {
                                let _ = this.update(cx, |this, cx| {
                                    this.cast = st;
                                    this.cast_modal = None;
                                    this.show_list(cx);
                                });
                            }
                        } else if let Ok(st) = w.cast_status().await {
                            let _ = this.update(cx, |this, cx| {
                                this.cast = st;
                                cx.notify();
                            });
                        }
                    }
                    refresh(&this, cx).await;
                }
                Err(err) => {
                    let _ = this.update(cx, |this, cx| this.fail(err, cx));
                }
            }
        })
        .detach();
    }

    pub fn clear_cache(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.clear_cache(key.as_deref()).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
    }

    /// Storage contribution from the settings screen: persisted, then applied
    /// to the running worklet so a change does not interrupt playback.
    pub fn set_cache_limit(&mut self, gb: u32, cx: &mut Context<Self>) {
        if self.settings.cache_max_gb == gb {
            return;
        }
        self.settings.cache_max_gb = gb;
        let _ = self.settings.save();
        if let Screen::Settings(form) = &mut self.screen {
            form.set_cache_max_gb(gb);
        }
        let bytes = u64::from(gb) * 1_000_000_000;
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.set_cache_max(bytes).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
        cx.notify();
    }

    pub fn remove_channel_entry(&mut self, key: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                if let Err(err) = w.remove_entry(&key).await {
                    let _ = this.update(cx, |this, cx| this.fail(err, cx));
                } else {
                    refresh(&this, cx).await;
                }
            }
        })
        .detach();
    }

    pub fn rotate_subscriber_pass(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                match w.rotate_epoch().await {
                    Ok(_) => refresh(&this, cx).await,
                    Err(err) => {
                        let _ = this.update(cx, |this, cx| this.fail(err, cx));
                    }
                }
            }
        })
        .detach();
    }

    pub fn revoke_linked_writer(&mut self, writer_key: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.revoke_writer(&writer_key, false).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
    }

    pub fn copy_recovery_phrase(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                match w.identity(true).await {
                    Ok(ident) if !ident.mnemonic.is_empty() => {
                        let _ = this.update(cx, |this, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(ident.mnemonic));
                            this.notice = Some(DownloadNotice { message: "Copied 12-word recovery phrase".into(), saved_path: None });
                            cx.notify();
                        });
                    }
                    Ok(_) => {
                        let _ = this.update(cx, |this, cx| this.fail("No recovery phrase saved on this Mac.".into(), cx));
                    }
                    Err(err) => {
                        let _ = this.update(cx, |this, cx| this.fail(err, cx));
                    }
                }
            }
        })
        .detach();
    }

    pub fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        self.screen = Screen::Settings(SettingsForm::new(&self.settings, window, cx));
        cx.notify();
    }

    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        self.cast_modal = None;
        self.screen = Screen::List;
        cx.notify();
    }

    pub fn open_cast_sheet(&mut self, pending_entry: Option<(String, String, u64)>, _window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = Some(CastSheetForm::new(pending_entry));
        if let Screen::Play(play) = &self.screen {
            play.update(cx, |s, cx| s.set_cast_open(true, cx));
        }
        self.refresh_cast(cx);
        cx.notify();
    }

    pub fn close_cast_modal(&mut self, cx: &mut Context<Self>) {
        self.cast_modal = None;
        if let Screen::Play(play) = &self.screen {
            play.update(cx, |s, cx| s.set_cast_open(false, cx));
        }
        cx.notify();
    }
    /// Destination-first activation: plays on the active TV if connected, else immediately opens fullscreen cinema on this Mac.
    pub fn activate_entry(&mut self, entry: Entry, explicit_pos_ms: Option<u64>, window: &mut Window, cx: &mut Context<Self>) {
        if entry.locked {
            self.fail("Subscriber pass needed: paste this channel's peartube://access/… pass in the search bar.".into(), cx);
            return;
        }
        let start_pos = explicit_pos_ms.unwrap_or_else(|| self.resume_position_for(&entry));
        if self.cast.session.is_some() {
            self.cast_entry_or_sheet(entry, start_pos, window, cx);
        } else {
            self.play(entry, start_pos, window, cx);
        }
    }

    pub fn cast_entry_or_sheet(&mut self, entry: Entry, start_pos_ms: u64, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(sess) = &self.cast.session {
            let rec_id = sess.receiver_id.clone();
            let key = entry.key.clone();
            cx.spawn(async move |this, cx| {
                let Ok(w) = worker() else { return };
                match w.cast_play(&rec_id, &key, "auto", start_pos_ms).await {
                    Ok(st) => {
                        let _ = this.update(cx, |this, cx| {
                            this.cast = st;
                            cx.notify();
                        });
                    }
                    Err(err) => {
                        let _ = this.update(cx, |this, cx| this.fail(err, cx));
                    }
                }
            })
            .detach();
        } else if self.cast.receivers.len() == 1 && self.cast.receivers[0].online {
            let rec_id = self.cast.receivers[0].id.clone();
            let key = entry.key.clone();
            cx.spawn(async move |this, cx| {
                let Ok(w) = worker() else { return };
                match w.cast_play(&rec_id, &key, "auto", start_pos_ms).await {
                    Ok(st) => {
                        let _ = this.update(cx, |this, cx| {
                            this.cast = st;
                            cx.notify();
                        });
                    }
                    Err(err) => {
                        let _ = this.update(cx, |this, cx| this.fail(err, cx));
                    }
                }
            })
            .detach();
        } else {
            self.open_cast_sheet(Some((entry.key, entry.title, start_pos_ms)), window, cx);
        }
    }

    pub fn refresh_cast(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            if let Ok(st) = w.cast_status().await {
                let _ = this.update(cx, |this, cx| {
                    this.cast = st;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn cast_to_receiver(&mut self, receiver_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let mut pending = self.cast_modal.as_ref().and_then(|f| f.pending_entry.clone());
        if let (Some((p_key, _, p_pos)), Screen::Play(play)) = (&mut pending, &self.screen)
            && play.read(cx).entry_key() == p_key
        {
            *p_pos = play.read(cx).current_position_ms();
        }
        let Some((key, _, start_pos)) = pending else {
            self.close_cast_modal(cx);
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            let Ok(w) = worker() else { return };
            match w.cast_play(&receiver_id, &key, "auto", start_pos).await {
                Ok(st) => {
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.cast = st;
                        this.cast_modal = None;
                        if matches!(this.screen, Screen::Play(_)) {
                            this.close_player(window, cx);
                        } else {
                            cx.notify();
                        }
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(form) = &mut this.cast_modal {
                            form.error = Some(err.into());
                        } else {
                            this.fail(err, cx);
                        }
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    pub fn remove_cast_receiver(&mut self, id: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            if let Ok(st) = w.cast_remove(&id).await {
                let _ = this.update(cx, |this, cx| {
                    this.cast = st;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn send_cast_control(&mut self, params: serde_json::Value, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            if let Ok(st) = w.cast_control(params).await {
                let _ = this.update(cx, |this, cx| {
                    this.cast = st;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn stop_casting(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            if let Ok(st) = w.cast_stop(true).await {
                let _ = this.update(cx, |this, cx| {
                    this.cast = st;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn play(&mut self, entry: Entry, start_pos_ms: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        // Immediately join this entry's content swarm and prefetch its 4 MiB head + 1 MiB tail (moov/Cues).
        let warm_key = entry.key.clone();
        cx.background_executor()
            .spawn(async move {
                if let Ok(w) = worker() {
                    let _ = w.set_player_active(true).await;
                    let _ = w.warm(&warm_key).await;
                }
            })
            .detach();
        let formats: Vec<Entry> = self.entries.iter().filter(|e| e.id == entry.id).cloned().collect();
        let episodes: Vec<Entry> = if entry.season.is_some() {
            let grp = &entry.series_key;
            let mut eps: Vec<Entry> = self
                .entries
                .iter()
                .filter(|e| e.season.is_some() && &e.series_key == grp)
                .cloned()
                .collect();
            eps.sort_by_key(|e| (e.season, e.episode, e.id.clone(), std::cmp::Reverse(e.size)));
            eps.dedup_by(|a, b| e_same_id(a, b));
            eps
        } else {
            Vec::new()
        };
        let screen = cx.new(|cx| PlayScreen::new(entry, start_pos_ms, episodes, formats, window, cx));
        if !window.is_fullscreen() {
            cx.spawn_in(window, async move |_, cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(35)).await;
                let _ = cx.update(|window, _| {
                    if !window.is_fullscreen() {
                        window.toggle_fullscreen();
                    }
                });
            })
            .detach();
        }
        self.player_events = Some(cx.subscribe_in(&screen, window, |this, _, event: &PlayEvent, window, cx| match event {
            PlayEvent::Back => this.close_player(window, cx),
            PlayEvent::DismissCast => this.close_cast_modal(cx),
            PlayEvent::Progress(id, key, pos, dur) => {
                this.record_watch_progress(id.clone(), key.clone(), *pos, *dur);
            }
            PlayEvent::SwitchEntry(next_entry, pos_ms) => {
                let target = next_entry.clone();
                let at = *pos_ms;
                window.set_background_appearance(WindowBackgroundAppearance::Opaque);
                this.player_events = None;
                this.play(target, at, window, cx);
            }
            PlayEvent::Cast(entry, pos_ms) => {
                this.open_cast_sheet(Some((entry.key.clone(), entry.title.clone(), *pos_ms)), window, cx);
            }
        }));
        self.screen = Screen::Play(screen);
        cx.notify();
    }

    fn close_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cast_modal = None;
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        self.player_events = None;
        cx.background_executor()
            .spawn(async move {
                if let Ok(w) = worker() {
                    let _ = w.set_player_active(false).await;
                }
            })
            .detach();
        self.show_list(cx);
        cx.spawn(async move |this, cx| refresh(&this, cx).await).detach();
    }

    pub fn detach_casting(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            if let Ok(st) = w.cast_stop(false).await {
                let _ = this.update(cx, |this, cx| {
                    this.cast = st;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub fn download_entry(&mut self, entry: Entry, label_override: Option<String>, cx: &mut Context<Self>) {
        if self.downloads.contains_key(&entry.key) {
            return;
        }
        if entry.stream_url.is_empty() {
            self.fail("This video has no local stream URL yet".into(), cx);
            return;
        }
        let downloaded = Arc::new(AtomicU64::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        self.downloads.insert(
            entry.key.clone(),
            ActiveDownload {
                downloaded: Arc::clone(&downloaded),
                total: entry.size,
                cancel: Arc::clone(&cancel),
            },
        );
        let title = label_override.unwrap_or_else(|| entry.title.clone());
        self.notice = Some(DownloadNotice {
            message: format!("Downloading “{title}” to Downloads…").into(),
            saved_path: None,
        });
        cx.notify();

        let warm_key = entry.key.clone();
        let dl_key = entry.key.clone();
        let download_url = entry.download_url.as_deref().unwrap_or(&entry.stream_url).to_string();
        let expected_size = entry.size;
        let (done_tx, mut done_rx) = futures_channel::mpsc::unbounded::<Result<PathBuf, String>>();

        std::thread::spawn(move || {
            let res = stream_entry_to_downloads(&download_url, &title, expected_size, &downloaded, &cancel);
            let _ = done_tx.unbounded_send(res);
        });

        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.warm(&warm_key).await;
            }
            loop {
                match done_rx.try_recv() {
                    Ok(outcome) => {
                        let _ = this.update(cx, |this, cx| {
                            this.downloads.remove(&dl_key);
                            match outcome {
                                Ok(path) => {
                                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("video");
                                    this.notice = Some(DownloadNotice {
                                        message: format!("Saved {file_name} to Downloads").into(),
                                        saved_path: Some(path),
                                    });
                                }
                                Err(err) if err == "cancelled" => {
                                    this.notice = None;
                                }
                                Err(err) => {
                                    this.notice = None;
                                    this.fail(format!("Download failed: {err}"), cx);
                                }
                            }
                            cx.notify();
                        });
                        break;
                    }
                    Err(_) => {
                        let still_active = this
                            .update(cx, |this, cx| {
                                cx.notify();
                                this.downloads.contains_key(&dl_key)
                            })
                            .unwrap_or(false);
                        if !still_active {
                            break;
                        }
                        cx.background_executor().timer(Duration::from_millis(250)).await;
                    }
                }
            }
        })
        .detach();
    }

    pub fn cancel_download(&mut self, key: &str, cx: &mut Context<Self>) {
        if let Some(active) = self.downloads.remove(key) {
            active.cancel.store(true, Ordering::SeqCst);
            self.notice = None;
            cx.notify();
        }
    }
}

async fn follow(this: WeakEntity<PearTube>, cx: &mut AsyncApp) {
    let w = match worker() {
        Ok(w) => w,
        Err(err) => {
            let _ = this.update(cx, |this, cx| this.fail(err, cx));
            return;
        }
    };
    let mut events = w.subscribe();
    let _ = this.update(cx, |this, cx| {
        if this.settings.has_sources() {
            this.start(this.settings.clone(), cx);
        }
    });
    while let Some(mut event) = events.next().await {
        let mut needs_refresh = false;
        // Coalesce startup/replication update bursts over 180ms so the worklet stays free for video streaming.
        cx.background_executor().timer(std::time::Duration::from_millis(180)).await;
        loop {
            match event {
                Event::Update => needs_refresh = true,
                Event::Sources(list) => {
                    needs_refresh = true;
                    let _ = this.update(cx, |this, _| sync_sources_from_daemon(&mut this.settings, list));
                }
                Event::Cast(st) => {
                    let _ = this.update(cx, |this, cx| {
                        this.cast = st;
                        cx.notify();
                    });
                }
                Event::ReceiverCommand(_) => {}
                Event::Fatal(msg) => {
                    let _ = this.update(cx, |this, cx| this.fail(msg, cx));
                }
                Event::Exited => {
                    let _ = this.update(cx, |this, cx| this.fail("The P2P worker stopped".into(), cx));
                    return;
                }
            }
            match events.try_recv() {
                Ok(next) => event = next,
                Err(_) => break,
            }
        }
        if needs_refresh {
            refresh(&this, cx).await;
        }
    }
}

fn e_same_id(a: &Entry, b: &Entry) -> bool {
    a.id == b.id
}

fn sync_sources_from_daemon(settings: &mut Settings, list: Vec<SourceSpec>) {
    settings.sources = list;
    let _ = settings.save();
}

async fn follow_urls(this: WeakEntity<PearTube>, mut rx: UnboundedReceiver<String>, cx: &mut AsyncApp) {
    while let Some(url) = rx.next().await {
        let _ = this.update(cx, |this, cx| this.open_uri_or_key(url, cx));
    }
}

async fn refresh(this: &WeakEntity<PearTube>, cx: &mut AsyncApp) {
    let Ok(w) = worker() else { return };
    let (has_sources, playing) = this
        .read_with(cx, |this, _| (this.settings.has_sources(), matches!(this.screen, Screen::Play(_))))
        .unwrap_or((false, false));
    if !has_sources {
        return;
    }
    // Leave Cast collared and quiet while idle or playing locally; opening the chooser wakes it, and Event::Cast drips live state back.
    if playing {
        let st = w.status().await;
        let _ = this.update(cx, |this, cx| {
            // Keep GPUI's SDR Metal layer still over the picture unless an error banner needs to gape open.
            let prev_err = this.error.clone();
            match st {
                Ok(status) => this.status = Some(status),
                Err(err) => this.error = Some(err.into()),
            }
            if this.error != prev_err {
                cx.notify();
            }
        });
        return;
    }
    let result = futures_util::join!(w.status(), w.search(None), w.identity(false));
    let mut count_changed = false;
    let _ = this.update(cx, |this, cx| {
        if let Ok(ident) = result.2 {
            this.identity = Some(ident);
        }
        match (result.0, result.1) {
            (Ok(status), Ok(entries)) => {
                count_changed = this.entries.len() != entries.len();
                this.status = Some(status);
                this.entries = entries;
            }
            (Err(err), _) | (_, Err(err)) => this.error = Some(err.into()),
        }
        cx.notify();
    });
    if count_changed {
        std::thread::spawn(peartube::worker::release_unused_memory);
    }
}

fn sanitize_download_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() { "PearTube Video".into() } else { collapsed.chars().take(160).collect() }
}

fn unique_download_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let lower = stem.to_ascii_lowercase();
    let known = [".mkv", ".mp4", ".webm", ".mov", ".avi", ".m4v", ".ts", ".ogv", ".ogg", ".flac", ".mp3"];
    let (base, suffix) = known
        .iter()
        .find(|e| lower.ends_with(*e))
        .map(|e| (&stem[..stem.len() - e.len()], *e))
        .unwrap_or((stem, ext));
    let first = dir.join(format!("{base}{suffix}"));
    if !first.exists() && !dir.join(format!("{base}{suffix}.part")).exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{base} ({n}){suffix}"));
        if !candidate.exists() && !dir.join(format!("{base} ({n}){suffix}.part")).exists() {
            return candidate;
        }
    }
    dir.join(format!("{base}-{}{suffix}", std::process::id()))
}

fn stream_entry_to_downloads(
    download_url: &str,
    title: &str,
    expected_size: u64,
    downloaded: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let rest = download_url.strip_prefix("http://").ok_or_else(|| "Unsupported stream URL scheme".to_string())?;
    let (authority, path_q) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let mut sock = TcpStream::connect(authority).map_err(|e| format!("Connect {authority}: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(45))).ok();
    let req = format!("GET {path_q} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    sock.write_all(req.as_bytes()).map_err(|e| format!("Send request: {e}"))?;

    let mut hdr = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !hdr.ends_with(b"\r\n\r\n") {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let n = sock.read(&mut byte).map_err(|e| format!("Read headers: {e}"))?;
        if n == 0 {
            return Err("Stream closed before HTTP headers completed".into());
        }
        hdr.push(byte[0]);
        if hdr.len() > 32 * 1024 {
            return Err("HTTP response headers too large".into());
        }
    }
    let header_str = String::from_utf8_lossy(&hdr);
    let status_line = header_str.lines().next().unwrap_or("");
    if !status_line.contains(" 200 ") && !status_line.contains(" 206 ") {
        return Err(format!("Stream server answered {status_line}"));
    }

    // The server sniffs the container; only its extension is used, the name stays the app's (episode suffix, any script).
    let ext = header_str
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-disposition"))
        .and_then(|(_, v)| v.split("filename=\"").nth(1)?.split('"').next().map(str::to_string))
        .and_then(|name| name.rfind('.').map(|i| name[i..].to_string()))
        .unwrap_or_else(|| ".mkv".into());

    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME directory unavailable".to_string())?;
    let downloads_dir = home.join("Downloads");
    std::fs::create_dir_all(&downloads_dir).map_err(|e| format!("Create Downloads folder: {e}"))?;
    let stem = sanitize_download_stem(title);
    // A title that already ends in the container's extension keeps it once.
    let ext = if stem.to_ascii_lowercase().ends_with(&ext.to_ascii_lowercase()) { String::new() } else { ext };
    let final_path = unique_download_path(&downloads_dir, &stem, &ext);
    let part_path = downloads_dir.join(format!(
        "{}.part",
        final_path.file_name().and_then(|s| s.to_str()).unwrap_or("video.mkv")
    ));

    let mut chunk = vec![0u8; 256 * 1024];
    let write_res = (|| -> Result<u64, String> {
        let file = std::fs::File::create(&part_path).map_err(|e| format!("Create {}: {e}", part_path.display()))?;
        let mut out = BufWriter::with_capacity(512 * 1024, file);
        let mut total_written = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let n = sock.read(&mut chunk).map_err(|e| format!("Stream read: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&chunk[..n]).map_err(|e| format!("Write file: {e}"))?;
            total_written += n as u64;
            downloaded.store(total_written, Ordering::Relaxed);
        }
        out.flush().map_err(|e| format!("Flush file: {e}"))?;
        let inner = out.into_inner().map_err(|e| format!("Flush buffer: {e}"))?;
        let _ = inner.sync_data();
        Ok(total_written)
    })();

    match write_res {
        Ok(written) => {
            if expected_size > 0 && written != expected_size {
                let _ = std::fs::remove_file(&part_path);
                return Err(format!("Incomplete transfer ({written} of {expected_size} bytes)"));
            }
            std::fs::rename(&part_path, &final_path).map_err(|e| {
                let _ = std::fs::remove_file(&part_path);
                format!("Finalize download: {e}")
            })?;
            Ok(final_path)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&part_path);
            Err(err)
        }
    }
}

impl Render for PearTube {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some((entry, pos)) = self.pending_watch.take() {
            self.play(entry, pos, window, cx);
        }
        let is_list = matches!(self.screen, Screen::List);
        let screen = match &self.screen {
            Screen::List => self.render_list(cx).into_any_element(),
            Screen::Settings(form) => self.render_settings(form, cx).into_any_element(),
            Screen::Play(play) => play.clone().into_any_element(),
        };
        let cast_popup = self
            .cast_modal
            .as_ref()
            .map(|form| self.render_cast_popup(form, cx).into_any_element());
        let transparent_video = matches!(&self.screen, Screen::Play(play) if play.read(cx).has_picture());
        let remote_bar = if is_list { self.render_cast_remote_bar(cx).map(IntoElement::into_any_element) } else { None };
        v_flex()
            .size_full()
            .text_color(rgb(INK))
            .when(!transparent_video, |this| this.bg(rgb(BG)))
            .when_some(self.error.clone(), |this, error| {
                this.child(
                    div().bg(rgb(BG)).px_4().pt_3().child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_4()
                            .py_2()
                            .rounded(px(12.))
                            .bg(rgb(0x2d1216))
                            .border_1()
                            .border_color(rgb(0x6b1d26))
                            .text_color(rgb(0xfca5a5))
                            .text_sm()
                            .child(div().flex_1().child(error))
                            .child(Button::new("dismiss-error").ghost().small().icon(IconName::Close).on_click(cx.listener(|this, _, _, cx| {
                                this.error = None;
                                cx.notify();
                            }))),
                    ),
                )
            })
            .when_some(self.notice.clone(), |this, notice| {
                let saved = notice.saved_path.clone();
                this.child(
                    div().bg(rgb(BG)).px_4().pt_3().child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_4()
                            .py_2()
                            .rounded(px(12.))
                            .bg(rgb(0x132620))
                            .border_1()
                            .border_color(rgb(0x1f513f))
                            .text_color(rgb(0xa7f3d0))
                            .text_sm()
                            .child(div().flex_1().child(notice.message))
                            .when_some(saved, |row, path| {
                                row.child(
                                    Button::new("reveal-download")
                                        .ghost()
                                        .small()
                                        .label("Show in Finder")
                                        .on_click(move |_, _, _| {
                                            let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
                                        }),
                                )
                            })
                            .child(Button::new("dismiss-notice").ghost().small().icon(IconName::Close).on_click(cx.listener(|this, _, _, cx| {
                                this.notice = None;
                                cx.notify();
                            }))),
                    ),
                )
            })
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(screen)
                    .when_some(cast_popup, |this, popup| this.child(popup)),
            )
            .when_some(remote_bar, |this, bar| this.child(bar))
    }
}
