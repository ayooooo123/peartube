import Foundation

struct NativeBrowseSnapshot: Codable, Hashable {
  let generatedAt: TimeInterval
  let sections: NativeBrowseSections
  let stats: NativeBrowseStats
  let state: NativeBrowseState

  init(
    generatedAt: TimeInterval,
    sections: NativeBrowseSections,
    stats: NativeBrowseStats,
    state: NativeBrowseState = .empty
  ) {
    self.generatedAt = generatedAt
    self.sections = sections
    self.stats = stats
    self.state = state
  }
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

struct NativeBrowseState: Codable, Hashable {
  let subscriptionChannelKeys: [String]
  let identityChannelKeys: [String]
  let activeIdentityName: String?
  let activeIdentityChannelKey: String?
  let activeChannelPublished: Bool

  static let empty = NativeBrowseState(
    subscriptionChannelKeys: [],
    identityChannelKeys: [],
    activeIdentityName: nil,
    activeIdentityChannelKey: nil,
    activeChannelPublished: false
  )

  var hasActiveIdentity: Bool {
    activeIdentityName != nil || activeIdentityChannelKey != nil
  }
}
