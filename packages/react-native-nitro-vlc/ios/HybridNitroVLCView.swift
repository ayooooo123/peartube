import Foundation

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import MobileVLCKit
import UIKit

private class VLCDelegateHelper: NSObject, VLCMediaPlayerDelegate, VLCCustomDialogRendererProtocol {
  weak var owner: HybridNitroVLCView?

  func mediaPlayerStateChanged(_ aNotification: Notification) {
    owner?.handleStateChanged()
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    owner?.handleTimeChanged()
  }

  func showError(withTitle error: String, message: String) {
    owner?.handleError()
  }

  func showLogin(withTitle title: String, message: String, defaultUsername: String?, askingForStorage: Bool, withReference reference: NSValue) {
    owner?.handleLoginDialog(reference: reference)
  }

  func showQuestion(withTitle title: String, message: String, type questionType: VLCDialogQuestionType, cancel cancelString: String?, action1String: String?, action2String: String?, withReference reference: NSValue) {
    owner?.handleQuestionDialog(title: title, message: message, reference: reference)
  }

  func showProgress(withTitle title: String, message: String, isIndeterminate: Bool, position: Float, cancel cancelString: String?, withReference reference: NSValue) {
    owner?.handleProgressDialog(reference: reference)
  }

  func updateProgress(withReference reference: NSValue, message: String?, position: Float) {}

  func cancelDialog(withReference reference: NSValue) {}
}

final class HybridNitroVLCView: HybridNitroVLCViewSpec {
  // MARK: - Static View Registry
  private static let registryLock = NSLock()
  private static let registry = NSMapTable<NSString, HybridNitroVLCView>(
    keyOptions: .copyIn,
    valueOptions: .weakMemory
  )

  static func lookup(viewId: String) -> HybridNitroVLCView? {
    registryLock.lock()
    defer { registryLock.unlock() }
    return registry.object(forKey: viewId as NSString)
  }

  private static func register(viewId: String, view: HybridNitroVLCView) {
    registryLock.lock()
    registry.setObject(view, forKey: viewId as NSString)
    registryLock.unlock()
  }

  private static func unregister(viewId: String) {
    registryLock.lock()
    registry.removeObject(forKey: viewId as NSString)
    registryLock.unlock()
  }

  private struct VideoInfoSnapshot: Equatable {
    let duration: Double
    let width: Double
    let height: Double
    let audioTracks: [TrackSnapshot]
    let textTracks: [TrackSnapshot]
  }

  private struct TrackSnapshot: Equatable {
    let id: Double
    let name: String
  }

  let view: UIView
  private var player: VLCMediaPlayer?
  private var dialogProvider: VLCDialogProvider?
  private var delegateHelper: VLCDelegateHelper?
  private var lastVideoInfoSnapshot: VideoInfoSnapshot?
  private var aspectRatioCString: UnsafeMutablePointer<Int8>?
  fileprivate var isPaused: Bool = false

  // Backing fields for imperative setters (no longer Fabric props)
  private var _source: VLCPlayerSource = VLCPlayerSource(uri: "", initType: nil, initOptions: nil)
  private var _subtitleUri: String?
  private var _paused: Bool?
  private var _loop: Bool?
  private var _rate: Double?
  private var _volume: Double?
  private var _muted: Bool?
  private var _audioTrack: Double?
  private var _textTrack: Double?
  private var _playInBackground: Bool?
  private var _videoAspectRatio: PlayerAspectRatio?
  private var _autoAspectRatio: Bool?
  private var _resizeMode: PlayerResizeMode?
  private var _autoplay: Bool? = true
  private var _acceptInvalidCertificates: Bool?
  private var lastLoadedSourceSignature: String?

