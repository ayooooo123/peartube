import Foundation

public class OutgoingStream {
  public let requestId: UInt
  public let mask: UInt
  private let send: (Data) -> Void
  var onClose: (() -> Void)?
  private var ended = false

  public init(requestId: UInt, mask: UInt, send: @escaping (Data) -> Void) {
    self.requestId = requestId
    self.mask = mask
    self.send = send
  }

  public func write(_ data: Data) {
    guard !ended else { return }
    send(Messages.encodeStream(id: requestId, flags: mask | StreamFlag.data, data: data))
  }

  public func end() {
    guard !ended else { return }
    ended = true
    send(Messages.encodeStream(id: requestId, flags: mask | StreamFlag.end))
    send(Messages.encodeStream(id: requestId, flags: mask | StreamFlag.close))
    onClose?()
  }

  public func destroy(error: RPCRemoteError? = nil) {
    guard !ended else { return }
    ended = true
    if let error {
      send(
        Messages.encodeStream(
          id: requestId, flags: mask | StreamFlag.close | StreamFlag.error, error: error))
    } else {
      send(Messages.encodeStream(id: requestId, flags: mask | StreamFlag.close))
    }
    onClose?()
  }
}
