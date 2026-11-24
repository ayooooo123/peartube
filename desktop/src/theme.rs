//! Both apps' palette, mirroring design/tokens.json (dark side): the Mac, Android and TV
//! surfaces share one violet brand, one ink/dim pair, one green, and one radius language.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Hsla, px, rgb};

pub const BG: u32 = 0x08090c;
pub const CARD: u32 = 0x101218;
pub const CARD_ELEVATED: u32 = 0x171a22;
pub const LINE: u32 = 0x232733;
pub const INK: u32 = 0xf2f4f8;
pub const DIM: u32 = 0x98a0b3;
pub const BRAND: u32 = 0x9147ff;
pub const BRAND_HOVER: u32 = 0xa866ff;
pub const RING: u32 = 0xb98bff;
pub const ACCENT: u32 = 0x45d08a;
#[allow(dead_code)]
pub const WARN: u32 = 0xf5a623;
pub const DANGER: u32 = 0xff7d7d;
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
        theme.slider_thumb = color(0xffffff);
        theme.danger = color(DANGER);
        theme.font_size = px(15.);
        theme.radius = px(10.);
    });
}
