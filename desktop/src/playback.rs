use std::sync::{Arc, LazyLock};
use std::time::Duration;

use oxideav_core::RuntimeContext;
use player::Track;

pub const SKIP: Duration = Duration::from_secs(10);
pub const FULLSCREEN_COOLDOWN: Duration = Duration::from_millis(550);

pub static CODECS: LazyLock<Arc<RuntimeContext>> = LazyLock::new(|| Arc::new(codecs::context()));

pub fn clock(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

pub use clock as format_clock;

pub fn track_label(t: &Track) -> String {
    let mut name = t
        .title
        .clone()
        .or_else(|| t.language.as_ref().map(|l| l.to_uppercase()))
        .unwrap_or_else(|| format!("Track {}", t.stream));
    if let (Some(_), Some(lang)) = (&t.title, &t.language) {
        name = format!("{name} ({})", lang.to_uppercase());
    }
    format!("{name} · {}", t.codec.to_uppercase())
}
