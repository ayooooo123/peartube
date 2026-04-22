@preconcurrency import BareRPC
import Foundation
// HRPC and Schema types are compiled in the same module (GeneratedHRPC.swift, Generatedswift)

// MARK: - RPCDelegate Adapter

/// Bridges the generated ``HRPC`` class to the transport layer.
/// Sends outgoing RPC frames via the provided closure and logs errors.
final class HostBridgeRPCDelegate: RPCDelegate, @unchecked Sendable {
  let send: @Sendable (Data) -> Void
  let logError: @Sendable (Error) -> Void

  init(
    send: @escaping @Sendable (Data) -> Void,
    logError: @escaping @Sendable (Error) -> Void
  ) {
    self.send = send
    self.logError = logError
  }

  func rpc(_ rpc: RPC, send data: Data) {
    send(data)
  }

  func rpc(_ rpc: RPC, didReceiveEvent event: IncomingEvent) async {
    // Events are dispatched internally by the generated HRPC class.
  }

  func rpc(_ rpc: RPC, didFailWith error: Error) {
    logError(error)
  }
}


// MARK: - RPCRemoteError extension

extension RPCRemoteError: @retroactive LocalizedError {
  public var errorDescription: String? { message }
}

// MARK: - NativeBrowseSnapshot ↔ Schema Conversions

extension NativeVideo {
  init(browseVideo v: DesktopBrowseVideo) {
    let sectionSet: Set<AppSection> = Set(
      (v.sections ?? []).compactMap { AppSection(rawValue: $0) }
    )
    self.init(
      id: v.id,
      backendVideoID: v.backendVideoId,
      channelKey: v.channelKey,
      publicBeeKey: v.publicBeeKey?.isEmpty == false ? v.publicBeeKey : nil,
      title: v.title,
      channelName: v.channelName,
      durationText: v.durationText ?? "",
      summary: v.summary ?? "",
      tags: v.tags ?? [],
      accentHex: v.accentHex ?? "",
      sections: sectionSet,
      thumbnailURL: v.thumbnailUrl.flatMap { $0.isEmpty ? nil : URL(string: $0) },
      path: v.path?.isEmpty == false ? v.path : nil,
      blobId: v.blobId?.isEmpty == false ? v.blobId : nil,
      blobsCoreKey: v.blobsCoreKey?.isEmpty == false ? v.blobsCoreKey : nil,
      mimeType: v.mimeType?.isEmpty == false ? v.mimeType : nil,
      width: v.width.flatMap { $0 > 0 ? Int($0) : nil },
      height: v.height.flatMap { $0 > 0 ? Int($0) : nil }
    )
  }
}

extension NativeVideo {
  /// Convert a Schema ``Video`` (from listVideos, uploadVideo, etc.) to a ``NativeVideo``.
  init(video v: Video, channelKey: String? = nil) {
    self.init(
      id: v.id,
      backendVideoID: v.id,
      channelKey: channelKey ?? v.channelKey ?? "",
      publicBeeKey: v.publicBeeKey?.isEmpty == false ? v.publicBeeKey : nil,
      title: v.title,
      channelName: v.channelName ?? "",
      durationText: "",
      summary: v.description ?? "",
      tags: [],
      accentHex: "",
      sections: [],
      thumbnailURL: v.thumbnail.flatMap { $0.isEmpty ? nil : URL(string: $0) },
      path: v.path?.isEmpty == false ? v.path : nil,
      blobId: v.blobId?.isEmpty == false ? v.blobId : nil,
      blobsCoreKey: v.blobsCoreKey?.isEmpty == false ? v.blobsCoreKey : nil,
      mimeType: v.mimeType?.isEmpty == false ? v.mimeType : nil,
      width: nil,
      height: nil
    )
  }
}

extension NativeBrowseSnapshot {
  init(schema s: DesktopBrowseSnapshot) {
    self.init(
      generatedAt: TimeInterval(s.generatedAt ?? 0) / 1000.0,
      sections: NativeBrowseSections(schema: s.sections),
      stats: NativeBrowseStats(schema: s.stats),
      state: NativeBrowseState(schema: s.state)
    )
  }
}

extension NativeBrowseSections {
  init(schema s: DesktopBrowseSections) {
    self.init(
      home: (s.home ?? []).map { NativeVideo(browseVideo: $0) },
      subscriptions: (s.subscriptions ?? []).map { NativeVideo(browseVideo: $0) },
      library: (s.library ?? []).map { NativeVideo(browseVideo: $0) },
      studio: (s.studio ?? []).map { NativeVideo(browseVideo: $0) },
      diagnostics: (s.diagnostics ?? []).map { NativeVideo(browseVideo: $0) }
    )
  }
}

extension NativeBrowseStats {
  init(schema s: DesktopBrowseStats) {
    self.init(
      homeCount: Int(s.homeCount ?? 0),
      subscriptionCount: Int(s.subscriptionCount ?? 0),
      libraryCount: Int(s.libraryCount ?? 0),
      channelCount: Int(s.channelCount ?? 0)
    )
  }
}

extension NativeBrowseState {
  init(schema s: DesktopBrowseState) {
    self.init(
      subscriptionChannelKeys: s.subscriptionChannelKeys ?? [],
      identityChannelKeys: s.identityChannelKeys ?? [],
      activeIdentityName: s.activeIdentityName?.isEmpty == false ? s.activeIdentityName : nil,
      activeIdentityChannelKey: s.activeIdentityChannelKey?.isEmpty == false ? s.activeIdentityChannelKey : nil,
      activeChannelPublished: s.activeChannelPublished
    )
  }
}

