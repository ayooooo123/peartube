//! End-to-end `#![forbid(unsafe_code)]` macOS GPUI verification:
//!   1. `VideoView` attaches at `[0, 0, 0, 0]` before GPUI layout supplies the slot.
//!   2. Double-clicking near macOS's configured `[NSEvent doubleClickInterval]` boundary
//!      (`interval - 70 ms`, e.g. ~450 ms) while maximized to restore — and again to maximize —
//!      never flips `player.state().playing` (`playingStateFlips == 0` across every 10 ms poll).
//!   3. Sampling `video_metrics()` on every 10 ms tick *throughout* both transitions verifies
//!      `maxEdgeErrorPt <= 1.0` between parent and `NSView`/`container`/sublayers and
//!      `maxActiveAnimationKeys == 0`.
//!   4. Clicking Cast while playing opens the Cast popup OVER the playing video without
//!      stopping or pausing playback, and dismissing the popup leaves the video playing.
//! Writes `desktop/target/e2e/window-smooth-result.json`.

#![forbid(unsafe_code)]

#[allow(dead_code)]
#[path = "../src/theme.rs"]
mod theme;
#[allow(dead_code)]
#[path = "../src/qr.rs"]
mod qr;
#[allow(dead_code)]
#[path = "../src/video.rs"]
mod video;
#[allow(dead_code)]
#[path = "../src/settings_screen.rs"]
mod settings_screen;
#[allow(dead_code)]
#[path = "../src/list.rs"]
mod list;
#[allow(dead_code)]
#[path = "../src/play.rs"]
mod play;
#[allow(dead_code)]
#[path = "../src/cast_screen.rs"]
mod cast_screen;
#[allow(dead_code)]
#[path = "../src/app.rs"]
mod app;

use std::borrow::Cow;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use gpui_kit::assets::{Assets, icon_assets};
use gpui_kit::base::Root;
use gpui_kit::*;
use peartube::worker::Entry;
use serde_json::json;

icon_assets!(PlayerIcons, [
    Captions, Volume2, RotateCcw, Cast, Tv, TvMinimalPlay, QrCode, Info,
    Ellipsis, ChevronDown, ChevronRight, Sparkles, Share2, SlidersHorizontal, Check, Plus, Search
]);

struct SmoothAssets;
impl AssetSource for SmoothAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match PlayerIcons.load(path)? {
            Some(svg) => Ok(Some(svg)),
            None => Assets.load(path),
        }
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = Assets.list(path)?;
        paths.extend(PlayerIcons.list(path)?);
        Ok(paths)
    }
}

fn spawn_local_video_server(mp4_bytes: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let data = mp4_bytes.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    return;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let total = data.len();
                let mut start = 0usize;
                let mut end = total.saturating_sub(1);
                let mut partial = false;
                for line in req.lines() {
                    if let Some(rest) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        if let Some((l, r)) = rest.trim().split_once('-') {
                            if let Ok(s) = l.parse::<usize>() {
                                start = s.min(end);
                                partial = true;
                            }
                            if !r.is_empty()
                                && let Ok(e) = r.parse::<usize>()
                            {
                                end = e.min(total - 1);
                            }
                        }
                    }
                }
                let slice = &data[start..=end];
                let header = if partial {
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    )
                };
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(slice);
            });
        }
    });
    format!("http://127.0.0.1:{port}/fixture.mp4")
}

fn edge_error_pt(m: &player::WindowSlotMetrics) -> f64 {
    let [pw, ph] = m.parent_size;
    let mut err = (m.ns_view_frame[2] - pw)
        .abs()
        .max((m.ns_view_frame[3] - ph).abs())
        .max((m.container_frame[2] - pw).abs())
        .max((m.container_frame[3] - ph).abs());
    for sub in &m.sublayer_frames {
        err = err.max((sub[2] - pw).abs()).max((sub[3] - ph).abs());
    }
    err
}

