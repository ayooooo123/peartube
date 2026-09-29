//! In-app video on macOS through the libVLC inside VLC.app. WebKit plays MP4
//! and WebM only, and relays mostly carry AVI and MKV. The video draws into a
//! native view that the app keeps over a slot in the page.

use std::ffi::{CString, c_char, c_int, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::LazyLock;

use futures_channel::mpsc::UnboundedSender;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::NSView;
use objc2_foundation::{NSPoint, NSRect, NSSize};

/// VLC.app's Contents/MacOS, which holds lib/ and plugins/.
static VLC_DIR: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
    let home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications"));
    [Some(PathBuf::from("/Applications")), home]
        .into_iter()
        .flatten()
        .map(|apps| apps.join("VLC.app/Contents/MacOS"))
        .find(|dir| dir.join("lib/libvlc.dylib").exists())
});

/// Points libVLC at VLC.app's plugins, which it finds only through the
/// environment. Call at the top of `main`, before any other thread starts.
pub fn init() {
    if let Some(dir) = VLC_DIR.as_ref()
        && std::env::var_os("VLC_PLUGIN_PATH").is_none()
    {
        // SAFETY: no other thread exists yet to read the environment.
        unsafe { std::env::set_var("VLC_PLUGIN_PATH", dir.join("plugins")) };
    }
}

pub fn installed() -> bool {
    VLC_DIR.is_some()
}

type Callback = unsafe extern "C" fn(*const c_void, *mut c_void);

struct Lib {
    instance: *mut c_void,
    media_new_location: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    media_release: unsafe extern "C" fn(*mut c_void),
    player_new_from_media: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    player_release: unsafe extern "C" fn(*mut c_void),
    set_nsobject: unsafe extern "C" fn(*mut c_void, *mut c_void),
    play: unsafe extern "C" fn(*mut c_void) -> c_int,
    set_pause: unsafe extern "C" fn(*mut c_void, c_int),
    stop: unsafe extern "C" fn(*mut c_void),
    get_state: unsafe extern "C" fn(*mut c_void) -> c_int,
    get_time: unsafe extern "C" fn(*mut c_void) -> i64,
    get_length: unsafe extern "C" fn(*mut c_void) -> i64,
    set_time: unsafe extern "C" fn(*mut c_void, i64),
    event_manager: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    event_attach: unsafe extern "C" fn(*mut c_void, c_int, Callback, *mut c_void) -> c_int,
}

// SAFETY: a libVLC instance and its functions may be used from any thread.
unsafe impl Send for Lib {}
unsafe impl Sync for Lib {}

static LIB: LazyLock<Result<Lib, String>> = LazyLock::new(load);

fn load() -> Result<Lib, String> {
    let dir = VLC_DIR.as_ref().ok_or("VLC is not installed")?;
    let open = |name: &str, flags| {
        let path = CString::new(dir.join("lib").join(name).as_os_str().as_bytes()).map_err(|err| err.to_string())?;
        // SAFETY: loads VLC's own library from its app bundle.
        let handle = unsafe { libc::dlopen(path.as_ptr(), flags) };
        if handle.is_null() { Err(format!("Could not load VLC's {name}")) } else { Ok(handle) }
    };
    // libvlc links libvlccore through @rpath, which resolves only once
    // libvlccore is already loaded.
    open("libvlccore.dylib", libc::RTLD_NOW | libc::RTLD_GLOBAL)?;
    let lib = open("libvlc.dylib", libc::RTLD_NOW)?;
    macro_rules! sym {
        ($name:literal) => {{
            // SAFETY: the name is NUL-terminated.
            let f = unsafe { libc::dlsym(lib, concat!($name, "\0").as_ptr().cast()) };
            if f.is_null() {
                return Err(format!("VLC lacks {}", $name));
            }
            // SAFETY: the field's type is the C signature of this libVLC 3 function.
            unsafe { std::mem::transmute::<*mut c_void, _>(f) }
        }};
    }
    let new: unsafe extern "C" fn(c_int, *const *const c_char) -> *mut c_void = sym!("libvlc_new");
    // No title over the video as it starts: for a stream it would be the URL.
    let args = [c"--no-video-title-show".as_ptr()];
    // SAFETY: args outlives the call.
    let instance = unsafe { new(args.len() as c_int, args.as_ptr()) };
    if instance.is_null() {
        return Err("VLC failed to start".into());
    }
    Ok(Lib {
        instance,
        media_new_location: sym!("libvlc_media_new_location"),
        media_release: sym!("libvlc_media_release"),
        player_new_from_media: sym!("libvlc_media_player_new_from_media"),
        player_release: sym!("libvlc_media_player_release"),
        set_nsobject: sym!("libvlc_media_player_set_nsobject"),
        play: sym!("libvlc_media_player_play"),
        set_pause: sym!("libvlc_media_player_set_pause"),
        stop: sym!("libvlc_media_player_stop"),
        get_state: sym!("libvlc_media_player_get_state"),
        get_time: sym!("libvlc_media_player_get_time"),
        get_length: sym!("libvlc_media_player_get_length"),
        set_time: sym!("libvlc_media_player_set_time"),
        event_manager: sym!("libvlc_media_player_event_manager"),
        event_attach: sym!("libvlc_event_attach"),
    })
}

