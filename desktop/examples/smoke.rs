//! The app's P2P stack without the UI, for test/desktop.e2e.js. Starts the real
//! engine (the Bare worklet, or the Rust engine with `--features engine-rust`),
//! joins the tracker in PEARTUBE_STORAGE/settings.json, and prints one
//! JSON line per stage:
//!   streamed  an entry for <id> appeared, and its stream URL read back; with
//!             PEARTUBE_PLAY set, also played through the app's player with
//!             the headless backend (frame MD5s and the PCM's SHA-256)
//!   second    a second entry for <id> appeared
//!   removed   that entry was removed again
//! After `streamed` it never polls: like the UI, it searches only when the
//! worker reports an update. The test publishes and removes the second entry
//! when it reads each line.

#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use peartube::playback::CODECS;
use peartube::settings::Settings;
use peartube::worker::{Event, worker};
use sha2::{Digest, Sha256};

static STAGE: AtomicU8 = AtomicU8::new(0);
const STAGES: [&str; 3] = ["streamed", "second", "removed"];
/// Seconds after start before the watchdog gives up; playback adds its own.
static DEADLINE: AtomicU64 = AtomicU64::new(240);

fn main() {
    let id = std::env::args().nth(1).expect("usage: smoke <id>");
    let start = Instant::now();
    std::thread::spawn(move || {
        while start.elapsed().as_secs() < DEADLINE.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_secs(1));
        }
        let waiting = STAGES[STAGE.load(Ordering::SeqCst) as usize];
        println!("{}", serde_json::json!({ "stage": "timeout", "waitingFor": waiting }));
        std::process::exit(1);
    });
    let worker = worker().expect("start the engine");
    let mut events = worker.subscribe();
    futures_executor::block_on(async {
        let started = Instant::now();
        let status = worker.start(&Settings::load()).await.expect("start the node");
        let entry = loop {
            if let Some(entry) = worker.search(Some(&id)).await.expect("search").into_iter().next() {
                break entry;
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let found_ms = started.elapsed().as_millis();
        if std::env::var_os("PEARTUBE_BENCH_COLD").is_some() {
            assert_eq!(entry.cached_bytes, 0, "cold play requires uncached entry");
            let use_warm = std::env::var("PEARTUBE_WARM").is_ok_and(|v| v == "1");
            DEADLINE.fetch_add(120, Ordering::SeqCst);
            let headless = player::Headless::new();
            let ctx = CODECS.clone();
            let click_t0 = Instant::now();
            let warm_handle = use_warm.then(|| {
                let warm_key = entry.key.clone();
                std::thread::spawn(move || {
                    futures_executor::block_on(async move {
                        let _ = worker.warm(&warm_key).await;
                    });
                    click_t0.elapsed().as_millis()
                })
            });
            let p = player::Player::open(&entry.stream_url, headless, ctx, player::PlayerOptions::default(), |_| {});
            let mut first_picture_ms = None;
            for _ in 0..4000 {
                let st = p.state();
                if st.video_size.is_some() && (!st.buffering || !st.position.is_zero()) {
                    first_picture_ms = Some(click_t0.elapsed().as_millis());
                    break;
                }
                if let Some(err) = st.error {
                    panic!("player error: {err}");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let warm_done_ms = warm_handle.and_then(|h| h.join().ok());
            drop(p);
            emit(serde_json::json!({
                "stage": "cold_first_frame",
                "withWarm": use_warm,
                "initialCachedBytes": entry.cached_bytes,
                "foundMs": found_ms,
                "warmDoneMs": warm_done_ms,
                "firstPictureMs": first_picture_ms,
            }));
            return;
        }
        let range = ureq::get(&entry.stream_url).header("Range", "bytes=1000000-1065535").call().expect("range read");
        let range_status = range.status().as_u16();
        let range_sha256 = hex(&Sha256::digest(read(range.into_body())));
        let full = read(ureq::get(&entry.stream_url).call().expect("full read").into_body());
        let titles: Vec<String> = worker.search(None).await.expect("list the tracker").into_iter().map(|entry| entry.title).collect();
        let api_url = status.api_url.clone().expect("loopback /v1 daemon url");
        let ident = worker.identity(true).await.expect("worklet identity");
        let manifest: serde_json::Value = serde_json::from_slice(&read(
            ureq::get(&format!("{api_url}/manifest.json")).call().expect("stremio manifest").into_body(),
        ))
        .expect("manifest json");
        let played = std::env::var_os("PEARTUBE_PLAY").map(|_| {
            DEADLINE.fetch_add(300, Ordering::SeqCst);
            play(&entry.stream_url)
        });
        // Whatever arrived so far predates the next change.
        while events.try_recv().is_ok() {}
        emit(serde_json::json!({
            "stage": "streamed",
            "tracker": status.tracker,
            "channel": status.channel,
            "apiUrl": api_url,
            "manifestId": manifest["id"],
            "writer": status.writer,
            "lan": status.lan,
            "writable": status.writable,
            "mnemonicWords": ident.mnemonic.split_whitespace().count(),
            "entry": { "key": entry.key, "title": entry.title, "size": entry.size, "sha256": entry.sha256, "local": entry.local, "magnetUrl": entry.magnet_url },
            "foundMs": found_ms,
            "rangeStatus": range_status,
            "rangeSha256": range_sha256,
            "fullBytes": full.len(),
            "fullSha256": hex(&Sha256::digest(&full)),
            "titles": titles,
            "played": played,
        }));

        for (stage, count) in [(1u8, 2usize), (2, 1)] {
            STAGE.store(stage, Ordering::SeqCst);
            let waiting = Instant::now();
            let keys = loop {
                match events.next().await {
                    Some(Event::Update) => {}
                    Some(event) => panic!("worker event {event:?}"),
                    None => panic!("the worker stopped"),
                }
                let keys: Vec<String> = worker.search(Some(&id)).await.expect("search").into_iter().map(|entry| entry.key).collect();
                if keys.len() == count {
                    break keys;
                }
            };
            emit(serde_json::json!({ "stage": STAGES[stage as usize], "keys": keys, "waitedMs": waiting.elapsed().as_millis() }));
        }
    });
}

/// Plays `url` through the player the UI uses, over the worklet's HTTP
/// stream, as fast as it decodes, and reports what reached the sinks.
fn play(url: &str) -> serde_json::Value {
    use player::{Headless, Player, PlayerOptions};
    let started = Instant::now();
    let headless = Headless::new();
    let ctx = CODECS.clone();
    let options = PlayerOptions { realtime: false, ..PlayerOptions::default() };
    let player = Player::open(url, headless.clone(), ctx, options, |_| {});
    let state = player.wait();
    drop(player);
    let capture = headless.capture();
    let video = capture.video.first();
    let audio = capture.audio.first();
    let pcm: Vec<u8> = audio.map(|a| a.pcm.iter().flat_map(|s| s.to_le_bytes()).collect()).unwrap_or_default();
    serde_json::json!({
        "ended": state.ended,
        "error": state.error,
        "ms": started.elapsed().as_millis(),
        "video": video.map(|v| serde_json::json!({ "codec": v.codec, "width": v.width, "height": v.height, "frameMd5": v.frame_md5 })),
        "audio": audio.map(|a| serde_json::json!({ "codec": a.codec, "sampleRate": a.sample_rate, "channels": a.channels, "samples": a.pcm.len(), "pcmSha256": hex(&Sha256::digest(&pcm)) })),
    })
}

fn emit(line: serde_json::Value) {
    println!("{line}");
    std::io::stdout().flush().expect("flush stdout");
}

fn read(body: ureq::Body) -> Vec<u8> {
    let mut bytes = Vec::new();
    body.into_reader().read_to_end(&mut bytes).expect("read body");
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
