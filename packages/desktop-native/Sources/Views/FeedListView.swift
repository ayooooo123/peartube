import SwiftUI

struct FeedListView: View {
  @Environment(AppState.self) private var appState

  var body: some View {
    @Bindable var appState = appState
    let videos = appState.videos()

    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        Text(appState.currentSection.title)
          .font(.largeTitle.bold())
        Text(appState.currentSection.headline)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 18)

      List(videos, selection: $appState.selectedVideoID) { video in
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .center, spacing: 12) {
            RoundedRectangle(cornerRadius: 12)
              .fill(Color(hex: video.accentHex).gradient)
              .frame(width: 72, height: 46)
              .overlay(Image(systemName: "play.fill").font(.title3).foregroundStyle(.white))

            VStack(alignment: .leading, spacing: 4) {
              Text(video.title)
                .font(.headline)
              Text(video.channelName)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }

            Spacer()

            Text(video.duration)
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
    .background(Color(nsColor: .windowBackgroundColor))
  }
}
