//! Pure-Rust ThumbHash decoder (Evan Wallace's compact image placeholder format)
//! with zero external dependencies and `#![forbid(unsafe_code)]`.

#![forbid(unsafe_code)]

use std::f32::consts::PI;

/// Decodes a binary ThumbHash into `(width, height, rgba_bytes)` where
/// `rgba_bytes.len() == (width as usize) * (height as usize) * 4`.
/// Returns `None` on empty, truncated, or structurally invalid inputs.
pub fn thumb_hash_to_rgba(hash: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if hash.len() < 5 {
        return None;
    }

    let header24 = u32::from(hash[0]) | (u32::from(hash[1]) << 8) | (u32::from(hash[2]) << 16);
    let header16 = u16::from(hash[3]) | (u16::from(hash[4]) << 8);

    let l_dc = (header24 & 63) as f32 / 63.0;
    let p_dc = ((header24 >> 6) & 63) as f32 / 31.5 - 1.0;
    let q_dc = ((header24 >> 12) & 63) as f32 / 31.5 - 1.0;
    let l_scale = ((header24 >> 18) & 31) as f32 / 31.0;
    let has_alpha = (header24 >> 23) != 0;

    let p_scale = ((header16 >> 3) & 63) as f32 / 63.0;
    let q_scale = ((header16 >> 9) & 63) as f32 / 63.0;
    let is_landscape = (header16 >> 15) != 0;

    let raw_minor = usize::from(header16 & 7);
    if raw_minor == 0 {
        return None;
    }
    let major = if has_alpha { 5usize } else { 7usize };
    let (raw_lx, raw_ly) = if is_landscape {
        (major, raw_minor)
    } else {
        (raw_minor, major)
    };
    let lx = raw_lx.max(3);
    let ly = raw_ly.max(3);

    let (a_dc, a_scale) = if has_alpha {
        if hash.len() < 6 {
            return None;
        }
        ((hash[5] & 15) as f32 / 15.0, (hash[5] >> 4) as f32 / 15.0)
    } else {
        (1.0, 1.0)
    };

    let ac_start = if has_alpha { 6usize } else { 5usize };
    let mut ac_index = 0usize;

    let l_ac = decode_channel(hash, ac_start, &mut ac_index, lx, ly, l_scale)?;
    let p_ac = decode_channel(hash, ac_start, &mut ac_index, 3, 3, p_scale * 1.25)?;
    let q_ac = decode_channel(hash, ac_start, &mut ac_index, 3, 3, q_scale * 1.25)?;
    let a_ac = if has_alpha {
        decode_channel(hash, ac_start, &mut ac_index, 5, 5, a_scale)?
    } else {
        Vec::new()
    };

    let ratio = raw_lx as f32 / raw_ly as f32;
    let w = (if ratio > 1.0 { 32.0 } else { 32.0 * ratio }).round() as usize;
    let h = (if ratio > 1.0 { 32.0 / ratio } else { 32.0 }).round() as usize;
    if w == 0 || h == 0 {
        return None;
    }

    let fx_len = lx.max(if has_alpha { 5 } else { 3 });
    let fy_len = ly.max(if has_alpha { 5 } else { 3 });
    let mut fx = vec![0.0f32; fx_len];
    let mut fy = vec![0.0f32; fy_len];
    let mut rgba = vec![0u8; w * h * 4];

    for y in 0..h {
        let y_factor = PI / h as f32 * (y as f32 + 0.5);
        for (cy, slot) in fy.iter_mut().enumerate() {
            *slot = (y_factor * cy as f32).cos();
        }
        for x in 0..w {
            let x_factor = PI / w as f32 * (x as f32 + 0.5);
            for (cx, slot) in fx.iter_mut().enumerate() {
                *slot = (x_factor * cx as f32).cos();
            }

            let l = l_dc + eval_channel(&l_ac, lx, ly, &fx, &fy);
            let (dp, dq) = eval_chroma(&p_ac, &q_ac, &fx, &fy);
            let p = p_dc + dp;
            let q = q_dc + dq;
            let a = if has_alpha {
                a_dc + eval_square(&a_ac, 5, &fx, &fy)
            } else {
                1.0
            };

            let b = l - (2.0 / 3.0) * p;
            let r = (3.0 * l - b + q) * 0.5;
            let g = r - q;

            let idx = (y * w + x) * 4;
            rgba[idx] = to_u8_channel(r);
            rgba[idx + 1] = to_u8_channel(g);
            rgba[idx + 2] = to_u8_channel(b);
            rgba[idx + 3] = to_u8_channel(a);
        }
    }

    Some((w as u32, h as u32, rgba))
}

