@preconcurrency import BareRPC
import XCTest

@testable import PearTubeDesktop

final class BridgeRPCChannelTests: XCTestCase {
  func testSequentialRequestsRoundTrip() async throws {
    let server = RPCEchoServer()
    var client: BridgeRPCChannel!

    await server.setOnSend { data in
      Task { await client.receive(data) }
    }

    client = BridgeRPCChannel(
      onSend: { data in Task { await server.receive(data) } },
      onEvent: { _ in },
      onError: { error in
        XCTFail("Unexpected RPC error: \(error.localizedDescription)")
      }
    )

    for index in 0..<5 {
      let payload = Data([UInt8(index % 255), UInt8((index * 3) % 255)])
      let response = try await client.request(command: UInt(index + 1), data: payload)
      XCTAssertEqual(response, payload)
    }
  }

  func testRequestHonorsCustomTimeout() async {
    let client = BridgeRPCChannel(
      onSend: { _ in },
      onEvent: { _ in },
      onError: { _ in }
    )

    do {
      _ = try await client.request(
        command: 99,
        data: nil,
        timeout: .milliseconds(50)
      )
      XCTFail("Expected request to time out")
    } catch let error as BridgeRPCChannelError {
      XCTAssertEqual(error, .requestTimedOut(99))
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }

  func testRequestCanDisableTimeoutForLongRunningOperations() async throws {
    let server = RPCDelayedEchoServer(delay: .milliseconds(150))
    var client: BridgeRPCChannel!

    await server.setOnSend { data in
      Task { await client.receive(data) }
    }

    client = BridgeRPCChannel(
      onSend: { data in Task { await server.receive(data) } },
      onEvent: { _ in },
      onError: { error in
        XCTFail("Unexpected RPC error: \(error.localizedDescription)")
      }
    )

    let payload = Data([0xAB, 0xCD])
    let response = try await client.request(
      command: 7,
      data: payload,
      timeout: nil
    )

    XCTAssertEqual(response, payload)
  }

  func testEventsAreDispatchedToCallback() async throws {
    let eventExpectation = expectation(description: "Event received")
    var receivedCommand: UInt?
    var receivedData: Data?

    let server = RPCEchoServer()
    let client = BridgeRPCChannel(
      onSend: { _ in },
      onEvent: { event in
        receivedCommand = event.command
        receivedData = event.data
        eventExpectation.fulfill()
      },
      onError: { _ in }
    )

    await server.setOnSend { data in
      Task { await client.receive(data) }
    }

    let eventData = Data([0xDE, 0xAD])
    await server.sendEvent(command: 42, data: eventData)
    await fulfillment(of: [eventExpectation], timeout: 2)

    XCTAssertEqual(receivedCommand, 42)
    XCTAssertEqual(receivedData, eventData)
  }
}

// MARK: - Test Helpers

/// Actor-isolated echo server that wraps a bare-rpc-swift `RPC` instance,
/// ensuring all access to the non-Sendable `RPC` class is serialized.
private actor RPCEchoServer {
  private let rpc: RPC
  private let delegateAdapter: ServerDelegateAdapter

  init() {
    let adapter = ServerDelegateAdapter()
    self.rpc = RPC(delegate: adapter)
    self.delegateAdapter = adapter
    adapter.onRequest = { [rpc] request in
      request.reply(request.data)
    }
  }

  func setOnSend(_ handler: @escaping @Sendable (Data) -> Void) {
    delegateAdapter.onSend = handler
  }

  func receive(_ data: Data) {
    rpc.receive(data)
  }

  func sendEvent(command: UInt, data: Data?) {
    rpc.event(command, data: data)
  }
}

/// Actor-isolated delayed echo server for timeout tests.
private actor RPCDelayedEchoServer {
  private let rpc: RPC
  private let delegateAdapter: ServerDelegateAdapter

  init(delay: Duration) {
    let adapter = ServerDelegateAdapter()
    self.rpc = RPC(delegate: adapter)
    self.delegateAdapter = adapter
    adapter.onRequest = { [rpc] request in
      Task {
        try? await Task.sleep(for: delay)
        request.reply(request.data)
      }
    }
  }

  func setOnSend(_ handler: @escaping @Sendable (Data) -> Void) {
    delegateAdapter.onSend = handler
  }

  func receive(_ data: Data) {
    rpc.receive(data)
  }
}

/// Delegate bridge for test server RPCs.
private final class ServerDelegateAdapter: RPCDelegate, @unchecked Sendable {
  var onSend: (@Sendable (Data) -> Void)?
  var onRequest: ((IncomingRequest) -> Void)?

  func rpc(_ rpc: RPC, send data: Data) {
    onSend?(data)
  }

  func rpc(_ rpc: RPC, didReceiveRequest request: IncomingRequest) async throws {
    onRequest?(request)
  }
}
