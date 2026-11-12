//! Browser playback state machine: monotonic media clock interpolation, decode/mux buffer
//! horizon gating, W3C MSE keyframe-aware eviction cutoffs, and A/V drift/stall recovery.

use crate::VideoOutputMode;
use std::cell::RefCell;

pub const STREAM_BLOCK_BYTES: u64 = 2 * 1024 * 1024;

thread_local! {
    pub(crate) static CACHE: RefCell<StreamCache> = RefCell::new(StreamCache::default());
}

struct CachedBlock {
    idx: u32,
    stamp: u64,
    data: Vec<u8>,
}

pub(crate) struct StreamCache {
    stamp: u64,
    head_probe: Vec<u8>,
    blocks: Vec<CachedBlock>,
    partial_start: u64,
    partial_data: Vec<u8>,
    pub(crate) last_read_offset: i64,
    pub(crate) last_posted_block: i32,
    pub(crate) waiting_for_block: i32,
    pub(crate) waiting_block_since_ms: f64,
    hidden_in_flight: Vec<u32>,
    pending_read_req: Option<(u32, bool)>,
}

impl Default for StreamCache {
    fn default() -> Self {
        Self {
            stamp: 0,
            head_probe: Vec::new(),
            blocks: Vec::with_capacity(MAX_CACHE_BLOCKS),
            partial_start: 0,
            partial_data: Vec::new(),
            last_read_offset: -1,
            last_posted_block: -1,
            waiting_for_block: -1,
            waiting_block_since_ms: 0.0,
            hidden_in_flight: Vec::with_capacity(4),
            pending_read_req: None,
        }
    }
}

impl StreamCache {
    pub(crate) fn clear_all(&mut self) {
        self.stamp = 0;
        self.head_probe.clear();
        self.blocks.clear();
        self.partial_start = 0;
        self.partial_data.clear();
        self.reset_stream_state();
    }

    pub(crate) fn reset_stream_state(&mut self) {
        self.last_read_offset = -1;
        self.last_posted_block = -1;
        self.waiting_for_block = -1;
        self.waiting_block_since_ms = 0.0;
        self.hidden_in_flight.clear();
        self.pending_read_req = None;
    }

    pub(crate) fn put_head_bytes(&mut self, bytes: &[u8]) {
        self.head_probe.clear();
        self.head_probe.extend_from_slice(bytes);
        if !bytes.is_empty() {
            let _ = self.put_block_bytes(0, bytes);
        }
    }

    pub(crate) fn set_partial_bytes(&mut self, start: u64, bytes: &[u8]) {
        self.partial_start = start;
        self.partial_data.clear();
        self.partial_data.extend_from_slice(bytes);
    }

    pub(crate) fn put_block_bytes(&mut self, idx: u32, bytes: &[u8]) -> i32 {
        self.stamp = self.stamp.wrapping_add(1);
        if let Some(b) = self.blocks.iter_mut().find(|b| b.idx == idx) {
            b.data.clear();
            b.data.extend_from_slice(bytes);
            b.stamp = self.stamp;
            if self.waiting_for_block == idx as i32 {
                self.waiting_for_block = -1;
            }
            return -1;
        }
        if self.blocks.len() >= MAX_CACHE_BLOCKS {
            let pos = self
                .blocks
                .iter()
                .enumerate()
                .filter(|(_, b)| (b.idx as i32) < self.last_posted_block)
                .min_by_key(|(_, b)| b.stamp)
                .or_else(|| self.blocks.iter().enumerate().min_by_key(|(_, b)| b.stamp))
                .map(|(i, _)| i);
            if let Some(i) = pos {
                let evicted = self.blocks[i].idx as i32;
                self.blocks[i].idx = idx;
                self.blocks[i].stamp = self.stamp;
                self.blocks[i].data.clear();
                self.blocks[i].data.extend_from_slice(bytes);
                if self.waiting_for_block == idx as i32 {
                    self.waiting_for_block = -1;
                }
                return evicted;
            }
        }
        let mut data = Vec::with_capacity(bytes.len());
        data.extend_from_slice(bytes);
        self.blocks.push(CachedBlock {
            idx,
            stamp: self.stamp,
            data,
        });
        if self.waiting_for_block == idx as i32 {
            self.waiting_for_block = -1;
        }
        -1
    }

