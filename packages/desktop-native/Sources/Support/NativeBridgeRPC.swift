import CompactEncoding
import Foundation

enum NativeBridgeCommand: UInt {
  case bootstrap = 1
  case refreshBrowse = 2
  case resolvePlayback = 3
  case shutdown = 4
  case searchVideos = 5
  case createIdentity = 6
  case refreshFeed = 7
  case publishActiveChannel = 8
  case subscribeChannel = 9
  case unsubscribeChannel = 10
  case uploadVideo = 11
  case resolveThumbnail = 12
  case mpvAvailable = 13
  case mpvCreate = 14
  case mpvLoadFile = 15
  case mpvPlay = 16
  case mpvPause = 17
  case mpvSeek = 18
  case mpvGetState = 19
  case mpvRenderFrame = 20
  case mpvDestroy = 21
  case getVideoStats = 22
  case addComment = 23
  case listComments = 24
  case hideComment = 25
  case removeComment = 26
  case addReaction = 27
  case removeReaction = 28
  case getReactions = 29
  case getChannelMeta = 30
  case listChannelVideos = 31
  case updateChannel = 32
  case updateChannelAvatar = 33
  case updateVideoMetadata = 34
  case deleteVideo = 35
  case setVideoThumbnailFromFile = 36
  case ffmpegDecodeAvailable = 37
}

enum NativeBridgeEventCommand: UInt {
  case hostReady = 1
  case hostError = 2
  case hostLog = 3
  case workletReady = 4
  case feedUpdated = 5
  case uploadProgress = 6
}

struct NativeBridgePushRequest: Equatable {
  let command: UInt
  let data: Data?
}

struct NativeBridgeBootstrapRequest: Equatable {
  let storagePath: String
}

struct NativeBridgeBootstrapResponse: Equatable {
  let blobServerPort: Int?
  let protocolVersion: Int
  let storagePath: String
  let snapshot: NativeBrowseSnapshot
}

struct NativeBridgeShutdownResponse: Equatable {
  let success: Bool
}

struct NativeBridgeResolvePlaybackRequest: Equatable {
  let channelKey: String
  let publicBeeKey: String?
  let videoId: String
  let videoPath: String?
  let blobId: String?
  let blobsCoreKey: String?
  let mimeType: String?
}

struct NativeBridgeResolvePlaybackResponse: Equatable {
  let videoId: String
  let url: String
}

struct NativeBridgeVideoStatsRequest: Equatable {
  let channelKey: String
  let videoId: String
  let videoPath: String?
}

struct NativeBridgeVideoStatsResponse: Equatable {
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
}

struct NativeBridgeAddCommentRequest: Equatable {
  let channelKey: String
  let videoId: String
  let text: String
  let parentId: String?
  let authorChannelKey: String?
  let publicBeeKey: String?
}

struct NativeBridgeAddCommentResponse: Equatable {
  let success: Bool
  let commentId: String?
  let queued: Bool
  let error: String?
}

struct NativeBridgeListCommentsRequest: Equatable {
  let channelKey: String
  let videoId: String
  let page: Int
  let limit: Int
  let publicBeeKey: String?
}

struct NativeBridgeComment: Equatable {
  let videoId: String
  let commentId: String
  let text: String
  let authorKeyHex: String
  let timestamp: Int
  let parentId: String?
  let isAdmin: Bool
}

struct NativeBridgeListCommentsResponse: Equatable {
  let success: Bool
  let comments: [NativeBridgeComment]
  let error: String?
}

struct NativeBridgeCommentModerationRequest: Equatable {
  let channelKey: String
  let videoId: String
  let commentId: String
  let authorChannelKey: String?
  let publicBeeKey: String?
}

struct NativeBridgeHideCommentResponse: Equatable {
  let success: Bool
  let error: String?
}

struct NativeBridgeRemoveCommentResponse: Equatable {
  let success: Bool
  let queued: Bool
  let error: String?
}

struct NativeBridgeAddReactionRequest: Equatable {
  let channelKey: String
  let videoId: String
  let reactionType: String
  let authorChannelKey: String?
  let publicBeeKey: String?
}

struct NativeBridgeReactionRequest: Equatable {
  let channelKey: String
  let videoId: String
  let authorChannelKey: String?
  let publicBeeKey: String?
}

struct NativeBridgeReactionMutationResponse: Equatable {
  let success: Bool
  let queued: Bool
  let error: String?
}

struct NativeBridgeReactionCount: Equatable {
  let reactionType: String
  let count: Int
}

struct NativeBridgeGetReactionsResponse: Equatable {
  let success: Bool
  let counts: [NativeBridgeReactionCount]
  let userReaction: String?
  let error: String?
}

struct NativeBridgeResolveThumbnailRequest: Equatable {
  let channelKey: String
  let publicBeeKey: String?
  let videoId: String
  let videoPath: String?
}

struct NativeBridgeResolveThumbnailResponse: Equatable {
  let videoId: String
  let url: String?
  let exists: Bool
}

struct NativeBridgeSearchRequest: Equatable {
  let query: String
  let topK: Int
}

struct NativeBridgeSearchResponse: Equatable {
  let query: String
  let results: [NativeVideo]
}

struct NativeBridgeCreateIdentityRequest: Equatable {
  let name: String
}

struct NativeBridgeSubscribeRequest: Equatable {
  let channelKey: String
}

struct NativeBridgeUploadVideoRequest: Equatable {
  let filePath: String
  let title: String
  let description: String
  let category: String?
}

struct NativeBridgeGetChannelMetaRequest: Equatable {
  let channelKey: String
  let publicBeeKey: String?
}

struct NativeBridgeGetChannelMetaResponse: Equatable {
  let channelKey: String
  let publicBeeKey: String?
  let avatarURL: String?
  let name: String?
  let description: String?
  let videoCount: Int?
}

struct NativeBridgeListChannelVideosRequest: Equatable {
  let channelKey: String
  let publicBeeKey: String?
}

struct NativeBridgeListChannelVideosResponse: Equatable {
  let channelKey: String
  let videos: [NativeVideo]
}

struct NativeBridgeUpdateChannelRequest: Equatable {
  let name: String?
  let description: String?
}

struct NativeBridgeUpdateChannelAvatarRequest: Equatable {
  let filePath: String
  let mimeType: String?
}

