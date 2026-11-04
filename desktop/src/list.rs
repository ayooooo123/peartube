//! Minimalist cinema library: movie cards, collapsible series with season pills,
//! unified Smart Omnibar, and the cheeky hidden "Under the Hood" swarm drawer.

use std::collections::BTreeSet;

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::{Entry, Status};

use crate::app::{LibraryFilter, PearTube, detect_smart_action};
use crate::qr::qr_card;
use crate::theme::{ACCENT, BG, BRAND, CARD, CARD_ELEVATED, DIM, INK, LINE};

pub fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB { format!("{:.1} GB", bytes as f64 / GB as f64) }
    else if bytes >= MB { format!("{:.1} MB", bytes as f64 / MB as f64) }
    else if bytes >= KB { format!("{:.0} KB", bytes as f64 / KB as f64) }
    else { format!("{bytes} B") }
}

pub fn parse_season_episode(id: &str) -> Option<(u32, u32)> {
    let (_, tail) = id.rsplit_once(':')?;
    let b = tail.as_bytes();
    if (b.len() != 6 && b.len() != 7) || (b[0] != b's' && b[0] != b'S') || (b[3] != b'e' && b[3] != b'E') {
        return None;
    }
    let season: u32 = std::str::from_utf8(&b[1..3]).ok()?.parse().ok()?;
    let ep: u32 = std::str::from_utf8(&b[4..]).ok()?.parse().ok()?;
    Some((season, ep))
}

pub fn is_episode_id(id: &str) -> bool {
    parse_season_episode(id).is_some()
}

pub fn label(id: &str) -> String {
    if let Some((s, e)) = parse_season_episode(id) {
        format!("S{s:02}E{e:02}")
    } else {
        "Movie".to_string()
    }
}

pub fn series_group_key(entry: &Entry) -> String {
    if is_episode_id(&entry.id)
        && let Some((prefix, _)) = entry.id.rsplit_once(':')
    {
        return prefix.to_lowercase();
    }
    entry.title.to_lowercase()
}

/// Splits an unambiguous trailing year like `"Angels & Demons (2009)"` or `"Angels & Demons 2009"` into `("Angels & Demons", Some("2009"))`.
pub fn split_title_year(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if trimmed.len() > 6 && trimmed.ends_with(')')
        && let Some(open) = trimmed.rfind('(')
    {
        let yr = &trimmed[open + 1..trimmed.len() - 1];
        if yr.len() == 4 && yr.bytes().all(|b| b.is_ascii_digit()) && (yr.starts_with("19") || yr.starts_with("20")) {
            let base = trimmed[..open].trim();
            if !base.is_empty() {
                return (base.to_string(), Some(yr.to_string()));
            }
        }
    }
    if let Some((base, last)) = trimmed.rsplit_once(' ')
        && last.len() == 4
        && last.bytes().all(|b| b.is_ascii_digit())
        && (last.starts_with("19") || last.starts_with("20"))
        && !base.trim().is_empty()
    {
        return (base.trim().to_string(), Some(last.to_string()));
    }
    (trimmed.to_string(), None)
}

pub fn origin(entry: &Entry) -> &'static str {
    if entry.local || (entry.size > 0 && entry.cached_bytes >= entry.size) { "Saved" } else { "Stream" }
}

pub fn p2p_summary(status: Option<&Status>) -> Option<String> {
    let s = status?;
    let routes = [
        ("Private", &s.routes.private_route),
        ("Public DHT", &s.routes.public_route),
        ("LAN", &s.routes.lan),
    ];
    if s.down_bps == 0 && s.up_bps == 0 && s.inflight_blocks == 0
        && routes.iter().all(|(_, route)| route.rx_bytes == 0 && route.tx_bytes == 0)
    {
        return None;
    }
    let rtt = if s.rtt > 0 { format!(" · {} ms", s.rtt) } else { String::new() };
    let paths = routes
        .into_iter()
        .map(|(name, route)| format!("{name} ↓ {} ↑ {}", format_bytes(route.rx_bytes), format_bytes(route.tx_bytes)))
        .collect::<Vec<_>>()
        .join(" · ");
    Some(format!("↓ {}/s · ↑ {}/s · {} blks{rtt}\n{paths}", format_bytes(s.down_bps), format_bytes(s.up_bps), s.inflight_blocks))
}

pub fn column() -> Div {
    v_flex().w_full().max_w(px(920.)).mx_auto().px_6()
}

/// The poster the app's own loopback API serves for an IMDb-identified title.
pub fn poster_uri(entry: &Entry) -> Option<String> {
    let tt = entry.id.strip_prefix("imdb:")?.split(':').next()?;
    if tt.len() < 7 || tt.len() > 11 || !tt.starts_with("tt") || !tt[2..].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Blocked on the artwork crash: GPUI's image path aborts the app the moment a fetch runs.
    // The worklet already serves /v1/poster/{tt}; this hook returns None until that pipeline lands.
    let _ = tt;
    None
}

enum CatalogItem<'a> {
    Movie(&'a Entry, usize),
    Series {
        group_key: String,
        title: String,
        episodes: Vec<&'a Entry>,
    },
}

impl PearTube {
    pub fn render_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.as_ref();
        let peers = status.map_or(0, |s| s.peers + s.lan_peers);
        let transferring = status.is_some_and(|s| s.down_bps > 0 || s.up_bps > 0 || s.inflight_blocks > 0);
        let raw_input = self.search.read(cx).value().to_string();
        let smart_action = detect_smart_action(&raw_input);
        let query = if smart_action.is_some() { String::new() } else { raw_input.trim().to_lowercase() };

