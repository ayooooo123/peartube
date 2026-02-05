import Foundation

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import MobileVLCKit
import UIKit

final class HybridNitroVLCView: HybridNitroVLCViewSpec {
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
  private var lastVideoInfoSnapshot: VideoInfoSnapshot?
  private var aspectRatioCString: UnsafeMutablePointer<Int8>?
  private var isPaused: Bool = false

  var source: VLCPlayerSource {
    didSet {
      configureSource()
    }
  }

  var subtitleUri: String? {
    didSet {
      applySubtitle()
    }
  }

  var paused: Bool? {
    didSet {
      applyPaused()
    }
  }

  var `repeat`: Bool?

  var rate: Double? {
    didSet {
      applyRate()
    }
  }

  var seek: Double? {
    didSet {
      applySeek()
    }
  }

  var volume: Double? {
    didSet {
      applyVolume()
    }
  }

  var muted: Bool? {
    didSet {
      applyMuted()
    }
  }

  var audioTrack: Double? {
    didSet {
      applyAudioTrack()
    }
  }

  var textTrack: Double? {
    didSet {
      applyTextTrack()
    }
  }

  var playInBackground: Bool?

  var videoAspectRatio: PlayerAspectRatio? {
    didSet {
      applyAspectRatio()
    }
  }

  var autoAspectRatio: Bool? {
    didSet {
      applyAspectRatio()
    }
  }

  var resizeMode: PlayerResizeMode? {
    didSet {
      applyResizeMode()
    }
  }

  var autoplay: Bool?

  var acceptInvalidCertificates: Bool?

  var onPlaying: ((OnPlayingEventProps) -> Void)?
  var onProgress: ((OnProgressEventProps) -> Void)?
  var onPaused: ((SimpleCallbackEventProps) -> Void)?
  var onStopped: ((SimpleCallbackEventProps) -> Void)?
  var onBuffering: ((SimpleCallbackEventProps) -> Void)?
  var onEnded: ((SimpleCallbackEventProps) -> Void)?
  var onError: ((SimpleCallbackEventProps) -> Void)?
  var onLoad: ((VideoInfo) -> Void)?

  var memorySize: Int {
    return 0
  }

  override init() {
    self.view = NitroVLCView(frame: .zero)
    self.source = VLCPlayerSource(uri: "", initType: nil, initOptions: nil)
    self.autoplay = true
    super.init()
    configureSource()
  }

  deinit {
    cleanup()
  }

  func play() throws {
    player?.play()
  }

  func pause() throws {
    player?.pause()
  }

  func stop() throws {
    player?.stop()
  }

  func seek(position: Double) throws {
    setSeek(position)
  }

  func setVolume(volume: Double) throws {
    setPlayerVolume(volume)
  }

  func beforeUpdate() {}

  func afterUpdate() {}

  func dispose() {
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
  }

  private func configureSource() {
    guard !source.uri.isEmpty else { return }

    cleanup()

    if let initType = source.initType, initType != 1, let options = source.initOptions {
      player = VLCMediaPlayer(options: options)
    } else {
      player = VLCMediaPlayer()
    }

    player?.delegate = self
    player?.drawable = view

    if let library = player?.libraryInstance {
      dialogProvider = VLCDialogProvider(library: library, customUI: true)
      dialogProvider?.customRenderer = self
    }

    loadMedia(uri: source.uri)
    applySubtitle()
    applyRate()
    applyVolume()
    applyMuted()
    applyAudioTrack()
    applyTextTrack()
    applyAspectRatio()
    applyResizeMode()
    applyPaused()

    if autoplay != false, paused != true {
      player?.play()
    }
  }

  private func loadMedia(uri: String) {
    guard let url = URL(string: uri) else { return }
    player?.media = VLCMedia(url: url)
  }

  private func applySubtitle() {
    guard let subtitleUri, !subtitleUri.isEmpty, let url = URL(string: subtitleUri) else { return }
    _ = player?.addPlaybackSlave(url, type: .subtitle, enforce: true)
  }

  private func applyPaused() {
    guard let paused else { return }
    isPaused = paused
    if paused {
      player?.pause()
    } else {
      player?.play()
    }
  }

  private func applyRate() {
    guard let rate else { return }
    player?.rate = Float(rate)
  }

  private func applySeek() {
    guard let seek else { return }
    setSeek(seek)
  }

  private func setSeek(_ position: Double) {
    guard let player, player.isSeekable else { return }
    let clamped = max(0.0, min(1.0, position))
    player.position = Float(clamped)
  }

  private func applyVolume() {
    guard let volume else { return }
    setPlayerVolume(volume)
  }

