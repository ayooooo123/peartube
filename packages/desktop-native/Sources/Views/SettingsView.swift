import SwiftUI

struct SettingsView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    Form {
      Section("Migration") {
        LabeledContent("Native shell") {
          Text("Enabled")
        }
        LabeledContent("Desktop fallback") {
          Text("Pear runtime remains available")
        }
      }

      Section("Host bridge") {
        Text(hostBridge.statusTitle)
        Button("Reload Preview Host") {
          Task {
            hostBridge.resetPreviewSession()
            await hostBridge.bootstrapPreviewSession()
          }
        }
      }

      Section("Selection") {
        Text(appState.selectedVideo?.title ?? "No video selected")
      }
    }
    .formStyle(.grouped)
  }
}
