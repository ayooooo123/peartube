import XCTest

#if canImport(NitroModules) && canImport(MobileVLCKit)
import NitroModules
import MobileVLCKit
@testable import NitroVLC

final class HybridNitroVLCViewTests: XCTestCase {
  var view: HybridNitroVLCView!
  
  override func setUp() {
    super.setUp()
    view = HybridNitroVLCView()
  }
  
  override func tearDown() {
    view.dispose()
    view = nil
    super.tearDown()
  }
  
  // MARK: - Initialization Tests
  
  func testInitialization() {
    XCTAssertNotNil(view)
    XCTAssertNotNil(view.view)
    XCTAssertTrue(view.view is NitroVLCView)
  }
  
  func testDefaultProperties() {
    XCTAssertTrue(view.source.uri.isEmpty)
    XCTAssertEqual(view.autoplay, true)
    XCTAssertNil(view.paused)
    XCTAssertNil(view.loop)
    XCTAssertNil(view.rate)
    XCTAssertNil(view.volume)
    XCTAssertNil(view.muted)
    XCTAssertNil(view.subtitleUri)
    XCTAssertNil(view.videoAspectRatio)
    XCTAssertNil(view.resizeMode)
  }
  
  func testMemorySize() {
    XCTAssertEqual(view.memorySize, 0)
  }
  
  // MARK: - Play/Pause Tests
  
  func testPlayDoesNotThrow() {
    XCTAssertNoThrow(try view.play())
  }
  
  func testPauseDoesNotThrow() {
    XCTAssertNoThrow(try view.pause())
  }
  
  func testStopDoesNotThrow() {
    XCTAssertNoThrow(try view.stop())
  }
  
  func testPlayPauseSequence() {
    XCTAssertNoThrow(try view.play())
    XCTAssertNoThrow(try view.pause())
    XCTAssertNoThrow(try view.play())
    XCTAssertNoThrow(try view.stop())
  }
  
  // MARK: - Seek Tests
  
  func testSeekDoesNotThrow() {
    XCTAssertNoThrow(try view.seek(position: 0.5))
  }
  
  func testSeekClampsBelowZero() {
    XCTAssertNoThrow(try view.seek(position: -0.5))
  }
  
  func testSeekClampsAboveOne() {
    XCTAssertNoThrow(try view.seek(position: 1.5))
  }
  
  func testSeekAtBoundaries() {
    XCTAssertNoThrow(try view.seek(position: 0.0))
    XCTAssertNoThrow(try view.seek(position: 1.0))
  }
  
  func testSeekProperty() {
    view.seek = 0.5
    XCTAssertEqual(view.seek, 0.5)
  }
  
  // MARK: - Volume Tests
  
  func testSetVolumeDoesNotThrow() {
    XCTAssertNoThrow(try view.setVolume(volume: 0.5))
  }
  
  func testSetVolumeAtBoundaries() {
    XCTAssertNoThrow(try view.setVolume(volume: 0.0))
    XCTAssertNoThrow(try view.setVolume(volume: 1.0))
  }
  
  func testVolumeProperty() {
    view.volume = 0.75
    XCTAssertEqual(view.volume, 0.75)
  }
  
  // MARK: - Callback Registration Tests
  
  func testOnPlayingCallback() {
    let expectation = XCTestExpectation(description: "onPlaying callback registered")
    expectation.isInverted = true
    
    view.onPlaying = { _ in
      expectation.fulfill()
    }
    
    XCTAssertNotNil(view.onPlaying)
    wait(for: [expectation], timeout: 0.1)
  }
  
  func testOnProgressCallback() {
    let expectation = XCTestExpectation(description: "onProgress callback registered")
    expectation.isInverted = true
    
    view.onProgress = { _ in
      expectation.fulfill()
    }
    
    XCTAssertNotNil(view.onProgress)
    wait(for: [expectation], timeout: 0.1)
  }
  
  func testOnPausedCallback() {
    view.onPaused = { _ in }
    XCTAssertNotNil(view.onPaused)
  }
  
  func testOnStoppedCallback() {
    view.onStopped = { _ in }
    XCTAssertNotNil(view.onStopped)
  }
  
  func testOnBufferingCallback() {
    view.onBuffering = { _ in }
    XCTAssertNotNil(view.onBuffering)
  }
  
  func testOnEndedCallback() {
    view.onEnded = { _ in }
    XCTAssertNotNil(view.onEnded)
  }
  
  func testOnErrorCallback() {
    view.onError = { _ in }
    XCTAssertNotNil(view.onError)
  }
  
  func testOnLoadCallback() {
    view.onLoad = { _ in }
    XCTAssertNotNil(view.onLoad)
  }
  
  // MARK: - Property Setter Tests
  
  func testSourceProperty() {
    let testUri = "https://example.com/video.mp4"
    view.source = VLCPlayerSource(uri: testUri, initType: nil, initOptions: nil)
    XCTAssertEqual(view.source.uri, testUri)
  }
  
  func testSubtitleUriProperty() {
    let testUri = "https://example.com/subs.srt"
    view.subtitleUri = testUri
    XCTAssertEqual(view.subtitleUri, testUri)
  }
  
  func testPausedProperty() {
    view.paused = true
    XCTAssertEqual(view.paused, true)
    
    view.paused = false
    XCTAssertEqual(view.paused, false)
  }
  
  func testLoopProperty() {
    view.loop = true
    XCTAssertEqual(view.loop, true)
    
    view.loop = false
    XCTAssertEqual(view.loop, false)
  }
  
