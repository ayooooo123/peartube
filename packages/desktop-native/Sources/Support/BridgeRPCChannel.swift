@preconcurrency import BareRPC
import Foundation

private final class BridgeRPCDelegate: RPCDelegate {
  private let onSend: @Sendable (Data) -> Void

  init(onSend: @escaping @Sendable (Data) -> Void) {
    self.onSend = onSend
  }

  func rpc(_ rpc: RPC, send data: Data) {
    onSend(data)
  }
}

actor BridgeRPCChannel {
  private let delegate: BridgeRPCDelegate
  private let rpc: RPC

  init(
    onSend: @escaping @Sendable (Data) -> Void,
    onEvent: @escaping @Sendable (IncomingEvent) async -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) {
    let delegate = BridgeRPCDelegate(onSend: onSend)
    self.delegate = delegate

    let rpc = RPC(delegate: delegate)
    rpc.onEvent = { event in
      await onEvent(event)
    }
    rpc.onError = { error in
      onError(error)
    }

    self.rpc = rpc
  }

  func request(command: UInt, data: Data? = nil) async throws -> Data? {
    try await rpc.request(command, data: data)
  }

  func receive(_ data: Data) {
    rpc.receive(data)
  }
}
