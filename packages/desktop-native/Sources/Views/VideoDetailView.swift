import AVKit
import SwiftUI

struct VideoDetailView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var player: AVPlayer?
  private let metadataColumns = [
    GridItem(.flexible(minimum: 180), spacing: 16),
    GridItem(.flexible(minimum: 180), spacing: 16),
  ]

  var body: some View {
    if let video = appState.selectedVideo {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 28)
              .fill(Color(hex: video.accentHex).gradient.opacity(0.9))
              .overlay {
                if let player {
                  VideoPlayer(player: player)
                    .clipShape(RoundedRectangle(cornerRadius: 28))
                } else {
                  VStack(spacing: 14) {
                    Image(systemName: hostBridge.isResolvingPlayback ? "dot.radiowaves.left.and.right" : "play.circle.fill")
                      .font(.system(size: 72))
                      .foregroundStyle(.white)
                    Text(hostBridge.isResolvingPlayback ? "Resolving Playback URL" : "Ready for AVPlayer")
                      .font(.headline)
                      .foregroundStyle(.white.opacity(0.95))
                  }
                }
              }
              .frame(height: 320)

            VStack(alignment: .leading, spacing: 8) {
              Text(video.sections.displayText)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.85))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.white.opacity(0.14), in: Capsule())
              Text(video.title)
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(.white)
              Text("\(video.channelName) • \(video.durationText)")
                .foregroundStyle(.white.opacity(0.85))
                .font(.headline)
            }
            .padding(28)
          }

          actionBar(for: video)

          VStack(alignment: .leading, spacing: 12) {
            Text(video.summary)
              .font(.body)
              .foregroundStyle(.primary)

            FlowTags(tags: video.tags)
          }

          LazyVGrid(columns: metadataColumns, spacing: 16) {
            DetailMetricCard(
              title: "Channel",
              value: video.channelName,
              caption: shortKey(video.channelKey)
            )
            DetailMetricCard(
              title: "Duration",
              value: video.durationText,
              caption: appState.isSearchActive ? "Global search hit" : appState.currentSection.title
            )
            DetailMetricCard(
              title: "Sections",
              value: video.sections.displayText,
              caption: "\(video.tags.count) tags"
            )
            DetailMetricCard(
              title: "Host",
              value: hostBridge.statusTitle,
              caption: heartbeatCaption
            )
          }

          if !appState.relatedVideos().isEmpty {
            VStack(alignment: .leading, spacing: 14) {
              Text("Up Next")
                .font(.title3.weight(.semibold))

              VStack(spacing: 10) {
                ForEach(appState.relatedVideos()) { relatedVideo in
                  Button {
                    appState.selectVideo(relatedVideo.id)
                  } label: {
                    HStack(spacing: 12) {
                      RoundedRectangle(cornerRadius: 14)
                        .fill(Color(hex: relatedVideo.accentHex).gradient)
                        .frame(width: 88, height: 56)
                        .overlay {
                          Image(systemName: "play.fill")
                            .foregroundStyle(.white)
                        }

                      VStack(alignment: .leading, spacing: 4) {
                        Text(relatedVideo.title)
                          .font(.headline)
                          .foregroundStyle(.primary)
                          .lineLimit(2)
                        Text("\(relatedVideo.channelName) • \(relatedVideo.durationText)")
                          .font(.caption)
                          .foregroundStyle(.secondary)
                      }

                      Spacer()
                    }
                    .padding(14)
                    .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 18))
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          VStack(alignment: .leading, spacing: 10) {
            Label("Host log", systemImage: "list.bullet.rectangle")
              .font(.headline)
            ForEach(Array(hostBridge.logLines.suffix(8).enumerated()), id: \.offset) { _, line in
              Text(line)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            }
          }
          .padding(18)
          .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 18))
        }
        .padding(28)
      }
      .onChange(of: appState.selectedVideoID) { _, selectedVideoID in
        if selectedVideoID != hostBridge.activePlaybackVideoID {
          player?.pause()
          player = nil
          hostBridge.clearPlayback()
          appState.pausePreview()
        }
      }
    } else if !appState.isSearchActive, appState.currentSection == .diagnostics {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          Text("Diagnostics")
            .font(.largeTitle.bold())

          Text("Inspect the native host bridge, current storage target, and recent Bare-sidecar logs.")
            .font(.subheadline)
            .foregroundStyle(.secondary)

          HStack(spacing: 12) {
            Button("Reload Host") {
              Task {
                await hostBridge.refreshBrowse(into: appState)
              }
            }
            .buttonStyle(.borderedProminent)

            if let storagePath = hostBridge.selectedStoragePath {
              Text(storagePath)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
          }

          DetailMetricCard(
            title: "Host",
            value: hostBridge.statusTitle,
            caption: heartbeatCaption
          )

          VStack(alignment: .leading, spacing: 10) {
            Label("Recent host log", systemImage: "list.bullet.rectangle")
              .font(.headline)

            ForEach(Array(hostBridge.logLines.suffix(20).enumerated()), id: \.offset) { _, line in
              Text(line)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          .padding(18)
          .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 18))
        }
        .padding(28)
      }
    } else {
      if appState.isSearchActive {
        ContentUnavailableView(
          appState.isLoading ? "Searching the Network" : "No Video Selected",
          systemImage: "magnifyingglass",
          description: Text(
            appState.lastErrorMessage ?? "Search results will appear here with inline playback and detail."
          )
        )
      } else {
        ScrollView {
          SectionEmptyStateView(section: appState.currentSection, prominence: .detail)
            .padding(28)
        }
      }
    }
  }

  @ViewBuilder
  private func actionBar(for video: NativeVideo) -> some View {
    HStack(spacing: 12) {
      Button(appState.isPlayingPreview ? "Pause" : "Play") {
        if appState.isPlayingPreview {
          player?.pause()
          appState.pausePreview()
          hostBridge.clearPlayback()
        } else {
          Task {
            if let url = await hostBridge.resolvePlayback(for: video) {
              player = AVPlayer(url: url)
              player?.play()
              appState.playSelectedPreview()
            }
          }
        }
      }
      .buttonStyle(.borderedProminent)

      if appState.ownsChannel(video.channelKey) {
        if !appState.activeChannelPublished {
          Button("Publish Channel") {
            Task {
              await hostBridge.publishActiveChannel(into: appState)
            }
          }
          .buttonStyle(.bordered)
        } else {
          Text("Published")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.quaternary.opacity(0.4), in: Capsule())
        }

        Button("Upload Video") {
          Task {
            await hostBridge.uploadVideo(into: appState)
          }
        }
        .buttonStyle(.bordered)
      } else {
        Button(appState.isSubscribed(to: video.channelKey) ? "Unsubscribe" : "Subscribe") {
          Task {
            await hostBridge.toggleSubscription(for: video, into: appState)
          }
        }
        .buttonStyle(.bordered)
      }

      Button("Refresh Feed") {
        Task {
          await hostBridge.refreshPublicFeed(into: appState)
        }
      }
      .buttonStyle(.bordered)

      Spacer()

      Text(hostBridge.statusTitle)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }

  private var heartbeatCaption: String {
    if let lastHeartbeat = hostBridge.lastHeartbeat {
      return "Heartbeat \(lastHeartbeat.formatted(date: .omitted, time: .shortened))"
    }
    return "Awaiting host heartbeat"
  }

  private func shortKey(_ key: String) -> String {
    String(key.prefix(12))
  }
}

private struct FlowTags: View {
  let tags: [String]

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], alignment: .leading, spacing: 8) {
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

private struct DetailMetricCard: View {
  let title: String
  let value: String
  let caption: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title.uppercased())
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.title3.weight(.semibold))
      Text(caption)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 18))
  }
}

private extension Set<AppSection> {
  var displayText: String {
    let orderedTitles = AppSection.allCases
      .filter { contains($0) }
      .map(\.title)

    return orderedTitles.isEmpty ? "General" : orderedTitles.joined(separator: " • ")
  }
}