// MARK: - Video Stats

/// Presentation-layer video stats converted from the generated ``GetVideoStatsResponse``.
struct NativeVideoStats: Equatable {
  let success: Bool
  let status: String?
  let progress: Int
  let totalBlocks: Int
  let downloadedBlocks: Int
  let totalBytes: Int
  let downloadedBytes: Int
  let peerCount: Int
  let swarmConnections: Int
  let speedMBps: String
  let uploadSpeedMBps: String?
  let elapsed: Int
  let isComplete: Bool
  let error: String?

  init(schema s: VideoStats) {
    self.success = true
    self.status = s.status?.isEmpty == false ? s.status : nil
    self.progress = Int(s.progress ?? 0)
    self.totalBlocks = Int(s.totalBlocks ?? 0)
    self.downloadedBlocks = Int(s.downloadedBlocks ?? 0)
    self.totalBytes = Int(s.totalBytes ?? 0)
    self.downloadedBytes = Int(s.downloadedBytes ?? 0)
    self.peerCount = Int(s.peerCount ?? 0)
    self.swarmConnections = 0
    self.speedMBps = s.speedMBps ?? "0"
    self.uploadSpeedMBps = s.uploadSpeedMBps?.isEmpty == false ? s.uploadSpeedMBps : nil
    self.elapsed = Int(s.elapsed ?? 0)
    self.isComplete = s.isComplete
    self.error = nil
  }

  init(error: String) {
    self.success = false
    self.status = nil
    self.progress = 0
    self.totalBlocks = 0
    self.downloadedBlocks = 0
    self.totalBytes = 0
    self.downloadedBytes = 0
    self.peerCount = 0
    self.swarmConnections = 0
    self.speedMBps = "0"
    self.uploadSpeedMBps = nil
    self.elapsed = 0
    self.isComplete = false
    self.error = error
  }
}

// MARK: - MPV State

struct NativeMpvState: Equatable {
  let success: Bool
  let currentTime: Double
  let duration: Double
  let paused: Bool
  let error: String?

  init(schema s: MpvStateResponse) {
    self.success = s.success
    self.currentTime = s.currentTime.flatMap { Double($0) } ?? 0
    self.duration = s.duration.flatMap { Double($0) } ?? 0
    self.paused = s.paused
    self.error = s.error?.isEmpty == false ? s.error : nil
  }
}

// MARK: - MPV Render Frame

struct NativeMpvRenderFrame: Equatable {
  let success: Bool
  let hasFrame: Bool
  let width: Int
  let height: Int
  let frameData: Data?
  let error: String?

  init(schema s: MpvRenderFrameResponse) {
    self.success = s.success
    self.hasFrame = s.hasFrame
    self.width = Int(s.width ?? 0)
    self.height = Int(s.height ?? 0)
    self.frameData = s.frameData.flatMap { $0.isEmpty ? nil : $0 }
    self.error = s.error?.isEmpty == false ? s.error : nil
  }
}

// MARK: - Upload Progress Event

struct NativeUploadProgressEvent: Equatable {
  let videoId: String
  let progress: Int
  let bytesUploaded: Int?
  let totalBytes: Int?
  let speed: Int?
  let eta: Int?

  init(schema s: EventUploadProgress) {
    self.videoId = s.videoId
    self.progress = Int(s.progress)
    self.bytesUploaded = s.bytesUploaded.flatMap { $0 > 0 ? Int($0) : nil }
    self.totalBytes = s.totalBytes.flatMap { $0 > 0 ? Int($0) : nil }
    self.speed = s.speed.flatMap { $0 > 0 ? Int($0) : nil }
    self.eta = s.eta.flatMap { $0 > 0 ? Int($0) : nil }
  }
}

// MARK: - Comment / Reaction type aliases

/// Use the generated Schema types directly for comments and reactions.
typealias NativeComment = Comment
typealias NativeListCommentsResponse = ListCommentsResponse
typealias NativeAddCommentResponse = AddCommentResponse
typealias NativeHideCommentResponse = HideCommentResponse
typealias NativeRemoveCommentResponse = RemoveCommentResponse
typealias NativeAddReactionResponse = AddReactionResponse
typealias NativeRemoveReactionResponse = RemoveReactionResponse
typealias NativeGetReactionsResponse = GetReactionsResponse
typealias NativeReactionCount = ReactionCount

// MARK: - Channel Meta

struct NativeChannelMeta: Equatable {
  let channelKey: String
  let publicBeeKey: String?
  let avatarURL: String?
  let name: String?
  let description: String?
  let videoCount: Int?

  init(channelKey: String, schema s: GetChannelMetaResponse) {
    self.channelKey = channelKey
    self.publicBeeKey = nil
    self.avatarURL = nil
    self.name = s.name?.isEmpty == false ? s.name : nil
    self.description = s.description?.isEmpty == false ? s.description : nil
    self.videoCount = s.videoCount.flatMap { $0 > 0 ? Int($0) : nil }
  }
}

// MARK: - Resolve Thumbnail

struct NativeThumbnailResolution: Equatable {
  let videoId: String
  let url: String?
  let exists: Bool

  init(schema s: GetVideoThumbnailResponse) {
    self.videoId = ""
    self.url = s.url?.isEmpty == false ? s.url : nil
    self.exists = s.exists
  }
}

// MARK: - Mutation Response helper

struct NativeMutationResult: Equatable {
  let success: Bool
  let error: String?
}
