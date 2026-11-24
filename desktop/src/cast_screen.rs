//! TVs dialog (active TV remote, paired TVs with actionable states, `Forget`
//! confirmation, and `Pair a TV…` with `Code on the TV`) plus bottom TV remote bar.
//! Never shows a TV's IP address (`design/unified-library.md`).

#![forbid(unsafe_code)]

use std::time::Duration;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::CastReceiver;
use serde_json::json;

use crate::app::PearTube;
use crate::list::column;
use crate::play::clock;
use crate::theme::{ACCENT, BG, BRAND, CARD, CARD_ELEVATED, DANGER, DIM, INK, LINE};

pub struct CastSheetForm {
    pub pending_entry: Option<(String, String, u64)>,
    pub pair_input: Entity<InputState>,
    pub pairing_for_id: Option<String>,
    pub confirm_forget_id: Option<String>,
    pub busy: bool,
    pub error: Option<SharedString>,
}

impl CastSheetForm {
    pub fn new(
        pending_entry: Option<(String, String, u64)>,
        window: &mut Window,
        cx: &mut Context<PearTube>,
    ) -> Self {
        let pair_input = cx.new(|cx| InputState::new(window, cx).placeholder("K7M2QX"));
        CastSheetForm {
            pending_entry,
            pair_input,
            pairing_for_id: None,
            confirm_forget_id: None,
            busy: false,
            error: None,
        }
    }
}

fn tv_state_label(r: &CastReceiver, active: bool) -> &'static str {
    if active {
        "Playing"
    } else if r.current == Some(false) {
        "Needs an update"
    } else if !r.paired && r.auth != "open" {
        "Needs its code"
    } else {
        "Ready"
    }
}

