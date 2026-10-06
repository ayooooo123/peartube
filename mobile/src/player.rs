//! In-app video through peartube-media's player: OxideAV codecs plus the
//! platform's own video decoders. Its picture is native, drawn over an empty
//! slot that the page lays out; the controls are in the page.

use dioxus::prelude::*;
use futures_channel::mpsc::unbounded;
use futures_util::StreamExt;
use oxideav_core::RuntimeContext;
use player::backend::Backend;
use player::{Event, Player, PlayerOptions, State, TrackKind};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

#[cfg(feature = "mobile")]
use dioxus::mobile as native;
#[cfg(not(feature = "mobile"))]
use dioxus::desktop as native;

/// Every container and decoder the player can use, built once.
static CODECS: LazyLock<Arc<RuntimeContext>> = LazyLock::new(|| Arc::new(codecs::context()));

/// Sends the video slot's rect, [left, top, width, height] in CSS pixels,
/// whenever it changes, until the slot leaves the page.
const TRACK_SLOT: &str = r#"
const slot = document.getElementById('video-slot')
let last = ''
const tick = () => {
  if (!slot.isConnected) return
  const r = slot.getBoundingClientRect()
  const rect = [r.left, r.top, r.width, r.height]
  if (rect.join() !== last) { last = rect.join(); dioxus.send(rect) }
  requestAnimationFrame(tick)
}
tick()
await new Promise(() => {})
"#;

fn clock(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

fn track_label(t: &player::Track) -> String {
    let mut label = t.title.clone().or_else(|| t.language.clone()).unwrap_or_else(|| format!("Track {}", t.stream));
    if t.title.is_some() {
        if let Some(lang) = &t.language {
            label = format!("{label} ({lang})");
        }
    }
    format!("{label} · {}", t.codec)
}

/// Plays `url` in a native view over the page's slot. Leaving the screen
/// (back, or the end of the video) closes it.
#[component]
pub fn VideoPlayer(url: String) -> Element {
    let host = use_hook(|| Host::open().map(Arc::new));
    let mut state = use_signal(State::default);
    // The seek bar's position, in ms, while it is dragged.
    let mut dragging = use_signal(|| None::<u64>);

    let player = use_hook(|| {
        let host = host.as_ref().ok()?.clone();
        let (tx, mut rx) = unbounded::<Event>();
        let player = Arc::new(Player::open(&url, host.backend(), CODECS.clone(), PlayerOptions::default(), move |event| {
            let _ = tx.unbounded_send(event);
        }));
        // Events come on change; the clock needs a steadier beat.
        let weak = Arc::downgrade(&player);
        spawn(async move {
            loop {
                let next = futures_util::future::select(rx.next(), Box::pin(tick())).await;
                let event = match next {
                    futures_util::future::Either::Left((None, _)) => return,
                    futures_util::future::Either::Left((Some(event), _)) => Some(event),
                    futures_util::future::Either::Right(_) => None,
                };
                let Some(p) = Weak::upgrade(&weak) else { return };
                state.set(p.state());
                if matches!(event, Some(Event::Ended)) {
                    go_back();
                    return;
                }
            }
        });
        Some(player)
    });

    // The worklet serving the stream suspends with the app.
    {
        let player = player.clone();
        native::use_wry_event_handler(move |event, _| {
            let Some(p) = player.as_ref() else { return };
            match event {
                native::tao::event::Event::Suspended => p.suspend(),
                native::tao::event::Event::Resumed => p.resume(),
                _ => {}
            }
        });
    }

    let st = state.read().clone();
    let length_ms = st.duration.map(|d| d.as_millis() as u64).unwrap_or(0);
    let shown_ms = dragging().unwrap_or(st.position.as_millis() as u64);
    let clock_text = match st.duration {
        Some(d) => format!("{} / {}", clock(Duration::from_millis(shown_ms)), clock(d)),
        None if st.buffering || st.position.is_zero() => "Loading…".to_string(),
        None => clock(st.position),
    };
    let audio: Vec<_> = st.tracks.iter().filter(|t| t.kind == TrackKind::Audio).cloned().collect();
    let subtitles: Vec<_> = st.tracks.iter().filter(|t| t.kind == TrackKind::Subtitle).cloned().collect();
    let error = match (&host, &st.error) {
        (Err(err), _) => Some(err.clone()),
        (_, Some(err)) => Some(err.clone()),
        _ => None,
    };

    let (p1, p2, p3, p4) = (player.clone(), player.clone(), player.clone(), player.clone());
    let host_for_slot = host.as_ref().ok().cloned();
    rsx! {
        div {
            id: "video-slot",
            class: "video-slot",
            onmounted: move |_| {
                let host = host_for_slot.clone();
                spawn(async move {
                    let mut slot = document::eval(TRACK_SLOT);
                    while let Ok(rect) = slot.recv::<[f64; 4]>().await {
                        if let Some(host) = &host {
                            host.set_frame(rect);
                        }
                    }
                });
            },
        }
        div { class: "player-controls",
            button {
                class: "icon-btn",
                disabled: player.is_none(),
                onclick: move |_| if let Some(p) = &p1 { if p.state().playing { p.pause() } else { p.play() }; state.set(p.state()) },
                if st.playing { "⏸" } else { "▶" }
            }
            input {
                class: "seek",
                r#type: "range",
                min: "0",
                max: "{length_ms}",
                value: "{shown_ms}",
                disabled: length_ms == 0,
                oninput: move |e| dragging.set(e.value().parse().ok()),
                onchange: move |e| {
                    if let (Some(p), Ok(ms)) = (&p2, e.value().parse::<u64>()) {
                        p.seek(Duration::from_millis(ms));
                    }
                    dragging.set(None);
                },
            }
            span { class: "clock", "{clock_text}" }
        }
        if audio.len() > 1 || !subtitles.is_empty() {
            div { class: "player-tracks",
                if audio.len() > 1 {
                    select {
                        class: "track-select",
                        onchange: move |e| if let (Some(p), Ok(s)) = (&p3, e.value().parse::<u32>()) { p.select_audio(Some(s)) },
                        for t in audio.iter() {
                            option { value: "{t.stream}", selected: st.audio == Some(t.stream), "Audio: {track_label(t)}" }
                        }
                    }
                }
                if !subtitles.is_empty() {
                    select {
                        class: "track-select",
                        onchange: move |e| if let Some(p) = &p4 { p.select_subtitle(e.value().parse::<u32>().ok()) },
                        option { value: "off", selected: st.subtitle.is_none(), "Subtitles: off" }
                        for t in subtitles.iter() {
                            option { value: "{t.stream}", selected: st.subtitle == Some(t.stream), "Subtitles: {track_label(t)}" }
                        }
                    }
                }
            }
        }
        if let Some(err) = error {
            div { class: "inline-error player-error", "{err}" }
        }
    }
}

async fn tick() {
    let (tx, rx) = futures_channel::oneshot::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let _ = tx.send(());
    });
    let _ = rx.await;
}

