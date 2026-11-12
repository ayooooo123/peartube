//! The wasm boundary: the only place this crate touches an extern host call, the global allocator,
//! a Worker-owned raw pointer, or the SIMD128 unaligned loads. Every other module is safe Rust and
//! the crate root denies `unsafe_code`, so the engine cannot grow a new unsafe hole without this file.
#![allow(unsafe_code)]

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

// O(1) bitmapped TLSF allocator keeps per-frame VideoPlane/deblock churn off dlmalloc's slow linear lists.
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: talc::TalckWasm = unsafe { talc::TalckWasm::new_global() };

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_stream_len() -> u64;
    fn host_read_at(offset: u64, dst: *mut u8, len: usize) -> isize;
}

pub fn stream_len() -> u64 {
    unsafe { host_stream_len() }
}

/// Fill `dst` from the Worker's stream at `offset`; the Worker returns the byte count, negative on error.
pub fn read_at(offset: u64, dst: &mut [u8]) -> isize {
    unsafe { host_read_at(offset, dst.as_mut_ptr(), dst.len()) }
}

/// The `pt_open` extension buffer the Worker allocated for the length of the call.
///
/// # Safety
/// `ptr` must point at `len` readable bytes that stay alive for the returned slice.
pub unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

/// The block behind a `pt_alloc` pointer.
///
/// # Safety
/// `ptr`/`len` must be exactly what `pt_alloc` returned and the Worker must not have freed it twice.
pub unsafe fn drop_vec(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

/// Pack two f32 planes little-endian, L then R, into the pooled output buffer the Worker reads.
pub fn pack_audio_f32(out: &mut Vec<u8>, left: &[f32], right: &[f32]) {
    let frames = left.len().min(right.len());
    out.clear();
    out.reserve(frames * 8);
    if frames > 0 {
        // SAFETY: f32 is Pod with identical little-endian representation on wasm32/arm64/x86.
        unsafe {
            out.extend_from_slice(std::slice::from_raw_parts(left.as_ptr().cast::<u8>(), frames * 4));
            out.extend_from_slice(std::slice::from_raw_parts(right.as_ptr().cast::<u8>(), frames * 4));
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn decode_f32le_clamped_simd(src_bytes: &[u8], dst: &mut [f32]) {
    let n = dst.len().min(src_bytes.len() / 4);
    let vecs = n / 4;
    let min_v = f32x4_splat(-1.0);
    let max_v = f32x4_splat(1.0);
    let zero_v = f32x4_splat(0.0);
    let sp = src_bytes.as_ptr();
    let dp = dst.as_mut_ptr();
    for i in 0..vecs {
        unsafe {
            let v = v128_load(sp.add(i * 16) as *const v128);
            let finite_mask = f32x4_eq(v, v);
            let clean = v128_bitselect(v, zero_v, finite_mask);
            let clamped = f32x4_pmax(min_v, f32x4_pmin(max_v, clean));
            v128_store(dp.add(i * 4) as *mut v128, clamped);
        }
    }
    for i in (vecs * 4)..n {
        let b = &src_bytes[i * 4..i * 4 + 4];
        let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        dst[i] = if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 };
    }
}

#[cfg(target_arch = "wasm32")]
pub fn accum_f32le_plane_simd(src_bytes: &[u8], gl: f32, gr: f32, dst_l: &mut [f32], dst_r: &mut [f32]) {
    let n = dst_l.len().min(dst_r.len()).min(src_bytes.len() / 4);
    let vecs = n / 4;
    let gl_v = f32x4_splat(gl);
    let gr_v = f32x4_splat(gr);
    let zero_v = f32x4_splat(0.0);
    let sp = src_bytes.as_ptr();
    let lp = dst_l.as_mut_ptr();
    let rp = dst_r.as_mut_ptr();
    for i in 0..vecs {
        unsafe {
            let v = v128_load(sp.add(i * 16) as *const v128);
            let finite_mask = f32x4_eq(v, v);
            let clean = v128_bitselect(v, zero_v, finite_mask);
            if gl != 0.0 {
                let cur_l = v128_load(lp.add(i * 4) as *const v128);
                v128_store(lp.add(i * 4) as *mut v128, f32x4_add(cur_l, f32x4_mul(clean, gl_v)));
            }
            if gr != 0.0 {
                let cur_r = v128_load(rp.add(i * 4) as *const v128);
                v128_store(rp.add(i * 4) as *mut v128, f32x4_add(cur_r, f32x4_mul(clean, gr_v)));
            }
        }
    }
    for i in (vecs * 4)..n {
        let b = &src_bytes[i * 4..i * 4 + 4];
        let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if s.is_finite() {
            dst_l[i] += s * gl;
            dst_r[i] += s * gr;
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn clamp_stereo_simd(dst_l: &mut [f32], dst_r: &mut [f32]) {
    let min_v = f32x4_splat(-1.0);
    let max_v = f32x4_splat(1.0);
    for slice in [dst_l, dst_r] {
        let n = slice.len();
        let vecs = n / 4;
        let p = slice.as_mut_ptr();
        for i in 0..vecs {
            unsafe {
                let v = v128_load(p.add(i * 4) as *const v128);
                v128_store(p.add(i * 4) as *mut v128, f32x4_pmax(min_v, f32x4_pmin(max_v, v)));
            }
        }
        for x in &mut slice[vecs * 4..] {
            *x = x.clamp(-1.0, 1.0);
        }
    }
}

/// 10-bit little-endian samples to 8-bit with 4x4 Bayer ordered dithering, 16 pixels per two SIMD ops.
/// Exact multiples of 4 (`px & 3 == 0`) remain untouched while fractional 10-bit steps dither across 2x2 quads.
#[cfg(target_arch = "wasm32")]
pub fn pack_u16_to_u8(src_row: &[u8], dst_row: &mut [u8], row: usize) {
    const BAYER_4X4: [[u16; 4]; 4] = [
        [0, 2, 1, 3],
        [3, 1, 2, 0],
        [1, 3, 0, 2],
        [2, 0, 3, 1],
    ];
    let d4 = BAYER_4X4[row & 3];
    let d = u16x8(d4[0], d4[1], d4[2], d4[3], d4[0], d4[1], d4[2], d4[3]);
    let cols = dst_row.len().min(src_row.len() / 2);
    let chunks16 = cols / 16;
    let sp = src_row.as_ptr();
    let dp = dst_row.as_mut_ptr();
    for i in 0..chunks16 {
        unsafe {
            let lo = u16x8_shr(u16x8_add(v128_load(sp.add(i * 32) as *const v128), d), 2);
            let hi = u16x8_shr(u16x8_add(v128_load(sp.add(i * 32 + 16) as *const v128), d), 2);
            let packed = u8x16_narrow_i16x8(lo, hi);
            v128_store(dp.add(i * 16) as *mut v128, packed);
        }
    }
    for i in (chunks16 * 16)..cols {
        let px = u16::from_le_bytes([src_row[i * 2], src_row[i * 2 + 1]]);
        dst_row[i] = ((px + d4[i & 3]) >> 2).min(255) as u8;
    }
}

/// Two 4:2:2 chroma rows averaged with the hardware rounded-average instruction.
#[cfg(target_arch = "wasm32")]
pub fn average_rows(row0: &[u8], row1: &[u8], drow: &mut [u8]) {
    let cwu = drow.len().min(row0.len()).min(row1.len());
    let chunks16 = cwu / 16;
    for i in 0..chunks16 {
        unsafe {
            let a = v128_load(row0.as_ptr().add(i * 16) as *const v128);
            let b = v128_load(row1.as_ptr().add(i * 16) as *const v128);
            v128_store(drow.as_mut_ptr().add(i * 16) as *mut v128, u8x16_avgr(a, b));
        }
    }
    for i in (chunks16 * 16)..cwu {
        drow[i] = ((u16::from(row0[i]) + u16::from(row1[i]) + 1) >> 1) as u8;
    }
}

/// SIMD128 stereo downmix of interleaved 32-bit signed PCM (e.g. 5.1 / 7.1 TrueHD & LPCM).
#[cfg(target_arch = "wasm32")]
pub fn downmix_s32le_simd(
    plane: &[u8],
    ch: usize,
    avail: usize,
    gains: &[[f32; 2]],
    dl: &mut [f32],
    dr: &mut [f32],
) {
    const SCALE: f32 = 1.0 / 2_147_483_648.0;
    if ch == 8 && gains.len() >= 8 {
        let gl0 = f32x4(gains[0][0] * SCALE, gains[1][0] * SCALE, gains[2][0] * SCALE, gains[3][0] * SCALE);
        let gl1 = f32x4(gains[4][0] * SCALE, gains[5][0] * SCALE, gains[6][0] * SCALE, gains[7][0] * SCALE);
        let gr0 = f32x4(gains[0][1] * SCALE, gains[1][1] * SCALE, gains[2][1] * SCALE, gains[3][1] * SCALE);
        let gr1 = f32x4(gains[4][1] * SCALE, gains[5][1] * SCALE, gains[6][1] * SCALE, gains[7][1] * SCALE);
        let sp = plane.as_ptr();
        for i in 0..avail {
            unsafe {
                let f0 = f32x4_convert_i32x4(v128_load(sp.add(i * 32) as *const v128));
                let f1 = f32x4_convert_i32x4(v128_load(sp.add(i * 32 + 16) as *const v128));
                let l4 = f32x4_add(f32x4_mul(f0, gl0), f32x4_mul(f1, gl1));
                let r4 = f32x4_add(f32x4_mul(f0, gr0), f32x4_mul(f1, gr1));
                let lp = f32x4_add(l4, i32x4_shuffle::<2, 3, 0, 1>(l4, l4));
                let rp = f32x4_add(r4, i32x4_shuffle::<2, 3, 0, 1>(r4, r4));
                let l = f32x4_extract_lane::<0>(lp) + f32x4_extract_lane::<1>(lp);
                let r = f32x4_extract_lane::<0>(rp) + f32x4_extract_lane::<1>(rp);
                dl[i] = l.clamp(-1.0, 1.0);
                dr[i] = r.clamp(-1.0, 1.0);
            }
        }
        return;
    }
    if ch == 6 && gains.len() >= 6 {
        let gl0 = f32x4(gains[0][0] * SCALE, gains[1][0] * SCALE, gains[2][0] * SCALE, gains[3][0] * SCALE);
        let gr0 = f32x4(gains[0][1] * SCALE, gains[1][1] * SCALE, gains[2][1] * SCALE, gains[3][1] * SCALE);
        let g4l = gains[4][0] * SCALE;
        let g5l = gains[5][0] * SCALE;
        let g4r = gains[4][1] * SCALE;
        let g5r = gains[5][1] * SCALE;
        let sp = plane.as_ptr();
        for i in 0..avail {
            unsafe {
                let base = sp.add(i * 24);
                let f0 = f32x4_convert_i32x4(v128_load(base as *const v128));
                let s4 = i32::from_le_bytes(*base.add(16).cast::<[u8; 4]>()) as f32;
                let s5 = i32::from_le_bytes(*base.add(20).cast::<[u8; 4]>()) as f32;
                let l4 = f32x4_mul(f0, gl0);
                let r4 = f32x4_mul(f0, gr0);
                let lp = f32x4_add(l4, i32x4_shuffle::<2, 3, 0, 1>(l4, l4));
                let rp = f32x4_add(r4, i32x4_shuffle::<2, 3, 0, 1>(r4, r4));
                let l = f32x4_extract_lane::<0>(lp) + f32x4_extract_lane::<1>(lp) + s4 * g4l + s5 * g5l;
                let r = f32x4_extract_lane::<0>(rp) + f32x4_extract_lane::<1>(rp) + s4 * g4r + s5 * g5r;
                dl[i] = l.clamp(-1.0, 1.0);
                dr[i] = r.clamp(-1.0, 1.0);
            }
        }
        return;
    }
    for (i, frame) in plane[..avail * ch * 4].chunks_exact(ch * 4).enumerate() {
        let mut l = 0.0f32;
        let mut r = 0.0f32;
        for (b, &[gl, gr]) in frame.chunks_exact(4).zip(&gains[..ch]) {
            let s = i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 * SCALE;
            l += s * gl;
            r += s * gr;
        }
        dl[i] = l.clamp(-1.0, 1.0);
        dr[i] = r.clamp(-1.0, 1.0);
    }
}
