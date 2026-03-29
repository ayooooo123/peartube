import Foundation

protocol NativeHostSession: AnyObject {
  func write(_ data: Data)
  func terminate()
}

final class EmbeddedBareKitSession: NativeHostSession {
  private let stateLock = NSLock()
  private let ipcQueue = DispatchQueue(label: "com.peartube.desktop.native.barekit-ipc")
  private let worklet: BareWorklet
  private let ipc: BareIPC
  private let onData: @Sendable (Data) -> Void
  private let onLog: @Sendable (String) -> Void
  private let onClosed: @Sendable () -> Void
  private var didClose = false
  private var writeQueue: [Data] = []
  private var isWriteScheduled = false
  private var isReadScheduled = false

  init(
    bundleURL: URL,
    assetsPath: String?,
    onData: @escaping @Sendable (Data) -> Void,
    onLog: @escaping @Sendable (String) -> Void,
    onClosed: @escaping @Sendable () -> Void
  ) throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = assetsPath

    guard let worklet = BareWorklet(configuration: configuration) else {
      throw EmbeddedBareKitSessionError.unavailable
    }

    self.worklet = worklet
    self.onData = onData
    self.onLog = onLog
    self.onClosed = onClosed

    try Self.startWorklet(worklet: worklet, bundleURL: bundleURL, onLog: onLog)

    guard let ipc = BareIPC(worklet: worklet) else {
      throw EmbeddedBareKitSessionError.ipcUnavailable
    }

    self.ipc = ipc

    ipc.readable = { [weak self] _ in
      self?.scheduleReadableDrain()
    }

