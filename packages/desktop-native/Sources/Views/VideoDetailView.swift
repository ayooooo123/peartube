import AVKit
import Observation
import SwiftUI

struct VideoDetailView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var isStartingPlayback = false
  @State private var commentsViewModel = VideoCommentsViewModel()

  var body: some View {
    GeometryReader { proxy in
      if let video = appState.selectedVideo {
        ScrollView {
          VStack(spacing: 0) {
            VStack(alignment: .center, spacing: 0) {
              playbackSurface(for: video, containerSize: proxy.size)
                .frame(maxWidth: WatchPlaybackLayout.contentMaxWidth, alignment: .center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.top, 24)
            .padding(.bottom, 20)

            watchContent(for: video)
              .frame(maxWidth: WatchPlaybackLayout.contentMaxWidth, alignment: .leading)
              .padding(.horizontal, 32)
              .padding(.bottom, 32)
          }
          .frame(maxWidth: .infinity, alignment: .top)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onChange(of: appState.selectedVideoID) { _, selectedVideoID in
          if appState.isShowingWatchPage,
             selectedVideoID != hostBridge.activePlaybackVideoID {
            hostBridge.clearPlayback()
            appState.clearPlaybackSelection()
          }
        }
      } else {
        ContentUnavailableView(
          "No Video Selected",
          systemImage: "play.rectangle",
          description: Text("Choose a video from the feed to open the watch page.")
        )
      }
    }
  }

  @ViewBuilder
  private func playbackSurface(for video: NativeVideo, containerSize: CGSize) -> some View {
    let playbackSize = WatchPlaybackLayout.preferredSize(for: video, containerSize: containerSize)

    ZStack {
      RoundedRectangle(cornerRadius: 22)
        .fill(.black)
        .overlay {
          if hostBridge.activePlaybackVideoID == video.id,
             hostBridge.activeMpvPlayerID != nil {
            MpvPlayerView(video: video)
              .clipShape(RoundedRectangle(cornerRadius: 22))
          } else if hostBridge.activePlaybackVideoID == video.id,
                    let player = hostBridge.activeAVPlayer {
            NativeAVPlayerView(player: player)
              .clipShape(RoundedRectangle(cornerRadius: 22))
          } else {
            watchPlaceholder(for: video)
          }
        }
    }
    .frame(width: playbackSize.width, height: playbackSize.height)
    .frame(maxWidth: .infinity, alignment: .center)
  }

  @ViewBuilder
  private func watchContent(for video: NativeVideo) -> some View {
    ViewThatFits(in: .horizontal) {
      wideWatchContent(for: video)
      compactWatchContent(for: video)
    }
  }

  private func wideWatchContent(for video: NativeVideo) -> some View {
    HStack(alignment: .top, spacing: 28) {
      VStack(alignment: .leading, spacing: 20) {
        watchHeader(for: video)
        playbackStatusSection(for: video)
        commentsSection(for: video)
        descriptionCard(for: video)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if !appState.relatedVideos().isEmpty {
        upNextRail
          .frame(width: 360, alignment: .topLeading)
      }
    }
  }

  private func compactWatchContent(for video: NativeVideo) -> some View {
    VStack(alignment: .leading, spacing: 20) {
      watchHeader(for: video)
      playbackStatusSection(for: video)
      commentsSection(for: video)
      descriptionCard(for: video)

      if !appState.relatedVideos().isEmpty {
        upNextRail
      }
    }
  }

  private func watchHeader(for video: NativeVideo) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(video.title)
        .font(.system(size: 34, weight: .bold))
        .multilineTextAlignment(.leading)

      HStack(alignment: .center, spacing: 16) {
        VStack(alignment: .leading, spacing: 5) {
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
              .font(.title3.weight(.semibold))
          }
          .buttonStyle(.plain)
          Text(videoMetaLine(for: video))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }

        Spacer(minLength: 16)

        actionBar(for: video)
      }
    }
  }

  @ViewBuilder
  private func playbackStatusSection(for video: NativeVideo) -> some View {
    if hostBridge.activePlaybackVideoID == video.id,
       let stats = hostBridge.playbackStats {
      PlaybackStatusCard(
        stats: stats,
        errorMessage: hostBridge.lastPlaybackErrorMessage
      )
    } else if hostBridge.activePlaybackVideoID == video.id,
              let errorMessage = hostBridge.lastPlaybackErrorMessage {
      Text(errorMessage)
        .font(.footnote)
        .foregroundStyle(.orange)
    }
  }

  private var upNextRail: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Up next")
        .font(.title3.weight(.semibold))

      VStack(spacing: 12) {
        ForEach(appState.relatedVideos()) { relatedVideo in
          WatchRelatedVideoRow(video: relatedVideo)
        }
      }
    }
    .padding(20)
    .background(.quaternary.opacity(0.14), in: RoundedRectangle(cornerRadius: 22))
  }

  @ViewBuilder
  private func watchPlaceholder(for video: NativeVideo) -> some View {
    Button {
      handlePlaybackIntent(for: video, source: "hero")
    } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 22)
          .fill(Color(hex: video.accentHex).gradient)
          .overlay {
            if let thumbnailURL = hostBridge.thumbnailURL(for: video) {
              AsyncImage(url: thumbnailURL) { phase in
                switch phase {
                case .success(let image):
                  if WatchPlaybackLayout.usesContainedPoster(for: video) {
                    image
                      .resizable()
                      .scaledToFit()
                  } else {
                    image
                      .resizable()
                      .scaledToFill()
                  }
                default:
                  placeholderOverlay
                }
              }
              .clipShape(RoundedRectangle(cornerRadius: 22))
            } else {
              placeholderOverlay
            }
          }

        LinearGradient(
          colors: [.clear, .black.opacity(0.52)],
          startPoint: .center,
          endPoint: .bottom
        )
        .clipShape(RoundedRectangle(cornerRadius: 22))

        Image(systemName: hostBridge.isResolvingPlayback ? "dot.radiowaves.left.and.right" : "play.circle.fill")
          .font(.system(size: 70))
          .foregroundStyle(.white.opacity(0.95))
      }
      .contentShape(RoundedRectangle(cornerRadius: 22))
    }
    .buttonStyle(.plain)
    .disabled(playbackInteractionDisabled)
    .task(id: video.id) {
      await hostBridge.ensureThumbnail(for: video)
    }
  }

  private var placeholderOverlay: some View {
    LinearGradient(
      colors: [Color.black.opacity(0.12), Color.black.opacity(0.42)],
      startPoint: .top,
      endPoint: .bottom
    )
  }

  private func actionBar(for video: NativeVideo) -> some View {
    let isPlaybackActive = isPlaybackActive(for: video)

    return HStack(spacing: 10) {
      Button(isPlaybackActive ? "Pause" : "Play") {
        handlePlaybackIntent(for: video, source: "button")
      }
      .buttonStyle(.borderedProminent)
      .disabled(playbackInteractionDisabled && !isPlaybackActive)

      if appState.ownsChannel(video.channelKey) {
        if !appState.activeChannelPublished {
          Button("Publish") {
            Task {
              await hostBridge.publishActiveChannel(into: appState)
            }
          }
          .buttonStyle(.bordered)
        }

        Button("Upload") {
          Task {
            await hostBridge.uploadVideo(into: appState)
          }
        }
        .buttonStyle(.bordered)
      } else {
        if appState.isSubscribed(to: video.channelKey) {
          Button("Subscribed") {
            Task {
              await hostBridge.toggleSubscription(for: video, into: appState)
            }
          }
          .buttonStyle(.bordered)
        } else {
          Button("Subscribe") {
            Task {
              await hostBridge.toggleSubscription(for: video, into: appState)
            }
          }
          .buttonStyle(.borderedProminent)
        }
      }
    }
  }

  private func descriptionCard(for video: NativeVideo) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Text(video.durationText)
        Text(video.sections.displayText)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)

      Text(video.summary.isEmpty ? "No description has been published for this video yet." : video.summary)
        .font(.body)
        .foregroundStyle(.primary)

      if !video.tags.isEmpty {
        FlowTags(tags: video.tags)
      }
    }
    .padding(18)
    .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 20))
  }

  private func commentsSection(for video: NativeVideo) -> some View {
    VideoCommentsSection(
      viewModel: commentsViewModel,
      video: video,
      identityChannelKey: appState.activeIdentityChannelKey,
      canModerate: appState.ownsChannel(video.channelKey)
    )
  }

  private func hasConcretePlaybackSession(for video: NativeVideo) -> Bool {
    hostBridge.activePlaybackVideoID == video.id
      && (hostBridge.activeMpvPlayerID != nil || hostBridge.activeAVPlayer != nil)
  }

  private var playbackInteractionDisabled: Bool {
    hostBridge.isResolvingPlayback || isStartingPlayback
  }

  private func isPlaybackActive(for video: NativeVideo) -> Bool {
    appState.isPlayingPreview && hasConcretePlaybackSession(for: video)
  }

  private func handlePlaybackIntent(for video: NativeVideo, source: String) {
    if playbackInteractionDisabled {
      hostBridge.recordPlaybackUIEvent("Ignoring \(source) playback tap for \(video.id) while a playback transition is already in flight.")
      return
    }

    let active = isPlaybackActive(for: video)
    hostBridge.recordPlaybackUIEvent(
      "Playback \(source) tapped for \(video.id) active=\(active) hostVideo=\(hostBridge.activePlaybackVideoID ?? "nil") mpvPlayer=\(hostBridge.activeMpvPlayerID ?? "nil") localPlayer=\(hostBridge.activeAVPlayer == nil ? "nil" : "ready")"
    )

    if active {
      if hostBridge.activePlaybackVideoID == video.id,
         hostBridge.activeMpvPlayerID != nil {
        hostBridge.recordPlaybackUIEvent("Pausing active bare-mpv session for \(video.id).")
        Task {
          await hostBridge.pauseActivePlayback()
        }
      } else {
        hostBridge.recordPlaybackUIEvent("Pausing active AVPlayer session for \(video.id).")
        hostBridge.pauseActiveAVPlayer()
      }
      appState.pausePreview()
      return
    }

    Task { @MainActor in
      isStartingPlayback = true
      defer { isStartingPlayback = false }

      if let activePlaybackVideoID = hostBridge.activePlaybackVideoID,
         activePlaybackVideoID != video.id {
        hostBridge.recordPlaybackUIEvent("Clearing playback for \(activePlaybackVideoID) before starting \(video.id).")
        hostBridge.clearPlayback()
        appState.clearPlaybackSelection()
      }

      if hostBridge.activePlaybackVideoID == video.id,
         hostBridge.activeMpvPlayerID != nil {
        hostBridge.recordPlaybackUIEvent("Resuming existing bare-mpv session for \(video.id).")
        await hostBridge.resumeActivePlayback()
        appState.resumePlayback()
        appState.setError(nil)
        return
      }

      if hostBridge.activePlaybackVideoID == video.id,
         hostBridge.activeAVPlayer != nil {
        hostBridge.recordPlaybackUIEvent("Resuming existing AVPlayer session for \(video.id).")
        hostBridge.resumeActiveAVPlayer()
        appState.resumePlayback()
        appState.setError(nil)
        return
      }

      hostBridge.recordPlaybackUIEvent("Starting new playback session for \(video.id).")
      if !HostBridgeService.shouldUseNativeMpvPlayback(for: video) {
        hostBridge.recordPlaybackUIEvent("Using direct AVPlayer startup path for \(video.id).")
        if let url = await hostBridge.prepareAVPlayerURL(for: video) {
          hostBridge.recordPlaybackUIEvent("Playback session resolved to AVPlayer for \(video.id).")
          hostBridge.recordPlaybackUIEvent("Creating AVPlayer instance for \(video.id).")
          let avPlayer = AVPlayer(url: url)
          avPlayer.automaticallyWaitsToMinimizeStalling = true
          hostBridge.recordPlaybackUIEvent("AVPlayer instance created for \(video.id).")
          hostBridge.recordPlaybackUIEvent("Assigning AVPlayer state for \(video.id).")
          hostBridge.installAVPlayer(avPlayer, for: video)
          hostBridge.recordPlaybackUIEvent("Calling AVPlayer.play() for \(video.id).")
          avPlayer.play()
          hostBridge.recordPlaybackUIEvent("AVPlayer.play() returned for \(video.id).")
          appState.playSelectedPreview()
          appState.setError(nil)
        } else {
          hostBridge.recordPlaybackUIEvent("Playback session failed to start for \(video.id): \(hostBridge.lastPlaybackErrorMessage ?? "unknown").")
          appState.setError(
            hostBridge.lastPlaybackErrorMessage
              ?? "Playback URL could not be resolved for \(video.title)."
          )
        }
        return
      }

      if let session = await hostBridge.startPlaybackSession(
        for: video,
        renderSize: CGSize(width: 1280, height: 720)
      ) {
        switch session.mode {
        case .mpv:
          hostBridge.recordPlaybackUIEvent("Playback session resolved to bare-mpv for \(video.id).")
          hostBridge.releaseAVPlayer()
        case .avPlayer:
          hostBridge.recordPlaybackUIEvent("Playback session resolved to AVPlayer for \(video.id).")
          hostBridge.recordPlaybackUIEvent("Creating AVPlayer instance for \(video.id).")
          let avPlayer = AVPlayer(url: session.url)
          avPlayer.automaticallyWaitsToMinimizeStalling = true
          hostBridge.recordPlaybackUIEvent("AVPlayer instance created for \(video.id).")
          hostBridge.recordPlaybackUIEvent("Assigning AVPlayer state for \(video.id).")
          hostBridge.installAVPlayer(avPlayer, for: video)
          hostBridge.recordPlaybackUIEvent("Calling AVPlayer.play() for \(video.id).")
          avPlayer.play()
          hostBridge.recordPlaybackUIEvent("AVPlayer.play() returned for \(video.id).")
        }

        appState.playSelectedPreview()
        appState.setError(nil)
      } else {
        hostBridge.recordPlaybackUIEvent("Playback session failed to start for \(video.id): \(hostBridge.lastPlaybackErrorMessage ?? "unknown").")
        appState.setError(
          hostBridge.lastPlaybackErrorMessage
            ?? "Playback URL could not be resolved for \(video.title)."
        )
      }
    }
  }

  private func videoMetaLine(for video: NativeVideo) -> String {
    var components = [video.durationText]
    if !video.tags.isEmpty {
      components.append("\(video.tags.count) tags")
    }
    if let heartbeat = hostBridge.lastHeartbeat {
      components.append("Updated \(heartbeat.formatted(date: .omitted, time: .shortened))")
    }
    return components.joined(separator: " • ")
  }
}

