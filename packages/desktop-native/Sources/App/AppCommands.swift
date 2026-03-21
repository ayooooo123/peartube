import SwiftUI

struct PearTubeDesktopCommands: Commands {
  let appState: AppState
  let hostBridge: HostBridgeService

  var body: some Commands {
    CommandMenu("PearTube Native") {
      Button("Create Channel") {
        Task {
          await hostBridge.createIdentity(into: appState)
        }
      }
      .keyboardShortcut("n", modifiers: [.command, .shift])

      Button("Refresh Public Feed") {
        Task {
          await hostBridge.refreshPublicFeed(into: appState)
        }
      }
      .keyboardShortcut("r", modifiers: [.command, .shift])

      Button("Upload Video") {
        Task {
          await hostBridge.uploadVideo(into: appState)
        }
      }
      .keyboardShortcut("u", modifiers: [.command, .shift])

      Divider()

      Button("Reload Native Host") {
        Task {
          await hostBridge.refreshBrowse(into: appState)
        }
      }
      .keyboardShortcut("r", modifiers: [.command, .option])

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
