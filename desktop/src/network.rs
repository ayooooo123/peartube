//! Network visualizations (`Globe`, `Swarm`, `Flow`) powered by live `Status`
//! route traffic, rolling 40-sample sparklines, reciprocity meter, per-route
//! breakdown (`Home network`, `Internet`, `Private route`), and storage kept.

#![forbid(unsafe_code)]

use std::f32::consts::{PI, TAU};

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::{RouteTraffic, Status};

use crate::app::{NetworkTab, PearTube, Room};
use crate::list::{column, format_bytes, format_rate, total_peers};
use crate::theme::{ACCENT, BRAND, BRAND_HOVER, CARD, CARD_ELEVATED, DIM, INK, LINE, WARN};

const ROUTE_COLORS: [u32; 3] = [ACCENT, BRAND_HOVER, WARN];
const ROUTE_NAMES: [&str; 3] = ["Home network", "Internet", "Private route"];

fn route_slice(st: &Status) -> [&RouteTraffic; 3] {
    [&st.routes.lan, &st.routes.public_route, &st.routes.private_route]
}

fn route_speed(r: &RouteTraffic) -> f32 {
    let bps = (r.down_bps + r.up_bps) as f32;
    0.07 + 0.85 * (bps / 4_200_000.0).min(1.0)
}

pub fn reciprocity_sentence(rx: u64, tx: u64, ratio: f64) -> String {
    if rx + tx == 0 {
        "Nothing moved yet.".to_string()
    } else if ratio >= 1.0 {
        "You gave more than you took. Thank you.".to_string()
    } else if ratio >= 0.1 {
        let per_ten = (ratio * 10.0).round() as u64;
        format!("You shared {per_ten} GB for every 10 GB you got.")
    } else if tx > 0 {
        "You mostly receive now. Peers take when they ask.".to_string()
    } else {
        "You only received so far.".to_string()
    }
}

impl PearTube {
    pub fn render_network(&self, tab: NetworkTab, cx: &mut Context<Self>) -> impl IntoElement {
        let st = self.status.clone().unwrap_or_default();
        let down_hist: Vec<u64> = self.net_down_hist.iter().copied().collect();
        let up_hist: Vec<u64> = self.net_up_hist.iter().copied().collect();
        let title = match tab {
            NetworkTab::Globe => "Network",
            NetworkTab::Swarm => "Swarm",
            NetworkTab::Flow => "Flow",
        };

        let seg = |id: &'static str, lbl: &'static str, target: NetworkTab, cx: &mut Context<Self>| {
            let active = tab == target;
            div()
                .id(id)
                .px_3()
                .py_1()
                .rounded(px(8.))
                .bg(if active { Hsla::from(rgb(CARD_ELEVATED)) } else { transparent_black() })
                .text_sm()
                .font_weight(if active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                .text_color(if active { rgb(INK) } else { rgb(DIM) })
                .cursor_pointer()
                .hover(|s| s.text_color(rgb(INK)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_room(Room::Network(target), cx);
                }))
                .child(lbl)
        };

        let header = h_flex()
            .justify_between()
            .items_center()
            .flex_wrap()
            .gap_3()
            .child(div().text_2xl().font_weight(FontWeight::BOLD).child(title))
            .child(
                h_flex()
                    .p_1()
                    .gap_1()
                    .rounded(px(10.))
                    .bg(rgb(CARD))
                    .border_1()
                    .border_color(rgb(LINE))
                    .child(seg("net-tab-globe", "Globe", NetworkTab::Globe, cx))
                    .child(seg("net-tab-swarm", "Swarm", NetworkTab::Swarm, cx))
                    .child(seg("net-tab-flow", "Flow", NetworkTab::Flow, cx)),
            );

        column()
            .py_6()
            .gap_5()
            .child(header)
            .child(
                h_flex()
                    .gap_5()
                    .items_start()
                    .flex_wrap()
                    .child(render_scene_card(tab, &st, self.net_phase))
                    .child(render_metrics_column(&st, down_hist, up_hist)),
            )
    }
}