fn go_back() {
    #[cfg(target_os = "android")]
    let _ = crate::android_player::back();
    #[cfg(not(target_os = "android"))]
    let _ = document::eval("history.back()");
}

/// Where the picture goes. Dropping it takes the picture down.
pub struct Host {
    #[cfg(target_os = "android")]
    _open: (),
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    apple: crate::apple_view::AppleView,
}

impl Host {
    fn open() -> Result<Host, String> {
        #[cfg(target_os = "android")]
        {
            crate::android_player::open()?;
            Ok(Host { _open: () })
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            Ok(Host { apple: crate::apple_view::AppleView::open()? })
        }
        #[cfg(not(any(target_os = "android", target_os = "macos", target_os = "ios")))]
        {
            Err("No video output on this platform".into())
        }
    }

    fn backend(&self) -> Arc<dyn Backend> {
        #[cfg(target_os = "android")]
        {
            crate::android_player::backend()
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            self.apple.backend()
        }
        #[cfg(not(any(target_os = "android", target_os = "macos", target_os = "ios")))]
        {
            unreachable!("Host::open fails on this platform")
        }
    }

    fn set_frame(&self, rect: [f64; 4]) {
        #[cfg(target_os = "android")]
        let _ = crate::android_player::set_frame(rect);
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        self.apple.set_frame(rect);
        #[cfg(not(any(target_os = "android", target_os = "macos", target_os = "ios")))]
        let _ = rect;
    }
}

#[cfg(target_os = "android")]
impl Drop for Host {
    fn drop(&mut self) {
        let _ = crate::android_player::close();
    }
}
