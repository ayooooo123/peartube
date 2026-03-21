import Foundation

struct ProtocolLineBuffer {
  private var pending = Data()

  mutating func append(_ data: Data) -> [String] {
    pending.append(data)
    var lines: [String] = []

    while let newlineIndex = pending.firstIndex(of: 0x0A) {
      let lineData = pending.prefix(upTo: newlineIndex)
      pending.removeSubrange(...newlineIndex)

      guard !lineData.isEmpty else { continue }
      if let line = String(data: lineData, encoding: .utf8) {
        lines.append(line)
      }
    }

    return lines
  }
}
