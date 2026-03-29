import XCTest
@testable import BareRPC
@testable import PearTubeDesktop

final class BridgeRPCChannelTests: XCTestCase {
  func testUnexpectedRequestErrorMentionsEmbeddedWorklet() {
    let message = BridgeRPCChannelError.unexpectedRequest(7).errorDescription

    XCTAssertEqual(message, "Embedded BareKit worklet sent an unexpected inbound request for command 7.")
  }

  func testNativeSidecarFrameParserSeparatesEventsFromResponses() throws {
    let parser = NativeSidecarFrameParser()
    let eventPayload = Data([0x11, 0x22, 0x33])
    let responsePayload = Data([0x44, 0x55, 0x66])

    let combined = Messages.encodeEvent(command: 3, data: eventPayload)
      + Messages.encodeResponse(id: 42, data: responsePayload)

    let messages = try parser.push(combined)

    XCTAssertEqual(messages.count, 2)

    guard case .event(let event) = messages[0] else {
      return XCTFail("Expected the first parsed message to be an event")
    }
    XCTAssertEqual(event.command, 3)
    XCTAssertEqual(event.data, eventPayload)

    guard case .response(let frame) = messages[1] else {
      return XCTFail("Expected the second parsed message to be a response frame")
    }
    XCTAssertEqual(frame, Messages.encodeResponse(id: 42, data: responsePayload))
  }

  func testConcurrentRequestsRoundTripWithoutCorruptingRPCState() async throws {
    var client: BridgeRPCChannel!
    client = BridgeRPCChannel(
      onSend: { data in
        guard let decoded = try? Messages.decodeFrame(data) else {
          XCTFail("Failed to decode outbound RPC frame")
          return
        }

        guard case .request(let request) = decoded else {
          XCTFail("Expected an outbound request frame")
          return
        }

        Task.detached {
          try? await Task.sleep(nanoseconds: 1_000_000)
          await client.receive(Messages.encodeResponse(id: request.id, data: request.data))
        }
      },
      onEvent: { _ in },
      onError: { error in
        XCTFail("Unexpected RPC error: \(error.localizedDescription)")
      }
    )

    try await withThrowingTaskGroup(of: Data?.self) { group in
      for index in 0..<40 {
        let payload = Data([UInt8(index % 255), UInt8((index * 3) % 255)])
        group.addTask {
          try await client.request(command: UInt(index + 1), data: payload)
        }
      }

      var responses: [Data] = []
      for try await response in group {
        if let response {
          responses.append(response)
        }
      }

      XCTAssertEqual(responses.count, 40)
    }
  }
}