  // Callbacks — set imperatively via setOn*() methods, NOT via Fabric props
  private var onPlayingCb: ((OnPlayingEventProps) -> Void)?
  private var onProgressCb: ((OnProgressEventProps) -> Void)?
  private var onPausedCb: ((SimpleCallbackEventProps) -> Void)?
  private var onStoppedCb: ((SimpleCallbackEventProps) -> Void)?
  private var onBufferingCb: ((SimpleCallbackEventProps) -> Void)?
  private var onEndedCb: ((SimpleCallbackEventProps) -> Void)?
  private var onErrorCb: ((SimpleCallbackEventProps) -> Void)?
  private var onLoadCb: ((VideoInfo) -> Void)?

  // viewId is the ONLY Fabric prop — stays as spec property
  var viewId: String = "" {
    didSet {
      if !oldValue.isEmpty {
        Self.unregister(viewId: oldValue)
      }
      if !viewId.isEmpty {
        Self.register(viewId: viewId, view: self)
      }
    }
  }

  var memorySize: Int {
    return 0
  }

  override init() {
    self.view = NitroVLCView(frame: .zero)
    super.init()

    delegateHelper = VLCDelegateHelper()
    delegateHelper?.owner = self
  }

  deinit {
    if !viewId.isEmpty {
      Self.unregister(viewId: viewId)
    }
    cleanup()
  }

  // MARK: - Imperative Property Setters

  func setSource(source: VLCPlayerSource) throws {
    let nextSignature = Self.sourceSignature(source)
    if lastLoadedSourceSignature == nextSignature {
      return
    }

    _source = source
    lastLoadedSourceSignature = nextSignature
    runOnMainThread { [weak self] in
      self?.configureSource()
    }
  }

  func setPaused(paused: Bool) throws {
    _paused = paused
    runOnMainThread { [weak self] in
      self?.applyPaused()
    }
  }

  func setLoop(loop: Bool) throws {
    _loop = loop
  }

  func setRate(rate: Double) throws {
    _rate = rate
    runOnMainThread { [weak self] in
      self?.applyRate()
    }
  }

  func setVolume(volume: Double) throws {
    _volume = volume
    runOnMainThread { [weak self] in
      self?.applyVolume()
    }
  }

  func setMuted(muted: Bool) throws {
    _muted = muted
    runOnMainThread { [weak self] in
      self?.applyMuted()
    }
  }

  func setAudioTrack(audioTrack: Double) throws {
    _audioTrack = audioTrack
    runOnMainThread { [weak self] in
      self?.applyAudioTrack()
    }
  }

  func setTextTrack(textTrack: Double) throws {
    _textTrack = textTrack
    runOnMainThread { [weak self] in
      self?.applyTextTrack()
    }
  }

  func setSubtitleUri(subtitleUri: String) throws {
    _subtitleUri = subtitleUri
    runOnMainThread { [weak self] in
      self?.applySubtitle()
    }
  }

  func setPlayInBackground(playInBackground: Bool) throws {
    _playInBackground = playInBackground
  }

  func setVideoAspectRatio(videoAspectRatio: PlayerAspectRatio) throws {
    _videoAspectRatio = videoAspectRatio
    runOnMainThread { [weak self] in
      self?.applyAspectRatio()
      self?.applyResizeMode()
    }
  }

  func setAutoAspectRatio(autoAspectRatio: Bool) throws {
    _autoAspectRatio = autoAspectRatio
    runOnMainThread { [weak self] in
      self?.applyAspectRatio()
      self?.applyResizeMode()
    }
  }

  func setResizeMode(resizeMode: PlayerResizeMode) throws {
    _resizeMode = resizeMode
    runOnMainThread { [weak self] in
      self?.applyResizeMode()
    }
  }

  func setAutoplay(autoplay: Bool) throws {
    _autoplay = autoplay
  }

  func setAcceptInvalidCertificates(acceptInvalidCertificates: Bool) throws {
    _acceptInvalidCertificates = acceptInvalidCertificates
  }

  // MARK: - Playback Methods

  func play() throws {
    runOnMainThread { [weak self] in
      self?.player?.play()
    }
  }

  func pause() throws {
    runOnMainThread { [weak self] in
      self?.player?.pause()
    }
  }

