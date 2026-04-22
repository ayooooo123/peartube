import Foundation

public class IncomingStream {
  public let requestId: UInt
  public let mask: UInt
  public let stream: AsyncThrowingStream<Data, Error>
  private let continuation: AsyncThrowingStream<Data, Error>.Continuation
  private var finished = false

  public init(requestId: UInt, mask: UInt) {
    self.requestId = requestId
    self.mask = mask
    var cont: AsyncThrowingStream<Data, Error>.Continuation!
    self.stream = AsyncThrowingStream<Data, Error> { cont = $0 }
    self.continuation = cont
  }

  func push(_ data: Data) {
    guard !finished else { return }
    continuation.yield(data)
  }

  func end() {
    guard !finished else { return }
    finished = true
    continuation.finish()
  }

  public func destroy(error: RPCRemoteError? = nil) {
    guard !finished else { return }
    finished = true
    if let error {
      continuation.finish(throwing: error)
    } else {
      continuation.finish()
    }
  }
}
