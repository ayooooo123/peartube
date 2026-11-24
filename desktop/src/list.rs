//! Top navigation bar, `Add to library` modal, Under the Hood drawer,
//! room/detail dispatcher, and shared formatting helpers.

#![forbid(unsafe_code)]

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Disableable as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::worker::{Entry, Status};

use crate::api::{AcquireJob, IdentifyResult, extract_shared_url, format_duration, is_web_url};
use crate::app::{DetailView, ListenTab, NetworkTab, PearTube, Room, WatchKind, WatchViewMode};
use crate::qr::qr_card;
use crate::theme::{ACCENT, BG, BRAND, BRAND_HOVER, CARD, CARD_ELEVATED, DANGER, DIM, INK, LINE};

pub fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

pub fn format_rate(bps: u64) -> String {
    if bps == 0 {
        "0 B/s".to_string()
    } else {
        format!("{}/s", format_bytes(bps))
    }
}

pub fn total_peers(status: &Status) -> u64 {
    let routed = status.routes.lan.peers
        + status.routes.public_route.peers
        + status.routes.private_route.peers;
    if routed > 0 {
        routed
    } else {
        status.peers + status.lan_peers
    }
}

pub fn label(entry: &Entry) -> String {
    if let (Some(s), Some(e)) = (entry.season, entry.episode) {
        format!("S{s:02}E{e:02}")
    } else if entry.id.starts_with("imdb:") {
        "Movie".to_string()
    } else {
        "Clip".to_string()
    }
}

pub fn origin(entry: &Entry) -> &'static str {
    if entry.local || (entry.size > 0 && entry.cached_bytes >= entry.size) {
        "Saved here"
    } else if entry.cached_bytes > 0 {
        "Partly saved"
    } else {
        "On the network"
    }
}

pub fn p2p_summary(status: Option<&Status>) -> Option<String> {
    let s = status?;
    let routes = [
        ("Private", &s.routes.private_route),
        ("Public DHT", &s.routes.public_route),
        ("LAN", &s.routes.lan),
    ];
    if s.down_bps == 0
        && s.up_bps == 0
        && s.inflight_blocks == 0
        && routes.iter().all(|(_, route)| route.rx_bytes == 0 && route.tx_bytes == 0)
    {
        return None;
    }
    let rtt = if s.rtt > 0 {
        format!(" · {} ms", s.rtt)
    } else {
        String::new()
    };
    let paths = routes
        .into_iter()
        .map(|(name, route)| format!("{name} ↓ {} ↑ {}", format_bytes(route.rx_bytes), format_bytes(route.tx_bytes)))
        .collect::<Vec<_>>()
        .join(" · ");
    Some(format!(
        "↓ {}/s · ↑ {}/s · {} blks{rtt}\n{paths}",
        format_bytes(s.down_bps),
        format_bytes(s.up_bps),
        s.inflight_blocks
    ))
}

pub fn column() -> Div {
    v_flex().w_full().max_w(px(1080.)).mx_auto().px_6()
}

pub fn grid_columns(window: &Window, card_width: f32, gap: f32) -> usize {
    let viewport_w: f32 = window.viewport_size().width.into();
    let avail = (viewport_w.min(1080.0) - 48.0).max(card_width);
    ((avail + gap) / (card_width + gap)).floor().max(1.0) as usize
}

pub struct AddModalForm {
    pub input: Entity<InputState>,
    pub identified_url: Option<String>,
    pub identifying: bool,
    pub identified: Option<IdentifyResult>,
    pub audio_only: bool,
    pub acquiring: bool,
    pub error: Option<SharedString>,
    _input_sub: Subscription,
}

impl AddModalForm {
    pub fn new(window: &mut Window, cx: &mut Context<PearTube>) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Paste a YouTube, SoundCloud, Rumble, Bandcamp, media, or peartube:// link")
        });
        let input_sub = cx.subscribe_in(&input, window, |this, state, event: &InputEvent, _window, cx| match event {
            InputEvent::Change => {
                let raw = state.read(cx).value().to_string();
                match extract_shared_url(&raw) {
                    Some(url) if is_web_url(&url) => {
                        let already = this
                            .add_modal
                            .as_ref()
                            .is_some_and(|f| f.identified_url.as_deref() == Some(url.as_str()));
                        if !already {
                            this.identify_add_url(url, cx);
                        }
                    }
                    _ => {
                        if let Some(f) = &mut this.add_modal
                            && (f.identified.is_some() || f.identifying || f.identified_url.is_some())
                        {
                            f.identified = None;
                            f.identified_url = None;
                            f.identifying = false;
                            f.error = None;
                            cx.notify();
                        }
                    }
                }
            }
            InputEvent::PressEnter { .. } => {
                this.submit_add_modal(cx);
            }
            _ => {}
        });
        AddModalForm {
            input,
            identified_url: None,
            identifying: false,
            identified: None,
            audio_only: false,
            acquiring: false,
            error: None,
            _input_sub: input_sub,
        }
    }
}

