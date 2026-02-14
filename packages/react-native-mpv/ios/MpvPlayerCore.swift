import Foundation

#if canImport(UIKit) && canImport(Libmpv)
import UIKit
import QuartzCore
import Libmpv

protocol MpvPlayerCoreDelegate: AnyObject {
  func onPropertyChange(name: String, value: Any?)
  func onEvent(name: String, data: [String: Any]?)
}

private final class MpvMetalLayer: CAMetalLayer {
  override var drawableSize: CGSize {
    get { super.drawableSize }
    set {
      if Int(newValue.width) > 1 && Int(newValue.height) > 1 {
        super.drawableSize = newValue
      }
    }
  }
}

final class MpvPlayerCore: NSObject {
  weak var delegate: MpvPlayerCoreDelegate?

  private var mpv: OpaquePointer?
  private var metalLayer: MpvMetalLayer?
  private var containerView: UIView?
  private weak var parentView: UIView?
  private let queue = DispatchQueue(label: "to.holepunch.peartube.mpv.events", qos: .userInitiated)
  private var disposing = false

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

    let layer = MpvMetalLayer()
    layer.frame = container.bounds
    layer.contentsScale = UIScreen.main.nativeScale
    layer.framebufferOnly = true
    layer.backgroundColor = UIColor.black.cgColor
    let scale = UIScreen.main.nativeScale
    layer.drawableSize = CGSize(width: max(1, container.bounds.width * scale), height: max(1, container.bounds.height * scale))

    container.layer.addSublayer(layer)
    view.insertSubview(container, at: 0)
    containerView = container
    metalLayer = layer

    guard let handle = mpv_create() else {
      container.removeFromSuperview()
      containerView = nil
      metalLayer = nil
      return false
    }
    mpv = handle

    var wid = layer
    _ = mpv_set_option(handle, "wid", MPV_FORMAT_INT64, &wid)
    _ = mpv_set_option_string(handle, "vo", "gpu-next")
    _ = mpv_set_option_string(handle, "gpu-api", "vulkan")
    _ = mpv_set_option_string(handle, "gpu-context", "moltenvk")
    _ = mpv_set_option_string(handle, "hwdec", "videotoolbox")
    _ = mpv_set_option_string(handle, "target-colorspace-hint", "yes")
    _ = mpv_set_option_string(handle, "cache", "yes")
    _ = mpv_set_option_string(handle, "cache-secs", "30")
    _ = mpv_set_option_string(handle, "force-seekable", "yes")
    _ = mpv_set_option_string(handle, "http-reconnect", "yes")
    _ = mpv_set_option_string(handle, "stream-reconnect", "yes")
    _ = mpv_set_option_string(handle, "vd-lavc-o", "strict=-2")

    if mpv_initialize(handle) < 0 {
      mpv_terminate_destroy(handle)
      mpv = nil
      container.removeFromSuperview()
      containerView = nil
      metalLayer = nil
      return false
    }

    let opaque = Unmanaged.passUnretained(self).toOpaque()
    mpv_set_wakeup_callback(handle, { context in
      guard let context else { return }
      let core = Unmanaged<MpvPlayerCore>.fromOpaque(context).takeUnretainedValue()
      core.readEvents()
    }, opaque)

    mpv_observe_property(handle, 0, "time-pos", MPV_FORMAT_DOUBLE)
    mpv_observe_property(handle, 0, "duration", MPV_FORMAT_DOUBLE)
    mpv_observe_property(handle, 0, "paused-for-cache", MPV_FORMAT_FLAG)
    mpv_observe_property(handle, 0, "width", MPV_FORMAT_INT64)
    mpv_observe_property(handle, 0, "height", MPV_FORMAT_INT64)
    return true
  }

  func loadFile(_ url: String, headers: [String: String]?) {
    guard let mpv else { return }
    if let headers, !headers.isEmpty {
      let all = headers.map { "\($0.key): \($0.value)" }.joined(separator: "\r\n")
      _ = mpv_set_option_string(mpv, "http-header-fields", all)
    }
    command(["loadfile", url])
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

  func updateFrame(_ frame: CGRect?) {
    guard let container = containerView, let layer = metalLayer else { return }
    if let frame {
      container.frame = frame
      layer.frame = container.bounds
    } else if let parent = parentView {
      container.frame = parent.bounds
      layer.frame = container.bounds
    }
    let scale = UIScreen.main.nativeScale
    layer.drawableSize = CGSize(width: max(1, layer.frame.width * scale), height: max(1, layer.frame.height * scale))
  }

  func dispose() {
    disposing = true
    let handle = mpv
    mpv = nil
    if let handle {
      mpv_set_wakeup_callback(handle, nil, nil)
      mpv_terminate_destroy(handle)
    }
    metalLayer?.removeFromSuperlayer()
    metalLayer = nil
    containerView?.removeFromSuperview()
    containerView = nil
  }

  private func command(_ args: [String]) {
    guard let mpv else { return }
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
    cargs.append(nil)
    defer { cargs.forEach { free($0) } }
    cargs.withUnsafeMutableBufferPointer { buffer in
      _ = mpv_command(mpv, buffer.baseAddress)
    }
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
        self.delegate?.onEvent(name: "file-loaded", data: [
          "duration": self.duration,
          "width": self.videoWidth,
          "height": self.videoHeight,
        ])
      }
    case MPV_EVENT_END_FILE:
      DispatchQueue.main.async { [weak self] in
        self?.delegate?.onEvent(name: "end-file", data: nil)
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
      case "width":
        if let v = value as? Int64 { videoWidth = Int(v) }
      case "height":
        if let v = value as? Int64 { videoHeight = Int(v) }
      default:
        break
      }
      DispatchQueue.main.async { [weak self] in
        self?.delegate?.onPropertyChange(name: name, value: value)
      }
    default:
      break
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

#endif
