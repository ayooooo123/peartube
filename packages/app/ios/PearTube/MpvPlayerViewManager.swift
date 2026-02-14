import Foundation

import React
import UIKit

@objc(MpvPlayerViewManager)
final class MpvPlayerViewManager: RCTViewManager {
  override func view() -> UIView! {
    return MpvPlayerView()
  }

  override static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc func play(_ node: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.play()
    }
  }

  @objc func pause(_ node: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.pause()
    }
  }

  @objc func stop(_ node: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.stop()
    }
  }

  @objc func seekToSeconds(_ node: NSNumber, seconds: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.seekToSeconds(seconds)
    }
  }

  @objc func startPiP(_ node: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.startPiP()
    }
  }

  @objc func stopPiP(_ node: NSNumber) {
    DispatchQueue.main.async {
      guard let view = self.bridge.uiManager.view(forReactTag: node) as? MpvPlayerView else { return }
      view.stopPiP()
    }
  }
}
