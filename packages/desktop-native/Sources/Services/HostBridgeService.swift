import AppKit
import AVFoundation
@preconcurrency import BareRPC
import Darwin
import Foundation
import Observation
// HRPC and Schema types are compiled in the same module (GeneratedHRPC.swift, GeneratedSchema.swift)

@MainActor
@Observable
final class HostBridgeService {
  private static let supportedProtocolVersion = 2
  private static let supportedVideoUploadFileExtensions: Set<String> = [
    "mp4", "mov", "m4v", "mkv", "webm"
  ]
  private static let uploadBridgeRequestTimeout: Duration = .seconds(1800)

  private final class WorkletSessionSink: @unchecked Sendable {
    var session: (any NativeHostSession)?

    func write(_ data: Data) {
      session?.write(data)
    }
  }

  enum NativeHostTransportMode: Equatable {
    case sidecar
    case embedded

    var label: String {
      switch self {
      case .sidecar:
        return "native host sidecar"
      case .embedded:
        return "embedded BareKit native host"
      }
    }
  }

  enum NativeStoreRecoveryOutcome: Equatable {
    case notNeeded
    case archived(String)
    case deleted(String)
    case failed(String)
  }

  enum Phase: Equatable {
    case idle
    case booting
    case ready(blobServerPort: Int?)
    case failed(String)
  }

  private(set) var phase: Phase = .idle
  private(set) var logLines: [String] = ["Native host bridge scaffold created."]
  private(set) var lastHeartbeat: Date?
  private(set) var activePlaybackVideoID: NativeVideo.ID?
  private(set) var resolvedPlaybackURL: URL?
  private(set) var isResolvingPlayback = false
  private(set) var lastPlaybackErrorMessage: String?
  private(set) var playbackStats: NativeVideoStats?
  private(set) var thumbnailURLs: [String: URL] = [:]
  private(set) var thumbnailRefreshTokens: [String: Int] = [:]
  private(set) var activeAVPlayer: AVPlayer?
  private(set) var activeMpvPlayerID: String?
  private(set) var activeMpvFrameServerPort: Int?
  private(set) var mpvAvailable = false
  private(set) var ffmpegDecodeAvailable = false
  private(set) var ffmpegDecodeAvailabilityError: String?
  private(set) var networkStatus: NativeNetworkStatus?

  @ObservationIgnored private var hostSession: (any NativeHostSession)?
  @ObservationIgnored private var hrpc: HRPC?
  @ObservationIgnored private var hrpcDelegate: HostBridgeRPCDelegate?
  // RPCGate retired — RPC is now an actor, so concurrency is handled inside
  // BareRPC itself. `gatedRPC` remains a thin passthrough so its ~30 call
  // sites don't need updating.
  @ObservationIgnored private var inFlightThumbnailIDs = Set<String>()
  @ObservationIgnored private let logLimit = 120
  @ObservationIgnored private(set) var selectedStoragePath: String?
  @ObservationIgnored private var lastPlaybackRenderSize = CGSize(width: 1280, height: 720)
  @ObservationIgnored private var forceAVPlayerFallback = false
  @ObservationIgnored private var playbackStatsTask: Task<Void, Never>?
  @ObservationIgnored private var feedWarmupTask: Task<Void, Never>?
  @ObservationIgnored private var feedUpdateRefreshTask: Task<Void, Never>?
  @ObservationIgnored private let diagnosticsLogURL: URL
  @ObservationIgnored private let workletDebugLogURL: URL
  @ObservationIgnored private let snapshotCacheURL: URL
  @ObservationIgnored private weak var observedAppState: AppState?
  @ObservationIgnored private var currentHostTransportMode: NativeHostTransportMode?

  struct NativePlaybackSession: Equatable {
    enum Mode: Equatable {
      case mpv
      case avPlayer
    }

    let mode: Mode
    let url: URL
    let playerId: String?
    let frameServerPort: Int?
  }

  struct NativeNetworkStatus: Equatable {
    let connected: Bool
    let peerCount: Int
    let swarmConnections: Int
    let swarmPeers: Int
    let feedConnections: Int
    let feedEntries: Int
    let channelsLoaded: Int
    let swarmOffline: Bool
    let swarmOfflineReason: String?
    let swarmListenResolved: Bool
    let peerPoolJoined: Bool
    let publicFeedDiscoveryJoined: Bool
    let feedTopicHex: String?
    let recommendedBoundary: String?

    init(schema: GetSwarmStatusResponse) {
      let resolvedSwarmConnections = Self.intValue(schema.swarmConnections)
      connected = schema.connected
      peerCount = Self.intValue(schema.peerCount, defaultValue: resolvedSwarmConnections)
      swarmConnections = resolvedSwarmConnections
      swarmPeers = Self.intValue(schema.swarmPeers)
      feedConnections = Self.intValue(schema.feedConnections)
      feedEntries = Self.intValue(schema.feedEntries)
      channelsLoaded = Self.intValue(schema.channelsLoaded)
      swarmOffline = schema.swarmOffline
      swarmOfflineReason = schema.swarmOfflineReason
      swarmListenResolved = schema.swarmListenResolved
      peerPoolJoined = schema.peerPoolJoined
      publicFeedDiscoveryJoined = schema.publicFeedDiscoveryJoined
      feedTopicHex = schema.feedTopicHex
      recommendedBoundary = schema.recommendedBoundary
    }

    var diagnosticSummary: String {
      if swarmOffline {
        return "Network status: offline (\(swarmOfflineReason ?? "unknown reason"))."
      }
      if !swarmListenResolved {
        return "Network status: DHT bootstrap still pending."
      }
      return "Network status: peers=\(peerCount), swarmConnections=\(swarmConnections), feedConnections=\(feedConnections), feedEntries=\(feedEntries)."
    }

    private static func intValue(_ value: UInt?, defaultValue: Int = 0) -> Int {
      value.map(Int.init) ?? defaultValue
    }
  }

  var isReady: Bool {
    if case .ready = phase { return true }
    return false
  }

  var diagnosticsLogPath: String {
    diagnosticsLogURL.path
  }

  var professionalVideoWorkflowDiagnostics: ProfessionalVideoWorkflowDiagnostics {
    ProfessionalVideoWorkflowExtensions.diagnostics()
  }

  var activeMediaExtensionPlaybackSummary: String? {
    guard #available(macOS 15.0, *),
          let asset = activeAVPlayer?.currentItem?.asset as? AVURLAsset,
          let properties = asset.mediaExtensionProperties else {
      return nil
    }

    return "\(properties.extensionName) (\(properties.extensionIdentifier))"
  }

  var ffmpegDecodeDiagnosticsTitle: String {
    guard Self.isExperimentalFFmpegDecodeEnabled() else { return "Disabled" }
    return ffmpegDecodeAvailable ? "Enabled + Available" : "Enabled"
  }

  var ffmpegDecodeDiagnosticsCaption: String {
    if ffmpegDecodeAvailable {
      return "bare-ffmpeg decode engine available"
    }

    if let ffmpegDecodeAvailabilityError, !ffmpegDecodeAvailabilityError.isEmpty {
      return ffmpegDecodeAvailabilityError
    }

    return Self.isExperimentalFFmpegDecodeEnabled()
      ? "Experimental decode path is enabled but not yet probed"
      : "Experimental decode path is off"
  }

  init() {
    diagnosticsLogURL = Self.defaultDiagnosticsLogURL()
    workletDebugLogURL = Self.defaultWorkletDebugLogURL()
    snapshotCacheURL = Self.defaultBrowseSnapshotCacheURL()
    Self.appendPersistentLog(
      "=== Native host session \(Self.isoTimestamp()) ===",
      to: diagnosticsLogURL
    )
    for line in logLines {
      Self.appendPersistentLog(line, to: diagnosticsLogURL)
    }
  }

  var statusTitle: String {
    switch phase {
    case .idle:
      return "Host bridge idle"
    case .booting:
      return "Booting shared host"
    case .ready(let port):
      if let port {
        return "Host ready on blob port \(port)"
      }
      return "Host ready in preview mode"
    case .failed(let message):
      return "Host failed: \(message)"
    }
  }

  func bootstrap(
    appState: AppState,
    allowNativeStoreRecovery: Bool = HostBridgeService.isNativeStoreRecoveryEnabled(),
    allowEmbeddedRunnerRetry: Bool = true
  ) async {
    guard phase != .booting else { return }

    observe(appState)
    appState.setLoading(true)
    phase = .booting
    appState.setError(nil)
    let storagePath = Self.preferredStoragePath()
    selectedStoragePath = storagePath
    let transportMode = Self.preferredNativeHostTransportMode()

    if ProfessionalVideoWorkflowExtensions.isEnabled() {
      let registered = ProfessionalVideoWorkflowExtensions.registerIfNeeded()
      if registered {
        appendLog("Registered experimental MediaExtension format readers and supplemental video decoders.")
      } else {
        appendLog("Experimental MediaExtension registration already active for this process.")
      }
    }

    appendLog("Launching \(transportMode.label).")
    appendLog("Using storage path \(storagePath).")

    do {
      appendLog("Bridge established. Requesting bootstrap snapshot.")
      let response = try await gatedRPC { hrpc in
        try await hrpc.desktopBootstrap(
          DesktopBootstrapRequest(storagePath: storagePath)
        )
      }

      try Self.validateProtocolVersion(response.protocolVersion)
      appendLog("Bootstrap snapshot received from shared host.")
      let blobPort = response.blobServerPort.flatMap { $0 > 0 ? Int($0) : nil }
      phase = .ready(blobServerPort: blobPort)
      lastHeartbeat = Date()
      _ = await refreshNetworkStatus()
      let responseSnapshot = NativeBrowseSnapshot(schema: response.snapshot)
      let displaySnapshot = Self.preferredBrowseSnapshot(
        liveSnapshot: responseSnapshot,
        cachedSnapshot: Self.loadCachedBrowseSnapshot(from: snapshotCacheURL)
      )
      if displaySnapshot != responseSnapshot {
        appendLog("Using cached browse snapshot while the live public feed is still empty.")
      }
      persistBrowseSnapshotIfUseful(displaySnapshot)
      appState.applySnapshot(displaySnapshot)
      appState.settleAfterSuccessfulBootstrap()
      primeThumbnailCache(with: displaySnapshot)
      if Self.isExperimentalFFmpegDecodeEnabled() {
        _ = await refreshFFmpegDecodeAvailability()
      }
      scheduleAutomaticFeedWarmupIfNeeded(
        snapshot: responseSnapshot,
        appState: appState,
        keepRefreshingWhileShowingCachedFeed: displaySnapshot != responseSnapshot
      )
      appendLog("Shared host ready. Loaded \(displaySnapshot.stats.homeCount) home videos across \(displaySnapshot.stats.channelCount) channels.")
    } catch {
      var bridgeDiscarded = false

      if Self.shouldRequireEmbeddedHostRelaunchAfterBootstrapFailure(
        transportMode: currentHostTransportMode
      ) {
        let relaunchMessage = Self.friendlyInProcessRelaunchRequiredMessage(
          error.localizedDescription,
          storagePath: storagePath
        )
        if !bridgeDiscarded {
          discardBridgeAfterBootstrapFailure()
          bridgeDiscarded = true
        }
        phase = .failed(relaunchMessage)
        appState.setError(relaunchMessage)
        appState.selectSection(.diagnostics)
        appendLog("Host bootstrap failed after the embedded runtime had already launched in this app process. Relaunch required: \(relaunchMessage)")
        appState.setLoading(false)
        return
      }

      if allowNativeStoreRecovery {
        discardBridgeAfterBootstrapFailure()
        bridgeDiscarded = true
      }

      if currentHostTransportMode == .embedded,
         allowEmbeddedRunnerRetry,
         Self.isEmbeddedBridgeTimeout(error) {
        appendLog("Embedded BareKit bootstrap timed out. Restarting the embedded host and retrying once.")
        await resetBridgeState()
        appState.setError(nil)
        return await bootstrap(
          appState: appState,
          allowNativeStoreRecovery: allowNativeStoreRecovery,
          allowEmbeddedRunnerRetry: false
        )
      }

      let shouldAttemptNativeStoreRecovery =
        allowNativeStoreRecovery
        || Self.shouldAutoRecoverIdentitylessBootstrapFailure(
          storagePath: storagePath,
          message: error.localizedDescription
        )

      if shouldAttemptNativeStoreRecovery {
        if !bridgeDiscarded {
          appendLog("Discarding the failed native host before attempting native store recovery.")
          await resetBridgeState()
          bridgeDiscarded = true
        }

        switch await Self.recoverNativeStoreIfRecoverable(
          storagePath: storagePath,
          message: error.localizedDescription
        ) {
        case .archived(let archivedStorePath):
          appendLog("Archived unusable native store to \(archivedStorePath). Retrying bootstrap with a fresh native store.")
          await resetBridgeState()
          appState.setError(nil)
          return await bootstrap(
            appState: appState,
            allowNativeStoreRecovery: false,
            allowEmbeddedRunnerRetry: allowEmbeddedRunnerRetry
          )
        case .deleted(let deletedStorePath):
          appendLog("Deleted unusable native store at \(deletedStorePath). Retrying bootstrap with a fresh native store.")
          await resetBridgeState()
          appState.setError(nil)
          return await bootstrap(
            appState: appState,
            allowNativeStoreRecovery: false,
            allowEmbeddedRunnerRetry: allowEmbeddedRunnerRetry
          )
        case .failed(let reason):
          appendLog("Recoverable native store reset failed: \(reason)")
        case .notNeeded:
          break
        }
      }

      let friendlyMessage = Self.friendlyBootstrapError(
        error.localizedDescription,
        storagePath: storagePath
      )
      if !bridgeDiscarded {
        discardBridgeAfterBootstrapFailure()
      }
      phase = .failed(friendlyMessage)
      appState.setError(friendlyMessage)
      appState.selectSection(.diagnostics)
      appendLog("Host bootstrap failed: \(friendlyMessage)")
    }

    appState.setLoading(false)
  }

