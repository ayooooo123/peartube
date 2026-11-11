//! Dedicated Dumb TV Receiver binary (`PearTubeReceiver`) for macOS / HTPC boxes:
//! opens into the 10-foot QR Cast Receiver screen + native OxideAV/AppleBackend player,
//! with full local playback controls (Play/Pause, ±10s, Seek bar, Audio/Subtitles menus,
//! Fullscreen, Stop) synced back to the casting device.

#![forbid(unsafe_code)]

mod qr;
mod theme;
mod video;

use std::borrow::Cow;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_channel::mpsc::unbounded;
use futures_util::StreamExt;
use gpui_kit::assets::Assets;
use gpui_kit::base::Root;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::playback::{clock, track_label, CODECS, FULLSCREEN_COOLDOWN, SKIP};
use peartube::soundfont;
use peartube::worker::{CastEntryMeta, Event as WorkerEvent, ReceiverCommand, ReceiverInfo, worker};
use player::{AudioOutputMode, Event, FrameRateMode, Player, PlayerOptions, State, Track, TrackKind};
use serde_json::json;

use crate::qr::qr_card;
use crate::theme::{ACCENT, BG, CARD, DANGER, DIM, INK, LINE};
use crate::video::VideoView;


const CONTEXT: &str = "TvReceiver";
const SHOW_HUD: Duration = Duration::from_secs(4);

actions!(tv_receiver, [Quit, TogglePlay, SkipBack, SkipForward, ToggleFullscreen, StopCast]);

struct ReceiverAssets;
impl AssetSource for ReceiverAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Assets.load(path)
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Assets.list(path)
    }
}


struct DumbTvApp {
    info: Option<ReceiverInfo>,
    entry: Option<CastEntryMeta>,
    mode: String,
    player: Option<Arc<Player>>,
    video: Option<VideoView>,
    state: State,
    seek: Option<(Entity<SliderState>, Subscription)>,
    dragging: Option<f32>,
    menu_open: bool,
    pending_click: Option<Task<()>>,
    last_fullscreen_at: Option<Instant>,
    error: Option<SharedString>,
    pending_seek_ms: Option<u64>,
    pending_cmds: Vec<ReceiverCommand>,
    hud_until: Instant,
    frame: Option<Bounds<Pixels>>,
    transparent_applied: bool,
    last_reported: Instant,
    focus: FocusHandle,
    _worker: Task<()>,
    _tick: Task<()>,
}

impl Drop for DumbTvApp {
    fn drop(&mut self) {
        if let Some(player) = self.player.take() {
            std::thread::spawn(move || drop(player));
        }
    }
}

impl DumbTvApp {
    fn new(name: String, open_auth: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);

