import SwiftUI

struct SidebarView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    List {
      Section("Workspace") {
        ForEach(AppSection.allCases) { section in
          Button {
            appState.selectSection(section)
          } label: {
            HStack(spacing: 10) {
              Label(section.title, systemImage: section.systemImage)
              Spacer(minLength: 12)
              Text("\(appState.videoCount(for: section))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(isSelected(section) ? .primary : .secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(isSelected(section) ? 0.9 : 0.5), in: Capsule())
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rowBackground(for: section))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
          }
          .buttonStyle(.plain)
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

  private func isSelected(_ section: AppSection) -> Bool {
    appState.currentSection == section
  }

  private func rowBackground(for section: AppSection) -> some ShapeStyle {
    if isSelected(section) {
      return AnyShapeStyle(.quaternary.opacity(0.7))
    }

    return AnyShapeStyle(.clear)
  }
}