    ipc.writable = { [weak self] _ in
      self?.scheduleWritableDrain()
    }
  }

  func write(_ data: Data) {
    stateLock.lock()
    guard !didClose else {
      stateLock.unlock()
      return
    }
    writeQueue.append(data)
    stateLock.unlock()

    onLog("Queued \(data.count) IPC bytes for embedded BareKit worklet.")

    scheduleWritableDrain()
  }

  func terminate() {
    closeSession(notify: false)
  }

  private func scheduleReadableDrain() {
    stateLock.lock()
    guard !didClose, !isReadScheduled else {
      stateLock.unlock()
      return
    }
    isReadScheduled = true
    stateLock.unlock()

    ipcQueue.async { [weak self] in
      self?.drainReadableFrames()
    }
  }

  private func drainReadableFrames() {
    while true {
      stateLock.lock()
      let shouldRead = !didClose
      stateLock.unlock()

      guard shouldRead else {
        stateLock.lock()
        isReadScheduled = false
        stateLock.unlock()
        return
      }

      guard let data = ipc.read() else {
        stateLock.lock()
        isReadScheduled = false
        stateLock.unlock()
        return
      }

      if data.isEmpty {
        onLog("BareKit IPC read returned EOF.")
        closeSession(notify: true)
        return
      }

      onLog("Read \(data.count) IPC bytes from embedded BareKit worklet.")
      onData(data)
    }
  }

  private func scheduleWritableDrain() {
    stateLock.lock()
    guard !didClose, !isWriteScheduled else {
      stateLock.unlock()
      return
    }
    guard !writeQueue.isEmpty else {
      stateLock.unlock()
      return
    }
    isWriteScheduled = true
    stateLock.unlock()

    ipcQueue.async { [weak self] in
      self?.drainWritableFrames()
    }
  }

  private func drainWritableFrames() {
    while true {
      var nextFrame: Data?

      stateLock.lock()
      guard !didClose else {
        isWriteScheduled = false
        stateLock.unlock()
        return
      }
      nextFrame = writeQueue.first
      guard let nextFrame else {
        isWriteScheduled = false
        stateLock.unlock()
        return
      }
      stateLock.unlock()

      onLog("Dispatching \(nextFrame.count) IPC bytes to embedded BareKit worklet.")
      let result = ipc.write(nextFrame)

      if result < 0 {
        onLog("BareKit IPC write not yet accepted (result \(result)); waiting for writable.")
        stateLock.lock()
        isWriteScheduled = false
        stateLock.unlock()
        return
      }

      if result == 0, !nextFrame.isEmpty {
        onLog("BareKit IPC write returned 0 bytes; waiting for writable.")
        stateLock.lock()
        isWriteScheduled = false
        stateLock.unlock()
        return
      }

      stateLock.lock()
      if !writeQueue.isEmpty {
        if result >= nextFrame.count {
          writeQueue.removeFirst()
        } else if result > 0 {
          writeQueue[0] = nextFrame.subdata(in: result..<nextFrame.count)
        }
      }
      stateLock.unlock()

      onLog("Finished writing \(result) IPC bytes to embedded BareKit worklet.")
    }
  }

  private func closeSession(notify: Bool) {
    stateLock.lock()
    let closeState = closeSessionLocked(notify: notify)
    stateLock.unlock()

    guard let closeState else { return }

    closeState.ipc.readable = nil
    closeState.ipc.writable = nil
    closeState.ipc.close()
    closeState.worklet.terminate()

    guard closeState.shouldNotify else { return }
    onClosed()
  }

  private func closeSessionLocked(
    notify: Bool
  ) -> (shouldNotify: Bool, ipc: BareIPC, worklet: BareWorklet)? {
    guard !didClose else { return nil }

    didClose = true
    writeQueue.removeAll(keepingCapacity: false)
    isWriteScheduled = false
    isReadScheduled = false

    return (notify, ipc, worklet)
  }

  private static func startWorklet(
    worklet: BareWorklet,
    bundleURL: URL,
    onLog: @escaping @Sendable (String) -> Void
  ) throws {
    if let resourceStart = resourceFileStart(bundleURL: bundleURL) {
      let resourceLabel = "\(resourceStart.name).\(resourceStart.type)"
      if let directory = resourceStart.directory {
        onLog("Launching embedded BareKit worklet from bundled resource \(resourceLabel) in \(directory).")
        worklet.start(
          resourceStart.name,
          ofType: resourceStart.type,
          inDirectory: directory,
          in: resourceStart.bundle,
          arguments: []
        )
      } else {
        onLog("Launching embedded BareKit worklet from bundled resource \(resourceLabel).")
        worklet.start(
          resourceStart.name,
          ofType: resourceStart.type,
          in: resourceStart.bundle,
          arguments: []
        )
      }
      return
    }

    let source = try Data(contentsOf: bundleURL)
    onLog("Launching embedded BareKit worklet from source \(bundleURL.path).")
    worklet.start(bundleURL.path, source: source, arguments: [])
  }

  private static func resourceFileStart(bundleURL: URL) -> (
    name: String,
    type: String,
    directory: String?,
    bundle: Bundle
  )? {
    guard
      let resourceURL = Bundle.main.resourceURL?.standardizedFileURL
    else {
      return nil
    }

    let standardizedBundleURL = bundleURL.standardizedFileURL
    guard standardizedBundleURL.path.hasPrefix(resourceURL.path + "/") else {
      return nil
    }

    let directoryURL = standardizedBundleURL.deletingLastPathComponent()
    let name = standardizedBundleURL.deletingPathExtension().lastPathComponent
    let type = standardizedBundleURL.pathExtension
    let relativeDirectory = String(directoryURL.path.dropFirst(resourceURL.path.count))
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

    return (
      name: name,
      type: type,
      directory: relativeDirectory.isEmpty ? nil : relativeDirectory,
      bundle: .main
    )
  }
}

enum EmbeddedBareKitSessionError: LocalizedError {
  case unavailable
  case ipcUnavailable

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "BareKit worklet could not be created."
    case .ipcUnavailable:
      return "BareKit IPC could not be created."
    }
  }
}