/// Decodes a Base64-encoded ThumbHash (standard or URL-safe, padded or unpadded) into RGBA pixels.
pub fn decode_base64_thumbhash(b64: &str) -> Option<(u32, u32, Vec<u8>)> {
    let bytes = decode_base64(b64)?;
    thumb_hash_to_rgba(&bytes)
}

/// Encodes a small RGBA image (such as a decoded ThumbHash <= 32x32) into a valid
/// uncompressed RGBA PNG byte buffer suitable for `gpui::Image::from_bytes(ImageFormat::Png, ...)`.
pub fn rgba_to_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > 256 || height > 256 {
        return None;
    }
    let row_bytes = (width as usize).checked_mul(4)?;
    let expected = row_bytes.checked_mul(height as usize)?;
    if rgba.len() != expected {
        return None;
    }

    let mut raw = Vec::with_capacity(height as usize * (row_bytes + 1));
    for y in 0..height as usize {
        raw.push(0u8); // PNG filter type 0 (None)
        let start = y * row_bytes;
        raw.extend_from_slice(&rgba[start..start + row_bytes]);
    }

    let zlib = zlib_store(&raw);
    let mut png = Vec::with_capacity(8 + 25 + 12 + zlib.len() + 12);
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    write_png_chunk(&mut png, b"IHDR", &ihdr);
    write_png_chunk(&mut png, b"IDAT", &zlib);
    write_png_chunk(&mut png, b"IEND", &[]);
    Some(png)
}

fn decode_channel(
    hash: &[u8],
    ac_start: usize,
    ac_index: &mut usize,
    nx: usize,
    ny: usize,
    scale: f32,
) -> Option<Vec<f32>> {
    let mut out = Vec::new();
    for cy in 0..ny {
        let mut cx = if cy > 0 { 0 } else { 1 };
        while cx * ny < nx * (ny - cy) {
            let byte_idx = ac_start + (*ac_index >> 1);
            let byte = *hash.get(byte_idx)?;
            let nibble = (byte >> ((*ac_index & 1) << 2)) & 15;
            out.push((f32::from(nibble) / 7.5 - 1.0) * scale);
            *ac_index += 1;
            cx += 1;
        }
    }
    Some(out)
}

fn eval_channel(ac: &[f32], nx: usize, ny: usize, fx: &[f32], fy: &[f32]) -> f32 {
    let mut acc = 0.0f32;
    let mut j = 0usize;
    for cy in 0..ny {
        let fy2 = fy[cy] * 2.0;
        let mut cx = if cy > 0 { 0 } else { 1 };
        while cx * ny < nx * (ny - cy) {
            acc += ac[j] * fx[cx] * fy2;
            j += 1;
            cx += 1;
        }
    }
    acc
}

fn eval_chroma(p_ac: &[f32], q_ac: &[f32], fx: &[f32], fy: &[f32]) -> (f32, f32) {
    let mut p = 0.0f32;
    let mut q = 0.0f32;
    let mut j = 0usize;
    for cy in 0..3 {
        let fy2 = fy[cy] * 2.0;
        let cx_start = if cy > 0 { 0 } else { 1 };
        for cx in cx_start..(3 - cy) {
            let f = fx[cx] * fy2;
            p += p_ac[j] * f;
            q += q_ac[j] * f;
            j += 1;
        }
    }
    (p, q)
}

fn eval_square(ac: &[f32], n: usize, fx: &[f32], fy: &[f32]) -> f32 {
    let mut acc = 0.0f32;
    let mut j = 0usize;
    for cy in 0..n {
        let fy2 = fy[cy] * 2.0;
        let cx_start = if cy > 0 { 0 } else { 1 };
        for cx in cx_start..(n - cy) {
            acc += ac[j] * fx[cx] * fy2;
            j += 1;
        }
    }
    acc
}

