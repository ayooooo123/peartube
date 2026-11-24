//! Watch room (`Rows`, `Tonight`, `Store`, `Channels`) sharing one video library,
//! plus the Title detail page for movies (all versions), series (seasons, episodes,
//! `Next episode`), and clips.

#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::Entry;

use crate::app::{DetailView, PearTube, Room, WatchKind, WatchProgress, WatchViewMode};
use crate::catalog::{VideoKind, VideoTile, format_time_left, is_saved, monogram, plural, sleeve_hash};
use crate::home::ResumeVideo;
use crate::list::{column, format_bytes, label};
use crate::sleeves::{
    held_dot, hero_primary_btn, hero_progress_bar, hero_secondary_btn, hero_surface, video_art,
};
use crate::theme::{ACCENT, BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

const FALLBACK_EP_SECS: u64 = 42 * 60;
const FALLBACK_MOVIE_SECS: u64 = 100 * 60;
const FALLBACK_CLIP_SECS: u64 = 20 * 60;
const GUIDE_PX_PER_MIN: f32 = 5.0;

static LOCAL_TZ_OFFSET_SECS: LazyLock<i64> = LazyLock::new(|| {
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| parse_tz_offset(s.trim()))
        .unwrap_or(0)
});

fn parse_tz_offset(raw: &str) -> Option<i64> {
    if raw.len() != 5 {
        return None;
    }
    let sign = match raw.as_bytes()[0] {
        b'+' => 1_i64,
        b'-' => -1_i64,
        _ => return None,
    };
    let hours: i64 = raw[1..3].parse().ok()?;
    let mins: i64 = raw[3..5].parse().ok()?;
    Some(sign * (hours * 3600 + mins * 60))
}

fn local_day_secs() -> u64 {
    let utc = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (utc + *LOCAL_TZ_OFFSET_SECS).rem_euclid(86_400) as u64
}

fn format_hhmm(secs: u64) -> String {
    let s = secs % 86_400;
    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
}

fn sort_title_key(title: &str) -> String {
    let lower = title.trim().to_lowercase();
    for prefix in ["the ", "a ", "an "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return rest.trim_start().to_string();
        }
    }
    lower
}

fn index_letter(title: &str) -> char {
    sort_title_key(title)
        .chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| {
            if c.is_ascii_alphabetic() {
                c.to_ascii_uppercase()
            } else {
                '#'
            }
        })
        .unwrap_or('#')
}

struct ChannelItem {
    tile_key: String,
    entry: Entry,
    name: String,
    sub: Option<String>,
    seconds: u64,
}

struct GuideBlock {
    item_idx: usize,
    from_secs: u64,
    to_secs: u64,
    into_secs: u64,
    live: bool,
}

struct ChannelSchedule {
    number: u8,
    label: &'static str,
    items: Vec<ChannelItem>,
    blocks: Vec<GuideBlock>,
    live_idx: usize,
}

fn build_channel_schedule(
    number: u8,
    label_name: &'static str,
    items: Vec<ChannelItem>,
    now_secs: u64,
    start_secs: u64,
    span_secs: u64,
) -> Option<ChannelSchedule> {
    if items.is_empty() {
        return None;
    }
    let total: u64 = items.iter().map(|i| i.seconds.max(60)).sum();
    if total == 0 {
        return None;
    }
    let mut at = start_secs % total;
    let mut idx = 0usize;
    while at >= items[idx].seconds.max(60) {
        at -= items[idx].seconds.max(60);
        idx = (idx + 1) % items.len();
    }
    let mut blocks = Vec::new();
    let mut cursor = start_secs;
    let end = start_secs + span_secs;
    while cursor < end {
        let dur = items[idx].seconds.max(60);
        let len = dur.saturating_sub(at).max(1);
        let to = (cursor + len).min(end);
        let live = now_secs >= cursor && now_secs < cursor + len;
        blocks.push(GuideBlock {
            item_idx: idx,
            from_secs: cursor,
            to_secs: to,
            into_secs: at,
            live,
        });
        cursor += len;
        at = 0;
        idx = (idx + 1) % items.len();
    }
    let live_idx = blocks.iter().position(|b| b.live).unwrap_or(0);
    Some(ChannelSchedule {
        number,
        label: label_name,
        items,
        blocks,
        live_idx,
    })
}

type FeaturedHeroTuple = (
    &'static str,
    String,
    String,
    (usize, usize, bool),
    String,
    Option<f32>,
    Option<(Entry, Option<u64>, bool)>,
    Option<String>,
);

fn featured_hero_data(resume: Option<&ResumeVideo>, tile: Option<VideoTile>) -> Option<FeaturedHeroTuple> {
    if let Some(r) = resume {
        let name = if !r.entry.base_title.is_empty() {
            r.entry.base_title.clone()
        } else {
            r.entry.title.clone()
        };
        let line = format!("{} · {}", label(&r.entry), format_time_left(r.remaining_ms));
        let (saved, total, partial, state) = if let Some(t) = &tile {
            (t.saved, t.items.len(), t.partial, t.state_label())
        } else {
            let s = usize::from(is_saved(&r.entry));
            let p = r.entry.cached_bytes > 0 && s == 0;
            let st = if s > 0 {
                "Saved here"
            } else if p {
                "Partly saved"
            } else {
                "On the network"
            };
            (s, 1, p, st.to_string())
        };
        return Some((
            "CONTINUE",
            name,
            line,
            (saved, total, partial),
            state,
            Some(r.ratio),
            Some((r.entry.clone(), Some(r.position_ms), true)),
            tile.map(|t| t.key),
        ));
    }
    let t = tile?;
    let play_entry = t.items.first().map(|i| (i.entry.clone(), None, false));
    let eye = if t.saved > 0 { "ON THIS RELAY" } else { "IN YOUR LIBRARY" };
    let line = t.subtitle_line(format_bytes);
    let state = t.state_label();
    Some((
        eye,
        t.title.clone(),
        line,
        (t.saved, t.items.len(), t.partial),
        state,
        None,
        play_entry,
        Some(t.key),
    ))
}

fn item_duration_secs(entry: &Entry, kind: VideoKind, history: &HashMap<String, WatchProgress>) -> u64 {
    if let Some(h) = history.get(&entry.id)
        && h.duration_ms >= 60_000
    {
        return h.duration_ms / 1000;
    }
    match kind {
        VideoKind::Series => FALLBACK_EP_SECS,
        VideoKind::Movie => FALLBACK_MOVIE_SECS,
        VideoKind::Clip => FALLBACK_CLIP_SECS,
    }
}

impl PearTube {
    pub fn render_watch(&self, kind: WatchKind, cx: &mut Context<Self>) -> impl IntoElement {
        let mode = self.watch_view;
        let has_videos = !self.catalog.movies.is_empty()
            || !self.catalog.series.is_empty()
            || !self.catalog.clips.is_empty();

        let top_bar = self.render_watch_top_bar(mode, has_videos, cx);
        let body: AnyElement = if !has_videos {
            div()
                .py_16()
                .text_center()
                .text_color(rgb(DIM))
                .child("Nothing to watch yet.")
                .into_any_element()
        } else {
            match mode {
                WatchViewMode::Rows => self.render_watch_rows(kind, cx).into_any_element(),
                WatchViewMode::Tonight => self.render_watch_tonight(cx).into_any_element(),
                WatchViewMode::Store => self.render_watch_store(cx).into_any_element(),
                WatchViewMode::Channels => self.render_watch_channels(cx).into_any_element(),
            }
        };

        column().py_6().gap_6().child(top_bar).child(body)
    }