struct NativeBridgeUpdateVideoMetadataRequest: Equatable {
  let channelKey: String
  let videoId: String
  let title: String?
  let description: String?
  let category: String?
}

struct NativeBridgeDeleteVideoRequest: Equatable {
  let channelKey: String
  let videoId: String
}

struct NativeBridgeSetVideoThumbnailFromFileRequest: Equatable {
  let videoId: String
  let filePath: String
}

struct NativeBridgeMutationResponse: Equatable {
  let success: Bool
  let error: String?
}

struct NativeBridgeHostReadyEvent: Equatable {
  let blobServerPort: Int?
}

struct NativeBridgeHostMessageEvent: Equatable {
  let message: String
}

struct NativeBridgeWorkletReadyEvent: Equatable {
  let stage: String
}

struct NativeBridgeFeedUpdatedEvent: Equatable {
  let channelKey: String
  let action: String
}

struct NativeBridgeUploadProgressEvent: Equatable {
  let videoId: String
  let progress: Int
  let bytesUploaded: Int?
  let totalBytes: Int?
  let speed: Int?
  let eta: Int?
}

struct NativeBridgeMpvAvailableResponse: Equatable {
  let available: Bool
  let error: String?
}

struct NativeBridgeFFmpegDecodeAvailableResponse: Equatable {
  let available: Bool
  let error: String?
}

struct NativeBridgeMpvCreateRequest: Equatable {
  let width: Int
  let height: Int
}

struct NativeBridgeMpvCreateResponse: Equatable {
  let success: Bool
  let playerId: String?
  let frameServerPort: Int?
  let error: String?
}

struct NativeBridgeMpvLoadFileRequest: Equatable {
  let playerId: String
  let url: String
}

struct NativeBridgeMpvPlayerRequest: Equatable {
  let playerId: String
}

struct NativeBridgeMpvPlayerResponse: Equatable {
  let success: Bool
  let error: String?
}

struct NativeBridgeMpvSeekRequest: Equatable {
  let playerId: String
  let time: Double
}

struct NativeBridgeMpvStateResponse: Equatable {
  let success: Bool
  let currentTime: Double
  let duration: Double
  let paused: Bool
  let error: String?
}

struct NativeBridgeMpvRenderFrameResponse: Equatable {
  let success: Bool
  let hasFrame: Bool
  let width: Int
  let height: Int
  let frameData: Data?
  let error: String?
}

enum NativeBridgePayload {
  static func encode<C: Codec>(_ codec: C, value: C.Value) throws -> Data {
    var state = State()
    codec.preencode(&state, value)
    state.allocate()
    try codec.encode(&state, value)
    return state.buffer
  }

  static func decode<C: Codec>(_ codec: C, from data: Data?) throws -> C.Value {
    guard let data else {
      throw NativeBridgePayloadError.missingPayload
    }

    var state = State(data)
    return try codec.decode(&state)
  }

  static func decodeIfPresent<C: Codec>(_ codec: C, from data: Data?) throws -> C.Value? {
    guard let data else { return nil }
    var state = State(data)
    return try codec.decode(&state)
  }
}

enum NativeBridgePayloadError: LocalizedError {
  case missingPayload
  case invalidAppSection(String)
  case negativeUInt(Int)

  var errorDescription: String? {
    switch self {
    case .missingPayload:
      return "Native bridge response payload was missing."
    case .invalidAppSection(let rawValue):
      return "Native bridge sent an unknown app section: \(rawValue)"
    case .negativeUInt(let value):
      return "Native bridge tried to encode a negative unsigned value: \(value)"
    }
  }
}

struct NativeSidecarEvent {
  let command: UInt
  let data: Data?
}

enum NativeSidecarFrame {
  case event(NativeSidecarEvent)
  case response(Data)
}

final class NativeSidecarFrameParser {
  private var pending = Data()
  private let maxFrameBodyLength: Int

  init(maxFrameBodyLength: Int = 16 * 1024 * 1024) {
    self.maxFrameBodyLength = maxFrameBodyLength
  }

  func push(_ chunk: Data) throws -> [NativeSidecarFrame] {
    if !chunk.isEmpty {
      pending.append(chunk)
    }

    var frames: [NativeSidecarFrame] = []

    while true {
      guard let frame = try nextFrame() else { break }
      frames.append(frame)
    }

    return frames
  }

  private func nextFrame() throws -> NativeSidecarFrame? {
    while pending.count >= 4 {
      let bodyLength = Int(pending.readUInt32LE(at: 0))
      if bodyLength > maxFrameBodyLength {
        pending.removeFirst(1)
        continue
      }

      let frameLength = bodyLength + 4
      guard pending.count >= frameLength else { return nil }

      let candidate = Data(pending.prefix(frameLength))

      do {
        guard let message = try NativeSidecarRPCWire.decodeFrame(candidate) else {
          pending.removeFirst(frameLength)
          continue
        }

        pending.removeFirst(frameLength)

        switch message {
        case .request(let request):
          guard request.id == 0 else { continue }
          return .event(NativeSidecarEvent(command: request.command, data: request.data))
        case .response:
          return .response(candidate)
        }
      } catch {
        pending.removeFirst(1)
      }
    }

    return nil
  }
}

enum NativeSidecarRPCWire {
  static func encodeRequestFrame(id: UInt, command: UInt, data: Data?) throws -> Data {
    try encodeFrame(.request(NativeSidecarRequestMessage(id: id, command: command, data: data)))
  }

  static func decodeFrame(_ frame: Data) throws -> NativeSidecarDecodedMessage? {
    guard frame.count >= 4 else {
      throw NativeSidecarRPCWireError.frameTooShort
    }

    let bodyLength = Int(frame.readUInt32LE(at: 0))
    guard bodyLength == frame.count - 4 else {
      throw NativeSidecarRPCWireError.invalidLengthPrefix
    }

    var state = State(Data(frame.dropFirst(4)))
    do {
      return try NativeSidecarDecodedMessageCodec().decode(&state)
    } catch NativeSidecarRPCWireError.streamingNotSupported {
      return nil
    } catch NativeSidecarRPCWireError.unknownMessageType {
      return nil
    }
  }