  func refreshBrowse(into appState: AppState) async {
    observe(appState)
    guard isReady else {
      await bootstrap(appState: appState)
      return
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Refreshing browse snapshot from shared host.")

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.desktopRefreshBrowse(DesktopRefreshBrowseRequest())
      }
      _ = await refreshNetworkStatus()
      let liveSnapshot = NativeBrowseSnapshot(schema: response.snapshot)
      let snapshot = Self.preferredBrowseSnapshot(
        liveSnapshot: liveSnapshot,
        cachedSnapshot: Self.loadCachedBrowseSnapshot(from: snapshotCacheURL)
      )
      if snapshot != liveSnapshot {
        appendLog("Retaining cached browse snapshot because the live public feed is still empty.")
      }
      persistBrowseSnapshotIfUseful(snapshot)
      appState.applySnapshot(snapshot)
      primeThumbnailCache(with: snapshot)
      lastHeartbeat = Date()
      appendLog("Browse snapshot refreshed. Home now has \(appState.videoCount(for: .home)) videos.")
    } catch {
      appState.setError(error.localizedDescription)
      appState.selectSection(.diagnostics)
      appendLog("Browse refresh failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  @discardableResult
  func refreshNetworkStatus() async -> NativeNetworkStatus? {
    guard hrpc != nil else { return networkStatus }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.getSwarmStatus(GetSwarmStatusRequest())
      }
      let status = NativeNetworkStatus(schema: response)
      networkStatus = status
      lastHeartbeat = Date()
      appendLog(status.diagnosticSummary)
      return status
    } catch {
      appendLog("Network status refresh failed: \(error.localizedDescription)")
      return networkStatus
    }
  }

