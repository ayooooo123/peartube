//! Home room: paired `Listen` and `Watch` quick-start hero cards, `Keep playing`
//! (unfinished videos + saved music list), `Albums` shelf (`All albums`), and
//! `Movies and series` shelf (`All video`, or `Clips` / `All clips` when a library
//! has clips and no movies or series).

#![forbid(unsafe_code)]

use std::collections::BTreeSet;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::Entry;

use crate::app::{DetailView, ListenTab, PearTube, Room, WatchKind};
use crate::catalog::{AlbumTile, VideoTile, format_time_left, is_music_entry, plural, sleeve_hash};
use crate::list::{column, format_bytes, label};
use crate::music::TrackItem;
use crate::sleeves::{album_sleeve, video_art};
use crate::theme::{BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

pub struct ResumeVideo {
    pub entry: Entry,
    pub position_ms: u64,
    pub remaining_ms: u64,
    pub ratio: f32,
}

impl PearTube {
    pub fn unfinished_videos(&self) -> Vec<ResumeVideo> {
        let mut list: Vec<(u64, ResumeVideo)> = self
            .entries
            .iter()
            .filter(|e| !is_music_entry(e))
            .filter_map(|e| {
                let prog = self.watch_history.get(&e.id)?;
                if prog.duration_ms == 0 {
                    return None;
                }
                let pos = self.resume_position_for(e);
                if pos == 0 {
                    return None;
                }
                let ratio = (prog.position_ms as f32 / prog.duration_ms as f32).clamp(0.02, 1.0);
                if ratio >= 0.95 {
                    return None;
                }
                let remaining = prog.duration_ms.saturating_sub(prog.position_ms);
                Some((
                    prog.updated_at,
                    ResumeVideo {
                        entry: e.clone(),
                        position_ms: pos,
                        remaining_ms: remaining,
                        ratio,
                    },
                ))
            })
            .collect();
        list.sort_by_key(|a| std::cmp::Reverse(a.0));
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for (_, item) in list {
            let dedup_key = if !item.entry.series_key.is_empty() {
                item.entry.series_key.clone()
            } else {
                item.entry.id.clone()
            };
            if seen.insert(dedup_key) {
                out.push(item);
                if out.len() >= 8 {
                    break;
                }
            }
        }
        out
    }

    pub fn render_home(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let cat = &self.catalog;
        if cat.is_empty() {
            let sub = if self.status.is_none() {
                "Connecting to your channels…"
            } else {
                "Add a channel link or open Settings to connect your library."
            };
            return column()
                .py_16()
                .gap_4()
                .items_center()
                .text_center()
                .child(div().text_xl().font_weight(FontWeight::BOLD).child("Nothing in your library yet."))
                .child(div().text_sm().text_color(rgb(DIM)).child(sub))
                .child(
                    Button::new("home-empty-add")
                        .primary()
                        .label("Add to library")
                        .on_click(cx.listener(|this, _, window, cx| this.open_add_modal(window, cx))),
                )
                .into_any_element();
        }

        let resume_videos = self.unfinished_videos();
        let saved_music = self.music_queue.current().cloned();
        let has_keep_playing = !resume_videos.is_empty() || saved_music.is_some();

        let albums_preview: Vec<_> = cat.albums.iter().take(6).cloned().collect();
        let mut movies_and_series: Vec<VideoTile> = cat
            .movies
            .iter()
            .chain(cat.series.iter())
            .cloned()
            .collect();
        movies_and_series.sort_by_key(|a| a.title.to_lowercase());
        let show_clips_instead = movies_and_series.is_empty() && !cat.clips.is_empty();
        let video_preview: Vec<VideoTile> = if show_clips_instead {
            cat.clips.iter().take(6).cloned().collect()
        } else {
            movies_and_series.into_iter().take(6).collect()
        };

        column()
            .py_6()
            .gap_8()
            .child(self.render_home_pair(&resume_videos, saved_music.as_ref(), cx))
            .when(has_keep_playing, |this| {
                this.child(self.render_keep_playing(&resume_videos, saved_music.as_ref(), cx))
            })
            .when(!albums_preview.is_empty(), |this| {
                this.child(self.render_home_albums(albums_preview, cx))
            })
            .when(!video_preview.is_empty(), |this| {
                this.child(self.render_home_videos(video_preview, show_clips_instead, cx))
            })
            .into_any_element()
    }

    fn render_home_pair(
        &self,
        resume_videos: &[ResumeVideo],
        saved_music: Option<&TrackItem>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let has_music = !self.catalog.albums.is_empty() || !self.catalog.tracks.is_empty();
        let total_videos = self.catalog.movies.len() + self.catalog.series.len() + self.catalog.clips.len();
        let has_video = total_videos > 0;
        let music_first = has_music && (resume_videos.is_empty() || !self.last_room_was_watch);

        h_flex()
            .gap_4()
            .flex_wrap()
            .items_stretch()
            .when(has_music, |row| {
                row.child(self.render_home_listen_hero(saved_music, music_first, cx))
            })
            .when(has_video, |row| {
                row.child(self.render_home_watch_hero(resume_videos.first(), total_videos, !music_first, cx))
            })
    }

    fn render_home_listen_hero(
        &self,
        saved_music: Option<&TrackItem>,
        is_primary: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let collage_albums: Vec<AlbumTile> = self.catalog.albums.iter().take(4).cloned().collect();
        let all_tracks: Vec<TrackItem> = self.catalog.tracks.iter().map(TrackItem::from_track_row).collect();
        let play_tracks = all_tracks.clone();
        let shuffle_tracks = all_tracks;
        let playing = self.music_is_playing();

        let (title, sub) = if let Some(cur) = saved_music {
            let sub_line = if self.music_queue.paused_for_video {
                format!("{} · Paused for a video", cur.artist)
            } else {
                cur.artist.clone()
            };
            (cur.title.clone(), sub_line)
        } else {
            (
                plural(self.catalog.tracks.len(), "track", "tracks"),
                plural(self.catalog.albums.len(), "album", "albums"),
            )
        };

        let primary_btn = if saved_music.is_some() {
            let lbl = if playing { "Pause" } else { "Resume" };
            let ic = if playing { Lucide::Pause } else { Lucide::Play };
            let btn = Button::new("home-hero-listen-play")
                .icon(Icon::new(ic))
                .label(lbl)
                .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx)));
            if is_primary { btn.primary() } else { btn }
        } else {
            let btn = Button::new("home-hero-listen-play")
                .icon(Icon::new(Lucide::Play))
                .label("Play all")
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.play_music_list(play_tracks.clone(), 0, "Library".to_string(), Some(false), window, cx);
                }));
            if is_primary { btn.primary() } else { btn }
        };

        let tint = hsla(258.0 / 360.0, 0.45, 0.16, 0.45);
        h_flex()
            .id("home-hero-listen")
            .flex_1()
            .min_w(px(340.))
            .p_5()
            .gap_4()
            .items_center()
            .justify_between()
            .rounded(px(16.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .relative()
            .overflow_hidden()
            .child(div().absolute().top_0().left_0().right_0().h(px(3.)).bg(tint))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_2()
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Listen"))
                    .child(div().text_xl().font_weight(FontWeight::BOLD).truncate().child(title))
                    .child(div().text_sm().text_color(rgb(DIM)).truncate().child(sub))
                    .child(
                        h_flex()
                            .pt_2()
                            .gap_2()
                            .flex_wrap()
                            .child(primary_btn)
                            .child(
                                Button::new("home-hero-listen-shuffle")
                                    .icon(Icon::new(Lucide::Shuffle))
                                    .label("Shuffle")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.play_music_list(
                                            shuffle_tracks.clone(),
                                            0,
                                            "Library".to_string(),
                                            Some(true),
                                            window,
                                            cx,
                                        );
                                    })),
                            ),
                    ),
            )
            .when(!collage_albums.is_empty(), |card| {
                card.child(render_sleeve_collage(&collage_albums))
            })
    }

    fn render_home_watch_hero(
        &self,
        unfinished: Option<&ResumeVideo>,
        total_videos: usize,
        is_primary: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (title, facts, ratio, hue_deg, resume_target) = if let Some(first) = unfinished {
            let name = if !first.entry.base_title.is_empty() {
                first.entry.base_title.clone()
            } else {
                first.entry.title.clone()
            };
            let line = format!("{} · {}", label(&first.entry), format_time_left(first.remaining_ms));
            let h = sleeve_hash(&name) % 360;
            (name, line, Some(first.ratio), h, Some((first.entry.clone(), first.position_ms)))
        } else {
            (
                plural(total_videos, "title", "titles"),
                "Movies, series and clips".to_string(),
                None,
                20u32,
                None,
            )
        };

        let has_resume = resume_target.is_some();
        let tint = hsla(hue_deg as f32 / 360.0, 0.55, 0.45, 0.55);

        let surprise_btn = {
            let btn = Button::new("home-hero-watch-surprise")
                .icon(Icon::new(Lucide::Sparkles))
                .label("Play something")
                .on_click(cx.listener(|this, _, window, cx| this.play_something(window, cx)));
            if !has_resume && is_primary { btn.primary() } else { btn }
        };

        v_flex()
            .id("home-hero-watch")
            .flex_1()
            .min_w(px(340.))
            .p_5()
            .gap_2()
            .justify_between()
            .rounded(px(16.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .relative()
            .overflow_hidden()
            .child(div().absolute().top_0().left_0().right_0().h(px(3.)).bg(tint))
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Watch"))
                    .child(div().text_xl().font_weight(FontWeight::BOLD).truncate().child(title))
                    .child(div().text_sm().text_color(rgb(DIM)).truncate().child(facts))
                    .when_some(ratio, |col, r| {
                        col.child(
                            div()
                                .mt_1()
                                .h(px(3.))
                                .w_full()
                                .rounded(px(2.))
                                .bg(hsla(0., 0., 1., 0.08))
                                .child(div().h_full().rounded(px(2.)).w(relative(r)).bg(rgb(BRAND))),
                        )
                    }),
            )
            .child(
                h_flex()
                    .pt_2()
                    .gap_2()
                    .flex_wrap()
                    .when_some(resume_target, |row, (entry, pos)| {
                        let btn = Button::new("home-hero-watch-continue")
                            .icon(Icon::new(Lucide::Play))
                            .label("Continue")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.activate_entry(entry.clone(), Some(pos), window, cx);
                            }));
                        row.child(if is_primary { btn.primary() } else { btn })
                    })
                    .child(surprise_btn),
            )
    }

    fn render_home_albums(&self, albums_preview: Vec<AlbumTile>, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("Albums"))
                    .child(
                        Button::new("home-all-albums")
                            .ghost()
                            .small()
                            .label("All albums")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.open_room(Room::Listen(ListenTab::Albums), cx);
                            })),
                    ),
            )
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .children(albums_preview.into_iter().map(|album| {
                        let a_key = album.key.clone();
                        let play_items = TrackItem::from_album(&album);
                        let play_label = album.album.clone();
                        v_flex()
                            .id(SharedString::from(format!("home-alb-{}", album.key)))
                            .w(px(148.))
                            .gap_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_detail(DetailView::Album(a_key.clone()), cx);
                            }))
                            .child(
                                div()
                                    .relative()
                                    .child(album_sleeve(album.hue, album.seed, &album.monogram, 148.))
                                    .child(
                                        div()
                                            .absolute()
                                            .bottom_2()
                                            .right_2()
                                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                            .child(
                                                Button::new(SharedString::from(format!("home-alb-play-{}", album.key)))
                                                    .primary()
                                                    .small()
                                                    .label("Play")
                                                    .on_click(cx.listener(move |this, _, window, cx| {
                                                        this.play_music_list(
                                                            play_items.clone(),
                                                            0,
                                                            play_label.clone(),
                                                            None,
                                                            window,
                                                            cx,
                                                        );
                                                    })),
                                            ),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(album.album))
                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(album.artist)),
                            )
                    })),
            )
    }

    fn render_home_videos(
        &self,
        video_preview: Vec<VideoTile>,
        show_clips_instead: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let heading = if show_clips_instead { "Clips" } else { "Movies and series" };
        let link_lbl = if show_clips_instead { "All clips" } else { "All video" };
        let target_room = if show_clips_instead {
            Room::Watch(WatchKind::Clips)
        } else {
            Room::Watch(WatchKind::All)
        };
        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child(heading))
                    .child(
                        Button::new("home-all-video")
                            .ghost()
                            .small()
                            .label(link_lbl)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_room(target_room.clone(), cx);
                            })),
                    ),
            )
            .child(
                h_flex()
                    .gap_4()
                    .flex_wrap()
                    .children(video_preview.into_iter().map(|tile| {
                        let t_key = tile.key.clone();
                        let w = if show_clips_instead { 216. } else { 142. };
                        let h = if show_clips_instead { 122. } else { 210. };
                        let sub = tile.subtitle_line(format_bytes);
                        let badge = if show_clips_instead { Some("Clip") } else { None };
                        v_flex()
                            .id(SharedString::from(format!("home-vid-{}", tile.key)))
                            .w(px(w))
                            .gap_2()
                            .cursor_pointer()
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_detail(DetailView::Title(t_key.clone()), cx);
                            }))
                            .child(video_art(&tile.title, badge, w, h))
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(tile.title))
                                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
                            )
                    })),
            )
    }

    fn render_keep_playing(
        &self,
        videos: &[ResumeVideo],
        music: Option<&TrackItem>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut side_rows: Vec<AnyElement> = Vec::new();
        let hero_el: AnyElement;

        if let Some(first) = videos.first() {
            let entry = first.entry.clone();
            let pos = first.position_ms;
            let title = if !entry.base_title.is_empty() {
                entry.base_title.clone()
            } else {
                entry.title.clone()
            };
            let meta = format!("{} · {}", label(&entry), format_time_left(first.remaining_ms));
            let ratio = first.ratio;
            hero_el = v_flex()
                .id("keep-hero-video")
                .flex_1()
                .min_w(px(320.))
                .p_5()
                .gap_3()
                .rounded(px(14.))
                .bg(rgb(CARD))
                .border_1()
                .border_color(rgb(LINE))
                .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Video"))
                .child(div().text_xl().font_weight(FontWeight::BOLD).truncate().child(title))
                .child(div().text_sm().text_color(rgb(DIM)).child(meta))
                .child(
                    div()
                        .h(px(3.))
                        .w_full()
                        .rounded(px(2.))
                        .bg(hsla(0., 0., 1., 0.08))
                        .child(div().h_full().rounded(px(2.)).w(relative(ratio)).bg(rgb(BRAND))),
                )
                .child(
                    h_flex().gap_2().child(
                        Button::new("keep-hero-resume")
                            .primary()
                            .small()
                            .label("Play")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.activate_entry(entry.clone(), Some(pos), window, cx);
                            })),
                    ),
                )
                .into_any_element();

            for item in videos.iter().skip(1).take(3) {
                side_rows.push(self.render_keep_video_side_row(item, cx).into_any_element());
            }
            if let Some(m) = music {
                side_rows.push(self.render_keep_music_row(m, cx).into_any_element());
            }
        } else if let Some(m) = music {
            hero_el = self.render_keep_music_hero(m, cx).into_any_element();
        } else {
            hero_el = div().into_any_element();
        }

        v_flex()
            .gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child("Keep playing"))
            .child(
                h_flex()
                    .items_start()
                    .gap_4()
                    .child(hero_el)
                    .when(!side_rows.is_empty(), |this| {
                        this.child(v_flex().w(px(300.)).gap_2().children(side_rows))
                    }),
            )
    }

    fn render_keep_video_side_row(&self, item: &ResumeVideo, cx: &mut Context<Self>) -> impl IntoElement {
        let e = item.entry.clone();
        let p = item.position_ms;
        let t = if !e.base_title.is_empty() { e.base_title.clone() } else { e.title.clone() };
        let sub = format!("{} · {}", label(&e), format_time_left(item.remaining_ms));
        h_flex()
            .id(SharedString::from(format!("keep-side-{}", e.key)))
            .items_center()
            .justify_between()
            .gap_3()
            .p_3()
            .rounded(px(12.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(CARD_ELEVATED)))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.activate_entry(e.clone(), Some(p), window, cx);
            }))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(t))
                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
            )
    }

    fn render_keep_music_hero(&self, m: &TrackItem, cx: &mut Context<Self>) -> impl IntoElement {
        let status_txt = if self.music_queue.paused_for_video {
            "Paused for a video".to_string()
        } else if self.music_is_playing() {
            "Playing now".to_string()
        } else {
            format!("{} · {}", m.artist, m.album)
        };
        let is_playing = self.music_is_playing();
        h_flex()
            .id("keep-hero-music")
            .flex_1()
            .items_center()
            .gap_4()
            .p_5()
            .rounded(px(14.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .child(album_sleeve(m.hue, m.seed, &m.monogram, 92.))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_1p5()
                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Music"))
                    .child(div().text_xl().font_weight(FontWeight::BOLD).truncate().child(m.title.clone()))
                    .child(div().text_sm().text_color(rgb(DIM)).truncate().child(status_txt))
                    .child(
                        h_flex()
                            .gap_2()
                            .pt_1()
                            .child(
                                Button::new("keep-music-play")
                                    .primary()
                                    .small()
                                    .label(if is_playing { "Pause" } else { "Play" })
                                    .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx))),
                            )
                            .child(
                                Button::new("keep-music-open")
                                    .ghost()
                                    .small()
                                    .label("Open player")
                                    .on_click(cx.listener(|this, _, _, cx| this.open_detail(DetailView::Playing, cx))),
                            ),
                    ),
            )
    }

    fn render_keep_music_row(&self, m: &TrackItem, cx: &mut Context<Self>) -> impl IntoElement {
        let sub = if self.music_queue.paused_for_video {
            "Paused for a video".to_string()
        } else {
            format!("{} · {}", m.artist, m.album)
        };
        h_flex()
            .id("keep-side-music")
            .items_center()
            .gap_3()
            .p_3()
            .rounded(px(12.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(CARD_ELEVATED)))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx)))
            .child(album_sleeve(m.hue, m.seed, &m.monogram, 42.))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(m.title.clone()))
                    .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub)),
            )
            .child(div().text_xs().text_color(rgb(INK)).child(if self.music_is_playing() { "Pause" } else { "Play" }))
    }
}

/// 2x2 album sleeve collage for the Home `Listen` hero card.
fn render_sleeve_collage(albums: &[AlbumTile]) -> Div {
    let tile_at = |idx: usize| -> Div {
        if let Some(a) = albums.get(idx).or_else(|| albums.first()) {
            album_sleeve(a.hue, a.seed, &a.monogram, 44.)
        } else {
            div().size(px(44.)).rounded(px(6.)).bg(rgb(CARD_ELEVATED))
        }
    };
    v_flex()
        .flex_none()
        .gap_1()
        .child(h_flex().gap_1().child(tile_at(0)).child(tile_at(1)))
        .child(h_flex().gap_1().child(tile_at(2)).child(tile_at(3)))
}
