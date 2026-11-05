//! The P2P worker: a Bare worklet (bare-kit) running `worklet/worker.js`, which
//! is the relay's own core. We talk to it in newline-delimited JSON over
//! bare-kit's IPC pipes; worker.js documents the messages.

use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use futures_channel::{mpsc, oneshot};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::settings::Settings;

// worklet/worker.js packed by build.rs with bare-pack.
static BUNDLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/worker.bundle"));

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTraffic {
    pub peers: u64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct TrafficRoutes {
    #[serde(rename = "private")]
    pub private_route: RouteTraffic,
    #[serde(rename = "public")]
    pub public_route: RouteTraffic,
    pub lan: RouteTraffic,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub key: String,
    pub kind: String,
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub writable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSource {
    pub key: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub via: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reciprocity {
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub seeded_bytes: u64,
    #[serde(default)]
    pub contributing_peers: u64,
    #[serde(default)]
    pub ratio: f64,
    #[serde(default)]
    pub inflight_max: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tracker: String,
    #[serde(default)]
    pub channel: String,
    pub writer: String,
    #[serde(default)]
    pub writable: bool,
    pub blobs: String,
    pub blob_bytes: u64,
    #[serde(default)]
    pub cached_bytes: u64,
    pub peers: u64,
    pub lan_peers: u64,
    #[serde(default)]
    pub down_bps: u64,
    #[serde(default)]
    pub up_bps: u64,
    #[serde(default)]
    pub rx_bytes: u64,
    #[serde(default)]
    pub tx_bytes: u64,
    pub routes: TrafficRoutes,
    #[serde(default)]
    pub inflight_blocks: u64,
    #[serde(default)]
    pub rtt: u64,
    #[serde(default)]
    pub retransmits: u64,
    pub lan: Option<String>,
    #[serde(default)]
    pub api_url: Option<String>,
    #[serde(default)]
    pub sources: Vec<SourceInfo>,
    #[serde(default)]
    pub discovered_sources: Vec<DiscoveredSource>,
    #[serde(default)]
    pub reciprocity: Reciprocity,
}

/// One tracker or channel entry, matching `/v1/search` results.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub id: String,
    pub title: String,
    pub size: u64,
    pub sha256: String,
    pub local: bool,
    #[serde(default)]
    pub cached_bytes: u64,
    #[serde(rename = "private", default)]
    pub is_private: bool,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub locked: bool,
    pub stream_url: String,
    #[serde(default)]
    pub magnet_url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_kind: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterInfo {
    pub key: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub alias: String,
    #[serde(rename = "self", default)]
    pub self_device: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub writer: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub writable: bool,
    #[serde(default)]
    pub mnemonic_set: bool,
    #[serde(default)]
    pub mnemonic: String,
    #[serde(default)]
    pub writers: Vec<WriterInfo>,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub access_uri: String,
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUriResult {
    pub action: String,
    #[serde(default)]
    pub source: Option<SourceInfo>,
    #[serde(default)]
    pub entry: Option<Entry>,
    #[serde(default)]
    pub receiver: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastReceiver {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub paired: bool,
    #[serde(default)]
    pub p2p: bool,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub auth: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastTrack {
    pub stream: i32,
    pub kind: String,
    #[serde(default)]
    pub codec: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastEntryMeta {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastPlaybackState {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub entry: Option<CastEntryMeta>,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub playing: bool,
    #[serde(default)]
    pub buffering: bool,
    #[serde(default)]
    pub ended: bool,
    #[serde(default)]
    pub p2p_peers: u64,
    #[serde(default)]
    pub cached_bytes: u64,
    #[serde(default)]
    pub seeding: bool,
    #[serde(default)]
    pub tracks: Vec<CastTrack>,
    #[serde(default)]
    pub audio: Option<i32>,
    #[serde(default)]
    pub subtitle: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSession {
    pub receiver_id: String,
    pub receiver_name: String,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub state: CastPlaybackState,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverInfo {
    pub device_id: String,
    pub name: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub pair_code: String,
    #[serde(default)]
    pub pairing_uri: String,
    #[serde(default)]
    pub listen_url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastStatus {
    #[serde(default)]
    pub web_receiver_url: Option<String>,
    #[serde(default)]
    pub receivers: Vec<CastReceiver>,
    #[serde(default)]
    pub session: Option<CastSession>,
    #[serde(default)]
    pub receiver_mode: Option<ReceiverInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverCommand {
    #[serde(default)]
    pub seq: u64,
    pub action: String,
    #[serde(default)]
    pub entry: Option<CastEntryMeta>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub stream_url: Option<String>,
    #[serde(default)]
    pub http_stream_url: Option<String>,
    #[serde(default)]
    pub start_position_ms: u64,
    #[serde(default)]
    pub position_ms: Option<u64>,
    #[serde(default)]
    pub delta_ms: Option<i64>,
    #[serde(default)]
    pub stream: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A tracker, channel, or peer set changed.
    Update,
    /// Subscribed sources changed through the loopback HTTP daemon.
    Sources(Vec<SourceInfo>),
    /// Cast receivers, remote session, or local TV receiver metadata changed.
    Cast(CastStatus),
    /// A remote sender pushed a playback command into our local TV Receiver mode.
    ReceiverCommand(ReceiverCommand),
    /// The worker hit an uncaught error.
    Fatal(String),
    /// The worklet closed its IPC; no more replies will come.
    Exited,
}

// bare-kit 3's C API (include/bare-kit.h in the framework).

#[repr(C)]
struct BareWorklet {
    _opaque: [u8; 0],
}

#[repr(C)]
struct BareIpcPoll {
    _private: [u8; 0],
}

type IpcPollCb = extern "C" fn(*mut BareIpcPoll, c_int);

const IPC_READABLE: c_int = 0x1;
const IPC_WRITABLE: c_int = 0x2;
const IPC_WOULD_BLOCK: c_int = -1;

#[repr(C)]
struct BareIpc {
    _opaque: [u8; 0],
}

unsafe extern "C" {
    fn bare_worklet_create(options: *const c_void, result: *mut *mut BareWorklet) -> c_int;
    fn bare_worklet_start(worklet: *mut BareWorklet, filename: *const c_char, source: *const c_void, len: usize, argc: c_int, argv: *const *const c_char) -> c_int;
    fn bare_worklet_suspend(worklet: *mut BareWorklet, linger: c_int) -> c_int;
    fn bare_worklet_resume(worklet: *mut BareWorklet) -> c_int;
    fn bare_ipc_create(worklet: *mut BareWorklet, result: *mut *mut BareIpc) -> c_int;
    fn bare_ipc_read(ipc: *mut BareIpc, data: *mut c_void, len: usize) -> c_int;
    fn bare_ipc_write(ipc: *mut BareIpc, data: *const c_void, len: usize) -> c_int;
    fn bare_ipc_poll_create(ipc: *mut BareIpc, result: *mut *mut BareIpcPoll) -> c_int;
    fn bare_ipc_poll_start(poll: *mut BareIpcPoll, events: c_int, cb: IpcPollCb) -> c_int;
    fn bare_ipc_poll_stop(poll: *mut BareIpcPoll) -> c_int;
    fn bare_ipc_poll_set_data(poll: *mut BareIpcPoll, data: *mut c_void);
    fn bare_ipc_poll_get_data(poll: *mut BareIpcPoll) -> *mut c_void;
    fn malloc_zone_pressure_relief(zone: *mut c_void, goal: usize) -> usize;
}

type Reply = Result<Value, String>;

/// State shared with the IPC reader thread.
#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    subscribers: Mutex<Vec<mpsc::UnboundedSender<Event>>>,
}

struct IpcCtx {
    shared: Arc<Shared>,
    ipc: *mut BareIpc,
    poll: *mut BareIpcPoll,
    outbox: Mutex<VecDeque<Vec<u8>>>,
    buffered: Mutex<Vec<u8>>,
    writing: Mutex<()>,
}

unsafe impl Send for IpcCtx {}
unsafe impl Sync for IpcCtx {}

extern "C" fn ipc_callback(poll: *mut BareIpcPoll, events: c_int) {
    let data = unsafe { bare_ipc_poll_get_data(poll) } as *const IpcCtx;
    if data.is_null() {
        return;
    }
    let ctx = unsafe { &*data };
    if events & IPC_READABLE != 0 {
        ctx.read_all();
    }
    if events & IPC_WRITABLE != 0 {
        let _ = ctx.flush();
    }
}

impl IpcCtx {
    fn watch(&self, writable: bool) {
        unsafe {
            bare_ipc_poll_stop(self.poll);
            let events = IPC_READABLE | if writable { IPC_WRITABLE } else { 0 };
            bare_ipc_poll_start(self.poll, events, ipc_callback);
        }
    }

    fn read_all(&self) {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = unsafe { bare_ipc_read(self.ipc, chunk.as_mut_ptr().cast(), chunk.len()) };
            if n > 0 {
                let mut buffered = self.buffered.lock();
                buffered.extend_from_slice(&chunk[..n as usize]);
                while let Some(end) = buffered.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buffered.drain(..=end).collect();
                    drop(buffered);
                    self.shared.dispatch(&line[..end]);
                    buffered = self.buffered.lock();
                }
                continue;
            }
            if n == IPC_WOULD_BLOCK {
                break;
            }
            self.shared.pending.lock().clear();
            self.shared.broadcast(Event::Exited);
            break;
        }
    }

    fn flush(&self) -> Result<(), String> {
        let _writer = self.writing.lock();
        loop {
            let front = self.outbox.lock().front().cloned();
            let Some(bytes) = front else {
                self.watch(false);
                return Ok(());
            };
            let n = unsafe { bare_ipc_write(self.ipc, bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                let mut outbox = self.outbox.lock();
                if let Some(entry) = outbox.front_mut() {
                    entry.drain(..(n as usize).min(entry.len()));
                    if entry.is_empty() {
                        outbox.pop_front();
                    }
                }
                continue;
            }
            if n == IPC_WOULD_BLOCK {
                self.watch(true);
                return Ok(());
            }
            return Err("The P2P worker stopped".to_string());
        }
    }

    fn send(&self, bytes: Vec<u8>) -> Result<(), String> {
        let _writer = self.writing.lock();
        let n = unsafe { bare_ipc_write(self.ipc, bytes.as_ptr().cast(), bytes.len()) };
        if n >= 0 {
            if n as usize == bytes.len() {
                return Ok(());
            }
            self.outbox.lock().push_back(bytes[n as usize..].to_vec());
        } else if n == IPC_WOULD_BLOCK {
            self.outbox.lock().push_back(bytes);
        } else {
            return Err("The P2P worker stopped".to_string());
        }
        self.watch(true);
        Ok(())
    }
}

pub struct Worker {
    worklet: *mut BareWorklet,
    ipc: *mut BareIpc,
    poll: *mut BareIpcPoll,
    ctx: Arc<IpcCtx>,
    next_id: AtomicU64,
    shared: Arc<Shared>,
}

// The worklet handle is only passed to bare-kit calls, which are thread safe;
// everything else is behind a Mutex or atomic.
unsafe impl Send for Worker {}
unsafe impl Sync for Worker {}

static WORKER: LazyLock<Result<Worker, String>> = LazyLock::new(Worker::spawn);

/// The process's one worklet, started on first use.
pub fn worker() -> Result<&'static Worker, String> {
    WORKER.as_ref().map_err(Clone::clone)
}

/// Drains empty xzone magazines across Rust, RocksDB, BareKit, and VideoToolbox back to macOS as clean pages.
pub fn release_unused_memory() {
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
    }
}

impl Worker {
    fn spawn() -> Result<Worker, String> {
        let (worklet, ipc, poll) = unsafe {
            // A write to a closed socket or pipe must fail with EPIPE, not kill the app.
            libc::signal(libc::SIGPIPE, libc::SIG_IGN);
            let mut worklet = std::ptr::null_mut();
            // Default options: the heap limit follows the machine's memory.
            check(bare_worklet_create(std::ptr::null(), &mut worklet), "create")?;
            // The ipc exists before the worker runs, so nothing it writes at start is missed.
            let mut ipc = std::ptr::null_mut();
            check(bare_ipc_create(worklet, &mut ipc), "IPC create")?;
            let mut poll = std::ptr::null_mut();
            check(bare_ipc_poll_create(ipc, &mut poll), "IPC poll create")?;
            // Returns once the filename and source have been copied in.
            check(bare_worklet_start(worklet, c"/worker.bundle".as_ptr(), BUNDLE.as_ptr().cast(), BUNDLE.len(), 0, std::ptr::null()), "start")?;
            (worklet, ipc, poll)
        };
        let shared = Arc::new(Shared::default());
        let ctx = Arc::new(IpcCtx {
            shared: shared.clone(),
            ipc,
            poll,
            outbox: Mutex::new(VecDeque::new()),
            buffered: Mutex::new(Vec::new()),
            writing: Mutex::new(()),
        });
        unsafe {
            bare_ipc_poll_set_data(poll, Arc::as_ptr(&ctx) as *const c_void as *mut c_void);
            check(bare_ipc_poll_start(poll, IPC_READABLE, ipc_callback), "IPC poll start")?;
        }
        Ok(Worker { worklet, ipc, poll, ctx, next_id: AtomicU64::new(1), shared })
    }

    pub async fn start(&self, settings: &Settings) -> Result<Status, String> {
        let folder = if !settings.tracker.is_empty() {
            settings.tracker.as_str()
        } else if !settings.mnemonic.is_empty() {
            "linked"
        } else {
            "default"
        };
        let storage = STORE_DIR.join("trackers").join(folder);
        let tracker = if settings.tracker.is_empty() { Value::Null } else { json!(settings.tracker) };
        let mnemonic = if settings.mnemonic.is_empty() { Value::Null } else { json!(settings.mnemonic) };
        let join = !settings.mnemonic.is_empty() && settings.tracker.is_empty();
        let params = json!({
            "storage": storage.to_string_lossy(),
            "tracker": tracker,
            "mnemonic": mnemonic,
            "join": join,
            "sources": settings.sources,
            "relayThrough": non_empty(&settings.relay_through),
            "bootstrap": non_empty(&settings.bootstrap),
            "lan": settings.lan_discovery,
            "privateRouting": settings.private_routing,
        });
        parse(self.call("start", params).await?)
    }

    pub async fn status(&self) -> Result<Status, String> {
        parse(self.call("status", json!({})).await?)
    }

    /// Every entry for `id`, or the whole subscribed catalog when `id` is None.
    pub async fn search(&self, id: Option<&str>) -> Result<Vec<Entry>, String> {
        parse(self.call("search", json!({ "id": id })).await?)
    }

    pub async fn add_source(&self, key: &str, kind: &str, alias: &str) -> Result<SourceInfo, String> {
        let res = self.call("addSource", json!({ "key": key, "kind": kind, "alias": alias })).await?;
        parse(res.get("source").cloned().unwrap_or(Value::Null))
    }

    pub async fn remove_source(&self, key: &str) -> Result<(), String> {
        self.call("removeSource", json!({ "key": key })).await.map(drop)
    }

    pub async fn focus_source(&self, key: &str) -> Result<(), String> {
        self.call("focusSource", json!({ "key": key })).await.map(drop)
    }

    pub async fn open_uri(&self, uri: &str) -> Result<OpenUriResult, String> {
        let storage = STORE_DIR.join("cast").to_string_lossy().to_string();
        parse(self.call("openUri", json!({ "uri": uri, "storage": storage })).await?)
    }


    pub async fn warm(&self, key: &str) -> Result<(), String> {
        self.call("warm", json!({ "key": key })).await.map(drop)
    }

    /// A film is playing here: stop fetching blocks ahead for peers so the picture never waits
    /// behind the seeding read-ahead. Peers still get every block on demand.
    pub async fn set_player_active(&self, active: bool) -> Result<(), String> {
        self.call("setPlayerActive", json!({ "active": active })).await.map(drop)
    }
    pub async fn remove_entry(&self, key: &str) -> Result<(), String> {
        self.call("remove", json!({ "key": key })).await.map(drop)
    }
    pub async fn identity(&self, reveal_mnemonic: bool) -> Result<IdentityInfo, String> {
        parse(self.call("identity", json!({ "revealMnemonic": reveal_mnemonic })).await?)
    }
    pub async fn grant_writer(&self, writer: &str, role: &str, alias: &str) -> Result<(), String> {
        self.call("grantWriter", json!({ "writer": writer, "role": role, "alias": alias })).await.map(drop)
    }
    pub async fn revoke_writer(&self, writer: &str, purge_entries: bool) -> Result<(), String> {
        self.call("revokeWriter", json!({ "writer": writer, "purgeEntries": purge_entries })).await.map(drop)
    }
    pub async fn rotate_epoch(&self) -> Result<Value, String> {
        self.call("rotateEpoch", json!({})).await
    }
    pub async fn clear_cache(&self, key: Option<&str>) -> Result<(), String> {
        self.call("clearCache", json!({ "key": key })).await.map(drop)
    }
    fn cast_dir() -> String {
        STORE_DIR.join("cast").to_string_lossy().to_string()
    }

    pub async fn cast_status(&self) -> Result<CastStatus, String> {
        parse(self.call("castStatus", json!({ "storage": Self::cast_dir() })).await?)
    }

    pub async fn cast_pair(&self, params: Value) -> Result<CastStatus, String> {
        let mut body = params;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("storage").or_insert_with(|| json!(Self::cast_dir()));
        }
        parse(self.call("castPair", body).await?)
    }

    pub async fn cast_remove(&self, id: &str) -> Result<CastStatus, String> {
        parse(self.call("castRemove", json!({ "id": id, "storage": Self::cast_dir() })).await?)
    }

    pub async fn cast_play(&self, receiver_id: &str, key: &str, prefer_mode: &str, start_position_ms: u64) -> Result<CastStatus, String> {
        parse(
            self.call(
                "castPlay",
                json!({
                    "storage": Self::cast_dir(),
                    "receiverId": receiver_id,
                    "key": key,
                    "preferMode": prefer_mode,
                    "startPositionMs": start_position_ms,
                }),
            )
            .await?,
        )
    }

    pub async fn cast_attach(&self, receiver_id: &str) -> Result<CastStatus, String> {
        parse(self.call("castAttach", json!({ "storage": Self::cast_dir(), "receiverId": receiver_id })).await?)
    }

    pub async fn cast_control(&self, params: Value) -> Result<CastStatus, String> {
        let mut body = params;
        if let Some(obj) = body.as_object_mut() {
            obj.entry("storage").or_insert_with(|| json!(Self::cast_dir()));
        }
        parse(self.call("castControl", body).await?)
    }

    pub async fn cast_stop(&self, stop_playback: bool) -> Result<CastStatus, String> {
        parse(self.call("castStop", json!({ "storage": Self::cast_dir(), "stopPlayback": stop_playback })).await?)
    }

    pub async fn receiver_start(&self, name: &str, open_auth: bool) -> Result<ReceiverInfo, String> {
        parse(self.call("receiverStart", json!({ "storage": Self::cast_dir(), "name": name, "openAuth": open_auth })).await?)
    }

    pub async fn receiver_stop(&self) -> Result<(), String> {
        self.call("receiverStop", json!({})).await.map(drop)
    }

    pub async fn receiver_rotate_code(&self) -> Result<ReceiverInfo, String> {
        parse(self.call("receiverRotateCode", json!({ "storage": Self::cast_dir() })).await?)
    }

    pub async fn receiver_report_state(&self, state: Value) -> Result<(), String> {
        self.call("receiverReportState", json!({ "storage": Self::cast_dir(), "state": state })).await.map(drop)
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
        if let Err(err) = self.ctx.send(line) {
            self.shared.pending.lock().remove(&id);
            return Err(err);
        }
        rx.await.map_err(|_| "The P2P worker stopped".to_string())?
    }

}

impl Shared {

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
                Some("sources") => {
                    if let Ok(list) = serde_json::from_value::<Vec<SourceInfo>>(msg.get("sources").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::Sources(list));
                    }
                    self.broadcast(Event::Update);
                }
                Some("cast") => {
                    if let Ok(st) = serde_json::from_value::<CastStatus>(msg.get("cast").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::Cast(st));
                    }
                }
                Some("receiverCommand") => {
                    if let Ok(cmd) = serde_json::from_value::<ReceiverCommand>(msg.get("command").cloned().unwrap_or(Value::Null)) {
                        self.broadcast(Event::ReceiverCommand(cmd));
                    }
                }
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


fn non_empty(list: &[String]) -> Option<&[String]> {
    if list.is_empty() { None } else { Some(list) }
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| format!("Unexpected reply from the P2P worker: {err}"))
}

/// Where the app keeps its settings and bare-kit's unpacked assets: the same
/// place the Dioxus app used, so an upgrade keeps them. PEARTUBE_STORAGE
/// overrides this and STORE_DIR.
pub static DATA_DIR: LazyLock<PathBuf> = LazyLock::new(|| app_dir("Library/Application Support/PearTube"));

/// Where each tracker's Corestore lives. The app only reads, so its stores hold
/// nothing peers cannot serve again, and they can be large: keep them out of
/// backups (Time Machine skips Library/Caches).
static STORE_DIR: LazyLock<PathBuf> = LazyLock::new(|| app_dir("Library/Caches/PearTube"));

fn app_dir(in_home: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("PEARTUBE_STORAGE") {
        return dir.into();
    }
    PathBuf::from(std::env::var_os("HOME").expect("HOME is set")).join(in_home)
}
