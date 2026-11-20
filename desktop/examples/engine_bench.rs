//! Resource use of the app's P2P engine on fixed workloads, so the Bare worklet (default build)
//! and the Rust engine (`--features engine-rust`) can be compared on one machine. Both engines run
//! in this process, so its CPU time and memory are the engine's plus this small driver.
//!
//!   PEARTUBE_STORAGE=<empty dir> engine_bench <channel key> <expected entries> <stream seconds> <film id>
//!
//! Phases, one JSON line each: `follow` (cold start until the listing holds still for 20 s),
//! `idle` (120 s), `stream` (one reader at 2 MB/s from 30% into a fixed film, after 30 s of
//! fill), `after` (60 s idle). LAN discovery is off so both engines see the same public peers.

#![forbid(unsafe_code)]

use std::io::Read;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use peartube::settings::Settings;
use peartube::worker::worker;

const RATE: f64 = 2_000_000.0;
const MIB: f64 = 1_048_576.0;

/// CPU seconds and resident KiB of this process, from `ps` (no unsafe here).
fn sample() -> (f64, u64) {
    let out = Command::new("/bin/ps").args(["-o", "cputime=,rss=", "-p", &std::process::id().to_string()]).output().expect("ps");
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let cpu = parts.next().unwrap_or("0:0");
    let rss = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut secs = 0.0;
    for field in cpu.split(':') {
        secs = secs * 60.0 + field.parse::<f64>().unwrap_or(0.0);
    }
    (secs, rss)
}

/// macOS's own memory charge for this process (`phys_footprint`, which counts compressed and
/// swapped dirty pages that `ps` RSS leaves out) and its lifetime peak, in MB.
fn footprint() -> (f64, f64) {
    let out = Command::new("/usr/bin/footprint").arg(std::process::id().to_string()).output().expect("footprint");
    let text = String::from_utf8_lossy(&out.stdout);
    let value = |label: &str| -> f64 {
        text.lines().find_map(|l| l.trim().strip_prefix(label)).map_or(0.0, |rest| {
            let mut parts = rest.split_whitespace();
            let n: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
            match parts.next().unwrap_or("MB") {
                "KB" => n / 1024.0,
                "GB" => n * 1024.0,
                "B" => n / 1_048_576.0,
                _ => n,
            }
        })
    };
    (value("phys_footprint:"), value("phys_footprint_peak:"))
}

/// Highest resident size seen since the last `take`, sampled once a second: each sample spawns
/// `/bin/ps`, which this process pays for (`BENCH_FLOOR=1` measures that floor without an engine).
struct PeakRss(Arc<AtomicU64>);

impl PeakRss {
    fn start() -> Self {
        let peak = Arc::new(AtomicU64::new(0));
        let seen = peak.clone();
        std::thread::spawn(move || loop {
            seen.fetch_max(sample().1, Ordering::Relaxed);
            std::thread::sleep(Duration::from_secs(1));
        });
        Self(peak)
    }
    fn take(&self) -> u64 {
        self.0.swap(0, Ordering::Relaxed)
    }
}

