import SwiftUI

struct FeedListView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  private let gridColumns = [
    GridItem(.adaptive(minimum: 320, maximum: 360), spacing: 28, alignment: .top)
  ]

  var body: some View {
    let videos = appState.displayedVideos

    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        header

        if videos.isEmpty {
          emptyState
        } else if appState.isSearchActive {
          searchResults(videos)
        } else {
          homeGrid(videos)
        }
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 24)
      .frame(maxWidth: 1420, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .center)
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }

  private var header: some View {
    HStack(alignment: .bottom, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text(appState.contentTitle)
          .font(.title2.weight(.bold))
        Text(appState.contentHeadline)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      Spacer()

      HStack(spacing: 10) {
        if appState.currentSection == .home || appState.currentSection == .subscriptions {
          Button("Refresh Feed") {
            Task {
              await hostBridge.refreshPublicFeed(into: appState)
            }
          }
          .buttonStyle(.bordered)
          .disabled(appState.isLoading)
        }

        if appState.currentSection == .studio || appState.currentSection == .library {
          if !appState.hasActiveIdentity {
            Button("Create Channel") {
              Task {
                await hostBridge.createIdentity(into: appState)
              }
            }
            .buttonStyle(.borderedProminent)
            .disabled(appState.isLoading)
          } else {
            Button("Upload Video") {
              Task {
                await hostBridge.uploadVideo(into: appState)
              }
            }
            .buttonStyle(.borderedProminent)
            .disabled(appState.isLoading)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    if appState.isSearchActive {
      ContentUnavailableView(
        appState.isLoading ? "Searching Videos" : "No Search Results",
        systemImage: appState.isLoading ? "magnifyingglass.circle" : "magnifyingglass",
        description: Text(
          appState.lastErrorMessage ?? "Try a different title, topic, or channel phrase."
        )
      )
      .frame(maxWidth: .infinity, minHeight: 420)
    } else {
      SectionEmptyStateView(section: appState.currentSection)
        .padding(.top, 8)
    }
  }

  private func homeGrid(_ videos: [NativeVideo]) -> some View {
    LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 30) {
      ForEach(videos) { video in
        BrowseVideoCard(video: video)
      }
    }
  }

  private func searchResults(_ videos: [NativeVideo]) -> some View {
    LazyVStack(spacing: 18) {
      ForEach(videos) { video in
        SearchVideoRow(video: video)
      }
    }
  }
}

enum NativeThumbnailContext {
  case browseGrid
  case searchRow
  case relatedRail

  var fixedSize: CGSize? {
    switch self {
    case .browseGrid:
      return nil
    case .searchRow:
      return CGSize(width: 300, height: 168)
    case .relatedRail:
      return CGSize(width: 184, height: 104)
    }
  }

  var shellAspectRatio: CGFloat {
    if let fixedSize {
      return fixedSize.width / max(fixedSize.height, 1)
    }

    return 16.0 / 9.0
  }
}

enum NativeThumbnailMediaStyle: Equatable {
  case fillShell
  case fitInsideShell
}

struct NativeThumbnailLayout {
  let context: NativeThumbnailContext
  let fixedSize: CGSize?
  let shellAspectRatio: CGFloat
  let mediaStyle: NativeThumbnailMediaStyle
  let mediaPadding: CGFloat

  init(video: NativeVideo, context: NativeThumbnailContext) {
    self.context = context
    fixedSize = context.fixedSize
    shellAspectRatio = context.shellAspectRatio

    let hasKnownAspectMetadata = (video.width ?? 0) > 0 && (video.height ?? 0) > 0
    guard hasKnownAspectMetadata else {
      mediaStyle = .fitInsideShell
      mediaPadding = 0
      return
    }

    switch video.presentationStyle {
    case .portrait:
      mediaStyle = .fitInsideShell
      mediaPadding = 10
    case .square:
      mediaStyle = .fitInsideShell
      mediaPadding = 8
    case .landscape:
      mediaStyle = .fillShell
      mediaPadding = 0
    }
  }
}

struct NativeVideoThumbnailView: View {
  @Environment(HostBridgeService.self) private var hostBridge

  let video: NativeVideo
  let context: NativeThumbnailContext
  let cornerRadius: CGFloat
  var showsDurationBadge = true

  var body: some View {
    let layout = NativeThumbnailLayout(video: video, context: context)

    framedThumbnail(layout: layout) {
      ZStack(alignment: .bottomTrailing) {
        thumbnailShell(layout: layout)

        if showsDurationBadge {
          Text(video.durationText)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.black.opacity(0.7), in: Capsule())
            .padding(10)
        }
      }
    }
    .task(id: video.id) {
      await hostBridge.ensureThumbnail(for: video)
    }
  }

  private func thumbnailShell(layout: NativeThumbnailLayout) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: cornerRadius)
        .fill(
          LinearGradient(
            colors: [Color.black.opacity(0.96), Color.black.opacity(0.84)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .overlay {
          RoundedRectangle(cornerRadius: cornerRadius)
            .strokeBorder(Color.white.opacity(0.05), lineWidth: 1)
        }

      if let thumbnailURL = hostBridge.thumbnailURL(for: video) {
        AsyncImage(url: thumbnailURL) { phase in
          switch phase {
          case .success(let image):
            styledMedia(image: image, layout: layout)
          default:
            fallbackThumbnail
          }
        }
      } else {
        fallbackThumbnail
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    .contentShape(RoundedRectangle(cornerRadius: cornerRadius))
  }

  @ViewBuilder
  private func styledMedia(image: Image, layout: NativeThumbnailLayout) -> some View {
    switch layout.mediaStyle {
    case .fillShell:
      image
        .resizable()
        .scaledToFill()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .fitInsideShell:
      image
        .resizable()
        .scaledToFit()
        .padding(layout.mediaPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var fallbackThumbnail: some View {
    ZStack {
      LinearGradient(
        colors: [Color.black.opacity(0.15), Color.black.opacity(0.45)],
        startPoint: .top,
        endPoint: .bottom
      )

      Image(systemName: "play.circle.fill")
        .font(.system(size: 40))
        .foregroundStyle(.white.opacity(0.9))
    }
  }

  @ViewBuilder
  private func framedThumbnail<Content: View>(
    layout: NativeThumbnailLayout,
    @ViewBuilder content: () -> Content
  ) -> some View {
    if let fixedSize = layout.fixedSize {
      content()
        .frame(width: fixedSize.width, height: fixedSize.height)
    } else {
      content()
        .frame(maxWidth: .infinity)
        .aspectRatio(layout.shellAspectRatio, contentMode: .fit)
    }
  }
}

private struct BrowseVideoCard: View {
  @Environment(AppState.self) private var appState

  let video: NativeVideo

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        appState.openVideo(video.id)
      } label: {
        videoThumbnail
      }
      .buttonStyle(.plain)

      VStack(alignment: .leading, spacing: 6) {
        Button {
          appState.openVideo(video.id)
        } label: {
          Text(video.title)
            .font(.headline)
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)

        ChannelAttributionButton(video: video)

        Text(video.durationText + (video.tags.isEmpty ? "" : " • \(video.tags.count) tags"))
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var videoThumbnail: some View {
    NativeVideoThumbnailView(
      video: video,
      context: .browseGrid,
      cornerRadius: 18
    )
  }
}

private struct SearchVideoRow: View {
  @Environment(AppState.self) private var appState

  let video: NativeVideo

  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      Button {
        appState.openVideo(video.id)
      } label: {
        searchThumbnail
      }
      .buttonStyle(.plain)

      VStack(alignment: .leading, spacing: 8) {
        Button {
          appState.openVideo(video.id)
        } label: {
          Text(video.title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        .buttonStyle(.plain)

        HStack(spacing: 6) {
          ChannelAttributionButton(video: video)
          Text("• \(video.durationText)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }

        Text(video.summary)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(3)

        if !video.tags.isEmpty {
          HStack(spacing: 8) {
            ForEach(Array(video.tags.prefix(3)), id: \.self) { tag in
              Text(tag.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(0.5), in: Capsule())
            }
          }
        }
      }

      Spacer(minLength: 0)
    }
    .padding(18)
    .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 22))
  }

  private var searchThumbnail: some View {
    NativeVideoThumbnailView(
      video: video,
      context: .searchRow,
      cornerRadius: 16
    )
  }
}

private struct ChannelAttributionButton: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  let video: NativeVideo

  var body: some View {
    Button {
      Task {
        await hostBridge.loadChannelPage(
          channelKey: video.channelKey,
          publicBeeKey: video.publicBeeKey,
          into: appState
        )
      }
    } label: {
      Text(video.channelName)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .buttonStyle(.plain)
  }
}
