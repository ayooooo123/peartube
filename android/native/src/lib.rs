//! libpeartube.so: peartube-media's player for the Kotlin app, behind JNI for
//! `com.peartube.app.player.NativePlayer`. OxideAV codecs plus the platform's
//! own decoders; MediaCodec draws onto the app's SurfaceViews, AAudio plays.
//!
//! A player is a handle (a boxed `Player`). Surfaces belong to the one
//! `AndroidBackend` and outlive single playbacks: the activity re-creates them
//! on stop/start, whichever player is open.

use jni::JNIEnv;
use jni::objects::{JClass, JObject, JString};
use jni::sys::{jboolean, jint, jlong, jstring};
use oxideav_core::RuntimeContext;
use player::android::surface::{SurfaceBinding, SurfaceRegistry, SurfaceRetirement};
use player::{AndroidBackend, Player, PlayerOptions, State, TrackKind};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

/// The player's allocator. The software decoders allocate and free a lot each
/// frame: on a Pixel 5a, 720p XviD took 23 ms a frame with Android's own
/// allocator and 11 ms with mimalloc.
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Every container and decoder the player can use, built once.
static CODECS: LazyLock<Arc<RuntimeContext>> = LazyLock::new(|| Arc::new(codecs::context()));

/// The backend every playback uses.
static BACKEND: LazyLock<Arc<AndroidBackend>> = LazyLock::new(AndroidBackend::new);

// ---- Playback ----

fn player<'a>(handle: jlong) -> &'a Player {
    // SAFETY: handles come from `open` and stay valid until `close`, which the
    // Kotlin side calls once, after its last use.
    unsafe { &*(handle as *const Player) }
}

/// Opens `url` and starts playing. `soundfont`: the user's SF2 bank for MIDI, or null.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_open(
    mut env: JNIEnv, _class: JClass, url: JString, soundfont: JString,
) -> jlong {
    let url: String = match env.get_string(&url) {
        Ok(url) => url.into(),
        Err(err) => {
            let _ = env.throw_new("java/lang/IllegalArgumentException", err.to_string());
            return 0;
        }
    };
    let soundfont = if soundfont.is_null() {
        None
    } else {
        env.get_string(&soundfont).ok().map(|path| PathBuf::from(String::from(path)))
    };
    let options = PlayerOptions { soundfont, ..PlayerOptions::default() };
    let backend = BACKEND.clone();
    // The app polls state(); events would only wake it sooner.
    let player = Player::open(&url, backend, CODECS.clone(), options, |_| {});
    Box::into_raw(Box::new(player)) as jlong
}

/// Stops playback and frees the handle. Joining the pipeline can take a moment,
/// so it happens off the caller's thread.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_close(_env: JNIEnv, _class: JClass, handle: jlong) {
    if handle == 0 {
        return;
    }
    // SAFETY: see `player`; this is the handle's last use.
    let player = unsafe { Box::from_raw(handle as *mut Player) };
    std::thread::spawn(move || drop(player));
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_play(_env: JNIEnv, _class: JClass, handle: jlong) {
    player(handle).play();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_pause(_env: JNIEnv, _class: JClass, handle: jlong) {
    player(handle).pause();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_seek(_env: JNIEnv, _class: JClass, handle: jlong, ms: jlong) {
    player(handle).seek(Duration::from_millis(ms.max(0) as u64));
}

/// `stream` < 0 means no audio.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_selectAudio(_env: JNIEnv, _class: JClass, handle: jlong, stream: jint) {
    player(handle).select_audio(u32::try_from(stream).ok());
}

/// `stream` < 0 turns subtitles off.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_selectSubtitle(_env: JNIEnv, _class: JClass, handle: jlong, stream: jint) {
    player(handle).select_subtitle(u32::try_from(stream).ok());
}

/// The worklet serving the stream suspends with the app; so does the player.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_suspend(_env: JNIEnv, _class: JClass, handle: jlong) {
    player(handle).suspend();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_resume(_env: JNIEnv, _class: JClass, handle: jlong) {
    player(handle).resume();
}

