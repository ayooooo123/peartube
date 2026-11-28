//! LUMEN Obsidian & Pearl palette, shared across desktop surfaces: deep obsidian
//! grounds, warm pearl highlights, luminous violet accent, and refined 12px radii.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, hsla, px, rgb};

pub const BG: u32 = 0x06070a;
pub const CARD: u32 = 0x0e1017;
pub const CARD_ELEVATED: u32 = 0x161923;
pub const LINE: u32 = 0x222634;
pub const INK: u32 = 0xf4f5f7;
pub const DIM: u32 = 0x959cb0;
pub const PEARL: u32 = 0xeae6dd;
pub const BRAND: u32 = 0x9b7bff;
pub const BRAND_HOVER: u32 = 0xb096ff;
pub const RING: u32 = 0xc2adff;
pub const ACCENT: u32 = 0x45d08a;
#[allow(dead_code)]
pub const WARN: u32 = 0xe8b45c;
pub const DANGER: u32 = 0xff7d7d;

/// Subtle translucent glass surface fill and hairline border for floating LUMEN pills & popovers.
pub const GLASS_BG: Hsla = Hsla { h: 228.0 / 360.0, s: 0.24, l: 0.14, a: 0.72 };
pub const GLASS_BORDER: Hsla = Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.10 };

#[allow(dead_code)]
pub fn glass_pill_bg() -> Hsla {
    hsla(0., 0., 1., 0.06)
}

pub fn apply(cx: &mut App) {
    Theme::change(ThemeMode::Dark, None, cx);
    Theme::update(cx, |theme| {
        let color = |hex: u32| -> Hsla { rgb(hex).into() };
        theme.background = color(BG);
        theme.foreground = color(INK);
        theme.muted_foreground = color(DIM);
        theme.border = color(LINE);
        theme.input = color(LINE);
        theme.popover = color(CARD_ELEVATED);
        let brand = color(BRAND);
        theme.primary = brand;
        theme.primary_foreground = color(0xffffff);
        theme.button_primary = brand;
        theme.button_primary_hover = color(BRAND_HOVER);
        theme.button_primary_active = brand;
        theme.button_primary_foreground = color(0xffffff);
        theme.ring = color(RING);
        theme.caret = brand;
        theme.selection = brand.opacity(0.35);
        theme.slider_bar = brand;
        theme.slider_thumb = color(PEARL);
        theme.danger = color(DANGER);
        theme.font_size = px(15.);
        theme.radius = px(12.);
    });
}
