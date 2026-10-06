//! Android side of the player: MainActivity (android/MainActivity.kt) keeps
//! two SurfaceViews over a slot in the page, and hands their surfaces to the
//! one AndroidBackend here as they come and go.

use jni::objects::{JObject, JValue};
use jni::sys::jobject;
use jni::{JNIEnv, JavaVM, NativeMethod};
use ndk::native_window::NativeWindow;
use player::AndroidBackend;
use std::sync::{Arc, LazyLock};

/// The backend every playback uses. Surfaces outlive single playbacks: the
/// activity re-creates them on stop/start, whichever player is open.
static BACKEND: LazyLock<Arc<AndroidBackend>> = LazyLock::new(AndroidBackend::new);

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

/// Takes the surfaces down. Their surfaceDestroyed callbacks detach them from
/// the backend first.
pub fn close() -> Result<(), String> {
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

/// MainActivity's `external fun videoSurface` / `subtitleSurface`. The app's
/// library is loaded as an executable, whose symbols the JVM cannot look up,
/// so the methods are registered by hand, once.
static NATIVES: LazyLock<Result<(), String>> = LazyLock::new(|| {
    with_activity(|env, activity| {
        let class = env.get_object_class(activity)?;
        env.register_native_methods(
            &class,
            &[
                NativeMethod {
                    name: "videoSurface".into(),
                    sig: "(Landroid/view/Surface;)V".into(),
                    fn_ptr: video_surface as *mut _,
                },
                NativeMethod {
                    name: "subtitleSurface".into(),
                    sig: "(Landroid/view/Surface;)V".into(),
                    fn_ptr: subtitle_surface as *mut _,
                },
            ],
        )
    })
});

/// On the UI thread, from SurfaceHolder.Callback. A null surface is
/// surfaceDestroyed: Android reclaims the surface when the callback returns,
/// and `set_video_window(None)` blocks until nothing uses it.
extern "system" fn video_surface(env: JNIEnv, _this: JObject, surface: jobject) {
    backend().set_video_window(window(&env, surface));
}

extern "system" fn subtitle_surface(env: JNIEnv, _this: JObject, surface: jobject) {
    backend().set_subtitle_window(window(&env, surface));
}

fn window(env: &JNIEnv, surface: jobject) -> Option<NativeWindow> {
    if surface.is_null() {
        return None;
    }
    // SAFETY: a live android.view.Surface from the callback, on this JNI env.
    unsafe { NativeWindow::from_surface(env.get_raw(), surface) }
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
