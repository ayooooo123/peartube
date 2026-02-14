import Foundation
import UIKit
import AVKit
import AVFoundation
import CoreMedia

protocol MpvPipControllerDelegate: AnyObject {
  func pipStateChanged(isInPip: Bool, width: CGFloat, height: CGFloat)
}

@available(iOS 15.0, *)
final class MpvPipController: NSObject,
    AVPictureInPictureControllerDelegate,
    AVPictureInPictureSampleBufferPlaybackDelegate {

  weak var delegate: MpvPipControllerDelegate?

  private var pipController: AVPictureInPictureController?
  private weak var displayLayer: AVSampleBufferDisplayLayer?
  private weak var sourceView: UIView?
  private var timebase: CMTimebase?

  var isPlaybackPaused: (() -> Bool)?
  var setPlaying: ((_ playing: Bool) -> Void)?
  var skipByInterval: ((_ seconds: Double, _ completion: @escaping () -> Void) -> Void)?
  var currentTimeRange: (() -> CMTimeRange)?
  private(set) var isActive = false
  private var isEnabled = false
  private var didSendRestoreEvent = false
  private(set) var videoWidth: Int = 0
  private(set) var videoHeight: Int = 0

  func setup(sourceView: UIView, displayLayer: AVSampleBufferDisplayLayer) {
    self.sourceView = sourceView
    self.displayLayer = displayLayer

    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }

    setupTimebase()

    let contentSource = AVPictureInPictureController.ContentSource(
      sampleBufferDisplayLayer: displayLayer,
      playbackDelegate: self
    )
    let controller = AVPictureInPictureController(contentSource: contentSource)
    controller.delegate = self
    controller.canStartPictureInPictureAutomaticallyFromInline = false
    pipController = controller
  }

  private func setupTimebase() {
    guard let layer = displayLayer else { return }
    var newTimebase: CMTimebase?
    CMTimebaseCreateWithSourceClock(
      allocator: kCFAllocatorDefault,
      sourceClock: CMClockGetHostTimeClock(),
      timebaseOut: &newTimebase
    )
    if let tb = newTimebase {
      CMTimebaseSetRate(tb, rate: 1.0)
      CMTimebaseSetTime(tb, time: .zero)
      layer.controlTimebase = tb
      timebase = tb
    }
  }

  func updatePlaybackState(currentTime: Double, playing: Bool) {
    guard let tb = timebase else { return }
    CMTimebaseSetTime(tb, time: CMTime(seconds: currentTime, preferredTimescale: 1000))
    CMTimebaseSetRate(tb, rate: playing ? 1.0 : 0.0)
    pipController?.invalidatePlaybackState()
  }

  func setEnabled(_ enabled: Bool) {
    guard let controller = pipController else { return }
    isEnabled = enabled
    controller.canStartPictureInPictureAutomaticallyFromInline = enabled
  }

  func startPiP() {
    guard let controller = pipController, !controller.isPictureInPictureActive else { return }
    controller.startPictureInPicture()
  }

  func stopPiP() {
    guard let controller = pipController, controller.isPictureInPictureActive else { return }
    controller.stopPictureInPicture()
  }

  var isPipActive: Bool {
    pipController?.isPictureInPictureActive ?? false
  }

  var isPipPossible: Bool {
    pipController?.isPictureInPicturePossible ?? false
  }

  func teardown() {
    pipController?.stopPictureInPicture()
    pipController = nil
    timebase = nil
    sourceView = nil
  }

  func setVideoDimensions(width: Int, height: Int) {
    videoWidth = width
    videoHeight = height
  }

  // MARK: - AVPictureInPictureControllerDelegate

  func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
    isActive = true
    didSendRestoreEvent = false
    pipController?.invalidatePlaybackState()
  }

  func pictureInPictureControllerDidStartPictureInPicture(_ controller: AVPictureInPictureController) {
    let size = displayLayer?.bounds.size ?? .zero
    let width = size.width > 0 ? size.width : 360
    let height = size.height > 0 ? size.height : 640
    delegate?.pipStateChanged(isInPip: true, width: width, height: height)
  }

  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    isActive = false
    pipController?.invalidatePlaybackState()
    if !didSendRestoreEvent {
      delegate?.pipStateChanged(isInPip: false, width: 0, height: 0)
    }
    didSendRestoreEvent = false
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    print("[MpvPiP] failed to start PiP: \(error.localizedDescription)")
    isActive = false
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    didSendRestoreEvent = true
    delegate?.pipStateChanged(isInPip: false, width: 0, height: 0)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
      completionHandler(true)
    }
  }

  // MARK: - AVPictureInPictureSampleBufferPlaybackDelegate

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    setPlaying playing: Bool
  ) {
    setPlaying?(playing)
  }

  func pictureInPictureControllerTimeRangeForPlayback(
    _ controller: AVPictureInPictureController
  ) -> CMTimeRange {
    return currentTimeRange?() ?? CMTimeRange(start: .zero, duration: CMTime(seconds: 3600, preferredTimescale: 1))
  }

  func pictureInPictureControllerIsPlaybackPaused(
    _ controller: AVPictureInPictureController
  ) -> Bool {
    return isPlaybackPaused?() ?? false
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    didTransitionToRenderSize newRenderSize: CMVideoDimensions
  ) {
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    skipByInterval skipInterval: CMTime,
    completion completionHandler: @escaping () -> Void
  ) {
    let seconds = CMTimeGetSeconds(skipInterval)
    if let skip = skipByInterval {
      skip(seconds, completionHandler)
    } else {
      completionHandler()
    }
  }
}

final class MpvPipControllerStub {
  weak var delegate: MpvPipControllerDelegate?
  var isActive: Bool { false }
  var isPipPossible: Bool { false }
  func setEnabled(_ enabled: Bool) {}
  func startPiP() {}
  func stopPiP() {}
  func teardown() {}
}
