import Foundation
import Observation

@MainActor
@Observable
final class AppState {
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

  private let catalog: [NativeVideo]

  init(catalog: [NativeVideo] = NativeVideo.samples) {
    self.catalog = catalog
    selectedSection = .home
    selectedVideoID = catalog.first?.id
  }

  var currentSection: AppSection {
    selectedSection ?? .home
  }

  var selectedVideo: NativeVideo? {
    catalog.first(where: { $0.id == selectedVideoID })
  }

  func videos(for section: AppSection? = nil) -> [NativeVideo] {
    let target = section ?? currentSection
    return catalog.filter { $0.sections.contains(target) }
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

  private func syncSelectionToSection() {
    let firstVideo = videos(for: selectedSection).first
    if let firstVideo {
      selectedVideoID = firstVideo.id
      if playingVideoID == nil {
        playingVideoID = firstVideo.id
      }
    } else {
      selectedVideoID = nil
    }
  }
}