  private static func encodeFrame(_ message: NativeSidecarDecodedMessage) throws -> Data {
    var bodyState = State()
    NativeSidecarDecodedMessageCodec().preencode(&bodyState, message)
    bodyState.allocate()
    try NativeSidecarDecodedMessageCodec().encode(&bodyState, message)

    var frameState = State()
    Primitive.UInt32().preencode(&frameState, UInt32(bodyState.buffer.count))
    frameState.end += bodyState.buffer.count
    frameState.allocate()
    try Primitive.UInt32().encode(&frameState, UInt32(bodyState.buffer.count))
    frameState.buffer.replaceSubrange(4..<(4 + bodyState.buffer.count), with: bodyState.buffer)
    return frameState.buffer
  }
}

enum NativeSidecarDecodedMessage {
  case request(NativeSidecarRequestMessage)
  case response(NativeSidecarResponseMessage)
}

struct NativeSidecarRequestMessage {
  let id: UInt
  let command: UInt
  let data: Data?
}

struct NativeSidecarResponseMessage {
  let id: UInt
  let result: NativeSidecarResponseResult
}

enum NativeSidecarResponseResult {
  case success(Data?)
  case remoteError(message: String, code: String, errno: Int)
}

private struct NativeSidecarRequestMessageCodec: Codec {
  typealias Value = NativeSidecarRequestMessage

  private let uint = Primitive.UInt()
  private let buffer = Primitive.Buffer()

  func preencode(_ state: inout State, _ value: Value) {
    uint.preencode(&state, value.id)
    uint.preencode(&state, value.command)
    uint.preencode(&state, 0)
    buffer.preencode(&state, value.data ?? Data())
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try uint.encode(&state, value.id)
    try uint.encode(&state, value.command)
    try uint.encode(&state, 0 as UInt)
    try buffer.encode(&state, value.data ?? Data())
  }

  func decode(_ state: inout State) throws -> Value {
    let id = try uint.decode(&state)
    let command = try uint.decode(&state)
    let stream = try uint.decode(&state)
    guard stream == 0 else { throw NativeSidecarRPCWireError.streamingNotSupported }
    let raw = try buffer.decode(&state)
    return NativeSidecarRequestMessage(id: id, command: command, data: raw.isEmpty ? nil : raw)
  }
}

private struct NativeSidecarResponseMessageCodec: Codec {
  typealias Value = NativeSidecarResponseMessage

  private let uint = Primitive.UInt()
  private let bool = Primitive.Bool()
  private let buffer = Primitive.Buffer()
  private let string = Primitive.UTF8()
  private let int = Primitive.Int()

  func preencode(_ state: inout State, _ value: Value) {
    uint.preencode(&state, value.id)

    switch value.result {
    case .success(let data):
      bool.preencode(&state, false)
      uint.preencode(&state, 0)
      buffer.preencode(&state, data ?? Data())
    case .remoteError(let message, let code, let errno):
      bool.preencode(&state, true)
      uint.preencode(&state, 0)
      string.preencode(&state, message)
      string.preencode(&state, code)
      int.preencode(&state, errno)
    }
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try uint.encode(&state, value.id)

    switch value.result {
    case .success(let data):
      try bool.encode(&state, false)
      try uint.encode(&state, 0 as UInt)
      try buffer.encode(&state, data ?? Data())
    case .remoteError(let message, let code, let errno):
      try bool.encode(&state, true)
      try uint.encode(&state, 0 as UInt)
      try string.encode(&state, message)
      try string.encode(&state, code)
      try int.encode(&state, errno)
    }
  }

  func decode(_ state: inout State) throws -> Value {
    let id = try uint.decode(&state)
    let isError = try bool.decode(&state)
    let stream = try uint.decode(&state)
    guard stream == 0 else { throw NativeSidecarRPCWireError.streamingNotSupported }

    if isError {
      return NativeSidecarResponseMessage(
        id: id,
        result: .remoteError(
          message: try string.decode(&state),
          code: try string.decode(&state),
          errno: try int.decode(&state)
        )
      )
    }

    let raw = try buffer.decode(&state)
    return NativeSidecarResponseMessage(id: id, result: .success(raw.isEmpty ? nil : raw))
  }
}

private struct NativeSidecarDecodedMessageCodec: Codec {
  typealias Value = NativeSidecarDecodedMessage

  private let uint = Primitive.UInt()

  func preencode(_ state: inout State, _ value: Value) {
    switch value {
    case .request(let request):
      uint.preencode(&state, 1)
      NativeSidecarRequestMessageCodec().preencode(&state, request)
    case .response(let response):
      uint.preencode(&state, 2)
      NativeSidecarResponseMessageCodec().preencode(&state, response)
    }
  }

  func encode(_ state: inout State, _ value: Value) throws {
    switch value {
    case .request(let request):
      try uint.encode(&state, 1 as UInt)
      try NativeSidecarRequestMessageCodec().encode(&state, request)
    case .response(let response):
      try uint.encode(&state, 2 as UInt)
      try NativeSidecarResponseMessageCodec().encode(&state, response)
    }
  }

  func decode(_ state: inout State) throws -> Value {
    switch try uint.decode(&state) {
    case 1:
      return .request(try NativeSidecarRequestMessageCodec().decode(&state))
    case 2:
      return .response(try NativeSidecarResponseMessageCodec().decode(&state))
    default:
      throw NativeSidecarRPCWireError.unknownMessageType
    }
  }
}

private enum NativeSidecarRPCWireError: Error {
  case frameTooShort
  case invalidLengthPrefix
  case streamingNotSupported
  case unknownMessageType
}

private extension Data {
  func readUInt32LE(at offset: Int) -> UInt32 {
    let start = index(startIndex, offsetBy: offset)
    let b0 = UInt32(self[start])
    let b1 = UInt32(self[index(start, offsetBy: 1)]) << 8
    let b2 = UInt32(self[index(start, offsetBy: 2)]) << 16
    let b3 = UInt32(self[index(start, offsetBy: 3)]) << 24
    return b0 | b1 | b2 | b3
  }
}

struct NativeBridgePushRequestCodec: Codec {
  typealias Value = NativeBridgePushRequest

  private let uint = Primitive.UInt()
  private let buffer = Primitive.Buffer()
  private let bool = Primitive.Bool()

  func preencode(_ state: inout State, _ value: Value) {
    uint.preencode(&state, value.command)
    bool.preencode(&state, value.data != nil)
    if let data = value.data {
      buffer.preencode(&state, data)
    }
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try uint.encode(&state, value.command)
    try bool.encode(&state, value.data != nil)
    if let data = value.data {
      try buffer.encode(&state, data)
    }
  }

