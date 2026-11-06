//! PearTube's Mac app without its UI: the Bare worklet that runs the relay's
//! P2P core on this machine, the settings it joins with, and the MIDI bank.
//! The GPUI window (src/main.rs) and test/desktop.e2e.js's smoke example both
//! drive it. Android has its own app in android/.

pub mod playback;
pub mod settings;
#[forbid(unsafe_code)]
pub mod soundfont;
pub mod worker;
