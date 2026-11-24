//! Discover, unified Search (library + sources + other relays), and Soulseek shelf browser.
//! Discover has no field of its own (Rule 16): `Search sources & relays` focuses the
//! top-bar search field, and artist chips jump into Search and ask both sources and other relays.

#![forbid(unsafe_code)]

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::api::{
    ALL_SOURCES, format_duration, group_soulseek_candidates, is_web_url, unwrap_peartube_add,
};
use crate::app::{DetailView, PearTube};
use crate::catalog::{AlbumTile, TrackRow, VideoTile, plural};
use crate::list::{column, format_bytes};
use crate::music::TrackItem;
use crate::sleeves::{album_sleeve, video_art};
use crate::theme::{ACCENT, BG, BRAND, CARD, CARD_ELEVATED, DANGER, DIM, INK, LINE};

fn looks_like_peartube_link_or_key(s: &str) -> bool {
    let trimmed = s.trim();
    if unwrap_peartube_add(trimmed).is_some() {
        return false;
    }
    let is_key = trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit());
    trimmed.to_ascii_lowercase().starts_with("peartube:") || is_key
}

fn looks_like_web_link(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if let Some(target) = unwrap_peartube_add(trimmed) {
        return Some(target);
    }
    if is_web_url(trimmed) && !trimmed.contains(char::is_whitespace) {
        return Some(trimmed.to_string());
    }
    None
}

