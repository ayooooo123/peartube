import Foundation

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import UIKit

/// A plain UIView container that hosts a HybridNitroVLCView player.
///
/// This replaces the Nitrogen-generated HybridNitroVLCViewComponent.mm which
/// used Fabric's ConcreteState/CachedProp/BorrowingReference and caused
/// SIGSEGV crashes when ShadowNodes were destroyed on background threads.
///
/// The container creates a HybridNitroVLCView on init, adds the player's
/// drawable view as a subview, and exposes a setViewId method for the
/// ObjC RCTViewManager to call via RCT_CUSTOM_VIEW_PROPERTY.
@objc(NitroVLCContainerView)
final class NitroVLCContainerView: UIView {
  let player: HybridNitroVLCView

  override init(frame: CGRect) {
    player = HybridNitroVLCView()
    super.init(frame: frame)
    setupPlayerView()
  }

  required init?(coder: NSCoder) {
    player = HybridNitroVLCView()
    super.init(coder: coder)
    setupPlayerView()
  }

  private func setupPlayerView() {
    addSubview(player.view)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Frame-based layout is more reliable with React Native than auto-layout.
    // RN sets our frame directly via Yoga; this ensures the player view
    // always matches, and VLC re-reads the drawable bounds on each layout.
    player.view.frame = bounds
  }

  @objc func setViewId(_ viewId: String) {
    player.viewId = viewId
  }

  override func removeFromSuperview() {
    player.dispose()
    super.removeFromSuperview()
  }
}
#endif
