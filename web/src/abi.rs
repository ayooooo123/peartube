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

pub const STEP_EOF: i32 = 0;
pub const STEP_MSE_INIT: i32 = 1;
pub const STEP_MSE_SEGMENT: i32 = 2;
pub const STEP_VIDEO_RGBA: i32 = 3;
pub const STEP_AUDIO_PLANAR_F32: i32 = 4;
pub const STEP_SUB_TEXT: i32 = 5;
pub const STEP_SUB_BITMAP: i32 = 6;
pub const STEP_VIDEO_YUV420: i32 = 7;
pub const STEP_VIDEO_PACKET: i32 = 8;
pub const STEP_YIELD: i32 = 9;

pub const MODE_SOFTWARE: i32 = 0;
pub const MODE_MSE: i32 = 1;
pub const MODE_WEBCODECS: i32 = 2;

#[unsafe(no_mangle)]
pub extern "C" fn pt_abi_json() -> usize {
    let pf_in_flight = controller::PREFETCH_IN_FLIGHT;
    let pf_lookahead = controller::PREFETCH_LOOKAHEAD_BLOCKS;
    let max_cache_blocks = controller::MAX_CACHE_BLOCKS;
    STATE.with(|c| {
        let mut st = c.borrow_mut();
        st.json_buf = format!(
            r#"{{"step":{{"eof":{STEP_EOF},"mseInit":{STEP_MSE_INIT},"mseSegment":{STEP_MSE_SEGMENT},"videoRgba":{STEP_VIDEO_RGBA},"audioPlanarF32":{STEP_AUDIO_PLANAR_F32},"subText":{STEP_SUB_TEXT},"subBitmap":{STEP_SUB_BITMAP},"videoYuv420":{STEP_VIDEO_YUV420},"videoPacket":{STEP_VIDEO_PACKET},"yield":{STEP_YIELD}}},"mode":{{"software":{MODE_SOFTWARE},"mse":{MODE_MSE},"webcodecs":{MODE_WEBCODECS}}},"limits":{{"maxHiddenGops":{MAX_HIDDEN_GOPS},"maxGopPkts":{MAX_GOP_PKTS},"prefetchInFlight":{pf_in_flight},"prefetchLookahead":{pf_lookahead},"maxCacheBlocks":{max_cache_blocks}}}}}"#
        ).into_bytes();
        st.json_buf.len()
    })
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
        let mut demuxer = match ctx
            .containers
            .open_demuxer(&container, Box::new(src), &ctx.codecs)
            .map(decode_order::wrap)
        {
            Ok(d) => d,
            Err(e) => return set_json_error(&mut st, &format!("Demuxer error ({container}): {e}")),
        };

        let streams: Vec<StreamInfo> = demuxer.streams().iter().take(256).cloned().collect();
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
                let Ok(pkt) = demuxer.next_packet() else {
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

        let first_kf_bytes = peek_packets.back().map(|p| p.data.as_slice());
        let video_color = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .map(|vs| resolve_video_color(&vs.params, first_kf_bytes, None, None));

        let webcodecs_hint = first_video
            .and_then(|vi| streams.iter().find(|s| s.index == vi))
            .and_then(|vs| build_webcodecs_hint(vs, mse_cfg.as_ref(), video_color.unwrap_or_default()));

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
            "videoColor": video_color.map(ResolvedVideoColor::to_manifest_json),
            "rules": controller::PlayerController::rules_json(duration_secs),
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
            audio_seek_target: None,
            preseek_mlp_gop: Vec::new(),
            demux_eof: false,
            flushed_eof: false,
            controller: controller::PlayerController::default(),
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
            MODE_MSE if sess.mse_cfg.is_some() => VideoOutputMode::Mse,
            MODE_WEBCODECS => VideoOutputMode::WebCodecs,
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
        sess.controller.reset(
            0.0,
            0.0,
            sess.video_idx.is_some(),
            sess.audio_idx.is_some(),
            sess.video_mode,
        );
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
        sess.audio_seek_target = Some(clamped);

        if sess.demuxer.seek_to(seek_stream, ticks).is_err() {
            let _ = sess.demuxer.seek_to(seek_stream, 0);
        }
        sess.rebuild_decoders();
        sess.controller.reset(
            clamped,
            0.0,
            sess.video_idx.is_some(),
            sess.audio_idx.is_some(),
            sess.video_mode,
        );
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
            let h = hidden != 0;
            sess.controller.page_hidden = h;
            sess.set_hidden(h);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_apply_clock(
    time_secs: f64,
    wall_ms: f64,
    playing: i32,
    video_sec: f64,
    audio_sec: f64,
) {
    STATE.with(|cell| {
        if let Some(sess) = cell.borrow_mut().session.as_mut() {
            sess.controller
                .apply_clock(time_secs, wall_ms, playing != 0, video_sec, audio_sec);
            sess.client_clock = sess.controller.media_time(wall_ms);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_media_time(wall_ms: f64) -> f64 {
    STATE.with(|cell| {
        cell.borrow()
            .session
            .as_ref()
            .map_or(0.0, |s| s.controller.media_time(wall_ms))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_buffered_ahead(
    wall_ms: f64,
    wc_span_sec: f64,
    wc_in_flight: u32,
) -> i32 {
    STATE.with(|cell| {
        cell.borrow()
            .session
            .as_ref()
            .map_or(0, |s| i32::from(s.controller.buffered_ahead(wall_ms, wc_span_sec, wc_in_flight)))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_on_video_frame(pts_secs: f64) {
    STATE.with(|cell| {
        if let Some(sess) = cell.borrow_mut().session.as_mut() {
            sess.controller.on_video_frame(pts_secs);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_evict_cut(
    now_secs: f64,
    keep_behind_secs: f64,
    b0_secs: f64,
    b_end_secs: f64,
) -> f64 {
    STATE.with(|cell| {
        cell.borrow_mut()
            .session
            .as_mut()
            .map_or(0.0, |s| s.controller.safe_mse_evict_cut(now_secs, keep_behind_secs, b0_secs, b_end_secs))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_max_evict_cap(now_secs: f64, keep_behind_secs: f64) -> f64 {
    STATE.with(|cell| {
        cell.borrow()
            .session
            .as_ref()
            .map_or(0.0, |s| s.controller.max_safe_evict_cap(now_secs, keep_behind_secs))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_prefetch_plan(base_block: u32, total_bytes: u64, block_bytes: u32) -> u64 {
    let (_start_b, end_b, evict_b, _max_f) =
        controller::PlayerController::prefetch_plan(base_block, total_bytes, block_bytes);
    (u64::from(end_b) << 32) | u64::from(evict_b)
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_crop_due(w: u32) -> i32 {
    STATE.with(|cell| {
        cell.borrow_mut()
            .session
            .as_mut()
            .map_or(0, |s| i32::from(s.controller.crop_sample_due(w)))
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_ctrl_probe_crop(
    ptr: *const u8,
    len: usize,
    sw: u32,
    sh: u32,
    full_w: u32,
    full_h: u32,
    rgba: i32,
) -> i32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    let slice = unsafe { ffi::bytes(ptr, len) };
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return 0;
        };
        let Some(c) = sess.controller.probe_letterbox(slice, sw, sh, full_w, full_h, rgba != 0) else {
            return 0;
        };
        st.out_x = c.left as i32;
        st.out_y = c.top as i32;
        st.out_w = c.right;
        st.out_h = c.bottom;
        st.out_cw = u32::from(c.full);
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_crop_stats() -> u64 {
    STATE.with(|cell| {
        cell.borrow()
            .session
            .as_ref()
            .map_or(0, |s| {
                (u64::from(s.controller.crop_readbacks) << 32)
                    | u64::from(s.controller.stream_crop_same)
            })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_mse_tick(
    now_secs: f64,
    vt_secs: f64,
    b0_secs: f64,
    b_end_secs: f64,
    ready_state: u32,
    mse_stalled: i32,
    can_hard_sync: i32,
    duration_secs: f64,
    rebuffering: i32,
    mse_buffered_ahead_sec: f64,
    audio_queued_ahead_sec: f64,
    eof: i32,
) -> i32 {
    STATE.with(|cell| {
        let mut st = cell.borrow_mut();
        let Some(sess) = st.session.as_mut() else {
            return 0;
        };
        let act = sess.controller.evaluate_mse_tick(
            now_secs,
            vt_secs,
            b0_secs,
            b_end_secs,
            ready_state,
            mse_stalled != 0,
            can_hard_sync != 0,
            duration_secs,
            rebuffering != 0,
            mse_buffered_ahead_sec,
            audio_queued_ahead_sec,
            eof != 0,
        );
        st.out_pts = act.evict_to;
        st.out_dur = act.snap_to;
        st.out_w = (act.playback_rate * 1000.0).round() as u32;
        st.out_h = (act.max_evict_cap * 1000.0).round() as u32;
        st.out_x = i32::from(act.exit_rebuffer);
        1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_ctrl_return_sync(
    use_mse: i32,
    was_hidden: i32,
    is_avi: i32,
    audio_secs: f64,
    video_secs: f64,
    mse_buffered_at_audio: f64,
    sb_updating: i32,
) -> u32 {
    let (mode, _target) = controller::PlayerController::evaluate_return_sync(
        use_mse != 0,
        was_hidden != 0,
        is_avi != 0,
        audio_secs,
        video_secs,
        mse_buffered_at_audio,
        sb_updating != 0,
    );
    mode
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_clear_all() {
    controller::CACHE.with(|c| c.borrow_mut().clear_all());
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_reset_stream() {
    controller::CACHE.with(|c| c.borrow_mut().reset_stream_state());
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_cache_put_head(ptr: *const u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let slice = unsafe { ffi::bytes(ptr, len) };
    controller::CACHE.with(|c| c.borrow_mut().put_head_bytes(slice));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_cache_set_partial(start: u64, ptr: *const u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let slice = unsafe { ffi::bytes(ptr, len) };
    controller::CACHE.with(|c| c.borrow_mut().set_partial_bytes(start, slice));
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_cache_put_block(idx: u32, ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 {
        return -1;
    }
    let slice = unsafe { ffi::bytes(ptr, len) };
    controller::CACHE.with(|c| c.borrow_mut().put_block_bytes(idx, slice))
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_take_read_req() -> u32 {
    controller::CACHE.with(|c| c.borrow_mut().take_read_req())
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_block_count() -> u32 {
    controller::CACHE.with(|c| c.borrow().block_count())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pt_cache_read_cached(
    offset: u64,
    dst_ptr: *mut u8,
    len: usize,
    streaming_mode: i32,
) -> usize {
    if dst_ptr.is_null() || len == 0 {
        return 0;
    }
    let dst = unsafe { std::slice::from_raw_parts_mut(dst_ptr, len) };
    controller::CACHE.with(|c| c.borrow_mut().read_cached(offset, dst, streaming_mode != 0))
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_should_yield(
    streaming_mode: i32,
    page_hidden: i32,
    stream_len: u64,
    now_ms: f64,
) -> u32 {
    controller::CACHE.with(|c| {
        c.borrow_mut()
            .should_yield_for_next_block(streaming_mode != 0, page_hidden != 0, stream_len, now_ms)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_next_hidden_block(stream_len: u64) -> i32 {
    controller::CACHE.with(|c| c.borrow_mut().next_hidden_prefetch_block(stream_len))
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_hidden_done(idx: u32) {
    controller::CACHE.with(|c| c.borrow_mut().hidden_done(idx));
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_hidden_clear() {
    controller::CACHE.with(|c| c.borrow_mut().hidden_clear());
}

#[unsafe(no_mangle)]
pub extern "C" fn pt_cache_last_posted_block() -> i32 {
    controller::CACHE.with(|c| c.borrow().last_posted_block)
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
                    sess.demuxer.next_packet()
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
                None => return if sess.demux_eof { STEP_EOF } else { STEP_YIELD },
                Some(OutItem::MseInit(data)) => {
                    st.out_buf = data;
                    st.out_pts = 0.0;
                    st.out_dur = 0.0;
                    STEP_MSE_INIT
                }
                Some(OutItem::MseSegment { data, start, end, key_ms }) => {
                    sess.controller.on_mse_segment(start, end, key_ms);
                    st.out_buf = data;
                    st.out_pts = start;
                    st.out_dur = end;
                    st.out_w = key_ms;
                    STEP_MSE_SEGMENT
                }
                Some(OutItem::VideoRgba { data, pts, w, h }) => {
                    sess.controller.on_video_frame(pts);
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_w = w;
                    st.out_h = h;
                    STEP_VIDEO_RGBA
                }
                Some(OutItem::VideoYuv420 { data, pts, w, h, matrix_id, full_range }) => {
                    sess.controller.on_video_frame(pts);
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_w = w;
                    st.out_h = h;
                    st.out_x = i32::from(matrix_id);
                    st.out_y = i32::from(full_range);
                    STEP_VIDEO_YUV420
                }
                Some(OutItem::VideoPacket { data, pts, dur, keyframe }) => {
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_dur = dur;
                    st.out_w = u32::from(keyframe);
                    STEP_VIDEO_PACKET
                }
                Some(OutItem::AudioPlanarF32 { data, pts, rate, frames }) => {
                    sess.controller.on_audio_chunk(rate, frames);
                    st.out_buf = data;
                    st.out_pts = pts;
                    st.out_rate = rate;
                    st.out_samples = frames;
                    STEP_AUDIO_PLANAR_F32
                }
                Some(OutItem::SubText { text, start, end }) => {
                    st.out_buf = text;
                    st.out_pts = start;
                    st.out_dur = end;
                    STEP_SUB_TEXT
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
                    STEP_SUB_BITMAP
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
