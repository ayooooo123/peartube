import Foundation

public final class IncomingRequest: @unchecked Sendable {
  public let command: UInt
  public let id: UInt
  public let data: Data?
  public let requestStream: IncomingStream?

  private weak var rpc: RPC?

  init(id: UInt, command: UInt, data: Data?, rpc: RPC, requestStream: IncomingStream? = nil) {
    self.id = id
    self.command = command
    self.data = data
    self.rpc = rpc
    self.requestStream = requestStream
  }

  // Reply/reject bypass the actor because ``sendNonisolated`` only reads the
  // weak delegate and never touches actor state. Keeping these sync preserves
  // source compatibility for every `req.reply(...)` / `req.reject(...)` call
  // in adopter code (notably the generated HRPC handler plumbing).
  public func reply(_ data: Data? = nil) {
    rpc?.sendNonisolated(Messages.encodeResponse(id: id, data: data))
  }

  public func reject(_ message: String, code: String = "ERROR", errno: Int = 0) {
    rpc?.sendNonisolated(
      Messages.encodeErrorResponse(id: id, message: message, code: code, errno: errno))
  }

  // createResponseStream touches the actor's outgoing-stream table, so the
  // entry point is async. Callers that use response streaming are already in
  // async contexts (CommandRouter dispatch and user request handlers).
  public func createResponseStream() async -> OutgoingStream? {
    guard let rpc else { return nil }
    let stream = OutgoingStream(requestId: id, mask: StreamFlag.response) { [weak rpc] data in
      rpc?.sendNonisolated(data)
    }
    await rpc.registerOutgoingStream(stream, forId: id)
    rpc.sendNonisolated(Messages.encodeResponse(id: id, stream: StreamFlag.open, data: nil))
    return stream
  }
}