impl PearTube {
    pub fn render_discover(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let discovered = self
            .status
            .as_ref()
            .map(|s| s.discovered_sources.clone())
            .unwrap_or_default();
        let visited_shelves = self.visited_shelves.clone();
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
                    .child(
                        div()
                            .text_sm()
                            .text_color(rgb(DIM))
                            .child("Find music and video from your sources, Soulseek shelves, other relays, and channels on your network."),
                    )
                    .child(
                        h_flex().pt_1().child(
                            Button::new("disc-search-relays")
                                .primary()
                                .icon(Icon::new(Lucide::Search))
                                .label("Search sources & relays")
                                .on_click(cx.listener(|this, _, window, cx| this.focus_search(window, cx))),
                        ),
                    ),
            )
            .child(
                v_flex()
                    .gap_3()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("Shelves you visited"))
                    .when(visited_shelves.is_empty(), |this| {
                        this.child(
                            div()
                                .text_sm()
                                .text_color(rgb(DIM))
                                .child("Peer shelves you browse from Soulseek search results will show up here."),
                        )
                    })
                    .when(!visited_shelves.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .border_t_1()
                                .border_color(rgb(LINE))
                                .children(visited_shelves.into_iter().map(|shelf| {
                                    let peer_open = shelf.peer.clone();
                                    let peer_rm = shelf.peer.clone();
                                    let meta = if shelf.tracks > 0 {
                                        format!(
                                            "{} · {}",
                                            plural(shelf.tracks, "track", "tracks"),
                                            format_bytes(shelf.size)
                                        )
                                    } else {
                                        "Soulseek peer".to_string()
                                    };
                                    h_flex()
                                        .id(SharedString::from(format!("disc-shelf-{}", shelf.peer)))
                                        .justify_between()
                                        .items_center()
                                        .py_3()
                                        .px_2()
                                        .border_b_1()
                                        .border_color(hsla(0., 0., 1., 0.06))
                                        .child(
                                            v_flex()
                                                .gap_0p5()
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(shelf.peer.clone()))
                                                .child(div().text_xs().text_color(rgb(DIM)).child(meta)),
                                        )
                                        .child(
                                            h_flex()
                                                .gap_1p5()
                                                .child(
                                                    Button::new(SharedString::from(format!("disc-shelf-open-{}", shelf.peer)))
                                                        .small()
                                                        .label("Browse shelf")
                                                        .on_click(cx.listener(move |this, _, _, cx| {
                                                            this.open_shelf(peer_open.clone(), false, cx);
                                                        })),
                                                )
                                                .child(
                                                    Button::new(SharedString::from(format!("disc-shelf-rm-{}", shelf.peer)))
                                                        .ghost()
                                                        .small()
                                                        .icon(Icon::new(Lucide::X))
                                                        .tooltip("Remove from visited shelves")
                                                        .on_click(cx.listener(move |this, _, _, cx| {
                                                            this.remove_visited_shelf(peer_rm.clone(), cx);
                                                        })),
                                                ),
                                        )
                                })),
                        )
                    }),
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
                .child(div().text_lg().font_weight(FontWeight::BOLD).child("Search your library, sources, and other relays"))
                .child(
                    div()
                        .text_sm()
                        .text_color(rgb(DIM))
                        .child("Type in the search bar to filter your library, or press Enter to ask your sources and other relays."),
                )
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

        let web_link = looks_like_web_link(trimmed);
        let is_pt_link = looks_like_peartube_link_or_key(trimmed);
        let is_any_link = web_link.is_some() || is_pt_link;
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
            .when_some(web_link, |this, target| {
                let target_click = target.clone();
                this.child(
                    h_flex()
                        .justify_between()
                        .items_center()
                        .gap_3()
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
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Web or media link"))
                                .child(div().text_xs().text_color(rgb(DIM)).truncate().child(target)),
                        )
                        .child(
                            Button::new("search-identify-web-link")
                                .primary()
                                .small()
                                .label("Identify & save")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.search.update(cx, |inp, cx| inp.set_value("", window, cx));
                                    this.open_add_modal_with_url(target_click.clone(), window, cx);
                                })),
                        ),
                )
            })
            .when(is_pt_link, |this| {
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
            .when(!is_any_link, |this| {
                this.child(
                    h_flex()
                        .items_start()
                        .gap_6()
                        .pt_4()
                        .border_t_1()
                        .border_color(rgb(LINE))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(self.render_sources_section(trimmed, ask_query.clone(), cx)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(self.render_other_relays_section(trimmed, ask_query, cx)),
                        ),
                )
            })
            .into_any_element()
    }

    fn render_sources_section(&self, typed: &str, ask_query: String, cx: &mut Context<Self>) -> impl IntoElement {
        let s = &self.source_search;
        let asked = s.query == typed;
        let result = if asked { s.result.as_ref() } else { None };
        let ask_both = ask_query.clone();

        let soulseek_groups = result
            .filter(|_| s.enabled.contains("soulseek"))
            .map(|r| group_soulseek_candidates(&r.soulseek))
            .unwrap_or_default();
        let youtube_rows = result
            .filter(|_| s.enabled.contains("youtube"))
            .map(|r| r.youtube.clone())
            .unwrap_or_default();
        let soundcloud_rows = result
            .filter(|_| s.enabled.contains("soundcloud"))
            .map(|r| r.soundcloud.clone())
            .unwrap_or_default();
        let rumble_rows = result
            .filter(|_| s.enabled.contains("rumble"))
            .map(|r| r.rumble.clone())
            .unwrap_or_default();
        let source_errors: Vec<(String, String)> = result
            .map(|r| {
                ALL_SOURCES
                    .iter()
                    .filter_map(|(id, label)| {
                        if !s.enabled.contains(*id) {
                            return None;
                        }
                        r.errors.get(*id).map(|msg| ((*label).to_string(), msg.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let any_hits = !soulseek_groups.is_empty()
            || !youtube_rows.is_empty()
            || !soundcloud_rows.is_empty()
            || !rumble_rows.is_empty();

        let note: Option<String> = if !asked {
            Some("Press Enter or choose Ask your sources to search Soulseek, YouTube, SoundCloud, and Rumble.".into())
        } else if let Some(err) = &s.error {
            Some(err.to_string())
        } else if s.busy && !any_hits {
            Some("Asking your sources…".into())
        } else if !s.busy && !any_hits && source_errors.is_empty() {
            Some("No matches found on the selected sources.".into())
        } else {
            None
        };

        v_flex()
            .gap_3()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("From your sources"))
                    .child(
                        Button::new("search-ask-sources")
                            .small()
                            .primary()
                            .disabled(s.busy && asked)
                            .label(if s.busy && asked { "Asking…" } else { "Ask your sources" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.search_global(ask_both.clone(), cx);
                                this.search_sources(ask_both.clone(), cx);
                            })),
                    ),
            )
            // Toggleable source chips
            .child(
                h_flex()
                    .gap_1p5()
                    .flex_wrap()
                    .children(ALL_SOURCES.iter().map(|(id, label)| {
                        let on = s.enabled.contains(*id);
                        let count = result.map(|r| r.count_for(id)).unwrap_or(0);
                        let chip_text = if asked && count > 0 {
                            format!("{label} ({count})")
                        } else {
                            (*label).to_string()
                        };
                        let toggle_id = (*id).to_string();
                        div()
                            .id(SharedString::from(format!("source-chip-{id}")))
                            .px_2p5()
                            .py_1()
                            .rounded(px(99.))
                            .bg(if on { rgb(CARD_ELEVATED) } else { rgb(CARD) })
                            .border_1()
                            .border_color(if on { rgb(BRAND) } else { rgb(LINE) })
                            .text_xs()
                            .font_weight(if on { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                            .text_color(if on { rgb(INK) } else { rgb(DIM) })
                            .cursor_pointer()
                            .hover(|st| st.bg(rgb(CARD_ELEVATED)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.toggle_source_chip(toggle_id.clone(), cx);
                            }))
                            .child(chip_text)
                    })),
            )
            .when_some(note, |this, n| this.child(div().text_sm().text_color(rgb(DIM)).child(n)))
            // Per-source error notes (e.g. Soulseek not configured)
            .when(!source_errors.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_1p5()
                        .children(source_errors.into_iter().enumerate().map(|(idx, (src, msg))| {
                            let is_slsk_unconfigured =
                                src == "Soulseek" && msg.to_ascii_lowercase().contains("not configured");
                            h_flex()
                                .id(SharedString::from(format!("source-err-{idx}")))
                                .justify_between()
                                .items_center()
                                .gap_2()
                                .px_3()
                                .py_2()
                                .rounded(px(10.))
                                .bg(rgb(CARD))
                                .border_1()
                                .border_color(rgb(LINE))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_xs()
                                        .text_color(rgb(DIM))
                                        .child(format!("{src}: {msg}")),
                                )
                                .when(is_slsk_unconfigured, |row| {
                                    row.child(
                                        Button::new("source-err-open-settings")
                                            .ghost()
                                            .small()
                                            .label("Settings")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.open_settings(window, cx);
                                            })),
                                    )
                                })
                        })),
                )
            })
            // Soulseek results (grouped by peer + album folder)
            .when(!soulseek_groups.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("SOULSEEK"))
                        .children(soulseek_groups.into_iter().take(20).enumerate().map(|(idx, grp)| {
                            let peer_save = grp.peer.clone();
                            let peer_browse = grp.peer.clone();
                            let files = grp.files.clone();
                            let save_title = grp.title.clone();
                            let readiness = if grp.slots && grp.queue == 0 {
                                "Ready".to_string()
                            } else if grp.queue > 0 {
                                format!("Queue {}", grp.queue)
                            } else {
                                "Busy".to_string()
                            };
                            let meta = format!(
                                "{} · {} · {} · {} · {readiness}",
                                grp.peer,
                                plural(grp.files.len(), "track", "tracks"),
                                format_bytes(grp.total_size),
                                grp.format_label
                            );
                            h_flex()
                                .id(SharedString::from(format!("slsk-grp-{idx}-{}", grp.peer)))
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
                                        .gap_0p5()
                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(grp.title.clone()))
                                        .child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta)),
                                )
                                .child(
                                    h_flex()
                                        .gap_1p5()
                                        .child(
                                            Button::new(SharedString::from(format!("slsk-shelf-{idx}")))
                                                .ghost()
                                                .small()
                                                .label("Browse shelf")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_shelf(peer_browse.clone(), false, cx);
                                                })),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("slsk-save-{idx}")))
                                                .primary()
                                                .small()
                                                .label("Save album")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.mirror_soulseek_files(
                                                        peer_save.clone(),
                                                        files.clone(),
                                                        Some(save_title.clone()),
                                                        cx,
                                                    );
                                                })),
                                        ),
                                )
                        })),
                )
            })
            // YouTube results
            .when(!youtube_rows.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("YOUTUBE"))
                        .children(youtube_rows.into_iter().take(15).enumerate().map(|(idx, cand)| {
                            let save_cand = cand.clone();
                            let mut parts: Vec<String> = Vec::new();
                            if let Some(ch) = &cand.channel {
                                parts.push(ch.clone());
                            }
                            if let Some(len) = cand.length {
                                parts.push(format_duration(len));
                            }
                            if let Some(br) = cand.bitrate {
                                parts.push(format!("AAC {br}k"));
                            }
                            let meta = parts.join(" · ");
                            h_flex()
                                .id(SharedString::from(format!("yt-row-{idx}-{}", cand.video_id)))
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
                                        .gap_0p5()
                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(cand.title.clone()))
                                        .when(!meta.is_empty(), |col| {
                                            col.child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta))
                                        }),
                                )
                                .child(
                                    Button::new(SharedString::from(format!("yt-save-{idx}")))
                                        .primary()
                                        .small()
                                        .label("Save track")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.mirror_youtube_candidate(save_cand.clone(), cx);
                                        })),
                                )
                        })),
                )
            })
            // SoundCloud results
            .when(!soundcloud_rows.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("SOUNDCLOUD"))
                        .children(soundcloud_rows.into_iter().take(15).enumerate().map(|(idx, cand)| {
                            let save_cand = cand.clone();
                            let mut parts: Vec<String> = Vec::new();
                            if let Some(artist) = &cand.artist {
                                parts.push(artist.clone());
                            }
                            if let Some(len) = cand.length {
                                parts.push(format_duration(len));
                            }
                            let meta = parts.join(" · ");
                            h_flex()
                                .id(SharedString::from(format!("sc-row-{idx}")))
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
                                        .gap_0p5()
                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(cand.title.clone()))
                                        .when(!meta.is_empty(), |col| {
                                            col.child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta))
                                        }),
                                )
                                .child(
                                    Button::new(SharedString::from(format!("sc-save-{idx}")))
                                        .primary()
                                        .small()
                                        .label("Save track")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.mirror_soundcloud_candidate(save_cand.clone(), cx);
                                        })),
                                )
                        })),
                )
            })
            // Rumble results
            .when(!rumble_rows.is_empty(), |this| {
                this.child(
                    v_flex()
                        .gap_2()
                        .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(rgb(DIM)).child("RUMBLE"))
                        .children(rumble_rows.into_iter().take(15).enumerate().map(|(idx, cand)| {
                            let save_vid = cand.clone();
                            let save_aud = cand.clone();
                            let mut parts: Vec<String> = Vec::new();
                            if let Some(ch) = &cand.channel {
                                parts.push(ch.clone());
                            }
                            if let Some(len) = cand.length {
                                parts.push(format_duration(len));
                            }
                            let meta = parts.join(" · ");
                            h_flex()
                                .id(SharedString::from(format!("rm-row-{idx}")))
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
                                        .gap_0p5()
                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(cand.title.clone()))
                                        .when(!meta.is_empty(), |col| {
                                            col.child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta))
                                        }),
                                )
                                .child(
                                    h_flex()
                                        .gap_1p5()
                                        .child(
                                            Button::new(SharedString::from(format!("rm-save-aud-{idx}")))
                                                .ghost()
                                                .small()
                                                .label("Save audio")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.mirror_rumble_candidate(save_aud.clone(), true, cx);
                                                })),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("rm-save-vid-{idx}")))
                                                .primary()
                                                .small()
                                                .label("Save video")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.mirror_rumble_candidate(save_vid.clone(), false, cx);
                                                })),
                                        ),
                                )
                        })),
                )
            })
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

    /// Soulseek peer shelf browser (`DetailView::Shelf(peer)`).
    pub fn render_shelf_detail(&self, peer: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let state = &self.shelf;
        let matching = state.peer == peer;
        let busy = matching && state.busy;
        let error = if matching { state.error.clone() } else { None };
        let data = if matching { state.data.as_ref() } else { None };
        let folders = data.map(|d| d.folders()).unwrap_or_default();
        let peer_refresh = peer.to_string();
        let summary = data.map(|d| {
            format!(
                "{} across {} · {}{}",
                plural(d.tracks, "track", "tracks"),
                plural(folders.len(), "folder", "folders"),
                format_bytes(d.size),
                if d.cached { " · cached" } else { "" }
            )
        });

        column()
            .py_6()
            .gap_6()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_3()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_3()
                            .child(
                                Button::new("shelf-back")
                                    .ghost()
                                    .small()
                                    .icon(Icon::new(Lucide::ChevronLeft))
                                    .label("Back")
                                    .on_click(cx.listener(|this, _, _, cx| this.close_detail(cx))),
                            )
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_xl().font_weight(FontWeight::BOLD).child(format!("{peer}'s shelf")))
                                    .when_some(summary, |col, s| {
                                        col.child(div().text_xs().text_color(rgb(DIM)).child(s))
                                    }),
                            ),
                    )
                    .child(
                        Button::new("shelf-refresh")
                            .ghost()
                            .small()
                            .disabled(busy)
                            .label(if busy { "Loading…" } else { "Refresh" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.open_shelf(peer_refresh.clone(), true, cx);
                            })),
                    ),
            )
            .when_some(error, |this, err| {
                this.child(
                    div()
                        .p_4()
                        .rounded(px(12.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .text_sm()
                        .text_color(rgb(DANGER))
                        .child(err),
                )
            })
            .when(busy && folders.is_empty(), |this| {
                this.child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .p_4()
                        .rounded(px(12.))
                        .bg(rgb(CARD))
                        .border_1()
                        .border_color(rgb(LINE))
                        .child(div().size(px(8.)).rounded(px(99.)).bg(rgb(ACCENT)))
                        .child(div().text_sm().text_color(rgb(DIM)).child(format!("Browsing {peer}'s shared library…"))),
                )
            })
            .when(!busy && folders.is_empty() && state.error.is_none(), |this| {
                this.child(div().text_sm().text_color(rgb(DIM)).child("No shared audio folders found on this peer."))
            })
            .when(!folders.is_empty(), |this| {
                let peer_owned = peer.to_string();
                this.child(
                    v_flex()
                        .gap_3()
                        .children(folders.into_iter().take(60).enumerate().map(|(idx, folder)| {
                            let save_peer = peer_owned.clone();
                            let save_files = folder.files.clone();
                            let save_title = folder.title.clone();
                            let meta = format!(
                                "{} · {} · {}",
                                plural(folder.files.len(), "track", "tracks"),
                                format_bytes(folder.total_size),
                                folder.format_label
                            );
                            let preview_tracks: Vec<String> = folder
                                .files
                                .iter()
                                .take(6)
                                .map(|f| f.file_name())
                                .collect();
                            let extra = folder.files.len().saturating_sub(preview_tracks.len());
                            v_flex()
                                .id(SharedString::from(format!("shelf-folder-{idx}")))
                                .gap_2p5()
                                .p_4()
                                .rounded(px(14.))
                                .bg(rgb(CARD))
                                .border_1()
                                .border_color(rgb(LINE))
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .items_center()
                                        .gap_3()
                                        .child(
                                            v_flex()
                                                .flex_1()
                                                .min_w_0()
                                                .gap_0p5()
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(folder.title.clone()))
                                                .child(div().text_xs().text_color(rgb(DIM)).child(meta)),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("shelf-save-{idx}")))
                                                .primary()
                                                .small()
                                                .label("Save album")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.mirror_soulseek_files(
                                                        save_peer.clone(),
                                                        save_files.clone(),
                                                        Some(save_title.clone()),
                                                        cx,
                                                    );
                                                })),
                                        ),
                                )
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .p_2p5()
                                        .rounded(px(10.))
                                        .bg(rgb(BG))
                                        .children(preview_tracks.into_iter().map(|name| {
                                            div().text_xs().text_color(rgb(DIM)).truncate().child(name)
                                        }))
                                        .when(extra > 0, |col| {
                                            col.child(
                                                div()
                                                    .text_xs()
                                                    .text_color(rgb(DIM))
                                                    .child(format!("+ {extra} more")),
                                            )
                                        }),
                                )
                        })),
                )
            })
    }
}
