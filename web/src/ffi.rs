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
    for &x in &left[..frames] {
        out.extend_from_slice(&x.to_le_bytes());
    }
    for &x in &right[..frames] {
        out.extend_from_slice(&x.to_le_bytes());
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

/// 10-bit little-endian samples to 8-bit, 16 pixels per two SIMD ops.
#[cfg(target_arch = "wasm32")]
pub fn pack_u16_to_u8(src_row: &[u8], dst_row: &mut [u8]) {
    let cols = dst_row.len().min(src_row.len() / 2);
    let chunks16 = cols / 16;
    let sp = src_row.as_ptr();
    let dp = dst_row.as_mut_ptr();
    for i in 0..chunks16 {
        unsafe {
            let lo = u16x8_shr(v128_load(sp.add(i * 32) as *const v128), 2);
            let hi = u16x8_shr(v128_load(sp.add(i * 32 + 16) as *const v128), 2);
            let packed = u8x16_narrow_i16x8(lo, hi);
            v128_store(dp.add(i * 16) as *mut v128, packed);
        }
    }
    for i in (chunks16 * 16)..cols {
        let px = u16::from_le_bytes([src_row[i * 2], src_row[i * 2 + 1]]);
        dst_row[i] = (px >> 2).min(255) as u8;
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
