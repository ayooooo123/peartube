import Foundation
import Observation

@MainActor
@Observable
final class AppState {
  var isLoading = false
  var lastErrorMessage: String?
  var selectedSection: AppSection? {
    didSet { syncSelectionToSection() }
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

  init(catalog: [NativeVideo] = NativeVideo.samples) {
    self.sectionCatalog = Self.makeSectionCatalog(from: catalog)
    selectedSection = .home
    selectedVideoID = Self.makeSectionCatalog(from: catalog)[.home]?.first?.id ?? catalog.first?.id
  }

  var currentSection: AppSection {
    selectedSection ?? .home
  }

  var selectedVideo: NativeVideo? {
    uniqueVideoLookup[selectedVideoID ?? ""]
  }

  func videos(for section: AppSection? = nil) -> [NativeVideo] {
    let target = section ?? currentSection
    return sectionCatalog[target] ?? []
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
    sectionCatalog = [
      .home: snapshot.sections.home,
      .subscriptions: snapshot.sections.subscriptions,
      .library: snapshot.sections.library,
      .studio: snapshot.sections.studio,
      .diagnostics: snapshot.sections.diagnostics,
    ]
    lastErrorMessage = nil
    syncSelectionAfterCatalogUpdate()
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
      selectedVideoID = fallbackVideo()?.id
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

  private func syncSelectionAfterCatalogUpdate() {
    if let selectedVideoID, uniqueVideoLookup[selectedVideoID] != nil {
      let currentVideos = videos(for: selectedSection)
      if selectedSection == nil || currentVideos.contains(where: { $0.id == selectedVideoID }) {
        return
      }
    }

    selectedVideoID = videos(for: selectedSection).first?.id ?? fallbackVideo()?.id
  }

  private func fallbackVideo() -> NativeVideo? {
    for section in AppSection.allCases {
      if let video = sectionCatalog[section]?.first {
        return video
      }
    }

    return nil
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
