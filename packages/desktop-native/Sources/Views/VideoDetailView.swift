import SwiftUI

struct VideoDetailView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    if let video = appState.selectedVideo {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 28)
              .fill(Color(hex: video.accentHex).gradient.opacity(0.9))
              .frame(height: 320)
              .overlay(
                VStack(spacing: 14) {
                  Image(systemName: appState.isPlayingPreview ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(.white)
                  Text("AVPlayer Surface Placeholder")
                    .font(.headline)
                    .foregroundStyle(.white.opacity(0.95))
                }
              )

            VStack(alignment: .leading, spacing: 8) {
              Text(video.title)
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(.white)
              Text("\(video.channelName) • \(video.duration)")
                .foregroundStyle(.white.opacity(0.85))
                .font(.headline)
            }
            .padding(28)
          }

          HStack(spacing: 12) {
            Button(appState.isPlayingPreview ? "Pause Preview" : "Play Preview") {
              if appState.isPlayingPreview {
                appState.pausePreview()
              } else {
                appState.playSelectedPreview()
              }
            }
            .buttonStyle(.borderedProminent)

            Button("Reload Host") {
              Task {
                hostBridge.resetPreviewSession()
                await hostBridge.bootstrapPreviewSession()
              }
            }
            .buttonStyle(.bordered)

            Spacer()

            Text(hostBridge.statusTitle)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }

          Text(video.summary)
            .font(.body)
            .foregroundStyle(.primary)

          FlowTags(tags: video.tags)

          VStack(alignment: .leading, spacing: 10) {
            Label("Host bridge status", systemImage: "cable.connector")
              .font(.headline)
            Text(hostBridge.statusTitle)
            if let lastHeartbeat = hostBridge.lastHeartbeat {
              Text("Preview heartbeat: \(lastHeartbeat.formatted(date: .omitted, time: .standard))")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
          .padding(18)
          .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))

          VStack(alignment: .leading, spacing: 8) {
            Label("Host log", systemImage: "list.bullet.rectangle")
              .font(.headline)
            ForEach(Array(hostBridge.logLines.enumerated()), id: \.offset) { _, line in
              Text(line)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            }
          }
        }
        .padding(28)
      }
    } else {
      ContentUnavailableView(
        "Select a Video",
        systemImage: "play.square.stack",
        description: Text("The native shell scaffold is ready for a browse-to-detail-to-play flow.")
      )
    }
  }
}

private struct FlowTags: View {
  let tags: [String]

  var body: some View {
    HStack(spacing: 8) {
      ForEach(tags, id: \.self) { tag in
        Text(tag.uppercased())
          .font(.caption.weight(.semibold))
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(.quaternary.opacity(0.5), in: Capsule())
      }
    }
  }
}
