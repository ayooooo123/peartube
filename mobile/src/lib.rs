//! PearTube's mobile app: a Dioxus UI over a Bare worklet that runs the relay's
//! P2P core on the device.

#[cfg(target_os = "android")]
pub mod android_player;
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple_view;
pub mod player;
pub mod settings;
pub mod soundfont;
pub mod worker;
