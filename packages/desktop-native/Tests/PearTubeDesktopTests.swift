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

  func testSearchResultsOverrideSectionVideosUntilCleared() {
    let appState = AppState()
    let sectionVideos = appState.videos(for: .home)
    XCTAssertFalse(sectionVideos.isEmpty)

    let searchResults = [
      NativeVideo(
        id: "channel-search:video-1",
        backendVideoID: "video-1",
        channelKey: "channel-search",
        title: "Search Hit",
        channelName: "Search Channel",
        durationText: "2:22",
        summary: "Global result summary",
        tags: ["search"],
        accentHex: "#F59F00",
        sections: [.home]
      )
    ]

    appState.applySearchResults(query: "search", videos: searchResults)

    XCTAssertTrue(appState.isSearchActive)
    XCTAssertEqual(appState.displayedVideos.map(\.title), ["Search Hit"])
    XCTAssertEqual(appState.selectedVideo?.title, "Search Hit")

    appState.clearSearch()

    XCTAssertFalse(appState.isSearchActive)
    XCTAssertEqual(appState.displayedVideos.map(\.id), sectionVideos.map(\.id))
    XCTAssertEqual(appState.selectedVideo?.id, sectionVideos.first?.id)
  }

  func testSearchResultsReplaceMissingSelectionWithFirstResult() {
    let appState = AppState()
    appState.selectSection(.library)
    appState.selectVideo("missing-video")

    let searchResults = [
      NativeVideo(
        id: "channel-search:video-1",
        backendVideoID: "video-1",
        channelKey: "channel-search",
        title: "First Search Hit",
        channelName: "Search Channel",
        durationText: "2:22",
        summary: "Global result summary",
        tags: ["search"],
        accentHex: "#F59F00",
        sections: [.home]
      ),
      NativeVideo(
        id: "channel-search:video-2",
        backendVideoID: "video-2",
        channelKey: "channel-search",
        title: "Second Search Hit",
        channelName: "Search Channel",
        durationText: "3:10",
        summary: "Another result summary",
        tags: ["search"],
        accentHex: "#12B886",
        sections: [.home]
      )
    ]

    appState.applySearchResults(query: "search", videos: searchResults)

    XCTAssertEqual(appState.selectedVideoID, "channel-search:video-1")
    XCTAssertEqual(appState.displayedVideos.count, 2)
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

  func testNativeBridgeSearchResponseRoundTripsThroughCompactEncoding() throws {
    let response = NativeBridgeSearchResponse(
      query: "native shell",
      results: [
        NativeVideo(
          id: "channel-a:video-1",
          backendVideoID: "video-1",
          channelKey: "channel-a",
          publicBeeKey: "bee-a",
          title: "Native Shell Walkthrough",
          channelName: "PearTube HQ",
          durationText: "9:12",
          summary: "A strong global search result.",
          tags: ["search", "native"],
          accentHex: "#FF7A59",
          sections: [.home],
          thumbnailURL: URL(string: "https://example.com/thumb.jpg")
        )
      ]
    )

    let encoded = try NativeBridgePayload.encode(NativeBridgeSearchResponseCodec(), value: response)
    let decoded = try NativeBridgePayload.decode(NativeBridgeSearchResponseCodec(), from: encoded)

    XCTAssertEqual(decoded, response)
  }
}
