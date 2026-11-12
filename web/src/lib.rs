//! PearTube Browser WebAssembly Media Engine.
//! Wraps peartube-media's safe-Rust container demuxers, video/audio/subtitle decoders,
//! SIMD128 surround-to-stereo planar downmixer, and zero-copy H.264/HEVC/AV1/VP9 fMP4 muxer
//! behind a flat C ABI for Dedicated Web Workers.
//!
//! Every module below the boundary is safe Rust: the crate root denies `unsafe_code`, and only
//! `ffi` (host bridge, allocator, raw-pointer marshalling, SIMD128 loads) and `abi` (the C exports)
//! are allowed any. The demuxers, decoders, mixer and muxer themselves never touch a raw pointer.
#![deny(unsafe_code)]

// The demux repair the native player already runs, so a movie stamped in
// decode order keeps all 24 of its pictures here too.
mod controller;
mod decode_order;
mod ffi;
mod abi;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use oxideav_core::{
    ChannelLayout, ChannelPosition, CodecParameters, ColorPrimaries, ColorRange, ColorSignal,
    Decoder, Demuxer, Error as AvError, Frame, MatrixCoefficients, MediaType, Packet, PixelFormat,
    ProbeData, RuntimeContext, SampleFormat, Segment, StreamInfo, SubtitleCue, TimeBase,
    TransferCharacteristics, VideoFrame, PROBE_SCORE_EXTENSION,
};
use oxideav_pixfmt::{ColorSpace, ConvertOptions, FrameInfo};
use serde_json::json;

pub const MAX_HIDDEN_GOPS: usize = 12;
pub const MAX_GOP_PKTS: usize = 320;

const PROBE_PAGE_SIZE: usize = 128 * 1024;
const STREAM_PAGE_SIZE: usize = 256 * 1024;
const MAX_PAGES: usize = 4;
const VIDEO_TIMESCALE: u32 = 90_000;

static REGISTRY: LazyLock<RuntimeContext> = LazyLock::new(codecs::context);

struct CachePage {
    start: u64,
    valid: usize,
    stamp: u64,
    data: Vec<u8>,
}

// Lean 1 MiB (4 x 256 KiB) in-place page ring over the Worker's async-prefetched 2 MiB block cache:
// zero per-page heap allocations and 19 MiB less WASM linear memory footprint.
struct HttpRangeSource {
    len: u64,
    pos: u64,
    clock: u64,
    streaming: Arc<AtomicBool>,
    pages: Vec<CachePage>,
}

impl HttpRangeSource {
    fn new(streaming: Arc<AtomicBool>) -> Self {
        let len = ffi::stream_len();
        Self {
            len,
            pos: 0,
            clock: 0,
            streaming,
            pages: Vec::with_capacity(MAX_PAGES),
        }
    }

    fn fetch_at(&mut self, pos: u64) -> io::Result<usize> {
        self.clock = self.clock.wrapping_add(1);
        if let Some(idx) = self
            .pages
            .iter()
            .position(|p| p.valid > 0 && pos >= p.start && pos < p.start + p.valid as u64)
        {
            self.pages[idx].stamp = self.clock;
            return Ok(idx);
        }
        let chunk_size = if self.streaming.load(Ordering::Relaxed) {
            STREAM_PAGE_SIZE
        } else {
            PROBE_PAGE_SIZE
        };
        let aligned_start = (pos / chunk_size as u64) * chunk_size as u64;
        if aligned_start >= self.len {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "past stream end"));
        }
        let want = (self.len - aligned_start).min(chunk_size as u64) as usize;
        let slot = if self.pages.len() < MAX_PAGES {
            let idx = self.pages.len();
            self.pages.push(CachePage {
                start: 0,
                valid: 0,
                stamp: 0,
                data: Vec::with_capacity(STREAM_PAGE_SIZE),
            });
            idx
        } else {
            self.pages
                .iter()
                .enumerate()
                .min_by_key(|(_, p)| p.stamp)
                .map(|(i, _)| i)
                .unwrap_or(0)
        };
        let page = &mut self.pages[slot];
        if page.data.len() < want {
            page.data.resize(want, 0);
        }
        let streaming = self.streaming.load(Ordering::Relaxed);
        let mut filled = 0usize;
        while filled < want {
            let cur_off = aligned_start + filled as u64;
            let cached_got = controller::CACHE.with(|c| {
                c.borrow_mut().read_cached(cur_off, &mut page.data[filled..want], streaming)
            });
            if cached_got > 0 {
                filled += cached_got;
                continue;
            }
            let got = ffi::read_at(cur_off, &mut page.data[filled..want]);
            if got < 0 {
                page.valid = 0;
                return Err(io::Error::other("HTTP Range read failed"));
            }
            if got == 0 {
                break;
            }
            filled += got as usize;
        }
        if filled == 0 {
            page.valid = 0;
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "empty Range response"));
        }
        page.start = aligned_start;
        page.valid = filled;
        page.stamp = self.clock;
        Ok(slot)
    }
}