  func stop() throws {
    runOnMainThread { [weak self] in
      self?.player?.stop()
    }
  }

  func seek(position: Double) throws {
    runOnMainThread { [weak self] in
      self?.setSeek(position)
    }
  }

  // MARK: - Imperative Listener Setters

  func setOnPlaying(callback: @escaping (OnPlayingEventProps) -> Void) throws {
    onPlayingCb = callback
  }

  func setOnProgress(callback: @escaping (OnProgressEventProps) -> Void) throws {
    onProgressCb = callback
  }

  func setOnPaused(callback: @escaping (SimpleCallbackEventProps) -> Void) throws {
    onPausedCb = callback
  }

  func setOnStopped(callback: @escaping (SimpleCallbackEventProps) -> Void) throws {
    onStoppedCb = callback
  }

  func setOnBuffering(callback: @escaping (SimpleCallbackEventProps) -> Void) throws {
    onBufferingCb = callback
  }

  func setOnEnded(callback: @escaping (SimpleCallbackEventProps) -> Void) throws {
    onEndedCb = callback
  }

  func setOnError(callback: @escaping (SimpleCallbackEventProps) -> Void) throws {
    onErrorCb = callback
  }

  func setOnLoad(callback: @escaping (VideoInfo) -> Void) throws {
    onLoadCb = callback
  }

  // MARK: - Lifecycle

  func beforeUpdate() {}

  func afterUpdate() {}

  func dispose() {
    if !viewId.isEmpty {
      Self.unregister(viewId: viewId)
    }
    clearCallbacks()
    cleanup()
  }

  private func cleanup() {
    if let aspectRatioCString {
      free(aspectRatioCString)
      self.aspectRatioCString = nil
    }

    dialogProvider = nil
    player?.delegate = nil
    player?.drawable = nil
    player?.stop()
    player = nil
    delegateHelper?.owner = nil
  }

  private func clearCallbacks() {
    onPlayingCb = nil
    onProgressCb = nil
    onPausedCb = nil
    onStoppedCb = nil
    onBufferingCb = nil
    onEndedCb = nil
    onErrorCb = nil
    onLoadCb = nil
  }