// libvlc_state_t
const PLAYING: c_int = 3;
const ENDED: c_int = 6;
const ERROR: c_int = 7;

// libvlc_event_e: Playing, Paused, Stopped, EndReached, EncounteredError,
// TimeChanged, LengthChanged.
const EVENTS: [c_int; 7] = [260, 261, 262, 265, 266, 267, 273];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct State {
    /// Milliseconds.
    pub time: i64,
    pub length: i64,
    pub playing: bool,
    pub ended: bool,
    pub failed: bool,
}

pub struct Player {
    lib: &'static Lib,
    player: *mut c_void,
    parent: Retained<NSView>,
    view: Retained<NSView>,
    changed: *mut UnboundedSender<()>,
}

unsafe extern "C" fn on_event(_event: *const c_void, changed: *mut c_void) {
    // SAFETY: the sender lives until the player is released.
    let changed = unsafe { &*changed.cast::<UnboundedSender<()>>() };
    let _ = changed.unbounded_send(());
}

impl Player {
    /// Starts playing `url` in a new view inside `parent`. `changed` gets a
    /// message whenever the state may have changed.
    pub fn new(url: &str, parent: &NSView, changed: UnboundedSender<()>) -> Result<Player, String> {
        let lib = LIB.as_ref().map_err(String::clone)?;
        let mtm = MainThreadMarker::new().ok_or("The player runs on the main thread")?;
        let url = CString::new(url).map_err(|err| err.to_string())?;
        // SAFETY: each pointer is checked before use and the player owns them all.
        unsafe {
            let media = (lib.media_new_location)(lib.instance, url.as_ptr());
            if media.is_null() {
                return Err("VLC cannot open this stream".into());
            }
            let player = (lib.player_new_from_media)(media);
            (lib.media_release)(media);
            if player.is_null() {
                return Err("VLC cannot open this stream".into());
            }
            let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO);
            parent.addSubview(&view);
            (lib.set_nsobject)(player, Retained::as_ptr(&view) as *mut c_void);
            let changed = Box::into_raw(Box::new(changed));
            let events = (lib.event_manager)(player);
            for event in EVENTS {
                (lib.event_attach)(events, event, on_event, changed.cast());
            }
            (lib.play)(player);
            Ok(Player { lib, player, parent: parent.retain(), view, changed })
        }
    }

    /// Moves the video over a rect of the page, in CSS pixels from the
    /// webview's top left: [left, top, width, height].
    pub fn set_frame(&self, [left, top, width, height]: [f64; 4]) {
        let y = if self.parent.isFlipped() { top } else { self.parent.bounds().size.height - top - height };
        self.view.setFrame(NSRect::new(NSPoint::new(left, y), NSSize::new(width, height)));
    }

    pub fn state(&self) -> State {
        // SAFETY: the player is valid until drop.
        unsafe {
            let state = (self.lib.get_state)(self.player);
            State {
                time: (self.lib.get_time)(self.player).max(0),
                length: (self.lib.get_length)(self.player).max(0),
                playing: state == PLAYING,
                ended: state == ENDED,
                failed: state == ERROR,
            }
        }
    }

    /// Pauses, resumes, or after the end starts over.
    pub fn toggle(&self) {
        // SAFETY: the player is valid until drop.
        unsafe {
            if (self.lib.get_state)(self.player) == PLAYING {
                (self.lib.set_pause)(self.player, 1);
            } else {
                (self.lib.play)(self.player);
            }
        }
    }

    pub fn seek(&self, ms: i64) {
        // SAFETY: the player is valid until drop.
        unsafe { (self.lib.set_time)(self.player, ms) }
    }
}

/// libdispatch's main queue, `dispatch_get_main_queue()` in C.
#[repr(C)]
struct DispatchQueue([u8; 0]);

unsafe extern "C" {
    static _dispatch_main_q: DispatchQueue;
    fn dispatch_async_f(queue: *const DispatchQueue, context: *mut c_void, work: unsafe extern "C" fn(*mut c_void));
}

unsafe extern "C" fn release_view(view: *mut c_void) {
    // SAFETY: a reference from `Retained::into_raw` in `Player::drop`, released
    // here on the main queue.
    drop(unsafe { Retained::from_raw(view.cast::<NSView>()) });
}

impl Drop for Player {
    fn drop(&mut self) {
        self.view.removeFromSuperview();
        // VLC keeps only the view's pointer until its video output opens and
        // retains it, which may still be pending: hold a reference until the
        // player is released, then let it go on the main thread.
        let view = Retained::into_raw(self.view.clone()) as usize;
        let (lib, player, changed) = (self.lib, self.player as usize, self.changed as usize);
        // Stopping waits for VLC's video thread, which needs the main thread to
        // take its view down: stopping on the main thread could deadlock.
        std::thread::spawn(move || {
            // SAFETY: nothing else holds the player; after release no event
            // can reach the sender, and VLC no longer needs the view.
            unsafe {
                (lib.stop)(player as *mut c_void);
                (lib.player_release)(player as *mut c_void);
                drop(Box::from_raw(changed as *mut UnboundedSender<()>));
                dispatch_async_f(&raw const _dispatch_main_q, view as *mut c_void, release_view);
            }
        });
    }
}