        let worker_task = cx.spawn(async move |this, cx| {
            let w = match worker() {
                Ok(w) => w,
                Err(err) => {
                    let _ = this.update(cx, |this, cx| {
                        this.error = Some(err.into());
                        cx.notify();
                    });
                    return;
                }
            };
            let mut events = w.subscribe();
            match w.receiver_start(&name, open_auth).await {
                Ok(info) => {
                    let _ = this.update(cx, |this, cx| {
                        this.info = Some(info);
                        cx.notify();
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |this, cx| {
                        this.error = Some(err.into());
                        cx.notify();
                    });
                }
            }
            while let Some(ev) = events.next().await {
                match ev {
                    WorkerEvent::Cast(st) => {
                        if let Some(rm) = st.receiver_mode {
                            let _ = this.update(cx, |this, cx| {
                                this.info = Some(rm);
                                cx.notify();
                            });
                        }
                    }
                    WorkerEvent::ReceiverCommand(cmd) => {
                        let _ = this.update(cx, |this, cx| {
                            this.pending_cmds.push(cmd);
                            cx.notify();
                        });
                    }
                    WorkerEvent::Fatal(err) => {
                        let _ = this.update(cx, |this, cx| {
                            this.error = Some(err.into());
                            cx.notify();
                        });
                    }
                    WorkerEvent::Exited => break,
                    _ => {}
                }
            }
        });

        let tick = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(250)).await;
                if this.update_in(cx, |this, window, cx| this.tick(window, cx)).is_err() {
                    return;
                }
            }
        });

        DumbTvApp {
            info: None,
            entry: None,
            mode: "http".into(),
            player: None,
            video: None,
            state: State::default(),
            seek: None,
            dragging: None,
            menu_open: false,
            pending_click: None,
            last_fullscreen_at: None,
            error: None,
            pending_seek_ms: None,
            pending_cmds: Vec::new(),
            hud_until: Instant::now() + SHOW_HUD,
            frame: None,
            transparent_applied: false,
            last_reported: Instant::now(),
            focus,
            _worker: worker_task,
            _tick: tick,
        }
    }

    fn poke(&mut self, cx: &mut Context<Self>) {
        self.hud_until = Instant::now() + SHOW_HUD;
        cx.notify();
    }

    fn on_seek(&mut self, _: &Entity<SliderState>, event: &SliderEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.poke(cx);
        match event {
            SliderEvent::Change(at) => self.dragging = Some(at.start()),
            SliderEvent::Release(at) => {
                self.dragging = None;
                if let Some(player) = &self.player {
                    player.seek(Duration::from_secs_f32(at.start().max(0.)));
                    self.report_now(cx);
                }
            }
        }
        cx.notify();
    }

    fn apply_command(&mut self, cmd: ReceiverCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.hud_until = Instant::now() + SHOW_HUD;
        match cmd.action.as_str() {
            "load" => {
                let Some(url) = cmd.stream_url.or(cmd.http_stream_url) else { return };
                self.stop_playback(window);
                self.entry = cmd.entry;
                self.mode = cmd.mode.unwrap_or_else(|| "http".into());
                self.error = None;
                self.pending_seek_ms = (cmd.start_position_ms > 0).then_some(cmd.start_position_ms);
                let (tx, mut events) = unbounded::<Event>();
                match VideoView::open(window) {
                    Ok(video) => {
                        let options = PlayerOptions {
                            soundfont: soundfont::path(),
                            audio_mode: AudioOutputMode::Auto,
                            frame_rate_mode: FrameRateMode::Exact,
                            steep_dsd_filter: true,
                            ..PlayerOptions::default()
                        };
                        let player = Player::open(&url, video.backend(), CODECS.clone(), options, move |event| {
                            let _ = tx.unbounded_send(event);
                        });
                        self.player = Some(Arc::new(player));
                        self.video = Some(video);
                        cx.spawn_in(window, async move |this, cx| {
                            while let Some(ev) = events.next().await {
                                let ended = matches!(ev, Event::Ended);
                                if this
                                    .update_in(cx, |this, window, cx| {
                                        this.report_now(cx);
                                        if ended {
                                            this.finish_ended(window, cx);
                                        }
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        })
                        .detach();
                    }
                    Err(err) => self.error = Some(err.into()),
                }
            }
            "play" => if let Some(p) = &self.player { p.play() },
            "pause" => if let Some(p) = &self.player { p.pause() },
            "togglePlay" => if let Some(p) = &self.player {
                if p.state().playing { p.pause() } else { p.play() }
            },
            "seek" => if let (Some(p), Some(ms)) = (&self.player, cmd.position_ms) {
                p.seek(Duration::from_millis(ms));
            },
            "skip" => if let (Some(p), Some(delta)) = (&self.player, cmd.delta_ms) {
                let cur = p.state().position.as_millis() as i64;
                p.seek(Duration::from_millis((cur + delta).max(0) as u64));
            },
            "selectAudio" => if let (Some(p), Some(s)) = (&self.player, cmd.stream) {
                p.select_audio((s >= 0).then_some(s as u32));
            },
            "selectSubtitle" => if let (Some(p), Some(s)) = (&self.player, cmd.stream) {
                p.select_subtitle((s >= 0).then_some(s as u32));
            },
            "stop" => self.stop_playback(window),
            _ => {}
        }
        self.report_now(cx);
        cx.notify();
    }

    fn finish_ended(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Ok(w) = worker() {
            let payload = json!({
                "positionMs": self.state.duration.unwrap_or(self.state.position).as_millis() as u64,
                "durationMs": self.state.duration.map(|d| d.as_millis() as u64),
                "playing": false,
                "buffering": false,
                "ended": true,
            });
            cx.background_executor().spawn(async move { let _ = w.receiver_report_state(payload).await; }).detach();
        }
        self.stop_playback(window);
        cx.notify();
    }

    fn stop_playback(&mut self, window: &mut Window) {
        window.set_background_appearance(WindowBackgroundAppearance::Opaque);
        if let Some(p) = self.player.take() {
            std::thread::spawn(move || drop(p));
        }
        self.video = None;
        self.seek = None;
        self.dragging = None;
        self.menu_open = false;
        self.pending_click = None;
        self.frame = None;
        self.transparent_applied = false;
        self.entry = None;
        self.pending_seek_ms = None;
        self.state = State::default();
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(player) = &self.player else { return };
        self.state = player.state();
        if let (Some(ms), Some(_)) = (self.pending_seek_ms, self.state.duration) {
            self.pending_seek_ms = None;
            player.seek(Duration::from_millis(ms));
        }
        if let (None, Some(duration)) = (&self.seek, self.state.duration) {
            let seek = cx.new(|_| SliderState::new().min(0.).max(duration.as_secs_f32().max(1.)).step(1.));
            let subscription = cx.subscribe_in(&seek, window, Self::on_seek);
            self.seek = Some((seek, subscription));
        }
        if let (Some((seek, _)), None) = (&self.seek, self.dragging) {
            let at = self.state.position.as_secs_f32();
            seek.update(cx, |seek, cx| {
                if seek.value().start() != at {
                    seek.set_value(at, window, cx);
                }
            });
        }
        if self.last_reported.elapsed() >= Duration::from_millis(500) {
            self.last_reported = Instant::now();
            self.report_now(cx);
        }
        cx.notify();
    }

    fn report_now(&self, cx: &Context<Self>) {
        let Some(player) = &self.player else { return };
        let st = player.state();
        let tracks: Vec<_> = st
            .tracks
            .iter()
            .filter(|t| matches!(t.kind, TrackKind::Audio | TrackKind::Subtitle))
            .map(|t| {
                json!({
                    "stream": t.stream,
                    "kind": if t.kind == TrackKind::Audio { "audio" } else { "subtitle" },
                    "codec": t.codec,
                    "language": t.language,
                    "title": t.title,
                })
            })
            .collect();
        let chapters: Vec<_> = st
            .chapters
            .iter()
            .enumerate()
            .map(|(i, c)| {
                json!({
                    "title": c.title.clone().unwrap_or_else(|| format!("Chapter {}", i + 1)),
                    "startMs": c.start.as_millis() as u64,
                    "endMs": c.end.map(|e| e.as_millis() as u64),
                })
            })
            .collect();
        let payload = json!({
            "positionMs": st.position.as_millis() as u64,
            "durationMs": st.duration.map(|d| d.as_millis() as u64),
            "playing": st.playing,
            "buffering": st.buffering,
            "ended": false,
            "error": st.error,
            "tracks": tracks,
            "chapters": chapters,
            "audio": st.audio.map(|s| s as i32).unwrap_or(-1),
            "subtitle": st.subtitle.map(|s| s as i32).unwrap_or(-1),
            "videoDecoder": st.video_decoder,
            "videoDynamicRange": st.video_dynamic_range,
            "videoBitDepth": st.video_bit_depth,
            "videoChroma": st.video_chroma,
            "audioOutput": st.audio_output,
            "droppedFrames": st.dropped_frames,
        });
        if let Ok(w) = worker() {
            cx.background_executor().spawn(async move { let _ = w.receiver_report_state(payload).await; }).detach();
        }
    }

    fn track_menu(&self, kind: TrackKind, button: Button, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let player = Arc::downgrade(self.player.as_ref()?);
        let tracks: Vec<Track> = self.state.tracks.iter().filter(|t| t.kind == kind).cloned().collect();
        let current = if kind == TrackKind::Audio { self.state.audio } else { self.state.subtitle };
        let mut items: Vec<(String, Option<u32>, bool)> = Vec::new();
        match kind {
            TrackKind::Audio if tracks.is_empty() => return None,
            TrackKind::Subtitle if tracks.is_empty() => return None,
            TrackKind::Subtitle => items.push(("Subtitles Off".into(), None, current.is_none())),
            _ => {}
        }
        items.extend(tracks.iter().map(|t| (track_label(t), Some(t.stream), current == Some(t.stream))));
        let this_click = cx.entity().downgrade();
        let this_open = cx.entity().downgrade();
        let menu = button.dropdown_menu(move |menu, _, _| {
            items.iter().fold(menu, |menu, (lbl, stream, selected)| {
                let (player, stream, this_click) = (player.clone(), *stream, this_click.clone());
                menu.item(PopupMenuItem::new(lbl.clone()).checked(*selected).on_click(move |_, _, cx| {
                    if let Some(player) = player.upgrade() {
                        if kind == TrackKind::Audio { player.select_audio(stream) } else { player.select_subtitle(stream) }
                    }
                    let _ = this_click.update(cx, |this, cx| {
                        this.report_now(cx);
                        cx.notify();
                    });
                }))
            })
        });
        Some(menu.anchor(Anchor::BottomRight).on_open_change(move |open, _, cx| {
            let _ = this_open.update(cx, |this, cx| {
                this.menu_open = *open;
                this.hud_until = Instant::now() + SHOW_HUD;
                cx.notify();
            });
        }))
    }

    fn chapters_menu(&self, button: Button, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        if self.state.chapters.is_empty() {
            return None;
        }
        let player = Arc::downgrade(self.player.as_ref()?);
        let pos = self.state.position;
        let items: Vec<(String, Duration, bool)> = self
            .state
            .chapters
            .iter()
            .enumerate()
            .map(|(idx, c)| {
                let active = pos >= c.start && c.end.is_none_or(|e| pos < e);
                let title = c.title.clone().unwrap_or_else(|| format!("Chapter {}", idx + 1));
                (format!("{} · {title}", clock(c.start)), c.start, active)
            })
            .collect();
        let this_click = cx.entity().downgrade();
        let this_open = cx.entity().downgrade();
        let menu = button.dropdown_menu(move |menu, _, _| {
            items.iter().fold(menu, |menu, (lbl, start, active)| {
                let (player, start, this_click) = (player.clone(), *start, this_click.clone());
                menu.item(PopupMenuItem::new(lbl.clone()).checked(*active).on_click(move |_, _, cx| {
                    if let Some(player) = player.upgrade() {
                        player.seek(start);
                    }
                    let _ = this_click.update(cx, |this, cx| {
                        this.report_now(cx);
                        cx.notify();
                    });
                }))
            })
        });
        Some(menu.anchor(Anchor::BottomRight).on_open_change(move |open, _, cx| {
            let _ = this_open.update(cx, |this, cx| {
                this.menu_open = *open;
                this.hud_until = Instant::now() + SHOW_HUD;
                cx.notify();
            });
        }))
    }

    fn toggle_fullscreen_smooth(&mut self, window: &mut Window) {
        if self.last_fullscreen_at.is_some_and(|t| t.elapsed() < FULLSCREEN_COOLDOWN) {
            return;
        }
        self.last_fullscreen_at = Some(Instant::now());
        window.toggle_fullscreen();
    }

    fn place(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        if self.frame != Some(bounds) {
            self.frame = Some(bounds);
            if let Some(video) = &self.video {
                let [x, y, w, h] = [bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height].map(|p| f64::from(f32::from(p)));
                video.set_frame([x, y, w, h]);
            }
        }
        if self.video.is_some() && !self.transparent_applied {
            self.transparent_applied = true;
            window.set_background_appearance(WindowBackgroundAppearance::Transparent);
        }
    }
}

impl Render for DumbTvApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.pending_cmds.is_empty() {
            let cmds = std::mem::take(&mut self.pending_cmds);
            for cmd in cmds {
                self.apply_command(cmd, window, cx);
            }
        }
        let fullscreen = window.is_fullscreen();

        if self.player.is_none() {
            let name = self.info.as_ref().map(|i| i.name.clone()).unwrap_or_else(|| "PearTube Receiver".into());
            let uri = self.info.as_ref().map(|i| i.pairing_uri.clone()).unwrap_or_default();
            return v_flex()
                .size_full()
                .bg(rgb(BG))
                .text_color(rgb(INK))
                .track_focus(&self.focus)
                .key_context(CONTEXT)
                .on_action(cx.listener(|_, _: &ToggleFullscreen, window, _| window.toggle_fullscreen()))
                .items_center()
                .justify_center()
                .p_8()
                .child(
                    h_flex()
                        .w_full()
                        .max_w(px(780.))
                        .p_9()
                        .gap_8()
                        .items_center()
                        .rounded(px(26.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(if uri.is_empty() {
                            div().size(px(210.)).flex().items_center().justify_center().child(Spinner::new().large()).into_any_element()
                        } else {
                            qr_card(&uri, 210.).into_any_element()
                        })
                        .child(
                            v_flex()
                                .flex_1()
                                .gap_2p5()
                                .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(ACCENT)).child("READY TO CAST"))
                                .child(div().text_3xl().font_weight(FontWeight::BOLD).child(name))
                                .child(div().text_sm().text_color(rgb(DIM)).child("Open PearTube on your phone or Mac, click Cast, and choose this screen — or scan the QR code."))
                                .when_some(self.error.clone(), |this, err| this.child(div().text_xs().text_color(rgb(DANGER)).child(err)))
                                .child(
                                    h_flex().mt_2().child(
                                        Button::new("tv-fs-idle")
                                            .small()
                                            .ghost()
                                            .label(if fullscreen { "Exit Fullscreen (F)" } else { "Fullscreen (F)" })
                                            .on_click(cx.listener(|_, _, window, _| window.toggle_fullscreen())),
                                    ),
                                ),
                        ),
                )
                .into_any_element();
        }

        let playing = self.state.playing;
        let at_pos = self.dragging.map(|s| Duration::from_secs_f32(s.max(0.))).unwrap_or(self.state.position);
        let time_txt = match self.state.duration {
            Some(dur) => format!("{} / {}", clock(at_pos), clock(dur)),
            None => "Buffering…".into(),
        };
        let title = self.entry.as_ref().map(|e| e.title.clone()).unwrap_or_else(|| "PearTube Cast".into());
        let badge = match self.mode.as_str() {
            "private-p2p" => "PRIVATE 2-HOP P2P",
            "p2p" => "P2P SWARM PEER",
            _ => "LAN STREAM",
        };
        let show_hud = !playing || self.dragging.is_some() || self.menu_open || Instant::now() < self.hud_until;
        let busy = self.state.buffering && self.state.error.is_none();
        let seek_slider = self.seek.as_ref().map(|(s, _)| s.clone());
        let audio_menu = self.track_menu(TrackKind::Audio, Button::new("tv-audio").ghost().small().label("Audio"), cx);
        let sub_menu = self.track_menu(TrackKind::Subtitle, Button::new("tv-subs").ghost().small().label("Subtitles"), cx);
        let chap_menu = self.chapters_menu(Button::new("tv-chaps").ghost().small().label("Chapters"), cx);
        let signal_line = {
            let mut parts = Vec::new();
            if let Some((w, h)) = self.state.video_size {
                parts.push(format!("{w}×{h}"));
            }
            if let Some(dr) = &self.state.video_dynamic_range {
                parts.push(dr.clone());
            }
            if let Some(ao) = &self.state.audio_output {
                parts.push(ao.clone());
            }
            parts.join(" · ")
        };
        let (placer, mover) = (cx.entity().downgrade(), cx.entity().downgrade());

        v_flex()
            .size_full()
            .track_focus(&self.focus)
            .key_context(CONTEXT)
            .on_action(cx.listener(|this, _: &TogglePlay, _, cx| {
                this.poke(cx);
                if let Some(p) = &this.player {
                    if p.state().playing { p.pause() } else { p.play() }
                    this.report_now(cx);
                }
            }))
            .on_action(cx.listener(|this, _: &SkipBack, _, cx| {
                this.poke(cx);
                if let Some(p) = &this.player {
                    p.seek(p.state().position.saturating_sub(SKIP));
                    this.report_now(cx);
                }
            }))
            .on_action(cx.listener(|this, _: &SkipForward, _, cx| {
                this.poke(cx);
                if let (Some(p), Some(dur)) = (&this.player, this.state.duration) {
                    p.seek((p.state().position + SKIP).min(dur));
                    this.report_now(cx);
                }
            }))
            .on_action(cx.listener(|_, _: &ToggleFullscreen, window, _| window.toggle_fullscreen()))
            .on_action(cx.listener(|this, _: &StopCast, window, cx| {
                if window.is_fullscreen() {
                    window.toggle_fullscreen();
                    return;
                }
                this.stop_playback(window);
                if let Ok(w) = worker() {
                    let payload = json!({ "idle": true, "playing": false, "buffering": false, "ended": true, "positionMs": 0 });
                    cx.background_executor().spawn(async move { let _ = w.receiver_report_state(payload).await; }).detach();
                }
                cx.notify();
            }))
            .child(
                div()
                    .id("dumb-tv-video")
                    .relative()
                    .size_full()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, ev: &MouseDownEvent, window, cx| {
                            this.focus.focus(window, cx);
                            match ev.click_count {
                                1 => {
                                    let wait = VideoView::double_click_interval();
                                    this.pending_click = Some(cx.spawn_in(window, async move |this, cx| {
                                        cx.background_executor().timer(wait).await;
                                        let _ = this.update(cx, |this, cx| {
                                            this.pending_click = None;
                                            this.poke(cx);
                                            if let Some(p) = &this.player {
                                                if p.state().playing { p.pause() } else { p.play() }
                                                this.report_now(cx);
                                            }
                                        });
                                    }));
                                }
                                2 => {
                                    this.pending_click = None;
                                    this.toggle_fullscreen_smooth(window);
                                }
                                _ => {
                                    this.pending_click = None;
                                }
                            }
                        }),
                    )
                    .child(
                        canvas(
                            move |bounds, window, cx| {
                                let _ = placer.update(cx, |this, _| this.place(bounds, window));
                            },
                            move |bounds, _, window, _| {
                                window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                                    if phase == DispatchPhase::Bubble && bounds.contains(&event.position) {
                                        let _ = mover.update(cx, |this, cx| {
                                            this.hud_until = Instant::now() + SHOW_HUD;
                                            cx.notify();
                                        });
                                    }
                                });
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
                    .when(busy, |this| this.child(div().absolute().inset_0().flex().items_center().justify_center().child(Spinner::new().large().color(white()))))
                    .when(show_hud, |this| {
                        this.child(
                            v_flex()
                                .absolute()
                                .inset_0()
                                .justify_between()
                                .p_6()
                                .text_color(white())
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .items_center()
                                        .p_3p5()
                                        .rounded(px(14.))
                                        .bg(hsla(0., 0., 0., 0.68))
                                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                        .child(
                                            v_flex()
                                                .gap_0p5()
                                                .child(div().text_xl().font_weight(FontWeight::BOLD).child(title))
                                                .when(!signal_line.is_empty(), |this| {
                                                    this.child(div().text_xs().text_color(rgb(DIM)).child(signal_line))
                                                }),
                                        )
                                        .child(div().px_3().py_1().rounded(px(99.)).bg(hsla(142. / 360., 0.7, 0.4, 0.25)).text_xs().font_weight(FontWeight::BOLD).text_color(rgb(ACCENT)).child(badge)),
                                )
                                .child(
                                    v_flex()
                                        .gap_2p5()
                                        .p_4()
                                        .rounded(px(16.))
                                        .bg(hsla(0., 0., 0., 0.78))
                                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                        .when_some(seek_slider, |this, seek| this.child(Slider::new(&seek)))
                                        .child(
                                            h_flex()
                                                .justify_between()
                                                .items_center()
                                                .gap_3()
                                                .child(
                                                    h_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .child(
                                                            Button::new("tv-play")
                                                                .primary()
                                                                .small()
                                                                .label(if playing { "Pause" } else { "Play" })
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.poke(cx);
                                                                    if let Some(p) = &this.player {
                                                                        if p.state().playing { p.pause() } else { p.play() }
                                                                        this.report_now(cx);
                                                                    }
                                                                })),
                                                        )
                                                        .child(
                                                            Button::new("tv-back-10")
                                                                .ghost()
                                                                .small()
                                                                .label("-10s")
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.poke(cx);
                                                                    if let Some(p) = &this.player {
                                                                        p.seek(p.state().position.saturating_sub(SKIP));
                                                                        this.report_now(cx);
                                                                    }
                                                                })),
                                                        )
                                                        .child(
                                                            Button::new("tv-fwd-10")
                                                                .ghost()
                                                                .small()
                                                                .label("+10s")
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.poke(cx);
                                                                    if let (Some(p), Some(dur)) = (&this.player, this.state.duration) {
                                                                        p.seek((p.state().position + SKIP).min(dur));
                                                                        this.report_now(cx);
                                                                    }
                                                                })),
                                                        )
                                                        .child(div().ml_2().text_sm().child(time_txt)),
                                                )
                                                .child(
                                                    h_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .when_some(chap_menu, |this, m| this.child(m))
                                                        .when_some(audio_menu, |this, m| this.child(m))
                                                        .when_some(sub_menu, |this, m| this.child(m))
                                                        .child(Button::new("tv-stop").ghost().small().label("Stop").on_click(cx.listener(|this, _, window, cx| {
                                                            this.stop_playback(window);
                                                            if let Ok(w) = worker() {
                                                                let payload = json!({ "idle": true, "playing": false, "buffering": false, "ended": true, "positionMs": 0 });
                                                                cx.background_executor().spawn(async move { let _ = w.receiver_report_state(payload).await; }).detach();
                                                            }
                                                            cx.notify();
                                                        })))
                                                        .child(Button::new("tv-fs").ghost().small().icon(if fullscreen { IconName::Minimize } else { IconName::Maximize }).on_click(cx.listener(|_, _, window, _| window.toggle_fullscreen()))),
                                                ),
                                        ),
                                ),
                        )
                    }),
            )
            .into_any_element()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut name = std::env::var("PEARTUBE_RECEIVER_NAME").unwrap_or_else(|_| "PearTube Mac TV".into());
    let mut open_auth = std::env::var("PEARTUBE_RECEIVER_OPEN").map(|v| v != "0").unwrap_or(true);
    let mut start_fullscreen = std::env::var("PEARTUBE_FULLSCREEN").is_ok_and(|v| v == "1");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--fullscreen" => start_fullscreen = true,
            "--require-code" => open_auth = false,
            "--open" => open_auth = true,
            "--name" if i + 1 < args.len() => {
                name = args[i + 1].clone();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }

    let app = gpui_kit::application().with_assets(ReceiverAssets);
    app.run(move |cx: &mut App| {
        gpui_kit::init(cx);
        theme::apply(cx);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("space", TogglePlay, Some(CONTEXT)),
            KeyBinding::new("left", SkipBack, Some(CONTEXT)),
            KeyBinding::new("right", SkipForward, Some(CONTEXT)),
            KeyBinding::new("f", ToggleFullscreen, Some(CONTEXT)),
            KeyBinding::new("escape", StopCast, Some(CONTEXT)),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus([Menu { name: "PearTube Receiver".into(), items: vec![MenuItem::action("Quit PearTube Receiver", Quit)], disabled: false }]);
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        let bounds = Bounds::centered(None, size(px(1080.), px(640.)), cx);
        let options = WindowOptions {
            window_bounds: Some(if start_fullscreen { WindowBounds::Fullscreen(bounds) } else { WindowBounds::Windowed(bounds) }),
            titlebar: Some(TitlebarOptions { title: Some("PearTube Receiver".into()), appears_transparent: false, traffic_light_position: None }),
            window_min_size: Some(size(px(640.), px(400.))),
            app_id: Some("com.peartube.receiver".into()),
            ..Default::default()
        };
        let tv_name = name.clone();
        cx.open_window(options, move |window, cx| {
            let view = cx.new(|cx| DumbTvApp::new(tv_name, open_auth, window, cx));
            cx.new(|cx| Root::new(view, window, cx).bg(transparent_black()))
        })
        .expect("open receiver window");
        cx.activate(true);
    });
}