fn to_u8_channel(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn b64_val(b: u8) -> Option<u8> {
    match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.is_empty() {
        return None;
    }
    let unpadded_len = clean.iter().rposition(|&b| b != b'=').map(|i| i + 1)?;
    let body = &clean[..unpadded_len];
    if body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity((body.len() * 3) / 4);
    let mut i = 0usize;
    while i < body.len() {
        let rem = body.len() - i;
        let a = b64_val(body[i])?;
        let b = b64_val(body[i + 1])?;
        out.push((a << 2) | (b >> 4));
        if rem >= 3 {
            let c = b64_val(body[i + 2])?;
            out.push((b << 4) | (c >> 2));
            if rem >= 4 {
                let d = b64_val(body[i + 3])?;
                out.push((c << 6) | d);
            }
        }
        i += 4;
    }
    Some(out)
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    out.push(0x78); // CMF: deflate, 32K window
    out.push(0x01); // FLG: no dict, check bits valid (0x7801 % 31 == 0)
    let mut pos = 0usize;
    while pos < data.len() {
        let chunk_len = (data.len() - pos).min(65535);
        let is_final = pos + chunk_len == data.len();
        out.push(u8::from(is_final));
        let len_u16 = chunk_len as u16;
        out.extend_from_slice(&len_u16.to_le_bytes());
        out.extend_from_slice(&(!len_u16).to_le_bytes());
        out.extend_from_slice(&data[pos..pos + chunk_len]);
        pos += chunk_len;
    }
    let adler = adler32(data);
    out.extend_from_slice(&adler.to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut s1 = 1u32;
    let mut s2 = 0u32;
    for &b in data {
        s1 = (s1 + u32::from(b)) % MOD;
        s2 = (s2 + s1) % MOD;
    }
    (s2 << 16) | s1
}

fn crc32(kind: &[u8; 4], data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in kind.iter().chain(data.iter()) {
        crc ^= u32::from(b);
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn write_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(kind, data).to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_hex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("valid hex"))
            .collect()
    }

    #[test]
    fn decodes_spec_meta_vector_25_byte_thumbhashes() {
        // Exact 25-byte vector from spec/meta-vectors.json cardMovie.thumbHashHex / thumbHash
        let spec_bytes = from_hex("000102030405060708090a0b0c0d0e0f101112131415161718");
        let (w1, h1, rgba1) = thumb_hash_to_rgba(&spec_bytes).expect("decode spec cardMovie thumbHash");
        assert!(w1 > 0 && w1 <= 32);
        assert!(h1 > 0 && h1 <= 32);
        assert_eq!(rgba1.len(), (w1 * h1 * 4) as usize);
        // No alpha bit set -> every pixel must be opaque
        assert!(rgba1.chunks_exact(4).all(|px| px[3] == 255));

        let from_b64 = decode_base64_thumbhash("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGA==")
            .expect("decode spec base64 thumbHash");
        assert_eq!((w1, h1, rgba1.clone()), from_b64);

        // Prompt's 25-byte vector 010203...19
        let vec2 = from_hex("0102030405060708090a0b0c0d0e0f10111213141516171819");
        let (w2, h2, rgba2) = thumb_hash_to_rgba(&vec2).expect("decode 01..19 25-byte thumbHash");
        assert_eq!((w2, h2), (18, 32));
        assert_eq!(rgba2.len(), (w2 * h2 * 4) as usize);
        assert!(rgba2.chunks_exact(4).all(|px| px[3] == 255));

        // Unpadded base64 also decodes cleanly
        let from_b64_unpadded =
            decode_base64_thumbhash("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGA").expect("unpadded b64");
        assert_eq!((w1, h1, rgba1), from_b64_unpadded);
    }

    #[test]
    fn decodes_landscape_and_alpha_thumbhashes() {
        // Landscape + alpha: header24 has bit 23 set (0x80 on byte 2), header16 has bit 15 set (0x80 on byte 4)
        // and minor = 3 (byte 3 = 0x03). Needs 6 header bytes + (l_ac(5,3)=8 + p_ac=5 + q_ac=5 + a_ac(5,5)=14 = 32 nibbles = 16 bytes) = 22 bytes.
        let mut hash = vec![0x20u8, 0x40, 0x80, 0x03, 0x84, 0x78];
        hash.resize(24, 0x77);
        let (w, h, rgba) = thumb_hash_to_rgba(&hash).expect("landscape alpha thumbHash");
        assert!(w > h, "landscape hash should have width > height, got {w}x{h}");
        assert_eq!(rgba.len(), (w * h * 4) as usize);
        // Alpha channel is active (a_dc = 8/15 ~= 0.53), so not all pixels are 255
        assert!(rgba.chunks_exact(4).any(|px| px[3] < 255));

        // PNG encoding round-trip sanity check
        let png = rgba_to_png(w, h, &rgba).expect("encode png");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(png.ends_with(b"IEND\xaeB`\x82"));
    }

    #[test]
    fn returns_none_on_empty_truncated_or_corrupt_inputs() {
        assert_eq!(thumb_hash_to_rgba(&[]), None);
        assert_eq!(thumb_hash_to_rgba(&[1, 2, 3, 4]), None);
        // Truncated AC payload
        assert_eq!(thumb_hash_to_rgba(&[1, 2, 3, 4, 5]), None);
        assert_eq!(thumb_hash_to_rgba(&[1, 2, 3, 4, 5, 6, 7, 8]), None);
        // Zero minor dimension (header16 & 7 == 0)
        assert_eq!(thumb_hash_to_rgba(&[0u8; 25]), None);
        // Corrupt base64
        assert_eq!(decode_base64_thumbhash(""), None);
        assert_eq!(decode_base64_thumbhash("   "), None);
        assert_eq!(decode_base64_thumbhash("!!!not-base64!!!"), None);
        assert_eq!(decode_base64_thumbhash("A"), None);
    }
}