impl Read for HttpRangeSource {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let slot = match self.fetch_at(self.pos) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(0),
            Err(e) => return Err(e),
        };
        let page = &self.pages[slot];
        let page_off = (self.pos - page.start) as usize;
        if page_off >= page.valid {
            return Ok(0);
        }
        let n = out.len().min(page.valid - page_off);
        out[..n].copy_from_slice(&page.data[page_off..page_off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeSource {
    fn seek(&mut self, style: SeekFrom) -> io::Result<u64> {
        let next: i128 = match style {
            SeekFrom::Start(off) => i128::from(off),
            SeekFrom::Current(rel) => i128::from(self.pos) + i128::from(rel),
            SeekFrom::End(rel) => i128::from(self.len) + i128::from(rel),
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek"));
        }
        self.pos = (next as u64).min(self.len);
        Ok(self.pos)
    }
}

// Folds 5.1 / 7.1 surround channels straight into reusable planar [L..][R..] f32 buffers with SIMD128 and zero per-packet allocations.
struct StereoMix {
    channels: usize,
    gains: [[f32; 2]; 64],
}

impl StereoMix {
    fn new(layout: ChannelLayout) -> Self {
        let channels = usize::from(layout.channel_count()).clamp(1, 64);
        let mut gains = [[0.0f32; 2]; 64];
        let surround = std::f32::consts::FRAC_1_SQRT_2;
        for (idx, gain) in gains[..channels].iter_mut().enumerate() {
            use ChannelPosition::*;
            *gain = match layout.position(idx) {
                Some(FrontLeft) => [1.0, 0.0],
                Some(FrontRight) => [0.0, 1.0],
                Some(FrontCenter) if channels == 1 => [1.0, 1.0],
                Some(FrontCenter) => [surround, surround],
                Some(SideLeft | BackLeft | FrontLeftOfCenter) => [surround, 0.0],
                Some(SideRight | BackRight | FrontRightOfCenter) => [0.0, surround],
                Some(BackCenter) => [0.5, 0.5],
                Some(LowFrequency) => [0.0, 0.0],
                _ => [1.0 / channels as f32; 2],
            };
        }
        let mut sums = [0.0f32; 2];
        for g in &gains[..channels] {
            sums[0] += g[0];
            sums[1] += g[1];
        }
        let scale = 1.0 / sums[0].max(sums[1]).max(1.0);
        for g in &mut gains[..channels] {
            g[0] *= scale;
            g[1] *= scale;
        }
        Self { channels, gains }
    }

    fn append_frame_planar(
        &self,
        af: &oxideav_core::AudioFrame,
        format: SampleFormat,
        out_l: &mut Vec<f32>,
        out_r: &mut Vec<f32>,
    ) -> usize {
        let n = af.samples as usize;
        if n == 0 || af.data.is_empty() {
            return 0;
        }
        let ch = self.channels.clamp(1, 64);
        let base_idx = out_l.len();
        out_l.resize(base_idx + n, 0.0);
        out_r.resize(base_idx + n, 0.0);
        let dst_l = &mut out_l[base_idx..base_idx + n];
        let dst_r = &mut out_r[base_idx..base_idx + n];

        match format {
            SampleFormat::F32P => {
                if ch == 2 && af.data.len() >= 2 && af.data[0].len() >= n * 4 && af.data[1].len() >= n * 4 {
                    decode_f32le_clamped(&af.data[0][..n * 4], dst_l);
                    decode_f32le_clamped(&af.data[1][..n * 4], dst_r);
                    return n;
                }
                if ch == 1 && af.data[0].len() >= n * 4 {
                    decode_f32le_clamped(&af.data[0][..n * 4], dst_l);
                    dst_r.copy_from_slice(dst_l);
                    return n;
                }
                for (c, &[gl, gr]) in self.gains[..ch].iter().enumerate() {
                    if gl == 0.0 && gr == 0.0 {
                        continue;
                    }
                    let Some(plane) = af.data.get(c).filter(|p| p.len() >= n * 4) else {
                        continue;
                    };
                    accum_f32le_plane(&plane[..n * 4], gl, gr, dst_l, dst_r);
                }
                clamp_stereo_inplace(dst_l, dst_r);
                n
            }
            SampleFormat::F32 => {
                let plane = &af.data[0];
                let avail = (plane.len() / (ch * 4)).min(n);
                if avail == 0 {
                    out_l.truncate(base_idx);
                    out_r.truncate(base_idx);
                    return 0;
                }
                out_l.truncate(base_idx + avail);
                out_r.truncate(base_idx + avail);
                let dl = &mut out_l[base_idx..base_idx + avail];
                let dr = &mut out_r[base_idx..base_idx + avail];
                if ch == 2 {
                    for (i, frame) in plane[..avail * 8].chunks_exact(8).enumerate() {
                        let l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                        let r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
                        dl[i] = if l.is_finite() { l.clamp(-1.0, 1.0) } else { 0.0 };
                        dr[i] = if r.is_finite() { r.clamp(-1.0, 1.0) } else { 0.0 };
                    }
                } else {
                    for (i, frame) in plane[..avail * ch * 4].chunks_exact(ch * 4).enumerate() {
                        let mut l = 0.0f32;
                        let mut r = 0.0f32;
                        for (s_bytes, &[gl, gr]) in frame.chunks_exact(4).zip(&self.gains[..ch]) {
                            let s = f32::from_le_bytes([s_bytes[0], s_bytes[1], s_bytes[2], s_bytes[3]]);
                            if s.is_finite() {
                                l += s * gl;
                                r += s * gr;
                            }
                        }
                        dl[i] = l.clamp(-1.0, 1.0);
                        dr[i] = r.clamp(-1.0, 1.0);
                    }
                }
                avail
            }
            SampleFormat::S16P => {
                const SCALE: f32 = 1.0 / 32768.0;
                for (c, &[gl, gr]) in self.gains[..ch].iter().enumerate() {
                    if gl == 0.0 && gr == 0.0 {
                        continue;
                    }
                    let Some(plane) = af.data.get(c).filter(|p| p.len() >= n * 2) else {
                        continue;
                    };
                    let sl = gl * SCALE;
                    let sr = gr * SCALE;
                    for (i, b) in plane[..n * 2].chunks_exact(2).enumerate() {
                        let s = i16::from_le_bytes([b[0], b[1]]) as f32;
                        dst_l[i] += s * sl;
                        dst_r[i] += s * sr;
                    }
                }
                clamp_stereo_inplace(dst_l, dst_r);
                n
            }
            SampleFormat::S16 => {
                const SCALE: f32 = 1.0 / 32768.0;
                let plane = &af.data[0];
                let avail = (plane.len() / (ch * 2)).min(n);
                out_l.truncate(base_idx + avail);
                out_r.truncate(base_idx + avail);
                let dl = &mut out_l[base_idx..base_idx + avail];
                let dr = &mut out_r[base_idx..base_idx + avail];
                if ch == 2 {
                    for (i, frame) in plane[..avail * 4].chunks_exact(4).enumerate() {
                        dl[i] = i16::from_le_bytes([frame[0], frame[1]]) as f32 * SCALE;
                        dr[i] = i16::from_le_bytes([frame[2], frame[3]]) as f32 * SCALE;
                    }
                } else {
                    for (i, frame) in plane[..avail * ch * 2].chunks_exact(ch * 2).enumerate() {
                        let mut l = 0.0f32;
                        let mut r = 0.0f32;
                        for (b, &[gl, gr]) in frame.chunks_exact(2).zip(&self.gains[..ch]) {
                            let s = i16::from_le_bytes([b[0], b[1]]) as f32 * SCALE;
                            l += s * gl;
                            r += s * gr;
                        }
                        dl[i] = l.clamp(-1.0, 1.0);
                        dr[i] = r.clamp(-1.0, 1.0);
                    }
                }
                avail
            }
            SampleFormat::S32P => {
                const SCALE: f32 = 1.0 / 2_147_483_648.0;
                for (c, &[gl, gr]) in self.gains[..ch].iter().enumerate() {
                    if gl == 0.0 && gr == 0.0 {
                        continue;
                    }
                    let Some(plane) = af.data.get(c).filter(|p| p.len() >= n * 4) else {
                        continue;
                    };
                    let sl = gl * SCALE;
                    let sr = gr * SCALE;
                    for (i, b) in plane[..n * 4].chunks_exact(4).enumerate() {
                        let s = i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32;
                        dst_l[i] += s * sl;
                        dst_r[i] += s * sr;
                    }
                }
                clamp_stereo_inplace(dst_l, dst_r);
                n
            }
            SampleFormat::S32 => {
                let plane = &af.data[0];
                let avail = (plane.len() / (ch * 4)).min(n);
                out_l.truncate(base_idx + avail);
                out_r.truncate(base_idx + avail);
                let dl = &mut out_l[base_idx..base_idx + avail];
                let dr = &mut out_r[base_idx..base_idx + avail];
                #[cfg(target_arch = "wasm32")]
                {
                    ffi::downmix_s32le_simd(plane, ch, avail, &self.gains[..ch], dl, dr);
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    const SCALE: f32 = 1.0 / 2_147_483_648.0;
                    for (i, frame) in plane[..avail * ch * 4].chunks_exact(ch * 4).enumerate() {
                        let mut l = 0.0f32;
                        let mut r = 0.0f32;
                        for (b, &[gl, gr]) in frame.chunks_exact(4).zip(&self.gains[..ch]) {
                            let s = i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 * SCALE;
                            l += s * gl;
                            r += s * gr;
                        }
                        dl[i] = l.clamp(-1.0, 1.0);
                        dr[i] = r.clamp(-1.0, 1.0);
                    }
                }
                avail
            }
            _ => {
                for i in 0..n {
                    let mut l = 0.0f32;
                    let mut r = 0.0f32;
                    for (c, &[gl, gr]) in self.gains[..ch].iter().enumerate() {
                        if gl == 0.0 && gr == 0.0 {
                            continue;
                        }
                        let s = sample_f32_fallback(format, &af.data, ch, c, i);
                        if s.is_finite() {
                            l += s * gl;
                            r += s * gr;
                        }
                    }
                    dst_l[i] = l.clamp(-1.0, 1.0);
                    dst_r[i] = r.clamp(-1.0, 1.0);
                }
                n
            }
        }
    }
}

#[inline]
fn decode_f32le_clamped(src_bytes: &[u8], dst: &mut [f32]) {
    #[cfg(target_arch = "wasm32")]
    {
        ffi::decode_f32le_clamped_simd(src_bytes, dst);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for (d, b) in dst.iter_mut().zip(src_bytes.chunks_exact(4)) {
            let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            *d = if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 };
        }
    }
}

#[inline]
fn accum_f32le_plane(src_bytes: &[u8], gl: f32, gr: f32, dst_l: &mut [f32], dst_r: &mut [f32]) {
    #[cfg(target_arch = "wasm32")]
    {
        ffi::accum_f32le_plane_simd(src_bytes, gl, gr, dst_l, dst_r);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for ((dl, dr), b) in dst_l.iter_mut().zip(dst_r.iter_mut()).zip(src_bytes.chunks_exact(4)) {
            let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            if s.is_finite() {
                *dl += s * gl;
                *dr += s * gr;
            }
        }
    }
}

#[inline]
fn clamp_stereo_inplace(dst_l: &mut [f32], dst_r: &mut [f32]) {
    #[cfg(target_arch = "wasm32")]
    {
        ffi::clamp_stereo_simd(dst_l, dst_r);
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for x in dst_l {
            *x = x.clamp(-1.0, 1.0);
        }
        for x in dst_r {
            *x = x.clamp(-1.0, 1.0);
        }
    }
}

fn sample_f32_fallback(format: SampleFormat, data: &[Vec<u8>], channels: usize, c: usize, i: usize) -> f32 {
    let (plane, index) = if format.is_planar() {
        (data.get(c).or_else(|| data.first()).map(Vec::as_slice).unwrap_or(&[]), i)
    } else {
        (data.first().map(Vec::as_slice).unwrap_or(&[]), i * channels + c)
    };
    let w = format.bytes_per_sample();
    let start = index * w;
    if w == 0 || start + w > plane.len() {
        return 0.0;
    }
    let b = &plane[start..start + w];
    match format {
        SampleFormat::U8 | SampleFormat::U8P => (b[0] as f32 - 128.0) / 128.0,
        SampleFormat::S8 => (b[0] as i8 as f32) / 128.0,
        SampleFormat::S24 => (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f32 / 8_388_608.0,
        SampleFormat::F64 | SampleFormat::F64P => f64::from_le_bytes(b.try_into().unwrap_or([0; 8])) as f32,
        _ => 0.0,
    }
}

// SIMD128 10-bit YUV420P10LE -> 8-bit YUV420P narrowing kernel with 4x4 Bayer ordered dithering.
fn pack_plane_10_to_8(plane: &oxideav_core::VideoPlane, cols: usize, rows: usize, dst: &mut Vec<u8>) {
    #[cfg(not(target_arch = "wasm32"))]
    const BAYER_4X4: [[u16; 4]; 4] = [
        [0, 2, 1, 3],
        [3, 1, 2, 0],
        [1, 3, 0, 2],
        [2, 0, 3, 1],
    ];
    let row_bytes = cols * 2;
    let base = dst.len();
    dst.resize(base + cols * rows, 0);
    let out = &mut dst[base..base + cols * rows];
    for r in 0..rows {
        let s = r * plane.stride;
        if s + row_bytes > plane.data.len() {
            break;
        }
        let src_row = &plane.data[s..s + row_bytes];
        let dst_row = &mut out[r * cols..(r + 1) * cols];
        #[cfg(target_arch = "wasm32")]
        {
            ffi::pack_u16_to_u8(src_row, dst_row, r);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let d4 = BAYER_4X4[r & 3];
            for (c, (d, px)) in dst_row.iter_mut().zip(src_row.chunks_exact(2)).enumerate() {
                *d = ((u16::from_le_bytes([px[0], px[1]]) + d4[c & 3]) >> 2).min(255) as u8;
            }
        }
    }
}

fn pack_plane_8(plane: &oxideav_core::VideoPlane, cols: usize, rows: usize, dst: &mut Vec<u8>) -> bool {
    if plane.stride == cols && plane.data.len() >= cols * rows {
        dst.extend_from_slice(&plane.data[..cols * rows]);
        return true;
    }
    let start_len = dst.len();
    dst.reserve(cols * rows);
    for r in 0..rows {
        let s = r * plane.stride;
        if s + cols > plane.data.len() {
            dst.truncate(start_len);
            return false;
        }
        dst.extend_from_slice(&plane.data[s..s + cols]);
    }
    true
}

// Vertically averages 4:2:2 chroma rows using hardware u8x16_avgr_u so YUV422P stays on the GPU YUV shader.
fn subsample_422_chroma(plane: &oxideav_core::VideoPlane, cwu: usize, hu: usize, chu: usize, dst: &mut Vec<u8>) -> bool {
    let base = dst.len();
    dst.resize(base + cwu * chu, 128);
    let out = &mut dst[base..base + cwu * chu];
    for cr in 0..chu {
        let r0 = (cr * 2).min(hu.saturating_sub(1));
        let r1 = (cr * 2 + 1).min(hu.saturating_sub(1));
        let s0 = r0 * plane.stride;
        let s1 = r1 * plane.stride;
        if s0 + cwu > plane.data.len() || s1 + cwu > plane.data.len() {
            dst.truncate(base);
            return false;
        }
        let row0 = &plane.data[s0..s0 + cwu];
        let row1 = &plane.data[s1..s1 + cwu];
        let drow = &mut out[cr * cwu..(cr + 1) * cwu];
        #[cfg(target_arch = "wasm32")]
        {
            ffi::average_rows(row0, row1, drow);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            for i in 0..cwu {
                drow[i] = ((u16::from(row0[i]) + u16::from(row1[i]) + 1) >> 1) as u8;
            }
        }
    }
    true
}

fn subsample_444_chroma(plane: &oxideav_core::VideoPlane, wu: usize, hu: usize, cwu: usize, chu: usize, dst: &mut Vec<u8>) -> bool {
    let base = dst.len();
    dst.resize(base + cwu * chu, 128);
    let out = &mut dst[base..base + cwu * chu];
    for cr in 0..chu {
        let r0 = (cr * 2).min(hu.saturating_sub(1));
        let r1 = (cr * 2 + 1).min(hu.saturating_sub(1));
        let s0 = r0 * plane.stride;
        let s1 = r1 * plane.stride;
        if s0 + wu > plane.data.len() || s1 + wu > plane.data.len() {
            dst.truncate(base);
            return false;
        }
        let row0 = &plane.data[s0..s0 + wu];
        let row1 = &plane.data[s1..s1 + wu];
        let drow = &mut out[cr * cwu..(cr + 1) * cwu];
        for cx in 0..cwu {
            let x0 = (cx * 2).min(wu.saturating_sub(1));
            let x1 = (cx * 2 + 1).min(wu.saturating_sub(1));
            let sum = u16::from(row0[x0]) + u16::from(row0[x1]) + u16::from(row1[x0]) + u16::from(row1[x1]) + 2;
            drow[cx] = (sum >> 2) as u8;
        }
    }
    true
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VideoCodecKind {
    H264,
    Hevc,
    Av1,
    Vp9,
    Vp8,
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NalFraming {
    AnnexB,
    LengthPrefixed(u8),
    RawPassthrough,
}

/// The byte stream MSE gets: fragmented MP4, or WebM for VP8, which browsers accept only in WebM.
#[derive(Clone, Copy, PartialEq, Eq)]
enum MseContainer {
    Fmp4,
    /// The Matroska codec ID of the one video track.
    WebM(&'static str),
}

#[derive(Clone)]
struct MseVideoConfig {
    kind: VideoCodecKind,
    width: u32,
    height: u32,
    framing: NalFraming,
    container: MseContainer,
    // The fMP4 sample entry; unused for WebM.
    config_box_fourcc: [u8; 4],
    sample_entry_fourcc: [u8; 4],
    config_payload: Vec<u8>,
    codec_string: String,
    frame_ticks_90k: i64,
    colr_nclx: Option<(u8, u8, u8, bool)>,
}

impl MseVideoConfig {
    /// The type the page hands `MediaSource.isTypeSupported` and `addSourceBuffer`.
    fn mime_type(&self) -> String {
        let base = match self.container {
            MseContainer::Fmp4 => "video/mp4",
            MseContainer::WebM(_) => "video/webm",
        };
        format!("{base}; codecs=\"{}\"", self.codec_string)
    }

    fn init_segment(&self) -> Vec<u8> {
        match self.container {
            MseContainer::Fmp4 => build_fmp4_init(self),
            MseContainer::WebM(codec_id) => build_webm_init(self, codec_id),
        }
    }

    fn media_segment(
        &self,
        seq: u32,
        gop: &[GopPacket],
        lookahead: &[GopPacket],
        min_dts_90k: &mut i64,
    ) -> Option<(Vec<u8>, f64, f64)> {
        match self.container {
            MseContainer::Fmp4 => build_fmp4_segment(seq, gop, lookahead, self.frame_ticks_90k, min_dts_90k),
            MseContainer::WebM(_) => build_webm_clusters(gop, lookahead, self.frame_ticks_90k),
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct ResolvedVideoColor {
    pub(crate) primaries: ColorPrimaries,
    pub(crate) transfer: TransferCharacteristics,
    pub(crate) matrix: MatrixCoefficients,
    pub(crate) full_range: bool,
    pub(crate) explicit_range: bool,
    pub(crate) matrix_id: u8,
    pub(crate) wide_gamut: bool,
}

impl ResolvedVideoColor {
    pub(crate) fn to_manifest_json(self) -> serde_json::Value {
        let primaries = match self.primaries {
            ColorPrimaries::BT2020 => "bt2020",
            ColorPrimaries::SMPTE_EG432 => "smpte432",
            ColorPrimaries::BT470_SYSTEM_BG => "bt470bg",
            ColorPrimaries::BT601_525 => "smpte170m",
            ColorPrimaries::BT709 => "bt709",
            _ if self.primaries.is_unspecified() => {
                if self.matrix_id == 1 { "smpte170m" } else { "bt709" }
            }
            _ => "other",
        };
        json!({
            "matrix": self.matrix_id,
            "fullRange": self.full_range,
            "primaries": primaries,
            "wideGamut": self.wide_gamut,
        })
    }

    pub(crate) fn to_webcodecs_color_space(self) -> Option<serde_json::Value> {
        let primaries = if self.primaries.is_unspecified() {
            None
        } else {
            match self.primaries {
                ColorPrimaries::BT709 => Some("bt709"),
                ColorPrimaries::BT470_SYSTEM_BG => Some("bt470bg"),
                ColorPrimaries::BT601_525 => Some("smpte170m"),
                ColorPrimaries::BT2020 => Some("bt2020"),
                ColorPrimaries::SMPTE_EG432 => Some("smpte432"),
                _ => return None,
            }
        };
        let transfer = if self.transfer.is_unspecified() {
            None
        } else {
            match self.transfer {
                TransferCharacteristics::BT709 => Some("bt709"),
                TransferCharacteristics::BT601 => Some("smpte170m"),
                TransferCharacteristics::IEC61966_2_1 => Some("iec61966-2-1"),
                TransferCharacteristics::LINEAR => Some("linear"),
                TransferCharacteristics::SMPTE_ST2084 => Some("pq"),
                TransferCharacteristics::ARIB_STD_B67 => Some("hlg"),
                _ => return None,
            }
        };
        let matrix = if self.matrix.is_unspecified() {
            None
        } else {
            match self.matrix {
                MatrixCoefficients::IDENTITY => Some("rgb"),
                MatrixCoefficients::BT709 => Some("bt709"),
                MatrixCoefficients::BT470_SYSTEM_BG => Some("bt470bg"),
                MatrixCoefficients::BT601_525 => Some("smpte170m"),
                MatrixCoefficients::BT2020_NCL => Some("bt2020-ncl"),
                _ => return None,
            }
        };
        if primaries.is_none() && transfer.is_none() && matrix.is_none() && !self.explicit_range {
            return None;
        }
        let mut obj = serde_json::Map::new();
        if let Some(p) = primaries {
            obj.insert("primaries".into(), json!(p));
        }
        if let Some(t) = transfer {
            obj.insert("transfer".into(), json!(t));
        }
        if let Some(m) = matrix {
            obj.insert("matrix".into(), json!(m));
        }
        if self.explicit_range {
            obj.insert("fullRange".into(), json!(self.full_range));
        }
        Some(serde_json::Value::Object(obj))
    }

    fn pixfmt_color_space(self) -> ColorSpace {
        match (self.matrix_id, self.full_range) {
            (2, true) => ColorSpace::Bt2020Full,
            (2, false) => ColorSpace::Bt2020Limited,
            (1, true) => ColorSpace::Bt601Full,
            (1, false) => ColorSpace::Bt601Limited,
            (_, true) => ColorSpace::Bt709Full,
            (_, false) => ColorSpace::Bt709Limited,
        }
    }

    pub(crate) fn exact_nclx(self) -> Option<(u8, u8, u8, bool)> {
        if self.primaries.is_unspecified()
            && self.transfer.is_unspecified()
            && self.matrix.is_unspecified()
            && !self.explicit_range
        {
            return None;
        }
        let p = if self.primaries.is_unspecified() { 2 } else { self.primaries.0 };
        let t = if self.transfer.is_unspecified() { 2 } else { self.transfer.0 };
        let m = if self.matrix.is_unspecified() { 2 } else { self.matrix.0 };
        Some((p, t, m, self.full_range))
    }
}

#[derive(Clone)]
struct ActiveVideoMeta {
    time_base: TimeBase,
    width: u32,
    height: u32,
    pixel_format: PixelFormat,
    frame_dur: f64,
    codec_kind: VideoCodecKind,
    h264_framing: NalFraming,
    color: ResolvedVideoColor,
}
#[derive(Clone)]
struct ActiveAudioMeta {
    time_base: TimeBase,
    params: CodecParameters,
}

// Stride-3 startcode scanner skips non-0/1 bytes 3x faster than naive byte-by-byte Annex-B loops.
fn split_annexb_nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let len = data.len();
    let mut i = 0usize;
    while i + 2 < len {
        let b2 = data[i + 2];
        if b2 > 1 {
            i += 3;
        } else if b2 == 1 && data[i] == 0 && data[i + 1] == 0 {
            starts.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (idx, &s) in starts.iter().enumerate() {
        let nal_start = s + 3;
        let mut nal_end = starts.get(idx + 1).copied().unwrap_or(len);
        while nal_end > nal_start && data[nal_end - 1] == 0 {
            nal_end -= 1;
        }
        if nal_end > nal_start {
            out.push(&data[nal_start..nal_end]);
        }
    }
    out
}

fn unescape_rbsp_prefix(nal: &[u8], max_out: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(max_out.min(nal.len()));
    let mut zeros = 0usize;
    for &b in nal {
        if out.len() >= max_out {
            break;
        }
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        out.push(b);
        if b == 0 {
            zeros += 1;
        } else {
            zeros = 0;
        }
    }
    out
}

fn keep_hevc_nal(nal: &[u8]) -> bool {
    if nal.len() < 2 {
        return false;
    }
    let nal_type = (nal[0] >> 1) & 0x3F;
    let layer_id = ((nal[0] & 1) << 5) | (nal[1] >> 3);
    layer_id == 0 && nal_type < 62
}

// Moves 4-byte H.264, HEVC, AV1, and VP9 packet buffers straight through with zero allocations.
fn to_fmp4_sample_bytes(mut data: Vec<u8>, framing: NalFraming, kind: VideoCodecKind) -> Vec<u8> {
    match framing {
        NalFraming::RawPassthrough => data,
        NalFraming::LengthPrefixed(4) if kind == VideoCodecKind::H264 => data,
        NalFraming::LengthPrefixed(4) if kind == VideoCodecKind::Hevc => {
            // Fast zero-alloc scan: 99.9% of 4K HEVC packets keep every NAL untouched.
            let mut pos = 0usize;
            let mut all_valid = true;
            while pos + 4 <= data.len() {
                let len = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
                if len == 0 || pos + 4 + len > data.len() {
                    all_valid = pos == data.len();
                    break;
                }
                if !keep_hevc_nal(&data[pos + 4..pos + 4 + len]) {
                    all_valid = false;
                    break;
                }
                pos += 4 + len;
            }
            if all_valid && pos == data.len() {
                return data;
            }
            // Compact in-place with zero heap allocations when non-base-layer/filler NALs appear.
            let mut rpos = 0usize;
            let mut wpos = 0usize;
            while rpos + 4 <= data.len() {
                let len = u32::from_be_bytes([data[rpos], data[rpos + 1], data[rpos + 2], data[rpos + 3]]) as usize;
                if len == 0 || rpos + 4 + len > data.len() {
                    break;
                }
                if keep_hevc_nal(&data[rpos + 4..rpos + 4 + len]) {
                    if wpos != rpos {
                        data.copy_within(rpos..rpos + 4 + len, wpos);
                    }
                    wpos += 4 + len;
                }
                rpos += 4 + len;
            }
            data.truncate(wpos);
            data
        }
        NalFraming::LengthPrefixed(w) => {
            let width = w as usize;
            let mut out = Vec::with_capacity(data.len() + 16);
            let mut pos = 0usize;
            while pos + width <= data.len() {
                let mut len = 0usize;
                for &b in &data[pos..pos + width] {
                    len = (len << 8) | (b as usize);
                }
                pos += width;
                if len == 0 || pos + len > data.len() {
                    break;
                }
                let nal = &data[pos..pos + len];
                pos += len;
                if kind == VideoCodecKind::Hevc && !keep_hevc_nal(nal) {
                    continue;
                }
                out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                out.extend_from_slice(nal);
            }
            out
        }
        NalFraming::AnnexB => {
            let mut out = Vec::with_capacity(data.len() + 16);
            for nal in split_annexb_nals(&data) {
                if kind == VideoCodecKind::Hevc && !keep_hevc_nal(nal) {
                    continue;
                }
                out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                out.extend_from_slice(nal);
            }
            out
        }
    }
}

// True when every VCL NAL in an H.264 packet has nal_ref_idc == 0 (disposable non-reference B-frame).
fn is_droppable_h264_nonref(data: &[u8], framing: NalFraming) -> bool {
    let mut saw_vcl = false;
    match framing {
        NalFraming::LengthPrefixed(w) if w >= 1 && w <= 4 => {
            let width = w as usize;
            let mut pos = 0usize;
            while pos + width < data.len() {
                let mut len = 0usize;
                for &b in &data[pos..pos + width] {
                    len = (len << 8) | (b as usize);
                }
                pos += width;
                if len == 0 || pos + len > data.len() {
                    return false;
                }
                let b0 = data[pos];
                pos += len;
                let nal_type = b0 & 0x1F;
                if (1..=5).contains(&nal_type) {
                    saw_vcl = true;
                    if nal_type == 5 || ((b0 >> 5) & 3) != 0 {
                        return false;
                    }
                }
            }
        }
        NalFraming::AnnexB => {
            for nal in split_annexb_nals(data) {
                let b0 = nal[0];
                let nal_type = b0 & 0x1F;
                if (1..=5).contains(&nal_type) {
                    saw_vcl = true;
                    if nal_type == 5 || ((b0 >> 5) & 3) != 0 {
                        return false;
                    }
                }
            }
        }
        _ => return false,
    }
    saw_vcl
}

// True when every VCL NAL in an HEVC packet is a spec-defined non-reference picture
// (even-numbered VCL NAL types 0..=14: TRAIL_N, TSA_N, STSA_N, RADL_N, RASL_N, RSV_VCL_N10..14).
fn is_droppable_hevc_nonref(data: &[u8], framing: NalFraming) -> bool {
    let mut saw_vcl = false;
    match framing {
        NalFraming::LengthPrefixed(w) if w >= 1 && w <= 4 => {
            let width = w as usize;
            let mut pos = 0usize;
            while pos + width < data.len() {
                let mut len = 0usize;
                for &b in &data[pos..pos + width] {
                    len = (len << 8) | (b as usize);
                }
                pos += width;
                if len < 2 || pos + len > data.len() {
                    return false;
                }
                let nal_type = (data[pos] >> 1) & 0x3F;
                pos += len;
                if nal_type < 32 {
                    saw_vcl = true;
                    if nal_type > 14 || (nal_type & 1) != 0 {
                        return false;
                    }
                }
            }
        }
        NalFraming::AnnexB => {
            for nal in split_annexb_nals(data) {
                if nal.len() < 2 {
                    continue;
                }
                let nal_type = (nal[0] >> 1) & 0x3F;
                if nal_type < 32 {
                    saw_vcl = true;
                    if nal_type > 14 || (nal_type & 1) != 0 {
                        return false;
                    }
                }
            }
        }
        _ => return false,
    }
    saw_vcl
}

fn read_leb128(buf: &[u8]) -> Option<(usize, usize)> {
    let mut val = 0usize;
    for (i, &b) in buf.iter().take(8).enumerate() {
        val |= ((b & 0x7F) as usize) << (i * 7);
        if (b & 0x80) == 0 {
            return Some((val, i + 1));
        }
    }
    None
}

// Extracts an AV1CodecConfigurationRecord from MP4/MKV extradata or raw in-band OBUs for hardware av01 MSE.
fn build_av1_config(stream: &StreamInfo, first_keyframe: Option<&[u8]>) -> Option<(Vec<u8>, String)> {
    let extra = &stream.params.extradata;
    let is_10bit = matches!(stream.params.pixel_format, Some(PixelFormat::Yuv420P10Le));
    if extra.len() >= 4 && (extra[0] & 0x80) != 0 && (extra[0] & 0x7F) == 1 {
        let profile = (extra[1] >> 5) & 0x07;
        let level = extra[1] & 0x1F;
        let tier = if (extra[2] & 0x80) != 0 { 'H' } else { 'M' };
        let high_bd = (extra[2] & 0x40) != 0;
        let twelve_bd = (extra[2] & 0x20) != 0;
        let bit_depth = if profile == 2 && high_bd && twelve_bd {
            12
        } else if high_bd || is_10bit {
            10
        } else {
            8
        };
        let codec_string = format!("av01.{profile}.{level:02}{tier}.{bit_depth:02}");
        return Some((extra.clone(), codec_string));
    }

    for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
        let mut pos = 0usize;
        while pos < src.len() {
            let hdr = src[pos];
            let obu_type = (hdr >> 3) & 0x0F;
            let has_ext = (hdr & 0x04) != 0;
            let has_size = (hdr & 0x02) != 0;
            let hdr_len = 1 + usize::from(has_ext);
            if pos + hdr_len > src.len() {
                break;
            }
            let (payload_len, size_bytes) = if has_size {
                let Some((sz, sb)) = read_leb128(&src[pos + hdr_len..]) else {
                    break;
                };
                (sz, sb)
            } else {
                (src.len() - (pos + hdr_len), 0)
            };
            let obu_total = hdr_len + size_bytes + payload_len;
            if pos + obu_total > src.len() {
                break;
            }
            if obu_type == 1 && payload_len >= 2 {
                let p = &src[pos + hdr_len + size_bytes..pos + obu_total];
                let profile = (p[0] >> 5) & 0x07;
                let reduced = (p[0] & 0x08) != 0;
                let level = if reduced { p[0] & 0x1F } else { ((p[0] & 0x07) << 2) | (p[1] >> 6) };
                let high_bd = is_10bit;
                let bit_depth = if high_bd { 10 } else { 8 };
                let flags = (u8::from(high_bd) << 6) | 0x0C; // 4:2:0 subsampling x=1,y=1
                let mut rec = Vec::with_capacity(4 + obu_total);
                rec.extend_from_slice(&[0x81, (profile << 5) | (level & 0x1F), flags, 0x00]);
                rec.extend_from_slice(&src[pos..pos + obu_total]);
                let codec_string = format!("av01.{profile}.{level:02}M.{bit_depth:02}");
                return Some((rec, codec_string));
            }
            pos += obu_total;
        }
    }
    None
}

// Synthesizes an ISO-BMFF vpcC v1 FullBox from VP9 keyframe header + pixel format so WebM/MKV VP9 hits hardware MSE.
fn build_vp9_config(stream: &StreamInfo, first_keyframe: Option<&[u8]>, w: u32, h: u32) -> (Vec<u8>, String) {
    let mut profile: u8 = if matches!(stream.params.pixel_format, Some(PixelFormat::Yuv420P10Le)) {
        2
    } else {
        0
    };
    let mut bit_depth: u8 = if profile >= 2 { 10 } else { 8 };
    if let Some(kf) = first_keyframe
        && kf.len() >= 5
        && (kf[0] >> 6) == 2
    {
        let p_low = (kf[0] >> 5) & 1;
        let p_high = (kf[0] >> 4) & 1;
        let parsed_prof = (p_high << 1) | p_low;
        profile = parsed_prof;
        if parsed_prof < 2 {
            bit_depth = 8;
        } else if bit_depth < 10 {
            bit_depth = 10;
        }
    }
    let pixels = (w as u64) * (h as u64);
    let level: u8 = if pixels <= 1280 * 720 {
        31
    } else if pixels <= 1920 * 1080 {
        41
    } else if pixels <= 2560 * 1440 {
        50
    } else {
        51
    };
    let color = resolve_video_color(&stream.params, first_keyframe, None, None);
    let (prim_iso, trc_iso, mat_iso, full_range) = color.exact_nclx().unwrap_or((1, 1, 1, false));
    let mut vpcc = Vec::with_capacity(12);
    vpcc.extend_from_slice(&[1, 0, 0, 0]); // FullBox version=1, flags=0
    vpcc.push(profile);
    vpcc.push(level);
    vpcc.push((bit_depth << 4) | 0x02 | u8::from(full_range));
    vpcc.extend_from_slice(&[prim_iso, trc_iso, mat_iso, 0, 0]);
    let codec_string = format!("vp09.{profile:02}.{level:02}.{bit_depth:02}");
    (vpcc, codec_string)
}

fn fill_color_from_sps(params: &CodecParameters, first_keyframe: Option<&[u8]>, sig: &mut ColorSignal) {
    let extra = &params.extradata;
    match params.codec_id.as_str() {
        "h264" => {
            let mut sps_nal: Option<&[u8]> = None;
            if extra.len() >= 8 && extra[0] == 1 && (extra[5] & 0x1F) > 0 {
                let sps_len = u16::from_be_bytes([extra[6], extra[7]]) as usize;
                if sps_len >= 2 && 8 + sps_len <= extra.len() {
                    sps_nal = Some(&extra[8..8 + sps_len]);
                }
            }
            if sps_nal.is_none() {
                for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
                    for nal in split_annexb_nals(src) {
                        if nal.len() >= 2 && (nal[0] & 0x1F) == 7 {
                            sps_nal = Some(nal);
                            break;
                        }
                    }
                    if sps_nal.is_some() {
                        break;
                    }
                }
            }
            if let Some(nal) = sps_nal {
                let rbsp = unescape_rbsp_prefix(&nal[1..], 512);
                if let Ok(sps) = oxideav_h264::sps::Sps::parse(&rbsp)
                    && let Some(vst) = sps.vui.as_ref().and_then(|v| v.video_signal_type.as_ref())
                {
                    if sig.range.is_unspecified() {
                        sig.range = if vst.video_full_range_flag {
                            ColorRange::Full
                        } else {
                            ColorRange::Limited
                        };
                    }
                    if let Some(cd) = &vst.colour_description {
                        if sig.primaries.is_unspecified() && cd.colour_primaries != 0 && cd.colour_primaries != 2 {
                            sig.primaries = ColorPrimaries(cd.colour_primaries);
                        }
                        if sig.transfer.is_unspecified() && cd.transfer_characteristics != 0 && cd.transfer_characteristics != 2 {
                            sig.transfer = TransferCharacteristics(cd.transfer_characteristics);
                        }
                        if sig.matrix.is_unspecified() && cd.matrix_coefficients != 0 && cd.matrix_coefficients != 2 {
                            sig.matrix = MatrixCoefficients(cd.matrix_coefficients);
                        }
                    }
                }
            }
        }
        "h265" | "hevc" => {
            let mut sps_nal: Option<&[u8]> = None;
            if extra.len() >= 23 && extra[0] == 1 {
                let num_arrays = extra[22] as usize;
                let mut pos = 23usize;
                'outer: for _ in 0..num_arrays {
                    if pos + 3 > extra.len() {
                        break;
                    }
                    let nal_type = extra[pos] & 0x3F;
                    let count = u16::from_be_bytes([extra[pos + 1], extra[pos + 2]]) as usize;
                    pos += 3;
                    for _ in 0..count {
                        if pos + 2 > extra.len() {
                            break 'outer;
                        }
                        let nlen = u16::from_be_bytes([extra[pos], extra[pos + 1]]) as usize;
                        pos += 2;
                        if pos + nlen > extra.len() {
                            break 'outer;
                        }
                        if nal_type == 33 && nlen >= 3 && sps_nal.is_none() {
                            sps_nal = Some(&extra[pos..pos + nlen]);
                        }
                        pos += nlen;
                    }
                }
            }
            if sps_nal.is_none() {
                for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
                    for nal in split_annexb_nals(src) {
                        if nal.len() >= 3 && ((nal[0] >> 1) & 0x3F) == 33 {
                            sps_nal = Some(nal);
                            break;
                        }
                    }
                    if sps_nal.is_some() {
                        break;
                    }
                }
            }
            if let Some(nal) = sps_nal {
                let rbsp = unescape_rbsp_prefix(&nal[2..], 512);
                if let Ok(sps) = oxideav_h265::sps::SeqParameterSet::parse(&rbsp)
                    && let Some(vst) = sps.vui_parameters.as_ref().and_then(|v| v.video_signal_type.as_ref())
                {
                    if sig.range.is_unspecified() {
                        sig.range = if vst.video_full_range_flag {
                            ColorRange::Full
                        } else {
                            ColorRange::Limited
                        };
                    }
                    if let Some(cd) = &vst.colour_description {
                        if sig.primaries.is_unspecified() && cd.colour_primaries != 0 && cd.colour_primaries != 2 {
                            sig.primaries = ColorPrimaries(cd.colour_primaries);
                        }
                        if sig.transfer.is_unspecified() && cd.transfer_characteristics != 0 && cd.transfer_characteristics != 2 {
                            sig.transfer = TransferCharacteristics(cd.transfer_characteristics);
                        }
                        if sig.matrix.is_unspecified() && cd.matrix_coeffs != 0 && cd.matrix_coeffs != 2 {
                            sig.matrix = MatrixCoefficients(cd.matrix_coeffs);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn resolve_video_color(
    params: &CodecParameters,
    first_keyframe: Option<&[u8]>,
    frame_sig: Option<ColorSignal>,
    fmt: Option<PixelFormat>,
) -> ResolvedVideoColor {
    let mut sig = params.color_signal;
    if let Some(fs) = frame_sig {
        if !fs.primaries.is_unspecified() {
            sig.primaries = fs.primaries;
        }
        if !fs.transfer.is_unspecified() {
            sig.transfer = fs.transfer;
        }
        if !fs.matrix.is_unspecified() {
            sig.matrix = fs.matrix;
        }
        if !fs.range.is_unspecified() {
            sig.range = fs.range;
        }
    }
    if sig.primaries.is_unspecified()
        || sig.transfer.is_unspecified()
        || sig.matrix.is_unspecified()
        || sig.range.is_unspecified()
    {
        fill_color_from_sps(params, first_keyframe, &mut sig);
    }
    let pix = fmt.or(params.pixel_format);
    let is_yuvj = matches!(
        pix,
        Some(PixelFormat::YuvJ420P | PixelFormat::YuvJ422P | PixelFormat::YuvJ444P)
    );
    let explicit_range = is_yuvj || !sig.range.is_unspecified();
    let full_range = is_yuvj
        || sig.range == ColorRange::Full
        || (sig.range.is_unspecified() && params.resolved_color_range() == ColorRange::Full);
    let w = params.width.unwrap_or(0);
    let h = params.height.unwrap_or(0);
    let is_sd = w > 0 && h > 0 && w < 1280 && h <= 576;
    let matrix_id = if matches!(
        sig.matrix,
        MatrixCoefficients::BT2020_NCL | MatrixCoefficients::BT2020_CL
    ) || (sig.matrix.is_unspecified() && sig.primaries == ColorPrimaries::BT2020)
    {
        2u8
    } else if matches!(
        sig.matrix,
        MatrixCoefficients::BT470_SYSTEM_BG
            | MatrixCoefficients::BT601_525
            | MatrixCoefficients::SMPTE_ST240
            | MatrixCoefficients::FCC
    ) || (sig.matrix.is_unspecified()
        && (matches!(
            sig.primaries,
            ColorPrimaries::BT470_SYSTEM_BG
                | ColorPrimaries::BT601_525
                | ColorPrimaries::SMPTE_ST240
                | ColorPrimaries::BT470_SYSTEM_M
        ) || (sig.primaries.is_unspecified() && is_sd)))
    {
        1u8
    } else {
        0u8
    };
    let wide_gamut = matches!(
        sig.primaries,
        ColorPrimaries::BT2020 | ColorPrimaries::SMPTE_EG432
    );
    ResolvedVideoColor {
        primaries: sig.primaries,
        transfer: sig.transfer,
        matrix: sig.matrix,
        full_range,
        explicit_range,
        matrix_id,
        wide_gamut,
    }
}

fn hevc_codec_string_from_ptl(ptl12: &[u8]) -> String {
    let space = match (ptl12[0] >> 6) & 3 {
        1 => "A",
        2 => "B",
        3 => "C",
        _ => "",
    };
    let tier = if (ptl12[0] & 0x20) != 0 { "H" } else { "L" };
    let profile = ptl12[0] & 0x1F;
    let compat = u32::from_be_bytes([ptl12[1], ptl12[2], ptl12[3], ptl12[4]]).reverse_bits();
    let level = ptl12[11];
    let mut constraints = &ptl12[5..11];
    while let Some((&0, rest)) = constraints.split_last() {
        constraints = rest;
    }
    let mut codec_string = format!("hvc1.{space}{profile}.{compat:x}.{tier}{level}");
    for &b in constraints {
        codec_string.push_str(&format!(".{b:X}"));
    }
    codec_string
}

fn probe_mse_video(stream: &StreamInfo, first_keyframe: Option<&[u8]>) -> Option<MseVideoConfig> {
    let params = &stream.params;
    let w = params.width.unwrap_or(0);
    let h = params.height.unwrap_or(0);
    if w == 0 || h == 0 {
        return None;
    }
    let fps = params
        .frame_rate
        .map(|r| if r.den > 0 { r.num as f64 / r.den as f64 } else { 0.0 })
        .filter(|&f| f > 1.0 && f < 240.0)
        .unwrap_or(24.0);
    let frame_ticks_90k = ((VIDEO_TIMESCALE as f64) / fps).round().max(1.0) as i64;
    let extra = &params.extradata;
    let colr_nclx = resolve_video_color(params, first_keyframe, None, None).exact_nclx();

    match params.codec_id.as_str() {
        "h264" => {
            if extra.len() >= 7 && extra[0] == 1 {
                let len_size = (extra[4] & 3) + 1;
                let mut rec = extra.clone();
                rec[4] |= 0x03;
                let codec_string = format!("avc1.{:02x}{:02x}{:02x}", extra[1], extra[2], extra[3]);
                Some(MseVideoConfig {
                    kind: VideoCodecKind::H264,
                    width: w,
                    height: h,
                    framing: NalFraming::LengthPrefixed(len_size),
                    container: MseContainer::Fmp4,
                    config_box_fourcc: *b"avcC",
                    sample_entry_fourcc: *b"avc1",
                    config_payload: rec,
                    codec_string,
                    frame_ticks_90k,
                    colr_nclx,
                })
            } else {
                let mut sps: Option<Vec<u8>> = None;
                let mut pps: Option<Vec<u8>> = None;
                for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
                    for nal in split_annexb_nals(src) {
                        match nal[0] & 0x1F {
                            7 if nal.len() >= 4 && sps.is_none() => sps = Some(nal.to_vec()),
                            8 if pps.is_none() => pps = Some(nal.to_vec()),
                            _ => {}
                        }
                    }
                }
                let (sps, pps) = (sps?, pps?);
                let codec_string = format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]);
                let mut rec = Vec::with_capacity(11 + sps.len() + pps.len());
                rec.extend_from_slice(&[1, sps[1], sps[2], sps[3], 0xFF, 0xE1]);
                rec.extend_from_slice(&(sps.len() as u16).to_be_bytes());
                rec.extend_from_slice(&sps);
                rec.push(1);
                rec.extend_from_slice(&(pps.len() as u16).to_be_bytes());
                rec.extend_from_slice(&pps);
                Some(MseVideoConfig {
                    kind: VideoCodecKind::H264,
                    width: w,
                    height: h,
                    framing: NalFraming::AnnexB,
                    container: MseContainer::Fmp4,
                    config_box_fourcc: *b"avcC",
                    sample_entry_fourcc: *b"avc1",
                    config_payload: rec,
                    codec_string,
                    frame_ticks_90k,
                    colr_nclx,
                })
            }
        }
        "h265" | "hevc" => {
            if extra.len() >= 23 && extra[0] == 1 {
                let len_size = (extra[21] & 3) + 1;
                let mut header_22 = extra[0..22].to_vec();
                header_22[21] |= 0x03;
                // Strip SEI (39/40) and Dolby Vision RPU/EL arrays from hvcC so VideoToolbox accepts 4K UHD remuxes.
                let num_arrays = extra[22] as usize;
                let mut pos = 23usize;
                let mut kept_arrays: Vec<(u8, Vec<Vec<u8>>)> = Vec::new();
                for _ in 0..num_arrays {
                    if pos + 3 > extra.len() {
                        break;
                    }
                    let nal_type = extra[pos] & 0x3F;
                    let count = u16::from_be_bytes([extra[pos + 1], extra[pos + 2]]) as usize;
                    pos += 3;
                    let mut nals = Vec::new();
                    for _ in 0..count {
                        if pos + 2 > extra.len() {
                            break;
                        }
                        let nlen = u16::from_be_bytes([extra[pos], extra[pos + 1]]) as usize;
                        pos += 2;
                        if pos + nlen > extra.len() {
                            break;
                        }
                        if matches!(nal_type, 32..=34) {
                            nals.push(extra[pos..pos + nlen].to_vec());
                        }
                        pos += nlen;
                    }
                    if !nals.is_empty() {
                        kept_arrays.push((nal_type, nals));
                    }
                }
                let mut rec = Vec::with_capacity(23 + 256);
                rec.extend_from_slice(&header_22);
                rec.push(kept_arrays.len() as u8);
                for (nal_type, nals) in &kept_arrays {
                    rec.push(0x80 | nal_type);
                    rec.extend_from_slice(&(nals.len() as u16).to_be_bytes());
                    for nal in nals {
                        rec.extend_from_slice(&(nal.len() as u16).to_be_bytes());
                        rec.extend_from_slice(nal);
                    }
                }
                let codec_string = hevc_codec_string_from_ptl(&extra[1..13]);
                Some(MseVideoConfig {
                    kind: VideoCodecKind::Hevc,
                    width: w,
                    height: h,
                    framing: NalFraming::LengthPrefixed(len_size),
                    container: MseContainer::Fmp4,
                    config_box_fourcc: *b"hvcC",
                    sample_entry_fourcc: *b"hvc1",
                    config_payload: rec,
                    codec_string,
                    frame_ticks_90k,
                    colr_nclx,
                })
            } else {
                // Annex-B HEVC (e.g. MPEG-TS): extract VPS (32), SPS (33), PPS (34) and synthesize hvcC.
                let mut vps: Option<Vec<u8>> = None;
                let mut sps: Option<Vec<u8>> = None;
                let mut pps: Option<Vec<u8>> = None;
                for src in [Some(extra.as_slice()), first_keyframe].into_iter().flatten() {
                    for nal in split_annexb_nals(src) {
                        if nal.len() < 2 {
                            continue;
                        }
                        match (nal[0] >> 1) & 0x3F {
                            32 if vps.is_none() => vps = Some(nal.to_vec()),
                            33 if sps.is_none() => sps = Some(nal.to_vec()),
                            34 if pps.is_none() => pps = Some(nal.to_vec()),
                            _ => {}
                        }
                    }
                }
                let (vps, sps, pps) = (vps?, sps?, pps?);
                let sps_rbsp = unescape_rbsp_prefix(&sps, 20);
                if sps_rbsp.len() < 15 {
                    return None;
                }
                let ptl12 = &sps_rbsp[3..15];
                let codec_string = hevc_codec_string_from_ptl(ptl12);
                let is_10bit = matches!(params.pixel_format, Some(PixelFormat::Yuv420P10Le));
                let bd_minus8 = if is_10bit { 2u8 } else { 0u8 };
                let mut rec = Vec::with_capacity(23 + vps.len() + sps.len() + pps.len() + 24);
                rec.push(1);
                rec.extend_from_slice(ptl12);
                rec.extend_from_slice(&[0xF0, 0x00, 0xFC, 0xFD, 0xF8 | bd_minus8, 0xF8 | bd_minus8, 0x00, 0x00, 0x03, 0x03]);
                for (nal_type, nal) in [(32u8, &vps), (33u8, &sps), (34u8, &pps)] {
                    rec.push(0x80 | nal_type);
                    rec.extend_from_slice(&1u16.to_be_bytes());
                    rec.extend_from_slice(&(nal.len() as u16).to_be_bytes());
                    rec.extend_from_slice(nal);
                }
                Some(MseVideoConfig {
                    kind: VideoCodecKind::Hevc,
                    width: w,
                    height: h,
                    framing: NalFraming::AnnexB,
                    container: MseContainer::Fmp4,
                    config_box_fourcc: *b"hvcC",
                    sample_entry_fourcc: *b"hvc1",
                    config_payload: rec,
                    codec_string,
                    frame_ticks_90k,
                    colr_nclx,
                })
            }
        }
        "av1" => {
            let (av1c, codec_string) = build_av1_config(stream, first_keyframe)?;
            Some(MseVideoConfig {
                kind: VideoCodecKind::Av1,
                width: w,
                height: h,
                framing: NalFraming::RawPassthrough,
                container: MseContainer::Fmp4,
                config_box_fourcc: *b"av1C",
                sample_entry_fourcc: *b"av01",
                config_payload: av1c,
                codec_string,
                frame_ticks_90k,
                colr_nclx,
            })
        }
        "vp9" => {
            if extra.is_empty() && first_keyframe.is_none() {
                return None;
            }
            let (vpcc, codec_string) = build_vp9_config(stream, first_keyframe, w, h);
            Some(MseVideoConfig {
                kind: VideoCodecKind::Vp9,
                width: w,
                height: h,
                framing: NalFraming::RawPassthrough,
                container: MseContainer::Fmp4,
                config_box_fourcc: *b"vpcC",
                sample_entry_fourcc: *b"vp09",
                config_payload: vpcc,
                codec_string,
                frame_ticks_90k,
                colr_nclx,
            })
        }
        // Browsers take VP8 through MSE only in WebM (Chromium refuses `vp08` in MP4), and the
        // page needs no secure context for MSE, unlike WebCodecs.
        "vp8" => Some(MseVideoConfig {
            kind: VideoCodecKind::Vp8,
            width: w,
            height: h,
            framing: NalFraming::RawPassthrough,
            container: MseContainer::WebM("V_VP8"),
            config_box_fourcc: [0; 4],
            sample_entry_fourcc: [0; 4],
            config_payload: Vec::new(),
            codec_string: "vp8".to_string(),
            frame_ticks_90k,
            colr_nclx: None,
        }),
        _ => None,
    }
}

fn wrap_box(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(fourcc);
    out.extend_from_slice(payload);
    out
}

fn build_fmp4_init(cfg: &MseVideoConfig) -> Vec<u8> {
    let mut ftyp_body = Vec::with_capacity(24);
    ftyp_body.extend_from_slice(b"iso6");
    ftyp_body.extend_from_slice(&1u32.to_be_bytes());
    ftyp_body.extend_from_slice(b"iso6cmfciso5mp41");
    let ftyp = wrap_box(b"ftyp", &ftyp_body);

    let mut mvhd = Vec::with_capacity(96);
    mvhd.extend_from_slice(&[0u8; 12]);
    mvhd.extend_from_slice(&1000u32.to_be_bytes());
    mvhd.extend_from_slice(&0u32.to_be_bytes());
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes());
    mvhd.extend_from_slice(&[0u8; 10]);
    for m in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        mvhd.extend_from_slice(&m.to_be_bytes());
    }
    mvhd.extend_from_slice(&[0u8; 24]);
    mvhd.extend_from_slice(&2u32.to_be_bytes());

    let mut tkhd = Vec::with_capacity(84);
    tkhd.extend_from_slice(&[0, 0, 0, 3]);
    tkhd.extend_from_slice(&[0u8; 8]);
    tkhd.extend_from_slice(&1u32.to_be_bytes());
    tkhd.extend_from_slice(&[0u8; 24]);
    for m in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        tkhd.extend_from_slice(&m.to_be_bytes());
    }
    tkhd.extend_from_slice(&(cfg.width << 16).to_be_bytes());
    tkhd.extend_from_slice(&(cfg.height << 16).to_be_bytes());

    let mut vse = Vec::with_capacity(86 + cfg.config_payload.len());
    vse.extend_from_slice(&[0u8; 6]);
    vse.extend_from_slice(&1u16.to_be_bytes());
    vse.extend_from_slice(&[0u8; 16]);
    vse.extend_from_slice(&(cfg.width as u16).to_be_bytes());
    vse.extend_from_slice(&(cfg.height as u16).to_be_bytes());
    vse.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    vse.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    vse.extend_from_slice(&0u32.to_be_bytes());
    vse.extend_from_slice(&1u16.to_be_bytes());
    vse.extend_from_slice(&[0u8; 32]);
    vse.extend_from_slice(&0x0018u16.to_be_bytes());
    vse.extend_from_slice(&0xFFFFu16.to_be_bytes());
    vse.extend_from_slice(&wrap_box(&cfg.config_box_fourcc, &cfg.config_payload));
    if let Some((prim, trc, mat, full)) = cfg.colr_nclx {
        let mut colr = Vec::with_capacity(11);
        colr.extend_from_slice(b"nclx");
        colr.extend_from_slice(&u16::from(prim).to_be_bytes());
        colr.extend_from_slice(&u16::from(trc).to_be_bytes());
        colr.extend_from_slice(&u16::from(mat).to_be_bytes());
        colr.push(if full { 0x80 } else { 0x00 });
        vse.extend_from_slice(&wrap_box(b"colr", &colr));
    }
    let sample_entry = wrap_box(&cfg.sample_entry_fourcc, &vse);

    let mut stsd_body = Vec::with_capacity(8 + sample_entry.len());
    stsd_body.extend_from_slice(&[0, 0, 0, 0]);
    stsd_body.extend_from_slice(&1u32.to_be_bytes());
    stsd_body.extend_from_slice(&sample_entry);
    let mut stbl_body = Vec::new();
    stbl_body.extend_from_slice(&wrap_box(b"stsd", &stsd_body));
    stbl_body.extend_from_slice(&wrap_box(b"stts", &[0u8; 8]));
    stbl_body.extend_from_slice(&wrap_box(b"stsc", &[0u8; 8]));
    stbl_body.extend_from_slice(&wrap_box(b"stsz", &[0u8; 12]));
    stbl_body.extend_from_slice(&wrap_box(b"stco", &[0u8; 8]));

    let url_box = wrap_box(b"url ", &[0, 0, 0, 1]);
    let mut dref_body = vec![0, 0, 0, 0, 0, 0, 0, 1];
    dref_body.extend_from_slice(&url_box);
    let mut minf_body = Vec::new();
    minf_body.extend_from_slice(&wrap_box(b"vmhd", &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]));
    minf_body.extend_from_slice(&wrap_box(b"dinf", &wrap_box(b"dref", &dref_body)));
    minf_body.extend_from_slice(&wrap_box(b"stbl", &stbl_body));

    let mut mdhd = Vec::with_capacity(24);
    mdhd.extend_from_slice(&[0u8; 12]);
    mdhd.extend_from_slice(&VIDEO_TIMESCALE.to_be_bytes());
    mdhd.extend_from_slice(&0u32.to_be_bytes());
    mdhd.extend_from_slice(&21956u16.to_be_bytes());
    mdhd.extend_from_slice(&0u16.to_be_bytes());

    let mut hdlr = Vec::with_capacity(37);
    hdlr.extend_from_slice(&[0u8; 8]);
    hdlr.extend_from_slice(b"vide");
    hdlr.extend_from_slice(&[0u8; 12]);
    hdlr.extend_from_slice(b"VideoHandler\0");

    let mut mdia_body = Vec::new();
    mdia_body.extend_from_slice(&wrap_box(b"mdhd", &mdhd));
    mdia_body.extend_from_slice(&wrap_box(b"hdlr", &hdlr));
    mdia_body.extend_from_slice(&wrap_box(b"minf", &minf_body));

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&wrap_box(b"tkhd", &tkhd));
    trak_body.extend_from_slice(&wrap_box(b"mdia", &mdia_body));

    let mut trex = Vec::with_capacity(24);
    trex.extend_from_slice(&[0, 0, 0, 0]);
    trex.extend_from_slice(&1u32.to_be_bytes());
    trex.extend_from_slice(&1u32.to_be_bytes());
    trex.extend_from_slice(&[0u8; 12]);

    let mut moov_body = Vec::new();
    moov_body.extend_from_slice(&wrap_box(b"mvhd", &mvhd));
    moov_body.extend_from_slice(&wrap_box(b"trak", &trak_body));
    moov_body.extend_from_slice(&wrap_box(b"mvex", &wrap_box(b"trex", &trex)));

    let moov = wrap_box(b"moov", &moov_body);
    let mut init = Vec::with_capacity(ftyp.len() + moov.len());
    init.extend_from_slice(&ftyp);
    init.extend_from_slice(&moov);
    init
}

struct GopPacket {
    pts_90k: i64,
    sync: bool,
    data_4byte: Vec<u8>,
}

fn build_fmp4_segment(
    seq: u32,
    gop: &[GopPacket],
    lookahead: &[GopPacket],
    frame_90k: i64,
    min_dts_90k: &mut i64,
) -> Option<(Vec<u8>, f64, f64)> {
    if gop.is_empty() {
        return None;
    }
    let mut sorted_pts: Vec<i64> = gop
        .iter()
        .chain(lookahead.iter())
        .map(|p| p.pts_90k.max(0))
        .collect();
    sorted_pts.sort_unstable();
    let mut dts = Vec::with_capacity(gop.len());
    let mut prev = *min_dts_90k - 1;
    for &p in &sorted_pts[..gop.len()] {
        let cur = p.max(prev + 1).max(0);
        dts.push(cur);
        prev = cur;
    }
    let last_dts = *dts.last().unwrap_or(&0);
    let end_dts = sorted_pts
        .get(gop.len())
        .copied()
        .filter(|&n| n > last_dts)
        .unwrap_or_else(|| last_dts + frame_90k.max(1));
    *min_dts_90k = end_dts;

    let base_decode_time = dts[0] as u64;
    let start_secs = (sorted_pts[0] as f64) / (VIDEO_TIMESCALE as f64);
    let end_secs = (end_dts as f64) / (VIDEO_TIMESCALE as f64);
    let moof_body_size = 16 + 64 + gop.len() * 16;
    let moof_size = 8 + moof_body_size;
    let payload_bytes: usize = gop.iter().map(|p| p.data_4byte.len()).sum();
    let mdat_size = 8 + payload_bytes;
    let data_offset = (moof_size + 8) as i32;

    let mut out = Vec::with_capacity(moof_size + mdat_size);
    out.extend_from_slice(&(moof_size as u32).to_be_bytes());
    out.extend_from_slice(b"moof");
    out.extend_from_slice(&16u32.to_be_bytes());
    out.extend_from_slice(b"mfhd");
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&seq.to_be_bytes());

    let traf_size = (64 + gop.len() * 16) as u32;
    out.extend_from_slice(&traf_size.to_be_bytes());
    out.extend_from_slice(b"traf");
    out.extend_from_slice(&16u32.to_be_bytes());
    out.extend_from_slice(b"tfhd");
    out.extend_from_slice(&[0, 0x02, 0x00, 0x00]);
    out.extend_from_slice(&1u32.to_be_bytes());

    out.extend_from_slice(&20u32.to_be_bytes());
    out.extend_from_slice(b"tfdt");
    out.extend_from_slice(&[1, 0, 0, 0]);
    out.extend_from_slice(&base_decode_time.to_be_bytes());

    let trun_size = (20 + gop.len() * 16) as u32;
    out.extend_from_slice(&trun_size.to_be_bytes());
    out.extend_from_slice(b"trun");
    out.extend_from_slice(&[1, 0x00, 0x0F, 0x01]);
    out.extend_from_slice(&(gop.len() as u32).to_be_bytes());
    out.extend_from_slice(&data_offset.to_be_bytes());

    for (i, pkt) in gop.iter().enumerate() {
        let next_d = dts.get(i + 1).copied().unwrap_or(end_dts);
        let dur = (next_d - dts[i]).clamp(1, i64::from(u32::MAX)) as u32;
        let cto = (pkt.pts_90k.max(0) - dts[i]).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let flags: u32 = if pkt.sync { 0x0200_0000 } else { 0x0101_0000 };
        out.extend_from_slice(&dur.to_be_bytes());
        out.extend_from_slice(&(pkt.data_4byte.len() as u32).to_be_bytes());
        out.extend_from_slice(&flags.to_be_bytes());
        out.extend_from_slice(&cto.to_be_bytes());
    }

    out.extend_from_slice(&(mdat_size as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for pkt in gop {
        out.extend_from_slice(&pkt.data_4byte);
    }
    Some((out, start_secs, end_secs))
}

fn ebml_id(out: &mut Vec<u8>, id: u32) {
    let bytes = id.to_be_bytes();
    let skip = bytes.iter().position(|&b| b != 0).unwrap_or(3);
    out.extend_from_slice(&bytes[skip..]);
}

/// The shortest EBML size; each width's all-ones value is reserved for "unknown size".
fn ebml_size(out: &mut Vec<u8>, size: u64) {
    let mut width = 1usize;
    while width < 8 && size >= (1u64 << (7 * width)) - 1 {
        width += 1;
    }
    let marked = size | (1u64 << (7 * width));
    out.extend_from_slice(&marked.to_be_bytes()[8 - width..]);
}

fn ebml_bytes(out: &mut Vec<u8>, id: u32, payload: &[u8]) {
    ebml_id(out, id);
    ebml_size(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

fn ebml_uint(out: &mut Vec<u8>, id: u32, value: u64) {
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().position(|&b| b != 0).unwrap_or(7);
    ebml_bytes(out, id, &bytes[skip..]);
}

/// EBML header, a Segment of unknown size (clusters follow in later appends), millisecond
/// timestamps and the one video track.
fn build_webm_init(cfg: &MseVideoConfig, codec_id: &str) -> Vec<u8> {
    let mut header = Vec::with_capacity(40);
    ebml_uint(&mut header, 0x4286, 1); // EBMLVersion
    ebml_uint(&mut header, 0x42F7, 1); // EBMLReadVersion
    ebml_uint(&mut header, 0x42F2, 4); // EBMLMaxIDLength
    ebml_uint(&mut header, 0x42F3, 8); // EBMLMaxSizeLength
    ebml_bytes(&mut header, 0x4282, b"webm"); // DocType
    ebml_uint(&mut header, 0x4287, 2); // DocTypeVersion
    ebml_uint(&mut header, 0x4285, 2); // DocTypeReadVersion

    let mut info = Vec::with_capacity(32);
    ebml_uint(&mut info, 0x2AD7B1, 1_000_000); // TimestampScale: 1 ms
    ebml_bytes(&mut info, 0x4D80, b"peartube"); // MuxingApp
    ebml_bytes(&mut info, 0x5741, b"peartube"); // WritingApp

    let mut video = Vec::with_capacity(12);
    ebml_uint(&mut video, 0xB0, u64::from(cfg.width)); // PixelWidth
    ebml_uint(&mut video, 0xBA, u64::from(cfg.height)); // PixelHeight
    let mut entry = Vec::with_capacity(48);
    ebml_uint(&mut entry, 0xD7, 1); // TrackNumber
    ebml_uint(&mut entry, 0x73C5, 1); // TrackUID
    ebml_uint(&mut entry, 0x83, 1); // TrackType: video
    ebml_uint(&mut entry, 0x9C, 0); // FlagLacing
    ebml_bytes(&mut entry, 0x86, codec_id.as_bytes()); // CodecID
    // No DefaultDuration: the frame rate is often a guess and VP8 may be variable-rate, and a
    // declared duration overrides the one the browser takes from the next block's timestamp.
    ebml_bytes(&mut entry, 0xE0, &video); // Video
    let mut tracks = Vec::with_capacity(entry.len() + 4);
    ebml_bytes(&mut tracks, 0xAE, &entry); // TrackEntry

    let mut out = Vec::with_capacity(160);
    ebml_bytes(&mut out, 0x1A45_DFA3, &header); // EBML
    ebml_id(&mut out, 0x1853_8067); // Segment
    out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    ebml_bytes(&mut out, 0x1549_A966, &info); // Info
    ebml_bytes(&mut out, 0x1654_AE6B, &tracks); // Tracks
    out
}

/// Writes the 8-byte size of the element whose size field starts at `size_at` and runs to the end.
fn close_webm_element(out: &mut [u8], size_at: usize) {
    let size = (out.len() - size_at - 8) as u64;
    out[size_at..size_at + 8].copy_from_slice(&(size | (1u64 << 56)).to_be_bytes());
}

/// Packets as SimpleBlocks in presentation order. A block holds its time as a signed 16-bit
/// millisecond offset from its Cluster, so a new Cluster starts whenever that would not fit.
fn build_webm_clusters(gop: &[GopPacket], lookahead: &[GopPacket], frame_90k: i64) -> Option<(Vec<u8>, f64, f64)> {
    let (first, last) = (gop.first()?, gop.last()?);
    let ticks_per_ms = i64::from(VIDEO_TIMESCALE / 1000);
    let payload_bytes: usize = gop.iter().map(|p| p.data_4byte.len() + 16).sum();
    let mut out = Vec::with_capacity(payload_bytes + 32);
    let mut cluster: Option<(usize, i64)> = None;
    for pkt in gop {
        let ms = pkt.pts_90k.max(0) / ticks_per_ms;
        let offset = match cluster {
            Some((_, base)) if (0..=i64::from(i16::MAX)).contains(&(ms - base)) => ms - base,
            _ => {
                if let Some((size_at, _)) = cluster {
                    close_webm_element(&mut out, size_at);
                }
                ebml_id(&mut out, 0x1F43_B675); // Cluster
                cluster = Some((out.len(), ms));
                out.extend_from_slice(&[0; 8]);
                ebml_uint(&mut out, 0xE7, ms as u64); // Timestamp
                0
            }
        };
        ebml_id(&mut out, 0xA3); // SimpleBlock
        ebml_size(&mut out, (4 + pkt.data_4byte.len()) as u64);
        out.push(0x81); // track 1
        out.extend_from_slice(&(offset as i16).to_be_bytes());
        out.push(if pkt.sync { 0x80 } else { 0 });
        out.extend_from_slice(&pkt.data_4byte);
    }
    if let Some((size_at, _)) = cluster {
        close_webm_element(&mut out, size_at);
    }
    let end_90k = lookahead
        .first()
        .map(|p| p.pts_90k)
        .filter(|&n| n > last.pts_90k)
        .unwrap_or(last.pts_90k + frame_90k.max(1));
    let secs = |ticks: i64| ticks.max(0) as f64 / f64::from(VIDEO_TIMESCALE);
    Some((out, secs(first.pts_90k), secs(end_90k)))
}

fn strip_ass_overrides(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_brace = false;
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '{' {
            in_brace = true;
            continue;
        }
        if ch == '}' {
            in_brace = false;
            continue;
        }
        if in_brace {
            continue;
        }
        if ch == '\\' {
            match chars.peek().copied() {
                Some('N' | 'n') => {
                    chars.next();
                    out.push('\n');
                    continue;
                }
                Some('h') => {
                    chars.next();
                    out.push(' ');
                    continue;
                }
                _ => {}
            }
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn collect_segments_text(items: &[Segment], out: &mut String, depth: u8) {
    if depth >= 32 {
        return;
    }
    for seg in items {
        match seg {
            Segment::Text(t) | Segment::Raw(t) => out.push_str(t),
            Segment::LineBreak => out.push('\n'),
            Segment::Timestamp { .. } => {}
            Segment::Bold(c) | Segment::Italic(c) | Segment::Underline(c) | Segment::Strike(c) => {
                collect_segments_text(c, out, depth + 1);
            }
            Segment::Color { children, .. }
            | Segment::Font { children, .. }
            | Segment::Karaoke { children, .. }
            | Segment::Voice { children, .. }
            | Segment::Class { children, .. } => collect_segments_text(children, out, depth + 1),
        }
    }
}

fn extract_visible_rgba(vf: &VideoFrame) -> Option<(i32, i32, u32, u32, u32, u32, Vec<u8>)> {
    let plane = vf.image_planes().first()?;
    let stride = plane.stride;
    if stride == 0 || stride % 4 != 0 {
        return None;
    }
    let width = stride / 4;
    let height = plane.data.len() / stride;
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return None;
    }
    let mut left = width;
    let mut right = 0usize;
    let mut top = height;
    let mut bottom = 0usize;
    for y in 0..height {
        let row = &plane.data[y * stride..y * stride + width * 4];
        let Some(first) = row.chunks_exact(4).position(|px| px[3] != 0) else {
            continue;
        };
        let last = row.chunks_exact(4).rposition(|px| px[3] != 0).unwrap_or(first);
        left = left.min(first);
        right = right.max(last + 1);
        top = top.min(y);
        bottom = y + 1;
    }
    if left >= right {
        return Some((0, 0, 0, 0, width as u32, height as u32, Vec::new()));
    }
    let cw = right - left;
    let ch = bottom - top;
    let mut rgba = Vec::with_capacity(cw * ch * 4);
    for y in top..bottom {
        let row = &plane.data[y * stride..y * stride + width * 4];
        rgba.extend_from_slice(&row[left * 4..right * 4]);
    }
    Some((
        left as i32,
        top as i32,
        cw as u32,
        ch as u32,
        width as u32,
        height as u32,
        rgba,
    ))
}

enum OutItem {
    MseInit(Vec<u8>),
    MseSegment { data: Vec<u8>, start: f64, end: f64, key_ms: u32 },
    VideoRgba { data: Vec<u8>, pts: f64, w: u32, h: u32 },
    VideoYuv420 { data: Vec<u8>, pts: f64, w: u32, h: u32, matrix_id: u8, full_range: bool },
    VideoPacket { data: Vec<u8>, pts: f64, dur: f64, keyframe: bool },
    AudioPlanarF32 { data: Vec<u8>, pts: f64, rate: u32, frames: u32 },
    SubText { text: Vec<u8>, start: f64, end: f64 },
    SubBitmap { rgba: Vec<u8>, start: f64, end: f64, x: i32, y: i32, w: u32, h: u32, cw: u32, ch: u32 },
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum VideoOutputMode {
    #[default]
    Software,
    Mse,
    WebCodecs,
}

struct WebSession {
    container: String,
    streaming_io: Arc<AtomicBool>,
    demuxer: Box<dyn Demuxer>,
    streams: Vec<StreamInfo>,
    mse_cfg: Option<MseVideoConfig>,
    peek_packets: VecDeque<Packet>,
    out_queue: VecDeque<OutItem>,
    frame_pool: Vec<Vec<u8>>,
    video_idx: Option<u32>,
    /// The stream seeks use: the file's first video stream, whether or not video is being decoded. Matroska Cues
    /// usually index only the video track, so a seek on the audio stream finds nothing and does not move.
    seek_idx: Option<u32>,
    audio_idx: Option<u32>,
    sub_idx: Option<u32>,
    video_mode: VideoOutputMode,
    video_meta: Option<ActiveVideoMeta>,
    audio_meta: Option<ActiveAudioMeta>,
    sub_meta: Option<(TimeBase, String)>,
    video_dec: Option<Box<dyn Decoder>>,
    audio_dec: Option<Box<dyn Decoder>>,
    sub_dec: Option<Box<dyn Decoder>>,
    audio_mix: Option<(ChannelLayout, StereoMix)>,
    audio_next_pts: Option<f64>,
    audio_left: Vec<f32>,
    audio_right: Vec<f32>,
    audio_accum_pts: Option<f64>,
    audio_accum_rate: u32,
    audio_first_flushed: bool,
    video_next_pts: f64,
    video_seeded: bool,
    drop_until_keyframe: bool,
    client_clock: f64,
    video_hidden: bool,
    replaying_hidden_gop: bool,
    hidden_gops: VecDeque<Vec<Packet>>,
    hidden_gop_bytes: usize,
    mse_gop: Vec<GopPacket>,
    mse_seq: u32,
    mse_min_dts: i64,
    mse_started: bool,
    seek_target: Option<f64>,
    audio_seek_target: Option<f64>,
    preseek_mlp_gop: Vec<Packet>,
    demux_eof: bool,
    flushed_eof: bool,
    controller: controller::PlayerController,
}

#[derive(Default)]
struct WasmState {
    session: Option<WebSession>,
    json_buf: Vec<u8>,
    out_buf: Vec<u8>,
    out_pts: f64,
    out_dur: f64,
    out_w: u32,
    out_h: u32,
    out_x: i32,
    out_y: i32,
    out_cw: u32,
    out_ch: u32,
    out_rate: u32,
    out_samples: u32,
}

thread_local! {
    static STATE: RefCell<WasmState> = RefCell::new(WasmState::default());
}

fn set_json_error(st: &mut WasmState, msg: &str) -> i32 {
    st.json_buf = json!({ "error": msg }).to_string().into_bytes();
    -1
}

fn make_subtitle_cue(cue: &SubtitleCue, pkt_start: f64, pkt_dur: Option<f64>) -> Option<OutItem> {
    let mut buf = String::with_capacity(64);
    collect_segments_text(&cue.segments, &mut buf, 0);
    let cleaned = strip_ass_overrides(&buf);
    if cleaned.is_empty() {
        return None;
    }
    let (start, end) = if cue.end_us > cue.start_us {
        (
            (cue.start_us.max(0) as f64) / 1_000_000.0,
            (cue.end_us.max(0) as f64) / 1_000_000.0,
        )
    } else {
        (pkt_start, pkt_start + pkt_dur.unwrap_or(4.0))
    };
    Some(OutItem::SubText {
        text: cleaned.into_bytes(),
        start,
        end,
    })
}

fn build_webcodecs_hint(
    vs: &StreamInfo,
    mse_cfg: Option<&MseVideoConfig>,
    color: ResolvedVideoColor,
) -> Option<serde_json::Value> {
    let w = vs.params.width.unwrap_or(0);
    let h = vs.params.height.unwrap_or(0);
    if w == 0 || h == 0 {
        return None;
    }
    let color_space = color.to_webcodecs_color_space();
    if vs.params.codec_id.as_str() == "vp8" {
        let mut hint = json!({ "codec": "vp8", "width": w, "height": h, "raw": true });
        if let Some(cs) = color_space {
            hint["colorSpace"] = cs;
        }
        return Some(hint);
    }
    let cfg = mse_cfg?;
    let desc_bytes: &[u8] = match cfg.kind {
        VideoCodecKind::H264 | VideoCodecKind::Hevc | VideoCodecKind::Av1 => &cfg.config_payload,
        VideoCodecKind::Vp9 => &[],
        _ => return None,
    };
    let mut hex = String::with_capacity(desc_bytes.len() * 2);
    for &b in desc_bytes {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    let mut hint = json!({
        "codec": cfg.codec_string,
        "width": cfg.width,
        "height": cfg.height,
        "descriptionHex": hex,
    });
    if let Some(cs) = color_space {
        hint["colorSpace"] = cs;
    }
    Some(hint)
}

impl WebSession {
    fn stream_info(&self, idx: u32) -> Option<&StreamInfo> {
        self.streams.iter().find(|s| s.index == idx)
    }

    fn take_pooled_buf(&mut self, cap: usize) -> Vec<u8> {
        if let Some(idx) = self.frame_pool.iter().position(|b| b.capacity() >= cap) {
            let mut v = self.frame_pool.swap_remove(idx);
            v.clear();
            return v;
        }
        if let Some(mut v) = self.frame_pool.pop() {
            v.clear();
            v.reserve(cap);
            return v;
        }
        Vec::with_capacity(cap)
    }

    fn recycle_buf(&mut self, mut buf: Vec<u8>) {
        if buf.capacity() >= 16 * 1024 && self.frame_pool.len() < 6 {
            buf.clear();
            self.frame_pool.push(buf);
        }
    }

    fn rebuild_decoders(&mut self) {
        let ctx = &*REGISTRY;
        self.video_dec = None;
        self.audio_dec = None;
        self.sub_dec = None;
        self.video_meta = None;
        self.audio_meta = None;
        self.sub_meta = None;
        self.audio_mix = None;
        self.audio_next_pts = None;
        self.audio_left.clear();
        self.audio_right.clear();
        self.audio_accum_pts = None;
        self.audio_accum_rate = 0;
        self.audio_first_flushed = false;
        self.preseek_mlp_gop.clear();
        self.video_next_pts = self.seek_target.unwrap_or(0.0);
        self.video_seeded = false;
        self.drop_until_keyframe = false;
        self.client_clock = self.seek_target.unwrap_or(0.0);
        self.replaying_hidden_gop = false;
        self.hidden_gops.clear();
        self.hidden_gop_bytes = 0;
        self.mse_gop.clear();
        self.mse_started = false;
        if let Some(vi) = self.video_idx
            && let Some(s) = self.stream_info(vi).cloned()
        {
            let tb = s.time_base;
            let frame_dur = s
                .params
                .frame_rate
                .filter(|r| r.num > 0 && r.den > 0)
                .map(|r| (r.den as f64) / (r.num as f64))
                .filter(|&d| d > 0.004 && d < 0.2)
                .or_else(|| tb.is_valid().then(|| tb.seconds_of(1)).filter(|&d| d > 0.004 && d < 0.2))
                .unwrap_or(1.0 / 24.0);
            let codec_kind = match s.params.codec_id.as_str() {
                "h264" => VideoCodecKind::H264,
                "h265" | "hevc" => VideoCodecKind::Hevc,
                "av1" => VideoCodecKind::Av1,
                "vp9" => VideoCodecKind::Vp9,
                "vp8" => VideoCodecKind::Vp8,
                _ => VideoCodecKind::Other,
            };
            let h264_framing = if s.params.extradata.len() >= 7 && s.params.extradata[0] == 1 {
                NalFraming::LengthPrefixed((s.params.extradata[4] & 3) + 1)
            } else {
                NalFraming::AnnexB
            };
            let color = resolve_video_color(&s.params, None, None, None);
            self.video_meta = Some(ActiveVideoMeta {
                time_base: tb,
                width: s.params.width.unwrap_or(0),
                height: s.params.height.unwrap_or(0),
                pixel_format: s.params.pixel_format.unwrap_or(PixelFormat::Yuv420P),
                frame_dur,
                codec_kind,
                h264_framing,
                color,
            });
            if self.video_mode == VideoOutputMode::Software {
                self.video_dec = ctx.codecs.first_decoder(&s.params).ok();
            }
        }
        if let Some(ai) = self.audio_idx
            && let Some(s) = self.stream_info(ai).cloned()
        {
            self.audio_dec = ctx.codecs.first_decoder(&s.params).ok();
            self.audio_meta = Some(ActiveAudioMeta {
                time_base: s.time_base,
                params: s.params,
            });
        }
        if let Some(si) = self.sub_idx
            && let Some(s) = self.stream_info(si).cloned()
        {
            // A subtitle stream usually carries no dimensions of its own, but a bitmap subtitle
            // (DVD/VobSub, PGS) is authored in the video's frame. Without the video size the
            // decoder paints onto a 720x576 default, and a rect that lives lower or further right
            // — Kung Fu Panda's at 758,709 on a 1920x816 frame — falls outside the canvas, so
            // every cue comes out empty. Hand the subtitle decoder the picture it belongs to.
            let mut params = s.params.clone();
            if let Some(vi) = self.video_idx
                && let Some(v) = self.stream_info(vi)
            {
                if let Some(w) = v.params.width.filter(|&w| w > 0) {
                    params.width = Some(w);
                }
                if let Some(h) = v.params.height.filter(|&h| h > 0) {
                    params.height = Some(h);
                }
            }
            self.sub_dec = ctx.codecs.first_decoder(&params).ok();
            self.sub_meta = Some((s.time_base, s.params.codec_id.as_str().to_string()));
        }
    }

    // Holds the current GOP's raw packets un-decoded while the tab is hidden, then replays them cleanly on return.
    fn set_hidden(&mut self, hidden: bool) {
        if self.video_hidden == hidden {
            return;
        }
        self.video_hidden = hidden;
        // AVI picture times need uninterrupted decode, even when there is nothing to draw.
        if self.container == "avi" {
            return;
        }
        if hidden {
            if self.video_mode == VideoOutputMode::Software {
                self.hidden_gops.clear();
                self.hidden_gop_bytes = 0;
            }
            return;
        }
        while self.hidden_gops.len() >= 2
            && self.hidden_gops[1]
                .first()
                .and_then(|p| self.pkt_secs(p))
                .is_some_and(|s| s <= self.client_clock + 0.02)
        {
            self.hidden_gops.pop_front();
        }
        let mut gop: Vec<Packet> = std::mem::take(&mut self.hidden_gops).into_iter().flatten().collect();
        self.hidden_gop_bytes = 0;
        if gop.is_empty() {
            if self.video_mode == VideoOutputMode::Software {
                self.drop_until_keyframe = true;
                self.video_seeded = false;
            }
            return;
        }
        if self.video_mode == VideoOutputMode::Software {
            if let Some(dec) = self.video_dec.as_mut() {
                let _ = dec.flush();
            }
            self.drop_until_keyframe = false;
            self.video_seeded = false;
            self.replaying_hidden_gop = true;
            for pkt in gop.drain(..) {
                self.handle_video_packet(pkt);
            }
            self.replaying_hidden_gop = false;
        } else if self.video_mode == VideoOutputMode::WebCodecs {
            self.mse_started = false;
            self.replaying_hidden_gop = true;
            for pkt in gop.drain(..) {
                self.handle_video_packet(pkt);
            }
            self.replaying_hidden_gop = false;
        }
    }

    fn pkt_secs(&self, pkt: &Packet) -> Option<f64> {
        let tb = self.video_meta.as_ref()?.time_base;
        pkt.pts.or(pkt.dts).filter(|_| tb.is_valid()).map(|t| tb.seconds_of(t).max(0.0))
    }

    fn stash_hidden_gop_packet(&mut self, pkt: Packet) {
        const MAX_HIDDEN_BYTES: usize = 48 * 1024 * 1024;
        if pkt.flags.keyframe {
            // Audio buffers up to 5 s ahead while hidden; on 1 s Blu-ray GOPs that spans several keyframes,
            // so keep every GOP from the active keyframe at client_clock forward and drop only spent ones.
            while self.hidden_gops.len() >= 2
                && self.hidden_gops[1]
                    .first()
                    .and_then(|p| self.pkt_secs(p))
                    .is_some_and(|s| s <= self.client_clock + 0.02)
            {
                if let Some(old) = self.hidden_gops.pop_front() {
                    let dropped: usize = old.iter().map(|p| p.data.len()).sum();
                    self.hidden_gop_bytes = self.hidden_gop_bytes.saturating_sub(dropped);
                }
            }
            if self.pkt_secs(&pkt).is_some_and(|s| s <= self.client_clock + 0.02) {
                self.hidden_gops.clear();
                self.hidden_gop_bytes = 0;
            }
            while self.hidden_gops.len() >= MAX_HIDDEN_GOPS
                || (self.hidden_gops.len() >= 2 && self.hidden_gop_bytes + pkt.data.len() > MAX_HIDDEN_BYTES)
            {
                if let Some(old) = self.hidden_gops.pop_front() {
                    let dropped: usize = old.iter().map(|p| p.data.len()).sum();
                    self.hidden_gop_bytes = self.hidden_gop_bytes.saturating_sub(dropped);
                }
            }
            self.hidden_gop_bytes += pkt.data.len();
            self.hidden_gops.push_back(vec![pkt]);
        } else if let Some(cur) = self.hidden_gops.back()
            && cur.len() < MAX_GOP_PKTS
            && self.hidden_gop_bytes + pkt.data.len() <= MAX_HIDDEN_BYTES
        {
            self.hidden_gop_bytes += pkt.data.len();
            if let Some(last) = self.hidden_gops.back_mut() {
                last.push(pkt);
            }
        } else {
            self.hidden_gops.clear();
            self.hidden_gop_bytes = 0;
            self.drop_until_keyframe = true;
            self.video_seeded = false;
        }
    }

    fn flush_audio_accum(&mut self) {
        let frames = self.audio_left.len().min(self.audio_right.len());
        if frames > 0
            && let Some(pts) = self.audio_accum_pts.take()
        {
            let byte_len = frames * 2 * 4;
            let mut out = self.take_pooled_buf(byte_len);
            ffi::pack_audio_f32(&mut out, &self.audio_left, &self.audio_right);
            self.audio_left.clear();
            self.audio_right.clear();
            let rate = self.audio_accum_rate;
            self.out_queue.push_back(OutItem::AudioPlanarF32 {
                data: out,
                pts,
                rate,
                frames: frames as u32,
            });
        } else {
            self.audio_left.clear();
            self.audio_right.clear();
        }
    }

    fn convert_and_push_video(&mut self, vf: &VideoFrame, pts: f64, w: u32, h: u32, fmt: PixelFormat) {
        if let Some(target) = self.seek_target {
            if pts + 0.025 < target {
                return;
            }
            self.seek_target = None;
        }
        if self.video_hidden || (self.client_clock > 0.25 && pts + 0.085 < self.client_clock) {
            return;
        }
        let wu = w as usize;
        let hu = h as usize;
        let cwu = (wu + 1) / 2;
        let chu = (hu + 1) / 2;
        let y_len = wu * hu;
        let c_len = cwu * chu;
        let total_yuv = y_len + c_len * 2;
        let frame_color = self
            .video_idx
            .and_then(|vi| self.stream_info(vi))
            .map(|s| resolve_video_color(&s.params, None, vf.color_signal(), Some(fmt)))
            .or_else(|| self.video_meta.as_ref().map(|vm| vm.color))
            .unwrap_or_default();
        let matrix_id = frame_color.matrix_id;
        let full_range = frame_color.full_range;

        if matches!(fmt, PixelFormat::Yuv420P | PixelFormat::YuvJ420P) && vf.planes.len() >= 3 {
            let mut packed = self.take_pooled_buf(total_yuv);
            if pack_plane_8(&vf.planes[0], wu, hu, &mut packed)
                && pack_plane_8(&vf.planes[1], cwu, chu, &mut packed)
                && pack_plane_8(&vf.planes[2], cwu, chu, &mut packed)
                && packed.len() == total_yuv
            {
                self.out_queue.push_back(OutItem::VideoYuv420 {
                    data: packed,
                    pts,
                    w,
                    h,
                    matrix_id,
                    full_range,
                });
                return;
            }
            self.recycle_buf(packed);
        } else if fmt == PixelFormat::Yuv420P10Le && vf.planes.len() >= 3 {
            let mut packed = self.take_pooled_buf(total_yuv);
            pack_plane_10_to_8(&vf.planes[0], wu, hu, &mut packed);
            pack_plane_10_to_8(&vf.planes[1], cwu, chu, &mut packed);
            pack_plane_10_to_8(&vf.planes[2], cwu, chu, &mut packed);
            if packed.len() == total_yuv {
                self.out_queue.push_back(OutItem::VideoYuv420 {
                    data: packed,
                    pts,
                    w,
                    h,
                    matrix_id,
                    full_range,
                });
                return;
            }
            self.recycle_buf(packed);
        } else if matches!(fmt, PixelFormat::Yuv422P | PixelFormat::YuvJ422P) && vf.planes.len() >= 3 {
            let mut packed = self.take_pooled_buf(total_yuv);
            if pack_plane_8(&vf.planes[0], wu, hu, &mut packed)
                && subsample_422_chroma(&vf.planes[1], cwu, hu, chu, &mut packed)
                && subsample_422_chroma(&vf.planes[2], cwu, hu, chu, &mut packed)
                && packed.len() == total_yuv
            {
                self.out_queue.push_back(OutItem::VideoYuv420 {
                    data: packed,
                    pts,
                    w,
                    h,
                    matrix_id,
                    full_range,
                });
                return;
            }
            self.recycle_buf(packed);
        } else if matches!(fmt, PixelFormat::Yuv444P | PixelFormat::YuvJ444P) && vf.planes.len() >= 3 {
            let mut packed = self.take_pooled_buf(total_yuv);
            if pack_plane_8(&vf.planes[0], wu, hu, &mut packed)
                && subsample_444_chroma(&vf.planes[1], wu, hu, cwu, chu, &mut packed)
                && subsample_444_chroma(&vf.planes[2], wu, hu, cwu, chu, &mut packed)
                && packed.len() == total_yuv
            {
                self.out_queue.push_back(OutItem::VideoYuv420 {
                    data: packed,
                    pts,
                    w,
                    h,
                    matrix_id,
                    full_range,
                });
                return;
            }
            self.recycle_buf(packed);
        }

        let info = FrameInfo::new(fmt, w, h);
        let opts = ConvertOptions {
            color_space: frame_color.pixfmt_color_space(),
            ..Default::default()
        };
        let converted = oxideav_pixfmt::convert(vf, info, PixelFormat::Rgba, &opts);
        if let Ok(rgba_frame) = converted
            && let Some(plane) = rgba_frame.planes.first()
        {
            let row_bytes = wu * 4;
            let mut tight = self.take_pooled_buf(row_bytes * hu);
            if pack_plane_8(plane, row_bytes, hu, &mut tight) && tight.len() == row_bytes * hu {
                self.out_queue.push_back(OutItem::VideoRgba { data: tight, pts, w, h });
            } else {
                self.recycle_buf(tight);
            }
        }
    }

    fn handle_video_packet(&mut self, pkt: Packet) {
        let Some(vm) = self.video_meta.clone() else { return };
        let tb = vm.time_base;

        if self.video_mode == VideoOutputMode::Mse {
            let Some((framing, kind)) = self.mse_cfg.as_ref().map(|c| (c.framing, c.kind))
            else {
                return;
            };
            let raw_ticks = pkt.pts.or(pkt.dts).unwrap_or(0);
            let pts_secs = if tb.is_valid() { tb.seconds_of(raw_ticks).max(0.0) } else { 0.0 };
            let pts_90k = (pts_secs * f64::from(VIDEO_TIMESCALE)).round() as i64;
            let is_sync = pkt.flags.keyframe;

            if !self.mse_started {
                if !is_sync {
                    return;
                }
                self.mse_started = true;
                self.mse_min_dts = pts_90k;
            }
            let data_4byte = to_fmp4_sample_bytes(pkt.data, framing, kind);
            if !data_4byte.is_empty() {
                self.mse_gop.push(GopPacket {
                    pts_90k,
                    sync: is_sync,
                    data_4byte,
                });
            }
            let (min_emit, lookahead) = if self.mse_seq == 0 { (8usize, 8usize) } else { (16usize, 8usize) };
            if self.mse_gop.len() >= min_emit + lookahead {
                let max_k = self.mse_gop.len() - lookahead;
                let mut cut = (min_emit..=max_k).find(|&k| {
                    let max_before = self.mse_gop[..k].iter().map(|p| p.pts_90k).max().unwrap_or(0);
                    let min_after = self.mse_gop[k..].iter().map(|p| p.pts_90k).min().unwrap_or(i64::MAX);
                    max_before < min_after
                });
                if cut.is_none() && self.mse_gop.len() >= 64 {
                    cut = Some(min_emit);
                }
                if let Some(emit_n) = cut {
                    let chunk: Vec<GopPacket> = self.mse_gop.drain(..emit_n).collect();
                    let key_ms = chunk
                        .iter()
                        .filter(|p| p.sync)
                        .map(|p| ((p.pts_90k.max(0) as f64) / 90.0).round() as u32)
                        .min()
                        .unwrap_or(u32::MAX);
                    self.mse_seq = self.mse_seq.wrapping_add(1);
                    if let Some(cfg) = self.mse_cfg.as_ref()
                        && let Some((seg, start, end)) =
                            cfg.media_segment(self.mse_seq, &chunk, &self.mse_gop, &mut self.mse_min_dts)
                    {
                        self.out_queue.push_back(OutItem::MseSegment { data: seg, start, end, key_ms });
                    }
                }
            }
            return;
        }

        if self.video_mode == VideoOutputMode::WebCodecs && !self.replaying_hidden_gop {
            self.stash_hidden_gop_packet(pkt.clone());
        }
        if self.video_hidden && self.container != "avi" {
            if self.video_mode != VideoOutputMode::WebCodecs {
                self.stash_hidden_gop_packet(pkt);
            }
            return;
        }

        if self.video_mode == VideoOutputMode::WebCodecs {
            let raw_ticks = pkt.pts.or(pkt.dts).unwrap_or(0);
            let pts_secs = if tb.is_valid() { tb.seconds_of(raw_ticks).max(0.0) } else { self.video_next_pts };
            let is_sync = pkt.flags.keyframe;
            if !self.mse_started {
                if !is_sync {
                    return;
                }
                self.mse_started = true;
            }
            self.video_next_pts = pts_secs + vm.frame_dur;
            let payload = if let Some(cfg) = self.mse_cfg.as_ref() {
                to_fmp4_sample_bytes(pkt.data, cfg.framing, cfg.kind)
            } else {
                pkt.data
            };
            if !payload.is_empty() {
                self.out_queue.push_back(OutItem::VideoPacket {
                    data: payload,
                    pts: pts_secs,
                    dur: vm.frame_dur,
                    keyframe: is_sync,
                });
            }
            return;
        }

        let mut pkt_pts_secs = pkt
            .pts
            .or(pkt.dts)
            .filter(|_| tb.is_valid())
            .map(|t| tb.seconds_of(t).max(0.0));

        // Pre-decode recovery: skip whole GOPs on >1.5s starvation, or skip disposable non-reference H.264 B-frames before decoding.
        if self.drop_until_keyframe {
            if !pkt.flags.keyframe {
                return;
            }
            self.drop_until_keyframe = false;
            self.video_seeded = false;
            if let Some(dec) = self.video_dec.as_mut() {
                let _ = dec.flush();
            }
        } else if let Some(est) = pkt_pts_secs {
            // AVI picture times rely on uninterrupted decode; dropping a GOP labels later pictures with earlier times.
            if self.container != "avi" && !self.replaying_hidden_gop && self.client_clock > 0.5 && est + 1.50 < self.client_clock && !pkt.flags.keyframe {
                self.drop_until_keyframe = true;
                return;
            }
            let drop_b = (self.client_clock > 0.25 && est + 0.090 < self.client_clock)
                || self.seek_target.is_some_and(|t| est + 0.040 < t);
            if drop_b
                && !pkt.flags.keyframe
                && ((vm.codec_kind == VideoCodecKind::H264
                    && is_droppable_h264_nonref(&pkt.data, vm.h264_framing))
                    || (vm.codec_kind == VideoCodecKind::Hevc
                        && is_droppable_hevc_nonref(&pkt.data, vm.h264_framing)))
            {
                return;
            }
        }

        let mut decoded_frames = Vec::new();
        let is_avi = self.container == "avi";
        if let Some(dec) = self.video_dec.as_mut() {
            if dec.send_packet(&pkt).is_err() {
                return;
            }
            loop {
                let vf = match dec.receive_frame() {
                    Ok(Frame::Video(vf)) => vf,
                    Ok(_) => continue,
                    _ => break,
                };
                let (w, h) = dec.output_video_dimensions().unwrap_or((vm.width, vm.height));
                let fmt = dec.output_pixel_format().unwrap_or(vm.pixel_format);
                if w == 0 || h == 0 || w > 8192 || h > 8192 {
                    continue;
                }
                let seed_pkt = pkt_pts_secs.take();
                let vf_pts = vf
                    .pts
                    .filter(|_| tb.is_valid())
                    .map(|t| tb.seconds_of(t).max(0.0));
                if !self.video_seeded {
                    self.video_next_pts = vf_pts.or(seed_pkt).unwrap_or_else(|| self.seek_target.unwrap_or(0.0));
                    self.video_seeded = true;
                }
                let pts_secs = if is_avi {
                    match seed_pkt {
                        Some(p) if p + 0.005 >= self.video_next_pts && p <= self.video_next_pts + 0.25 => p,
                        _ => self.video_next_pts,
                    }
                } else {
                    vf_pts
                        .filter(|&s| (s - self.video_next_pts).abs() < 2.0)
                        .or_else(|| seed_pkt.filter(|&s| (s - self.video_next_pts).abs() < 0.5))
                        .unwrap_or(self.video_next_pts)
                };
                self.video_next_pts = pts_secs + vm.frame_dur;
                decoded_frames.push((vf, pts_secs, w, h, fmt));
            }
        }
        for (vf, pts, w, h, fmt) in decoded_frames {
            self.convert_and_push_video(&vf, pts, w, h, fmt);
        }
    }

    fn handle_audio_packet(&mut self, pkt: Packet) {
        if let Some(target) = self.audio_seek_target
            && let Some((tb, is_mlp_family)) = self.audio_meta.as_ref().map(|am| {
                (
                    am.time_base,
                    matches!(am.params.codec_id.as_str(), "truehd" | "mlp"),
                )
            })
        {
            let pkt_secs = pkt
                .pts
                .or(pkt.dts)
                .filter(|_| tb.is_valid())
                .map(|t| tb.seconds_of(t).max(0.0));
            if is_mlp_family {
                if let Some(ps) = pkt_secs
                    && ps + 0.005 < target
                    && self.preseek_mlp_gop.len() < 160
                {
                    let d = &pkt.data;
                    if d.len() >= 32
                        && (u32::from_be_bytes([d[4], d[5], d[6], d[7]]) & 0xffff_fffe)
                            == 0xf872_6fba
                    {
                        self.preseek_mlp_gop.clear();
                    }
                    self.preseek_mlp_gop.push(pkt);
                    return;
                }
                self.audio_seek_target = None;
                let gop = std::mem::take(&mut self.preseek_mlp_gop);
                for g in gop {
                    self.decode_one_audio_packet(g);
                }
            } else if let Some(ps) = pkt_secs {
                // Keep ~80 ms of pre-roll packets before `target` so stateful MDCT codecs
                // (AC-3, E-AC-3, AAC, Opus, Vorbis, DTS) warm their overlap window cleanly.
                if ps + 0.080 < target {
                    return;
                }
                self.audio_seek_target = None;
            }
        }
        self.decode_one_audio_packet(pkt);
    }

    fn decode_one_audio_packet(&mut self, pkt: Packet) {
        let Some(dec) = self.audio_dec.as_mut() else { return };
        let Some(am) = self.audio_meta.as_ref() else { return };
        let tb = am.time_base;
        let mut pkt_pts = pkt.pts.or(pkt.dts);
        if dec.send_packet(&pkt).is_err() {
            return;
        }
        let mut raw_frames = Vec::new();
        loop {
            match dec.receive_frame() {
                Ok(Frame::Audio(af)) => {
                    if af.samples > 0 {
                        let out_fmt = dec.output_audio_format();
                        raw_frames.push((af, out_fmt));
                    }
                }
                Ok(_) => continue,
                _ => break,
            }
        }
        for (af, out_fmt) in raw_frames {
            let Some(am) = self.audio_meta.as_ref() else { break };
            let af_layout = audio_trim::frame_layout(out_fmt, &am.params, &af);
            let format = af_layout.sample_format;
            let rate = af_layout.sample_rate.max(8000);
            let channels = (af_layout.channels as usize).clamp(1, 64);
            let frames = af.samples as usize;

            let pkt_secs = af
                .pts
                .or(pkt_pts.take())
                .filter(|_| tb.is_valid())
                .map(|t| tb.seconds_of(t).max(0.0));
            let pts_secs = match (self.audio_next_pts, pkt_secs) {
                (None, Some(s)) => s,
                (None, None) => self.seek_target.unwrap_or(0.0),
                (Some(next), Some(s)) if (s - next).abs() > 0.040 && (s - next).abs() < 30.0 => s,
                (Some(next), _) => next,
            };
            self.audio_next_pts = Some(pts_secs + (frames as f64) / f64::from(rate));
            if let Some(target) = self.seek_target
                && pts_secs + (frames as f64) / f64::from(rate) < target - 0.02
            {
                continue;
            }
            if self.video_mode != VideoOutputMode::Software {
                self.seek_target = None;
            }
            let chan_layout = am
                .params
                .resolved_layout()
                .filter(|l| usize::from(l.channel_count()) == channels)
                .unwrap_or_else(|| ChannelLayout::from_count(channels as u16));

            if !self.audio_left.is_empty() && self.audio_accum_rate != rate {
                self.flush_audio_accum();
            }
            if self.audio_accum_pts.is_none() {
                self.audio_accum_pts = Some(pts_secs);
                self.audio_accum_rate = rate;
            }
            if self.audio_mix.as_ref().is_none_or(|(prev, _)| *prev != chan_layout) {
                self.audio_mix = Some((chan_layout, StereoMix::new(chan_layout)));
            }
            let (_, mixer) = self.audio_mix.as_ref().unwrap();
            mixer.append_frame_planar(&af, format, &mut self.audio_left, &mut self.audio_right);

            let flush_thresh = if self.audio_first_flushed { 4096 } else { 1024 };
            if self.audio_left.len() >= flush_thresh {
                self.audio_first_flushed = true;
                self.flush_audio_accum();
            }
        }
    }

    fn handle_sub_packet(&mut self, pkt: Packet) {
        let Some((tb, ref codec_id_owned)) = self.sub_meta else { return };
        let codec_id = codec_id_owned.clone();
        let pkt_start = pkt
            .pts
            .or(pkt.dts)
            .map(|t| if tb.is_valid() { tb.seconds_of(t).max(0.0) } else { 0.0 })
            .unwrap_or(0.0);
        let pkt_dur = pkt
            .duration
            .filter(|&d| d > 0)
            .map(|d| if tb.is_valid() { tb.seconds_of(d).max(0.0) } else { 0.0 });

        if matches!(codec_id.as_str(), "ass" | "ssa")
            && let Ok(raw) = std::str::from_utf8(&pkt.data)
        {
            let text_part = if raw.starts_with("Dialogue:") {
                raw.splitn(10, ',').nth(9).unwrap_or(raw)
            } else {
                raw.splitn(9, ',').nth(8).unwrap_or(raw)
            };
            let cleaned = strip_ass_overrides(text_part);
            if !cleaned.is_empty() {
                let end = pkt_start + pkt_dur.unwrap_or(4.0);
                self.out_queue.push_back(OutItem::SubText {
                    text: cleaned.into_bytes(),
                    start: pkt_start,
                    end,
                });
                return;
            }
        }

        let mut sub_items = Vec::new();
        if let Some(dec) = self.sub_dec.as_mut() {
            if dec.send_packet(&pkt).is_err() {
                return;
            }
            loop {
                match dec.receive_frame() {
                    Ok(Frame::Subtitle(cue)) => {
                        if let Some(item) = make_subtitle_cue(&cue, pkt_start, pkt_dur) {
                            sub_items.push(item);
                        }
                    }
                    Ok(Frame::Video(vf)) => {
                        let dur = vf
                            .display_duration()
                            .map(|d| d.as_secs_f64())
                            .or(pkt_dur)
                            .unwrap_or(5.0);
                        if let Some((x, y, w, h, cw, ch, rgba)) = extract_visible_rgba(&vf) {
                            sub_items.push(OutItem::SubBitmap {
                                rgba,
                                start: pkt_start,
                                end: pkt_start + dur,
                                x,
                                y,
                                w,
                                h,
                                cw,
                                ch,
                            });
                        }
                    }
                    Ok(_) => continue,
                    _ => break,
                }
            }
        }
        self.out_queue.extend(sub_items);
    }

    fn flush_eof(&mut self) {
        if self.flushed_eof {
            return;
        }
        self.flushed_eof = true;
        self.flush_audio_accum();
        if self.video_mode == VideoOutputMode::Mse {
            if !self.mse_gop.is_empty()
                && let Some(cfg) = self.mse_cfg.as_ref()
            {
                self.mse_seq = self.mse_seq.wrapping_add(1);
                let gop = std::mem::take(&mut self.mse_gop);
                let key_ms = gop
                    .iter()
                    .filter(|p| p.sync)
                    .map(|p| ((p.pts_90k.max(0) as f64) / 90.0).round() as u32)
                    .min()
                    .unwrap_or(u32::MAX);
                if let Some((seg, start, end)) = cfg.media_segment(self.mse_seq, &gop, &[], &mut self.mse_min_dts) {
                    self.out_queue.push_back(OutItem::MseSegment { data: seg, start, end, key_ms });
                }
            }
        } else if self.video_mode == VideoOutputMode::Software {
            let vm = self.video_meta.clone();
            let mut tail_frames = Vec::new();
            if let (Some(dec), Some(vm)) = (self.video_dec.as_mut(), vm) {
                let _ = dec.flush();
                loop {
                    let Ok(Frame::Video(vf)) = dec.receive_frame() else {
                        break;
                    };
                    let (w, h) = dec.output_video_dimensions().unwrap_or((vm.width, vm.height));
                    let fmt = dec.output_pixel_format().unwrap_or(vm.pixel_format);
                    let pts = self.video_next_pts;
                    self.video_next_pts = pts + vm.frame_dur;
                    tail_frames.push((vf, pts, w, h, fmt));
                }
            }
            for (vf, pts, w, h, fmt) in tail_frames {
                self.convert_and_push_video(&vf, pts, w, h, fmt);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_params(
        primaries: ColorPrimaries,
        transfer: TransferCharacteristics,
        matrix: MatrixCoefficients,
        range: ColorRange,
    ) -> CodecParameters {
        let mut p = CodecParameters::video("hevc".into());
        p.width = Some(1920);
        p.height = Some(1080);
        p.color_signal.primaries = primaries;
        p.color_signal.transfer = transfer;
        p.color_signal.matrix = matrix;
        p.color_signal.range = range;
        p
    }

    #[test]
    fn webcodecs_color_space_emits_only_exact_mappings() {
        let bt709 = resolve_video_color(
            &make_params(
                ColorPrimaries::BT709,
                TransferCharacteristics::BT709,
                MatrixCoefficients::BT709,
                ColorRange::Limited,
            ),
            None,
            None,
            None,
        );
        assert_eq!(
            bt709.to_webcodecs_color_space(),
            Some(json!({
                "primaries": "bt709",
                "transfer": "bt709",
                "matrix": "bt709",
                "fullRange": false,
            }))
        );

        let p3 = resolve_video_color(
            &make_params(
                ColorPrimaries::SMPTE_EG432,
                TransferCharacteristics::SMPTE_ST2084,
                MatrixCoefficients::BT2020_NCL,
                ColorRange::Limited,
            ),
            None,
            None,
            None,
        );
        assert!(p3.wide_gamut);
        assert_eq!(
            p3.to_webcodecs_color_space(),
            Some(json!({
                "primaries": "smpte432",
                "transfer": "pq",
                "matrix": "bt2020-ncl",
                "fullRange": false,
            }))
        );

        // Non-representable standards must return None so WebCodecs keeps in-band bitstream VUI.
        for bad in [
            make_params(
                ColorPrimaries::BT2020,
                TransferCharacteristics::SMPTE_ST2084,
                MatrixCoefficients::BT2020_CL,
                ColorRange::Limited,
            ),
            make_params(
                ColorPrimaries(11), // DCI-P3 theater white point != Display-P3 (12)
                TransferCharacteristics::BT709,
                MatrixCoefficients::BT709,
                ColorRange::Limited,
            ),
            make_params(
                ColorPrimaries::SMPTE_ST240,
                TransferCharacteristics::SMPTE_ST240,
                MatrixCoefficients::SMPTE_ST240,
                ColorRange::Limited,
            ),
            make_params(
                ColorPrimaries::BT601_525,
                TransferCharacteristics::BT601,
                MatrixCoefficients::FCC,
                ColorRange::Limited,
            ),
        ] {
            let resolved = resolve_video_color(&bad, None, None, None);
            assert_eq!(resolved.to_webcodecs_color_space(), None);
        }
        // DCI-P3 (11) must not claim Display-P3 wideGamut.
        let dci_p3 = resolve_video_color(
            &make_params(
                ColorPrimaries(11),
                TransferCharacteristics::BT709,
                MatrixCoefficients::BT709,
                ColorRange::Limited,
            ),
            None,
            None,
            None,
        );
        assert!(!dci_p3.wide_gamut);
        assert_eq!(dci_p3.to_manifest_json()["primaries"], "other");
        // Untagged streams must not invent nclx tags, and partially tagged streams keep H.273 2 (Unspecified).
        let untagged = resolve_video_color(
            &make_params(
                ColorPrimaries::UNSPECIFIED,
                TransferCharacteristics::UNSPECIFIED,
                MatrixCoefficients::UNSPECIFIED,
                ColorRange::Unspecified,
            ),
            None,
            None,
            None,
        );
        assert_eq!(untagged.exact_nclx(), None);
        let partial = resolve_video_color(
            &make_params(
                ColorPrimaries::BT2020,
                TransferCharacteristics::SMPTE_ST2084,
                MatrixCoefficients::UNSPECIFIED,
                ColorRange::Unspecified,
            ),
            None,
            None,
            None,
        );
        assert_eq!(partial.exact_nclx(), Some((9, 16, 2, false)));
        let mut cfg = MseVideoConfig {
            kind: VideoCodecKind::H264,
            width: 1920,
            height: 1080,
            framing: NalFraming::LengthPrefixed(4),
            container: MseContainer::Fmp4,
            config_box_fourcc: *b"avcC",
            sample_entry_fourcc: *b"avc1",
            config_payload: vec![1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80],
            codec_string: "avc1.640028".to_string(),
            frame_ticks_90k: 3750,
            colr_nclx: untagged.exact_nclx(),
        };
        let init_untagged = build_fmp4_init(&cfg);
        assert!(!init_untagged.windows(4).any(|w| w == b"colr"), "untagged stream must omit colr box");
        cfg.colr_nclx = partial.exact_nclx();
        let init_tagged = build_fmp4_init(&cfg);
        assert!(init_tagged.windows(15).any(|w| w == b"colrnclx\x00\x09\x00\x10\x00\x02\x00"), "tagged stream writes exact colr/nclx box with 2 for unspecified");
    }
}