  func decode(_ state: inout State) throws -> Value {
    let command = try uint.decode(&state)
    let hasData = try bool.decode(&state)
    let data = hasData ? try buffer.decode(&state) : nil
    return NativeBridgePushRequest(command: command, data: data)
  }
}

struct NativeBridgeBootstrapRequestCodec: Codec {
  typealias Value = NativeBridgeBootstrapRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.storagePath)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.storagePath)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(storagePath: try string.decode(&state))
  }
}

struct NativeBridgeBootstrapResponseCodec: Codec {
  typealias Value = NativeBridgeBootstrapResponse

  private let optionalInt = OptionalUIntAsIntCodec()
  private let nonNegativeInt = NonNegativeIntCodec()
  private let string = Primitive.UTF8()
  private let snapshot = NativeBrowseSnapshotCodec()

  func preencode(_ state: inout State, _ value: Value) {
    optionalInt.preencode(&state, value.blobServerPort)
    nonNegativeInt.preencode(&state, value.protocolVersion)
    string.preencode(&state, value.storagePath)
    snapshot.preencode(&state, value.snapshot)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try optionalInt.encode(&state, value.blobServerPort)
    try nonNegativeInt.encode(&state, value.protocolVersion)
    try string.encode(&state, value.storagePath)
    try snapshot.encode(&state, value.snapshot)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      blobServerPort: try optionalInt.decode(&state),
      protocolVersion: try nonNegativeInt.decode(&state),
      storagePath: try string.decode(&state),
      snapshot: try snapshot.decode(&state)
    )
  }
}

struct NativeBridgeResolvePlaybackRequestCodec: Codec {
  typealias Value = NativeBridgeResolvePlaybackRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.videoPath)
    optionalString.preencode(&state, value.blobId)
    optionalString.preencode(&state, value.blobsCoreKey)
    optionalString.preencode(&state, value.mimeType)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.videoPath)
    try optionalString.encode(&state, value.blobId)
    try optionalString.encode(&state, value.blobsCoreKey)
    try optionalString.encode(&state, value.mimeType)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      publicBeeKey: try optionalString.decode(&state),
      videoId: try string.decode(&state),
      videoPath: try optionalString.decode(&state),
      blobId: try optionalString.decode(&state),
      blobsCoreKey: try optionalString.decode(&state),
      mimeType: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeResolvePlaybackResponseCodec: Codec {
  typealias Value = NativeBridgeResolvePlaybackResponse

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.url)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.url)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      videoId: try string.decode(&state),
      url: try string.decode(&state)
    )
  }
}

struct NativeBridgeVideoStatsRequestCodec: Codec {
  typealias Value = NativeBridgeVideoStatsRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.videoPath)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.videoPath)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      videoPath: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeVideoStatsResponseCodec: Codec {
  typealias Value = NativeBridgeVideoStatsResponse

  private let bool = Primitive.Bool()
  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let nonNegativeInt = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.status)
    nonNegativeInt.preencode(&state, value.progress)
    nonNegativeInt.preencode(&state, value.totalBlocks)
    nonNegativeInt.preencode(&state, value.downloadedBlocks)
    nonNegativeInt.preencode(&state, value.totalBytes)
    nonNegativeInt.preencode(&state, value.downloadedBytes)
    nonNegativeInt.preencode(&state, value.peerCount)
    nonNegativeInt.preencode(&state, value.swarmConnections)
    string.preencode(&state, value.speedMBps)
    optionalString.preencode(&state, value.uploadSpeedMBps)
    nonNegativeInt.preencode(&state, value.elapsed)
    bool.preencode(&state, value.isComplete)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.status)
    try nonNegativeInt.encode(&state, value.progress)
    try nonNegativeInt.encode(&state, value.totalBlocks)
    try nonNegativeInt.encode(&state, value.downloadedBlocks)
    try nonNegativeInt.encode(&state, value.totalBytes)
    try nonNegativeInt.encode(&state, value.downloadedBytes)
    try nonNegativeInt.encode(&state, value.peerCount)
    try nonNegativeInt.encode(&state, value.swarmConnections)
    try string.encode(&state, value.speedMBps)
    try optionalString.encode(&state, value.uploadSpeedMBps)
    try nonNegativeInt.encode(&state, value.elapsed)
    try bool.encode(&state, value.isComplete)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      status: try optionalString.decode(&state),
      progress: try nonNegativeInt.decode(&state),
      totalBlocks: try nonNegativeInt.decode(&state),
      downloadedBlocks: try nonNegativeInt.decode(&state),
      totalBytes: try nonNegativeInt.decode(&state),
      downloadedBytes: try nonNegativeInt.decode(&state),
      peerCount: try nonNegativeInt.decode(&state),
      swarmConnections: try nonNegativeInt.decode(&state),
      speedMBps: try string.decode(&state),
      uploadSpeedMBps: try optionalString.decode(&state),
      elapsed: try nonNegativeInt.decode(&state),
      isComplete: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeAddCommentRequestCodec: Codec {
  typealias Value = NativeBridgeAddCommentRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.text)
    optionalString.preencode(&state, value.parentId)
    optionalString.preencode(&state, value.authorChannelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.text)
    try optionalString.encode(&state, value.parentId)
    try optionalString.encode(&state, value.authorChannelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      text: try string.decode(&state),
      parentId: try optionalString.decode(&state),
      authorChannelKey: try optionalString.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeAddCommentResponseCodec: Codec {
  typealias Value = NativeBridgeAddCommentResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.commentId)
    bool.preencode(&state, value.queued)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.commentId)
    try bool.encode(&state, value.queued)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      commentId: try optionalString.decode(&state),
      queued: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeListCommentsRequestCodec: Codec {
  typealias Value = NativeBridgeListCommentsRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let nonNegativeInt = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    nonNegativeInt.preencode(&state, value.page)
    nonNegativeInt.preencode(&state, value.limit)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try nonNegativeInt.encode(&state, value.page)
    try nonNegativeInt.encode(&state, value.limit)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      page: try nonNegativeInt.decode(&state),
      limit: try nonNegativeInt.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeCommentCodec: Codec {
  typealias Value = NativeBridgeComment

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let bool = Primitive.Bool()
  private let nonNegativeInt = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.commentId)
    string.preencode(&state, value.text)
    string.preencode(&state, value.authorKeyHex)
    nonNegativeInt.preencode(&state, value.timestamp)
    optionalString.preencode(&state, value.parentId)
    bool.preencode(&state, value.isAdmin)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.commentId)
    try string.encode(&state, value.text)
    try string.encode(&state, value.authorKeyHex)
    try nonNegativeInt.encode(&state, value.timestamp)
    try optionalString.encode(&state, value.parentId)
    try bool.encode(&state, value.isAdmin)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      videoId: try string.decode(&state),
      commentId: try string.decode(&state),
      text: try string.decode(&state),
      authorKeyHex: try string.decode(&state),
      timestamp: try nonNegativeInt.decode(&state),
      parentId: try optionalString.decode(&state),
      isAdmin: try bool.decode(&state)
    )
  }
}