    fn render_watch_top_bar(&self, mode: WatchViewMode, has_videos: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let title = match mode {
            WatchViewMode::Rows => "Watch",
            WatchViewMode::Tonight => "Tonight",
            WatchViewMode::Store => "Video store",
            WatchViewMode::Channels => "Channels",
        };
        let seg = |id: &'static str, lbl: &'static str, target: WatchViewMode, cx: &mut Context<Self>| {
            let active = mode == target;
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
                .on_click(cx.listener(move |this, _, _, cx| this.set_watch_view(target, cx)))
                .child(lbl)
        };

        let show_top_surprise = has_videos && matches!(mode, WatchViewMode::Store | WatchViewMode::Channels);

        h_flex()
            .justify_between()
            .items_center()
            .flex_wrap()
            .gap_3()
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).child(title))
                    .when(show_top_surprise, |row| {
                        row.child(
                            Button::new("watch-play-something")
                                .small()
                                .icon(Icon::new(Lucide::Sparkles))
                                .label("Play something")
                                .on_click(cx.listener(|this, _, window, cx| this.play_something(window, cx))),
                        )
                    }),
            )
            .when(has_videos, |bar| {
                bar.child(
                    h_flex()
                        .p_1()
                        .gap_1()
                        .rounded(px(10.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(seg("watch-mode-rows", "Rows", WatchViewMode::Rows, cx))
                        .child(seg("watch-mode-tonight", "Tonight", WatchViewMode::Tonight, cx))
                        .child(seg("watch-mode-store", "Store", WatchViewMode::Store, cx))
                        .child(seg("watch-mode-channels", "Channels", WatchViewMode::Channels, cx)),
                )
            })
    }

    fn render_watch_rows(&self, kind: WatchKind, cx: &mut Context<Self>) -> impl IntoElement {
        let saved_only = self.watch_saved_only;
        let source_filter = self.watch_source_filter.as_deref();
        let matches_tile = |t: &VideoTile| -> bool {
            let pass_saved = !saved_only || t.saved > 0;
            let pass_src = source_filter
                .is_none_or(|src| t.items.iter().any(|i| i.entry.source == src));
            pass_saved && pass_src
        };

        let movies: Vec<&VideoTile> = self.catalog.movies.iter().filter(|t| matches_tile(t)).collect();
        let series: Vec<&VideoTile> = self.catalog.series.iter().filter(|t| matches_tile(t)).collect();
        let clips: Vec<&VideoTile> = self.catalog.clips.iter().filter(|t| matches_tile(t)).collect();
        let all_count = movies.len() + series.len() + clips.len();
        let keep_watching = self.unfinished_videos();

        let mut ms_combined: Vec<&VideoTile> = movies.iter().chain(series.iter()).copied().collect();
        ms_combined.sort_by_key(|a| a.title.to_lowercase());

        let featured_hero = if kind == WatchKind::All {
            self.render_watch_featured_hero(&keep_watching, &ms_combined, &clips, cx)
        } else {
            None
        };

        v_flex()
            .gap_6()
            .when_some(featured_hero, |this, hero| this.child(hero))
            .child(self.render_watch_row_filters(&kind, all_count, movies.len(), series.len(), clips.len(), cx))
            .when(kind == WatchKind::All && keep_watching.len() > 1, |this| {
                this.child(self.render_keep_watching_rail(keep_watching, cx))
            })
            .when(kind == WatchKind::All, |this| {
                this.when(all_count == 0, |d| {
                    d.child(div().py_16().text_center().text_color(rgb(DIM)).child("No videos match that filter."))
                })
                .when(!ms_combined.is_empty(), |d| {
                    d.child(self.render_poster_grid("Movies and series", &ms_combined, cx))
                })
                .when(!clips.is_empty(), |d| {
                    d.child(self.render_clips_grid("Clips", &clips, cx))
                })
            })
            .when(kind == WatchKind::Movies, |this| {
                if movies.is_empty() {
                    this.child(div().py_16().text_center().text_color(rgb(DIM)).child("No movies match that filter."))
                } else {
                    this.child(self.render_poster_grid("Movies", &movies, cx))
                }
            })
            .when(kind == WatchKind::Series, |this| {
                if series.is_empty() {
                    this.child(div().py_16().text_center().text_color(rgb(DIM)).child("No series match that filter."))
                } else {
                    this.child(self.render_poster_grid("Series", &series, cx))
                }
            })
            .when(kind == WatchKind::Clips, |this| {
                if clips.is_empty() {
                    this.child(div().py_16().text_center().text_color(rgb(DIM)).child("No clips match that filter."))
                } else {
                    this.child(self.render_clips_grid("Clips", &clips, cx))
                }
            })
    }

    fn render_watch_featured_hero(
        &self,
        keep_watching: &[ResumeVideo],
        ms_combined: &[&VideoTile],
        clips: &[&VideoTile],
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let resume = keep_watching.first();
        let tile = if let Some(r) = resume {
            self.catalog
                .movies
                .iter()
                .chain(self.catalog.series.iter())
                .chain(self.catalog.clips.iter())
                .find(|t| t.items.iter().any(|i| i.entry.key == r.entry.key || i.entry.id == r.entry.id))
                .cloned()
        } else {
            ms_combined
                .iter()
                .copied()
                .find(|t| t.saved > 0)
                .or_else(|| ms_combined.first().copied())
                .or_else(|| clips.iter().copied().find(|t| t.saved > 0))
                .or_else(|| clips.first().copied())
                .cloned()
        };

        let (eyebrow, title, facts, saved_counts, state_txt, ratio, primary_play, details_key) =
            featured_hero_data(resume, tile)?;

        let hue_deg = sleeve_hash(&title) % 360;
        let title_px = if title.chars().count() > 26 { 28. } else { 40. };
        let display_title = title.to_uppercase();

        Some(
            hero_surface(hue_deg, true)
                .w_full()
                .min_h(px(300.))
                .p_7()
                .justify_end()
                .child(
                    v_flex()
                        .relative()
                        .w_full()
                        .gap_3()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::BOLD)
                                .text_color(hsla(0., 0., 1., 0.80))
                                .child(eyebrow),
                        )
                        .child(
                            div()
                                .max_w(px(640.))
                                .text_size(px(title_px))
                                .line_height(relative(0.96))
                                .font_weight(FontWeight::EXTRA_BOLD)
                                .text_color(rgb(0xffffff))
                                .child(display_title),
                        )
                        .child(
                            h_flex()
                                .items_center()
                                .flex_wrap()
                                .gap_2p5()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hsla(0., 0., 1., 0.90))
                                .child(facts)
                                .child(held_dot(saved_counts.0, saved_counts.1, saved_counts.2))
                                .child(state_txt),
                        )
                        .when_some(ratio, |col, r| col.child(hero_progress_bar(r)))
                        .child(
                            h_flex()
                                .pt_1()
                                .gap_2p5()
                                .flex_wrap()
                                .when_some(primary_play, |row, (entry, pos, is_resume)| {
                                    let lbl = if is_resume { "Continue" } else { "Play" };
                                    row.child(
                                        hero_primary_btn("watch-hero-play", Some(Lucide::Play), lbl)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.activate_entry(entry.clone(), pos, window, cx);
                                            })),
                                    )
                                })
                                .child(
                                    hero_secondary_btn(
                                        "watch-hero-surprise",
                                        Some(Lucide::Sparkles),
                                        "Play something",
                                    )
                                    .on_click(cx.listener(|this, _, window, cx| this.play_something(window, cx))),
                                )
                                .when_some(details_key, |row, tk| {
                                    row.child(
                                        hero_secondary_btn("watch-hero-details", None, "Details")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.open_detail(DetailView::Title(tk.clone()), cx);
                                            })),
                                    )
                                }),
                        ),
                ),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn render_watch_row_filters(
        &self,
        kind: &WatchKind,
        all_count: usize,
        movies_len: usize,
        series_len: usize,
        clips_len: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let chip = |id: &'static str, txt: String, target: WatchKind, cx: &mut Context<Self>| {
            let active = *kind == target;
            div()
                .id(id)
                .px_3()
                .py_1()
                .rounded(px(99.))
                .bg(if active { rgb(BRAND) } else { rgb(CARD) })
                .border_1()
                .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                .text_xs()
                .font_weight(if active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                .text_color(if active { rgb(0xffffff) } else { rgb(DIM) })
                .cursor_pointer()
                .hover(|s| if active { s } else { s.text_color(rgb(INK)) })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_room(Room::Watch(target.clone()), cx);
                }))
                .child(txt)
        };
        let sources = self.status.as_ref().map(|s| s.sources.clone()).unwrap_or_default();

        v_flex()
            .gap_2p5()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .flex_wrap()
                    .gap_3()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .flex_wrap()
                            .child(chip("watch-all", format!("All · {all_count}"), WatchKind::All, cx))
                            .child(chip("watch-movies", format!("Movies · {movies_len}"), WatchKind::Movies, cx))
                            .child(chip("watch-series", format!("Series · {series_len}"), WatchKind::Series, cx))
                            .child(chip("watch-clips", format!("Clips · {clips_len}"), WatchKind::Clips, cx)),
                    )
                    .child(
                        Checkbox::new("watch-saved-only")
                            .checked(self.watch_saved_only)
                            .label("Saved here")
                            .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                this.watch_saved_only = *checked;
                                cx.notify();
                            })),
                    ),
            )
            .when(sources.len() > 1, |this| {
                this.child(
                    h_flex()
                        .gap_1p5()
                        .flex_wrap()
                        .child({
                            let active = self.watch_source_filter.is_none();
                            div()
                                .id("watch-src-all")
                                .px_2p5()
                                .py_0p5()
                                .rounded(px(99.))
                                .bg(if active { Hsla::from(rgb(CARD_ELEVATED)) } else { transparent_black() })
                                .border_1()
                                .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                                .text_xs()
                                .text_color(if active { rgb(INK) } else { rgb(DIM) })
                                .cursor_pointer()
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.watch_source_filter = None;
                                    cx.notify();
                                }))
                                .child("All channels")
                        })
                        .children(sources.iter().take(12).map(|src| {
                            let sk = src.key.clone();
                            let active = self.watch_source_filter.as_deref() == Some(src.key.as_str());
                            let name = if !src.alias.is_empty() {
                                src.alias.clone()
                            } else if src.primary {
                                "Main channel".to_string()
                            } else {
                                let short: String = src.key.chars().take(6).collect();
                                format!("{short}…")
                            };
                            div()
                                .id(SharedString::from(format!("watch-src-{}", src.key)))
                                .px_2p5()
                                .py_0p5()
                                .rounded(px(99.))
                                .bg(if active { Hsla::from(rgb(CARD_ELEVATED)) } else { transparent_black() })
                                .border_1()
                                .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                                .text_xs()
                                .text_color(if active { rgb(INK) } else { rgb(DIM) })
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.watch_source_filter = Some(sk.clone());
                                    this.focus_source_bg(sk.clone(), cx);
                                    cx.notify();
                                }))
                                .child(name)
                        })),
                )
            })
    }

    fn render_keep_watching_rail(&self, keep_watching: Vec<ResumeVideo>, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child("Keep watching"))
            .child(
                h_flex()
                    .id("watch-keep-rail")
                    .gap_3()
                    .flex_wrap()
                    .children(keep_watching.into_iter().take(4).map(|item| {
                        let e = item.entry.clone();
                        let pos = item.position_ms;
                        let ratio = item.ratio;
                        let title = if !e.base_title.is_empty() { e.base_title.clone() } else { e.title.clone() };
                        let sub = format!("{} · {}", label(&e), format_time_left(item.remaining_ms));
                        v_flex()
                            .id(SharedString::from(format!("kw-{}", e.key)))
                            .w(px(210.))
                            .rounded(px(12.))
                            .bg(rgb(CARD))
                            .border_1()
                            .border_color(rgb(LINE))
                            .overflow_hidden()
                            .cursor_pointer()
                            .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.activate_entry(e.clone(), Some(pos), window, cx);
                            }))
                            .p_3()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(title))
                            .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub))
                            .child(
                                div()
                                    .h(px(3.))
                                    .w_full()
                                    .rounded(px(2.))
                                    .bg(hsla(0., 0., 1., 0.08))
                                    .child(div().h_full().rounded(px(2.)).w(relative(ratio)).bg(rgb(BRAND))),
                            )
                    })),
            )
    }

    // ---- Tonight: three decision cards + A-Z letter jump bar & alphabetical index ----

    fn render_watch_tonight(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let unfinished = self.unfinished_videos();
        let cont = unfinished.first();
        let next_ep = self.find_next_episode_pick(cont);
        let surprise_tile = self
            .watch_surprise_key
            .as_deref()
            .and_then(|k| self.catalog.video_by_key(k).cloned())
            .or_else(|| self.pick_surprise_video(None, 0));

        let mut all_titles: Vec<&VideoTile> = self
            .catalog
            .movies
            .iter()
            .chain(self.catalog.series.iter())
            .chain(self.catalog.clips.iter())
            .collect();
        all_titles.sort_by_key(|a| sort_title_key(&a.title));
        let letters: Vec<char> = all_titles
            .iter()
            .map(|t| index_letter(&t.title))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        let has_cont = cont.is_some();
        let has_next = next_ep.is_some();

        v_flex()
            .gap_6()
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .items_stretch()
                    .when_some(cont, |row, item| {
                        row.child(self.render_tonight_continue_card(item, cx))
                    })
                    .when_some(next_ep, |row, (title_name, ep)| {
                        row.child(self.render_tonight_next_ep_card(title_name, ep, !has_cont, cx))
                    })
                    .when_some(surprise_tile, |row, tile| {
                        row.child(self.render_tonight_surprise_card(tile, !has_cont && !has_next, cx))
                    }),
            )
            .child(self.render_tonight_az_bar(&letters, cx))
            .child(self.render_tonight_az_index(&all_titles, cx))
    }

    fn find_next_episode_pick(&self, cont: Option<&ResumeVideo>) -> Option<(String, Entry)> {
        let cont_series = cont.map(|c| c.entry.series_key.as_str()).unwrap_or("");
        for tile in &self.catalog.series {
            let mut latest: Option<(u64, usize)> = None;
            for (idx, item) in tile.items.iter().enumerate() {
                if let Some(h) = self.watch_history.get(&item.entry.id)
                    && latest.is_none_or(|(t, _)| h.updated_at > t)
                {
                    latest = Some((h.updated_at, idx));
                }
            }
            if let Some((_, idx)) = latest {
                let target_idx = if tile.items[idx].entry.series_key == cont_series {
                    idx + 1
                } else {
                    let h = self.watch_history.get(&tile.items[idx].entry.id);
                    let done = h.is_some_and(|p| p.duration_ms > 0 && p.position_ms * 100 >= p.duration_ms * 93);
                    if done { idx + 1 } else { idx }
                };
                if let Some(next_item) = tile.items.get(target_idx) {
                    return Some((tile.title.clone(), next_item.entry.clone()));
                }
            }
        }
        None
    }

    fn render_tonight_continue_card(&self, item: &ResumeVideo, cx: &mut Context<Self>) -> impl IntoElement {
        let entry = item.entry.clone();
        let pos = item.position_ms;
        let title = if !entry.base_title.is_empty() { entry.base_title.clone() } else { entry.title.clone() };
        let sub = format!("{} · {}", label(&entry), format_time_left(item.remaining_ms));
        let hue_deg = sleeve_hash(&title) % 360;
        let display_title = title.to_uppercase();

        hero_surface(hue_deg, true)
            .id("tonight-continue")
            .flex_1()
            .min_w(px(260.))
            .min_h(px(236.))
            .p_5()
            .justify_end()
            .child(
                v_flex()
                    .relative()
                    .gap_2()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(hsla(0., 0., 1., 0.80)).child("CONTINUE"))
                    .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(0xffffff)).truncate().child(display_title))
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(hsla(0., 0., 1., 0.88)).truncate().child(sub))
                    .child(hero_progress_bar(item.ratio))
                    .child(
                        h_flex().pt_2().child(
                            hero_primary_btn("tonight-continue-play", Some(Lucide::Play), "Play")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.activate_entry(entry.clone(), Some(pos), window, cx);
                                })),
                        ),
                    ),
            )
    }

    fn render_tonight_next_ep_card(
        &self,
        title_name: String,
        ep: Entry,
        primary: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let sub = format!("{} · {}", label(&ep), format_bytes(ep.size));
        let hue_deg = sleeve_hash(&title_name) % 360;
        let display_title = title_name.to_uppercase();
        let on_click = cx.listener(move |this, _, window, cx| {
            this.activate_entry(ep.clone(), None, window, cx);
        });
        let play_btn: AnyElement = if primary {
            hero_primary_btn("tonight-next-play", Some(Lucide::Play), "Play")
                .on_click(on_click)
                .into_any_element()
        } else {
            hero_secondary_btn("tonight-next-play", Some(Lucide::Play), "Play")
                .on_click(on_click)
                .into_any_element()
        };

        hero_surface(hue_deg, true)
            .id("tonight-next-ep")
            .flex_1()
            .min_w(px(260.))
            .min_h(px(236.))
            .p_5()
            .justify_end()
            .child(
                v_flex()
                    .relative()
                    .gap_2()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(hsla(0., 0., 1., 0.80)).child("NEXT EPISODE"))
                    .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(0xffffff)).truncate().child(display_title))
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(hsla(0., 0., 1., 0.88)).truncate().child(sub))
                    .child(h_flex().pt_2().child(play_btn)),
            )
    }

    fn render_tonight_surprise_card(&self, tile: VideoTile, primary: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let play_entry = tile.items.first().map(|i| i.entry.clone());
        let sub = format!("{} · {}", tile.subtitle_line(format_bytes), tile.state_label());
        let hue_deg = sleeve_hash(&tile.title) % 360;
        let display_title = tile.title.to_uppercase();

        hero_surface(hue_deg, true)
            .id("tonight-surprise")
            .flex_1()
            .min_w(px(260.))
            .min_h(px(236.))
            .p_5()
            .justify_end()
            .child(
                v_flex()
                    .relative()
                    .gap_2()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(hsla(0., 0., 1., 0.80)).child("SURPRISE ME"))
                    .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(0xffffff)).truncate().child(display_title))
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(hsla(0., 0., 1., 0.88)).truncate().child(sub))
                    .child(
                        h_flex()
                            .pt_2()
                            .gap_2()
                            .flex_wrap()
                            .when_some(play_entry, |row, e| {
                                let on_click = cx.listener(move |this, _, window, cx| {
                                    this.activate_entry(e.clone(), None, window, cx);
                                });
                                let btn: AnyElement = if primary {
                                    hero_primary_btn("tonight-surprise-play", Some(Lucide::Play), "Play")
                                        .on_click(on_click)
                                        .into_any_element()
                                } else {
                                    hero_secondary_btn("tonight-surprise-play", Some(Lucide::Play), "Play")
                                        .on_click(on_click)
                                        .into_any_element()
                                };
                                row.child(btn)
                            })
                            .child(
                                hero_secondary_btn("tonight-surprise-another", Some(Lucide::Sparkles), "Another")
                                    .on_click(cx.listener(|this, _, _, cx| this.roll_surprise_video(cx))),
                            ),
                    ),
            )
    }

    fn render_tonight_az_bar(&self, letters: &[char], cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.watch_az_letter;
        h_flex()
            .gap_1()
            .flex_wrap()
            .child(
                div()
                    .id("az-jump-all")
                    .px_2p5()
                    .py_1()
                    .rounded(px(8.))
                    .bg(if selected.is_none() { rgb(BRAND) } else { rgb(CARD) })
                    .border_1()
                    .border_color(if selected.is_none() { rgb(BRAND) } else { rgb(LINE) })
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(if selected.is_none() { rgb(0xffffff) } else { rgb(DIM) })
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.watch_az_letter = None;
                        cx.notify();
                    }))
                    .child("A–Z"),
            )
            .children(letters.iter().copied().map(|ch| {
                let active = selected == Some(ch);
                div()
                    .id(SharedString::from(format!("az-jump-{ch}")))
                    .w(px(28.))
                    .py_1()
                    .rounded(px(8.))
                    .bg(if active { rgb(BRAND) } else { rgb(CARD) })
                    .border_1()
                    .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_center()
                    .text_color(if active { rgb(0xffffff) } else { rgb(DIM) })
                    .cursor_pointer()
                    .hover(|s| if active { s } else { s.text_color(rgb(INK)) })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.watch_az_letter = if this.watch_az_letter == Some(ch) { None } else { Some(ch) };
                        cx.notify();
                    }))
                    .child(ch.to_string())
            }))
    }

    fn render_tonight_az_index(&self, all_titles: &[&VideoTile], cx: &mut Context<Self>) -> impl IntoElement {
        let jump = self.watch_az_letter;
        let mut rows: Vec<AnyElement> = Vec::new();
        let mut last_letter: Option<char> = None;

        for tile in all_titles {
            let ch = index_letter(&tile.title);
            if let Some(target) = jump
                && ch < target
            {
                continue;
            }
            if last_letter != Some(ch) {
                last_letter = Some(ch);
                rows.push(
                    div()
                        .pt_3()
                        .pb_1()
                        .text_xs()
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(BRAND))
                        .child(ch.to_string())
                        .into_any_element(),
                );
            }
            let tk = tile.key.clone();
            let hue = (sleeve_hash(&tile.title) % 360) as f32 / 360.0;
            let dot = hsla(hue, 0.55, 0.52, 1.0);
            let sub = tile.subtitle_line(format_bytes);
            let saved_col = if tile.saved > 0 { rgb(ACCENT) } else { rgb(DIM) };
            rows.push(
                h_flex()
                    .id(SharedString::from(format!("az-row-{}", tile.key)))
                    .items_center()
                    .gap_3()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(hsla(0., 0., 1., 0.05))
                    .cursor_pointer()
                    .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_detail(DetailView::Title(tk.clone()), cx);
                    }))
                    .child(div().size(px(10.)).rounded(px(3.)).bg(dot))
                    .child(div().flex_1().min_w_0().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(tile.title.clone()))
                    .child(div().text_xs().text_color(rgb(DIM)).child(sub))
                    .child(div().size(px(7.)).rounded(px(99.)).bg(saved_col))
                    .into_any_element(),
            );
        }

        v_flex().children(rows)
    }

    // ---- Video store: horizontal shelves of vertical spines + cover preview modal ----

    fn render_watch_store(&self, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_6()
            .when(!self.catalog.series.is_empty(), |col| {
                col.child(self.render_spine_shelf("Series", &self.catalog.series, cx))
            })
            .when(!self.catalog.movies.is_empty(), |col| {
                col.child(self.render_spine_shelf("Films", &self.catalog.movies, cx))
            })
            .when(!self.catalog.clips.is_empty(), |col| {
                let take_len = self.catalog.clips.len().min(120);
                col.child(self.render_spine_shelf("Clips", &self.catalog.clips[..take_len], cx))
            })
    }

    fn render_spine_shelf(&self, heading: &'static str, tiles: &[VideoTile], cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child(heading))
                    .child(div().text_xs().text_color(rgb(DIM)).child(tiles.len().to_string())),
            )
            .child(
                div()
                    .id(SharedString::from(format!("store-shelf-{heading}")))
                    .w_full()
                    .overflow_x_scrollbar()
                    .pb_2()
                    .child(
                        h_flex()
                            .items_end()
                            .gap_1p5()
                            .px_2()
                            .pt_2()
                            .pb_2()
                            .border_b_2()
                            .border_color(rgb(LINE))
                            .children(tiles.iter().map(|tile| self.render_spine(tile, cx))),
                    ),
            )
    }

    fn render_spine(&self, tile: &VideoTile, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let seed = sleeve_hash(&tile.title);
        let hue = (seed % 360) as f32 / 360.0;
        let bg = hsla(hue, 0.34, 0.19, 1.0);
        let top_band = hsla(hue, 0.56, 0.44, 1.0);
        let seasons = tile.seasons().len().clamp(1, 8);
        let width_px = match tile.kind {
            VideoKind::Series => 46.0 + 10.0 * seasons as f32,
            VideoKind::Movie => 44.0,
            VideoKind::Clip => 36.0,
        };
        let height_px = 178.0 + ((seed % 5) * 6) as f32;
        let started = tile.items.iter().any(|i| self.resume_position_for(&i.entry) > 0);
        let tk = tile.key.clone();
        let top_lbl = if tile.kind == VideoKind::Series {
            format!("×{}", tile.items.len())
        } else {
            monogram(&tile.title)
        };
        let saved_dot = if tile.saved > 0 { rgb(ACCENT) } else { rgb(DIM) };
        let short_name: String = tile.title.chars().take(24).collect();

        v_flex()
            .id(SharedString::from(format!("spine-{}", tile.key)))
            .flex_none()
            .w(px(width_px))
            .h(px(height_px))
            .rounded_t(px(6.))
            .rounded_b(px(3.))
            .bg(bg)
            .border_1()
            .border_color(if started { Hsla::from(rgb(BRAND)) } else { hsla(0., 0., 1., 0.12) })
            .overflow_hidden()
            .cursor_pointer()
            .hover(|s| s.border_color(rgb(INK)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.watch_cover_key = Some(tk.clone());
                cx.notify();
            }))
            .child(div().h(px(6.)).w_full().bg(top_band))
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .justify_between()
                    .items_center()
                    .px_1()
                    .py_2()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(hsla(0., 0., 1., 0.82)).child(top_lbl))
                    .child(
                        div()
                            .w_full()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_center()
                            .text_color(rgb(INK))
                            .overflow_hidden()
                            .child(short_name),
                    )
                    .child(div().size(px(6.)).rounded(px(99.)).bg(saved_dot)),
            )
    }

    pub fn render_watch_cover_modal(&self, tile_key: &str, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let tile = self.catalog.video_by_key(tile_key)?.clone();
        let header_title = tile.title.clone();
        let body = self.render_watch_cover_body(tile, cx);

        Some(
            div()
                .id("watch-cover-backdrop")
                .absolute()
                .inset_0()
                .bg(hsla(0., 0., 0., 0.62))
                .flex()
                .items_center()
                .justify_center()
                .p_6()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|this, _, _, cx| {
                    this.watch_cover_key = None;
                    cx.notify();
                }))
                .child(
                    v_flex()
                        .id("watch-cover-card")
                        .w(px(520.))
                        .max_w_full()
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
                                .py_3p5()
                                .border_b_1()
                                .border_color(rgb(LINE))
                                .child(div().text_sm().font_weight(FontWeight::BOLD).truncate().child(header_title))
                                .child(
                                    Button::new("close-watch-cover")
                                        .ghost()
                                        .small()
                                        .icon(IconName::Close)
                                        .tooltip("Close")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.watch_cover_key = None;
                                            cx.notify();
                                        })),
                                ),
                        )
                        .child(body),
                ),
        )
    }

    fn render_watch_cover_body(&self, tile: VideoTile, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let is_clip = tile.kind == VideoKind::Clip;
        let kind_word = match tile.kind {
            VideoKind::Movie => "Film",
            VideoKind::Series => "Series",
            VideoKind::Clip => "Clip",
        };
        let (play_entry, resume_pos, remaining_ms, ratio) = self.tile_resume_state(&tile);
        let facts = format!("{} · {}", tile.subtitle_line(format_bytes), tile.state_label());
        let det_key = tile.key.clone();

        h_flex()
            .p_5()
            .gap_5()
            .items_start()
            .child(video_art(
                &tile.title,
                Some(kind_word),
                if is_clip { 184. } else { 132. },
                if is_clip { 104. } else { 196. },
            ))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2p5()
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child(kind_word))
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child(tile.title))
                    .child(div().text_xs().text_color(rgb(DIM)).child(facts))
                    .when_some(remaining_ms.zip(ratio), |col, (rem, r)| {
                        col.child(
                            v_flex()
                                .gap_1()
                                .child(div().text_xs().text_color(rgb(DIM)).child(format_time_left(rem)))
                                .child(
                                    div()
                                        .h(px(3.))
                                        .w_full()
                                        .rounded(px(2.))
                                        .bg(hsla(0., 0., 1., 0.08))
                                        .child(div().h_full().rounded(px(2.)).w(relative(r)).bg(rgb(BRAND))),
                                ),
                        )
                    })
                    .child(
                        h_flex()
                            .pt_2()
                            .gap_2()
                            .flex_wrap()
                            .when_some(play_entry, |row, pe| {
                                let lbl = if resume_pos > 0 { "Continue" } else { "Play" };
                                row.child(
                                    Button::new("cover-play")
                                        .primary()
                                        .small()
                                        .icon(Icon::new(Lucide::Play))
                                        .label(lbl)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.watch_cover_key = None;
                                            this.activate_entry(pe.clone(), None, window, cx);
                                        })),
                                )
                            })
                            .child(
                                Button::new("cover-details")
                                    .small()
                                    .label("Details")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.watch_cover_key = None;
                                        this.open_detail(DetailView::Title(det_key.clone()), cx);
                                    })),
                            ),
                    ),
            )
    }

    fn tile_resume_state(&self, tile: &VideoTile) -> (Option<Entry>, u64, Option<u64>, Option<f32>) {
        for item in &tile.items {
            let pos = self.resume_position_for(&item.entry);
            if pos > 0
                && let Some(h) = self.watch_history.get(&item.entry.id)
                && h.duration_ms > 0
            {
                let rem = h.duration_ms.saturating_sub(pos);
                let ratio = (pos as f32 / h.duration_ms as f32).clamp(0.03, 1.0);
                return (Some(item.entry.clone()), pos, Some(rem), Some(ratio));
            }
        }
        (tile.items.first().map(|i| i.entry.clone()), 0, None, None)
    }

    // ---- Channels: 3 deterministic pseudo-live channels + 4-hour guide ----

    fn render_watch_channels(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let now = local_day_secs();
        let start = (now / 1800) * 1800;
        let span = 4 * 3600;
        let channels = self.build_all_channels(now, start, span);

        if channels.is_empty() {
            return div()
                .py_16()
                .text_center()
                .text_color(rgb(DIM))
                .child("No channels available yet.")
                .into_any_element();
        }

        let now_offset_px = 112.0 + ((now.saturating_sub(start)) as f32 / 60.0) * GUIDE_PX_PER_MIN;

        v_flex()
            .gap_6()
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .items_stretch()
                    .children(channels.iter().map(|ch| self.render_channel_on_now(ch, now, cx))),
            )
            .child(
                div()
                    .id("channels-guide-scroll")
                    .w_full()
                    .overflow_x_scrollbar()
                    .rounded(px(14.))
                    .bg(rgb(CARD))
                    .border_1()
                    .border_color(rgb(LINE))
                    .child(
                        v_flex()
                            .relative()
                            .p_3()
                            .gap_2()
                            .child(
                                h_flex()
                                    .items_center()
                                    .pb_2()
                                    .border_b_1()
                                    .border_color(rgb(LINE))
                                    .child(div().w(px(112.)).flex_none().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Today"))
                                    .children((0..8u64).map(|k| {
                                        div()
                                            .w(px(30.0 * GUIDE_PX_PER_MIN))
                                            .flex_none()
                                            .text_xs()
                                            .text_color(rgb(DIM))
                                            .child(format_hhmm(start + k * 1800))
                                    })),
                            )
                            .children(channels.iter().map(|ch| self.render_channel_guide_row(ch, cx)))
                            .child(
                                div()
                                    .absolute()
                                    .top_2()
                                    .bottom_2()
                                    .left(px(now_offset_px + 12.0))
                                    .w(px(2.))
                                    .bg(rgb(BRAND)),
                            ),
                    ),
            )
            .into_any_element()
    }

    fn build_all_channels(&self, now: u64, start: u64, span: u64) -> Vec<ChannelSchedule> {
        let series_items: Vec<ChannelItem> = self
            .catalog
            .series
            .iter()
            .flat_map(|t| {
                t.items.iter().take(6).map(move |ep| ChannelItem {
                    tile_key: t.key.clone(),
                    entry: ep.entry.clone(),
                    name: t.title.clone(),
                    sub: Some(label(&ep.entry)),
                    seconds: item_duration_secs(&ep.entry, VideoKind::Series, &self.watch_history),
                })
            })
            .collect();

        let movie_items: Vec<ChannelItem> = self
            .catalog
            .movies
            .iter()
            .filter_map(|t| {
                let first = t.items.first()?;
                Some(ChannelItem {
                    tile_key: t.key.clone(),
                    entry: first.entry.clone(),
                    name: t.title.clone(),
                    sub: t.year.clone(),
                    seconds: item_duration_secs(&first.entry, VideoKind::Movie, &self.watch_history),
                })
            })
            .collect();

        let clip_items: Vec<ChannelItem> = self
            .catalog
            .clips
            .iter()
            .filter_map(|t| {
                let first = t.items.first()?;
                Some(ChannelItem {
                    tile_key: t.key.clone(),
                    entry: first.entry.clone(),
                    name: t.title.clone(),
                    sub: None,
                    seconds: item_duration_secs(&first.entry, VideoKind::Clip, &self.watch_history),
                })
            })
            .collect();

        [
            build_channel_schedule(1, "Series", series_items, now, start, span),
            build_channel_schedule(2, "Films", movie_items, now, start, span),
            build_channel_schedule(3, "Clips", clip_items, now, start, span),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    fn render_channel_on_now(&self, ch: &ChannelSchedule, now: u64, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let Some(block) = ch.blocks.get(ch.live_idx) else {
            return div().into_any_element();
        };
        let Some(item) = ch.items.get(block.item_idx) else {
            return div().into_any_element();
        };
        let into = block.into_secs + now.saturating_sub(block.from_secs);
        let left_secs = item.seconds.saturating_sub(into);
        let ratio = (into as f32 / item.seconds.max(1) as f32).clamp(0.02, 1.0);
        let facts = match &item.sub {
            Some(s) => format!("{s} · {}", format_time_left(left_secs * 1000)),
            None => format_time_left(left_secs * 1000),
        };
        let hue_deg = sleeve_hash(&item.name) % 360;
        let display_title = item.name.to_uppercase();
        let entry = item.entry.clone();
        let into_ms = into * 1000;

        hero_surface(hue_deg, true)
            .id(SharedString::from(format!("ch-onnow-{}", ch.number)))
            .flex_1()
            .min_w(px(260.))
            .min_h(px(216.))
            .p_5()
            .justify_end()
            .child(
                v_flex()
                    .relative()
                    .gap_2()
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .text_color(hsla(0., 0., 1., 0.80))
                            .child(format!("CH {} · {} · ON NOW", ch.number, ch.label.to_uppercase())),
                    )
                    .child(div().text_xl().font_weight(FontWeight::EXTRA_BOLD).text_color(rgb(0xffffff)).truncate().child(display_title))
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(hsla(0., 0., 1., 0.88)).truncate().child(facts))
                    .child(hero_progress_bar(ratio))
                    .child(
                        h_flex().pt_2().child(
                            hero_secondary_btn(SharedString::from(format!("ch-watch-{}", ch.number)), Some(Lucide::Play), "Watch")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.activate_entry(entry.clone(), Some(into_ms), window, cx);
                                })),
                        ),
                    ),
            )
            .into_any_element()
    }

    fn render_channel_guide_row(&self, ch: &ChannelSchedule, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        h_flex()
            .items_center()
            .gap_1()
            .child(
                h_flex()
                    .w(px(108.))
                    .flex_none()
                    .gap_2()
                    .items_center()
                    .child(div().text_xs().font_weight(FontWeight::BOLD).text_color(rgb(DIM)).child(ch.number.to_string()))
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).truncate().child(ch.label)),
            )
            .children(ch.blocks.iter().enumerate().filter_map(|(b_idx, block)| {
                let item = ch.items.get(block.item_idx)?;
                let width_px = (((block.to_secs.saturating_sub(block.from_secs)) as f32 / 60.0) * GUIDE_PX_PER_MIN - 4.0).max(48.0);
                let hue = (sleeve_hash(&item.name) % 360) as f32 / 360.0;
                let bg = hsla(hue, 0.30, if block.live { 0.24 } else { 0.16 }, 1.0);
                let sub = match &item.sub {
                    Some(s) => format!("{s} · {}", format_hhmm(block.from_secs)),
                    None => format_hhmm(block.from_secs),
                };
                let tk = item.tile_key.clone();
                Some(
                    v_flex()
                        .id(SharedString::from(format!("ch-{}-blk-{b_idx}", ch.number)))
                        .flex_none()
                        .w(px(width_px))
                        .px_2p5()
                        .py_2()
                        .rounded(px(8.))
                        .bg(bg)
                        .border_1()
                        .border_color(if block.live { rgb(BRAND) } else { rgb(LINE) })
                        .cursor_pointer()
                        .hover(|s| s.border_color(rgb(INK)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.watch_cover_key = Some(tk.clone());
                            cx.notify();
                        }))
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).truncate().child(item.name.clone()))
                        .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
                )
            }))
    }

    fn render_poster_grid(&self, heading: &'static str, tiles: &[&VideoTile], cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child(heading))
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .children(tiles.iter().map(|tile| {
                        let tk = tile.key.clone();
                        let sub = tile.subtitle_line(format_bytes);
                        let badge = match tile.kind {
                            VideoKind::Series => Some("Series"),
                            VideoKind::Movie => Some("Film"),
                            VideoKind::Clip => Some("Clip"),
                        };
                        v_flex()
                            .id(SharedString::from(format!("poster-{}", tile.key)))
                            .w(px(154.))
                            .gap_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_detail(DetailView::Title(tk.clone()), cx);
                            }))
                            .child(video_art(&tile.title, badge, 154., 228.))
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(tile.title.clone()))
                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
                            )
                    })),
            )
    }

    fn render_clips_grid(&self, heading: &'static str, tiles: &[&VideoTile], cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child(heading))
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .children(tiles.iter().map(|tile| {
                        let tk = tile.key.clone();
                        let sub = tile.subtitle_line(format_bytes);
                        v_flex()
                            .id(SharedString::from(format!("clip-{}", tile.key)))
                            .w(px(216.))
                            .gap_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_detail(DetailView::Title(tk.clone()), cx);
                            }))
                            .child(video_art(&tile.title, Some("Clip"), 216., 122.))
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(tile.title.clone()))
                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
                            )
                    })),
            )
    }

    pub fn render_title_detail(&self, tile_key: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(tile) = self.catalog.video_by_key(tile_key).cloned() else {
            return column()
                .py_12()
                .gap_3()
                .child(div().text_base().text_color(rgb(DIM)).child("This title is no longer in your library."))
                .child(
                    Button::new("vid-missing-back")
                        .ghost()
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                )
                .into_any_element();
        };

        let kind_word = match tile.kind {
            VideoKind::Movie => "Film",
            VideoKind::Series => "Series",
            VideoKind::Clip => "Clip",
        };
        let is_clip = tile.kind == VideoKind::Clip;
        let art_w = if is_clip { 240. } else { 148. };
        let art_h = if is_clip { 135. } else { 220. };

        let mut facts = vec![tile.subtitle_line(format_bytes), tile.state_label()];
        if tile.kind == VideoKind::Series
            && let Some(y) = &tile.year
        {
            facts.insert(0, y.clone());
        }

        let (primary_entry, next_ep): (Option<Entry>, Option<Entry>) = if tile.kind == VideoKind::Series {
            let resume_idx = tile
                .items
                .iter()
                .enumerate()
                .filter_map(|(i, item)| {
                    let pos = self.resume_position_for(&item.entry);
                    if pos > 0 {
                        let upd = self.watch_history.get(&item.entry.id).map_or(0, |w| w.updated_at);
                        Some((upd, i))
                    } else {
                        None
                    }
                })
                .max_by_key(|(u, _)| *u)
                .map(|(_, i)| i);
            let idx = resume_idx.unwrap_or(0);
            let cur = tile.items.get(idx).map(|i| i.entry.clone());
            let nxt = tile.items.get(idx + 1).map(|i| i.entry.clone());
            (cur, nxt)
        } else {
            (tile.items.first().map(|i| i.entry.clone()), None)
        };

        let seasons = tile.seasons();
        let active_season = self
            .selected_seasons
            .get(&tile.key)
            .copied()
            .filter(|s| seasons.contains(s))
            .or_else(|| primary_entry.as_ref().and_then(|e| e.season))
            .or_else(|| seasons.first().copied())
            .unwrap_or(1);

        let visible_items: Vec<&Entry> = if tile.kind == VideoKind::Series && seasons.len() > 1 {
            tile.items
                .iter()
                .filter(|i| i.season.is_none_or(|s| s == active_season))
                .map(|i| &i.entry)
                .collect()
        } else {
            tile.items.iter().map(|i| &i.entry).collect()
        };

        let rows_heading = match tile.kind {
            VideoKind::Series => plural(visible_items.len(), "episode", "episodes"),
            VideoKind::Movie => {
                if tile.items.len() > 1 {
                    format!("{} versions", tile.items.len())
                } else {
                    "File".to_string()
                }
            }
            VideoKind::Clip => "File".to_string(),
        };

        let tile_key_s = tile.key.clone();

        column()
            .py_6()
            .gap_6()
            .child(
                h_flex().child(
                    Button::new("title-back")
                        .ghost()
                        .small()
                        .icon(Icon::new(Lucide::ChevronLeft))
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                ),
            )
            .child(
                h_flex()
                    .items_start()
                    .gap_6()
                    .child(video_art(&tile.title, Some(kind_word), art_w, art_h))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_2()
                            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child(kind_word))
                            .child(div().text_2xl().font_weight(FontWeight::BOLD).child(tile.title.clone()))
                            .child(div().text_sm().text_color(rgb(DIM)).child(facts.join(" · ")))
                            .child(
                                h_flex()
                                    .pt_2()
                                    .gap_2()
                                    .flex_wrap()
                                    .when_some(primary_entry.clone(), |row, pe| {
                                        let cast_e = pe.clone();
                                        let resume_pos = self.resume_position_for(&pe);
                                        let play_lbl = if tile.kind == VideoKind::Series {
                                            if resume_pos > 0 {
                                                format!("Resume {}", label(&pe))
                                            } else {
                                                format!("Play {}", label(&pe))
                                            }
                                        } else if resume_pos > 0 {
                                            "Resume".to_string()
                                        } else {
                                            "Play".to_string()
                                        };
                                        row.child(
                                            Button::new("title-play-primary")
                                                .primary()
                                                .icon(Icon::new(Lucide::Play))
                                                .label(play_lbl)
                                                .on_click(cx.listener(move |this, _, window, cx| {
                                                    this.activate_entry(pe.clone(), None, window, cx);
                                                })),
                                        )
                                        .child(
                                            Button::new("title-cast-primary")
                                                .icon(Icon::new(Lucide::Tv))
                                                .label("Play on a TV")
                                                .on_click(cx.listener(move |this, _, window, cx| {
                                                    this.open_cast_sheet(
                                                        Some((cast_e.key.clone(), cast_e.title.clone(), resume_pos)),
                                                        window,
                                                        cx,
                                                    );
                                                })),
                                        )
                                    })
                                    .when_some(next_ep, |row, ne| {
                                        let lbl = format!("Next episode ({})", label(&ne));
                                        row.child(
                                            Button::new("title-next-ep")
                                                .ghost()
                                                .label(lbl)
                                                .on_click(cx.listener(move |this, _, window, cx| {
                                                    this.activate_entry(ne.clone(), Some(0), window, cx);
                                                })),
                                        )
                                    }),
                            ),
                    ),
            )
            .when(tile.kind == VideoKind::Series && seasons.len() > 1, |this| {
                this.child(
                    h_flex()
                        .gap_1p5()
                        .flex_wrap()
                        .children(seasons.iter().copied().map(|s| {
                            let tk = tile_key_s.clone();
                            let active = s == active_season;
                            let btn = Button::new(SharedString::from(format!("det-season-{s}")))
                                .small()
                                .label(format!("Season {s}"));
                            let btn = if active { btn.primary() } else { btn.ghost() };
                            btn.on_click(cx.listener(move |this, _, _, cx| {
                                this.selected_seasons.insert(tk.clone(), s);
                                cx.notify();
                            }))
                        })),
                )
            })
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child(rows_heading))
                    .child(
                        v_flex()
                            .border_t_1()
                            .border_color(rgb(LINE))
                            .children(visible_items.into_iter().enumerate().map(|(idx, e)| {
                                self.render_title_file_row(idx, e, tile.kind == VideoKind::Series, cx)
                            })),
                    ),
            )
            .into_any_element()
    }

    fn render_title_file_row(&self, idx: usize, entry: &Entry, is_series: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let play_e = entry.clone();
        let cast_e = entry.clone();
        let dl_e = entry.clone();
        let magnet = (!entry.magnet_url.is_empty()).then(|| entry.magnet_url.clone());
        let clear_key = (!entry.local && entry.cached_bytes > 0).then(|| entry.key.clone());
        let can_delete = self
            .status
            .as_ref()
            .is_some_and(|st| st.writable && !st.channel.is_empty() && st.channel == entry.source);
        let del_key = can_delete.then(|| entry.key.clone());
        let active_dl = self.downloads.get(&entry.key).map(|d| {
            let got = d.downloaded.load(std::sync::atomic::Ordering::Relaxed);
            let tot = d.total.max(entry.size);
            (got, tot)
        });
        let is_downloading = active_dl.is_some();
        let cancel_key = entry.key.clone();
        let row_title = if is_series {
            format!("{} · {}", label(entry), entry.title)
        } else {
            entry.title.clone()
        };
        let mut meta = vec![format_bytes(entry.size)];
        if let Some((got, tot)) = active_dl {
            if tot > 0 {
                meta.push(format!("Downloading {:.0}%", (got as f64 / tot as f64 * 100.0).min(100.0)));
            } else {
                meta.push(format!("Downloading {}", format_bytes(got)));
            }
        } else if is_saved(entry) {
            meta.push("Saved here".into());
        } else if entry.cached_bytes > 0 {
            meta.push("Partly saved".into());
        } else {
            meta.push("On the network".into());
        }
        if entry.locked {
            meta.push("Subscriber pass needed".into());
        } else if entry.is_private {
            meta.push("Subscribers only".into());
        }
        let resume_pos = self.resume_position_for(entry);

        h_flex()
            .id(SharedString::from(format!("file-row-{idx}-{}", entry.key)))
            .justify_between()
            .items_center()
            .gap_3()
            .py_3()
            .px_2()
            .border_b_1()
            .border_color(hsla(0., 0., 1., 0.06))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(row_title))
                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta.join(" · "))),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_1p5()
                    .flex_wrap()
                    .child(
                        Button::new(SharedString::from(format!("fr-play-{idx}-{}", entry.key)))
                            .primary()
                            .small()
                            .label(if resume_pos > 0 { "Resume" } else { "Play" })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.activate_entry(play_e.clone(), None, window, cx);
                            })),
                    )
                    .when(!entry.locked, |row| {
                        row.child(
                            Button::new(SharedString::from(format!("fr-tv-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Play on a TV")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.open_cast_sheet(
                                        Some((cast_e.key.clone(), cast_e.title.clone(), resume_pos)),
                                        window,
                                        cx,
                                    );
                                })),
                        )
                        .child(if is_downloading {
                            Button::new(SharedString::from(format!("fr-dl-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Cancel")
                                .on_click(cx.listener(move |this, _, _, cx| this.cancel_download(&cancel_key, cx)))
                        } else {
                            Button::new(SharedString::from(format!("fr-dl-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Download")
                                .on_click(cx.listener(move |this, _, _, cx| this.download_entry(dl_e.clone(), None, cx)))
                        })
                    })
                    .when_some(magnet, |row, url| {
                        row.child(
                            Button::new(SharedString::from(format!("fr-copy-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Copy link")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                                    this.show_notice("Copied link".into(), cx);
                                })),
                        )
                    })
                    .when_some(clear_key, |row, ck| {
                        row.child(
                            Button::new(SharedString::from(format!("fr-clr-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Free up cache")
                                .on_click(cx.listener(move |this, _, _, cx| this.clear_cache(Some(ck.clone()), cx))),
                        )
                    })
                    .when_some(del_key, |row, dk| {
                        row.child(
                            Button::new(SharedString::from(format!("fr-del-{idx}-{}", entry.key)))
                                .ghost()
                                .small()
                                .label("Delete")
                                .on_click(cx.listener(move |this, _, _, cx| this.remove_channel_entry(dk.clone(), cx))),
                        )
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use peartube::worker::Entry;

    use super::{ChannelItem, build_channel_schedule, index_letter};

    #[test]
    fn channel_schedule_is_deterministic_and_covers_four_hours() {
        let items = vec![
            ChannelItem {
                tile_key: "m1".into(),
                entry: Entry { key: "k1".into(), title: "Movie A".into(), ..Entry::default() },
                name: "Movie A".into(),
                sub: None,
                seconds: 5400,
            },
            ChannelItem {
                tile_key: "m2".into(),
                entry: Entry { key: "k2".into(), title: "Movie B".into(), ..Entry::default() },
                name: "Movie B".into(),
                sub: None,
                seconds: 3600,
            },
        ];
        let sched = build_channel_schedule(2, "Films", items, 36_600, 36_000, 4 * 3600).unwrap();
        assert!(!sched.blocks.is_empty());
        assert!(sched.blocks[sched.live_idx].live);
        assert_eq!(sched.blocks.first().unwrap().from_secs, 36_000);
        assert_eq!(sched.blocks.last().unwrap().to_secs, 36_000 + 4 * 3600);
    }

    #[test]
    fn sort_title_strips_leading_articles_for_az_index() {
        assert_eq!(index_letter("The Matrix"), 'M');
        assert_eq!(index_letter("A Clockwork Orange"), 'C');
        assert_eq!(index_letter("An Autumn Afternoon"), 'A');
        assert_eq!(index_letter("2001: A Space Odyssey"), '#');
    }
}
