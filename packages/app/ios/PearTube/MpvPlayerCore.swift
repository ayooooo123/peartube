import Foundation
import UIKit
import QuartzCore
import CoreMedia
import AVFoundation
import MPVKit

protocol MpvPlayerCoreDelegate: AnyObject {
  func onPropertyChange(name: String, value: Any?)
  func onEvent(name: String, data: [String: Any]?)
}

final class MpvPlayerCore: NSObject {
  weak var delegate: MpvPlayerCoreDelegate?
  weak var pipDelegate: MpvPipControllerDelegate? {
    didSet {
      if #available(iOS 15.0, *) {
        pipController?.delegate = pipDelegate
      } else {
        pipControllerStub?.delegate = pipDelegate
      }
    }
  }

  private var mpv: OpaquePointer?
  private var displayLayer: AVSampleBufferDisplayLayer?
  private var containerView: UIView?
  private weak var parentView: UIView?
  private let queue = DispatchQueue(label: "to.holepunch.peartube.mpv.events", qos: .userInitiated)
  private var disposing = false
  private var recentLogLines: [String] = []
  private var displayLayerObservation: NSKeyValueObservation?
  private var isPaused = true

  @available(iOS 15.0, *)
  private var pipController: MpvPipController? {
    get { _pipStorage as? MpvPipController }
    set { _pipStorage = newValue }
  }
  private var pipControllerStub: MpvPipControllerStub?
  private var _pipStorage: AnyObject?

  private(set) var duration: Double = 0
  private(set) var currentTime: Double = 0
  private(set) var videoWidth: Int = 0
  private(set) var videoHeight: Int = 0

  func initialize(in view: UIView) -> Bool {
    if mpv != nil { return true }
    parentView = view

    let container = UIView(frame: view.bounds)
    container.backgroundColor = .clear
    container.isUserInteractionEnabled = false
    container.autoresizingMask = [.flexibleWidth, .flexibleHeight]

    let layer = AVSampleBufferDisplayLayer()
    layer.frame = container.bounds
    layer.videoGravity = .resizeAspect
    layer.backgroundColor = UIColor.black.cgColor

    container.layer.addSublayer(layer)
    view.insertSubview(container, at: 0)
    containerView = container
    displayLayer = layer

    displayLayerObservation = layer.observe(\.status, options: [.new]) { [weak self] observedLayer, _ in
      if observedLayer.status == .failed {
        observedLayer.flush()
        self?.resetDecoder()
      }
    }

    guard let handle = mpv_create() else {
      print("[MpvIOSCore] mpv_create failed")
      container.removeFromSuperview()
      containerView = nil
      displayLayer = nil
      return false
    }
    mpv = handle

    #if targetEnvironment(simulator)
    _ = mpv_set_option_string(handle, "vo", "null")
    _ = mpv_set_option_string(handle, "hwdec", "no")
    #else
    let layerPtr = Int64(Int(bitPattern: Unmanaged.passUnretained(layer).toOpaque()))
    var widValue = layerPtr
    _ = mpv_set_option(handle, "wid", MPV_FORMAT_INT64, &widValue)
    _ = mpv_set_option_string(handle, "vo", "avfoundation")
    _ = mpv_set_option_string(handle, "hwdec", "videotoolbox")
    _ = mpv_set_option_string(handle, "hwdec-software-fallback", "yes")
    #endif

    _ = mpv_set_option_string(handle, "cache", "yes")
    _ = mpv_set_option_string(handle, "cache-secs", "120")
    _ = mpv_set_option_string(handle, "demuxer-max-bytes", "150MiB")
    _ = mpv_set_option_string(handle, "demuxer-max-back-bytes", "75MiB")
    _ = mpv_set_option_string(handle, "network-timeout", "60")
    _ = mpv_set_option_string(handle, "http-reconnect", "yes")
    _ = mpv_set_option_string(handle, "stream-reconnect", "yes")
    _ = mpv_set_option_string(handle, "vd-lavc-o", "strict=-2")

    if mpv_initialize(handle) < 0 {
      print("[MpvIOSCore] mpv_initialize failed")
      mpv_terminate_destroy(handle)
      mpv = nil
      container.removeFromSuperview()
      containerView = nil
      displayLayer = nil
      return false
    }
    MpvHttpStreamBridge.register(mpv: handle)

    #if DEBUG
    _ = mpv_request_log_messages(handle, "debug")
    _ = mpv_set_option_string(handle, "msg-level", "ffmpeg=debug,demux=debug,network=debug")
    #else
    _ = mpv_request_log_messages(handle, "warn")
    #endif

    let opaque = Unmanaged.passUnretained(self).toOpaque()
    mpv_set_wakeup_callback(handle, { context in
      guard let context else { return }
      let core = Unmanaged<MpvPlayerCore>.fromOpaque(context).takeUnretainedValue()
      core.readEvents()
    }, opaque)

    mpv_observe_property(handle, 0, "time-pos", MPV_FORMAT_DOUBLE)
    mpv_observe_property(handle, 0, "duration", MPV_FORMAT_DOUBLE)
    mpv_observe_property(handle, 0, "pause", MPV_FORMAT_FLAG)
    mpv_observe_property(handle, 0, "paused-for-cache", MPV_FORMAT_FLAG)
    mpv_observe_property(handle, 0, "width", MPV_FORMAT_INT64)
    mpv_observe_property(handle, 0, "height", MPV_FORMAT_INT64)

    setupPip(in: container, displayLayer: layer)
    return true
  }

  private func setupPip(in containerView: UIView, displayLayer: AVSampleBufferDisplayLayer) {
    if #available(iOS 15.0, *) {
      let pip = MpvPipController()
      pip.delegate = pipDelegate
      pip.isPlaybackPaused = { [weak self] in
        guard let self, let mpv = self.mpv else { return true }
        var flag: Int32 = 0
        mpv_get_property(mpv, "pause", MPV_FORMAT_FLAG, &flag)
        return flag != 0
      }
      pip.setPlaying = { [weak self] playing in
        guard let self else { return }
        if playing { self.play() } else { self.pause() }
      }
      pip.skipByInterval = { [weak self] seconds, completion in
        guard let self else { completion(); return }
        self.command(["seek", "\(seconds)", "relative"])
        completion()
      }
      pip.currentTimeRange = { [weak self] in
        guard let self else {
          return CMTimeRange(start: .zero, duration: CMTime(seconds: 3600, preferredTimescale: 1))
        }
        let dur = self.duration > 0 ? self.duration : 3600
        return CMTimeRange(
          start: CMTime(seconds: self.currentTime, preferredTimescale: 1000),
          duration: CMTime(seconds: dur, preferredTimescale: 1000)
        )
      }
      pip.setup(sourceView: containerView, displayLayer: displayLayer)
      pipController = pip
    } else {
      let stub = MpvPipControllerStub()
      stub.delegate = pipDelegate
      pipControllerStub = stub
    }
  }

  func setPipEnabled(_ enabled: Bool) {
    if #available(iOS 15.0, *) {
      pipController?.setEnabled(enabled)
    }
  }

  func startPip() {
    if #available(iOS 15.0, *) {
      pipController?.startPiP()
    }
  }

  func stopPip() {
    if #available(iOS 15.0, *) {
      pipController?.stopPiP()
    }
  }

  func loadFile(_ url: String, headers: [String: String]?) {
    guard let mpv else { return }
    recentLogLines.removeAll(keepingCapacity: true)
    if let headers, !headers.isEmpty {
      let all = headers.map { "\($0.key): \($0.value)" }.joined(separator: "\r\n")
      _ = mpv_set_option_string(mpv, "http-header-fields", all)
    } else {
      _ = mpv_set_option_string(mpv, "http-header-fields", "")
    }
    let status = command(["loadfile", url, "replace"])
    if status < 0 {
      let message = String(cString: mpv_error_string(status))
      print("[MpvIOSCore] loadfile command failed: \(status) \(message)")
      delegate?.onEvent(name: "end-file", data: [
        "reason": "error",
        "reasonCode": Int(MPV_END_FILE_REASON_ERROR.rawValue),
        "errorCode": Int(status),
        "errorMessage": message,
        "recentLogs": recentLogLines,
      ])
    }
  }

  func play() { _ = mpv_set_property_string(mpv, "pause", "no") }
  func pause() { _ = mpv_set_property_string(mpv, "pause", "yes") }
  func stop() { command(["stop"]) }
  func seek(to seconds: Double) { command(["seek", "\(seconds)", "absolute"]) }
  func setSpeed(_ speed: Double) { _ = mpv_set_property_string(mpv, "speed", "\(speed)") }
  func setVolume(_ volume: Double) { _ = mpv_set_property_string(mpv, "volume", "\(Int(max(0, min(100, volume * 100.0))))") }
  func setMuted(_ muted: Bool) { _ = mpv_set_property_string(mpv, "mute", muted ? "yes" : "no") }

  func setResizeMode(_ mode: String) {
    switch mode {
    case "cover":
      _ = mpv_set_property_string(mpv, "keepaspect", "yes")
      _ = mpv_set_property_string(mpv, "panscan", "1.0")
    case "stretch":
      _ = mpv_set_property_string(mpv, "keepaspect", "no")
      _ = mpv_set_property_string(mpv, "panscan", "0.0")
    default:
      _ = mpv_set_property_string(mpv, "keepaspect", "yes")
      _ = mpv_set_property_string(mpv, "panscan", "0.0")
    }
  }

  /// Reset hardware decoder — iOS kills VideoToolbox sessions when
  /// backgrounding or transitioning PiP, causing black frames.
  /// Toggling hwdec forces mpv to recreate the decoder session.
  func resetDecoder() {
    guard let mpv, !disposing else { return }
    queue.async { [weak self] in
      guard let self, let mpv = self.mpv, !self.disposing else { return }
      mpv_set_property_string(mpv, "hwdec", "no")
      mpv_set_property_string(mpv, "hwdec", "videotoolbox")
    }
  }

  func updateFrame(_ frame: CGRect?) {
    guard let container = containerView, let layer = displayLayer else { return }
    if let frame {
      container.frame = frame
      layer.frame = container.bounds
    } else if let parent = parentView {
      container.frame = parent.bounds
      layer.frame = container.bounds
    }
  }

  func dispose() {
    disposing = true
    displayLayerObservation?.invalidate()
    displayLayerObservation = nil
    if #available(iOS 15.0, *) {
      pipController?.teardown()
      pipController = nil
    }
    pipControllerStub = nil
    let handle = mpv
    mpv = nil
    if let handle {
      mpv_set_wakeup_callback(handle, nil, nil)
      queue.async {
        mpv_terminate_destroy(handle)
      }
    }
    displayLayer?.removeFromSuperlayer()
    displayLayer = nil
    containerView?.removeFromSuperview()
    containerView = nil
  }

  @discardableResult
  private func command(_ args: [String]) -> CInt {
    guard let mpv else { return -1 }
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
    cargs.append(nil)
    defer { cargs.forEach { free($0) } }
    let status: CInt = cargs.withUnsafeBufferPointer { buffer in
      var constPtrs = buffer.map { $0.map { UnsafePointer<CChar>($0) } }
      return mpv_command(mpv, &constPtrs)
    }
    if status < 0 {
      let message = String(cString: mpv_error_string(status))
      print("[MpvIOSCore] command failed: \(args.joined(separator: " ")) -> \(status) \(message)")
    }
    return status
  }

  private func readEvents() {
    queue.async { [weak self] in
      guard let self, let mpv = self.mpv, !self.disposing else { return }
      while true {
        guard let event = mpv_wait_event(mpv, 0) else { break }
        let e = event.pointee
        if e.event_id == MPV_EVENT_NONE { break }
        self.handleEvent(e)
      }
    }
  }

  private func handleEvent(_ event: mpv_event) {
    switch event.event_id {
    case MPV_EVENT_FILE_LOADED:
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if #available(iOS 15.0, *) {
          self.pipController?.updatePlaybackState(currentTime: 0, playing: !self.isPaused)
        }
        self.delegate?.onEvent(name: "file-loaded", data: [
          "duration": self.duration,
          "width": self.videoWidth,
          "height": self.videoHeight,
        ])
      }
    case MPV_EVENT_END_FILE:
      var payload: [String: Any] = [:]
      if let data = event.data {
        let endData = data.assumingMemoryBound(to: mpv_event_end_file.self).pointee
        payload["reason"] = mapEndFileReason(endData.reason)
        payload["reasonCode"] = Int(endData.reason.rawValue)
        payload["errorCode"] = Int(endData.error)
        if endData.error < 0 {
          payload["errorMessage"] = String(cString: mpv_error_string(endData.error))
        }
      }
      if !recentLogLines.isEmpty {
        payload["recentLogs"] = recentLogLines
      }
      DispatchQueue.main.async { [weak self] in
        self?.delegate?.onEvent(name: "end-file", data: payload)
      }
    case MPV_EVENT_PROPERTY_CHANGE:
      guard let data = event.data else { return }
      let property = data.assumingMemoryBound(to: mpv_event_property.self).pointee
      let name = String(cString: property.name)
      let value = decodeProperty(property)
      switch name {
      case "time-pos":
        if let v = value as? Double { currentTime = v }
      case "duration":
        if let v = value as? Double { duration = v }
      case "pause":
        let paused = (value as? Bool) ?? true
        isPaused = paused
        if #available(iOS 15.0, *) {
          pipController?.updatePlaybackState(currentTime: currentTime, playing: !paused)
        }
      case "width":
        if let v = value as? Int64 {
          videoWidth = Int(v)
          if #available(iOS 15.0, *) { pipController?.setVideoDimensions(width: videoWidth, height: videoHeight) }
        }
      case "height":
        if let v = value as? Int64 {
          videoHeight = Int(v)
          if #available(iOS 15.0, *) { pipController?.setVideoDimensions(width: videoWidth, height: videoHeight) }
        }
      default:
        break
      }
      DispatchQueue.main.async { [weak self] in
        self?.delegate?.onPropertyChange(name: name, value: value)
      }
    case MPV_EVENT_LOG_MESSAGE:
      guard let data = event.data else { return }
      let message = data.assumingMemoryBound(to: mpv_event_log_message.self).pointee
      let prefix = message.prefix.map { String(cString: $0) } ?? ""
      let level = message.level.map { String(cString: $0) } ?? ""
      let text = message.text.map { String(cString: $0) } ?? ""
      let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !normalizedText.isEmpty {
        let line = "[\(level)] \(prefix)\(normalizedText)"
        recentLogLines.append(line)
        if recentLogLines.count > 12 {
          recentLogLines.removeFirst(recentLogLines.count - 12)
        }
      }
      DispatchQueue.main.async { [weak self] in
        self?.delegate?.onEvent(name: "log-message", data: [
          "prefix": prefix,
          "level": level,
          "text": normalizedText,
        ])
      }
    default:
      break
    }
  }

  private func mapEndFileReason(_ reason: mpv_end_file_reason) -> String {
    switch reason {
    case MPV_END_FILE_REASON_EOF:
      return "eof"
    case MPV_END_FILE_REASON_STOP:
      return "stop"
    case MPV_END_FILE_REASON_QUIT:
      return "quit"
    case MPV_END_FILE_REASON_ERROR:
      return "error"
    case MPV_END_FILE_REASON_REDIRECT:
      return "redirect"
    default:
      return "unknown"
    }
  }

  private func decodeProperty(_ property: mpv_event_property) -> Any? {
    guard let data = property.data else { return nil }
    switch property.format {
    case MPV_FORMAT_DOUBLE:
      return data.assumingMemoryBound(to: Double.self).pointee
    case MPV_FORMAT_FLAG:
      return data.assumingMemoryBound(to: Int32.self).pointee != 0
    case MPV_FORMAT_INT64:
      return data.assumingMemoryBound(to: Int64.self).pointee
    default:
      return nil
    }
  }
}
