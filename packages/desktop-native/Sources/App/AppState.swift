import Foundation
import Observation

struct NativeChannelProfile: Hashable, Codable {
  enum Role: String, Hashable, Codable {
    case owner
    case viewer
  }

  let channelKey: String
  let publicBeeKey: String?
  let avatarURL: URL?
  let name: String
  let description: String
  let videoCount: Int
  let role: Role
  let isSubscribed: Bool
  let isPublished: Bool
}

struct NativeUploadJob: Identifiable, Hashable, Codable {
  enum State: String, Hashable, Codable {
    case pending
    case uploading
    case processing
    case completed
    case failed
  }

  let id: String
  let fileName: String
  let title: String
  let createdAt: Date
  let sourceFilePath: String?
  var videoID: String?
  var progress: Int
  var bytesUploaded: Int?
  var totalBytes: Int?
  var speed: Int?
  var eta: Int?
  var state: State
  var errorMessage: String?

  init(
    id: String,
    fileName: String,
    title: String,
    createdAt: Date,
    sourceFilePath: String? = nil,
    videoID: String?,
    progress: Int,
    bytesUploaded: Int?,
    totalBytes: Int?,
    speed: Int?,
    eta: Int?,
    state: State,
    errorMessage: String?
  ) {
    self.id = id
    self.fileName = fileName
    self.title = title
    self.createdAt = createdAt
    self.sourceFilePath = sourceFilePath
    self.videoID = videoID
    self.progress = progress
    self.bytesUploaded = bytesUploaded
    self.totalBytes = totalBytes
    self.speed = speed
    self.eta = eta
    self.state = state
    self.errorMessage = errorMessage
  }
}

@MainActor
@Observable
final class AppState {
  var isLoading = false
  var lastErrorMessage: String?
  var searchQuery = ""
  var selectedSection: AppSection? {
    didSet {
      if !isSearchActive {
        syncSelectionToSection()
      }
    }
  }

  var selectedVideoID: NativeVideo.ID? {
    didSet {
      if selectedVideoID == nil, playingVideoID == nil {
        isPlayingPreview = false
      }
    }
  }

  var playingVideoID: NativeVideo.ID?
  var isPlayingPreview = false
  var isShowingWatchPage = false
  var isShowingChannelPage = false
  var channelPageProfile: NativeChannelProfile?
  var channelPageVideos: [NativeVideo] = []
  var studioChannelProfile: NativeChannelProfile?
  var studioChannelVideos: [NativeVideo] = []
  var studioUploadJobs: [NativeUploadJob] = []
  var selectedStudioVideoID: NativeVideo.ID?

  private var sectionCatalog: [AppSection: [NativeVideo]]
  private var searchResults: [NativeVideo] = []
  private var browseState: NativeBrowseState = .empty
  private var pinnedWatchVideo: NativeVideo?
  private var pinnedPlaybackVideo: NativeVideo?

  init(catalog: [NativeVideo] = []) {
    self.sectionCatalog = Self.makeSectionCatalog(from: catalog)
    selectedSection = .home
    selectedVideoID = Self.makeSectionCatalog(from: catalog)[.home]?.first?.id
  }

  var currentSection: AppSection {
    selectedSection ?? .home
  }

