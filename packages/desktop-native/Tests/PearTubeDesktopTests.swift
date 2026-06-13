import AVFoundation
import AVKit
import SwiftUI
import XCTest
@testable import PearTubeDesktop

@MainActor
final class PearTubeDesktopTests: XCTestCase {
  func testDefaultAppStateStartsEmptyUntilHostSnapshotArrives() {
    let appState = AppState()

    XCTAssertTrue(appState.displayedVideos.isEmpty)
    XCTAssertNil(appState.selectedVideo)
    XCTAssertEqual(appState.currentSection, .home)
  }

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
    let appState = AppState(catalog: NativeVideo.samples)

    appState.selectSection(.subscriptions)

    XCTAssertEqual(appState.currentSection, .subscriptions)
    XCTAssertFalse(appState.videos().isEmpty)
    XCTAssertNotNil(appState.selectedVideo)
  }

  func testSelectingEmptySectionClearsVideoSelectionInsteadOfFallingBack() {
    let appState = AppState()

    appState.selectSection(.diagnostics)

    XCTAssertEqual(appState.currentSection, .diagnostics)
    XCTAssertTrue(appState.videos().isEmpty)
    XCTAssertNil(appState.selectedVideo)
  }

  func testSelectingVideoAfterPauseDoesNotReenterPreviewState() {
    let appState = AppState(
      catalog: [
        makeVideo(
          id: "channel-a:video-1",
          backendVideoID: "video-1",
          channelKey: "channel-a",
          title: "Video 1",
          channelName: "Channel A",
          sections: [.home]
        ),
        makeVideo(
          id: "channel-a:video-2",
          backendVideoID: "video-2",
          channelKey: "channel-a",
          title: "Video 2",
          channelName: "Channel A",
          sections: [.home]
        ),
      ]
    )

    appState.playSelectedPreview()
    appState.pausePreview()
    appState.selectVideo("channel-a:video-1")

    XCTAssertFalse(appState.isPlayingPreview)
    XCTAssertEqual(appState.playingVideoID, "channel-a:video-1")
  }

  func testOpeningVideoEntersWatchPage() {
    let appState = AppState(catalog: NativeVideo.samples)

    appState.openVideo("sample-native-shell-walkthrough")

    XCTAssertTrue(appState.isShowingWatchPage)
    XCTAssertEqual(appState.selectedVideoID, "sample-native-shell-walkthrough")
  }

  func testSelectingSectionLeavesWatchPage() {
    let appState = AppState(catalog: NativeVideo.samples)
    appState.openVideo("sample-native-shell-walkthrough")

    appState.selectSection(.subscriptions)

    XCTAssertFalse(appState.isShowingWatchPage)
    XCTAssertEqual(appState.currentSection, .subscriptions)
  }

  func testApplyingSnapshotKeepsPinnedWatchVideoOpenWhenFeedTemporarilyDropsIt() {
    let appState = AppState(
      catalog: [
        makeVideo(
          id: "channel-a:video-1",
          backendVideoID: "video-1",
          channelKey: "channel-a",
          title: "Video 1",
          channelName: "Channel A",
          sections: [.home]
        )
      ]
    )
    appState.openVideo("channel-a:video-1")

    let emptySnapshot = NativeBrowseSnapshot(
      generatedAt: 2,
      sections: NativeBrowseSections(home: [], subscriptions: [], library: [], studio: [], diagnostics: []),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0)
    )

    appState.applySnapshot(emptySnapshot)

    XCTAssertTrue(appState.isShowingWatchPage)
    XCTAssertEqual(appState.selectedVideoID, "channel-a:video-1")
    XCTAssertEqual(appState.selectedVideo?.id, "channel-a:video-1")
  }

  func testClosingWatchPageWhilePlaybackIsActiveLeavesMiniPlayerAvailable() {
    let appState = AppState(catalog: NativeVideo.samples)

    appState.openVideo("sample-native-shell-walkthrough")
    appState.playSelectedPreview()
    appState.closeWatchPage()

    XCTAssertFalse(appState.isShowingWatchPage)
    XCTAssertEqual(appState.miniPlayerVideo?.id, "sample-native-shell-walkthrough")
  }

  func testSelectingSectionWhilePlaybackIsActiveKeepsMiniPlayerPinned() {
    let appState = AppState(catalog: NativeVideo.samples)

    appState.openVideo("sample-native-shell-walkthrough")
    appState.playSelectedPreview()
    appState.selectSection(.subscriptions)

    XCTAssertFalse(appState.isShowingWatchPage)
    XCTAssertEqual(appState.currentSection, .subscriptions)
    XCTAssertEqual(appState.miniPlayerVideo?.id, "sample-native-shell-walkthrough")
  }

  func testSelectingEmptySectionWhilePlaybackIsActiveKeepsMiniPlayerAndPlaybackState() {
    let appState = AppState(
      catalog: [
        makeVideo(
          id: "channel-a:video-1",
          backendVideoID: "video-1",
          channelKey: "channel-a",
          title: "Video 1",
          channelName: "Channel A",
          sections: [.home]
        )
      ]
    )

    appState.openVideo("channel-a:video-1")
    appState.playSelectedPreview()
    appState.selectSection(.diagnostics)

    XCTAssertFalse(appState.isShowingWatchPage)
    XCTAssertNil(appState.selectedVideoID)
    XCTAssertEqual(appState.miniPlayerVideo?.id, "channel-a:video-1")
    XCTAssertTrue(appState.isPlayingPreview)
  }

  func testNativeAVPlayerViewShowsBuiltInPlaybackControlsByDefault() {
    let hostingView = NSHostingView(rootView: NativeAVPlayerView(player: AVPlayer()))
    hostingView.frame = CGRect(x: 0, y: 0, width: 320, height: 180)
    hostingView.layoutSubtreeIfNeeded()

    let playerView = findSubview(in: hostingView, ofType: AVPlayerView.self)

    XCTAssertNotNil(playerView)
    XCTAssertEqual(playerView?.controlsStyle, .default)
    XCTAssertTrue(playerView?.showsFullScreenToggleButton ?? false)
  }

  func testNativeAVPlayerViewCanHideBuiltInPlaybackControls() {
    let hostingView = NSHostingView(rootView: NativeAVPlayerView(player: AVPlayer(), hidesControls: true))
    hostingView.frame = CGRect(x: 0, y: 0, width: 320, height: 180)
    hostingView.layoutSubtreeIfNeeded()

    let playerView = findSubview(in: hostingView, ofType: AVPlayerView.self)

    XCTAssertNotNil(playerView)
    XCTAssertEqual(playerView?.controlsStyle, .none)
    XCTAssertFalse(playerView?.showsFullScreenToggleButton ?? true)
  }

  func testSuccessfulBootstrapLeavesDiagnosticsAndReturnsToHome() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(
            id: "channel-a:home-1",
            backendVideoID: "home-1",
            channelKey: "channel-a",
            title: "Home 1",
            channelName: "Channel A",
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

    appState.selectSection(.diagnostics)
    appState.setError("Boot failed")
    appState.applySnapshot(snapshot)
    appState.settleAfterSuccessfulBootstrap()

    XCTAssertEqual(appState.currentSection, .home)
    XCTAssertEqual(appState.selectedVideo?.title, "Home 1")
    XCTAssertNil(appState.lastErrorMessage)
  }

  func testSearchResultsOverrideSectionVideosUntilCleared() {
    let appState = AppState(catalog: NativeVideo.samples)
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

  func testSectionCountsReflectAppliedSnapshot() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(id: "channel-a:home-1", backendVideoID: "home-1", channelKey: "channel-a", title: "Home 1", channelName: "Channel A", sections: [.home]),
          makeVideo(id: "channel-b:home-2", backendVideoID: "home-2", channelKey: "channel-b", title: "Home 2", channelName: "Channel B", sections: [.home]),
        ],
        subscriptions: [
          makeVideo(id: "channel-a:sub-1", backendVideoID: "sub-1", channelKey: "channel-a", title: "Sub 1", channelName: "Channel A", sections: [.subscriptions]),
        ],
        library: [
          makeVideo(id: "channel-c:lib-1", backendVideoID: "lib-1", channelKey: "channel-c", title: "Lib 1", channelName: "Channel C", sections: [.library]),
        ],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 2, subscriptionCount: 1, libraryCount: 1, channelCount: 3)
    )

    appState.applySnapshot(snapshot)

    XCTAssertEqual(appState.videoCount(for: .home), 2)
    XCTAssertEqual(appState.videoCount(for: .subscriptions), 1)
    XCTAssertEqual(appState.videoCount(for: .library), 1)
    XCTAssertEqual(appState.videoCount(for: .studio), 0)
  }

  func testBrowseStateTracksIdentityAndSubscriptionFlags() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [makeVideo(id: "channel-b:home-1", backendVideoID: "home-1", channelKey: "channel-b", title: "B1", channelName: "Channel B", sections: [.home])],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 0, libraryCount: 0, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: ["channel-b"],
        identityChannelKeys: ["channel-a"],
        activeIdentityName: "Channel A",
        activeIdentityChannelKey: "channel-a",
        activeChannelPublished: true
      )
    )

    appState.applySnapshot(snapshot)

    XCTAssertTrue(appState.hasActiveIdentity)
    XCTAssertEqual(appState.activeIdentityName, "Channel A")
    XCTAssertTrue(appState.activeChannelPublished)
    XCTAssertTrue(appState.ownsChannel("channel-a"))
    XCTAssertFalse(appState.ownsChannel("channel-b"))
    XCTAssertTrue(appState.isSubscribed(to: "channel-b"))
    XCTAssertFalse(appState.isSubscribed(to: "channel-c"))
  }

  func testChannelPageStateOpensAndClosesWithoutDroppingBrowseSelection() {
    let appState = AppState(catalog: NativeVideo.samples)
    let profile = NativeChannelProfile(
      channelKey: "channel-viewer",
      publicBeeKey: nil,
      avatarURL: nil,
      name: "Viewer Channel",
      description: "A channel opened from browse.",
      videoCount: 3,
      role: .viewer,
      isSubscribed: true,
      isPublished: false
    )
    let priorSelection = appState.selectedVideoID

    appState.openChannelPage(profile: profile, videos: [
      makeVideo(
        id: "channel-viewer:video-1",
        backendVideoID: "video-1",
        channelKey: "channel-viewer",
        title: "Viewer Video",
        channelName: "Viewer Channel",
        sections: [.home]
      )
    ])

    XCTAssertTrue(appState.isShowingChannelPage)
    XCTAssertEqual(appState.channelPageProfile?.channelKey, "channel-viewer")
    XCTAssertEqual(appState.channelPageVideos.count, 1)

    appState.closeChannelPage()

    XCTAssertFalse(appState.isShowingChannelPage)
    XCTAssertNil(appState.channelPageProfile)
    XCTAssertEqual(appState.selectedVideoID, priorSelection)
  }

  func testChannelProfileDerivesOwnerAndViewerModesFromBrowseState() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(home: [], subscriptions: [], library: [], studio: [], diagnostics: []),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0),
      state: NativeBrowseState(
        subscriptionChannelKeys: ["channel-viewer"],
        identityChannelKeys: ["channel-owner"],
        activeIdentityName: "Owner",
        activeIdentityChannelKey: "channel-owner",
        activeChannelPublished: true
      )
    )
    appState.applySnapshot(snapshot)

    let ownerProfile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: nil,
      name: "Owner Channel",
      description: "Owned channel",
      videoCount: 4
    )
    let viewerProfile = appState.makeChannelProfile(
      channelKey: "channel-viewer",
      publicBeeKey: nil,
      name: "Viewer Channel",
      description: "Subscribed channel",
      videoCount: 2
    )

    XCTAssertEqual(ownerProfile.role, .owner)
    XCTAssertTrue(ownerProfile.isPublished)
    XCTAssertFalse(ownerProfile.isSubscribed)
    XCTAssertEqual(viewerProfile.role, .viewer)
    XCTAssertTrue(viewerProfile.isSubscribed)
    XCTAssertFalse(viewerProfile.isPublished)
  }

  func testSelectingSectionClosesOpenChannelPage() {
    let appState = AppState(catalog: NativeVideo.samples)
    let profile = NativeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      avatarURL: URL(string: "https://example.com/avatar.png"),
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 1,
      role: .owner,
      isSubscribed: false,
      isPublished: true
    )

    appState.openChannelPage(profile: profile, videos: [])
    XCTAssertTrue(appState.isShowingChannelPage)

    appState.selectSection(.home)

    XCTAssertFalse(appState.isShowingChannelPage)
    XCTAssertNil(appState.channelPageProfile)
  }

  func testStudioWorkspaceTracksLoadedOwnerProfileAndSelection() {
    let appState = AppState(catalog: NativeVideo.samples)
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [
          makeVideo(
            id: "studio:video-1",
            backendVideoID: "video-1",
            channelKey: "channel-owner",
            title: "Studio Video 1",
            channelName: "Owner Channel",
            sections: [.studio]
          )
        ],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["channel-owner"],
        activeIdentityName: "Owner Channel",
        activeIdentityChannelKey: "channel-owner",
        activeChannelPublished: true
      )
    )
    appState.applySnapshot(snapshot)

    let loadedProfile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      avatarURL: "https://example.com/avatar.png",
      name: "Owner Channel",
      description: "Loaded studio profile",
      videoCount: 2
    )
    let loadedVideos = [
      makeVideo(
        id: "studio:video-2",
        backendVideoID: "video-2",
        channelKey: "channel-owner",
        title: "Studio Video 2",
        channelName: "Owner Channel",
        sections: [.studio]
      )
    ]

    appState.updateStudioWorkspace(profile: loadedProfile, videos: loadedVideos)

    XCTAssertEqual(appState.studioWorkspaceProfile?.avatarURL?.absoluteString, "https://example.com/avatar.png")
    XCTAssertEqual(appState.studioWorkspaceVideos.count, 1)
    XCTAssertEqual(appState.selectedStudioVideoID, "studio:video-2")
    XCTAssertEqual(appState.studioEditingVideo?.id, "studio:video-2")
  }

  func testStudioUploadJobTracksProgressAndFailureState() {
    let appState = AppState()

    appState.beginStudioUpload(fileName: "clip.mov", title: "Clip")
    appState.applyUploadProgress(
      NativeBridgeUploadProgressEvent(
        videoId: "",
        progress: 42,
        bytesUploaded: 420,
        totalBytes: 1000,
        speed: 84,
        eta: 7
      )
    )

    XCTAssertEqual(appState.activeStudioUploadJob?.title, "Clip")
    XCTAssertEqual(appState.activeStudioUploadJob?.state, .uploading)
    XCTAssertEqual(appState.activeStudioUploadJob?.progress, 42)
    XCTAssertEqual(appState.activeStudioUploadJob?.bytesUploaded, 420)

    appState.failStudioUpload(message: "Network lost")

    XCTAssertEqual(appState.activeStudioUploadJob?.state, .failed)
    XCTAssertEqual(appState.activeStudioUploadJob?.errorMessage, "Network lost")
  }

  func testRetryableStudioUploadFileURLRequiresFailedJobAndExistingSourcePath() {
    let appState = AppState()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let fileURL = root.appendingPathComponent("retry-upload.mp4")

    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: fileURL.path, contents: Data())
    defer { try? FileManager.default.removeItem(at: root) }

    appState.beginStudioUpload(
      fileName: "retry-upload.mp4",
      title: "Retry Upload",
      sourceFilePath: fileURL.path
    )
    XCTAssertNil(appState.retryableStudioUploadFileURL())

    appState.failStudioUpload(message: "Network lost")

    XCTAssertEqual(appState.retryableStudioUploadFileURL(), fileURL)
  }

  func testCompletingStudioUploadSelectsLatestSuccessfulVideoForEditing() {
    let appState = AppState()
    let newestVideo = makeVideo(
      id: "channel-owner:video-new",
      backendVideoID: "video-new",
      channelKey: "channel-owner",
      title: "Newest Upload",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )
    let olderVideo = makeVideo(
      id: "channel-owner:video-old",
      backendVideoID: "video-old",
      channelKey: "channel-owner",
      title: "Older Upload",
      channelName: "Owner Channel",
      sections: [.studio]
    )

    appState.applySnapshot(
      NativeBrowseSnapshot(
        generatedAt: 1,
        sections: NativeBrowseSections(
          home: [],
          subscriptions: [],
          library: [newestVideo],
          studio: [newestVideo, olderVideo],
          diagnostics: []
        ),
        stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 1, channelCount: 1)
      )
    )
    appState.beginStudioUpload(fileName: "newest.mov", title: "Newest Upload")

    appState.completeStudioUpload(with: newestVideo)

    XCTAssertEqual(appState.activeStudioUploadJob?.state, .completed)
    XCTAssertEqual(appState.studioEditingVideo?.id, newestVideo.id)
    XCTAssertEqual(appState.selectedStudioVideoID, newestVideo.id)
  }

  func testCompletedStudioUploadJobIsHiddenFromStudioStatusCard() {
    let appState = AppState()
    let uploadedVideo = makeVideo(
      id: "channel-owner:video-new",
      backendVideoID: "video-new",
      channelKey: "channel-owner",
      title: "Newest Upload",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )

    appState.beginStudioUpload(fileName: "newest.mov", title: "Newest Upload")
    appState.completeStudioUpload(with: uploadedVideo)

    XCTAssertEqual(appState.activeStudioUploadJob?.state, .completed)
    XCTAssertNil(appState.presentedStudioUploadJob)
  }

  func testResolveUploadedStudioVideoPrefersProgressVideoIDThenFirstOwnerTitleMatch() {
    let activeIdentityChannelKey = "channel-owner"
    let matchingVideo = makeVideo(
      id: "channel-owner:video-2",
      backendVideoID: "video-2",
      channelKey: activeIdentityChannelKey,
      title: "Uploaded Clip",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )
    let fallbackVideo = makeVideo(
      id: "channel-owner:video-3",
      backendVideoID: "video-3",
      channelKey: activeIdentityChannelKey,
      title: "Uploaded Clip",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [matchingVideo],
        studio: [matchingVideo, fallbackVideo],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 1, channelCount: 1)
    )
    let jobWithVideoID = NativeUploadJob(
      id: "active-upload",
      fileName: "uploaded-clip.mp4",
      title: "Uploaded Clip",
      createdAt: Date(),
      sourceFilePath: "/tmp/uploaded-clip.mp4",
      videoID: "video-2",
      progress: 100,
      bytesUploaded: nil,
      totalBytes: nil,
      speed: nil,
      eta: nil,
      state: .processing,
      errorMessage: nil
    )
    let jobWithoutVideoID = NativeUploadJob(
      id: "active-upload",
      fileName: "uploaded-clip.mp4",
      title: "Uploaded Clip",
      createdAt: Date(),
      sourceFilePath: "/tmp/uploaded-clip.mp4",
      videoID: nil,
      progress: 100,
      bytesUploaded: nil,
      totalBytes: nil,
      speed: nil,
      eta: nil,
      state: .processing,
      errorMessage: nil
    )

    XCTAssertEqual(
      HostBridgeService.resolveUploadedStudioVideo(
        snapshot: snapshot,
        uploadJob: jobWithVideoID,
        activeIdentityChannelKey: activeIdentityChannelKey
      )?.backendVideoID,
      "video-2"
    )

    XCTAssertEqual(
      HostBridgeService.resolveUploadedStudioVideo(
        snapshot: snapshot,
        uploadJob: jobWithoutVideoID,
        activeIdentityChannelKey: activeIdentityChannelKey
      )?.id,
      matchingVideo.id
    )
  }

  func testStudioWorkspaceRefreshKeepsCurrentEditingSelectionWhenVideoStillExists() {
    let appState = AppState()
    let firstVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "First Video",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let secondVideo = makeVideo(
      id: "channel-owner:video-2",
      backendVideoID: "video-2",
      channelKey: "channel-owner",
      title: "Second Video",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let profile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 2
    )

    appState.updateStudioWorkspace(profile: profile, videos: [firstVideo, secondVideo])
    appState.selectStudioVideoForEditing(secondVideo.id)

    appState.updateStudioWorkspace(
      profile: profile,
      videos: [
        firstVideo,
        secondVideo.updating(title: "Second Video Updated")
      ]
    )

    XCTAssertEqual(appState.selectedStudioVideoID, secondVideo.id)
    XCTAssertEqual(appState.studioEditingVideo?.title, "Second Video Updated")
  }

  func testLoadedEmptyStudioWorkspaceClearsSnapshotFallbackAndEditingSelection() {
    let appState = AppState()
    let snapshotVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "Snapshot Video",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [snapshotVideo],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["channel-owner"],
        activeIdentityName: "Owner Channel",
        activeIdentityChannelKey: "channel-owner",
        activeChannelPublished: true
      )
    )
    let profile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 1
    )

    appState.applySnapshot(snapshot)
    appState.selectStudioVideoForEditing(snapshotVideo.id)
    appState.updateStudioWorkspace(profile: profile, videos: [])

    XCTAssertTrue(appState.studioWorkspaceVideos.isEmpty)
    XCTAssertEqual(appState.studioWorkspaceProfile?.videoCount, 0)
    XCTAssertNil(appState.selectedStudioVideoID)
    XCTAssertNil(appState.studioEditingVideo)
  }

  func testStudioWorkspaceProfileUsesLoadedWorkspaceVideoCount() {
    let appState = AppState()
    let loadedVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "Loaded Video",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let profile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 4
    )

    appState.updateStudioWorkspace(profile: profile, videos: [loadedVideo])

    XCTAssertEqual(appState.studioWorkspaceVideos.map(\.id), [loadedVideo.id])
    XCTAssertEqual(appState.studioWorkspaceProfile?.videoCount, 1)
  }

  func testApplyingSnapshotForDifferentActiveIdentityClearsPreviouslyLoadedStudioWorkspace() {
    let appState = AppState()
    let loadedVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "Owner Video",
      channelName: "Owner Channel",
      sections: [.studio]
    )
    let loadedProfile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 1
    )
    let snapshotVideo = makeVideo(
      id: "channel-next:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-next",
      title: "Next Identity Video",
      channelName: "Next Channel",
      sections: [.studio]
    )
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 2,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [snapshotVideo],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["channel-next"],
        activeIdentityName: "Next Channel",
        activeIdentityChannelKey: "channel-next",
        activeChannelPublished: false
      )
    )

    appState.updateStudioWorkspace(profile: loadedProfile, videos: [loadedVideo])
    appState.selectStudioVideoForEditing(loadedVideo.id)
    appState.applySnapshot(snapshot)

    XCTAssertEqual(appState.studioWorkspaceVideos.map(\.id), [snapshotVideo.id])
    XCTAssertEqual(appState.selectedStudioVideoID, snapshotVideo.id)
    XCTAssertEqual(appState.studioEditingVideo?.id, snapshotVideo.id)
    XCTAssertEqual(appState.studioWorkspaceProfile?.channelKey, "channel-next")
  }

  func testUpsertOwnedVideoRefreshesStudioWorkspaceAndChannelPageCopies() {
    let appState = AppState()
    let originalVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "Original Title",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )
    let updatedVideo = NativeVideo(
      id: originalVideo.id,
      backendVideoID: originalVideo.backendVideoID,
      channelKey: originalVideo.channelKey,
      title: "Updated Title",
      channelName: originalVideo.channelName,
      durationText: originalVideo.durationText,
      summary: "Updated summary",
      tags: originalVideo.tags,
      accentHex: originalVideo.accentHex,
      sections: originalVideo.sections
    )
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [originalVideo],
        studio: [originalVideo],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 1, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["channel-owner"],
        activeIdentityName: "Owner Channel",
        activeIdentityChannelKey: "channel-owner",
        activeChannelPublished: true
      )
    )
    appState.applySnapshot(snapshot)
    let profile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 1
    )
    appState.updateStudioWorkspace(profile: profile, videos: [originalVideo])
    appState.openChannelPage(profile: profile, videos: [originalVideo])
    appState.selectStudioVideoForEditing(originalVideo.id)

    appState.upsertOwnedVideo(updatedVideo)

    XCTAssertEqual(appState.videos(for: .studio).first?.title, "Updated Title")
    XCTAssertEqual(appState.videos(for: .library).first?.title, "Updated Title")
    XCTAssertEqual(appState.studioWorkspaceVideos.first?.title, "Updated Title")
    XCTAssertEqual(appState.channelPageVideos.first?.title, "Updated Title")
    XCTAssertEqual(appState.studioEditingVideo?.title, "Updated Title")
  }

  func testRemoveOwnedVideoPrunesWorkspaceCopiesAndAdvancesSelection() {
    let appState = AppState()
    let firstVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "First Video",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )
    let secondVideo = makeVideo(
      id: "channel-owner:video-2",
      backendVideoID: "video-2",
      channelKey: "channel-owner",
      title: "Second Video",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [firstVideo, secondVideo],
        studio: [firstVideo, secondVideo],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 2, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["channel-owner"],
        activeIdentityName: "Owner Channel",
        activeIdentityChannelKey: "channel-owner",
        activeChannelPublished: true
      )
    )
    appState.applySnapshot(snapshot)
    let profile = appState.makeChannelProfile(
      channelKey: "channel-owner",
      publicBeeKey: "bee-owner",
      name: "Owner Channel",
      description: "Owner profile",
      videoCount: 2
    )
    appState.updateStudioWorkspace(profile: profile, videos: [firstVideo, secondVideo])
    appState.openChannelPage(profile: profile, videos: [firstVideo, secondVideo])
    appState.selectStudioVideoForEditing(firstVideo.id)

    appState.removeOwnedVideo(firstVideo)

    XCTAssertEqual(appState.videos(for: .studio).map(\.id), [secondVideo.id])
    XCTAssertEqual(appState.videos(for: .library).map(\.id), [secondVideo.id])
    XCTAssertEqual(appState.studioWorkspaceVideos.map(\.id), [secondVideo.id])
    XCTAssertEqual(appState.channelPageVideos.map(\.id), [secondVideo.id])
    XCTAssertEqual(appState.selectedStudioVideoID, secondVideo.id)
    XCTAssertEqual(appState.studioEditingVideo?.id, secondVideo.id)
    XCTAssertEqual(appState.channelPageProfile?.videoCount, 1)
    XCTAssertEqual(appState.studioWorkspaceProfile?.videoCount, 1)
  }

  func testNativeVideoUpdatingPreservesExistingFields() {
    let originalVideo = makeVideo(
      id: "channel-owner:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-owner",
      title: "Original Title",
      channelName: "Owner Channel",
      sections: [.studio, .library]
    )

    let updatedVideo = originalVideo.updating(title: "Updated Title", summary: "Updated Summary")

    XCTAssertEqual(updatedVideo.id, originalVideo.id)
    XCTAssertEqual(updatedVideo.backendVideoID, originalVideo.backendVideoID)
    XCTAssertEqual(updatedVideo.channelKey, originalVideo.channelKey)
    XCTAssertEqual(updatedVideo.title, "Updated Title")
    XCTAssertEqual(updatedVideo.summary, "Updated Summary")
    XCTAssertEqual(updatedVideo.sections, originalVideo.sections)
    XCTAssertEqual(updatedVideo.path, originalVideo.path)
    XCTAssertEqual(updatedVideo.blobId, originalVideo.blobId)
  }

  func testHostBridgeUploadProgressEventUpdatesObservedStudioState() {
    let appState = AppState()
    let hostBridge = HostBridgeService()

    appState.beginStudioUpload(fileName: "event.mov", title: "Event Upload")
    hostBridge.applyUploadProgressEvent(
      NativeBridgeUploadProgressEvent(
        videoId: "",
        progress: 64,
        bytesUploaded: 640,
        totalBytes: 1000,
        speed: 32,
        eta: 11
      ),
      to: appState
    )

    XCTAssertEqual(appState.activeStudioUploadJob?.state, .uploading)
    XCTAssertEqual(appState.activeStudioUploadJob?.progress, 64)
    XCTAssertEqual(appState.activeStudioUploadJob?.speed, 32)
  }

  func testPreferredVideoUploadDropURLPrefersFirstSupportedVideoFile() {
    let urls = [
      URL(fileURLWithPath: "/tmp/poster.png"),
      URL(fileURLWithPath: "/tmp/clip.MP4"),
      URL(fileURLWithPath: "/tmp/backup.mov"),
    ]

    let resolved = HostBridgeService.preferredVideoUploadDropURL(from: urls)

    XCTAssertEqual(resolved?.lastPathComponent, "clip.MP4")
  }

  func testIsSupportedVideoUploadURLRejectsDirectoriesAndImages() {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let directoryURL = root.appendingPathComponent("folder", isDirectory: true)
    let imageURL = root.appendingPathComponent("poster.png")
    let videoURL = root.appendingPathComponent("upload.webm")

    try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: imageURL.path, contents: Data())
    FileManager.default.createFile(atPath: videoURL.path, contents: Data())
    defer { try? fileManager.removeItem(at: root) }

    XCTAssertFalse(
      HostBridgeService.isSupportedVideoUploadURL(
        directoryURL,
        fileManager: fileManager
      )
    )
    XCTAssertFalse(
      HostBridgeService.isSupportedVideoUploadURL(
        imageURL,
        fileManager: fileManager
      )
    )
    XCTAssertTrue(
      HostBridgeService.isSupportedVideoUploadURL(
        videoURL,
        fileManager: fileManager
      )
    )
  }

  func testRelatedVideosPreferSameChannelAndExcludeSelection() {
    let appState = AppState()
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(id: "channel-a:home-1", backendVideoID: "home-1", channelKey: "channel-a", title: "A1", channelName: "Channel A", sections: [.home]),
          makeVideo(id: "channel-a:home-2", backendVideoID: "home-2", channelKey: "channel-a", title: "A2", channelName: "Channel A", sections: [.home]),
          makeVideo(id: "channel-b:home-1", backendVideoID: "home-1", channelKey: "channel-b", title: "B1", channelName: "Channel B", sections: [.home]),
          makeVideo(id: "channel-c:home-1", backendVideoID: "home-1", channelKey: "channel-c", title: "C1", channelName: "Channel C", sections: [.home]),
        ],
        subscriptions: [],
        library: [
          makeVideo(id: "channel-a:lib-1", backendVideoID: "lib-1", channelKey: "channel-a", title: "A Library", channelName: "Channel A", sections: [.library]),
        ],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 4, subscriptionCount: 0, libraryCount: 1, channelCount: 3)
    )

    appState.applySnapshot(snapshot)
    appState.selectVideo("channel-a:home-1")

    XCTAssertEqual(
      appState.relatedVideos(limit: 4).map(\.id),
      [
        "channel-a:home-2",
        "channel-a:lib-1",
        "channel-b:home-1",
        "channel-c:home-1",
      ]
    )
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
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 0, libraryCount: 0, channelCount: 1),
      state: NativeBrowseState(
        subscriptionChannelKeys: ["channel-b"],
        identityChannelKeys: ["channel-a"],
        activeIdentityName: "Channel A",
        activeIdentityChannelKey: "channel-a",
        activeChannelPublished: true
      )
    )

    let response = NativeBridgeBootstrapResponse(
      blobServerPort: 64369,
      protocolVersion: 3,
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
      videoId: "video-1",
      videoPath: "/videos/video-1.mp4",
      blobId: "0:128:0:4096",
      blobsCoreKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      mimeType: "video/mp4"
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
          thumbnailURL: URL(string: "https://example.com/thumb.jpg"),
          path: "/videos/video-1.mp4",
          blobId: "0:128:0:4096",
          blobsCoreKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          mimeType: "video/mp4",
          width: 1080,
          height: 1920
        )
      ]
    )

    let encoded = try NativeBridgePayload.encode(NativeBridgeSearchResponseCodec(), value: response)
    let decoded = try NativeBridgePayload.decode(NativeBridgeSearchResponseCodec(), from: encoded)

    XCTAssertEqual(decoded, response)
  }

  func testNativeVideoPresentationStyleClassifiesPortraitShorts() {
    let portraitVideo = NativeVideo(
      id: "channel-a:portrait-1",
      backendVideoID: "portrait-1",
      channelKey: "channel-a",
      title: "Portrait Short",
      channelName: "Channel A",
      durationText: "0:45",
      summary: "Portrait short-form video.",
      tags: ["short"],
      accentHex: "#FF7A59",
      sections: [.home],
      width: 1080,
      height: 1920
    )

    XCTAssertEqual(portraitVideo.presentationStyle, .portrait)
    XCTAssertEqual(portraitVideo.displayAspectRatio, 9.0 / 16.0, accuracy: 0.0001)
  }

  func testBrowseThumbnailLayoutKeepsOneShellAcrossOrientations() {
    let landscapeVideo = NativeVideo(
      id: "channel-a:landscape-1",
      backendVideoID: "landscape-1",
      channelKey: "channel-a",
      title: "Landscape",
      channelName: "Channel A",
      durationText: "4:20",
      summary: "Landscape video.",
      tags: [],
      accentHex: "#4B65FF",
      sections: [.home],
      width: 1920,
      height: 1080
    )
    let portraitVideo = NativeVideo(
      id: "channel-a:portrait-2",
      backendVideoID: "portrait-2",
      channelKey: "channel-a",
      title: "Portrait",
      channelName: "Channel A",
      durationText: "0:34",
      summary: "Portrait video.",
      tags: [],
      accentHex: "#FF7A59",
      sections: [.home],
      width: 1080,
      height: 1920
    )

    let landscapeLayout = NativeThumbnailLayout(video: landscapeVideo, context: .browseGrid)
    let portraitLayout = NativeThumbnailLayout(video: portraitVideo, context: .browseGrid)

    XCTAssertNil(landscapeLayout.fixedSize)
    XCTAssertNil(portraitLayout.fixedSize)
    XCTAssertEqual(landscapeLayout.shellAspectRatio, portraitLayout.shellAspectRatio, accuracy: 0.0001)
    XCTAssertEqual(landscapeLayout.mediaStyle, .fillShell)
    XCTAssertEqual(portraitLayout.mediaStyle, .fitInsideShell)
  }

  func testSearchThumbnailLayoutUsesSharedFixedShellForPortraitVideos() {
    let landscapeVideo = NativeVideo(
      id: "channel-a:landscape-2",
      backendVideoID: "landscape-2",
      channelKey: "channel-a",
      title: "Landscape",
      channelName: "Channel A",
      durationText: "5:00",
      summary: "Landscape video.",
      tags: [],
      accentHex: "#12B886",
      sections: [.home],
      width: 1920,
      height: 1080
    )
    let portraitVideo = NativeVideo(
      id: "channel-a:portrait-3",
      backendVideoID: "portrait-3",
      channelKey: "channel-a",
      title: "Portrait",
      channelName: "Channel A",
      durationText: "0:18",
      summary: "Portrait video.",
      tags: ["short"],
      accentHex: "#E64980",
      sections: [.home],
      width: 1080,
      height: 1920
    )

    let landscapeLayout = NativeThumbnailLayout(video: landscapeVideo, context: .searchRow)
    let portraitLayout = NativeThumbnailLayout(video: portraitVideo, context: .searchRow)

    XCTAssertEqual(landscapeLayout.fixedSize, CGSize(width: 300, height: 168))
    XCTAssertEqual(portraitLayout.fixedSize, landscapeLayout.fixedSize)
    XCTAssertEqual(landscapeLayout.mediaStyle, .fillShell)
    XCTAssertEqual(portraitLayout.mediaStyle, .fitInsideShell)
    XCTAssertGreaterThan(portraitLayout.mediaPadding, 0)
  }

  func testThumbnailLayoutUsesContainedMediaWhenAspectMetadataIsMissing() {
    let metadataSparseVideo = NativeVideo(
      id: "channel-a:unknown-1",
      backendVideoID: "unknown-1",
      channelKey: "channel-a",
      title: "Unknown Aspect",
      channelName: "Channel A",
      durationText: "1:00",
      summary: "No width or height metadata.",
      tags: [],
      accentHex: "#F59F00",
      sections: [.home]
    )

    let browseLayout = NativeThumbnailLayout(video: metadataSparseVideo, context: .browseGrid)
    let searchLayout = NativeThumbnailLayout(video: metadataSparseVideo, context: .searchRow)

    XCTAssertEqual(browseLayout.mediaStyle, .fitInsideShell)
    XCTAssertEqual(searchLayout.mediaStyle, .fitInsideShell)
    XCTAssertEqual(browseLayout.mediaPadding, 0)
    XCTAssertEqual(searchLayout.mediaPadding, 0)
  }

  func testMiniPlayerLayoutSnapsFloatingPlayerIntoVisibleBounds() {
    let frame = MiniPlayerLayout.snapFrame(
      proposedOrigin: CGPoint(x: 1400, y: -40),
      playerSize: CGSize(width: 360, height: 640),
      containerSize: CGSize(width: 1280, height: 900),
      margin: 24
    )

    XCTAssertEqual(frame.origin.x, 896, accuracy: 0.5)
    XCTAssertEqual(frame.origin.y, 24, accuracy: 0.5)
    XCTAssertEqual(frame.size.width, 360, accuracy: 0.5)
    XCTAssertEqual(frame.size.height, 640, accuracy: 0.5)
  }

  func testWatchPlaybackLayoutKeepsPortraitHeroNarrowAndTall() {
    let portraitVideo = NativeVideo(
      id: "channel-a:portrait-watch-1",
      backendVideoID: "portrait-watch-1",
      channelKey: "channel-a",
      title: "Portrait Watch",
      channelName: "Channel A",
      durationText: "0:41",
      summary: "Portrait playback should use a narrow stage.",
      tags: ["short"],
      accentHex: "#E64980",
      sections: [.home],
      width: 1080,
      height: 1920
    )

    let size = WatchPlaybackLayout.preferredSize(
      for: portraitVideo,
      containerSize: CGSize(width: 1440, height: 900)
    )

    XCTAssertEqual(size.width, 351.9, accuracy: 0.5)
    XCTAssertEqual(size.height, 625.6, accuracy: 0.5)
  }

  func testWatchPlaybackLayoutKeepsLandscapeHeroWide() {
    let landscapeVideo = NativeVideo(
      id: "channel-a:landscape-watch-1",
      backendVideoID: "landscape-watch-1",
      channelKey: "channel-a",
      title: "Landscape Watch",
      channelName: "Channel A",
      durationText: "8:10",
      summary: "Landscape playback should keep the wide stage.",
      tags: [],
      accentHex: "#4B65FF",
      sections: [.home],
      width: 1920,
      height: 1080
    )

    let size = WatchPlaybackLayout.preferredSize(
      for: landscapeVideo,
      containerSize: CGSize(width: 1440, height: 900)
    )

    XCTAssertEqual(size.width, 1102.222, accuracy: 0.5)
    XCTAssertEqual(size.height, 620, accuracy: 0.5)
  }

  func testWatchPlaybackLayoutUsesContainedPosterForPortraitVideos() {
    let portraitVideo = NativeVideo(
      id: "channel-a:portrait-watch-2",
      backendVideoID: "portrait-watch-2",
      channelKey: "channel-a",
      title: "Portrait Watch Poster",
      channelName: "Channel A",
      durationText: "0:20",
      summary: "Portrait poster should be contained.",
      tags: ["short"],
      accentHex: "#FF7A59",
      sections: [.home],
      width: 1080,
      height: 1920
    )
    let landscapeVideo = NativeVideo(
      id: "channel-a:landscape-watch-2",
      backendVideoID: "landscape-watch-2",
      channelKey: "channel-a",
      title: "Landscape Watch Poster",
      channelName: "Channel A",
      durationText: "5:00",
      summary: "Landscape poster can fill the stage.",
      tags: [],
      accentHex: "#12B886",
      sections: [.home],
      width: 1920,
      height: 1080
    )

    XCTAssertTrue(WatchPlaybackLayout.usesContainedPoster(for: portraitVideo))
    XCTAssertFalse(WatchPlaybackLayout.usesContainedPoster(for: landscapeVideo))
  }

  func testPreferredBrowseSnapshotUsesCachedHomeWhenLiveFeedIsEmpty() {
    let cachedSnapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(
            id: "cached:video-1",
            backendVideoID: "video-1",
            channelKey: "cached-channel",
            title: "Cached Video",
            channelName: "Cached Channel",
            sections: [.home]
          )
        ],
        subscriptions: [
          makeVideo(
            id: "cached:sub-1",
            backendVideoID: "sub-1",
            channelKey: "cached-channel",
            title: "Cached Sub",
            channelName: "Cached Channel",
            sections: [.subscriptions]
          )
        ],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 1, libraryCount: 0, channelCount: 1)
    )

    let liveSnapshot = NativeBrowseSnapshot(
      generatedAt: 2,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["identity-channel"],
        activeIdentityName: "Native Identity",
        activeIdentityChannelKey: "identity-channel",
        activeChannelPublished: true
      )
    )

    let resolved = HostBridgeService.preferredBrowseSnapshot(
      liveSnapshot: liveSnapshot,
      cachedSnapshot: cachedSnapshot
    )

    XCTAssertEqual(resolved.sections.home.map(\.id), ["cached:video-1"])
    XCTAssertEqual(resolved.sections.subscriptions.map(\.id), ["cached:sub-1"])
    XCTAssertEqual(resolved.state.activeIdentityName, "Native Identity")
    XCTAssertEqual(resolved.stats.homeCount, 1)
    XCTAssertEqual(resolved.stats.subscriptionCount, 1)
  }

  func testManualFeedRefreshBypassesCachedHomeFallback() {
    let cachedSnapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(
            id: "cached:video-1",
            backendVideoID: "video-1",
            channelKey: "cached-channel",
            title: "Cached Video",
            channelName: "Cached Channel",
            sections: [.home]
          )
        ],
        subscriptions: [
          makeVideo(
            id: "cached:sub-1",
            backendVideoID: "sub-1",
            channelKey: "cached-channel",
            title: "Cached Sub",
            channelName: "Cached Channel",
            sections: [.subscriptions]
          )
        ],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 1, subscriptionCount: 1, libraryCount: 0, channelCount: 1)
    )

    let liveSnapshot = NativeBrowseSnapshot(
      generatedAt: 2,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["identity-channel"],
        activeIdentityName: "Native Identity",
        activeIdentityChannelKey: "identity-channel",
        activeChannelPublished: true
      )
    )

    let resolved = HostBridgeService.resolvedBrowseSnapshot(
      liveSnapshot: liveSnapshot,
      cachedSnapshot: cachedSnapshot,
      allowCachedFeedFallback: false
    )

    XCTAssertEqual(resolved.sections.home.map(\.id), [])
    XCTAssertEqual(resolved.sections.subscriptions.map(\.id), [])
    XCTAssertEqual(resolved.state.activeIdentityName, "Native Identity")
    XCTAssertEqual(resolved.stats.homeCount, 0)
    XCTAssertEqual(resolved.stats.subscriptionCount, 0)
  }

  func testSnapshotForPersistenceKeepsCachedHomeWhenLiveRefreshIsEmpty() {
    let cachedSnapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(
            id: "cached:video-1",
            backendVideoID: "video-1",
            channelKey: "cached-channel",
            title: "Cached Video",
            channelName: "Cached Channel",
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

    let liveSnapshot = NativeBrowseSnapshot(
      generatedAt: 2,
      sections: NativeBrowseSections(
        home: [],
        subscriptions: [],
        library: [],
        studio: [],
        diagnostics: []
      ),
      stats: NativeBrowseStats(homeCount: 0, subscriptionCount: 0, libraryCount: 0, channelCount: 0),
      state: NativeBrowseState(
        subscriptionChannelKeys: [],
        identityChannelKeys: ["identity-channel"],
        activeIdentityName: "Native Identity",
        activeIdentityChannelKey: "identity-channel",
        activeChannelPublished: true
      )
    )

    let persisted = HostBridgeService.snapshotForPersistence(
      liveSnapshot: liveSnapshot,
      cachedSnapshot: cachedSnapshot
    )

    XCTAssertEqual(persisted.sections.home.map(\.id), ["cached:video-1"])
    XCTAssertEqual(persisted.state.activeIdentityName, "Native Identity")
    XCTAssertEqual(persisted.stats.homeCount, 1)
  }

  func testBrowseSnapshotCacheRoundTripsThroughDisk() throws {
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let cacheURL = root.appendingPathComponent("browse-snapshot.json")
    let snapshot = NativeBrowseSnapshot(
      generatedAt: 1,
      sections: NativeBrowseSections(
        home: [
          makeVideo(
            id: "cached:video-1",
            backendVideoID: "video-1",
            channelKey: "cached-channel",
            title: "Cached Video",
            channelName: "Cached Channel",
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

    HostBridgeService.persistBrowseSnapshot(snapshot, to: cacheURL)
    let restored = HostBridgeService.loadCachedBrowseSnapshot(from: cacheURL)

    XCTAssertEqual(restored, snapshot)

    try? FileManager.default.removeItem(at: root)
  }

  func testPreferredStoragePathDefaultsToUnifiedHomeStore() {
    let homeRoot = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString, isDirectory: true)

    let resolved = HostBridgeService.preferredStoragePath(
      environment: [:],
      homeDirectory: homeRoot
    )

    XCTAssertEqual(resolved, homeRoot.appendingPathComponent(".peartube", isDirectory: true).path)
  }

  func testPreferredStoragePathHonorsExplicitEnvironmentOverride() {
    let homeRoot = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let override = "/tmp/peartube-explicit-override"

    let resolved = HostBridgeService.preferredStoragePath(
      environment: ["PEARTUBE_NATIVE_STORAGE_PATH": override],
      homeDirectory: homeRoot
    )

    XCTAssertEqual(resolved, override)
  }

  func testRecoverableNativeStoragePathMatchesContainerizedAppStore() {
    let homeRoot = URL(fileURLWithPath: "/Users/jd", isDirectory: true)
    let containerizedStore = homeRoot
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)

    XCTAssertTrue(
      HostBridgeService.isRecoverableNativeStoragePath(containerizedStore.path)
    )
  }

  func testRecoverableNativeStoragePathRejectsUnifiedHomeStore() {
    // ~/.peartube is shared with the Electrobun app — recovery must never
    // auto-archive it, even though it's now the default for the native app.
    let homeStore = URL(fileURLWithPath: "/Users/jd/.peartube", isDirectory: true)
    XCTAssertFalse(HostBridgeService.isRecoverableNativeStoragePath(homeStore.path))
  }

  func testNativeStoreRecoveryIsDisabledByDefault() {
    XCTAssertFalse(HostBridgeService.isNativeStoreRecoveryEnabled(environment: [:]))
    XCTAssertFalse(HostBridgeService.isNativeStoreRecoveryEnabled(environment: ["PEARTUBE_NATIVE_ALLOW_STORE_RECOVERY": "0"]))
  }

  func testNativeStoreRecoveryRequiresExplicitEnvironmentFlag() {
    XCTAssertTrue(HostBridgeService.isNativeStoreRecoveryEnabled(environment: ["PEARTUBE_NATIVE_ALLOW_STORE_RECOVERY": "1"]))
    XCTAssertTrue(HostBridgeService.isNativeStoreRecoveryEnabled(environment: ["PEARTUBE_NATIVE_ALLOW_STORE_RECOVERY": "true"]))
    XCTAssertFalse(HostBridgeService.isNativeStoreRecoveryEnabled(environment: ["PEARTUBE_NATIVE_ALLOW_STORE_RECOVERY": "unexpected"]))
  }

  func testIdentitylessBootstrapFailureCodeThreeAutoRecoveryIsEnabledForAppContainerStore() throws {
    let fileManager = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storage = root
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)
    let dbDirectory = storage.appendingPathComponent("db", isDirectory: true)

    try fileManager.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    try Data("CURRENT".utf8).write(to: dbDirectory.appendingPathComponent("CURRENT"))

    XCTAssertTrue(
      HostBridgeService.shouldAutoRecoverIdentitylessBootstrapFailure(
        storagePath: storage.path,
        message: "3",
        fileManager: fileManager
      )
    )

    try? fileManager.removeItem(at: root)
  }

  func testIdentitylessBootstrapFailureCodeThreeAutoRecoveryStaysOffWhenIdentityExists() throws {
    let fileManager = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storage = root
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)
    let dbDirectory = storage.appendingPathComponent("db", isDirectory: true)

    try fileManager.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    try Data("CURRENT".utf8).write(to: dbDirectory.appendingPathComponent("CURRENT"))
    try Data("identity".utf8).write(to: storage.appendingPathComponent("identity-key"))

    XCTAssertFalse(
      HostBridgeService.shouldAutoRecoverIdentitylessBootstrapFailure(
        storagePath: storage.path,
        message: "3",
        fileManager: fileManager
      )
    )

    try? fileManager.removeItem(at: root)
  }

  func testArchiveNativeStoreIfRecoverableArchivesContainerStoreAfterNumericBootstrapFailure() throws {
    let fileManager = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storage = root
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)
    let dbDirectory = storage.appendingPathComponent("db", isDirectory: true)

    try fileManager.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    try Data("CURRENT".utf8).write(to: dbDirectory.appendingPathComponent("CURRENT"))

    let archivedPath = HostBridgeService.archiveNativeStoreIfRecoverable(
      storagePath: storage.path,
      message: "6",
      fileManager: fileManager
    )

    XCTAssertNotNil(archivedPath)
    XCTAssertFalse(fileManager.fileExists(atPath: storage.path))
    XCTAssertTrue(fileManager.fileExists(atPath: archivedPath!))

    try? fileManager.removeItem(at: root)
  }

  func testArchiveNativeStoreIfRecoverableArchivesContainerStoreAfterPrefixedBootstrapFailure() throws {
    let fileManager = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storage = root
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)
    let dbDirectory = storage.appendingPathComponent("db", isDirectory: true)

    try fileManager.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    try Data("CURRENT".utf8).write(to: dbDirectory.appendingPathComponent("CURRENT"))

    let archivedPath = HostBridgeService.archiveNativeStoreIfRecoverable(
      storagePath: storage.path,
      message: "Error: 4",
      fileManager: fileManager
    )

    XCTAssertNotNil(archivedPath)
    XCTAssertFalse(fileManager.fileExists(atPath: storage.path))
    XCTAssertTrue(fileManager.fileExists(atPath: archivedPath!))

    try? fileManager.removeItem(at: root)
  }

  func testRecoverNativeStoreIfRecoverableDeletesContainerStoreWhenArchiveKeepsFailing() async throws {
    let fileManager = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let storage = root
      .appendingPathComponent("Library/Containers/com.peartube.desktop.native/Data/Library/Application Support/PearTubeDesktopNative/host-storage", isDirectory: true)
    let dbDirectory = storage.appendingPathComponent("db", isDirectory: true)
    let backupDirectory = storage
      .deletingLastPathComponent()
      .appendingPathComponent("host-storage-bak-fixed", isDirectory: true)

    try fileManager.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
    try Data("CURRENT".utf8).write(to: dbDirectory.appendingPathComponent("CURRENT"))

    let outcome = await HostBridgeService.recoverNativeStoreIfRecoverable(
      storagePath: storage.path,
      message: "5",
      fileManager: fileManager,
      backupTimestamp: "fixed",
      maxArchiveAttempts: 1,
      sleepBetweenAttempts: {}
    )

    XCTAssertEqual(outcome, .deleted(storage.path))
    XCTAssertFalse(fileManager.fileExists(atPath: storage.path))
    XCTAssertTrue(fileManager.fileExists(atPath: backupDirectory.path))

    try? fileManager.removeItem(at: root)
  }

  func testRecoverableBootstrapErrorCodeParsesPrefixedNumericErrors() {
    XCTAssertEqual(HostBridgeService.recoverableBootstrapErrorCode(from: "4"), 4)
    XCTAssertEqual(HostBridgeService.recoverableBootstrapErrorCode(from: "Error: 4"), 4)
    XCTAssertEqual(HostBridgeService.recoverableBootstrapErrorCode(from: " error: 12 "), 12)
    XCTAssertNil(HostBridgeService.recoverableBootstrapErrorCode(from: "Corestore locked"))
  }

  func testRealUserHomeDirectoryPrefersExplicitOverride() {
    let resolved = HostBridgeService.realUserHomeDirectory(
      environment: ["PEARTUBE_NATIVE_REAL_HOME": "/Users/jd"]
    )

    XCTAssertEqual(resolved.path, "/Users/jd")
  }

  func testFriendlyBootstrapErrorExplainsLegacyStoreLock() {
    let message = HostBridgeService.friendlyBootstrapError(
      "File descriptor could not be locked",
      storagePath: "/Users/jd/.peartube"
    )

    XCTAssertTrue(message.contains("Close the existing PearTube desktop app"))
    XCTAssertTrue(message.contains("/Users/jd/.peartube"))
  }

  func testFriendlyBootstrapErrorDoesNotMislabelCorestorePathEpermAsLock() {
    let rawMessage = "FileError: EPERM: operation not permitted, open \"/Users/jd/.peartube/CORESTORE\""
    let message = HostBridgeService.friendlyBootstrapError(
      rawMessage,
      storagePath: "/Users/jd/.peartube"
    )

    XCTAssertEqual(message, rawMessage)
  }

  func testPreferredNativeHostTransportDefaultsToSidecar() {
    XCTAssertEqual(
      HostBridgeService.preferredNativeHostTransportMode(environment: [:]),
      .sidecar
    )
  }

  func testPreferredNativeHostTransportRequiresDebugFlagForEmbeddedMode() {
    XCTAssertEqual(
      HostBridgeService.preferredNativeHostTransportMode(
        environment: ["PEARTUBE_NATIVE_HOST_MODE": "embedded"]
      ),
      .sidecar
    )
  }

  func testPreferredNativeHostTransportCanOptIntoEmbeddedModeWithDebugFlag() {
    XCTAssertEqual(
      HostBridgeService.preferredNativeHostTransportMode(
        environment: [
          "PEARTUBE_NATIVE_HOST_MODE": "embedded",
          "PEARTUBE_NATIVE_ENABLE_EMBEDDED_HOST": "1",
        ]
      ),
      .embedded
    )
  }

  func testPreferredNativeHostTransportIgnoresWorkletOverridesWithoutDebugFlag() {
    XCTAssertEqual(
      HostBridgeService.preferredNativeHostTransportMode(
        environment: ["PEARTUBE_NATIVE_WORKLET_BUNDLE": "/tmp/native-host-worklet.bundle"]
      ),
      .sidecar
    )
  }

  func testPreferredNativeHostTransportHonorsExplicitWorkletOverridesWithDebugFlag() {
    XCTAssertEqual(
      HostBridgeService.preferredNativeHostTransportMode(
        environment: [
          "PEARTUBE_NATIVE_ENABLE_EMBEDDED_HOST": "1",
          "PEARTUBE_NATIVE_WORKLET_BUNDLE": "/tmp/native-host-worklet.bundle",
        ]
      ),
      .embedded
    )
  }

  func testFriendlyBootstrapErrorDoesNotSurfaceEmbeddedRelaunchCopyOnSidecarPath() {
    let message = HostBridgeService.friendlyBootstrapError(
      "3",
      storagePath: "/Users/jd/Library/Application Support/PearTubeDesktopNative/host-storage"
    )

    XCTAssertEqual(message, "3")
    XCTAssertFalse(HostBridgeService.isInProcessRelaunchRequiredMessage(message))
  }

  func testEmbeddedRelaunchRequirementOnlyAppliesToEmbeddedTransport() {
    XCTAssertFalse(
      HostBridgeService.shouldRequireEmbeddedHostRelaunchAfterBootstrapFailure(
        transportMode: .sidecar
      )
    )
    XCTAssertTrue(
      HostBridgeService.shouldRequireEmbeddedHostRelaunchAfterBootstrapFailure(
        transportMode: .embedded
      )
    )
    XCTAssertFalse(
      HostBridgeService.shouldRequireEmbeddedHostRelaunchAfterBootstrapFailure(
        transportMode: nil
      )
    )
  }

  func testBareRuntimeSidecarSessionLaunchesStandaloneProcess() throws {
    let bundleURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-sidecar-\(UUID().uuidString).bundle")
    try Data("noop".utf8).write(to: bundleURL)
    defer { try? FileManager.default.removeItem(at: bundleURL) }

    let closedExpectation = expectation(description: "sidecar process closes")
    let session = try BareRuntimeSidecarSession(
      runtimeURL: URL(fileURLWithPath: "/usr/bin/true"),
      bundleURL: bundleURL,
      environment: [:],
      onData: { _ in
        XCTFail("Standalone sidecar smoke test should not emit stdout frames.")
      },
      onLog: { _ in },
      onClosed: {
        closedExpectation.fulfill()
      }
    )

    wait(for: [closedExpectation], timeout: 2.0)
    session.terminate()
  }

  func testPreferredLinkedAddonFrameworkPathPrefersBundledResources() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let resourcesPath = root.appendingPathComponent("AppResources/BareAddons", isDirectory: true)
    let workspacePath = root.appendingPathComponent("packages/desktop-native/Vendor/BareAddons", isDirectory: true)
    let frameworksPath = root.appendingPathComponent("AppFrameworks", isDirectory: true)

    try fileManager.createDirectory(at: resourcesPath, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: workspacePath, withIntermediateDirectories: true)
    try fileManager.createDirectory(atPath: frameworksPath.path, withIntermediateDirectories: true)
    try makeRequiredLinkedAddonMarkers(at: resourcesPath, fileManager: fileManager)
    defer { try? fileManager.removeItem(at: root) }

    XCTAssertEqual(
      HostBridgeService.preferredLinkedAddonFrameworkPath(
        resourceURL: root.appendingPathComponent("AppResources", isDirectory: true),
        privateFrameworksPath: frameworksPath.path,
        workspaceRoot: root,
        fileManager: fileManager
      ),
      resourcesPath.path
    )
  }

  func testPreferredLinkedAddonFrameworkPathFallsBackToWorkspaceThenFrameworks() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let workspacePath = root.appendingPathComponent("packages/desktop-native/Vendor/BareAddons", isDirectory: true)
    let frameworksPath = root.appendingPathComponent("AppFrameworks", isDirectory: true)

    try fileManager.createDirectory(at: workspacePath, withIntermediateDirectories: true)
    try fileManager.createDirectory(atPath: frameworksPath.path, withIntermediateDirectories: true)
    try makeRequiredLinkedAddonMarkers(at: workspacePath, fileManager: fileManager)
    try makeRequiredLinkedAddonMarkers(at: URL(fileURLWithPath: frameworksPath.path, isDirectory: true), fileManager: fileManager)
    defer { try? fileManager.removeItem(at: root) }

    XCTAssertEqual(
      HostBridgeService.preferredLinkedAddonFrameworkPath(
        resourceURL: root.appendingPathComponent("MissingResources", isDirectory: true),
        privateFrameworksPath: frameworksPath.path,
        workspaceRoot: root,
        fileManager: fileManager
      ),
      workspacePath.path
    )

    try fileManager.removeItem(at: workspacePath)

    XCTAssertEqual(
      HostBridgeService.preferredLinkedAddonFrameworkPath(
        resourceURL: root.appendingPathComponent("MissingResources", isDirectory: true),
        privateFrameworksPath: frameworksPath.path,
        workspaceRoot: root,
        fileManager: fileManager
      ),
      frameworksPath.path
    )
  }

  func testPreferredLinkedAddonFrameworkPathIgnoresIncompleteBundledResources() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let resourcesPath = root.appendingPathComponent("AppResources/BareAddons", isDirectory: true)
    let frameworksPath = root.appendingPathComponent("AppFrameworks", isDirectory: true)

    try fileManager.createDirectory(at: resourcesPath, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: frameworksPath, withIntermediateDirectories: true)
    try fileManager.createDirectory(
      at: resourcesPath.appendingPathComponent("bare-abort.2.0.13.framework", isDirectory: true),
      withIntermediateDirectories: true
    )
    try makeRequiredLinkedAddonMarkers(at: frameworksPath, fileManager: fileManager)
    defer { try? fileManager.removeItem(at: root) }

    XCTAssertEqual(
      HostBridgeService.preferredLinkedAddonFrameworkPath(
        resourceURL: root.appendingPathComponent("AppResources", isDirectory: true),
        privateFrameworksPath: frameworksPath.path,
        workspaceRoot: root,
        fileManager: fileManager
      ),
      frameworksPath.path
    )
  }

  func testEmbeddedBridgeTimeoutDetectionMatchesRPCChannelTimeout() {
    XCTAssertTrue(
      HostBridgeService.isEmbeddedBridgeTimeout(
        BridgeRPCChannelError.requestTimedOut(NativeBridgeCommand.bootstrap.rawValue)
      )
    )
    XCTAssertFalse(
      HostBridgeService.isEmbeddedBridgeTimeout(
        NSError(domain: "PearTubeDesktopTests", code: 0)
      )
    )
  }

  func testAVPlayerReadinessAllowsCompleteLocalPlaybackWithoutPeers() {
    let localCompleteStats = NativeBridgeVideoStatsResponse(
      success: true,
      status: "complete",
      progress: 100,
      totalBlocks: 128,
      downloadedBlocks: 0,
      totalBytes: 1024,
      downloadedBytes: 0,
      peerCount: 0,
      swarmConnections: 0,
      speedMBps: "0",
      uploadSpeedMBps: nil,
      elapsed: 1,
      isComplete: false,
      error: nil
    )

    XCTAssertTrue(HostBridgeService.isAVPlayerReadyForPlayback(localCompleteStats))
  }

  func testDiagnosticsTransportLogFilterOnlySuppressesLowLevelIpcSpam() {
    XCTAssertTrue(
      HostBridgeService.shouldSuppressDiagnosticsTransportLog(
        "Queued 110 IPC bytes for embedded BareKit worklet.",
        environment: [:]
      )
    )
    XCTAssertTrue(
      HostBridgeService.shouldSuppressDiagnosticsTransportLog(
        "Read 58 IPC bytes from embedded BareKit worklet.",
        environment: [:]
      )
    )
    XCTAssertFalse(
      HostBridgeService.shouldSuppressDiagnosticsTransportLog(
        "BareKit IPC write not yet accepted (result -2); waiting for writable.",
        environment: [:]
      )
    )
    XCTAssertFalse(
      HostBridgeService.shouldSuppressDiagnosticsTransportLog(
        "Playback URL resolved.",
        environment: [:]
      )
    )
    XCTAssertFalse(
      HostBridgeService.shouldSuppressDiagnosticsTransportLog(
        "Queued 110 IPC bytes for embedded BareKit worklet.",
        environment: ["PEARTUBE_NATIVE_VERBOSE_IPC": "1"]
      )
    )
  }

  func testProfessionalVideoWorkflowExtensionsAreDisabledByDefault() {
    XCTAssertFalse(ProfessionalVideoWorkflowExtensions.isEnabled(environment: [:]))
    XCTAssertFalse(
      ProfessionalVideoWorkflowExtensions.isEnabled(
        environment: ["PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS": "false"]
      )
    )
    XCTAssertTrue(
      ProfessionalVideoWorkflowExtensions.isEnabled(
        environment: ["PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS": "1"]
      )
    )
  }

  func testProfessionalVideoWorkflowRegistrationIsIdempotent() {
    var formatReaderRegistrations = 0
    var videoDecoderRegistrations = 0
    var state = ProfessionalVideoWorkflowRegistrationState()
    let environment = ["PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS": "1"]

    let firstRegistration = ProfessionalVideoWorkflowExtensions.registerIfNeeded(
      environment: environment,
      state: &state,
      formatReaderRegistration: { formatReaderRegistrations += 1 },
      videoDecoderRegistration: { videoDecoderRegistrations += 1 }
    )
    let secondRegistration = ProfessionalVideoWorkflowExtensions.registerIfNeeded(
      environment: environment,
      state: &state,
      formatReaderRegistration: { formatReaderRegistrations += 1 },
      videoDecoderRegistration: { videoDecoderRegistrations += 1 }
    )

    XCTAssertTrue(firstRegistration)
    XCTAssertFalse(secondRegistration)
    XCTAssertEqual(formatReaderRegistrations, 1)
    XCTAssertEqual(videoDecoderRegistrations, 1)
  }

  func testProfessionalVideoWorkflowDiagnosticsReportDisabledStateWithoutBundledExtensions() {
    let diagnostics = ProfessionalVideoWorkflowExtensions.diagnostics(
      environment: [:],
      pluginsDirectory: nil
    )

    XCTAssertFalse(diagnostics.isEnabled)
    XCTAssertFalse(diagnostics.isRoutingEnabled)
    XCTAssertEqual(diagnostics.statusTitle, "Disabled")
    XCTAssertEqual(diagnostics.bundledExtensionsSummary, "No bundled MediaExtensions")
    XCTAssertEqual(
      diagnostics.reportLines,
      [
        "Media extensions: Disabled",
        "Media extension routing: Disabled",
        "Media extension plug-ins: Unavailable",
        "Bundled MediaExtensions: none",
      ]
    )
  }

  func testProfessionalVideoWorkflowDiagnosticsEnumerateBundledMediaExtensions() throws {
    let fileManager = FileManager.default
    let rootURL = fileManager.temporaryDirectory
      .appendingPathComponent("peartube-mediaextension-diagnostics-\(UUID().uuidString)", isDirectory: true)
    let pluginsDirectory = rootURL.appendingPathComponent("PlugIns", isDirectory: true)

    defer {
      try? fileManager.removeItem(at: rootURL)
    }

    try fileManager.createDirectory(at: pluginsDirectory, withIntermediateDirectories: true)

    try writeBundledMediaExtensionInfo(
      at: pluginsDirectory.appendingPathComponent("PearTubeMediaFormatReader.appex", isDirectory: true),
      bundleIdentifier: "com.peartube.desktop.native.media-format-reader",
      bundleName: "PearTube Media Format Reader",
      extensionIdentifier: "com.peartube.mediaextension.formatreader.experimental",
      extensionPointIdentifier: "com.apple.mediaextension.formatreader"
    )
    try writeBundledMediaExtensionInfo(
      at: pluginsDirectory.appendingPathComponent("PearTubeSupplementalVideoDecoder.appex", isDirectory: true),
      bundleIdentifier: "com.peartube.desktop.native.supplemental-video-decoder",
      bundleName: "PearTube Supplemental Video Decoder",
      extensionIdentifier: "com.peartube.mediaextension.videodecoder.experimental",
      extensionPointIdentifier: "com.apple.mediaextension.videodecoder"
    )

    let diagnostics = ProfessionalVideoWorkflowExtensions.diagnostics(
      environment: [
        "PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS": "1",
        "PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSION_ROUTING": "1"
      ],
      pluginsDirectory: pluginsDirectory
    )

    XCTAssertTrue(diagnostics.isEnabled)
    XCTAssertTrue(diagnostics.isRoutingEnabled)
    XCTAssertEqual(diagnostics.statusTitle, "Enabled + Routing")
    XCTAssertEqual(diagnostics.bundledExtensions.count, 2)
    XCTAssertEqual(diagnostics.bundledExtensionsSummary, "2 bundled MediaExtensions")
    XCTAssertEqual(
      diagnostics.bundledExtensions.map(\.extensionPointIdentifier),
      ["com.apple.mediaextension.formatreader", "com.apple.mediaextension.videodecoder"]
    )
    XCTAssertEqual(
      diagnostics.bundledExtensions.map(\.extensionIdentifier),
      [
        "com.peartube.mediaextension.formatreader.experimental",
        "com.peartube.mediaextension.videodecoder.experimental"
      ]
    )
  }

  func testAVPlayerReadinessRequiresEitherBufferedDataOrPeers() {
    let coldStats = NativeBridgeVideoStatsResponse(
      success: true,
      status: "unknown",
      progress: 0,
      totalBlocks: 128,
      downloadedBlocks: 0,
      totalBytes: 1024,
      downloadedBytes: 0,
      peerCount: 0,
      swarmConnections: 0,
      speedMBps: "0.00",
      uploadSpeedMBps: nil,
      elapsed: 0,
      isComplete: false,
      error: nil
    )
    let downloadingStats = NativeBridgeVideoStatsResponse(
      success: true,
      status: "downloading",
      progress: 1,
      totalBlocks: 128,
      downloadedBlocks: 3,
      totalBytes: 1024,
      downloadedBytes: 64,
      peerCount: 1,
      swarmConnections: 1,
      speedMBps: "1.25",
      uploadSpeedMBps: nil,
      elapsed: 1,
      isComplete: false,
      error: nil
    )

    XCTAssertFalse(HostBridgeService.isAVPlayerReadyForPlayback(coldStats))
    XCTAssertTrue(HostBridgeService.isAVPlayerReadyForPlayback(downloadingStats))
  }

  func testThumbnailCacheKeyUsesPlaybackRefsWhenBackendIDsCollide() {
    let first = NativeVideo(
      id: "channel-a::video",
      backendVideoID: "video",
      channelKey: "channel-a",
      title: "First",
      channelName: "A",
      durationText: "1:00",
      summary: "",
      tags: [],
      accentHex: "#000000",
      sections: [.home],
      thumbnailURL: URL(string: "https://example.com/a.jpg"),
      path: "/videos/shared-name.mp4",
      blobId: "0:1:0:10",
      blobsCoreKey: "aa"
    )
    let second = NativeVideo(
      id: "channel-b::video",
      backendVideoID: "video",
      channelKey: "channel-b",
      title: "Second",
      channelName: "B",
      durationText: "1:00",
      summary: "",
      tags: [],
      accentHex: "#000000",
      sections: [.home],
      thumbnailURL: URL(string: "https://example.com/b.jpg"),
      path: "/videos/shared-name.mp4",
      blobId: "0:2:0:10",
      blobsCoreKey: "bb"
    )

    XCTAssertNotEqual(first.thumbnailCacheKey, second.thumbnailCacheKey)
  }

  func testAVPlayerReadinessAcceptsProgressOnlyStartupStats() {
    let progressOnlyStats = NativeBridgeVideoStatsResponse(
      success: true,
      status: "downloading",
      progress: 1,
      totalBlocks: 128,
      downloadedBlocks: 0,
      totalBytes: 1024,
      downloadedBytes: 0,
      peerCount: 0,
      swarmConnections: 0,
      speedMBps: "0.00",
      uploadSpeedMBps: nil,
      elapsed: 1,
      isComplete: false,
      error: nil
    )

    XCTAssertTrue(HostBridgeService.isAVPlayerReadyForPlayback(progressOnlyStats))
  }

  func testFeedUpdatedEventCodecRoundTrips() throws {
    let payload = NativeBridgeFeedUpdatedEvent(channelKey: "feed", action: "update")
    let encoded = try NativeBridgePayload.encode(NativeBridgeFeedUpdatedEventCodec(), value: payload)
    let decoded = try NativeBridgePayload.decode(NativeBridgeFeedUpdatedEventCodec(), from: encoded)

    XCTAssertEqual(NativeBridgeEventCommand(rawValue: 5), .feedUpdated)
    XCTAssertEqual(decoded, payload)
  }

  func testCommentsAndReactionsBridgeCommandsReserveExpectedCommandSlots() {
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 23))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 24))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 25))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 26))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 27))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 28))
    XCTAssertNotNil(NativeBridgeCommand(rawValue: 29))
  }

  func testCommentsViewModelBindOrganizesRepliesAndLoadsReactions() async {
    let video = makeVideo(
      id: "channel-a:video-1",
      backendVideoID: "video-1",
      channelKey: "channel-a",
      title: "Video 1",
      channelName: "Channel A",
      sections: [.home]
    )
    let service = MockVideoCommentsBridge()
    service.listCommentsResponses = [
      NativeBridgeListCommentsResponse(
        success: true,
        comments: [
          makeBridgeComment(
            videoId: "video-1",
            commentId: "reply-1",
            text: "Reply",
            authorKeyHex: "reply-author",
            timestamp: 200,
            parentId: "comment-1"
          ),
          makeBridgeComment(
            videoId: "video-1",
            commentId: "comment-1",
            text: "Root",
            authorKeyHex: "author-root",
            timestamp: 100
          ),
        ],
        error: nil
      )
    ]
    service.getReactionsResponses = [
      NativeBridgeGetReactionsResponse(
        success: true,
        counts: [
          NativeBridgeReactionCount(reactionType: "like", count: 3),
          NativeBridgeReactionCount(reactionType: "dislike", count: 1),
        ],
        userReaction: "like",
        error: nil
      )
    ]

    let model = VideoCommentsViewModel(pollInterval: nil)

    await model.bind(
      video: video,
      identityChannelKey: "self-channel",
      canModerate: false,
      service: service
    )

    XCTAssertFalse(model.commentsLoading)
    XCTAssertEqual(model.organizedComments.count, 1)
    XCTAssertEqual(model.organizedComments.first?.commentId, "comment-1")
    XCTAssertEqual(model.organizedComments.first?.replies.count, 1)
    XCTAssertEqual(model.organizedComments.first?.replies.first?.commentId, "reply-1")
    XCTAssertEqual(model.reactionCounts["like"], 3)
    XCTAssertEqual(model.reactionCounts["dislike"], 1)
    XCTAssertEqual(model.userReaction, "like")
  }

  func testCommentsViewModelFailedPostLeavesFailedPendingComment() async {
    let video = makeVideo(
      id: "channel-a:video-2",
      backendVideoID: "video-2",
      channelKey: "channel-a",
      title: "Video 2",
      channelName: "Channel A",
      sections: [.home]
    )
    let service = MockVideoCommentsBridge()
    service.listCommentsResponses = [
      NativeBridgeListCommentsResponse(success: true, comments: [], error: nil),
    ]
    service.getReactionsResponses = [
      NativeBridgeGetReactionsResponse(success: true, counts: [], userReaction: nil, error: nil),
    ]
    service.addCommentResponse = NativeBridgeAddCommentResponse(
      success: false,
      commentId: nil,
      queued: false,
      error: "No writable identity"
    )

    let model = VideoCommentsViewModel(
      pollInterval: nil,
      now: { 123_456 },
      idProvider: { "pending-failed" }
    )

    await model.bind(
      video: video,
      identityChannelKey: "self-channel",
      canModerate: false,
      service: service
    )
    model.commentText = "Hello world"

    await model.postComment()

    XCTAssertEqual(model.organizedComments.count, 1)
    XCTAssertEqual(model.organizedComments.first?.commentId, "pending-failed")
    XCTAssertEqual(model.organizedComments.first?.pendingState, .failed)
    XCTAssertEqual(model.organizedComments.first?.text, "Hello world")
  }

  func testCommentsViewModelToggleReactionReplacesExistingReaction() async {
    let video = makeVideo(
      id: "channel-a:video-3",
      backendVideoID: "video-3",
      channelKey: "channel-a",
      title: "Video 3",
      channelName: "Channel A",
      sections: [.home]
    )
    let service = MockVideoCommentsBridge()
    service.listCommentsResponses = [
      NativeBridgeListCommentsResponse(success: true, comments: [], error: nil),
      NativeBridgeListCommentsResponse(success: true, comments: [], error: nil),
    ]
    service.getReactionsResponses = [
      NativeBridgeGetReactionsResponse(
        success: true,
        counts: [NativeBridgeReactionCount(reactionType: "like", count: 2)],
        userReaction: "like",
        error: nil
      ),
      NativeBridgeGetReactionsResponse(
        success: true,
        counts: [NativeBridgeReactionCount(reactionType: "dislike", count: 4)],
        userReaction: "dislike",
        error: nil
      ),
    ]

    let model = VideoCommentsViewModel(pollInterval: nil)

    await model.bind(
      video: video,
      identityChannelKey: "self-channel",
      canModerate: false,
      service: service
    )
    await model.toggleReaction("dislike")

    XCTAssertEqual(service.removeReactionCallCount, 1)
    XCTAssertEqual(service.addReactionTypes, ["dislike"])
    XCTAssertEqual(model.userReaction, "dislike")
    XCTAssertEqual(model.reactionCounts["dislike"], 4)
    XCTAssertNil(model.reactionCounts["like"])
  }

  func testCommentsViewModelDeletePendingLocallyAndHideModeratorComment() async {
    let video = makeVideo(
      id: "channel-a:video-4",
      backendVideoID: "video-4",
      channelKey: "channel-a",
      title: "Video 4",
      channelName: "Channel A",
      sections: [.home]
    )
    let service = MockVideoCommentsBridge()
    service.listCommentsResponses = [
      NativeBridgeListCommentsResponse(success: true, comments: [], error: nil),
      NativeBridgeListCommentsResponse(success: true, comments: [], error: nil),
      NativeBridgeListCommentsResponse(
        success: true,
        comments: [
          makeBridgeComment(
            videoId: "video-4",
            commentId: "server-comment",
            text: "Server comment",
            authorKeyHex: "other-channel",
            timestamp: 300
          )
        ],
        error: nil
      ),
    ]
    service.getReactionsResponses = [
      NativeBridgeGetReactionsResponse(success: true, counts: [], userReaction: nil, error: nil),
      NativeBridgeGetReactionsResponse(success: true, counts: [], userReaction: nil, error: nil),
      NativeBridgeGetReactionsResponse(success: true, counts: [], userReaction: nil, error: nil),
    ]
    service.addCommentResponse = NativeBridgeAddCommentResponse(
      success: true,
      commentId: "queued-comment",
      queued: true,
      error: nil
    )
    service.hideCommentResponse = NativeBridgeHideCommentResponse(success: true, error: nil)

    let model = VideoCommentsViewModel(
      pollInterval: nil,
      now: { 222_000 },
      idProvider: { "local-pending" }
    )

    await model.bind(
      video: video,
      identityChannelKey: "self-channel",
      canModerate: true,
      service: service
    )

    model.commentText = "Pending delete"
    await model.postComment()

    XCTAssertEqual(model.organizedComments.first?.pendingState, .queued)

    if let pending = model.organizedComments.first {
      await model.deleteComment(pending)
    }

    XCTAssertEqual(service.removeCommentCallCount, 0)
    XCTAssertTrue(model.organizedComments.isEmpty)

    await model.refreshComments()

    XCTAssertEqual(model.organizedComments.count, 1)
    if let liveComment = model.organizedComments.first {
      XCTAssertTrue(model.canHide(liveComment))
      await model.hideComment(liveComment)
    }

    XCTAssertEqual(service.hideCommentCallCount, 1)
    XCTAssertTrue(model.organizedComments.isEmpty)
  }

  func testHostBridgeBootstrapSucceedsWithFreshTempStorage() async {
    let storageURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-hostbridge-\(UUID().uuidString)", isDirectory: true)
    let debugLogURL = URL(fileURLWithPath: "/tmp/peartube-native-hostbridge-bootstrap.log")

    try? FileManager.default.removeItem(at: storageURL)
    try? FileManager.default.removeItem(at: debugLogURL)
    try? FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)

    setenv("PEARTUBE_NATIVE_STORAGE_PATH", storageURL.path, 1)
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", debugLogURL.path, 1)
    defer {
      unsetenv("PEARTUBE_NATIVE_STORAGE_PATH")
      unsetenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG")
      try? FileManager.default.removeItem(at: storageURL)
      try? FileManager.default.removeItem(at: debugLogURL)
    }

    let appState = AppState()
    let hostBridge = HostBridgeService()

    await hostBridge.bootstrap(appState: appState)

    switch hostBridge.phase {
    case .ready(let blobServerPort):
      XCTAssertNotNil(blobServerPort)
    default:
      XCTFail("Expected host bridge to reach ready state, got \(hostBridge.phase)")
    }

    XCTAssertNil(appState.lastErrorMessage)
    XCTAssertFalse(appState.isLoading)
  }

  func testLiveHomePlaybackURLResolvesAndLocalBlobServerServesBytes() async throws {
    let appState = AppState()
    let hostBridge = HostBridgeService()

    await hostBridge.bootstrap(appState: appState)

    do {
      for _ in 0..<6 where appState.videoCount(for: .home) == 0 {
        await hostBridge.refreshPublicFeed(into: appState)
        try? await Task.sleep(for: .seconds(2))
      }

      guard let video = appState.videos(for: .home).first else {
        throw XCTSkip("No Home videos are available in the current native store.")
      }

      let playbackURL = await hostBridge.resolvePlayback(for: video)
      XCTAssertNotNil(playbackURL, hostBridge.lastPlaybackErrorMessage ?? "Playback URL did not resolve.")

      guard let playbackURL else { return }

      var request = URLRequest(url: playbackURL)
      request.timeoutInterval = 15
      request.setValue("bytes=0-1", forHTTPHeaderField: "Range")

      let (_, response) = try await URLSession.shared.data(for: request)
      let httpResponse = try XCTUnwrap(response as? HTTPURLResponse)

      XCTAssertTrue(
        [200, 206].contains(httpResponse.statusCode),
        "Unexpected blob server status \(httpResponse.statusCode) for \(playbackURL.absoluteString)"
      )

      let asset = AVURLAsset(url: playbackURL)
      let isPlayable = try await asset.load(.isPlayable)

      XCTAssertTrue(
        isPlayable,
        "Resolved blob URL is reachable but AVFoundation does not consider it playable. " +
          "mimeType=\(video.mimeType ?? "nil") url=\(playbackURL.absoluteString)"
      )
    } catch {
      await hostBridge.resetBridgeState()
      throw error
    }

    await hostBridge.resetBridgeState()
  }

  private func makeVideo(
    id: String,
    backendVideoID: String,
    channelKey: String,
    title: String,
    channelName: String,
    sections: Set<AppSection>
  ) -> NativeVideo {
    NativeVideo(
      id: id,
      backendVideoID: backendVideoID,
      channelKey: channelKey,
      title: title,
      channelName: channelName,
      durationText: "1:23",
      summary: "Summary for \(title)",
      tags: ["test"],
      accentHex: "#FF7A59",
      sections: sections
    )
  }

  private func makeBridgeComment(
    videoId: String,
    commentId: String,
    text: String,
    authorKeyHex: String,
    timestamp: Int,
    parentId: String? = nil,
    isAdmin: Bool = false
  ) -> NativeBridgeComment {
    NativeBridgeComment(
      videoId: videoId,
      commentId: commentId,
      text: text,
      authorKeyHex: authorKeyHex,
      timestamp: timestamp,
      parentId: parentId,
      isAdmin: isAdmin
    )
  }

  private func makeRequiredLinkedAddonMarkers(at root: URL, fileManager: FileManager) throws {
    let frameworks = [
      "bare-pipe.4.1.5.framework",
      "bare-fs.4.5.6.framework",
      "quickbit-native.2.4.8.framework",
      "rocksdb-native.3.15.0.framework",
      "sodium-native.5.1.0.framework",
    ]

    for framework in frameworks {
      try fileManager.createDirectory(
        at: root.appendingPathComponent(framework, isDirectory: true),
        withIntermediateDirectories: true
      )
    }
  }

  private func writeBundledMediaExtensionInfo(
    at bundleURL: URL,
    bundleIdentifier: String,
    bundleName: String,
    extensionIdentifier: String,
    extensionPointIdentifier: String
  ) throws {
    let fileManager = FileManager.default
    let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
    let infoPlistURL = contentsURL.appendingPathComponent("Info.plist")

    try fileManager.createDirectory(at: contentsURL, withIntermediateDirectories: true)

    let info: [String: Any] = [
      "CFBundleIdentifier": bundleIdentifier,
      "CFBundleDisplayName": bundleName,
      "CFBundleName": bundleName,
      "CFBundlePackageType": "XPC!",
      "EXAppExtensionAttributes": [
        "ClassImplementationID": extensionIdentifier,
        "EXExtensionPointIdentifier": extensionPointIdentifier,
      ]
    ]

    let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try data.write(to: infoPlistURL)
  }

  private func findSubview<T: NSView>(in view: NSView, ofType type: T.Type) -> T? {
    if let typedView = view as? T {
      return typedView
    }

    for subview in view.subviews {
      if let typedView = findSubview(in: subview, ofType: type) {
        return typedView
      }
    }

    return nil
  }
}