impl PearTube {
    /// Renders the main Listen and Watch workspace (top bar + active room/detail).
    pub fn render_list(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let active_nav = self.active_nav_room();
        let casting = self.cast.session.is_some();
        let jobs_pill = top_bar_jobs_pill(&self.jobs);

        let nav_tab = |id: &'static str, text: &'static str, is_active: bool, target: Room, cx: &mut Context<Self>| {
            div()
                .id(id)
                .px_2p5()
                .py_2()
                .border_b_2()
                .border_color(if is_active { Hsla::from(rgb(BRAND)) } else { transparent_black() })
                .text_sm()
                .font_weight(if is_active { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                .text_color(if is_active { rgb(INK) } else { rgb(DIM) })
                .cursor_pointer()
                .hover(|s| s.text_color(rgb(INK)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.open_room(target.clone(), cx);
                }))
                .child(text)
        };

        let self_scrolling = self.detail.is_none()
            && (matches!(self.room, Room::Listen(_))
                || (self.watch_view == WatchViewMode::Rows
                    && matches!(
                        self.room,
                        Room::Watch(WatchKind::Movies | WatchKind::Series | WatchKind::Clips)
                    )));
        let body: AnyElement = match &self.detail {
            Some(DetailView::Album(key)) => self.render_album_detail(key, cx).into_any_element(),
            Some(DetailView::Artist(key)) => self.render_artist_detail(key, cx).into_any_element(),
            Some(DetailView::Title(key)) => self.render_title_detail(key, cx).into_any_element(),
            Some(DetailView::Shelf(peer)) => self.render_shelf_detail(peer, cx).into_any_element(),
            Some(DetailView::Playing) => self.render_playing_view(cx).into_any_element(),
            None => match &self.room {
                Room::Home => self.render_home(cx).into_any_element(),
                Room::Listen(tab) => self.render_listen(tab.clone(), window, cx).into_any_element(),
                Room::Watch(kind) => self.render_watch(kind.clone(), window, cx).into_any_element(),
                Room::Discover => self.render_discover(cx).into_any_element(),
                Room::Search => self.render_search(cx).into_any_element(),
                Room::Network(tab) => self.render_network(*tab, cx).into_any_element(),
            },
        };

        v_flex()
            .size_full()
            .relative()
            // Unified top navigation bar with live Network pill and Add/TVs/Settings actions
            .child(
                div().border_b_1().border_color(rgb(LINE)).bg(rgb(BG)).child(
                    h_flex()
                        .w_full()
                        .max_w(px(1240.))
                        .mx_auto()
                        .px_6()
                        .h(px(54.))
                        .items_center()
                        .justify_between()
                        .gap_4()
                        // Left: Brand (opens Under the Hood) + room tabs
                        .child(
                            h_flex()
                                .items_center()
                                .gap_5()
                                .child(
                                    div()
                                        .id("brand-hood-trigger")
                                        .px_2()
                                        .py_1()
                                        .ml(px(-8.))
                                        .rounded(px(8.))
                                        .cursor_pointer()
                                        .hover(|s| s.bg(hsla(0., 0., 1., 0.04)))
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.hood_open = !this.hood_open;
                                            cx.notify();
                                        }))
                                        .child(div().text_lg().font_weight(FontWeight::BOLD).child("PearTube")),
                                )
                                .child(
                                    h_flex()
                                        .items_center()
                                        .gap_1()
                                        .child(nav_tab(
                                            "nav-home",
                                            "Home",
                                            matches!(active_nav, Room::Home),
                                            Room::Home,
                                            cx,
                                        ))
                                        .child(nav_tab(
                                            "nav-listen",
                                            "Listen",
                                            matches!(active_nav, Room::Listen(_)),
                                            Room::Listen(ListenTab::Albums),
                                            cx,
                                        ))
                                        .child(nav_tab(
                                            "nav-watch",
                                            "Watch",
                                            matches!(active_nav, Room::Watch(_)),
                                            Room::Watch(WatchKind::All),
                                            cx,
                                        ))
                                        .child(nav_tab(
                                            "nav-discover",
                                            "Discover",
                                            matches!(active_nav, Room::Discover),
                                            Room::Discover,
                                            cx,
                                        )),
                                ),
                        )
                        // Center: unified search input (Rule 16)
                        .child(
                            div().flex_1().max_w(px(360.)).min_w(px(180.)).child(
                                Input::new(&self.search)
                                    .prefix(Icon::new(Lucide::Search).text_color(rgb(DIM)))
                                    .cleanable(true),
                            ),
                        )
                        // Right: live network pill, Adding… pill (when active), Add (+), TVs (green dot when casting), Settings
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1p5()
                                .child(self.render_network_pill(&active_nav, cx))
                                .when_some(jobs_pill, |row, (pill_text, is_error)| {
                                    let dot_color = if is_error { rgb(DANGER) } else { rgb(BRAND) };
                                    let border_color = if is_error { rgb(DANGER) } else { rgb(LINE) };
                                    let text_color = if is_error { rgb(DANGER) } else { rgb(INK) };
                                    row.child(
                                        h_flex()
                                            .id("top-adding-pill")
                                            .items_center()
                                            .gap_1p5()
                                            .px_2p5()
                                            .py_1()
                                            .rounded(px(99.))
                                            .bg(rgb(CARD_ELEVATED))
                                            .border_1()
                                            .border_color(border_color)
                                            .text_xs()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(text_color)
                                            .cursor_pointer()
                                            .hover(|s| s.border_color(rgb(BRAND)))
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.open_add_modal(window, cx);
                                            }))
                                            .child(div().size(px(6.)).rounded(px(99.)).bg(dot_color))
                                            .child(pill_text),
                                    )
                                })
                                .child(
                                    Button::new("top-add")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(Lucide::Plus))
                                        .label("Add")
                                        .tooltip("Add to library")
                                        .on_click(cx.listener(|this, _, window, cx| this.open_add_modal(window, cx))),
                                )
                                .child(
                                    div()
                                        .relative()
                                        .child(
                                            Button::new("top-tvs")
                                                .ghost()
                                                .small()
                                                .icon(Icon::new(Lucide::Tv))
                                                .tooltip("TVs")
                                                .on_click(cx.listener(|this, _, window, cx| this.open_cast_sheet(None, window, cx))),
                                        )
                                        .when(casting, |d| {
                                            d.child(
                                                div()
                                                    .absolute()
                                                    .top(px(4.))
                                                    .right(px(4.))
                                                    .size(px(7.))
                                                    .rounded(px(99.))
                                                    .bg(rgb(ACCENT)),
                                            )
                                        }),
                                )
                                .child(
                                    Button::new("top-settings")
                                        .ghost()
                                        .small()
                                        .icon(IconName::Settings)
                                        .tooltip("Settings")
                                        .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx))),
                                ),
                        ),
                ),
            )
            .when(self.hood_open, |this| this.child(self.render_under_the_hood(cx)))
            .child(if self_scrolling {
                div()
                    .id("main-virtual")
                    .flex_1()
                    .min_h_0()
                    .size_full()
                    .child(body)
                    .into_any_element()
            } else {
                div()
                    .id("main-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(body)
                    .into_any_element()
            })
    }

    fn render_network_pill(&self, active_nav: &Room, cx: &mut Context<Self>) -> impl IntoElement {
        let active = matches!(active_nav, Room::Network(_));
        let (peers, down_bps, up_bps, online) = match &self.status {
            Some(st) => (total_peers(st), st.down_bps, st.up_bps, true),
            None => (0, 0, 0, false),
        };
        let peers_txt = if !online {
            "Network".to_string()
        } else if peers == 1 {
            "1 peer".to_string()
        } else {
            format!("{peers} peers")
        };
        let rate_badge = if !online {
            None
        } else if down_bps > 0 && down_bps >= up_bps {
            Some(format!("↓ {}", format_rate(down_bps)))
        } else if up_bps > 0 {
            Some(format!("↑ {}", format_rate(up_bps)))
        } else {
            None
        };
        let spark_samples: Vec<u64> = self
            .net_down_hist
            .iter()
            .zip(self.net_up_hist.iter())
            .map(|(d, u)| d.saturating_add(*u))
            .collect();
        let show_spark = online && spark_samples.len() >= 2;
        let dot_color = if !online || peers == 0 {
            rgb(DIM)
        } else {
            rgb(ACCENT)
        };
        h_flex()
            .id("top-network-pill")
            .items_center()
            .gap_2()
            .h(px(32.))
            .px_3()
            .rounded(px(99.))
            .bg(if active { rgb(CARD_ELEVATED) } else { rgb(CARD) })
            .border_1()
            .border_color(if active { rgb(BRAND) } else { rgb(LINE) })
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(if active || (online && peers > 0) { rgb(INK) } else { rgb(DIM) })
            .cursor_pointer()
            .hover(|s| s.border_color(rgb(DIM)).bg(rgb(CARD_ELEVATED)).text_color(rgb(INK)))
            .on_click(cx.listener(|this, _, _, cx| {
                this.open_room(Room::Network(NetworkTab::Globe), cx);
            }))
            .child(div().size(px(8.)).rounded(px(99.)).bg(dot_color))
            .child(peers_txt)
            .when(show_spark, |pill| {
                pill.child(
                    div().w(px(42.)).h(px(16.)).flex_none().child(
                        canvas(
                            move |_, _, _| spark_samples.clone(),
                            move |bounds, data, window, _| paint_pill_sparkline(bounds, &data, window),
                        )
                        .size_full(),
                    ),
                )
            })
            .when_some(rate_badge, |pill, rate| {
                pill.child(div().text_color(rgb(DIM)).font_weight(FontWeight::MEDIUM).child(rate))
            })
    }

    /// `Add to library` dialog (Rule 11 & Rule 18) with auto-identification (`ubit`) and live `Adding` jobs list.
    pub fn render_add_modal(&self, form: &AddModalForm, cx: &mut Context<Self>) -> impl IntoElement {
        let preview = form.identified.clone();
        let identified_url = form.identified_url.clone().unwrap_or_default();
        let has_preview = preview.is_some();
        let active_jobs = self.active_job_count();
        let failed_jobs = self.failed_job_count();
        let job_rows: Vec<AnyElement> = self
            .jobs
            .iter()
            .cloned()
            .map(|job| self.render_job_row(job, "add-job", cx).into_any_element())
            .collect();
        let has_jobs = !job_rows.is_empty();

        div()
            .id("add-modal-backdrop")
            .absolute()
            .inset_0()
            .bg(hsla(0., 0., 0., 0.62))
            .flex()
            .items_center()
            .justify_center()
            .p_6()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|this, _, _, cx| this.close_add_modal(cx)))
            .child(
                v_flex()
                    .id("add-modal-card")
                    .w(px(560.))
                    .max_w_full()
                    .max_h(px(620.))
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
                            .child(div().text_base().font_weight(FontWeight::BOLD).child("Add to library"))
                            .child(
                                Button::new("close-add-modal")
                                    .ghost()
                                    .small()
                                    .icon(IconName::Close)
                                    .tooltip("Close")
                                    .on_click(cx.listener(|this, _, _, cx| this.close_add_modal(cx))),
                            ),
                    )
                    .child(
                        div()
                            .id("add-modal-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scrollbar()
                            .child(
                                v_flex()
                                    .p_5()
                                    .gap_4()
                                    .when_some(form.error.clone(), |d, err| {
                                        d.child(div().text_sm().text_color(rgb(DANGER)).child(err))
                                    })
                                    .child(
                                        v_flex()
                                            .gap_1p5()
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .text_color(rgb(DIM))
                                                    .child("SoundCloud, YouTube, Rumble, Bandcamp, direct media, peartube:// link, or 64-character key"),
                                            )
                                            .child(Input::new(&form.input).cleanable(true)),
                                    )
                                    .when(form.identifying, |d| {
                                        d.child(
                                            h_flex()
                                                .items_center()
                                                .gap_2()
                                                .p_3p5()
                                                .rounded(px(12.))
                                                .bg(rgb(BG))
                                                .border_1()
                                                .border_color(rgb(LINE))
                                                .child(div().size(px(8.)).rounded(px(99.)).bg(rgb(BRAND)))
                                                .child(div().text_sm().text_color(rgb(DIM)).child("Identifying link…")),
                                        )
                                    })
                                    .when_some(preview, |d, info| {
                                        let site = info.effective_site(&identified_url);
                                        let title = info.effective_title(&identified_url);
                                        let author = info.effective_author();
                                        let duration = info.effective_duration_secs().map(format_duration);
                                        d.child(
                                            v_flex()
                                                .gap_3()
                                                .p_4()
                                                .rounded(px(14.))
                                                .bg(rgb(BG))
                                                .border_1()
                                                .border_color(rgb(LINE))
                                                .child(
                                                    h_flex()
                                                        .items_center()
                                                        .gap_2()
                                                        .flex_wrap()
                                                        .child(
                                                            div()
                                                                .px_2()
                                                                .py_0p5()
                                                                .rounded(px(99.))
                                                                .bg(rgb(CARD_ELEVATED))
                                                                .border_1()
                                                                .border_color(rgb(LINE))
                                                                .text_xs()
                                                                .font_weight(FontWeight::SEMIBOLD)
                                                                .text_color(rgb(BRAND))
                                                                .child(site),
                                                        )
                                                        .when_some(duration, |row, dur| {
                                                            row.child(div().text_xs().text_color(rgb(DIM)).child(dur))
                                                        }),
                                                )
                                                .child(
                                                    v_flex()
                                                        .gap_0p5()
                                                        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(title))
                                                        .when_some(author, |col, a| {
                                                            col.child(div().text_xs().text_color(rgb(DIM)).child(a))
                                                        }),
                                                )
                                                .child(
                                                    h_flex()
                                                        .justify_between()
                                                        .items_center()
                                                        .gap_3()
                                                        .pt_1()
                                                        .child(
                                                            Checkbox::new("add-audio-only")
                                                                .checked(form.audio_only)
                                                                .label("Audio only")
                                                                .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                                                    this.toggle_add_audio_only(*checked, cx);
                                                                })),
                                                        )
                                                        .child(
                                                            Button::new("add-save-library")
                                                                .primary()
                                                                .small()
                                                                .disabled(form.acquiring)
                                                                .label(if form.acquiring { "Saving…" } else { "Save to library" })
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.acquire_identified_url(cx);
                                                                })),
                                                        ),
                                                ),
                                        )
                                    })
                                    .child(
                                        h_flex()
                                            .justify_between()
                                            .items_center()
                                            .child(
                                                Button::new("add-open-settings")
                                                    .ghost()
                                                    .small()
                                                    .label("Channel settings")
                                                    .on_click(cx.listener(|this, _, window, cx| {
                                                        this.close_add_modal(cx);
                                                        this.open_settings(window, cx);
                                                    })),
                                            )
                                            .child(
                                                h_flex()
                                                    .gap_2()
                                                    .child(
                                                        Button::new("add-cancel")
                                                            .ghost()
                                                            .small()
                                                            .label("Close")
                                                            .on_click(cx.listener(|this, _, _, cx| this.close_add_modal(cx))),
                                                    )
                                                    .when(!has_preview, |row| {
                                                        row.child(
                                                            Button::new("add-submit")
                                                                .primary()
                                                                .small()
                                                                .disabled(form.identifying)
                                                                .label(if form.identifying { "Identifying…" } else { "Add" })
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.submit_add_modal(cx);
                                                                })),
                                                        )
                                                    }),
                                            ),
                                    )
                                    .when(has_jobs, |d| {
                                        d.child(
                                            v_flex()
                                                .gap_2p5()
                                                .pt_3()
                                                .border_t_1()
                                                .border_color(rgb(LINE))
                                                .child(
                                                    h_flex()
                                                        .justify_between()
                                                        .items_center()
                                                        .child(
                                                            div()
                                                                .text_sm()
                                                                .font_weight(FontWeight::SEMIBOLD)
                                                                .child(if active_jobs > 0 {
                                                                    format!("Downloads ({active_jobs} active)")
                                                                } else if failed_jobs > 0 {
                                                                    format!("Downloads ({failed_jobs} failed)")
                                                                } else {
                                                                    "Downloads".to_string()
                                                                }),
                                                        )
                                                        .child(
                                                            Button::new("add-jobs-refresh")
                                                                .ghost()
                                                                .small()
                                                                .label("Refresh")
                                                                .on_click(cx.listener(|this, _, _, cx| {
                                                                    this.refresh_jobs(cx);
                                                                })),
                                                        ),
                                                )
                                                .children(job_rows),
                                        )
                                    }),
                            ),
                    ),
            )
    }

    pub(crate) fn render_job_row(&self, job: AcquireJob, id_prefix: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let active = job.is_active();
        let failed = job.is_failed();
        let done = job.is_done();
        let pct = job.progress_fraction();
        let status_text = job.status_label();
        let job_id = job.job_id.clone();

        let mut meta_parts: Vec<String> = Vec::new();
        if !job.plugin.is_empty() && job.plugin != "http-acquire" {
            meta_parts.push(job.plugin.clone());
        }
        if let Some(peer) = &job.peer {
            meta_parts.push(peer.clone());
        }
        if job.bytes > 0 {
            if let Some(total) = job.total.filter(|&t| t > 0) {
                let pct_num = ((job.bytes as f64 / total as f64) * 100.0).clamp(0.0, 100.0).round() as u32;
                meta_parts.push(format!(
                    "{} / {} ({pct_num}%)",
                    format_bytes(job.bytes),
                    format_bytes(total)
                ));
            } else {
                meta_parts.push(format_bytes(job.bytes));
            }
        } else if let Some(total) = job.total.filter(|&t| t > 0) {
            meta_parts.push(format_bytes(total));
        }
        if let Some(speed) = job.speed.filter(|&s| s > 0 && active) {
            meta_parts.push(format!("{}/s", format_bytes(speed)));
        }
        let meta_line = meta_parts.join(" · ");
        let current_file = job.file.clone().filter(|f| !f.trim().is_empty());

        let status_color = if failed {
            rgb(DANGER)
        } else if done {
            rgb(ACCENT)
        } else if active {
            rgb(BRAND)
        } else {
            rgb(DIM)
        };
        let border_color = if failed { rgb(DANGER) } else { rgb(LINE) };

        v_flex()
            .id(SharedString::from(format!("{id_prefix}-{}", job.job_id)))
            .gap_1p5()
            .p_3()
            .rounded(px(12.))
            .bg(rgb(BG))
            .border_1()
            .border_color(border_color)
            .child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .gap_2()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .child(if job.title.is_empty() { "Untitled".to_string() } else { job.title.clone() }),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(status_color).child(status_text))
                                    .when(!meta_line.is_empty(), |row| {
                                        row.child(div().text_xs().text_color(rgb(DIM)).truncate().child(meta_line))
                                    }),
                            )
                            .when_some(current_file, |col, file| {
                                col.child(div().text_xs().text_color(rgb(DIM)).truncate().child(file))
                            }),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .when(failed && (job.retryable || job.plugin == "soulseek"), |row| {
                                let retry_id = job.job_id.clone();
                                row.child(
                                    Button::new(SharedString::from(format!("{id_prefix}-retry-{}", job.job_id)))
                                        .ghost()
                                        .small()
                                        .label("Retry")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.retry_job(retry_id.clone(), cx);
                                        })),
                                )
                            })
                            .child(
                                Button::new(SharedString::from(format!("{id_prefix}-cancel-{}", job.job_id)))
                                    .ghost()
                                    .small()
                                    .label(if active { "Cancel" } else { "Dismiss" })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.cancel_or_dismiss_job(job_id.clone(), cx);
                                    })),
                            ),
                    ),
            )
            .when_some(pct.filter(|_| active), |card, frac| {
                card.child(
                    div()
                        .w_full()
                        .h(px(4.))
                        .rounded(px(99.))
                        .bg(rgb(LINE))
                        .overflow_hidden()
                        .child(
                            div()
                                .h_full()
                                .w(relative(frac))
                                .rounded(px(99.))
                                .bg(rgb(BRAND)),
                        ),
                )
            })
            .when_some(job.error.clone(), |card, err| {
                card.child(div().text_xs().text_color(rgb(DANGER)).child(err))
            })
            .when_some(job.note.clone().filter(|_| job.error.is_none()), |card, note| {
                card.child(div().text_xs().text_color(rgb(DIM)).child(note))
            })
    }

    fn render_under_the_hood(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let status = self.status.as_ref();
        let peers = status.map_or(0, total_peers);
        let cached = status.map_or(0, |s| s.cached_bytes);
        let stored = status.map_or(0, |s| s.blob_bytes);
        let channel = status.map(|s| s.channel.clone()).unwrap_or_default();
        let discovered = status.map(|s| s.discovered_sources.clone()).unwrap_or_default();
        let p2p = p2p_summary(status);
        let lan = status.and_then(|s| s.lan.clone());
        let api_url = status.and_then(|s| s.api_url.clone());

        let mood = if peers > 0 {
            format!("Connected to {peers} peer{}.", if peers == 1 { "" } else { "s" })
        } else {
            "Searching for peers…".to_string()
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
                                                .label(format!("Free up {}", format_bytes(cached)))
                                                .on_click(cx.listener(|this, _, _, cx| this.clear_cache(None, cx))),
                                        )
                                    })
                                    .child(
                                        Button::new("hood-close")
                                            .ghost()
                                            .small()
                                            .icon(IconName::Close)
                                            .tooltip("Close")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.hood_open = false;
                                                cx.notify();
                                            })),
                                    ),
                            ),
                    )
                    .when(!self.settings.sources.is_empty() || !discovered.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_2()
                                .when(!self.settings.sources.is_empty(), |this| {
                                    let total_src = self.settings.sources.len();
                                    let active: Vec<_> = self
                                        .settings
                                        .sources
                                        .iter()
                                        .take(48)
                                        .map(|s| {
                                            let label_txt = if s.alias.is_empty() {
                                                let short: String = s.key.chars().take(8).collect();
                                                format!("{short}…")
                                            } else {
                                                s.alias.clone()
                                            };
                                            let rm_key = s.key.clone();
                                            Button::new(SharedString::from(format!("hood-rm-{}", s.key)))
                                                .ghost()
                                                .small()
                                                .label(format!("{label_txt} ×"))
                                                .tooltip("Unfollow channel")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.remove_subscribed_source(rm_key.clone(), cx)
                                                }))
                                        })
                                        .collect();
                                    let mut row = v_flex().gap_1().child(h_flex().gap_1p5().flex_wrap().children(active));
                                    if total_src > 48 {
                                        row = row.child(
                                            div()
                                                .text_xs()
                                                .text_color(rgb(DIM))
                                                .child(format!("Showing 48 of {total_src} followed channels")),
                                        );
                                    }
                                    this.child(row)
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
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.subscribe_discovered(d.clone(), cx)
                                                }))
                                        })
                                        .collect();
                                    this.child(h_flex().gap_2().flex_wrap().children(disc_btns))
                                }),
                        )
                    })
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
                                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Share your channel"))
                                                .child(
                                                    div()
                                                        .text_xs()
                                                        .text_color(rgb(DIM))
                                                        .child("Read-only public feed; only your linked devices can publish or delete."),
                                                )
                                                .child(
                                                    h_flex()
                                                        .mt_1()
                                                        .gap_2()
                                                        .flex_wrap()
                                                        .child(
                                                            Button::new("hood-copy-channel")
                                                                .small()
                                                                .icon(Icon::new(Lucide::Share2))
                                                                .label("Copy channel link")
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
                                                                    .label("Copy device key")
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
                                                                    .label("Copy 12-word phrase")
                                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                                        this.copy_recovery_phrase(cx)
                                                                    })),
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
                                                            .label("Copy pass")
                                                            .on_click(cx.listener(move |_, _, _, cx| {
                                                                cx.write_to_clipboard(ClipboardItem::new_string(pass.clone()));
                                                            })),
                                                    )
                                                    .child(
                                                        Button::new("hood-rotate-pass")
                                                            .ghost()
                                                            .small()
                                                            .label("Rotate pass")
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
                                            let name = if !w.alias.is_empty() {
                                                w.alias
                                            } else {
                                                let short: String = w.key.chars().take(8).collect();
                                                format!("{short}…")
                                            };
                                            let tag = if w.self_device {
                                                format!("{name} (this Mac)")
                                            } else {
                                                format!("{name} · {}", w.role)
                                            };
                                            let can_rm = w.key != ch_hex;
                                            let wk = w.key.clone();
                                            let btn = Button::new(SharedString::from(format!("hood-writer-{}", w.key)))
                                                .ghost()
                                                .small();
                                            if can_rm {
                                                btn.label(format!("{tag} ×"))
                                                    .on_click(cx.listener(move |this, _, _, cx| this.revoke_linked_writer(wk.clone(), cx)))
                                            } else {
                                                btn.label(tag)
                                            }
                                        })
                                        .collect();
                                    card.child(h_flex().gap_1p5().flex_wrap().children(chips))
                                }),
                        )
                    })
                    .child(
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex().child(
                                    Button::new("hood-engine-toggle")
                                        .ghost()
                                        .small()
                                        .icon(Icon::new(if self.hood_engine_open {
                                            Lucide::ChevronDown
                                        } else {
                                            Lucide::ChevronRight
                                        }))
                                        .label("Engine room")
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
                                        .child({
                                            let limit = status.map_or(0, |s| s.cache_max_bytes);
                                            if limit > 0 {
                                                format!("Playback cache limit {}", format_bytes(limit))
                                            } else {
                                                "Playback cache unlimited".to_string()
                                            }
                                        })
                                        .when_some(lan, |t, l| t.child(format!("LAN {l}")))
                                        .when_some(api_url, |t, a| t.child(format!("Local daemon {a}")))
                                        .when_some(p2p, |t, p| t.child(div().text_color(rgb(BRAND)).child(p))),
                                )
                            }),
                    ),
            )
    }
}

