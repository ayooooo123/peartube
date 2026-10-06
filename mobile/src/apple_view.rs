//! The player's picture on macOS and iOS: a native view inside the webview,
//! kept over the page's video slot. The AppleBackend draws into it.

#[cfg(feature = "mobile")]
use dioxus::mobile as native;
#[cfg(not(feature = "mobile"))]
use dioxus::desktop as native;

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2::rc::Retained;
use player::AppleBackend;
use player::backend::Backend;
use std::sync::Arc;

#[cfg(target_os = "macos")]
use native::wry::WebViewExtMacOS as _;
#[cfg(target_os = "ios")]
use native::wry::WebViewExtIOS as _;

#[cfg(target_os = "macos")]
use objc2_app_kit::NSView as View;
#[cfg(target_os = "ios")]
use objc2_ui_kit::UIView as View;

pub struct AppleView {
    backend: Arc<AppleBackend>,
    view: Retained<View>,
    parent: Retained<View>,
}

impl AppleView {
    /// Adds an empty view to the webview; it gets a size from `set_frame`.
    pub fn open() -> Result<AppleView, String> {
        let mtm = MainThreadMarker::new().ok_or("The player runs on the main thread")?;
        let webview = native::window().webview.webview();
        let parent: Retained<View> = Retained::into_super(Retained::into_super(webview));
        let view = new_view(mtm);
        parent.addSubview(&view);
        let backend = AppleBackend::new();
        // SAFETY: `view` is a live view of the right class, kept alive by self.
        unsafe { backend.attach(Retained::as_ptr(&view) as *mut std::ffi::c_void) };
        Ok(AppleView { backend, view, parent })
    }

    pub fn backend(&self) -> Arc<dyn Backend> {
        self.backend.clone()
    }

    /// Moves the picture over a rect of the page, in CSS pixels from the
    /// webview's top left: [left, top, width, height].
    pub fn set_frame(&self, [left, top, width, height]: [f64; 4]) {
        #[cfg(target_os = "macos")]
        let top = if self.parent.isFlipped() { top } else { self.parent.bounds().size.height - top - height };
        set_view_frame(&self.view, left, top, width, height);
        self.backend.set_frame([0.0, 0.0, width, height]);
    }
}

impl Drop for AppleView {
    fn drop(&mut self) {
        self.backend.detach();
        self.view.removeFromSuperview();
    }
}

#[cfg(target_os = "macos")]
fn new_view(mtm: MainThreadMarker) -> Retained<View> {
    use objc2_foundation::NSRect;
    View::initWithFrame(View::alloc(mtm), NSRect::ZERO)
}

#[cfg(target_os = "ios")]
fn new_view(mtm: MainThreadMarker) -> Retained<View> {
    use objc2_core_foundation::CGRect;
    View::initWithFrame(View::alloc(mtm), CGRect::ZERO)
}

#[cfg(target_os = "macos")]
fn set_view_frame(view: &View, x: f64, y: f64, w: f64, h: f64) {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    view.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)));
}

#[cfg(target_os = "ios")]
fn set_view_frame(view: &View, x: f64, y: f64, w: f64, h: f64) {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    view.setFrame(CGRect::new(CGPoint::new(x, y), CGSize::new(w, h)));
}