struct NativeBridgeListCommentsResponseCodec: Codec {
  typealias Value = NativeBridgeListCommentsResponse

  private let bool = Primitive.Bool()
  private let comments = Primitive.Array(NativeBridgeCommentCodec())
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    comments.preencode(&state, value.comments)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try comments.encode(&state, value.comments)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      comments: try comments.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeCommentModerationRequestCodec: Codec {
  typealias Value = NativeBridgeCommentModerationRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.commentId)
    optionalString.preencode(&state, value.authorChannelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.commentId)
    try optionalString.encode(&state, value.authorChannelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      commentId: try string.decode(&state),
      authorChannelKey: try optionalString.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeHideCommentResponseCodec: Codec {
  typealias Value = NativeBridgeHideCommentResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(success: try bool.decode(&state), error: try optionalString.decode(&state))
  }
}

struct NativeBridgeRemoveCommentResponseCodec: Codec {
  typealias Value = NativeBridgeRemoveCommentResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    bool.preencode(&state, value.queued)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try bool.encode(&state, value.queued)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      queued: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeAddReactionRequestCodec: Codec {
  typealias Value = NativeBridgeAddReactionRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.reactionType)
    optionalString.preencode(&state, value.authorChannelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.reactionType)
    try optionalString.encode(&state, value.authorChannelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      reactionType: try string.decode(&state),
      authorChannelKey: try optionalString.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeReactionRequestCodec: Codec {
  typealias Value = NativeBridgeReactionRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.authorChannelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.authorChannelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      authorChannelKey: try optionalString.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeReactionMutationResponseCodec: Codec {
  typealias Value = NativeBridgeReactionMutationResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    bool.preencode(&state, value.queued)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try bool.encode(&state, value.queued)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      queued: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeReactionCountCodec: Codec {
  typealias Value = NativeBridgeReactionCount

  private let string = Primitive.UTF8()
  private let nonNegativeInt = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.reactionType)
    nonNegativeInt.preencode(&state, value.count)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.reactionType)
    try nonNegativeInt.encode(&state, value.count)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      reactionType: try string.decode(&state),
      count: try nonNegativeInt.decode(&state)
    )
  }
}

struct NativeBridgeGetReactionsResponseCodec: Codec {
  typealias Value = NativeBridgeGetReactionsResponse

  private let bool = Primitive.Bool()
  private let counts = Primitive.Array(NativeBridgeReactionCountCodec())
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    counts.preencode(&state, value.counts)
    optionalString.preencode(&state, value.userReaction)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try counts.encode(&state, value.counts)
    try optionalString.encode(&state, value.userReaction)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      counts: try counts.decode(&state),
      userReaction: try optionalString.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeResolveThumbnailRequestCodec: Codec {
  typealias Value = NativeBridgeResolveThumbnailRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.videoPath)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.videoPath)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      publicBeeKey: try optionalString.decode(&state),
      videoId: try string.decode(&state),
      videoPath: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeResolveThumbnailResponseCodec: Codec {
  typealias Value = NativeBridgeResolveThumbnailResponse

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let bool = Primitive.Bool()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.url)
    bool.preencode(&state, value.exists)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.url)
    try bool.encode(&state, value.exists)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      videoId: try string.decode(&state),
      url: try optionalString.decode(&state),
      exists: try bool.decode(&state)
    )
  }
}

struct NativeBridgeSearchRequestCodec: Codec {
  typealias Value = NativeBridgeSearchRequest

  private let string = Primitive.UTF8()
  private let count = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.query)
    count.preencode(&state, value.topK)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.query)
    try count.encode(&state, value.topK)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      query: try string.decode(&state),
      topK: try count.decode(&state)
    )
  }
}

struct NativeBridgeSearchResponseCodec: Codec {
  typealias Value = NativeBridgeSearchResponse

  private let string = Primitive.UTF8()
  private let videos = Primitive.Array(NativeVideoCodec())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.query)
    videos.preencode(&state, value.results)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.query)
    try videos.encode(&state, value.results)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      query: try string.decode(&state),
      results: try videos.decode(&state)
    )
  }
}

struct NativeBridgeCreateIdentityRequestCodec: Codec {
  typealias Value = NativeBridgeCreateIdentityRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.name)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.name)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(name: try string.decode(&state))
  }
}

struct NativeBridgeSubscribeRequestCodec: Codec {
  typealias Value = NativeBridgeSubscribeRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(channelKey: try string.decode(&state))
  }
}

struct NativeBridgeUploadVideoRequestCodec: Codec {
  typealias Value = NativeBridgeUploadVideoRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.filePath)
    string.preencode(&state, value.title)
    string.preencode(&state, value.description)
    optionalString.preencode(&state, value.category)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.filePath)
    try string.encode(&state, value.title)
    try string.encode(&state, value.description)
    try optionalString.encode(&state, value.category)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      filePath: try string.decode(&state),
      title: try string.decode(&state),
      description: try string.decode(&state),
      category: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeGetChannelMetaRequestCodec: Codec {
  typealias Value = NativeBridgeGetChannelMetaRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeGetChannelMetaResponseCodec: Codec {
  typealias Value = NativeBridgeGetChannelMetaResponse

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let optionalInt = OptionalUIntAsIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
    optionalString.preencode(&state, value.avatarURL)
    optionalString.preencode(&state, value.name)
    optionalString.preencode(&state, value.description)
    optionalInt.preencode(&state, value.videoCount)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
    try optionalString.encode(&state, value.avatarURL)
    try optionalString.encode(&state, value.name)
    try optionalString.encode(&state, value.description)
    try optionalInt.encode(&state, value.videoCount)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      publicBeeKey: try optionalString.decode(&state),
      avatarURL: try optionalString.decode(&state),
      name: try optionalString.decode(&state),
      description: try optionalString.decode(&state),
      videoCount: try optionalInt.decode(&state)
    )
  }
}

