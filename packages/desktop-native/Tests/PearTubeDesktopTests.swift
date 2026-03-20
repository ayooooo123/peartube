import XCTest
@testable import PearTubeDesktop

@MainActor
final class PearTubeDesktopTests: XCTestCase {
  func testPreviewHostBootstrapTransitionsToReady() async {
    let hostBridge = HostBridgeService()

    await hostBridge.bootstrapPreviewSession(delayNanoseconds: 0)

    XCTAssertTrue(hostBridge.isReady)
    XCTAssertEqual(hostBridge.statusTitle, "Host ready in preview mode")
  }

  func testSectionSelectionKeepsBrowseContentAvailable() {
    let appState = AppState()

    appState.selectSection(.subscriptions)

    XCTAssertEqual(appState.currentSection, .subscriptions)
    XCTAssertFalse(appState.videos().isEmpty)
    XCTAssertNotNil(appState.selectedVideo)
  }
}
