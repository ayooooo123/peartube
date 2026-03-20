import Foundation

struct NativeVideo: Identifiable, Hashable {
  let id: UUID
  let title: String
  let channelName: String
  let duration: String
  let summary: String
  let tags: [String]
  let accentHex: String
  let sections: Set<AppSection>

  init(
    id: UUID = UUID(),
    title: String,
    channelName: String,
    duration: String,
    summary: String,
    tags: [String],
    accentHex: String,
    sections: Set<AppSection>
  ) {
    self.id = id
    self.title = title
    self.channelName = channelName
    self.duration = duration
    self.summary = summary
    self.tags = tags
    self.accentHex = accentHex
    self.sections = sections
  }
}

extension NativeVideo {
  static let samples: [NativeVideo] = [
    NativeVideo(
      title: "Native Shell Walkthrough",
      channelName: "PearTube HQ",
      duration: "09:12",
      summary: "A pinned walkthrough of the new macOS shell architecture, showing how browse, detail, and playback can live above the shared host seam.",
      tags: ["native", "swiftui", "host"],
      accentHex: "#FF7A59",
      sections: [.home, .library]
    ),
    NativeVideo(
      title: "Offline Feed Smoke Test",
      channelName: "Diagnostics Lab",
      duration: "04:38",
      summary: "A short validation clip for proving feed hydration and playback URL resolution after the host boots inside a native shell.",
      tags: ["offline", "feed", "diagnostics"],
      accentHex: "#4B65FF",
      sections: [.home, .diagnostics]
    ),
    NativeVideo(
      title: "Channel Sync Deep Dive",
      channelName: "Peer Signals",
      duration: "13:47",
      summary: "A longer browse-to-detail example that stands in for subscribed channels and richer metadata views.",
      tags: ["subscriptions", "sync"],
      accentHex: "#12B886",
      sections: [.subscriptions, .library]
    ),
    NativeVideo(
      title: "Creator Studio Surface",
      channelName: "Studio Preview",
      duration: "06:05",
      summary: "A placeholder slice for the future studio flow: uploads, metadata edits, and device-aware capabilities.",
      tags: ["studio", "upload"],
      accentHex: "#E64980",
      sections: [.studio]
    )
  ]
}
