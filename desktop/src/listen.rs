//! Listen room (`Albums`, `Artists`, `Tracks`), plus Album and Artist detail pages.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ops::Range;

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
use crate::list::{column, format_bytes, grid_columns};
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

fn compare_track_rows(
    a: &TrackRow,
    b: &TrackRow,
    sort_col: TrackSortCol,
    asc: bool,
    durations: &HashMap<String, u64>,
) -> Ordering {
    match sort_col {
        TrackSortCol::Order => Ordering::Equal,
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
    }
}

#[cfg_attr(not(test), allow(dead_code))]
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
        let ord = compare_track_rows(a, b, sort_col, asc, durations);
        if ord == Ordering::Equal { ia.cmp(ib) } else { ord }
    });

    indexed.into_iter().map(|(_, r)| r).collect()
}

impl PearTube {
    pub fn render_listen(&self, tab: ListenTab, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_any_music = !self.catalog.albums.is_empty() || !self.catalog.tracks.is_empty();
        if !has_any_music {
            return column()
                .py_6()
                .gap_5()
                .child(div().text_2xl().font_weight(FontWeight::BOLD).child("Listen"))
                .child(
                    v_flex()
                        .py_16()
                        .gap_3()
                        .items_center()
                        .text_center()
                        .child(div().text_lg().font_weight(FontWeight::BOLD).child("No music yet"))
                        .child(
                            div()
                                .text_sm()
                                .text_color(rgb(DIM))
                                .child("Add a folder, a link, or search your sources."),
                        )
                        .child(
                            h_flex()
                                .pt_2()
                                .gap_2()
                                .child(
                                    Button::new("listen-empty-add")
                                        .primary()
                                        .label("Add music")
                                        .on_click(cx.listener(|this, _, window, cx| this.open_add_modal(window, cx))),
                                )
                                .child(
                                    Button::new("listen-empty-discover")
                                        .label("Discover")
                                        .on_click(cx.listener(|this, _, _, cx| this.open_room(Room::Discover, cx))),
                                ),
                        ),
                )
                .into_any_element();
        }

        let saved_only = self.listen_saved_only;
        let album_indices: Vec<usize> = self
            .catalog
            .albums
            .iter()
            .enumerate()
            .filter(|(_, a)| !saved_only || a.saved > 0)
            .map(|(i, _)| i)
            .collect();
        let artist_indices: Vec<usize> = self
            .catalog
            .artists
            .iter()
            .enumerate()
            .filter(|(_, a)| !saved_only || a.saved_tracks > 0)
            .map(|(i, _)| i)
            .collect();
        let has_unfiltered_tracks = self.catalog.tracks.iter().any(|t| !saved_only || t.saved);
        let has_query = tab == ListenTab::Tracks && !self.track_filter.read(cx).value().trim().is_empty();
        let track_indices = if tab == ListenTab::Tracks {
            self.filtered_track_indices(cx)
        } else {
            Vec::new()
        };
        let has_tracks = if tab == ListenTab::Tracks {
            !track_indices.is_empty()
        } else {
            has_unfiltered_tracks
        };

        let count_text = match tab {
            ListenTab::Albums => plural(album_indices.len(), "album", "albums"),
            ListenTab::Artists => plural(artist_indices.len(), "artist", "artists"),
            ListenTab::Tracks => plural(track_indices.len(), "track", "tracks"),
        };

        let header = self.render_listen_header(&tab, &count_text, has_tracks, cx);

        let body: AnyElement = match tab {
            ListenTab::Albums => self.render_albums_grid(album_indices, window, cx).into_any_element(),
            ListenTab::Artists => self.render_artists_grid(artist_indices, window, cx).into_any_element(),
            ListenTab::Tracks => self
                .render_tracks_table(track_indices, has_unfiltered_tracks, has_query, cx)
                .into_any_element(),
        };

        v_flex()
            .size_full()
            .child(column().pt_6().pb_4().child(header))
            .child(div().flex_1().min_h_0().size_full().child(body))
            .into_any_element()
    }