    pub(crate) fn read_cached(&mut self, offset: u64, dst: &mut [u8], streaming_mode: bool) -> usize {
        if dst.is_empty() {
            return 0;
        }
        let max_len = dst.len();
        self.last_read_offset = (offset + max_len as u64) as i64;
        let b_idx = (offset / STREAM_BLOCK_BYTES) as u32;
        let b_off = (offset - u64::from(b_idx) * STREAM_BLOCK_BYTES) as usize;
        let in_head = !self.head_probe.is_empty()
            && offset.saturating_add(max_len as u64) <= self.head_probe.len() as u64;
        let mut block_pos = None;
        if !in_head
            && let Some(pos) = self.blocks.iter().position(|b| b.idx == b_idx && b_off < b.data.len())
        {
            self.stamp = self.stamp.wrapping_add(1);
            self.blocks[pos].stamp = self.stamp;
            block_pos = Some(pos);
        }
        let in_cache = in_head || block_pos.is_some();
        if in_cache && self.waiting_for_block == b_idx as i32 {
            self.waiting_for_block = -1;
        }
        if streaming_mode && (b_idx as i32 != self.last_posted_block || !in_cache) {
            self.last_posted_block = b_idx as i32;
            self.pending_read_req = Some((b_idx, !in_cache));
        }
        if in_head {
            let start = offset as usize;
            dst.copy_from_slice(&self.head_probe[start..start + max_len]);
            return max_len;
        }
        if let Some(pos) = block_pos {
            let b = &self.blocks[pos];
            let take = max_len.min(b.data.len() - b_off);
            dst[..take].copy_from_slice(&b.data[b_off..b_off + take]);
            return take;
        }
        if !self.partial_data.is_empty() && offset >= self.partial_start {
            let p_off_u64 = offset - self.partial_start;
            if p_off_u64 < self.partial_data.len() as u64 {
                let p_off = p_off_u64 as usize;
                let p_take = max_len.min(self.partial_data.len() - p_off);
                if p_take >= max_len {
                    dst[..p_take].copy_from_slice(&self.partial_data[p_off..p_off + p_take]);
                    return p_take;
                }
            }
        }
        0
    }

    /// Bit 0: has pending readBlock request. Bit 1: force. Bits 2..31: block index.
    pub(crate) fn take_read_req(&mut self) -> u32 {
        if let Some((b_idx, force)) = self.pending_read_req.take() {
            1 | (u32::from(force) << 1) | (b_idx << 2)
        } else {
            0
        }
    }

    pub(crate) fn block_count(&self) -> u32 {
        self.blocks.len() as u32
    }
    /// Bit 0: yield pump loop. Bit 1: also post non-forced readBlock for `(ret >> 2)`.
    pub(crate) fn should_yield_for_next_block(
        &mut self,
        streaming_mode: bool,
        page_hidden: bool,
        stream_len: u64,
        now_ms: f64,
    ) -> u32 {
        if !streaming_mode || page_hidden || self.last_read_offset < 0 {
            return 0;
        }
        let cur_blk = (self.last_read_offset as u64 / STREAM_BLOCK_BYTES) as u32;
        let rem = u64::from(cur_blk + 1) * STREAM_BLOCK_BYTES - (self.last_read_offset as u64);
        let next_blk = cur_blk + 1;
        if rem > 1_048_576
            || u64::from(next_blk) * STREAM_BLOCK_BYTES >= stream_len
            || self.blocks.iter().any(|b| b.idx == next_blk)
        {
            if self.waiting_for_block == next_blk as i32 {
                self.waiting_for_block = -1;
            }
            return 0;
        }
        let mut post_flag = 0u32;
        if self.last_posted_block < cur_blk as i32 {
            self.last_posted_block = cur_blk as i32;
            post_flag = 2 | (cur_blk << 2);
        }
        if self.waiting_for_block != next_blk as i32 {
            self.waiting_for_block = next_blk as i32;
            self.waiting_block_since_ms = now_ms;
            return 1 | post_flag;
        }
        if now_ms - self.waiting_block_since_ms < 600.0 {
            1 | post_flag
        } else {
            post_flag
        }
    }

    pub(crate) fn next_hidden_prefetch_block(&mut self, stream_len: u64) -> i32 {
        if self.hidden_in_flight.len() >= 4 || stream_len == 0 {
            return -1;
        }
        let base = self.last_posted_block.max(0) as u32;
        for i in 0..=16 {
            let idx = base + i;
            let start = u64::from(idx) * STREAM_BLOCK_BYTES;
            if start >= stream_len {
                break;
            }
            if self.blocks.iter().any(|b| b.idx == idx)
                || self.hidden_in_flight.contains(&idx)
                || (idx == 0 && !self.head_probe.is_empty())
            {
                continue;
            }
            self.hidden_in_flight.push(idx);
            return idx as i32;
        }
        -1
    }

    pub(crate) fn hidden_done(&mut self, idx: u32) {
        self.hidden_in_flight.retain(|&x| x != idx);
    }