fn render_scene_card(tab: NetworkTab, st: &Status, phase: f32) -> Div {
    let peers = total_peers(st);
    let caption = if peers == 0 {
        "No peers now. Your library still plays from this Mac."
    } else if tab == NetworkTab::Flow {
        "Width is speed."
    } else {
        "Connections, not locations"
    };
    let st_clone = st.clone();

    let scene_canvas: AnyElement = match tab {
        NetworkTab::Globe => canvas(
            move |_, _, _| (st_clone.clone(), phase),
            move |bounds, (s, ph), window, _| paint_globe_scene(bounds, &s, ph, window),
        )
        .size_full()
        .into_any_element(),
        NetworkTab::Swarm => canvas(
            move |_, _, _| (st_clone.clone(), phase),
            move |bounds, (s, ph), window, _| paint_swarm_scene(bounds, &s, ph, window),
        )
        .size_full()
        .into_any_element(),
        NetworkTab::Flow => render_flow_scene(st).into_any_element(),
    };

    div()
        .relative()
        .flex_1()
        .min_w(px(440.))
        .h(px(420.))
        .rounded(px(22.))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .overflow_hidden()
        .child(scene_canvas)
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(px(14.))
                .flex()
                .justify_center()
                .px_4()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(rgb(DIM))
                        .child(caption),
                ),
        )
}

fn render_metrics_column(st: &Status, down_hist: Vec<u64>, up_hist: Vec<u64>) -> Div {
    v_flex()
        .w(px(340.))
        .flex_none()
        .gap_4()
        .child(render_rates_card(st, down_hist, up_hist))
        .child(render_reciprocity_card(st))
        .child(render_routes_card(st))
}

fn render_rates_card(st: &Status, down_hist: Vec<u64>, up_hist: Vec<u64>) -> Div {
    h_flex()
        .p_4()
        .gap_4()
        .rounded(px(18.))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .child(
            v_flex()
                .flex_1()
                .gap_1()
                .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("RECEIVING"))
                .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(BRAND_HOVER)).child(format_rate(st.down_bps)))
                .child(render_sparkline(down_hist, BRAND_HOVER)),
        )
        .child(
            v_flex()
                .flex_1()
                .gap_1()
                .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child("SHARING"))
                .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(ACCENT)).child(format_rate(st.up_bps)))
                .child(render_sparkline(up_hist, ACCENT)),
        )
}

fn render_reciprocity_card(st: &Status) -> Div {
    let rx = st.rx_bytes;
    let tx = st.tx_bytes;
    let total = rx.saturating_add(tx);
    let ratio = if st.reciprocity.ratio > 0.0 {
        st.reciprocity.ratio
    } else if rx > 0 {
        tx as f64 / rx as f64
    } else {
        0.0
    };
    let share_frac = if total > 0 { (tx as f32 / total as f32).clamp(0.0, 1.0) } else { 0.0 };
    let recv_frac = if total > 0 { (1.0 - share_frac).max(0.0) } else { 0.0 };
    let sentence = reciprocity_sentence(rx, tx, ratio);

    v_flex()
        .p_4()
        .gap_3()
        .rounded(px(18.))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(sentence))
        .child(
            h_flex()
                .w_full()
                .h(px(10.))
                .rounded(px(99.))
                .bg(rgb(CARD_ELEVATED))
                .overflow_hidden()
                .when(share_frac > 0.0, |bar| bar.child(div().h_full().w(relative(share_frac)).bg(rgb(ACCENT))))
                .when(recv_frac > 0.0, |bar| bar.child(div().h_full().w(relative(recv_frac)).bg(rgb(BRAND_HOVER)))),
        )
        .child(
            h_flex()
                .justify_between()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .child(div().text_color(rgb(ACCENT)).child(format!("Shared {}", format_bytes(tx))))
                .child(div().text_color(rgb(BRAND_HOVER)).child(format!("Received {}", format_bytes(rx)))),
        )
}

fn render_routes_card(st: &Status) -> Div {
    let routes = route_slice(st);
    let kept_text = if st.cache_max_bytes > 0 {
        format!("Kept {} of {}", format_bytes(st.cached_bytes), format_bytes(st.cache_max_bytes))
    } else {
        format!("Kept {}", format_bytes(st.cached_bytes))
    };

    v_flex()
        .p_4()
        .gap_3()
        .rounded(px(18.))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .child(div().text_sm().font_weight(FontWeight::BOLD).child("Routes"))
        .child(
            v_flex().gap_2().children((0..3).map(|k| {
                let r = routes[k];
                let active = r.peers > 0;
                let rate = if active {
                    format!("↓ {}  ↑ {}", format_rate(r.down_bps), format_rate(r.up_bps))
                } else {
                    "No peers".to_string()
                };
                h_flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .text_xs()
                    .text_color(if active { rgb(INK) } else { rgb(DIM) })
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(div().size(px(8.)).rounded(px(99.)).bg(rgb(ROUTE_COLORS[k])))
                            .child(ROUTE_NAMES[k])
                            .child(div().font_weight(FontWeight::BOLD).child(r.peers.to_string())),
                    )
                    .child(div().text_color(rgb(DIM)).child(rate))
            })),
        )
        .child(
            h_flex()
                .pt_2()
                .border_t_1()
                .border_color(rgb(LINE))
                .justify_between()
                .text_xs()
                .text_color(rgb(DIM))
                .child(kept_text)
                .when(st.blob_bytes > 0, |row| {
                    row.child(format!("Library {}", format_bytes(st.blob_bytes)))
                }),
        )
}

