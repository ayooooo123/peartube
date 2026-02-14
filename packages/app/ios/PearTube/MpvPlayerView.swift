import Foundation

import UIKit
import React

@objc(MpvPlayerView)
final class MpvPlayerView: UIView, MpvPlayerCoreDelegate, MpvPipControllerDelegate {
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

  @objc var pipEnabled: Bool = false {
    didSet { core?.setPipEnabled(pipEnabled) }
  }

  @objc var onLoad: RCTDirectEventBlock?
  @objc var onProgress: RCTDirectEventBlock?
  @objc var onPlaying: RCTDirectEventBlock?
  @objc var onPaused: RCTDirectEventBlock?
  @objc var onBuffering: RCTDirectEventBlock?
  @objc var onEnded: RCTDirectEventBlock?
  @objc var onError: RCTDirectEventBlock?
  @objc var onVideoStateChange: RCTDirectEventBlock?
  @objc var onPictureInPictureChanged: RCTDirectEventBlock?

  private var core: MpvPlayerCore?
  private var pendingSource: NSDictionary?
  private var progressTimer: Timer?
  private var didEmitLoad = false
  private var lastPreflight: [String: Any] = [:]
  private var lastSourceUri: String?
  private var lastSourceHeaders: [String: String]?
  private var loadRetryCount = 0
  private var foregroundObserver: NSObjectProtocol?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
    observeForeground()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .black
    clipsToBounds = true
    observeForeground()
  }

  private func observeForeground() {
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.core?.resetDecoder()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if core == nil, bounds.width > 0, bounds.height > 0 {
      let playerCore = MpvPlayerCore()
      playerCore.delegate = self
      playerCore.pipDelegate = self
      if playerCore.initialize(in: self) {
        core = playerCore
        playerCore.setPipEnabled(pipEnabled)
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
  }

  @objc func seekToSeconds(_ seconds: NSNumber) {
    core?.seek(to: seconds.doubleValue)
  }

  @objc func startPiP() {
    core?.startPip()
  }

  @objc func stopPiP() {
    core?.stopPip()
  }

  func pipStateChanged(isInPip: Bool, width: CGFloat, height: CGFloat) {
    onPictureInPictureChanged?([
      "isInPictureInPicture": isInPip,
      "width": width,
      "height": height,
    ])
  }

  private func applySource() {
    guard let source, let uri = source["uri"] as? String, !uri.isEmpty else { return }
    let normalizedUri = normalizeLoopbackURL(uri)
    var sourceHeaders: [String: String]? = nil
    if let headers = source["headers"] as? [String: String] {
      sourceHeaders = headers
    }
    lastSourceUri = normalizedUri
    lastSourceHeaders = sourceHeaders
    loadRetryCount = 0
    preflightSourceURL(normalizedUri, headers: sourceHeaders)
    guard let core else {
      pendingSource = source
      return
    }

    didEmitLoad = false
    core.loadFile(normalizedUri, headers: sourceHeaders)
    core.setSpeed(rate.doubleValue)
    core.setVolume(volume.doubleValue)
    core.setMuted(muted)
    core.setResizeMode(resizeMode as String)
    applyPaused()
  }

  private func normalizeLoopbackURL(_ raw: String) -> String {
    guard var components = URLComponents(string: raw) else { return raw }
    if components.host == "localhost" || components.host == "::1" {
      components.host = "127.0.0.1"
      return components.string ?? raw
    }
    return raw
  }

  private func preflightSourceURL(_ rawURL: String, headers: [String: String]?) {
    guard let url = URL(string: rawURL) else {
      print("[MpvIOSView] preflight invalid url")
      lastPreflight = ["ok": false, "error": "invalid_url"]
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 5
    request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
    headers?.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
    URLSession.shared.dataTask(with: request) { _, response, error in
      if let error {
        print("[MpvIOSView] preflight error=\(error.localizedDescription)")
        self.lastPreflight = ["ok": false, "error": error.localizedDescription]
        return
      }
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? -1
      let contentType = http?.value(forHTTPHeaderField: "Content-Type") ?? ""
      let acceptRanges = http?.value(forHTTPHeaderField: "Accept-Ranges") ?? ""
      let contentRange = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
      self.lastPreflight = [
        "ok": (200...299).contains(status) || status == 206,
        "status": status,
        "contentType": contentType,
        "acceptRanges": acceptRanges,
        "contentRange": contentRange,
      ]
    }.resume()
  }

  private func intValue(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return n.intValue }
    if let s = value as? String { return Int(s) }
    return nil
  }

  private func applyPaused() {
    if paused { core?.pause() } else { core?.play() }
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
    case "pause":
      guard didEmitLoad else { break }
      let isPaused = (value as? Bool) ?? paused
      if isPaused {
        onPaused?(["target": 0])
      } else {
        onPlaying?(["duration": (core?.duration ?? 0) * 1000.0, "seekable": (core?.duration ?? 0) > 0, "target": 0])
      }
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
        if !paused {
          onPlaying?(["duration": durationSec * 1000.0, "seekable": durationSec > 0, "target": 0])
        }
      }
    case "end-file":
      let reason = (data?["reason"] as? String) ?? "unknown"
      if reason == "eof" || reason == "stop" || reason == "quit" {
        onEnded?(["target": 0])
      } else {
        let errorCode = intValue(data?["errorCode"]) ?? -1
        if errorCode == -13, loadRetryCount < 1, let retryUri = lastSourceUri {
          loadRetryCount += 1
          print("[MpvIOSView] retrying load after error -13, attempt=\(loadRetryCount)")
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, let core = self.core else { return }
            self.preflightSourceURL(retryUri, headers: self.lastSourceHeaders)
            core.loadFile(retryUri, headers: self.lastSourceHeaders)
            self.applyPaused()
          }
          break
        }
        let recentLogs = data?["recentLogs"] as? [String] ?? []
        if !recentLogs.isEmpty {
          print("[MpvIOSView] recent mpv logs before error: \(recentLogs.joined(separator: " | "))")
        }
        onError?([
          "target": 0,
          "message": (data?["errorMessage"] as? String) ?? "MPV end-file error",
          "reason": reason,
          "reasonCode": data?["reasonCode"] ?? -1,
          "errorCode": data?["errorCode"] ?? -1,
          "recentLogs": recentLogs,
          "preflight": lastPreflight,
        ])
      }
    case "log-message":
      let level = (data?["level"] as? String) ?? ""
      let text = ((data?["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !text.isEmpty && (level == "error" || level == "fatal") {
        print("[MpvIOSLog][\(level)] \(text)")
      }
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
    if let observer = foregroundObserver {
      NotificationCenter.default.removeObserver(observer)
      foregroundObserver = nil
    }
    stopProgressTimer()
    core?.dispose()
    core = nil
    super.removeFromSuperview()
  }
}
