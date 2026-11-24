//! Listen room (`Albums`, `Artists`, `Tracks`), plus Album and Artist detail pages.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::HashMap;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::format_duration;
use crate::app::{DetailView, ListenTab, PearTube, Room, TrackSortCol};
use crate::catalog::{AlbumTile, ArtistGroup, TrackRow, fold, is_saved, plural};
use crate::list::{column, format_bytes};
use crate::music::TrackItem;
use crate::sleeves::{album_sleeve, artist_sleeve_stack};
use crate::theme::{BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

fn track_quality_info(row: &TrackRow) -> Option<(u32, &'static str)> {
    if row.is_yt {
        Some((128, "YouTube · AAC 128"))
    } else {
        None
    }
}

fn compare_opt_u64(a: Option<u64>, b: Option<u64>, asc: bool) -> Ordering {
    match (a, b) {
        (Some(va), Some(vb)) => {
            if asc {
                va.cmp(&vb)
            } else {
                vb.cmp(&va)
            }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn sort_track_rows<'a>(
    tracks: &[&'a TrackRow],
    query: &str,
    sort_col: TrackSortCol,
    asc: bool,
    durations: &HashMap<String, u64>,
) -> Vec<&'a TrackRow> {
    let q = query.trim().to_lowercase();
    let mut indexed: Vec<(usize, &'a TrackRow)> = tracks
        .iter()
        .copied()
        .filter(|t| {
            q.is_empty()
                || t.track_name.to_lowercase().contains(&q)
                || t.artist.to_lowercase().contains(&q)
                || t.album_title.to_lowercase().contains(&q)
        })
        .enumerate()
        .collect();

    if sort_col == TrackSortCol::Order {
        if !asc {
            indexed.reverse();
        }
        return indexed.into_iter().map(|(_, r)| r).collect();
    }

    indexed.sort_by(|(ia, a), (ib, b)| {
        let ord = match sort_col {
            TrackSortCol::Order => ia.cmp(ib),
            TrackSortCol::Title => {
                let c = a.track_name.to_lowercase().cmp(&b.track_name.to_lowercase());
                if asc { c } else { c.reverse() }
            }
            TrackSortCol::Artist => {
                let c = a.artist.to_lowercase().cmp(&b.artist.to_lowercase());
                if asc { c } else { c.reverse() }
            }
            TrackSortCol::Album => {
                let c = a.album_title.to_lowercase().cmp(&b.album_title.to_lowercase());
                if asc { c } else { c.reverse() }
            }
            TrackSortCol::Quality => {
                let qa = track_quality_info(a).map(|(r, _)| u64::from(r));
                let qb = track_quality_info(b).map(|(r, _)| u64::from(r));
                // Ascending = highest quality first (matching sketch), unknown last in both directions.
                compare_opt_u64(qa, qb, !asc)
            }
            TrackSortCol::Size => {
                let sa = (a.entry.size > 0).then_some(a.entry.size);
                let sb = (b.entry.size > 0).then_some(b.entry.size);
                // Ascending = largest first (matching sketch), unknown last in both directions.
                compare_opt_u64(sa, sb, !asc)
            }
            TrackSortCol::Time => {
                let da = durations.get(&a.entry.key).copied().filter(|&d| d > 0);
                let db = durations.get(&b.entry.key).copied().filter(|&d| d > 0);
                compare_opt_u64(da, db, !asc)
            }
        };
        if ord == Ordering::Equal { ia.cmp(ib) } else { ord }
    });

    indexed.into_iter().map(|(_, r)| r).collect()
}

impl PearTube {
    pub fn render_listen(&self, tab: ListenTab, cx: &mut Context<Self>) -> impl IntoElement {
        let saved_only = self.listen_saved_only;
        let albums: Vec<&AlbumTile> = self
            .catalog
            .albums
            .iter()
            .filter(|a| !saved_only || a.saved > 0)
            .collect();
        let artists: Vec<&ArtistGroup> = self
            .catalog
            .artists
            .iter()
            .filter(|a| !saved_only || a.saved_tracks > 0)
            .collect();
        let tracks_all: Vec<&TrackRow> = self
            .catalog
            .tracks
            .iter()
            .filter(|t| !saved_only || t.saved)
            .collect();

        let (sort_col, asc) = self.track_sort;
        let tracks_sorted = if tab == ListenTab::Tracks {
            let q = self.track_filter.read(cx).value().to_string();
            sort_track_rows(&tracks_all, &q, sort_col, asc, &self.track_durations)
        } else {
            tracks_all.clone()
        };

        let count_text = match tab {
            ListenTab::Albums => plural(albums.len(), "album", "albums"),
            ListenTab::Artists => plural(artists.len(), "artist", "artists"),
            ListenTab::Tracks => plural(tracks_sorted.len(), "track", "tracks"),
        };

        let play_list: Vec<TrackItem> = tracks_sorted.iter().map(|r| TrackItem::from_track_row(r)).collect();
        let play_label = if tab == ListenTab::Tracks { "Tracks" } else { "Library" };
        let header = self.render_listen_header(&tab, &count_text, play_list, play_label, cx);

        let body: AnyElement = match tab {
            ListenTab::Albums => self.render_albums_grid(&albums, cx).into_any_element(),
            ListenTab::Artists => self.render_artists_grid(&artists, cx).into_any_element(),
            ListenTab::Tracks => self.render_tracks_table(&tracks_sorted, cx).into_any_element(),
        };

        column().py_6().gap_5().child(header).child(body)
    }

    fn render_listen_header(
        &self,
        tab: &ListenTab,
        count_text: &str,
        play_list: Vec<TrackItem>,
        play_label: &'static str,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let saved_only = self.listen_saved_only;
        let waiting = self.music_queue.current().is_some() && !self.music_is_playing();
        let has_tracks = !play_list.is_empty();
        let shuffle_list = play_list.clone();

        let seg = |id: &'static str, lbl: &'static str, target: ListenTab, cx: &mut Context<Self>| {
            let active = *tab == target;
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
                    this.open_room(Room::Listen(target.clone()), cx);
                }))
                .child(lbl)
        };

        h_flex()
            .justify_between()
            .items_center()
            .flex_wrap()
            .gap_3()
            .child(
                h_flex()
                    .items_center()
                    .flex_wrap()
                    .gap_3()
                    .when(has_tracks || waiting, |row| {
                        let primary_btn = if waiting {
                            Button::new("listen-top-play")
                                .primary()
                                .small()
                                .icon(Icon::new(Lucide::Play))
                                .label("Resume")
                                .on_click(cx.listener(|this, _, window, cx| this.toggle_music_play(window, cx)))
                        } else {
                            Button::new("listen-top-play")
                                .primary()
                                .small()
                                .icon(Icon::new(Lucide::Play))
                                .label("Play all")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.play_music_list(
                                        play_list.clone(),
                                        0,
                                        play_label.to_string(),
                                        Some(false),
                                        window,
                                        cx,
                                    );
                                }))
                        };
                        row.child(primary_btn).when(has_tracks, |r| {
                            r.child(
                                Button::new("listen-top-shuffle")
                                    .small()
                                    .icon(Icon::new(Lucide::Shuffle))
                                    .label("Shuffle")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.play_music_list(
                                            shuffle_list.clone(),
                                            0,
                                            play_label.to_string(),
                                            Some(true),
                                            window,
                                            cx,
                                        );
                                    })),
                            )
                        })
                    })
                    .child(
                        h_flex()
                            .p_1()
                            .gap_1()
                            .rounded(px(10.))
                            .bg(rgb(CARD))
                            .border_1()
                            .border_color(rgb(LINE))
                            .child(seg("listen-tab-albums", "Albums", ListenTab::Albums, cx))
                            .child(seg("listen-tab-artists", "Artists", ListenTab::Artists, cx))
                            .child(seg("listen-tab-tracks", "Tracks", ListenTab::Tracks, cx)),
                    )
                    .child(div().text_sm().text_color(rgb(DIM)).child(count_text.to_string())),
            )
            .child(
                Checkbox::new("listen-saved-only")
                    .checked(saved_only)
                    .label("Saved here")
                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                        this.listen_saved_only = *checked;
                        cx.notify();
                    })),
            )
    }

    fn render_albums_grid(&self, albums: &[&AlbumTile], cx: &mut Context<Self>) -> impl IntoElement {
        if albums.is_empty() {
            return div()
                .py_16()
                .text_center()
                .text_color(rgb(DIM))
                .child(if self.listen_saved_only {
                    "No albums saved on this Mac yet."
                } else {
                    "No albums in your library yet."
                })
                .into_any_element();
        }
        h_flex()
            .gap_5()
            .flex_wrap()
            .children(albums.iter().map(|album| {
                let a_key = album.key.clone();
                let play_items = TrackItem::from_album(album);
                let play_label = album.album.clone();
                let is_playing_album = self
                    .music_queue
                    .current()
                    .is_some_and(|c| c.album_key == album.key);
                v_flex()
                    .id(SharedString::from(format!("alb-card-{}", album.key)))
                    .w(px(164.))
                    .gap_2()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_detail(DetailView::Album(a_key.clone()), cx);
                    }))
                    .child(
                        div()
                            .relative()
                            .rounded(px(12.))
                            .when(is_playing_album, |d| d.border_2().border_color(rgb(BRAND)))
                            .child(album_sleeve(album.hue, album.seed, &album.monogram, 164.))
                            .child(
                                div()
                                    .absolute()
                                    .bottom_2()
                                    .right_2()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                    .child(
                                        Button::new(SharedString::from(format!("alb-play-{}", album.key)))
                                            .primary()
                                            .small()
                                            .icon(Icon::new(Lucide::Play))
                                            .tooltip("Play")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_list(play_items.clone(), 0, play_label.clone(), None, window, cx);
                                            })),
                                    ),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .truncate()
                                    .text_color(if is_playing_album { rgb(BRAND) } else { rgb(INK) })
                                    .child(album.album.clone()),
                            )
                            .child(div().text_xs().text_color(rgb(DIM)).truncate().child(album.artist.clone())),
                    )
            }))
            .into_any_element()
    }

    fn render_artists_grid(&self, artists: &[&ArtistGroup], cx: &mut Context<Self>) -> impl IntoElement {
        if artists.is_empty() {
            return div()
                .py_16()
                .text_center()
                .text_color(rgb(DIM))
                .child("No artists in your library yet.")
                .into_any_element();
        }
        h_flex()
            .gap_5()
            .flex_wrap()
            .children(artists.iter().map(|artist| {
                let k = artist.key.clone();
                let count = plural(artist.album_keys.len(), "album", "albums");
                v_flex()
                    .id(SharedString::from(format!("artist-card-{}", artist.key)))
                    .w(px(164.))
                    .gap_2()
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_detail(DetailView::Artist(k.clone()), cx);
                    }))
                    .child(artist_sleeve_stack(&artist.sleeves, 164.))
                    .child(
                        v_flex()
                            .gap_0p5()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(artist.name.clone()))
                            .child(div().text_xs().text_color(rgb(DIM)).child(count)),
                    )
            }))
            .into_any_element()
    }

    fn render_tracks_table(&self, rows: &[&TrackRow], cx: &mut Context<Self>) -> impl IntoElement {
        let (sort_col, asc) = self.track_sort;
        let queue_snapshot: Vec<TrackItem> = rows.iter().map(|r| TrackItem::from_track_row(r)).collect();
        let current_key = self.music_queue.current().map(|c| c.entry.key.clone());

        let sort_header = |id: &'static str, label: &'static str, col: TrackSortCol, right: bool, cx: &mut Context<Self>| {
            let active = sort_col == col;
            let arrow = if active {
                Some(if asc { "↑" } else { "↓" })
            } else {
                None
            };
            h_flex()
                .id(id)
                .items_center()
                .gap_1()
                .when(right, |d| d.justify_end())
                .cursor_pointer()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if active { rgb(INK) } else { rgb(DIM) })
                .hover(|s| s.text_color(rgb(INK)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if this.track_sort.0 == col {
                        this.track_sort.1 = !this.track_sort.1;
                    } else {
                        this.track_sort = (col, true);
                    }
                    cx.notify();
                }))
                .child(label)
                .when_some(arrow, |d, sym| d.child(div().text_color(rgb(BRAND)).child(sym)))
        };

        v_flex()
            .gap_3()
            .child(
                div().max_w(px(340.)).child(
                    Input::new(&self.track_filter)
                        .prefix(Icon::new(Lucide::Search).text_color(rgb(DIM)))
                        .cleanable(true),
                ),
            )
            .when(rows.is_empty(), |this| {
                this.child(div().py_12().text_center().text_color(rgb(DIM)).child("No tracks match that filter."))
            })
            .when(!rows.is_empty(), |this| {
                this.child(
                    v_flex()
                        .child(
                            h_flex()
                                .px_3()
                                .py_2()
                                .gap_3()
                                .border_b_1()
                                .border_color(rgb(LINE))
                                .child(div().w(px(36.)).child(sort_header("sort-order", "#", TrackSortCol::Order, true, cx)))
                                .child(div().flex_1().min_w_0().child(sort_header("sort-title", "Title", TrackSortCol::Title, false, cx)))
                                .child(div().w(px(150.)).child(sort_header("sort-artist", "Artist", TrackSortCol::Artist, false, cx)))
                                .child(div().w(px(150.)).child(sort_header("sort-album", "Album", TrackSortCol::Album, false, cx)))
                                .child(div().w(px(120.)).child(sort_header("sort-quality", "Quality", TrackSortCol::Quality, false, cx)))
                                .child(div().w(px(74.)).child(sort_header("sort-size", "Size", TrackSortCol::Size, true, cx)))
                                .child(div().w(px(58.)).child(sort_header("sort-time", "Time", TrackSortCol::Time, true, cx)))
                                .child(div().w(px(32.))),
                        )
                        .children(rows.iter().enumerate().take(200).map(|(idx, row)| {
                            self.render_track_table_row(idx, row, &queue_snapshot, current_key.as_deref(), cx)
                        })),
                )
            })
    }

    fn render_track_table_row(
        &self,
        idx: usize,
        row: &TrackRow,
        queue_snapshot: &[TrackItem],
        current_key: Option<&str>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let is_cur = current_key == Some(row.entry.key.as_str());
        let list = queue_snapshot.to_vec();
        let single = TrackItem::from_track_row(row);
        let single_next = single.clone();
        let single_last = single;
        let alb_key = row.album_key.clone();
        let w = cx.entity().downgrade();
        let quality_text = track_quality_info(row).map(|(_, q)| q).unwrap_or("");
        let size_text = if row.entry.size > 0 { format_bytes(row.entry.size) } else { String::new() };
        let time_text = self
            .track_durations
            .get(&row.entry.key)
            .copied()
            .filter(|&d| d > 0)
            .map(format_duration)
            .unwrap_or_default();

        h_flex()
            .id(SharedString::from(format!("trk-row-{idx}-{}", row.entry.key)))
            .items_center()
            .px_3()
            .py_2()
            .gap_3()
            .border_b_1()
            .border_color(hsla(0., 0., 1., 0.04))
            .cursor_pointer()
            .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
            .on_click(cx.listener(move |this, _, window, cx| {
                // Rule 13: a row plays the list it is in, from that row.
                this.play_music_list(list.clone(), idx, "Tracks".to_string(), None, window, cx);
            }))
            .child(
                div()
                    .w(px(36.))
                    .text_xs()
                    .text_right()
                    .text_color(if is_cur { rgb(BRAND) } else { rgb(DIM) })
                    .child(if is_cur { "▶".to_string() } else { format!("{}", idx + 1) }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_sm()
                    .font_weight(if is_cur { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                    .text_color(if is_cur { rgb(BRAND) } else { rgb(INK) })
                    .truncate()
                    .child(row.track_name.clone()),
            )
            .child(div().w(px(150.)).text_xs().text_color(rgb(DIM)).truncate().child(row.artist.clone()))
            .child(div().w(px(150.)).text_xs().text_color(rgb(DIM)).truncate().child(row.album_title.clone()))
            .child(div().w(px(120.)).text_xs().text_color(rgb(DIM)).truncate().child(quality_text))
            .child(div().w(px(74.)).text_xs().text_color(rgb(DIM)).text_right().child(size_text))
            .child(div().w(px(58.)).text_xs().text_color(rgb(DIM)).text_right().child(time_text))
            .child(
                div()
                    .w(px(32.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        Button::new(SharedString::from(format!("trk-more-{idx}-{}", row.entry.key)))
                            .ghost()
                            .small()
                            .icon(Icon::new(Lucide::Ellipsis))
                            .tooltip("More")
                            .dropdown_menu(move |menu, _, _| {
                                let w1 = w.clone();
                                let w2 = w.clone();
                                let w3 = w.clone();
                                let sn = single_next.clone();
                                let sl = single_last.clone();
                                let ak = alb_key.clone();
                                menu.item(PopupMenuItem::new("Play next").on_click(move |_, window, cx| {
                                    let _ = w1.update(cx, |this, cx| {
                                        this.play_music_next(vec![sn.clone()], sn.album.clone(), window, cx);
                                    });
                                }))
                                .item(PopupMenuItem::new("Play last").on_click(move |_, window, cx| {
                                    let _ = w2.update(cx, |this, cx| {
                                        this.play_music_last(vec![sl.clone()], sl.album.clone(), window, cx);
                                    });
                                }))
                                .item(PopupMenuItem::new("Go to album").on_click(move |_, _, cx| {
                                    let _ = w3.update(cx, |this, cx| {
                                        this.open_detail(DetailView::Album(ak.clone()), cx);
                                    });
                                }))
                            }),
                    ),
            )
    }

    pub fn render_album_detail(&self, album_key: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(album) = self.catalog.album_by_key(album_key).cloned() else {
            return column()
                .py_12()
                .gap_3()
                .child(div().text_base().text_color(rgb(DIM)).child("This album is no longer in your library."))
                .child(
                    Button::new("alb-missing-back")
                        .ghost()
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                )
                .into_any_element();
        };

        let tracks = TrackItem::from_album(&album);
        let play_list = tracks.clone();
        let shuffle_list = tracks.clone();
        let next_list = tracks.clone();
        let last_list = tracks.clone();
        let album_title = album.album.clone();
        let shuffle_title = album.album.clone();
        let next_title = album.album.clone();
        let last_title = album.album.clone();
        let artist_key = fold(&album.artist);
        let current_key = self.music_queue.current().map(|c| c.entry.key.clone());

        let mut facts = vec![plural(album.items.len(), "track", "tracks")];
        if album.discs() > 1 {
            facts.insert(0, plural(album.discs(), "disc", "discs"));
        }
        facts.push(format_bytes(album.total_bytes()));
        facts.push(album.state_label());
        if album.releases > 1 {
            facts.push(plural(album.releases, "release", "releases"));
        }
        if album.all_yt {
            facts.push("YouTube · Lossy".to_string());
        }
        let can_delete_album = self.status.as_ref().is_some_and(|st| {
            st.writable
                && !st.channel.is_empty()
                && album.items.iter().all(|i| i.entry.source == st.channel)
        });
        let del_keys = album.all_keys.clone();

        let more_by: Vec<AlbumTile> = self
            .catalog
            .albums
            .iter()
            .filter(|a| fold(&a.artist) == artist_key && a.key != album.key)
            .take(5)
            .cloned()
            .collect();

        let weak = cx.entity().downgrade();

        column()
            .py_6()
            .gap_6()
            .child(
                h_flex().child(
                    Button::new("alb-back")
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
                    .child(album_sleeve(album.hue, album.seed, &album.monogram, 196.))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_2()
                            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Album"))
                            .child(div().text_2xl().font_weight(FontWeight::BOLD).child(album.album.clone()))
                            .when(!album.artist.is_empty(), |this| {
                                let ak = artist_key.clone();
                                this.child(
                                    div()
                                        .id("alb-artist-link")
                                        .text_base()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(rgb(BRAND))
                                        .cursor_pointer()
                                        .hover(|s| s.underline())
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.open_detail(DetailView::Artist(ak.clone()), cx);
                                        }))
                                        .child(album.artist.clone()),
                                )
                            })
                            .child(div().text_sm().text_color(rgb(DIM)).child(facts.join(" · ")))
                            .child(
                                h_flex()
                                    .pt_2()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(
                                        Button::new("alb-play-btn")
                                            .primary()
                                            .icon(Icon::new(Lucide::Play))
                                            .label("Play")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_list(play_list.clone(), 0, album_title.clone(), Some(false), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-shuffle-btn")
                                            .icon(Icon::new(Lucide::Shuffle))
                                            .label("Shuffle")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                // Rule 14: Shuffle on an album starts that list with shuffle on.
                                                this.play_music_list(shuffle_list.clone(), 0, shuffle_title.clone(), Some(true), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-play-next")
                                            .ghost()
                                            .label("Play next")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_next(next_list.clone(), next_title.clone(), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-play-last")
                                            .ghost()
                                            .label("Play last")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_last(last_list.clone(), last_title.clone(), window, cx);
                                            })),
                                    )
                                    .when(can_delete_album, |row| {
                                        let keys = del_keys.clone();
                                        row.child(
                                            Button::new("alb-delete")
                                                .ghost()
                                                .label("Delete")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    for k in &keys {
                                                        this.remove_channel_entry(k.clone(), cx);
                                                    }
                                                })),
                                        )
                                    }),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .border_t_1()
                    .border_color(rgb(LINE))
                    .children(tracks.iter().enumerate().map(|(idx, item)| {
                        let is_cur = current_key.as_deref() == Some(item.entry.key.as_str());
                        let list = tracks.clone();
                        let src = album.album.clone();
                        let sn = item.clone();
                        let sl = item.clone();
                        let dl_e = item.entry.clone();
                        let w = weak.clone();
                        let saved_note = if is_saved(&item.entry) { "" } else { "On the network" };
                        let artist_diff = !item.artist.is_empty() && item.artist != album.artist;
                        let mut sub_parts = Vec::new();
                        if artist_diff {
                            sub_parts.push(item.artist.as_str());
                        }
                        if !saved_note.is_empty() {
                            sub_parts.push(saved_note);
                        }
                        let sub_line = sub_parts.join(" · ");
                        h_flex()
                            .id(SharedString::from(format!("alb-trk-{idx}-{}", item.entry.key)))
                            .items_center()
                            .gap_3()
                            .px_3()
                            .py_2p5()
                            .border_b_1()
                            .border_color(hsla(0., 0., 1., 0.05))
                            .cursor_pointer()
                            .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.play_music_list(list.clone(), idx, src.clone(), None, window, cx);
                            }))
                            .child(
                                div()
                                    .w(px(36.))
                                    .text_xs()
                                    .text_right()
                                    .text_color(if is_cur { rgb(BRAND) } else { rgb(DIM) })
                                    .child(if is_cur {
                                        "▶".to_string()
                                    } else if !item.track_no.is_empty() {
                                        item.track_no.clone()
                                    } else {
                                        format!("{:02}", idx + 1)
                                    }),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_0p5()
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(if is_cur { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                                            .text_color(if is_cur { rgb(BRAND) } else { rgb(INK) })
                                            .truncate()
                                            .child(item.title.clone()),
                                    )
                                    .when(!sub_line.is_empty(), |d| d.child(div().text_xs().text_color(rgb(DIM)).child(sub_line))),
                            )
                            .child(div().text_xs().text_color(rgb(DIM)).child(format_bytes(item.entry.size)))
                            .child(
                                div()
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                    .child(
                                        Button::new(SharedString::from(format!("alb-trk-more-{idx}")))
                                            .ghost()
                                            .small()
                                            .icon(Icon::new(Lucide::Ellipsis))
                                            .tooltip("More")
                                            .dropdown_menu(move |menu, _, _| {
                                                let w1 = w.clone();
                                                let w2 = w.clone();
                                                let w3 = w.clone();
                                                let s1 = sn.clone();
                                                let s2 = sl.clone();
                                                let dl_title = sl.title.clone();
                                                let dl = dl_e.clone();
                                                menu.item(PopupMenuItem::new("Play next").on_click(move |_, window, cx| {
                                                    let _ = w1.update(cx, |this, cx| {
                                                        this.play_music_next(vec![s1.clone()], s1.album.clone(), window, cx);
                                                    });
                                                }))
                                                .item(PopupMenuItem::new("Play last").on_click(move |_, window, cx| {
                                                    let _ = w2.update(cx, |this, cx| {
                                                        this.play_music_last(vec![s2.clone()], s2.album.clone(), window, cx);
                                                    });
                                                }))
                                                .item(PopupMenuItem::new("Download").on_click(move |_, _, cx| {
                                                    let _ = w3.update(cx, |this, cx| {
                                                        this.download_entry(dl.clone(), Some(dl_title.clone()), cx);
                                                    });
                                                }))
                                            }),
                                    ),
                            )
                    })),
            )
            .when(!more_by.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_3()
                        .pt_2()
                        .child(div().text_base().font_weight(FontWeight::BOLD).child(format!("More by {}", album.artist)))
                        .child(
                            h_flex()
                                .gap_4()
                                .flex_wrap()
                                .children(more_by.into_iter().map(|other| {
                                    let ok = other.key.clone();
                                    v_flex()
                                        .id(SharedString::from(format!("more-by-{}", other.key)))
                                        .w(px(136.))
                                        .gap_1p5()
                                        .cursor_pointer()
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.open_detail(DetailView::Album(ok.clone()), cx);
                                        }))
                                        .child(album_sleeve(other.hue, other.seed, &other.monogram, 136.))
                                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(other.album))
                                })),
                        ),
                )
            })
            .into_any_element()
    }

    pub fn render_artist_detail(&self, artist_key: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(artist) = self.catalog.artist_by_key(artist_key).cloned() else {
            return column()
                .py_12()
                .gap_3()
                .child(div().text_base().text_color(rgb(DIM)).child("This artist is no longer in your library."))
                .child(
                    Button::new("art-missing-back")
                        .ghost()
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                )
                .into_any_element();
        };

        let albums: Vec<AlbumTile> = artist
            .album_keys
            .iter()
            .filter_map(|k| self.catalog.album_by_key(k).cloned())
            .collect();
        let all_tracks: Vec<TrackItem> = albums.iter().flat_map(TrackItem::from_album).collect();
        let play_all = all_tracks.clone();
        let shuffle_all = all_tracks.clone();
        let next_all = all_tracks.clone();
        let last_all = all_tracks.clone();
        let name_play = artist.name.clone();
        let name_shuf = artist.name.clone();
        let name_next = artist.name.clone();
        let name_last = artist.name.clone();
        let show_all = self.artist_show_all.contains(artist_key);
        let shown_count = if show_all { all_tracks.len() } else { all_tracks.len().min(8) };
        let current_key = self.music_queue.current().map(|c| c.entry.key.clone());
        let facts = format!(
            "{} · {}",
            plural(albums.len(), "album", "albums"),
            plural(artist.track_count, "track", "tracks")
        );
        let key_toggle = artist.key.clone();

        column()
            .py_6()
            .gap_6()
            .child(
                h_flex().child(
                    Button::new("art-back")
                        .ghost()
                        .small()
                        .icon(Icon::new(Lucide::ChevronLeft))
                        .label("Back")
                        .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                ),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_6()
                    .child(artist_sleeve_stack(&artist.sleeves, 148.))
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Artist"))
                            .child(div().text_2xl().font_weight(FontWeight::BOLD).child(artist.name.clone()))
                            .child(div().text_sm().text_color(rgb(DIM)).child(facts))
                            .child(
                                h_flex()
                                    .pt_1()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(
                                        Button::new("art-play")
                                            .primary()
                                            .icon(Icon::new(Lucide::Play))
                                            .label("Play")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_list(play_all.clone(), 0, name_play.clone(), Some(false), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-shuffle")
                                            .icon(Icon::new(Lucide::Shuffle))
                                            .label("Shuffle")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_list(shuffle_all.clone(), 0, name_shuf.clone(), Some(true), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-next")
                                            .ghost()
                                            .label("Play next")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_next(next_all.clone(), name_next.clone(), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-last")
                                            .ghost()
                                            .label("Play last")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_music_last(last_all.clone(), name_last.clone(), window, cx);
                                            })),
                                    ),
                            ),
                    ),
            )
            .child(
                v_flex()
                    .gap_3()
                    .child(div().text_base().font_weight(FontWeight::BOLD).child("Albums"))
                    .child(
                        h_flex()
                            .gap_4()
                            .flex_wrap()
                            .children(albums.into_iter().map(|alb| {
                                let ak = alb.key.clone();
                                v_flex()
                                    .id(SharedString::from(format!("art-alb-{}", alb.key)))
                                    .w(px(148.))
                                    .gap_1p5()
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_detail(DetailView::Album(ak.clone()), cx);
                                    }))
                                    .child(album_sleeve(alb.hue, alb.seed, &alb.monogram, 148.))
                                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(alb.album))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(plural(alb.items.len(), "track", "tracks")))
                            })),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_base().font_weight(FontWeight::BOLD).child("Tracks"))
                    .child(
                        v_flex()
                            .border_t_1()
                            .border_color(rgb(LINE))
                            .children(all_tracks.iter().enumerate().take(shown_count).map(|(idx, item)| {
                                let is_cur = current_key.as_deref() == Some(item.entry.key.as_str());
                                let list = all_tracks.clone();
                                let src = artist.name.clone();
                                h_flex()
                                    .id(SharedString::from(format!("art-trk-{idx}-{}", item.entry.key)))
                                    .items_center()
                                    .gap_3()
                                    .px_3()
                                    .py_2()
                                    .border_b_1()
                                    .border_color(hsla(0., 0., 1., 0.05))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.play_music_list(list.clone(), idx, src.clone(), None, window, cx);
                                    }))
                                    .child(
                                        div()
                                            .w(px(32.))
                                            .text_xs()
                                            .text_right()
                                            .text_color(if is_cur { rgb(BRAND) } else { rgb(DIM) })
                                            .child(if is_cur { "▶".to_string() } else { format!("{}", idx + 1) }),
                                    )
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_sm()
                                            .text_color(if is_cur { rgb(BRAND) } else { rgb(INK) })
                                            .truncate()
                                            .child(item.title.clone()),
                                    )
                                    .child(div().w(px(200.)).text_xs().text_color(rgb(DIM)).truncate().child(item.album.clone()))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(format_bytes(item.entry.size)))
                            })),
                    )
                    .when(!show_all && all_tracks.len() > 8, |this| {
                        let total = all_tracks.len();
                        this.child(
                            h_flex().pt_1().child(
                                Button::new("art-show-all-tracks")
                                    .ghost()
                                    .small()
                                    .label(format!("Show all {total}"))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.artist_show_all.insert(key_toggle.clone());
                                        cx.notify();
                                    })),
                            ),
                        )
                    }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use peartube::worker::Entry;

    use super::{TrackRow, TrackSortCol, sort_track_rows};

    fn mk_row(key: &str, name: &str, size: u64, is_yt: bool) -> TrackRow {
        TrackRow {
            entry: Entry {
                key: key.to_string(),
                size,
                ..Entry::default()
            },
            album_key: "alb:1".to_string(),
            album_title: "Album".to_string(),
            artist: "Artist".to_string(),
            track_no: "01".to_string(),
            track_name: name.to_string(),
            hue: 100,
            seed: 1,
            monogram: "AL".to_string(),
            is_yt,
            saved: true,
        }
    }

    #[test]
    fn unknown_quality_size_and_time_sort_last_in_both_directions() {
        let a = mk_row("a", "Alpha", 5_000, true);
        let b = mk_row("b", "Beta", 0, false);
        let c = mk_row("c", "Gamma", 2_000, false);
        let all = vec![&a, &b, &c];
        let mut durs = HashMap::new();
        durs.insert("a".to_string(), 240);
        durs.insert("c".to_string(), 120);

        // Size: b (0 = unknown) is always last
        let sz_asc = sort_track_rows(&all, "", TrackSortCol::Size, true, &durs);
        assert_eq!(sz_asc.iter().map(|r| r.entry.key.as_str()).collect::<Vec<_>>(), vec!["a", "c", "b"]);
        let sz_desc = sort_track_rows(&all, "", TrackSortCol::Size, false, &durs);
        assert_eq!(sz_desc.iter().map(|r| r.entry.key.as_str()).collect::<Vec<_>>(), vec!["c", "a", "b"]);

        // Time: b (missing) is always last
        let tm_asc = sort_track_rows(&all, "", TrackSortCol::Time, true, &durs);
        assert_eq!(tm_asc.iter().map(|r| r.entry.key.as_str()).collect::<Vec<_>>(), vec!["a", "c", "b"]);
        let tm_desc = sort_track_rows(&all, "", TrackSortCol::Time, false, &durs);
        assert_eq!(tm_desc.iter().map(|r| r.entry.key.as_str()).collect::<Vec<_>>(), vec!["c", "a", "b"]);

        // Quality: known (a) comes before unknowns (b, c) in both directions
        let q_asc = sort_track_rows(&all, "", TrackSortCol::Quality, true, &durs);
        assert_eq!(q_asc[0].entry.key, "a");
        let q_desc = sort_track_rows(&all, "", TrackSortCol::Quality, false, &durs);
        assert_eq!(q_desc[0].entry.key, "a");
    }
}