  private func runOnMainThread(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.async(execute: block)
    }
  }

  // MARK: - Source Configuration

  private func configureSource() {
    guard !_source.uri.isEmpty else { return }

    cleanup()
    delegateHelper?.owner = self

    if let initType = _source.initType, initType != 1, let options = _source.initOptions {
      player = VLCMediaPlayer(options: options)
    } else {
      player = VLCMediaPlayer()
    }

    player?.delegate = delegateHelper
    player?.drawable = view

    if let library = player?.libraryInstance {
      dialogProvider = VLCDialogProvider(library: library, customUI: true)
      dialogProvider?.customRenderer = delegateHelper
    }

    loadMedia(uri: _source.uri)
    applySubtitle()
    applyRate()
    applyVolume()
    applyMuted()
    applyAudioTrack()
    applyTextTrack()
    applyAspectRatio()
    applyResizeMode()
    applyPaused()

    if _autoplay != false, _paused != true {
      player?.play()
    }
  }

  private static func sourceSignature(_ source: VLCPlayerSource) -> String {
    let initTypePart = source.initType.map(String.init) ?? "default"
    let initOptionsPart = source.initOptions?.joined(separator: "\u{001F}") ?? ""
    return "\(source.uri)::\(initTypePart)::\(initOptionsPart)"
  }

  private func loadMedia(uri: String) {
    guard let url = URL(string: uri) else { return }
    player?.media = VLCMedia(url: url)
  }

  private func applySubtitle() {
    guard let subtitleUri = _subtitleUri, !subtitleUri.isEmpty, let url = URL(string: subtitleUri) else { return }
    _ = player?.addPlaybackSlave(url, type: .subtitle, enforce: true)
  }

  private func applyPaused() {
    guard let paused = _paused else { return }
    isPaused = paused
    if paused {
      player?.pause()
    } else {
      player?.play()
    }
  }

  private func applyRate() {
    guard let rate = _rate else { return }
    player?.rate = Float(rate)
  }

  private func setSeek(_ position: Double) {
    guard let player, player.isSeekable else { return }
    let clamped = max(0.0, min(1.0, position))
    player.position = Float(clamped)
  }

  private func applyVolume() {
    guard let volume = _volume else { return }
    setPlayerVolume(volume)
  }

  private func setPlayerVolume(_ volume: Double) {
    guard let audio = player?.audio else { return }
    let clamped = max(0.0, min(1.0, volume))
    audio.volume = Int32(clamped * 100.0)
  }

  private func applyMuted() {
    guard let muted = _muted else { return }
    player?.audio?.isMuted = muted
  }

  private func applyAudioTrack() {
    guard let audioTrack = _audioTrack else { return }
    player?.currentAudioTrackIndex = Int32(audioTrack)
  }

  private func applyTextTrack() {
    guard let textTrack = _textTrack else { return }
    player?.currentVideoSubTitleIndex = Int32(textTrack)
  }

  private func applyAspectRatio() {
    guard let player else { return }

    if _autoAspectRatio == true || _videoAspectRatio == nil {
      if let aspectRatioCString {
        free(aspectRatioCString)
        self.aspectRatioCString = nil
      }
      player.videoAspectRatio = nil
      return
    }

    guard let aspectRatio = _videoAspectRatio else { return }
    let ratio = vlcAspectRatioString(for: aspectRatio)
    if let aspectRatioCString {
      free(aspectRatioCString)
      self.aspectRatioCString = nil
    }

    aspectRatioCString = strdup(ratio)
    player.videoAspectRatio = aspectRatioCString
  }

  private func vlcAspectRatioString(for ratio: PlayerAspectRatio) -> String {
    switch ratio {
    case .ratio16x9: return "16:9"
    case .ratio1x1: return "1:1"
    case .ratio4x3: return "4:3"
    case .ratio3x2: return "3:2"
    case .ratio21x9: return "21:9"
    case .ratio9x16: return "9:16"
    @unknown default: return "16:9"
    }
  }

  private func applyResizeMode() {
    guard let player else { return }
    guard let resizeMode = _resizeMode else { return }

    switch resizeMode {
    case .fill:
      let w = view.bounds.width
      let h = view.bounds.height
      if w > 0, h > 0 {
        if let aspectRatioCString {
          free(aspectRatioCString)
          self.aspectRatioCString = nil
        }
        let fillRatio = "\(Int(w)):\(Int(h))"
        aspectRatioCString = strdup(fillRatio)
        player.videoAspectRatio = aspectRatioCString
        player.scaleFactor = 0
      }
    case .cover:
      player.videoAspectRatio = nil
      let videoSize = player.videoSize
      let w = view.bounds.width
      let h = view.bounds.height
      if videoSize.width > 0, videoSize.height > 0, w > 0, h > 0 {
        let scaleW = w / videoSize.width
        let scaleH = h / videoSize.height
        player.scaleFactor = Float(max(scaleW, scaleH))
      } else {
        player.scaleFactor = 0
      }
    case .contain, .scaleDown:
      player.videoAspectRatio = nil
      player.scaleFactor = 0
    case .none:
      player.videoAspectRatio = nil
      player.scaleFactor = 1.0
    @unknown default:
      player.videoAspectRatio = nil
      player.scaleFactor = 0
    }
  }

  // MARK: - Event Handlers

  fileprivate func handleStateChanged() {
    guard let player else { return }

    switch player.state {
    case .opening, .buffering:
      onBufferingCb?(SimpleCallbackEventProps(target: 0))
    case .playing:
      isPaused = false
      let duration = Double(player.media?.length.intValue ?? 0)
      onPlayingCb?(OnPlayingEventProps(duration: duration, target: 0, seekable: player.isSeekable))
    case .paused:
      isPaused = true
      onPausedCb?(SimpleCallbackEventProps(target: 0))
    case .stopped:
      onStoppedCb?(SimpleCallbackEventProps(target: 0))
    case .ended:
      onEndedCb?(SimpleCallbackEventProps(target: 0))
      if _loop == true {
        player.position = 0
        player.play()
      }
    case .error:
      onErrorCb?(SimpleCallbackEventProps(target: 0))
    case .esAdded:
      break
    @unknown default:
      break
    }

    updateVideoInfoIfNeeded()
  }

  fileprivate func handleTimeChanged() {
    guard let player else { return }
    guard player.isPlaying, !isPaused else { return }

    let duration = Double(player.media?.length.intValue ?? 0)
    let currentTime = Double(player.time.intValue)
    let remainingTime = Double(player.remainingTime?.intValue ?? 0)
    let position = duration > 0 ? currentTime / duration : 0

    onProgressCb?(OnProgressEventProps(
      duration: duration,
      target: 0,
      currentTime: currentTime,
      position: position,
      remainingTime: remainingTime
    ))

    updateVideoInfoIfNeeded()
  }

  fileprivate func handleError() {
    onErrorCb?(SimpleCallbackEventProps(target: 0))
  }

  fileprivate func handleLoginDialog(reference: NSValue) {
    dialogProvider?.postAction(3, forDialogReference: reference)
  }

  fileprivate func handleQuestionDialog(title: String, message: String, reference: NSValue) {
    let fullText = "\(title) \(message)"
    let lowercased = fullText.lowercased()
    let isCertificateDialog = lowercased.contains("certificate") || lowercased.contains("ssl") || lowercased.contains("tls") || lowercased.contains("cert") || lowercased.contains("security")

    if isCertificateDialog {
      if _acceptInvalidCertificates == true {
        dialogProvider?.postAction(1, forDialogReference: reference)
      } else {
        dialogProvider?.postAction(3, forDialogReference: reference)
      }
    } else {
      dialogProvider?.postAction(3, forDialogReference: reference)
    }
  }

  fileprivate func handleProgressDialog(reference: NSValue) {
    dialogProvider?.dismissDialog(withReference: reference)
  }

  private func updateVideoInfoIfNeeded() {
    guard let player else { return }

    let duration = Double(player.media?.length.intValue ?? 0)
    let size = player.videoSize
    let audioTracks = buildTrackSnapshots(names: player.audioTrackNames, ids: player.audioTrackIndexes)
    let textTracks = buildTrackSnapshots(names: player.videoSubTitlesNames, ids: player.videoSubTitlesIndexes)

    let snapshot = VideoInfoSnapshot(
      duration: duration,
      width: Double(size.width),
      height: Double(size.height),
      audioTracks: audioTracks,
      textTracks: textTracks
    )

    if snapshot == lastVideoInfoSnapshot {
      return
    }

    lastVideoInfoSnapshot = snapshot

    let videoSize = VideoSize(width: Double(size.width), height: Double(size.height))
    let info = VideoInfo(
      duration: duration,
      target: 0,
      videoSize: videoSize,
      audioTracks: audioTracks.map { Track(id: $0.id, name: $0.name) },
      textTracks: textTracks.map { Track(id: $0.id, name: $0.name) }
    )
    onLoadCb?(info)
  }

  private func buildTrackSnapshots(names: [Any], ids: [Any]) -> [TrackSnapshot] {
    let count = min(names.count, ids.count)
    guard count > 0 else { return [] }

    var snapshots: [TrackSnapshot] = []
    snapshots.reserveCapacity(count)

    for index in 0..<count {
      guard let name = names[index] as? String else { continue }
      let idValue = (ids[index] as? NSNumber)?.doubleValue ?? 0
      snapshots.append(TrackSnapshot(id: idValue, name: name))
    }

    return snapshots
  }
}
#endif
