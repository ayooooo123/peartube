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
}

enum NativeBridgeEventCommand: UInt {
  case hostReady = 1
  case hostError = 2
  case hostLog = 3
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

struct NativeBridgeHostReadyEvent: Equatable {
  let blobServerPort: Int?
}

struct NativeBridgeHostMessageEvent: Equatable {
  let message: String
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
      mimeType: mimeType
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
