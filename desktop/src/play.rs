//! Fullscreen-first cinema player with an unobtrusive translucent Info, Formats & Episodes HUD overlay.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_channel::mpsc::unbounded;
use futures_util::StreamExt;
use futures_util::future::{Either, select};
use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
pub(crate) use peartube::playback::clock;
use peartube::playback::{track_label, CODECS, FULLSCREEN_COOLDOWN, SKIP};
use peartube::soundfont;
use peartube::worker::Entry;
use player::{AudioOutputMode, Event, FrameRateMode, Player, PlayerOptions, State, Track, TrackKind};

use crate::list::{format_bytes, label, origin};
use crate::theme::{ACCENT, BG, BRAND, CARD, CARD_ELEVATED, DANGER, DIM, INK, LINE};
use crate::video::VideoView;

const CONTEXT: &str = "Player";
const SHOW_FOR: Duration = Duration::from_secs(3);

actions!(player, [TogglePlay, SkipBack, SkipForward, ToggleFullscreen, Back]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("space", TogglePlay, Some(CONTEXT)),
        KeyBinding::new("left", SkipBack, Some(CONTEXT)),
        KeyBinding::new("right", SkipForward, Some(CONTEXT)),
        KeyBinding::new("f", ToggleFullscreen, Some(CONTEXT)),
        KeyBinding::new("escape", Back, Some(CONTEXT)),
    ]);
}

pub enum PlayEvent {
    Back,
    Cast(Entry, u64),
    DismissCast,
    SwitchEntry(Entry, u64),
    Progress(String, String, u64, u64),
}

pub struct PlayScreen {
    entry: Entry,
    episodes: Vec<Entry>,
    formats: Vec<Entry>,
    selected_season: u32,
    info_open: bool,
    cast_open: bool,
    pending_seek_ms: Option<u64>,
    audio_mode: AudioOutputMode,
    frame_rate_mode: FrameRateMode,
    prefer_fel_12bit: bool,
    last_progress_saved: Instant,
    player: Option<Arc<Player>>,
    video: Option<VideoView>,
    open_error: Option<String>,
    state: State,
    seek: Option<(Entity<SliderState>, Subscription)>,
    dragging: Option<f32>,
    controls_until: Instant,
    controls_drawn: bool,
    frame: Option<Bounds<Pixels>>,
    transparent_applied: bool,
    menu_open: bool,
    pending_click: Option<Task<()>>,
    last_fullscreen_at: Option<Instant>,
    focus: FocusHandle,
    _tick: Task<()>,
}

impl EventEmitter<PlayEvent> for PlayScreen {}

impl Drop for PlayScreen {
    fn drop(&mut self) {
        if let Some(player) = self.player.take() {
            std::thread::spawn(move || {
                drop(player);
                peartube::worker::release_unused_memory();
            });
        }
    }
}

impl PlayScreen {
    pub fn has_picture(&self) -> bool {
        self.state.video_size.is_some() && (!self.state.buffering || !self.state.position.is_zero())
    }


    pub fn current_position_ms(&self) -> u64 {
        self.player
            .as_ref()
            .map(|p| p.state().position.as_millis() as u64)
            .unwrap_or(self.state.position.as_millis() as u64)
    }

    pub fn entry_key(&self) -> &str {
        &self.entry.key
    }