  private func setPlayerVolume(_ volume: Double) {
    guard let audio = player?.audio else { return }
    let clamped = max(0.0, min(1.0, volume))
    audio.volume = Int32(clamped * 100.0)
  }

  private func applyMuted() {
    guard let muted else { return }
    player?.audio?.isMuted = muted
  }

  private func applyAudioTrack() {
    guard let audioTrack else { return }
    player?.currentAudioTrackIndex = Int32(audioTrack)
  }

  private func applyTextTrack() {
    guard let textTrack else { return }
    player?.currentVideoSubTitleIndex = Int32(textTrack)
  }

  private func applyAspectRatio() {
    guard let player else { return }

    if autoAspectRatio == true || videoAspectRatio == nil {
      if let aspectRatioCString {
        free(aspectRatioCString)
        self.aspectRatioCString = nil
      }
      player.videoAspectRatio = nil
      return
    }

    guard let ratio = videoAspectRatio?.stringValue else { return }
    if let aspectRatioCString {
      free(aspectRatioCString)
      self.aspectRatioCString = nil
    }

    aspectRatioCString = strdup(ratio)
    player.videoAspectRatio = aspectRatioCString
  }

  private func applyResizeMode() {
    guard let resizeMode else { return }
    switch resizeMode {
    case .fill:
      view.contentMode = .scaleToFill
    case .contain:
      view.contentMode = .scaleAspectFit
    case .cover:
      view.contentMode = .scaleAspectFill
    case .none:
      view.contentMode = .center
    case .scaleDown:
      view.contentMode = .scaleAspectFit
    @unknown default:
      view.contentMode = .scaleAspectFit
    }
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
    onLoad?(info)
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

extension HybridNitroVLCView: VLCMediaPlayerDelegate {
  func mediaPlayerStateChanged(_ aNotification: Notification) {
    guard let player else { return }

    switch player.state {
    case .opening, .buffering:
      onBuffering?(SimpleCallbackEventProps(target: 0))
    case .playing:
      let duration = Double(player.media?.length.intValue ?? 0)
      onPlaying?(OnPlayingEventProps(duration: duration, target: 0, seekable: player.isSeekable))
    case .paused:
      isPaused = true
      onPaused?(SimpleCallbackEventProps(target: 0))
    case .stopped:
      onStopped?(SimpleCallbackEventProps(target: 0))
    case .ended:
      onEnded?(SimpleCallbackEventProps(target: 0))
      if `repeat` == true {
        player.position = 0
        player.play()
      }
    case .error:
      onError?(SimpleCallbackEventProps(target: 0))
    case .esAdded:
      break
    @unknown default:
      break
    }

    updateVideoInfoIfNeeded()
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    guard let player else { return }
    guard player.isPlaying, !isPaused else { return }

    let duration = Double(player.media?.length.intValue ?? 0)
    let currentTime = Double(player.time.intValue)
    let remainingTime = Double(player.remainingTime?.intValue ?? 0)
    let position = duration > 0 ? currentTime / duration : 0

    onProgress?(OnProgressEventProps(
      duration: duration,
      target: 0,
      currentTime: currentTime,
      position: position,
      remainingTime: remainingTime
    ))

    updateVideoInfoIfNeeded()
  }
}

extension HybridNitroVLCView: VLCCustomDialogRendererProtocol {
  func showError(withTitle error: String, message: String) {
    onError?(SimpleCallbackEventProps(target: 0))
  }

  func showLogin(withTitle title: String, message: String, defaultUsername: String?, askingForStorage: Bool, withReference reference: NSValue) {
    dialogProvider?.postAction(3, forDialogReference: reference)
  }

  func showQuestion(withTitle title: String, message: String, type questionType: VLCDialogQuestionType, cancelString: String?, action1String: String?, action2String: String?, withReference reference: NSValue) {
    let fullText = "\(title) \(message)"
    let lowercased = fullText.lowercased()
    let isCertificateDialog = lowercased.contains("certificate") || lowercased.contains("ssl") || lowercased.contains("tls") || lowercased.contains("cert") || lowercased.contains("security")

    if isCertificateDialog {
      if acceptInvalidCertificates == true {
        dialogProvider?.postAction(1, forDialogReference: reference)
      } else {
        dialogProvider?.postAction(3, forDialogReference: reference)
      }
    } else {
      dialogProvider?.postAction(3, forDialogReference: reference)
    }
  }

  func showProgress(withTitle title: String, message: String, isIndeterminate: Bool, position: Float, cancelString: String?, withReference reference: NSValue) {
    dialogProvider?.dismissDialog(withReference: reference)
  }

  func updateProgress(withReference reference: NSValue, message: String?, position: Float) {}

  func cancelDialog(withReference reference: NSValue) {}
}
#endif