struct NativeBridgeListChannelVideosRequestCodec: Codec {
  typealias Value = NativeBridgeListChannelVideosRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      publicBeeKey: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeListChannelVideosResponseCodec: Codec {
  typealias Value = NativeBridgeListChannelVideosResponse

  private let string = Primitive.UTF8()
  private let videos = Primitive.Array(NativeVideoCodec())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    videos.preencode(&state, value.videos)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try videos.encode(&state, value.videos)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videos: try videos.decode(&state)
    )
  }
}

struct NativeBridgeUpdateChannelRequestCodec: Codec {
  typealias Value = NativeBridgeUpdateChannelRequest

  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    optionalString.preencode(&state, value.name)
    optionalString.preencode(&state, value.description)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try optionalString.encode(&state, value.name)
    try optionalString.encode(&state, value.description)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      name: try optionalString.decode(&state),
      description: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeUpdateChannelAvatarRequestCodec: Codec {
  typealias Value = NativeBridgeUpdateChannelAvatarRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.filePath)
    optionalString.preencode(&state, value.mimeType)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.filePath)
    try optionalString.encode(&state, value.mimeType)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      filePath: try string.decode(&state),
      mimeType: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeUpdateVideoMetadataRequestCodec: Codec {
  typealias Value = NativeBridgeUpdateVideoMetadataRequest

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
    optionalString.preencode(&state, value.title)
    optionalString.preencode(&state, value.description)
    optionalString.preencode(&state, value.category)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
    try optionalString.encode(&state, value.title)
    try optionalString.encode(&state, value.description)
    try optionalString.encode(&state, value.category)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state),
      title: try optionalString.decode(&state),
      description: try optionalString.decode(&state),
      category: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeDeleteVideoRequestCodec: Codec {
  typealias Value = NativeBridgeDeleteVideoRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.videoId)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.videoId)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      videoId: try string.decode(&state)
    )
  }
}

struct NativeBridgeSetVideoThumbnailFromFileRequestCodec: Codec {
  typealias Value = NativeBridgeSetVideoThumbnailFromFileRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.videoId)
    string.preencode(&state, value.filePath)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.videoId)
    try string.encode(&state, value.filePath)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      videoId: try string.decode(&state),
      filePath: try string.decode(&state)
    )
  }
}

struct NativeBridgeMutationResponseCodec: Codec {
  typealias Value = NativeBridgeMutationResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeHostReadyEventCodec: Codec {
  typealias Value = NativeBridgeHostReadyEvent

  private let optionalInt = OptionalUIntAsIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    optionalInt.preencode(&state, value.blobServerPort)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try optionalInt.encode(&state, value.blobServerPort)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(blobServerPort: try optionalInt.decode(&state))
  }
}

struct NativeBridgeShutdownResponseCodec: Codec {
  typealias Value = NativeBridgeShutdownResponse

  private let bool = Primitive.Bool()

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(success: try bool.decode(&state))
  }
}

struct NativeBridgeHostMessageEventCodec: Codec {
  typealias Value = NativeBridgeHostMessageEvent

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.message)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.message)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(message: try string.decode(&state))
  }
}

struct NativeBridgeWorkletReadyEventCodec: Codec {
  typealias Value = NativeBridgeWorkletReadyEvent

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.stage)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.stage)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(stage: try string.decode(&state))
  }
}

struct NativeBridgeFeedUpdatedEventCodec: Codec {
  typealias Value = NativeBridgeFeedUpdatedEvent

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.channelKey)
    string.preencode(&state, value.action)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.channelKey)
    try string.encode(&state, value.action)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      channelKey: try string.decode(&state),
      action: try string.decode(&state)
    )
  }
}

struct NativeBridgeUploadProgressEventCodec: Codec {
  typealias Value = NativeBridgeUploadProgressEvent

  private let string = Primitive.UTF8()
  private let count = NonNegativeIntCodec()
  private let optionalInt = OptionalUIntAsIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.videoId)
    count.preencode(&state, value.progress)
    optionalInt.preencode(&state, value.bytesUploaded)
    optionalInt.preencode(&state, value.totalBytes)
    optionalInt.preencode(&state, value.speed)
    optionalInt.preencode(&state, value.eta)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.videoId)
    try count.encode(&state, value.progress)
    try optionalInt.encode(&state, value.bytesUploaded)
    try optionalInt.encode(&state, value.totalBytes)
    try optionalInt.encode(&state, value.speed)
    try optionalInt.encode(&state, value.eta)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      videoId: try string.decode(&state),
      progress: try count.decode(&state),
      bytesUploaded: try optionalInt.decode(&state),
      totalBytes: try optionalInt.decode(&state),
      speed: try optionalInt.decode(&state),
      eta: try optionalInt.decode(&state)
    )
  }
}

struct NativeBridgeMpvAvailableResponseCodec: Codec {
  typealias Value = NativeBridgeMpvAvailableResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.available)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.available)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      available: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeFFmpegDecodeAvailableResponseCodec: Codec {
  typealias Value = NativeBridgeFFmpegDecodeAvailableResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.available)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.available)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      available: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeMpvCreateRequestCodec: Codec {
  typealias Value = NativeBridgeMpvCreateRequest

  private let count = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    count.preencode(&state, value.width)
    count.preencode(&state, value.height)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try count.encode(&state, value.width)
    try count.encode(&state, value.height)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      width: try count.decode(&state),
      height: try count.decode(&state)
    )
  }
}

struct NativeBridgeMpvCreateResponseCodec: Codec {
  typealias Value = NativeBridgeMpvCreateResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let optionalInt = OptionalUIntAsIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.playerId)
    optionalInt.preencode(&state, value.frameServerPort)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.playerId)
    try optionalInt.encode(&state, value.frameServerPort)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      playerId: try optionalString.decode(&state),
      frameServerPort: try optionalInt.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeMpvLoadFileRequestCodec: Codec {
  typealias Value = NativeBridgeMpvLoadFileRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.playerId)
    string.preencode(&state, value.url)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.playerId)
    try string.encode(&state, value.url)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      playerId: try string.decode(&state),
      url: try string.decode(&state)
    )
  }
}

