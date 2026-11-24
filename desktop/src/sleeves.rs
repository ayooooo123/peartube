//! Drawn album sleeves, stacked artist sleeves, 4-variant geometric video poster
//! art, and shared hero panel/button primitives in pure GPUI. Never contacts an
//! external host for artwork.

#![forbid(unsafe_code)]

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::catalog::sleeve_hash;
use crate::theme::{ACCENT, BRAND_HOVER, CARD_ELEVATED, LINE};

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
        10.
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
        .border_color(hsla(0., 0., 1., 0.10));

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

/// 4-variant geometric poster art (`v0` off-center circle, `v1` diagonal pinstripes,
/// `v2` angled color band, `v3` stroked ring, chosen by `hue % 4`), mirroring
/// `.poster.v0`–`v3` in `sketch.css`, with `SERIES` / `FILM` / `CLIP` eyebrow at
/// top-left and bold uppercase title at bottom-left.
pub fn video_art(title: &str, badge: Option<&str>, width_px: f32, height_px: f32) -> Div {
    let hue_deg = sleeve_hash(title) % 360;
    let h1 = hue_deg as f32 / 360.0;
    let h2 = ((hue_deg + 48) % 360) as f32 / 360.0;
    let wide = width_px > height_px * 1.15;
    let long_title = title.chars().count() > 30;

    let bg = linear_gradient(
        165.,
        linear_color_stop(hsla(h1, 0.58, 0.36, 1.0), 0.0),
        linear_color_stop(hsla(h2, 0.64, 0.11, 1.0), 1.0),
    );
    let scrim = linear_gradient(
        0.,
        linear_color_stop(hsla(0., 0., 0., 0.52), 0.0),
        linear_color_stop(hsla(0., 0., 0., 0.0), 0.68),
    );

    let pad = if wide {
        (width_px * 0.055).clamp(9., 14.)
    } else {
        (width_px * 0.088).clamp(10., 16.)
    };
    let kind_px = if wide {
        (width_px * 0.044).clamp(9., 11.)
    } else {
        (width_px * 0.062).clamp(9., 11.)
    };
    let title_px = match (wide, long_title) {
        (false, false) => (width_px * 0.145).clamp(15., 24.),
        (false, true) => (width_px * 0.105).clamp(11.5, 16.),
        (true, false) => (width_px * 0.092).clamp(13., 20.),
        (true, true) => (width_px * 0.070).clamp(11., 15.),
    };
    let kind_text = badge.map(|b| b.to_uppercase()).unwrap_or_default();
    let display_title = title.to_uppercase();

    div()
        .relative()
        .flex_none()
        .w(px(width_px))
        .h(px(height_px))
        .rounded(px(14.))
        .overflow_hidden()
        .bg(bg)
        .border_1()
        .border_color(hsla(0., 0., 1., 0.10))
        .child(
            div().absolute().inset_0().child(
                canvas(
                    move |_, _, _| hue_deg,
                    move |bounds, h, window, _| paint_poster_pattern(bounds, h, window),
                )
                .size_full(),
            ),
        )
        .child(div().absolute().inset_0().bg(scrim))
        .child(
            v_flex()
                .absolute()
                .inset_0()
                .justify_between()
                .p(px(pad))
                .child(
                    div()
                        .text_size(px(kind_px))
                        .font_weight(FontWeight::BOLD)
                        .text_color(hsla(0., 0., 1., 0.86))
                        .child(kind_text),
                )
                .child(
                    div()
                        .w_full()
                        .max_h(px(height_px * (if wide { 0.56 } else { 0.62 })))
                        .overflow_hidden()
                        .text_size(px(title_px))
                        .line_height(relative(1.02))
                        .font_weight(FontWeight::EXTRA_BOLD)
                        .text_color(rgb(0xffffff))
                        .child(display_title),
                ),
        )
}

