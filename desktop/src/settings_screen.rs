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

use crate::app::{PearTube, Screen};
use crate::list::{column, format_bytes};
use crate::theme::{CARD, DANGER, DIM, LINE};

pub struct SettingsForm {
    tracker: Entity<InputState>,
    mnemonic: Entity<InputState>,
    sources: Entity<TextareaState>,
    relays: Entity<TextareaState>,
    bootstrap: Entity<TextareaState>,
    lan: bool,
    private_routing: bool,
    cache_max_gb: u32,
    advanced_open: bool,
    error: Option<SharedString>,
}

impl SettingsForm {
    pub fn set_cache_max_gb(&mut self, gb: u32) {
        self.cache_max_gb = gb;
    }

    pub fn new(settings: &Settings, window: &mut Window, cx: &mut Context<PearTube>) -> Self {
        let advanced_open = !settings.relay_through.is_empty() || !settings.bootstrap.is_empty() || settings.private_routing;
        SettingsForm {
            tracker: cx.new(|cx| InputState::new(window, cx).placeholder("Paste a 64-character channel key or peartube://channel/…").default_value(settings.tracker.clone())),
            mnemonic: cx.new(|cx| InputState::new(window, cx).placeholder("12-word recovery phrase to link your channel on this Mac…").default_value(settings.mnemonic.clone())),
            sources: cx.new(|cx| TextareaState::new(window, cx).rows(4).placeholder("One peartube://channel/… link per line").default_value(settings.format_sources())),
            relays: cx.new(|cx| TextareaState::new(window, cx).rows(2).default_value(settings.relay_through.join(", "))),
            bootstrap: cx.new(|cx| TextareaState::new(window, cx).rows(2).default_value(settings.bootstrap.join(", "))),
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

        let raw = json!({
            "tracker": tracker,
            "mnemonic": mnemonic,
            "sources": sources,
            "relayThrough": relay_through,
            "bootstrap": bootstrap,
            "lanDiscovery": lan_discovery,
            "privateRouting": private_routing,
            "cacheMaxGb": cache_max_gb,
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
}