    pub fn set_cast_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.cast_open != open {
            self.cast_open = open;
            if open {
                self.controls_until = Instant::now() + SHOW_FOR;
            }
            cx.notify();
        }
    }

    pub fn new(entry: Entry, start_pos_ms: u64, episodes: Vec<Entry>, formats: Vec<Entry>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (tx, mut events) = unbounded::<Event>();
        let (player, video, open_error) = match VideoView::open(window) {
            Ok(video) => {
                let options = PlayerOptions {
                    soundfont: soundfont::path(),
                    audio_mode: AudioOutputMode::Auto,
                    frame_rate_mode: FrameRateMode::Seamless,
                    prefer_fel_12bit: false,
                    steep_dsd_filter: true,
                    ..PlayerOptions::default()
                };
                let player = Player::open(&entry.stream_url, video.backend(), CODECS.clone(), options, move |event| {
                    let _ = tx.unbounded_send(event);
                });
                (Some(Arc::new(player)), Some(video), None)
            }
            Err(err) => (None, None, Some(err.into())),
        };
        let tick = cx.spawn_in(window, async move |this, cx| {
            loop {
                let beat = cx.background_executor().timer(Duration::from_millis(250));
                let ended = match select(events.next(), beat).await {
                    Either::Left((None, _)) => return,
                    Either::Left((Some(event), _)) => matches!(event, Event::Ended),
                    Either::Right(_) => false,
                };
                if this.update_in(cx, |this, window, cx| this.tick(ended, window, cx)).is_err() {
                    return;
                }
            }
        });
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let selected_season = entry.season.unwrap_or(1);
        PlayScreen {
            entry,
            episodes,
            formats,
            selected_season,
            info_open: false,
            cast_open: false,
            pending_seek_ms: (start_pos_ms > 0).then_some(start_pos_ms),
            audio_mode: AudioOutputMode::Auto,
            frame_rate_mode: FrameRateMode::Seamless,
            prefer_fel_12bit: false,
            last_progress_saved: Instant::now(),
            player,
            video,
            open_error,
            state: State::default(),
            seek: None,
            dragging: None,
            controls_until: Instant::now() + SHOW_FOR,
            controls_drawn: true,
            frame: None,
            transparent_applied: false,
            menu_open: false,
            pending_click: None,
            last_fullscreen_at: None,
            focus,
            _tick: tick,
        }
    }

    fn tick(&mut self, ended: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(player) = &self.player else { return };
        let prev = (self.has_picture(), self.state.buffering, self.state.error.is_some(), self.controls_drawn);
        self.state = player.state();
        if ended {
            if let Some(dur) = self.state.duration {
                cx.emit(PlayEvent::Progress(self.entry.id.clone(), self.entry.key.clone(), dur.as_millis() as u64, dur.as_millis() as u64));
            }
            return cx.emit(PlayEvent::Back);
        }
        if let (Some(ms), Some(_dur)) = (self.pending_seek_ms, self.state.duration) {
            self.pending_seek_ms = None;
            player.seek(Duration::from_millis(ms));
        }
        if let (None, Some(duration)) = (&self.seek, self.state.duration) {
            let seek = cx.new(|_| SliderState::new().min(0.).max(duration.as_secs_f32().max(1.)).step(1.));
            let subscription = cx.subscribe_in(&seek, window, Self::on_seek);
            self.seek = Some((seek, subscription));
        }
        let shown = self.controls_shown();
        self.controls_drawn = shown;
        if shown {
            self.sync_seek(window, cx);
        }
        if self.last_progress_saved.elapsed() >= Duration::from_secs(4)
            && let Some(dur) = self.state.duration
        {
            self.last_progress_saved = Instant::now();
            peartube::worker::release_unused_memory();
            cx.emit(PlayEvent::Progress(self.entry.id.clone(), self.entry.key.clone(), self.state.position.as_millis() as u64, dur.as_millis() as u64));
        }
        if shown || prev != (self.has_picture(), self.state.buffering, self.state.error.is_some(), shown) {
            cx.notify();
        }
    }

    fn reopen_with_quality(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(video) = &self.video else { return };
        let pos_ms = self.current_position_ms();
        if let Some(old) = self.player.take() {
            std::thread::spawn(move || drop(old));
        }
        let (tx, mut events) = unbounded::<Event>();
        let options = PlayerOptions {
            soundfont: soundfont::path(),
            audio_mode: self.audio_mode,
            frame_rate_mode: self.frame_rate_mode,
            prefer_fel_12bit: self.prefer_fel_12bit,
            steep_dsd_filter: true,
            ..PlayerOptions::default()
        };
        let player = Player::open(&self.entry.stream_url, video.backend(), CODECS.clone(), options, move |event| {
            let _ = tx.unbounded_send(event);
        });
        self.player = Some(Arc::new(player));
        self.pending_seek_ms = (pos_ms > 0).then_some(pos_ms);
        self._tick = cx.spawn_in(window, async move |this, cx| {
            loop {
                let beat = cx.background_executor().timer(Duration::from_millis(250));
                let ended = match select(events.next(), beat).await {
                    Either::Left((None, _)) => return,
                    Either::Left((Some(event), _)) => matches!(event, Event::Ended),
                    Either::Right(_) => false,
                };
                if this.update_in(cx, |this, window, cx| this.tick(ended, window, cx)).is_err() {
                    return;
                }
            }
        });
        self.controls_until = Instant::now() + SHOW_FOR;
        cx.notify();
    }

    fn sync_seek(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let (Some((seek, _)), None) = (&self.seek, self.dragging) {
            let at = self.state.position.as_secs_f32().floor();
            seek.update(cx, |seek, cx| {
                if seek.value().start() != at {
                    seek.set_value(at, window, cx);
                }
            });
        }
    }

    fn on_seek(&mut self, _: &Entity<SliderState>, event: &SliderEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.poke(window, cx);
        match event {
            SliderEvent::Change(at) => self.dragging = Some(at.start()),
            SliderEvent::Release(at) => {
                self.dragging = None;
                if let Some(player) = &self.player {
                    player.seek(Duration::from_secs_f32(at.start().max(0.)));
                }
            }
        }
        cx.notify();
    }

    fn poke(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let hidden = !self.controls_shown();
        self.controls_until = Instant::now() + SHOW_FOR;
        self.controls_drawn = true;
        if hidden {
            if let Some(p) = &self.player {
                self.state = p.state();
            }
            self.sync_seek(window, cx);
            cx.notify();
        }
    }

    fn controls_shown(&self) -> bool {
        self.info_open || self.cast_open || self.menu_open || self.dragging.is_some() || !self.state.playing || Instant::now() < self.controls_until
    }

    fn toggle_fullscreen_smooth(&mut self, window: &mut Window) {
        if self.last_fullscreen_at.is_some_and(|t| t.elapsed() < FULLSCREEN_COOLDOWN) {
            return;
        }
        self.last_fullscreen_at = Some(Instant::now());
        window.toggle_fullscreen();
    }

    pub(crate) fn click(&mut self, count: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window, cx);
        if self.cast_open {
            self.pending_click = None;
            cx.emit(PlayEvent::DismissCast);
            return;
        }
        if self.info_open {
            self.pending_click = None;
            self.info_open = false;
            cx.notify();
            return;
        }
        match count {
            1 => {
                // Wait briefly before toggling play/pause so a double-click maximizes/restores
                // without ever pausing audio, freezing video, or flashing the paused HUD.
                let wait = VideoView::double_click_interval();
                self.pending_click = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(wait).await;
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.pending_click = None;
                        this.toggle_play(window, cx);
                    });
                }));
            }
            2 => {
                self.pending_click = None;
                self.toggle_fullscreen_smooth(window);
            }
            _ => {
                self.pending_click = None;
            }
        }
    }

    fn toggle_play(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.poke(window, cx);
        let Some(player) = &self.player else { return };
        if player.state().playing { player.pause() } else { player.play() }
        self.state = player.state();
        cx.notify();
    }

    fn skip(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.poke(window, cx);
        let (Some(player), Some(duration)) = (&self.player, self.state.duration) else { return };
        let at = if forward { (self.state.position + SKIP).min(duration) } else { self.state.position.saturating_sub(SKIP) };
        player.seek(at);
    }

    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.cast_open {
            cx.emit(PlayEvent::DismissCast);
            return;
        }
        if self.info_open {
            self.info_open = false;
            cx.notify();
            return;
        }
        if window.is_fullscreen() {
            self.toggle_fullscreen_smooth(window);
            return;
        }
        if let Some(dur) = self.state.duration {
            cx.emit(PlayEvent::Progress(self.entry.id.clone(), self.entry.key.clone(), self.state.position.as_millis() as u64, dur.as_millis() as u64));
        }
        cx.emit(PlayEvent::Back);
    }

    pub(crate) fn place(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        let pic = self.has_picture();
        if self.frame != Some(bounds) {
            self.frame = Some(bounds);
            if let Some(video) = &self.video {
                let [x, y, w, h] = [bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height].map(|p| f64::from(f32::from(p)));
                video.set_frame([x, y, w, h]);
            }
        }
        if pic && !self.transparent_applied {
            self.transparent_applied = true;
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
        }
    }

    fn track_menu(&self, kind: TrackKind, button: Button, anchor: Anchor, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let player = Arc::downgrade(self.player.as_ref()?);
        let tracks: Vec<Track> = self.state.tracks.iter().filter(|t| t.kind == kind).cloned().collect();
        let current = if kind == TrackKind::Audio { self.state.audio } else { self.state.subtitle };
        let mut items: Vec<(String, Option<u32>, bool)> = Vec::new();
        match kind {
            TrackKind::Audio if tracks.len() < 2 => return None,
            TrackKind::Subtitle if tracks.is_empty() => return None,
            TrackKind::Subtitle => items.push(("Off".into(), None, current.is_none())),
            _ => {}
        }
        items.extend(tracks.iter().map(|t| (track_label(t), Some(t.stream), current == Some(t.stream))));
        let this = cx.entity().downgrade();
        let menu = button.dropdown_menu(move |menu, _, _| {
            items.iter().fold(menu, |menu, (lbl, stream, selected)| {
                let (player, stream) = (player.clone(), *stream);
                menu.item(PopupMenuItem::new(lbl.clone()).checked(*selected).on_click(move |_, _, _| {
                    let Some(player) = player.upgrade() else { return };
                    if kind == TrackKind::Audio { player.select_audio(stream) } else { player.select_subtitle(stream) }
                }))
            })
        });
        Some(menu.anchor(anchor).on_open_change(move |open, _, cx| {
            let _ = this.update(cx, |this, cx| {
                this.menu_open = *open;
                this.controls_until = Instant::now() + SHOW_FOR;
                cx.notify();
            });
        }))
    }

    fn render_info_drawer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let clean_title = self.entry.base_title.clone();
        let year = &self.entry.year;
        let seasons: Vec<u32> = self
            .episodes
            .iter()
            .filter_map(|e| e.season)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let active_season = if seasons.contains(&self.selected_season) {
            self.selected_season
        } else {
            seasons.first().copied().unwrap_or(1)
        };
        let visible_eps: Vec<Entry> = self
            .episodes
            .iter()
            .filter(|e| seasons.len() <= 1 || e.season.is_none_or(|s| s == active_season))
            .cloned()
            .collect();

        let video_tracks: Vec<&Track> = self.state.tracks.iter().filter(|t| t.kind == TrackKind::Video).collect();
        let audio_tracks: Vec<&Track> = self.state.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect();
        let sub_tracks: Vec<&Track> = self.state.tracks.iter().filter(|t| t.kind == TrackKind::Subtitle).collect();

        let active_video = self
            .state
            .video
            .and_then(|id| video_tracks.iter().copied().find(|t| t.stream == id))
            .or_else(|| video_tracks.first().copied());
        let active_audio = self
            .state
            .audio
            .and_then(|id| audio_tracks.iter().copied().find(|t| t.stream == id))
            .or_else(|| audio_tracks.first().copied());
        let active_sub = self.state.subtitle.and_then(|id| sub_tracks.iter().copied().find(|t| t.stream == id));

        let res_badge = self.state.video_size.and_then(|(w, h)| resolution_tier(w, h));
        let v_codec_badge = active_video.map(|t| pretty_codec(&t.codec));
        let a_codec_badge = active_audio.map(|t| pretty_codec(&t.codec));
        let dec_badge = self.state.video_decoder.as_deref().map(pretty_decoder);

        let color_suffix = match (self.state.video_bit_depth, self.state.video_chroma.as_deref()) {
            (Some(b), Some(c)) => format!(" · {b}-bit {c}"),
            (Some(b), None) => format!(" · {b}-bit"),
            _ => String::new(),
        };
        let picture_spec = match (self.state.video_size, &v_codec_badge) {
            (Some((w, h)), Some(vc)) => format!("{w} × {h} ({}) · {vc}{color_suffix}", aspect_label(w, h)),
            (Some((w, h)), None) => format!("{w} × {h} ({}){color_suffix}", aspect_label(w, h)),
            (None, Some(vc)) => format!("{vc}{color_suffix}"),
            (None, None) => "Probing stream…".into(),
        };
        let dynamic_spec = self.state.video_dynamic_range.clone().unwrap_or_else(|| "SDR".into());
        let decoder_spec = match &self.state.video_decoder {
            Some(dec) => format!("{dec} · {} dropped", self.state.dropped_frames),
            None => format!("{} dropped frames", self.state.dropped_frames),
        };
        let bitrate_spec = match self.state.duration {
            Some(dur) if dur.as_secs_f64() > 1.0 && self.entry.size > 0 => {
                let mbps = (self.entry.size as f64 * 8.0) / dur.as_secs_f64() / 1_000_000.0;
                format!("{mbps:.1} Mbps avg · {}", format_bytes(self.entry.size))
            }
            _ => format_bytes(self.entry.size),
        };
        let audio_spec = match active_audio {
            Some(a) => {
                let lang = a.language.as_deref().or(a.title.as_deref()).unwrap_or("Default").to_uppercase();
                let out_txt = self.state.audio_output.as_deref().map(|o| format!(" · {o}")).unwrap_or_default();
                format!("{lang} · {}{out_txt}", pretty_codec(&a.codec))
            }
            None => self.state.audio_output.clone().unwrap_or_else(|| "None".into()),
        };
        let sub_spec = if sub_tracks.is_empty() {
            "None".into()
        } else if let Some(s) = active_sub {
            let lang = s.language.as_deref().or(s.title.as_deref()).unwrap_or("Active").to_uppercase();
            format!("{lang} · {} (of {})", pretty_codec(&s.codec), sub_tracks.len())
        } else {
            let codecs: Vec<String> = sub_tracks.iter().map(|s| pretty_codec(&s.codec)).collect::<BTreeSet<_>>().into_iter().collect();
            format!("Off · {} available ({})", sub_tracks.len(), codecs.join(", "))
        };
        let storage_spec = if self.entry.local || (self.entry.size > 0 && self.entry.cached_bytes >= self.entry.size) {
            format!("Saved on device · {}", format_bytes(self.entry.size))
        } else if self.entry.cached_bytes > 0 && self.entry.size > 0 {
            let pct = ((self.entry.cached_bytes as f64 / self.entry.size as f64) * 100.0).round() as u64;
            format!("{} buffered ({pct}%)", format_bytes(self.entry.cached_bytes))
        } else {
            "Live P2P stream".into()
        };

        let mut badges: Vec<(String, u32)> = Vec::new();
        if let Some(r) = res_badge {
            badges.push((r.into(), BRAND));
        }
        if let Some(dr) = &self.state.video_dynamic_range {
            if dr != "SDR" {
                badges.push((dr.clone(), ACCENT));
            }
        }
        if let Some(vc) = v_codec_badge {
            badges.push((vc, INK));
        }
        if let Some(ac) = a_codec_badge {
            badges.push((ac, INK));
        }
        if let Some((dlbl, hw)) = dec_badge {
            badges.push((dlbl, if hw { ACCENT } else { DIM }));
        }
        let cur_pos_ms = self.state.position.as_millis() as u64;
        let current_key = self.entry.key.clone();
        let current_id = self.entry.id.clone();
        let player_weak = self.player.as_ref().map(Arc::downgrade);

        fenced(v_flex())
            .id("hud-info-drawer")
            .absolute()
            .top(px(58.))
            .right(px(20.))
            .w(px(400.))
            .rounded(px(20.))
            .bg(hsla(224. / 360., 0.34, 0.08, 0.95))
            .border_1()
            .border_color(hsla(0., 0., 1., 0.14))
            .shadow_xl()
            .p_5()
            .gap_4()
            .text_color(rgb(INK))
            .child(
                h_flex()
                    .justify_between()
                    .items_start()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(div().text_lg().font_weight(FontWeight::BOLD).child(clean_title))
                            .child(
                                div().text_xs().text_color(rgb(DIM)).child(match year {
                                    Some(y) => format!("{} · {y}", label(&self.entry)),
                                    None => label(&self.entry),
                                }),
                            ),
                    )
                    .child(
                        Button::new("hud-info-close")
                            .ghost()
                            .small()
                            .icon(IconName::Close)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.info_open = false;
                                cx.notify();
                            })),
                    ),
            )
            .when(!badges.is_empty(), |this| {
                this.child(
                    h_flex()
                        .gap_1p5()
                        .flex_wrap()
                        .children(badges.into_iter().map(|(txt, col)| {
                            div()
                                .px_2p5()
                                .py_1()
                                .rounded(px(8.))
                                .bg(hsla(0., 0., 1., 0.07))
                                .border_1()
                                .border_color(hsla(0., 0., 1., 0.10))
                                .text_xs()
                                .font_weight(FontWeight::BOLD)
                                .text_color(rgb(col))
                                .child(txt)
                        })),
                )
            })
            .child(
                v_flex()
                    .p_3p5()
                    .gap_2()
                    .rounded(px(14.))
                    .bg(hsla(0., 0., 0., 0.36))
                    .border_1()
                    .border_color(rgb(LINE))
                    .child(spec_row("Video", picture_spec))
                    .child(spec_row("Dynamic Range", dynamic_spec))
                    .child(spec_row("Decoder", decoder_spec))
                    .child(spec_row("Bitrate", bitrate_spec))
                    .child(spec_row("Audio", audio_spec))
                    .child(spec_row("Subtitles", sub_spec))
                    .child(spec_row("Source", storage_spec)),
            )
            .child({
                let cur_am = self.audio_mode;
                let cur_fr = self.frame_rate_mode;
                let cur_fel = self.prefer_fel_12bit;
                let am_chips: Vec<_> = [
                    (AudioOutputMode::Auto, "Auto"),
                    (AudioOutputMode::BitPerfectPcm, "Bit-Perfect"),
                    (AudioOutputMode::Passthrough, "Passthrough"),
                    (AudioOutputMode::Stereo, "Stereo"),
                ]
                .into_iter()
                .map(|(m, lbl)| {
                    let btn = Button::new(SharedString::from(format!("am-{lbl}"))).small().label(lbl);
                    let btn = if cur_am == m { btn.primary() } else { btn.ghost() };
                    btn.on_click(cx.listener(move |this, _, window, cx| {
                        if this.audio_mode != m {
                            this.audio_mode = m;
                            this.reopen_with_quality(window, cx);
                        }
                    }))
                })
                .collect();
                let fr_chips: Vec<_> = [
                    (FrameRateMode::Seamless, "VRR"),
                    (FrameRateMode::Exact, "Exact 24p"),
                    (FrameRateMode::Off, "Off"),
                ]
                .into_iter()
                .map(|(m, lbl)| {
                    let btn = Button::new(SharedString::from(format!("fr-{lbl}"))).small().label(lbl);
                    let btn = if cur_fr == m { btn.primary() } else { btn.ghost() };
                    btn.on_click(cx.listener(move |this, _, window, cx| {
                        if this.frame_rate_mode != m {
                            this.frame_rate_mode = m;
                            this.reopen_with_quality(window, cx);
                        }
                    }))
                })
                .collect();
                let fel_btn = {
                    let b = Button::new("fel-12bit").small().label("DV P7 FEL 12-bit");
                    let b = if cur_fel { b.primary() } else { b.ghost() };
                    b.on_click(cx.listener(|this, _, window, cx| {
                        this.prefer_fel_12bit = !this.prefer_fel_12bit;
                        this.reopen_with_quality(window, cx);
                    }))
                };
                v_flex()
                    .gap_1p5()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("LOSSLESS AUDIO & CADENCE"))
                    .child(h_flex().gap_1p5().flex_wrap().children(am_chips))
                    .child(h_flex().gap_1p5().flex_wrap().children(fr_chips).child(fel_btn))
            })
            .when(!self.state.chapters.is_empty(), |this| {
                let pw = player_weak.clone();
                let pos = self.state.position;
                let ch_chips: Vec<_> = self
                    .state
                    .chapters
                    .iter()
                    .enumerate()
                    .map(|(idx, ch)| {
                        let start = ch.start;
                        let active = pos >= ch.start && ch.end.is_none_or(|e| pos < e);
                        let title = ch.title.clone().unwrap_or_else(|| format!("Chapter {}", idx + 1));
                        let lbl = format!("{} · {}", clock(start), title);
                        let p = pw.clone();
                        let b = Button::new(SharedString::from(format!("chap-{idx}"))).small().label(lbl);
                        let b = if active { b.primary() } else { b.ghost() };
                        b.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(pl) = p.as_ref().and_then(|w| w.upgrade()) {
                                pl.seek(start);
                                this.controls_until = Instant::now() + SHOW_FOR;
                                cx.notify();
                            }
                        }))
                    })
                    .collect();
                this.child(
                    v_flex()
                        .gap_1p5()
                        .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("CHAPTERS"))
                        .child(div().id("hud-chap-scroll").max_h(px(120.)).overflow_y_scrollbar().child(h_flex().gap_1p5().flex_wrap().children(ch_chips))),
                )
            })
            .when(audio_tracks.len() > 1, |this| {
                let pw = player_weak.clone();
                let active_a = self.state.audio;
                let chips: Vec<_> = audio_tracks
                    .iter()
                    .map(|t| {
                        let stream = t.stream;
                        let sel = active_a == Some(stream);
                        let lbl = format!("{} · {}", t.language.as_deref().or(t.title.as_deref()).unwrap_or("Track").to_uppercase(), pretty_codec(&t.codec));
                        let p = pw.clone();
                        let btn = Button::new(SharedString::from(format!("insp-aud-{stream}"))).small().label(lbl);
                        let btn = if sel { btn.primary() } else { btn.ghost() };
                        btn.on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(pl) = p.as_ref().and_then(|w| w.upgrade()) {
                                pl.select_audio(Some(stream));
                                this.controls_until = Instant::now() + SHOW_FOR;
                                cx.notify();
                            }
                        }))
                    })
                    .collect();
                this.child(
                    v_flex()
                        .gap_1p5()
                        .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("AUDIO TRACKS"))
                        .child(h_flex().gap_1p5().flex_wrap().children(chips)),
                )
            })
            .when(self.formats.len() > 1, |this| {
                this.child(
                    v_flex()
                        .gap_1p5()
                        .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("VERSIONS"))
                        .children(self.formats.iter().cloned().map(|fmt| {
                            let selected = fmt.key == current_key;
                            let switch_fmt = fmt.clone();
                            h_flex()
                                .id(SharedString::from(format!("hud-fmt-{}", fmt.key)))
                                .justify_between()
                                .items_center()
                                .px_3()
                                .py_2()
                                .rounded(px(10.))
                                .bg(if selected { hsla(264. / 360., 0.8, 0.6, 0.22) } else { hsla(0., 0., 1., 0.04) })
                                .cursor_pointer()
                                .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                                .on_click(cx.listener(move |_, _, _, cx| {
                                    if !selected {
                                        cx.emit(PlayEvent::SwitchEntry(switch_fmt.clone(), cur_pos_ms));
                                    }
                                }))
                                .child(div().text_xs().font_weight(FontWeight::MEDIUM).child(format!("{} · {}", format_bytes(fmt.size), origin(&fmt))))
                                .when(selected, |r| r.child(Icon::new(Lucide::Check).text_color(rgb(BRAND))))
                        })),
                )
            })
            .when(self.episodes.len() > 1, |this| {
                this.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("EPISODES"))
                        .when(seasons.len() > 1, |this| {
                            this.child(
                                h_flex()
                                    .gap_1p5()
                                    .flex_wrap()
                                    .children(seasons.iter().copied().map(|s| {
                                        let sel = s == active_season;
                                        let btn = Button::new(SharedString::from(format!("hud-season-{s}"))).small().label(format!("S{s:02}"));
                                        let btn = if sel { btn.primary() } else { btn.ghost() };
                                        btn.on_click(cx.listener(move |this, _, _, cx| {
                                            this.selected_season = s;
                                            cx.notify();
                                        }))
                                    })),
                            )
                        })
                        .child(
                            div()
                                .id("hud-ep-scroll")
                                .max_h(px(176.))
                                .overflow_y_scrollbar()
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .children(visible_eps.into_iter().map(|ep| {
                                            let is_current = ep.id == current_id;
                                            let next_ep = ep.clone();
                                            let row_bg = if is_current { hsla(264. / 360., 0.8, 0.6, 0.22) } else { hsla(0., 0., 1., 0.04) };
                                            h_flex()
                                                .id(SharedString::from(format!("hud-ep-{}", ep.key)))
                                                .justify_between()
                                                .items_center()
                                                .px_3()
                                                .py_2()
                                                .rounded(px(10.))
                                                .bg(row_bg)
                                                .when(is_current, |r| r.border_1().border_color(rgb(BRAND)))
                                                .cursor_pointer()
                                                .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                                                .on_click(cx.listener(move |_, _, _, cx| {
                                                    if !is_current {
                                                        cx.emit(PlayEvent::SwitchEntry(next_ep.clone(), 0));
                                                    }
                                                }))
                                                .child(
                                                    h_flex()
                                                        .items_center()
                                                        .gap_2p5()
                                                        .child(div().text_xs().font_weight(FontWeight::BOLD).child(label(&ep)))
                                                        .child(div().text_xs().text_color(rgb(DIM)).child(format_bytes(ep.size))),
                                                )
                                                .when(is_current, |r| r.child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(BRAND)).child("Playing")))
                                        })),
                                ),
                        ),
                )
            })
    }

    fn render_controls(&self, fullscreen: bool, clock: String, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.state.buffering && self.state.error.is_none();
        let shade = |angle: f32, alpha: f32| linear_gradient(angle, linear_color_stop(hsla(0., 0., 0., alpha), 0.), linear_color_stop(hsla(0., 0., 0., 0.), 1.));
        let overlay_button = |id: &'static str, icon: Icon, tooltip: &'static str| Button::new(id).ghost().icon(icon).tooltip(tooltip);

        let subtitles = self.track_menu(TrackKind::Subtitle, overlay_button("cc", Lucide::Captions.into(), "Subtitles"), Anchor::TopRight, cx);
        let audio = self.track_menu(TrackKind::Audio, overlay_button("audio", Lucide::Volume2.into(), "Audio"), Anchor::TopRight, cx);
        let ep_tag = self.entry.season.map(|_| format!(" · {}", label(&self.entry))).unwrap_or_default();

        v_flex()
            .absolute()
            .inset_0()
            .justify_between()
            .text_color(white())
            .child(
                fenced(h_flex())
                    .w_full()
                    .items_center()
                    .gap_1p5()
                    .px_3()
                    .py_2p5()
                    .bg(shade(180., 0.68))
                    .child(overlay_button("back", IconName::ArrowLeft.into(), "Back").on_click(cx.listener(|this, _, window, cx| this.back(window, cx))))
                    .child(div().flex_1().ml_2().truncate().font_weight(FontWeight::SEMIBOLD).child(format!("{}{ep_tag}", self.entry.title)))
                    .children(audio)
                    .children(subtitles)
                    .child({
                        let btn = Button::new("hud-cast").icon(Icon::new(Lucide::Cast)).tooltip("Play on TV");
                        let btn = if self.cast_open { btn.primary().small() } else { btn.ghost() };
                        btn.on_click(cx.listener(|this, _, _, cx| {
                            if this.cast_open {
                                cx.emit(PlayEvent::DismissCast);
                            } else {
                                cx.emit(PlayEvent::Cast(this.entry.clone(), this.current_position_ms()));
                            }
                        }))
                    })
                    .child({
                        let btn = Button::new("hud-info").icon(Icon::new(Lucide::Info)).tooltip(if self.episodes.len() > 1 { "Episodes & Info" } else { "Stream Info & Versions" });
                        let btn = if self.info_open { btn.primary().small() } else { btn.ghost() };
                        btn.on_click(cx.listener(|this, _, _, cx| {
                            this.info_open = !this.info_open;
                            this.controls_until = Instant::now() + SHOW_FOR;
                            cx.notify();
                        }))
                    }),
            )
            .child(
                h_flex()
                    .justify_center()
                    .gap_12()
                    .child(fenced(div()).child(
                        overlay_button("skip-back", Lucide::RotateCcw.into(), "Back 10 seconds")
                            .with_size(px(48.))
                            .on_click(cx.listener(|this, _, window, cx| this.skip(false, window, cx))),
                    ))
                    .child(if busy {
                        div().size(px(60.)).into_any_element()
                    } else {
                        let (icon, tooltip) = if self.state.playing { (IconName::Pause, "Pause") } else { (IconName::Play, "Play") };
                        fenced(div())
                            .child(
                                overlay_button("play", icon.into(), tooltip)
                                    .with_size(px(60.))
                                    .rounded(px(30.))
                                    .bg(hsla(0., 0., 0., 0.42))
                                    .on_click(cx.listener(|this, _, window, cx| this.toggle_play(window, cx))),
                            )
                            .into_any_element()
                    })
                    .child(fenced(div()).child(
                        overlay_button("skip-forward", IconName::RotateCw.into(), "Forward 10 seconds")
                            .with_size(px(48.))
                            .on_click(cx.listener(|this, _, window, cx| this.skip(true, window, cx))),
                    )),
            )
            .child(
                fenced(v_flex())
                    .w_full()
                    .px_4()
                    .pb_3()
                    .bg(shade(0., 0.78))
                    .child(
                        h_flex()
                            .items_center()
                            .child(div().flex_1().ml_1().text_sm().child(clock))
                            .child(
                                overlay_button("fullscreen", if fullscreen { IconName::Minimize } else { IconName::Maximize }.into(), if fullscreen { "Windowed" } else { "Fullscreen" })
                                    .on_click(cx.listener(|this, _, window, _| this.toggle_fullscreen_smooth(window))),
                            ),
                    )
                    .child(div().h(px(20.)).flex().items_center().children(self.seek.as_ref().map(|(seek, _)| {
                        Slider::new(seek).bg(rgb(BRAND)).text_color(white())
                    }))),
            )
    }
}

