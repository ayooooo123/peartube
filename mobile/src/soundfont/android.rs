//! MainActivity owns the document grant and bounded copy. Only a private
//! temporary path crosses JNI; the caller validates and commits the bank.

use futures_channel::oneshot;
use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::sys::{JNI_FALSE, jboolean, jlong};
use jni::{JNIEnv, JavaVM, NativeMethod};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};

type Reply = Result<bool, String>;
static PENDING: Mutex<Option<(jlong, oneshot::Sender<Reply>)>> = Mutex::new(None);
static NEXT_REQUEST: AtomicI64 = AtomicI64::new(1);

/// True only after the selected document and destination have both closed.
/// Cancellation is false; picker/copy failures and activity destruction are errors.
pub(super) async fn pick(destination: PathBuf, max_bytes: u64) -> Result<bool, String> {
    let destination = destination.to_str().ok_or("SoundFont destination is not valid UTF-8")?;
    let max_bytes = jlong::try_from(max_bytes).map_err(|_| "SoundFont size limit exceeds Android's supported range")?;
    let ctx = ndk_context::android_context();
    // SAFETY: ndk-context supplies the app's live JVM and tao-held activity.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|error| error.to_string())?;
    let activity = with_env(&vm, |env| {
        // Borrow tao's reference only to make an owned global reference. The
        // latter keeps cancellation safe even after onDestroy clears tao's context.
        let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
        env.new_global_ref(&activity)
    })?;
    let request = Request {
        id: NEXT_REQUEST.fetch_add(1, Ordering::Relaxed),
        vm,
        activity,
    };
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = PENDING.lock();
        if pending.is_some() {
            return Err("A SoundFont selection is already in progress".into());
        }
        *pending = Some((request.id, sender));
    }
    with_env(&request.vm, |env| {
        let activity = request.activity.as_obj();
        let class = env.get_object_class(activity)?;
        // As with android_player.rs, the library is loaded as an executable:
        // register explicitly instead of relying on exported Java_* symbols.
        env.register_native_methods(
            &class,
            &[NativeMethod {
                name: "soundFontResult".into(),
                sig: "(JZLjava/lang/String;)V".into(),
                fn_ptr: sound_font_result as *mut _,
            }],
        )?;
        let destination = env.new_string(destination)?;
        env.call_method(
            activity,
            "pickSoundFont",
            "(JLjava/lang/String;J)V",
            &[JValue::Long(request.id), JValue::Object(&destination), JValue::Long(max_bytes)],
        )?;
        Ok(())
    })?;
    receiver.await.map_err(|_| "Android SoundFont picker closed without a result".to_string())?
}

struct Request {
    id: jlong,
    vm: JavaVM,
    activity: GlobalRef,
}

impl Drop for Request {
    fn drop(&mut self) {
        // Completion takes the sender first. Otherwise this is a launch error
        // or a dropped future: release the global slot and stop the native job.
        if take_sender(self.id).is_some() {
            let _ = with_env(&self.vm, |env| {
                env.call_method(self.activity.as_obj(), "cancelSoundFont", "(J)V", &[JValue::Long(self.id)])?;
                Ok(())
            });
        }
    }
}

fn take_sender(id: jlong) -> Option<oneshot::Sender<Reply>> {
    let mut pending = PENDING.lock();
    if pending.as_ref().is_some_and(|(current, _)| *current == id) {
        pending.take().map(|(_, sender)| sender)
    } else {
        None
    }
}

extern "system" fn sound_font_result(mut env: JNIEnv, _activity: JObject, id: jlong, selected: jboolean, error: JString) {
    // Ignore late callbacks from cancelled jobs without touching a newer request.
    let Some(sender) = take_sender(id) else { return };
    let result = if error.is_null() {
        Ok(selected != JNI_FALSE)
    } else {
        Err(match env.get_string(&error) {
            Ok(message) => message.into(),
            Err(error) => format!("Cannot read Android SoundFont error: {error}"),
        })
    };
    clear_exception(&mut env);
    let _ = sender.send(result);
}

fn with_env<T>(vm: &JavaVM, call: impl FnOnce(&mut JNIEnv) -> jni::errors::Result<T>) -> Result<T, String> {
    let mut env = vm.attach_current_thread().map_err(|error| error.to_string())?;
    // Attached app threads may persist across many selections. Release local
    // strings/classes at each call rather than waiting for thread detachment.
    let result = env.with_local_frame(8, call);
    clear_exception(&mut env);
    result.map_err(|error| error.to_string())
}

fn clear_exception(env: &mut JNIEnv) {
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}