fn render_sparkline(samples: Vec<u64>, color_hex: u32) -> Div {
    div()
        .w_full()
        .h(px(34.))
        .mt_1()
        .child(
            canvas(
                move |_, _, _| samples.clone(),
                move |bounds, data, window, _| paint_sparkline(bounds, &data, color_hex, window),
            )
            .size_full(),
        )
}

fn paint_sparkline(bounds: Bounds<Pixels>, data: &[u64], color_hex: u32, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 4.0 || h < 4.0 || data.len() < 2 {
        return;
    }
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let top = data.iter().copied().max().unwrap_or(1).max(1) as f32;
    let step = w / (data.len() - 1) as f32;
    let mut pb = PathBuilder::stroke(px(1.75));
    for (i, &val) in data.iter().enumerate() {
        let x = ox + i as f32 * step;
        let y = oy + (h - 2.0) - (val as f32 / top) * (h - 4.0);
        if i == 0 {
            pb.move_to(point(px(x), px(y)));
        } else {
            pb.line_to(point(px(x), px(y)));
        }
    }
    if let Ok(path) = pb.build() {
        window.paint_path(path, Hsla::from(rgb(color_hex)));
    }
}

fn paint_circle(window: &mut Window, x: f32, y: f32, r: f32, color: Hsla) {
    if r <= 0.2 {
        return;
    }
    let d = r * 2.0;
    window.paint_quad(PaintQuad {
        bounds: Bounds {
            origin: point(px(x - r), px(y - r)),
            size: size(px(d), px(d)),
        },
        corner_radii: Corners::all(px(r)),
        background: color.into(),
        border_widths: Edges::default(),
        border_color: transparent_black(),
        border_style: BorderStyle::default(),
    });
}

fn paint_ring(window: &mut Window, cx: f32, cy: f32, rad: f32, width: f32, color: Hsla) {
    if rad <= 1.0 {
        return;
    }
    let d = rad * 2.0;
    window.paint_quad(PaintQuad {
        bounds: Bounds {
            origin: point(px(cx - rad), px(cy - rad)),
            size: size(px(d), px(d)),
        },
        corner_radii: Corners::all(px(rad)),
        background: transparent_black().into(),
        border_widths: Edges::all(px(width)),
        border_color: color,
        border_style: BorderStyle::default(),
    });
}

/// Subtle radial brand glow centered at (50%, 42%), matching `.scene` in `sketch.css`.
fn paint_scene_glow(bounds: Bounds<Pixels>, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 20.0 || h < 20.0 {
        return;
    }
    let cx = f32::from(bounds.origin.x) + w * 0.50;
    let cy = f32::from(bounds.origin.y) + h * 0.42;
    let max_r = w.max(h) * 0.56;
    let brand = Hsla::from(rgb(BRAND));
    paint_circle(window, cx, cy, max_r, brand.opacity(0.045));
    paint_circle(window, cx, cy, max_r * 0.72, brand.opacity(0.065));
    paint_circle(window, cx, cy, max_r * 0.46, brand.opacity(0.075));
    paint_circle(window, cx, cy, max_r * 0.24, brand.opacity(0.055));
}

