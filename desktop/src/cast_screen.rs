//! Zero-pairing Cast chooser popup overlay and floating Mini Remote for macOS sender clients.

use std::time::Duration;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::json;

use crate::app::PearTube;
use crate::list::column;
use crate::play::clock;
use crate::theme::{ACCENT, BG, BRAND, CARD, CARD_ELEVATED, DANGER, DIM, INK, LINE};

pub struct CastSheetForm {
    pub pending_entry: Option<(String, String, u64)>,
    pub error: Option<SharedString>,
}

impl CastSheetForm {
    pub fn new(pending_entry: Option<(String, String, u64)>) -> Self {
        CastSheetForm {
            pending_entry,
            error: None,
        }
    }
}

impl PearTube {
    /// Renders the Cast chooser as a modal popup over the active screen (including
    /// directly over a playing video without interrupting playback).
    pub fn render_cast_popup(&self, form: &CastSheetForm, cx: &mut Context<Self>) -> impl IntoElement {
        let receivers = self.cast.receivers.clone();
        let headline = match &form.pending_entry {
            Some((_, title, pos)) if *pos > 0 => format!("Play \"{title}\" from {}", clock(Duration::from_millis(*pos))),
            Some((_, title, _)) => format!("Play \"{title}\" on…"),
            None => "Choose a screen".into(),
        };

        let rows: Vec<_> = receivers
            .into_iter()
            .map(|r| {
                let rec_id = r.id.clone();
                let rm_id = r.id.clone();
                let active = self.cast.session.as_ref().is_some_and(|s| s.receiver_id == r.id);
                h_flex()
                    .id(SharedString::from(format!("cast-row-{}", r.id)))
                    .justify_between()
                    .items_center()
                    .p_3p5()
                    .rounded(px(14.))
                    .bg(rgb(BG))
                    .border_1()
                    .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                    .on_click(cx.listener(move |this, _, window, cx| this.cast_to_receiver(rec_id.clone(), window, cx)))
                    .child(
                        h_flex()
                            .items_center()
                            .gap_3()
                            .child(Icon::new(Lucide::Tv).text_color(if r.online { rgb(ACCENT) } else { rgb(DIM) }))
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(INK)).child(r.name.clone()))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(if active {
                                        "Connected"
                                    } else if r.current == Some(false) {
                                        "Needs update"
                                    } else if r.online {
                                        "Ready on Wi-Fi · Click to play"
                                    } else {
                                        "Saved TV"
                                    })),
                            ),
                    )
                    .child(
                        h_flex()
                            .items_center()
                            .gap_1p5()
                            .when(!r.online, |this| {
                                this.child(
                                    div()
                                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                        .child(
                                            Button::new(SharedString::from(format!("cast-rm-{rm_id}")))
                                                .ghost()
                                                .small()
                                                .icon(IconName::Close)
                                                .tooltip("Forget TV")
                                                .on_click(cx.listener(move |this, _, _, cx| this.remove_cast_receiver(rm_id.clone(), cx))),
                                        ),
                                )
                            })
                            .child(Icon::new(Lucide::ChevronRight).text_color(rgb(DIM))),
                    )
            })
            .collect();

        div()
            .id("cast-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(hsla(0., 0., 0., 0.62))
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| this.close_cast_modal(cx)))
            .child(
                v_flex()
                    .id("cast-modal-card")
                    .w(px(500.))
                    .max_w_full()
                    .max_h(px(520.))
                    .rounded(px(22.))
                    .bg(rgb(CARD))
                    .border_1()
                    .border_color(rgb(LINE))
                    .overflow_hidden()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        h_flex()
                            .justify_between()
                            .items_center()
                            .px_5()
                            .py_4()
                            .border_b_1()
                            .border_color(rgb(LINE))
                            .child(div().flex_1().truncate().text_base().font_weight(FontWeight::BOLD).text_color(rgb(INK)).child(headline))
                            .child(
                                Button::new("close-cast-modal")
                                    .ghost()
                                    .small()
                                    .icon(IconName::Close)
                                    .tooltip("Close")
                                    .on_click(cx.listener(|this, _, _, cx| this.close_cast_modal(cx))),
                            ),
                    )
                    .child(
                        div()
                            .id("cast-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scrollbar()
                            .child(
                                v_flex()
                                    .p_5()
                                    .gap_3()
                                    .when_some(form.error.clone(), |this, err| this.child(div().text_sm().text_color(rgb(DANGER)).child(err)))
                                    .when(rows.is_empty(), |this| {
                                        this.child(
                                            v_flex()
                                                .p_6()
                                                .gap_2()
                                                .items_center()
                                                .text_center()
                                                .rounded(px(16.))
                                                .bg(rgb(BG))
                                                .border_1()
                                                .border_color(rgb(LINE))
                                                .child(Icon::new(Lucide::Tv).text_color(rgb(DIM)))
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(INK)).child("Looking for screens on your Wi-Fi…"))
                                                .child(div().text_xs().text_color(rgb(DIM)).child("Launch PearTube Receiver on your TV device, and it will appear right here automatically.")),
                                        )
                                    })
                                    .children(rows),
                            ),
                    ),
            )
    }

    pub fn render_cast_remote_bar(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let session = self.cast.session.as_ref()?;
        let st = &session.state;
        let title = st.entry.as_ref().map(|e| e.title.clone()).unwrap_or_else(|| session.receiver_name.clone());
        let mode_lbl = match st.mode.as_deref() {
            Some("private-p2p") => format!(" · Private P2P ({} peers)", st.p2p_peers),
            Some("p2p") => format!(" · P2P Seeding ({} peers)", st.p2p_peers),
            _ => String::new(),
        };
        let pos = Duration::from_millis(st.position_ms);
        let time_str = match st.duration_ms {
            Some(d) if d > 0 => format!("{} / {}", clock(pos), clock(Duration::from_millis(d))),
            _ => clock(pos),
        };
        let playing = st.playing;
        let has_entry = st.entry.is_some();

        Some(
            div()
                .border_t_1()
                .border_color(rgb(LINE))
                .bg(rgb(CARD))
                .child(
                    column()
                        .py_2p5()
                        .child(
                            h_flex()
                                .justify_between()
                                .items_center()
                                .gap_4()
                                .child(
                                    h_flex()
                                        .items_center()
                                        .gap_3()
                                        .flex_1()
                                        .min_w_0()
                                        .child(Icon::new(Lucide::Cast).text_color(rgb(BRAND)))
                                        .child(
                                            v_flex()
                                                .flex_1()
                                                .min_w_0()
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(title))
                                                .child(div().text_xs().text_color(rgb(DIM)).child(format!("{}{mode_lbl} · {time_str}", session.receiver_name))),
                                        ),
                                )
                                .child(
                                    h_flex()
                                        .items_center()
                                        .gap_1p5()
                                        .when(has_entry, |this| {
                                            this.child(Button::new("rc-back10").ghost().small().icon(Icon::new(Lucide::RotateCcw)).on_click(cx.listener(|this, _, _, cx| {
                                                this.send_cast_control(json!({ "action": "skip", "deltaMs": -10000 }), cx);
                                            })))
                                            .child(
                                                Button::new("rc-toggle")
                                                    .primary()
                                                    .small()
                                                    .icon(if playing { IconName::Pause } else { IconName::Play })
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.send_cast_control(json!({ "action": "togglePlay" }), cx);
                                                    })),
                                            )
                                            .child(Button::new("rc-fwd10").ghost().small().icon(IconName::RotateCw).on_click(cx.listener(|this, _, _, cx| {
                                                this.send_cast_control(json!({ "action": "skip", "deltaMs": 10000 }), cx);
                                            })))
                                        })
                                        .child(Button::new("rc-sheet").ghost().small().label("Screens").on_click(cx.listener(|this, _, window, cx| {
                                            this.open_cast_sheet(None, window, cx);
                                        })))
                                        .child(Button::new("rc-detach").ghost().small().label("Detach").on_click(cx.listener(|this, _, _, cx| {
                                            this.detach_casting(cx);
                                        })))
                                        .child(Button::new("rc-stop").ghost().small().icon(IconName::Close).tooltip("Stop casting").on_click(cx.listener(|this, _, _, cx| {
                                            this.stop_casting(cx);
                                        }))),
                                ),
                        ),
                ),
        )
    }
}
