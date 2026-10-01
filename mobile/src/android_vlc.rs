//! In-app video on Android: libVLC in a view that MainActivity
//! (android/MainActivity.kt) keeps over the page. These calls reach it
//! through JNI.

use jni::objects::{JObject, JValue};
use jni::{JNIEnv, JavaVM};

/// Plays url full screen over the page.
pub fn play(url: &str) -> Result<(), String> {
    with_activity(|env, activity| {
        let url = env.new_string(url)?;
        env.call_method(activity, "play", "(Ljava/lang/String;)V", &[JValue::Object(&url)])?;
        Ok(())
    })
}

/// Takes the player down.
pub fn close() -> Result<(), String> {
    with_activity(|env, activity| {
        env.call_method(activity, "closePlayer", "()V", &[])?;
        Ok(())
    })
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