fn paint_globe_scene(bounds: Bounds<Pixels>, st: &Status, phase: f32, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 20.0 || h < 20.0 {
        return;
    }
    paint_scene_glow(bounds, window);
    let cx = f32::from(bounds.origin.x) + w * 0.5;
    let cy = f32::from(bounds.origin.y) + h * 0.46;
    let radius = w.min(h * 1.2) * 0.22;
    let routes = route_slice(st);
    let turns = [
        0.3 + phase * route_speed(routes[0]),
        1.9 + phase * route_speed(routes[1]),
        4.1 + phase * route_speed(routes[2]),
    ];

    for k in (0..3).rev() {
        paint_globe_band(window, cx, cy, radius, k, routes[k], turns[k], false);
    }

    // Globe soft core + dotted Fibonacci sphere
    paint_circle(window, cx, cy, radius, Hsla::from(rgb(CARD)));
    paint_circle(window, cx, cy, radius, Hsla::from(rgb(BRAND)).opacity(0.22));
    paint_ring(window, cx, cy, radius, 1.0, Hsla::from(rgb(LINE)).opacity(0.6));

    let spin = 0.6 + phase * 0.11;
    let (s, q) = spin.sin_cos();
    let (ts, tq) = 0.38_f32.sin_cos();
    let dot_base = Hsla::from(rgb(INK));
    for i in 0..320 {
        let py = 1.0 - (i as f32 + 0.5) / 160.0;
        let r = (1.0 - py * py).max(0.0).sqrt();
        let a = i as f32 * 2.399_963;
        let (sa, ca) = a.sin_cos();
        let px_v = ca * r;
        let pz_v = sa * r;
        let x = px_v * q + pz_v * s;
        let z0 = -px_v * s + pz_v * q;
        let y = py * tq - z0 * ts;
        let z = py * ts + z0 * tq;
        if z < -0.05 {
            continue;
        }
        let alpha = (0.14 + z * 0.48).clamp(0.05, 0.72);
        paint_circle(window, cx + x * radius, cy - y * radius, 0.8 + z * 0.85, dot_base.opacity(alpha));
    }

    for k in 0..3 {
        paint_globe_band(window, cx, cy, radius, k, routes[k], turns[k], true);
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_globe_band(
    window: &mut Window,
    cx: f32,
    cy: f32,
    radius: f32,
    k: usize,
    route: &RouteTraffic,
    turn: f32,
    front: bool,
) {
    const ROLL: [f32; 3] = [-0.20, 0.13, -0.34];
    const REACH: [f32; 3] = [1.42, 1.86, 2.30];
    const SQUASH: f32 = 0.36;

    let (sr, cr) = ROLL[k].sin_cos();
    let reach_r = radius * REACH[k];
    let at = |a: f32| -> (f32, f32, bool) {
        let x = a.cos() * reach_r;
        let y = a.sin() * reach_r * SQUASH;
        (cx + x * cr - y * sr, cy + x * sr + y * cr, a.sin() > 0.0)
    };

    let base_col = if route.peers > 0 {
        Hsla::from(rgb(ROUTE_COLORS[k]))
    } else {
        Hsla::from(rgb(LINE))
    };
    let mut pb = PathBuilder::stroke(px(1.2));
    let start_a = if front { 0.0 } else { PI };
    for i in 0..=36 {
        let (x, y, _) = at(start_a + (i as f32 / 36.0) * PI);
        if i == 0 {
            pb.move_to(point(px(x), px(y)));
        } else {
            pb.line_to(point(px(x), px(y)));
        }
    }
    if let Ok(path) = pb.build() {
        window.paint_path(path, base_col.opacity(if front { 0.50 } else { 0.22 }));
    }

    let n = route.peers.min(36) as usize;
    if n == 0 {
        return;
    }
    let tail = route_speed(route) * 0.55;
    let route_col = Hsla::from(rgb(ROUTE_COLORS[k]));
    for i in 0..n {
        let a = turn + (i as f32 / n as f32) * TAU;
        let (x, y, near) = at(a);
        if near != front {
            continue;
        }
        for j in 1..=5 {
            let (tx, ty, tn) = at(a - tail * (j as f32 / 5.0));
            if tn == front {
                let r = (if front { 4.2 } else { 3.0 }) * (1.0 - j as f32 / 7.0);
                let alpha = (if front { 0.48 } else { 0.22 }) * (1.0 - j as f32 / 6.0);
                paint_circle(window, tx, ty, r, route_col.opacity(alpha));
            }
        }
        paint_circle(
            window,
            x,
            y,
            if front { 5.2 } else { 3.6 },
            route_col.opacity(if front { 1.0 } else { 0.45 }),
        );
    }
}

fn paint_swarm_scene(bounds: Bounds<Pixels>, st: &Status, phase: f32, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 20.0 || h < 20.0 {
        return;
    }
    paint_scene_glow(bounds, window);
    let cx = f32::from(bounds.origin.x) + w * 0.5;
    let cy = f32::from(bounds.origin.y) + h * 0.47;
    let top = w.min(h) * 0.41;
    let rings = [0.42_f32, 0.70, 0.98];
    let routes = route_slice(st);

    for k in (0..3).rev() {
        let r = routes[k];
        let rad = top * rings[k];
        let route_col = Hsla::from(rgb(ROUTE_COLORS[k]));
        let bps = (r.down_bps + r.up_bps) as f32;
        let ring_w = if r.peers > 0 { 1.0 + 4.5 * (bps / 4_200_000.0).min(1.0) } else { 1.0 };
        let ring_col = if r.peers > 0 {
            route_col.opacity(0.50)
        } else {
            Hsla::from(rgb(LINE)).opacity(0.40)
        };
        paint_ring(window, cx, cy, rad, ring_w, ring_col);

        let n = r.peers.min(36) as usize;
        let turn = (k as f32 * 1.6 + 0.3) + phase * route_speed(r);
        for i in 0..n {
            let a = turn * 0.35 + (i as f32 / n as f32) * TAU + k as f32;
            let x = cx + a.cos() * rad;
            let y = cy + a.sin() * rad;
            let mut pb = PathBuilder::stroke(px(1.0));
            pb.move_to(point(px(cx), px(cy)));
            pb.line_to(point(px(x), px(y)));
            if let Ok(path) = pb.build() {
                window.paint_path(path, route_col.opacity(0.22));
            }
            if r.down_bps + r.up_bps > 0 {
                let f = (turn * 0.9 + i as f32 * 0.37).rem_euclid(1.0);
                paint_circle(window, x + (cx - x) * f, y + (cy - y) * f, 2.3, route_col.opacity(0.80));
            }
            paint_circle(window, x, y, 6.0, route_col);
        }
    }

    paint_circle(window, cx, cy, 24.0, Hsla::from(rgb(CARD)));
    paint_circle(window, cx, cy, 24.0, Hsla::from(rgb(BRAND)).opacity(0.30));
    paint_circle(window, cx, cy, 13.0, Hsla::from(rgb(BRAND)));
    paint_circle(window, cx, cy, 5.0, hsla(0., 0., 1., 0.95));
}

fn render_flow_scene(st: &Status) -> Div {
    let st_paint = st.clone();
    let routes = route_slice(st);
    let kept = format!("{} kept", format_bytes(st.cached_bytes));
    let ys = [115.0_f32, 198.0, 281.0];

    let side_labels = |right_side: bool| -> Div {
        let mut col = div()
            .absolute()
            .top_0()
            .bottom_0()
            .w(px(136.))
            .when(!right_side, |d| d.left(px(16.)))
            .when(right_side, |d| d.right(px(16.)))
            .child(
                div()
                    .absolute()
                    .top(px(28.))
                    .left_0()
                    .right_0()
                    .when(right_side, |d| d.text_right())
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(DIM))
                    .child(if right_side { "Shared" } else { "Received" }),
            );
        for k in 0..3 {
            let r = routes[k];
            let bps = if right_side { r.up_bps } else { r.down_bps };
            let sub = if r.peers > 0 { format_rate(bps) } else { "no peers".to_string() };
            col = col.child(
                v_flex()
                    .absolute()
                    .top(px(ys[k] - 18.))
                    .left_0()
                    .right_0()
                    .when(right_side, |d| d.items_end())
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if r.peers > 0 { rgb(INK) } else { rgb(DIM) })
                            .child(ROUTE_NAMES[k]),
                    )
                    .child(div().text_xs().text_color(rgb(DIM)).child(sub)),
            );
        }
        col
    };

    div()
        .relative()
        .size_full()
        .child(
            canvas(
                move |_, _, _| st_paint.clone(),
                move |bounds, s, window, _| paint_flow_ribbons(bounds, &s, window),
            )
            .size_full(),
        )
        .child(side_labels(false))
        .child(side_labels(true))
        .child(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    v_flex()
                        .items_center()
                        .gap_0p5()
                        .child(div().text_sm().font_weight(FontWeight::BOLD).text_color(rgb(INK)).child("This Mac"))
                        .child(div().text_xs().text_color(rgb(DIM)).child(kept)),
                ),
        )
}