  var isSearchActive: Bool {
    !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var contentTitle: String {
    isSearchActive ? "Search" : currentSection.title
  }

  var contentHeadline: String {
    if isSearchActive {
      return "Global results for \"\(searchQuery.trimmingCharacters(in: .whitespacesAndNewlines))\"."
    }

    return currentSection.headline
  }

  var selectedVideo: NativeVideo? {
    displayedVideos.first(where: { $0.id == selectedVideoID })
      ?? uniqueVideoLookup[selectedVideoID ?? ""]
      ?? pinnedWatchVideo
  }

  var activePlaybackVideo: NativeVideo? {
    guard let playingVideoID else { return nil }
    return uniqueVideoLookup[playingVideoID]
      ?? pinnedPlaybackVideo
      ?? (selectedVideoID == playingVideoID ? pinnedWatchVideo : nil)
  }

  var miniPlayerVideo: NativeVideo? {
    guard !isShowingWatchPage else { return nil }
    return activePlaybackVideo
  }

  var activeStudioUploadJob: NativeUploadJob? {
    studioUploadJobs.first
  }

  var studioWorkspaceProfile: NativeChannelProfile? {
    if let studioChannelProfile {
      return studioChannelProfile
    }

    guard let activeIdentityChannelKey else { return nil }
    return makeChannelProfile(
      channelKey: activeIdentityChannelKey,
      publicBeeKey: nil,
      avatarURL: nil,
      name: activeIdentityName,
      description: nil,
      videoCount: studioWorkspaceVideos.count
    )
  }

  var studioWorkspaceVideos: [NativeVideo] {
    if !studioChannelVideos.isEmpty {
      return studioChannelVideos
    }

    return videos(for: .studio)
  }

  var studioEditingVideo: NativeVideo? {
    guard let selectedStudioVideoID else { return nil }
    return uniqueVideoLookup[selectedStudioVideoID]
      ?? studioWorkspaceVideos.first(where: { $0.id == selectedStudioVideoID })
      ?? channelPageVideos.first(where: { $0.id == selectedStudioVideoID })
  }

  var displayedVideos: [NativeVideo] {
    if isSearchActive {
      return searchResults
    }

    return videos(for: selectedSection)
  }

  var allVideos: [NativeVideo] {
    var ordered: [NativeVideo] = []
    var seen = Set<NativeVideo.ID>()

    for section in AppSection.allCases {
      for video in sectionCatalog[section] ?? [] where !seen.contains(video.id) {
        seen.insert(video.id)
        ordered.append(video)
      }
    }

    return ordered
  }

  var hasActiveIdentity: Bool {
    browseState.hasActiveIdentity
  }

  var activeIdentityName: String {
    browseState.activeIdentityName ?? "PearTube Channel"
  }

  var activeIdentityChannelKey: String? {
    browseState.activeIdentityChannelKey
  }

  var activeChannelPublished: Bool {
    browseState.activeChannelPublished
  }

  var identityCount: Int {
    browseState.identityChannelKeys.count
  }

  func ownsChannel(_ channelKey: String) -> Bool {
    browseState.identityChannelKeys.contains(channelKey)
  }

  func isSubscribed(to channelKey: String) -> Bool {
    browseState.subscriptionChannelKeys.contains(channelKey)
  }

  func videos(for section: AppSection? = nil) -> [NativeVideo] {
    let target = section ?? currentSection
    return sectionCatalog[target] ?? []
  }

  func videoCount(for section: AppSection) -> Int {
    sectionCatalog[section]?.count ?? 0
  }

  func relatedVideos(limit: Int = 6) -> [NativeVideo] {
    guard let selectedVideo else { return [] }

    let currentContext = isSearchActive ? displayedVideos : allVideos
    let sameChannel = currentContext.filter {
      $0.id != selectedVideo.id && $0.channelKey == selectedVideo.channelKey
    }
    let remaining = currentContext.filter {
      $0.id != selectedVideo.id && $0.channelKey != selectedVideo.channelKey
    }

    return Array((sameChannel + remaining).prefix(limit))
  }

  func selectSection(_ section: AppSection?) {
    isShowingWatchPage = false
    if isShowingChannelPage {
      closeChannelPage()
    }
    if let activePlaybackVideo {
      pinnedPlaybackVideo = activePlaybackVideo
      pinnedWatchVideo = activePlaybackVideo
    } else {
      pinnedWatchVideo = nil
    }
    selectedSection = section
  }

  func selectVideo(_ id: NativeVideo.ID?) {
    selectedVideoID = id
    if isShowingWatchPage, let id {
      pinnedWatchVideo = uniqueVideoLookup[id] ?? pinnedWatchVideo
    }
  }

  func openVideo(_ id: NativeVideo.ID) {
    if isShowingChannelPage {
      closeChannelPage()
    }
    selectedVideoID = id
    let resolvedVideo = uniqueVideoLookup[id] ?? (playingVideoID == id ? pinnedPlaybackVideo : nil)
    pinnedWatchVideo = resolvedVideo
    if playingVideoID == id {
      pinnedPlaybackVideo = resolvedVideo
    }
    isShowingWatchPage = true
  }

  func closeWatchPage() {
    isShowingWatchPage = false
    if let activePlaybackVideo {
      pinnedPlaybackVideo = activePlaybackVideo
      pinnedWatchVideo = activePlaybackVideo
    } else {
      pinnedWatchVideo = nil
    }
  }

  func playSelectedPreview() {
    guard let selectedVideoID else { return }
    playingVideoID = selectedVideoID
    pinnedPlaybackVideo = uniqueVideoLookup[selectedVideoID] ?? pinnedWatchVideo ?? pinnedPlaybackVideo
    isPlayingPreview = true
  }

  func pausePreview() {
    isPlayingPreview = false
  }

  func resumePlayback() {
    guard playingVideoID != nil else { return }
    isPlayingPreview = true
  }

  func setLoading(_ isLoading: Bool) {
    self.isLoading = isLoading
  }

  func setError(_ message: String?) {
    lastErrorMessage = message
  }

  func applySnapshot(_ snapshot: NativeBrowseSnapshot) {
    browseState = snapshot.state
    sectionCatalog = [
      .home: snapshot.sections.home,
      .subscriptions: snapshot.sections.subscriptions,
      .library: snapshot.sections.library,
      .studio: snapshot.sections.studio,
      .diagnostics: snapshot.sections.diagnostics,
    ]
    lastErrorMessage = nil
    refreshChannelPageProfile()
    if hasActiveIdentity {
      refreshStudioWorkspaceProfile()
    } else {
      clearStudioWorkspace()
    }
    refreshPinnedPlaybackVideo()
    refreshPinnedWatchVideo()
    refreshStudioEditingSelection()
    syncSelectionForDisplayedVideos()
  }

  func settleAfterSuccessfulBootstrap() {
    guard !isSearchActive else { return }

    if selectedSection == nil || currentSection == .diagnostics {
      selectedSection = preferredLandingSection()
      return
    }

    if displayedVideos.isEmpty, currentSection != preferredLandingSection() {
      selectedSection = preferredLandingSection()
    }
  }

  func applySearchResults(query: String, videos: [NativeVideo]) {
    searchQuery = query
    searchResults = videos
    lastErrorMessage = nil
    refreshPinnedPlaybackVideo()
    refreshPinnedWatchVideo()
    syncSelectionForDisplayedVideos()
  }

  func beginSearch(query: String) {
    searchQuery = query
    searchResults = []
    lastErrorMessage = nil
    if !isSearchActive {
      syncSelectionForDisplayedVideos()
    }
  }

  func clearSearch() {
    searchQuery = ""
    searchResults = []
    isShowingWatchPage = false
    if playingVideoID == nil {
      pinnedWatchVideo = nil
    } else if let activePlaybackVideo {
      pinnedPlaybackVideo = activePlaybackVideo
      pinnedWatchVideo = activePlaybackVideo
    }
    syncSelectionForDisplayedVideos()
  }

  func clearPlaybackSelection() {
    playingVideoID = nil
    isPlayingPreview = false
    pinnedPlaybackVideo = nil
    if !isShowingWatchPage {
      pinnedWatchVideo = nil
    }
  }

  func restorePlayingVideoToWatchPage() {
    guard let playingVideoID else { return }
    selectedVideoID = playingVideoID
    let resolvedVideo = uniqueVideoLookup[playingVideoID] ?? pinnedPlaybackVideo ?? pinnedWatchVideo
    pinnedPlaybackVideo = resolvedVideo
    pinnedWatchVideo = resolvedVideo
    isShowingWatchPage = true
  }

  func makeChannelProfile(
    channelKey: String,
    publicBeeKey: String?,
    avatarURL: String? = nil,
    name: String?,
    description: String?,
    videoCount: Int?
  ) -> NativeChannelProfile {
    let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let resolvedName = trimmedName.isEmpty ? "Channel \(String(channelKey.prefix(8)))" : trimmedName
    let resolvedDescription = description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let role: NativeChannelProfile.Role = ownsChannel(channelKey) ? .owner : .viewer
    let isPublished = browseState.activeChannelPublished && browseState.activeIdentityChannelKey == channelKey

    return NativeChannelProfile(
      channelKey: channelKey,
      publicBeeKey: publicBeeKey,
      avatarURL: URL(string: avatarURL ?? ""),
      name: resolvedName,
      description: resolvedDescription,
      videoCount: max(0, videoCount ?? 0),
      role: role,
      isSubscribed: isSubscribed(to: channelKey),
      isPublished: isPublished
    )
  }

  func openChannelPage(profile: NativeChannelProfile, videos: [NativeVideo] = []) {
    isShowingWatchPage = false
    channelPageProfile = makeChannelProfile(
      channelKey: profile.channelKey,
      publicBeeKey: profile.publicBeeKey,
      avatarURL: profile.avatarURL?.absoluteString,
      name: profile.name,
      description: profile.description,
      videoCount: profile.videoCount
    )
    channelPageVideos = videos
    isShowingChannelPage = true
  }

  func updateChannelPage(profile: NativeChannelProfile? = nil, videos: [NativeVideo]? = nil) {
    if let profile {
      channelPageProfile = makeChannelProfile(
        channelKey: profile.channelKey,
        publicBeeKey: profile.publicBeeKey,
        avatarURL: profile.avatarURL?.absoluteString,
        name: profile.name,
        description: profile.description,
        videoCount: profile.videoCount
      )
    } else {
      refreshChannelPageProfile()
    }

    if let videos {
      channelPageVideos = videos
    }
  }

  func closeChannelPage() {
    isShowingChannelPage = false
    channelPageProfile = nil
    channelPageVideos = []
  }

  func updateStudioWorkspace(profile: NativeChannelProfile? = nil, videos: [NativeVideo]? = nil) {
    if let profile {
      studioChannelProfile = makeChannelProfile(
        channelKey: profile.channelKey,
        publicBeeKey: profile.publicBeeKey,
        avatarURL: profile.avatarURL?.absoluteString,
        name: profile.name,
        description: profile.description,
        videoCount: profile.videoCount
      )
    } else {
      refreshStudioWorkspaceProfile()
    }

    if let videos {
      studioChannelVideos = videos
    }

    if selectedStudioVideoID == nil {
      selectedStudioVideoID = studioWorkspaceVideos.first?.id ?? self.videos(for: .studio).first?.id
    }

    refreshStudioEditingSelection()
  }

  func clearStudioWorkspace() {
    studioChannelProfile = nil
    studioChannelVideos = []
    selectedStudioVideoID = nil
  }

  func upsertOwnedVideo(_ video: NativeVideo) {
    for section in AppSection.allCases {
      var sectionVideos = sectionCatalog[section] ?? []
      let existingIndex = sectionVideos.firstIndex { $0.id == video.id }

      if video.sections.contains(section) {
        if let existingIndex {
          sectionVideos[existingIndex] = video
        } else {
          sectionVideos.append(video)
        }
      } else if let existingIndex {
        sectionVideos.remove(at: existingIndex)
      }

      sectionCatalog[section] = sectionVideos
    }

    upsertVideo(video, in: &channelPageVideos, appendIfMissing: channelPageProfile?.channelKey == video.channelKey)
    upsertVideo(video, in: &studioChannelVideos, appendIfMissing: studioChannelProfile?.channelKey == video.channelKey)
    refreshOwnedWorkspaceProfiles(for: video.channelKey)
    refreshPinnedPlaybackVideo()
    refreshPinnedWatchVideo()
    refreshStudioEditingSelection()
    syncSelectionForDisplayedVideos()
  }

  func removeOwnedVideo(_ video: NativeVideo) {
    for section in AppSection.allCases {
      var sectionVideos = sectionCatalog[section] ?? []
      sectionVideos.removeAll { $0.id == video.id }
      sectionCatalog[section] = sectionVideos
    }

    channelPageVideos.removeAll { $0.id == video.id }
    studioChannelVideos.removeAll { $0.id == video.id }

    if selectedVideoID == video.id {
      selectedVideoID = nil
    }
    if pinnedWatchVideo?.id == video.id {
      pinnedWatchVideo = nil
    }
    if pinnedPlaybackVideo?.id == video.id {
      pinnedPlaybackVideo = nil
    }
    if playingVideoID == video.id {
      clearPlaybackSelection()
    }

    refreshOwnedWorkspaceProfiles(for: video.channelKey)
    refreshStudioEditingSelection()
    syncSelectionForDisplayedVideos()
  }

  func beginStudioUpload(fileName: String, title: String, sourceFilePath: String? = nil) {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    studioUploadJobs = [
      NativeUploadJob(
        id: "active-upload",
        fileName: fileName,
        title: trimmedTitle.isEmpty ? "Untitled Upload" : trimmedTitle,
        createdAt: Date(),
        sourceFilePath: sourceFilePath,
        videoID: nil,
        progress: 0,
        bytesUploaded: nil,
        totalBytes: nil,
        speed: nil,
        eta: nil,
        state: .pending,
        errorMessage: nil
      )
    ]
    selectedStudioVideoID = nil
  }

  func applyUploadProgress(_ event: NativeBridgeUploadProgressEvent) {
    if studioUploadJobs.isEmpty {
      let fallbackTitle = event.videoId.isEmpty ? "Uploading Video" : event.videoId
      beginStudioUpload(fileName: fallbackTitle, title: fallbackTitle)
    }

    guard var job = studioUploadJobs.first else { return }
    if !event.videoId.isEmpty {
      job.videoID = event.videoId
    }
    job.progress = max(0, min(100, event.progress))
    job.bytesUploaded = event.bytesUploaded
    job.totalBytes = event.totalBytes
    job.speed = event.speed
    job.eta = event.eta
    job.state = job.progress >= 100 ? .processing : .uploading
    job.errorMessage = nil
    studioUploadJobs = [job]
  }

  func completeStudioUpload(with video: NativeVideo?) {
    guard var job = studioUploadJobs.first else { return }
    job.progress = max(job.progress, 100)
    job.state = .completed
    job.errorMessage = nil
    if let video {
      job.videoID = video.backendVideoID
      selectedStudioVideoID = video.id
    }
    studioUploadJobs = [job]
  }

  func failStudioUpload(message: String) {
    guard var job = studioUploadJobs.first else { return }
    job.state = .failed
    job.errorMessage = message
    studioUploadJobs = [job]
  }

  func selectStudioVideoForEditing(_ id: NativeVideo.ID?) {
    selectedStudioVideoID = id
  }

  func retryableStudioUploadFileURL(fileManager: FileManager = .default) -> URL? {
    guard let job = activeStudioUploadJob,
          job.state == .failed,
          let sourceFilePath = job.sourceFilePath,
          fileManager.fileExists(atPath: sourceFilePath) else {
      return nil
    }

    return URL(fileURLWithPath: sourceFilePath)
  }

  private var uniqueVideoLookup: [NativeVideo.ID: NativeVideo] {
    var lookup: [NativeVideo.ID: NativeVideo] = [:]
    for section in AppSection.allCases {
      for video in sectionCatalog[section] ?? [] {
        lookup[video.id] = video
      }
    }
    return lookup
  }

  private func syncSelectionToSection() {
    let sectionVideos = videos(for: selectedSection)
    if sectionVideos.isEmpty {
      selectedVideoID = nil
      return
    }

    if let selectedVideoID, sectionVideos.contains(where: { $0.id == selectedVideoID }) {
      return
    }

    if let firstVideo = sectionVideos.first {
      selectedVideoID = firstVideo.id
    }
  }

  private func syncSelectionForDisplayedVideos() {
    let currentVideos = displayedVideos

    if isShowingWatchPage, let selectedVideoID {
      if currentVideos.contains(where: { $0.id == selectedVideoID })
          || uniqueVideoLookup[selectedVideoID] != nil
          || pinnedWatchVideo?.id == selectedVideoID {
        return
      }

      isShowingWatchPage = false
      pinnedWatchVideo = nil
    }

    if let selectedVideoID, currentVideos.contains(where: { $0.id == selectedVideoID }) {
      return
    }

    if !currentVideos.isEmpty {
      selectedVideoID = currentVideos.first?.id
      return
    }

    selectedVideoID = nil
  }

  private func preferredLandingSection() -> AppSection {
    if !(sectionCatalog[.home] ?? []).isEmpty {
      return .home
    }

    if hasActiveIdentity && !(sectionCatalog[.studio] ?? []).isEmpty {
      return .studio
    }

    return .home
  }

  private static func makeSectionCatalog(from videos: [NativeVideo]) -> [AppSection: [NativeVideo]] {
    var catalog = Dictionary(uniqueKeysWithValues: AppSection.allCases.map { ($0, [NativeVideo]()) })

    for video in videos {
      for section in video.sections {
        catalog[section, default: []].append(video)
      }
    }

    return catalog
  }

  private func upsertVideo(
    _ video: NativeVideo,
    in videos: inout [NativeVideo],
    appendIfMissing: Bool
  ) {
    if let existingIndex = videos.firstIndex(where: { $0.id == video.id }) {
      videos[existingIndex] = video
    } else if appendIfMissing {
      videos.append(video)
    }
  }

  private func refreshOwnedWorkspaceProfiles(for channelKey: String) {
    if let profile = channelPageProfile, profile.channelKey == channelKey {
      channelPageProfile = makeChannelProfile(
        channelKey: profile.channelKey,
        publicBeeKey: profile.publicBeeKey,
        avatarURL: profile.avatarURL?.absoluteString,
        name: profile.name,
        description: profile.description,
        videoCount: channelPageVideos.count
      )
    }

    if let profile = studioChannelProfile, profile.channelKey == channelKey {
      studioChannelProfile = makeChannelProfile(
        channelKey: profile.channelKey,
        publicBeeKey: profile.publicBeeKey,
        avatarURL: profile.avatarURL?.absoluteString,
        name: profile.name,
        description: profile.description,
        videoCount: studioWorkspaceVideos.count
      )
    }
  }

  private func refreshPinnedWatchVideo() {
    guard let selectedVideoID else {
      pinnedWatchVideo = nil
      return
    }

    if let refreshedVideo = uniqueVideoLookup[selectedVideoID] {
      pinnedWatchVideo = refreshedVideo
    }
  }

  private func refreshPinnedPlaybackVideo() {
    guard let playingVideoID else {
      pinnedPlaybackVideo = nil
      return
    }

    if let refreshedVideo = uniqueVideoLookup[playingVideoID] {
      pinnedPlaybackVideo = refreshedVideo
    }
  }

  private func refreshChannelPageProfile() {
    guard let profile = channelPageProfile else { return }
    channelPageProfile = makeChannelProfile(
      channelKey: profile.channelKey,
      publicBeeKey: profile.publicBeeKey,
      avatarURL: profile.avatarURL?.absoluteString,
      name: profile.name,
      description: profile.description,
      videoCount: profile.videoCount
    )
  }

  private func refreshStudioWorkspaceProfile() {
    guard let profile = studioChannelProfile else { return }
    studioChannelProfile = makeChannelProfile(
      channelKey: profile.channelKey,
      publicBeeKey: profile.publicBeeKey,
      avatarURL: profile.avatarURL?.absoluteString,
      name: profile.name,
      description: profile.description,
      videoCount: max(profile.videoCount, studioWorkspaceVideos.count)
    )
  }

  private func refreshStudioEditingSelection() {
    guard let selectedStudioVideoID else { return }
    if !studioWorkspaceVideos.contains(where: { $0.id == selectedStudioVideoID }),
       uniqueVideoLookup[selectedStudioVideoID] == nil {
      self.selectedStudioVideoID = studioWorkspaceVideos.first?.id ?? videos(for: .studio).first?.id
    }
  }
}
