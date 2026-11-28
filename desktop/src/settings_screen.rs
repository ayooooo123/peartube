//! Progressive-disclosure Settings: human-first Channels & Playback up front,
//! Advanced Network & Engine tucked quietly behind an expandable section.

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use peartube::settings::Settings;
use peartube::soundfont;
use peartube::worker::worker;
use serde_json::json;

use crate::api::{MetaSourceInfo, run_blocking};
use crate::app::{PearTube, Screen};
use crate::list::{column, format_bytes};
use crate::theme::{ACCENT, CARD, DANGER, DIM, LINE};

pub struct SettingsForm {
    tracker: Entity<InputState>,
    mnemonic: Entity<InputState>,
    sources: Entity<TextareaState>,
    relays: Entity<TextareaState>,
    bootstrap: Entity<TextareaState>,
    slsk_user: Entity<InputState>,
    slsk_password: Entity<InputState>,
    slsk_password_set: bool,
    slsk_share: bool,
    slsk_uses_slsk_keys: bool,
    slsk_busy: bool,
    slsk_notice: Option<SharedString>,
    slsk_error: Option<SharedString>,
    meta_sources: Vec<MetaSourceInfo>,
    meta_input: Entity<InputState>,
    p2p_only_metadata: bool,
    seed_full_metadata: bool,
    meta_busy: bool,
    meta_notice: Option<SharedString>,
    meta_error: Option<SharedString>,
    lan: bool,
    private_routing: bool,
    cache_max_gb: u32,
    advanced_open: bool,
    error: Option<SharedString>,
}

fn meta_info_from_saved(raw: &str) -> MetaSourceInfo {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let key = if let Some(rest) = lower.strip_prefix("peartube://meta/") {
        rest.split(['?', '#', '/']).next().unwrap_or("").to_string()
    } else if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        lower
    } else {
        trimmed.to_string()
    };
    let uri = if trimmed.to_ascii_lowercase().starts_with("peartube://meta/") {
        trimmed.to_string()
    } else if key.len() == 64 {
        format!("peartube://meta/{key}")
    } else {
        trimmed.to_string()
    };
    MetaSourceInfo {
        key,
        uri,
        alias: String::new(),
        writable: false,
        seed_full: false,
        active: true,
    }
}

fn saved_meta_uris(sources: &[MetaSourceInfo]) -> Vec<String> {
    sources
        .iter()
        .filter_map(|s| {
            let v = if !s.uri.trim().is_empty() {
                s.uri.trim()
            } else {
                s.key.trim()
            };
            (!v.is_empty()).then(|| v.to_string())
        })
        .collect()
}

impl SettingsForm {
    pub fn set_cache_max_gb(&mut self, gb: u32) {
        self.cache_max_gb = gb;
    }

    pub fn new(settings: &Settings, window: &mut Window, cx: &mut Context<PearTube>) -> Self {
        let advanced_open = !settings.relay_through.is_empty() || !settings.bootstrap.is_empty() || settings.private_routing;
        let meta_sources = settings.meta_sources.iter().map(|s| meta_info_from_saved(s)).collect();
        SettingsForm {
            tracker: cx.new(|cx| InputState::new(window, cx).placeholder("Paste a 64-character channel key or peartube://channel/…").default_value(settings.tracker.clone())),
            mnemonic: cx.new(|cx| InputState::new(window, cx).placeholder("12-word recovery phrase to link your channel on this Mac…").default_value(settings.mnemonic.clone())),
            sources: cx.new(|cx| TextareaState::new(window, cx).rows(4).placeholder("One peartube://channel/… link per line").default_value(settings.format_sources())),
            relays: cx.new(|cx| TextareaState::new(window, cx).rows(2).default_value(settings.relay_through.join(", "))),
            bootstrap: cx.new(|cx| TextareaState::new(window, cx).rows(2).default_value(settings.bootstrap.join(", "))),
            slsk_user: cx.new(|cx| InputState::new(window, cx).placeholder("Soulseek username")),
            slsk_password: cx.new(|cx| InputState::new(window, cx).placeholder("Soulseek password")),
            slsk_password_set: false,
            slsk_share: false,
            slsk_uses_slsk_keys: false,
            slsk_busy: false,
            slsk_notice: None,
            slsk_error: None,
            meta_sources,
            meta_input: cx.new(|cx| InputState::new(window, cx).placeholder("Paste peartube://meta/… link or 64-hex key")),
            p2p_only_metadata: settings.p2p_only_metadata,
            seed_full_metadata: settings.seed_full_metadata,
            meta_busy: false,
            meta_notice: None,
            meta_error: None,
            lan: settings.lan_discovery,
            private_routing: settings.private_routing,
            cache_max_gb: settings.cache_max_gb,
            advanced_open,
            error: None,
        }
    }
}