    pub fn play_listen_tracks(
        &mut self,
        tab: ListenTab,
        shuffle_override: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (items, label) = if tab == ListenTab::Tracks {
            let indices = self.filtered_track_indices(cx);
            let list: Vec<TrackItem> = indices
                .iter()
                .filter_map(|&i| self.catalog.tracks.get(i))
                .map(TrackItem::from_track_row)
                .collect();
            (list, "Tracks".to_string())
        } else {
            let saved_only = self.listen_saved_only;
            let list: Vec<TrackItem> = self
                .catalog
                .tracks
                .iter()
                .filter(|t| !saved_only || t.saved)
                .map(TrackItem::from_track_row)
                .collect();
            (list, "Library".to_string())
        };
        self.play_music_list(items, 0, label, shuffle_override, window, cx);
    }

    fn render_listen_header(
        &self,
        tab: &ListenTab,
        count_text: &str,
        has_tracks: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let saved_only = self.listen_saved_only;
        let waiting = self.music_queue.current().is_some() && !self.music_is_playing();
        let tab_play = tab.clone();
        let tab_shuf = tab.clone();

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
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).child("Listen"))
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
                                    this.play_listen_tracks(tab_play.clone(), Some(false), window, cx);
                                }))
                        };
                        row.child(primary_btn).when(has_tracks, |r| {
                            r.child(
                                Button::new("listen-top-shuffle")
                                    .small()
                                    .icon(Icon::new(Lucide::Shuffle))
                                    .label("Shuffle")
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.play_listen_tracks(tab_shuf.clone(), Some(true), window, cx);
                                    })),
                            )
                        })
                    })
                    .child(div().text_sm().text_color(rgb(DIM)).child(count_text.to_string())),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Checkbox::new("listen-saved-only")
                            .checked(saved_only)
                            .label("Saved here")
                            .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                this.listen_saved_only = *checked;
                                cx.notify();
                            })),
                    )
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
                    ),
            )
    }

    fn render_album_card(&self, album: &AlbumTile, playing_album_key: Option<&str>, cx: &mut Context<Self>) -> Stateful<Div> {
        let open_key = album.key.clone();
        let play_key = album.key.clone();
        let is_playing_album = playing_album_key == Some(album.key.as_str());
        v_flex()
            .id(SharedString::from(format!("alb-card-{}", album.key)))
            .w(px(164.))
            .gap_2()
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open_detail(DetailView::Album(open_key.clone()), cx);
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
                                        this.play_album_key(&play_key, 0, None, window, cx);
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
    }

    fn render_albums_grid(&self, indices: Vec<usize>, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        if indices.is_empty() {
            return column()
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
        let cols = grid_columns(window, 164., 20.);
        let row_count = indices.len().div_ceil(cols);
        uniform_list(
            "listen-albums-grid",
            row_count,
            cx.processor(move |this, range: Range<usize>, _, cx| {
                let playing_key = this.music_queue.current().map(|c| c.album_key.clone());
                range
                    .map(|row_idx| {
                        let start = row_idx * cols;
                        let end = (start + cols).min(indices.len());
                        let cards: Vec<_> = indices[start..end]
                            .iter()
                            .filter_map(|&i| this.catalog.albums.get(i))
                            .map(|album| this.render_album_card(album, playing_key.as_deref(), cx))
                            .collect();
                        column().pb_5().child(h_flex().gap_5().children(cards))
                    })
                    .collect()
            }),
        )
        .size_full()
        .into_any_element()
    }

    fn render_artist_card(&self, artist: &ArtistGroup, cx: &mut Context<Self>) -> Stateful<Div> {
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
    }

    fn render_artists_grid(&self, indices: Vec<usize>, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        if indices.is_empty() {
            return column()
                .py_16()
                .text_center()
                .text_color(rgb(DIM))
                .child(if self.listen_saved_only {
                    "No artists saved on this Mac yet."
                } else {
                    "No artists in your library yet."
                })
                .into_any_element();
        }
        let cols = grid_columns(window, 164., 20.);
        let row_count = indices.len().div_ceil(cols);
        uniform_list(
            "listen-artists-grid",
            row_count,
            cx.processor(move |this, range: Range<usize>, _, cx| {
                range
                    .map(|row_idx| {
                        let start = row_idx * cols;
                        let end = (start + cols).min(indices.len());
                        let cards: Vec<_> = indices[start..end]
                            .iter()
                            .filter_map(|&i| this.catalog.artists.get(i))
                            .map(|artist| this.render_artist_card(artist, cx))
                            .collect();
                        column().pb_5().child(h_flex().gap_5().children(cards))
                    })
                    .collect()
            }),
        )
        .size_full()
        .into_any_element()
    }

    pub fn filtered_track_indices(&self, cx: &Context<Self>) -> Vec<usize> {
        let saved_only = self.listen_saved_only;
        let q = self.track_filter.read(cx).value().trim().to_lowercase();
        let mut indexed: Vec<(usize, usize)> = self
            .catalog
            .tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| !saved_only || t.saved)
            .filter(|(_, t)| {
                q.is_empty()
                    || t.track_name.to_lowercase().contains(&q)
                    || t.artist.to_lowercase().contains(&q)
                    || t.album_title.to_lowercase().contains(&q)
            })
            .map(|(cat_idx, _)| cat_idx)
            .enumerate()
            .collect();

        let (sort_col, asc) = self.track_sort;
        if sort_col == TrackSortCol::Order {
            if !asc {
                indexed.reverse();
            }
            return indexed.into_iter().map(|(_, cat_idx)| cat_idx).collect();
        }

        let tracks = &self.catalog.tracks;
        let durations = &self.track_durations;
        indexed.sort_by(|&(ia, ai), &(ib, bi)| {
            let ord = compare_track_rows(&tracks[ai], &tracks[bi], sort_col, asc, durations);
            if ord == Ordering::Equal { ia.cmp(&ib) } else { ord }
        });
        indexed.into_iter().map(|(_, cat_idx)| cat_idx).collect()
    }

    pub fn play_tracks_view_at(&mut self, entry_key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let indices = self.filtered_track_indices(cx);
        let items: Vec<TrackItem> = indices
            .iter()
            .filter_map(|&i| self.catalog.tracks.get(i))
            .map(TrackItem::from_track_row)
            .collect();
        let start_idx = items.iter().position(|t| t.entry.key == entry_key).unwrap_or(0);
        self.play_music_list(items, start_idx, "Tracks".to_string(), None, window, cx);
    }

    fn render_tracks_table(
        &self,
        row_indices: Vec<usize>,
        has_unfiltered_tracks: bool,
        has_query: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let (sort_col, asc) = self.track_sort;

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

        let empty_msg = if has_query {
            "No tracks match that filter."
        } else if self.listen_saved_only {
            "No tracks saved on this Mac yet."
        } else {
            "No tracks in your library yet."
        };

        let controls = column()
            .gap_3()
            .when(has_unfiltered_tracks, |this| {
                this.child(
                    div().max_w(px(340.)).child(
                        Input::new(&self.track_filter)
                            .prefix(Icon::new(Lucide::Search).text_color(rgb(DIM)))
                            .cleanable(true),
                    ),
                )
            })
            .when(!row_indices.is_empty(), |this| {
                this.child(
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
            });

        let list_body: AnyElement = if row_indices.is_empty() {
            column()
                .py_12()
                .text_center()
                .text_color(rgb(DIM))
                .child(empty_msg)
                .into_any_element()
        } else {
            let count = row_indices.len();
            uniform_list(
                "listen-tracks-table",
                count,
                cx.processor(move |this, range: Range<usize>, _, cx| {
                    let current_key = this.music_queue.current().map(|c| c.entry.key.clone());
                    range
                        .filter_map(|idx| {
                            let row = this.catalog.tracks.get(*row_indices.get(idx)?)?;
                            Some(this.render_track_table_row(idx, row, current_key.as_deref(), cx))
                        })
                        .collect()
                }),
            )
            .size_full()
            .into_any_element()
        };

        v_flex()
            .size_full()
            .child(controls)
            .child(div().flex_1().min_h_0().size_full().child(list_body))
    }

    fn render_track_table_row(
        &self,
        idx: usize,
        row: &TrackRow,
        current_key: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Div {
        let is_cur = current_key == Some(row.entry.key.as_str());
        let play_key = row.entry.key.clone();
        let menu_key = row.entry.key.clone();
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

        column().child(
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
                    this.play_tracks_view_at(&play_key, window, cx);
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
                                    let k1 = menu_key.clone();
                                    let k2 = menu_key.clone();
                                    let ak = alb_key.clone();
                                    menu.item(PopupMenuItem::new("Play next").on_click(move |_, window, cx| {
                                        let _ = w1.update(cx, |this, cx| {
                                            this.queue_track_entry(&k1, true, window, cx);
                                        });
                                    }))
                                    .item(PopupMenuItem::new("Play last").on_click(move |_, window, cx| {
                                        let _ = w2.update(cx, |this, cx| {
                                            this.queue_track_entry(&k2, false, window, cx);
                                        });
                                    }))
                                    .item(PopupMenuItem::new("Go to album").on_click(move |_, _, cx| {
                                        let _ = w3.update(cx, |this, cx| {
                                            this.open_detail(DetailView::Album(ak.clone()), cx);
                                        });
                                    }))
                                }),
                        ),
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
        let key_play = album.key.clone();
        let key_shuf = album.key.clone();
        let key_next = album.key.clone();
        let key_last = album.key.clone();
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
                                                this.play_album_key(&key_play, 0, Some(false), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-shuffle-btn")
                                            .icon(Icon::new(Lucide::Shuffle))
                                            .label("Shuffle")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                // Rule 14: Shuffle on an album starts that list with shuffle on.
                                                this.play_album_key(&key_shuf, 0, Some(true), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-play-next")
                                            .ghost()
                                            .label("Play next")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.queue_album_key(&key_next, true, window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("alb-play-last")
                                            .ghost()
                                            .label("Play last")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.queue_album_key(&key_last, false, window, cx);
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
                        let ak = album.key.clone();
                        let ek = item.entry.key.clone();
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
                                this.play_album_key(&ak, idx, None, window, cx);
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
                                                let k1 = ek.clone();
                                                let k2 = ek.clone();
                                                let k3 = ek.clone();
                                                menu.item(PopupMenuItem::new("Play next").on_click(move |_, window, cx| {
                                                    let _ = w1.update(cx, |this, cx| {
                                                        this.queue_track_entry(&k1, true, window, cx);
                                                    });
                                                }))
                                                .item(PopupMenuItem::new("Play last").on_click(move |_, window, cx| {
                                                    let _ = w2.update(cx, |this, cx| {
                                                        this.queue_track_entry(&k2, false, window, cx);
                                                    });
                                                }))
                                                .item(PopupMenuItem::new("Download").on_click(move |_, _, cx| {
                                                    let _ = w3.update(cx, |this, cx| {
                                                        this.download_track_entry(&k3, cx);
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
        let key_play = artist.key.clone();
        let key_shuf = artist.key.clone();
        let key_next = artist.key.clone();
        let key_last = artist.key.clone();
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
                                                this.play_artist_key(&key_play, 0, Some(false), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-shuffle")
                                            .icon(Icon::new(Lucide::Shuffle))
                                            .label("Shuffle")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.play_artist_key(&key_shuf, 0, Some(true), window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-next")
                                            .ghost()
                                            .label("Play next")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.queue_artist_key(&key_next, true, window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("art-last")
                                            .ghost()
                                            .label("Play last")
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.queue_artist_key(&key_last, false, window, cx);
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
                                let ak = artist.key.clone();
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
                                        this.play_artist_key(&ak, idx, None, window, cx);
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