  func searchVideos(query: String, into appState: AppState, topK: Int = 12) async {
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedQuery.isEmpty else {
      appState.clearSearch()
      return
    }

    if !isReady {
      await bootstrap(appState: appState)
      guard isReady else { return }
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Running global search for \(trimmedQuery).")

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.globalSearchVideos(
          GlobalSearchVideosRequest(query: trimmedQuery, topK: UInt(topK))
        )
      }

      // TODO: HRPC globalSearchVideos returns SearchResult { id, score, metadata }, not full NativeVideo objects.
      // The appState.applySearchResults API expects [NativeVideo]. For now, pass empty results.
      appState.applySearchResults(query: trimmedQuery, videos: [])
      lastHeartbeat = Date()
      appendLog("Global search returned \(response.results.count) results (search result conversion pending).")
    } catch {
      appState.setError(error.localizedDescription)
      appState.selectSection(.diagnostics)
      appendLog("Global search failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  func createIdentity(into appState: AppState, suggestedName: String? = nil) async {
    let trimmedSuggestedName = suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let identityName = trimmedSuggestedName.isEmpty ? defaultIdentityName() : trimmedSuggestedName

    guard await ensureReady(into: appState) else { return }

    await performSnapshotMutationViaHRPC(
      into: appState,
      logMessage: "Creating native identity \(identityName).",
      afterApply: { appState in
        appState.selectSection(.studio)
      }
    ) { hrpc in
      _ = try await hrpc.createIdentity(CreateIdentityRequest(name: identityName, avatar: ""))
    }
  }

  func refreshPublicFeed(into appState: AppState) async {
    guard await ensureReady(into: appState) else { return }

    await performSnapshotMutationViaHRPC(
      into: appState,
      logMessage: "Refreshing public feed from native shell.",
      allowCachedFeedFallback: false,
      afterApply: { appState in
        appState.selectSection(.home)
      }
    ) { hrpc in
      _ = try await hrpc.refreshFeed(RefreshFeedRequest())
    }
  }

  func publishActiveChannel(into appState: AppState) async {
    guard await ensureReady(into: appState) else { return }

    await performSnapshotMutationViaHRPC(
      into: appState,
      logMessage: "Publishing active channel to the public feed.",
      afterApply: { appState in
        appState.selectSection(.studio)
      }
    ) { hrpc in
      _ = try await hrpc.submitToFeed(SubmitToFeedRequest())
    }
  }

  func toggleSubscription(channelKey: String, channelName: String, into appState: AppState) async {
    guard await ensureReady(into: appState) else { return }

    let isSubscribed = appState.isSubscribed(to: channelKey)
    let logMessage = isSubscribed
      ? "Unsubscribing from \(channelName)."
      : "Subscribing to \(channelName)."

    await performSnapshotMutationViaHRPC(
      into: appState,
      logMessage: logMessage
    ) { hrpc in
      if isSubscribed {
        _ = try await hrpc.unsubscribeChannel(UnsubscribeChannelRequest(channelKey: channelKey))
      } else {
        _ = try await hrpc.subscribeChannel(SubscribeChannelRequest(channelKey: channelKey))
      }
    }
  }

  func toggleSubscription(for video: NativeVideo, into appState: AppState) async {
    await toggleSubscription(
      channelKey: video.channelKey,
      channelName: video.channelName,
      into: appState
    )
  }

  func uploadVideo(into appState: AppState) async {
    guard await ensureReady(into: appState) else { return }

    if !appState.hasActiveIdentity {
      appState.setError("Create a channel before uploading a video.")
      appState.selectSection(.studio)
      appendLog("Upload blocked because no active identity exists.")
      return
    }

    guard let fileURL = chooseVideoURL() else {
      appendLog("Native upload cancelled.")
      return
    }

    await uploadVideo(from: fileURL, into: appState)
  }

  func uploadVideo(from fileURL: URL, into appState: AppState) async {
    guard await ensureReady(into: appState) else { return }

    if !appState.hasActiveIdentity {
      appState.setError("Create a channel before uploading a video.")
      appState.selectSection(.studio)
      appendLog("Upload blocked because no active identity exists.")
      return
    }

    let title = fileURL.deletingPathExtension().lastPathComponent
      .replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTitle = title.isEmpty ? "Untitled Upload" : title

    appState.beginStudioUpload(
      fileName: fileURL.lastPathComponent,
      title: resolvedTitle,
      sourceFilePath: fileURL.path
    )
    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Uploading \(fileURL.lastPathComponent) from native shell.")

    do {
      let refreshResponse = try await gatedRPC { hrpc in
        _ = try await hrpc.uploadVideo(
          UploadVideoRequest(
            filePath: fileURL.path,
            title: resolvedTitle,
            description: "",
            category: "",
            skipThumbnailGeneration: false
          )
        )
        // After upload, refresh the browse snapshot to get updated sections
        return try await hrpc.desktopRefreshBrowse(DesktopRefreshBrowseRequest())
      }
      let liveSnapshot = NativeBrowseSnapshot(schema: refreshResponse.snapshot)
      let snapshot = Self.resolvedBrowseSnapshot(
        liveSnapshot: liveSnapshot,
        cachedSnapshot: Self.loadCachedBrowseSnapshot(from: snapshotCacheURL),
        allowCachedFeedFallback: true
      )
      if snapshot != liveSnapshot {
        appendLog("Retaining cached browse snapshot because the live public feed is still empty.")
      }
      persistBrowseSnapshotIfUseful(snapshot)
      appState.applySnapshot(snapshot)
      appState.selectSection(.studio)
      let uploadedVideo =
        Self.resolveUploadedStudioVideo(
          snapshot: snapshot,
          uploadJob: appState.activeStudioUploadJob,
          activeIdentityChannelKey: appState.activeIdentityChannelKey
        )
        ?? appState.videos(for: .studio).first
      if let uploadedVideo {
        appState.upsertOwnedVideo(uploadedVideo)
      }
      appState.completeStudioUpload(with: uploadedVideo)
      primeThumbnailCache(with: snapshot)
      lastHeartbeat = Date()
      appendLog("Native host mutation completed. Home now has \(appState.videoCount(for: .home)) videos.")
    } catch {
      appState.failStudioUpload(message: error.localizedDescription)
      appState.setError(error.localizedDescription)
      appendLog("Native host mutation failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  func loadStudioWorkspace(into appState: AppState, preserveLoadingState: Bool = false) async {
    guard let channelKey = appState.activeIdentityChannelKey else {
      appState.clearStudioWorkspace()
      return
    }

    guard await ensureReady(into: appState) else { return }

    if !preserveLoadingState {
      appState.setLoading(true)
      appState.setError(nil)
    }
    appendLog("Loading Studio workspace for \(String(channelKey.prefix(12))).")

    defer {
      if !preserveLoadingState {
        appState.setLoading(false)
      }
    }

    do {
      let workspace = try await fetchChannelWorkspace(
        channelKey: channelKey,
        publicBeeKey: nil,
        appState: appState
      )
      appState.updateStudioWorkspace(profile: workspace.profile, videos: workspace.videos)
      primeThumbnailCache(with: workspace.videos)
      lastHeartbeat = Date()
      appendLog("Studio workspace ready with \(workspace.videos.count) videos.")
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Studio workspace load failed: \(error.localizedDescription)")
    }
  }

  func retryFailedStudioUpload(into appState: AppState) async {
    guard let retryURL = appState.retryableStudioUploadFileURL() else {
      appState.setError("Choose the original upload file again before retrying.")
      appendLog("Retry upload unavailable because the original file is missing.")
      return
    }

    await uploadVideo(from: retryURL, into: appState)
  }

  func loadChannelPage(
    channelKey: String,
    publicBeeKey: String? = nil,
    into appState: AppState
  ) async {
    guard await ensureReady(into: appState) else { return }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Loading channel page for \(String(channelKey.prefix(12))).")

    do {
      let workspace = try await fetchChannelWorkspace(
        channelKey: channelKey,
        publicBeeKey: publicBeeKey,
        appState: appState
      )
      appState.openChannelPage(profile: workspace.profile, videos: workspace.videos)
      primeThumbnailCache(with: workspace.videos)
      lastHeartbeat = Date()
      appendLog("Loaded \(workspace.videos.count) videos for \(workspace.profile.name).")
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Channel page load failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  func updateChannelMetadata(
    name: String?,
    description: String?,
    into appState: AppState
  ) async -> Bool {
    guard await ensureReady(into: appState) else { return false }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Updating native channel metadata.")

    defer { appState.setLoading(false) }

    do {
      _ = try await gatedRPC { hrpc in
        try await hrpc.updateChannel(
          UpdateChannelRequest(
            name: name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            description: description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            avatar: ""
          )
        )
      }

      if let profile = appState.channelPageProfile {
        let updatedProfile = appState.makeChannelProfile(
          channelKey: profile.channelKey,
          publicBeeKey: profile.publicBeeKey,
          avatarURL: profile.avatarURL?.absoluteString,
          name: name ?? profile.name,
          description: description ?? profile.description,
          videoCount: profile.videoCount
        )
        appState.updateChannelPage(profile: updatedProfile)
      }
      if let profile = appState.studioWorkspaceProfile,
         profile.role == .owner {
        let updatedProfile = appState.makeChannelProfile(
          channelKey: profile.channelKey,
          publicBeeKey: profile.publicBeeKey,
          avatarURL: profile.avatarURL?.absoluteString,
          name: name ?? profile.name,
          description: description ?? profile.description,
          videoCount: profile.videoCount
        )
        appState.updateStudioWorkspace(profile: updatedProfile)
      }
      lastHeartbeat = Date()
      appendLog("Native channel metadata updated.")
      return true
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Native channel metadata update failed: \(error.localizedDescription)")
      return false
    }
  }

  func updateChannelAvatar(into appState: AppState) async -> Bool {
    guard await ensureReady(into: appState) else { return false }
    guard let fileURL = chooseImageURL(title: "Choose a channel avatar", prompt: "Select Avatar") else {
      appendLog("Native channel avatar selection cancelled.")
      return false
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Updating native channel avatar from \(fileURL.lastPathComponent).")

    defer { appState.setLoading(false) }

    do {
      let mimeType = Self.mimeType(forImageURL: fileURL)
      let response = try await gatedRPC { hrpc in
        try await hrpc.updateChannelAvatar(
          UpdateChannelAvatarRequest(filePath: fileURL.path, imageData: "", mimeType: mimeType)
        )
      }
      guard response.success else {
        throw HostBridgeError.bridgeResponse(response.error?.isEmpty == false ? response.error! : "Failed to update channel avatar.")
      }
      lastHeartbeat = Date()
      appendLog("Native channel avatar updated.")
      return true
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Native channel avatar update failed: \(error.localizedDescription)")
      return false
    }
  }

  func updateVideoMetadata(
    for video: NativeVideo,
    title: String?,
    description: String?,
    category: String?,
    into appState: AppState
  ) async -> Bool {
    guard await ensureReady(into: appState) else { return false }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Updating metadata for \(video.title).")

    defer { appState.setLoading(false) }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.updateVideoMetadata(
          UpdateVideoMetadataRequest(
            channelKey: video.channelKey,
            videoId: video.backendVideoID,
            title: title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            description: description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            category: category?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
          )
        )
      }
      guard response.success else {
        throw HostBridgeError.bridgeResponse(response.error?.isEmpty == false ? response.error! : "Failed to update video metadata.")
      }
      lastHeartbeat = Date()
      appendLog("Video metadata updated for \(video.title).")
      return true
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Video metadata update failed: \(error.localizedDescription)")
      return false
    }
  }

  func deleteVideo(_ video: NativeVideo, into appState: AppState) async -> Bool {
    guard await ensureReady(into: appState) else { return false }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Deleting \(video.title) from the active channel.")

    defer { appState.setLoading(false) }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.deleteVideo(
          DeleteVideoRequest(videoId: video.backendVideoID)
        )
      }
      guard response.success else {
        throw HostBridgeError.bridgeResponse(response.error?.isEmpty == false ? response.error! : "Failed to delete video.")
      }
      lastHeartbeat = Date()
      appendLog("Deleted \(video.title) from the active channel.")
      return true
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Video deletion failed: \(error.localizedDescription)")
      return false
    }
  }

  func setVideoThumbnailFromFile(for video: NativeVideo, into appState: AppState) async -> Bool {
    guard await ensureReady(into: appState) else { return false }
    guard let fileURL = chooseImageURL(title: "Choose a video thumbnail", prompt: "Set Thumbnail") else {
      appendLog("Native thumbnail selection cancelled.")
      return false
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Setting thumbnail for \(video.title) from \(fileURL.lastPathComponent).")

    defer { appState.setLoading(false) }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.setVideoThumbnailFromFile(
          SetVideoThumbnailFromFileRequest(videoId: video.backendVideoID, filePath: fileURL.path)
        )
      }
      guard response.success else {
        throw HostBridgeError.bridgeResponse("Failed to set video thumbnail.")
      }
      lastHeartbeat = Date()
      appendLog("Updated thumbnail for \(video.title).")
      return true
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Video thumbnail update failed: \(error.localizedDescription)")
      return false
    }
  }

  func resolvePlayback(for video: NativeVideo) async -> URL? {
    guard isReady else { return nil }

    isResolvingPlayback = true
    activePlaybackVideoID = video.id
    resolvedPlaybackURL = nil
    lastPlaybackErrorMessage = nil
    appendLog("Resolving playback URL for \(video.title).")

    defer {
      isResolvingPlayback = false
      lastHeartbeat = Date()
    }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.preparePlayback(
          PreparePlaybackRequest(
            channelKey: video.channelKey,
            videoId: video.backendVideoID,
            publicBeeKey: video.publicBeeKey ?? "",
            blobId: video.blobId ?? "",
            blobsCoreKey: video.blobsCoreKey ?? "",
            mimeType: video.mimeType ?? ""
          )
        )
      }

      let url = URL(string: response.url)
      resolvedPlaybackURL = url
      appendLog("Playback URL resolved.")
      return url
    } catch {
      lastPlaybackErrorMessage = error.localizedDescription
      appendLog("Playback resolution failed: \(error.localizedDescription)")
      return nil
    }
  }

  func prepareAVPlayerURL(for video: NativeVideo) async -> URL? {
    guard let url = await resolvePlayback(for: video) else {
      return nil
    }

    startPlaybackStatsPolling(for: video)
    return url
  }

  func startPlaybackSession(
    for video: NativeVideo,
    renderSize: CGSize
  ) async -> NativePlaybackSession? {
    guard isReady else { return nil }

    let normalizedSize = CGSize(
      width: max(640, renderSize.width.rounded(.up)),
      height: max(360, renderSize.height.rounded(.up))
    )
    lastPlaybackRenderSize = normalizedSize

    guard let url = await resolvePlayback(for: video) else {
      return nil
    }

    await destroyActiveMpvPlayer()
    activePlaybackVideoID = video.id
    startPlaybackStatsPolling(for: video)

    let prefersFFmpegDecode = Self.prefersNativeFFmpegDecodePlayback(for: video)
    let prefersMpv = Self.prefersNativeMpvPlayback(for: video)

    guard prefersMpv || prefersFFmpegDecode else {
      mpvAvailable = false
      appendLog("Using AVPlayer for native playback.")
      return NativePlaybackSession(
        mode: .avPlayer,
        url: url,
        playerId: nil,
        frameServerPort: nil
      )
    }

    do {
      if prefersFFmpegDecode {
        let availability = await refreshFFmpegDecodeAvailability()
        if availability?.available == true {
          appendLog("Experimental bare-ffmpeg decode path selected for \(video.title), but the custom renderer is not wired yet. Falling back to bare-mpv.")
        } else {
          appendLog(
            "Experimental bare-ffmpeg decode path requested for \(video.title), but bare-ffmpeg is unavailable: \(availability?.error ?? ffmpegDecodeAvailabilityError ?? "Unknown error"). Falling back to bare-mpv."
          )
        }
      }

      if forceAVPlayerFallback {
        appendLog("Using AVPlayer fallback while bare-mpv is disabled for this native session.")
        return NativePlaybackSession(
          mode: .avPlayer,
          url: url,
          playerId: nil,
          frameServerPort: nil
        )
      }

      let (availability, createResponse, playerId) = try await gatedRPC { hrpc -> (MpvAvailableResponse, MpvCreateResponse?, String?) in
        let availability = try await hrpc.mpvAvailable(MpvAvailableRequest())

        var createResponse: MpvCreateResponse?
        var playerId: String?

        if availability.available {
          let response = try await hrpc.mpvCreate(
            MpvCreateRequest(
              width: UInt(normalizedSize.width),
              height: UInt(normalizedSize.height)
            )
          )
          createResponse = response

          if response.success, response.playerId?.isEmpty == false {
            let pid = response.playerId!

            let loadResponse = try await hrpc.mpvLoadFile(
              MpvLoadFileRequest(playerId: pid, url: url.absoluteString)
            )

            if loadResponse.success {
              let playResponse = try await hrpc.mpvPlay(MpvPlayerRequest(playerId: pid))

              if playResponse.success {
                playerId = pid
              } else {
                self.appendLog("bare-mpv play failed: \(playResponse.error?.isEmpty == false ? playResponse.error! : "Unknown error"). Falling back to AVPlayer.")
                _ = try? await hrpc.mpvDestroy(MpvPlayerRequest(playerId: pid))
              }
            } else {
              self.appendLog("bare-mpv load failed: \(loadResponse.error?.isEmpty == false ? loadResponse.error! : "Unknown error"). Falling back to AVPlayer.")
              _ = try? await hrpc.mpvDestroy(MpvPlayerRequest(playerId: pid))
            }
          }
        }

        return (availability, createResponse, playerId)
      }
      self.mpvAvailable = availability.available

      guard let createResponse else {
        appendLog("bare-mpv unavailable. Falling back to AVPlayer.")
        return NativePlaybackSession(
          mode: .avPlayer,
          url: url,
          playerId: nil,
          frameServerPort: nil
        )
      }

      guard let playerId else {
        if createResponse.playerId?.isEmpty == false {
          // load or play failed — already logged above
        } else {
          appendLog("bare-mpv create failed: \(createResponse.error?.isEmpty == false ? createResponse.error! : "Unknown error"). Falling back to AVPlayer.")
        }
        return NativePlaybackSession(
          mode: .avPlayer,
          url: url,
          playerId: nil,
          frameServerPort: nil
        )
      }

      activePlaybackVideoID = video.id
      activeMpvPlayerID = playerId
      activeMpvFrameServerPort = createResponse.frameServerPort.map { Int($0) }
      appendLog("bare-mpv playback session started for \(video.title).")

      Task { @MainActor [weak self] in
        guard let self else { return }

        let didProducePlayback = await self.waitForMpvPlaybackSignal(playerId: playerId, maxAttempts: 60)
        guard self.activeMpvPlayerID == playerId else { return }

        if didProducePlayback {
          self.appendLog("bare-mpv produced its first playback signal for \(video.title).")
        } else {
          self.appendLog("bare-mpv has not produced a playback frame yet for \(video.title). Keeping the mpv session alive and waiting in the player surface.")
        }
      }

      return NativePlaybackSession(
        mode: .mpv,
        url: url,
        playerId: playerId,
        frameServerPort: createResponse.frameServerPort.map { Int($0) }
      )
    } catch {
      appendLog("bare-mpv session failed: \(error.localizedDescription). Falling back to AVPlayer.")
      mpvAvailable = false
      return NativePlaybackSession(
        mode: .avPlayer,
        url: url,
        playerId: nil,
        frameServerPort: nil
      )
    }
  }

  static func shouldAcceptPlaybackCommand(
    activeVideoID: NativeVideo.ID?,
    activePlayerID: String?,
    requestedVideoID: NativeVideo.ID,
    requestedPlayerID: String
  ) -> Bool {
    activeVideoID == requestedVideoID && activePlayerID == requestedPlayerID
  }

  private func shouldAcceptActivePlaybackCommand(for videoID: NativeVideo.ID, playerId: String) -> Bool {
    Self.shouldAcceptPlaybackCommand(
      activeVideoID: activePlaybackVideoID,
      activePlayerID: activeMpvPlayerID,
      requestedVideoID: videoID,
      requestedPlayerID: playerId
    )
  }

  func pauseActivePlayback(for video: NativeVideo) async {
    guard let playerId = activeMpvPlayerID else { return }
    guard shouldAcceptActivePlaybackCommand(for: video.id, playerId: playerId) else {
      appendLog("Ignoring stale bare-mpv pause for \(video.title).")
      return
    }

    do {
      _ = try await gatedRPC { hrpc in
        try await hrpc.mpvPause(MpvPlayerRequest(playerId: playerId))
      }
    } catch {
      appendLog("bare-mpv pause failed: \(error.localizedDescription)")
    }
  }

  func resumeActivePlayback(for video: NativeVideo) async {
    guard let playerId = activeMpvPlayerID else { return }
    guard shouldAcceptActivePlaybackCommand(for: video.id, playerId: playerId) else {
      appendLog("Ignoring stale bare-mpv resume for \(video.title).")
      return
    }

    do {
      _ = try await gatedRPC { hrpc in
        try await hrpc.mpvPlay(MpvPlayerRequest(playerId: playerId))
      }
    } catch {
      appendLog("bare-mpv resume failed: \(error.localizedDescription)")
    }
  }

  func seekActivePlayback(for video: NativeVideo, to time: Double) async {
    guard let playerId = activeMpvPlayerID else { return }
    guard shouldAcceptActivePlaybackCommand(for: video.id, playerId: playerId) else {
      appendLog("Ignoring stale bare-mpv seek for \(video.title).")
      return
    }

    do {
      _ = try await gatedRPC { hrpc in
        try await hrpc.mpvSeek(MpvSeekRequest(playerId: playerId, time: String(time)))
      }
    } catch {
      appendLog("bare-mpv seek failed: \(error.localizedDescription)")
    }
  }

  func activePlaybackState(for video: NativeVideo) async -> NativeMpvState? {
    guard let playerId = activeMpvPlayerID else { return nil }
    guard shouldAcceptActivePlaybackCommand(for: video.id, playerId: playerId) else { return nil }

    do {
      return try await gatedRPC { hrpc in
        let response = try await hrpc.mpvGetState(MpvPlayerRequest(playerId: playerId))
        return NativeMpvState(schema: response)
      }
    } catch {
      appendLog("bare-mpv state polling failed: \(error.localizedDescription)")
      return nil
    }
  }

  func activePlaybackFrame(for video: NativeVideo) async -> NativeMpvRenderFrame? {
    guard let playerId = activeMpvPlayerID else { return nil }
    guard shouldAcceptActivePlaybackCommand(for: video.id, playerId: playerId) else { return nil }

    do {
      return try await gatedRPC { hrpc in
        let response = try await hrpc.mpvRenderFrame(MpvPlayerRequest(playerId: playerId))
        return NativeMpvRenderFrame(schema: response)
      }
    } catch {
      appendLog("bare-mpv frame fetch failed: \(error.localizedDescription)")
      return nil
    }
  }

  func activePlaybackFrameURL() -> URL? {
    guard let playerId = activeMpvPlayerID,
          let frameServerPort = activeMpvFrameServerPort else {
      return nil
    }

    guard let encodedPlayerId = playerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
      return nil
    }

    return URL(string: "http://127.0.0.1:\(frameServerPort)/frame/\(encodedPlayerId)")
  }

  func thumbnailURL(for video: NativeVideo) -> URL? {
    guard let baseURL = thumbnailURLs[video.thumbnailCacheKey] ?? video.thumbnailURL else {
      return nil
    }

    guard let revision = thumbnailRefreshTokens[video.thumbnailCacheKey], revision > 0 else {
      return baseURL
    }

    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    var queryItems = components?.queryItems ?? []
    queryItems.removeAll { $0.name == "pt_rev" }
    queryItems.append(URLQueryItem(name: "pt_rev", value: String(revision)))
    components?.queryItems = queryItems
    return components?.url ?? baseURL
  }

  func ensureThumbnail(for video: NativeVideo) async {
    await resolveThumbnail(for: video, force: false)
  }

  func refreshThumbnail(for video: NativeVideo) async {
    thumbnailRefreshTokens[video.thumbnailCacheKey] = (thumbnailRefreshTokens[video.thumbnailCacheKey] ?? 0) + 1
    thumbnailURLs.removeValue(forKey: video.thumbnailCacheKey)
    await resolveThumbnail(for: video, force: true)
  }

  static func resolveUploadedStudioVideo(
    snapshot: NativeBrowseSnapshot,
    uploadJob: NativeUploadJob?,
    activeIdentityChannelKey: String?
  ) -> NativeVideo? {
    if let videoID = uploadJob?.videoID, !videoID.isEmpty {
      if let matchingStudioVideo = snapshot.sections.studio.first(where: {
        $0.backendVideoID == videoID || $0.id == videoID
      }) {
        return matchingStudioVideo
      }

      if let matchingLibraryVideo = snapshot.sections.library.first(where: {
        $0.backendVideoID == videoID || $0.id == videoID
      }) {
        return matchingLibraryVideo
      }
    }

    let trimmedTitle = uploadJob?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if let activeIdentityChannelKey, !trimmedTitle.isEmpty {
      return snapshot.sections.studio.first(where: {
        $0.channelKey == activeIdentityChannelKey && $0.title == trimmedTitle
      })
    }

    return snapshot.sections.studio.first(where: {
      guard let activeIdentityChannelKey else { return false }
      return $0.channelKey == activeIdentityChannelKey
    })
  }

  private func resolveThumbnail(for video: NativeVideo, force: Bool) async {
    if !force, thumbnailURL(for: video) != nil { return }
    guard isReady else { return }
    let thumbnailKey = video.thumbnailCacheKey
    guard !inFlightThumbnailIDs.contains(thumbnailKey) else { return }

    inFlightThumbnailIDs.insert(thumbnailKey)
    defer { inFlightThumbnailIDs.remove(thumbnailKey) }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.getVideoThumbnail(
          GetVideoThumbnailRequest(
            channelKey: video.channelKey,
            videoId: video.thumbnailReference,
            thumbnailBlobId: video.blobId ?? "",
            thumbnailBlobsCoreKey: video.blobsCoreKey ?? ""
          )
        )
      }

      if response.exists, let urlString = response.url, !urlString.isEmpty, let url = URL(string: urlString) {
        thumbnailURLs[video.thumbnailCacheKey] = url
      }
    } catch {
      appendLog("Thumbnail resolution failed for \(video.title): \(error.localizedDescription)")
    }
  }

  func listComments(
    for video: NativeVideo,
    page: Int = 0,
    limit: Int = 50
  ) async throws -> NativeListCommentsResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.listComments(
        ListCommentsRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          page: UInt(page),
          limit: UInt(limit),
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func addComment(
    text: String,
    to video: NativeVideo,
    parentId: String? = nil,
    authorChannelKey: String? = nil
  ) async throws -> NativeAddCommentResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.addComment(
        AddCommentRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          text: text,
          parentId: parentId ?? "",
          authorChannelKey: authorChannelKey ?? "",
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func hideComment(
    _ comment: NativeComment,
    on video: NativeVideo,
    authorChannelKey: String? = nil
  ) async throws -> NativeHideCommentResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.hideComment(
        HideCommentRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          commentId: comment.commentId,
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func removeComment(
    _ comment: NativeComment,
    on video: NativeVideo,
    authorChannelKey: String? = nil
  ) async throws -> NativeRemoveCommentResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.removeComment(
        RemoveCommentRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          commentId: comment.commentId,
          authorChannelKey: authorChannelKey ?? "",
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func addReaction(
    _ reactionType: String,
    to video: NativeVideo,
    authorChannelKey: String? = nil
  ) async throws -> NativeAddReactionResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.addReaction(
        AddReactionRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          reactionType: reactionType,
          authorChannelKey: authorChannelKey ?? "",
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func removeReaction(
    from video: NativeVideo,
    authorChannelKey: String? = nil
  ) async throws -> NativeRemoveReactionResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.removeReaction(
        RemoveReactionRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          authorChannelKey: authorChannelKey ?? "",
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func getReactions(
    for video: NativeVideo,
    authorChannelKey: String? = nil
  ) async throws -> NativeGetReactionsResponse {
    return try await gatedRPC { hrpc in
      try await hrpc.getReactions(
        GetReactionsRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID,
          authorChannelKey: authorChannelKey ?? "",
          publicBeeKey: video.publicBeeKey ?? ""
        )
      )
    }
  }

  func diagnosticsReport(appState: AppState? = nil) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .medium

    var lines = [
      "PearTube Native Diagnostics",
      "Status: \(statusTitle)",
      "Storage: \(selectedStoragePath ?? "Unavailable")",
      "Last heartbeat: \(lastHeartbeat.map(formatter.string(from:)) ?? "Never")",
      "Persistent log: \(diagnosticsLogURL.path)",
    ]

    let mediaExtensionDiagnostics = professionalVideoWorkflowDiagnostics
    lines.append(contentsOf: mediaExtensionDiagnostics.reportLines)
    lines.append("FFmpeg decode lab: \(ffmpegDecodeDiagnosticsTitle)")
    lines.append("FFmpeg decode engine: \(ffmpegDecodeDiagnosticsCaption)")

    if let activeMediaExtensionPlaybackSummary {
      lines.append("Active playback MediaExtension: \(activeMediaExtensionPlaybackSummary)")
    }

    if let errorMessage = appState?.lastErrorMessage, !errorMessage.isEmpty {
      lines.append("App error: \(errorMessage)")
    }

    lines.append("")
    lines.append("Recent host log:")
    lines.append(contentsOf: logLines.suffix(40))
    return lines.joined(separator: "\n")
  }

  func copyDiagnosticsToPasteboard(appState: AppState? = nil) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(diagnosticsReport(appState: appState), forType: .string)
    appendLog("Copied diagnostics report to the clipboard.")
  }

  private func startPlaybackStatsPolling(for video: NativeVideo) {
    playbackStatsTask?.cancel()
    playbackStats = nil

    playbackStatsTask = Task { @MainActor [weak self] in
      guard let self else { return }

      while !Task.isCancelled {
        guard self.activePlaybackVideoID == video.id else { return }

        do {
          let stats = try await self.fetchVideoStats(for: video)
          guard !Task.isCancelled else { return }

          self.playbackStats = stats
          if let error = stats.error, !error.isEmpty {
            self.lastPlaybackErrorMessage = error
          }
        } catch {
          self.appendLog("Playback stats polling failed: \(error.localizedDescription)")
        }

        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  private func fetchVideoStats(for video: NativeVideo) async throws -> NativeVideoStats {
    let response = try await gatedRPC { hrpc in
      try await hrpc.getVideoStats(
        GetVideoStatsRequest(
          channelKey: video.channelKey,
          videoId: video.backendVideoID
        )
      )
    }
    guard let stats = response.stats else {
      return NativeVideoStats(error: "No stats returned")
    }
    return NativeVideoStats(schema: stats)
  }

  private func waitForAVPlayerReadiness(
    for video: NativeVideo,
    maxAttempts: Int = 12,
    delay: Duration = .milliseconds(500)
  ) async -> NativeVideoStats? {
    var lastStats: NativeVideoStats?

    for attempt in 0..<maxAttempts {
      guard activePlaybackVideoID == video.id else { return nil }

      do {
        let stats = try await fetchVideoStats(for: video)
        guard !Task.isCancelled else { return nil }
        playbackStats = stats
        lastStats = stats

        if let error = stats.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
          lastPlaybackErrorMessage = error
        }

        if Self.isAVPlayerReadyForPlayback(stats) {
          return stats
        }
      } catch {
        if attempt == maxAttempts - 1 {
          appendLog("Playback readiness check failed: \(error.localizedDescription)")
        }
      }

      if attempt < maxAttempts - 1 {
        try? await Task.sleep(for: delay)
      }
    }

    if let lastStats {
      playbackStats = lastStats
      if let error = lastStats.error?.trimmingCharacters(in: .whitespacesAndNewlines),
         !error.isEmpty {
        lastPlaybackErrorMessage = error
      } else if lastStats.downloadedBlocks == 0, lastStats.downloadedBytes == 0 {
        lastPlaybackErrorMessage = "Playback source is not ready yet. Waiting for the first video data to arrive."
      } else {
        lastPlaybackErrorMessage = "Playback did not become ready in time."
      }
    } else {
      lastPlaybackErrorMessage = "Playback stats could not be loaded."
    }

    return nil
  }

  private func stopPlaybackStatsPolling() {
    playbackStatsTask?.cancel()
    playbackStatsTask = nil
    playbackStats = nil
  }

  private func scheduleAutomaticFeedWarmupIfNeeded(
    snapshot: NativeBrowseSnapshot,
    appState: AppState,
    keepRefreshingWhileShowingCachedFeed: Bool = false
  ) {
    feedWarmupTask?.cancel()
    feedWarmupTask = nil

    guard snapshot.stats.homeCount == 0 else { return }

    feedWarmupTask = Task { @MainActor [weak self] in
      guard let self else { return }

      let attempts: [(delay: Duration, requestFeed: Bool)] = [
        (.seconds(2), true),
        (.seconds(8), true),
        (.seconds(20), true),
        (.seconds(40), true),
        (.seconds(80), true),
        (.seconds(150), true),
      ]

      for (index, attempt) in attempts.enumerated() {
        try? await Task.sleep(for: attempt.delay)
        guard !Task.isCancelled else { return }
        guard self.isReady else { return }
        if !keepRefreshingWhileShowingCachedFeed {
          guard appState.videoCount(for: .home) == 0 else { return }
        }
        guard !appState.isSearchActive else { return }
        guard appState.currentSection == .home || appState.currentSection == .diagnostics else { return }

        if index == 0 {
          self.appendLog("Warming public feed after startup.")
        } else {
          self.appendLog("Retrying public feed warmup after initial peer discovery window.")
        }

        if attempt.requestFeed {
          await self.refreshPublicFeed(into: appState)
        } else {
          await self.refreshBrowse(into: appState)
        }
      }
    }
  }

  private func persistBrowseSnapshotIfUseful(_ snapshot: NativeBrowseSnapshot) {
    let persistedSnapshot = Self.snapshotForPersistence(
      liveSnapshot: snapshot,
      cachedSnapshot: Self.loadCachedBrowseSnapshot(from: snapshotCacheURL)
    )
    guard Self.shouldPersistBrowseSnapshot(persistedSnapshot) else { return }
    Self.persistBrowseSnapshot(persistedSnapshot, to: snapshotCacheURL)
  }

  func startPlaybackTracking(for video: NativeVideo) {
    activePlaybackVideoID = video.id
    startPlaybackStatsPolling(for: video)
  }

  func installAVPlayer(_ player: AVPlayer, for video: NativeVideo) {
    activeAVPlayer?.pause()
    activeAVPlayer = player
    activePlaybackVideoID = video.id
  }

  func pauseActiveAVPlayer() {
    activeAVPlayer?.pause()
  }

  func resumeActiveAVPlayer() {
    activeAVPlayer?.play()
  }

  func releaseAVPlayer() {
    activeAVPlayer?.pause()
    activeAVPlayer = nil
  }

  func clearPlayback() {
    // RPC cancellation is now handled per-Task (Task.cancel()) rather than
    // via a gate flush, because the actor model lets requests run in parallel
    // instead of queueing serially.
    stopPlaybackStatsPolling()
    releaseAVPlayer()
    let playerId = activeMpvPlayerID
    if let playerId {
      Task { [weak self] in
        await self?.destroyMpvPlayer(playerId: playerId)
      }
    }
    activePlaybackVideoID = nil
    resolvedPlaybackURL = nil
    isResolvingPlayback = false
    lastPlaybackErrorMessage = nil
    activeMpvPlayerID = nil
    activeMpvFrameServerPort = nil
  }

  func recordPlaybackUIEvent(_ line: String) {
    appendLog("[ui] \(line)")
  }

  private func chooseVideoURL() -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.allowedFileTypes = Array(Self.supportedVideoUploadFileExtensions).sorted()
    panel.title = "Choose a video to upload"
    panel.prompt = "Upload"

    return panel.runModal() == .OK ? panel.urls.first : nil
  }

  private func chooseImageURL(title: String, prompt: String) -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.allowedFileTypes = ["jpg", "jpeg", "png", "webp"]
    panel.title = title
    panel.prompt = prompt

    return panel.runModal() == .OK ? panel.urls.first : nil
  }

  private func defaultIdentityName() -> String {
    let base = ProcessInfo.processInfo.fullUserName.trimmingCharacters(in: .whitespacesAndNewlines)
    if base.isEmpty {
      return "PearTube Channel"
    }
    return "\(base)'s Channel"
  }

  private func fetchChannelWorkspace(
    channelKey: String,
    publicBeeKey: String?,
    appState: AppState
  ) async throws -> (profile: NativeChannelProfile, videos: [NativeVideo]) {
    let (meta, videos) = try await gatedRPC { hrpc in
      async let metaResponse = hrpc.getChannelMeta(
        GetChannelMetaRequest(
          channelKey: channelKey,
          publicBeeKey: publicBeeKey ?? ""
        )
      )
      async let videosResponse = hrpc.listVideos(
        ListVideosRequest(
          channelKey: channelKey,
          publicBeeKey: publicBeeKey ?? "",
          limit: 0,
          offset: 0
        )
      )
      return try await (metaResponse, videosResponse)
    }
    let profile = appState.makeChannelProfile(
      channelKey: channelKey,
      publicBeeKey: publicBeeKey,
      avatarURL: nil,
      name: meta.name?.isEmpty == false ? meta.name : nil,
      description: meta.description?.isEmpty == false ? meta.description : nil,
      videoCount: meta.videoCount.flatMap { $0 > 0 ? Int($0) : nil }
    )
    let nativeVideos = (videos.videos ?? []).map { NativeVideo(video: $0, channelKey: channelKey) }
    return (profile, nativeVideos)
  }

  private func destroyActiveMpvPlayer() async {
    guard let playerId = activeMpvPlayerID else {
      activeMpvFrameServerPort = nil
      return
    }

    await destroyMpvPlayer(playerId: playerId)
  }

  private func destroyMpvPlayer(playerId: String) async {
    if activeMpvPlayerID == playerId {
      activeMpvPlayerID = nil
    }

    do {
      _ = try await gatedRPC { hrpc in
        try await hrpc.mpvDestroy(MpvPlayerRequest(playerId: playerId))
      }
    } catch {
      appendLog("bare-mpv destroy failed: \(error.localizedDescription)")
    }

    activeMpvFrameServerPort = nil
  }

  private func waitForMpvPlaybackSignal(playerId: String, maxAttempts: Int = 20) async -> Bool {
    for _ in 0..<maxAttempts {
      guard !Task.isCancelled else { return false }

      var state: NativeMpvState?
      var frame: NativeMpvRenderFrame?

      if let responses = try? await gatedRPC({ hrpc in
        let stateResponse = try? await hrpc.mpvGetState(MpvPlayerRequest(playerId: playerId))
        let frameResponse = try? await hrpc.mpvRenderFrame(MpvPlayerRequest(playerId: playerId))
        return (stateResponse, frameResponse)
      }) {
        if let stateResponse = responses.0 {
          state = NativeMpvState(schema: stateResponse)
        }
        if let frameResponse = responses.1 {
          frame = NativeMpvRenderFrame(schema: frameResponse)
        }
      }

      guard !Task.isCancelled else { return false }

      if Self.mpvSessionHasPlaybackSignal(state: state, frame: frame) {
        return true
      }

      try? await Task.sleep(for: .milliseconds(250))
    }

    return false
  }

  private func ensureReady(into appState: AppState) async -> Bool {
    observe(appState)
    if isReady { return true }
    await bootstrap(appState: appState)
    return isReady
  }

  // Old performSnapshotMutation overloads removed — use performSnapshotMutationViaHRPC instead.

  func resetBridgeState() async {
    feedWarmupTask?.cancel()
    feedWarmupTask = nil
    feedUpdateRefreshTask?.cancel()
    feedUpdateRefreshTask = nil
    await requestBridgeShutdownIfNeeded()
    discardBridgeAfterBootstrapFailure()
    phase = .idle
    lastHeartbeat = nil
    clearPlayback()
  }

  private func requestBridgeShutdownIfNeeded() async {
    guard let hrpc else { return }

    do {
      _ = try await hrpc.desktopShutdown(DesktopShutdownRequest())
      appendLog("Native host shutdown acknowledged.")
    } catch {
      appendLog("Native host shutdown request failed: \(error.localizedDescription)")
    }
  }

  private func appendLog(_ line: String) {
    guard !Self.shouldSuppressDiagnosticsTransportLog(line) else { return }

    logLines.append(line)
    if logLines.count > logLimit {
      logLines.removeFirst(logLines.count - logLimit)
    }
    Self.appendPersistentLog(line, to: diagnosticsLogURL)
  }

  private func primeThumbnailCache(with snapshot: NativeBrowseSnapshot) {
    primeThumbnailCache(with: snapshot.sections.home)
    primeThumbnailCache(with: snapshot.sections.subscriptions)
    primeThumbnailCache(with: snapshot.sections.library)
    primeThumbnailCache(with: snapshot.sections.studio)
    primeThumbnailCache(with: snapshot.sections.diagnostics)
  }

  private func primeThumbnailCache(with videos: [NativeVideo]) {
    for video in videos {
      if let url = video.thumbnailURL {
        thumbnailURLs[video.thumbnailCacheKey] = url
      }
    }
  }

  private func ensureBridgeRunning() async throws {
    if hostSession != nil, hrpc != nil {
      return
    }

    switch Self.preferredNativeHostTransportMode() {
    case .sidecar:
      try ensureSidecarBridgeRunning()
    case .embedded:
      try await ensureWorkletBridgeRunning()
    }
  }

  private func discardBridgeAfterBootstrapFailure() {
    feedUpdateRefreshTask?.cancel()
    feedUpdateRefreshTask = nil
    hostSession?.terminate()
    hostSession = nil
    currentHostTransportMode = nil
    hrpc = nil
    hrpcDelegate = nil
    inFlightThumbnailIDs.removeAll()
    thumbnailURLs.removeAll()
    stopPlaybackStatsPolling()
    mpvAvailable = false
    forceAVPlayerFallback = false
    activeMpvPlayerID = nil
    activeMpvFrameServerPort = nil
    networkStatus = nil
  }

  private func makeHRPC(
    logPrefix: String,
    onSend: @escaping @Sendable (Data) -> Void
  ) -> HRPC {
    let delegate = HostBridgeRPCDelegate(
      send: onSend,
      logError: { [weak self] error in
        Task { @MainActor [weak self] in
          self?.appendLog("\(logPrefix) RPC decode failed: \(error.localizedDescription)")
        }
      }
    )
    self.hrpcDelegate = delegate
    let hrpc = HRPC(delegate: delegate)
    registerEventHandlers(on: hrpc)
    return hrpc
  }

  private func registerEventHandlers(on hrpc: HRPC) {
    hrpc.onEventReady { [weak self] event in
      await MainActor.run { [weak self] in
        self?.lastHeartbeat = Date()
        let port = event.blobServerPort.flatMap { $0 > 0 ? Int($0) : nil }
        self?.phase = .ready(blobServerPort: port)
        if Self.isExperimentalFFmpegDecodeEnabled() {
          Task { @MainActor [weak self] in
            _ = await self?.refreshFFmpegDecodeAvailability()
          }
        }
      }
    }

    hrpc.onEventError { [weak self] event in
      await MainActor.run { [weak self] in
        self?.lastHeartbeat = Date()
        let message = event.message.isEmpty ? "Unknown host error" : event.message
        if case .failed(let existingMessage) = self?.phase,
           Self.isInProcessRelaunchRequiredMessage(existingMessage) {
          self?.appendLog("Host error arrived after relaunch-required state was already set: \(message)")
          return
        }
        self?.phase = .failed(message)
        self?.appendLog("Host error: \(message)")
      }
    }

    hrpc.onEventLog { [weak self] event in
      await MainActor.run { [weak self] in
        self?.lastHeartbeat = Date()
        if !event.message.isEmpty {
          self?.appendLog(event.message)
        }
      }
    }

    hrpc.onEventFeedUpdate { [weak self] event in
      await MainActor.run { [weak self] in
        self?.lastHeartbeat = Date()
        let channelKey = event.channelKey.isEmpty ? "feed" : event.channelKey
        let action = event.action.isEmpty ? "update" : event.action
        self?.appendLog("Embedded host reported a feed update (\(action)) for \(channelKey).")
        self?.scheduleAutomaticFeedRefresh()
      }
    }

    hrpc.onEventUploadProgress { [weak self] event in
      await MainActor.run { [weak self] in
        self?.lastHeartbeat = Date()
        let nativeEvent = NativeUploadProgressEvent(schema: event)
        if let appState = self?.observedAppState {
          self?.applyUploadProgressEvent(nativeEvent, to: appState)
          self?.appendLog("Upload progress \(nativeEvent.progress)% for \(nativeEvent.videoId.isEmpty ? "active upload" : nativeEvent.videoId).")
        }
      }
    }
  }

  private func ensureWorkletBridgeRunning() async throws {
    configureEmbeddedBareKitEnvironment()
    let bundleURL = try resolveWorkletBundleURL()
    let sessionSink = WorkletSessionSink()
    let hrpc = makeHRPC(
      logPrefix: "Embedded BareKit"
    ) { frame in
      sessionSink.write(frame)
    }
    let session = try EmbeddedBareKitSession(
      bundleURL: bundleURL,
      assetsPath: Bundle.main.resourceURL?.path,
      onData: { [weak self] data in
        DispatchQueue.main.async { [weak self] in
          self?.handleBridgeOutputData(data)
        }
      },
      onLog: { [weak self] message in
        Task { @MainActor [weak self] in
          self?.appendLog(message)
        }
      },
      onClosed: { [weak self] in
        Task { @MainActor [weak self] in
          self?.handleHostSessionTermination()
        }
      }
    )

    sessionSink.session = session
    self.hrpc = hrpc
    self.hostSession = session
    self.currentHostTransportMode = .embedded
    appendLog("Embedded BareKit worklet launched from \(bundleURL.path).")
  }

  private func ensureSidecarBridgeRunning() throws {
    // Prefer bare-native .app bundle (addons in Frameworks/, properly codesigned)
    let runtimeURL: URL
    let bundleURL: URL?
    if let nativeBinary = resolveNativeSidecarBinary() {
      runtimeURL = nativeBinary
      bundleURL = nil
    } else {
      runtimeURL = try resolveBareRuntimeURL()
      bundleURL = try resolveSidecarBundleURL()
    }
    let sessionSink = WorkletSessionSink()
    let hrpc = makeHRPC(
      logPrefix: "Native host sidecar"
    ) { frame in
      sessionSink.write(frame)
    }

    var environment = ProcessInfo.processInfo.environment
    if let frameworkPath = linkedAddonFrameworkPath() {
      environment["DYLD_FRAMEWORK_PATH"] = frameworkPath
      appendLog("Native host sidecar linked addons: \(frameworkPath)")
    }
    if let mpvPrebuildRoot = bundledMpvPrebuildRootPath() {
      environment["BARE_MPV_PREBUILD_ROOT"] = mpvPrebuildRoot
    }

    let session = try BareRuntimeSidecarSession(
      runtimeURL: runtimeURL,
      bundleURL: bundleURL,
      environment: environment,
      onData: { [weak self] data in
        DispatchQueue.main.async { [weak self] in
          self?.handleBridgeOutputData(data)
        }
      },
      onLog: { [weak self] message in
        Task { @MainActor [weak self] in
          self?.appendLog(message)
        }
      },
      onClosed: { [weak self] in
        Task { @MainActor [weak self] in
          self?.handleHostSessionTermination()
        }
      }
    )

    sessionSink.session = session
    self.hrpc = hrpc
    self.hostSession = session
    self.currentHostTransportMode = .sidecar
    if let bundleURL {
      appendLog("Native host sidecar launched from \(runtimeURL.path) using \(bundleURL.path).")
    } else {
      appendLog("Native host sidecar launched as bare-native binary: \(runtimeURL.path)")
    }
  }

  private func configureEmbeddedBareKitEnvironment() {
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", workletDebugLogURL.path, 1)
    setenv("PEARTUBE_NATIVE_EMBEDDED_BAREKIT", "1", 1)
    if let frameworkPath = linkedAddonFrameworkPath() {
      setenv("DYLD_FRAMEWORK_PATH", frameworkPath, 1)
    }
    if let mpvPrebuildRoot = bundledMpvPrebuildRootPath() {
      setenv("BARE_MPV_PREBUILD_ROOT", mpvPrebuildRoot, 1)
    }
  }

  private func linkedAddonFrameworkPath(fileManager: FileManager = .default) -> String? {
    Self.preferredLinkedAddonFrameworkPath(fileManager: fileManager)
  }

  private func bundledMpvPrebuildRootPath(fileManager: FileManager = .default) -> String? {
    if let bundledPath = Bundle.main.resourceURL?
      .appendingPathComponent("Generated", isDirectory: true)
      .appendingPathComponent("bare-mpv-prebuilds", isDirectory: true).path,
       fileManager.fileExists(atPath: bundledPath) {
      return bundledPath
    }

    do {
      let workspaceRoot = try Self.workspaceRootURL()
      let workspacePath = workspaceRoot
        .appendingPathComponent("packages/desktop-native/Resources/Generated/bare-mpv-prebuilds", isDirectory: true)
        .path
      if fileManager.fileExists(atPath: workspacePath) {
        return workspacePath
      }
    } catch {}

    return nil
  }

  private func handleBridgeOutputData(_ data: Data) {
    guard !data.isEmpty else { return }
    hrpc?.receive(data)
  }

  private func handleHostSessionTermination() {
    guard hostSession != nil else { return }

    let disconnectError = HostBridgeError.bridgeDisconnected
    let transportMode = currentHostTransportMode
    feedUpdateRefreshTask?.cancel()
    feedUpdateRefreshTask = nil
    hostSession = nil
    currentHostTransportMode = nil
    hrpc = nil
    hrpcDelegate = nil
    stopPlaybackStatsPolling()
    networkStatus = nil

    if case .booting = phase {
      phase = .failed(disconnectError.localizedDescription)
    }

    appendLog("\(transportMode?.label ?? "Native host bridge") closed.")
    appendLog(disconnectError.localizedDescription)
  }

  // Event handling is now registered via registerEventHandlers(on:) in makeHRPC().

  func applyUploadProgressEvent(_ payload: NativeUploadProgressEvent, to appState: AppState) {
    appState.applyUploadProgress(payload)
  }

  private func observe(_ appState: AppState) {
    observedAppState = appState
  }

  private func scheduleAutomaticFeedRefresh() {
    guard case .ready = phase else { return }
    guard let appState = observedAppState else {
      appendLog("Skipping automatic feed refresh because no app state is attached.")
      return
    }
    guard feedUpdateRefreshTask == nil else {
      appendLog("Coalescing feed update while a browse refresh is already pending.")
      return
    }

    feedUpdateRefreshTask = Task { @MainActor [weak self, weak appState] in
      defer { self?.feedUpdateRefreshTask = nil }
      try? await Task.sleep(for: .milliseconds(350))
      guard let self, let appState else { return }
      guard self.isReady else { return }
      await self.refreshBrowse(into: appState)
    }
  }

  /// Ensures the bridge is running and returns the HRPC instance, or throws.
  private func ensureHRPC() async throws -> HRPC {
    try await ensureBridgeRunning()
    guard let hrpc else {
      throw HostBridgeError.bridgeInputUnavailable
    }
    return hrpc
  }

  /// Passthrough wrapper around HRPC calls. Historically serialized through
  /// `RPCGate`; now a no-op because `BareRPC.RPC` is an actor and handles
  /// concurrent request/receive safely. Kept as a single entry point so
  /// future cross-cutting concerns (retries, logging) have one place to land.
  private func gatedRPC<T>(_ body: (HRPC) async throws -> T) async throws -> T {
    let hrpc = try await ensureHRPC()
    return try await body(hrpc)
  }

  private static func validateProtocolVersion(_ version: UInt?) throws {
    let actual = version.map(Int.init)
    guard actual == supportedProtocolVersion else {
      throw HostBridgeError.protocolVersionMismatch(
        expected: supportedProtocolVersion,
        actual: actual
      )
    }
  }

  /// Performs any HRPC call, then refreshes the browse snapshot afterward.
  private func performSnapshotMutationViaHRPC(
    into appState: AppState,
    logMessage: String,
    allowCachedFeedFallback: Bool = true,
    afterApply: ((AppState) -> Void)? = nil,
    call: (HRPC) async throws -> Void
  ) async {
    appState.setLoading(true)
    appState.setError(nil)
    appendLog(logMessage)

    do {
      let response = try await gatedRPC { hrpc in
        // Execute the mutation command
        try await call(hrpc)
        // Then refresh the browse snapshot
        return try await hrpc.desktopRefreshBrowse(DesktopRefreshBrowseRequest())
      }
      let liveSnapshot = NativeBrowseSnapshot(schema: response.snapshot)
      let snapshot = Self.resolvedBrowseSnapshot(
        liveSnapshot: liveSnapshot,
        cachedSnapshot: Self.loadCachedBrowseSnapshot(from: snapshotCacheURL),
        allowCachedFeedFallback: allowCachedFeedFallback
      )
      if allowCachedFeedFallback, snapshot != liveSnapshot {
        appendLog("Retaining cached browse snapshot because the live public feed is still empty.")
      }
      persistBrowseSnapshotIfUseful(snapshot)
      appState.applySnapshot(snapshot)
      afterApply?(appState)
      lastHeartbeat = Date()
      appendLog("Native host mutation completed. Home now has \(appState.videoCount(for: .home)) videos.")
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Native host mutation failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  // Unified storage path: both desktop apps (Electrobun + native Swift) use
  // ~/.peartube so their corestores, identity, and cache state stay in sync.
  // Never run both apps simultaneously — corestore is not multi-process safe.
  static func preferredStoragePath(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = realUserHomeDirectory(environment: ProcessInfo.processInfo.environment)
  ) -> String {
    if let override = environment["PEARTUBE_NATIVE_STORAGE_PATH"], !override.isEmpty {
      return override
    }
    return homeDirectory.appendingPathComponent(".peartube", isDirectory: true).path
  }

  static func realUserHomeDirectory(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> URL {
    if let override = environment["PEARTUBE_NATIVE_REAL_HOME"], !override.isEmpty {
      return URL(fileURLWithPath: override, isDirectory: true)
    }

    if let home = getpwuid(getuid())?.pointee.pw_dir {
      return URL(fileURLWithPath: String(cString: home), isDirectory: true)
    }

    return FileManager.default.homeDirectoryForCurrentUser
  }

  static func archiveNativeStoreIfRecoverable(
    storagePath: String,
    message: String,
    fileManager: FileManager = .default,
    backupTimestamp: String = timestampForBackupName()
  ) -> String? {
    guard isRecoverableNativeStoragePath(storagePath) else { return nil }
    guard recoverableBootstrapErrorCode(from: message) != nil else { return nil }
    guard nativeStoreHasNoIdentity(at: storagePath, fileManager: fileManager) else { return nil }
    guard fileManager.fileExists(atPath: storagePath) else { return nil }

    let sourceURL = URL(fileURLWithPath: storagePath, isDirectory: true)
    let backupURL = nativeStoreBackupURL(for: sourceURL, backupTimestamp: backupTimestamp)

    do {
      try fileManager.moveItem(at: sourceURL, to: backupURL)
      return backupURL.path
    } catch {
      return nil
    }
  }

  static func recoverNativeStoreIfRecoverable(
    storagePath: String,
    message: String,
    fileManager: FileManager = .default,
    backupTimestamp: String = timestampForBackupName(),
    maxArchiveAttempts: Int = 5,
    sleepBetweenAttempts: @escaping @Sendable () async -> Void = {
      try? await Task.sleep(for: .milliseconds(150))
    }
  ) async -> NativeStoreRecoveryOutcome {
    guard isRecoverableNativeStoragePath(storagePath) else { return .notNeeded }
    guard recoverableBootstrapErrorCode(from: message) != nil else {
      return .notNeeded
    }
    guard nativeStoreHasNoIdentity(at: storagePath, fileManager: fileManager) else {
      return .notNeeded
    }
    guard fileManager.fileExists(atPath: storagePath) else { return .notNeeded }

    let sourceURL = URL(fileURLWithPath: storagePath, isDirectory: true)
    let backupURL = nativeStoreBackupURL(for: sourceURL, backupTimestamp: backupTimestamp)
    let attempts = max(1, maxArchiveAttempts)
    var lastArchiveError: Error?

    for attempt in 0..<attempts {
      do {
        try fileManager.moveItem(at: sourceURL, to: backupURL)
        return .archived(backupURL.path)
      } catch {
        lastArchiveError = error
        if attempt + 1 < attempts {
          await sleepBetweenAttempts()
        }
      }
    }

    do {
      try fileManager.removeItem(at: sourceURL)
      return .deleted(sourceURL.path)
    } catch {
      let archiveMessage = lastArchiveError?.localizedDescription ?? "unknown archive error"
      return .failed(
        "storagePath=\(storagePath) archiveError=\(archiveMessage) deleteError=\(error.localizedDescription)"
      )
    }
  }

  // Auto-recovery (archive-on-empty-identity) only fires for the legacy
  // App-Support container path (PearTubeDesktopNative/host-storage). The
  // unified ~/.peartube store is shared with the Electrobun app and must
  // never be auto-archived — hence the strict structural check.
  static func isRecoverableNativeStoragePath(_ storagePath: String) -> Bool {
    let storageURL = URL(fileURLWithPath: storagePath, isDirectory: true)
      .standardizedFileURL
    return storageURL.lastPathComponent == "host-storage"
      && storageURL.deletingLastPathComponent().lastPathComponent == "PearTubeDesktopNative"
  }

  static func nativeStoreHasNoIdentity(
    at storagePath: String,
    fileManager: FileManager = .default
  ) -> Bool {
    let rootIdentity = URL(fileURLWithPath: storagePath, isDirectory: true)
      .appendingPathComponent("identity-key", isDirectory: false)
      .path
    let legacyIdentity = URL(fileURLWithPath: storagePath, isDirectory: true)
      .appendingPathComponent("db", isDirectory: true)
      .appendingPathComponent("identity-key", isDirectory: false)
      .path

    return !fileManager.fileExists(atPath: rootIdentity)
      && !fileManager.fileExists(atPath: legacyIdentity)
  }

  static func recoverableBootstrapErrorCode(from message: String) -> Int? {
    let normalizedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedMessage.isEmpty else { return nil }

    if let directCode = Int(normalizedMessage) {
      return directCode
    }

    let nsRange = NSRange(normalizedMessage.startIndex..<normalizedMessage.endIndex, in: normalizedMessage)
    let pattern = #"^(?:error:\s*)?(\d+)$"#
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
      return nil
    }
    guard let match = regex.firstMatch(in: normalizedMessage, options: [], range: nsRange),
          match.numberOfRanges == 2,
          let codeRange = Range(match.range(at: 1), in: normalizedMessage) else {
      return nil
    }

    return Int(normalizedMessage[codeRange])
  }

  static func isNativeStoreRecoveryEnabled(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    guard let rawValue = environment["PEARTUBE_NATIVE_ALLOW_STORE_RECOVERY"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() else {
      return false
    }

    switch rawValue {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }

  static func shouldAutoRecoverIdentitylessBootstrapFailure(
    storagePath: String,
    message: String,
    fileManager: FileManager = .default
  ) -> Bool {
    guard recoverableBootstrapErrorCode(from: message) == 3 else { return false }
    guard isRecoverableNativeStoragePath(storagePath) else { return false }
    return nativeStoreHasNoIdentity(at: storagePath, fileManager: fileManager)
      && fileManager.fileExists(atPath: storagePath)
  }

  private static func nativeStoreBackupURL(
    for sourceURL: URL,
    backupTimestamp: String
  ) -> URL {
    let backupName = "host-storage-bak-\(backupTimestamp)"
    return sourceURL
      .deletingLastPathComponent()
      .appendingPathComponent(backupName, isDirectory: true)
  }

  static func friendlyBootstrapError(_ message: String, storagePath: String) -> String {
    let lowercased = message.lowercased()
    if isCorestoreLockMessage(lowercased) {
      return "Close the existing PearTube desktop app or Pear worker using \(storagePath), then reopen PearTube Native."
    }

    return message
  }

  static func friendlyInProcessRelaunchRequiredMessage(
    _ message: String,
    storagePath: String
  ) -> String {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      return "Close and reopen PearTube Native. The embedded BareKit host cannot safely reopen \(storagePath) in the current app process after a bootstrap failure."
    }

    return "Close and reopen PearTube Native. The embedded BareKit host cannot safely reopen \(storagePath) in the current app process after a bootstrap failure. Last error: \(trimmed)"
  }

  static func isInProcessRelaunchRequiredMessage(_ message: String) -> Bool {
    message.hasPrefix("Close and reopen PearTube Native.")
      && message.contains("cannot safely reopen")
  }

  static func shouldRequireEmbeddedHostRelaunchAfterBootstrapFailure(
    transportMode: NativeHostTransportMode?
  ) -> Bool {
    transportMode == .embedded
  }

  static func isEmbeddedBridgeTimeout(_ error: Error) -> Bool {
    // Check for BareRPC timeout or generic timeout patterns
    let message = error.localizedDescription.lowercased()
    return message.contains("timed out") || message.contains("timeout")
  }

  static func mpvSessionHasPlaybackSignal(
    state: NativeMpvState?,
    frame: NativeMpvRenderFrame?
  ) -> Bool {
    if let frame, frame.success, frame.hasFrame {
      return true
    }

    if let state, state.success {
      if state.currentTime > 0 {
        return true
      }

      if state.duration > 0 {
        return true
      }
    }

    return false
  }

  static func shouldUseNativeMpvPlayback(
    for video: NativeVideo,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    if let override = nativeMpvPlaybackOverride(environment: environment) {
      return override
    }

    return false
  }

  static func prefersNativeMpvPlayback(
    for video: NativeVideo,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    if let override = nativeMpvPlaybackOverride(environment: environment) {
      return override
    }

    if prefersNativeFFmpegDecodePlayback(for: video, environment: environment) {
      return false
    }

    if ProfessionalVideoWorkflowExtensions.isExperimentalRoutingEnabled(environment: environment),
       !isLikelyAVPlayerCompatible(video: video),
       hasKnownPlaybackFormat(video: video) {
      return false
    }

    return !isLikelyAVPlayerCompatible(video: video) && hasKnownPlaybackFormat(video: video)
  }

  static func prefersNativeFFmpegDecodePlayback(
    for video: NativeVideo,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    if nativeMpvPlaybackOverride(environment: environment) != nil {
      return false
    }

    guard isExperimentalFFmpegDecodeEnabled(environment: environment) else {
      return false
    }

    return !isLikelyAVPlayerCompatible(video: video) && hasKnownPlaybackFormat(video: video)
  }

  static func isExperimentalFFmpegDecodeEnabled(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    guard let rawValue = environment["PEARTUBE_NATIVE_ENABLE_FFMPEG_DECODE"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
      !rawValue.isEmpty else {
      return false
    }

    switch rawValue {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }

  static func isAVPlayerReadyForPlayback(_ stats: NativeVideoStats) -> Bool {
    guard stats.success else { return false }
    if stats.isComplete { return true }
    if stats.progress > 0 { return true }
    if stats.downloadedBlocks > 0 || stats.downloadedBytes > 0 { return true }

    guard let status = stats.status?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
      !status.isEmpty else {
      return false
    }

    if ["ready", "playing", "cached", "complete"].contains(status) {
      return true
    }

    if ["buffering", "downloading"].contains(status) {
      return stats.peerCount > 0 || stats.progress > 0 || stats.downloadedBlocks > 0 || stats.downloadedBytes > 0
    }

    return false
  }

  private static func nativeMpvPlaybackOverride(
    environment: [String: String]
  ) -> Bool? {
    guard let rawValue = environment["PEARTUBE_NATIVE_ENABLE_MPV"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() else {
      return nil
    }

    switch rawValue {
    case "1", "true", "yes", "on":
      return true
    case "0", "false", "no", "off":
      return false
    default:
      return nil
    }
  }

  @discardableResult
  func refreshFFmpegDecodeAvailability() async -> FfmpegDecodeAvailableResponse? {
    guard isReady else { return nil }

    do {
      let response = try await gatedRPC { hrpc in
        try await hrpc.ffmpegDecodeAvailable(FfmpegDecodeAvailableRequest())
      }
      ffmpegDecodeAvailable = response.available
      ffmpegDecodeAvailabilityError = response.error?.isEmpty == false ? response.error : nil
      return response
    } catch {
      ffmpegDecodeAvailable = false
      ffmpegDecodeAvailabilityError = error.localizedDescription
      appendLog("bare-ffmpeg decode availability probe failed: \(error.localizedDescription)")
      return nil
    }
  }

  static func shouldSuppressDiagnosticsTransportLog(
    _ line: String,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    if let rawValue = environment["PEARTUBE_NATIVE_VERBOSE_IPC"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
       ["1", "true", "yes", "on"].contains(rawValue) {
      return false
    }

    guard line.contains("IPC bytes"), line.contains("embedded BareKit worklet") else {
      return false
    }

    return line.hasPrefix("Queued ")
      || line.hasPrefix("Dispatching ")
      || line.hasPrefix("Finished writing ")
      || line.hasPrefix("Read ")
  }

  private static func isLikelyAVPlayerCompatible(video: NativeVideo) -> Bool {
    let avMimeTypes = Set([
      "application/vnd.apple.mpegurl",
      "audio/aac",
      "audio/mp4",
      "audio/mpeg",
      "video/mp2t",
      "video/mp4",
      "video/quicktime",
      "video/x-m4v",
    ])
    let avExtensions = Set([
      "aac",
      "m3u8",
      "m4a",
      "m4v",
      "mov",
      "mp3",
      "mp4",
      "ts",
    ])

    if let mimeType = video.mimeType?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
       !mimeType.isEmpty {
      return avMimeTypes.contains(mimeType)
    }

    if let path = video.path?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !path.isEmpty {
      let pathExtension = URL(fileURLWithPath: path).pathExtension.lowercased()
      if !pathExtension.isEmpty {
        return avExtensions.contains(pathExtension)
      }
    }

    return false
  }

  private static func hasKnownPlaybackFormat(video: NativeVideo) -> Bool {
    if let mimeType = video.mimeType?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !mimeType.isEmpty {
      return true
    }

    if let path = video.path?
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !path.isEmpty {
      return !URL(fileURLWithPath: path).pathExtension.isEmpty
    }

    return false
  }

  private static func defaultDiagnosticsLogURL(
    fileManager: FileManager = .default,
    homeDirectory: URL = URL(fileURLWithPath: NSHomeDirectory()),
    appSupportDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  ) -> URL {
    let appSupportRoot = appSupportDirectory ?? homeDirectory
    let logDirectory = appSupportRoot.appendingPathComponent("PearTubeDesktopNative", isDirectory: true)

    if !fileManager.fileExists(atPath: logDirectory.path) {
      try? fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
    }

    return logDirectory.appendingPathComponent("host-bridge.log")
  }

  private static func defaultWorkletDebugLogURL(
    fileManager: FileManager = .default,
    homeDirectory: URL = URL(fileURLWithPath: NSHomeDirectory()),
    appSupportDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  ) -> URL {
    let appSupportRoot = appSupportDirectory ?? homeDirectory
    let logDirectory = appSupportRoot.appendingPathComponent("PearTubeDesktopNative", isDirectory: true)

    if !fileManager.fileExists(atPath: logDirectory.path) {
      try? fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
    }

    return logDirectory.appendingPathComponent("host-worklet-debug.log")
  }

  private static func defaultBrowseSnapshotCacheURL(
    fileManager: FileManager = .default,
    homeDirectory: URL = URL(fileURLWithPath: NSHomeDirectory()),
    appSupportDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  ) -> URL {
    let appSupportRoot = appSupportDirectory ?? homeDirectory
    let cacheDirectory = appSupportRoot.appendingPathComponent("PearTubeDesktopNative", isDirectory: true)

    if !fileManager.fileExists(atPath: cacheDirectory.path) {
      try? fileManager.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    return cacheDirectory.appendingPathComponent("browse-snapshot.json")
  }

  static func resolvedBrowseSnapshot(
    liveSnapshot: NativeBrowseSnapshot,
    cachedSnapshot: NativeBrowseSnapshot?,
    allowCachedFeedFallback: Bool
  ) -> NativeBrowseSnapshot {
    guard allowCachedFeedFallback else { return liveSnapshot }
    return preferredBrowseSnapshot(liveSnapshot: liveSnapshot, cachedSnapshot: cachedSnapshot)
  }

  static func preferredBrowseSnapshot(
    liveSnapshot: NativeBrowseSnapshot,
    cachedSnapshot: NativeBrowseSnapshot?
  ) -> NativeBrowseSnapshot {
    guard liveSnapshot.stats.homeCount == 0 else { return liveSnapshot }
    guard let cachedSnapshot, cachedSnapshot.stats.homeCount > 0 else { return liveSnapshot }

    let mergedSections = NativeBrowseSections(
      home: cachedSnapshot.sections.home,
      subscriptions: liveSnapshot.sections.subscriptions.isEmpty
        ? cachedSnapshot.sections.subscriptions
        : liveSnapshot.sections.subscriptions,
      library: liveSnapshot.sections.library,
      studio: liveSnapshot.sections.studio,
      diagnostics: liveSnapshot.sections.diagnostics
    )

    let mergedStats = NativeBrowseStats(
      homeCount: mergedSections.home.count,
      subscriptionCount: mergedSections.subscriptions.count,
      libraryCount: liveSnapshot.stats.libraryCount,
      channelCount: max(
        liveSnapshot.stats.channelCount,
        Set(mergedSections.home.map(\.channelKey)).count
      )
    )

    return NativeBrowseSnapshot(
      generatedAt: liveSnapshot.generatedAt,
      sections: mergedSections,
      stats: mergedStats,
      state: liveSnapshot.state
    )
  }

  static func snapshotForPersistence(
    liveSnapshot: NativeBrowseSnapshot,
    cachedSnapshot: NativeBrowseSnapshot?
  ) -> NativeBrowseSnapshot {
    preferredBrowseSnapshot(liveSnapshot: liveSnapshot, cachedSnapshot: cachedSnapshot)
  }

  static func shouldPersistBrowseSnapshot(_ snapshot: NativeBrowseSnapshot) -> Bool {
    snapshot.stats.homeCount > 0 ||
      snapshot.stats.subscriptionCount > 0 ||
      snapshot.stats.libraryCount > 0 ||
      snapshot.state.hasActiveIdentity
  }

  static func loadCachedBrowseSnapshot(from url: URL) -> NativeBrowseSnapshot? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(NativeBrowseSnapshot.self, from: data)
  }

  static func persistBrowseSnapshot(_ snapshot: NativeBrowseSnapshot, to url: URL) {
    let fileManager = FileManager.default
    let directoryURL = url.deletingLastPathComponent()

    if !fileManager.fileExists(atPath: directoryURL.path) {
      try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    try? data.write(to: url, options: .atomic)
  }

  private static func appendPersistentLog(_ line: String, to url: URL) {
    let fileManager = FileManager.default
    let directoryURL = url.deletingLastPathComponent()

    if !fileManager.fileExists(atPath: directoryURL.path) {
      try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    if !fileManager.fileExists(atPath: url.path) {
      fileManager.createFile(atPath: url.path, contents: nil)
    }

    guard let data = "[\(isoTimestamp())] \(line)\n".data(using: .utf8) else {
      return
    }

    do {
      let handle = try FileHandle(forWritingTo: url)
      try handle.seekToEnd()
      try handle.write(contentsOf: data)
      try handle.close()
    } catch {
      // Keep in-memory diagnostics working even if the file logger fails.
    }
  }

  private static func isoTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
  }

  private static func timestampForBackupName(date: Date = Date()) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone.current
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter.string(from: date)
  }

  private func defaultStoragePath() -> String {
    Self.preferredStoragePath()
  }

  static func preferredNativeHostTransportMode(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> NativeHostTransportMode {
    let embeddedDebugEnabled = isTruthyEnvironmentFlag(
      environment["PEARTUBE_NATIVE_ENABLE_EMBEDDED_HOST"]
    )

    if let explicitMode = environment["PEARTUBE_NATIVE_HOST_MODE"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() {
      switch explicitMode {
      case "embedded", "worklet":
        return embeddedDebugEnabled ? .embedded : .sidecar
      case "sidecar":
        return .sidecar
      default:
        break
      }
    }

    if embeddedDebugEnabled,
       (environment["PEARTUBE_NATIVE_WORKLET_ENTRY"]?.isEmpty == false
         || environment["PEARTUBE_NATIVE_WORKLET_BUNDLE"]?.isEmpty == false)
    {
      return .embedded
    }

    return .sidecar
  }

  private static func isTruthyEnvironmentFlag(_ value: String?) -> Bool {
    guard let normalized = value?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
      !normalized.isEmpty
    else {
      return false
    }

    switch normalized {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }

  private static func isCorestoreLockMessage(_ lowercasedMessage: String) -> Bool {
    lowercasedMessage.contains("file descriptor could not be locked")
      || lowercasedMessage.contains("lock hold by current process")
      || lowercasedMessage.contains("no locks available")
      || (lowercasedMessage.contains("corestore") && lowercasedMessage.contains("locked"))
  }

  static func preferredLinkedAddonFrameworkPath(
    resourceURL: URL? = Bundle.main.resourceURL,
    privateFrameworksPath: String? = Bundle.main.privateFrameworksPath,
    workspaceRoot: URL? = nil,
    fileManager: FileManager = .default
  ) -> String? {
    if let bundledResourcesPath = resourceURL?
      .appendingPathComponent("BareAddons", isDirectory: true).path,
       linkedAddonDirectoryLooksUsable(bundledResourcesPath, fileManager: fileManager) {
      return bundledResourcesPath
    }

    let resolvedWorkspaceRoot = workspaceRoot ?? (try? Self.workspaceRootURL())
    if let resolvedWorkspaceRoot {
      let workspaceFrameworkPath = resolvedWorkspaceRoot
        .appendingPathComponent("packages/desktop-native/Vendor/BareAddons", isDirectory: true)
        .path
      if linkedAddonDirectoryLooksUsable(workspaceFrameworkPath, fileManager: fileManager) {
        return workspaceFrameworkPath
      }
    }

    if let privateFrameworksPath,
       linkedAddonDirectoryLooksUsable(privateFrameworksPath, fileManager: fileManager) {
      return privateFrameworksPath
    }

    return nil
  }

  private static func linkedAddonDirectoryLooksUsable(
    _ directoryPath: String,
    fileManager: FileManager
  ) -> Bool {
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: directoryPath, isDirectory: &isDirectory), isDirectory.boolValue else {
      return false
    }

    let requiredFrameworkPrefixes = [
      "bare-pipe.",
      "bare-fs.",
      "quickbit-native.",
      "rocksdb-native.",
      "sodium-native.",
    ]

    let presentEntries = Set((try? fileManager.contentsOfDirectory(atPath: directoryPath)) ?? [])

    return requiredFrameworkPrefixes.allSatisfy { prefix in
      presentEntries.contains(where: { entry in
        entry.hasPrefix(prefix) && entry.hasSuffix(".framework")
      })
    }
  }

  private func resolveWorkletBundleURL(fileManager: FileManager = .default) throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    if let sourceOverride = environment["PEARTUBE_NATIVE_WORKLET_ENTRY"], !sourceOverride.isEmpty {
      let sourceURL = URL(fileURLWithPath: sourceOverride)
      if fileManager.fileExists(atPath: sourceURL.path) {
        return sourceURL
      }
    }

    if let bundleOverride = environment["PEARTUBE_NATIVE_WORKLET_BUNDLE"], !bundleOverride.isEmpty {
      let bundleURL = URL(fileURLWithPath: bundleOverride)
      if fileManager.fileExists(atPath: bundleURL.path) {
        return bundleURL
      }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundledBundleURL = resourceURL
        .appendingPathComponent("Generated", isDirectory: true)
        .appendingPathComponent("native-host-worklet.bundle")
      if fileManager.fileExists(atPath: bundledBundleURL.path) {
        return bundledBundleURL
      }
    }

    let workspaceRoot = try Self.workspaceRootURL()
    let workspaceBundleURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
      .appendingPathComponent("native-host-worklet.bundle")

    if fileManager.fileExists(atPath: workspaceBundleURL.path) {
      return workspaceBundleURL
    }

    let workspaceEntryURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Bridge", isDirectory: true)
      .appendingPathComponent("native-host-worklet.mjs")

    if fileManager.fileExists(atPath: workspaceEntryURL.path) {
      return workspaceEntryURL
    }

    throw HostBridgeError.bridgeArtifactMissing(
      "Generated/native-host-worklet.bundle"
    )
  }

  private func resolveSidecarBundleURL(fileManager: FileManager = .default) throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    if let bundleOverride = environment["PEARTUBE_NATIVE_SIDECAR_BUNDLE"], !bundleOverride.isEmpty {
      let bundleURL = URL(fileURLWithPath: bundleOverride)
      if fileManager.fileExists(atPath: bundleURL.path) {
        return bundleURL
      }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundledBundleURL = resourceURL
        .appendingPathComponent("Generated", isDirectory: true)
        .appendingPathComponent("native-host-sidecar.bundle")
      if fileManager.fileExists(atPath: bundledBundleURL.path) {
        return bundledBundleURL
      }
    }

    let workspaceRoot = try Self.workspaceRootURL()
    let workspaceBundleURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
      .appendingPathComponent("native-host-sidecar.bundle")

    if fileManager.fileExists(atPath: workspaceBundleURL.path) {
      return workspaceBundleURL
    }

    let workspaceEntryURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Bridge", isDirectory: true)
      .appendingPathComponent("native-host-sidecar.mjs")

    if fileManager.fileExists(atPath: workspaceEntryURL.path) {
      return workspaceEntryURL
    }

    throw HostBridgeError.bridgeArtifactMissing(
      "Generated/native-host-sidecar.bundle"
    )
  }

  /// Look for a bare-native compiled sidecar .app bundle.
  /// Returns the executable URL inside the .app, or nil if not found.
  private func resolveNativeSidecarBinary(fileManager: FileManager = .default) -> URL? {
    let appName = "PearTubeHost.app"
    let executablePath = "Contents/MacOS/PearTubeHost"

    func executableInApp(_ appURL: URL) -> URL? {
      let execURL = appURL.appendingPathComponent(executablePath)
      return fileManager.fileExists(atPath: execURL.path) ? execURL : nil
    }

    let environment = ProcessInfo.processInfo.environment
    if let override = environment["PEARTUBE_NATIVE_SIDECAR_BINARY"], !override.isEmpty {
      let url = URL(fileURLWithPath: override)
      if fileManager.fileExists(atPath: url.path) { return url }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundled = resourceURL
        .appendingPathComponent("Generated", isDirectory: true)
        .appendingPathComponent(appName, isDirectory: true)
      if let exec = executableInApp(bundled) { return exec }
    }

    if let workspaceRoot = try? Self.workspaceRootURL() {
      let workspace = workspaceRoot
        .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
        .appendingPathComponent(appName, isDirectory: true)
      if let exec = executableInApp(workspace) { return exec }
    }

    return nil
  }

  private func resolveBareRuntimeURL(fileManager: FileManager = .default) throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    if let runtimeOverride = environment["PEARTUBE_NATIVE_BARE_RUNTIME"], !runtimeOverride.isEmpty {
      let runtimeURL = URL(fileURLWithPath: runtimeOverride)
      if fileManager.fileExists(atPath: runtimeURL.path) {
        return runtimeURL
      }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundledRuntimeURL = resourceURL
        .appendingPathComponent("Runtime", isDirectory: true)
        .appendingPathComponent("bare")
      if fileManager.fileExists(atPath: bundledRuntimeURL.path) {
        return bundledRuntimeURL
      }
    }

    let workspaceRoot = try Self.workspaceRootURL()
    let workspaceRuntimeURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Resources/Runtime", isDirectory: true)
      .appendingPathComponent("bare")

    if fileManager.fileExists(atPath: workspaceRuntimeURL.path) {
      return workspaceRuntimeURL
    }

    throw HostBridgeError.bridgeArtifactMissing(
      "Runtime/bare"
    )
  }

  private static func workspaceRootURL() throws -> URL {
    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let packagesDirectory = candidate.appendingPathComponent("packages", isDirectory: true)
      if FileManager.default.fileExists(atPath: packageJSON.path)
          && FileManager.default.fileExists(atPath: packagesDirectory.path) {
        return candidate
      }
      candidate.deleteLastPathComponent()
    }

    throw HostBridgeError.workspaceRootNotFound
  }

  private static func mimeType(forImageURL url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "png":
      return "image/png"
    case "webp":
      return "image/webp"
    default:
      return "image/jpeg"
    }
  }

  static func isSupportedVideoUploadURL(
    _ url: URL,
    fileManager: FileManager = .default
  ) -> Bool {
    let pathExtension = url.pathExtension.lowercased()
    guard supportedVideoUploadFileExtensions.contains(pathExtension) else {
      return false
    }

    var isDirectory = ObjCBool(false)
    if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
      return false
    }

    return true
  }

  static func preferredVideoUploadDropURL(
    from urls: [URL],
    fileManager: FileManager = .default
  ) -> URL? {
    urls.first { isSupportedVideoUploadURL($0, fileManager: fileManager) }
  }
}

private enum HostBridgeError: LocalizedError {
  case workspaceRootNotFound
  case bridgeArtifactMissing(String)
  case bridgeInputUnavailable
  case bridgeResponse(String)
  case bridgeDisconnected
  case protocolVersionMismatch(expected: Int, actual: Int?)

  var errorDescription: String? {
    switch self {
    case .workspaceRootNotFound:
      return "Could not locate the PearTube workspace root from the native app build."
    case .bridgeArtifactMissing(let path):
      return "Native host bridge artifacts not found at \(path)."
    case .bridgeInputUnavailable:
      return "Native host bridge input stream is unavailable."
    case .bridgeResponse(let message):
      return message
    case .bridgeDisconnected:
      return "Native host bridge disconnected."
    case .protocolVersionMismatch(let expected, let actual):
      let actualDescription = actual.map(String.init) ?? "missing"
      return "Native host protocol version mismatch. Expected \(expected), received \(actualDescription)."
    }
  }
}
