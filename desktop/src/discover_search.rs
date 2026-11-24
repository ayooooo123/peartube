//! Discover and unified Search rooms.
//! Discover has no field of its own (Rule 16): `Search other relays` focuses the
//! top-bar search field, and artist chips jump into Search and ask other relays.

#![forbid(unsafe_code)]

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::app::{DetailView, PearTube};
use crate::catalog::{AlbumTile, TrackRow, VideoTile, plural};
use crate::list::{column, format_bytes};
use crate::music::TrackItem;
use crate::sleeves::{album_sleeve, video_art};
use crate::theme::{CARD, CARD_ELEVATED, DIM, INK, LINE};

fn looks_like_link_or_key(s: &str) -> bool {
    let trimmed = s.trim();
    let is_key = trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
    trimmed.to_ascii_lowercase().starts_with("peartube:") || is_key
}

impl PearTube {
    pub fn render_discover(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let discovered = self
            .status
            .as_ref()
            .map(|s| s.discovered_sources.clone())
            .unwrap_or_default();
        let artists: Vec<String> = self
            .catalog
            .artists
            .iter()
            .filter(|a| !a.name.is_empty() && a.name != "Unknown artist")
            .take(24)
            .map(|a| a.name.clone())
            .collect();

        column()
            .py_6()
            .gap_8()
            .child(
                v_flex()
                    .gap_2()
                    .child(div().text_xl().font_weight(FontWeight::BOLD).child("Discover"))
                    .child(div().text_sm().text_color(rgb(DIM)).child("Find music and video on other relays and channels on your network."))
                    .child(
                        h_flex().pt_1().child(
                            Button::new("disc-search-relays")
                                .primary()
                                .icon(Icon::new(Lucide::Search))
                                .label("Search other relays")
                                .on_click(cx.listener(|this, _, window, cx| this.focus_search(window, cx))),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .gap_3()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("Channels on your network"))
                    .when(discovered.is_empty(), |this| {
                        this.child(
                            div()
                                .text_sm()
                                .text_color(rgb(DIM))
                                .child("No channels advertising on your local network right now."),
                        )
                    })
                    .when(!discovered.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .border_t_1()
                                .border_color(rgb(LINE))
                                .children(discovered.into_iter().map(|d| {
                                    let title = if d.title.is_empty() {
                                        format!("{}…", &d.key[..8.min(d.key.len())])
                                    } else {
                                        d.title.clone()
                                    };
                                    let via = if d.via.is_empty() { "Local network".to_string() } else { d.via.clone() };
                                    let disc_clone = d.clone();
                                    h_flex()
                                        .id(SharedString::from(format!("disc-src-{}", d.key)))
                                        .justify_between()
                                        .items_center()
                                        .py_3()
                                        .px_2()
                                        .border_b_1()
                                        .border_color(hsla(0., 0., 1., 0.06))
                                        .child(
                                            v_flex()
                                                .gap_0p5()
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title))
                                                .child(div().text_xs().text_color(rgb(DIM)).child(via)),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("disc-follow-{}", d.key)))
                                                .small()
                                                .label("Follow")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.subscribe_discovered(disc_clone.clone(), cx);
                                                })),
                                        )
                                })),
                        )
                    }),
            )
            .when(!artists.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_3()
                        .child(div().text_lg().font_weight(FontWeight::BOLD).child("More from artists you have"))
                        .child(
                            h_flex()
                                .gap_2()
                                .flex_wrap()
                                .children(artists.into_iter().enumerate().map(|(idx, name)| {
                                    let q = name.clone();
                                    div()
                                        .id(SharedString::from(format!("disc-artist-chip-{idx}")))
                                        .px_3()
                                        .py_1p5()
                                        .rounded(px(99.))
                                        .bg(rgb(CARD))
                                        .border_1()
                                        .border_color(rgb(LINE))
                                        .text_sm()
                                        .text_color(rgb(INK))
                                        .cursor_pointer()
                                        .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.search_for_artist(q.clone(), window, cx);
                                        }))
                                        .child(name)
                                })),
                        ),
                )
            })
            .child(div().pt_2().text_xs().text_color(rgb(DIM)).child("Planned: Rumble, SoundCloud."))
    }

    pub fn render_search(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let raw = self.search.read(cx).value().to_string();
        let trimmed = raw.trim();
        let query = trimmed.to_lowercase();

        if trimmed.is_empty() {
            let sample_artists: Vec<String> = self
                .catalog
                .artists
                .iter()
                .filter(|a| !a.name.is_empty() && a.name != "Unknown artist")
                .take(8)
                .map(|a| a.name.clone())
                .collect();

            return column()
                .py_8()
                .gap_4()
                .child(div().text_lg().font_weight(FontWeight::BOLD).child("Search your library and other relays"))
                .child(div().text_sm().text_color(rgb(DIM)).child("Type in the search bar to filter your library, or press Enter to ask other relays."))
                .when(!sample_artists.is_empty(), |this| {
                    this.child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .children(sample_artists.into_iter().enumerate().map(|(idx, name)| {
                                let q = name.clone();
                                div()
                                    .id(SharedString::from(format!("search-hint-chip-{idx}")))
                                    .px_3()
                                    .py_1p5()
                                    .rounded(px(99.))
                                    .bg(rgb(CARD))
                                    .border_1()
                                    .border_color(rgb(LINE))
                                    .text_sm()
                                    .cursor_pointer()
                                    .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.search_for_artist(q.clone(), window, cx);
                                    }))
                                    .child(name)
                            })),
                    )
                })
                .into_any_element();
        }

        let is_link = looks_like_link_or_key(trimmed);
        let link_str = trimmed.to_string();

        let matched_albums: Vec<&AlbumTile> = self
            .catalog
            .albums
            .iter()
            .filter(|a| {
                a.album.to_lowercase().contains(&query)
                    || a.artist.to_lowercase().contains(&query)
                    || a.title.to_lowercase().contains(&query)
            })
            .take(12)
            .collect();

        let matched_tracks: Vec<&TrackRow> = self
            .catalog
            .tracks
            .iter()
            .filter(|t| {
                t.track_name.to_lowercase().contains(&query)
                    || t.artist.to_lowercase().contains(&query)
                    || t.album_title.to_lowercase().contains(&query)
            })
            .take(24)
            .collect();
        let track_items: Vec<TrackItem> = matched_tracks.iter().map(|r| TrackItem::from_track_row(r)).collect();

        let matched_ms: Vec<&VideoTile> = self
            .catalog
            .movies
            .iter()
            .chain(self.catalog.series.iter())
            .filter(|v| {
                v.title.to_lowercase().contains(&query)
                    || v.imdb.as_deref().is_some_and(|i| i.to_lowercase().contains(&query))
            })
            .take(12)
            .collect();

        let matched_clips: Vec<&VideoTile> = self
            .catalog
            .clips
            .iter()
            .filter(|v| v.title.to_lowercase().contains(&query))
            .take(12)
            .collect();

        let any_local = !matched_albums.is_empty()
            || !matched_tracks.is_empty()
            || !matched_ms.is_empty()
            || !matched_clips.is_empty();

        let ask_query = trimmed.to_string();

        column()
            .py_6()
            .gap_6()
            .when(is_link, |this| {
                let u1 = link_str.clone();
                this.child(
                    h_flex()
                        .justify_between()
                        .items_center()
                        .p_4()
                        .rounded(px(12.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap_0p5()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("PearTube link or channel key"))
                                .child(div().text_xs().text_color(rgb(DIM)).truncate().child(link_str.clone())),
                        )
                        .child(
                            Button::new("search-open-link")
                                .primary()
                                .small()
                                .label("Add to library")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.search.update(cx, |inp, cx| inp.set_value("", window, cx));
                                    this.open_uri_or_key(u1.clone(), cx);
                                })),
                        ),
                )
            })
            .child(
                v_flex()
                    .gap_4()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("In your library"))
                    .when(!any_local, |this| {
                        this.child(div().text_sm().text_color(rgb(DIM)).child("Nothing in your library matches that search."))
                    })
                    .when(!matched_albums.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Albums"))
                                .child(
                                    h_flex()
                                        .gap_4()
                                        .flex_wrap()
                                        .children(matched_albums.into_iter().map(|alb| {
                                            let ak = alb.key.clone();
                                            v_flex()
                                                .id(SharedString::from(format!("srch-alb-{}", alb.key)))
                                                .w(px(136.))
                                                .gap_1p5()
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_detail(DetailView::Album(ak.clone()), cx);
                                                }))
                                                .child(album_sleeve(alb.hue, alb.seed, &alb.monogram, 136.))
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(alb.album.clone()))
                                                .child(div().text_xs().text_color(rgb(DIM)).truncate().child(alb.artist.clone()))
                                        })),
                                ),
                        )
                    })
                    .when(!matched_tracks.is_empty(), |this| {
                        let search_src = format!("Search: {trimmed}");
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Tracks"))
                                .child(
                                    v_flex()
                                        .border_t_1()
                                        .border_color(rgb(LINE))
                                        .children(matched_tracks.into_iter().enumerate().map(|(idx, row)| {
                                            let list = track_items.clone();
                                            let src = search_src.clone();
                                            h_flex()
                                                .id(SharedString::from(format!("srch-trk-{idx}-{}", row.entry.key)))
                                                .items_center()
                                                .gap_3()
                                                .px_2()
                                                .py_2()
                                                .border_b_1()
                                                .border_color(hsla(0., 0., 1., 0.05))
                                                .cursor_pointer()
                                                .hover(|s| s.bg(hsla(0., 0., 1., 0.03)))
                                                .on_click(cx.listener(move |this, _, window, cx| {
                                                    this.play_music_list(list.clone(), idx, src.clone(), None, window, cx);
                                                }))
                                                .child(album_sleeve(row.hue, row.seed, &row.monogram, 34.))
                                                .child(
                                                    v_flex()
                                                        .flex_1()
                                                        .min_w_0()
                                                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).truncate().child(row.track_name.clone()))
                                                        .child(
                                                            div()
                                                                .text_xs()
                                                                .text_color(rgb(DIM))
                                                                .truncate()
                                                                .child(format!("{} · {}", row.artist, row.album_title)),
                                                        ),
                                                )
                                                .child(div().text_xs().text_color(rgb(DIM)).child(format_bytes(row.entry.size)))
                                        })),
                                ),
                        )
                    })
                    .when(!matched_ms.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Movies and series"))
                                .child(
                                    h_flex()
                                        .gap_4()
                                        .flex_wrap()
                                        .children(matched_ms.into_iter().map(|tile| {
                                            let tk = tile.key.clone();
                                            let sub = tile.subtitle_line(format_bytes);
                                            v_flex()
                                                .id(SharedString::from(format!("srch-ms-{}", tile.key)))
                                                .w(px(136.))
                                                .gap_1p5()
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_detail(DetailView::Title(tk.clone()), cx);
                                                }))
                                                .child(video_art(&tile.title, tile.year.as_deref(), 136., 200.))
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(tile.title.clone()))
                                                .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub))
                                        })),
                                ),
                        )
                    })
                    .when(!matched_clips.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("Clips"))
                                .child(
                                    h_flex()
                                        .gap_4()
                                        .flex_wrap()
                                        .children(matched_clips.into_iter().map(|tile| {
                                            let tk = tile.key.clone();
                                            let sub = tile.subtitle_line(format_bytes);
                                            v_flex()
                                                .id(SharedString::from(format!("srch-clip-{}", tile.key)))
                                                .w(px(200.))
                                                .gap_1p5()
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_detail(DetailView::Title(tk.clone()), cx);
                                                }))
                                                .child(video_art(&tile.title, Some("Clip"), 200., 112.))
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(tile.title.clone()))
                                                .child(div().text_xs().text_color(rgb(DIM)).truncate().child(sub))
                                        })),
                                ),
                        )
                    }),
            )
            .when(!is_link, |this| {
                this.child(self.render_other_relays_section(trimmed, ask_query, cx))
            })
            .into_any_element()
    }

    fn render_other_relays_section(&self, typed: &str, ask_query: String, cx: &mut Context<Self>) -> impl IntoElement {
        let g = &self.global;
        let asked = g.query == typed;
        let note: Option<String> = if !asked {
            Some("Press Enter or choose Ask other relays to look outside your followed channels.".into())
        } else if let Some(err) = &g.error {
            Some(err.to_string())
        } else if g.rows.is_empty() {
            Some(if g.busy {
                "Asking other relays…".into()
            } else {
                "No relay has answered yet. Answers can take a few seconds.".into()
            })
        } else {
            None
        };

        v_flex()
            .gap_3()
            .pt_4()
            .border_t_1()
            .border_color(rgb(LINE))
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("On other relays"))
                    .child(
                        Button::new("search-ask-relays")
                            .small()
                            .label(if g.busy && asked { "Asking…" } else { "Ask other relays" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.search_global(ask_query.clone(), cx);
                            })),
                    ),
            )
            .when_some(note, |this, n| this.child(div().text_sm().text_color(rgb(DIM)).child(n)))
            .when(asked && !g.rows.is_empty(), |this| {
                this.children(g.rows.iter().map(|row| {
                    let uri = row.magnet_url.clone();
                    let meta = format!(
                        "{} · {}",
                        format_bytes(row.size),
                        plural(row.relays as usize, "relay", "relays")
                    );
                    h_flex()
                        .id(SharedString::from(format!("global-{}", row.key)))
                        .justify_between()
                        .items_center()
                        .gap_3()
                        .p_3()
                        .rounded(px(12.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(row.title.clone()))
                                .child(div().text_xs().text_color(rgb(DIM)).child(meta)),
                        )
                        .child(
                            Button::new(SharedString::from(format!("global-play-{}", row.key)))
                                .primary()
                                .small()
                                .label("Play")
                                .on_click(cx.listener(move |this, _, _, cx| this.open_uri_or_key(uri.clone(), cx))),
                        )
                }))
            })
    }
}
