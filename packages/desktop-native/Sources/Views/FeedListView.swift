import SwiftUI

struct FeedListView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    @Bindable var appState = appState
    let videos = appState.displayedVideos

    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text(appState.contentTitle)
            .font(.largeTitle.bold())

          if appState.isSearchActive {
            Text("\(videos.count) results")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(.quaternary.opacity(0.45), in: Capsule())
          }
        }
        Text(appState.contentHeadline)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 18)

      if videos.isEmpty {
        if appState.isSearchActive {
          ContentUnavailableView(
            appState.isLoading ? "Searching Videos" : "No Search Results",
            systemImage: appState.isLoading ? "magnifyingglass.circle" : "magnifyingglass",
            description: Text(
              appState.lastErrorMessage ?? "Try a different title, topic, or channel phrase."
            )
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ScrollView {
            SectionEmptyStateView(section: appState.currentSection)
              .padding(20)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      } else {
        List(videos, selection: $appState.selectedVideoID) { video in
          VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
              VideoRowThumbnail(video: video)

              VStack(alignment: .leading, spacing: 4) {
                Text(video.title)
                  .font(.headline)
                Text(video.channelName)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }

              Spacer()

              Text(video.durationText)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }

            Text(video.summary)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
          .padding(.vertical, 6)
          .tag(video.id)
        }
        .listStyle(.inset)
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

private struct VideoRowThumbnail: View {
  let video: NativeVideo

  var body: some View {
    RoundedRectangle(cornerRadius: 12)
      .fill(Color(hex: video.accentHex).gradient)
      .frame(width: 88, height: 52)
      .overlay {
        if let thumbnailURL = video.thumbnailURL {
          AsyncImage(url: thumbnailURL) { phase in
            switch phase {
            case .success(let image):
              image
                .resizable()
                .scaledToFill()
            default:
              Image(systemName: "play.fill")
                .font(.title3)
                .foregroundStyle(.white)
            }
          }
          .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
          Image(systemName: "play.fill")
            .font(.title3)
            .foregroundStyle(.white)
        }
      }
  }
}
