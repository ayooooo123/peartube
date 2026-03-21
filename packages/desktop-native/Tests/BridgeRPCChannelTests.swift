import XCTest
@testable import BareRPC
@testable import PearTubeDesktop

final class BridgeRPCChannelTests: XCTestCase {
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
