//! Root application controller: library filtering, watch-history persistence,
//! "Under the Hood" progressive disclosure, seamless Cast handoff, and fullscreen cinema playback.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{IconName, Sizable as _, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::{Settings, SourceSpec, is_key, parse_source_token};
use peartube::soundfont;
use peartube::worker::{CastStatus, DATA_DIR, DiscoveredSource, Entry, Event, SourceInfo, Status, worker};
use serde::{Deserialize, Serialize};

use crate::cast_screen::CastSheetForm;
use crate::list::{is_episode_id, series_group_key};
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

pub struct PearTube {
    pub settings: Settings,
    pub status: Option<Status>,
    pub entries: Vec<Entry>,
    pub error: Option<SharedString>,
    pub screen: Screen,
    pub cast_modal: Option<CastSheetForm>,
    pub cast: CastStatus,
    pub search: Entity<InputState>,
    pub bank: Bank,
    pub filter: LibraryFilter,
    pub expanded_series: HashSet<String>,
    pub selected_seasons: HashMap<String, u32>,
    pub hood_open: bool,
    pub hood_engine_open: bool,
    pub watch_history: HashMap<String, WatchProgress>,
    pending_watch: Option<(Entry, u64)>,
    pending_cast_target: Option<(String, String, u64)>,
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

pub fn detect_smart_action(raw: &str) -> Option<(&'static str, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    if is_key(&lower) {
        return Some(("Add Channel", trimmed.to_string()));
    }
    if lower.starts_with("peartube://channel/") || lower.starts_with("peartube:channel/") {
        return Some(("Add Channel", trimmed.to_string()));
    }
    if lower.starts_with("peartube://tracker/") || lower.starts_with("peartube:tracker/") || lower.starts_with("peartube://add/") || lower.starts_with("peartube://source/") {
        return Some(("Connect Source", trimmed.to_string()));
    }
    if lower.starts_with("peartube://watch/") || lower.starts_with("peartube:watch/") {
        return Some(("Play Stream", trimmed.to_string()));
    }
    if lower.starts_with("peartube://receiver/") || lower.starts_with("peartube://cast/") || lower.starts_with("peartube:receiver/") {
        return Some(("Connect TV", trimmed.to_string()));
    }
    None
}

