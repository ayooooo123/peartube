import Foundation

enum AppSection: String, CaseIterable, Identifiable, Hashable, Codable {
  case home
  case subscriptions
  case library
  case studio
  case diagnostics

  var id: String { rawValue }

  var title: String {
    switch self {
    case .home: return "Home"
    case .subscriptions: return "Subscriptions"
    case .library: return "Library"
    case .studio: return "Studio"
    case .diagnostics: return "Diagnostics"
    }
  }

  var systemImage: String {
    switch self {
    case .home: return "house"
    case .subscriptions: return "dot.radiowaves.left.and.right"
    case .library: return "film.stack"
    case .studio: return "slider.horizontal.3"
    case .diagnostics: return "waveform.path.ecg"
    }
  }

  var headline: String {
    switch self {
    case .home: return "Browse the shared PearTube feed from the native macOS shell."
    case .subscriptions: return "Keep up with subscribed channels without dropping into the web renderer."
    case .library: return "Review the videos and channels tied to this device's identities."
    case .studio: return "Manage your own channel surface and creator workflow from the native shell."
    case .diagnostics: return "Inspect host status, logs, and storage details while the embedded Bare backend runs."
    }
  }

  var emptyTitle: String {
    switch self {
    case .home: return "No Feed Videos Yet"
    case .subscriptions: return "No Subscriptions Yet"
    case .library: return "No Library Videos Yet"
    case .studio: return "No Studio Videos Yet"
    case .diagnostics: return "Diagnostics Ready"
    }
  }

  var emptyDescription: String {
    switch self {
    case .home:
      return "Pull to refresh the public feed or let the host discover more peers."
    case .subscriptions:
      return "Subscribed channels will appear here once the shared host loads them."
    case .library:
      return "Your published and local channel content will appear here when identities are available."
    case .studio:
      return "This section will surface your own channel uploads and metadata actions."
    case .diagnostics:
      return "Use this section to inspect host logs, storage selection, and backend health."
    }
  }
}