@MainActor
private final class MockVideoCommentsBridge: VideoCommentsBridge {
  var listCommentsResponses: [NativeBridgeListCommentsResponse] = []
  var getReactionsResponses: [NativeBridgeGetReactionsResponse] = []
  var addCommentResponse = NativeBridgeAddCommentResponse(success: true, commentId: "comment-id", queued: false, error: nil)
  var hideCommentResponse = NativeBridgeHideCommentResponse(success: true, error: nil)
  var removeCommentResponse = NativeBridgeRemoveCommentResponse(success: true, queued: false, error: nil)
  var addReactionResponse = NativeBridgeReactionMutationResponse(success: true, queued: false, error: nil)
  var removeReactionResponse = NativeBridgeReactionMutationResponse(success: true, queued: false, error: nil)

  private(set) var addReactionTypes: [String] = []
  private(set) var removeReactionCallCount = 0
  private(set) var removeCommentCallCount = 0
  private(set) var hideCommentCallCount = 0

  func listComments(
    for video: NativeVideo,
    page: Int,
    limit: Int
  ) async throws -> NativeBridgeListCommentsResponse {
    if !listCommentsResponses.isEmpty {
      return listCommentsResponses.removeFirst()
    }

    return NativeBridgeListCommentsResponse(success: true, comments: [], error: nil)
  }

  func addComment(
    text: String,
    to video: NativeVideo,
    parentId: String?,
    authorChannelKey: String?
  ) async throws -> NativeBridgeAddCommentResponse {
    addCommentResponse
  }

  func hideComment(
    _ comment: NativeBridgeComment,
    on video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeHideCommentResponse {
    hideCommentCallCount += 1
    return hideCommentResponse
  }

  func removeComment(
    _ comment: NativeBridgeComment,
    on video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeRemoveCommentResponse {
    removeCommentCallCount += 1
    return removeCommentResponse
  }

  func addReaction(
    _ reactionType: String,
    to video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeReactionMutationResponse {
    addReactionTypes.append(reactionType)
    return addReactionResponse
  }

  func removeReaction(
    from video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeReactionMutationResponse {
    removeReactionCallCount += 1
    return removeReactionResponse
  }

  func getReactions(
    for video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeGetReactionsResponse {
    if !getReactionsResponses.isEmpty {
      return getReactionsResponses.removeFirst()
    }

    return NativeBridgeGetReactionsResponse(success: true, counts: [], userReaction: nil, error: nil)
  }
}
