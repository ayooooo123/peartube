@preconcurrency import BareRPC
import Foundation

enum BridgeRPCChannelError: LocalizedError, Equatable {
  case requestTimedOut(UInt)

  var errorDescription: String? {
    switch self {
    case .requestTimedOut(let command):
      return "Native host bridge request timed out while waiting for command \(command)."
    }
  }
}

/// Wraps bare-rpc-swift's ``RPC`` class in an actor for thread-safe request/response
/// and stream communication with the native host process.
actor BridgeRPCChannel {
  nonisolated static let defaultRequestTimeout: Duration = .seconds(8)

  private let rpc: RPC
  private let delegateAdapter: RPCBridgeDelegateAdapter

  init(
    onSend: @escaping @Sendable (Data) -> Void,
    onEvent: @escaping @Sendable (IncomingEvent) async -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) {
    let adapter = RPCBridgeDelegateAdapter(
      onSend: onSend,
      onEvent: onEvent,
      onError: onError
    )
    self.rpc = RPC(delegate: adapter)
    self.delegateAdapter = adapter
  }

  // MARK: - Request / Response

  func request(
    command: UInt,
    data: Data? = nil,
    timeout: Duration? = BridgeRPCChannel.defaultRequestTimeout
  ) async throws -> Data? {
    guard let timeout else {
      return try await rpc.request(command, data: data)
    }

    // Race the RPC against a deadline. The rpc.request() call runs directly
    // on this actor (keeping RPC's non-Sendable state safe). A separate Task
    // fires after the deadline and cancels the RPC task if it hasn't completed.
    let rpcTask = Task { try await self.rpc.request(command, data: data) }

    let timeoutTask = Task {
      try? await Task.sleep(for: timeout)
      rpcTask.cancel()
    }

    do {
      let result = try await rpcTask.value
      timeoutTask.cancel()
      return result
    } catch is CancellationError {
      throw BridgeRPCChannelError.requestTimedOut(command)
    } catch {
      timeoutTask.cancel()
      throw error
    }
  }

  // MARK: - Response Streams

  /// Send a request and receive a stream of response chunks.
  ///
  /// The returned ``AsyncThrowingStream`` yields each chunk the responder
  /// writes and finishes when the responder calls ``end()``.
  func requestStream(
    command: UInt,
    data: Data? = nil,
    timeout: Duration? = BridgeRPCChannel.defaultRequestTimeout
  ) async throws -> AsyncThrowingStream<Data, Error> {
    let incoming: IncomingStream
    if let timeout {
      let rpcTask = Task { try await self.rpc.requestWithResponseStream(command: command, data: data) }

      let timeoutTask = Task {
        try? await Task.sleep(for: timeout)
        rpcTask.cancel()
      }

      do {
        incoming = try await rpcTask.value
        timeoutTask.cancel()
      } catch is CancellationError {
        throw BridgeRPCChannelError.requestTimedOut(command)
      } catch {
        timeoutTask.cancel()
        throw error
      }
    } else {
      incoming = try await rpc.requestWithResponseStream(command: command, data: data)
    }
    return incoming.stream
  }

  // MARK: - Transport

  func receive(_ data: Data) {
    rpc.receive(data)
  }

  /// Best-effort notification that the transport has disconnected.
  ///
  /// bare-rpc-swift does not expose a ``failPending`` API, so in-flight
  /// requests will time out naturally via their configured deadline.
  func failPending(_ error: Error) {
    delegateAdapter.onError(error)
  }
}

// MARK: - RPCDelegate Adapter

/// Bridges ``RPCDelegate`` callbacks to the closures expected by ``BridgeRPCChannel``.
///
/// All delegate methods are invoked synchronously from within ``RPC.receive(_:)``
/// which is called on the owning actor, so access is effectively serialized.
private final class RPCBridgeDelegateAdapter: RPCDelegate, @unchecked Sendable {
  let onSend: @Sendable (Data) -> Void
  let onEvent: @Sendable (IncomingEvent) async -> Void
  let onError: @Sendable (Error) -> Void

  init(
    onSend: @escaping @Sendable (Data) -> Void,
    onEvent: @escaping @Sendable (IncomingEvent) async -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) {
    self.onSend = onSend
    self.onEvent = onEvent
    self.onError = onError
  }

  func rpc(_ rpc: RPC, send data: Data) {
    onSend(data)
  }

  func rpc(_ rpc: RPC, didReceiveEvent event: IncomingEvent) async {
    await onEvent(event)
  }

  func rpc(_ rpc: RPC, didFailWith error: Error) {
    onError(error)
  }
}