/// Compact rate sparkline painted inside the top-bar Network pill.
fn paint_pill_sparkline(bounds: Bounds<Pixels>, data: &[u64], window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    if w < 4.0 || h < 4.0 || data.len() < 2 {
        return;
    }
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let peak = data.iter().copied().max().unwrap_or(0);
    let top = peak.max(1) as f32;
    let step = w / (data.len() - 1) as f32;
    let mut pb = PathBuilder::stroke(px(1.5));
    for (i, &val) in data.iter().enumerate() {
        let x = ox + i as f32 * step;
        let y = if peak == 0 {
            oy + h - 2.0
        } else {
            oy + (h - 2.0) - (val as f32 / top) * (h - 4.0)
        };
        if i == 0 {
            pb.move_to(point(px(x), px(y)));
        } else {
            pb.line_to(point(px(x), px(y)));
        }
    }
    if let Ok(path) = pb.build() {
        let col = if peak == 0 {
            Hsla::from(rgb(DIM)).opacity(0.45)
        } else {
            Hsla::from(rgb(BRAND_HOVER))
        };
        window.paint_path(path, col);
    }
}

/// Top-bar pill summary for active or failed acquisition jobs.
/// Returns `(label, is_error)` when any job is active or failed.
pub(crate) fn top_bar_jobs_pill(jobs: &[AcquireJob]) -> Option<(String, bool)> {
    let active: Vec<&AcquireJob> = jobs.iter().filter(|j| j.is_active()).collect();
    if let Some(first) = active.first() {
        let text = if active.len() == 1 {
            if let Some(frac) = first.progress_fraction().filter(|_| first.bytes > 0) {
                format!("Adding · {}%", (frac * 100.0).round() as u32)
            } else if first.status == "queued" {
                if first.phase.as_deref() == Some("retrying") {
                    "Retrying…".into()
                } else {
                    match first.queue_place {
                        Some(q) if q > 0 => format!("Queued (#{q})"),
                        _ => "Adding…".into(),
                    }
                }
            } else {
                "Adding…".into()
            }
        } else {
            format!("Adding ({})…", active.len())
        };
        return Some((text, false));
    }
    let failed = jobs.iter().filter(|j| j.is_failed()).count();
    if failed > 0 {
        return Some((format!("{failed} failed"), true));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::top_bar_jobs_pill;
    use crate::api::AcquireJob;

    fn job(id: &str, status: &str) -> AcquireJob {
        AcquireJob {
            job_id: id.into(),
            status: status.into(),
            ..Default::default()
        }
    }

    #[test]
    fn top_bar_pill_shows_active_progress_and_failed_count() {
        assert_eq!(top_bar_jobs_pill(&[]), None);
        assert_eq!(top_bar_jobs_pill(&[job("1", "done")]), None);

        let mut active = job("2", "transferring");
        active.bytes = 500;
        active.total = Some(2000);
        assert_eq!(
            top_bar_jobs_pill(&[active]),
            Some(("Adding · 25%".into(), false))
        );

        let mut queued = job("3", "queued");
        queued.queue_place = Some(12);
        assert_eq!(
            top_bar_jobs_pill(&[queued]),
            Some(("Queued (#12)".into(), false))
        );

        let mut retrying = job("3b", "queued");
        retrying.phase = Some("retrying".into());
        assert_eq!(retrying.status_label(), "Retrying…");
        assert_eq!(
            top_bar_jobs_pill(&[retrying]),
            Some(("Retrying…".into(), false))
        );

        let failed_only = vec![job("4", "failed"), job("5", "failed")];
        assert_eq!(
            top_bar_jobs_pill(&failed_only),
            Some(("2 failed".into(), true))
        );
    }
}
