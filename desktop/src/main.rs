//! PearTube for the Mac: a GPUI window over the P2P worklet (peartube::worker)
//! and peartube-media's player. It joins a tracker, lists its entries grouped
//! by title, and plays one in the window.

#![forbid(unsafe_code)]

mod app;
mod cast_screen;
mod list;
mod play;
mod qr;
mod settings_screen;
mod theme;
mod video;

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use gpui_kit::assets::{Assets, icon_assets};
use gpui_kit::base::Root;
use gpui_kit::*;

actions!(peartube, [Quit]);

// Cinema UI & player icons from Lucide.
icon_assets!(PlayerIcons, [
    Captions, Volume2, RotateCcw, Cast, Tv, TvMinimalPlay, QrCode, Info,
    Ellipsis, ChevronDown, ChevronRight, Sparkles, Share2, SlidersHorizontal, Check, Plus, Search, Download, X
]);
/// gpui-component's icons plus the player's.
struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match PlayerIcons.load(path)? {
            Some(svg) => Ok(Some(svg)),
            None => Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = Assets.list(path)?;
        paths.extend(PlayerIcons.list(path)?);
        Ok(paths)
    }
}

/// The one lock every launch takes before the worklet can open the Corestore. A second launch
/// fails here, raises the running app through LaunchServices, and exits without touching the
/// store (otherwise rocksdb reports "file descriptor could not be locked").
fn app_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PEARTUBE_STORAGE") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/PearTube"))
}

fn bundle_of(exe: &Path) -> Option<&Path> {
    exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))
}

fn hold_single_instance() -> Option<std::fs::File> {
    let dir = app_data_dir()?;
    let _ = std::fs::create_dir_all(&dir);
    let lock_path = dir.join("instance.lock");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .ok()?;
    match file.try_lock() {
        Ok(()) => Some(file),
        Err(_) => {
            // Another PearTube owns the store: raise it, do not start a second worklet.
            if let Ok(exe) = std::env::current_exe() {
                if let Some(bundle) = bundle_of(&exe) {
                    let _ = std::process::Command::new("open").arg("-a").arg(bundle).status();
                }
            }
            None
        }
    }
}

fn main() {
    let _instance_lock = match hold_single_instance() {
        Some(lock) => lock,
        None => return,
    };
    let (url_tx, url_rx) = futures_channel::mpsc::unbounded::<String>();
    for arg in std::env::args().skip(1) {
        if arg.starts_with("peartube:") {
            let _ = url_tx.unbounded_send(arg);
        }
    }
    // GPUI's default client is a null one: artwork never loads without this.
    let app = gpui_kit::application().with_assets(AppAssets);
    app.on_open_urls(move |urls| {
        for url in urls {
            let _ = url_tx.unbounded_send(url);
        }
    });
    let mut url_rx = Some(url_rx);
    app.run(move |cx: &mut App| {
        gpui_kit::init(cx);
        theme::apply(cx);
        play::bind_keys(cx);
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus([Menu { name: "PearTube".into(), items: vec![MenuItem::action("Quit PearTube", Quit)], disabled: false }]);
        cx.on_window_closed(|cx, _| cx.quit()).detach();

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(1000.), px(680.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some("PearTube".into()), appears_transparent: false, traffic_light_position: None }),
            window_min_size: Some(size(px(480.), px(360.))),
            app_id: Some("com.peartube.app".into()),
            ..Default::default()
        };
        let rx = url_rx.take().unwrap_or_else(|| futures_channel::mpsc::unbounded().1);
        cx.open_window(options, move |window, cx| {
            let view = cx.new(|cx| app::PearTube::new(rx, window, cx));
            cx.new(|cx| Root::new(view, window, cx).bg(transparent_black()))
        })
        .expect("open the window");
        cx.activate(true);
    });
}