struct WatchPlaybackLayout {
  static let contentMaxWidth: CGFloat = 1320

  private static let horizontalPadding: CGFloat = 64
  private static let detailsReserveHeight: CGFloat = 220
  private static let portraitMaxWidth: CGFloat = 460
  private static let portraitMinHeight: CGFloat = 580
  private static let portraitMaxHeight: CGFloat = 680
  private static let squareMinSide: CGFloat = 460
  private static let squareMaxSide: CGFloat = 640
  private static let landscapeMaxHeight: CGFloat = 620

  static func preferredSize(for video: NativeVideo, containerSize: CGSize) -> CGSize {
    let availableWidth = max(280, containerSize.width - horizontalPadding)
    let availableHeight = max(240, containerSize.height - detailsReserveHeight)
    let aspectRatio = max(CGFloat(video.heroAspectRatio), 0.01)

    switch video.presentationStyle {
    case .portrait:
      let maxWidth = min(availableWidth, portraitMaxWidth)
      let maxHeight = min(
        availableHeight,
        min(max(availableHeight * 0.92, portraitMinHeight), portraitMaxHeight)
      )
      return fittedSize(aspectRatio: aspectRatio, maxWidth: maxWidth, maxHeight: maxHeight)
    case .square:
      let maxSideByHeight = min(
        availableHeight,
        min(max(availableHeight * 0.9, squareMinSide), squareMaxSide)
      )
      let side = min(min(availableWidth, squareMaxSide), maxSideByHeight)
      return CGSize(width: side, height: side)
    case .landscape:
      return fittedSize(
        aspectRatio: aspectRatio,
        maxWidth: min(availableWidth, contentMaxWidth),
        maxHeight: min(availableHeight, landscapeMaxHeight)
      )
    }
  }

