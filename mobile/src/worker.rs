//! The P2P worker: a Bare worklet (bare-kit) running `mobile/worker.js`, which
//! is the relay's own core. We talk to it in newline-delimited JSON over
//! bare-kit's IPC pipes; worker.js documents the messages.

use std::collections::HashMap;
use std::ffi::{CString, c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use futures_channel::{mpsc, oneshot};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::settings::Settings;

// mobile/worker.js packed by build.rs with bare-pack.
static BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/worker.bundle"));

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tracker: String,
    pub writer: String,
    pub blobs: String,
    pub blob_bytes: u64,
    pub peers: u64,
    /// Peers connected over LAN discovery.
    pub lan_peers: u64,
}

/// One tracker entry, the same shape as the relay's `/v1/search` results.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub id: String,
    pub title: String,
    pub size: u64,
    pub sha256: String,
    pub local: bool,
    pub stream_url: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The tracker or the peer set changed.
    Update,
    /// The worker hit an uncaught error.
    Fatal(String),
    /// The worklet closed its IPC; no more replies will come.
    Exited,
}

#[repr(C)]
struct UvBuf {
    base: *const c_char,
    len: usize,
}

#[repr(C)]
struct WorkletOptions {
    memory_limit: usize,
    assets: *const c_char,
}

#[repr(C)]
struct BareWorklet {
    _opaque: [u8; 0],
}

#[repr(C)]
struct BareIpc {
    _opaque: [u8; 0],
}

unsafe extern "C" {
    fn bare_worklet_alloc(result: *mut *mut BareWorklet) -> c_int;
    fn bare_worklet_init(worklet: *mut BareWorklet, options: *const WorkletOptions) -> c_int;
    fn bare_worklet_start(worklet: *mut BareWorklet, filename: *const c_char, source: *const UvBuf, argc: c_int, argv: *const *const c_char) -> c_int;
    fn bare_worklet_suspend(worklet: *mut BareWorklet, linger: c_int) -> c_int;
    fn bare_worklet_resume(worklet: *mut BareWorklet) -> c_int;
    fn bare_ipc_alloc(result: *mut *mut BareIpc) -> c_int;
    fn bare_ipc_init(ipc: *mut BareIpc, worklet: *mut BareWorklet) -> c_int;
    fn bare_ipc_get_incoming(ipc: *mut BareIpc) -> c_int;
    fn bare_ipc_get_outgoing(ipc: *mut BareIpc) -> c_int;
}

type Reply = Result<Value, String>;

/// State shared with the IPC reader thread.
#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    subscribers: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
}

pub struct Worker {
    worklet: *mut BareWorklet,
    outgoing: c_int,
    write: Mutex<()>,
    next_id: AtomicU64,
    shared: Arc<Shared>,
}

// The worklet handle is only passed to bare-kit calls, which are thread safe;
// everything else is behind a Mutex or atomic.
unsafe impl Send for Worker {}
unsafe impl Sync for Worker {}

static WORKER: LazyLock<Result<Worker, String>> = LazyLock::new(|| Worker::spawn(&DATA_DIR.join("bare-assets")));

/// The process's one worklet, started on first use.
pub fn worker() -> Result<&'static Worker, String> {
    WORKER.as_ref().map_err(Clone::clone)
}

impl Worker {
    fn spawn(assets: &Path) -> Result<Worker, String> {
        std::fs::create_dir_all(assets).map_err(|err| format!("Cannot create {}: {err}", assets.display()))?;
        let assets = CString::new(assets.to_string_lossy().as_bytes()).map_err(|err| err.to_string())?;
        let source = UvBuf { base: BUNDLE.as_ptr().cast(), len: BUNDLE.len() };
        #[cfg(target_os = "android")]
        android::publish_jvm()?;
        let (incoming, outgoing, worklet) = unsafe {
            // A write to a worklet that has exited must fail with EPIPE, not kill the app.
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            let mut worklet = std::ptr::null_mut();
            check(bare_worklet_alloc(&mut worklet), "alloc")?;
            let options = WorkletOptions { memory_limit: 0, assets: assets.as_ptr() };
            check(bare_worklet_init(worklet, &options), "init")?;
            // Returns once the source, filename and assets have been copied in.
            check(bare_worklet_start(worklet, c"/worker.bundle".as_ptr(), &source, 0, std::ptr::null()), "start")?;
            let mut ipc = std::ptr::null_mut();
            check(bare_ipc_alloc(&mut ipc), "IPC alloc")?;
            check(bare_ipc_init(ipc, worklet), "IPC init")?;
            (bare_ipc_get_incoming(ipc), bare_ipc_get_outgoing(ipc), worklet)
        };
        let shared = Arc::new(Shared::default());
        let reader = shared.clone();
        std::thread::Builder::new()
            .name("peartube-ipc".into())
            .spawn(move || reader.read(incoming))
            .map_err(|err| err.to_string())?;
        Ok(Worker { worklet, outgoing, write: Mutex::new(()), next_id: AtomicU64::new(1), shared })
    }

