import CompactEncoding
import Foundation

enum DecodedMessage {
  case request(RequestMessage)
  case response(ResponseMessage)
  case stream(StreamMessage)
}

struct RequestMessage {
  let id: UInt
  let command: UInt
  let stream: UInt
  let data: Data?
}

struct StreamMessage {
  let id: UInt
  let flags: UInt
  let data: Data?
  let error: RPCRemoteError?
}

struct ResponseMessage {
  let id: UInt
  let stream: UInt
  let result: ResponseResult
}

enum ResponseResult {
  case success(Data?)
  case remoteError(message: String, code: String, errno: Int)
}

struct RequestMessageCodec: Codec {
  typealias Value = RequestMessage

  func preencode(_ state: inout State, _ value: RequestMessage) {
    Primitive.UInt().preencode(&state, value.id)
    Primitive.UInt().preencode(&state, value.command)
    Primitive.UInt().preencode(&state, value.stream)
    if value.stream == 0 {
      Primitive.Buffer().preencode(&state, value.data ?? Data())
    }
  }

  func encode(_ state: inout State, _ value: RequestMessage) throws {
    try Primitive.UInt().encode(&state, value.id)
    try Primitive.UInt().encode(&state, value.command)
    try Primitive.UInt().encode(&state, value.stream)
    if value.stream == 0 {
      try Primitive.Buffer().encode(&state, value.data ?? Data())
    }
  }

  func decode(_ state: inout State) throws -> RequestMessage {
    let id = try Primitive.UInt().decode(&state)
    let command = try Primitive.UInt().decode(&state)
    let stream = try Primitive.UInt().decode(&state)
    if stream == 0 {
      let raw = try Primitive.Buffer().decode(&state)
      return RequestMessage(id: id, command: command, stream: stream, data: raw.isEmpty ? nil : raw)
    }
    return RequestMessage(id: id, command: command, stream: stream, data: nil)
  }
}

struct ResponseMessageCodec: Codec {
  typealias Value = ResponseMessage

  func preencode(_ state: inout State, _ value: ResponseMessage) {
    Primitive.UInt().preencode(&state, value.id)
    switch value.result {
    case .success(let data):
      Primitive.Bool().preencode(&state, false)
      Primitive.UInt().preencode(&state, value.stream)
      if value.stream == 0 {
        Primitive.Buffer().preencode(&state, data ?? Data())
      }
    case .remoteError(let message, let code, let errno):
      Primitive.Bool().preencode(&state, true)
      Primitive.UInt().preencode(&state, value.stream)
      Primitive.UTF8().preencode(&state, message)
      Primitive.UTF8().preencode(&state, code)
      Primitive.Int().preencode(&state, errno)
    }
  }

  func encode(_ state: inout State, _ value: ResponseMessage) throws {
    try Primitive.UInt().encode(&state, value.id)
    switch value.result {
    case .success(let data):
      try Primitive.Bool().encode(&state, false)
      try Primitive.UInt().encode(&state, value.stream)
      if value.stream == 0 {
        try Primitive.Buffer().encode(&state, data ?? Data())
      }
    case .remoteError(let message, let code, let errno):
      try Primitive.Bool().encode(&state, true)
      try Primitive.UInt().encode(&state, value.stream)
      try Primitive.UTF8().encode(&state, message)
      try Primitive.UTF8().encode(&state, code)
      try Primitive.Int().encode(&state, errno)
    }
  }

  func decode(_ state: inout State) throws -> ResponseMessage {
    let id = try Primitive.UInt().decode(&state)
    let isErr = try Primitive.Bool().decode(&state)
    let stream = try Primitive.UInt().decode(&state)
    if isErr {
      let message = try Primitive.UTF8().decode(&state)
      let code = try Primitive.UTF8().decode(&state)
      let errnoValue = try Primitive.Int().decode(&state)
      return ResponseMessage(
        id: id, stream: stream,
        result: .remoteError(message: message, code: code, errno: errnoValue))
    }
    if stream == 0 {
      let raw = try Primitive.Buffer().decode(&state)
      return ResponseMessage(id: id, stream: stream, result: .success(raw.isEmpty ? nil : raw))
    }
    return ResponseMessage(id: id, stream: stream, result: .success(nil))
  }
}

struct StreamMessageCodec: Codec {
  typealias Value = StreamMessage

  func preencode(_ state: inout State, _ value: StreamMessage) {
    Primitive.UInt().preencode(&state, value.id)
    Primitive.UInt().preencode(&state, value.flags)
    if value.flags & StreamFlag.error != 0 {
      let error = value.error!
      Primitive.UTF8().preencode(&state, error.message)
      Primitive.UTF8().preencode(&state, error.code)
      Primitive.Int().preencode(&state, error.errno)
    } else if value.flags & StreamFlag.data != 0 {
      Primitive.Buffer().preencode(&state, value.data ?? Data())
    }
  }

