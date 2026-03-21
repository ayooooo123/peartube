import Foundation

struct NativeBrowseSnapshot: Codable, Hashable {
  let generatedAt: TimeInterval
  let sections: NativeBrowseSections
  let stats: NativeBrowseStats
}

struct NativeBrowseSections: Codable, Hashable {
  let home: [NativeVideo]
  let subscriptions: [NativeVideo]
  let library: [NativeVideo]
  let studio: [NativeVideo]
  let diagnostics: [NativeVideo]

  func videos(for section: AppSection) -> [NativeVideo] {
    switch section {
    case .home: return home
    case .subscriptions: return subscriptions
    case .library: return library
    case .studio: return studio
    case .diagnostics: return diagnostics
    }
  }
}

struct NativeBrowseStats: Codable, Hashable {
  let homeCount: Int
  let subscriptionCount: Int
  let libraryCount: Int
  let channelCount: Int
}