fn metrics_with_z_json(m: &player::WindowSlotMetrics) -> serde_json::Value {
    json!({
        "parentSize": m.parent_size,
        "nsViewFrame": m.ns_view_frame,
        "containerFrame": m.container_frame,
        "sublayerFrames": m.sublayer_frames,
        "activeAnimationKeys": m.active_animation_keys,
        "alignedWithParent": m.aligned_with_parent,
        "hostAboveVideo": m.host_above_video,
    })
}
fn main() {
    let tmp_mp4 = std::env::temp_dir().join("peartube-window-smooth-fixture.mp4");
    let status = Command::new("ffmpeg")
        .args([
            "-y", "-v", "error",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=16",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-movflags", "+faststart",
            tmp_mp4.to_str().unwrap(),
        ])
        .status()
        .expect("ffmpeg must be installed");
    assert!(status.success(), "ffmpeg fixture failed");
    let bytes = fs::read(&tmp_mp4).expect("read fixture");
    let _ = fs::remove_file(&tmp_mp4);
    let url = spawn_local_video_server(bytes);

    let app = gpui_kit::application().with_assets(SmoothAssets);
    app.run(move |cx: &mut App| {
        gpui_kit::init(cx);
        theme::apply(cx);
        play::bind_keys(cx);

        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(640.), px(400.)), cx))),
            titlebar: Some(TitlebarOptions { title: Some("PearTube Safe & Smooth Proof".into()), appears_transparent: false, traffic_light_position: None }),
            ..Default::default()
        };

        let entry = Entry {
            key: "imdb:tt0111161/smooth".into(),
            id: "imdb:tt0111161".into(),
            title: "Safe & Smooth Proof".into(),
            size: 100_000,
            sha256: String::new(),
            local: true,
            cached_bytes: 100_000,
            stream_url: url.clone(),
            magnet_url: String::new(),
            source: String::new(),
            source_kind: String::new(),
        };

        let (_url_tx, url_rx) = futures_channel::mpsc::unbounded::<String>();
        let mut root_entity: Option<Entity<app::PearTube>> = None;
        let win_handle = cx
            .open_window(options, |window, cx| {
                let pt = cx.new(|cx| app::PearTube::new(url_rx, window, cx));
                root_entity = Some(pt.clone());
                cx.new(|cx| Root::new(pt, window, cx).bg(transparent_black()))
            })
            .expect("open test window");

        let pt = root_entity.expect("PearTube entity");
        cx.spawn(async move |cx| {
            let os_interval = video::VideoView::double_click_interval();
            let near_boundary_gap = os_interval.saturating_sub(Duration::from_millis(80));

            // Capture pre-layout zero frame
            let mut pre_layout_frame = [0.0; 4];
            let entry_probe = entry.clone();
            let _ = win_handle.update(cx, |_, window, cx| {
                let probe = cx.new(|cx| play::PlayScreen::new(entry_probe, 0, Vec::new(), Vec::new(), window, cx));
                if let Some(m) = probe.read(cx).video_metrics() {
                    pre_layout_frame = m.ns_view_frame;
                }
            });

            // Start production play() (which enters fullscreen at 35ms)
            let entry_play = entry.clone();
            let _ = win_handle.update(cx, |_, window, cx| {
                pt.update(cx, |pt, cx| pt.play(entry_play, 0, window, cx));
            });

            cx.background_executor().timer(Duration::from_millis(1000)).await;
            for _ in 0..30 {
                let ready = win_handle
                    .update(cx, |_, _, cx| match &pt.read(cx).screen {
                        app::Screen::Play(s) => s.read(cx).is_playing() && s.read(cx).has_picture(),
                        _ => false,
                    })
                    .unwrap_or(false);
                if ready {
                    break;
                }
                cx.background_executor().timer(Duration::from_millis(100)).await;
            }
            let initial_fs_host_above = win_handle
                .update(cx, |_, _, cx| match &pt.read(cx).screen {
                    app::Screen::Play(s) => s.read(cx).video_metrics().map(|m| m.host_above_video).unwrap_or(false),
                    _ => false,
                })
                .unwrap_or(false);

            // 1. Cast UI Popup OVER Playing Video
            let pos_before_cast_popup = win_handle
                .update(cx, |_, window, cx| {
                    let pos = match &pt.read(cx).screen {
                        app::Screen::Play(s) => s.read(cx).current_position_ms(),
                        _ => 0,
                    };
                    pt.update(cx, |pt, cx| pt.open_cast_sheet(Some((entry.key.clone(), entry.title.clone(), pos)), window, cx));
                    pos
                })
                .unwrap();

            let mut flips_during_cast_popup = 0usize;
            for _ in 0..40 {
                cx.background_executor().timer(Duration::from_millis(15)).await;
                let (modal_open, still_play_screen, playing) = win_handle
                    .update(cx, |_, _, cx| {
                        let p = pt.read(cx);
                        let (is_ps, pl) = match &p.screen {
                            app::Screen::Play(s) => (true, s.read(cx).is_playing()),
                            _ => (false, false),
                        };
                        (p.cast_modal.is_some(), is_ps, pl)
                    })
                    .unwrap();
                assert!(modal_open);
                assert!(still_play_screen);
                if !playing {
                    flips_during_cast_popup += 1;
                }
            }
            let pos_while_cast_popup_open = win_handle
                .update(cx, |_, _, cx| match &pt.read(cx).screen {
                    app::Screen::Play(s) => s.read(cx).current_position_ms(),
                    _ => 0,
                })
                .unwrap();

            let _ = win_handle.update(cx, |_, _, cx| pt.update(cx, |pt, cx| pt.close_cast_modal(cx)));
            cx.background_executor().timer(Duration::from_millis(100)).await;
            let playing_after_cast_dismiss = win_handle
                .update(cx, |_, _, cx| match &pt.read(cx).screen {
                    app::Screen::Play(s) => pt.read(cx).cast_modal.is_none() && s.read(cx).is_playing(),
                    _ => false,
                })
                .unwrap();

            // 2. Near-boundary Double-Click WHILE MAXIMIZED -> Restore Windowed, polling video_metrics() EVERY 10ms!
            let restore_t0 = std::time::Instant::now();
            let _ = win_handle.update(cx, |_, window, cx| {
                let s = match &pt.read(cx).screen { app::Screen::Play(s) => Some(s.clone()), _ => None };
                if let Some(s) = s { s.update(cx, |s, cx| s.click(1, window, cx)); }
            });
            let mut sent_restore_c2 = false;
            let mut actual_restore_gap_ms = 0u128;
            let mut flips_restore = 0usize;
            let mut max_edge_err_restore = 0.0f64;
            let mut max_anim_keys_restore = 0usize;
            while restore_t0.elapsed() < near_boundary_gap + Duration::from_millis(950) {
                cx.background_executor().timer(Duration::from_millis(10)).await;
                if !sent_restore_c2 && restore_t0.elapsed() >= near_boundary_gap {
                    sent_restore_c2 = true;
                    actual_restore_gap_ms = restore_t0.elapsed().as_millis();
                    let _ = win_handle.update(cx, |_, window, cx| {
                        let s = match &pt.read(cx).screen { app::Screen::Play(s) => Some(s.clone()), _ => None };
                        if let Some(s) = s { s.update(cx, |s, cx| s.click(2, window, cx)); }
                    });
                }
                let (playing, m_opt) = win_handle
                    .update(cx, |_, _, cx| match &pt.read(cx).screen {
                        app::Screen::Play(s) => (s.read(cx).is_playing(), s.read(cx).video_metrics()),
                        _ => (false, None),
                    })
                    .unwrap_or((false, None));
                if !playing {
                    flips_restore += 1;
                }
                if let Some(m) = m_opt {
                    max_edge_err_restore = max_edge_err_restore.max(edge_error_pt(&m));
                    max_anim_keys_restore = max_anim_keys_restore.max(m.active_animation_keys);
                }
            }
            let (is_fs_restored, restored_host_above, restored_metrics) = win_handle
                .update(cx, |_, window, cx| {
                    let m = match &pt.read(cx).screen {
                        app::Screen::Play(s) => s.read(cx).video_metrics().unwrap(),
                        _ => panic!("expected Screen::Play"),
                    };
                    let z_ok = m.host_above_video;
                    (window.is_fullscreen(), z_ok, metrics_with_z_json(&m))
                })
                .unwrap();

            // 3. Near-boundary Double-Click from Windowed -> Maximized, polling video_metrics() EVERY 10ms!
            let max_t0 = std::time::Instant::now();
            let _ = win_handle.update(cx, |_, window, cx| {
                let s = match &pt.read(cx).screen { app::Screen::Play(s) => Some(s.clone()), _ => None };
                if let Some(s) = s { s.update(cx, |s, cx| s.click(1, window, cx)); }
            });
            let mut sent_max_c2 = false;
            let mut actual_max_gap_ms = 0u128;
            let mut flips_maximize = 0usize;
            let mut max_edge_err_maximize = 0.0f64;
            let mut max_anim_keys_maximize = 0usize;
            while max_t0.elapsed() < near_boundary_gap + Duration::from_millis(950) {
                cx.background_executor().timer(Duration::from_millis(10)).await;
                if !sent_max_c2 && max_t0.elapsed() >= near_boundary_gap {
                    sent_max_c2 = true;
                    actual_max_gap_ms = max_t0.elapsed().as_millis();
                    let _ = win_handle.update(cx, |_, window, cx| {
                        let s = match &pt.read(cx).screen { app::Screen::Play(s) => Some(s.clone()), _ => None };
                        if let Some(s) = s { s.update(cx, |s, cx| s.click(2, window, cx)); }
                    });
                }
                let (playing, m_opt) = win_handle
                    .update(cx, |_, _, cx| match &pt.read(cx).screen {
                        app::Screen::Play(s) => (s.read(cx).is_playing(), s.read(cx).video_metrics()),
                        _ => (false, None),
                    })
                    .unwrap_or((false, None));
                if !playing {
                    flips_maximize += 1;
                }
                if let Some(m) = m_opt {
                    max_edge_err_maximize = max_edge_err_maximize.max(edge_error_pt(&m));
                    max_anim_keys_maximize = max_anim_keys_maximize.max(m.active_animation_keys);
                }
            }
            let (is_fs_remaximized, remax_host_above, remax_metrics) = win_handle
                .update(cx, |_, window, cx| {
                    let m = match &pt.read(cx).screen {
                        app::Screen::Play(s) => s.read(cx).video_metrics().unwrap(),
                        _ => panic!("expected Screen::Play"),
                    };
                    let z_ok = m.host_above_video;
                    (window.is_fullscreen(), z_ok, metrics_with_z_json(&m))
                })
                .unwrap();

            // 4. Single-click pause/resume after os_interval
            let _ = win_handle.update(cx, |_, window, cx| {
                let s = match &pt.read(cx).screen { app::Screen::Play(s) => Some(s.clone()), _ => None };
                if let Some(s) = s { s.update(cx, |s, cx| s.click(1, window, cx)); }
            });
            cx.background_executor().timer(os_interval + Duration::from_millis(90)).await;
            let playing_after_single_pause = win_handle
                .update(cx, |_, _, cx| match &pt.read(cx).screen {
                    app::Screen::Play(s) => s.read(cx).is_playing(),
                    _ => true,
                })
                .unwrap_or(true);

            let report = json!({
                "forbidUnsafeCodeEnforced": true,
                "osDoubleClickIntervalMs": os_interval.as_millis(),
                "testedDoubleClickGapsMs": [actual_restore_gap_ms, actual_max_gap_ms],
                "preLayoutViewFrame": pre_layout_frame,
                "castPopupOverPlayingVideo": {
                    "playingStateFlipsWhilePopupOpen": flips_during_cast_popup,
                    "positionBeforePopupMs": pos_before_cast_popup,
                    "positionWhilePopupOpenMs": pos_while_cast_popup_open,
                    "videoAdvancedMsWhilePopupOpen": pos_while_cast_popup_open.saturating_sub(pos_before_cast_popup),
                    "playingAfterDismiss": playing_after_cast_dismiss,
                },
                "doubleClickWhileMaximizedRestore": {
                    "playingStateFlips": flips_restore,
                    "exitedFullscreen": !is_fs_restored,
                    "maxEdgeErrorPtDuringTransition": max_edge_err_restore,
                    "maxActiveAnimationKeysDuringTransition": max_anim_keys_restore,
                    "settledMetrics": restored_metrics,
                },
                "doubleClickToMaximize": {
                    "playingStateFlips": flips_maximize,
                    "enteredFullscreen": is_fs_remaximized,
                    "maxEdgeErrorPtDuringTransition": max_edge_err_maximize,
                    "maxActiveAnimationKeysDuringTransition": max_anim_keys_maximize,
                    "settledMetrics": remax_metrics,
                },
                "singleClickPauseAfterIntervalWorks": !playing_after_single_pause,
            });

            let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/e2e");
            let _ = fs::create_dir_all(&out_dir);
            fs::write(out_dir.join("window-smooth-result.json"), serde_json::to_string_pretty(&report).unwrap()).expect("write artifact");
            println!("{}", serde_json::to_string_pretty(&report).unwrap());

            assert_eq!(pre_layout_frame, [0.0, 0.0, 0.0, 0.0]);
            assert!(initial_fs_host_above, "GPUI host must stay above video_window in initial fullscreen");
            assert_eq!(flips_during_cast_popup, 0);
            assert!(pos_while_cast_popup_open > pos_before_cast_popup);
            assert!(playing_after_cast_dismiss);
            assert_eq!(flips_restore, 0);
            assert!(!is_fs_restored);
            assert!(restored_host_above, "GPUI host must stay above video_window after exiting fullscreen");
            assert!(max_edge_err_restore <= 1.0, "max_edge_err_restore={max_edge_err_restore}");
            assert_eq!(max_anim_keys_restore, 0);
            assert_eq!(flips_maximize, 0);
            assert!(is_fs_remaximized);
            assert!(remax_host_above, "GPUI host must stay above video_window after re-entering fullscreen");
            assert!(max_edge_err_maximize <= 1.0, "max_edge_err_maximize={max_edge_err_maximize}");
            assert_eq!(max_anim_keys_maximize, 0);
            assert!(!playing_after_single_pause);

            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
}
