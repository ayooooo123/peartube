import Foundation
import MediaToolbox
import VideoToolbox

struct ProfessionalVideoWorkflowRegistrationState {
  var didRegister = false
}

struct BundledMediaExtension: Equatable {
  let bundleName: String
  let bundleIdentifier: String
  let extensionIdentifier: String
  let extensionPointIdentifier: String
  let bundleURL: URL
}

struct ProfessionalVideoWorkflowDiagnostics: Equatable {
  let isEnabled: Bool
  let isRoutingEnabled: Bool
  let pluginsDirectoryURL: URL?
  let bundledExtensions: [BundledMediaExtension]

  var statusTitle: String {
    guard isEnabled else { return "Disabled" }
    return isRoutingEnabled ? "Enabled + Routing" : "Enabled"
  }

  var bundledExtensionsSummary: String {
    guard !bundledExtensions.isEmpty else {
      return "No bundled MediaExtensions"
    }

    if bundledExtensions.count == 1 {
      return bundledExtensions[0].bundleName
    }

    return "\(bundledExtensions.count) bundled MediaExtensions"
  }

  var reportLines: [String] {
    var lines = [
      "Media extensions: \(statusTitle)",
      "Media extension routing: \(isRoutingEnabled ? "Enabled" : "Disabled")",
      "Media extension plug-ins: \(pluginsDirectoryURL?.path ?? "Unavailable")",
    ]

    if bundledExtensions.isEmpty {
      lines.append("Bundled MediaExtensions: none")
    } else {
      lines.append("Bundled MediaExtensions:")
      for bundledExtension in bundledExtensions {
        lines.append(
          "- \(bundledExtension.bundleName) [\(bundledExtension.extensionPointIdentifier)] \(bundledExtension.extensionIdentifier)"
        )
      }
    }

    return lines
  }
}

enum ProfessionalVideoWorkflowExtensions {
  static let enableEnvironmentKey = "PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSIONS"
  static let routingEnvironmentKey = "PEARTUBE_NATIVE_ENABLE_MEDIA_EXTENSION_ROUTING"

  private static let lock = NSLock()
  private static var sharedState = ProfessionalVideoWorkflowRegistrationState()

  static func isEnabled(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    isTruthy(environment[enableEnvironmentKey])
  }

  static func isExperimentalRoutingEnabled(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Bool {
    isEnabled(environment: environment) && isTruthy(environment[routingEnvironmentKey])
  }

  static func diagnostics(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    pluginsDirectory: URL? = Bundle.main.builtInPlugInsURL,
    fileManager: FileManager = .default
  ) -> ProfessionalVideoWorkflowDiagnostics {
    ProfessionalVideoWorkflowDiagnostics(
      isEnabled: isEnabled(environment: environment),
      isRoutingEnabled: isExperimentalRoutingEnabled(environment: environment),
      pluginsDirectoryURL: pluginsDirectory,
      bundledExtensions: bundledMediaExtensions(
        pluginsDirectory: pluginsDirectory,
        fileManager: fileManager
      )
    )
  }

  static func bundledMediaExtensions(
    pluginsDirectory: URL?,
    fileManager: FileManager = .default
  ) -> [BundledMediaExtension] {
    guard let pluginsDirectory else { return [] }

    let entries = (try? fileManager.contentsOfDirectory(
      at: pluginsDirectory,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )) ?? []

    return entries
      .filter { $0.pathExtension == "appex" }
      .compactMap { bundledMediaExtension(at: $0) }
      .sorted { lhs, rhs in
        lhs.bundleName.localizedCaseInsensitiveCompare(rhs.bundleName) == .orderedAscending
      }
  }

  @discardableResult
  static func registerIfNeeded(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    formatReaderRegistration: () -> Void = MTRegisterProfessionalVideoWorkflowFormatReaders,
    videoDecoderRegistration: () -> Void = VTRegisterProfessionalVideoWorkflowVideoDecoders
  ) -> Bool {
    guard isEnabled(environment: environment) else { return false }

    lock.lock()
    defer { lock.unlock() }

    guard !sharedState.didRegister else { return false }

    formatReaderRegistration()
    videoDecoderRegistration()
    sharedState.didRegister = true
    return true
  }

  @discardableResult
  static func registerIfNeeded(
    environment: [String: String],
    state: inout ProfessionalVideoWorkflowRegistrationState,
    formatReaderRegistration: () -> Void,
    videoDecoderRegistration: () -> Void
  ) -> Bool {
    guard isEnabled(environment: environment) else { return false }
    guard !state.didRegister else { return false }

    formatReaderRegistration()
    videoDecoderRegistration()
    state.didRegister = true
    return true
  }

  private static func isTruthy(_ value: String?) -> Bool {
    guard let normalized = value?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased(),
      !normalized.isEmpty else {
      return false
    }

    switch normalized {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }

  private static func bundledMediaExtension(
    at bundleURL: URL
  ) -> BundledMediaExtension? {
    let infoPlistCandidates = [
      bundleURL.appendingPathComponent("Contents/Info.plist"),
      bundleURL.appendingPathComponent("Info.plist")
    ]

    guard let infoPlistURL = infoPlistCandidates.first(where: {
      FileManager.default.fileExists(atPath: $0.path)
    }),
    let data = try? Data(contentsOf: infoPlistURL),
    let propertyList = try? PropertyListSerialization.propertyList(from: data, format: nil),
    let info = propertyList as? [String: Any],
    let extensionAttributes = info["EXAppExtensionAttributes"] as? [String: Any],
    let extensionPointIdentifier = extensionAttributes["EXExtensionPointIdentifier"] as? String,
    extensionPointIdentifier.hasPrefix("com.apple.mediaextension."),
    let extensionIdentifier = extensionAttributes["ClassImplementationID"] as? String else {
      return nil
    }

    let bundleName = (info["CFBundleDisplayName"] as? String)
      ?? (info["CFBundleName"] as? String)
      ?? bundleURL.deletingPathExtension().lastPathComponent

    return BundledMediaExtension(
      bundleName: bundleName,
      bundleIdentifier: (info["CFBundleIdentifier"] as? String) ?? bundleName,
      extensionIdentifier: extensionIdentifier,
      extensionPointIdentifier: extensionPointIdentifier,
      bundleURL: bundleURL
    )
  }
}
