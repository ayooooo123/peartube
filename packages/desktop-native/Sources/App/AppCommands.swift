import SwiftUI

struct PearTubeDesktopCommands: Commands {
  let appState: AppState
  let hostBridge: HostBridgeService

  var body: some Commands {
    CommandMenu("PearTube Native") {
      Button("Reload Native Host") {
        Task {
          await hostBridge.refreshBrowse(into: appState)
        }
      }
      .keyboardShortcut("r", modifiers: [.command, .shift])

      Divider()

      Button("Jump to Diagnostics") {
        appState.selectSection(.diagnostics)
      }
      .keyboardShortcut("d", modifiers: [.command, .shift])

      Button("Play Selected Preview") {
        appState.playSelectedPreview()
      }
      .keyboardShortcut(.space, modifiers: [])
    }

    CommandGroup(replacing: .newItem) {}
  }
}