        // Filter entries
        let filtered: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| {
                let is_ep = is_episode_id(&e.id);
                let on_device = e.local || (e.size > 0 && e.cached_bytes >= e.size);
                let pass_filter = match &self.filter {
                    LibraryFilter::All => true,
                    LibraryFilter::Movies => !is_ep,
                    LibraryFilter::Series => is_ep,
                    LibraryFilter::OnDevice => on_device,
                    LibraryFilter::Source(src) => &e.source == src,
                };
                if !pass_filter {
                    return false;
                }
                query.is_empty() || e.title.to_lowercase().contains(&query) || e.id.to_lowercase().contains(&query)
            })
            .collect();

        // Build clean catalog items (Movies vs grouped Series)
        let mut movies: Vec<&Entry> = Vec::new();
        let mut series_map: std::collections::BTreeMap<String, (String, Vec<&Entry>)> = std::collections::BTreeMap::new();
        for e in filtered {
            if is_episode_id(&e.id) {
                let gk = series_group_key(e);
                let slot = series_map.entry(gk).or_insert_with(|| (e.title.clone(), Vec::new()));
                slot.1.push(e);
            } else {
                movies.push(e);
            }
        }

        // Deduplicate alternate movie formats onto primary card with format count badge
        movies.sort_by(|a, b| a.id.cmp(&b.id).then(b.size.cmp(&a.size)));
        let mut catalog: Vec<(String, CatalogItem)> = Vec::new();
        for chunk in movies.chunk_by(|a, b| !a.id.is_empty() && a.id == b.id) {
            let best = chunk[0];
            catalog.push((best.title.to_lowercase(), CatalogItem::Movie(best, chunk.len())));
        }
        for (gk, (title, mut eps)) in series_map {
            eps.sort_by(|a, b| parse_season_episode(&a.id).cmp(&parse_season_episode(&b.id)).then(b.size.cmp(&a.size)));
            eps.dedup_by(|a, b| a.id == b.id);
            catalog.push((title.to_lowercase(), CatalogItem::Series { group_key: gk, title, episodes: eps }));
        }
        catalog.sort_by(|a, b| a.0.cmp(&b.0));

        // Continue watching: newest first, one card per title (episodes of a show collapse to the
        // latest), so the hero is what you actually stopped on.
        let mut resume: Vec<(Entry, u64, f32)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let prog = self.watch_history.get(&e.id)?;
                if prog.duration_ms == 0 { return None }
                let pos = self.resume_position_for(e);
                if pos == 0 { return None }
                let ratio = (prog.position_ms as f32 / prog.duration_ms as f32).clamp(0.01, 1.);
                if ratio >= 0.98 { return None }
                Some((e.clone(), pos, ratio))
            })
            .collect();
        resume.sort_by(|a, b| {
            let ua = self.watch_history.get(&a.0.id).map_or(0, |w| w.updated_at);
            let ub = self.watch_history.get(&b.0.id).map_or(0, |w| w.updated_at);
            ub.cmp(&ua)
        });
        let mut seen_titles = BTreeSet::new();
        resume.retain(|(e, _, _)| seen_titles.insert(series_group_key(e)));
        resume.truncate(8);
        let browse = query.is_empty();

        let empty_msg = if self.entries.is_empty() {
            if self.status.is_none() { "Connecting to your private cinema…" } else { "Your library is quiet. Waiting for peers or channels to sync…" }
        } else {
            "Nothing matches that filter."
        };

        let dot_color = if transferring { BRAND } else if peers > 0 { ACCENT } else { DIM };
        let pulse_label = if status.is_none() {
            "Connecting…".to_string()
        } else if peers > 0 {
            format!("{peers} live")
        } else {
            "Standby".to_string()
        };

        let sources = status.map(|s| s.sources.clone()).unwrap_or_default();

        v_flex()
            .size_full()
            .relative()
            .child(
                // Minimalist 56pt Top Bar
                div().border_b_1().border_color(rgb(LINE)).child(
                    column()
                        .py_3()
                        .gap_3()
                        .child(
                            h_flex()
                                .justify_between()
                                .items_center()
                                .min_h(px(36.))
                                .child(
                                    h_flex()
                                        .id("brand-hood-trigger")
                                        .items_center()
                                        .gap_2p5()
                                        .cursor_pointer()
                                        .px_2()
                                        .py_1()
                                        .ml(px(-8.))
                                        .rounded(px(10.))
                                        .hover(|s| s.bg(hsla(0., 0., 1., 0.04)))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.hood_open = !this.hood_open;
                                            cx.notify();
                                        }))
                                        .child(div().text_xl().font_weight(FontWeight::BOLD).child("PearTube"))
                                        .child(
                                            h_flex()
                                                .items_center()
                                                .gap_1p5()
                                                .px_2p5()
                                                .py_0p5()
                                                .rounded(px(99.))
                                                .bg(rgb(CARD))
                                                .border_1()
                                                .border_color(rgb(LINE))
                                                .child(div().size(px(7.)).rounded(px(99.)).bg(rgb(dot_color)))
                                                .child(div().text_xs().text_color(rgb(DIM)).child(pulse_label)),
                                        ),
                                )
                                .child(
                                    h_flex()
                                        .items_center()
                                        .gap_1p5()
                                        .child({
                                            let casting = self.cast.session.is_some();
                                            let btn = Button::new("open-cast-header").icon(Icon::new(Lucide::Cast));
                                            let btn = if let Some(s) = &self.cast.session {
                                                btn.primary().small().label(s.receiver_name.clone())
                                            } else {
                                                btn.ghost().tooltip("Cast to TV")
                                            };
                                            let _ = casting;
                                            btn.on_click(cx.listener(|this, _, window, cx| this.open_cast_sheet(None, window, cx)))
                                        })
                                        .child(
                                            Button::new("settings")
                                                .ghost()
                                                .icon(IconName::Settings)
                                                .tooltip("Settings")
                                                .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx))),
                                        ),
                                ),
                        )
                        // Single Unified Smart Omnibar
                        .child(
                            v_flex()
                                .gap_2()
                                .child(Input::new(&self.search).prefix(Icon::new(Lucide::Search).text_color(rgb(DIM))).cleanable(true))
                                .when_some(smart_action, |this, (act_label, _)| {
                                    this.child(
                                        h_flex()
                                            .justify_between()
                                            .items_center()
                                            .px_3p5()
                                            .py_2()
                                            .rounded(px(12.))
                                            .bg(hsla(264. / 360., 0.85, 0.60, 0.14))
                                            .border_1()
                                            .border_color(rgb(BRAND))
                                            .child(
                                                h_flex()
                                                    .items_center()
                                                    .gap_2()
                                                    .child(Icon::new(Lucide::Sparkles).text_color(rgb(BRAND)))
                                                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child("PearTube link detected")),
                                            )
                                            .child(
                                                Button::new("smart-bar-go")
                                                    .primary()
                                                    .small()
                                                    .label(act_label)
                                                    .on_click(cx.listener(|this, _, window, cx| this.submit_smart_bar_action(window, cx))),
                                            ),
                                    )
                                }),
                        )
                        // Quiet Filter Pills
                        .child({
                            let mut pills = vec![
                                self.filter_pill("flt-all", "All", LibraryFilter::All, cx),
                                self.filter_pill("flt-movies", "Movies", LibraryFilter::Movies, cx),
                                self.filter_pill("flt-series", "Series", LibraryFilter::Series, cx),
                                self.filter_pill("flt-saved", "On Device", LibraryFilter::OnDevice, cx),
                            ];
                            if sources.len() > 1 {
                                for s in &sources {
                                    let name = if !s.alias.is_empty() {
                                        s.alias.clone()
                                    } else if s.primary {
                                        "Main Library".into()
                                    } else {
                                        format!("{}…", &s.key[..6.min(s.key.len())])
                                    };
                                    pills.push(self.filter_pill(&format!("flt-src-{}", s.key), &name, LibraryFilter::Source(s.key.clone()), cx));
                                }
                            }
                            h_flex().gap_1p5().flex_wrap().children(pills)
                        }),
                ),
            )
            // Cheeky "Under the Hood" Drawer when the wordmark/pulse is clicked
            .when(self.hood_open, |this| this.child(self.render_under_the_hood(cx)))
            // Scrollable Cinema Catalog
            .child(
                div().id("entries").flex_1().min_h_0().overflow_y_scrollbar().child(
                    column()
                        .py_5()
                        .gap_3()
                        .when(browse && !resume.is_empty(), |this| this.child(self.render_hero(&resume[0], cx)))
                        .when(browse && resume.len() > 1, |this| this.child(self.render_rail(&resume[1..], cx)))
                        .when(browse && !catalog.is_empty(), |this| {
                            this.child(
                                h_flex()
                                    .justify_between()
                                    .items_center()
                                    .pt_2()
                                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("In your library"))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(format!("{} titles", catalog.len()))),
                            )
                        })
                        .when(catalog.is_empty(), |this| {
                            this.child(div().py_16().text_center().text_color(rgb(DIM)).child(empty_msg))
                        })
                        .children(catalog.into_iter().map(|(_, item)| match item {
                            CatalogItem::Movie(entry, alt_count) => self.render_movie_card(entry, alt_count, cx).into_any_element(),
                            CatalogItem::Series { group_key, title, episodes } => self.render_series_card(group_key, title, episodes, !query.is_empty(), cx).into_any_element(),
                        })),
                ),
            )
    }

    fn filter_pill(&self, id: &str, label: &str, target: LibraryFilter, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let active = self.filter == target;
        let bg_col = if active { rgb(BRAND) } else { rgb(CARD) };
        let txt_col = if active { rgb(0xffffff) } else { rgb(DIM) };
        let border_col = if active { rgb(BRAND) } else { rgb(LINE) };
        div()
            .id(SharedString::from(id.to_string()))
            .px_3()
            .py_1()
            .rounded(px(99.))
            .bg(bg_col)
            .border_1()
            .border_color(border_col)
            .text_xs()
            .font_weight(if active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
            .text_color(txt_col)
            .cursor_pointer()
            .hover(|s| if active { s } else { s.text_color(rgb(INK)) })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.filter = target.clone();
                cx.notify();
            }))
            .child(label.to_string())
    }

    /// The one thing you were watching, at the size it deserves.
    fn render_hero(&self, item: &(Entry, u64, f32), cx: &mut Context<Self>) -> impl IntoElement {
        let (entry, resume_ms, ratio) = item;
        let (title, year) = split_title_year(&entry.title);
        let mut meta = vec![label(&entry.id), format_bytes(entry.size)];
        if let Some(y) = year {
            meta.push(y);
        }
        let meta_line = meta.join(" · ");
        let pct = (ratio * 100.).round() as u32;
        let resume_entry = entry.clone();
        let restart_entry = entry.clone();
        let start_at = *resume_ms;

        v_flex()
            .id("hero")
            .rounded(px(18.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .p_6()
            .child(
                h_flex()
                    .gap_5()
                    .items_start()
                    .when_some(poster_uri(entry), |this, uri| {
                        this.child(
                            div()
                                .w(px(132.))
                                .h(px(198.))
                                .flex_none()
                                .rounded(px(12.))
                                .overflow_hidden()
                                .bg(rgb(BG))
                                .child(img(uri).size_full().object_fit(ObjectFit::Cover)),
                        )
                    })
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_3()
                            .child(
                                div()
                                    .text_xs()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(rgb(DIM))
                                    .child("CONTINUE WATCHING"),
                            )
                            .child(div().text_3xl().font_weight(FontWeight::BOLD).child(title))
                            .child(div().text_sm().text_color(rgb(DIM)).child(meta_line))
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_3()
                                    .child(
                                        div()
                                            .flex_1()
                                            .h(px(4.))
                                            .rounded(px(2.))
                                            .bg(hsla(0., 0., 1., 0.08))
                                            .child(
                                                div()
                                                    .h_full()
                                                    .rounded(px(2.))
                                                    .w(relative(*ratio))
                                                    .bg(rgb(BRAND)),
                                            ),
                                    )
                                    .child(div().text_xs().text_color(rgb(DIM)).child(format!("{pct}%"))),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(Button::new("hero-resume").primary().label("Resume").on_click(
                                        cx.listener(move |this, _, window, cx| {
                                            this.activate_entry(resume_entry.clone(), Some(start_at), window, cx)
                                        }),
                                    ))
                                    .child(Button::new("hero-restart").label("Start over").on_click(
                                        cx.listener(move |this, _, window, cx| {
                                            this.activate_entry(restart_entry.clone(), Some(0), window, cx)
                                        }),
                                    )),
                            ),
                    ),
            )
    }

    /// Everything else in progress, on one horizontal line.
    fn render_rail(&self, items: &[(Entry, u64, f32)], cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .gap_2()
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .child(div().text_lg().font_weight(FontWeight::BOLD).child("Continue watching"))
                    .child(div().text_xs().text_color(rgb(DIM)).child(format!("{}", items.len()))),
            )
            .child(
                h_flex()
                    .id("continue-rail")
                    .w_full()
                    .gap_3()
                    .overflow_x_scroll()
                    .children(items.iter().map(|(entry, pos, ratio)| {
                        let (title, _) = split_title_year(&entry.title);
                        let kind = label(&entry.id);
                        let play = entry.clone();
                        let start_at = *pos;
                        let fill = *ratio;
                        v_flex()
                            .id(SharedString::from(format!("rail-{}", entry.key)))
                            .w(px(170.))
                            .flex_none()
                            .rounded(px(14.))
                            .bg(rgb(CARD))
                            .border_1()
                            .border_color(rgb(LINE))
                            .overflow_hidden()
                            .when_some(poster_uri(entry), |this, uri| {
                                this.child(
                                    div()
                                        .w_full()
                                        .h(px(255.))
                                        .bg(rgb(BG))
                                        .child(img(uri).size_full().object_fit(ObjectFit::Cover)),
                                )
                            })
                            .cursor_pointer()
                            .hover(|s| {
                                s.bg(rgb(CARD_ELEVATED))
                                    .border_color(hsla(264. / 360., 0.6, 0.65, 0.45))
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.activate_entry(play.clone(), Some(start_at), window, cx)
                            }))
                            .p_3()
                            .gap_2()
                            .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).truncate().child(title))
                            .child(div().text_xs().text_color(rgb(DIM)).child(kind))
                            .child(
                                div()
                                    .h(px(3.))
                                    .w_full()
                                    .rounded(px(2.))
                                    .bg(hsla(0., 0., 1., 0.06))
                                    .child(div().h_full().rounded(px(2.)).w(relative(fill)).bg(rgb(BRAND))),
                            )
                    })),
            )
    }

    fn render_movie_card(&self, entry: &Entry, alt_count: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let (clean_title, year) = split_title_year(&entry.title);
        let play_entry = entry.clone();
        let cast_entry = entry.clone();
        let menu_cast = entry.clone();
        let dl_entry = entry.clone();
        let menu_dl = entry.clone();
        let magnet = (!entry.magnet_url.is_empty()).then(|| entry.magnet_url.clone());
        let clear_key = (!entry.local && entry.cached_bytes > 0).then(|| entry.key.clone());
        let active_dl = self.downloads.get(&entry.key).map(|d| {
            let got = d.downloaded.load(std::sync::atomic::Ordering::Relaxed);
            let tot = d.total.max(entry.size);
            let pct = if tot > 0 { ((got as f64 / tot as f64) * 100.0).clamp(0.0, 100.0) } else { 0.0 };
            (got, tot, pct as f32 / 100.0)
        });

        let resume_ms = self.resume_position_for(entry);
        let watch_ratio = self
            .watch_history
            .get(&entry.id)
            .filter(|w| w.duration_ms > 0 && resume_ms > 0)
            .map(|w| (w.position_ms as f32 / w.duration_ms as f32).clamp(0.02, 1.0));
        let dl_ratio = active_dl.map(|(_, _, r)| r.clamp(0.02, 1.0));
        let cache_ratio = (!entry.local && entry.size > 0 && entry.cached_bytes > 0 && entry.cached_bytes < entry.size)
            .then(|| (entry.cached_bytes as f32 / entry.size as f32).clamp(0.02, 1.0));

        let mut meta_parts = vec!["Movie".to_string()];
        if let Some(y) = year {
            meta_parts.push(y);
        }
        meta_parts.push(format_bytes(entry.size));
        if let Some((got, tot, _)) = active_dl {
            if tot > 0 {
                meta_parts.push(format!("Downloading {:.0}%", (got as f64 / tot as f64 * 100.0).min(100.0)));
            } else {
                meta_parts.push(format!("Downloading {}", format_bytes(got)));
            }
        } else if entry.local || (entry.size > 0 && entry.cached_bytes >= entry.size) {
            meta_parts.push("Saved".into());
        } else if entry.cached_bytes > 0 {
            meta_parts.push(format!("{} buffered", format_bytes(entry.cached_bytes)));
        }
        if entry.locked {
            meta_parts.push("Subscriber pass needed".into());
        } else if entry.is_private {
            meta_parts.push("Subscribers only".into());
        }
        if alt_count > 1 {
            meta_parts.push(format!("{alt_count} versions"));
        }
        let can_delete = self.status.as_ref().is_some_and(|st| st.writable && !st.channel.is_empty() && st.channel == entry.source);
        let del_key = can_delete.then(|| entry.key.clone());
        let card_id = SharedString::from(format!("movie-{}", entry.key));
        let cast_btn_id = SharedString::from(format!("cast-{}", entry.key));
        let dl_btn_id = SharedString::from(format!("dl-{}", entry.key));
        let more_btn_id = SharedString::from(format!("more-{}", entry.key));
        let is_downloading = active_dl.is_some();
        let cancel_key = entry.key.clone();
        let menu_cancel_key = entry.key.clone();
        let weak = cx.entity().downgrade();
        v_flex()
            .id(card_id)
            .rounded(px(16.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .overflow_hidden()
            .cursor_pointer()
            .hover(|s| s.bg(rgb(CARD_ELEVATED)).border_color(hsla(264. / 360., 0.6, 0.65, 0.45)))
            .on_click(cx.listener(move |this, _, window, cx| this.activate_entry(play_entry.clone(), None, window, cx)))
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_4()
                    .px_4()
                    .py_3p5()
                    .when_some(poster_uri(entry), |this, uri| {
                        this.child(
                            div()
                                .w(px(44.))
                                .h(px(66.))
                                .flex_none()
                                .rounded(px(8.))
                                .overflow_hidden()
                                .bg(rgb(BG))
                                .child(img(uri).size_full().object_fit(ObjectFit::Cover)),
                        )
                    })
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(div().text_base().font_weight(FontWeight::SEMIBOLD).truncate().child(clean_title))
                                    .when(resume_ms > 0, |this| {
                                        this.child(
                                            div()
                                                .px_2()
                                                .py_0p5()
                                                .rounded(px(99.))
                                                .bg(hsla(264. / 360., 0.8, 0.6, 0.20))
                                                .text_xs()
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(rgb(BRAND))
                                                .child("Resume"),
                                        )
                                    }),
                            )
                            .child(div().text_xs().text_color(rgb(DIM)).child(meta_parts.join(" · "))),
                    )
                    .child(
                        h_flex()
                            .items_center()
                            .gap_1()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                Button::new(cast_btn_id)
                                    .ghost()
                                    .small()
                                    .icon(Icon::new(Lucide::Cast))
                                    .tooltip("Play on TV")
                                    .on_click(cx.listener(move |this, _, window, cx| this.cast_entry_or_sheet(cast_entry.clone(), 0, window, cx))),
                            )
                            .child(
                                if is_downloading {
                                    Button::new(dl_btn_id)
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::X))
                                        .tooltip("Cancel download")
                                        .on_click(cx.listener(move |this, _, _, cx| this.cancel_download(&cancel_key, cx)))
                                } else {
                                    Button::new(dl_btn_id)
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::Download))
                                        .tooltip("Download to Downloads")
                                        .on_click(cx.listener(move |this, _, _, cx| this.download_entry(dl_entry.clone(), None, cx)))
                                },
                            )
                            .child({
                                let (mag, clr, del) = (magnet.clone(), clear_key.clone(), del_key.clone());
                                let w = weak.clone();
                                let c_item = menu_cast.clone();
                                let d_item = menu_dl.clone();
                                let m_cancel = menu_cancel_key.clone();
                                let is_locked = entry.locked;
                                Button::new(more_btn_id)
                                    .ghost()
                                    .small()
                                    .icon(Icon::new(Lucide::Ellipsis))
                                    .dropdown_menu(move |mut menu, _, _| {
                                        if !is_locked {
                                            let w_cast = w.clone();
                                            let ci = c_item.clone();
                                            menu = menu.item(PopupMenuItem::new("Play on TV…").on_click(move |_, window, cx| {
                                                let _ = w_cast.update(cx, |this, cx| this.open_cast_sheet(Some((ci.key.clone(), ci.title.clone(), 0)), window, cx));
                                            }));
                                            let w_dl = w.clone();
                                            if is_downloading {
                                                let ck = m_cancel.clone();
                                                menu = menu.item(PopupMenuItem::new("Cancel Download").on_click(move |_, _, cx| {
                                                    let _ = w_dl.update(cx, |this, cx| this.cancel_download(&ck, cx));
                                                }));
                                            } else {
                                                let di = d_item.clone();
                                                menu = menu.item(PopupMenuItem::new("Download Video").on_click(move |_, _, cx| {
                                                    let _ = w_dl.update(cx, |this, cx| this.download_entry(di.clone(), None, cx));
                                                }));
                                            }
                                        }
                                        if let Some(url) = mag.clone() {
                                            menu = menu.item(PopupMenuItem::new("Copy Stream Link").on_click(move |_, _, cx| {
                                                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                                            }));
                                        }
                                        if let Some(k) = clr.clone() {
                                            let w_clr = w.clone();
                                            menu = menu.item(PopupMenuItem::new("Free Up Downloaded Data").on_click(move |_, _, cx| {
                                                let _ = w_clr.update(cx, |this, cx| this.clear_cache(Some(k.clone()), cx));
                                            }));
                                        }
                                        if let Some(dk) = del.clone() {
                                            let w_del = w.clone();
                                            menu = menu.item(PopupMenuItem::new("Delete from Channel").on_click(move |_, _, cx| {
                                                let _ = w_del.update(cx, |this, cx| this.remove_channel_entry(dk.clone(), cx));
                                            }));
                                        }
                                        menu
                                    })
                            }),
                    ),
            )
            .when_some(dl_ratio.or(watch_ratio).or(cache_ratio), |this, ratio| {
                let bar_col = if dl_ratio.is_some() { rgb(ACCENT) } else if watch_ratio.is_some() { rgb(BRAND) } else { rgb(ACCENT) };
                this.child(
                    div()
                        .w_full()
                        .h(px(3.))
                        .bg(hsla(0., 0., 1., 0.06))
                        .child(div().h_full().w(relative(ratio)).bg(bar_col)),
                )
            })
    }

    fn render_series_card(&self, group_key: String, title: String, episodes: Vec<&Entry>, force_open: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let (clean_title, year) = split_title_year(&title);
        let seasons: Vec<u32> = episodes
            .iter()
            .filter_map(|e| parse_season_episode(&e.id).map(|(s, _)| s))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        // Pick best episode to Resume or Play first
        let resume_ep = episodes
            .iter()
            .filter_map(|e| self.watch_history.get(&e.id).map(|w| (*e, w.updated_at, self.resume_position_for(e))))
            .filter(|(_, _, pos)| *pos > 0)
            .max_by_key(|(_, updated, _)| *updated)
            .map(|(e, _, _)| e);
        let quick_ep = resume_ep.unwrap_or(episodes[0]).clone();
        let quick_label = if resume_ep.is_some() {
            format!("Resume {}", label(&quick_ep.id))
        } else {
            format!("Play {}", label(&quick_ep.id))
        };

        let expanded = force_open || self.expanded_series.contains(&group_key);
        let active_season = self
            .selected_seasons
            .get(&group_key)
            .copied()
            .filter(|s| seasons.contains(s))
            .or_else(|| parse_season_episode(&quick_ep.id).map(|(s, _)| s))
            .or_else(|| seasons.first().copied())
            .unwrap_or(1);

        let mut sub_parts = vec![format!("{} episodes", episodes.len())];
        if seasons.len() > 1 {
            sub_parts.push(format!("{} seasons", seasons.len()));
        }
        if let Some(y) = year {
            sub_parts.push(y);
        }

        let toggle_key = group_key.clone();
        let card_id = SharedString::from(format!("series-{group_key}"));
        let play_btn_id = SharedString::from(format!("series-play-{group_key}"));

        v_flex()
            .id(card_id)
            .rounded(px(16.))
            .bg(rgb(CARD))
            .border_1()
            .border_color(rgb(LINE))
            .overflow_hidden()
            .child(
                h_flex()
                    .id(SharedString::from(format!("series-hdr-{group_key}")))
                    .justify_between()
                    .items_center()
                    .gap_4()
                    .px_4()
                    .py_3p5()
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(CARD_ELEVATED)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.expanded_series.contains(&toggle_key) {
                            this.expanded_series.remove(&toggle_key);
                        } else {
                            this.expanded_series.insert(toggle_key.clone());
                        }
                        cx.notify();
                    }))
                    .child(
                        h_flex()
                            .items_center()
                            .gap_3()
                            .flex_1()
                            .min_w_0()
                            .child(Icon::new(if expanded { Lucide::ChevronDown } else { Lucide::ChevronRight }).text_color(rgb(DIM)))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap_0p5()
                                    .child(div().text_base().font_weight(FontWeight::SEMIBOLD).truncate().child(clean_title))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(sub_parts.join(" · "))),
                            ),
                    )
                    .child(
                        div()
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(
                                Button::new(play_btn_id)
                                    .primary()
                                    .small()
                                    .label(quick_label)
                                    .on_click(cx.listener(move |this, _, window, cx| this.activate_entry(quick_ep.clone(), None, window, cx))),
                            ),
                    ),
            )
            .when(expanded, |this| {
                let season_eps: Vec<&Entry> = episodes
                    .iter()
                    .copied()
                    .filter(|e| force_open || seasons.len() <= 1 || parse_season_episode(&e.id).is_none_or(|(s, _)| s == active_season))
                    .collect();
                this.child(
                    v_flex()
                        .border_t_1()
                        .border_color(rgb(LINE))
                        .bg(hsla(0., 0., 0., 0.18))
                        .when(seasons.len() > 1 && !force_open, |this| {
                            let gk = group_key.clone();
                            this.child(
                                h_flex()
                                    .px_4()
                                    .py_2p5()
                                    .gap_1p5()
                                    .flex_wrap()
                                    .border_b_1()
                                    .border_color(rgb(LINE))
                                    .children(seasons.iter().copied().map(|s| {
                                        let gk_s = gk.clone();
                                        let sel = s == active_season;
                                        let btn = Button::new(SharedString::from(format!("season-{gk}-{s}"))).small().label(format!("Season {s}"));
                                        let btn = if sel { btn.primary() } else { btn.ghost() };
                                        btn.on_click(cx.listener(move |this, _, _, cx| {
                                            this.selected_seasons.insert(gk_s.clone(), s);
                                            cx.notify();
                                        }))
                                    })),
                            )
                        })
                        .children(season_eps.into_iter().enumerate().map(|(idx, ep)| self.render_episode_row(idx, ep, cx))),
                )
            })
    }

    fn render_episode_row(&self, index: usize, entry: &Entry, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let ep_play = entry.clone();
        let ep_cast = entry.clone();
        let ep_menu_cast = entry.clone();
        let ep_dl = entry.clone();
        let ep_menu_dl = entry.clone();
        let ep_code = label(&entry.id);
        let ep_dl_name = if entry.title.to_ascii_lowercase().contains(&ep_code.to_ascii_lowercase()) {
            entry.title.clone()
        } else {
            format!("{} {}", entry.title, ep_code)
        };
        let ep_menu_dl_name = ep_dl_name.clone();
        let magnet = (!entry.magnet_url.is_empty()).then(|| entry.magnet_url.clone());
        let clear_key = (!entry.local && entry.cached_bytes > 0).then(|| entry.key.clone());
        let active_dl = self.downloads.get(&entry.key).map(|d| {
            let got = d.downloaded.load(std::sync::atomic::Ordering::Relaxed);
            let tot = d.total.max(entry.size);
            (got, tot)
        });
        let is_downloading = active_dl.is_some();
        let ep_cancel_key = entry.key.clone();
        let ep_menu_cancel_key = entry.key.clone();
        let lock_tag = if entry.locked { " · Subscriber pass needed" } else if entry.is_private { " · Subscribers only" } else { "" };
        let status_label = if let Some((got, tot)) = active_dl {
            if tot > 0 {
                format!("{} · Downloading {:.0}%{lock_tag}", format_bytes(entry.size), (got as f64 / tot as f64 * 100.0).min(100.0))
            } else {
                format!("{} · Downloading {}{lock_tag}", format_bytes(entry.size), format_bytes(got))
            }
        } else {
            format!("{} · {}{lock_tag}", format_bytes(entry.size), origin(entry))
        };
        let can_delete = self.status.as_ref().is_some_and(|st| st.writable && !st.channel.is_empty() && st.channel == entry.source);
        let ep_del_key = can_delete.then(|| entry.key.clone());
        let ep_locked = entry.locked;
        let resume = self.resume_position_for(entry) > 0;
        let weak = cx.entity().downgrade();

        h_flex()
            .id(SharedString::from(format!("ep-{}", entry.key)))
            .justify_between()
            .items_center()
            .px_4()
            .py_2p5()
            .when(index > 0, |this| this.border_t_1().border_color(rgb(LINE)))
            .cursor_pointer()
            .hover(|s| s.bg(hsla(0., 0., 1., 0.04)))
            .on_click(cx.listener(move |this, _, window, cx| this.activate_entry(ep_play.clone(), None, window, cx)))
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .px_2p5()
                            .py_0p5()
                            .rounded(px(6.))
                            .bg(rgb(CARD_ELEVATED))
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .child(ep_code),
                    )
                    .child(div().text_sm().text_color(rgb(DIM)).child(status_label))
                    .when(resume, |this| this.child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(BRAND)).child("In Progress"))),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_1()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        Button::new(SharedString::from(format!("ep-cast-{}", entry.key)))
                            .ghost()
                            .small()
                            .icon(Icon::new(Lucide::Cast))
                            .tooltip("Play on TV")
                            .on_click(cx.listener(move |this, _, window, cx| this.cast_entry_or_sheet(ep_cast.clone(), 0, window, cx))),
                    )
                    .child(
                        if is_downloading {
                            Button::new(SharedString::from(format!("ep-dl-{}", entry.key)))
                                .ghost()
                                .small()
                                .icon(Icon::new(Lucide::X))
                                .tooltip("Cancel download")
                                .on_click(cx.listener(move |this, _, _, cx| this.cancel_download(&ep_cancel_key, cx)))
                        } else {
                            Button::new(SharedString::from(format!("ep-dl-{}", entry.key)))
                                .ghost()
                                .small()
                                .icon(Icon::new(Lucide::Download))
                                .tooltip("Download episode")
                                .on_click(cx.listener(move |this, _, _, cx| this.download_entry(ep_dl.clone(), Some(ep_dl_name.clone()), cx)))
                        },
                    )
                    .child(
                        Button::new(SharedString::from(format!("ep-more-{}", entry.key)))
                            .ghost()
                            .small()
                            .icon(Icon::new(Lucide::Ellipsis))
                            .dropdown_menu(move |mut menu, _, _| {
                                if !ep_locked {
                                    let w_cast = weak.clone();
                                    let ci = ep_menu_cast.clone();
                                    menu = menu.item(PopupMenuItem::new("Play on TV…").on_click(move |_, window, cx| {
                                        let _ = w_cast.update(cx, |this, cx| this.open_cast_sheet(Some((ci.key.clone(), ci.title.clone(), 0)), window, cx));
                                    }));
                                    let w_dl = weak.clone();
                                    if is_downloading {
                                        let ck = ep_menu_cancel_key.clone();
                                        menu = menu.item(PopupMenuItem::new("Cancel Download").on_click(move |_, _, cx| {
                                            let _ = w_dl.update(cx, |this, cx| this.cancel_download(&ck, cx));
                                        }));
                                    } else {
                                        let di = ep_menu_dl.clone();
                                        let dn = ep_menu_dl_name.clone();
                                        menu = menu.item(PopupMenuItem::new("Download Episode").on_click(move |_, _, cx| {
                                            let _ = w_dl.update(cx, |this, cx| this.download_entry(di.clone(), Some(dn.clone()), cx));
                                        }));
                                    }
                                }
                                if let Some(url) = magnet.clone() {
                                    menu = menu.item(PopupMenuItem::new("Copy Stream Link").on_click(move |_, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                                    }));
                                }
                                if let Some(k) = clear_key.clone() {
                                    let w_clr = weak.clone();
                                    menu = menu.item(PopupMenuItem::new("Free Up Downloaded Data").on_click(move |_, _, cx| {
                                        let _ = w_clr.update(cx, |this, cx| this.clear_cache(Some(k.clone()), cx));
                                    }));
                                }
                                if let Some(dk) = ep_del_key.clone() {
                                    let w_del = weak.clone();
                                    menu = menu.item(PopupMenuItem::new("Delete from Channel").on_click(move |_, _, cx| {
                                        let _ = w_del.update(cx, |this, cx| this.remove_channel_entry(dk.clone(), cx));
                                    }));
                                }
                                menu
                            }),
                    ),
            )
    }

    fn render_under_the_hood(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.as_ref();
        let peers = status.map_or(0, |s| s.peers + s.lan_peers);
        let cached = status.map_or(0, |s| s.cached_bytes);
        let stored = status.map_or(0, |s| s.blob_bytes);
        let channel = status.map(|s| s.channel.clone()).unwrap_or_default();
        let discovered = status.map(|s| s.discovered_sources.clone()).unwrap_or_default();
        let p2p = p2p_summary(status);
        let lan = status.and_then(|s| s.lan.clone());
        let api_url = status.and_then(|s| s.api_url.clone());

        let mood = if peers > 0 {
            format!("Connected to {peers} peer{} · A little cinema, anywhere.", if peers == 1 { "" } else { "s" })
        } else {
            "Searching the swarm for peers…".to_string()
        };

        div()
            .border_b_1()
            .border_color(rgb(LINE))
            .bg(rgb(CARD))
            .child(
                column()
                    .py_4()
                    .gap_4()
                    .child(
                        h_flex()
                            .justify_between()
                            .items_center()
                            .child(
                                v_flex()
                                    .gap_0p5()
                                    .child(div().text_sm().font_weight(FontWeight::BOLD).child("Under the Hood"))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(mood)),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .when(cached > 0, |this| {
                                        this.child(
                                            Button::new("hood-clear-cache")
                                                .ghost()
                                                .small()
                                                .label(format!("Free Up {}", format_bytes(cached)))
                                                .on_click(cx.listener(|this, _, _, cx| this.clear_cache(None, cx))),
                                        )
                                    })
                                    .child(
                                        Button::new("hood-close")
                                            .ghost()
                                            .small()
                                            .icon(IconName::Close)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.hood_open = false;
                                                cx.notify();
                                            })),
                                    ),
                            ),
                    )
                    // Subscribed & Discovered Channels
                    .when(!self.settings.sources.is_empty() || !discovered.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .when(!self.settings.sources.is_empty(), |this| {
                                    let active: Vec<_> = self
                                        .settings
                                        .sources
                                        .iter()
                                        .map(|s| {
                                            let label_txt = if s.alias.is_empty() { format!("{}…", &s.key[..8]) } else { s.alias.clone() };
                                            let rm_key = s.key.clone();
                                            Button::new(SharedString::from(format!("hood-rm-{}", s.key)))
                                                .ghost()
                                                .small()
                                                .label(format!("{label_txt} ×"))
                                                .tooltip("Unfollow source")
                                                .on_click(cx.listener(move |this, _, _, cx| this.remove_subscribed_source(rm_key.clone(), cx)))
                                        })
                                        .collect();
                                    this.child(h_flex().gap_1p5().flex_wrap().children(active))
                                })
                                .when(!discovered.is_empty(), |this| {
                                    let disc_btns: Vec<_> = discovered
                                        .into_iter()
                                        .map(|d| {
                                            let lbl = format!("+ Follow {}", d.title);
                                            let id = SharedString::from(format!("hood-disc-{}", d.key));
                                            Button::new(id)
                                                .small()
                                                .label(lbl)
                                                .on_click(cx.listener(move |this, _, _, cx| this.subscribe_discovered(d.clone(), cx)))
                                        })
                                        .collect();
                                    this.child(h_flex().gap_2().flex_wrap().children(disc_btns))
                                }),
                        )
                    })
                    // Share My Channel Card with QR
                    // Share My Channel, Device Key, Recovery Phrase & Paid Subscriber Pass
                    .when(!channel.is_empty(), |this| {
                        let ch_uri = format!("peartube://channel/{channel}");
                        let copy_uri = ch_uri.clone();
                        let writer_key = status.map(|s| s.writer.clone()).unwrap_or_default();
                        let ident = self.identity.as_ref();
                        let access_uri = ident.map(|i| i.access_uri.clone()).unwrap_or_default();
                        let epoch = ident.map_or(1, |i| i.epoch);
                        let has_mnemonic = ident.is_some_and(|i| i.mnemonic_set);
                        let writers = ident.map(|i| i.writers.clone()).unwrap_or_default();
                        this.child(
                            v_flex()
                                .gap_3()
                                .p_3p5()
                                .rounded(px(14.))
                                .bg(rgb(BG))
                                .border_1()
                                .border_color(rgb(LINE))
                                .child(
                                    h_flex()
                                        .gap_4()
                                        .items_center()
                                        .child(qr_card(&ch_uri, 88.))
                                        .child(
                                            v_flex()
                                                .flex_1()
                                                .gap_1()
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Share Your Channel"))
                                                .child(div().text_xs().text_color(rgb(DIM)).child("Read-only public feed; only your linked devices can publish or delete."))
                                                .child(
                                                    h_flex()
                                                        .mt_1()
                                                        .gap_2()
                                                        .flex_wrap()
                                                        .child(
                                                            Button::new("hood-copy-channel")
                                                                .small()
                                                                .icon(Icon::new(Lucide::Share2))
                                                                .label("Copy Channel Link")
                                                                .on_click(cx.listener(move |_, _, _, cx| {
                                                                    cx.write_to_clipboard(ClipboardItem::new_string(copy_uri.clone()));
                                                                })),
                                                        )
                                                        .when(!writer_key.is_empty(), |row| {
                                                            let wk = writer_key.clone();
                                                            row.child(
                                                                Button::new("hood-copy-writer")
                                                                    .ghost()
                                                                    .small()
                                                                    .label("Copy Device Key")
                                                                    .on_click(cx.listener(move |_, _, _, cx| {
                                                                        cx.write_to_clipboard(ClipboardItem::new_string(wk.clone()));
                                                                    })),
                                                            )
                                                        })
                                                        .when(has_mnemonic, |row| {
                                                            row.child(
                                                                Button::new("hood-copy-mnemonic")
                                                                    .ghost()
                                                                    .small()
                                                                    .label("Copy 12-Word Phrase")
                                                                    .on_click(cx.listener(|this, _, _, cx| this.copy_recovery_phrase(cx))),
                                                            )
                                                        }),
                                                ),
                                        ),
                                )
                                .when(!access_uri.is_empty(), |card| {
                                    let pass = access_uri.clone();
                                    card.child(
                                        h_flex()
                                            .justify_between()
                                            .items_center()
                                            .gap_2()
                                            .pt_2()
                                            .border_t_1()
                                            .border_color(rgb(LINE))
                                            .child(div().text_xs().text_color(rgb(DIM)).child(format!("Subscriber pass · Epoch {epoch}")))
                                            .child(
                                                h_flex()
                                                    .gap_2()
                                                    .child(
                                                        Button::new("hood-copy-pass")
                                                            .ghost()
                                                            .small()
                                                            .label("Copy Pass")
                                                            .on_click(cx.listener(move |_, _, _, cx| {
                                                                cx.write_to_clipboard(ClipboardItem::new_string(pass.clone()));
                                                            })),
                                                    )
                                                    .child(
                                                        Button::new("hood-rotate-pass")
                                                            .ghost()
                                                            .small()
                                                            .label("Rotate Pass")
                                                            .on_click(cx.listener(|this, _, _, cx| this.rotate_subscriber_pass(cx))),
                                                    ),
                                            ),
                                    )
                                })
                                .when(writers.len() > 1, |card| {
                                    let ch_hex = channel.clone();
                                    let chips: Vec<_> = writers
                                        .into_iter()
                                        .map(|w| {
                                            let name = if !w.alias.is_empty() { w.alias } else { format!("{}…", &w.key[..8.min(w.key.len())]) };
                                            let tag = if w.self_device { format!("{name} (this Mac)") } else { format!("{name} · {}", w.role) };
                                            let can_rm = w.key != ch_hex;
                                            let wk = w.key.clone();
                                            let btn = Button::new(SharedString::from(format!("hood-writer-{}", w.key))).ghost().small();
                                            if can_rm {
                                                btn.label(format!("{tag} ×")).on_click(cx.listener(move |this, _, _, cx| this.revoke_linked_writer(wk.clone(), cx)))
                                            } else {
                                                btn.label(tag)
                                            }
                                        })
                                        .collect();
                                    card.child(h_flex().gap_1p5().flex_wrap().children(chips))
                                }),
                        )
                    })
                    // Collapsed Engine Room toggle for raw telemetry
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex().child(
                                    Button::new("hood-engine-toggle")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(if self.hood_engine_open { Lucide::ChevronDown } else { Lucide::ChevronRight }))
                                        .label("Engine Room")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.hood_engine_open = !this.hood_engine_open;
                                            cx.notify();
                                        })),
                                ),
                            )
                            .when(self.hood_engine_open, |this| {
                                this.child(
                                    v_flex()
                                        .p_3()
                                        .gap_1()
                                        .rounded(px(12.))
                                        .bg(rgb(BG))
                                        .border_1()
                                        .border_color(rgb(LINE))
                                        .text_xs()
                                        .text_color(rgb(DIM))
                                        .child(format!("Stored {} · Cached {}", format_bytes(stored), format_bytes(cached)))
                                        .when_some(lan, |t, l| t.child(format!("LAN {l}")))
                                        .when_some(api_url, |t, a| t.child(format!("Local Daemon {a}")))
                                        .when_some(p2p, |t, p| t.child(div().text_color(rgb(BRAND)).child(p))),
                                )
                            }),
                    ),
            )
    }
}
