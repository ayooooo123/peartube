import SwiftUI

struct SectionEmptyStateView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  let section: AppSection
  var prominence: Prominence = .regular

  enum Prominence: Equatable {
    case regular
    case detail

    var iconSize: CGFloat {
      switch self {
      case .regular: return 40
      case .detail: return 52
      }
    }

    var spacing: CGFloat {
      switch self {
      case .regular: return 18
      case .detail: return 22
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: prominence.spacing) {
      VStack(alignment: .leading, spacing: 12) {
        Image(systemName: section.systemImage)
          .font(.system(size: prominence.iconSize, weight: .semibold))
          .foregroundStyle(.secondary)

        Text(section.emptyTitle)
          .font(prominence == .detail ? .title.bold() : .title2.bold())

        Text(statusDescription)
          .font(.body)
          .foregroundStyle(.secondary)
      }

      actionRows

      if let error = appState.lastErrorMessage {
        Text(error)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(prominence == .detail ? 28 : 24)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.2), in: RoundedRectangle(cornerRadius: 24))
  }

  private var statusDescription: String {
    if let error = appState.lastErrorMessage {
      return error
    }

    switch section {
    case .home:
      if !appState.hasActiveIdentity {
        return "Create a channel or refresh the network feed to start populating PearTube Native."
      }
      if !appState.activeChannelPublished {
        return "Your channel exists locally. Publish it to the public feed or upload your first video."
      }
      if let description = networkEmptyDescription {
        return description
      }
      return "The native shell is ready. Refresh the feed or upload your first video."
    case .subscriptions:
      return "Subscribed channels will appear here after you follow creators from Home or Search."
    case .library:
      return appState.hasActiveIdentity
        ? "Upload a video and your own channel content will appear here."
        : "Create a channel first, then your library will fill with your local content."
    case .studio:
      return appState.hasActiveIdentity
        ? "Use the native Studio flow to upload and publish your channel."
        : "Create a channel to unlock native upload and publishing controls."
    case .diagnostics:
      return "Inspect host logs and connection health while the universal backend host runs."
    }
  }

  private var networkEmptyDescription: String? {
    guard section == .home, let status = hostBridge.networkStatus else {
      return nil
    }

    if status.swarmOffline {
      let reason = status.swarmOfflineReason ?? "the backend reported networking is unavailable"
      return "P2P networking is offline: \(reason)."
    }

    if !status.swarmListenResolved {
      return "Connecting to the DHT. Public feed entries will appear after the backend joins the discovery network."
    }

    if status.peerCount == 0 && status.swarmConnections == 0 {
      return "Connected to the DHT, but no PearTube peers are reachable yet."
    }

    if status.feedConnections == 0 {
      return "Connected to the DHT, but no PearTube feed channels have opened yet."
    }

    if status.feedEntries == 0 {
      return "Connected to the DHT and feed peers, but no public feed entries have arrived yet."
    }

    return nil
  }

  @ViewBuilder
  private var actionRows: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        if shouldShowCreateIdentity {
          Button("Create Channel") {
            Task {
              await hostBridge.createIdentity(into: appState)
            }
          }
          .buttonStyle(.borderedProminent)
          .disabled(appState.isLoading)
        }

        if shouldShowRefreshFeed {
          if shouldShowCreateIdentity {
            Button("Refresh Feed") {
              Task {
                await hostBridge.refreshPublicFeed(into: appState)
              }
            }
            .buttonStyle(.bordered)
            .disabled(appState.isLoading)
          } else {
            Button("Refresh Feed") {
              Task {
                await hostBridge.refreshPublicFeed(into: appState)
              }
            }
            .buttonStyle(.borderedProminent)
            .disabled(appState.isLoading)
          }
        }

        if shouldShowUpload {
          Button("Upload Video") {
            Task {
              await hostBridge.uploadVideo(into: appState)
            }
          }
          .buttonStyle(.bordered)
          .disabled(appState.isLoading)
        }

        if shouldShowPublish {
          Button("Publish Channel") {
            Task {
              await hostBridge.publishActiveChannel(into: appState)
            }
          }
          .buttonStyle(.bordered)
          .disabled(appState.isLoading)
        }
      }

      if section == .subscriptions {
        Button("Browse Home") {
          appState.selectSection(.home)
        }
        .buttonStyle(.link)
      }
    }
  }

  private var shouldShowCreateIdentity: Bool {
    !appState.hasActiveIdentity && section != .diagnostics && section != .subscriptions
  }

  private var shouldShowRefreshFeed: Bool {
    section == .home || section == .subscriptions
  }

  private var shouldShowUpload: Bool {
    appState.hasActiveIdentity && (section == .library || section == .studio || section == .home)
  }

  private var shouldShowPublish: Bool {
    appState.hasActiveIdentity && !appState.activeChannelPublished && (section == .home || section == .studio)
  }
}