  static func usesContainedPoster(for video: NativeVideo) -> Bool {
    video.presentationStyle != .landscape || video.intrinsicAspectRatio == nil
  }

  private static func fittedSize(aspectRatio: CGFloat, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
    guard aspectRatio > 0 else {
      return CGSize(width: min(maxWidth, 640), height: min(maxHeight, 360))
    }

    let widthFromHeight = maxHeight * aspectRatio

    if widthFromHeight <= maxWidth {
      return CGSize(width: widthFromHeight, height: maxHeight)
    }

    return CGSize(width: maxWidth, height: maxWidth / aspectRatio)
  }
}

struct NativeAVPlayerView: NSViewRepresentable {
  let player: AVPlayer

  func makeNSView(context: Context) -> AVPlayerView {
    let view = AVPlayerView()
    view.controlsStyle = .floating
    view.showsFullScreenToggleButton = true
    view.videoGravity = .resizeAspect
    view.player = player
    return view
  }

  func updateNSView(_ nsView: AVPlayerView, context: Context) {
    if nsView.player !== player {
      nsView.player = player
    }
  }
}

private struct WatchRelatedVideoRow: View {
  @Environment(AppState.self) private var appState

  let video: NativeVideo

  var body: some View {
    Button {
      appState.openVideo(video.id)
    } label: {
      HStack(alignment: .top, spacing: 12) {
        relatedThumbnail

        VStack(alignment: .leading, spacing: 5) {
          Text(video.title)
            .font(.headline)
            .foregroundStyle(.primary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)

          Text(video.channelName)
            .font(.caption)
            .foregroundStyle(.secondary)

          Text(video.durationText)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Spacer()
      }
      .padding(10)
      .background(.quaternary.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
    }
    .buttonStyle(.plain)
  }

  private var relatedThumbnail: some View {
    NativeVideoThumbnailView(
      video: video,
      context: .relatedRail,
      cornerRadius: 14,
      showsDurationBadge: false
    )
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

private struct PlaybackStatusCard: View {
  let stats: NativeBridgeVideoStatsResponse
  let errorMessage: String?

  private var statusLabel: String {
    if stats.isComplete { return "Cached" }

    switch stats.status {
    case "downloading":
      return "Downloading"
    case "connecting":
      return "Connecting"
    case let status? where !status.isEmpty:
      return status.capitalized
    default:
      return "Connecting"
    }
  }

  private var statusColor: Color {
    if stats.isComplete { return .green }
    if stats.status == "downloading" { return .yellow }
    if errorMessage != nil || (stats.error?.isEmpty == false) { return .orange }
    return .secondary
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Circle()
          .fill(statusColor)
          .frame(width: 8, height: 8)
        Text(statusLabel)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(statusColor)
        Spacer()
        Text("\(stats.peerCount) peers")
          .font(.caption)
          .foregroundStyle(.secondary)
        Text("↓ \(stats.speedMBps) MB/s")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      HStack {
        Text("\(stats.downloadedBlocks) / \(stats.totalBlocks) blocks")
        Spacer()
        Text("\(stats.progress)%")
      }
      .font(.caption)
      .foregroundStyle(.secondary)

      ProgressView(
        value: stats.totalBlocks > 0 ? Double(stats.downloadedBlocks) : 0,
        total: stats.totalBlocks > 0 ? Double(stats.totalBlocks) : 1
      )
      .tint(statusColor)

      if let errorMessage, !errorMessage.isEmpty {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
    .padding(16)
    .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
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

@MainActor
protocol VideoCommentsBridge: AnyObject {
  func listComments(
    for video: NativeVideo,
    page: Int,
    limit: Int
  ) async throws -> NativeBridgeListCommentsResponse

  func addComment(
    text: String,
    to video: NativeVideo,
    parentId: String?,
    authorChannelKey: String?
  ) async throws -> NativeBridgeAddCommentResponse

  func hideComment(
    _ comment: NativeBridgeComment,
    on video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeHideCommentResponse

  func removeComment(
    _ comment: NativeBridgeComment,
    on video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeRemoveCommentResponse

  func addReaction(
    _ reactionType: String,
    to video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeReactionMutationResponse

  func removeReaction(
    from video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeReactionMutationResponse

  func getReactions(
    for video: NativeVideo,
    authorChannelKey: String?
  ) async throws -> NativeBridgeGetReactionsResponse
}

extension HostBridgeService: VideoCommentsBridge {}

enum VideoCommentPendingState: String, Equatable {
  case sending
  case queued
  case pending
  case failed
}

struct VideoCommentItem: Identifiable, Equatable {
  let commentId: String
  var localId: String?
  let text: String
  let authorKeyHex: String
  let timestamp: Int
  let parentId: String?
  let isAdmin: Bool
  var pendingState: VideoCommentPendingState?
  var replies: [VideoCommentItem] = []

  var id: String {
    localId ?? commentId
  }

  var mergeKey: String {
    commentId
  }

  var authorLabel: String {
    let prefix = String(authorKeyHex.prefix(12))
    return authorKeyHex.count > 12 ? "\(prefix)…" : prefix
  }

  var pendingBadgeText: String? {
    switch pendingState {
    case .sending, .queued, .pending:
      return "Pending"
    case .failed:
      return "Failed"
    case .none:
      return nil
    }
  }

  var relativeTimestampText: String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return formatter.localizedString(for: timestampDate, relativeTo: Date())
  }

  var timestampDate: Date {
    if timestamp > 1_000_000_000_000 {
      return Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000.0)
    }

    if timestamp > 1_000_000_000 {
      return Date(timeIntervalSince1970: TimeInterval(timestamp))
    }

    return Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000.0)
  }

  init(
    commentId: String,
    localId: String? = nil,
    text: String,
    authorKeyHex: String,
    timestamp: Int,
    parentId: String?,
    isAdmin: Bool,
    pendingState: VideoCommentPendingState? = nil,
    replies: [VideoCommentItem] = []
  ) {
    self.commentId = commentId
    self.localId = localId
    self.text = text
    self.authorKeyHex = authorKeyHex
    self.timestamp = timestamp
    self.parentId = parentId
    self.isAdmin = isAdmin
    self.pendingState = pendingState
    self.replies = replies
  }

  init(bridgeComment: NativeBridgeComment) {
    self.init(
      commentId: bridgeComment.commentId,
      text: bridgeComment.text,
      authorKeyHex: bridgeComment.authorKeyHex,
      timestamp: bridgeComment.timestamp,
      parentId: bridgeComment.parentId,
      isAdmin: bridgeComment.isAdmin
    )
  }
}

@MainActor
@Observable
final class VideoCommentsViewModel {
  var commentText = ""
  var replyToComment: VideoCommentItem?
  var commentsLoading = false
  var postingComment = false
  var commentsPage = 0
  var hasMoreComments = false
  var loadingMoreComments = false
  var refreshingComments = false
  var deletingCommentID: String?
  var reactionCounts: [String: Int] = [:]
  var userReaction: String?

  private(set) var comments: [VideoCommentItem] = []
  private(set) var pendingComments: [VideoCommentItem] = []

  @ObservationIgnored private var service: (any VideoCommentsBridge)?
  @ObservationIgnored private var currentVideo: NativeVideo?
  @ObservationIgnored private var currentVideoKey: String?
  @ObservationIgnored private var identityChannelKey: String?
  @ObservationIgnored private var canModerateComments = false
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private let pollInterval: Duration?
  @ObservationIgnored private let now: () -> Int
  @ObservationIgnored private let idProvider: () -> String

  private let commentsPerPage = 50

  init(
    pollInterval: Duration? = .seconds(5),
    now: @escaping () -> Int = {
      Int(Date().timeIntervalSince1970 * 1000)
    },
    idProvider: @escaping () -> String = {
      UUID().uuidString
    }
  ) {
    self.pollInterval = pollInterval
    self.now = now
    self.idProvider = idProvider
  }

  deinit {
    pollTask?.cancel()
  }

  var displayComments: [VideoCommentItem] {
    if pendingComments.isEmpty {
      return comments.sorted { $0.timestamp > $1.timestamp }
    }

    var merged = [String: VideoCommentItem]()
    for comment in comments {
      merged[comment.mergeKey] = comment
    }
    for pending in pendingComments where merged[pending.mergeKey] == nil {
      merged[pending.mergeKey] = pending
    }

    return merged.values.sorted { $0.timestamp > $1.timestamp }
  }

  var organizedComments: [VideoCommentItem] {
    let sortedComments = displayComments
    let repliesByParent = Dictionary(grouping: sortedComments.filter { $0.parentId != nil }) { $0.parentId ?? "" }

    return sortedComments
      .filter { $0.parentId == nil }
      .map { comment in
        var threaded = comment
        threaded.replies = (repliesByParent[comment.commentId] ?? []).sorted { $0.timestamp > $1.timestamp }
        return threaded
      }
  }

  var displayCommentsCount: Int {
    displayComments.count
  }

  var commentsTitle: String {
    displayCommentsCount == 1 ? "1 Comment" : "\(displayCommentsCount) Comments"
  }

  var canPost: Bool {
    !postingComment && !commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  func bind(
    video: NativeVideo,
    identityChannelKey: String?,
    canModerate: Bool,
    service: any VideoCommentsBridge
  ) async {
    self.service = service
    self.currentVideo = video
    self.identityChannelKey = identityChannelKey
    self.canModerateComments = canModerate

    let videoKey = "\(video.channelKey):\(video.backendVideoID)"
    if currentVideoKey != videoKey {
      currentVideoKey = videoKey
      resetState()
      await loadSocial(page: 0, append: false, displayLoading: true, markRefreshing: false)
    }

    startPollingIfNeeded()
  }

  func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
  }

  func refreshComments() async {
    await loadSocial(page: 0, append: false, displayLoading: displayComments.isEmpty, markRefreshing: true)
  }

  func loadMoreComments() async {
    guard !loadingMoreComments, hasMoreComments else { return }
    await loadSocial(page: commentsPage + 1, append: true, displayLoading: false, markRefreshing: false)
  }

  func postComment() async {
    guard let service, let currentVideo else { return }

    let trimmedText = commentText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else { return }

    let localID = idProvider()
    let pendingComment = VideoCommentItem(
      commentId: localID,
      localId: localID,
      text: trimmedText,
      authorKeyHex: identityChannelKey ?? "local",
      timestamp: now(),
      parentId: replyToComment?.commentId,
      isAdmin: false,
      pendingState: .sending
    )

    pendingComments.insert(pendingComment, at: 0)
    commentText = ""
    replyToComment = nil
    postingComment = true

    defer {
      postingComment = false
    }

    do {
      let response = try await service.addComment(
        text: trimmedText,
        to: currentVideo,
        parentId: pendingComment.parentId,
        authorChannelKey: identityChannelKey
      )

      guard response.success else {
        updatePendingComment(localID: localID, state: .failed, commentID: nil)
        return
      }

      updatePendingComment(
        localID: localID,
        state: response.queued ? .queued : .pending,
        commentID: response.commentId
      )
      await loadSocial(page: 0, append: false, displayLoading: false, markRefreshing: false)
    } catch {
      updatePendingComment(localID: localID, state: .failed, commentID: nil)
    }
  }

  func deleteComment(_ comment: VideoCommentItem) async {
    if pendingComments.contains(where: { $0.id == comment.id || $0.commentId == comment.commentId }) {
      pendingComments.removeAll { $0.id == comment.id || $0.commentId == comment.commentId }
      if replyToComment?.id == comment.id {
        replyToComment = nil
      }
      return
    }

    guard let service, let currentVideo else { return }

    deletingCommentID = comment.id
    defer {
      deletingCommentID = nil
    }

    do {
      let response = try await service.removeComment(
        bridgeComment(for: comment, in: currentVideo),
        on: currentVideo,
        authorChannelKey: identityChannelKey
      )

      guard response.success else { return }
      comments.removeAll { $0.commentId == comment.commentId }
      if replyToComment?.commentId == comment.commentId {
        replyToComment = nil
      }
    } catch {
      return
    }
  }

  func hideComment(_ comment: VideoCommentItem) async {
    guard canHide(comment), let service, let currentVideo else { return }

    deletingCommentID = comment.id
    defer {
      deletingCommentID = nil
    }

    do {
      let response = try await service.hideComment(
        bridgeComment(for: comment, in: currentVideo),
        on: currentVideo,
        authorChannelKey: identityChannelKey
      )

      guard response.success else { return }
      comments.removeAll { $0.commentId == comment.commentId }
      if replyToComment?.commentId == comment.commentId {
        replyToComment = nil
      }
    } catch {
      return
    }
  }

  func toggleReaction(_ reactionType: String) async {
    guard let service, let currentVideo else { return }

    do {
      if userReaction == reactionType {
        _ = try await service.removeReaction(from: currentVideo, authorChannelKey: identityChannelKey)
      } else {
        _ = try await service.removeReaction(from: currentVideo, authorChannelKey: identityChannelKey)
        _ = try await service.addReaction(reactionType, to: currentVideo, authorChannelKey: identityChannelKey)
      }

      await loadSocial(page: 0, append: false, displayLoading: false, markRefreshing: false)
    } catch {
      return
    }
  }

  func isOwnComment(_ comment: VideoCommentItem) -> Bool {
    guard let identityChannelKey, !identityChannelKey.isEmpty else { return false }
    return comment.authorKeyHex == identityChannelKey
  }

  func canDelete(_ comment: VideoCommentItem) -> Bool {
    isOwnComment(comment) || comment.pendingState != nil
  }

  func canHide(_ comment: VideoCommentItem) -> Bool {
    canModerateComments && !isOwnComment(comment) && comment.pendingState == nil
  }

  private func resetState() {
    stopPolling()
    comments = []
    pendingComments = []
    commentText = ""
    replyToComment = nil
    commentsLoading = false
    postingComment = false
    commentsPage = 0
    hasMoreComments = false
    loadingMoreComments = false
    refreshingComments = false
    deletingCommentID = nil
    reactionCounts = [:]
    userReaction = nil
  }

  private func startPollingIfNeeded() {
    guard pollTask == nil, let interval = pollInterval else { return }

    pollTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        do {
          try await Task.sleep(for: interval)
        } catch {
          return
        }

        guard !Task.isCancelled else { return }
        await self.loadSocial(page: 0, append: false, displayLoading: false, markRefreshing: false)
      }
    }
  }

  private func loadSocial(
    page: Int,
    append: Bool,
    displayLoading: Bool,
    markRefreshing: Bool
  ) async {
    guard let service, let currentVideo else { return }

    if append {
      loadingMoreComments = true
    } else if displayLoading {
      commentsLoading = true
    }

    if markRefreshing {
      refreshingComments = true
    }

    defer {
      loadingMoreComments = false
      if !append {
        commentsLoading = false
      }
      if markRefreshing {
        refreshingComments = false
      }
    }

    do {
      let commentsResponse = try await service.listComments(
        for: currentVideo,
        page: page,
        limit: commentsPerPage
      )
      let reactionsResponse = append
        ? nil
        : try await service.getReactions(for: currentVideo, authorChannelKey: identityChannelKey)

      let fetchedComments = commentsResponse.success
        ? commentsResponse.comments.map(VideoCommentItem.init(bridgeComment:))
        : []

      if append {
        comments = mergeExistingComments(with: fetchedComments)
      } else {
        comments = fetchedComments
      }

      commentsPage = page
      hasMoreComments = fetchedComments.count >= commentsPerPage
      removeResolvedPendingComments(knownIDs: Set(fetchedComments.map(\.commentId)))
      clearInvalidReplyTarget()

      if let reactionsResponse {
        if reactionsResponse.success {
          reactionCounts = Dictionary(
            uniqueKeysWithValues: reactionsResponse.counts.map { ($0.reactionType, $0.count) }
          )
          userReaction = reactionsResponse.userReaction
        } else {
          reactionCounts = [:]
          userReaction = nil
        }
      }
    } catch {
      if !append {
        comments = []
        hasMoreComments = false
        reactionCounts = [:]
        userReaction = nil
      }
    }
  }

  private func updatePendingComment(localID: String, state: VideoCommentPendingState, commentID: String?) {
    pendingComments = pendingComments.map { comment in
      guard comment.localId == localID else { return comment }

      return VideoCommentItem(
        commentId: commentID ?? comment.commentId,
        localId: comment.localId,
        text: comment.text,
        authorKeyHex: comment.authorKeyHex,
        timestamp: comment.timestamp,
        parentId: comment.parentId,
        isAdmin: comment.isAdmin,
        pendingState: state
      )
    }
  }

  private func mergeExistingComments(with additional: [VideoCommentItem]) -> [VideoCommentItem] {
    var merged = Dictionary(uniqueKeysWithValues: comments.map { ($0.commentId, $0) })
    for comment in additional {
      merged[comment.commentId] = comment
    }
    return merged.values.sorted { $0.timestamp > $1.timestamp }
  }

  private func removeResolvedPendingComments(knownIDs: Set<String>) {
    guard !knownIDs.isEmpty else { return }
    pendingComments.removeAll { knownIDs.contains($0.commentId) }
  }

  private func clearInvalidReplyTarget() {
    guard let replyToComment else { return }

    let knownIDs = Set(displayComments.map(\.commentId))
    if !knownIDs.contains(replyToComment.commentId) {
      self.replyToComment = nil
    }
  }

  private func bridgeComment(for comment: VideoCommentItem, in video: NativeVideo) -> NativeBridgeComment {
    NativeBridgeComment(
      videoId: video.backendVideoID,
      commentId: comment.commentId,
      text: comment.text,
      authorKeyHex: comment.authorKeyHex,
      timestamp: comment.timestamp,
      parentId: comment.parentId,
      isAdmin: comment.isAdmin
    )
  }
}

private struct VideoCommentsSection: View {
  @Environment(HostBridgeService.self) private var hostBridge
  @Bindable var viewModel: VideoCommentsViewModel

  let video: NativeVideo
  let identityChannelKey: String?
  let canModerate: Bool

  private var bindKey: String {
    "\(video.id):\(identityChannelKey ?? "none"):\(canModerate)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      header
      reactions
      composer
      commentsBody
    }
    .padding(20)
    .background(.quaternary.opacity(0.16), in: RoundedRectangle(cornerRadius: 22))
    .task(id: bindKey) {
      await viewModel.bind(
        video: video,
        identityChannelKey: identityChannelKey,
        canModerate: canModerate,
        service: hostBridge
      )
    }
    .onDisappear {
      viewModel.stopPolling()
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      Text(viewModel.commentsTitle)
        .font(.title3.weight(.semibold))

      Spacer()

      Button {
        Task {
          await viewModel.refreshComments()
        }
      } label: {
        Label("Refresh", systemImage: viewModel.refreshingComments ? "arrow.triangle.2.circlepath.circle.fill" : "arrow.clockwise")
          .labelStyle(.titleAndIcon)
      }
      .buttonStyle(.bordered)
      .disabled(viewModel.refreshingComments)
    }
  }

  private var reactions: some View {
    HStack(spacing: 10) {
      VideoReactionButton(
        title: "Like",
        systemImage: "hand.thumbsup",
        count: viewModel.reactionCounts["like"] ?? 0,
        isActive: viewModel.userReaction == "like"
      ) {
        Task {
          await viewModel.toggleReaction("like")
        }
      }

      VideoReactionButton(
        title: "Dislike",
        systemImage: "hand.thumbsdown",
        count: viewModel.reactionCounts["dislike"] ?? 0,
        isActive: viewModel.userReaction == "dislike"
      ) {
        Task {
          await viewModel.toggleReaction("dislike")
        }
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let replyTarget = viewModel.replyToComment {
        HStack(spacing: 10) {
          Text("Replying to \(replyTarget.authorLabel)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)

          Button {
            viewModel.replyToComment = nil
            viewModel.commentText = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
        }
      }

      HStack(alignment: .bottom, spacing: 12) {
        TextField(
          viewModel.replyToComment == nil ? "Add a comment…" : "Write a reply…",
          text: $viewModel.commentText,
          axis: .vertical
        )
        .textFieldStyle(.roundedBorder)
        .lineLimit(1...4)

        Button(viewModel.postingComment ? "Posting…" : "Post") {
          Task {
            await viewModel.postComment()
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!viewModel.canPost)
      }
    }
  }

  @ViewBuilder
  private var commentsBody: some View {
    if viewModel.commentsLoading && viewModel.displayCommentsCount == 0 {
      HStack {
        Spacer()
        ProgressView()
        Spacer()
      }
      .padding(.vertical, 18)
    } else if viewModel.displayCommentsCount == 0 {
      Text("No comments yet. Be the first to comment.")
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(.vertical, 8)
    } else {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(viewModel.organizedComments) { comment in
          VideoCommentRow(
            comment: comment,
            isReply: false,
            isOwnComment: viewModel.isOwnComment(comment),
            canDelete: viewModel.canDelete(comment),
            canHide: viewModel.canHide(comment),
            isMutating: viewModel.deletingCommentID == comment.id,
            onReply: {
              viewModel.replyToComment = comment
            },
            onDelete: {
              Task {
                await viewModel.deleteComment(comment)
              }
            },
            onHide: {
              Task {
                await viewModel.hideComment(comment)
              }
            }
          )

          if !comment.replies.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(comment.replies) { reply in
                VideoCommentRow(
                  comment: reply,
                  isReply: true,
                  isOwnComment: viewModel.isOwnComment(reply),
                  canDelete: viewModel.canDelete(reply),
                  canHide: viewModel.canHide(reply),
                  isMutating: viewModel.deletingCommentID == reply.id,
                  onReply: {
                    viewModel.replyToComment = reply
                  },
                  onDelete: {
                    Task {
                      await viewModel.deleteComment(reply)
                    }
                  },
                  onHide: {
                    Task {
                      await viewModel.hideComment(reply)
                    }
                  }
                )
              }
            }
            .padding(.leading, 28)
          }
        }

        if viewModel.hasMoreComments {
          Button {
            Task {
              await viewModel.loadMoreComments()
            }
          } label: {
            HStack(spacing: 8) {
              if viewModel.loadingMoreComments {
                ProgressView()
                  .controlSize(.small)
              }
              Text(viewModel.loadingMoreComments ? "Loading…" : "Load more comments")
            }
          }
          .buttonStyle(.bordered)
          .disabled(viewModel.loadingMoreComments)
        }
      }
    }
  }
}

private struct VideoReactionButton: View {
  let title: String
  let systemImage: String
  let count: Int
  let isActive: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label {
        Text(count > 0 ? "\(title) (\(count))" : title)
      } icon: {
        Image(systemName: systemImage)
      }
      .font(.subheadline.weight(.semibold))
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        isActive
          ? AnyShapeStyle(Color.accentColor.opacity(0.18))
          : AnyShapeStyle(Color.primary.opacity(0.06)),
        in: Capsule()
      )
    }
    .buttonStyle(.plain)
  }
}

private struct VideoCommentRow: View {
  let comment: VideoCommentItem
  let isReply: Bool
  let isOwnComment: Bool
  let canDelete: Bool
  let canHide: Bool
  let isMutating: Bool
  let onReply: () -> Void
  let onDelete: () -> Void
  let onHide: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Text("\(comment.authorLabel) · \(comment.relativeTimestampText)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)

        if comment.isAdmin {
          badge("Admin", tint: .purple)
        }

        if let pendingText = comment.pendingBadgeText {
          badge(pendingText, tint: comment.pendingState == .failed ? .orange : .secondary)
        }

        Spacer(minLength: 8)

        HStack(spacing: 12) {
          Button(action: onReply) {
            Image(systemName: "arrowshape.turn.up.left")
          }
          .buttonStyle(.plain)

          if canHide {
            Button(action: onHide) {
              if isMutating {
                ProgressView()
                  .controlSize(.small)
              } else {
                Image(systemName: "eye.slash")
              }
            }
            .buttonStyle(.plain)
            .disabled(isMutating)
          }

          if canDelete {
            Button(action: onDelete) {
              if isMutating {
                ProgressView()
                  .controlSize(.small)
              } else {
                Image(systemName: "trash")
              }
            }
            .buttonStyle(.plain)
            .disabled(isMutating)
          }
        }
        .foregroundStyle(canDelete || canHide || isOwnComment ? .secondary : .tertiary)
      }

      Text(comment.text)
        .font(isReply ? .subheadline : .body)
        .foregroundStyle(comment.pendingState == .failed ? .secondary : .primary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(
      comment.pendingState == .failed
        ? .orange.opacity(0.08)
        : Color.white.opacity(isReply ? 0.04 : 0.06),
      in: RoundedRectangle(cornerRadius: isReply ? 16 : 18)
    )
  }

  private func badge(_ text: String, tint: Color) -> some View {
    Text(text)
      .font(.caption2.weight(.bold))
      .foregroundStyle(tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(tint.opacity(0.12), in: Capsule())
  }
}
