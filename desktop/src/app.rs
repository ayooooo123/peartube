//! Root application controller: unified Listen and Watch rooms, music queue &
//! audio player handoff (Rules 1-4), watch-history persistence, TVs dialog, and
//! fullscreen cinema playback.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
use futures_util::future::{Either, select};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::slider::{SliderEvent, SliderState};
use gpui_kit::component::{IconName, Sizable as _, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::{Settings, SourceSpec};
use peartube::soundfont;
use peartube::worker::{CastStatus, DATA_DIR, DiscoveredSource, Entry, Event, GlobalHit, Status, worker};
use player::{Event as PlayerEvent, State as PlayerState};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::cast_screen::CastSheetForm;
use crate::catalog::{Catalog, build_catalog, is_music_entry};
use crate::list::AddModalForm;
use crate::music::{MusicAudio, MusicQueue, PreviousAction, TrackItem};
use crate::play::{PlayEvent, PlayScreen};
use crate::settings_screen::SettingsForm;
use crate::theme::{BG, INK};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListenTab {
    Albums,
    Artists,
    Tracks,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchKind {
    All,
    Movies,
    Series,
    Clips,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Room {
    Home,
    Listen(ListenTab),
    Watch(WatchKind),
    Discover,
    Search,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailView {
    Album(String),
    Artist(String),
    Title(String),
    Playing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSortCol {
    Title,
    Artist,
    Album,
    Size,
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

/// A search across relays the app does not follow (src/search.js): the query, its rows, and when it was last asked.
#[derive(Default)]
pub struct GlobalSearch {
    pub query: String,
    pub rows: Vec<GlobalHit>,
    pub busy: bool,
    pub error: Option<SharedString>,
    pub asked_at: Option<Instant>,
}

pub struct PearTube {
    pub settings: Settings,
    pub status: Option<Status>,
    pub identity: Option<peartube::worker::IdentityInfo>,
    pub entries: Vec<Entry>,
    pub catalog: Catalog,
    pub error: Option<SharedString>,
    pub screen: Screen,
    pub room: Room,
    pub detail: Option<DetailView>,
    pub listen_saved_only: bool,
    pub watch_saved_only: bool,
    pub watch_source_filter: Option<String>,
    pub track_sort: (TrackSortCol, bool),
    pub track_filter: Entity<InputState>,
    pub artist_show_all: HashSet<String>,
    pub add_modal: Option<AddModalForm>,
    pub cast_modal: Option<CastSheetForm>,
    pub cast: CastStatus,
    pub search: Entity<InputState>,
    pub bank: Bank,
    pub selected_seasons: HashMap<String, u32>,
    pub hood_open: bool,
    pub hood_engine_open: bool,
    pub watch_history: HashMap<String, WatchProgress>,
    pub downloads: HashMap<String, ActiveDownload>,
    pub notice: Option<DownloadNotice>,
    pub global: GlobalSearch,
    pub music_queue: MusicQueue,
    pub music_audio: MusicAudio,
    pub music_state: PlayerState,
    pub music_seek: Option<(Entity<SliderState>, Subscription)>,
    music_dragging: Option<f32>,
    music_tick: Option<Task<()>>,
    last_music_saved: Instant,
    pending_watch: Option<(Entry, u64)>,
    start: Option<Task<()>>,
    player_events: Option<Subscription>,
    _worker: Task<()>,
    _urls: Task<()>,
    _search: Subscription,
    _track_filter: Subscription,
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
        let music_queue = MusicQueue::load();

        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search — e.g. Blue Train"));
        let search_sub = cx.subscribe_in(&search, window, |this, state, event: &InputEvent, window, cx| match event {
            InputEvent::Change => {
                let val = state.read(cx).value().to_string();
                if !val.trim().is_empty() {
                    this.detail = None;
                    this.room = Room::Search;
                }
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                let raw = state.read(cx).value().to_string();
                let trimmed = raw.trim();
                let is_key = trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
                if trimmed.to_ascii_lowercase().starts_with("peartube:") || is_key {
                    let uri = trimmed.to_string();
                    state.update(cx, |inp, cx| inp.set_value("", window, cx));
                    this.open_uri_or_key(uri, cx);
                } else if !trimmed.is_empty() {
                    this.detail = None;
                    this.room = Room::Search;
                    this.search_global(trimmed.to_string(), cx);
                }
            }
            _ => {}
        });

        let track_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter tracks…"));
        let track_filter_sub = cx.subscribe_in(&track_filter, window, |_this, _, event: &InputEvent, _, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
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
            catalog: Catalog::default(),
            error: None,
            screen,
            room: Room::Home,
            detail: None,
            listen_saved_only: false,
            watch_saved_only: false,
            watch_source_filter: None,
            track_sort: (TrackSortCol::Title, true),
            track_filter,
            artist_show_all: HashSet::new(),
            add_modal: None,
            cast_modal: None,
            cast: CastStatus::default(),
            search,
            bank: Bank {
                selected: soundfont::path().is_some(),
                busy: false,
                error: None,
                task: None,
            },
            selected_seasons: HashMap::new(),
            hood_open: false,
            hood_engine_open: false,
            watch_history,
            downloads: HashMap::new(),
            notice: None,
            global: GlobalSearch::default(),
            music_queue,
            music_audio: MusicAudio::default(),
            music_state: PlayerState::default(),
            music_seek: None,
            music_dragging: None,
            music_tick: None,
            last_music_saved: Instant::now(),
            pending_watch: None,
            start: None,
            player_events: None,
            _worker: cx.spawn(async move |this, cx| follow(this, cx).await),
            _urls: cx.spawn(async move |this, cx| follow_urls(this, url_rx, cx).await),
            _search: search_sub,
            _track_filter: track_filter_sub,
        }
    }

    pub fn active_nav_room(&self) -> Room {
        match &self.detail {
            Some(DetailView::Album(_))
            | Some(DetailView::Artist(_))
            | Some(DetailView::Playing) => Room::Listen(ListenTab::Albums),
            Some(DetailView::Title(_)) => Room::Watch(WatchKind::All),
            None => self.room.clone(),
        }
    }

    pub fn open_room(&mut self, room: Room, cx: &mut Context<Self>) {
        self.detail = None;
        self.room = room;
        self.screen = Screen::List;
        cx.notify();
    }

    pub fn open_detail(&mut self, detail: DetailView, cx: &mut Context<Self>) {
        self.detail = Some(detail);
        self.screen = Screen::List;
        cx.notify();
    }

    pub fn close_detail(&mut self, cx: &mut Context<Self>) {
        self.detail = None;
        cx.notify();
    }

    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.detail = None;
        self.room = Room::Search;
        window.focus(&self.search.read(cx).focus_handle(cx), cx);
        cx.notify();
    }

    pub fn search_for_artist(&mut self, artist_name: String, window: &mut Window, cx: &mut Context<Self>) {
        let q = artist_name.trim().to_string();
        if q.is_empty() {
            return;
        }
        self.detail = None;
        self.room = Room::Search;
        self.search.update(cx, |inp, cx| inp.set_value(q.clone(), window, cx));
        self.search_global(q, cx);
        cx.notify();
    }

    pub fn open_add_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        let form = AddModalForm::new(window, cx);
        window.focus(&form.input.read(cx).focus_handle(cx), cx);
        self.add_modal = Some(form);
        cx.notify();
    }

    pub fn close_add_modal(&mut self, cx: &mut Context<Self>) {
        self.add_modal = None;
        cx.notify();
    }

    pub fn submit_add_modal(&mut self, cx: &mut Context<Self>) {
        let raw = self
            .add_modal
            .as_ref()
            .map(|f| f.input.read(cx).value().trim().to_string())
            .unwrap_or_default();
        if raw.is_empty() {
            if let Some(f) = &mut self.add_modal {
                f.error = Some("Paste a peartube:// link or 64-character key.".into());
            }
            cx.notify();
            return;
        }
        self.add_modal = None;
        self.open_uri_or_key(raw, cx);
    }

    pub fn show_notice(&mut self, message: SharedString, cx: &mut Context<Self>) {
        self.notice = Some(DownloadNotice {
            message,
            saved_path: None,
        });
        cx.notify();
    }

    pub fn focus_source_bg(&self, key: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if let Ok(w) = worker() {
                let _ = w.focus_source(&key).await;
                refresh(&this, cx).await;
            }
        })
        .detach();
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
        let Some(prog) = self.watch_history.get(&entry.id) else {
            return 0;
        };
        if prog.duration_ms == 0 || prog.position_ms < 15_000 {
            return 0;
        }
        let ratio = prog.position_ms as f64 / prog.duration_ms as f64;
        if (0.03..0.93).contains(&ratio) {
            prog.position_ms
        } else {
            0
        }
    }

    pub fn record_watch_progress(&mut self, id: String, entry_key: String, position_ms: u64, duration_ms: u64) {
        if duration_ms == 0 {
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.watch_history.insert(
            id.clone(),
            WatchProgress {
                entry_key,
                id,
                position_ms,
                duration_ms,
                updated_at: now,
            },
        );
        save_watch_history(&self.watch_history);
    }

    // ---- Music playback & Rules 1-4 handoff ----

    pub fn music_position_ms(&self) -> u64 {
        if let Some(drag) = self.music_dragging {
            return (drag.max(0.0) * 1000.0) as u64;
        }
        if self.music_audio.is_open() {
            self.music_state.position.as_millis() as u64
        } else {
            self.music_queue.saved_position_ms
        }
    }

    pub fn music_duration_ms(&self) -> u64 {
        if self.music_audio.is_open() {
            self.music_state
                .duration
                .map(|d| d.as_millis() as u64)
                .unwrap_or(self.music_queue.saved_duration_ms)
        } else {
            self.music_queue.saved_duration_ms
        }
    }

    pub fn music_is_playing(&self) -> bool {
        self.music_audio.is_open() && self.music_state.playing
    }

    /// Rule 4: Starting music while a video is open closes the video (saving its
    /// progress for `Keep playing` and restoring an opaque window).
    fn close_video_for_music(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Screen::Play(play) = &self.screen {
            let (id, key, pos, dur) = play.read(cx).progress_snapshot();
            if dur > 0 {
                self.record_watch_progress(id, key, pos, dur);
            }
            self.close_player(window, cx);
        }
    }

    fn open_current_music_track(&mut self, start_pos_ms: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.close_video_for_music(window, cx);
        let Some(track) = self.music_queue.current().cloned() else {
            return;
        };
        if track.entry.locked {
            self.fail(
                "Subscriber pass needed: paste this channel's peartube://access/… pass in Add to library.".into(),
                cx,
            );
            return;
        }
        if track.entry.stream_url.is_empty() {
            self.fail("This track has no local stream URL yet.".into(), cx);
            return;
        }

        self.music_queue.clear_paused_for_video();
        self.music_queue.save();

        let warm_key = track.entry.key.clone();
        cx.background_executor()
            .spawn(async move {
                if let Ok(w) = worker() {
                    let _ = w.warm(&warm_key).await;
                }
            })
            .detach();

        let mut events = self.music_audio.open_track(&track, start_pos_ms);
        self.music_state = PlayerState::default();
        self.music_state.playing = true;
        self.music_seek = None;
        self.music_dragging = None;

        self.music_tick = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let beat = cx.background_executor().timer(Duration::from_millis(250));
                let ended = match select(events.next(), beat).await {
                    Either::Left((None, _)) => return,
                    Either::Left((Some(ev), _)) => matches!(ev, PlayerEvent::Ended),
                    Either::Right(_) => false,
                };
                if this
                    .update_in(cx, |this, window, cx| this.tick_music(ended, window, cx))
                    .is_err()
                {
                    return;
                }
            }
        }));
        cx.notify();
    }

    fn tick_music(&mut self, ended: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.music_audio.is_open() {
            return;
        }
        let st = self.music_audio.state();
        self.music_audio.apply_pending_seek(&st);
        self.music_state = st;

        if ended {
            if self.music_queue.next(true).is_some() {
                self.open_current_music_track(0, window, cx);
            } else {
                self.music_audio.close();
                self.music_state = PlayerState::default();
                self.music_queue.saved_position_ms = 0;
                self.music_queue.save();
                cx.notify();
            }
            return;
        }

        if let (None, Some(dur)) = (&self.music_seek, self.music_state.duration) {
            let max_s = dur.as_secs_f32().max(1.0);
            let seek = cx.new(|_| SliderState::new().min(0.).max(max_s).step(1.));
            let sub = cx.subscribe_in(&seek, window, Self::on_music_seek);
            self.music_seek = Some((seek, sub));
        }
        if let (Some((seek, _)), None) = (&self.music_seek, self.music_dragging) {
            let at = self.music_state.position.as_secs_f32().floor();
            seek.update(cx, |s, cx| {
                if s.value().start() != at {
                    s.set_value(at, window, cx);
                }
            });
        }

        if self.last_music_saved.elapsed() >= Duration::from_secs(5) {
            self.last_music_saved = Instant::now();
            self.music_queue.saved_position_ms = self.music_state.position.as_millis() as u64;
            if let Some(d) = self.music_state.duration {
                self.music_queue.saved_duration_ms = d.as_millis() as u64;
            }
            self.music_queue.save();
        }
        cx.notify();
    }

    fn on_music_seek(
        &mut self,
        _: &Entity<SliderState>,
        event: &SliderEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SliderEvent::Change(at) => self.music_dragging = Some(at.start()),
            SliderEvent::Release(at) => {
                self.music_dragging = None;
                let secs = at.start().max(0.0);
                self.music_audio.seek(Duration::from_secs_f32(secs));
                self.music_queue.saved_position_ms = (secs * 1000.0) as u64;
                self.music_queue.save();
            }
        }
        cx.notify();
    }

    pub fn play_music_list(
        &mut self,
        items: Vec<TrackItem>,
        start_index: usize,
        source_label: String,
        shuffle_override: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .music_queue
            .play_list(items, start_index, source_label, shuffle_override)
            .is_some()
        {
            self.open_current_music_track(0, window, cx);
        }
    }

    pub fn play_music_next(
        &mut self,
        items: Vec<TrackItem>,
        fallback_source: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let should_start = self.music_queue.play_next(items, fallback_source);
        self.music_queue.save();
        if should_start {
            self.open_current_music_track(0, window, cx);
        } else {
            self.show_notice("Added to play next".into(), cx);
        }
    }

    pub fn play_music_last(
        &mut self,
        items: Vec<TrackItem>,
        fallback_source: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let should_start = self.music_queue.play_last(items, fallback_source);
        self.music_queue.save();
        if should_start {
            self.open_current_music_track(0, window, cx);
        } else {
            self.show_notice("Added to Up next".into(), cx);
        }
    }

    pub fn toggle_music_play(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.music_queue.has_list() {
            return;
        }
        if self.music_audio.is_open() {
            if self.music_state.playing {
                self.music_audio.pause();
                self.music_state.playing = false;
                self.music_queue.saved_position_ms = self.music_state.position.as_millis() as u64;
                self.music_queue.save();
            } else {
                self.close_video_for_music(window, cx);
                self.music_queue.clear_paused_for_video();
                self.music_audio.play();
                self.music_state.playing = true;
                self.music_queue.save();
            }
            cx.notify();
        } else {
            let resume = self.music_queue.saved_position_ms;
            self.open_current_music_track(resume, window, cx);
        }
    }

    pub fn music_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.music_queue.next(false).is_some() {
            self.open_current_music_track(0, window, cx);
        }
    }

    pub fn music_previous(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pos = self.music_position_ms();
        match self.music_queue.previous(pos) {
            PreviousAction::Restart => {
                if self.music_audio.is_open() {
                    self.music_audio.seek(Duration::ZERO);
                    self.music_queue.saved_position_ms = 0;
                    self.music_queue.save();
                    cx.notify();
                } else {
                    self.open_current_music_track(0, window, cx);
                }
            }
            PreviousAction::Track => {
                self.open_current_music_track(0, window, cx);
            }
            PreviousAction::None => {}
        }
    }

    pub fn music_jump_to(&mut self, order_idx: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.music_queue.jump_to_order(order_idx).is_some() {
            self.open_current_music_track(0, window, cx);
        }
    }

    pub fn music_toggle_shuffle(&mut self, cx: &mut Context<Self>) {
        self.music_queue.toggle_shuffle();
        self.music_queue.save();
        cx.notify();
    }

    pub fn music_cycle_repeat(&mut self, cx: &mut Context<Self>) {
        self.music_queue.cycle_repeat();
        self.music_queue.save();
        cx.notify();
    }

    pub fn music_remove_at(&mut self, order_idx: usize, cx: &mut Context<Self>) {
        self.music_queue.remove_at(order_idx);
        self.music_queue.save();
        cx.notify();
    }

    pub fn music_clear_up_next(&mut self, cx: &mut Context<Self>) {
        self.music_queue.clear_up_next();
        self.music_queue.save();
        cx.notify();
    }

    pub fn music_stop(&mut self, cx: &mut Context<Self>) {
        self.music_audio.close();
        self.music_state = PlayerState::default();
        self.music_seek = None;
        self.music_dragging = None;
        self.music_tick = None;
        self.music_queue.stop();
        self.music_queue.save();
        if matches!(self.detail, Some(DetailView::Playing)) {
            self.detail = None;
        }
        cx.notify();
    }

    // ---- Sources, links, global search ----

    pub fn subscribe_discovered(&mut self, disc: DiscoveredSource, cx: &mut Context<Self>) {
        let uri = format!("peartube://{}/{}?name={}", disc.kind, disc.key, disc.title);
        self.open_uri_or_key(uri, cx);
    }

    pub fn remove_subscribed_source(&mut self, key: String, cx: &mut Context<Self>) {
        self.settings.sources.retain(|s| s.key != key);
        if self.watch_source_filter.as_deref() == Some(key.as_str()) {
            self.watch_source_filter = None;
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
        let pending_cast = self.cast_modal.as_ref().and_then(|f| f.pending_entry.clone());
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            match w.open_uri(&trimmed).await {
                Ok(res) => {
                    let receiver_id = res
                        .receiver
                        .as_ref()
                        .and_then(|v| v.get("id"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let is_rec = res.action == "receiver";
                    let mut needs_start = false;
                    let _ = this.update(cx, |this, cx| {
                        if let Some(src) = res.source {
                            this.settings.add_or_update_source(SourceSpec {
                                key: src.key,
                                kind: src.kind,
                                alias: src.alias,
                            });
                            let _ = this.settings.save();
                            this.hood_open = false;
                            this.show_list(cx);
                            if this.status.is_none() {
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

    pub fn search_global(&mut self, query: String, cx: &mut Context<Self>) {
        let query = query.trim().to_string();
        if query.chars().count() < 2 {
            return;
        }
        if self.global.query != query {
            self.global.rows.clear();
        }
        self.global.query = query;
        self.global.error = None;
        self.global.asked_at = Some(Instant::now());
        self.fetch_global(cx);
    }

    fn fetch_global(&mut self, cx: &mut Context<Self>) {
        let query = self.global.query.clone();
        self.global.busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let Ok(w) = worker() else { return };
            let res = w.search_global(&query).await;
            let _ = this.update(cx, |this, cx| {
                if this.global.query != query {
                    return;
                }
                this.global.busy = false;
                match res {
                    Ok(rows) => this.global.rows = rows,
                    Err(err) => this.global.error = Some(err.into()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn global_search_live(&self) -> bool {
        !self.global.busy
            && self
                .global
                .asked_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
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
                            this.show_notice("Copied 12-word recovery phrase".into(), cx);
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
        self.add_modal = None;
        self.screen = Screen::Settings(SettingsForm::new(&self.settings, window, cx));
        cx.notify();
    }

    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        self.cast_modal = None;
        self.add_modal = None;
        self.screen = Screen::List;
        cx.notify();
    }

    // ---- TVs / Cast ----

    pub fn open_cast_sheet(&mut self, pending_entry: Option<(String, String, u64)>, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.add_modal = None;
        self.cast_modal = Some(CastSheetForm::new(pending_entry, window, cx));
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

    pub fn pair_cast_tv(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &mut self.cast_modal else {
            return;
        };
        let raw = form.pair_input.read(cx).value().trim().to_string();
        if raw.is_empty() {
            form.error = Some("Enter the code shown on the TV.".into());
            cx.notify();
            return;
        }
        let target_id = form.pairing_for_id.clone().or_else(|| {
            self.cast
                .receivers
                .iter()
                .find(|r| r.online && !r.paired && r.current != Some(false))
                .map(|r| r.id.clone())
        });
        form.busy = true;
        form.error = None;
        let params = if raw.to_ascii_lowercase().starts_with("peartube:") {
            json!({ "uri": raw })
        } else if let Some(id) = target_id {
            json!({ "id": id, "code": raw.to_uppercase() })
        } else {
            json!({ "code": raw.to_uppercase() })
        };
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let Ok(w) = worker() else { return };
            match w.cast_pair(params).await {
                Ok(st) => {
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.cast = st;
                        if let Some(f) = &mut this.cast_modal {
                            f.busy = false;
                            f.error = None;
                            f.pairing_for_id = None;
                            f.pair_input.update(cx, |inp, cx| inp.set_value("", window, cx));
                        }
                        cx.notify();
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |this, cx| {
                        if let Some(f) = &mut this.cast_modal {
                            f.busy = false;
                            f.error = Some(err.into());
                        }
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    pub fn activate_entry(&mut self, entry: Entry, explicit_pos_ms: Option<u64>, window: &mut Window, cx: &mut Context<Self>) {
        if entry.locked {
            self.fail(
                "Subscriber pass needed: paste this channel's peartube://access/… pass in Add to library.".into(),
                cx,
            );
            return;
        }
        // If someone opened a music track via URI/global search, route to the music player.
        if is_music_entry(&entry) {
            let title = crate::catalog::track_name(&entry);
            let artist = entry
                .music
                .as_ref()
                .and_then(|m| m.artist.clone())
                .unwrap_or_default();
            let album = entry.title.clone();
            let seed = crate::catalog::sleeve_hash(&format!("{}\n{}", crate::catalog::fold(&artist), crate::catalog::fold(&album)));
            let item = TrackItem {
                track_no: crate::catalog::track_no(&entry),
                monogram: crate::catalog::monogram(&album),
                hue: seed % 360,
                seed,
                title,
                artist,
                album: album.clone(),
                album_key: format!("album:{}", entry.series_key),
                entry,
            };
            self.play_music_list(vec![item], 0, album, None, window, cx);
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
        } else if self.cast.receivers.len() == 1
            && self.cast.receivers[0].online
            && (self.cast.receivers[0].paired || self.cast.receivers[0].auth == "open")
        {
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

    /// Starts fullscreen video playback.
    /// Rule 3: if music is open/playing, pause music (keeping track, position,
    /// and queue) and mark `paused_for_video = true`; never auto-resume on close.
    pub fn play(&mut self, entry: Entry, start_pos_ms: u64, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        self.add_modal = None;

        if self.music_queue.has_list() && (self.music_is_playing() || self.music_audio.is_open()) {
            let pos = self.music_position_ms();
            let dur = self.music_duration_ms();
            self.music_audio.pause();
            self.music_state.playing = false;
            self.music_queue.pause_for_video(pos, dur);
            self.music_queue.save();
        }

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
        let episodes: Vec<Entry> = if entry.season.is_some() && !is_music_entry(&entry) {
            let grp = &entry.series_key;
            let mut eps: Vec<Entry> = self
                .entries
                .iter()
                .filter(|e| e.season.is_some() && !is_music_entry(e) && &e.series_key == grp)
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
                cx.background_executor().timer(Duration::from_millis(35)).await;
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

    pub fn download_entry(&mut self, entry: Entry, label_override: Option<String>, cx: &mut Context<Self>) {
        if self.downloads.contains_key(&entry.key) {
            return;
        }
        if entry.stream_url.is_empty() {
            self.fail("This file has no local stream URL yet.".into(), cx);
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
                                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
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
        cx.background_executor().timer(Duration::from_millis(180)).await;
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
            if this.read_with(cx, |this, _| this.global_search_live()).unwrap_or(false) {
                let _ = this.update(cx, |this, cx| this.fetch_global(cx));
            }
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
    if playing {
        let st = w.status().await;
        let _ = this.update(cx, |this, cx| {
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
                this.catalog = build_catalog(&entries);
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
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "PearTube Media".into()
    } else {
        collapsed.chars().take(160).collect()
    }
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
    let rest = download_url
        .strip_prefix("http://")
        .ok_or_else(|| "Unsupported stream URL scheme".to_string())?;
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

    let ext = header_str
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-disposition"))
        .and_then(|(_, v)| v.split("filename=\"").nth(1)?.split('"').next().map(str::to_string))
        .and_then(|name| name.rfind('.').map(|i| name[i..].to_string()))
        .unwrap_or_else(|| ".mkv".into());

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME directory unavailable".to_string())?;
    let downloads_dir = home.join("Downloads");
    std::fs::create_dir_all(&downloads_dir).map_err(|e| format!("Create Downloads folder: {e}"))?;
    let stem = sanitize_download_stem(title);
    let ext = if stem.to_ascii_lowercase().ends_with(&ext.to_ascii_lowercase()) {
        String::new()
    } else {
        ext
    };
    let final_path = unique_download_path(&downloads_dir, &stem, &ext);
    let part_path = downloads_dir.join(format!(
        "{}.part",
        final_path.file_name().and_then(|s| s.to_str()).unwrap_or("media.mkv")
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
            self.activate_entry(entry, Some(pos), window, cx);
        }
        let is_video = matches!(self.screen, Screen::Play(_));
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
        let add_popup = self
            .add_modal
            .as_ref()
            .map(|form| self.render_add_modal(form, cx).into_any_element());
        let transparent_video = matches!(&self.screen, Screen::Play(play) if play.read(cx).has_picture());
        let remote_bar = if is_list {
            self.render_cast_remote_bar(cx).map(IntoElement::into_any_element)
        } else {
            None
        };
        let music_dock = if !is_video {
            self.render_music_dock(cx).map(IntoElement::into_any_element)
        } else {
            None
        };

        v_flex()
            .size_full()
            .text_color(rgb(INK))
            .when(!transparent_video, |this| this.bg(rgb(BG)))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    if this.cast_modal.is_some() {
                        this.close_cast_modal(cx);
                    } else if this.add_modal.is_some() {
                        this.close_add_modal(cx);
                    } else if this.hood_open {
                        this.hood_open = false;
                        cx.notify();
                    }
                }
            }))
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
                            .child(
                                Button::new("dismiss-error")
                                    .ghost()
                                    .small()
                                    .icon(IconName::Close)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.error = None;
                                        cx.notify();
                                    })),
                            ),
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
                            .child(
                                Button::new("dismiss-notice")
                                    .ghost()
                                    .small()
                                    .icon(IconName::Close)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.notice = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
                )
            })
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(screen)
                    .when_some(add_popup, |this, popup| this.child(popup))
                    .when_some(cast_popup, |this, popup| this.child(popup)),
            )
            .when_some(remote_bar, |this, bar| this.child(bar))
            .when_some(music_dock, |this, dock| this.child(dock))
    }
}