    pub(crate) fn hidden_clear(&mut self) {
        self.hidden_in_flight.clear();
    }
}


const MAX_TRACKED_KEYFRAMES: usize = 128;

pub const PREFETCH_IN_FLIGHT: usize = 6;
pub const PREFETCH_LOOKAHEAD_BLOCKS: usize = 24;
pub const MAX_CACHE_BLOCKS: usize = 48;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct MseTickAction {
    pub(crate) evict_to: f64,
    pub(crate) snap_to: f64,
    pub(crate) playback_rate: f64,
    pub(crate) max_evict_cap: f64,
    pub(crate) exit_rebuffer: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CropRect {
    pub(crate) left: u32,
    pub(crate) top: u32,
    pub(crate) right: u32,
    pub(crate) bottom: u32,
    pub(crate) full: bool,
}

#[derive(Default)]
pub(crate) struct PlayerController {
    pub(crate) has_video: bool,
    pub(crate) has_audio: bool,
    pub(crate) video_mode: VideoOutputMode,
    pub(crate) page_hidden: bool,
    pub(crate) clock_media: f64,
    pub(crate) clock_wall_ms: f64,
    pub(crate) clock_playing: bool,
    pub(crate) last_credit_wall_ms: f64,
    pub(crate) queued_video_sec: f64,
    pub(crate) queued_audio_sec: f64,
    pub(crate) last_video_pts: Option<f64>,
    pub(crate) last_mse_seg_end: f64,
    pub(crate) mse_keyframes: Vec<f64>,
    pub(crate) stream_crop: Option<CropRect>,
    pub(crate) stream_crop_candidate: Option<CropRect>,
    pub(crate) stream_crop_same: u32,
    pub(crate) stream_crop_frames: u32,
    pub(crate) last_sampled_w: u32,
    pub(crate) crop_readbacks: u32,
}

impl PlayerController {
    pub(crate) fn rules_json(duration_secs: f64) -> serde_json::Value {
        let long = duration_secs >= 120.0;
        serde_json::json!({
            "minMsePrimeLeadSec": if long { 3.0 } else { 0.04 },
            "minSwPrimeFrames": if long { 8 } else { 2 },
            "minAudioPrimeSec": if long { 2.0 } else { 0.01 },
            "rebufferVideoSec": if long { 2.2 } else { 0.5 },
            "rebufferAudioSec": if long { 1.2 } else { 0.2 },
            "prefetchInFlight": PREFETCH_IN_FLIGHT,
            "prefetchLookahead": PREFETCH_LOOKAHEAD_BLOCKS,
            "evictTrailBlocks": 4,
        })
    }

    pub(crate) fn prefetch_plan(
        base_block: u32,
        total_bytes: u64,
        block_bytes: u32,
    ) -> (u32, u32, u32, u32) {
        let blk_sz = u64::from(block_bytes.max(1));
        let total_blocks = ((total_bytes + blk_sz - 1) / blk_sz) as u32;
        let end_excl = (base_block.saturating_add(PREFETCH_LOOKAHEAD_BLOCKS as u32 + 1)).min(total_blocks);
        let evict_before = base_block.saturating_sub(4);
        (base_block, end_excl, evict_before, PREFETCH_IN_FLIGHT as u32)
    }

    pub(crate) fn reset(
        &mut self,
        start_at: f64,
        wall_ms: f64,
        has_video: bool,
        has_audio: bool,
        video_mode: VideoOutputMode,
    ) {
        let clamped = start_at.max(0.0);
        self.has_video = has_video;
        self.has_audio = has_audio;
        self.video_mode = video_mode;
        self.clock_media = clamped;
        self.clock_wall_ms = wall_ms;
        self.clock_playing = false;
        self.last_credit_wall_ms = wall_ms;
        self.queued_video_sec = 0.0;
        self.queued_audio_sec = 0.0;
        self.last_video_pts = None;
        self.last_mse_seg_end = clamped;
        self.mse_keyframes.clear();
        self.stream_crop = None;
        self.stream_crop_candidate = None;
        self.stream_crop_same = 0;
        self.stream_crop_frames = 0;
        self.crop_readbacks = 0;
    }

    pub(crate) fn media_time(&self, now_wall_ms: f64) -> f64 {
        if !self.clock_playing {
            return self.clock_media;
        }
        let elapsed = ((now_wall_ms - self.clock_wall_ms) / 1000.0).max(0.0);
        self.clock_media + elapsed
    }

    pub(crate) fn register_keyframe(&mut self, key_pts_secs: f64) {
        if !key_pts_secs.is_finite() || key_pts_secs < 0.0 {
            return;
        }
        if self
            .mse_keyframes
            .iter()
            .any(|&kf| (kf - key_pts_secs).abs() < 0.001)
        {
            return;
        }
        self.mse_keyframes.push(key_pts_secs);
        self.mse_keyframes
            .sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if self.mse_keyframes.len() > MAX_TRACKED_KEYFRAMES {
            self.mse_keyframes.remove(0);
        }
    }

    pub(crate) fn on_mse_segment(&mut self, start: f64, end: f64, key_ms: u32) {
        if end > self.last_mse_seg_end {
            self.last_mse_seg_end = end;
        }
        self.queued_video_sec += (end - start).clamp(0.04, 4.0);
        if key_ms != u32::MAX {
            self.register_keyframe(f64::from(key_ms) / 1000.0);
        }
    }

    pub(crate) fn on_video_frame(&mut self, pts: f64) {
        let step = self
            .last_video_pts
            .map_or(1.0 / 30.0, |prev| (pts - prev).clamp(0.01, 0.2));
        self.last_video_pts = Some(pts);
        self.queued_video_sec += step;
    }

    pub(crate) fn on_audio_chunk(&mut self, rate: u32, samples: u32) {
        if rate > 0 && samples > 0 {
            self.queued_audio_sec += f64::from(samples) / f64::from(rate);
        }
    }

    pub(crate) fn apply_clock(
        &mut self,
        media_time: f64,
        wall_ms: f64,
        playing: bool,
        video_consumed_sec: f64,
        audio_consumed_sec: f64,
    ) {
        if self.video_mode != VideoOutputMode::Mse && video_consumed_sec > 0.0 {
            self.queued_video_sec = (self.queued_video_sec - video_consumed_sec).max(0.0);
        }
        if audio_consumed_sec > 0.0 {
            self.queued_audio_sec = (self.queued_audio_sec - audio_consumed_sec).max(0.0);
        }
        self.clock_playing = playing;
        if media_time.is_finite() && media_time >= 0.0 {
            self.clock_media = media_time;
        }
        self.clock_wall_ms = wall_ms;
        self.last_credit_wall_ms = wall_ms;
    }

    pub(crate) fn buffered_ahead(
        &self,
        now_wall_ms: f64,
        wc_queued_span_sec: f64,
        wc_in_flight: u32,
    ) -> bool {
        if !self.has_video && !self.has_audio {
            return false;
        }
        let max_video = match self.video_mode {
            VideoOutputMode::Mse => 16.0,
            VideoOutputMode::WebCodecs => 5.0,
            VideoOutputMode::Software => 2.5,
        };
        let max_audio = if self.page_hidden { 6.5 } else { 6.0 };
        let since_credit = if self.clock_playing {
            ((now_wall_ms - self.last_credit_wall_ms) / 1000.0).clamp(0.0, 30.0)
        } else {
            0.0
        };
        let video_sec = match self.video_mode {
            VideoOutputMode::Mse => (self.last_mse_seg_end - self.media_time(now_wall_ms)).max(0.0),
            VideoOutputMode::WebCodecs => wc_queued_span_sec + (f64::from(wc_in_flight) / 24.0),
            VideoOutputMode::Software => (self.queued_video_sec - since_credit).max(0.0),
        };
        let audio_sec = (self.queued_audio_sec - since_credit).max(0.0);
        let v_ok = (self.page_hidden && self.video_mode != VideoOutputMode::Mse)
            || !self.has_video
            || video_sec >= max_video;
        let a_ok = !self.has_audio || audio_sec >= max_audio;
        v_ok && a_ok
    }

    /// Computes a W3C MSE Coded Frame Removal safe eviction cutoff `cut` in `[0, b_end)`.
    /// Never removes at or past the active GOP keyframe `active_kf <= now + 0.08`, preventing
    /// `SourceBuffer.remove(0, cut)` from wiping out the GOP currently playing at `now`.
    pub(crate) fn safe_mse_evict_cut(
        &mut self,
        now: f64,
        keep_behind: f64,
        b0: f64,
        b_end: f64,
    ) -> f64 {
        if !b0.is_finite() || !b_end.is_finite() || b_end <= b0 + 0.2 {
            return 0.0;
        }
        let max_safe = self.max_safe_evict_cap(now, keep_behind);
        let cut = (b_end - 0.5).min(now - keep_behind).min(max_safe);
        if cut > b0 + 0.2 {
            self.mse_keyframes.retain(|&kf| kf >= cut - 0.05);
            cut
        } else {
            0.0
        }
    }

    pub(crate) fn max_safe_evict_cap(&self, now: f64, keep_behind: f64) -> f64 {
        let active_kf = self
            .mse_keyframes
            .iter()
            .copied()
            .filter(|&kf| kf <= now + 0.08)
            .fold(None::<f64>, |acc, x| Some(acc.map_or(x, |a| a.max(x))));
        active_kf.map_or_else(|| (now - keep_behind.max(10.0)).max(0.0), |kf| (kf - 0.05).max(0.0))
    }

    pub(crate) fn evaluate_mse_tick(
        &mut self,
        now: f64,
        vt: f64,
        b0: f64,
        b_end: f64,
        ready_state: u32,
        mse_stalled: bool,
        can_hard_sync: bool,
        duration_secs: f64,
        rebuffering: bool,
        mse_buffered_ahead_sec: f64,
        audio_queued_ahead_sec: f64,
        eof: bool,
    ) -> MseTickAction {
        let max_evict_cap = self.max_safe_evict_cap(now, 1.5);
        let evict_to = if b0.is_finite() && now - b0 > 14.0 {
            self.safe_mse_evict_cut(now, 10.0, b0, b_end)
        } else {
            0.0
        };
        let long = duration_secs >= 120.0;
        let v_need = if long { 2.2 } else { 0.5 };
        let a_need = if long { 1.2 } else { 0.2 };
        let exit_rebuffer = rebuffering
            && (eof || mse_buffered_ahead_sec >= v_need)
            && (eof || !self.has_audio || audio_queued_ahead_sec >= a_need);
        let drift = vt - now;
        let mut snap_to = -1.0;
        let mut playback_rate = 1.0;
        if exit_rebuffer {
            if b0.is_finite() && b_end.is_finite() && now + 0.35 >= b0 && now + 0.15 <= b_end {
                if vt < b0 || drift.abs() > 0.25 {
                    snap_to = now.max(b0 + 0.02);
                }
            }
        } else if (drift.abs() > 1.2 || (mse_stalled && drift.abs() > 0.35)) && can_hard_sync {
            if b0.is_finite() && b_end.is_finite() && now + 0.35 >= b0 && now + 0.20 <= b_end {
                snap_to = now.max(b0 + 0.02);
            }
        } else if ready_state >= 2 {
            playback_rate = if drift > 0.22 {
                0.95
            } else if drift > 0.070 {
                0.98
            } else if drift < -0.22 {
                1.05
            } else if drift < -0.070 {
                1.02
            } else {
                1.0
            };
        }
        MseTickAction {
            evict_to,
            snap_to,
            playback_rate,
            max_evict_cap,
            exit_rebuffer,
        }
    }

    pub(crate) fn crop_sample_due(&mut self, w: u32) -> bool {
        if w > 0 {
            self.last_sampled_w = w;
        }
        if self.stream_crop_same >= 3 {
            if self.last_sampled_w >= 1280 || self.stream_crop.is_none() {
                return false;
            }
            self.stream_crop_frames = self.stream_crop_frames.wrapping_add(1);
            return self.stream_crop_frames % 30 == 1;
        }
        self.stream_crop_frames = self.stream_crop_frames.wrapping_add(1);
        self.stream_crop_frames % 4 == 1
    }

    pub(crate) fn detect_letterbox(
        u8_buf: &[u8],
        sw: u32,
        sh: u32,
        full_w: u32,
        full_h: u32,
        rgba: bool,
    ) -> Option<CropRect> {
        let w = sw as usize;
        let h = sh as usize;
        let need = if rgba { w.checked_mul(h)?.checked_mul(4)? } else { w.checked_mul(h)? };
        if w == 0 || h == 0 || full_w == 0 || full_h == 0 || u8_buf.len() < need {
            return None;
        }
        let value = |i: usize| -> u8 {
            if rgba {
                let b = i * 4;
                u8_buf[b].max(u8_buf[b + 1]).max(u8_buf[b + 2])
            } else {
                u8_buf[i]
            }
        };
        let mut sum = 0u64;
        let mut n = 0u64;
        let mut y = 0usize;
        while y < h {
            let mut x = 0usize;
            while x < w {
                sum += u64::from(value(y * w + x));
                n += 1;
                x += 16;
            }
            y += 16;
        }
        if n == 0 || (sum as f64) / (n as f64) < 25.0 {
            return None;
        }
        let black_row = |row: usize| -> bool {
            let mut x = 0usize;
            while x < w {
                if value(row * w + x) > 24 {
                    return false;
                }
                x += 8;
            }
            true
        };
        let mut top = 0usize;
        while top < h && black_row(top) {
            top += 1;
        }
        let mut bottom = h - 1;
        while bottom > top && black_row(bottom) {
            bottom -= 1;
        }
        if ((bottom - top + 1) as f64) < (h as f64) * 0.5 {
            return None;
        }
        let black_col = |col: usize| -> bool {
            let mut r = top;
            while r <= bottom {
                if value(r * w + col) > 24 {
                    return false;
                }
                r += 8;
            }
            true
        };
        let mut left = 0usize;
        while left < w && black_col(left) {
            left += 1;
        }
        let mut right = w - 1;
        while right > left && black_col(right) {
            right -= 1;
        }
        if ((right - left + 1) as f64) < (w as f64) * 0.95 {
            return None;
        }
        let full = (top as f64) < (h as f64) * 0.02
            && ((h - 1 - bottom) as f64) < (h as f64) * 0.02
            && (left as f64) < (w as f64) * 0.02
            && ((w - 1 - right) as f64) < (w as f64) * 0.02;
        if full {
            return Some(CropRect {
                left: 0,
                top: 0,
                right: full_w,
                bottom: full_h,
                full: true,
            });
        }
        let scale_y = |v: usize| -> u32 {
            (((v as f64) * (full_h as f64) / (sh as f64)).round() as u32).min(full_h)
        };
        Some(CropRect {
            left: 0,
            top: scale_y(top),
            right: full_w,
            bottom: scale_y(bottom + 1),
            full: false,
        })
    }

    pub(crate) fn probe_letterbox(
        &mut self,
        u8_buf: &[u8],
        sw: u32,
        sh: u32,
        full_w: u32,
        full_h: u32,
        rgba: bool,
    ) -> Option<CropRect> {
        if rgba {
            self.crop_readbacks = self.crop_readbacks.saturating_add(1);
        }
        let c = Self::detect_letterbox(u8_buf, sw, sh, full_w, full_h, rgba)?;
        let tol = (full_h as f64 / 100.0).round().max(2.0) as i64;
        let same = self.stream_crop_candidate.is_some_and(|p| {
            (i64::from(p.left) - i64::from(c.left)).abs() <= tol
                && (i64::from(p.top) - i64::from(c.top)).abs() <= tol
                && (i64::from(p.right) - i64::from(c.right)).abs() <= tol
                && (i64::from(p.bottom) - i64::from(c.bottom)).abs() <= tol
        });
        self.stream_crop_candidate = Some(c);
        self.stream_crop_same = if same { self.stream_crop_same + 1 } else { 1 };
        if self.stream_crop_same < 3 {
            return None;
        }
        let changed = if c.full {
            self.stream_crop.is_some()
        } else {
            self.stream_crop.is_none_or(|cur| {
                (i64::from(cur.top) - i64::from(c.top)).abs() > tol
                    || (i64::from(cur.bottom) - i64::from(c.bottom)).abs() > tol
            })
        };
        if changed {
            self.stream_crop = if c.full { None } else { Some(c) };
            Some(c)
        } else {
            None
        }
    }

    /// Returns `(mode, target_secs)`:
    /// - `0`: resume normal playback (`pendingReturnSnap = false`)
    /// - `1`: MSE segment is mid-append (`pendingReturnSnap = true`)
    /// - `2`: MSE is buffered at `audio_secs`, snap `video.currentTime = target_secs`
    /// - `3`: unbuffered idle MSE or returning from hidden `avi`, `seekTo(target_secs)`
    pub(crate) fn evaluate_return_sync(
        use_mse: bool,
        was_hidden: bool,
        is_avi: bool,
        audio_secs: f64,
        video_secs: f64,
        mse_buffered_at_audio: f64,
        sb_updating: bool,
    ) -> (u32, f64) {
        if use_mse {
            if mse_buffered_at_audio < 0.15 {
                if sb_updating {
                    return (1, audio_secs);
                }
                return (3, audio_secs);
            }
            if (video_secs - audio_secs).abs() > 0.2 {
                return (2, audio_secs);
            }
            return (0, audio_secs);
        }
        if was_hidden && is_avi {
            return (3, audio_secs);
        }
        (0, audio_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mse_evict_cut_never_deletes_active_gop_keyframe() {
        let mut ctrl = PlayerController::default();
        ctrl.reset(0.0, 1000.0, true, true, VideoOutputMode::Mse);
        for kf in [0.0, 8.0, 16.0, 24.0, 32.0] {
            ctrl.on_mse_segment(kf, kf + 8.0, (kf * 1000.0) as u32);
        }

        // At now = 22.8s (inside the 16..24s GOP) with b0 = 0.0s and QuotaExceeded keep_behind = 1.5s,
        // cut is capped at 15.95s (strictly before active_kf = 16.0s), evicting [0..16s] while keeping [16..24s].
        let cut1 = ctrl.safe_mse_evict_cut(22.8, 1.5, 0.0, 36.0);
        assert!((cut1 - 15.95).abs() < 1e-6, "expected 15.95, got {cut1}");

        // Once b0 is already at 16.0s, a second QuotaExceeded retry at now = 22.8s must return 0.0
        // rather than cutting into the active [16..24s] GOP.
        let cut2 = ctrl.safe_mse_evict_cut(22.8, 1.5, 16.0, 36.0);
        assert_eq!(cut2, 0.0);

        // Once playback advances into the next GOP (now = 26.5s, active_kf = 24.0s), normal trim (keep_behind = 10s)
        // safely evicts [16..24s] with cut = 16.5s (< 23.95s).
        let cut3 = ctrl.safe_mse_evict_cut(26.5, 10.0, 16.0, 36.0);
        assert!((cut3 - 16.5).abs() < 1e-6, "expected 16.5, got {cut3}");
    }

    #[test]
    fn buffer_horizon_gates_mse_webcodecs_and_software_modes() {
        let mut ctrl = PlayerController::default();
        ctrl.reset(10.0, 1000.0, true, true, VideoOutputMode::Mse);
        ctrl.apply_clock(10.0, 1000.0, true, 0.0, 0.0);
        ctrl.on_mse_segment(10.0, 22.0, 10_000);
        ctrl.on_audio_chunk(48_000, 48_000 * 7);
        // Only 12s of MSE video (< 16s target) -> not buffered ahead yet.
        assert!(!ctrl.buffered_ahead(1000.0, 0.0, 0));
        ctrl.on_mse_segment(22.0, 27.0, u32::MAX);
        // 17s of MSE video and 7s of audio -> buffered ahead.
        assert!(ctrl.buffered_ahead(1000.0, 0.0, 0));
        // After 2 seconds of wall-clock playback without credit, audio decays to 5s (< 6s) -> needs pump.
        assert!(!ctrl.buffered_ahead(3000.0, 0.0, 0));
    }

    #[test]
    fn repeated_pumps_between_credits_do_not_compound_clock() {
        let mut ctrl = PlayerController::default();
        ctrl.reset(5.0, 1000.0, true, true, VideoOutputMode::Mse);
        ctrl.apply_clock(5.0, 1000.0, true, 0.0, 0.0);
        let mut decoder_clock = 5.0;
        // Simulate 96 pump iterations 200 ms after the last credit anchor (wall = 1200 ms).
        for _ in 0..96 {
            decoder_clock = ctrl.media_time(1200.0);
        }
        assert!((decoder_clock - 5.2).abs() < 1e-6, "expected 5.2s, got {decoder_clock}");
        assert!((ctrl.media_time(1200.0) - 5.2).abs() < 1e-6);
    }

    #[test]
    fn evaluate_mse_tick_computes_eviction_drift_rate_and_stall_snap() {
        let mut ctrl = PlayerController::default();
        ctrl.reset(0.0, 1000.0, true, true, VideoOutputMode::Mse);
        for kf in [0.0, 8.0, 16.0, 24.0] {
            ctrl.on_mse_segment(kf, kf + 8.0, (kf * 1000.0) as u32);
        }
        // Small positive drift (+0.12s) -> gentle 0.98 rate, no snap.
        let act1 = ctrl.evaluate_mse_tick(10.0, 10.12, 0.0, 24.0, 4, false, true, 180.0, false, 14.0, 4.0, false);
        assert_eq!(act1.snap_to, -1.0);
        assert!((act1.playback_rate - 0.98).abs() < 1e-6);
        assert!(!act1.exit_rebuffer);

        // Stalled MSE with 0.5s drift at now = 18.0s (b0 = 0.0s, active_kf = 16.0s) -> evicts to 8.0s and snaps to 18.0s.
        let act2 = ctrl.evaluate_mse_tick(18.0, 17.4, 0.0, 28.0, 2, true, true, 180.0, false, 10.0, 4.0, false);
        assert!((act2.evict_to - 8.0).abs() < 1e-6);
        assert!((act2.snap_to - 18.0).abs() < 1e-6);
        assert!((act2.max_evict_cap - 15.95).abs() < 1e-6);

        // Rebuffer exit on long stream (duration = 180s >= 120s requires v >= 2.2s and a >= 1.2s).
        let act3 = ctrl.evaluate_mse_tick(18.0, 17.0, 16.0, 24.0, 2, false, true, 180.0, true, 2.5, 1.5, false);
        assert!(act3.exit_rebuffer);
        assert!((act3.snap_to - 18.0).abs() < 1e-6);

        // Prefetch plan bounds 24-block lookahead, 4-block trail eviction, and 6 in flight.
        let (start_b, end_b, evict_b, max_f) = PlayerController::prefetch_plan(10, 200 * 1024 * 1024, 2 * 1024 * 1024);
        assert_eq!((start_b, end_b, evict_b, max_f), (10, 35, 6, 6));
    }

    #[test]
    fn letterbox_detector_settles_after_three_samples_and_stops_on_1080p() {
        let mut ctrl = PlayerController::default();
        ctrl.reset(0.0, 1000.0, true, true, VideoOutputMode::WebCodecs);
        let (sw, sh, fw, fh) = (160u32, 90u32, 1920u32, 1080u32);
        let mut rgba = vec![0u8; (sw * sh * 4) as usize];
        // Fill middle rows [12..78] with bright gray (120), leaving 12-row black bars top and bottom.
        for y in 12..78 {
            for x in 0..sw as usize {
                let idx = (y * sw as usize + x) * 4;
                rgba[idx] = 120;
                rgba[idx + 1] = 120;
                rgba[idx + 2] = 120;
                rgba[idx + 3] = 255;
            }
        }
        let mut settled = None;
        for _ in 0..16 {
            if ctrl.crop_sample_due(fw) {
                if let Some(c) = ctrl.probe_letterbox(&rgba, sw, sh, fw, fh, true) {
                    settled = Some(c);
                }
            }
        }
        let c = settled.expect("3 agreeing samples must emit crop");
        assert!(!c.full && c.top == 144 && c.bottom == 936);
        assert_eq!(ctrl.crop_readbacks, 3);
        // Subsequent 1080p frames must not trigger any further readbacks.
        for _ in 0..100 {
            assert!(!ctrl.crop_sample_due(fw));
        }
    }

    #[test]
    fn stream_cache_stores_bytes_in_wasm_and_never_evicts_blocks_ahead_of_read_cursor() {
        let mut cache = StreamCache::default();
        cache.last_posted_block = 5;
        for idx in 0..MAX_CACHE_BLOCKS as u32 {
            assert_eq!(cache.put_block_bytes(idx, &[idx as u8; 64]), -1);
        }
        assert_eq!(cache.block_count(), MAX_CACHE_BLOCKS as u32);
        // Read from blocks 1..4 inside WASM so block 0 remains the oldest block behind last_posted_block (5).
        let mut dst = [0u8; 16];
        for idx in 1..5u32 {
            let n = cache.read_cached(u64::from(idx) * STREAM_BLOCK_BYTES, &mut dst, true);
            assert_eq!(n, 16);
            assert_eq!(dst[0], idx as u8);
        }
        cache.last_posted_block = 5;
        // Inserting block 48 must evict block 0 (the oldest block < last_posted_block = 5), never >= 5.
        let evicted = cache.put_block_bytes(48, &[48u8; 64]);
        assert_eq!(evicted, 0);

        // 4 GiB (1 << 32, block 2048) must never wrap u64 -> 32-bit usize and alias head_probe or partial_data at offset 0.
        cache.put_head_bytes(&[0xAA; 64]);
        cache.set_partial_bytes(0, &[0xBB; 64]);
        cache.put_block_bytes(2048, &[0xCC; 64]);
        let off_4gib = 2048u64 * STREAM_BLOCK_BYTES;
        assert_eq!(off_4gib as u32, 0);
        let n_4gib = cache.read_cached(off_4gib, &mut dst, true);
        assert_eq!(n_4gib, 16);
        assert_eq!(dst, [0xCC; 16]);
        // Uncached block 4096 (8 GiB) must miss (0) rather than aliasing head_probe (0xAA) or partial_data (0xBB).
        assert_eq!(cache.read_cached(4096u64 * STREAM_BLOCK_BYTES, &mut dst, true), 0);

        // Return-sync rules cover MSE buffered snap, mid-append wait, unbuffered seek, and AVI hidden seek.
        assert_eq!(PlayerController::evaluate_return_sync(true, true, false, 20.0, 12.0, 4.0, false), (2, 20.0));
        assert_eq!(PlayerController::evaluate_return_sync(true, true, false, 20.0, 12.0, 0.0, true), (1, 20.0));
        assert_eq!(PlayerController::evaluate_return_sync(true, true, false, 20.0, 12.0, 0.0, false), (3, 20.0));
        assert_eq!(PlayerController::evaluate_return_sync(false, true, true, 15.0, 15.0, 0.0, false), (3, 15.0));
    }
}