impl PearTube {
    /// Renders the `TVs` dialog as a modal overlay (works over any screen,
    /// including directly over a playing video).
    pub fn render_cast_popup(&self, form: &CastSheetForm, cx: &mut Context<Self>) -> impl IntoElement {
        let receivers = self.cast.receivers.clone();
        let active_session = self.cast.session.clone();
        let headline = match &form.pending_entry {
            Some((_, title, pos)) if *pos > 0 => {
                format!("Play \"{title}\" on a TV ({})", clock(Duration::from_millis(*pos)))
            }
            Some((_, title, _)) => format!("Play \"{title}\" on a TV"),
            None => "TVs".into(),
        };

        let confirm_id = form.confirm_forget_id.clone();

        let rows: Vec<_> = receivers
            .into_iter()
            .map(|r| {
                let rec_id = r.id.clone();
                let click_id = r.id.clone();
                let forget_id = r.id.clone();
                let confirm_forget_id = r.id.clone();
                let active = active_session
                    .as_ref()
                    .is_some_and(|s| s.receiver_id == r.id);
                let outdated = r.current == Some(false);
                let needs_code = !r.paired && r.auth != "open" && !outdated;
                let state = tv_state_label(&r, active);
                let asking_forget = confirm_id.as_deref() == Some(r.id.as_str());
                let can_forget = r.paired;

                v_flex()
                    .id(SharedString::from(format!("cast-row-{}", r.id)))
                    .rounded(px(12.))
                    .bg(rgb(BG))
                    .border_1()
                    .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                    .child(
                        h_flex()
                            .id(SharedString::from(format!("cast-row-hit-{}", r.id)))
                            .justify_between()
                            .items_center()
                            .p_3p5()
                            .when(!outdated, |d| {
                                d.cursor_pointer()
                                    .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if needs_code {
                                            if let Some(f) = &mut this.cast_modal {
                                                f.pairing_for_id = Some(click_id.clone());
                                                f.error = None;
                                                window.focus(&f.pair_input.read(cx).focus_handle(cx), cx);
                                            }
                                            cx.notify();
                                        } else {
                                            this.cast_to_receiver(click_id.clone(), window, cx);
                                        }
                                    }))
                            })
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_3()
                                    .child(Icon::new(Lucide::Tv).text_color(if active {
                                        rgb(ACCENT)
                                    } else if r.online && !outdated {
                                        rgb(INK)
                                    } else {
                                        rgb(DIM)
                                    }))
                                    .child(
                                        v_flex()
                                            .gap_0p5()
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(rgb(INK))
                                                    .child(r.name.clone()),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(if active {
                                                        rgb(ACCENT)
                                                    } else if outdated {
                                                        rgb(DANGER)
                                                    } else {
                                                        rgb(DIM)
                                                    })
                                                    .child(state),
                                            ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_1p5()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                    .when(can_forget && !asking_forget, |this| {
                                        this.child(
                                            Button::new(SharedString::from(format!("cast-forget-{rec_id}")))
                                                .ghost()
                                                .small()
                                                .label("Forget")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    if let Some(f) = &mut this.cast_modal {
                                                        f.confirm_forget_id = Some(forget_id.clone());
                                                    }
                                                    cx.notify();
                                                })),
                                        )
                                    })
                                    .when(!outdated && !asking_forget, |this| {
                                        this.child(Icon::new(Lucide::ChevronRight).text_color(rgb(DIM)))
                                    }),
                            ),
                    )
                    .when(asking_forget, |this| {
                        this.child(
                            h_flex()
                                .justify_between()
                                .items_center()
                                .px_3p5()
                                .py_2p5()
                                .border_t_1()
                                .border_color(rgb(LINE))
                                .bg(rgb(CARD_ELEVATED))
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(rgb(DIM))
                                        .child("Forget this TV? Pairing again needs its code."),
                                )
                                .child(
                                    h_flex()
                                        .gap_1p5()
                                        .child(
                                            Button::new(SharedString::from(format!("cast-forget-cancel-{}", r.id)))
                                                .ghost()
                                                .small()
                                                .label("Cancel")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    if let Some(f) = &mut this.cast_modal {
                                                        f.confirm_forget_id = None;
                                                    }
                                                    cx.notify();
                                                })),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("cast-forget-ok-{}", r.id)))
                                                .danger()
                                                .small()
                                                .label("Forget")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    if let Some(f) = &mut this.cast_modal {
                                                        f.confirm_forget_id = None;
                                                    }
                                                    this.remove_cast_receiver(confirm_forget_id.clone(), cx);
                                                })),
                                        ),
                                ),
                        )
                    })
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
                    .w(px(520.))
                    .max_w_full()
                    .max_h(px(580.))
                    .rounded(px(18.))
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
                            .child(
                                div()
                                    .flex_1()
                                    .truncate()
                                    .text_base()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(rgb(INK))
                                    .child(headline),
                            )
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
                                    .gap_4()
                                    .when_some(form.error.clone(), |this, err| {
                                        this.child(div().text_sm().text_color(rgb(DANGER)).child(err))
                                    })
                                    // Active TV remote
                                    .when_some(active_session, |this, sess| {
                                        let st = &sess.state;
                                        let title = st
                                            .entry
                                            .as_ref()
                                            .map(|e| e.title.clone())
                                            .unwrap_or_else(|| sess.receiver_name.clone());
                                        let pos = Duration::from_millis(st.position_ms);
                                        let time_str = match st.duration_ms {
                                            Some(d) if d > 0 => {
                                                format!("{} / {}", clock(pos), clock(Duration::from_millis(d)))
                                            }
                                            _ => clock(pos),
                                        };
                                        let playing = st.playing;
                                        this.child(
                                            v_flex()
                                                .p_4()
                                                .gap_3()
                                                .rounded(px(14.))
                                                .bg(rgb(BG))
                                                .border_1()
                                                .border_color(rgb(BRAND))
                                                .child(
                                                    h_flex()
                                                        .justify_between()
                                                        .items_center()
                                                        .child(
                                                            v_flex()
                                                                .flex_1()
                                                                .min_w_0()
                                                                .gap_0p5()
                                                                .child(
                                                                    div()
                                                                        .text_xs()
                                                                        .text_color(rgb(ACCENT))
                                                                        .child(format!("Playing on {}", sess.receiver_name)),
                                                                )
                                                                .child(
                                                                    div()
                                                                        .text_sm()
                                                                        .font_weight(FontWeight::SEMIBOLD)
                                                                        .truncate()
                                                                        .child(title),
                                                                )
                                                                .child(div().text_xs().text_color(rgb(DIM)).child(time_str)),
                                                        )
                                                        .child(
                                                            Button::new("tv-modal-stop")
                                                                .ghost()
                                                                .small()
                                                                .label("Stop")
                                                                .on_click(cx.listener(|this, _, _, cx| this.stop_casting(cx))),
                                                        ),
                                                )
                                                .child(
                                                    h_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .child(
                                                            Button::new("tv-modal-back10")
                                                                .ghost()
                                                                .small()
                                                                .icon(Icon::new(Lucide::RotateCcw))
                                                                .tooltip("Back 10 seconds")
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.send_cast_control(
                                                                        json!({ "action": "skip", "deltaMs": -10000 }),
                                                                        cx,
                                                                    );
                                                                })),
                                                        )
                                                        .child(
                                                            Button::new("tv-modal-toggle")
                                                                .primary()
                                                                .small()
                                                                .icon(if playing { IconName::Pause } else { IconName::Play })
                                                                .label(if playing { "Pause" } else { "Play" })
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.send_cast_control(json!({ "action": "togglePlay" }), cx);
                                                                })),
                                                        )
                                                        .child(
                                                            Button::new("tv-modal-fwd10")
                                                                .ghost()
                                                                .small()
                                                                .icon(IconName::RotateCw)
                                                                .tooltip("Forward 10 seconds")
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.send_cast_control(
                                                                        json!({ "action": "skip", "deltaMs": 10000 }),
                                                                        cx,
                                                                    );
                                                                })),
                                                        ),
                                                ),
                                        )
                                    })
                                    // Paired & nearby TVs
                                    .when(rows.is_empty(), |this| {
                                        this.child(
                                            v_flex()
                                                .p_5()
                                                .gap_1p5()
                                                .items_center()
                                                .text_center()
                                                .rounded(px(12.))
                                                .bg(rgb(BG))
                                                .border_1()
                                                .border_color(rgb(LINE))
                                                .child(Icon::new(Lucide::Tv).text_color(rgb(DIM)))
                                                .child(
                                                    div()
                                                        .text_sm()
                                                        .font_weight(FontWeight::SEMIBOLD)
                                                        .text_color(rgb(INK))
                                                        .child("Looking for TVs on your network…"),
                                                )
                                                .child(
                                                    div()
                                                        .text_xs()
                                                        .text_color(rgb(DIM))
                                                        .child("Open PearTube Receiver on your TV, or enter its code below."),
                                                ),
                                        )
                                    })
                                    .when(!rows.is_empty(), |this| this.child(v_flex().gap_2().children(rows)))
                                    // Pair a TV…
                                    .child(
                                        v_flex()
                                            .pt_3()
                                            .gap_2()
                                            .border_t_1()
                                            .border_color(rgb(LINE))
                                            .child(
                                                div()
                                                    .text_sm()
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .child("Pair a TV…"),
                                            )
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(rgb(DIM))
                                                    .child("Code on the TV"),
                                            )
                                            .child(
                                                h_flex()
                                                    .gap_2()
                                                    .items_center()
                                                    .child(div().flex_1().child(Input::new(&form.pair_input).cleanable(true)))
                                                    .child(
                                                        Button::new("tv-pair-submit")
                                                            .primary()
                                                            .small()
                                                            .label(if form.busy { "Pairing…" } else { "Pair" })
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.pair_cast_tv(window, cx);
                                                            })),
                                                    ),
                                            ),
                                    ),
                            ),
                    ),
            )
    }

    pub fn render_cast_remote_bar(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let session = self.cast.session.as_ref()?;
        let st = &session.state;
        let title = st
            .entry
            .as_ref()
            .map(|e| e.title.clone())
            .unwrap_or_else(|| session.receiver_name.clone());
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
                    column().py_2p5().child(
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
                                    .child(Icon::new(Lucide::Tv).text_color(rgb(ACCENT)))
                                    .child(
                                        v_flex()
                                            .flex_1()
                                            .min_w_0()
                                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(title))
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(rgb(DIM))
                                                    .child(format!("{} · {time_str}", session.receiver_name)),
                                            ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_1p5()
                                    .when(has_entry, |this| {
                                        this.child(
                                            Button::new("rc-back10")
                                                .ghost()
                                                .small()
                                                .icon(Icon::new(Lucide::RotateCcw))
                                                .tooltip("Back 10 seconds")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.send_cast_control(
                                                        json!({ "action": "skip", "deltaMs": -10000 }),
                                                        cx,
                                                    );
                                                })),
                                        )
                                        .child(
                                            Button::new("rc-toggle")
                                                .primary()
                                                .small()
                                                .icon(if playing { IconName::Pause } else { IconName::Play })
                                                .tooltip(if playing { "Pause" } else { "Play" })
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.send_cast_control(json!({ "action": "togglePlay" }), cx);
                                                })),
                                        )
                                        .child(
                                            Button::new("rc-fwd10")
                                                .ghost()
                                                .small()
                                                .icon(IconName::RotateCw)
                                                .tooltip("Forward 10 seconds")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.send_cast_control(
                                                        json!({ "action": "skip", "deltaMs": 10000 }),
                                                        cx,
                                                    );
                                                })),
                                        )
                                    })
                                    .child(
                                        Button::new("rc-sheet")
                                            .ghost()
                                            .small()
                                            .label("TVs")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.open_cast_sheet(None, window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("rc-stop")
                                            .ghost()
                                            .small()
                                            .label("Stop")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.stop_casting(cx);
                                            })),
                                    ),
                            ),
                    ),
                ),
        )
    }
}
