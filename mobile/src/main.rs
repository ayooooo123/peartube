use dioxus::prelude::*;
use futures_channel::mpsc::UnboundedReceiver;
use futures_util::StreamExt;
#[cfg(target_os = "android")]
use peartube::android_vlc;
use peartube::settings::Settings;
#[cfg(target_os = "macos")]
use peartube::vlc;
use peartube::worker::{Entry, Event, Status, Worker, worker};
#[cfg(target_os = "macos")]
use std::rc::Rc;

#[cfg(feature = "mobile")]
use dioxus::mobile as native;
#[cfg(not(feature = "mobile"))]
use dioxus::desktop as native;

const CSS: Asset = asset!("/assets/main.css");

fn main() {
    // Before dioxus::launch starts the app's threads.
    #[cfg(target_os = "macos")]
    vlc::init();
    dioxus::launch(App);
}

#[derive(Clone, PartialEq)]
enum Screen {
    List,
    Settings,
    Play(Entry),
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB { format!("{:.1} GB", bytes as f64 / GB as f64) }
    else if bytes >= MB { format!("{:.1} MB", bytes as f64 / MB as f64) }
    else if bytes >= KB { format!("{:.1} KB", bytes as f64 / KB as f64) }
    else { format!("{bytes} B") }
}

fn label(id: &str) -> String {
    if let Some((_, s)) = id.rsplit_once(':') {
        let b = s.as_bytes();
        let valid = (b.len() == 6 || b.len() == 7)
            && (b[0] == b's' || b[0] == b'S')
            && b[1].is_ascii_digit() && b[2].is_ascii_digit()
            && (b[3] == b'e' || b[3] == b'E')
            && b[4].is_ascii_digit() && b[5].is_ascii_digit()
            && (b.len() == 6 || b[6].is_ascii_digit());
        if valid { return s.to_ascii_uppercase(); }
    }
    "Movie".to_string()
}

async fn refresh(
    worker: &'static Worker,
    settings: Signal<Settings>,
    mut status: Signal<Option<Status>>,
    mut entries: Signal<Vec<Entry>>,
    mut error: Signal<Option<String>>,
) {
    if settings.read().tracker.is_empty() { return; }
    match futures_util::join!(worker.status(), worker.search(None)) {
        (Ok(st), Ok(en)) => { status.set(Some(st)); entries.set(en); }
        (Err(err), _) | (_, Err(err)) => error.set(Some(err)),
    }
}

#[component]
fn App() -> Element {
    let settings = use_signal(Settings::load);
    let status = use_signal(|| None::<Status>);
    let entries = use_signal(Vec::<Entry>::new);
    let mut error = use_signal(|| None::<String>);
    let query = use_signal(String::new);
    let mut is_pushed = use_signal(|| false);
    let mut screen = use_signal(|| if settings.read().tracker.is_empty() { Screen::Settings } else { Screen::List });

    native::use_wry_event_handler(|event, _| match event {
        native::tao::event::Event::Suspended => if let Ok(w) = worker() { w.suspend(); },
        native::tao::event::Event::Resumed => if let Ok(w) = worker() { w.resume(); },
        _ => {}
    });

    use_hook(|| {
        spawn(async move {
            let mut eval = document::eval("window.addEventListener('popstate', () => dioxus.send(true)); await new Promise(() => {})");
            while let Ok(_) = eval.recv::<bool>().await {
                if !settings.read().tracker.is_empty() {
                    is_pushed.set(false);
                    screen.set(Screen::List);
                }
            }
        });
    });

    // Every start runs here. App never unmounts; a task spawned by the Settings
    // screen would be cancelled when Save closes that screen.
    let starter = use_coroutine(move |mut requests: UnboundedReceiver<Settings>| async move {
        while let Some(next) = requests.next().await {
            let w = match worker() {
                Ok(w) => w,
                Err(err) => {
                    error.set(Some(err));
                    continue;
                }
            };
            match w.start(&next).await {
                Ok(_) => refresh(w, settings, status, entries, error).await,
                Err(err) => error.set(Some(err)),
            }
        }
    });

    use_future(move || async move {
        let w = match worker() {
            Ok(w) => w,
            Err(err) => { error.set(Some(err)); return; }
        };
        // Subscribe first, so no update after the start is missed.
        let mut events = w.subscribe();
        let cur = settings.read().clone();
        if !cur.tracker.is_empty() {
            starter.send(cur);
        }
        // A burst of events costs one refresh.
        while let Some(mut event) = events.next().await {
            loop {
                match event {
                    Event::Update => {}
                    Event::Fatal(msg) => error.set(Some(msg)),
                    Event::Exited => {
                        error.set(Some("The P2P worker stopped".into()));
                        return;
                    }
                }
                match events.try_recv() {
                    Ok(next) => event = next,
                    Err(_) => break,
                }
            }
            refresh(w, settings, status, entries, error).await;
        }
    });

    rsx! {
        document::Stylesheet { href: CSS }
        document::Meta { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }
        if let Some(err) = error.read().as_ref() {
            div { class: "error-banner",
                span { "{err}" }
                button { class: "dismiss-btn", onclick: move |_| error.set(None), "×" }
            }
        }
        match screen.cloned() {
            Screen::List => rsx! { ListScreen { settings, status, entries, query, screen, is_pushed } },
            Screen::Play(entry) => rsx! { PlayScreen { entry } },
            Screen::Settings => rsx! { SettingsScreen { settings, status, entries, screen, is_pushed } },
        }
    }
}