struct NativeBridgeMpvPlayerRequestCodec: Codec {
  typealias Value = NativeBridgeMpvPlayerRequest

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.playerId)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.playerId)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(playerId: try string.decode(&state))
  }
}

struct NativeBridgeMpvPlayerResponseCodec: Codec {
  typealias Value = NativeBridgeMpvPlayerResponse

  private let bool = Primitive.Bool()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeMpvSeekRequestCodec: Codec {
  typealias Value = NativeBridgeMpvSeekRequest

  private let string = Primitive.UTF8()
  private let float = Primitive.Float64()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.playerId)
    float.preencode(&state, value.time)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.playerId)
    try float.encode(&state, value.time)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      playerId: try string.decode(&state),
      time: try float.decode(&state)
    )
  }
}

struct NativeBridgeMpvStateResponseCodec: Codec {
  typealias Value = NativeBridgeMpvStateResponse

  private let bool = Primitive.Bool()
  private let float = Primitive.Float64()
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    float.preencode(&state, value.currentTime)
    float.preencode(&state, value.duration)
    bool.preencode(&state, value.paused)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try float.encode(&state, value.currentTime)
    try float.encode(&state, value.duration)
    try bool.encode(&state, value.paused)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      currentTime: try float.decode(&state),
      duration: try float.decode(&state),
      paused: try bool.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBridgeMpvRenderFrameResponseCodec: Codec {
  typealias Value = NativeBridgeMpvRenderFrameResponse

  private let bool = Primitive.Bool()
  private let count = NonNegativeIntCodec()
  private let optionalData = OptionalCodec(Primitive.Buffer())
  private let optionalString = OptionalCodec(Primitive.UTF8())

  func preencode(_ state: inout State, _ value: Value) {
    bool.preencode(&state, value.success)
    bool.preencode(&state, value.hasFrame)
    count.preencode(&state, value.width)
    count.preencode(&state, value.height)
    optionalData.preencode(&state, value.frameData)
    optionalString.preencode(&state, value.error)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try bool.encode(&state, value.success)
    try bool.encode(&state, value.hasFrame)
    try count.encode(&state, value.width)
    try count.encode(&state, value.height)
    try optionalData.encode(&state, value.frameData)
    try optionalString.encode(&state, value.error)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      success: try bool.decode(&state),
      hasFrame: try bool.decode(&state),
      width: try count.decode(&state),
      height: try count.decode(&state),
      frameData: try optionalData.decode(&state),
      error: try optionalString.decode(&state)
    )
  }
}

struct NativeBrowseSnapshotCodec: Codec {
  typealias Value = NativeBrowseSnapshot

  private let generatedAt = Primitive.Float64()
  private let sections = NativeBrowseSectionsCodec()
  private let stats = NativeBrowseStatsCodec()
  private let stateCodec = NativeBrowseStateCodec()

  func preencode(_ state: inout State, _ value: Value) {
    generatedAt.preencode(&state, value.generatedAt)
    sections.preencode(&state, value.sections)
    stats.preencode(&state, value.stats)
    stateCodec.preencode(&state, value.state)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try generatedAt.encode(&state, value.generatedAt)
    try sections.encode(&state, value.sections)
    try stats.encode(&state, value.stats)
    try stateCodec.encode(&state, value.state)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      generatedAt: try generatedAt.decode(&state),
      sections: try sections.decode(&state),
      stats: try stats.decode(&state),
      state: try stateCodec.decode(&state)
    )
  }
}

private struct NativeBrowseSectionsCodec: Codec {
  typealias Value = NativeBrowseSections

  private let videos = Primitive.Array(NativeVideoCodec())

  func preencode(_ state: inout State, _ value: Value) {
    videos.preencode(&state, value.home)
    videos.preencode(&state, value.subscriptions)
    videos.preencode(&state, value.library)
    videos.preencode(&state, value.studio)
    videos.preencode(&state, value.diagnostics)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try videos.encode(&state, value.home)
    try videos.encode(&state, value.subscriptions)
    try videos.encode(&state, value.library)
    try videos.encode(&state, value.studio)
    try videos.encode(&state, value.diagnostics)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      home: try videos.decode(&state),
      subscriptions: try videos.decode(&state),
      library: try videos.decode(&state),
      studio: try videos.decode(&state),
      diagnostics: try videos.decode(&state)
    )
  }
}

private struct NativeBrowseStatsCodec: Codec {
  typealias Value = NativeBrowseStats

  private let count = NonNegativeIntCodec()

  func preencode(_ state: inout State, _ value: Value) {
    count.preencode(&state, value.homeCount)
    count.preencode(&state, value.subscriptionCount)
    count.preencode(&state, value.libraryCount)
    count.preencode(&state, value.channelCount)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try count.encode(&state, value.homeCount)
    try count.encode(&state, value.subscriptionCount)
    try count.encode(&state, value.libraryCount)
    try count.encode(&state, value.channelCount)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      homeCount: try count.decode(&state),
      subscriptionCount: try count.decode(&state),
      libraryCount: try count.decode(&state),
      channelCount: try count.decode(&state)
    )
  }
}

private struct NativeBrowseStateCodec: Codec {
  typealias Value = NativeBrowseState

  private let strings = Primitive.Array(Primitive.UTF8())
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let bool = Primitive.Bool()

  func preencode(_ state: inout State, _ value: Value) {
    strings.preencode(&state, value.subscriptionChannelKeys)
    strings.preencode(&state, value.identityChannelKeys)
    optionalString.preencode(&state, value.activeIdentityName)
    optionalString.preencode(&state, value.activeIdentityChannelKey)
    bool.preencode(&state, value.activeChannelPublished)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try strings.encode(&state, value.subscriptionChannelKeys)
    try strings.encode(&state, value.identityChannelKeys)
    try optionalString.encode(&state, value.activeIdentityName)
    try optionalString.encode(&state, value.activeIdentityChannelKey)
    try bool.encode(&state, value.activeChannelPublished)
  }

