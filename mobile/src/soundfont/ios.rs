//! Import a user-selected document into the parent's private staging file.

#[cfg(feature = "mobile")]
use dioxus::mobile as native;
#[cfg(not(feature = "mobile"))]
use dioxus::desktop as native;

use futures_channel::oneshot;
use native::wry::WebViewExtIOS as _;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSURL};
use objc2_ui_kit::{
    UIAdaptivePresentationControllerDelegate, UIDocumentPickerDelegate,
    UIDocumentPickerViewController, UIModalPresentationStyle, UIPresentationController,
};
use objc2_uniform_type_identifiers::UTTypeData;
use std::cell::RefCell;
use std::path::PathBuf;

type Selection = Result<Option<PathBuf>, String>;

struct PickerState {
    completion: RefCell<Option<oneshot::Sender<Selection>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PearTubeSoundFontPickerDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = PickerState]
    struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    unsafe impl UIDocumentPickerDelegate for PickerDelegate {
        #[unsafe(method(documentPicker:didPickDocumentsAtURLs:))]
        fn selected(&self, _controller: &UIDocumentPickerViewController, urls: &NSArray<NSURL>) {
            let result = if urls.count() != 1 {
                Err("Select one SoundFont file".to_owned())
            } else {
                urls.firstObject()
                    .filter(|url| url.isFileURL())
                    .and_then(|url| url.to_file_path())
                    .map(Some)
                    .ok_or_else(|| "The document picker did not return a local file".to_owned())
            };
            self.finish(result);
        }

        #[unsafe(method(documentPickerWasCancelled:))]
        fn cancelled(&self, _controller: &UIDocumentPickerViewController) {
            self.finish(Ok(None));
        }
    }

    unsafe impl UIAdaptivePresentationControllerDelegate for PickerDelegate {
        #[unsafe(method(presentationControllerDidDismiss:))]
        fn dismissed(&self, _presentation: &UIPresentationController) {
            // Swiping away the sheet need not call documentPickerWasCancelled.
            self.finish(Ok(None));
        }
    }
);

impl PickerDelegate {
    fn new(mtm: MainThreadMarker, completion: oneshot::Sender<Selection>) -> Retained<Self> {
        let delegate = Self::alloc(mtm).set_ivars(PickerState {
            completion: RefCell::new(Some(completion)),
        });
        // SAFETY: NSObject's initializer is called once, after setting our ivars.
        unsafe { msg_send![super(delegate), init] }
    }

    fn finish(&self, result: Selection) {
        // Release the borrow before waking the task; UIKit may report both callbacks.
        let completion = self.ivars().completion.borrow_mut().take();
        if let Some(completion) = completion {
            let _ = completion.send(result);
        }
    }
}

struct Picker {
    controller: Retained<UIDocumentPickerViewController>,
    presentation: Retained<UIPresentationController>,
    // Both UIKit delegate properties are weak. The delegate holds no controller.
    _delegate: Retained<PickerDelegate>,
}

impl Drop for Picker {
    fn drop(&mut self) {
        self.controller.setDelegate(None);
        // SAFETY: The presentation and delegate are live on the main thread.
        unsafe { self.presentation.setDelegate(None) };
        // Also close the sheet if Dioxus drops this future while it is awaiting input.
        if self.controller.presentingViewController().is_some() && !self.controller.isBeingDismissed() {
            self.controller.dismissViewControllerAnimated_completion(false, None);
        }
    }
}

pub(super) async fn pick(destination: PathBuf, max_bytes: u64) -> Result<bool, String> {
    let mtm = MainThreadMarker::new().ok_or("The document picker must run on the main thread")?;
    // Use this webview's window, not UIApplication's key window from another scene.
    let webview = native::window().webview.webview();
    let presenter = webview.window()
        .and_then(|window| window.rootViewController())
        .ok_or("The document picker needs a visible app window")?;
    if presenter.viewIfLoaded().and_then(|view| view.window()).is_none() {
        return Err("The document picker needs a visible app window".to_owned());
    }
    if presenter.presentedViewController().is_some() || presenter.isBeingPresented() || presenter.isBeingDismissed() {
        return Err("Dismiss the current dialog before importing a SoundFont".to_owned());
    }

    // SAFETY: UTTypeData is an immutable framework constant, available since iOS 14;
    // the app's deployment target is iOS 16. The parent validates the actual SF2 bytes.
    let types = NSArray::from_slice(&[unsafe { UTTypeData }]);
    let controller = UIDocumentPickerViewController::initForOpeningContentTypes_asCopy(
        UIDocumentPickerViewController::alloc(mtm), &types, true,
    );
    controller.setAllowsMultipleSelection(false);
    controller.setShouldShowFileExtensions(true);
    controller.setModalPresentationStyle(UIModalPresentationStyle::FormSheet);
    let presentation = controller.presentationController()
        .ok_or("Could not create the document picker presentation")?;
    let (send, receive) = oneshot::channel();
    let delegate = PickerDelegate::new(mtm, send);
    controller.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // SAFETY: Our main-thread delegate implements the protocol and Picker retains it.
    unsafe { presentation.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    let picker = Picker { controller, presentation, _delegate: delegate };
    presenter.presentViewController_animated_completion(&picker.controller, true, None);
    if picker.controller.presentingViewController().is_none() {
        return Err("Could not present the document picker".to_owned());
    }

    let selected = receive.await.map_err(|_| "The document picker closed without a result".to_owned())??;
    let Some(source) = selected else { return Ok(false) };
    // asCopy imports into the app sandbox; Apple's import contract keeps this file
    // available until app termination, without security-scoped access or a bookmark.
    // Keep the picker/delegate alive through staging. Only the helper does file I/O,
    // on its worker thread with a bounded buffer and max_bytes checked before writes.
    super::stage_file(source, destination, max_bytes).await?;
    drop(picker);
    Ok(true)
}