fn card_section(title: &'static str, subtitle: &'static str, body: impl IntoElement) -> Div {
    v_flex()
        .p_5()
        .gap_3()
        .rounded(px(16.))
        .bg(rgb(CARD))
        .border_1()
        .border_color(rgb(LINE))
        .child(
            v_flex()
                .gap_0p5()
                .child(div().text_base().font_weight(FontWeight::SEMIBOLD).child(title))
                .child(div().text_xs().text_color(rgb(DIM)).child(subtitle)),
        )
        .child(body)
}

fn inline_error(error: SharedString) -> Div {
    div().text_sm().text_color(rgb(DANGER)).child(error)
}

impl PearTube {
    pub fn render_settings(&self, form: &SettingsForm, cx: &mut Context<Self>) -> impl IntoElement {
        let bank = &self.bank;
        let adv = form.advanced_open;
        let first_run = !self.settings.has_sources();

        v_flex()
            .size_full()
            .child(
                div().border_b_1().border_color(rgb(LINE)).child(
                    column().py_3p5().child(
                        h_flex()
                            .justify_between()
                            .items_center()
                            .min_h(px(32.))
                            .child(div().text_xl().font_weight(FontWeight::BOLD).child(if first_run { "Welcome to PearTube" } else { "Settings" }))
                            .when(!first_run, |this| {
                                this.child(Button::new("cancel").ghost().label("Close").on_click(cx.listener(|this, _, _, cx| this.show_list(cx))))
                            }),
                    ),
                ),
            )
            .child(
                div().id("settings").flex_1().min_h_0().overflow_y_scrollbar().child(
                    column()
                        .py_6()
                        .gap_4()
                        .when_some(form.error.clone(), |this, error| this.child(inline_error(error)))
                        .child(card_section(
                            "Channels & Account",
                            "Follow creator channels, connect a primary channel key, or link your 12-word recovery phrase.",
                            v_flex()
                                .gap_3()
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Primary Channel Key (optional)"))
                                        .child(Input::new(&form.tracker).cleanable(true)),
                                )
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("12-Word Recovery Phrase (link your account)"))
                                        .child(Input::new(&form.mnemonic).cleanable(true)),
                                )
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Followed Channels"))
                                        .child(Textarea::new(&form.sources)),
                                ),
                        ))
                        .when(!first_run, |this| {
                            this.child(card_section(
                                "Playback & MIDI",
                                "Optional SoundFont 2 (.sf2) bank for MIDI tracks, kept privately on this Mac.",
                                v_flex()
                                    .gap_2()
                                    .when_some(bank.error.clone(), |t, err| t.child(inline_error(err)))
                                    .child(div().text_xs().text_color(rgb(DIM)).child(if bank.selected { "SoundFont installed." } else { "No SoundFont selected." }))
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .child(
                                                Button::new("choose-soundfont")
                                                    .small()
                                                    .label(if bank.busy { "Importing…" } else { "Choose .sf2 File" })
                                                    .disabled(bank.busy)
                                                    .on_click(cx.listener(|this, _, _, cx| this.choose_soundfont(cx))),
                                            )
                                            .when(bank.selected, |t| {
                                                t.child(
                                                    Button::new("remove-soundfont")
                                                        .ghost()
                                                        .small()
                                                        .label("Remove")
                                                        .disabled(bank.busy)
                                                        .on_click(cx.listener(|this, _, _, cx| this.clear_soundfont(cx))),
                                                )
                                            }),
                                    ),
                            ))
                        })
                        .when(!first_run, |this| {
                            this.child(card_section(
                                "Soulseek",
                                "Connect this Mac as its own independent Soulseek peer to search and save lossless albums.",
                                v_flex()
                                    .gap_3()
                                    .when_some(form.slsk_error.clone(), |t, err| t.child(inline_error(err)))
                                    .when_some(form.slsk_notice.clone(), |t, msg| {
                                        t.child(div().text_xs().text_color(rgb(ACCENT)).child(msg))
                                    })
                                    .child(
                                        v_flex()
                                            .gap_1()
                                            .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Username"))
                                            .child(Input::new(&form.slsk_user).cleanable(true)),
                                    )
                                    .child(
                                        v_flex()
                                            .gap_1()
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(rgb(DIM))
                                                    .child(if form.slsk_password_set {
                                                        "Password (saved — leave blank to keep)"
                                                    } else {
                                                        "Password"
                                                    }),
                                            )
                                            .child(Input::new(&form.slsk_password).cleanable(true)),
                                    )
                                    .child(
                                        Checkbox::new("soulseek-share")
                                            .checked(form.slsk_share)
                                            .label("Share public music")
                                            .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                                if let Screen::Settings(f) = &mut this.screen {
                                                    f.slsk_share = *checked;
                                                    cx.notify();
                                                }
                                            })),
                                    )
                                    .child(
                                        h_flex().child(
                                            Button::new("save-soulseek-settings")
                                                .small()
                                                .primary()
                                                .disabled(form.slsk_busy)
                                                .label(if form.slsk_busy { "Saving…" } else { "Save Soulseek settings" })
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.save_soulseek_settings(window, cx);
                                                })),
                                        ),
                                    ),
                            ))
                        })
                        .when(!first_run, |this| this.child(self.render_meta_card(form, cx)))
                        .child(card_section(
                            "Storage Contribution",
                            "How much playback cache this Mac keeps to help the network. Applies immediately; the film you are watching always keeps a window around the playhead.",
                            v_flex()
                                .gap_3()
                                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(if form.cache_max_gb == 0 {
                                    "Unlimited".to_string()
                                } else {
                                    format!("{} GB on disk", form.cache_max_gb)
                                }))
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .flex_wrap()
                                        .children([5u32, 10, 25, 50, 100, 0].into_iter().map(|gb| {
                                            let selected = form.cache_max_gb == gb;
                                            let btn = Button::new(SharedString::from(format!("cache-limit-{gb}")))
                                                .small()
                                                .label(if gb == 0 { "Unlimited".to_string() } else { format!("{gb} GB") });
                                            let btn = if selected { btn.primary() } else { btn.ghost() };
                                            btn.on_click(cx.listener(move |this, _, _, cx| this.set_cache_limit(gb, cx)))
                                        })),
                                )
                                .child(div().text_xs().text_color(rgb(DIM)).child(match (self.status.as_ref(), form.cache_max_gb) {
                                    (Some(s), 0) => format!("Using {} · unlimited", format_bytes(s.cached_bytes)),
                                    (Some(s), gb) => format!("Using {} of {} GB", format_bytes(s.cached_bytes), gb),
                                    (None, _) => "Usage appears once the node is up.".to_string(),
                                }))
                                .child(div().text_xs().text_color(rgb(DIM)).child(if form.cache_max_gb == 0 {
                                    "Currently unlimited: cached blocks are only freed when you do it by hand.".to_string()
                                } else {
                                    format!("At most {} GB of cached blocks; the least recently watched are freed first.", form.cache_max_gb)
                                })),
                        ))
                        .child(
                            v_flex()
                                .gap_2()
                                .child(
                                    h_flex().child(
                                        Button::new("toggle-advanced-settings")
                                            .ghost()
                                            .small()
                                            .icon(Icon::new(if adv { Lucide::ChevronDown } else { Lucide::ChevronRight }))
                                            .label("Advanced Network & Engine")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                if let Screen::Settings(f) = &mut this.screen {
                                                    f.advanced_open = !f.advanced_open;
                                                    cx.notify();
                                                }
                                            })),
                                    ),
                                )
                                .when(adv, |this| {
                                    this.child(
                                        v_flex()
                                            .p_5()
                                            .gap_4()
                                            .rounded(px(16.))
                                            .bg(rgb(CARD))
                                            .border_1()
                                            .border_color(rgb(LINE))
                                            .child(
                                                Checkbox::new("lan")
                                                    .checked(form.lan)
                                                    .label("Local Wi-Fi Turbo (mDNS discovery)")
                                                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                                        if let Screen::Settings(form) = &mut this.screen {
                                                            form.lan = *checked;
                                                            cx.notify();
                                                        }
                                                    })),
                                            )
                                            .child(
                                                Checkbox::new("private-routing")
                                                    .checked(form.private_routing)
                                                    .label("2-Hop Private Guard Circuits")
                                                    .on_click(cx.listener(|this, checked: &bool, _, cx| {
                                                        if let Screen::Settings(form) = &mut this.screen {
                                                            form.private_routing = *checked;
                                                            cx.notify();
                                                        }
                                                    })),
                                            )
                                            .child(
                                                v_flex()
                                                    .gap_1()
                                                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Blind Relays (optional)"))
                                                    .child(Textarea::new(&form.relays)),
                                            )
                                            .child(
                                                v_flex()
                                                    .gap_1()
                                                    .child(div().text_xs().font_weight(FontWeight::MEDIUM).text_color(rgb(DIM)).child("Custom DHT Bootstrap (optional)"))
                                                    .child(Textarea::new(&form.bootstrap)),
                                            ),
                                    )
                                }),
                        )
                ),
            )
            .child(
                div().border_t_1().border_color(rgb(LINE)).child(
                    column().py_3().child(
                        h_flex()
                            .justify_end()
                            .child(Button::new("save").primary().label(if first_run { "Connect & Open Cinema" } else { "Save Changes" }).on_click(cx.listener(|this, _, _, cx| this.save_settings(cx)))),
                    ),
                ),
            )
    }

    fn save_settings(&mut self, cx: &mut Context<Self>) {
        let Screen::Settings(form) = &mut self.screen else { return };
        let tracker = form.tracker.read(cx).value();
        let mnemonic = form.mnemonic.read(cx).value();
        let sources = form.sources.read(cx).value();
        let relay_through = form.relays.read(cx).value();
        let bootstrap = form.bootstrap.read(cx).value();
        let lan_discovery = form.lan;
        let private_routing = form.private_routing;
        let cache_max_gb = form.cache_max_gb;
        let meta_sources = saved_meta_uris(&form.meta_sources);
        let p2p_only_metadata = form.p2p_only_metadata;
        let seed_full_metadata = form.seed_full_metadata;

        let raw = json!({
            "tracker": tracker,
            "mnemonic": mnemonic,
            "sources": sources,
            "relayThrough": relay_through,
            "bootstrap": bootstrap,
            "lanDiscovery": lan_discovery,
            "privateRouting": private_routing,
            "cacheMaxGb": cache_max_gb,
            "metaSources": meta_sources,
            "p2pOnlyMetadata": p2p_only_metadata,
            "seedFullMetadata": seed_full_metadata,
        });

        cx.spawn(async move |this, cx| {
            let normalized = match worker() {
                Ok(w) => w.normalize_settings(raw, true).await,
                Err(err) => Err(err),
            };
            let _ = this.update(cx, |this, cx| {
                match normalized.and_then(|new| new.save().map(|()| new)) {
                    Err(err) => {
                        if let Screen::Settings(form) = &mut this.screen {
                            form.error = Some(err.into());
                            cx.notify();
                        }
                    }
                    Ok(new) => {
                        this.settings = new.clone();
                        this.status = None;
                        this.entries.clear();
                        this.catalog = crate::catalog::Catalog::default();
                        this.show_list(cx);
                        this.start(new, cx);
                    }
                }
            });
        })
        .detach();
    }

    fn choose_soundfont(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Choose".into()) });
        self.bank.busy = true;
        self.bank.error = None;
        self.bank.task = Some(cx.spawn(async move |this, cx| {
            let result = match picked.await {
                Ok(Ok(Some(paths))) => match paths.into_iter().next() {
                    Some(path) => soundfont::import(path).await,
                    None => Ok(()),
                },
                Ok(Err(err)) => Err(err.to_string()),
                Ok(Ok(None)) | Err(_) => Ok(()),
            };
            let _ = this.update(cx, |this, cx| {
                this.bank.busy = false;
                this.bank.error = result.err().map(Into::into);
                this.bank.selected = soundfont::path().is_some();
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn clear_soundfont(&mut self, cx: &mut Context<Self>) {
        self.bank.error = soundfont::clear().err().map(Into::into);
        self.bank.selected = soundfont::path().is_some();
        cx.notify();
    }

    pub fn load_soulseek_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        cx.spawn_in(window, async move |this, cx| {
            let res = run_blocking(move || client.get_soulseek_settings()).await;
            let Ok(Ok(slsk)) = res else {
                return;
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    if !slsk.user.is_empty() {
                        form.slsk_user
                            .update(cx, |inp, cx| inp.set_value(slsk.user.clone(), window, cx));
                    }
                    form.slsk_password_set = slsk.password_set;
                    form.slsk_share = slsk.share;
                    form.slsk_uses_slsk_keys = slsk.uses_slsk_keys;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn save_soulseek_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            if let Screen::Settings(form) = &mut self.screen {
                form.slsk_error = Some("Local engine is still starting — wait a moment and try again.".into());
                cx.notify();
            }
            return;
        };
        let (user, password, share, uses_legacy) = {
            let Screen::Settings(form) = &mut self.screen else {
                return;
            };
            let user = form.slsk_user.read(cx).value().trim().to_string();
            let raw_pass = form.slsk_password.read(cx).value().to_string();
            let password = if raw_pass.is_empty() && form.slsk_password_set {
                None
            } else {
                Some(raw_pass)
            };
            let share = form.slsk_share;
            let uses_legacy = form.slsk_uses_slsk_keys;
            form.slsk_busy = true;
            form.slsk_error = None;
            form.slsk_notice = None;
            (user, password, share, uses_legacy)
        };
        cx.notify();

        let sent_password = password.as_ref().is_some_and(|p| !p.is_empty());
        cx.spawn_in(window, async move |this, cx| {
            let res = run_blocking(move || {
                client.save_soulseek_settings(&user, password.as_deref(), share, uses_legacy)
            })
            .await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    form.slsk_busy = false;
                    match outcome {
                        Ok(updated) => {
                            form.slsk_password_set = updated.password_set || sent_password;
                            form.slsk_share = updated.share;
                            form.slsk_uses_slsk_keys = updated.uses_slsk_keys;
                            form.slsk_password
                                .update(cx, |inp, cx| inp.set_value("", window, cx));
                            form.slsk_error = None;
                            form.slsk_notice = Some("Soulseek settings saved.".into());
                        }
                        Err(err) => {
                            form.slsk_error = Some(err.into());
                            form.slsk_notice = None;
                        }
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn render_meta_card(&self, form: &SettingsForm, cx: &mut Context<Self>) -> Div {
        let enforced_by_private = form.private_routing || self.settings.private_routing;
        let p2p_checked = form.p2p_only_metadata || enforced_by_private;
        let sources = form.meta_sources.clone();
        let busy = form.meta_busy;

        card_section(
            "P2P Metadata & Artwork",
            "Subscribe to peer-to-peer metadata catalogs for posters, backdrops, synopses, and search without clearnet trackers.",
            v_flex()
                .gap_3()
                .when_some(form.meta_error.clone(), |t, err| t.child(inline_error(err)))
                .when_some(form.meta_notice.clone(), |t, msg| {
                    t.child(div().text_xs().text_color(rgb(ACCENT)).child(msg))
                })
                .child(if sources.is_empty() {
                    div()
                        .text_xs()
                        .text_color(rgb(DIM))
                        .child("No P2P metadata sources configured.")
                        .into_any_element()
                } else {
                    v_flex()
                        .gap_2()
                        .children(sources.into_iter().enumerate().map(|(idx, src)| {
                            let label = if !src.alias.trim().is_empty() {
                                src.alias.clone()
                            } else {
                                format!("Catalog {}", idx + 1)
                            };
                            let display_uri = if !src.uri.is_empty() {
                                src.uri.clone()
                            } else {
                                format!("peartube://meta/{}", src.key)
                            };
                            let key_for_rm = src.key.clone();
                            h_flex()
                                .items_center()
                                .justify_between()
                                .gap_2()
                                .px_3()
                                .py_2()
                                .rounded(px(10.))
                                .border_1()
                                .border_color(rgb(LINE))
                                .child(
                                    v_flex()
                                        .min_w_0()
                                        .flex_1()
                                        .gap_0p5()
                                        .child(div().text_xs().font_weight(FontWeight::MEDIUM).child(label))
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(rgb(DIM))
                                                .truncate()
                                                .child(display_uri),
                                        ),
                                )
                                .child(
                                    Button::new(SharedString::from(format!("remove-meta-source-{idx}")))
                                        .ghost()
                                        .small()
                                        .disabled(busy)
                                        .label("Remove")
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.remove_meta_source(key_for_rm.clone(), window, cx);
                                        })),
                                )
                        }))
                        .into_any_element()
                })
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(div().flex_1().child(Input::new(&form.meta_input).cleanable(true)))
                        .child(
                            Button::new("add-meta-source")
                                .small()
                                .primary()
                                .disabled(busy)
                                .label(if busy { "Working…" } else { "Add" })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.add_meta_source(window, cx);
                                })),
                        ),
                )
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            Checkbox::new("p2p-only-metadata")
                                .checked(p2p_checked)
                                .disabled(enforced_by_private)
                                .label("P2P-only metadata")
                                .on_click(cx.listener(|this, checked: &bool, window, cx| {
                                    this.update_meta_toggles(Some(*checked), None, window, cx);
                                })),
                        )
                        .child(div().text_xs().text_color(rgb(DIM)).child(if enforced_by_private {
                            "Blocks all clearnet Cinemeta and Metahub lookups. Automatically enforced while 2-Hop Private Guard Circuits are enabled."
                        } else {
                            "Blocks all clearnet Cinemeta, Metahub, and external metadata lookups. Also enforced automatically under Private Routing."
                        })),
                )
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            Checkbox::new("seed-full-metadata")
                                .checked(form.seed_full_metadata)
                                .label("Seed full metadata catalog")
                                .on_click(cx.listener(|this, checked: &bool, window, cx| {
                                    this.update_meta_toggles(None, Some(*checked), window, cx);
                                })),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(rgb(DIM))
                                .child("Opt in to mirror full metadata and artwork shards for your subscribed catalogs."),
                        ),
                ),
        )
    }

    pub fn load_meta_sources(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_meta_sources(cx);
    }

    pub fn refresh_meta_sources(&mut self, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let res = run_blocking(move || client.meta_sources()).await;
            let Ok(Ok(state)) = res else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    form.meta_sources = state.sources;
                    if !this.settings.private_routing {
                        form.p2p_only_metadata = state.p2p_only_metadata;
                    }
                    form.seed_full_metadata = state.seed_full_metadata;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn add_meta_source(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            if let Screen::Settings(form) = &mut self.screen {
                form.meta_error = Some("Local engine is still starting — wait a moment and try again.".into());
                cx.notify();
            }
            return;
        };
        let (raw, seed_full) = {
            let Screen::Settings(form) = &mut self.screen else {
                return;
            };
            let raw = form.meta_input.read(cx).value().trim().to_string();
            if raw.is_empty() {
                form.meta_error = Some("Enter a peartube://meta/… link or 64-hex key.".into());
                form.meta_notice = None;
                cx.notify();
                return;
            }
            form.meta_busy = true;
            form.meta_error = None;
            form.meta_notice = None;
            (raw, form.seed_full_metadata)
        };
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let res = run_blocking(move || client.add_meta_source(&raw, "", seed_full)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update_in(cx, |this, window, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    form.meta_busy = false;
                    match outcome {
                        Ok(state) => {
                            form.meta_sources = state.sources.clone();
                            form.seed_full_metadata = state.seed_full_metadata;
                            if !this.settings.private_routing {
                                form.p2p_only_metadata = state.p2p_only_metadata;
                            }
                            form.meta_input
                                .update(cx, |inp, cx| inp.set_value("", window, cx));
                            form.meta_error = None;
                            form.meta_notice = Some("Metadata source added.".into());
                            this.settings.meta_sources = saved_meta_uris(&state.sources);
                            this.settings.seed_full_metadata = state.seed_full_metadata;
                            if let Err(err) = this.settings.save() {
                                form.meta_error = Some(err.into());
                            }
                            this.clear_failed_thumbs_and_prefetch(cx);
                        }
                        Err(err) => {
                            form.meta_error = Some(err.into());
                            form.meta_notice = None;
                        }
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn remove_meta_source(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(client) = self.api_client() else {
            if let Screen::Settings(form) = &mut self.screen {
                form.meta_error = Some("Local engine is still starting — wait a moment and try again.".into());
                cx.notify();
            }
            return;
        };
        if let Screen::Settings(form) = &mut self.screen {
            form.meta_busy = true;
            form.meta_error = None;
            form.meta_notice = None;
        }
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
            let res = run_blocking(move || client.remove_meta_source(&key)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update_in(cx, |this, _window, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    form.meta_busy = false;
                    match outcome {
                        Ok(state) => {
                            form.meta_sources = state.sources.clone();
                            form.meta_error = None;
                            form.meta_notice = Some("Metadata source removed.".into());
                            this.settings.meta_sources = saved_meta_uris(&state.sources);
                            if let Err(err) = this.settings.save() {
                                form.meta_error = Some(err.into());
                            }
                        }
                        Err(err) => {
                            form.meta_error = Some(err.into());
                            form.meta_notice = None;
                        }
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub fn update_meta_toggles(
        &mut self,
        p2p_only: Option<bool>,
        seed_full: Option<bool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Screen::Settings(form) = &mut self.screen {
            if let Some(p) = p2p_only {
                form.p2p_only_metadata = p;
                self.settings.p2p_only_metadata = p;
            }
            if let Some(s) = seed_full {
                form.seed_full_metadata = s;
                self.settings.seed_full_metadata = s;
            }
            form.meta_error = None;
            form.meta_notice = None;
            if let Err(err) = self.settings.save() {
                form.meta_error = Some(err.into());
            }
        }
        if p2p_only == Some(false) {
            self.clear_failed_thumbs_and_prefetch(cx);
        }
        cx.notify();

        let Some(client) = self.api_client() else {
            return;
        };
        if let Screen::Settings(form) = &mut self.screen {
            form.meta_busy = true;
        }
        cx.spawn_in(window, async move |this, cx| {
            let res = run_blocking(move || client.set_meta_toggles(p2p_only, seed_full)).await;
            let outcome = match res {
                Ok(inner) => inner,
                Err(err) => Err(err),
            };
            let _ = this.update_in(cx, |this, _window, cx| {
                if let Screen::Settings(form) = &mut this.screen {
                    form.meta_busy = false;
                    match outcome {
                        Ok(state) => {
                            form.meta_sources = state.sources.clone();
                            form.seed_full_metadata = state.seed_full_metadata;
                            if !this.settings.private_routing {
                                form.p2p_only_metadata = state.p2p_only_metadata;
                            }
                            this.settings.meta_sources = saved_meta_uris(&state.sources);
                            this.settings.seed_full_metadata = state.seed_full_metadata;
                            if !this.settings.private_routing {
                                this.settings.p2p_only_metadata = state.p2p_only_metadata;
                            }
                            if let Err(err) = this.settings.save() {
                                form.meta_error = Some(err.into());
                            } else {
                                form.meta_notice = Some("Metadata settings saved.".into());
                            }
                        }
                        Err(err) => {
                            form.meta_error = Some(err.into());
                            form.meta_notice = None;
                        }
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }
}
