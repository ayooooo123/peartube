import Foundation
import Observation

@MainActor
@Observable
final class HostBridgeService {
  enum Phase: Equatable {
    case idle
    case booting
    case ready(blobServerPort: Int?)
    case failed(String)
  }

  private(set) var phase: Phase = .idle
  private(set) var logLines: [String] = ["Native host bridge scaffold created."]
  private(set) var lastHeartbeat: Date?

  var isReady: Bool {
    if case .ready = phase { return true }
    return false
  }

  var statusTitle: String {
    switch phase {
    case .idle:
      return "Host bridge idle"
    case .booting:
      return "Booting shared host"
    case .ready(let port):
      if let port {
        return "Host ready on blob port \(port)"
      }
      return "Host ready in preview mode"
    case .failed(let message):
      return "Host failed: \(message)"
    }
  }

  func bootstrapPreviewSession(delayNanoseconds: UInt64 = 350_000_000) async {
    guard phase != .booting else { return }

    phase = .booting
    appendLog("Preparing native runner contract for desktop.")

    do {
      try await Task.sleep(nanoseconds: delayNanoseconds)
      lastHeartbeat = Date()
      phase = .ready(blobServerPort: nil)
      appendLog("Preview host bridge ready. Shared host/protocol integration is next.")
    } catch {
      phase = .failed(error.localizedDescription)
      appendLog("Host bootstrap was interrupted: \(error.localizedDescription)")
    }
  }

  func resetPreviewSession() {
    phase = .idle
    lastHeartbeat = nil
    appendLog("Preview host bridge reset.")
  }

  private func appendLog(_ line: String) {
    logLines.append(line)
  }
}
