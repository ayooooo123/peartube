@preconcurrency import BareRPC
import Foundation

enum BridgeRPCChannelError: LocalizedError {
  case unexpectedRequest(UInt)
  case requestTimedOut(UInt)

  var errorDescription: String? {
    switch self {
    case .unexpectedRequest(let command):
      return "Embedded BareKit worklet sent an unexpected inbound request for command \(command)."
    case .requestTimedOut(let command):
      return "Native host bridge request timed out while waiting for command \(command)."
    }
  }
}

actor BridgeRPCChannel {
  private let frameParser = NativeSidecarFrameParser()
  private let onSend: @Sendable (Data) -> Void
  private let onEvent: @Sendable (NativeSidecarEvent) async -> Void
  private let onError: @Sendable (Error) -> Void

  private var nextRequestID: UInt = 1
  private struct PendingRequest {
    let command: UInt
    let continuation: CheckedContinuation<Data?, Error>
    let timeoutTask: Task<Void, Never>
  }

  private var pending: [UInt: PendingRequest] = [:]

  init(
    onSend: @escaping @Sendable (Data) -> Void,
    onEvent: @escaping @Sendable (NativeSidecarEvent) async -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) {
    self.onSend = onSend
    self.onEvent = onEvent
    self.onError = onError
  }

  func request(command: UInt, data: Data? = nil) async throws -> Data? {
    let requestID = nextRequestID
    nextRequestID = (nextRequestID % 0xFFFF_FFFE) + 1

    let frame = try NativeSidecarRPCWire.encodeRequestFrame(
      id: requestID,
      command: command,
      data: data
    )

    return try await withCheckedThrowingContinuation { continuation in
      let timeoutTask = Task { [weak self] in
        try? await Task.sleep(for: .seconds(8))
        await self?.timeoutRequest(id: requestID)
      }

      pending[requestID] = PendingRequest(
        command: command,
        continuation: continuation,
        timeoutTask: timeoutTask
      )
      onSend(frame)
    }
  }

  func receive(_ data: Data) async {
    do {
      let frames = try frameParser.push(data)

      for frame in frames {
        switch frame {
        case .event(let event):
          await onEvent(event)
        case .response(let rawFrame):
          try handleResponseFrame(rawFrame)
        }
      }
    } catch {
      onError(error)
    }
  }

  func failPending(_ error: Error) {
    let continuations = pending.values
    pending.removeAll()

    for pendingRequest in continuations {
      pendingRequest.timeoutTask.cancel()
      pendingRequest.continuation.resume(throwing: error)
    }
  }

  private func timeoutRequest(id: UInt) {
    guard let pendingRequest = pending.removeValue(forKey: id) else { return }
    pendingRequest.timeoutTask.cancel()
    pendingRequest.continuation.resume(throwing: BridgeRPCChannelError.requestTimedOut(pendingRequest.command))
  }

  private func handleResponseFrame(_ rawFrame: Data) throws {
    guard let message = try NativeSidecarRPCWire.decodeFrame(rawFrame) else {
      return
    }

    switch message {
    case .request(let request):
      throw BridgeRPCChannelError.unexpectedRequest(request.command)
    case .response(let response):
      guard let pendingRequest = pending.removeValue(forKey: response.id) else {
        return
      }
      pendingRequest.timeoutTask.cancel()

      switch response.result {
      case .success(let data):
        pendingRequest.continuation.resume(returning: data)
      case .remoteError(let message, let code, let errno):
        pendingRequest.continuation.resume(throwing: RPCRemoteError(message: message, code: code, errno: errno))
      }
    }
  }
}
