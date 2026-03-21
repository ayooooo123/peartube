@preconcurrency import BareRPC
import CompactEncoding
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
  private(set) var activePlaybackVideoID: NativeVideo.ID?
  private(set) var resolvedPlaybackURL: URL?
  private(set) var isResolvingPlayback = false

  @ObservationIgnored private var sidecarProcess: Process?
  @ObservationIgnored private var sidecarInput: Pipe?
  @ObservationIgnored private var sidecarOutput: Pipe?
  @ObservationIgnored private var sidecarError: Pipe?
  @ObservationIgnored private var rpc: RPC?
  @ObservationIgnored private var rpcDelegate: NativeBridgeRPCDelegate?
  @ObservationIgnored private var sidecarStderrBuffer = ""
  @ObservationIgnored private let logLimit = 120
  @ObservationIgnored private(set) var selectedStoragePath: String?

  private struct SidecarArtifact {
    let runtimeURL: URL
    let bundleURL: URL
    let kind: String
  }

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

  func bootstrap(appState: AppState) async {
    guard phase != .booting else { return }

    appState.setLoading(true)
    phase = .booting
    appState.setError(nil)
    let storagePath = Self.preferredStoragePath()
    selectedStoragePath = storagePath
    appendLog("Launching Bare sidecar host.")
    appendLog("Using storage path \(storagePath).")

    do {
      try await ensureBridgeRunning()
      let response = try await sendRequest(
        command: .bootstrap,
        requestPayload: NativeBridgeBootstrapRequest(storagePath: storagePath),
        requestCodec: NativeBridgeBootstrapRequestCodec(),
        responseCodec: NativeBridgeBootstrapResponseCodec()
      )

      phase = .ready(blobServerPort: response.blobServerPort)
      lastHeartbeat = Date()
      appState.applySnapshot(response.snapshot)
      appendLog("Shared host ready. Loaded \(response.snapshot.stats.homeCount) home videos across \(response.snapshot.stats.channelCount) channels.")
    } catch {
      let friendlyMessage = Self.friendlyBootstrapError(
        error.localizedDescription,
        storagePath: storagePath
      )
      phase = .failed(friendlyMessage)
      appState.setError(friendlyMessage)
      appendLog("Host bootstrap failed: \(friendlyMessage)")
    }

    appState.setLoading(false)
  }

  func refreshBrowse(into appState: AppState) async {
    guard isReady else {
      await bootstrap(appState: appState)
      return
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Refreshing browse snapshot from shared host.")

    do {
      let snapshot = try await sendRequest(
        command: .refreshBrowse,
        responseCodec: NativeBrowseSnapshotCodec()
      )
      appState.applySnapshot(snapshot)
      lastHeartbeat = Date()
      appendLog("Browse snapshot refreshed.")
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Browse refresh failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  func searchVideos(query: String, into appState: AppState, topK: Int = 12) async {
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedQuery.isEmpty else {
      appState.clearSearch()
      return
    }

    if !isReady {
      await bootstrap(appState: appState)
      guard isReady else { return }
    }

    appState.setLoading(true)
    appState.setError(nil)
    appendLog("Running global search for \(trimmedQuery).")

    do {
      let response = try await sendRequest(
        command: .searchVideos,
        requestPayload: NativeBridgeSearchRequest(query: trimmedQuery, topK: topK),
        requestCodec: NativeBridgeSearchRequestCodec(),
        responseCodec: NativeBridgeSearchResponseCodec()
      )

      appState.applySearchResults(query: response.query, videos: response.results)
      lastHeartbeat = Date()
      appendLog("Global search returned \(response.results.count) results.")
    } catch {
      appState.setError(error.localizedDescription)
      appendLog("Global search failed: \(error.localizedDescription)")
    }

    appState.setLoading(false)
  }

  func resolvePlayback(for video: NativeVideo) async -> URL? {
    guard isReady else { return nil }

    isResolvingPlayback = true
    activePlaybackVideoID = video.id
    resolvedPlaybackURL = nil
    appendLog("Resolving playback URL for \(video.title).")

    defer {
      isResolvingPlayback = false
      lastHeartbeat = Date()
    }

    do {
      let response = try await sendRequest(
        command: .resolvePlayback,
        requestPayload: NativeBridgeResolvePlaybackRequest(
          channelKey: video.channelKey,
          publicBeeKey: video.publicBeeKey,
          videoId: video.backendVideoID
        ),
        requestCodec: NativeBridgeResolvePlaybackRequestCodec(),
        responseCodec: NativeBridgeResolvePlaybackResponseCodec()
      )

      let url = URL(string: response.url)
      resolvedPlaybackURL = url
      appendLog("Playback URL resolved.")
      return url
    } catch {
      appendLog("Playback resolution failed: \(error.localizedDescription)")
      return nil
    }
  }

  func clearPlayback() {
    activePlaybackVideoID = nil
    resolvedPlaybackURL = nil
    isResolvingPlayback = false
  }

  func resetBridgeState() {
    sidecarOutput?.fileHandleForReading.readabilityHandler = nil
    sidecarError?.fileHandleForReading.readabilityHandler = nil
    try? sidecarInput?.fileHandleForWriting.close()
    try? sidecarOutput?.fileHandleForReading.close()
    try? sidecarError?.fileHandleForReading.close()
    sidecarProcess?.terminate()
    rpc = nil
    rpcDelegate = nil
    sidecarInput = nil
    sidecarOutput = nil
    sidecarError = nil
    sidecarProcess = nil
    sidecarStderrBuffer = ""
    phase = .idle
    lastHeartbeat = nil
    clearPlayback()
  }

  private func appendLog(_ line: String) {
    logLines.append(line)
    if logLines.count > logLimit {
      logLines.removeFirst(logLines.count - logLimit)
    }
  }

  private func ensureBridgeRunning() async throws {
    if sidecarProcess != nil, sidecarInput != nil, sidecarOutput != nil, rpc != nil {
      return
    }

    let artifact = try sidecarArtifact()
    let process = Process()
    let stdinPipe = Pipe()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let rpcDelegate = NativeBridgeRPCDelegate { [weak self] data in
      Task { @MainActor [weak self] in
        self?.sendRPCFrame(data)
      }
    }
    let rpc = RPC(delegate: rpcDelegate)

    rpc.onEvent = { [weak self] event in
      await self?.handleRPCEvent(event)
    }
    rpc.onError = { [weak self] error in
      Task { @MainActor [weak self] in
        self?.appendLog("Bare sidecar RPC decode failed: \(error.localizedDescription)")
      }
    }

    process.executableURL = artifact.runtimeURL
    process.arguments = [artifact.bundleURL.path]
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    process.environment = sidecarEnvironment()
    process.terminationHandler = { [weak self] finishedProcess in
      Task { @MainActor [weak self] in
        self?.handleSidecarTermination(finishedProcess)
      }
    }

    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      Task { @MainActor [weak self] in
        self?.handleSidecarStdoutData(data)
      }
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      Task { @MainActor [weak self] in
        self?.handleSidecarStderrData(data)
      }
    }

    try process.run()

    self.sidecarProcess = process
    self.sidecarInput = stdinPipe
    self.sidecarOutput = stdoutPipe
    self.sidecarError = stderrPipe
    self.rpc = rpc
    self.rpcDelegate = rpcDelegate
    appendLog("Bare sidecar launched from \(artifact.kind) artifact at \(artifact.bundleURL.path).")
  }

  private func sidecarEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    if let frameworkPath = linkedAddonFrameworkPath() {
      environment["DYLD_FRAMEWORK_PATH"] = frameworkPath
    }
    return environment
  }

  private func linkedAddonFrameworkPath(fileManager: FileManager = .default) -> String? {
    if let frameworksPath = Bundle.main.privateFrameworksPath,
       fileManager.fileExists(atPath: frameworksPath) {
      return frameworksPath
    }

    do {
      let workspaceRoot = try Self.workspaceRootURL()
      let workspaceFrameworkPath = workspaceRoot
        .appendingPathComponent("packages/desktop-native/Vendor/BareAddons", isDirectory: true)
        .path
      if fileManager.fileExists(atPath: workspaceFrameworkPath) {
        return workspaceFrameworkPath
      }
    } catch {}

    return nil
  }

  private func handleSidecarStdoutData(_ data: Data) {
    guard !data.isEmpty else { return }
    rpc?.receive(data)
  }

  private func handleSidecarStderrData(_ data: Data) {
    if data.isEmpty {
      sidecarError?.fileHandleForReading.readabilityHandler = nil
      return
    }

    sidecarStderrBuffer += String(decoding: data, as: UTF8.self)

    while let newlineRange = sidecarStderrBuffer.range(of: "\n") {
      let line = String(sidecarStderrBuffer[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      sidecarStderrBuffer.removeSubrange(..<newlineRange.upperBound)
      if !line.isEmpty {
        appendLog(line)
      }
    }
  }

  private func handleSidecarTermination(_ process: Process) {
    guard sidecarProcess === process else { return }

    sidecarOutput?.fileHandleForReading.readabilityHandler = nil
    sidecarError?.fileHandleForReading.readabilityHandler = nil

    let disconnectError = HostBridgeError.bridgeDisconnected
    let reason: String
    if process.terminationReason == .uncaughtSignal {
      reason = "signal \(process.terminationStatus)"
    } else {
      reason = "exit \(process.terminationStatus)"
    }

    rpc = nil
    rpcDelegate = nil
    sidecarInput = nil
    sidecarOutput = nil
    sidecarError = nil
    sidecarProcess = nil

    if case .booting = phase {
      phase = .failed(disconnectError.localizedDescription)
    }

    appendLog("Bare sidecar exited (\(reason)).")
    appendLog(disconnectError.localizedDescription)
  }

  private func sendRPCFrame(_ data: Data) {
    guard let input = sidecarInput?.fileHandleForWriting else { return }

    do {
      try input.write(contentsOf: data)
    } catch {
      appendLog("Bare sidecar write failed: \(error.localizedDescription)")
    }
  }

  private func handleRPCEvent(_ event: IncomingEvent) async {
    lastHeartbeat = Date()

    switch NativeBridgeEventCommand(rawValue: event.command) {
    case .hostReady:
      let payload = try? NativeBridgePayload.decodeIfPresent(
        NativeBridgeHostReadyEventCodec(),
        from: event.data
      )
      phase = .ready(blobServerPort: payload?.blobServerPort)
    case .hostError:
      let payload = try? NativeBridgePayload.decodeIfPresent(
        NativeBridgeHostMessageEventCodec(),
        from: event.data
      )
      let message = payload?.message ?? "Unknown host error"
      phase = .failed(message)
      appendLog("Host error: \(message)")
    case .hostLog:
      let payload = try? NativeBridgePayload.decodeIfPresent(
        NativeBridgeHostMessageEventCodec(),
        from: event.data
      )
      if let message = payload?.message {
        appendLog(message)
      }
    case .none:
      appendLog("Bridge emitted an unknown RPC event command \(event.command).")
    }
  }

  private func sendRequest<ResponseCodec: Codec>(
    command: NativeBridgeCommand,
    responseCodec: ResponseCodec
  ) async throws -> ResponseCodec.Value {
    try await sendRequest(
      command: command,
      requestData: nil,
      responseCodec: responseCodec
    )
  }

  private func sendRequest<RequestCodec: Codec, ResponseCodec: Codec>(
    command: NativeBridgeCommand,
    requestPayload: RequestCodec.Value,
    requestCodec: RequestCodec,
    responseCodec: ResponseCodec
  ) async throws -> ResponseCodec.Value {
    let requestData = try NativeBridgePayload.encode(requestCodec, value: requestPayload)
    return try await sendRequest(
      command: command,
      requestData: requestData,
      responseCodec: responseCodec
    )
  }

  private func sendRequest<ResponseCodec: Codec>(
    command: NativeBridgeCommand,
    requestData: Data?,
    responseCodec: ResponseCodec
  ) async throws -> ResponseCodec.Value {
    try await ensureBridgeRunning()

    guard let rpc else {
      throw HostBridgeError.bridgeInputUnavailable
    }

    do {
      let responseData = try await rpc.request(command.rawValue, data: requestData)
      lastHeartbeat = Date()
      return try NativeBridgePayload.decode(responseCodec, from: responseData)
    } catch let error as RPCRemoteError {
      throw HostBridgeError.bridgeResponse(error.message)
    }
  }

  static func preferredStoragePath(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    fileManager: FileManager = .default,
    homeDirectory: URL = URL(fileURLWithPath: NSHomeDirectory()),
    appSupportDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
  ) -> String {
    if let override = environment["PEARTUBE_NATIVE_STORAGE_PATH"], !override.isEmpty {
      return override
    }

    let legacyStore = homeDirectory.appendingPathComponent(".peartube", isDirectory: true)
    let legacyMarkers = [
      legacyStore.appendingPathComponent("identity-key").path,
      legacyStore.appendingPathComponent("db/identity-key").path,
      legacyStore.appendingPathComponent("CORESTORE").path,
      legacyStore.appendingPathComponent("db/IDENTITY").path,
    ]

    if legacyMarkers.contains(where: { fileManager.fileExists(atPath: $0) }) {
      return legacyStore.path
    }

    let appSupport = appSupportDirectory ?? homeDirectory
    return appSupport
      .appendingPathComponent("PearTubeDesktopNative", isDirectory: true)
      .appendingPathComponent("host-storage", isDirectory: true)
      .path
  }

  static func friendlyBootstrapError(_ message: String, storagePath: String) -> String {
    let lowercased = message.lowercased()
    if lowercased.contains("file descriptor could not be locked")
      || lowercased.contains("corestore")
      || lowercased.contains("locked") {
      return "Close the existing PearTube desktop app or Pear worker using \(storagePath), then reopen PearTube Native."
    }

    return message
  }

  private func defaultStoragePath() -> String {
    Self.preferredStoragePath()
  }

  private func sidecarArtifact() throws -> SidecarArtifact {
    let fileManager = FileManager.default
    let environment = ProcessInfo.processInfo.environment

    if let runtimeOverride = environment["PEARTUBE_NATIVE_BARE_BINARY"], !runtimeOverride.isEmpty {
      let runtimeURL = URL(fileURLWithPath: runtimeOverride)
      let bundleURL = try resolveSidecarBundleURL(fileManager: fileManager)
      if fileManager.fileExists(atPath: runtimeURL.path) {
        return SidecarArtifact(
          runtimeURL: runtimeURL,
          bundleURL: bundleURL,
          kind: "override runtime"
        )
      }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundledRuntimeURL = resourceURL
        .appendingPathComponent("Runtime", isDirectory: true)
        .appendingPathComponent("bare")
      let bundledBundleURL = resourceURL
        .appendingPathComponent("Generated", isDirectory: true)
        .appendingPathComponent("native-host-sidecar.bundle")

      if fileManager.fileExists(atPath: bundledRuntimeURL.path)
          && fileManager.fileExists(atPath: bundledBundleURL.path) {
        return SidecarArtifact(
          runtimeURL: bundledRuntimeURL,
          bundleURL: bundledBundleURL,
          kind: "bundled sidecar"
        )
      }
    }

    let workspaceRoot = try Self.workspaceRootURL()
    let workspaceBundleURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
      .appendingPathComponent("native-host-sidecar.bundle")

    let runtimeCandidates = [
      workspaceRoot
        .appendingPathComponent("packages/desktop-native/Resources/Runtime", isDirectory: true)
        .appendingPathComponent("bare"),
      workspaceRoot
        .appendingPathComponent("node_modules/bare-runtime-darwin-arm64/bin", isDirectory: true)
        .appendingPathComponent("bare"),
      workspaceRoot
        .appendingPathComponent("node_modules/bare-runtime-darwin-x64/bin", isDirectory: true)
        .appendingPathComponent("bare"),
    ]

    if fileManager.fileExists(atPath: workspaceBundleURL.path) {
      for runtimeURL in runtimeCandidates where fileManager.fileExists(atPath: runtimeURL.path) {
        return SidecarArtifact(
          runtimeURL: runtimeURL,
          bundleURL: workspaceBundleURL,
          kind: "workspace sidecar"
        )
      }
    }

    throw HostBridgeError.bridgeArtifactMissing(
      "Runtime/bare + Generated/native-host-sidecar.bundle"
    )
  }

  private func resolveSidecarBundleURL(fileManager: FileManager = .default) throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    if let bundleOverride = environment["PEARTUBE_NATIVE_SIDECAR_BUNDLE"], !bundleOverride.isEmpty {
      let bundleURL = URL(fileURLWithPath: bundleOverride)
      if fileManager.fileExists(atPath: bundleURL.path) {
        return bundleURL
      }
    }

    if let resourceURL = Bundle.main.resourceURL {
      let bundledBundleURL = resourceURL
        .appendingPathComponent("Generated", isDirectory: true)
        .appendingPathComponent("native-host-sidecar.bundle")
      if fileManager.fileExists(atPath: bundledBundleURL.path) {
        return bundledBundleURL
      }
    }

    let workspaceRoot = try Self.workspaceRootURL()
    let workspaceBundleURL = workspaceRoot
      .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
      .appendingPathComponent("native-host-sidecar.bundle")

    if fileManager.fileExists(atPath: workspaceBundleURL.path) {
      return workspaceBundleURL
    }

    throw HostBridgeError.bridgeArtifactMissing("Generated/native-host-sidecar.bundle")
  }

  private static func workspaceRootURL() throws -> URL {
    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let packagesDirectory = candidate.appendingPathComponent("packages", isDirectory: true)
      if FileManager.default.fileExists(atPath: packageJSON.path)
          && FileManager.default.fileExists(atPath: packagesDirectory.path) {
        return candidate
      }
      candidate.deleteLastPathComponent()
    }

    throw HostBridgeError.workspaceRootNotFound
  }
}

private enum HostBridgeError: LocalizedError {
  case workspaceRootNotFound
  case bridgeArtifactMissing(String)
  case bridgeInputUnavailable
  case bridgeResponse(String)
  case bridgeDisconnected

  var errorDescription: String? {
    switch self {
    case .workspaceRootNotFound:
      return "Could not locate the PearTube workspace root from the native app build."
    case .bridgeArtifactMissing(let path):
      return "Native host bridge artifacts not found at \(path)."
    case .bridgeInputUnavailable:
      return "Native host bridge input stream is unavailable."
    case .bridgeResponse(let message):
      return message
    case .bridgeDisconnected:
      return "Bare sidecar bridge disconnected."
    }
  }
}
