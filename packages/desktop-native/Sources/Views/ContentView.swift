import SwiftUI

struct ContentView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var searchTask: Task<Void, Never>?

  var body: some View {
    GeometryReader { proxy in
      ZStack(alignment: .topLeading) {
        VStack(spacing: 0) {
          topSectionBar

          Divider()

          Group {
            if appState.isShowingWatchPage, appState.selectedVideo != nil {
              VideoDetailView()
            } else if appState.isShowingChannelPage {
              ChannelPageView()
            } else if appState.currentSection == .studio, !appState.isSearchActive {
              StudioDashboardView()
            } else if appState.currentSection == .diagnostics, !appState.isSearchActive {
              DiagnosticsView()
            } else {
              FeedListView()
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }

        if let miniPlayerVideo {
          FloatingMiniPlayer(
            video: miniPlayerVideo,
            containerSize: proxy.size
          )
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(nsColor: .windowBackgroundColor))
    }
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(alignment: .leading, spacing: 2) {
          Text("PearTube")
            .font(.headline)
          Text(appState.isSearchActive ? "Search results" : appState.currentSection.title)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .searchable(
      text: searchText,
      placement: .toolbar,
      prompt: "Search videos"
    )
    .onDisappear {
      searchTask?.cancel()
    }
  }

  private var topSectionBar: some View {
    HStack(spacing: 14) {
      if appState.isShowingWatchPage || appState.isShowingChannelPage {
        Button {
          if appState.isShowingWatchPage {
            appState.closeWatchPage()
          } else {
            appState.closeChannelPage()
          }
        } label: {
          Label("Back", systemImage: "chevron.left")
            .font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.borderless)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 10) {
          ForEach(AppSection.allCases) { section in
            Button {
              appState.selectSection(section)
            } label: {
              HStack(spacing: 8) {
                Image(systemName: section.systemImage)
                  .font(.caption.weight(.semibold))
                Text(section.title)
                  .font(.subheadline.weight(.semibold))

                if appState.videoCount(for: section) > 0 {
                  Text("\(appState.videoCount(for: section))")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(isSelected(section) ? .primary : .secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(
                      isSelected(section)
                        ? AnyShapeStyle(.white.opacity(0.18))
                        : AnyShapeStyle(.quaternary.opacity(0.6)),
                      in: Capsule()
                    )
                }
              }
              .foregroundStyle(isSelected(section) ? Color.white : Color.primary)
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
              .background(sectionChipBackground(for: section), in: Capsule())
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
      }

      Spacer(minLength: 12)

      HStack(spacing: 8) {
        Circle()
          .fill(hostIndicatorColor)
          .frame(width: 8, height: 8)
        Text(hostBridge.statusTitle)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .padding(.trailing, 20)
    }
    .background(Color(nsColor: .underPageBackgroundColor))
  }

  private func isSelected(_ section: AppSection) -> Bool {
    appState.currentSection == section && !appState.isSearchActive
  }

  private func sectionChipBackground(for section: AppSection) -> some ShapeStyle {
    if isSelected(section) {
      return AnyShapeStyle(
        LinearGradient(
          colors: [Color(red: 0.18, green: 0.18, blue: 0.2), Color(red: 0.11, green: 0.11, blue: 0.13)],
          startPoint: .top,
          endPoint: .bottom
        )
      )
    }

    return AnyShapeStyle(.clear)
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

  private var miniPlayerVideo: NativeVideo? {
    guard let miniPlayerVideo = appState.miniPlayerVideo,
          hostBridge.activePlaybackVideoID == miniPlayerVideo.id else {
      return nil
    }

    return miniPlayerVideo
  }

  private var searchText: Binding<String> {
    Binding(
      get: { appState.searchQuery },
      set: { newValue in
        searchTask?.cancel()

        let trimmedValue = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedValue.isEmpty else {
          appState.clearSearch()
          return
        }

        appState.beginSearch(query: newValue)
        searchTask = Task {
          try? await Task.sleep(for: .milliseconds(250))
          guard !Task.isCancelled else { return }
          await hostBridge.searchVideos(query: newValue, into: appState)
        }
      }
    )
  }
}

private struct FloatingMiniPlayer: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @GestureState private var dragTranslation: CGSize = .zero
  @State private var snappedOrigin = CGPoint.zero
  @State private var hasSeededOrigin = false
  @State private var isHovering = false

  let video: NativeVideo
  let containerSize: CGSize

  var body: some View {
    let playerSize = MiniPlayerLayout.preferredSize(for: video, containerSize: containerSize)
    let displayOrigin = CGPoint(
      x: snappedOrigin.x + dragTranslation.width,
      y: snappedOrigin.y + dragTranslation.height
    )

    ZStack {
      miniPlaybackSurface
        .overlay {
          miniPlayerControls
        }
    }
    .frame(width: playerSize.width, height: playerSize.height)
    .background(.black, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .strokeBorder(.white.opacity(0.08))
    )
    .shadow(color: .black.opacity(0.26), radius: 24, y: 16)
    .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .offset(x: displayOrigin.x, y: displayOrigin.y)
    .gesture(dragGesture(for: playerSize))
    .onHover { hovering in
      isHovering = hovering
    }
    .onAppear {
      seedOriginIfNeeded(for: playerSize, forceReset: true)
    }
    .onChange(of: video.id) { _, _ in
      seedOriginIfNeeded(for: playerSize, forceReset: true)
    }
    .onChange(of: video.width) { _, _ in
      seedOriginIfNeeded(for: playerSize, forceReset: true)
    }
    .onChange(of: video.height) { _, _ in
      seedOriginIfNeeded(for: playerSize, forceReset: true)
    }
    .onChange(of: containerSize) { _, _ in
      seedOriginIfNeeded(for: playerSize, forceReset: false)
    }
  }

  @ViewBuilder
  private var miniPlaybackSurface: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(.black)

      if hostBridge.activePlaybackVideoID == video.id,
         let player = hostBridge.activeAVPlayer {
        NativeAVPlayerView(player: player, hidesControls: true)
          .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
      } else if let thumbnailURL = hostBridge.thumbnailURL(for: video) {
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
            Color(hex: video.accentHex)
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
      } else {
        Color(hex: video.accentHex)
          .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
  }

  private var miniPlayerControls: some View {
    ZStack {
      LinearGradient(
        colors: [.black.opacity(isHovering ? 0.14 : 0.02), .black.opacity(isHovering ? 0.42 : 0.08)],
        startPoint: .top,
        endPoint: .bottom
      )

      VStack {
        HStack(spacing: 8) {
          Spacer()

          miniIconButton(systemImage: "arrow.up.left.and.arrow.down.right") {
            appState.restorePlayingVideoToWatchPage()
          }

          miniIconButton(systemImage: "xmark") {
            hostBridge.clearPlayback()
            appState.clearPlaybackSelection()
          }
        }
        .padding(12)

        Spacer()

        miniIconButton(systemImage: appState.isPlayingPreview ? "pause.fill" : "play.fill", action: togglePlayback)
          .scaleEffect(isHovering ? 1 : 0.92)
          .padding(.bottom, 18)
      }
    }
    .opacity(isHovering ? 1 : 0)
    .animation(.easeOut(duration: 0.18), value: isHovering)
  }

  private func miniIconButton(systemImage: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(.white)
        .frame(width: 36, height: 36)
        .background(.black.opacity(0.68), in: Circle())
    }
    .buttonStyle(.plain)
  }

  private func dragGesture(for playerSize: CGSize) -> some Gesture {
    DragGesture(minimumDistance: 2)
      .updating($dragTranslation) { value, state, _ in
        state = value.translation
      }
      .onEnded { value in
        let proposedOrigin = CGPoint(
          x: snappedOrigin.x + value.translation.width,
          y: snappedOrigin.y + value.translation.height
        )
        snappedOrigin = MiniPlayerLayout.snapFrame(
          proposedOrigin: proposedOrigin,
          playerSize: playerSize,
          containerSize: containerSize,
          margin: MiniPlayerLayout.margin
        ).origin
      }
  }

  private func seedOriginIfNeeded(for playerSize: CGSize, forceReset: Bool) {
    let nextOrigin: CGPoint

    if forceReset || !hasSeededOrigin {
      nextOrigin = MiniPlayerLayout.defaultOrigin(
        playerSize: playerSize,
        containerSize: containerSize,
        margin: MiniPlayerLayout.margin
      )
      hasSeededOrigin = true
    } else {
      nextOrigin = MiniPlayerLayout.snapFrame(
        proposedOrigin: snappedOrigin,
        playerSize: playerSize,
        containerSize: containerSize,
        margin: MiniPlayerLayout.margin
      ).origin
    }

    snappedOrigin = nextOrigin
  }

  private func togglePlayback() {
    if appState.isPlayingPreview {
      hostBridge.pauseActiveAVPlayer()
      appState.pausePreview()
      return
    }

    hostBridge.resumeActiveAVPlayer()
    appState.resumePlayback()
  }
}

struct MiniPlayerLayout {
  static let margin: CGFloat = 24

  static func preferredSize(for video: NativeVideo, containerSize: CGSize) -> CGSize {
    let availableWidth = max(180, containerSize.width - (margin * 2))
    let availableHeight = max(180, containerSize.height - (margin * 2))
    let maxWidth = min(max(300, min(containerSize.width * 0.36, 460)), availableWidth)
    let maxHeight = min(max(220, min(containerSize.height * 0.72, 680)), availableHeight)

    switch video.presentationStyle {
    case .portrait:
      return fittedSize(
        width: 360,
        height: 640,
        maxWidth: maxWidth,
        maxHeight: maxHeight
      )
    case .square:
      let side = min(360, min(maxWidth, maxHeight))
      return CGSize(width: side, height: side)
    case .landscape:
      return fittedSize(
        width: 420,
        height: 420 / max(CGFloat(video.displayAspectRatio), 0.01),
        maxWidth: maxWidth,
        maxHeight: maxHeight
      )
    }
  }

  static func defaultOrigin(playerSize: CGSize, containerSize: CGSize, margin: CGFloat = MiniPlayerLayout.margin) -> CGPoint {
    let maxX = max(margin, containerSize.width - playerSize.width - margin)
    let maxY = max(margin, containerSize.height - playerSize.height - margin)
    return CGPoint(x: maxX, y: maxY)
  }

  static func snapFrame(
    proposedOrigin: CGPoint,
    playerSize: CGSize,
    containerSize: CGSize,
    margin: CGFloat = MiniPlayerLayout.margin
  ) -> CGRect {
    let minX = margin
    let maxX = max(margin, containerSize.width - playerSize.width - margin)
    let minY = margin
    let maxY = max(margin, containerSize.height - playerSize.height - margin)

    let clampedX = min(max(proposedOrigin.x, minX), maxX)
    let clampedY = min(max(proposedOrigin.y, minY), maxY)
    let snappedX = abs(clampedX - minX) < abs(clampedX - maxX) ? minX : maxX
    let snappedY = abs(clampedY - minY) < abs(clampedY - maxY) ? minY : maxY

    return CGRect(origin: CGPoint(x: snappedX, y: snappedY), size: playerSize)
  }

  private static func fittedSize(width: CGFloat, height: CGFloat, maxWidth: CGFloat, maxHeight: CGFloat) -> CGSize {
    guard width > 0, height > 0 else {
      return CGSize(width: min(maxWidth, 360), height: min(maxHeight, 240))
    }

    let scale = min(1, min(maxWidth / width, maxHeight / height))
    return CGSize(width: width * scale, height: height * scale)
  }
}

extension Color {
  init(hex: String) {
    let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&int)

    let red, green, blue: UInt64
    switch hex.count {
    case 6:
      (red, green, blue) = (int >> 16, int >> 8 & 0xff, int & 0xff)
    default:
      (red, green, blue) = (255, 255, 255)
    }

    self.init(
      .sRGB,
      red: Double(red) / 255,
      green: Double(green) / 255,
      blue: Double(blue) / 255,
      opacity: 1
    )
  }
}

private struct NativeSurfaceCard<Content: View>: View {
  let alignment: HorizontalAlignment
  let spacing: CGFloat
  let content: Content

  init(
    alignment: HorizontalAlignment = .leading,
    spacing: CGFloat = 16,
    @ViewBuilder content: () -> Content
  ) {
    self.alignment = alignment
    self.spacing = spacing
    self.content = content()
  }

  var body: some View {
    VStack(alignment: alignment, spacing: spacing) {
      content
    }
    .padding(22)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.16), in: RoundedRectangle(cornerRadius: 24))
    .overlay(
      RoundedRectangle(cornerRadius: 24)
        .strokeBorder(.white.opacity(0.05))
    )
  }
}

private struct ChannelIdentityAvatar: View {
  let profile: NativeChannelProfile
  var size: CGFloat = 72

  var body: some View {
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: [Color.black.opacity(0.36), Color.black.opacity(0.14)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )

      if let avatarURL = profile.avatarURL {
        AsyncImage(url: avatarURL) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFill()
          default:
            initials
          }
        }
      } else {
        initials
      }
    }
    .frame(width: size, height: size)
    .overlay(Circle().strokeBorder(.white.opacity(0.08)))
    .clipShape(Circle())
  }

  private var initials: some View {
    Text(profile.name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined())
      .font(.system(size: size * 0.32, weight: .bold))
      .foregroundStyle(.white.opacity(0.92))
  }
}

