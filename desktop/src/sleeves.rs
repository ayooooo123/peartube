//! Drawn album sleeves, stacked artist sleeves, and quiet video poster / clip
//! art tiles in pure GPUI. Never contacts an external host for artwork.

#![forbid(unsafe_code)]

use gpui_kit::*;

use crate::catalog::{monogram, sleeve_hash};
use crate::theme::{CARD_ELEVATED, LINE};

/// Square drawn sleeve derived deterministically from an album's `hue`, `seed`,
/// and `monogram`, mirroring `albumArt` in `src/ui.js`.
pub fn album_sleeve(hue: u32, seed: u32, mono: &str, size_px: f32) -> Div {
    let h1 = (hue % 360) as f32 / 360.0;
    let h2 = ((hue + 30 + ((seed >> 9) % 120)) % 360) as f32 / 360.0;
    let l1 = (42 + ((seed >> 3) % 16)) as f32 / 100.0;
    let base = hsla(h1, 0.62, l1, 1.0);
    let deep = hsla(h2, 0.64, 0.20, 1.0);
    let cut = (seed >> 25) % 3;
    let radius = if size_px >= 140. {
        12.
    } else if size_px >= 64. {
        8.
    } else {
        6.
    };
    let font_px = (size_px * 0.30).clamp(13., 58.);

    let mut box_el = div()
        .relative()
        .flex_none()
        .size(px(size_px))
        .rounded(px(radius))
        .overflow_hidden()
        .bg(deep)
        .border_1()
        .border_color(hsla(0., 0., 1., 0.08));

    match cut {
        // Cut 0: sweep — upper-left warm wash + bright corner highlight
        0 => {
            box_el = box_el
                .child(
                    div()
                        .absolute()
                        .top(px(-size_px * 0.18))
                        .left(px(-size_px * 0.18))
                        .size(px(size_px * 0.98))
                        .rounded(px(size_px * 0.45))
                        .bg(base),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(size_px * 0.06))
                        .right(px(size_px * 0.06))
                        .size(px(size_px * 0.42))
                        .rounded(px(999.))
                        .bg(hsla(0., 0., 1., 0.14)),
                );
        }
        // Cut 1: record — concentric disc in `base` over dark `deep` field
        1 => {
            let outer = size_px * 0.74;
            let inner = size_px * 0.56;
            let off_outer = (size_px - outer) * 0.5;
            let off_inner = (size_px - inner) * 0.5;
            box_el = box_el
                .child(
                    div()
                        .absolute()
                        .top(px(off_outer))
                        .left(px(off_outer))
                        .size(px(outer))
                        .rounded(px(999.))
                        .border_1()
                        .border_color(hsla(0., 0., 1., 0.10))
                        .bg(hsla(0., 0., 0., 0.16)),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(off_inner))
                        .left(px(off_inner))
                        .size(px(inner))
                        .rounded(px(999.))
                        .bg(base),
                );
        }
        // Cut 2: split — crisp two-tone horizontal cut (54% / 46%)
        _ => {
            box_el = box_el
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(px(size_px * 0.54))
                        .bg(base),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(size_px * 0.08))
                        .right(px(size_px * 0.08))
                        .size(px(size_px * 0.34))
                        .rounded(px(999.))
                        .bg(hsla(0., 0., 1., 0.14)),
                );
        }
    }

    box_el.child(
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .text_size(px(font_px))
                    .font_weight(FontWeight::BOLD)
                    .text_color(hsla(0., 0., 1., 0.92))
                    .child(mono.to_string()),
            ),
    )
}

/// Rule 6: an artist's picture is a stack of up to 3 of that artist's sleeves.
pub fn artist_sleeve_stack(sleeves: &[(u32, u32, String)], size_px: f32) -> Div {
    let front_size = (size_px - 12.).max(40.);
    let mut stack = div().relative().flex_none().size(px(size_px));

    if let Some((hue, seed, mono)) = sleeves.get(2) {
        stack = stack.child(
            div()
                .absolute()
                .top_0()
                .right_0()
                .opacity(0.55)
                .child(album_sleeve(*hue, *seed, mono, front_size)),
        );
    }
    if let Some((hue, seed, mono)) = sleeves.get(1) {
        stack = stack.child(
            div()
                .absolute()
                .top(px(6.))
                .right(px(6.))
                .opacity(0.78)
                .child(album_sleeve(*hue, *seed, mono, front_size)),
        );
    }
    if let Some((hue, seed, mono)) = sleeves.first() {
        stack = stack.child(
            div()
                .absolute()
                .bottom_0()
                .left_0()
                .child(album_sleeve(*hue, *seed, mono, front_size)),
        );
    } else {
        stack = stack.child(
            div()
                .size(px(size_px))
                .rounded(px(10.))
                .bg(rgb(CARD_ELEVATED))
                .border_1()
                .border_color(rgb(LINE)),
        );
    }
    stack
}

/// Quiet tall (2:3) poster surface for movies and series, or wide (16:9) surface
/// for clips — deterministic subtle tint with the title's monogram.
pub fn video_art(title: &str, badge: Option<&str>, width_px: f32, height_px: f32) -> Div {
    let seed = sleeve_hash(title);
    let hue = (seed % 360) as f32 / 360.0;
    let top_tint = hsla(hue, 0.28, 0.22, 1.0);
    let base_bg = hsla(hue, 0.24, 0.13, 1.0);
    let mono = monogram(title);
    let font_px = (width_px.min(height_px) * 0.28).clamp(16., 42.);

    let mut box_el = div()
        .relative()
        .flex_none()
        .w(px(width_px))
        .h(px(height_px))
        .rounded(px(10.))
        .overflow_hidden()
        .bg(base_bg)
        .border_1()
        .border_color(hsla(0., 0., 1., 0.08))
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(height_px * 0.45))
                .bg(top_tint),
        )
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(font_px))
                        .font_weight(FontWeight::BOLD)
                        .text_color(hsla(0., 0., 1., 0.85))
                        .child(mono),
                ),
        );

    if let Some(tag) = badge {
        box_el = box_el.child(
            div()
                .absolute()
                .bottom_2()
                .left_2()
                .px_2()
                .py_0p5()
                .rounded(px(6.))
                .bg(hsla(0., 0., 0., 0.58))
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(hsla(0., 0., 1., 0.88))
                .child(tag.to_string()),
        );
    }

    box_el
}