  func testRateProperty() {
    view.rate = 2.0
    XCTAssertEqual(view.rate, 2.0)
    
    view.rate = 0.5
    XCTAssertEqual(view.rate, 0.5)
  }
  
  func testMutedProperty() {
    view.muted = true
    XCTAssertEqual(view.muted, true)
    
    view.muted = false
    XCTAssertEqual(view.muted, false)
  }
  
  func testAudioTrackProperty() {
    view.audioTrack = 1.0
    XCTAssertEqual(view.audioTrack, 1.0)
  }
  
  func testTextTrackProperty() {
    view.textTrack = 1.0
    XCTAssertEqual(view.textTrack, 1.0)
  }
  
  func testPlayInBackgroundProperty() {
    view.playInBackground = true
    XCTAssertEqual(view.playInBackground, true)
  }
  
  func testAutoplayProperty() {
    view.autoplay = false
    XCTAssertEqual(view.autoplay, false)
  }
  
  func testAcceptInvalidCertificatesProperty() {
    view.acceptInvalidCertificates = true
    XCTAssertEqual(view.acceptInvalidCertificates, true)
  }
  
  // MARK: - Aspect Ratio Tests
  
  func testVideoAspectRatioProperty() {
    view.videoAspectRatio = .ratio16x9
    XCTAssertEqual(view.videoAspectRatio, .ratio16x9)
    
    view.videoAspectRatio = .ratio4x3
    XCTAssertEqual(view.videoAspectRatio, .ratio4x3)
    
    view.videoAspectRatio = .ratio1x1
    XCTAssertEqual(view.videoAspectRatio, .ratio1x1)
  }
  
  func testAutoAspectRatioProperty() {
    view.autoAspectRatio = true
    XCTAssertEqual(view.autoAspectRatio, true)
    
    view.autoAspectRatio = false
    XCTAssertEqual(view.autoAspectRatio, false)
  }
  
  // MARK: - Resize Mode Tests
  
  func testResizeModeFill() {
    view.resizeMode = .fill
    XCTAssertEqual(view.resizeMode, .fill)
    XCTAssertEqual(view.view.contentMode, .scaleToFill)
  }
  
  func testResizeModeContain() {
    view.resizeMode = .contain
    XCTAssertEqual(view.resizeMode, .contain)
    XCTAssertEqual(view.view.contentMode, .scaleAspectFit)
  }
  
  func testResizeModeCover() {
    view.resizeMode = .cover
    XCTAssertEqual(view.resizeMode, .cover)
    XCTAssertEqual(view.view.contentMode, .scaleAspectFill)
  }
  
  func testResizeModeNone() {
    view.resizeMode = .none
    XCTAssertEqual(view.resizeMode, .none)
    XCTAssertEqual(view.view.contentMode, .center)
  }
  
  // MARK: - Lifecycle Tests
  
  func testBeforeUpdateDoesNotThrow() {
    view.beforeUpdate()
  }
  
  func testAfterUpdateDoesNotThrow() {
    view.afterUpdate()
  }
  
  func testDisposeCleanup() {
    view.dispose()
    XCTAssertNotNil(view.view)
  }
  
  func testMultipleDisposeCallsSafe() {
    view.dispose()
    view.dispose()
  }
  
  // MARK: - Source Configuration Tests
  
  func testSourceWithInitOptions() {
    let options = ["--network-caching=300", "--no-audio"]
    view.source = VLCPlayerSource(uri: "https://example.com/video.mp4", initType: 2, initOptions: options)
    
    XCTAssertEqual(view.source.uri, "https://example.com/video.mp4")
    XCTAssertEqual(view.source.initType, 2)
    XCTAssertEqual(view.source.initOptions, options)
  }
  
  func testEmptySourceNotConfigured() {
    view.source = VLCPlayerSource(uri: "", initType: nil, initOptions: nil)
    XCTAssertTrue(view.source.uri.isEmpty)
  }
  
  // MARK: - NitroVLCView Tests
  
  func testNitroVLCViewBackgroundColor() {
    guard let nitroView = view.view as? NitroVLCView else {
      XCTFail("View should be NitroVLCView")
      return
    }
    XCTAssertEqual(nitroView.backgroundColor, .clear)
  }
  
  func testNitroVLCViewDefaultContentMode() {
    guard let nitroView = view.view as? NitroVLCView else {
      XCTFail("View should be NitroVLCView")
      return
    }
    XCTAssertEqual(nitroView.contentMode, .scaleAspectFit)
  }
}

// MARK: - NitroVLCView Unit Tests

final class NitroVLCViewTests: XCTestCase {
  
  func testInitWithFrame() {
    let frame = CGRect(x: 0, y: 0, width: 320, height: 240)
    let nitroView = NitroVLCView(frame: frame)
    
    XCTAssertEqual(nitroView.frame, frame)
    XCTAssertEqual(nitroView.backgroundColor, .clear)
    XCTAssertEqual(nitroView.contentMode, .scaleAspectFit)
  }
  
  func testInitWithZeroFrame() {
    let nitroView = NitroVLCView(frame: .zero)
    
    XCTAssertEqual(nitroView.frame, .zero)
    XCTAssertEqual(nitroView.backgroundColor, .clear)
  }
}

#else
final class HybridNitroVLCViewTests: XCTestCase {
  func testSkipped() {
    XCTSkip("MobileVLCKit not available - tests require iOS environment with MobileVLCKit")
  }
}
#endif