private struct StatusPill: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(tint.opacity(0.12), in: Capsule())
  }
}

private struct StudioDashboardView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var channelNameDraft = ""
  @State private var channelDescriptionDraft = ""
  @State private var isEditingChannel = false
  @State private var isUploadDropTargeted = false
  @State private var videoTitleDraft = ""
  @State private var videoDescriptionDraft = ""
  @State private var videoCategoryDraft = ""
  @State private var pendingDeletion: NativeVideo?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        HStack(alignment: .bottom, spacing: 16) {
          VStack(alignment: .leading, spacing: 6) {
            Text("Studio")
              .font(.title.bold())
            Text("Create, upload, publish, and edit your channel from one native workspace.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }

          Spacer()

          if appState.hasActiveIdentity {
            Button("Refresh") {
              Task {
                await hostBridge.loadStudioWorkspace(into: appState)
              }
            }
            .buttonStyle(.bordered)
            .disabled(appState.isLoading)
          }
        }

        if !appState.hasActiveIdentity {
          SectionEmptyStateView(section: .studio, prominence: .detail)
        } else if let profile = appState.studioWorkspaceProfile {
          if let errorMessage = appState.lastErrorMessage,
             !errorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            NativeSurfaceCard(spacing: 12) {
              HStack(alignment: .center, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                  .foregroundStyle(.orange)

                VStack(alignment: .leading, spacing: 4) {
                  Text("Studio action failed")
                    .font(.headline)
                  Text(errorMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Button("Retry") {
                  Task {
                    await hostBridge.loadStudioWorkspace(into: appState)
                  }
                }
                .buttonStyle(.bordered)
                .disabled(appState.isLoading)
              }
            }
          }

          NativeSurfaceCard {
            HStack(alignment: .top, spacing: 18) {
              ChannelIdentityAvatar(profile: profile, size: 78)

              VStack(alignment: .leading, spacing: 12) {
                if isEditingChannel {
                  TextField("Channel name", text: $channelNameDraft)
                    .textFieldStyle(.roundedBorder)

                  TextEditor(text: $channelDescriptionDraft)
                    .frame(minHeight: 90)
                    .padding(8)
                    .background(.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))

                  HStack(spacing: 10) {
                    Button("Save Channel") {
                      Task {
                        let updated = await hostBridge.updateChannelMetadata(
                          name: channelNameDraft,
                          description: channelDescriptionDraft,
                          into: appState
                        )
                        if updated {
                          isEditingChannel = false
                          await hostBridge.loadStudioWorkspace(into: appState)
                        }
                      }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Cancel") {
                      seedChannelDraft(from: profile)
                      isEditingChannel = false
                    }
                    .buttonStyle(.bordered)
                  }
                } else {
                  VStack(alignment: .leading, spacing: 8) {
                    Text(profile.name)
                      .font(.title2.weight(.bold))
                    Text(profile.description.isEmpty ? "No channel description yet." : profile.description)
                      .font(.subheadline)
                      .foregroundStyle(.secondary)
                      .fixedSize(horizontal: false, vertical: true)
                  }
                }

                HStack(spacing: 10) {
                  StatusPill(
                    text: profile.isPublished ? "Published" : "Local only",
                    tint: profile.isPublished ? .green : .orange
                  )
                  StatusPill(text: "\(profile.videoCount) videos", tint: .secondary)
                  if appState.activeStudioUploadJob != nil {
                    StatusPill(text: "Upload active", tint: .blue)
                  }
                }
              }

              Spacer(minLength: 16)

              VStack(alignment: .trailing, spacing: 10) {
                Button(isEditingChannel ? "Editing" : "Edit Channel") {
                  seedChannelDraft(from: profile)
                  isEditingChannel.toggle()
                }
                .buttonStyle(.bordered)

                Button("Change Avatar") {
                  Task {
                    let updated = await hostBridge.updateChannelAvatar(into: appState)
                    if updated {
                      await hostBridge.loadStudioWorkspace(into: appState)
                    }
                  }
                }
                .buttonStyle(.bordered)

                if !profile.isPublished {
                  Button("Publish Channel") {
                    Task {
                      await hostBridge.publishActiveChannel(into: appState)
                    }
                  }
                  .buttonStyle(.borderedProminent)
                }

                Button("Open Channel") {
                  Task {
                    await hostBridge.loadChannelPage(
                      channelKey: profile.channelKey,
                      publicBeeKey: profile.publicBeeKey,
                      into: appState
                    )
                  }
                }
                .buttonStyle(.bordered)
              }
            }
          }

          Button {
            Task {
              await hostBridge.uploadVideo(into: appState)
            }
          } label: {
            NativeSurfaceCard(alignment: .center, spacing: 14) {
              Image(systemName: "square.and.arrow.up.on.square")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))

              VStack(spacing: 6) {
                Text("Upload a new video")
                  .font(.title3.weight(.semibold))
                  .foregroundStyle(.primary)
                Text("Choose a file or drop one here to start uploading immediately.")
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }

              Text("Choose Video")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 9)
                .background(Color.accentColor, in: Capsule())
            }
            .overlay {
              RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(
                  isUploadDropTargeted ? Color.accentColor.opacity(0.85) : Color.white.opacity(0.05),
                  style: StrokeStyle(lineWidth: isUploadDropTargeted ? 2 : 1, dash: isUploadDropTargeted ? [10, 8] : [])
                )
                .padding(1)
            }
            .background(
              RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(isUploadDropTargeted ? Color.accentColor.opacity(0.08) : .clear)
            )
          }
          .buttonStyle(.plain)
          .disabled(appState.isLoading)
          .dropDestination(for: URL.self) { droppedURLs, _ in
            handleVideoDrop(droppedURLs)
          } isTargeted: { isTargeted in
            isUploadDropTargeted = isTargeted
          }

          if let job = appState.presentedStudioUploadJob {
            NativeSurfaceCard(spacing: 14) {
              HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                  Text(job.title)
                    .font(.headline)
                  Text(uploadStatusText(for: job))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }

                Spacer()

                Text("\(job.progress)%")
                  .font(.headline.monospacedDigit())
              }

              ProgressView(value: Double(job.progress), total: 100)
                .tint(job.state == .failed ? .red : .accentColor)

              if let error = job.errorMessage, !error.isEmpty {
                Text(error)
                  .font(.caption)
                  .foregroundStyle(.orange)
              }

              if job.state == .failed {
                HStack(spacing: 10) {
                  if appState.retryableStudioUploadFileURL() != nil {
                    Button("Retry Upload") {
                      Task {
                        await hostBridge.retryFailedStudioUpload(into: appState)
                      }
                    }
                    .buttonStyle(.borderedProminent)
                  }

                  Button("Choose Another File") {
                    Task {
                      await hostBridge.uploadVideo(into: appState)
                    }
                  }
                  .buttonStyle(.bordered)
                }
              }
            }
          }

          ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 24) {
              studioVideosCard
                .frame(minWidth: 420, maxWidth: .infinity, alignment: .topLeading)
              studioEditorCard
                .frame(minWidth: 360, maxWidth: 420, alignment: .topLeading)
            }

            VStack(alignment: .leading, spacing: 24) {
              studioVideosCard
              studioEditorCard
            }
          }
        }
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 24)
      .frame(maxWidth: 1420, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .center)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .task(id: studioLoadToken) {
      guard appState.hasActiveIdentity else { return }
      await hostBridge.loadStudioWorkspace(into: appState)
    }
    .onAppear {
      seedChannelDraft(from: appState.studioWorkspaceProfile)
      seedVideoDraft(from: appState.studioEditingVideo)
    }
    .onChange(of: appState.studioWorkspaceProfile) { _, profile in
      seedChannelDraft(from: profile)
    }
    .onChange(of: appState.studioEditingVideo) { _, video in
      seedVideoDraft(from: video)
    }
    .confirmationDialog(
      "Delete Video",
      isPresented: Binding(
        get: { pendingDeletion != nil },
        set: { newValue in
          if !newValue {
            pendingDeletion = nil
          }
        }
      ),
      titleVisibility: .visible,
      presenting: pendingDeletion
    ) { video in
      Button("Delete Video", role: .destructive) {
        Task {
          let removed = await hostBridge.deleteVideo(video, into: appState)
          if removed {
            pendingDeletion = nil
            appState.removeOwnedVideo(video)
            await hostBridge.loadStudioWorkspace(into: appState)
          }
        }
      }
    } message: { video in
      Text("Remove \(video.title) from your channel?")
    }
  }

  private var studioVideosCard: some View {
    NativeSurfaceCard {
      HStack {
        Text("Recent uploads")
          .font(.title3.weight(.semibold))
        Spacer()
        Text("\(appState.studioWorkspaceVideos.count)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      if appState.studioWorkspaceVideos.isEmpty {
        Text("Your uploaded videos will appear here as soon as the host indexes them.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        LazyVStack(spacing: 12) {
          ForEach(appState.studioWorkspaceVideos) { video in
            HStack(alignment: .top, spacing: 14) {
              NativeVideoThumbnailView(
                video: video,
                context: .relatedRail,
                cornerRadius: 14
              )
              .frame(width: 184, height: 104)

              VStack(alignment: .leading, spacing: 6) {
                Text(video.title)
                  .font(.headline)
                  .lineLimit(2)
                Text(video.summary.isEmpty ? "No description yet." : video.summary)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .lineLimit(2)
                Text(video.durationText)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }

              Spacer(minLength: 12)

              VStack(alignment: .trailing, spacing: 8) {
                Button(video.id == appState.selectedStudioVideoID ? "Editing" : "Edit") {
                  appState.selectStudioVideoForEditing(video.id)
                }
                .buttonStyle(.borderedProminent)

                Button("Open") {
                  appState.openVideo(video.id)
                }
                .buttonStyle(.bordered)
              }
            }
            .padding(14)
            .background(
              (video.id == appState.selectedStudioVideoID ? .white.opacity(0.08) : .black.opacity(0.08)),
              in: RoundedRectangle(cornerRadius: 18)
            )
          }
        }
      }
    }
  }

  private var studioEditorCard: some View {
    NativeSurfaceCard {
      HStack {
        Text("Video details")
          .font(.title3.weight(.semibold))
        Spacer()
        if let video = appState.studioEditingVideo {
          Button("View Channel") {
            Task {
              await hostBridge.loadChannelPage(
                channelKey: video.channelKey,
                publicBeeKey: video.publicBeeKey,
                into: appState
              )
            }
          }
          .buttonStyle(.bordered)
        }
      }

      if let video = appState.studioEditingVideo {
        VStack(alignment: .leading, spacing: 12) {
          TextField("Title", text: $videoTitleDraft)
            .textFieldStyle(.roundedBorder)

          TextEditor(text: $videoDescriptionDraft)
            .frame(minHeight: 130)
            .padding(8)
            .background(.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))

          TextField("Category (optional)", text: $videoCategoryDraft)
            .textFieldStyle(.roundedBorder)

          HStack(spacing: 10) {
            Button("Save Details") {
              Task {
                let updated = await hostBridge.updateVideoMetadata(
                  for: video,
                  title: videoTitleDraft,
                  description: videoDescriptionDraft,
                  category: videoCategoryDraft.isEmpty ? nil : videoCategoryDraft,
                  into: appState
                )
                if updated {
                  appState.upsertOwnedVideo(locallyUpdatedStudioVideo(from: video))
                  await hostBridge.loadStudioWorkspace(into: appState)
                }
              }
            }
            .buttonStyle(.borderedProminent)

            Button("Set Thumbnail") {
              Task {
                let updated = await hostBridge.setVideoThumbnailFromFile(for: video, into: appState)
                if updated {
                  await hostBridge.refreshThumbnail(for: video)
                }
              }
            }
            .buttonStyle(.bordered)

            Button("Delete", role: .destructive) {
              pendingDeletion = video
            }
            .buttonStyle(.bordered)
          }
        }
      } else {
        Text("Pick one of your videos to edit its title, description, thumbnail, or category.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var studioLoadToken: String {
    "\(appState.activeIdentityChannelKey ?? "none"):\(appState.videoCount(for: .studio)):\(appState.activeChannelPublished)"
  }

  private func seedChannelDraft(from profile: NativeChannelProfile?) {
    channelNameDraft = profile?.name ?? appState.activeIdentityName
    channelDescriptionDraft = profile?.description ?? ""
  }

  private func seedVideoDraft(from video: NativeVideo?) {
    videoTitleDraft = video?.title ?? ""
    videoDescriptionDraft = video?.summary ?? ""
    videoCategoryDraft = ""
  }

  private func uploadStatusText(for job: NativeUploadJob) -> String {
    switch job.state {
    case .pending:
      return "Queued for upload"
    case .uploading:
      return "Uploading \(job.fileName)"
    case .processing:
      return "Processing upload"
    case .completed:
      return "Upload complete"
    case .failed:
      return "Upload failed"
    }
  }

  private func handleVideoDrop(_ droppedURLs: [URL]) -> Bool {
    guard let fileURL = HostBridgeService.preferredVideoUploadDropURL(from: droppedURLs) else {
      appState.setError("Drop a supported video file such as .mp4, .mov, .m4v, .mkv, or .webm.")
      return false
    }

    Task {
      await hostBridge.uploadVideo(from: fileURL, into: appState)
    }
    return true
  }

  private func locallyUpdatedStudioVideo(from video: NativeVideo) -> NativeVideo {
    let trimmedTitle = videoTitleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTitle = trimmedTitle.isEmpty ? video.title : trimmedTitle
    let resolvedSummary = videoDescriptionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    return video.updating(title: resolvedTitle, summary: resolvedSummary)
  }
}

private enum ChannelPageTab: String, CaseIterable, Identifiable {
  case videos
  case about

  var id: String { rawValue }

  var title: String {
    switch self {
    case .videos: return "Videos"
    case .about: return "About"
    }
  }
}

private struct ChannelPageView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge
  @State private var selectedTab: ChannelPageTab = .videos
  @State private var isEditingChannel = false
  @State private var channelNameDraft = ""
  @State private var channelDescriptionDraft = ""
  @State private var selectedOwnerVideoID: NativeVideo.ID?
  @State private var videoTitleDraft = ""
  @State private var videoDescriptionDraft = ""
  @State private var videoCategoryDraft = ""
  @State private var pendingDeletion: NativeVideo?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let profile = appState.channelPageProfile {
          if let errorMessage = appState.lastErrorMessage,
             !errorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            NativeSurfaceCard(spacing: 12) {
              HStack(alignment: .center, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                  .foregroundStyle(.orange)

                VStack(alignment: .leading, spacing: 4) {
                  Text("Channel action failed")
                    .font(.headline)
                  Text(errorMessage)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Button("Retry") {
                  Task {
                    await refreshChannelPage(for: profile)
                  }
                }
                .buttonStyle(.bordered)
                .disabled(appState.isLoading)
              }
            }
          }

          NativeSurfaceCard {
            HStack(alignment: .top, spacing: 18) {
              ChannelIdentityAvatar(profile: profile, size: 86)

              VStack(alignment: .leading, spacing: 12) {
                if isEditingChannel && profile.role == .owner {
                  TextField("Channel name", text: $channelNameDraft)
                    .textFieldStyle(.roundedBorder)

                  TextEditor(text: $channelDescriptionDraft)
                    .frame(minHeight: 100)
                    .padding(8)
                    .background(.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                } else {
                  Text(profile.name)
                    .font(.largeTitle.weight(.bold))
                  Text(profile.description.isEmpty ? "No channel description yet." : profile.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                  StatusPill(text: profile.role == .owner ? "Your channel" : "Creator", tint: .secondary)
                  StatusPill(
                    text: profile.isPublished ? "Published" : "Local only",
                    tint: profile.isPublished ? .green : .orange
                  )
                  StatusPill(text: "\(profile.videoCount) videos", tint: .secondary)
                }
              }

              Spacer(minLength: 16)

              VStack(alignment: .trailing, spacing: 10) {
                if profile.role == .owner {
                  if isEditingChannel {
                    Button("Save Channel") {
                      Task {
                        let updated = await hostBridge.updateChannelMetadata(
                          name: channelNameDraft,
                          description: channelDescriptionDraft,
                          into: appState
                        )
                        if updated {
                          isEditingChannel = false
                          await refreshChannelPage(for: appState.channelPageProfile ?? profile)
                        }
                      }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Cancel") {
                      seedDrafts(from: profile)
                      isEditingChannel = false
                    }
                    .buttonStyle(.bordered)
                  } else {
                    Button("Edit Channel") {
                      seedDrafts(from: profile)
                      isEditingChannel = true
                    }
                    .buttonStyle(.bordered)
                  }

                  Button("Change Avatar") {
                    Task {
                      let updated = await hostBridge.updateChannelAvatar(into: appState)
                      if updated {
                        await refreshChannelPage(for: profile)
                      }
                    }
                  }
                  .buttonStyle(.bordered)

                  if !profile.isPublished {
                    Button("Publish Channel") {
                      Task {
                        await hostBridge.publishActiveChannel(into: appState)
                      }
                    }
                    .buttonStyle(.borderedProminent)
                  }

                  Button("Open in Studio") {
                    appState.selectSection(.studio)
                  }
                  .buttonStyle(.bordered)
                } else {
                  if profile.isSubscribed {
                    Button("Subscribed") {
                      Task {
                        await hostBridge.toggleSubscription(
                          channelKey: profile.channelKey,
                          channelName: profile.name,
                          into: appState
                        )
                      }
                    }
                    .buttonStyle(.bordered)
                  } else {
                    Button("Subscribe") {
                      Task {
                        await hostBridge.toggleSubscription(
                          channelKey: profile.channelKey,
                          channelName: profile.name,
                          into: appState
                        )
                      }
                    }
                    .buttonStyle(.borderedProminent)
                  }
                }
              }
            }
          }

          Picker("Channel section", selection: $selectedTab) {
            ForEach(ChannelPageTab.allCases) { tab in
              Text(tab.title).tag(tab)
            }
          }
          .pickerStyle(.segmented)

          switch selectedTab {
          case .videos:
            NativeSurfaceCard {
              if profile.role == .owner {
                channelOwnerEditorCard

                if !appState.channelPageVideos.isEmpty {
                  Divider()
                }
              }

              if appState.channelPageVideos.isEmpty {
                Text("No videos are available for this channel yet.")
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              } else {
                LazyVGrid(
                  columns: [GridItem(.adaptive(minimum: 300, maximum: 360), spacing: 22)],
                  spacing: 22
                ) {
                  ForEach(appState.channelPageVideos) { video in
                    ChannelPageVideoCard(
                      video: video,
                      isOwnerMode: profile.role == .owner,
                      isSelectedForEditing: selectedOwnerVideo?.id == video.id,
                      onEdit: {
                        selectedOwnerVideoID = video.id
                      }
                    )
                  }
                }
              }
            }
          case .about:
            NativeSurfaceCard {
              Text("About")
                .font(.title3.weight(.semibold))
              Text(profile.description.isEmpty ? "This creator has not added a channel description yet." : profile.description)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

              Divider()

              VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Channel key", value: profile.channelKey)
                LabeledContent("Public bee", value: profile.publicBeeKey ?? "Unavailable")
                LabeledContent("Role", value: profile.role == .owner ? "Owner" : "Viewer")
              }
              .font(.subheadline)
            }
          }
        } else {
          ContentUnavailableView(
            "Channel unavailable",
            systemImage: "person.crop.square",
            description: Text("Select a channel from a video or Studio to open its page.")
          )
        }
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 24)
      .frame(maxWidth: 1420, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .center)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .onAppear {
      seedDrafts(from: appState.channelPageProfile)
      syncSelectedOwnerVideo(with: appState.channelPageVideos)
    }
    .onChange(of: appState.channelPageProfile) { _, profile in
      seedDrafts(from: profile)
    }
    .onChange(of: appState.channelPageVideos) { _, videos in
      syncSelectedOwnerVideo(with: videos)
    }
    .onChange(of: selectedOwnerVideoID) { _, _ in
      seedVideoDrafts(from: selectedOwnerVideo)
    }
    .confirmationDialog(
      "Delete Video",
      isPresented: Binding(
        get: { pendingDeletion != nil },
        set: { newValue in
          if !newValue {
            pendingDeletion = nil
          }
        }
      ),
      titleVisibility: .visible,
      presenting: pendingDeletion
    ) { video in
      Button("Delete Video", role: .destructive) {
        Task {
          let removed = await hostBridge.deleteVideo(video, into: appState)
          if removed {
            pendingDeletion = nil
            appState.removeOwnedVideo(video)
            await refreshOwnerChannelAfterMutation(for: video)
          }
        }
      }
    } message: { video in
      Text("Remove \(video.title) from your channel?")
    }
  }

  private var selectedOwnerVideo: NativeVideo? {
    guard let selectedOwnerVideoID else { return nil }
    return appState.channelPageVideos.first(where: { $0.id == selectedOwnerVideoID })
  }

  private var channelOwnerEditorCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("Manage videos")
          .font(.title3.weight(.semibold))
        Spacer()
        if let video = selectedOwnerVideo {
          Button("Open in Studio") {
            appState.selectStudioVideoForEditing(video.id)
            appState.selectSection(.studio)
          }
          .buttonStyle(.bordered)
        }
      }

      if let video = selectedOwnerVideo {
        VStack(alignment: .leading, spacing: 12) {
          Text(video.title)
            .font(.headline)
          TextField("Title", text: $videoTitleDraft)
            .textFieldStyle(.roundedBorder)

          TextEditor(text: $videoDescriptionDraft)
            .frame(minHeight: 120)
            .padding(8)
            .background(.black.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))

          TextField("Category (optional)", text: $videoCategoryDraft)
            .textFieldStyle(.roundedBorder)

          HStack(spacing: 10) {
            Button("Save Details") {
              Task {
                let updated = await hostBridge.updateVideoMetadata(
                  for: video,
                  title: videoTitleDraft,
                  description: videoDescriptionDraft,
                  category: videoCategoryDraft.isEmpty ? nil : videoCategoryDraft,
                  into: appState
                )
                if updated {
                  appState.upsertOwnedVideo(locallyUpdatedVideo(from: video))
                  await refreshOwnerChannelAfterMutation(for: video)
                }
              }
            }
            .buttonStyle(.borderedProminent)

            Button("Set Thumbnail") {
              Task {
                let updated = await hostBridge.setVideoThumbnailFromFile(for: video, into: appState)
                if updated {
                  await hostBridge.refreshThumbnail(for: video)
                }
              }
            }
            .buttonStyle(.bordered)

            Button("Delete", role: .destructive) {
              pendingDeletion = video
            }
            .buttonStyle(.bordered)
          }
        }
      } else {
        Text("Choose one of your channel videos to edit its details without leaving the channel page.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func seedDrafts(from profile: NativeChannelProfile?) {
    channelNameDraft = profile?.name ?? ""
    channelDescriptionDraft = profile?.description ?? ""
  }

  private func seedVideoDrafts(from video: NativeVideo?) {
    videoTitleDraft = video?.title ?? ""
    videoDescriptionDraft = video?.summary ?? ""
    videoCategoryDraft = ""
  }

  private func syncSelectedOwnerVideo(with videos: [NativeVideo]) {
    guard appState.channelPageProfile?.role == .owner else {
      selectedOwnerVideoID = nil
      seedVideoDrafts(from: nil)
      return
    }

    if let selectedOwnerVideoID,
       videos.contains(where: { $0.id == selectedOwnerVideoID }) {
      return
    }

    selectedOwnerVideoID = videos.first?.id
    seedVideoDrafts(from: videos.first)
  }

  private func locallyUpdatedVideo(from video: NativeVideo) -> NativeVideo {
    let trimmedTitle = videoTitleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTitle = trimmedTitle.isEmpty ? video.title : trimmedTitle
    let resolvedSummary = videoDescriptionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    return video.updating(title: resolvedTitle, summary: resolvedSummary)
  }

  private func refreshChannelPage(for profile: NativeChannelProfile) async {
    await hostBridge.loadChannelPage(
      channelKey: profile.channelKey,
      publicBeeKey: profile.publicBeeKey,
      into: appState
    )
  }

  private func refreshOwnerChannelAfterMutation(for video: NativeVideo) async {
    guard let profile = appState.channelPageProfile, profile.channelKey == video.channelKey else { return }
    await refreshChannelPage(for: profile)
  }
}