/// Shared rich `.hero` backdrop surface: 120° deep hue gradient, optional glowing
/// orb on the right, subtle 118° diagonal pinstripes, and left readability scrim.
pub fn hero_surface(hue_deg: u32, show_orb: bool) -> Div {
    let h1 = (hue_deg % 360) as f32 / 360.0;
    let h2 = ((hue_deg + 55) % 360) as f32 / 360.0;
    let base_grad = linear_gradient(
        120.,
        linear_color_stop(hsla(h1, 0.60, 0.30, 1.0), 0.0),
        linear_color_stop(hsla(h2, 0.66, 0.09, 1.0), 1.0),
    );
    let left_scrim = linear_gradient(
        90.,
        linear_color_stop(hsla(0., 0., 0., 0.52), 0.0),
        linear_color_stop(hsla(0., 0., 0., 0.0), 0.72),
    );

    v_flex()
        .relative()
        .rounded(px(22.))
        .overflow_hidden()
        .bg(base_grad)
        .border_1()
        .border_color(hsla(0., 0., 1., 0.12))
        .child(
            div().absolute().inset_0().child(
                canvas(
                    move |_, _, _| (hue_deg, show_orb),
                    move |bounds, (h, orb), window, _| paint_hero_backdrop(bounds, h, orb, window),
                )
                .size_full(),
            ),
        )
        .child(div().absolute().inset_0().bg(left_scrim))
}

/// Crisp white primary action button for hero cards (`#ffffff` bg, `#111111` ink).
pub fn hero_primary_btn(id: impl Into<ElementId>, icon: Option<Lucide>, label: impl Into<SharedString>) -> Stateful<Div> {
    h_flex()
        .id(id)
        .items_center()
        .justify_center()
        .gap_2()
        .h(px(42.))
        .px_5()
        .rounded(px(12.))
        .bg(rgb(0xffffff))
        .text_sm()
        .font_weight(FontWeight::BOLD)
        .text_color(rgb(0x111111))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0xe6e2f5)))
        .when_some(icon, |row, ic| row.child(Icon::new(ic).text_color(rgb(0x111111))))
        .child(label.into())
}

/// Frosted translucent secondary action button for hero cards.
pub fn hero_secondary_btn(id: impl Into<ElementId>, icon: Option<Lucide>, label: impl Into<SharedString>) -> Stateful<Div> {
    h_flex()
        .id(id)
        .items_center()
        .justify_center()
        .gap_2()
        .h(px(42.))
        .px_4()
        .rounded(px(12.))
        .bg(hsla(0., 0., 1., 0.16))
        .border_1()
        .border_color(hsla(0., 0., 1., 0.28))
        .text_sm()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(0xffffff))
        .cursor_pointer()
        .hover(|s| s.bg(hsla(0., 0., 1., 0.28)))
        .when_some(icon, |row, ic| row.child(Icon::new(ic).text_color(rgb(0xffffff))))
        .child(label.into())
}

/// Progress track for hero cards matching `.hero .prog`.
pub fn hero_progress_bar(ratio: f32) -> Div {
    div()
        .mt_1()
        .h(px(4.))
        .w_full()
        .max_w(px(420.))
        .rounded(px(2.))
        .bg(hsla(0., 0., 1., 0.28))
        .overflow_hidden()
        .child(
            div()
                .h_full()
                .rounded(px(2.))
                .w(relative(ratio.clamp(0.03, 1.0)))
                .bg(rgb(BRAND_HOVER)),
        )
}

/// Availability dot matching `.held` (full green, partial green ring, or hollow).
pub fn held_dot(saved: usize, total: usize, partial: bool) -> Div {
    let base = div().flex_none().size(px(11.)).rounded(px(99.));
    if total > 0 && saved >= total {
        base.bg(rgb(ACCENT))
    } else if saved > 0 || partial {
        base.bg(Hsla::from(rgb(ACCENT)).opacity(0.40))
            .border_2()
            .border_color(rgb(ACCENT))
    } else {
        base.border_2().border_color(hsla(0., 0., 1., 0.55))
    }
}

fn paint_quad_circle(window: &mut Window, cx: f32, cy: f32, rad: f32, color: Hsla) {
    if rad <= 0.5 {
        return;
    }
    let d = rad * 2.0;
    window.paint_quad(PaintQuad {
        bounds: Bounds {
            origin: point(px(cx - rad), px(cy - rad)),
            size: size(px(d), px(d)),
        },
        corner_radii: Corners::all(px(rad)),
        background: color.into(),
        border_widths: Edges::default(),
        border_color: transparent_black(),
        border_style: BorderStyle::default(),
    });
}

fn paint_diagonal_stripes(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    step: f32,
    stroke_w: f32,
    color: Hsla,
) {
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 4.0 || h < 4.0 || step < 2.0 {
        return;
    }
    // 118° angle -> slope dx/dy ≈ -0.53 (runs down-left / up-right)
    let dx = -h * 0.53;
    let start_x = ox - h.abs() * 0.6;
    let end_x = ox + w + h.abs() * 0.6;
    let mut x = start_x;
    while x <= end_x {
        let mut pb = PathBuilder::stroke(px(stroke_w));
        pb.move_to(point(px(x), px(oy - 4.0)));
        pb.line_to(point(px(x + dx), px(oy + h + 4.0)));
        if let Ok(path) = pb.build() {
            window.paint_path(path, color);
        }
        x += step;
    }
}

