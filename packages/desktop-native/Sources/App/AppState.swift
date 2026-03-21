import Foundation
import Observation

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
      if let selectedVideoID {
        isPlayingPreview = selectedVideoID == playingVideoID
      } else {
        isPlayingPreview = false
      }
    }
  }

  var playingVideoID: NativeVideo.ID?
  var isPlayingPreview = false

  private var sectionCatalog: [AppSection: [NativeVideo]]
  private var searchResults: [NativeVideo] = []
  private var browseState: NativeBrowseState = .empty

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
    selectedSection = section
  }

  func selectVideo(_ id: NativeVideo.ID?) {
    selectedVideoID = id
  }

  func playSelectedPreview() {
    guard let selectedVideoID else { return }
    playingVideoID = selectedVideoID
    isPlayingPreview = true
  }

  func pausePreview() {
    isPlayingPreview = false
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
    syncSelectionForDisplayedVideos()
  }

  func applySearchResults(query: String, videos: [NativeVideo]) {
    searchQuery = query
    searchResults = videos
    lastErrorMessage = nil
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
    syncSelectionForDisplayedVideos()
  }

  func clearPlaybackSelection() {
    playingVideoID = nil
    isPlayingPreview = false
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
      if playingVideoID == nil {
        playingVideoID = firstVideo.id
      }
    }
  }

  private func syncSelectionForDisplayedVideos() {
    let currentVideos = displayedVideos

    if let selectedVideoID, currentVideos.contains(where: { $0.id == selectedVideoID }) {
      return
    }

    if !currentVideos.isEmpty {
      selectedVideoID = currentVideos.first?.id
      if playingVideoID == nil {
        playingVideoID = currentVideos.first?.id
      }
      return
    }

    selectedVideoID = nil
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
}