private struct ChannelPageVideoCard: View {
  @Environment(AppState.self) private var appState

  let video: NativeVideo
  let isOwnerMode: Bool
  let isSelectedForEditing: Bool
  let onEdit: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        appState.openVideo(video.id)
      } label: {
        NativeVideoThumbnailView(
          video: video,
          context: .browseGrid,
          cornerRadius: 18
        )
      }
      .buttonStyle(.plain)

      VStack(alignment: .leading, spacing: 6) {
        Text(video.title)
          .font(.headline)
          .lineLimit(2)
        Text(video.durationText)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 10) {
        Button("Watch") {
          appState.openVideo(video.id)
        }
        .buttonStyle(.borderedProminent)

        if isOwnerMode {
          Button(isSelectedForEditing ? "Editing" : "Edit") {
            onEdit?()
          }
          .buttonStyle(.bordered)
        }
      }
    }
    .padding(16)
    .background(
      (isSelectedForEditing ? .white.opacity(0.08) : .black.opacity(0.08)),
      in: RoundedRectangle(cornerRadius: 20)
    )
  }
}

private struct DiagnosticsView: View {
  @Environment(AppState.self) private var appState
  @Environment(HostBridgeService.self) private var hostBridge

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        VStack(alignment: .leading, spacing: 8) {
          Text("Diagnostics")
            .font(.title.bold())
          Text("Inspect the embedded Bare host, storage target, and recent bridge activity.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }

        HStack(spacing: 12) {
          Button("Reload Host") {
            Task {
              await hostBridge.refreshBrowse(into: appState)
            }
          }
          .buttonStyle(.borderedProminent)

          Button("Copy Log") {
            hostBridge.copyDiagnosticsToPasteboard(appState: appState)
          }
          .buttonStyle(.bordered)
        }

        DiagnosticsMetricGrid()

        VStack(alignment: .leading, spacing: 10) {
          Label("Recent host log", systemImage: "list.bullet.rectangle")
            .font(.headline)

          ForEach(Array(hostBridge.logLines.suffix(24).enumerated()), id: \.offset) { _, line in
            Text(line)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(18)
        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 22))
      }
      .padding(28)
    }
    .background(Color(nsColor: .windowBackgroundColor))
  }
}