fn paint_poster_pattern(bounds: Bounds<Pixels>, hue_deg: u32, window: &mut Window) {
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 10.0 || h < 10.0 {
        return;
    }

    match hue_deg % 4 {
        // v0: off-center bold circle in upper-right
        0 => {
            let accent = hsla(((hue_deg + 170) % 360) as f32 / 360.0, 0.78, 0.62, 0.62);
            let rad = w.max(h) * 0.50;
            paint_quad_circle(window, ox + w * 0.82, oy + h * 0.18, rad, accent);
        }
        // v1: repeating 118° diagonal pinstripes
        1 => {
            let step = (w * 0.10).clamp(11.0, 22.0);
            let stroke_w = (w * 0.012).clamp(1.2, 2.2);
            paint_diagonal_stripes(window, bounds, step, stroke_w, hsla(0., 0., 1., 0.11));
        }
        // v2: angled -16° color band across the middle
        2 => {
            let accent = hsla(((hue_deg + 140) % 360) as f32 / 360.0, 0.78, 0.56, 0.62);
            let band_h = h * 0.34;
            let mid_y = oy + h * 0.43;
            let slope = (-16.0_f32.to_radians()).tan();
            let left_x = ox - w * 0.30;
            let right_x = ox + w * 1.30;
            let half_span = (right_x - left_x) * 0.5;
            let dy = half_span * slope;
            let mut pb = PathBuilder::fill();
            pb.move_to(point(px(left_x), px(mid_y - dy - band_h * 0.5)));
            pb.line_to(point(px(right_x), px(mid_y + dy - band_h * 0.5)));
            pb.line_to(point(px(right_x), px(mid_y + dy + band_h * 0.5)));
            pb.line_to(point(px(left_x), px(mid_y - dy + band_h * 0.5)));
            pb.close();
            if let Ok(path) = pb.build() {
                window.paint_path(path, accent);
            }
        }
        // v3: bold stroked ring in upper-right
        _ => {
            let accent = hsla(((hue_deg + 200) % 360) as f32 / 360.0, 0.82, 0.72, 0.50);
            let rad = w.min(h) * 0.46;
            let ring_w = (w.min(h) * 0.095).clamp(8.0, 18.0);
            let cx = ox + w * 0.78;
            let cy = oy + h * 0.24;
            let d = rad * 2.0;
            window.paint_quad(PaintQuad {
                bounds: Bounds {
                    origin: point(px(cx - rad), px(cy - rad)),
                    size: size(px(d), px(d)),
                },
                corner_radii: Corners::all(px(rad)),
                background: transparent_black().into(),
                border_widths: Edges::all(px(ring_w)),
                border_color: accent,
                border_style: BorderStyle::default(),
            });
        }
    }
}

fn paint_hero_backdrop(bounds: Bounds<Pixels>, hue_deg: u32, show_orb: bool, window: &mut Window) {
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 16.0 || h < 16.0 {
        return;
    }

    if show_orb {
        let orb_h_outer = ((hue_deg + 120) % 360) as f32 / 360.0;
        let orb_h_inner = ((hue_deg + 165) % 360) as f32 / 360.0;
        let cx = ox + w * 0.78;
        let cy = oy + h * 0.12;
        let max_r = (w * 0.34).max(h * 0.62);
        // Layered concentric circles approximate a smooth radial glow.
        paint_quad_circle(window, cx, cy, max_r, hsla(orb_h_outer, 0.80, 0.44, 0.14));
        paint_quad_circle(window, cx - max_r * 0.06, cy - max_r * 0.04, max_r * 0.74, hsla(orb_h_inner, 0.82, 0.56, 0.22));
        paint_quad_circle(window, cx - max_r * 0.12, cy - max_r * 0.08, max_r * 0.48, hsla(orb_h_inner, 0.84, 0.66, 0.32));
        paint_quad_circle(window, cx - max_r * 0.16, cy - max_r * 0.10, max_r * 0.26, hsla(orb_h_inner, 0.86, 0.74, 0.24));
    }

    paint_diagonal_stripes(window, bounds, 48.0, 1.5, hsla(0., 0., 1., 0.045));
}