impl Render for PlayScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fullscreen = window.is_fullscreen();
        let st = &self.state;
        let shown = self.dragging.map(Duration::from_secs_f32).unwrap_or(st.position);
        let clock = match st.duration {
            Some(duration) => format!("{} / {}", clock(shown), clock(duration)),
            None if st.buffering || st.position.is_zero() => "Loading…".into(),
            None => clock(st.position),
        };
        let busy = st.buffering && st.error.is_none();
        let error = self.open_error.clone().or_else(|| st.error.clone().map(Into::into));
        let (placer, mover) = (cx.entity().downgrade(), cx.entity().downgrade());

        let has_pic = self.has_picture();
        let slot = div()
            .id("video")
            .relative()
            .size_full()
            // Keep a velvet black cinema curtain until the decoder actually presents its first frame,
            // preventing any frozen Library frame or Metal swapchain flash during the transition!
            .when(!has_pic, |this| this.bg(black()))
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let _ = placer.update(cx, |this, _| this.place(bounds, window));
                    },
                    move |bounds, _, window, _| {
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Bubble && bounds.contains(&event.position) {
                                let _ = mover.update(cx, |this, cx| this.poke(window, cx));
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
            .on_click(cx.listener(|this, event: &ClickEvent, window, cx| this.click(event.click_count(), window, cx)))
            .when(busy || (!has_pic && error.is_none()), |this| {
                this.child(div().absolute().inset_0().flex().items_center().justify_center().child(Spinner::new().large().color(white())))
            })
            .when_some(error, |this, error| {
                this.child(div().absolute().inset_0().bg(rgb(BG)).flex().items_center().justify_center().child(div().p_4().rounded(px(14.)).bg(rgb(CARD)).text_color(rgb(DANGER)).child(error)))
            })
            .when(self.controls_shown(), |this| this.child(self.render_controls(fullscreen, clock, cx)))
            .when(self.info_open, |this| this.child(self.render_info_drawer(cx)));

        v_flex()
            .size_full()
            .track_focus(&self.focus)
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &TogglePlay, window, cx| this.toggle_play(window, cx)))
            .on_action(cx.listener(|this, _: &SkipBack, window, cx| this.skip(false, window, cx)))
            .on_action(cx.listener(|this, _: &SkipForward, window, cx| this.skip(true, window, cx)))
            .on_action(cx.listener(|this, _: &ToggleFullscreen, window, _| this.toggle_fullscreen_smooth(window)))
            .on_action(cx.listener(|this, _: &Back, window, cx| this.back(window, cx)))
            .child(slot)
    }
}

