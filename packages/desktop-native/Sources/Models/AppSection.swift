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
    case .home: return "Browse the native desktop shell scaffold."
    case .subscriptions: return "Preview the subscription-oriented two-column flow."
    case .library: return "Validate how a local-first media library will feel on macOS."
    case .studio: return "Stage future creator and upload controls without touching Electron."
    case .diagnostics: return "Inspect host bridge status while the backend seam stabilizes."
    }
  }
}
