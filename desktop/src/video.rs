//! The player's picture: a safe macOS window slot under GPUI's view, backed by
//! `player::AppleWindowSlot` (an AVSampleBufferDisplayLayer and the subtitle
//! layer). While a video plays the window is transparent, and the play
//! screen paints nothing over its video slot, so the picture shows through and
//! the controls draw over it.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use gpui_kit::Window;
use player::AppleWindowSlot;
use player::backend::Backend;

pub struct VideoView {
    slot: AppleWindowSlot,
}

impl VideoView {
    /// Returns macOS AppKit's configured double-click interval plus scheduling slack.
    pub fn double_click_interval() -> Duration {
        AppleWindowSlot::double_click_interval()
    }

    /// Adds an empty view below `window`'s GPUI view; `set_frame` places it.
    pub fn open(window: &Window) -> Result<VideoView, String> {
        Ok(VideoView {
            slot: AppleWindowSlot::open(window)?,
        })
    }

    pub fn backend(&self) -> Arc<dyn Backend> {
        self.slot.backend()
    }

    /// Puts the picture over a rect of the window's content, in points from
    /// its top left: `[left, top, width, height]`.
    pub fn set_frame(&self, rect: [f64; 4]) {
        self.slot.set_frame(rect);
    }

    #[allow(dead_code)]
    pub fn metrics(&self) -> Option<player::WindowSlotMetrics> {
        self.slot.metrics()
    }
}
