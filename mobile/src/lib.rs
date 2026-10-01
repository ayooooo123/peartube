//! PearTube's mobile app: a Dioxus UI over a Bare worklet that runs the relay's
//! P2P core on the device.

#[cfg(target_os = "android")]
pub mod android_vlc;
pub mod settings;
pub mod worker;
#[cfg(target_os = "macos")]
pub mod vlc;
