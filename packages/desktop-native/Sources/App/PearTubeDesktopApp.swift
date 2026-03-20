import Observation
import SwiftUI

@main
struct PearTubeDesktopApp: App {
  @State private var appState = AppState()
  @State private var hostBridge = HostBridgeService()

  var body: some Scene {
    WindowGroup("PearTube Native") {
      ContentView()
        .environment(appState)
        .environment(hostBridge)
        .frame(minWidth: 1100, minHeight: 760)
        .task {
          await hostBridge.bootstrapPreviewSession()
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