    pub async fn start(&self, settings: &Settings) -> Result<Status, String> {
        let storage = STORE_DIR.join("trackers").join(&settings.tracker);
        let params = json!({
            "storage": storage.to_string_lossy(),
            "tracker": settings.tracker,
            "relayThrough": non_empty(&settings.relay_through),
            "bootstrap": non_empty(&settings.bootstrap),
            "lan": (!settings.lan.is_empty()).then_some(&settings.lan),
        });
        parse(self.call("start", params).await?)
    }

    pub async fn status(&self) -> Result<Status, String> {
        parse(self.call("status", json!({})).await?)
    }

    /// Every entry for `id`, or the whole tracker when `id` is None.
    pub async fn search(&self, id: Option<&str>) -> Result<Vec<Entry>, String> {
        parse(self.call("search", json!({ "id": id })).await?)
    }

    /// Events from the worker, until it exits.
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded();
        self.shared.subscribers.lock().push(tx);
        rx
    }

    /// Stop the worklet's I/O while the app is in the background.
    pub fn suspend(&self) {
        unsafe { bare_worklet_suspend(self.worklet, -1) };
    }

    pub fn resume(&self) {
        unsafe { bare_worklet_resume(self.worklet) };
    }

    async fn call(&self, method: &str, params: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().insert(id, tx);
        let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params })).map_err(|err| err.to_string())?;
        line.push(b'\n');
        if let Err(err) = self.write_all(&line) {
            self.shared.pending.lock().remove(&id);
            return Err(err);
        }
        rx.await.map_err(|_| "The P2P worker stopped".to_string())?
    }

    fn write_all(&self, mut bytes: &[u8]) -> Result<(), String> {
        let _one_writer = self.write.lock();
        while !bytes.is_empty() {
            let n = unsafe { libc::write(self.outgoing, bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                bytes = &bytes[n as usize..];
                continue;
            }
            let err = std::io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::EAGAIN) => wait(self.outgoing, libc::POLLOUT),
                Some(libc::EINTR) => {}
                _ => return Err(format!("Cannot reach the P2P worker: {err}")),
            }
        }
        Ok(())
    }
}

impl Shared {
    fn read(&self, fd: c_int) {
        let mut chunk = vec![0u8; 64 * 1024];
        let mut buffered = Vec::new();
        loop {
            let n = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
            if n > 0 {
                buffered.extend_from_slice(&chunk[..n as usize]);
                while let Some(end) = buffered.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffered.drain(..=end).collect();
                    self.dispatch(&line[..end]);
                }
                continue;
            }
            if n == 0 {
                break;
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EAGAIN) => wait(fd, libc::POLLIN),
                Some(libc::EINTR) => {}
                _ => break,
            }
        }
        // Dropping the senders fails every call still waiting for a reply.
        self.pending.lock().clear();
        self.broadcast(Event::Exited);
    }

    fn dispatch(&self, line: &[u8]) {
        let msg = match serde_json::from_slice::<Value>(line) {
            Ok(msg) => msg,
            Err(err) => {
                // The reply's id is unreadable too: fail every waiting call rather than hang one.
                let error = format!("Unreadable message from the P2P worker: {err}");
                for (_, reply) in self.pending.lock().drain() {
                    let _ = reply.send(Err(error.clone()));
                }
                return self.broadcast(Event::Fatal(error));
            }
        };
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            let Some(reply) = self.pending.lock().remove(&id) else { return };
            let result = match msg.get("error") {
                Some(error) => Err(error.as_str().unwrap_or("Unknown worker error").to_string()),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = reply.send(result);
        } else {
            match msg.get("event").and_then(Value::as_str) {
                Some("update") => self.broadcast(Event::Update),
                Some("fatal") => self.broadcast(Event::Fatal(msg["error"].as_str().unwrap_or("").to_string())),
                _ => {}
            }
        }
    }

    fn broadcast(&self, event: Event) {
        self.subscribers.lock().retain(|tx| tx.unbounded_send(event.clone()).is_ok());
    }
}