  func encode(_ state: inout State, _ value: StreamMessage) throws {
    try Primitive.UInt().encode(&state, value.id)
    try Primitive.UInt().encode(&state, value.flags)
    if value.flags & StreamFlag.error != 0 {
      let error = value.error!
      try Primitive.UTF8().encode(&state, error.message)
      try Primitive.UTF8().encode(&state, error.code)
      try Primitive.Int().encode(&state, error.errno)
    } else if value.flags & StreamFlag.data != 0 {
      try Primitive.Buffer().encode(&state, value.data ?? Data())
    }
  }

  func decode(_ state: inout State) throws -> StreamMessage {
    let id = try Primitive.UInt().decode(&state)
    let flags = try Primitive.UInt().decode(&state)
    if flags & StreamFlag.error != 0 {
      let message = try Primitive.UTF8().decode(&state)
      let code = try Primitive.UTF8().decode(&state)
      let errno = try Primitive.Int().decode(&state)
      return StreamMessage(
        id: id, flags: flags, data: nil,
        error: RPCRemoteError(message: message, code: code, errno: errno))
    } else if flags & StreamFlag.data != 0 {
      let raw = try Primitive.Buffer().decode(&state)
      return StreamMessage(id: id, flags: flags, data: raw.isEmpty ? nil : raw, error: nil)
    }
    return StreamMessage(id: id, flags: flags, data: nil, error: nil)
  }
}

struct DecodedMessageCodec: Codec {
  typealias Value = DecodedMessage

  func preencode(_ state: inout State, _ value: DecodedMessage) {
    switch value {
    case .request(let req):
      Primitive.UInt().preencode(&state, 1)
      RequestMessageCodec().preencode(&state, req)
    case .response(let resp):
      Primitive.UInt().preencode(&state, 2)
      ResponseMessageCodec().preencode(&state, resp)
    case .stream(let s):
      Primitive.UInt().preencode(&state, 3)
      StreamMessageCodec().preencode(&state, s)
    }
  }

  func encode(_ state: inout State, _ value: DecodedMessage) throws {
    switch value {
    case .request(let req):
      try Primitive.UInt().encode(&state, 1 as UInt)
      try RequestMessageCodec().encode(&state, req)
    case .response(let resp):
      try Primitive.UInt().encode(&state, 2 as UInt)
      try ResponseMessageCodec().encode(&state, resp)
    case .stream(let s):
      try Primitive.UInt().encode(&state, 3 as UInt)
      try StreamMessageCodec().encode(&state, s)
    }
  }

  func decode(_ state: inout State) throws -> DecodedMessage {
    let messageType = try Primitive.UInt().decode(&state)
    switch messageType {
    case 1: return .request(try RequestMessageCodec().decode(&state))
    case 2: return .response(try ResponseMessageCodec().decode(&state))
    case 3: return .stream(try StreamMessageCodec().decode(&state))
    default: throw MessagesError.unknownMessageType
    }
  }
}

struct FrameCodec: Codec {
  typealias Value = DecodedMessage?

  func preencode(_ state: inout State, _ value: DecodedMessage?) {
    guard let value else { return }
    Primitive.UInt32().preencode(&state, 0)
    DecodedMessageCodec().preencode(&state, value)
  }

  func encode(_ state: inout State, _ value: DecodedMessage?) throws {
    guard let value else { return }
    var bodyState = State()
    DecodedMessageCodec().preencode(&bodyState, value)
    try Primitive.UInt32().encode(&state, UInt32(bodyState.end))
    try DecodedMessageCodec().encode(&state, value)
  }

  func decode(_ state: inout State) throws -> DecodedMessage? {
    _ = try Primitive.UInt32().decode(&state)
    do {
      return try DecodedMessageCodec().decode(&state)
    } catch MessagesError.unknownMessageType {
      return nil
    }
  }
}

enum Messages {

  private static func encodeFrame(_ msg: DecodedMessage) -> Data {
    var state = State()
    FrameCodec().preencode(&state, msg)
    state.allocate()
    try! FrameCodec().encode(&state, msg)
    return state.buffer
  }

  static func encodeRequest(id: UInt, command: UInt, stream: UInt = 0, data: Data?) -> Data {
    encodeFrame(.request(RequestMessage(id: id, command: command, stream: stream, data: data)))
  }

  static func encodeEvent(command: UInt, data: Data?) -> Data {
    encodeRequest(id: 0, command: command, data: data)
  }

  static func encodeResponse(id: UInt, stream: UInt = 0, data: Data?) -> Data {
    encodeFrame(.response(ResponseMessage(id: id, stream: stream, result: .success(data))))
  }

  static func encodeErrorResponse(
    id: UInt, message: String, code: String, errno: Int = 0
  ) -> Data {
    encodeFrame(
      .response(
        ResponseMessage(
          id: id, stream: 0,
          result: .remoteError(message: message, code: code, errno: errno))))
  }

  static func encodeStream(
    id: UInt, flags: UInt, data: Data? = nil, error: RPCRemoteError? = nil
  ) -> Data {
    encodeFrame(.stream(StreamMessage(id: id, flags: flags, data: data, error: error)))
  }

  static func decodeFrame(_ frame: Data) throws -> DecodedMessage? {
    var state = State(frame)
    return try FrameCodec().decode(&state)
  }
}

enum MessagesError: Error {
  case unknownMessageType
}
