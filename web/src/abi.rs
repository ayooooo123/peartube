//! The C ABI the Worker calls. Raw pointers live here, outside the engine's `#![deny(unsafe_code)]`:
//! every function marshals into and out of `WebSession`, which is safe Rust.
#![allow(unsafe_code)]

use super::*;

#[unsafe(no_mangle)]
pub extern "C" fn pt_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe { ffi::drop_vec(ptr, len) };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_json_ptr() -> *const u8 {
    STATE.with(|c| c.borrow().json_buf.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_json_len() -> usize {
    STATE.with(|c| c.borrow().json_buf.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_ptr() -> *const u8 {
    STATE.with(|c| c.borrow().out_buf.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_len() -> usize {
    STATE.with(|c| c.borrow().out_buf.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_pts() -> f64 {
    STATE.with(|c| c.borrow().out_pts)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_dur() -> f64 {
    STATE.with(|c| c.borrow().out_dur)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_w() -> u32 {
    STATE.with(|c| c.borrow().out_w)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_h() -> u32 {
    STATE.with(|c| c.borrow().out_h)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_x() -> i32 {
    STATE.with(|c| c.borrow().out_x)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_y() -> i32 {
    STATE.with(|c| c.borrow().out_y)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_cw() -> u32 {
    STATE.with(|c| c.borrow().out_cw)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_ch() -> u32 {
    STATE.with(|c| c.borrow().out_ch)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_rate() -> u32 {
    STATE.with(|c| c.borrow().out_rate)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_out_samples() -> u32 {
    STATE.with(|c| c.borrow().out_samples)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_open(ext_ptr: *const u8, ext_len: usize) -> i32 {
    let ext_hint = if !ext_ptr.is_null() && ext_len > 0 {
        let slice = unsafe { ffi::bytes(ext_ptr, ext_len) };
        std::str::from_utf8(slice).ok().map(str::to_ascii_lowercase)
    } else {
        None
    };

    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        st.session = None;
        let ctx = &*REGISTRY;
        let streaming_io = Arc::new(AtomicBool::new(false));
        let mut src = HttpRangeSource::new(Arc::clone(&streaming_io));
        if src.len == 0 {
            return set_json_error(&mut st, "Stream has zero bytes");
        }
        let mut probe_buf = vec![0u8; (256 * 1024).min(src.len as usize)];
        let mut read_n = 0usize;
        while read_n < probe_buf.len() {
            match src.read(&mut probe_buf[read_n..]) {
                Ok(0) => break,
                Ok(n) => read_n += n,
                Err(e) => return set_json_error(&mut st, &format!("Probe read error: {e}")),
            }
        }
        probe_buf.truncate(read_n);
        if let Err(e) = src.seek(SeekFrom::Start(0)) {
            return set_json_error(&mut st, &format!("Probe rewind error: {e}"));
        }

        let probe_data = ProbeData {
            buf: &probe_buf,
            ext: ext_hint.as_deref(),
        };
        let candidates = ctx.containers.probe_candidates(&probe_data);
        let by_ext = ext_hint
            .as_deref()
            .and_then(|e| ctx.containers.container_for_extension(e));
        let Some(container) = (match (candidates.first(), by_ext) {
            (Some(c), _) if c.score >= PROBE_SCORE_EXTENSION => Some(c.name.to_string()),
            (_, Some(name)) => Some(name.to_string()),
            (Some(c), _) => Some(c.name.to_string()),
            _ => None,
        }) else {
            return set_json_error(&mut st, "Unsupported media container");
        };

        // A file that stores decode times (no `ctts`) hands the decoder
        // backward display stamps; the browser then throws half its pictures
        // away as late. Repair presentation times before anything reads them.
        let mut demuxer = match catch_unwind(AssertUnwindSafe(|| {
            ctx.containers
                .open_demuxer(&container, Box::new(src), &ctx.codecs)
                .map(decode_order::wrap)
        })) {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => return set_json_error(&mut st, &format!("Demuxer error ({container}): {e}")),
            Err(_) => return set_json_error(&mut st, &format!("Demuxer panicked opening {container}")),
        };

        let streams: Vec<StreamInfo> = demuxer.streams().iter().take(64).cloned().collect();
        let mut first_video: Option<u32> = None;
        let mut first_audio: Option<u32> = None;
        let mut tracks_json = Vec::new();
        for s in &streams {
            let kind = match s.params.media_type {
                MediaType::Video => {
                    if first_video.is_none() {
                        first_video = Some(s.index);
                    }
                    "video"
                }
                MediaType::Audio => {
                    if first_audio.is_none() {
                        first_audio = Some(s.index);
                    }
                    "audio"
                }
                MediaType::Subtitle => "subtitle",
                _ => continue,
            };
            tracks_json.push(json!({
                "stream": s.index,
                "kind": kind,
                "codec": s.params.codec_id.as_str(),
                "language": s.params.language,
                "width": s.params.width,
                "height": s.params.height,
                "channels": s.params.channels,
                "sampleRate": s.params.sample_rate,
            }));
        }

        let duration_secs = demuxer
            .duration_micros()
            .map(|us| (us.max(0) as f64) / 1_000_000.0)
            .or_else(|| {
                streams
                    .iter()
                    .filter_map(|s| {
                        s.duration.and_then(|d| {
                            if s.time_base.is_valid() {
                                Some(s.time_base.seconds_of(d).max(0.0))
                            } else {
                                None
                            }
                        })
                    })
                    .fold(None::<f64>, |acc, x| Some(acc.map_or(x, |a| a.max(x))))
            })
            .unwrap_or(0.0);

        // Peek up to 128 packets when extradata lacks Annex-B SPS/PPS, raw AV1 OBUs, or VP9 profile bits.
        let mut peek_packets = VecDeque::new();
        let mut mse_cfg = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .and_then(|vs| probe_mse_video(vs, None));
        if mse_cfg.is_none()
            && let Some(vi) = first_video
            && let Some(vs) = streams.iter().find(|s| s.index == vi).cloned()
            && matches!(vs.params.codec_id.as_str(), "h264" | "h265" | "hevc" | "av1" | "vp9")
        {
            for _ in 0..128 {
                let Ok(Ok(pkt)) = catch_unwind(AssertUnwindSafe(|| demuxer.next_packet())) else {
                    break;
                };
                let is_vkf = pkt.stream_index == vi && pkt.flags.keyframe;
                peek_packets.push_back(pkt);
                if is_vkf {
                    mse_cfg = probe_mse_video(&vs, peek_packets.back().map(|p| p.data.as_slice()));
                    break;
                }
            }
        }

        let webcodecs_hint = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .and_then(|vs| build_webcodecs_hint(vs, mse_cfg.as_ref()));

        let (width, height) = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .map(|s| (s.params.width.unwrap_or(0), s.params.height.unwrap_or(0)))
            .unwrap_or((0, 0));

        let manifest = json!({
            "container": container,
            "duration": duration_secs,
            "width": mse_cfg.as_ref().map_or(width, |c| c.width),
            "height": mse_cfg.as_ref().map_or(height, |c| c.height),
            "mseType": mse_cfg.as_ref().map(MseVideoConfig::mime_type),
            "webCodecs": webcodecs_hint,
            "tracks": tracks_json,
            "defaultVideo": first_video,
            "defaultAudio": first_audio,
            "defaultSubtitle": serde_json::Value::Null,
        });
        st.json_buf = manifest.to_string().into_bytes();
        st.session = Some(WebSession {
            container,
            streaming_io,
            demuxer,
            streams,
            mse_cfg,
            peek_packets,
            out_queue: VecDeque::new(),
            frame_pool: Vec::with_capacity(6),
            video_idx: first_video,
            seek_idx: first_video,
            audio_idx: first_audio,
            sub_idx: None,
            video_mode: VideoOutputMode::Software,
            video_meta: None,
            audio_meta: None,
            sub_meta: None,
            video_dec: None,
            audio_dec: None,
            sub_dec: None,
            audio_mix: None,
            audio_next_pts: None,
            audio_left: Vec::with_capacity(8192 + 2048),
            audio_right: Vec::with_capacity(8192 + 2048),
            audio_accum_pts: None,
            audio_accum_rate: 0,
            audio_first_flushed: false,
            video_next_pts: 0.0,
            video_seeded: false,
            drop_until_keyframe: false,
            client_clock: 0.0,
            video_hidden: false,
            replaying_hidden_gop: false,
            hidden_gops: VecDeque::new(),
            hidden_gop_bytes: 0,
            mse_gop: Vec::new(),
            mse_seq: 0,
            mse_min_dts: 0,
            mse_started: false,
            seek_target: None,
            demux_eof: false,
            flushed_eof: false,
        });
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_configure(video_stream: i32, audio_stream: i32, sub_stream: i32, use_mse: i32) -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return set_json_error(&mut st, "No open session");
        };
        sess.video_idx = (video_stream >= 0).then_some(video_stream as u32);
        sess.audio_idx = (audio_stream >= 0).then_some(audio_stream as u32);
        sess.sub_idx = (sub_stream >= 0).then_some(sub_stream as u32);
        sess.video_mode = match use_mse {
            1 if sess.mse_cfg.is_some() => VideoOutputMode::Mse,
            2 => VideoOutputMode::WebCodecs,
            _ => VideoOutputMode::Software,
        };
        sess.out_queue.clear();
        sess.streaming_io.store(true, Ordering::Relaxed);

        let mut active = Vec::new();
        if let Some(v) = sess.video_idx {
            active.push(v);
        }
        if let Some(a) = sess.audio_idx {
            active.push(a);
        }
        if let Some(s) = sess.sub_idx {
            active.push(s);
        }
        sess.demuxer.set_active_streams(&active);
        sess.rebuild_decoders();

        if sess.video_mode == VideoOutputMode::Mse
            && let Some(cfg) = sess.mse_cfg.as_ref()
        {
            sess.out_queue.push_back(OutItem::MseInit(cfg.init_segment()));
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_seek(target_secs: f64) -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return set_json_error(&mut st, "No open session");
        };
        let clamped = target_secs.max(0.0);
        let seek_stream = sess.seek_idx.or(sess.video_idx).or(sess.audio_idx).unwrap_or(0);
        let tb = sess
            .stream_info(seek_stream)
            .map(|s| s.time_base)
            .filter(|tb| tb.is_valid())
            .unwrap_or_else(|| TimeBase::new(1, 1000));
        let ticks = tb.ticks_of(clamped);

        sess.peek_packets.clear();
        sess.out_queue.clear();
        sess.demux_eof = false;
        sess.flushed_eof = false;
        sess.seek_target = Some(clamped);

        let res = catch_unwind(AssertUnwindSafe(|| sess.demuxer.seek_to(seek_stream, ticks)));
        if let Err(_) | Ok(Err(_)) = res {
            let _ = catch_unwind(AssertUnwindSafe(|| sess.demuxer.seek_to(seek_stream, 0)));
        }
        sess.rebuild_decoders();
        if sess.video_mode == VideoOutputMode::Mse
            && let Some(cfg) = sess.mse_cfg.as_ref()
        {
            sess.out_queue.push_back(OutItem::MseInit(cfg.init_segment()));
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_set_clock(clock_secs: f64) {
    STATE.with(|cell| {
        if let Some(sess) = cell.borrow_mut().session.as_mut() {
            sess.client_clock = clock_secs.max(0.0);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_set_hidden(hidden: i32) {
    STATE.with(|cell| {
        if let Some(sess) = cell.borrow_mut().session.as_mut() {
            sess.set_hidden(hidden != 0);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_step() -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let prev_out = std::mem::take(&mut st.out_buf);
        let code = {
            let Some(sess) = st.session.as_mut() else {
                return set_json_error(&mut st, "No open session");
            };
            sess.recycle_buf(prev_out);

            let mut safety = 0usize;
            while sess.out_queue.is_empty() && safety < 4096 {
                safety += 1;
                if sess.demux_eof {
                    sess.flush_eof();
                    break;
                }
                let next_pkt = if let Some(p) = sess.peek_packets.pop_front() {
                    Ok(p)
                } else {
                    match catch_unwind(AssertUnwindSafe(|| sess.demuxer.next_packet())) {
                        Ok(r) => r,
                        Err(_) => Err(AvError::Other("demuxer panicked".into())),
                    }
                };
                match next_pkt {
                    Ok(pkt) => {
                        if Some(pkt.stream_index) == sess.video_idx {
                            sess.handle_video_packet(pkt);
                        } else if Some(pkt.stream_index) == sess.audio_idx {
                            sess.handle_audio_packet(pkt);
                        } else if Some(pkt.stream_index) == sess.sub_idx {
                            sess.handle_sub_packet(pkt);
                        }
                    }
                    Err(AvError::Eof) => {
                        sess.demux_eof = true;
                        sess.flush_eof();
                        break;
                    }
                    Err(e) => {
                        return set_json_error(&mut st, &format!("Demux error: {e}"));
                    }
                }
            }
            match sess.out_queue.pop_front() {
                // A 4,096-packet slice that skipped pre-seek TrueHD or hidden video is not EOF; yield 9 so the Worker pumps again.
                None => return if sess.demux_eof { 0 } else { 9 },
                Some(OutItem::MseInit(data)) => {
                    st.out_buf = data;
                    st.out_pts = 0.0;
                    st.out_dur = 0.0;
                    1
                }
                Some(OutItem::MseSegment { data, start, end }) => {
                    st.out_buf = data;
                    st.out_pts = start;
                    st.out_dur = end;
                    2
                }
                Some(OutItem::VideoRgba { data, pts, w, h }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_w = w;
                    st.out_h = h;
                    3
                }
                Some(OutItem::VideoYuv420 { data, pts, w, h }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_w = w;
                    st.out_h = h;
                    7
                }
                Some(OutItem::VideoPacket { data, pts, dur, keyframe }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_dur = dur;
                    st.out_w = u32::from(keyframe);
                    8
                }
                Some(OutItem::AudioPlanarF32 { data, pts, rate, frames }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_rate = rate;
                    st.out_samples = frames;
                    4
                }
                Some(OutItem::SubText { text, start, end }) => {
                    st.out_buf = text;
                    st.out_pts = start;
                    st.out_dur = end;
                    5
                }
                Some(OutItem::SubBitmap { rgba, start, end, x, y, w, h, cw, ch }) => {
                    st.out_buf = rgba;
                    st.out_pts = start;
                    st.out_dur = end;
                    st.out_x = x;
                    st.out_y = y;
                    st.out_w = w;
                    st.out_h = h;
                    st.out_cw = cw;
                    st.out_ch = ch;
                    6
                }
            }
        };
        code
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_close() {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        st.session = None;
        st.out_buf = Vec::new();
    });
}