/// The player's state as JSON (see PlayerState.kt).
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_state(env: JNIEnv, _class: JClass, handle: jlong) -> jstring {
    let text = state_json(&player(handle).state());
    env.new_string(text).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

fn state_json(st: &State) -> String {
    let tracks: Vec<_> = st.tracks.iter().map(|t| json!({
        "stream": t.stream,
        "kind": match t.kind { TrackKind::Audio => "audio", TrackKind::Video => "video", TrackKind::Subtitle => "subtitle" },
        "codec": t.codec,
        "language": t.language,
        "title": t.title,
        "default": t.default,
    })).collect();
    json!({
        "positionMs": st.position.as_millis() as u64,
        "durationMs": st.duration.map(|d| d.as_millis() as u64),
        "playing": st.playing,
        "buffering": st.buffering,
        "ended": st.ended,
        "error": st.error,
        "tracks": tracks,
        "audio": st.audio,
        "subtitle": st.subtitle,
        "videoWidth": st.video_size.map(|(w, _)| w),
        "videoHeight": st.video_size.map(|(_, h)| h),
        "videoPixelAspect": st.video_pixel_aspect.map(|(h, v)| [h, v]),
        "videoFps": st.video_fps,
        "videoDecoder": st.video_decoder,
        "droppedFrames": st.dropped_frames,
    })
    .to_string()
}

// ---- Surfaces ----
//
// The activity keeps two SurfaceViews (video, subtitles above it) and hands
// their surfaces here as they come and go. Surface import and the last native
// release happen on the player's bounded owner, never inside SurfaceHolder
// callbacks; only source admission happens in these calls.

// JNI handles are never reused. Keep at most the registry's sixteen admitted
// bindings, including those whose native retirement has not yet completed.
struct Registration {
    id: jlong,
    role: usize,
    binding: Arc<SurfaceBinding>,
    retirement: Option<SurfaceRetirement>,
    caller_released: bool,
    bind_error: Option<String>,
}

struct Surfaces {
    entries: [Option<Registration>; 16],
    current: [Option<jlong>; 2],
}

static SURFACES: LazyLock<Mutex<Surfaces>> = LazyLock::new(|| Mutex::new(Surfaces {
    entries: std::array::from_fn(|_| None),
    current: [None; 2],
}));
static NEXT_SURFACE: AtomicI64 = AtomicI64::new(1);

fn retirement_status(entry: &Registration) -> jint {
    let Some(retirement) = &entry.retirement else { return 0 };
    // The activity owns one coalesced polling callback; this observation must
    // not claim success merely because retirement was requested.
    match retirement.poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(Ok(_)) => 1,
        Poll::Ready(Err(_)) => 2,
        Poll::Pending => 0,
    }
}

impl Surfaces {
    fn retire(&mut self, id: jlong) -> Result<(), String> {
        let entry = self.entries.iter_mut().flatten().find(|entry| entry.id == id)
            .ok_or_else(|| "Unknown player Surface registration".to_owned())?;
        if self.current[entry.role] == Some(id) {
            // A delayed callback for an old binding must not clear its successor.
            self.current[entry.role] = None;
            if entry.role == 0 {
                BACKEND.clear_video_surface();
            } else {
                BACKEND.clear_subtitle_surface();
            }
        }
        if entry.retirement.is_none() {
            entry.retirement = Some(entry.binding.retire());
        }
        Ok(())
    }

    fn observe(&mut self, id: jlong, abandon: bool) -> Result<jint, String> {
        let entry = self.entries.iter_mut().flatten().find(|entry| entry.id == id)
            .ok_or_else(|| "Unknown player Surface registration".to_owned())?;
        let status = retirement_status(entry);
        entry.caller_released |= abandon || status == 1;
        Ok(status)
    }

    fn prune_retired(&mut self) {
        for entry in &mut self.entries {
            if entry.as_ref().is_some_and(|entry| entry.caller_released && retirement_status(entry) == 1) {
                *entry = None;
            }
        }
    }
}

