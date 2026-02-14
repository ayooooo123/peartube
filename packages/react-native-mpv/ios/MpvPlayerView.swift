import Foundation

#if canImport(UIKit) && canImport(React) && canImport(Libmpv)
import UIKit
import React

@objc(MpvPlayerView)
final class MpvPlayerView: UIView, MpvPlayerCoreDelegate {
  @objc var source: NSDictionary? {
    didSet { applySource() }
  }

  @objc var paused: Bool = true {
    didSet { applyPaused() }
  }

  @objc var rate: NSNumber = 1.0 {
    didSet { core?.setSpeed(rate.doubleValue) }
  }

  @objc var volume: NSNumber = 1.0 {
    didSet { core?.setVolume(volume.doubleValue) }
  }

  @objc var muted: Bool = false {
    didSet { core?.setMuted(muted) }
  }

  @objc var seek: NSNumber = -1 {
    didSet {
      let value = seek.doubleValue
      guard value >= 0 else { return }
      if value <= 1.0 {
        let target = (core?.duration ?? 0) * value
        core?.seek(to: target)
      } else {
        core?.seek(to: value)
      }
    }
  }

  @objc var resizeMode: NSString = "contain" {
    didSet { core?.setResizeMode(resizeMode as String) }
  }

  @objc var onLoad: RCTDirectEventBlock?
  @objc var onProgress: RCTDirectEventBlock?
  @objc var onPlaying: RCTDirectEventBlock?
  @objc var onPaused: RCTDirectEventBlock?
  @objc var onBuffering: RCTDirectEventBlock?
  @objc var onEnded: RCTDirectEventBlock?
  @objc var onError: RCTDirectEventBlock?
  @objc var onVideoStateChange: RCTDirectEventBlock?

  private var core: MpvPlayerCore?
  private var pendingSource: NSDictionary?
  private var progressTimer: Timer?
  private var didEmitLoad = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .black
    clipsToBounds = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if core == nil, bounds.width > 0, bounds.height > 0 {
      let playerCore = MpvPlayerCore()
      playerCore.delegate = self
      if playerCore.initialize(in: self) {
        core = playerCore
        startProgressTimer()
        if let pendingSource {
          source = pendingSource
          self.pendingSource = nil
        }
        applyPaused()
      } else {
        onError?(["target": 0, "message": "Failed to initialize MPV"])
      }
    } else {
      core?.updateFrame(bounds)
    }
  }

  @objc func play() {
    paused = false
    applyPaused()
  }

  @objc func pause() {
    paused = true
    applyPaused()
  }

  @objc func stop() {
    core?.stop()
    onPaused?(["target": 0])
  }

  @objc func seekToSeconds(_ seconds: NSNumber) {
    core?.seek(to: seconds.doubleValue)
  }

  private func applySource() {
    guard let source, let uri = source["uri"] as? String, !uri.isEmpty else { return }
    guard let core else {
      pendingSource = source
      return
    }

    didEmitLoad = false
    var headers: [String: String]? = nil
    if let sourceHeaders = source["headers"] as? [String: String] {
      headers = sourceHeaders
    }
    core.loadFile(uri, headers: headers)
    core.setSpeed(rate.doubleValue)
    core.setVolume(volume.doubleValue)
    core.setMuted(muted)
    core.setResizeMode(resizeMode as String)
    applyPaused()
  }

  private func applyPaused() {
    if paused {
      core?.pause()
      onPaused?(["target": 0])
    } else {
      core?.play()
      onPlaying?(["duration": (core?.duration ?? 0) * 1000.0, "seekable": (core?.duration ?? 0) > 0, "target": 0])
    }
  }

  func onPropertyChange(name: String, value: Any?) {
    switch name {
    case "time-pos":
      let current = (core?.currentTime ?? 0) * 1000.0
      let duration = (core?.duration ?? 0) * 1000.0
      onProgress?([
        "currentTime": current,
        "duration": duration,
        "position": duration > 0 ? current / duration : 0,
        "remainingTime": max(0, duration - current),
        "target": 0,
      ])
    case "paused-for-cache":
      let buffering = (value as? Bool) ?? false
      onBuffering?(["target": buffering ? 0 : 100])
    case "width", "height":
      let width = core?.videoWidth ?? 0
      let height = core?.videoHeight ?? 0
      if width > 0, height > 0 {
        onVideoStateChange?([
          "type": "onNewVideoLayout",
          "mVideoWidth": width,
          "mVideoHeight": height,
        ])
      }
    default:
      break
    }
  }

  func onEvent(name: String, data: [String : Any]?) {
    switch name {
    case "file-loaded":
      if !didEmitLoad {
        didEmitLoad = true
        let width = (data?["width"] as? Int) ?? core?.videoWidth ?? 0
        let height = (data?["height"] as? Int) ?? core?.videoHeight ?? 0
        let durationSec = (data?["duration"] as? Double) ?? core?.duration ?? 0
        onLoad?([
          "duration": durationSec * 1000.0,
          "videoSize": ["width": width, "height": height],
        ])
      }
    case "end-file":
      onEnded?(["target": 0])
    default:
      break
    }
  }

  private func startProgressTimer() {
    stopProgressTimer()
    progressTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      guard let self else { return }
      let current = (self.core?.currentTime ?? 0) * 1000.0
      let duration = (self.core?.duration ?? 0) * 1000.0
      self.onProgress?([
        "currentTime": current,
        "duration": duration,
        "position": duration > 0 ? current / duration : 0,
        "remainingTime": max(0, duration - current),
        "target": 0,
      ])
    }
  }

  private func stopProgressTimer() {
    progressTimer?.invalidate()
    progressTimer = nil
  }

  override func removeFromSuperview() {
    stopProgressTimer()
    core?.dispose()
    core = nil
    super.removeFromSuperview()
  }
}

#endif
