//! The app's P2P stack without the UI, for test/mobile.e2e.js. Starts the real
//! worklet, joins the tracker in PEARTUBE_STORAGE/settings.json, and prints one
//! JSON line per stage:
//!   streamed  an entry for <id> appeared, and its stream URL read back
//!   second    a second entry for <id> appeared
//!   removed   that entry was removed again
//! After `streamed` it never polls: like the UI, it searches only when the
//! worker reports an update. The test publishes and removes the second entry
//! when it reads each line.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use peartube::settings::Settings;
use peartube::worker::{Event, worker};
use sha2::{Digest, Sha256};

static STAGE: AtomicU8 = AtomicU8::new(0);
const STAGES: [&str; 3] = ["streamed", "second", "removed"];

fn main() {
    let id = std::env::args().nth(1).expect("usage: smoke <id>");
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(240));
        let waiting = STAGES[STAGE.load(Ordering::SeqCst) as usize];
        println!("{}", serde_json::json!({ "stage": "timeout", "waitingFor": waiting }));
        std::process::exit(1);
    });
    let worker = worker().expect("start the worklet");
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
        let range = ureq::get(&entry.stream_url).header("Range", "bytes=1000000-1065535").call().expect("range read");
        let range_status = range.status().as_u16();
        let range_sha256 = hex(&Sha256::digest(read(range.into_body())));
        let full = read(ureq::get(&entry.stream_url).call().expect("full read").into_body());
        let titles: Vec<String> = worker.search(None).await.expect("list the tracker").into_iter().map(|entry| entry.title).collect();
        // Whatever arrived so far predates the next change.
        while events.try_recv().is_ok() {}
        emit(serde_json::json!({
            "stage": "streamed",
            "tracker": status.tracker,
            "writer": status.writer,
            "lan": status.lan,
            "entry": { "key": entry.key, "title": entry.title, "size": entry.size, "sha256": entry.sha256, "local": entry.local },
            "foundMs": found_ms,
            "rangeStatus": range_status,
            "rangeSha256": range_sha256,
            "fullBytes": full.len(),
            "fullSha256": hex(&Sha256::digest(&full)),
            "titles": titles,
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
