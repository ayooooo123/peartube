import AppKit
import SwiftUI

struct MpvPlayerView: View {
  @Environment(HostBridgeService.self) private var hostBridge

  let video: NativeVideo

  @StateObject private var renderer = MpvFrameRenderer()

  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Color.black

        if let image = renderer.image {
          Image(decorative: image, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if renderer.isLoading {
          VStack(spacing: 14) {
            ProgressView()
              .progressViewStyle(.circular)
              .tint(.white)
            Text("Loading in bare-mpv")
              .font(.headline)
              .foregroundStyle(.white.opacity(0.92))
          }
        } else if let errorMessage = renderer.errorMessage {
          VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .font(.system(size: 42))
              .foregroundStyle(.orange)
            Text("MPV Playback Failed")
              .font(.headline)
              .foregroundStyle(.white)
            Text(errorMessage)
              .font(.caption)
              .multilineTextAlignment(.center)
              .foregroundStyle(.white.opacity(0.82))
              .padding(.horizontal, 18)
          }
        } else {
          VStack(spacing: 12) {
            Image(systemName: "play.rectangle.on.rectangle.fill")
              .font(.system(size: 64))
              .foregroundStyle(.white.opacity(0.9))
            Text("Ready for bare-mpv")
              .font(.headline)
              .foregroundStyle(.white.opacity(0.92))
          }
        }
      }
      .task(id: renderTaskID(for: geometry.size)) {
        await renderer.bind(
          hostBridge: hostBridge,
          video: video,
          renderSize: geometry.size
        )
      }
      .onDisappear {
        renderer.stop()
      }
    }
  }

  private func renderTaskID(for size: CGSize) -> String {
    "\(video.id)|\(hostBridge.activePlaybackVideoID ?? "nil")|\(hostBridge.activeMpvPlayerID ?? "nil")|\(hostBridge.activeMpvFrameServerPort ?? 0)|\(Int(size.width.rounded()))x\(Int(size.height.rounded()))"
  }
}

@MainActor
final class MpvFrameRenderer: ObservableObject {
  @Published private(set) var image: CGImage?
  @Published private(set) var isLoading = false
  @Published private(set) var errorMessage: String?
  @Published private(set) var currentTime: Double = 0
  @Published private(set) var duration: Double = 0
  @Published private(set) var paused = true

  private var renderTask: Task<Void, Never>?

  func bind(
    hostBridge: HostBridgeService,
    video: NativeVideo,
    renderSize: CGSize
  ) async {
    renderTask?.cancel()

    guard hostBridge.activePlaybackVideoID == video.id,
          let playerId = hostBridge.activeMpvPlayerID else {
      return
    }

    isLoading = image == nil
    errorMessage = nil

    let frameURL = hostBridge.activePlaybackFrameURL()
    renderTask = Task { [weak self] in
      await self?.runRenderLoop(
        hostBridge: hostBridge,
        videoID: video.id,
        playerId: playerId,
        frameURL: frameURL
      )
    }
  }

  func stop() {
    renderTask?.cancel()
    renderTask = nil
  }

  private func runRenderLoop(
    hostBridge: HostBridgeService,
    videoID: NativeVideo.ID,
    playerId: String,
    frameURL: URL?
  ) async {
    var iteration = 0

    while !Task.isCancelled {
      guard hostBridge.activePlaybackVideoID == videoID,
            hostBridge.activeMpvPlayerID == playerId else {
        break
      }

      if iteration.isMultiple(of: 3),
         let state = await hostBridge.activePlaybackState() {
        currentTime = state.currentTime
        duration = state.duration
        paused = state.paused
        if !state.success, let error = state.error {
          errorMessage = error
        }
      }

      if let frameURL,
         let frameImage = await Self.fetchFrameImage(from: frameURL) {
        image = frameImage
        isLoading = false
        errorMessage = nil
      } else if let frame = await hostBridge.activePlaybackFrame(),
                frame.success,
                frame.hasFrame,
                let frameImage = Self.makeImage(
                  from: frame.frameData,
                  width: frame.width,
                  height: frame.height
                ) {
        image = frameImage
        isLoading = false
        errorMessage = nil
      }

      iteration += 1
      try? await Task.sleep(for: .milliseconds(33))
    }
  }

  private static func fetchFrameImage(from url: URL) async -> CGImage? {
    do {
      let (data, response) = try await URLSession.shared.data(from: url)
      guard let httpResponse = response as? HTTPURLResponse else { return nil }
      guard httpResponse.statusCode == 200 else { return nil }

      let width = Int(httpResponse.value(forHTTPHeaderField: "X-Frame-Width") ?? "") ?? 0
      let height = Int(httpResponse.value(forHTTPHeaderField: "X-Frame-Height") ?? "") ?? 0
      return makeImage(from: data, width: width, height: height)
    } catch {
      return nil
    }
  }

  private static func makeImage(
    from frameData: Data?,
    width: Int,
    height: Int
  ) -> CGImage? {
    guard let frameData,
          width > 0,
          height > 0,
          frameData.count >= width * height * 4,
          let provider = CGDataProvider(data: frameData as CFData) else {
      return nil
    }

    let bitmapInfo = CGBitmapInfo.byteOrder32Big.union(
      CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue)
    )

    return CGImage(
      width: width,
      height: height,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: bitmapInfo,
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    )
  }
}
