import XCTest
@testable import PearTubeDesktop

@MainActor
final class PearTubeDesktopTests: XCTestCase {
  func testApplyingBrowseSnapshotUpdatesHomeSelection() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          NativeVideo(
            id: "channel-a:video-1",
            backendVideoID: "video-1",
            channelKey: "channel-a",
            title: "Video 1",
            channelName: "Channel A",
            durationText: "1:23",
            summary: "Summary",
            tags: ["home"],
            accentHex: "#FF7A59",
            sections: [.home]
          )
        ],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 0, libraryCount: 0, channelCount: 1)
    )

    appState.applySnapshot(snapshot)

    XCTAssertEqual(appState.selectedVideo?.title, "Video 1")
    XCTAssertEqual(appState.videos().count, 1)
  }

  func testSectionSelectionKeepsBrowseContentAvailable() {
    let appState = AppState()

    appState.selectSection(.subscriptions)

    XCTAssertEqual(appState.currentSection, .subscriptions)
    XCTAssertFalse(appState.videos().isEmpty)
    XCTAssertNotNil(appState.selectedVideo)
  }

  func testNativeBridgeBootstrapResponseRoundTripsThroughCompactEncoding() throws {
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 42.5,
      sections: NativeBrowseSections(
        home: [
          NativeVideo(
            id: "channel-a:video-1",
            backendVideoID: "video-1",
            channelKey: "channel-a",
            publicBeeKey: "bee-a",
            title: "Video 1",
            channelName: "Channel A",
            durationText: "1:23",
            summary: "Summary",
            tags: ["home", "native"],
            accentHex: "#FF7A59",
            sections: [.home, .library],
            thumbnailURL: URL(string: "https://example.com/thumb.jpg")
          )
        ],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 0, libraryCount: 0, channelCount: 1)
    )

    let response = NativeBridgeBootstrapResponse(
      blobServerPort: 64369,
      protocolVersion: 1,
      storagePath: "/tmp/peartube-native",
      snapshot: snapshot
    )

    let encoded = try NativeBridgePayload.encode(NativeBridgeBootstrapResponseCodec(), value: response)
    let decoded = try NativeBridgePayload.decode(NativeBridgeBootstrapResponseCodec(), from: encoded)

    XCTAssertEqual(decoded, response)
  }

  func testNativeBridgeResolvePlaybackRequestRoundTripsThroughCompactEncoding() throws {
    let request = NativeBridgeResolvePlaybackRequest(
      channelKey: "channel-a",
      publicBeeKey: "bee-a",
      videoId: "video-1"
    )

    let encoded = try NativeBridgePayload.encode(NativeBridgeResolvePlaybackRequestCodec(), value: request)
    let decoded = try NativeBridgePayload.decode(NativeBridgeResolvePlaybackRequestCodec(), from: encoded)

    XCTAssertEqual(decoded, request)
  }
}
