import Foundation

final class BareRuntimeSidecarSession: NativeHostSession {
  private let stateLock = NSLock()
  private let ioQueue = DispatchQueue(label: "com.peartube.desktop.native.sidecar-io")
  private let process = Process()
  private let standardInputPipe = Pipe()
  private let standardOutputPipe = Pipe()
  private let standardErrorPipe = Pipe()
  private let onData: @Sendable (Data) -> Void
  private let onLog: @Sendable (String) -> Void
  private let onClosed: @Sendable () -> Void
  private var didClose = false
  private var stderrBuffer = ""

  init(
    runtimeURL: URL,
    bundleURL: URL? = nil,
    environment: [String: String],
    onData: @escaping @Sendable (Data) -> Void,
    onLog: @escaping @Sendable (String) -> Void,
    onClosed: @escaping @Sendable () -> Void
  ) throws {
    self.onData = onData
    self.onLog = onLog
    self.onClosed = onClosed

    process.executableURL = runtimeURL
    process.arguments = bundleURL.map { [$0.path] } ?? []
    process.environment = environment
    process.standardInput = standardInputPipe
    process.standardOutput = standardOutputPipe
    process.standardError = standardErrorPipe

    standardOutputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      self?.handleStandardOutput(handle.availableData)
    }

    standardErrorPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      self?.handleStandardError(handle.availableData)
    }

    process.terminationHandler = { [weak self] process in
      self?.handleTermination(process.terminationStatus)
    }

    try process.run()
    if let bundleURL {
      onLog("Native host sidecar launched from \(runtimeURL.path) with bundle \(bundleURL.path).")
    } else {
      onLog("Native host sidecar launched as standalone binary: \(runtimeURL.path)")
    }
  }

  func write(_ data: Data) {
    guard !data.isEmpty else { return }

    ioQueue.async { [weak self] in
      guard let self else { return }
      self.stateLock.lock()
      let shouldWrite = !self.didClose
      self.stateLock.unlock()
      guard shouldWrite else { return }

      do {
        try self.standardInputPipe.fileHandleForWriting.write(contentsOf: data)
      } catch {
        self.onLog("Native host sidecar stdin write failed: \(error.localizedDescription)")
        self.closeSession(notify: true)
      }
    }
  }

  func terminate() {
    closeSession(notify: false)
  }

  private func handleStandardOutput(_ data: Data) {
    if data.isEmpty {
      closeSession(notify: true)
      return
    }

    onData(data)
  }

  private func handleStandardError(_ data: Data) {
    if data.isEmpty {
      flushPendingStandardError()
      return
    }

    let rendered = String(decoding: data, as: UTF8.self)
    stateLock.lock()
    stderrBuffer += rendered
    let buffered = stderrBuffer
    stateLock.unlock()

    var emittedLines: [String] = []
    var pending = buffered

    while let newlineIndex = pending.firstIndex(of: "\n") {
      let line = String(pending[..<newlineIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
      pending.removeSubrange(...newlineIndex)
      if !line.isEmpty {
        emittedLines.append(line)
      }
    }

    stateLock.lock()
    stderrBuffer = pending
    stateLock.unlock()

    for line in emittedLines {
      onLog(line)
    }
  }

  private func flushPendingStandardError() {
    stateLock.lock()
    let trailing = stderrBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
    stderrBuffer = ""
    stateLock.unlock()

    if !trailing.isEmpty {
      onLog(trailing)
    }
  }

  private func handleTermination(_ status: Int32) {
    if status != 0 {
      onLog("Native host sidecar exited with status \(status).")
    }

    closeSession(notify: true)
  }

  private func closeSession(notify: Bool) {
    stateLock.lock()
    let shouldClose = !didClose
    didClose = true
    stateLock.unlock()

    guard shouldClose else { return }

    standardOutputPipe.fileHandleForReading.readabilityHandler = nil
    standardErrorPipe.fileHandleForReading.readabilityHandler = nil

    try? standardInputPipe.fileHandleForWriting.close()
    try? standardOutputPipe.fileHandleForReading.close()
    try? standardErrorPipe.fileHandleForReading.close()

    if process.isRunning {
      process.terminate()
    }

    flushPendingStandardError()

    guard notify else { return }
    onClosed()
  }
}
