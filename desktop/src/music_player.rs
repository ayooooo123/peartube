//! Music player views:
//! 1. Bottom mini-player dock (visible whenever a music list exists and not in video playback).
//! 2. Full two-column `Playing` view (left: large sleeve, track, artist link, seek slider,
//!    transport controls, `1 of N`; right: `Playing from …`, done tracks dim, active track
//!    marked, upcoming rows with remove, and `Clear`).

#![forbid(unsafe_code)]

use std::time::Duration;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::slider::Slider;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::playback::clock;

use crate::app::{DetailView, PearTube};
use crate::catalog::fold;
use crate::list::column;
use crate::music::RepeatMode;
use crate::sleeves::album_sleeve;
use crate::theme::{BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

impl PearTube {
    /// Bottom mini-player dock (Rule 3, Rule 14, Rule 15).
    pub fn render_music_dock(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let cur = self.music_queue.current()?.clone();
        let pos_ms = self.music_position_ms();
        let dur_ms = self.music_duration_ms();
        let ratio = if dur_ms > 0 {
            (pos_ms as f32 / dur_ms as f32).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let playing = self.music_is_playing();
        let paused_for_video = self.music_queue.paused_for_video;
        let shuffle = self.music_queue.shuffle;
        let repeat = self.music_queue.repeat;

        let sub_text = if paused_for_video {
            "Paused for a video".to_string()
        } else if !cur.artist.is_empty() && !cur.album.is_empty() {
            format!("{} · {}", cur.artist, cur.album)
        } else if !cur.artist.is_empty() {
            cur.artist.clone()
        } else {
            cur.album.clone()
        };

        let time_label = if dur_ms > 0 {
            format!(
                "{} / {}",
                clock(Duration::from_millis(pos_ms)),
                clock(Duration::from_millis(dur_ms))
            )
        } else {
            clock(Duration::from_millis(pos_ms))
        };

        let alb_key = cur.album_key.clone();
        let is_playing_view = matches!(self.detail, Some(DetailView::Playing));

        let repeat_icon = if repeat == RepeatMode::One {
            Lucide::Repeat1
        } else {
            Lucide::Repeat
        };

        Some(
            v_flex()
                .id("music-dock")
                .w_full()
                .bg(rgb(CARD))
                .border_t_1()
                .border_color(rgb(LINE))
                // 2px violet progress edge across the top of the dock
                .child(
                    div()
                        .w_full()
                        .h(px(2.))
                        .bg(hsla(0., 0., 1., 0.08))
                        .child(div().h_full().w(relative(ratio)).bg(rgb(BRAND))),
                )
                .child(
                    h_flex()
                        .w_full()
                        .px_4()
                        .py_2p5()
                        .items_center()
                        .justify_between()
                        .gap_4()
                        // Left: sleeve, track, artist · album (or Paused for a video)
                        .child(
                            h_flex()
                                .id("dock-track-info")
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .gap_3()
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if !alb_key.is_empty() {
                                        this.open_detail(DetailView::Album(alb_key.clone()), cx);
                                    } else {
                                        this.open_detail(DetailView::Playing, cx);
                                    }
                                }))
                                .child(album_sleeve(cur.hue, cur.seed, &cur.monogram, 44.))
                                .child(
                                    v_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .gap_0p5()
                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(cur.title))
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(if paused_for_video { rgb(BRAND) } else { rgb(DIM) })
                                                .truncate()
                                                .child(sub_text),
                                        ),
                                ),
                        )
                        // Center: Previous, Play/Pause, Next, elapsed / total
                        .child(
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    Button::new("dock-prev")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::SkipBack))
                                        .tooltip("Previous")
                                        .on_click(cx.listener(|this, _, window, cx| this.music_previous(window, cx))),
                                )
                                .child(
                                    Button::new("dock-play-pause")
                                        .primary()
                                        .small()
                                        .icon(Icon::new(if playing { Lucide::Pause } else { Lucide::Play }))
                                        .tooltip(if playing { "Pause" } else { "Play" })
                                        .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx))),
                                )
                                .child(
                                    Button::new("dock-next")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::SkipForward))
                                        .tooltip("Next")
                                        .on_click(cx.listener(|this, _, window, cx| this.music_next(window, cx))),
                                )
                                .child(div().pl_2().text_xs().text_color(rgb(DIM)).child(time_label)),
                        )
                        // Right: Shuffle, Repeat, Up next / Open player
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1()
                                .child(
                                    Button::new("dock-shuffle")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::Shuffle).text_color(if shuffle { rgb(BRAND) } else { rgb(DIM) }))
                                        .tooltip(if shuffle { "Shuffle on" } else { "Shuffle" })
                                        .on_click(cx.listener(|this, _, _, cx| this.music_toggle_shuffle(cx))),
                                )
                                .child(
                                    Button::new("dock-repeat")
                                        .ghost()
                                        .small()
                                        .icon(
                                            Icon::new(repeat_icon)
                                                .text_color(if repeat != RepeatMode::Off { rgb(BRAND) } else { rgb(DIM) }),
                                        )
                                        .tooltip(repeat.label())
                                        .on_click(cx.listener(|this, _, _, cx| this.music_cycle_repeat(cx))),
                                )
                                .child(
                                    Button::new("dock-up-next")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::ListMusic).text_color(if is_playing_view { rgb(BRAND) } else { rgb(INK) }))
                                        .label(if is_playing_view { "Close player" } else { "Up next" })
                                        .tooltip(if is_playing_view { "Close player" } else { "Open player" })
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if matches!(this.detail, Some(DetailView::Playing)) {
                                                this.close_detail(cx);
                                            } else {
                                                this.open_detail(DetailView::Playing, cx);
                                            }
                                        })),
                                )
                                .child(
                                    Button::new("dock-stop")
                                        .ghost()
                                        .small()
                                        .icon(IconName::Close)
                                        .tooltip("Stop")
                                        .on_click(cx.listener(|this, _, _, cx| this.music_stop(cx))),
                                ),
                        ),
                ),
        )
    }

    /// Full two-column music player (`Playing` view).
    pub fn render_playing_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(cur) = self.music_queue.current().cloned() else {
            return column()
                .py_16()
                .gap_3()
                .items_center()
                .child(div().text_base().text_color(rgb(DIM)).child("Nothing is playing right now."))
                .child(
                    Button::new("playing-empty-back")
                        .ghost()
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                )
                .into_any_element();
        };

        let pos_ms = self.music_position_ms();
        let dur_ms = self.music_duration_ms();
        let playing = self.music_is_playing();
        let paused_for_video = self.music_queue.paused_for_video;
        let shuffle = self.music_queue.shuffle;
        let repeat = self.music_queue.repeat;
        let repeat_icon = if repeat == RepeatMode::One {
            Lucide::Repeat1
        } else {
            Lucide::Repeat
        };
        let pos_label = self.music_queue.position_label();
        let source_label = if self.music_queue.source_label.is_empty() {
            cur.album.clone()
        } else {
            self.music_queue.source_label.clone()
        };

        let artist_key = fold(&cur.artist);
        let album_key = cur.album_key.clone();
        let played_rows: Vec<_> = self
            .music_queue
            .played_items()
            .into_iter()
            .map(|(idx, t)| (idx, t.clone()))
            .collect();
        let up_next_rows: Vec<_> = self
            .music_queue
            .up_next()
            .into_iter()
            .map(|(idx, t)| (idx, t.clone()))
            .collect();
        let has_up_next = !up_next_rows.is_empty();

        let seek_slider = self.music_seek.as_ref().map(|(state, _)| state.clone());

        column()
            .py_6()
            .gap_6()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(
                        Button::new("playing-close")
                            .ghost()
                            .small()
                            .icon(Icon::new(Lucide::ChevronLeft))
                            .label("Close player")
                            .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                    )
                    .child(div().text_xs().text_color(rgb(DIM)).child(pos_label)),
            )
            .child(
                h_flex()
                    .items_start()
                    .gap_8()
                    // Left column: large sleeve, track, clickable artist, seek slider, controls
                    .child(
                        v_flex()
                            .w(px(340.))
                            .flex_none()
                            .gap_4()
                            .child(album_sleeve(cur.hue, cur.seed, &cur.monogram, 320.))
                            .child(
                                v_flex()
                                    .gap_1()
                                    .child(div().text_xl().font_weight(FontWeight::BOLD).child(cur.title.clone()))
                                    .when(!cur.artist.is_empty(), |d| {
                                        let ak = artist_key.clone();
                                        d.child(
                                            div()
                                                .id("playing-artist-link")
                                                .text_sm()
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(rgb(BRAND))
                                                .cursor_pointer()
                                                .hover(|s| s.underline())
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_detail(DetailView::Artist(ak.clone()), cx);
                                                }))
                                                .child(cur.artist.clone()),
                                        )
                                    })
                                    .when(paused_for_video, |d| {
                                        d.child(div().text_xs().text_color(rgb(BRAND)).child("Paused for a video"))
                                    })
                                    .when_some(self.music_state.error.clone(), |d, err| {
                                        d.child(div().text_xs().text_color(rgb(0xff7d7d)).child(err))
                                    }),
                            )
                            // Seek slider + clocks
                            .child(
                                v_flex()
                                    .gap_1p5()
                                    .when_some(seek_slider, |d, slider| d.child(Slider::new(&slider)))
                                    .child(
                                        h_flex()
                                            .justify_between()
                                            .text_xs()
                                            .text_color(rgb(DIM))
                                            .child(clock(Duration::from_millis(pos_ms)))
                                            .child(if dur_ms > 0 {
                                                clock(Duration::from_millis(dur_ms))
                                            } else {
                                                String::new()
                                            }),
                                    ),
                            )
                            // Transport row (Rule 15: Shuffle and Next stay enabled/visible even with 1 of 1)
                            .child(
                                h_flex()
                                    .items_center()
                                    .justify_between()
                                    .pt_1()
                                    .child(
                                        Button::new("playing-shuffle")
                                            .ghost()
                                            .icon(Icon::new(Lucide::Shuffle).text_color(if shuffle { rgb(BRAND) } else { rgb(DIM) }))
                                            .tooltip(if shuffle { "Shuffle on" } else { "Shuffle" })
                                            .on_click(cx.listener(|this, _, _, cx| this.music_toggle_shuffle(cx))),
                                    )
                                    .child(
                                        h_flex()
                                            .items_center()
                                            .gap_2()
                                            .child(
                                                Button::new("playing-prev")
                                                    .ghost()
                                                    .icon(Icon::new(Lucide::SkipBack))
                                                    .tooltip("Previous")
                                                    .on_click(cx.listener(|this, _, window, cx| this.music_previous(window, cx))),
                                            )
                                            .child(
                                                Button::new("playing-toggle")
                                                    .primary()
                                                    .icon(Icon::new(if playing { Lucide::Pause } else { Lucide::Play }))
                                                    .tooltip(if playing { "Pause" } else { "Play" })
                                                    .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx))),
                                            )
                                            .child(
                                                Button::new("playing-next")
                                                    .ghost()
                                                    .icon(Icon::new(Lucide::SkipForward))
                                                    .tooltip("Next")
                                                    .on_click(cx.listener(|this, _, window, cx| this.music_next(window, cx))),
                                            ),
                                    )
                                    .child(
                                        Button::new("playing-repeat")
                                            .ghost()
                                            .icon(
                                                Icon::new(repeat_icon)
                                                    .text_color(if repeat != RepeatMode::Off { rgb(BRAND) } else { rgb(DIM) }),
                                            )
                                            .tooltip(repeat.label())
                                            .on_click(cx.listener(|this, _, _, cx| this.music_cycle_repeat(cx))),
                                    ),
                            ),
                    )
                    // Right column: Playing from … and Up next
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_3()
                            .child(
                                h_flex()
                                    .justify_between()
                                    .items_center()
                                    .child(
                                        v_flex()
                                            .gap_0p5()
                                            .child(div().text_xs().text_color(rgb(DIM)).child("Playing from"))
                                            .child(
                                                div()
                                                    .id("playing-source-link")
                                                    .text_base()
                                                    .font_weight(FontWeight::BOLD)
                                                    .cursor_pointer()
                                                    .hover(|s| s.text_color(rgb(BRAND)))
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        if !album_key.is_empty() {
                                                            this.open_detail(DetailView::Album(album_key.clone()), cx);
                                                        }
                                                    }))
                                                    .child(source_label),
                                            ),
                                    )
                                    .when(has_up_next, |d| {
                                        d.child(
                                            Button::new("playing-clear")
                                                .ghost()
                                                .small()
                                                .label("Clear")
                                                .on_click(cx.listener(|this, _, _, cx| this.music_clear_up_next(cx))),
                                        )
                                    }),
                            )
                            .child(
                                v_flex()
                                    .border_t_1()
                                    .border_color(rgb(LINE))
                                    // Done tracks (dim)
                                    .children(played_rows.into_iter().map(|(o_idx, t)| {
                                        h_flex()
                                            .id(SharedString::from(format!("q-done-{o_idx}")))
                                            .items_center()
                                            .gap_3()
                                            .px_2()
                                            .py_2()
                                            .border_b_1()
                                            .border_color(hsla(0., 0., 1., 0.04))
                                            .opacity(0.55)
                                            .cursor_pointer()
                                            .hover(|s| s.opacity(0.9).bg(hsla(0., 0., 1., 0.03)))
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.music_jump_to(o_idx, window, cx);
                                            }))
                                            .child(div().w(px(28.)).text_xs().text_right().text_color(rgb(DIM)).child(format!("{}", o_idx + 1)))
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .child(div().text_sm().truncate().child(t.title))
                                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(t.artist)),
                                            )
                                    }))
                                    // Currently playing track (marked in violet)
                                    .child(
                                        h_flex()
                                            .id("q-current")
                                            .items_center()
                                            .gap_3()
                                            .px_2()
                                            .py_2p5()
                                            .bg(rgb(CARD_ELEVATED))
                                            .border_b_1()
                                            .border_color(rgb(LINE))
                                            .child(div().w(px(28.)).text_xs().text_right().text_color(rgb(BRAND)).child("▶"))
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(BRAND)).truncate().child(cur.title))
                                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(cur.artist)),
                                            ),
                                    )
                                    // Up next
                                    .when(has_up_next, |d| {
                                        d.child(
                                            div()
                                                .pt_3()
                                                .pb_1()
                                                .px_2()
                                                .text_xs()
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .text_color(rgb(DIM))
                                                .child("Up next"),
                                        )
                                    })
                                    .children(up_next_rows.into_iter().map(|(o_idx, t)| {
                                        h_flex()
                                            .id(SharedString::from(format!("q-next-{o_idx}")))
                                            .items_center()
                                            .gap_3()
                                            .px_2()
                                            .py_2()
                                            .border_b_1()
                                            .border_color(hsla(0., 0., 1., 0.04))
                                            .cursor_pointer()
                                            .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.music_jump_to(o_idx, window, cx);
                                            }))
                                            .child(div().w(px(28.)).text_xs().text_right().text_color(rgb(DIM)).child(format!("{}", o_idx + 1)))
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .child(div().text_sm().truncate().child(t.title))
                                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(t.artist)),
                                            )
                                            .child(
                                                div()
                                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                                    .child(
                                                        Button::new(SharedString::from(format!("q-rm-{o_idx}")))
                                                            .ghost()
                                                            .small()
                                                            .icon(IconName::Close)
                                                            .tooltip("Remove")
                                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                                this.music_remove_at(o_idx, cx);
                                                            })),
                                                    ),
                                            )
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }
}