impl PearTube {
    pub fn new(url_rx: UnboundedReceiver<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let settings = Settings::load();
        let watch_history = load_watch_history();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Find something to watch…"));
        let search_sub = cx.subscribe_in(&search, window, |this, state, event: &InputEvent, window, cx| match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } => {
                let raw = state.read(cx).value().to_string();
                if let Some((_, uri)) = detect_smart_action(&raw) {
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
            entries: Vec::new(),
            error: None,
            screen,
            cast_modal: None,
            cast: CastStatus::default(),
            search,
            bank: Bank { selected: soundfont::path().is_some(), busy: false, error: None, task: None },
            filter: LibraryFilter::All,
            expanded_series: HashSet::new(),
            selected_seasons: HashMap::new(),
            hood_open: false,
            hood_engine_open: false,
            watch_history,
            pending_watch: None,
            pending_cast_target: None,
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
                Ok(()) => refresh(&this, cx).await,
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

    pub fn submit_smart_bar_action(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.search.read(cx).value().to_string();
        if let Some((_, uri)) = detect_smart_action(&raw) {
            self.search.update(cx, |inp, cx| inp.set_value("", window, cx));
            self.open_uri_or_key(uri, cx);
        }
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

    pub fn open_uri_or_key(&mut self, raw: String, cx: &mut Context<Self>) {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        let lower = trimmed.to_lowercase();
        let is_receiver_uri = lower.starts_with("peartube://receiver/") || lower.starts_with("peartube://cast/") || lower.starts_with("peartube:receiver/");
        if !self.settings.has_sources() && !is_receiver_uri {
            let uri_candidate = if trimmed.starts_with("peartube:") { trimmed.clone() } else { format!("peartube://channel/{trimmed}") };
            if let Ok(spec) = parse_source_token(&uri_candidate, "channel") {
                self.settings.add_or_update_source(spec);
                let _ = self.settings.save();
                self.show_list(cx);
                let next = self.settings.clone();
                self.start(next, cx);
                return;
            }
        }
        let pending_cast = self.pending_cast_target.clone();
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            match w.open_uri(&trimmed).await {
                Ok(res) => {
                    let receiver_id = res.receiver.as_ref().and_then(|v| v.get("id")).and_then(|v| v.as_str()).map(String::from);
                    let is_rec = res.action == "receiver";
                    let _ = this.update(cx, |this, cx| {
                        if let Some(src) = res.source {
                            this.settings.add_or_update_source(SourceSpec { key: src.key, kind: src.kind, alias: src.alias });
                            let _ = this.settings.save();
                            this.hood_open = false;
                            this.show_list(cx);
                        }
                        if let Some(entry) = res.entry {
                            let resume = this.resume_position_for(&entry);
                            this.pending_watch = Some((entry, resume));
                        }
                        cx.notify();
                    });
                    if is_rec {
                        if let (Some(rec_id), Some((key, _, start_pos))) = (receiver_id, pending_cast) {
                            if let Ok(st) = w.cast_play(&rec_id, &key, "auto", start_pos).await {
                                let _ = this.update(cx, |this, cx| {
                                    this.cast = st;
                                    this.pending_cast_target = None;
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
        self.pending_cast_target = pending_entry.clone();
        self.cast_modal = Some(CastSheetForm::new(pending_entry));
        if let Screen::Play(play) = &self.screen {
            play.update(cx, |s, cx| s.set_cast_open(true, cx));
        }
        self.refresh_cast(cx);
        cx.notify();
    }

    pub fn close_cast_modal(&mut self, cx: &mut Context<Self>) {
        self.cast_modal = None;
        self.pending_cast_target = None;
        if let Screen::Play(play) = &self.screen {
            play.update(cx, |s, cx| s.set_cast_open(false, cx));
        }
        cx.notify();
    }
    /// Destination-first activation: plays on the active TV if connected, else immediately opens fullscreen cinema on this Mac.
    pub fn activate_entry(&mut self, entry: Entry, explicit_pos_ms: Option<u64>, window: &mut Window, cx: &mut Context<Self>) {
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
            // Single online TV on Wi-Fi: zero-question 1-click cast!
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
        let mut pending = self
            .cast_modal
            .as_ref()
            .and_then(|f| f.pending_entry.clone())
            .or_else(|| self.pending_cast_target.clone());
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
                        this.pending_cast_target = None;
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
                    let _ = w.warm(&warm_key).await;
                }
            })
            .detach();
        let formats: Vec<Entry> = self.entries.iter().filter(|e| e.id == entry.id).cloned().collect();
        let episodes: Vec<Entry> = if is_episode_id(&entry.id) {
            let grp = series_group_key(&entry);
            let mut eps: Vec<Entry> = self
                .entries
                .iter()
                .filter(|e| is_episode_id(&e.id) && series_group_key(e) == grp)
                .cloned()
                .collect();
            eps.sort_by_key(|e| (e.id.clone(), std::cmp::Reverse(e.size)));
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
                // Open the Cast chooser popup directly over the playing video without stopping playback.
                this.open_cast_sheet(Some((entry.key.clone(), entry.title.clone(), *pos_ms)), window, cx);
            }
        }));
        self.screen = Screen::Play(screen);
        cx.notify();
    }

    fn close_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cast_modal = None;
        self.pending_cast_target = None;
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        self.player_events = None;
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

fn sync_sources_from_daemon(settings: &mut Settings, list: Vec<SourceInfo>) {
    settings.sources = list
        .into_iter()
        .filter(|s| !s.primary && !s.writable)
        .map(|s| SourceSpec { key: s.key, kind: s.kind, alias: s.alias })
        .collect();
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
            match st {
                Ok(status) => this.status = Some(status),
                Err(err) => this.error = Some(err.into()),
            }
            cx.notify();
        });
        return;
    }
    let result = futures_util::join!(w.status(), w.search(None));
    let _ = this.update(cx, |this, cx| {
        match result {
            (Ok(status), Ok(entries)) => {
                this.status = Some(status);
                this.entries = entries;
            }
            (Err(err), _) | (_, Err(err)) => this.error = Some(err.into()),
        }
        cx.notify();
    });
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