#[component]
fn ListScreen(
    settings: Signal<Settings>,
    status: Signal<Option<Status>>,
    entries: Signal<Vec<Entry>>,
    mut query: Signal<String>,
    mut screen: Signal<Screen>,
    mut is_pushed: Signal<bool>,
) -> Element {
    let peers = status.read().as_ref().map_or(0, |s| s.peers + s.lan_peers);
    let bytes = status.read().as_ref().map_or(0, |s| s.blob_bytes);
    let tracker = status.read().as_ref().map(|s| s.tracker.clone()).unwrap_or_else(|| settings.read().tracker.clone());
    let t_short = if tracker.len() >= 8 { format!("{}…", &tracker[..8]) } else { tracker };
    let facts = format!("{peers} peers · {} · {t_short}", format_bytes(bytes));
    let lan = status.read().as_ref().and_then(|s| s.lan.clone());

    let q = query.read().to_lowercase();
    let all = entries.read();
    // Grouped by title: groups in case-insensitive order, episodes by id.
    let mut rows: Vec<&Entry> = all
        .iter()
        .filter(|e| q.is_empty() || e.title.to_lowercase().contains(&q) || e.id.to_lowercase().contains(&q))
        .collect();
    rows.sort_by_cached_key(|e| (e.title.to_lowercase(), e.title.as_str(), e.id.as_str()));

    rsx! {
        div { class: "header",
            div { class: "header-top",
                h1 { class: "header-title", "PearTube" }
                button { class: "icon-btn", onclick: move |_| {
                    let _ = document::eval("history.pushState(null, '')");
                    is_pushed.set(true);
                    screen.set(Screen::Settings);
                }, "⚙" }
            }
            p { class: "facts", "{facts}" }
            if let Some(lan) = lan {
                p { class: "facts", "LAN {lan}" }
            }
            input {
                class: "search-input",
                r#type: "search",
                placeholder: "Search title or ID…",
                initial_value: "{query}",
                oninput: move |e| query.set(e.value()),
            }
        }
        div { class: "list-content",
            if rows.is_empty() {
                if all.is_empty() {
                    if status.read().is_none() {
                        div { class: "empty-state", "Joining the tracker…" }
                    } else {
                        div { class: "empty-state", "Nothing in this tracker yet. Entries appear as relays announce them." }
                    }
                } else {
                    div { class: "empty-state", "No matching entries." }
                }
            } else {
                for group in rows.chunk_by(|a, b| a.title == b.title) {
                    div { key: "{group[0].title}",
                        h3 { class: "group-title", "{group[0].title}" }
                        div { class: "card-group",
                            for entry in group {
                                {
                                    let sub = format!("{} · {}", format_bytes(entry.size), if entry.local { "on this device" } else { "from peers" });
                                    let play_entry = Entry::clone(entry);
                                    rsx! {
                                        button {
                                            // The tracker key; an id can have several entries.
                                            key: "{entry.key}",
                                            class: "row",
                                            onclick: move |_| {
                                                let _ = document::eval("history.pushState(null, '')");
                                                screen.set(Screen::Play(play_entry.clone()));
                                            },
                                            span { class: "row-main", "{label(&entry.id)}" }
                                            span { class: "row-sub", "{sub}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn PlayScreen(entry: Entry) -> Element {
    let sha16 = if entry.sha256.len() >= 16 { &entry.sha256[..16] } else { &entry.sha256 };
    let origin = if entry.local { "on this device" } else { "from peers" };

    rsx! {
        div { class: "play-screen",
            div { class: "play-header",
                button { class: "icon-btn", onclick: move |_| { let _ = document::eval("history.back()"); }, "←" }
                h2 { class: "play-title", "{entry.title} ({label(&entry.id)})" }
            }
            {player(entry.stream_url.clone())}
            div { class: "play-meta", "{format_bytes(entry.size)} · {sha16} · {origin}" }
        }
    }
}

/// On macOS VLC plays everything when it is installed, and on Android the app's
/// own libVLC does. Otherwise the webview plays what it can: MP4 and WebM.
#[cfg(target_os = "macos")]
fn player(url: String) -> Element {
    if vlc::installed() { rsx! { VlcPlayer { key: "{url}", url } } } else { rsx! { WebPlayer { url } } }
}

#[cfg(target_os = "android")]
fn player(url: String) -> Element {
    rsx! { AndroidPlayer { key: "{url}", url } }
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
fn player(url: String) -> Element {
    rsx! { WebPlayer { url } }
}

/// Plays through the app's libVLC, in a native view that MainActivity keeps
/// over a slot in the page, as the macOS player does. Leaving the screen
/// (back, or the end of the video) closes it.
#[cfg(target_os = "android")]
#[component]
fn AndroidPlayer(url: String) -> Element {
    let opened = use_hook(|| android_vlc::play(&url));
    use_drop(|| {
        let _ = android_vlc::close();
    });
    rsx! {
        div {
            id: "video-slot",
            class: "video-slot",
            onmounted: move |_| {
                spawn(async move {
                    let mut slot = document::eval(TRACK_SLOT);
                    while let Ok(rect) = slot.recv::<[f64; 4]>().await {
                        let _ = android_vlc::set_frame(rect);
                    }
                });
            },
        }
        if let Err(err) = opened {
            div { class: "inline-error player-error", "{err}" }
        }
    }
}

#[cfg(not(target_os = "android"))]
#[component]
fn WebPlayer(url: String) -> Element {
    let mut failed = use_signal(|| false);
    let hint = if cfg!(target_os = "macos") { " Install VLC to play the rest here." } else { "" };
    rsx! {
        video {
            class: "video-player",
            src: "{url}",
            controls: true,
            autoplay: true,
            playsinline: true,
            onerror: move |_| failed.set(true),
        }
        if failed() {
            div { class: "video-error-box",
                p { "This file cannot play in the built-in player (it plays MP4 and WebM).{hint} Stream URL:" }
                code { class: "stream-url", "{url}" }
            }
        }
    }
}

/// Sends the video slot's rect, [left, top, width, height] in CSS pixels,
/// whenever it changes, until the slot leaves the page.
#[cfg(any(target_os = "macos", target_os = "android"))]
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

#[cfg(target_os = "macos")]
fn clock(ms: i64) -> String {
    let s = ms / 1000;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

/// Plays through libVLC. Its video is a native view over the page, so the page
/// lays out an empty slot for it and puts the controls below.
#[cfg(target_os = "macos")]
#[component]
fn VlcPlayer(url: String) -> Element {
    use native::wry::WebViewExtMacOS;

    let mut player = use_signal(|| None::<Rc<vlc::Player>>);
    let mut state = use_signal(vlc::State::default);
    let mut failure = use_signal(|| None::<String>);
    let mut frame = use_signal(|| None::<[f64; 4]>);
    // The seek bar's position while it is dragged.
    let mut dragging = use_signal(|| None::<i64>);

    use_future(move || {
        let url = url.clone();
        async move {
            let (changed, mut changes) = futures_channel::mpsc::unbounded();
            let webview = native::window().webview.webview();
            let p = match vlc::Player::new(&url, &webview, changed) {
                Ok(p) => Rc::new(p),
                Err(err) => return failure.set(Some(err)),
            };
            player.set(Some(p.clone()));
            // A burst of events costs one read.
            while changes.next().await.is_some() {
                while changes.try_recv().is_ok() {}
                state.set(p.state());
            }
        }
    });

    use_effect(move || {
        if let (Some(p), Some(rect)) = (player.read().as_ref(), *frame.read()) {
            p.set_frame(rect);
        }
    });

    let st = *state.read();
    let shown = dragging().unwrap_or(st.time);
    let clock_text = if st.length > 0 { format!("{} / {}", clock(shown), clock(st.length)) } else { "Loading…".to_string() };
    rsx! {
        div {
            id: "video-slot",
            class: "video-slot",
            onmounted: move |_| {
                spawn(async move {
                    let mut slot = document::eval(TRACK_SLOT);
                    while let Ok(rect) = slot.recv::<[f64; 4]>().await {
                        frame.set(Some(rect));
                    }
                });
            },
        }
        div { class: "player-controls",
            button {
                class: "icon-btn",
                disabled: player.read().is_none(),
                onclick: move |_| if let Some(p) = player.read().as_ref() { p.toggle() },
                if st.playing { "⏸" } else { "▶" }
            }
            input {
                class: "seek",
                r#type: "range",
                min: "0",
                max: "{st.length}",
                value: "{shown}",
                disabled: st.length == 0,
                oninput: move |e| dragging.set(e.value().parse().ok()),
                onchange: move |e| {
                    if let (Some(p), Ok(ms)) = (player.read().as_ref(), e.value().parse()) {
                        p.seek(ms);
                        // Paused, VLC reports no time until it plays again.
                        state.write().time = ms;
                    }
                    dragging.set(None);
                },
            }
            span { class: "clock", "{clock_text}" }
        }
        if let Some(err) = failure.read().as_ref() {
            div { class: "inline-error player-error", "{err}" }
        } else if st.failed {
            div { class: "inline-error player-error", "VLC could not play this stream." }
        }
    }
}

#[component]
fn SettingsScreen(
    mut settings: Signal<Settings>,
    mut status: Signal<Option<Status>>,
    mut entries: Signal<Vec<Entry>>,
    mut screen: Signal<Screen>,
    mut is_pushed: Signal<bool>,
) -> Element {
    let starter = use_coroutine_handle::<Settings>();
    let mut tracker = use_signal(|| settings.read().tracker.clone());
    let mut relays = use_signal(|| settings.read().relay_through.join(", "));
    let mut bootstrap = use_signal(|| settings.read().bootstrap.join(", "));
    let mut lan = use_signal(|| settings.read().lan_discovery);
    let mut inline_error = use_signal(|| None::<String>);

    let on_save = move |_| match Settings::parse(&tracker.read(), &relays.read(), &bootstrap.read(), lan()) {
        Err(err) => inline_error.set(Some(err)),
        Ok(new) => {
            if let Err(err) = new.save() { inline_error.set(Some(err)); return; }
            inline_error.set(None);
            settings.set(new.clone());
            status.set(None);
            entries.set(Vec::new());
            if *is_pushed.read() { is_pushed.set(false); let _ = document::eval("history.back()"); }
            else { screen.set(Screen::List); }
            starter.send(new);
        }
    };

    let has_tracker = !settings.read().tracker.is_empty();

    rsx! {
        div { class: "settings-screen",
            div { class: "settings-header",
                h2 { class: "header-title", "Settings" }
                if has_tracker {
                    button { class: "cancel-btn", onclick: move |_| { let _ = document::eval("history.back()"); }, "Cancel" }
                }
            }
            div { class: "settings-form",
                if let Some(err) = inline_error.read().as_ref() {
                    div { class: "inline-error", "{err}" }
                }
                div { class: "field-group",
                    label { class: "field-label", "Tracker key" }
                    div { class: "field-hint", "64 hex characters, from a relay's /v1/status" }
                    input { class: "text-input", initial_value: "{tracker}", autocapitalize: "off", spellcheck: "false", oninput: move |e| tracker.set(e.value()) }
                }
                div { class: "field-group",
                    label { class: "field-label", "Blind relays" }
                    div { class: "field-hint", "Optional relay keys, for networks where peers cannot connect directly" }
                    textarea { class: "text-input text-area", initial_value: "{relays}", autocapitalize: "off", spellcheck: "false", oninput: move |e| relays.set(e.value()) }
                }
                div { class: "field-group",
                    label { class: "field-label", "DHT bootstrap" }
                    div { class: "field-hint", "Optional host:port list for a private DHT. Empty uses the public DHT." }
                    textarea { class: "text-input text-area", initial_value: "{bootstrap}", autocapitalize: "off", spellcheck: "false", oninput: move |e| bootstrap.set(e.value()) }
                }
                div { class: "field-group",
                    label { class: "toggle",
                        input { r#type: "checkbox", checked: lan(), onchange: move |e| lan.set(e.checked()) }
                        "Find relays on this network"
                    }
                    div { class: "field-hint", "Over mDNS, on this device's Wi-Fi or Ethernet, for relays that run with PEARTUBE_LAN_HOST. Turn it on where peers on one network cannot reach each other through the internet." }
                }
                button { class: "save-btn", onclick: on_save, "Save" }
            }
        }
    }
}