/// Admits a surface for `role` (1 video, 2 subtitles) and returns its registration id.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_registerSurface(
    mut env: JNIEnv, _class: JClass, surface: JObject, role: jint,
) -> jlong {
    let result = (|| -> Result<jlong, String> {
        let role = match role {
            1 => 0,
            2 => 1,
            _ => return Err("Unknown player Surface role".into()),
        };
        let mut surfaces = SURFACES.lock().map_err(|_| "Player Surface state is unavailable")?;
        surfaces.prune_retired();
        let reservation = SurfaceRegistry::global().reserve_java(&mut env, &surface)
            .map_err(|error| format!("Cannot admit player Surface: {error:?}"))?;
        // Reserve app-side bookkeeping before committing native ownership.
        let slot = surfaces.entries.iter().position(Option::is_none)
            .ok_or_else(|| "Player Surface retirement capacity is occupied".to_owned())?;
        let id = NEXT_SURFACE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| "Player Surface registration identifiers exhausted")?;
        let previous_slot = surfaces.current[role].map(|previous| {
            surfaces.entries.iter().position(|entry| entry.as_ref().is_some_and(|entry| entry.id == previous))
                .ok_or_else(|| "Current player Surface registration is missing".to_owned())
        }).transpose()?;
        let binding = reservation.commit();
        if let Some(existing) = surfaces.entries.iter().flatten()
            .find(|entry| entry.binding.id() == binding.id())
        {
            if existing.role != role || existing.retirement.is_some() {
                return Err("Player Surface is already assigned or retiring".into());
            }
            return Ok(existing.id);
        }
        surfaces.entries[slot] = Some(Registration {
            id, role, binding: Arc::clone(&binding), retirement: None, caller_released: false, bind_error: None,
        });
        let bound = if role == 0 {
            BACKEND.set_video_surface(binding).map(|_| ())
        } else {
            BACKEND.set_subtitle_surface(binding)
        };
        if let Err(error) = bound {
            // A committed binding must reach Kotlin even when binding fails:
            // its view remains gated by this registration's cleanup receipt.
            let entry = surfaces.entries[slot].as_mut().unwrap();
            entry.bind_error = Some(format!("Cannot bind player Surface: {error:?}"));
            entry.retirement = Some(entry.binding.retire());
            return Ok(id);
        }
        surfaces.current[role] = Some(id);
        if let Some(previous_slot) = previous_slot {
            let entry = surfaces.entries[previous_slot].as_mut().unwrap();
            if entry.retirement.is_none() {
                entry.retirement = Some(entry.binding.retire());
            }
        }
        Ok(id)
    })();
    match result {
        Ok(id) => id,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_surfaceRegistrationError(
    mut env: JNIEnv, _class: JClass, id: jlong,
) -> jstring {
    let result = (|| -> Result<jstring, String> {
        let surfaces = SURFACES.lock().map_err(|_| "Player Surface state is unavailable")?;
        let entry = surfaces.entries.iter().flatten().find(|entry| entry.id == id)
            .ok_or_else(|| "Unknown player Surface registration".to_owned())?;
        match &entry.bind_error {
            Some(error) => env.new_string(error).map(|value| value.into_raw()).map_err(|error| error.to_string()),
            None => Ok(std::ptr::null_mut()),
        }
    })();
    match result {
        Ok(error) => error,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            std::ptr::null_mut()
        }
    }
}

/// Starts retiring a registration; 0 pending, 1 retired, 2 failed.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_retireSurface(
    mut env: JNIEnv, _class: JClass, id: jlong, keep_receipt: jboolean,
) -> jint {
    let result = SURFACES.lock().map_err(|_| "Player Surface state is unavailable".to_owned())
        .and_then(|mut surfaces| {
            surfaces.retire(id)?;
            surfaces.observe(id, keep_receipt == 0)
        });
    surface_result(&mut env, result)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_peartube_app_player_NativePlayer_surfaceRetirementStatus(
    mut env: JNIEnv, _class: JClass, id: jlong,
) -> jint {
    let result = SURFACES.lock().map_err(|_| "Player Surface state is unavailable".to_owned())
        .and_then(|mut surfaces| surfaces.observe(id, false));
    surface_result(&mut env, result)
}

fn surface_result(env: &mut JNIEnv, result: Result<jint, String>) -> jint {
    match result {
        Ok(status) => status,
        Err(error) => {
            let _ = env.throw_new("java/lang/IllegalStateException", error);
            2
        }
    }
}
