//! Watch room (`All`, `Movies`, `Series`, `Clips`, `Saved here`, channel chips,
//! `Keep watching`), plus the Title detail page for movies (all versions),
//! series (seasons, episodes, `Next episode`), and clips.

#![forbid(unsafe_code)]

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::Entry;

use crate::app::{DetailView, PearTube, Room, WatchKind};
use crate::catalog::{VideoKind, VideoTile, format_time_left, is_saved, plural};
use crate::list::{column, format_bytes, label};
use crate::sleeves::video_art;
use crate::theme::{BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

impl PearTube {
    pub fn render_watch(&self, kind: WatchKind, cx: &mut Context<Self>) -> impl IntoElement {
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

        let chip = |id: &'static str, txt: String, target: WatchKind, cx: &mut Context<Self>| {
            let active = kind == target;
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
        let keep_watching = self.unfinished_videos();

        let mut ms_combined: Vec<&VideoTile> = movies.iter().chain(series.iter()).copied().collect();
        ms_combined.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

        column()
            .py_6()
            .gap_6()
            .child(
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
                                    .child(chip("watch-movies", format!("Movies · {}", movies.len()), WatchKind::Movies, cx))
                                    .child(chip("watch-series", format!("Series · {}", series.len()), WatchKind::Series, cx))
                                    .child(chip("watch-clips", format!("Clips · {}", clips.len()), WatchKind::Clips, cx)),
                            )
                            .child(
                                Checkbox::new("watch-saved-only")
                                    .checked(saved_only)
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
                                        format!("{}…", &src.key[..6.min(src.key.len())])
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
                    }),
            )
            .when(kind == WatchKind::All && !keep_watching.is_empty(), |this| {
                this.child(
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
                        ),
                )
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
                            VideoKind::Movie => tile.year.as_deref(),
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
            VideoKind::Movie => "Movie",
            VideoKind::Series => "Series",
            VideoKind::Clip => "Clip",
        };
        let is_clip = tile.kind == VideoKind::Clip;
        let art_w = if is_clip { 240. } else { 148. };
        let art_h = if is_clip { 135. } else { 220. };

        let mut facts = vec![tile.subtitle_line(format_bytes), tile.state_label()];
        if tile.kind == VideoKind::Series {
            if let Some(y) = &tile.year {
                facts.insert(0, y.clone());
            }
        }

        // For series: pick resume episode or first episode, plus `Next episode`.
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
