import SwiftUI

struct SidebarView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    @Bindable var appState = appState

    List(selection: $appState.selectedSection) {
      Section("Workspace") {
        ForEach(AppSection.allCases) { section in
          HStack(spacing: 10) {
            Label(section.title, systemImage: section.systemImage)
            Spacer(minLength: 12)
            Text("\(appState.videoCount(for: section))")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 8)
              .padding(.vertical, 4)
              .background(.quaternary.opacity(0.5), in: Capsule())
          }
            .tag(Optional(section))
        }
      }

      Section("Host") {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 8) {
            Circle()
              .fill(hostIndicatorColor)
              .frame(width: 8, height: 8)
            Text(hostBridge.statusTitle)
              .font(.headline)
          }

          Text("Native macOS shell over the shared Bare host.")
            .font(.caption)
            .foregroundStyle(.secondary)

          if let lastHeartbeat = hostBridge.lastHeartbeat {
            Text("Heartbeat \(lastHeartbeat.formatted(date: .omitted, time: .shortened))")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        .padding(.vertical, 8)
      }
    }
    .listStyle(.sidebar)
    .navigationTitle("PearTube Native")
  }

  private var hostIndicatorColor: Color {
    switch hostBridge.phase {
    case .idle:
      return .secondary
    case .booting:
      return .orange
    case .ready:
      return .green
    case .failed:
      return .red
    }
  }
}
