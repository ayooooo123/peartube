import Observation
import SwiftUI

@MainActor
final class PearTubeDesktopAppDelegate: NSObject, NSApplicationDelegate {
  weak var hostBridge: HostBridgeService?
  private var terminationTask: Task<Void, Never>?
  private weak var terminatingApplication: NSApplication?

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard terminationTask == nil else { return .terminateLater }
    guard let hostBridge else { return .terminateNow }

    terminatingApplication = sender
    terminationTask = Task { @MainActor [weak self] in
      await hostBridge.resetBridgeState()
      guard let self else { return }
      self.terminationTask = nil
      self.terminatingApplication?.reply(toApplicationShouldTerminate: true)
      self.terminatingApplication = nil
    }

    return .terminateLater
  }
}

@main
struct PearTubeDesktopApp: App {
  @NSApplicationDelegateAdaptor(PearTubeDesktopAppDelegate.self) private var appDelegate
  @State private var appState = AppState()
  @State private var hostBridge = HostBridgeService()

  private static var isRunningTests: Bool {
    ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
  }

  var body: some Scene {
    WindowGroup("PearTube Native") {
      ContentView()
        .environment(appState)
        .environment(hostBridge)
        .frame(minWidth: 1100, minHeight: 760)
        .task {
          guard !Self.isRunningTests else { return }
          appDelegate.hostBridge = hostBridge
          await hostBridge.bootstrap(appState: appState)
        }
    }
    .defaultSize(width: 1440, height: 880)
    .commands {
      PearTubeDesktopCommands(appState: appState, hostBridge: hostBridge)
    }

    Settings {
      SettingsView()
        .environment(appState)
        .environment(hostBridge)
        .frame(width: 420)
        .padding(24)
    }
  }
}