fn main() {
    let usage = "usage: engine_bench <channel key> <expected entries> <stream seconds> <film id>";
    let channel = std::env::args().nth(1).expect(usage);
    let expected: usize = std::env::args().nth(2).and_then(|v| v.parse().ok()).expect(usage);
    let stream_secs: u64 = std::env::args().nth(3).and_then(|v| v.parse().ok()).unwrap_or(180);
    let mut settings = Settings::load();
    if !settings.sources.iter().any(|s| s.key == channel) {
        let spec = serde_json::from_value(serde_json::json!({ "key": channel, "kind": "channel" })).expect("source spec");
        settings.add_or_update_source(spec);
    }
    settings.lan_discovery = false;
    settings.save().expect("save settings");

    let peak = PeakRss::start();
    if std::env::var_os("BENCH_FLOOR").is_some() {
        // The harness alone: the sampler and nothing else, over the idle phase's length.
        let (cpu0, _) = sample();
        std::thread::sleep(Duration::from_secs(120));
        let (cpu, rss) = sample();
        println!("{}", serde_json::json!({ "phase": "floor", "cpuS": round(cpu - cpu0), "cpuPct": round((cpu - cpu0) / 120.0 * 100.0), "rssMB": round(rss as f64 / 1024.0) }));
        std::process::exit(0);
    }
    let worker = worker().expect("start the engine");
    futures_executor::block_on(async {
        let phase_start = |name: &str| {
            peak.take();
            let (cpu, _) = sample();
            (name.to_string(), Instant::now(), cpu)
        };
        let phase_end = |(name, t0, cpu0): (String, Instant, f64), extra: serde_json::Value| {
            let (cpu, rss) = sample();
            let wall = t0.elapsed().as_secs_f64();
            // After the CPU reading, so the footprint tool's own work stays out of the phase.
            let (fp, fp_peak) = footprint();
            let mut line = serde_json::json!({
                "phase": name,
                "wallS": round(wall),
                "cpuS": round(cpu - cpu0),
                "cpuPct": round((cpu - cpu0) / wall * 100.0),
                "rssMB": round(rss as f64 / 1024.0),
                "peakRssMB": round(peak.take().max(rss) as f64 / 1024.0),
                "footprintMB": round(fp),
                "footprintPeakMB": round(fp_peak),
            });
            line.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
            println!("{line}");
        };

        let p = phase_start("follow");
        // Search the way the app does: only after the engine reports a change (desktop/src/app.rs `follow`).
        let dirty = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let updates = Arc::new(AtomicU64::new(0));
        let (mark, count) = (dirty.clone(), updates.clone());
        let mut events = worker.subscribe();
        std::thread::spawn(move || {
            futures_executor::block_on(async move {
                use futures_util::StreamExt;
                while let Some(event) = events.next().await {
                    if matches!(event, peartube::worker::Event::Update | peartube::worker::Event::Sources(_)) {
                        count.fetch_add(1, Ordering::Relaxed);
                        mark.store(true, Ordering::Relaxed);
                    }
                }
            })
        });
        let status = worker.start(&settings).await.expect("start the node");
        // Both engines must reach the same complete listing (the relay's entry count) before idle, or one would
        // still be syncing while the other idles.
        let (mut list, mut searches, mut stable, mut complete_at) = (Vec::new(), 0u32, Instant::now(), None);
        loop {
            if dirty.swap(false, Ordering::Relaxed) {
                let next = worker.search(None).await.expect("search");
                searches += 1;
                if next.len() != list.len() {
                    stable = Instant::now();
                }
                list = next;
                if list.len() >= expected && complete_at.is_none() {
                    complete_at = Some(p.1.elapsed().as_secs_f64());
                }
            }
            if list.len() >= expected && stable.elapsed() > Duration::from_secs(20) {
                break;
            }
            if p.1.elapsed() > Duration::from_secs(600) {
                phase_end(p, serde_json::json!({ "ok": false, "error": format!("{} of {expected} entries after 600 s", list.len()), "searches": searches }));
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let entries = list;
        phase_end(p, serde_json::json!({ "ok": true, "entries": entries.len(), "completeS": complete_at.map(round), "searches": searches }));

        // Idle as the apps idle: refresh (status + full listing) after each update event, at most every 250 ms
        // (android AppModel `refreshes`), so the engine's own update rate is part of the idle cost.
        let p = phase_start("idle");
        let (u0, mut refreshes) = (updates.load(Ordering::Relaxed), 0u32);
        while p.1.elapsed() < Duration::from_secs(120) {
            if dirty.swap(false, Ordering::Relaxed) {
                let _ = worker.status().await;
                let _ = worker.search(None).await;
                refreshes += 1;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let st = worker.status().await.expect("status");
        phase_end(p, serde_json::json!({ "peers": st.peers, "updates": updates.load(Ordering::Relaxed) - u0, "refreshes": refreshes }));

        // The same film for both engines, named by its entry id (one the relay is known to serve).
        let film_id = std::env::args().nth(4).expect("film id: a usage argument after stream seconds");
        let film = entries.iter().filter(|e| e.id == film_id).min_by_key(|e| (e.size, e.key.clone())).expect("the film id is listed").clone();
        let _ = worker.set_player_active(true).await;
        let read = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(std::sync::Mutex::new(None::<String>));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (got, fail, halt) = (read.clone(), failed.clone(), stop.clone());
        let url = film.stream_url.clone();
        let offset = film.size * 3 / 10;
        let reader = std::thread::spawn(move || {
            let started = Instant::now();
            let resp = match ureq::get(&url).header("Range", &format!("bytes={offset}-")).call() {
                Ok(resp) if resp.status().as_u16() == 206 => resp,
                Ok(resp) => return *fail.lock().unwrap() = Some(format!("status {}", resp.status())),
                Err(err) => return *fail.lock().unwrap() = Some(err.to_string()),
            };
            let mut body = resp.into_body().into_reader();
            let mut buf = vec![0u8; 256 * 1024];
            // Dropping the body at the stop flag closes the request, so `after` is idle after play.
            while !halt.load(Ordering::Relaxed) {
                match body.read(&mut buf) {
                    Ok(0) => return *fail.lock().unwrap() = Some("body ended".into()),
                    Err(err) => return *fail.lock().unwrap() = Some(err.to_string()),
                    Ok(n) => {
                        let total = got.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                        let ahead = total as f64 / RATE - started.elapsed().as_secs_f64();
                        if ahead > 0.0 {
                            std::thread::sleep(Duration::from_secs_f64(ahead.min(0.25)));
                        }
                    }
                }
            }
        });
        let p = phase_start("fill");
        let rx0 = worker.status().await.map(|s| s.rx_bytes).unwrap_or(0);
        std::thread::sleep(Duration::from_secs(30));
        let rx1 = worker.status().await.map(|s| s.rx_bytes).unwrap_or(0);
        phase_end(p, serde_json::json!({ "film": film.title, "key": film.key, "size": film.size, "readMiB": round(read.load(Ordering::Relaxed) as f64 / MIB), "rxMiB": round((rx1 - rx0) as f64 / MIB) }));

        let p = phase_start("stream");
        let read0 = read.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_secs(stream_secs));
        let rx2 = worker.status().await.map(|s| s.rx_bytes).unwrap_or(0);
        let read_mib = (read.load(Ordering::Relaxed) - read0) as f64 / MIB;
        let rx_mib = (rx2 - rx1) as f64 / MIB;
        let cpu_now = sample().0 - p.2;
        // Fail closed: the reader must have kept up with the target rate the whole phase.
        let expected_mib = RATE * stream_secs as f64 / MIB;
        let error = failed.lock().unwrap().clone().or_else(|| (read_mib < expected_mib * 0.95).then(|| format!("read {read_mib:.0} MiB of {expected_mib:.0}")));
        phase_end(p, serde_json::json!({
            "readMiB": round(read_mib),
            "rxMiB": round(rx_mib),
            "ok": error.is_none(),
            "error": error,
            "cpuSPerGiBRead": error.is_none().then(|| round(cpu_now / (read_mib / 1024.0))),
        }));
        stop.store(true, Ordering::Relaxed);
        // The paced reader sleeps at most 250 ms between reads; a stalled read is reported, not waited on.
        let closed = (0..40).any(|_| reader.is_finished() || { std::thread::sleep(Duration::from_millis(100)); false });
        if !closed {
            println!("{}", serde_json::json!({ "warning": "the stream reader did not stop within 4 s; `after` includes it" }));
        }
        let _ = worker.set_player_active(false).await;

        let p = phase_start("after");
        std::thread::sleep(Duration::from_secs(60));
        phase_end(p, serde_json::json!({ "peers": worker.status().await.map(|s| s.peers).unwrap_or(0), "apiUrl": status.api_url }));
    });
    std::process::exit(0);
}

fn round(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
