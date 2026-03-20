import SwiftUI

struct SidebarView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    @Bindable var appState = appState

    List(selection: $appState.selectedSection) {
      Section("Workspace") {
        ForEach(AppSection.allCases) { section in
          Label(section.title, systemImage: section.systemImage)
            .tag(Optional(section))
        }
      }

      Section("Host") {
        VStack(alignment: .leading, spacing: 6) {
          Text(hostBridge.statusTitle)
            .font(.headline)
          Text("This shell is native now; the host bridge is still a preview stub.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
      }
    }
    .listStyle(.sidebar)
    .navigationTitle("PearTube Native")
  }
}
