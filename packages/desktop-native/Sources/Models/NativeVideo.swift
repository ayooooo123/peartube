import Foundation

enum NativeVideoPresentationStyle: Equatable {
  case landscape
  case square
  case portrait
}

struct NativeVideo: Identifiable, Hashable, Codable {
  let id: String
  let backendVideoID: String
  let channelKey: String
  let publicBeeKey: String?
  let title: String
  let channelName: String
  let durationText: String
  let summary: String
  let tags: [String]
  let accentHex: String
  let sections: Set<AppSection>
  let thumbnailURL: URL?
  let path: String?
  let blobId: String?
  let blobsCoreKey: String?
  let mimeType: String?
  let width: Int?
  let height: Int?

  init(
    id: String,
    backendVideoID: String,
    channelKey: String,
    publicBeeKey: String? = nil,
    title: String,
    channelName: String,
    durationText: String,
    summary: String,
    tags: [String],
    accentHex: String,
    sections: Set<AppSection>,
    thumbnailURL: URL? = nil,
    path: String? = nil,
    blobId: String? = nil,
    blobsCoreKey: String? = nil,
    mimeType: String? = nil,
    width: Int? = nil,
    height: Int? = nil
  ) {
    self.id = id
    self.backendVideoID = backendVideoID
    self.channelKey = channelKey
    self.publicBeeKey = publicBeeKey
    self.title = title
    self.channelName = channelName
    self.durationText = durationText
    self.summary = summary
    self.tags = tags
    self.accentHex = accentHex
    self.sections = sections
    self.thumbnailURL = thumbnailURL
    self.path = path
    self.blobId = blobId
    self.blobsCoreKey = blobsCoreKey
    self.mimeType = mimeType
    self.width = width
    self.height = height
  }

  var playbackReference: String {
    if let path, path.hasPrefix("/videos/") {
      return path
    }
    return backendVideoID
  }

  var thumbnailReference: String {
    if let path, path.hasPrefix("/videos/") {
      return path
    }
    return backendVideoID
  }

  var thumbnailCacheKey: String {
    [
      channelKey,
      publicBeeKey ?? "",
      thumbnailReference,
      blobId ?? "",
      blobsCoreKey ?? ""
    ].joined(separator: "|")
  }

  var intrinsicAspectRatio: Double? {
    guard let width, let height, width > 0, height > 0 else {
      return nil
    }

    return Double(width) / Double(height)
  }

  var presentationStyle: NativeVideoPresentationStyle {
    guard let intrinsicAspectRatio else {
      return .landscape
    }

    if intrinsicAspectRatio < 0.8 {
      return .portrait
    }

    if intrinsicAspectRatio < 1.2 {
      return .square
    }

    return .landscape
  }

  var displayAspectRatio: Double {
    switch presentationStyle {
    case .portrait:
      return 9.0 / 16.0
    case .square:
      return 1.0
    case .landscape:
      return 16.0 / 9.0
    }
  }

  var heroAspectRatio: Double {
    guard let intrinsicAspectRatio else {
      return 16.0 / 9.0
    }

    return min(max(intrinsicAspectRatio, 9.0 / 16.0), 16.0 / 9.0)
  }
}

extension NativeVideo {
  func updating(
    title: String? = nil,
    summary: String? = nil,
    thumbnailURL: URL? = nil
  ) -> NativeVideo {
    NativeVideo(
      id: id,
      backendVideoID: backendVideoID,
      channelKey: channelKey,
      publicBeeKey: publicBeeKey,
      title: title ?? self.title,
      channelName: channelName,
      durationText: durationText,
      summary: summary ?? self.summary,
      tags: tags,
      accentHex: accentHex,
      sections: sections,
      thumbnailURL: thumbnailURL ?? self.thumbnailURL,
      path: path,
      blobId: blobId,
      blobsCoreKey: blobsCoreKey,
      mimeType: mimeType,
      width: width,
      height: height
    )
  }

  static let samples: [NativeVideo] = [
    NativeVideo(
      id: "sample-native-shell-walkthrough",
      backendVideoID: "sample-native-shell-walkthrough",
      channelKey: "sample-channel-native",
      title: "Native Shell Walkthrough",
      channelName: "PearTube HQ",
      durationText: "9:12",
      summary: "A pinned walkthrough of the new macOS shell architecture, showing how browse, detail, and playback can live above the shared host seam.",
      tags: ["native", "swiftui", "host"],
      accentHex: "#FF7A59",
      sections: [.home, .library]
    ),
    NativeVideo(
      id: "sample-offline-feed-smoke",
      backendVideoID: "sample-offline-feed-smoke",
      channelKey: "sample-channel-diagnostics",
      title: "Offline Feed Smoke Test",
      channelName: "Diagnostics Lab",
      durationText: "4:38",
      summary: "A short validation clip for proving feed hydration and playback URL resolution after the host boots inside a native shell.",
      tags: ["offline", "feed", "diagnostics"],
      accentHex: "#4B65FF",
      sections: [.home, .diagnostics]
    ),
    NativeVideo(
      id: "sample-channel-sync-deep-dive",
      backendVideoID: "sample-channel-sync-deep-dive",
      channelKey: "sample-channel-sync",
      title: "Channel Sync Deep Dive",
      channelName: "Peer Signals",
      durationText: "13:47",
      summary: "A longer browse-to-detail example that stands in for subscribed channels and richer metadata views.",
      tags: ["subscriptions", "sync"],
      accentHex: "#12B886",
      sections: [.subscriptions, .library]
    ),
    NativeVideo(
      id: "sample-creator-studio-surface",
      backendVideoID: "sample-creator-studio-surface",
      channelKey: "sample-channel-studio",
      title: "Creator Studio Surface",
      channelName: "Studio Preview",
      durationText: "6:05",
      summary: "A placeholder slice for the future studio flow: uploads, metadata edits, and device-aware capabilities.",
      tags: ["studio", "upload"],
      accentHex: "#E64980",
      sections: [.studio]
    )
  ]
}