fn fenced(element: Div) -> Div {
    element.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}


fn spec_row(k: &'static str, v: String) -> Div {
    h_flex()
        .justify_between()
        .items_baseline()
        .gap_3()
        .child(div().text_xs().text_color(rgb(DIM)).flex_shrink_0().child(k))
        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(INK)).text_right().truncate().child(v))
}

fn resolution_tier(w: u32, h: u32) -> Option<&'static str> {
    if w == 0 || h == 0 {
        None
    } else if w >= 3800 || h >= 2100 {
        Some("4K UHD")
    } else if w >= 2500 || h >= 1400 {
        Some("1440p QHD")
    } else if w >= 1900 || h >= 1000 {
        Some("1080p HD")
    } else if w >= 1200 || h >= 700 {
        Some("720p HD")
    } else {
        Some("SD")
    }
}

fn aspect_label(w: u32, h: u32) -> String {
    if h == 0 {
        return "—".into();
    }
    let r = w as f64 / h as f64;
    if (r - 16.0 / 9.0).abs() < 0.06 {
        "16:9".into()
    } else if (r - 4.0 / 3.0).abs() < 0.06 {
        "4:3".into()
    } else {
        format!("{r:.2}:1")
    }
}

fn pretty_codec(raw: &str) -> String {
    match raw.to_lowercase().as_str() {
        "hevc" | "h265" => "HEVC · H.265".into(),
        "h264" | "avc" | "avc1" => "AVC · H.264".into(),
        "av1" => "AV1".into(),
        "vp9" => "VP9".into(),
        "vp8" => "VP8".into(),
        "mpeg4" | "xvid" | "divx" => "MPEG-4".into(),
        "mpeg2video" | "mpeg2" => "MPEG-2".into(),
        "mpeg1video" | "mpeg1" => "MPEG-1".into(),
        "vc1" => "VC-1".into(),
        "eac3" | "ec-3" => "Dolby E-AC-3".into(),
        "ac3" => "Dolby AC-3".into(),
        "truehd" => "Dolby TrueHD".into(),
        "mlp" => "Meridian Lossless".into(),
        "dts" | "dca" => "DTS-HD / DTS".into(),
        "flac" => "FLAC Lossless".into(),
        "alac" => "ALAC Lossless".into(),
        "wavpack" => "WavPack Lossless".into(),
        "als" => "MPEG-4 ALS".into(),
        "ape" => "Monkey's Audio".into(),
        "tak" => "TAK Lossless".into(),
        "tta" => "True Audio".into(),
        "shorten" => "Shorten Lossless".into(),
        "dsd_lsbf" | "dsd_msbf" | "dsd_lsbf_planar" | "dsd_msbf_planar" => "DSD SACD".into(),
        "aac" => "AAC".into(),
        "opus" => "Opus".into(),
        "vorbis" => "Vorbis".into(),
        "mp3" => "MP3".into(),
        "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le" | "pcm_f64le" | "pcm" => "Linear PCM".into(),
        "subrip" | "srt" => "SubRip".into(),
        "ass" | "ssa" => "ASS".into(),
        "hdmv_pgs_subtitle" | "pgs" => "PGS".into(),
        "dvd_subtitle" | "vobsub" => "VobSub".into(),
        "mov_text" | "tx3g" => "TX3G".into(),
        other => other.to_uppercase(),
    }
}

fn pretty_decoder(dec: &str) -> (String, bool) {
    let lower = dec.to_lowercase();
    let hw = lower.contains("avplayer") || lower.contains("videotoolbox") || lower.contains("mediacodec") || lower.contains("hardware") || lower.contains("hw");
    (format!("{} · {dec}", if hw { "HW" } else { "SW" }), hw)
}