  func decode(_ state: inout State) throws -> Value {
    Value(
      subscriptionChannelKeys: try strings.decode(&state),
      identityChannelKeys: try strings.decode(&state),
      activeIdentityName: try optionalString.decode(&state),
      activeIdentityChannelKey: try optionalString.decode(&state),
      activeChannelPublished: try bool.decode(&state)
    )
  }
}

private struct NativeVideoCodec: Codec {
  typealias Value = NativeVideo

  private let string = Primitive.UTF8()
  private let optionalString = OptionalCodec(Primitive.UTF8())
  private let optionalUInt = OptionalUIntAsIntCodec()
  private let tags = Primitive.Array(Primitive.UTF8())
  private let sections = Primitive.Array(AppSectionCodec())

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.id)
    string.preencode(&state, value.backendVideoID)
    string.preencode(&state, value.channelKey)
    optionalString.preencode(&state, value.publicBeeKey)
    string.preencode(&state, value.title)
    string.preencode(&state, value.channelName)
    string.preencode(&state, value.durationText)
    string.preencode(&state, value.summary)
    tags.preencode(&state, value.tags)
    string.preencode(&state, value.accentHex)
    sections.preencode(&state, value.sections.sorted(by: { $0.rawValue < $1.rawValue }))
    optionalString.preencode(&state, value.thumbnailURL?.absoluteString)
    optionalString.preencode(&state, value.path)
    optionalString.preencode(&state, value.blobId)
    optionalString.preencode(&state, value.blobsCoreKey)
    optionalString.preencode(&state, value.mimeType)
    optionalUInt.preencode(&state, value.width)
    optionalUInt.preencode(&state, value.height)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.id)
    try string.encode(&state, value.backendVideoID)
    try string.encode(&state, value.channelKey)
    try optionalString.encode(&state, value.publicBeeKey)
    try string.encode(&state, value.title)
    try string.encode(&state, value.channelName)
    try string.encode(&state, value.durationText)
    try string.encode(&state, value.summary)
    try tags.encode(&state, value.tags)
    try string.encode(&state, value.accentHex)
    try sections.encode(&state, value.sections.sorted(by: { $0.rawValue < $1.rawValue }))
    try optionalString.encode(&state, value.thumbnailURL?.absoluteString)
    try optionalString.encode(&state, value.path)
    try optionalString.encode(&state, value.blobId)
    try optionalString.encode(&state, value.blobsCoreKey)
    try optionalString.encode(&state, value.mimeType)
    try optionalUInt.encode(&state, value.width)
    try optionalUInt.encode(&state, value.height)
  }

  func decode(_ state: inout State) throws -> Value {
    let id = try string.decode(&state)
    let backendVideoID = try string.decode(&state)
    let channelKey = try string.decode(&state)
    let publicBeeKey = try optionalString.decode(&state)
    let title = try string.decode(&state)
    let channelName = try string.decode(&state)
    let durationText = try string.decode(&state)
    let summary = try string.decode(&state)
    let tagValues = try tags.decode(&state)
    let accentHex = try string.decode(&state)
    let sectionValues = try sections.decode(&state)
    let thumbnail = try optionalString.decode(&state)
    let path = try optionalString.decode(&state)
    let blobId = try optionalString.decode(&state)
    let blobsCoreKey = try optionalString.decode(&state)
    let mimeType = try optionalString.decode(&state)
    let width = try optionalUInt.decode(&state)
    let height = try optionalUInt.decode(&state)

    return Value(
      id: id,
      backendVideoID: backendVideoID,
      channelKey: channelKey,
      publicBeeKey: publicBeeKey,
      title: title,
      channelName: channelName,
      durationText: durationText,
      summary: summary,
      tags: tagValues,
      accentHex: accentHex,
      sections: Set(sectionValues),
      thumbnailURL: thumbnail.flatMap(URL.init(string:)),
      path: path,
      blobId: blobId,
      blobsCoreKey: blobsCoreKey,
      mimeType: mimeType,
      width: width,
      height: height
    )
  }
}

private struct AppSectionCodec: Codec {
  typealias Value = AppSection

  private let string = Primitive.UTF8()

  func preencode(_ state: inout State, _ value: Value) {
    string.preencode(&state, value.rawValue)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try string.encode(&state, value.rawValue)
  }

  func decode(_ state: inout State) throws -> Value {
    let rawValue = try string.decode(&state)
    guard let value = AppSection(rawValue: rawValue) else {
      throw NativeBridgePayloadError.invalidAppSection(rawValue)
    }
    return value
  }
}

private struct OptionalCodec<C: Codec>: Codec {
  typealias Value = C.Value?

  private let wrapped: C
  private let bool = Primitive.Bool()

  init(_ wrapped: C) {
    self.wrapped = wrapped
  }

  func preencode(_ state: inout State, _ value: Value) {
    let hasValue = value != nil
    bool.preencode(&state, hasValue)
    if let value {
      wrapped.preencode(&state, value)
    }
  }

  func encode(_ state: inout State, _ value: Value) throws {
    let hasValue = value != nil
    try bool.encode(&state, hasValue)
    if let value {
      try wrapped.encode(&state, value)
    }
  }

  func decode(_ state: inout State) throws -> Value {
    let hasValue = try bool.decode(&state)
    if !hasValue { return nil }
    return try wrapped.decode(&state)
  }
}

private struct NonNegativeIntCodec: Codec {
  typealias Value = Int

  private let uint = Primitive.UInt()

  func preencode(_ state: inout State, _ value: Value) {
    uint.preencode(&state, Swift.UInt(max(0, value)))
  }

  func encode(_ state: inout State, _ value: Value) throws {
    guard value >= 0 else {
      throw NativeBridgePayloadError.negativeUInt(value)
    }
    try uint.encode(&state, Swift.UInt(value))
  }

  func decode(_ state: inout State) throws -> Value {
    Int(try uint.decode(&state))
  }
}

private struct OptionalUIntAsIntCodec: Codec {
  typealias Value = Int?

  private let wrapped = OptionalCodec(NonNegativeIntCodec())

  func preencode(_ state: inout State, _ value: Value) {
    wrapped.preencode(&state, value)
  }

  func encode(_ state: inout State, _ value: Value) throws {
    try wrapped.encode(&state, value)
  }

  func decode(_ state: inout State) throws -> Value {
    try wrapped.decode(&state)
  }
}
