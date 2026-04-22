import CompactEncoding
import Foundation

public protocol RPCDelegate: AnyObject, Sendable {
  func rpc(_ rpc: RPC, send data: Data)
  func rpc(_ rpc: RPC, didReceiveRequest request: IncomingRequest) async throws
  func rpc(_ rpc: RPC, didReceiveEvent event: IncomingEvent) async
  func rpc(_ rpc: RPC, didFailWith error: Error)
}

extension RPCDelegate {
  public func rpc(_ rpc: RPC, didReceiveRequest request: IncomingRequest) async throws {}
  public func rpc(_ rpc: RPC, didReceiveEvent event: IncomingEvent) async {}
  public func rpc(_ rpc: RPC, didFailWith error: Error) {}
}

/// Actor-isolated RPC multiplexer. All mutable state (pending continuations,
/// in-flight streams, read buffer, id counter) lives on the actor executor,
/// so concurrent callers of ``request`` and the framer's ``receive`` no longer
/// tear the Dictionary internals apart. Public entry points are implicitly
/// `async` when called from outside the actor.
public actor RPC {
  private var buffer = Data()
  private var nextId: UInt = 1
  private var pending: [UInt: CheckedContinuation<Data?, Error>] = [:]
  private var pendingResponseStreams: [UInt: CheckedContinuation<IncomingStream, Error>] = [:]
  private var incomingStreams: [UInt: IncomingStream] = [:]
  private var outgoingStreams: [UInt: OutgoingStream] = [:]

  // Delegate is held in a Sendable weak-reference box so that nonisolated send
  // paths (OutgoingStream writer closures) can dispatch to the delegate
  // without hopping through the actor. Only short, stateless operations read
  // through the box; all state mutations stay actor-isolated.
  private let delegateBox = WeakDelegateBox()

  public var delegate: RPCDelegate? {
    get { delegateBox.value }
  }

  public func setDelegate(_ delegate: RPCDelegate?) {
    delegateBox.value = delegate
  }

  public init(delegate: RPCDelegate? = nil) {
    delegateBox.value = delegate
  }

  public func request(_ command: UInt, data: Data? = nil) async throws -> Data? {
    let id = nextId
    nextId = (nextId % 0xFFFF_FFFE) + 1
    let frame = Messages.encodeRequest(id: id, command: command, data: data)
    return try await withCheckedThrowingContinuation { continuation in
      pending[id] = continuation
      delegateBox.value?.rpc(self, send: frame)
    }
  }

  // event() is fire-and-forget and touches no actor-mutable state, so we mark
  // it nonisolated. Lets HRPC's generated eventXXX methods stay synchronous.
  nonisolated public func event(_ command: UInt, data: Data? = nil) {
    let frame = Messages.encodeEvent(command: command, data: data)
    delegateBox.value?.rpc(self, send: frame)
  }

  public func createRequestStream(command: UInt) -> OutgoingStream {
    let id = nextId
    nextId = (nextId % 0xFFFF_FFFE) + 1
    let stream = OutgoingStream(requestId: id, mask: StreamFlag.request, send: sendNonisolated)
    registerOutgoingStreamIsolated(stream, forId: id)
    sendNonisolated(
      Messages.encodeRequest(id: id, command: command, stream: StreamFlag.open, data: nil))
    return stream
  }

  public func requestWithResponseStream(command: UInt, data: Data? = nil) async throws
    -> IncomingStream
  {
    let id = nextId
    nextId = (nextId % 0xFFFF_FFFE) + 1
    let frame = Messages.encodeRequest(id: id, command: command, data: data)
    return try await withCheckedThrowingContinuation { continuation in
      pendingResponseStreams[id] = continuation
      delegateBox.value?.rpc(self, send: frame)
    }
  }

  public func receive(_ data: Data) {
    buffer.append(data)
    var frames: [Data] = []
    while buffer.count >= 4 {
      var peekState = State(Data(buffer.prefix(4)))
      let bodyLen = Int(try! Primitive.UInt32().decode(&peekState))
      let frameLen = 4 + bodyLen
      guard buffer.count >= frameLen else { break }
      frames.append(Data(buffer.prefix(frameLen)))
      buffer.removeFirst(frameLen)
    }
    for frame in frames {
      dispatchFrame(frame)
    }
  }

  // MARK: - Nonisolated send path

  /// Send a frame without hopping to the actor. The send path touches only
  /// the weak delegate (wrapped in a Sendable box) and does not mutate state,
  /// so it is safe to call from sync closures like ``OutgoingStream``'s writer.
  nonisolated func sendNonisolated(_ data: Data) {
    delegateBox.value?.rpc(self, send: data)
  }

  // Kept for source compat with call sites that expect the old `sendData` name.
  public func sendData(_ data: Data) {
    sendNonisolated(data)
  }

  // MARK: - Stream registration helpers

  func registerOutgoingStreamIsolated(_ stream: OutgoingStream, forId id: UInt) {
    outgoingStreams[id] = stream
    stream.onClose = { [weak self] in
      guard let self else { return }
      Task { await self.removeOutgoingStream(id) }
    }
  }

  public func registerOutgoingStream(_ stream: OutgoingStream, forId id: UInt) {
    registerOutgoingStreamIsolated(stream, forId: id)
  }

  private func removeOutgoingStream(_ id: UInt) {
    outgoingStreams.removeValue(forKey: id)
  }

  // MARK: - Frame dispatch

  private func handleRequestStreamOpen(_ req: RequestMessage) {
    guard req.id != 0 else { return }
    let incoming = IncomingStream(requestId: req.id, mask: StreamFlag.request)
    incomingStreams[req.id] = incoming
    sendNonisolated(Messages.encodeStream(id: req.id, flags: StreamFlag.request | StreamFlag.open))
    let incomingRequest = IncomingRequest(
      id: req.id, command: req.command, data: req.data, rpc: self,
      requestStream: incoming)
    Task { [weak self] in
      guard let self, let delegate = await self.delegate else { return }
      try? await delegate.rpc(self, didReceiveRequest: incomingRequest)
    }
  }

  private func handleResponseStreamOpen(_ resp: ResponseMessage) {
    if let normalCont = pending.removeValue(forKey: resp.id) {
      normalCont.resume(
        throwing: RPCRemoteError(
          message: "Expected normal response", code: "ERR_UNEXPECTED_STREAM"))
    }
    guard let continuation = pendingResponseStreams.removeValue(forKey: resp.id) else { return }
    let incoming = IncomingStream(requestId: resp.id, mask: StreamFlag.response)
    incomingStreams[resp.id] = incoming
    sendNonisolated(Messages.encodeStream(id: resp.id, flags: StreamFlag.response | StreamFlag.open))
    continuation.resume(returning: incoming)
  }

  private func handleStreamMessage(_ msg: StreamMessage) {
    if msg.flags & StreamFlag.open != 0 {
      return
    }

    if msg.flags & StreamFlag.data != 0 {
      if let incoming = incomingStreams[msg.id] {
        if let data = msg.data {
          incoming.push(data)
        }
      }
      return
    }

    if msg.flags & StreamFlag.end != 0 {
      if let incoming = incomingStreams[msg.id] {
        incoming.end()
      }
      return
    }

    if msg.flags & StreamFlag.close != 0 {
      if msg.flags & StreamFlag.error != 0 {
        if let incoming = incomingStreams.removeValue(forKey: msg.id) {
          incoming.destroy(error: msg.error)
        }
      } else {
        if let incoming = incomingStreams.removeValue(forKey: msg.id) {
          incoming.end()
        }
      }
      return
    }

    if msg.flags & StreamFlag.destroy != 0 {
      if let outgoing = outgoingStreams[msg.id] {
        if msg.flags & StreamFlag.error != 0 {
          outgoing.destroy(error: msg.error)
        } else {
          outgoing.destroy()
        }
      }
      return
    }
  }

  private func dispatchFrame(_ frame: Data) {
    let message: DecodedMessage?
    do {
      message = try Messages.decodeFrame(frame)
    } catch {
      delegateBox.value?.rpc(self, didFailWith: error)
      return
    }

    guard let message else { return }

    switch message {
    case .request(let req):
      if req.stream == StreamFlag.open {
        handleRequestStreamOpen(req)
      } else {
        Task { [weak self] in
          guard let self, let delegate = await self.delegate else { return }
          if req.id == 0 {
            let event = IncomingEvent(command: req.command, data: req.data)
            await delegate.rpc(self, didReceiveEvent: event)
          } else {
            let incoming = IncomingRequest(
              id: req.id, command: req.command, data: req.data, rpc: self)
            try? await delegate.rpc(self, didReceiveRequest: incoming)
          }
        }
      }
    case .stream(let s):
      handleStreamMessage(s)
    case .response(let resp):
      if resp.stream == StreamFlag.open {
        handleResponseStreamOpen(resp)
      } else {
        let continuation = pending.removeValue(forKey: resp.id)
        if let continuation {
          switch resp.result {
          case .success(let data):
            continuation.resume(returning: data)
          case .remoteError(let msg, let code, let errno):
            continuation.resume(throwing: RPCRemoteError(message: msg, code: code, errno: errno))
          }
        }
        if let streamCont = pendingResponseStreams.removeValue(forKey: resp.id) {
          streamCont.resume(
            throwing: RPCRemoteError(
              message: "Expected stream response", code: "ERR_NOT_STREAM"))
        }
      }
    }
  }
}

// Weak reference box that is Sendable. The delegate protocol already requires
// Sendable; the box's only mutable slot is a weak reference — we never copy
// concrete state across isolation boundaries, and reads/writes are atomic at
// the platform level.
final class WeakDelegateBox: @unchecked Sendable {
  weak var value: RPCDelegate?
}