private struct DiagnosticsMetricGrid: View {
  @Environment(HostBridgeService.self) private var hostBridge

  private let columns = [
    GridItem(.flexible(minimum: 220), spacing: 16),
    GridItem(.flexible(minimum: 220), spacing: 16),
  ]

  var body: some View {
    LazyVGrid(columns: columns, spacing: 16) {
      DiagnosticsMetricCard(
        title: "Host",
        value: hostBridge.statusTitle,
        caption: heartbeatCaption
      )
      DiagnosticsMetricCard(
        title: "Storage",
        value: hostBridge.selectedStoragePath ?? "Unavailable",
        caption: "Embedded app-private host store"
      )
      DiagnosticsMetricCard(
        title: "Persistent Log",
        value: hostBridge.diagnosticsLogPath,
        caption: "Bridge session log"
      )
      DiagnosticsMetricCard(
        title: "Media Extensions",
        value: hostBridge.professionalVideoWorkflowDiagnostics.statusTitle,
        caption: hostBridge.activeMediaExtensionPlaybackSummary
          ?? hostBridge.professionalVideoWorkflowDiagnostics.bundledExtensionsSummary
      )
      DiagnosticsMetricCard(
        title: "FFmpeg Decode",
        value: hostBridge.ffmpegDecodeDiagnosticsTitle,
        caption: hostBridge.ffmpegDecodeDiagnosticsCaption
      )
    }
  }

  private var heartbeatCaption: String {
    if let lastHeartbeat = hostBridge.lastHeartbeat {
      return "Heartbeat \(lastHeartbeat.formatted(date: .omitted, time: .shortened))"
    }
    return "Awaiting heartbeat"
  }
}

private struct DiagnosticsMetricCard: View {
  let title: String
  let value: String
  let caption: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title.uppercased())
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.headline)
        .textSelection(.enabled)
      Text(caption)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(18)
    .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
  }
}
