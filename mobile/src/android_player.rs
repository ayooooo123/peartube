//! Android side of the player: MainActivity (android/MainActivity.kt) keeps
//! two SurfaceViews over a slot in the page, and hands their surfaces to the
//! one AndroidBackend here as they come and go.

use jni::objects::{JObject, JValue};
use jni::sys::{jboolean, jint, jlong, jstring};
use jni::{JNIEnv, JavaVM, NativeMethod};
use player::android::surface::{SurfaceBinding, SurfaceRegistry, SurfaceRetirement};
use player::AndroidBackend;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Waker};

/// The backend every playback uses. Surfaces outlive single playbacks: the
/// activity re-creates them on stop/start, whichever player is open.
static BACKEND: LazyLock<Arc<AndroidBackend>> = LazyLock::new(AndroidBackend::new);

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

pub fn backend() -> Arc<AndroidBackend> {
    BACKEND.clone()
}

/// Adds the player's surfaces, hidden until `set_frame` places them.
pub fn open() -> Result<(), String> {
    NATIVES.clone()?;
    with_activity(|env, activity| {
        env.call_method(activity, "openPlayer", "()V", &[])?;
        Ok(())
    })
}

/// Moves the surfaces over a rect of the page: [left, top, width, height] in
/// CSS pixels from the webview's top left.
pub fn set_frame(rect: [f64; 4]) -> Result<(), String> {
    with_activity(|env, activity| {
        let [left, top, width, height] = rect.map(|v| JValue::Float(v as f32));
        env.call_method(activity, "setPlayerFrame", "(FFFF)V", &[left, top, width, height])?;
        Ok(())
    })
}

/// Requests asynchronous Surface retirement. Posting this request is not a
/// release receipt: Kotlin keeps the views until both native receipts arrive.
pub fn request_close() -> Result<(), String> {
    with_activity(|env, activity| {
        env.call_method(activity, "closePlayer", "()V", &[])?;
        Ok(())
    })
}

/// The page's own back, for the end of a video.
pub fn back() -> Result<(), String> {
    with_activity(|env, activity| {
        env.call_method(activity, "back", "()V", &[])?;
        Ok(())
    })
}

/// The app library is loaded as an executable, so register JNI methods by name.
static NATIVES: LazyLock<Result<(), String>> = LazyLock::new(|| {
    with_activity(|env, activity| {
        let class = env.get_object_class(activity)?;
        env.register_native_methods(
            &class,
            &[
                NativeMethod {
                    name: "registerSurface".into(),
                    sig: "(Landroid/view/Surface;I)J".into(),
                    fn_ptr: register_surface as *mut _,
                },
                NativeMethod {
                    name: "surfaceRegistrationError".into(),
                    sig: "(J)Ljava/lang/String;".into(),
                    fn_ptr: surface_registration_error as *mut _,
                },
                NativeMethod {
                    name: "retireSurface".into(),
                    sig: "(JZ)I".into(),
                    fn_ptr: retire_surface as *mut _,
                },
                NativeMethod {
                    name: "surfaceRetirementStatus".into(),
                    sig: "(J)I".into(),
                    fn_ptr: surface_retirement_status as *mut _,
                },
            ],
        )
    })
});

// Surface import and last native release happen on the player's bounded owner,
// never inside SurfaceHolder callbacks. Only source admission happens here.
extern "system" fn register_surface(mut env: JNIEnv, _this: JObject, surface: JObject, role: jint) -> jlong {
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
            // A committed binding must reach Java even when binding fails:
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

extern "system" fn surface_registration_error(mut env: JNIEnv, _this: JObject, id: jlong) -> jstring {
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

extern "system" fn retire_surface(mut env: JNIEnv, _this: JObject, id: jlong, keep_receipt: jboolean) -> jint {
    let result = SURFACES.lock().map_err(|_| "Player Surface state is unavailable".to_owned())
        .and_then(|mut surfaces| {
            surfaces.retire(id)?;
            surfaces.observe(id, keep_receipt == 0)
        });
    surface_result(&mut env, result)
}

extern "system" fn surface_retirement_status(mut env: JNIEnv, _this: JObject, id: jlong) -> jint {
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

fn with_activity(call: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<()>) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|err| err.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|err| err.to_string())?;
    // The activity: a global reference that tao holds for the app's lifetime.
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let result = call(&mut env, &activity);
    // A Java exception stays pending until cleared, and fails every later call.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    result.map_err(|err| err.to_string())
}
