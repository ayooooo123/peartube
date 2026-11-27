//! Root application controller: unified Listen and Watch rooms, music queue &
//! audio player handoff (Rules 1-4), watch-history persistence, TVs dialog, and
//! fullscreen cinema playback.

#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
use futures_util::future::{Either, select};
use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::slider::{SliderEvent, SliderState};
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::playback::clock;
use peartube::settings::{Settings, SourceSpec};
use peartube::soundfont;
use peartube::worker::{CastStatus, DATA_DIR, DiscoveredSource, Entry, Event, GlobalHit, MusicMeta, Status, worker};
use player::{Event as PlayerEvent, State as PlayerState};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{
    ALL_SOURCES, AcquireJob, AcquireRequest, ApiClient, CreatorSuggestion, DiscoverBrowseResult,
    DiscoverCreator, DiscoverFeed, DiscoverFollowRequest, DiscoverItem, MusicDiscoverResult,
    PluginInfo, PreviewPlayer, RumbleCandidate, SoulseekCandidate, SoulseekShelf,
    SoundcloudCandidate, SourceSearchResult, SuggestedSong, VisitedShelf, YoutubeCandidate,
    download_preview_m4a, extract_shared_url, fetch_external_image_bytes, fetch_music_discover,
    is_web_url, load_visited_shelves, parse_mirror_job, record_visited_shelf, run_blocking,
    save_visited_shelves, search_creators_typeahead, unwrap_peartube_add,
};
use crate::cast_screen::CastSheetForm;
use crate::catalog::{Catalog, VideoTile, build_catalog, is_music_entry};
use crate::list::{AddModalForm, label};
use crate::music::{MusicAudio, MusicQueue, PreviousAction, TrackItem};
use crate::play::{PlayEvent, PlayScreen};
use crate::settings_screen::SettingsForm;
use crate::theme::{ACCENT, BG, BRAND, BRAND_HOVER, CARD, DIM, GLASS_BORDER, INK, PEARL};

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WatchViewMode {
    #[default]
    Rows,
    Tonight,
    Store,
    Channels,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NetworkTab {
    #[default]
    Globe,
    Swarm,
    Flow,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DiscoverTab {
    #[default]
    All,
    Cinema,
    Videos,
    Music,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Room {
    Home,
    Listen(ListenTab),
    Watch(WatchKind),
    Discover,
    Search,
    Network(NetworkTab),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailView {
    Album(String),
    Artist(String),
    Title(String),
    Shelf(String),
    Playing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackSortCol {
    Order,
    Title,
    Artist,
    Album,
    Quality,
    Size,
    Time,
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

/// Unified search across local source providers (`Soulseek`, `YouTube`, `SoundCloud`, `Rumble`).
pub struct SourceSearchState {
    pub query: String,
    pub enabled: HashSet<String>,
    pub busy: bool,
    pub result: Option<SourceSearchResult>,
    pub error: Option<SharedString>,
    pub plugins: Vec<PluginInfo>,
}

impl Default for SourceSearchState {
    fn default() -> Self {
        let enabled = ALL_SOURCES.iter().map(|(id, _)| (*id).to_string()).collect();
        SourceSearchState {
            query: String::new(),
            enabled,
            busy: false,
            result: None,
            error: None,
            plugins: Vec::new(),
        }
    }
}

/// Active Soulseek peer shelf browse state (`DetailView::Shelf`).
#[derive(Default)]
pub struct ShelfState {
    pub peer: String,
    pub busy: bool,
    pub data: Option<SoulseekShelf>,
    pub error: Option<SharedString>,
}

/// Library/download state for one Discover v2 card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscoverItemStatus {
    Available,
    Adding,
    InLibrary,
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
    pub watch_view: WatchViewMode,
    pub watch_surprise_key: Option<String>,
    pub watch_cover_key: Option<String>,
    pub watch_az_letter: Option<char>,
    pub last_room_was_watch: bool,
    pub track_sort: (TrackSortCol, bool),
    pub track_durations: HashMap<String, u64>,
    pub track_filter: Entity<InputState>,
    pub net_down_hist: VecDeque<u64>,
    pub net_up_hist: VecDeque<u64>,
    pub net_phase: f32,
    surprise_salt: u64,
    _net_poll: Task<()>,
    pub artist_show_all: HashSet<String>,
    pub add_modal: Option<AddModalForm>,
    pub cast_modal: Option<CastSheetForm>,
    pub cast: CastStatus,
    pub search: Entity<InputState>,
    pub discover_tab: DiscoverTab,
    pub discover_follow_input: Entity<InputState>,
    pub discover_suggestions: Vec<CreatorSuggestion>,
    pub discover_suggest_busy: bool,
    discover_suggest_seq: u64,
    pub discover_music_input: Entity<InputState>,
    pub discover_music_mood: String,
    pub discover_music_query: String,
    pub discover_music_artist_focus: Option<String>,
    pub discover_music: Option<MusicDiscoverResult>,
    pub discover_music_loading: bool,
    discover_music_seq: u64,
    pub preview_player: PreviewPlayer,
    pub preview_loading_id: Option<String>,
    preview_seq: u64,
    preview_poll: Option<Task<()>>,
    pub discover_creators: Vec<DiscoverCreator>,
    pub discover_feed: Option<DiscoverFeed>,
    pub discover_browse: Option<DiscoverBrowseResult>,
    pub discover_loading: bool,
    pub discover_follow_busy: bool,
    pub discover_error: Option<SharedString>,
    pub discover_source_filter: Option<String>,
    pub discover_creator_filter: Option<String>,
    pub discover_active_topic: Option<String>,
    pub discover_thumbs: HashMap<String, Arc<Image>>,
    discover_thumbs_pending: HashSet<String>,
    discover_thumbs_failed: HashSet<String>,
    discover_clear_input: bool,
    pub minimized_video: Option<Entity<PlayScreen>>,
    player_observer: Option<Subscription>,
    pub bank: Bank,
    pub selected_seasons: HashMap<String, u32>,
    pub hood_open: bool,
    pub hood_engine_open: bool,
    pub watch_history: HashMap<String, WatchProgress>,
    pub downloads: HashMap<String, ActiveDownload>,
    pub notice: Option<DownloadNotice>,
    pub global: GlobalSearch,
    pub source_search: SourceSearchState,
    pub shelf: ShelfState,
    pub visited_shelves: Vec<VisitedShelf>,
    pub jobs: Vec<AcquireJob>,
    pub music_queue: MusicQueue,
    pub music_audio: MusicAudio,
    pub music_state: PlayerState,
    pub music_seek: Option<(Entity<SliderState>, Subscription)>,
    music_dragging: Option<f32>,
    music_tick: Option<Task<()>>,
    last_music_saved: Instant,
    pending_watch: Option<(Entry, u64)>,
    pending_add_url: Option<String>,
    jobs_poll: Option<Task<()>>,
    had_active_jobs: bool,
    start: Option<Task<()>>,
    player_events: Option<Subscription>,
    _worker: Task<()>,
    _urls: Task<()>,
    _search: Subscription,
    _track_filter: Subscription,
    _discover_follow: Subscription,
    _discover_music: Subscription,
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
        let visited_shelves = load_visited_shelves();
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
                if let Some(target) = unwrap_peartube_add(trimmed) {
                    state.update(cx, |inp, cx| inp.set_value("", window, cx));
                    this.open_add_modal_with_url(target, window, cx);
                } else if is_web_url(trimmed) {
                    let url = trimmed.to_string();
                    state.update(cx, |inp, cx| inp.set_value("", window, cx));
                    this.open_add_modal_with_url(url, window, cx);
                } else {
                    let is_key = trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
                    if trimmed.to_ascii_lowercase().starts_with("peartube:") || is_key {
                        let uri = trimmed.to_string();
                        state.update(cx, |inp, cx| inp.set_value("", window, cx));
                        this.open_uri_or_key(uri, cx);
                    } else if !trimmed.is_empty() {
                        this.detail = None;
                        this.room = Room::Search;
                        let q = trimmed.to_string();
                        this.search_global(q.clone(), cx);
                        this.search_sources(q, cx);
                    }
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

        let discover_follow_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search creators (@veritasium, 3Blue1Brown) or paste channel URL")
        });
        let discover_follow_sub = cx.subscribe_in(
            &discover_follow_input,
            window,
            |this, state, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    let raw = state.read(cx).value().to_string();
                    this.trigger_creator_typeahead(raw, cx);
                }
                InputEvent::PressEnter { .. } => {
                    this.submit_discover_follow_input(window, cx);
                }
                _ => {}
            },
        );

        let discover_music_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search artists, albums, or songs to preview & discover…")
        });
        let discover_music_sub = cx.subscribe_in(
            &discover_music_input,
            window,
            |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.search_music_discover_input(cx);
                }
            },
        );

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
            watch_view: WatchViewMode::Rows,
            watch_surprise_key: None,
            watch_cover_key: None,
            watch_az_letter: None,
            last_room_was_watch: false,
            track_sort: (TrackSortCol::Order, true),
            track_durations: HashMap::new(),
            track_filter,
            net_down_hist: VecDeque::with_capacity(40),
            net_up_hist: VecDeque::with_capacity(40),
            net_phase: 0.6,
            surprise_salt: 1,
            _net_poll: cx.spawn(async move |this, cx| poll_network_status(this, cx).await),
            artist_show_all: HashSet::new(),
            add_modal: None,
            cast_modal: None,
            cast: CastStatus::default(),
            search,
            discover_tab: DiscoverTab::All,
            discover_follow_input,
            discover_suggestions: Vec::new(),
            discover_suggest_busy: false,
            discover_suggest_seq: 0,
            discover_music_input,
            discover_music_mood: "featured".to_string(),
            discover_music_query: String::new(),
            discover_music_artist_focus: None,
            discover_music: None,
            discover_music_loading: false,
            discover_music_seq: 0,
            preview_player: PreviewPlayer::default(),
            preview_loading_id: None,
            preview_seq: 0,
            preview_poll: None,
            discover_creators: Vec::new(),
            discover_feed: None,
            discover_browse: None,
            discover_loading: false,
            discover_follow_busy: false,
            discover_error: None,
            discover_source_filter: None,
            discover_creator_filter: None,
            discover_active_topic: None,
            discover_thumbs: HashMap::new(),
            discover_thumbs_pending: HashSet::new(),
            discover_thumbs_failed: HashSet::new(),
            discover_clear_input: false,
            minimized_video: None,
            player_observer: None,
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
            source_search: SourceSearchState::default(),
            shelf: ShelfState::default(),
            visited_shelves,
            jobs: Vec::new(),
            music_queue,
            music_audio: MusicAudio::default(),
            music_state: PlayerState::default(),
            music_seek: None,
            music_dragging: None,
            music_tick: None,
            last_music_saved: Instant::now(),
            pending_watch: None,
            pending_add_url: None,
            jobs_poll: None,
            had_active_jobs: false,
            start: None,
            player_events: None,
            _worker: cx.spawn(async move |this, cx| follow(this, cx).await),
            _urls: cx.spawn(async move |this, cx| follow_urls(this, url_rx, cx).await),
            _search: search_sub,
            _track_filter: track_filter_sub,
            _discover_follow: discover_follow_sub,
            _discover_music: discover_music_sub,
        }
    }

    pub fn active_nav_room(&self) -> Room {
        match &self.detail {
            Some(DetailView::Album(_))
            | Some(DetailView::Artist(_))
            | Some(DetailView::Playing) => Room::Listen(ListenTab::Albums),
            Some(DetailView::Title(_)) => Room::Watch(WatchKind::All),
            Some(DetailView::Shelf(_)) => Room::Discover,
            None => self.room.clone(),
        }
    }

    pub fn api_client(&self) -> Option<ApiClient> {
        self.status
            .as_ref()
            .and_then(|s| s.api_url.as_ref())
            .filter(|u| !u.is_empty())
            .map(|u| ApiClient::new(u.clone()))
    }

    pub fn active_job_count(&self) -> usize {
        self.jobs.iter().filter(|j| j.is_active()).count()
    }

    pub fn failed_job_count(&self) -> usize {
        self.jobs.iter().filter(|j| j.is_failed()).count()
    }

    pub fn merge_job(&mut self, job: AcquireJob) {
        self.jobs.retain(|j| j.job_id != job.job_id);
        self.jobs.insert(0, job);
        self.jobs.sort_by_key(|j| std::cmp::Reverse(j.created.unwrap_or(0)));
    }

    pub fn open_room(&mut self, room: Room, cx: &mut Context<Self>) {
        let entering_discover = matches!(room, Room::Discover);
        if !entering_discover {
            self.stop_music_preview(cx);
        }
        self.detail = None;
        self.watch_cover_key = None;
        self.room = room;
        self.screen = Screen::List;
        if entering_discover {
            if self.discover_feed.is_none() && !self.discover_loading {
                self.refresh_discover_feed(false, cx);
            }
            if self.discover_music.is_none() && !self.discover_music_loading {
                let mood = self.discover_music_mood.clone();
                self.load_music_discover(mood, String::new(), None, cx);
            }
        }
        cx.notify();
    }

    pub fn set_watch_view(&mut self, mode: WatchViewMode, cx: &mut Context<Self>) {
        self.watch_view = mode;
        self.watch_cover_key = None;
        self.detail = None;
        if !matches!(self.room, Room::Watch(_)) {
            self.room = Room::Watch(WatchKind::All);
        }
        cx.notify();
    }

    pub fn record_status_sample(&mut self, status: Status) {
        const MAX_SAMPLES: usize = 40;
        if self.net_down_hist.len() >= MAX_SAMPLES {
            self.net_down_hist.pop_front();
        }
        if self.net_up_hist.len() >= MAX_SAMPLES {
            self.net_up_hist.pop_front();
        }
        self.net_down_hist.push_back(status.down_bps);
        self.net_up_hist.push_back(status.up_bps);
        self.status = Some(status);
    }

    pub fn pick_surprise_video(&self, exclude_key: Option<&str>, salt: u64) -> Option<VideoTile> {
        let all: Vec<&VideoTile> = self
            .catalog
            .movies
            .iter()
            .chain(self.catalog.series.iter())
            .chain(self.catalog.clips.iter())
            .collect();
        if all.is_empty() {
            return None;
        }
        let is_unwatched = |tile: &&VideoTile| -> bool {
            !tile.items.iter().any(|i| self.watch_history.contains_key(&i.entry.id))
        };
        let not_excluded = |tile: &&VideoTile| -> bool {
            exclude_key.is_none_or(|ex| tile.key != ex)
        };
        let mut pool: Vec<&VideoTile> = all
            .iter()
            .copied()
            .filter(|t| t.saved > 0 && is_unwatched(t) && not_excluded(t))
            .collect();
        if pool.is_empty() {
            pool = all
                .iter()
                .copied()
                .filter(|t| is_unwatched(t) && not_excluded(t))
                .collect();
        }
        if pool.is_empty() {
            pool = all.iter().copied().filter(not_excluded).collect();
        }
        if pool.is_empty() {
            pool = all;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let mixed = nanos
            .wrapping_add(salt.wrapping_mul(0x9e37_79b9_7f4a_7c15))
            .wrapping_mul(0x2545_f491_4f6c_dd1d);
        let idx = (mixed as usize) % pool.len();
        pool.get(idx).map(|t| (*t).clone())
    }

    pub fn roll_surprise_video(&mut self, cx: &mut Context<Self>) {
        self.surprise_salt = self.surprise_salt.wrapping_add(1);
        let prev = self.watch_surprise_key.clone();
        self.watch_surprise_key = self
            .pick_surprise_video(prev.as_deref(), self.surprise_salt)
            .map(|t| t.key);
        cx.notify();
    }

    pub fn play_something(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surprise_salt = self.surprise_salt.wrapping_add(1);
        let picked = self.pick_surprise_video(None, self.surprise_salt);
        if let Some(tile) = picked {
            self.watch_surprise_key = Some(tile.key.clone());
            if let Some(item) = tile.items.first() {
                self.activate_entry(item.entry.clone(), None, window, cx);
            }
        }
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
        self.search_global(q.clone(), cx);
        self.search_sources(q, cx);
        cx.notify();
    }

    pub fn open_add_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        let form = AddModalForm::new(window, cx);
        window.focus(&form.input.read(cx).focus_handle(cx), cx);
        self.add_modal = Some(form);
        self.refresh_jobs(cx);
        cx.notify();
    }

    pub fn open_add_modal_with_url(&mut self, url: String, window: &mut Window, cx: &mut Context<Self>) {
        self.hood_open = false;
        self.cast_modal = None;
        let clean = extract_shared_url(&url).unwrap_or_else(|| url.trim().to_string());
        let form = AddModalForm::new(window, cx);
        form.input.update(cx, |inp, cx| inp.set_value(clean.clone(), window, cx));
        window.focus(&form.input.read(cx).focus_handle(cx), cx);
        self.add_modal = Some(form);
        self.refresh_jobs(cx);
        if is_web_url(&clean) {
            self.identify_add_url(clean, cx);
        }
        cx.notify();
    }

    pub fn close_add_modal(&mut self, cx: &mut Context<Self>) {
        self.add_modal = None;
        cx.notify();
    }

    pub fn toggle_add_audio_only(&mut self, checked: bool, cx: &mut Context<Self>) {
        if let Some(form) = &mut self.add_modal {
            form.audio_only = checked;
            cx.notify();
        }
    }

    pub fn identify_add_url(&mut self, url: String, cx: &mut Context<Self>) {
        let trimmed = url.trim().to_string();
        if !is_web_url(&trimmed) {
            return;
        }
        let Some(client) = self.api_client() else {
            if let Some(form) = &mut self.add_modal {
                form.identifying = false;
                form.identified = None;
                form.identified_url = Some(trimmed);
                form.error = Some("Local engine is still starting — wait a moment and try again.".into());
            }
            cx.notify();
            return;
        };
        if let Some(form) = &mut self.add_modal {
            form.identified_url = Some(trimmed.clone());
            form.identifying = true;
            form.identified = None;
            form.error = None;
        }
        cx.notify();

        let target = trimmed.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.identify(&target)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                let Some(form) = &mut this.add_modal else {
                    return;
                };
                if form.identified_url.as_deref() != Some(trimmed.as_str()) {
                    return;
                }
                form.identifying = false;
                match outcome {
                    Ok(info) => {
                        form.audio_only = info.default_audio_only(&trimmed);
                        form.identified = Some(info);
                        form.error = None;
                    }
                    Err(err) => {
                        form.identified = None;
                        form.error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn acquire_identified_url(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            if let Some(form) = &mut self.add_modal {
                form.error = Some("Local engine is not ready yet.".into());
            }
            cx.notify();
            return;
        };
        let (url, info, audio_only) = {
            let Some(form) = &mut self.add_modal else {
                return;
            };
            let Some(url) = form.identified_url.clone() else {
                return;
            };
            let Some(info) = form.identified.clone() else {
                return;
            };
            if form.acquiring {
                return;
            }
            form.acquiring = true;
            form.error = None;
            (url, info, form.audio_only)
        };
        cx.notify();

        let title = info.effective_title(&url);
        let id = info.effective_id(&url);
        let page = info.is_page();
        let music = info.music_meta(audio_only, &url);
        let req = AcquireRequest {
            id,
            title: title.clone(),
            url,
            page,
            audio: audio_only,
            music,
        };

        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.acquire(&req)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                match outcome {
                    Ok(job) => {
                        if let Some(form) = &mut this.add_modal {
                            form.acquiring = false;
                            form.identified = None;
                            form.identified_url = None;
                            form.identifying = false;
                            form.error = None;
                        }
                        this.jobs.retain(|j| j.job_id != job.job_id);
                        this.jobs.insert(0, job);
                        this.had_active_jobs = true;
                        this.ensure_jobs_poller(cx);
                        this.show_notice(format!("Saving “{title}” to your library…").into(), cx);
                    }
                    Err(err) => {
                        if let Some(form) = &mut this.add_modal {
                            form.acquiring = false;
                            form.error = Some(err.into());
                        } else {
                            this.fail(err, cx);
                        }
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    pub fn submit_add_modal(&mut self, cx: &mut Context<Self>) {
        let raw = self
            .add_modal
            .as_ref()
            .map(|f| f.input.read(cx).value().trim().to_string())
            .unwrap_or_default();
        let Some(extracted) = extract_shared_url(&raw) else {
            if let Some(f) = &mut self.add_modal {
                f.error = Some("Paste a YouTube, SoundCloud, Rumble, Bandcamp, media, or peartube:// link.".into());
            }
            cx.notify();
            return;
        };
        if is_web_url(&extracted) {
            let already_ready = self.add_modal.as_ref().is_some_and(|f| {
                f.identified_url.as_deref() == Some(extracted.as_str()) && f.identified.is_some()
            });
            if already_ready {
                self.acquire_identified_url(cx);
            } else {
                self.identify_add_url(extracted, cx);
            }
            return;
        }
        self.add_modal = None;
        self.open_uri_or_key(extracted, cx);
    }

    fn apply_jobs_update(&mut self, mut jobs: Vec<AcquireJob>, cx: &mut Context<Self>) -> bool {
        jobs.sort_by_key(|j| std::cmp::Reverse(j.created.unwrap_or(0)));
        let prev_done: HashSet<String> = self
            .jobs
            .iter()
            .filter(|j| j.is_done())
            .map(|j| j.job_id.clone())
            .collect();
        let prev_failed: HashSet<String> = self
            .jobs
            .iter()
            .filter(|j| j.is_failed())
            .map(|j| j.job_id.clone())
            .collect();
        let prev_known: HashSet<String> = self.jobs.iter().map(|j| j.job_id.clone()).collect();

        let newly_done: Vec<&AcquireJob> = jobs
            .iter()
            .filter(|j| j.is_done() && !prev_done.contains(&j.job_id))
            .collect();
        let newly_failed: Vec<&AcquireJob> = jobs
            .iter()
            .filter(|j| {
                j.is_failed()
                    && !prev_failed.contains(&j.job_id)
                    && (self.had_active_jobs || prev_known.contains(&j.job_id))
            })
            .collect();

        let active_now = jobs.iter().any(AcquireJob::is_active);
        let should_refresh_library = !newly_done.is_empty() || (self.had_active_jobs && !active_now);

        if let Some(failed) = newly_failed.first() {
            let title = if failed.title.is_empty() {
                "Download"
            } else {
                failed.title.as_str()
            };
            let reason = failed
                .error
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Download failed");
            self.clear_saving_notice();
            self.error = Some(format!("“{title}” failed: {reason}").into());
        } else if !newly_done.is_empty() && !active_now {
            let title = newly_done[0].title.as_str();
            let msg = if newly_done.len() == 1 && !title.is_empty() {
                format!("Saved “{title}” to your library.")
            } else {
                format!("Saved {} items to your library.", newly_done.len())
            };
            self.notice = Some(DownloadNotice {
                message: msg.into(),
                saved_path: None,
            });
        } else if !active_now && self.had_active_jobs {
            self.clear_saving_notice();
        }

        self.had_active_jobs = active_now;
        self.jobs = jobs;
        if active_now {
            self.ensure_jobs_poller(cx);
        } else {
            self.jobs_poll = None;
        }
        cx.notify();
        should_refresh_library
    }

    fn clear_saving_notice(&mut self) {
        if let Some(notice) = &self.notice {
            let msg = notice.message.as_ref();
            if notice.saved_path.is_none()
                && (msg.starts_with("Saving ") || msg.starts_with("Queuing "))
            {
                self.notice = None;
            }
        }
    }

    fn on_mirror_queued(&mut self, label: &str, reply: serde_json::Value, cx: &mut Context<Self>) {
        if let Some(job) = parse_mirror_job(&reply) {
            self.merge_job(job);
        }
        self.had_active_jobs = true;
        self.refresh_jobs(cx);
        self.ensure_jobs_poller(cx);
        self.show_notice(format!("Saving “{label}” to your library…").into(), cx);
    }

    pub fn refresh_jobs(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.list_jobs()).await;
            let Ok(Ok(jobs)) = res else {
                return;
            };
            let should_refresh_library = this
                .update(cx, |this, cx| this.apply_jobs_update(jobs, cx))
                .unwrap_or(false);
            if should_refresh_library {
                refresh(&this, cx).await;
            }
        })
        .detach();
    }

    pub fn ensure_jobs_poller(&mut self, cx: &mut Context<Self>) {
        if self.jobs_poll.is_some() {
            return;
        }
        self.jobs_poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let client = this
                    .read_with(cx, |this, _| this.api_client())
                    .ok()
                    .flatten();
                let Some(client) = client else {
                    break;
                };
                let res = run_blocking(move || client.list_jobs()).await;
                let Ok(Ok(jobs)) = res else {
                    continue;
                };
                let mut keep_polling = false;
                let mut should_refresh_library = false;
                let updated = this.update(cx, |this, cx| {
                    should_refresh_library = this.apply_jobs_update(jobs, cx);
                    keep_polling = this.had_active_jobs;
                });
                if should_refresh_library {
                    refresh(&this, cx).await;
                }
                if updated.is_err() || !keep_polling {
                    break;
                }
            }
        }));
    }

    pub fn cancel_or_dismiss_job(&mut self, job_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let id_clone = job_id.clone();
            let _ = run_blocking(move || client.cancel_job(&id_clone)).await;
            let _ = this.update(cx, |this, cx| {
                this.jobs.retain(|j| j.job_id != job_id || j.is_active());
                this.refresh_jobs(cx);
            });
        })
        .detach();
    }

    pub fn retry_job(&mut self, job_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let id_clone = job_id.clone();
            let res = run_blocking(move || client.retry_job(&id_clone)).await;
            let _ = this.update(cx, |this, cx| match res {
                Ok(Ok(job)) => {
                    let title = if job.title.is_empty() { "download".to_string() } else { job.title.clone() };
                    this.merge_job(job);
                    this.show_notice(SharedString::from(format!("Resuming {title}…")), cx);
                    this.refresh_jobs(cx);
                }
                Ok(Err(err)) => {
                    this.show_notice(SharedString::from(format!("Retry failed: {err}")), cx);
                }
                Err(err) => {
                    this.show_notice(SharedString::from(format!("Retry failed: {err}")), cx);
                }
            });
        })
        .detach();
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
                    let _ = this.update(cx, |this, cx| {
                        this.refresh_jobs(cx);
                        if matches!(this.room, Room::Discover)
                            && this.discover_feed.is_none()
                            && !this.discover_loading
                        {
                            this.refresh_discover_feed(false, cx);
                        }
                    });
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

    /// Rule 4: Starting music while a video is open closes the fullscreen video
    /// (saving its progress), pauses any minimized mini-player video, and stops any 30s preview.
    fn close_video_for_music(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.stop_music_preview(cx);
        if let Screen::Play(play) = &self.screen {
            let (id, key, pos, dur) = play.read(cx).progress_snapshot();
            if dur > 0 {
                self.record_watch_progress(id, key, pos, dur);
            }
            self.close_player(window, cx);
        } else if let Some(mini) = &self.minimized_video {
            mini.update(cx, |p, cx| p.pause_playback(cx));
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
        let prev_sig = (
            self.music_state.playing,
            self.music_state.buffering,
            self.music_state.position.as_secs(),
            self.music_state.duration.map(|d| d.as_secs()),
            self.music_state.error.clone(),
        );
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

        let mut seek_created = false;
        if let (None, Some(dur)) = (&self.music_seek, self.music_state.duration) {
            if let Some(cur) = self.music_queue.current() {
                let dur_secs = dur.as_secs();
                if dur_secs > 0 {
                    self.track_durations.insert(cur.entry.key.clone(), dur_secs);
                }
            }
            let max_s = dur.as_secs_f32().max(1.0);
            let seek = cx.new(|_| SliderState::new().min(0.).max(max_s).step(1.));
            let sub = cx.subscribe_in(&seek, window, Self::on_music_seek);
            self.music_seek = Some((seek, sub));
            seek_created = true;
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
        let next_sig = (
            self.music_state.playing,
            self.music_state.buffering,
            self.music_state.position.as_secs(),
            self.music_state.duration.map(|d| d.as_secs()),
            self.music_state.error.clone(),
        );
        if seek_created || next_sig != prev_sig {
            cx.notify();
        }
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
            self.last_room_was_watch = false;
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

    pub fn play_all_library_tracks(
        &mut self,
        shuffle_override: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items: Vec<TrackItem> = self.catalog.tracks.iter().map(TrackItem::from_track_row).collect();
        self.play_music_list(items, 0, "Library".to_string(), shuffle_override, window, cx);
    }

    pub fn play_album_key(
        &mut self,
        album_key: &str,
        start_index: usize,
        shuffle_override: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((items, label)) = self
            .catalog
            .album_by_key(album_key)
            .map(|a| (TrackItem::from_album(a), a.album.clone()))
        else {
            return;
        };
        self.play_music_list(items, start_index, label, shuffle_override, window, cx);
    }

    pub fn queue_album_key(
        &mut self,
        album_key: &str,
        play_next: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((items, label)) = self
            .catalog
            .album_by_key(album_key)
            .map(|a| (TrackItem::from_album(a), a.album.clone()))
        else {
            return;
        };
        if play_next {
            self.play_music_next(items, label, window, cx);
        } else {
            self.play_music_last(items, label, window, cx);
        }
    }

    pub fn play_artist_key(
        &mut self,
        artist_key: &str,
        start_index: usize,
        shuffle_override: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((items, label)) = self.artist_tracks_by_key(artist_key) else {
            return;
        };
        self.play_music_list(items, start_index, label, shuffle_override, window, cx);
    }

    pub fn queue_artist_key(
        &mut self,
        artist_key: &str,
        play_next: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((items, label)) = self.artist_tracks_by_key(artist_key) else {
            return;
        };
        if play_next {
            self.play_music_next(items, label, window, cx);
        } else {
            self.play_music_last(items, label, window, cx);
        }
    }

    fn artist_tracks_by_key(&self, artist_key: &str) -> Option<(Vec<TrackItem>, String)> {
        let artist = self.catalog.artist_by_key(artist_key)?;
        let items: Vec<TrackItem> = artist
            .album_keys
            .iter()
            .filter_map(|k| self.catalog.album_by_key(k))
            .flat_map(TrackItem::from_album)
            .collect();
        Some((items, artist.name.clone()))
    }

    pub fn queue_track_entry(
        &mut self,
        entry_key: &str,
        play_next: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(item) = self
            .catalog
            .tracks
            .iter()
            .find(|r| r.entry.key == entry_key)
            .map(TrackItem::from_track_row)
        else {
            return;
        };
        let album = item.album.clone();
        if play_next {
            self.play_music_next(vec![item], album, window, cx);
        } else {
            self.play_music_last(vec![item], album, window, cx);
        }
    }

    pub fn download_track_entry(&mut self, entry_key: &str, cx: &mut Context<Self>) {
        let Some((entry, title)) = self
            .catalog
            .tracks
            .iter()
            .find(|r| r.entry.key == entry_key)
            .map(|r| (r.entry.clone(), r.track_name.clone()))
        else {
            return;
        };
        self.download_entry(entry, Some(title), cx);
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
        if let Some(target) = unwrap_peartube_add(&trimmed) {
            self.pending_add_url = Some(target);
            cx.notify();
            return;
        }
        if is_web_url(&trimmed) {
            self.pending_add_url = Some(trimmed);
            cx.notify();
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

    // ---- Unified source search & Soulseek shelf browser ----

    pub fn toggle_source_chip(&mut self, source: String, cx: &mut Context<Self>) {
        if self.source_search.enabled.contains(&source) {
            if self.source_search.enabled.len() > 1 {
                self.source_search.enabled.remove(&source);
            }
        } else {
            self.source_search.enabled.insert(source);
        }
        let active_query = self.search.read(cx).value().trim().to_string();
        if active_query.chars().count() >= 2 && self.source_search.query == active_query {
            self.search_sources(active_query, cx);
        } else {
            cx.notify();
        }
    }

    pub fn search_sources(&mut self, query: String, cx: &mut Context<Self>) {
        let query = query.trim().to_string();
        if query.chars().count() < 2 {
            return;
        }
        let Some(client) = self.api_client() else {
            self.source_search.query = query;
            self.source_search.busy = false;
            self.source_search.error = Some("Local engine is still starting.".into());
            cx.notify();
            return;
        };
        let sources: Vec<String> = ALL_SOURCES
            .iter()
            .map(|(id, _)| (*id).to_string())
            .filter(|id| self.source_search.enabled.contains(id))
            .collect();
        if sources.is_empty() {
            return;
        }
        let need_plugins = self.source_search.plugins.is_empty();
        self.source_search.query = query.clone();
        self.source_search.busy = true;
        self.source_search.error = None;
        cx.notify();

        let req_query = query.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || {
                let plugins = if need_plugins {
                    client.list_plugins().ok()
                } else {
                    None
                };
                let search = client.search_sources(&req_query, &sources);
                (plugins, search)
            })
            .await;

            let _ = this.update(cx, |this, cx| {
                if this.source_search.query != query {
                    return;
                }
                this.source_search.busy = false;
                match res {
                    Ok((plugins, Ok(result))) => {
                        if let Some(p) = plugins {
                            this.source_search.plugins = p;
                        }
                        this.source_search.result = Some(result);
                        this.source_search.error = None;
                    }
                    Ok((plugins, Err(err))) => {
                        if let Some(p) = plugins {
                            this.source_search.plugins = p;
                        }
                        this.source_search.error = Some(err.into());
                    }
                    Err(err) => {
                        this.source_search.error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn mirror_soulseek_files(
        &mut self,
        peer: String,
        files: Vec<SoulseekCandidate>,
        title: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.api_client() else {
            self.fail("Local engine is not ready yet.".into(), cx);
            return;
        };
        let label = title.clone().unwrap_or_else(|| format!("files from {peer}"));
        self.show_notice(format!("Queuing “{label}” from {peer}…").into(), cx);
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.mirror_soulseek(&peer, &files, title.as_deref())).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(reply) => this.on_mirror_queued(&label, reply, cx),
                Err(err) => {
                    this.clear_saving_notice();
                    this.fail(err, cx);
                }
            });
        })
        .detach();
    }

    pub fn mirror_youtube_candidate(&mut self, cand: YoutubeCandidate, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            self.fail("Local engine is not ready yet.".into(), cx);
            return;
        };
        let fallback_artist = self.source_search.query.clone();
        let label = cand.title.clone();
        self.show_notice(format!("Saving “{label}” from YouTube…").into(), cx);
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.mirror_youtube(&cand, &fallback_artist)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(reply) => this.on_mirror_queued(&label, reply, cx),
                Err(err) => {
                    this.clear_saving_notice();
                    this.fail(err, cx);
                }
            });
        })
        .detach();
    }

    pub fn mirror_soundcloud_candidate(&mut self, cand: SoundcloudCandidate, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            self.fail("Local engine is not ready yet.".into(), cx);
            return;
        };
        let fallback_artist = self.source_search.query.clone();
        let label = cand.title.clone();
        self.show_notice(format!("Saving “{label}” from SoundCloud…").into(), cx);
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.mirror_soundcloud(&cand, &fallback_artist)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(reply) => this.on_mirror_queued(&label, reply, cx),
                Err(err) => {
                    this.clear_saving_notice();
                    this.fail(err, cx);
                }
            });
        })
        .detach();
    }

    pub fn mirror_rumble_candidate(&mut self, cand: RumbleCandidate, audio_only: bool, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            self.fail("Local engine is not ready yet.".into(), cx);
            return;
        };
        let fallback_artist = self.source_search.query.clone();
        let label = cand.title.clone();
        let kind = if audio_only { "audio" } else { "video" };
        self.show_notice(format!("Saving {kind} “{label}” from Rumble…").into(), cx);
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.mirror_rumble(&cand, audio_only, &fallback_artist)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(reply) => this.on_mirror_queued(&label, reply, cx),
                Err(err) => {
                    this.clear_saving_notice();
                    this.fail(err, cx);
                }
            });
        })
        .detach();
    }

    pub fn open_shelf(&mut self, peer: String, refresh_remote: bool, cx: &mut Context<Self>) {
        let clean = peer.trim().to_string();
        if clean.is_empty() {
            return;
        }
        self.detail = Some(DetailView::Shelf(clean.clone()));
        self.screen = Screen::List;
        let Some(client) = self.api_client() else {
            self.shelf = ShelfState {
                peer: clean,
                busy: false,
                data: None,
                error: Some("Local engine is still starting.".into()),
            };
            cx.notify();
            return;
        };
        let keep_data = if self.shelf.peer == clean && !refresh_remote {
            self.shelf.data.clone()
        } else {
            None
        };
        self.shelf = ShelfState {
            peer: clean.clone(),
            busy: true,
            data: keep_data,
            error: None,
        };
        cx.notify();

        let target = clean.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.browse_soulseek(&target, refresh_remote)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                if this.shelf.peer != clean {
                    return;
                }
                this.shelf.busy = false;
                match outcome {
                    Ok(shelf) => {
                        record_visited_shelf(&mut this.visited_shelves, &shelf.peer, shelf.tracks, shelf.size);
                        this.shelf.data = Some(shelf);
                        this.shelf.error = None;
                    }
                    Err(err) => {
                        this.shelf.error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn remove_visited_shelf(&mut self, peer: String, cx: &mut Context<Self>) {
        self.visited_shelves
            .retain(|s| !s.peer.eq_ignore_ascii_case(&peer));
        save_visited_shelves(&self.visited_shelves);
        cx.notify();
    }

    // ---- Discover v2 (followed creators feed & topic browsing) ----

    pub fn discover_item_status(&self, item: &DiscoverItem) -> DiscoverItemStatus {
        let in_entries = !item.acquire_id.is_empty()
            && self
                .entries
                .iter()
                .any(|e| e.id.eq_ignore_ascii_case(&item.acquire_id));
        if item.in_library || in_entries {
            return DiscoverItemStatus::InLibrary;
        }
        let in_jobs = !item.acquire_id.is_empty()
            && self.jobs.iter().any(|j| {
                j.is_active()
                    && j.id
                        .as_deref()
                        .is_some_and(|id| id.eq_ignore_ascii_case(&item.acquire_id))
            });
        if in_jobs {
            DiscoverItemStatus::Adding
        } else {
            DiscoverItemStatus::Available
        }
    }

    pub fn is_discover_creator_followed(&self, source: &str, creator_url: &str, creator_name: &str) -> bool {
        let clean_url = creator_url.trim();
        let clean_name = creator_name.trim();
        self.discover_creators.iter().any(|c| {
            if !clean_url.is_empty() && c.url.eq_ignore_ascii_case(clean_url) {
                return true;
            }
            c.source.eq_ignore_ascii_case(source)
                && !clean_name.is_empty()
                && c.name.eq_ignore_ascii_case(clean_name)
        })
    }

    pub fn set_discover_source_filter(&mut self, source: Option<String>, cx: &mut Context<Self>) {
        self.discover_source_filter = source.clone();
        if let (Some(src), Some(cid)) = (source.as_deref(), self.discover_creator_filter.as_deref()) {
            let keep = self
                .discover_creators
                .iter()
                .any(|c| c.id == cid && c.source.eq_ignore_ascii_case(src));
            if !keep {
                self.discover_creator_filter = None;
            }
        }
        if self.discover_active_topic.is_some() {
            cx.notify();
        } else {
            self.refresh_discover_feed(false, cx);
        }
    }

    pub fn set_discover_creator_filter(&mut self, creator_id: Option<String>, cx: &mut Context<Self>) {
        self.discover_active_topic = None;
        self.discover_browse = None;
        self.discover_creator_filter = creator_id;
        self.refresh_discover_feed(false, cx);
    }

    pub fn refresh_discover_feed(&mut self, force_refresh: bool, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            self.discover_loading = false;
            cx.notify();
            return;
        };
        let source_filter = self.discover_source_filter.clone();
        let creator_filter = self.discover_creator_filter.clone();
        self.discover_loading = true;
        self.discover_error = None;
        cx.notify();

        let req_source = source_filter.clone();
        let req_creator = creator_filter.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || {
                client.get_discover_feed(req_source.as_deref(), req_creator.as_deref(), force_refresh, 40)
            })
            .await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                if this.discover_source_filter != source_filter || this.discover_creator_filter != creator_filter {
                    return;
                }
                this.discover_loading = false;
                match outcome {
                    Ok(feed) => {
                        let thumb_paths = collect_discover_thumbs(&feed.creators, &feed.items);
                        this.discover_creators = feed.creators.clone();
                        this.discover_feed = Some(feed);
                        this.discover_error = None;
                        this.prefetch_discover_thumbs(thumb_paths, cx);
                    }
                    Err(err) => {
                        this.discover_error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn submit_discover_follow_input(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.discover_follow_input.read(cx).value().trim().to_string();
        if raw.is_empty() {
            self.discover_error = Some(
                "Type a creator name, @handle, or paste a YouTube, SoundCloud, or Rumble channel link.".into(),
            );
            cx.notify();
            return;
        }
        let lower = raw.to_ascii_lowercase();
        let is_direct = is_web_url(&raw) || lower.starts_with("peartube:") || raw.starts_with('@');
        if !is_direct && let Some(first) = self.discover_suggestions.first().cloned() {
            self.follow_creator_suggestion(first, cx);
            return;
        }
        self.clear_creator_suggestions(cx);
        self.follow_discover_creator(DiscoverFollowRequest::from_url(raw), true, cx);
    }

    pub fn follow_discover_creator(&mut self, req: DiscoverFollowRequest, from_input: bool, cx: &mut Context<Self>) {
        if self.discover_follow_busy {
            return;
        }
        let Some(client) = self.api_client() else {
            self.discover_error = Some("Local engine is still starting — try again in a moment.".into());
            cx.notify();
            return;
        };
        self.discover_follow_busy = true;
        self.discover_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.follow_discover_creator(&req)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                this.discover_follow_busy = false;
                match outcome {
                    Ok(reply) => {
                        let name = reply.creator.display_name().to_string();
                        this.discover_creators = reply.creators;
                        if let Some(browse) = &mut this.discover_browse {
                            for c in &mut browse.creators {
                                if c.url.eq_ignore_ascii_case(&reply.creator.url)
                                    || (c.source == reply.creator.source
                                        && c.name.eq_ignore_ascii_case(&reply.creator.name))
                                {
                                    c.followed = Some(true);
                                }
                            }
                        }
                        if from_input {
                            this.discover_clear_input = true;
                        }
                        this.discover_error = None;
                        this.show_notice(format!("Following {name}").into(), cx);
                        if this.discover_active_topic.is_none() {
                            this.refresh_discover_feed(false, cx);
                        }
                    }
                    Err(err) => {
                        this.discover_error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn unfollow_discover_creator(&mut self, creator_id: String, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            self.discover_error = Some("Local engine is still starting.".into());
            cx.notify();
            return;
        };
        let target = creator_id.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.unfollow_discover_creator(&target)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(reply) => {
                    this.discover_creators = reply.creators;
                    if this.discover_creator_filter.as_deref() == Some(creator_id.as_str()) {
                        this.discover_creator_filter = None;
                    }
                    if this.discover_active_topic.is_none() {
                        this.refresh_discover_feed(false, cx);
                    } else {
                        cx.notify();
                    }
                }
                Err(err) => {
                    this.discover_error = Some(err.into());
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn browse_discover_topic(&mut self, topic: String, cx: &mut Context<Self>) {
        let clean = topic.trim().to_string();
        if clean.is_empty() {
            return;
        }
        let Some(client) = self.api_client() else {
            self.discover_error = Some("Local engine is still starting.".into());
            cx.notify();
            return;
        };
        self.discover_active_topic = Some(clean.clone());
        self.discover_loading = true;
        self.discover_error = None;
        cx.notify();

        let query = clean.clone();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || {
                client.browse_discover(&query, &["youtube", "soundcloud", "rumble"], 12)
            })
            .await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                if this.discover_active_topic.as_deref() != Some(clean.as_str()) {
                    return;
                }
                this.discover_loading = false;
                match outcome {
                    Ok(browse) => {
                        let thumb_paths = collect_discover_thumbs(&browse.creators, &browse.items);
                        this.discover_browse = Some(browse);
                        this.discover_error = None;
                        this.prefetch_discover_thumbs(thumb_paths, cx);
                    }
                    Err(err) => {
                        this.discover_error = Some(err.into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn clear_discover_browse(&mut self, cx: &mut Context<Self>) {
        self.discover_active_topic = None;
        self.discover_browse = None;
        self.discover_error = None;
        if self.discover_feed.is_none() && !self.discover_loading {
            self.refresh_discover_feed(false, cx);
        } else {
            cx.notify();
        }
    }

    pub fn add_discover_item_to_library(
        &mut self,
        item: DiscoverItem,
        audio_override: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        let Some(client) = self.api_client() else {
            self.fail("Local engine is not ready yet.".into(), cx);
            return;
        };
        let audio = audio_override.unwrap_or(item.audio_only);
        let music = if audio {
            item.music.clone().or_else(|| {
                let artist = (!item.creator_name.trim().is_empty()).then(|| item.creator_name.clone());
                Some(MusicMeta {
                    title: Some(item.title.clone()),
                    artist,
                })
            })
        } else {
            item.music.clone()
        };
        let title = item.title.clone();
        let req = AcquireRequest {
            id: item.acquire_id.clone(),
            title: title.clone(),
            url: item.url.clone(),
            page: true,
            audio,
            music,
        };
        self.show_notice(format!("Saving “{title}” to your library…").into(), cx);

        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.acquire(&req)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| match outcome {
                Ok(job) => {
                    this.jobs.retain(|j| j.job_id != job.job_id);
                    this.jobs.insert(0, job);
                    this.had_active_jobs = true;
                    this.ensure_jobs_poller(cx);
                    cx.notify();
                }
                Err(err) => this.fail(err, cx),
            });
        })
        .detach();
    }

    fn prefetch_discover_thumbs(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        let mut to_fetch = Vec::new();
        for path in paths {
            if !path.starts_with("/v1/") {
                continue;
            }
            if self.discover_thumbs.contains_key(&path) || self.discover_thumbs_pending.contains(&path) {
                continue;
            }
            self.discover_thumbs_pending.insert(path.clone());
            to_fetch.push(path);
            if to_fetch.len() >= 48 {
                break;
            }
        }
        if to_fetch.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let fetched = run_blocking(move || {
                let mut results = Vec::with_capacity(to_fetch.len());
                for path in to_fetch {
                    let img = client.get_bytes(&path).ok().and_then(|bytes| {
                        let fmt = detect_image_format(&bytes)?;
                        Some(Arc::new(Image::from_bytes(fmt, bytes)))
                    });
                    results.push((path, img));
                }
                results
            })
            .await;
            let Ok(results) = fetched else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                let mut changed = false;
                for (path, maybe_img) in results {
                    this.discover_thumbs_pending.remove(&path);
                    if let Some(img) = maybe_img {
                        if this.discover_thumbs.len() >= 256 {
                            this.discover_thumbs.clear();
                        }
                        this.discover_thumbs.insert(path, img);
                        changed = true;
                    }
                }
                if changed {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    // ---- LUMEN v4.4 Discover tabs, live typeahead, music discovery & 30s previews ----

    pub fn set_discover_tab(&mut self, tab: DiscoverTab, cx: &mut Context<Self>) {
        if self.discover_tab == tab {
            return;
        }
        if self.discover_tab == DiscoverTab::Music && tab != DiscoverTab::Music {
            self.stop_music_preview(cx);
        }
        self.discover_tab = tab;
        if matches!(tab, DiscoverTab::Music | DiscoverTab::All)
            && self.discover_music.is_none()
            && !self.discover_music_loading
        {
            let mood = self.discover_music_mood.clone();
            self.load_music_discover(mood, String::new(), None, cx);
        }
        cx.notify();
    }

    pub fn clear_creator_suggestions(&mut self, cx: &mut Context<Self>) {
        self.discover_suggest_seq = self.discover_suggest_seq.wrapping_add(1);
        self.discover_suggest_busy = false;
        self.discover_suggestions.clear();
        cx.notify();
    }

    pub fn trigger_creator_typeahead(&mut self, raw: String, cx: &mut Context<Self>) {
        let trimmed = raw.trim().to_string();
        self.discover_suggest_seq = self.discover_suggest_seq.wrapping_add(1);
        let seq = self.discover_suggest_seq;

        let lower = trimmed.to_ascii_lowercase();
        let is_direct_url = lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("peartube:");
        if trimmed.chars().count() < 2 || is_direct_url {
            self.discover_suggest_busy = false;
            self.discover_suggestions.clear();
            cx.notify();
            return;
        }

        // Immediately surface matching local PearTube swarm channels while remote YouTube typeahead runs.
        let local_hits = self.matching_peartube_suggestions(&trimmed);
        self.discover_suggestions = local_hits.clone();
        self.discover_suggest_busy = true;
        cx.notify();

        let q = trimmed.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(280)).await;
            let still_current = this
                .read_with(cx, |this, _| this.discover_suggest_seq == seq)
                .unwrap_or(false);
            if !still_current {
                return;
            }
            let query_owned = q.clone();
            let remote = run_blocking(move || search_creators_typeahead(&query_owned))
                .await
                .unwrap_or_default();

            let _ = this.update(cx, |this, cx| {
                if this.discover_suggest_seq != seq {
                    return;
                }
                this.discover_suggest_busy = false;
                let mut merged = remote;
                for local in this.matching_peartube_suggestions(&q) {
                    if !merged.iter().any(|m| m.url == local.url) {
                        merged.push(local);
                    }
                }
                let avatar_urls: Vec<String> = merged
                    .iter()
                    .map(|c| c.avatar_url.clone())
                    .filter(|u| u.starts_with("https://"))
                    .collect();
                this.discover_suggestions = merged;
                this.prefetch_external_thumbs(avatar_urls, cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn matching_peartube_suggestions(&self, query: &str) -> Vec<CreatorSuggestion> {
        let needle = query.trim().trim_start_matches('@').to_ascii_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let Some(status) = &self.status else {
            return Vec::new();
        };
        status
            .discovered_sources
            .iter()
            .filter(|d| {
                d.title.to_ascii_lowercase().contains(&needle)
                    || d.key.to_ascii_lowercase().starts_with(&needle)
            })
            .take(3)
            .map(|d| {
                let name = if d.title.trim().is_empty() {
                    format!("{}…", &d.key[..8.min(d.key.len())])
                } else {
                    d.title.clone()
                };
                let via = if d.via.is_empty() { "Local network".to_string() } else { d.via.clone() };
                CreatorSuggestion {
                    source: "peartube".to_string(),
                    name,
                    handle: format!("{}…", &d.key[..10.min(d.key.len())]),
                    subtitle: format!("PearTube channel · {via}"),
                    url: format!("peartube://{}/{}?name={}", d.kind, d.key, d.title),
                    avatar_url: String::new(),
                }
            })
            .collect()
    }

    pub fn follow_creator_suggestion(&mut self, suggestion: CreatorSuggestion, cx: &mut Context<Self>) {
        self.clear_creator_suggestions(cx);
        self.discover_clear_input = true;
        if suggestion.source == "peartube" {
            self.open_uri_or_key(suggestion.url, cx);
            return;
        }
        let req = DiscoverFollowRequest {
            url: suggestion.url,
            source: Some(suggestion.source),
            name: Some(suggestion.name),
            channel_id: None,
            handle: (!suggestion.handle.is_empty()).then_some(suggestion.handle),
        };
        self.follow_discover_creator(req, true, cx);
    }

    pub fn library_seed_artists(&self) -> Vec<String> {
        self.catalog
            .artists
            .iter()
            .filter(|a| !a.name.trim().is_empty() && a.name != "Unknown artist")
            .take(8)
            .map(|a| a.name.clone())
            .collect()
    }

    pub fn load_music_discover(
        &mut self,
        mood: String,
        query: String,
        artist_focus: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.discover_music_seq = self.discover_music_seq.wrapping_add(1);
        let seq = self.discover_music_seq;
        self.discover_music_mood = mood.clone();
        self.discover_music_query = query.clone();
        self.discover_music_artist_focus = artist_focus;
        self.discover_music_loading = true;
        cx.notify();

        let seeds = self.library_seed_artists();
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || fetch_music_discover(&mood, &query, &seeds)).await;
            let _ = this.update(cx, |this, cx| {
                if this.discover_music_seq != seq {
                    return;
                }
                this.discover_music_loading = false;
                if let Ok(data) = res {
                    let mut art_urls = Vec::new();
                    for a in &data.artists {
                        if a.art_url.starts_with("https://") {
                            art_urls.push(a.art_url.clone());
                        }
                    }
                    for s in &data.songs {
                        if s.art_url.starts_with("https://") {
                            art_urls.push(s.art_url.clone());
                        }
                    }
                    for alb in &data.albums {
                        if alb.art_url.starts_with("https://") {
                            art_urls.push(alb.art_url.clone());
                        }
                    }
                    this.discover_music = Some(data);
                    this.prefetch_external_thumbs(art_urls, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn select_music_mood(&mut self, mood: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.discover_music_input
            .update(cx, |inp, cx| inp.set_value("", window, cx));
        self.load_music_discover(mood.to_string(), String::new(), None, cx);
    }

    pub fn explore_music_artist(&mut self, artist: String, window: &mut Window, cx: &mut Context<Self>) {
        let clean = artist.trim().to_string();
        if clean.is_empty() {
            return;
        }
        self.discover_tab = DiscoverTab::Music;
        self.discover_music_input
            .update(cx, |inp, cx| inp.set_value(clean.clone(), window, cx));
        let mood = self.discover_music_mood.clone();
        self.load_music_discover(mood, clean.clone(), Some(clean), cx);
    }

    pub fn search_music_discover_input(&mut self, cx: &mut Context<Self>) {
        let q = self.discover_music_input.read(cx).value().trim().to_string();
        let mood = self.discover_music_mood.clone();
        if q.is_empty() {
            self.load_music_discover(mood, String::new(), None, cx);
        } else {
            self.load_music_discover(mood, q, None, cx);
        }
    }

    pub fn stop_music_preview(&mut self, cx: &mut Context<Self>) {
        let had = self.preview_player.active_id().is_some() || self.preview_loading_id.is_some();
        self.preview_seq = self.preview_seq.wrapping_add(1);
        self.preview_player.stop();
        self.preview_loading_id = None;
        self.preview_poll = None;
        if had {
            cx.notify();
        }
    }

    pub fn toggle_song_preview(&mut self, song: SuggestedSong, cx: &mut Context<Self>) {
        if song.preview_url.is_empty() {
            self.show_notice("No 30-second preview available for this track.".into(), cx);
            return;
        }
        if self.preview_player.is_playing_id(&song.id) || self.preview_loading_id.as_deref() == Some(song.id.as_str()) {
            self.stop_music_preview(cx);
            return;
        }

        // Pause real library music and any minimized video cleanly before starting preview.
        if self.music_is_playing() {
            self.music_audio.pause();
            self.music_state.playing = false;
            self.music_queue.saved_position_ms = self.music_state.position.as_millis() as u64;
            self.music_queue.save();
        }
        if let Some(mini) = &self.minimized_video {
            mini.update(cx, |p, cx| p.pause_playback(cx));
        }

        self.preview_player.stop();
        self.preview_seq = self.preview_seq.wrapping_add(1);
        let seq = self.preview_seq;
        let song_id = song.id.clone();
        let preview_url = song.preview_url.clone();
        self.preview_loading_id = Some(song_id.clone());
        cx.notify();

        cx.spawn(async move |this, cx| {
            let id_for_dl = song_id.clone();
            let dl = run_blocking(move || download_preview_m4a(&preview_url, &id_for_dl)).await;
            let _ = this.update(cx, |this, cx| {
                if this.preview_seq != seq {
                    if let Ok(Ok(path)) = dl {
                        let _ = std::fs::remove_file(path);
                    }
                    return;
                }
                this.preview_loading_id = None;
                match dl {
                    Ok(Ok(path)) => match this.preview_player.play_file(song_id.clone(), path) {
                        Ok(()) => {
                            this.ensure_preview_poller(cx);
                        }
                        Err(err) => {
                            this.show_notice(err.into(), cx);
                        }
                    },
                    Ok(Err(err)) | Err(err) => {
                        this.show_notice(err.into(), cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn ensure_preview_poller(&mut self, cx: &mut Context<Self>) {
        self.preview_poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(500)).await;
                let keep_going = this
                    .update(cx, |this, cx| {
                        if this.preview_player.poll_finished() {
                            cx.notify();
                            return false;
                        }
                        this.preview_player.active_id().is_some()
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        }));
    }

    pub fn video_poster_image(&self, tile: &crate::catalog::VideoTile) -> Option<Arc<Image>> {
        let imdb = tile.imdb.as_deref()?;
        let url = crate::api::imdb_poster_url(imdb)?;
        self.discover_thumbs.get(&url).cloned()
    }

    pub fn video_backdrop_image(&self, imdb: Option<&str>) -> Option<Arc<Image>> {
        let url = crate::api::imdb_backdrop_url(imdb?)?;
        self.discover_thumbs.get(&url).cloned()
    }

    pub fn prefetch_catalog_posters(&mut self, cx: &mut Context<Self>) {
        let mut urls = Vec::new();
        for tile in self.catalog.movies.iter().chain(self.catalog.series.iter()).take(12) {
            if let Some(imdb) = tile.imdb.as_deref() {
                if let Some(bg) = crate::api::imdb_backdrop_url(imdb) {
                    urls.push(bg);
                }
            }
        }
        for tile in self.catalog.movies.iter().chain(self.catalog.series.iter()) {
            if let Some(imdb) = tile.imdb.as_deref() {
                if let Some(poster) = crate::api::imdb_poster_url(imdb) {
                    urls.push(poster);
                }
            }
        }
        if !urls.is_empty() {
            self.prefetch_external_thumbs(urls, cx);
        }
    }

    pub fn prefetch_external_thumbs(&mut self, urls: Vec<String>, cx: &mut Context<Self>) {
        let mut to_fetch = Vec::new();
        for url in urls {
            if !url.starts_with("https://") {
                continue;
            }
            if self.discover_thumbs.contains_key(&url)
                || self.discover_thumbs_pending.contains(&url)
                || self.discover_thumbs_failed.contains(&url)
            {
                continue;
            }
            self.discover_thumbs_pending.insert(url.clone());
            to_fetch.push(url);
            if to_fetch.len() >= 180 {
                break;
            }
        }
        if to_fetch.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            // Fetch in 6-wide parallel chunks and notify after each chunk so posters pop in
            // progressively within ~200 ms instead of waiting for the whole catalog.
            for chunk in to_fetch.chunks(6) {
                let batch: Vec<String> = chunk.to_vec();
                let fetched = run_blocking(move || {
                    std::thread::scope(|s| {
                        let handles: Vec<_> = batch
                            .iter()
                            .map(|u| {
                                let url = u.clone();
                                s.spawn(move || {
                                    let img = fetch_external_image_bytes(&url).ok().and_then(|bytes| {
                                        let fmt = detect_image_format(&bytes)?;
                                        Some(Arc::new(Image::from_bytes(fmt, bytes)))
                                    });
                                    (url, img)
                                })
                            })
                            .collect();
                        handles
                            .into_iter()
                            .filter_map(|h| h.join().ok())
                            .collect::<Vec<_>>()
                    })
                })
                .await;
                let Ok(results) = fetched else {
                    break;
                };
                let updated = this.update(cx, |this, cx| {
                    let mut changed = false;
                    for (url, maybe_img) in results {
                        this.discover_thumbs_pending.remove(&url);
                        if let Some(img) = maybe_img {
                            if this.discover_thumbs.len() < 1024 {
                                this.discover_thumbs.insert(url, img);
                                changed = true;
                            }
                        } else {
                            this.discover_thumbs_failed.insert(url);
                        }
                    }
                    if changed {
                        cx.notify();
                    }
                });
                if updated.is_err() {
                    break;
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
        self.load_soulseek_settings(window, cx);
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
        self.stop_music_preview(cx);
        self.close_minimized_video(window, cx);
        self.hood_open = false;
        self.cast_modal = None;
        self.add_modal = None;
        self.watch_cover_key = None;
        self.last_room_was_watch = true;

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
        self.player_observer = Some(cx.observe(&screen, |this, _, cx| {
            if this.minimized_video.is_some() {
                cx.notify();
            }
        }));
        self.player_events = Some(cx.subscribe_in(&screen, window, |this, _, event: &PlayEvent, window, cx| match event {
            PlayEvent::Back => {
                if this.minimized_video.is_some() && !matches!(this.screen, Screen::Play(_)) {
                    this.close_minimized_video(window, cx);
                } else {
                    this.close_player(window, cx);
                }
            }
            PlayEvent::Minimize => this.minimize_player(window, cx),
            PlayEvent::DismissCast => this.close_cast_modal(cx),
            PlayEvent::Progress(id, key, pos, dur) => {
                this.record_watch_progress(id.clone(), key.clone(), *pos, *dur);
            }
            PlayEvent::SwitchEntry(next_entry, pos_ms) => {
                let target = next_entry.clone();
                let at = *pos_ms;
                window.set_background_appearance(WindowBackgroundAppearance::Opaque);
                this.player_events = None;
                this.player_observer = None;
                this.play(target, at, window, cx);
            }
            PlayEvent::Cast(entry, pos_ms) => {
                this.open_cast_sheet(Some((entry.key.clone(), entry.title.clone(), *pos_ms)), window, cx);
            }
        }));
        self.screen = Screen::Play(screen);
        cx.notify();
    }

    pub fn minimize_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(self.screen, Screen::Play(_)) {
            return;
        }
        if window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        let prev = std::mem::replace(&mut self.screen, Screen::List);
        if let Screen::Play(play) = prev {
            play.update(cx, |p, cx| p.set_minimized(true, cx));
            self.minimized_video = Some(play);
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
        }
        self.cast_modal = None;
        cx.notify();
    }

    pub fn restore_minimized_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(play) = self.minimized_video.take() else {
            return;
        };
        self.stop_music_preview(cx);
        self.hood_open = false;
        self.cast_modal = None;
        self.add_modal = None;
        play.update(cx, |p, cx| {
            p.set_minimized(false, cx);
            p.focus_player(window, cx);
        });
        self.screen = Screen::Play(play);
        cx.notify();
    }

    pub fn close_minimized_video(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(play) = self.minimized_video.take() {
            let (id, key, pos, dur) = play.read(cx).progress_snapshot();
            if dur > 0 {
                self.record_watch_progress(id, key, pos, dur);
            }
            drop(play);
            self.player_events = None;
            self.player_observer = None;
            window.set_background_appearance(WindowBackgroundAppearance::Opaque);
            cx.background_executor()
                .spawn(async move {
                    if let Ok(w) = worker() {
                        let _ = w.set_player_active(false).await;
                    }
                })
                .detach();
            cx.notify();
        }
    }

    fn close_player(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cast_modal = None;
        self.minimized_video = None;
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        self.player_events = None;
        self.player_observer = None;
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

    fn render_video_mini_player(&self, mini: &Entity<PlayScreen>, cx: &mut Context<Self>) -> impl IntoElement {
        let st = mini.read(cx);
        let entry = st.entry().clone();
        let playing = st.is_playing();
        let buffering = st.is_buffering();
        let pos = st.position();
        let dur = st.duration();
        let ratio = dur
            .filter(|d| !d.is_zero())
            .map(|d| (pos.as_secs_f32() / d.as_secs_f32()).clamp(0.0, 1.0))
            .unwrap_or(0.0);
        let time_txt = match dur {
            Some(d) => format!("{} / {}", clock(pos), clock(d)),
            None => clock(pos),
        };
        let title = if !entry.base_title.is_empty() {
            entry.base_title.clone()
        } else {
            entry.title.clone()
        };
        let ep_badge = if entry.season.is_some() {
            Some(label(&entry))
        } else {
            None
        };
        let status_txt = if buffering {
            "Buffering…"
        } else if playing {
            "Playing"
        } else {
            "Paused"
        };
        let placer = mini.downgrade();
        let mini_for_play = mini.clone();
        let mini_for_back = mini.clone();
        let mini_for_fwd = mini.clone();

        h_flex()
            .id("video-mini-player")
            .w_full()
            .h(px(142.))
            .border_t_1()
            .border_color(GLASS_BORDER)
            // Left opaque frame margin
            .child(div().flex_none().w(px(12.)).h_full().bg(rgb(CARD)))
            // Live 224x126 16:9 transparent video cutout framed by opaque CARD strips top/bottom
            .child(
                v_flex()
                    .flex_none()
                    .w(px(224.))
                    .h_full()
                    .child(div().w_full().h(px(8.)).bg(rgb(CARD)))
                    .child(
                        div()
                            .id("mini-video-viewport")
                            .relative()
                            .w(px(224.))
                            .h(px(126.))
                            .bg(transparent_black())
                            .border_1()
                            .border_color(hsla(0., 0., 1., 0.16))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.restore_minimized_video(window, cx);
                            }))
                            .child(
                                canvas(
                                    move |bounds, window, cx| {
                                        let _ = placer.update(cx, |p, _| p.place_mini(bounds, window));
                                    },
                                    |_, _, _, _| {},
                                )
                                .absolute()
                                .size_full(),
                            ),
                    )
                    .child(div().w_full().h(px(8.)).bg(rgb(CARD))),
            )
            // Right opaque controls surface
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .bg(rgb(CARD))
                    .px_5()
                    .py_3()
                    .justify_between()
                    .child(
                        h_flex()
                            .items_start()
                            .justify_between()
                            .gap_3()
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_0p5()
                                    .child(
                                        h_flex()
                                            .items_center()
                                            .gap_2()
                                            .child(
                                                div()
                                                    .size(px(7.))
                                                    .rounded(px(99.))
                                                    .bg(if playing { rgb(ACCENT) } else { rgb(DIM) }),
                                            )
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::BOLD)
                                                    .text_color(rgb(PEARL))
                                                    .truncate()
                                                    .child(title),
                                            )
                                            .when_some(ep_badge, |row, tag| {
                                                row.child(
                                                    div()
                                                        .px_2()
                                                        .py_0p5()
                                                        .rounded(px(6.))
                                                        .bg(hsla(256. / 360., 0.85, 0.72, 0.16))
                                                        .text_xs()
                                                        .font_weight(FontWeight::SEMIBOLD)
                                                        .text_color(rgb(BRAND_HOVER))
                                                        .child(tag),
                                                )
                                            }),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(rgb(DIM))
                                            .child(format!("{status_txt} · {time_txt}")),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_1()
                                    .child(
                                        Button::new("mini-expand")
                                            .ghost()
                                            .small()
                                            .icon(Icon::new(Lucide::Maximize2))
                                            .label("Expand")
                                            .tooltip("Return to full player")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.restore_minimized_video(window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("mini-close")
                                            .ghost()
                                            .small()
                                            .icon(IconName::Close)
                                            .tooltip("Close video")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.close_minimized_video(window, cx);
                                            })),
                                    ),
                            ),
                    )
                    // 2px hairline progress track
                    .child(
                        div()
                            .w_full()
                            .h(px(2.))
                            .rounded(px(99.))
                            .bg(hsla(0., 0., 1., 0.10))
                            .overflow_hidden()
                            .child(div().h_full().w(relative(ratio)).bg(rgb(BRAND))),
                    )
                    // Transport controls: -10s, Play/Pause, +10s
                    .child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        Button::new("mini-skip-back")
                                            .ghost()
                                            .small()
                                            .icon(Icon::new(Lucide::RotateCcw))
                                            .label("-10s")
                                            .on_click(move |_, _, cx| {
                                                mini_for_back.update(cx, |p, cx| p.skip_mini(false, cx));
                                            }),
                                    )
                                    .child(
                                        Button::new("mini-toggle-play")
                                            .primary()
                                            .small()
                                            .icon(Icon::new(if playing { Lucide::Pause } else { Lucide::Play }))
                                            .label(if playing { "Pause" } else { "Play" })
                                            .on_click(move |_, _, cx| {
                                                mini_for_play.update(cx, |p, cx| p.toggle_play_mini(cx));
                                            }),
                                    )
                                    .child(
                                        Button::new("mini-skip-fwd")
                                            .ghost()
                                            .small()
                                            .icon(Icon::new(IconName::RotateCw))
                                            .label("+10s")
                                            .on_click(move |_, _, cx| {
                                                mini_for_fwd.update(cx, |p, cx| p.skip_mini(true, cx));
                                            }),
                                    ),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(DIM))
                                    .child("Click preview or Expand to watch full screen"),
                            ),
                    ),
            )
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

async fn poll_network_status(this: WeakEntity<PearTube>, cx: &mut AsyncApp) {
    let mut tick_count: u64 = 0;
    loop {
        let (alive, animating) = this
            .read_with(cx, |this, _| {
                let on_net_canvas = matches!(this.screen, Screen::List)
                    && this.detail.is_none()
                    && matches!(this.room, Room::Network(NetworkTab::Globe | NetworkTab::Swarm));
                (true, on_net_canvas)
            })
            .unwrap_or((false, false));
        if !alive {
            break;
        }
        let step_ms = if animating { 120 } else { 2000 };
        cx.background_executor().timer(Duration::from_millis(step_ms)).await;
        if animating {
            tick_count = tick_count.wrapping_add(1);
            let _ = this.update(cx, |this, cx| {
                this.net_phase += 0.12;
                cx.notify();
            });
            // Poll real worker status roughly every ~2 seconds while animating.
            if !tick_count.is_multiple_of(16) {
                continue;
            }
        }
        let should_poll = this
            .read_with(cx, |this, _| {
                this.settings.has_sources() && !matches!(this.screen, Screen::Play(_))
            })
            .unwrap_or(false);
        if !should_poll {
            continue;
        }
        if let Ok(w) = worker()
            && let Ok(st) = w.status().await
        {
            let _ = this.update(cx, |this, cx| {
                this.record_status_sample(st);
                cx.notify();
            });
        }
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
                Ok(status) => this.record_status_sample(status),
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
                this.record_status_sample(status);
                this.catalog = build_catalog(&entries);
                this.entries = entries;
                this.prefetch_catalog_posters(cx);
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

fn collect_discover_thumbs(creators: &[DiscoverCreator], items: &[DiscoverItem]) -> Vec<String> {
    let mut paths = Vec::new();
    for item in items {
        if item.thumbnail.starts_with("/v1/") {
            paths.push(item.thumbnail.clone());
        }
    }
    for creator in creators {
        if creator.avatar.starts_with("/v1/") {
            paths.push(creator.avatar.clone());
        }
    }
    paths
}

fn detect_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    None
}

impl Render for PearTube {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some((entry, pos)) = self.pending_watch.take() {
            self.activate_entry(entry, Some(pos), window, cx);
        }
        if let Some(url) = self.pending_add_url.take() {
            self.open_add_modal_with_url(url, window, cx);
        }
        if self.discover_clear_input {
            self.discover_clear_input = false;
            self.discover_follow_input
                .update(cx, |inp, cx| inp.set_value("", window, cx));
        }
        let is_video = matches!(self.screen, Screen::Play(_));
        let is_list = matches!(self.screen, Screen::List);
        if !is_list && let Some(mini) = &self.minimized_video {
            mini.update(cx, |p, _| p.hide_mini_frame());
        }
        let screen = match &self.screen {
            Screen::List => self.render_list(window, cx).into_any_element(),
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
        let cover_popup = self
            .watch_cover_key
            .as_deref()
            .and_then(|key| self.render_watch_cover_modal(key, cx).map(IntoElement::into_any_element));
        let transparent_video = matches!(&self.screen, Screen::Play(play) if play.read(cx).has_picture());
        let video_mini_bar = if is_list {
            self.minimized_video
                .as_ref()
                .map(|mini| self.render_video_mini_player(mini, cx).into_any_element())
        } else {
            None
        };
        let transparent_root = transparent_video || video_mini_bar.is_some();
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
            .when(!transparent_root, |this| this.bg(rgb(BG)))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    if this.cast_modal.is_some() {
                        this.close_cast_modal(cx);
                    } else if this.add_modal.is_some() {
                        this.close_add_modal(cx);
                    } else if this.watch_cover_key.is_some() {
                        this.watch_cover_key = None;
                        cx.notify();
                    } else if this.hood_open {
                        this.hood_open = false;
                        cx.notify();
                    } else if !this.discover_suggestions.is_empty() {
                        this.clear_creator_suggestions(cx);
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
                    .when(!is_video, |d| d.bg(rgb(BG)))
                    .child(screen)
                    .when_some(cover_popup, |this, popup| this.child(popup))
                    .when_some(add_popup, |this, popup| this.child(popup))
                    .when_some(cast_popup, |this, popup| this.child(popup)),
            )
            .when_some(video_mini_bar, |this, bar| this.child(bar))
            .when_some(remote_bar, |this, bar| this.child(bar))
            .when_some(music_dock, |this, dock| this.child(dock))
    }
}