fn paint_flow_ribbons(bounds: Bounds<Pixels>, st: &Status, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 120.0 || h < 80.0 {
        return;
    }
    paint_scene_glow(bounds, window);
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let routes = route_slice(st);
    let wide = |bps: u64| -> f32 {
        if bps == 0 {
            0.0
        } else {
            ((bps as f32 / 4_200_000.0) * 40.0).clamp(3.0, 40.0)
        }
    };
    let in_w = [wide(routes[0].down_bps), wide(routes[1].down_bps), wide(routes[2].down_bps)];
    let out_w = [wide(routes[0].up_bps), wide(routes[1].up_bps), wide(routes[2].up_bps)];

    let stack_y = |ws: [f32; 3]| -> [f32; 3] {
        let total = ws[0] + ws[1] + ws[2] + 12.0;
        let mut y = oy + h * 0.47 - total * 0.5;
        let mut mids = [0.0; 3];
        for k in 0..3 {
            mids[k] = y + ws[k] * 0.5;
            y += ws[k] + 6.0;
        }
        mids
    };
    let in_y = stack_y(in_w);
    let out_y = stack_y(out_w);
    let ys = [oy + 115.0, oy + 198.0, oy + 281.0];

    let box_w = 112.0_f32.min(w * 0.24);
    let box_h = 152.0_f32.min(h * 0.52);
    let box_x = ox + (w - box_w) * 0.5;
    let box_y = oy + (h * 0.47 - box_h * 0.5);
    let left_x = ox + 150.0_f32.min(w * 0.25);
    let right_x = ox + w - 150.0_f32.min(w * 0.25);

    for k in 0..3 {
        let col = Hsla::from(rgb(ROUTE_COLORS[k])).opacity(0.62);
        if in_w[k] > 0.0 {
            let mid_x = (left_x + box_x) * 0.5;
            let mut pb = PathBuilder::stroke(px(in_w[k]));
            pb.move_to(point(px(left_x), px(ys[k])));
            pb.cubic_bezier_to(
                point(px(box_x), px(in_y[k])),
                point(px(mid_x), px(ys[k])),
                point(px(mid_x), px(in_y[k])),
            );
            if let Ok(path) = pb.build() {
                window.paint_path(path, col);
            }
        }
        if out_w[k] > 0.0 {
            let mid_x = (box_x + box_w + right_x) * 0.5;
            let mut pb = PathBuilder::stroke(px(out_w[k]));
            pb.move_to(point(px(box_x + box_w), px(out_y[k])));
            pb.cubic_bezier_to(
                point(px(right_x), px(ys[k])),
                point(px(mid_x), px(out_y[k])),
                point(px(mid_x), px(ys[k])),
            );
            if let Ok(path) = pb.build() {
                window.paint_path(path, col);
            }
        }
    }

    // Central cache tank
    window.paint_quad(PaintQuad {
        bounds: Bounds {
            origin: point(px(box_x), px(box_y)),
            size: size(px(box_w), px(box_h)),
        },
        corner_radii: Corners::all(px(16.)),
        background: Hsla::from(rgb(CARD_ELEVATED)).into(),
        border_widths: Edges::all(px(1.)),
        border_color: Hsla::from(rgb(LINE)),
        border_style: BorderStyle::default(),
    });
    let full = if st.cache_max_bytes > 0 {
        (st.cached_bytes as f32 / st.cache_max_bytes as f32).clamp(0.0, 1.0)
    } else if st.cached_bytes > 0 {
        0.35
    } else {
        0.0
    };
    if full > 0.01 {
        let pad = 10.0;
        let inner_h = (box_h - pad * 2.0) * full;
        window.paint_quad(PaintQuad {
            bounds: Bounds {
                origin: point(px(box_x + pad), px(box_y + box_h - pad - inner_h)),
                size: size(px(box_w - pad * 2.0), px(inner_h)),
            },
            corner_radii: Corners::all(px(9.)),
            background: Hsla::from(rgb(BRAND)).opacity(0.45).into(),
            border_widths: Edges::default(),
            border_color: transparent_black(),
            border_style: BorderStyle::default(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::reciprocity_sentence;

    #[test]
    fn reciprocity_messages_cover_all_bands() {
        assert_eq!(reciprocity_sentence(0, 0, 0.0), "Nothing moved yet.");
        assert_eq!(reciprocity_sentence(100, 150, 1.5), "You gave more than you took. Thank you.");
        assert_eq!(reciprocity_sentence(1000, 400, 0.4), "You shared 4 GB for every 10 GB you got.");
        assert_eq!(reciprocity_sentence(1000, 20, 0.02), "You mostly receive now. Peers take when they ask.");
        assert_eq!(reciprocity_sentence(1000, 0, 0.0), "You only received so far.");
    }
}