fn check(code: c_int, what: &str) -> Result<(), String> {
    if code == 0 { Ok(()) } else { Err(format!("bare-kit {what} failed ({code})")) }
}

fn wait(fd: c_int, events: libc::c_short) {
    let mut poll = libc::pollfd { fd, events, revents: 0 };
    unsafe { libc::poll(&mut poll, 1, -1) };
}

fn non_empty(list: &[String]) -> Option<&[String]> {
    if list.is_empty() { None } else { Some(list) }
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| format!("Unexpected reply from the P2P worker: {err}"))
}

/// Where the app keeps its settings and bare-kit's unpacked assets.
/// PEARTUBE_STORAGE overrides this and STORE_DIR.
pub static DATA_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    if let Some(dir) = std::env::var_os("PEARTUBE_STORAGE") {
        return dir.into();
    }
    #[cfg(target_os = "android")]
    return android::dir("getFilesDir").expect("Android files dir");
    #[cfg(not(target_os = "android"))]
    home_dir("Library/Application Support/PearTube", ".local/share/peartube")
});

/// Where each tracker's Corestore lives. The app only reads, so its stores hold
/// nothing peers cannot serve again, and they can be large: keep them out of
/// backups. iCloud skips Library/Caches; Android Auto Backup skips the
/// no-backup files dir.
static STORE_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    if let Some(dir) = std::env::var_os("PEARTUBE_STORAGE") {
        return dir.into();
    }
    #[cfg(target_os = "android")]
    return android::dir("getNoBackupFilesDir").expect("Android no-backup files dir");
    #[cfg(not(target_os = "android"))]
    home_dir("Library/Caches/PearTube", ".cache/peartube")
});

#[cfg(not(target_os = "android"))]
fn home_dir(apple: &str, other: &str) -> PathBuf {
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME is set"));
    home.join(if cfg!(target_vendor = "apple") { apple } else { other })
}

#[cfg(target_os = "android")]
mod android {
    use std::path::PathBuf;

    use jni::JavaVM;
    use jni::objects::{JObject, JString};

    /// bare-kit reads the JavaVM that its JNI_OnLoad stores. The library is
    /// loaded as our dependency rather than by System.loadLibrary, so nothing
    /// has called JNI_OnLoad yet: call it ourselves.
    pub fn publish_jvm() -> Result<(), String> {
        unsafe {
            let lib = libc::dlopen(c"libbare-kit.so".as_ptr(), libc::RTLD_NOW | libc::RTLD_NOLOAD);
            if lib.is_null() {
                return Err("libbare-kit.so is not loaded".into());
            }
            let on_load = libc::dlsym(lib, c"JNI_OnLoad".as_ptr());
            if on_load.is_null() {
                return Err("libbare-kit.so has no JNI_OnLoad".into());
            }
            let on_load: extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> i32 = std::mem::transmute(on_load);
            on_load(ndk_context::android_context().vm(), std::ptr::null_mut());
        }
        Ok(())
    }

    /// A directory of the app's Context, by getter name.
    pub fn dir(getter: &str) -> Result<PathBuf, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|err| err.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|err| err.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let dir = env.call_method(&context, getter, "()Ljava/io/File;", &[]).and_then(|v| v.l()).map_err(|err| err.to_string())?;
        let path = env.call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[]).and_then(|v| v.l()).map_err(|err| err.to_string())?;
        let path: String = env.get_string(&JString::from(path)).map_err(|err| err.to_string())?.into();
        Ok(PathBuf::from(path))
    }
}
