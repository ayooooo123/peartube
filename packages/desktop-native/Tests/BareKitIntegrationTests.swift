import XCTest
@testable import PearTubeDesktop

final class BareKitIntegrationTests: XCTestCase {
  private let diagnosticReadIdentityKeyFileCommand: UInt = 255

  private func requireExperimentalBareKitHostTests() throws {
    let enabled = ProcessInfo.processInfo.environment["PEARTUBE_ENABLE_EXPERIMENTAL_BAREKIT_TESTS"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()

    guard enabled == "1" || enabled == "true" else {
      throw XCTSkip("Experimental embedded BareKit host tests are opt-in.")
    }
  }

  struct BareKitTimeoutError: LocalizedError {
    let label: String

    var errorDescription: String? {
      "Timed out waiting for \(label)."
    }
  }

  @MainActor
  func testBareKitWorkletPushRoundTrips() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = "BareKit.on('push', (payload, reply) => reply(null, payload))"
    worklet.start("/app.cjs", source: Data(source.utf8), arguments: [])

    let response = try await worklet.push(Data("ping".utf8))
    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ping")

    worklet.terminate()
  }

  @MainActor
  func testBareKitInlineRequireLoadsBareFs() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = """
    BareKit.on('push', async (_payload, reply) => {
      try {
        const fsMod = require('bare-fs')
        const fs = fsMod?.default || fsMod
        reply(null, typeof fs?.existsSync === 'function' ? 'ok' : 'missing')
      } catch (error) {
        reply(error)
      }
    })
    """
    worklet.start("/require-bare-fs.cjs", source: Data(source.utf8), arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "require('bare-fs') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitInlineDynamicImportLoadsBareFs() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = """
    BareKit.on('push', async (_payload, reply) => {
      try {
        const fsMod = await import('bare-fs')
        const fs = fsMod?.default || fsMod
        reply(null, typeof fs?.existsSync === 'function' ? 'ok' : 'missing')
      } catch (error) {
        reply(error)
      }
    })
    """
    worklet.start("/dynamic-import-bare-fs.cjs", source: Data(source.utf8), arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "dynamic import('bare-fs') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitInlineRequireRocksdbNativeLoads() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = """
    BareKit.on('push', async (_payload, reply) => {
      try {
        const native = require('rocksdb-native')
        reply(null, native ? 'ok' : 'missing')
      } catch (error) {
        reply(error)
      }
    })
    """
    worklet.start("/require-rocksdb-native.cjs", source: Data(source.utf8), arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "require('rocksdb-native') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitInlineRequireQuickbitNativeLoads() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = """
    BareKit.on('push', async (_payload, reply) => {
      try {
        const native = require('quickbit-native')
        reply(null, native ? 'ok' : 'missing')
      } catch (error) {
        reply(error)
      }
    })
    """
    worklet.start("/require-quickbit-native.cjs", source: Data(source.utf8), arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "require('quickbit-native') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitInlineRequireSodiumNativeLoads() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = """
    BareKit.on('push', async (_payload, reply) => {
      try {
        const native = require('sodium-native')
        reply(null, native ? 'ok' : 'missing')
      } catch (error) {
        reply(error)
      }
    })
    """
    worklet.start("/require-sodium-native.cjs", source: Data(source.utf8), arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "require('sodium-native') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitBundledExistsSyncReturnsForMissingPath() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let entryURL = try bareKitBareFsBundleURL()
    let source = try Data(contentsOf: entryURL)
    worklet.start("/\(entryURL.lastPathComponent)", source: source, arguments: [])
    defer {
      worklet.terminate()
    }

    let missingPath = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-barekit-missing-\(UUID().uuidString)")
      .path
    let response = try await withTimeout(label: "bundled existsSync missing-path response") {
      try await worklet.push(Data(missingPath.utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "0")
  }

  @MainActor
  func testBareKitBundledRequireLoadsBareFs() async throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let entryURL = try bareKitBareFsBundleURL()
    let source = try Data(contentsOf: entryURL)
    worklet.start("/\(entryURL.lastPathComponent)", source: source, arguments: [])
    defer {
      worklet.terminate()
    }

    let response = try await withTimeout(label: "bundled require('bare-fs') push response") {
      try await worklet.push(Data("ping".utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ok")
  }

  @MainActor
  func testBareKitBundledEchoRawIPC() throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let entryURL = try bareKitEchoSourceURL()
    let source = try Data(contentsOf: entryURL)
    worklet.start("/app.bundle", source: source, arguments: [])

    guard let ipc = BareIPC(worklet: worklet) else {
      XCTFail("Could not create BareKit IPC.")
      return
    }

    defer {
      ipc.close()
      worklet.terminate()
    }

    let echoExpectation = expectation(description: "bundled echo round-trips through raw BareIPC")
    let timeoutExpectation = expectation(description: "bundled echo does not hang")
    timeoutExpectation.isInverted = true

    let payload = Data("ping".utf8)
    var hasWritten = false

    func attemptWrite() {
      guard !hasWritten else { return }

      let result = ipc.write(payload)
      if result >= 0 {
        hasWritten = true
      }
    }

    ipc.readable = { ipc in
      while let data = ipc.read() {
        if data.isEmpty {
          timeoutExpectation.fulfill()
          return
        }

        if String(decoding: data, as: UTF8.self) == "ping" {
          echoExpectation.fulfill()
          return
        }
      }
    }

    ipc.writable = { _ in
      attemptWrite()
    }

    attemptWrite()

    wait(for: [echoExpectation], timeout: 5.0)
    wait(for: [timeoutExpectation], timeout: 0.1)
  }

  @MainActor
  func testBareKitInlineEchoRawIPC() throws {
    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let source = "BareKit.IPC.on('data', (data) => BareKit.IPC.write(data))"
    worklet.start(
      "/app.cjs",
      source: source,
      encoding: String.Encoding.utf8.rawValue,
      arguments: []
    )

    guard let ipc = BareIPC(worklet: worklet) else {
      XCTFail("Could not create BareKit IPC.")
      return
    }

    defer {
      ipc.close()
      worklet.terminate()
    }

    let echoExpectation = expectation(description: "inline echo round-trips through raw BareIPC")
    let payload = Data("ping".utf8)
    var hasWritten = false

    func attemptWrite() {
      guard !hasWritten else { return }

      let result = ipc.write(payload)
      if result >= 0 {
        hasWritten = true
      }
    }

    ipc.readable = { ipc in
      while let data = ipc.read() {
        if String(decoding: data, as: UTF8.self) == "ping" {
          echoExpectation.fulfill()
          return
        }
      }
    }

    ipc.writable = { _ in
      attemptWrite()
    }

    attemptWrite()

    wait(for: [echoExpectation], timeout: 5.0)
  }

  @MainActor
  func testBareKitBundledCorestoreReadyForTempPath() async throws {
    try requireExperimentalBareKitHostTests()

    let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
    configuration.assets = Bundle.main.resourceURL?.path

    guard let worklet = BareWorklet(configuration: configuration) else {
      XCTFail("Could not create BareKit worklet.")
      return
    }

    let entryURL = try bareKitCorestoreBundleURL()
    let source = try Data(contentsOf: entryURL)
    worklet.start("/\(entryURL.lastPathComponent)", source: source, arguments: [])
    defer {
      worklet.terminate()
    }

    let appSupport = try XCTUnwrap(
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    )
    let storageURL = appSupport
      .appendingPathComponent("PearTubeDesktopNativeTests", isDirectory: true)
      .appendingPathComponent("peartube-barekit-corestore-\(UUID().uuidString)", isDirectory: true)
    let debugLogURL = URL(fileURLWithPath: "/tmp/peartube-barekit-corestore.log")
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: debugLogURL)
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", debugLogURL.path, 1)
    defer {
      unsetenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG")
      try? FileManager.default.removeItem(at: storageURL)
    }

    let response = try await withTimeout(label: "bundled corestore ready response") {
      try await worklet.push(Data(storageURL.path.utf8))
    }

    XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ready")
  }

  @MainActor
  func testBareKitBundledCorestoreReopensSameStorage() async throws {
    try requireExperimentalBareKitHostTests()

    let entryURL = try bareKitCorestoreBundleURL()
    let source = try Data(contentsOf: entryURL)

    let appSupport = try XCTUnwrap(
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    )
    let storageURL = appSupport
      .appendingPathComponent("PearTubeDesktopNativeTests", isDirectory: true)
      .appendingPathComponent("peartube-barekit-corestore-reopen-\(UUID().uuidString)", isDirectory: true)
    let debugLogURL = URL(fileURLWithPath: "/tmp/peartube-barekit-corestore.log")
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: debugLogURL)
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", debugLogURL.path, 1)
    defer {
      unsetenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG")
      try? FileManager.default.removeItem(at: storageURL)
    }

    for attempt in 1...2 {
      let configuration = BareWorkletConfiguration.default() ?? BareWorkletConfiguration()
      configuration.assets = Bundle.main.resourceURL?.path

      guard let worklet = BareWorklet(configuration: configuration) else {
        XCTFail("Could not create BareKit worklet on attempt \(attempt).")
        return
      }

      worklet.start("/\(entryURL.lastPathComponent)", source: source, arguments: [])
      let response = try await withTimeout(label: "bundled corestore reopen response attempt \(attempt)") {
        try await worklet.push(Data(storageURL.path.utf8))
      }
      XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "ready")
      worklet.terminate()
    }
  }

  @MainActor
  func testBareKitWorkletSessionBootstrapsWorkspaceHostEntry() async throws {
    let storageURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-barekit-\(UUID().uuidString)", isDirectory: true)
    let debugLogURL = URL(fileURLWithPath: "/tmp/peartube-native-barekit-bootstrap.log")
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: debugLogURL)
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", debugLogURL.path, 1)
    print("BareKit bootstrap debug log: \(debugLogURL.path)")
    defer {
      unsetenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG")
      try? FileManager.default.removeItem(at: storageURL)
    }

    let (session, rpcChannel) = try makeEmbeddedHostSession(
      logPrefix: "BareKit bootstrap"
    )
    do {
      let request = try NativeBridgePayload.encode(
        NativeBridgeBootstrapRequestCodec(),
        value: NativeBridgeBootstrapRequest(storagePath: storageURL.path)
      )
      print("BareKit bootstrap request bytes: \(request.count)")
      let responseData = try await withTimeout(label: "embedded BareKit bootstrap response") {
        try await rpcChannel.request(command: NativeBridgeCommand.bootstrap.rawValue, data: request)
      }
      let response = try NativeBridgePayload.decode(
        NativeBridgeBootstrapResponseCodec(),
        from: responseData
      )

      XCTAssertEqual(response.storagePath, storageURL.path)
      XCTAssertGreaterThanOrEqual(response.protocolVersion, 1)
      XCTAssertNotNil(response.blobServerPort)
    } catch {
      await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit bootstrap")
      throw error
    }

    await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit bootstrap")
  }

  @MainActor
  func testBareKitWorkletSessionReopensStorageBeforeIdentityExists() async throws {
    let storageURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-barekit-reopen-\(UUID().uuidString)", isDirectory: true)
    let debugLogURL = URL(fileURLWithPath: "/tmp/peartube-native-barekit-reopen.log")
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: debugLogURL)
    setenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG", debugLogURL.path, 1)
    defer {
      unsetenv("PEARTUBE_NATIVE_WORKLET_DEBUG_LOG")
      try? FileManager.default.removeItem(at: storageURL)
    }

    let firstResponse = try await bootstrapEmbeddedHost(storagePath: storageURL.path)
    XCTAssertEqual(firstResponse.storagePath, storageURL.path)
    XCTAssertGreaterThanOrEqual(firstResponse.protocolVersion, 1)

    let secondResponse = try await bootstrapEmbeddedHost(storagePath: storageURL.path)
    XCTAssertEqual(secondResponse.storagePath, storageURL.path)
    XCTAssertGreaterThanOrEqual(secondResponse.protocolVersion, 1)
  }

  @MainActor
  func testBareKitWorkletSessionCreatesIdentityAfterBootstrap() async throws {
    let storageURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-barekit-create-identity-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: storageURL)
    }

    let (session, rpcChannel) = try makeEmbeddedHostSession(
      logPrefix: "BareKit create identity"
    )
    do {
      let bootstrapRequest = try NativeBridgePayload.encode(
        NativeBridgeBootstrapRequestCodec(),
        value: NativeBridgeBootstrapRequest(storagePath: storageURL.path)
      )
      _ = try await withTimeout(label: "embedded BareKit bootstrap response") {
        try await rpcChannel.request(command: NativeBridgeCommand.bootstrap.rawValue, data: bootstrapRequest)
      }

      let channelName = "BareKit Test Channel"
      let createIdentityRequest = try NativeBridgePayload.encode(
        NativeBridgeCreateIdentityRequestCodec(),
        value: NativeBridgeCreateIdentityRequest(name: channelName)
      )
      let responseData = try await withTimeout(label: "embedded BareKit create identity response") {
        try await rpcChannel.request(command: NativeBridgeCommand.createIdentity.rawValue, data: createIdentityRequest)
      }
      let snapshot = try NativeBridgePayload.decode(
        NativeBrowseSnapshotCodec(),
        from: responseData
      )

      XCTAssertEqual(snapshot.state.activeIdentityName, channelName)
      XCTAssertEqual(snapshot.state.identityChannelKeys.isEmpty, false)
      XCTAssertEqual(snapshot.state.activeIdentityChannelKey?.isEmpty, false)
    } catch {
      await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit create identity")
      throw error
    }

    await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit create identity")
  }

  @MainActor
  func testBareKitWorkletSessionReadsIdentityKeyFileInWorkspaceHostEntry() async throws {
    try requireExperimentalBareKitHostTests()

    let storageURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("peartube-native-barekit-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: storageURL, withIntermediateDirectories: true)
    defer {
      try? FileManager.default.removeItem(at: storageURL)
    }

    let (session, rpcChannel) = try makeEmbeddedHostSession(logPrefix: "BareKit identity")
    do {
      let response = try await withTimeout(label: "diagnostic identity-key-file response") {
        try await rpcChannel.request(
          command: self.diagnosticReadIdentityKeyFileCommand,
          data: Data(storageURL.path.utf8)
        )
      }

      XCTAssertEqual(String(decoding: response ?? Data(), as: UTF8.self), "missing")
    } catch {
      await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit identity")
      throw error
    }

    await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit identity")
  }

  @MainActor
  func testBareKitWorkletSessionStartsWorkspaceSourceEntry() throws {
    let entryURL = try bareKitEchoSourceURL()
    let assetsPath = entryURL.deletingLastPathComponent().path

    let echoExpectation = expectation(description: "session echoes payload through direct source entry")
    let closedExpectation = expectation(description: "session closes cleanly")
    closedExpectation.isInverted = true

    let session = try EmbeddedBareKitSession(
      bundleURL: entryURL,
      assetsPath: assetsPath,
      onData: { data in
        let payload = String(decoding: data, as: UTF8.self)
        if payload == "ping" {
          echoExpectation.fulfill()
        }
      },
      onLog: { _ in },
      onClosed: {
        closedExpectation.fulfill()
      }
    )

    Task {
      try? await Task.sleep(nanoseconds: 250_000_000)
      session.write(Data("ping".utf8))
    }

    wait(for: [echoExpectation], timeout: 5.0)
    wait(for: [closedExpectation], timeout: 0.1)

    session.terminate()
  }

  private func bareKitEchoSourceURL() throws -> URL {
    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let generatedBundle = candidate
        .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
        .appendingPathComponent("barekit-echo.bundle")
      let sourceEntry = candidate
        .appendingPathComponent("packages/desktop-native/Bridge", isDirectory: true)
        .appendingPathComponent("barekit-echo-worklet.cjs")

      if FileManager.default.fileExists(atPath: packageJSON.path) {
        if FileManager.default.fileExists(atPath: generatedBundle.path) {
          return generatedBundle
        }

        if FileManager.default.fileExists(atPath: sourceEntry.path) {
          return sourceEntry
        }
      }

      candidate.deleteLastPathComponent()
    }

    throw XCTSkip("Could not resolve the workspace BareKit echo worklet artifact.")
  }

  private func nativeHostWorkletURL() throws -> URL {
    if let bundledResourceURL = Bundle.main.resourceURL?
      .appendingPathComponent("Generated", isDirectory: true)
      .appendingPathComponent("native-host-worklet.bundle"),
      FileManager.default.fileExists(atPath: bundledResourceURL.path) {
      return bundledResourceURL
    }

    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let generatedBundle = candidate
        .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
        .appendingPathComponent("native-host-worklet.bundle")
      let sourceEntry = candidate
        .appendingPathComponent("packages/desktop-native/Bridge", isDirectory: true)
        .appendingPathComponent("native-host-worklet.mjs")

      if FileManager.default.fileExists(atPath: packageJSON.path) {
        if FileManager.default.fileExists(atPath: generatedBundle.path) {
          return generatedBundle
        }

        if FileManager.default.fileExists(atPath: sourceEntry.path) {
          return sourceEntry
        }
      }

      candidate.deleteLastPathComponent()
    }

    throw XCTSkip("Could not resolve the workspace native host worklet artifact.")
  }

  @MainActor
  private func makeEmbeddedHostSession(
    logPrefix: String,
    onEvent: (@Sendable (NativeSidecarEvent) async -> Void)? = nil
  ) throws -> (EmbeddedBareKitSession, BridgeRPCChannel) {
    let entryURL = try nativeHostWorkletURL()
    var session: EmbeddedBareKitSession?

    let rpcChannel = BridgeRPCChannel(
      onSend: { data in
        print("\(logPrefix) onSend bytes: \(data.count)")
        session?.write(data)
      },
      onEvent: { event in
        switch NativeBridgeEventCommand(rawValue: event.command) {
        case .hostLog:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeHostMessageEventCodec(),
               from: data
             ) {
            let message = payload.message
            print("\(logPrefix) event: \(message)")
          }
        case .hostError:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeHostMessageEventCodec(),
               from: data
             ) {
            let message = payload.message
            print("\(logPrefix) error event: \(message)")
          }
        case .hostReady:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeHostReadyEventCodec(),
               from: data
             ) {
            print("\(logPrefix) ready event: \(String(describing: payload.blobServerPort))")
          }
        case .workletReady:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeWorkletReadyEventCodec(),
               from: data
             ) {
            print("\(logPrefix) worklet ready event: \(payload.stage)")
          }
        case .feedUpdated:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeFeedUpdatedEventCodec(),
               from: data
             ) {
            print("\(logPrefix) feed updated event: \(payload.channelKey) \(payload.action)")
          }
        case .uploadProgress:
          if let data = event.data,
             let payload = try? NativeBridgePayload.decode(
               NativeBridgeUploadProgressEventCodec(),
               from: data
             ) {
            print(
              "\(logPrefix) upload progress event: \(payload.videoId) \(String(describing: payload.bytesUploaded))/\(String(describing: payload.totalBytes))"
            )
          }
        case .none:
          print("\(logPrefix) unknown event command: \(event.command)")
        }

        if let onEvent {
          await onEvent(event)
        }
      },
      onError: { error in
        print("\(logPrefix) RPC decode failed: \(error.localizedDescription)")
      }
    )

    let createdSession = try EmbeddedBareKitSession(
      bundleURL: entryURL,
      assetsPath: Bundle.main.resourceURL?.path,
      onData: { data in
        Task {
          await rpcChannel.receive(data)
        }
      },
      onLog: { message in
        print("\(logPrefix) log: \(message)")
      },
      onClosed: {
        Task {
          await rpcChannel.failPending(
            NSError(
              domain: "PearTubeDesktopTests.BareKit",
              code: 1,
              userInfo: [NSLocalizedDescriptionKey: "Embedded BareKit worklet closed."]
            )
          )
        }
      }
    )

    session = createdSession
    return (createdSession, rpcChannel)
  }

  @MainActor
  private func bootstrapEmbeddedHost(storagePath: String) async throws -> NativeBridgeBootstrapResponse {
    let (session, rpcChannel) = try makeEmbeddedHostSession(
      logPrefix: "BareKit reopen bootstrap"
    )
    do {
      let request = try NativeBridgePayload.encode(
        NativeBridgeBootstrapRequestCodec(),
        value: NativeBridgeBootstrapRequest(storagePath: storagePath)
      )
      let responseData = try await withTimeout(label: "embedded BareKit bootstrap response") {
        try await rpcChannel.request(command: NativeBridgeCommand.bootstrap.rawValue, data: request)
      }
      let response = try NativeBridgePayload.decode(
        NativeBridgeBootstrapResponseCodec(),
        from: responseData
      )
      await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit reopen bootstrap")
      return response
    } catch {
      await shutdownEmbeddedHost(session: session, rpcChannel: rpcChannel, label: "BareKit reopen bootstrap")
      throw error
    }
  }

  @MainActor
  private func shutdownEmbeddedHost(
    session: EmbeddedBareKitSession,
    rpcChannel: BridgeRPCChannel,
    label: String
  ) async {
    do {
      let responseData = try await withTimeout(label: "\(label) shutdown response") {
        try await rpcChannel.request(command: NativeBridgeCommand.shutdown.rawValue, data: nil)
      }
      let response = try NativeBridgePayload.decode(
        NativeBridgeShutdownResponseCodec(),
        from: responseData
      )
      print("\(label) shutdown acknowledged: \(response.success)")
    } catch {
      print("\(label) shutdown failed: \(error.localizedDescription)")
    }

    session.terminate()
  }

  private func bareKitBareFsBundleURL() throws -> URL {
    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let generatedBundle = candidate
        .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
        .appendingPathComponent("barekit-bare-fs.bundle")

      if FileManager.default.fileExists(atPath: packageJSON.path)
          && FileManager.default.fileExists(atPath: generatedBundle.path) {
        return generatedBundle
      }

      candidate.deleteLastPathComponent()
    }

    throw XCTSkip("Could not resolve the workspace bundled bare-fs worklet artifact.")
  }

  private func bareKitCorestoreBundleURL() throws -> URL {
    var candidate = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()

    while candidate.path != "/" {
      let packageJSON = candidate.appendingPathComponent("package.json")
      let generatedBundle = candidate
        .appendingPathComponent("packages/desktop-native/Resources/Generated", isDirectory: true)
        .appendingPathComponent("barekit-corestore.bundle")

      if FileManager.default.fileExists(atPath: packageJSON.path)
          && FileManager.default.fileExists(atPath: generatedBundle.path) {
        return generatedBundle
      }

      candidate.deleteLastPathComponent()
    }

    throw XCTSkip("Could not resolve the workspace bundled corestore worklet artifact.")
  }

  @MainActor
  private func withTimeout<T>(
    label: String,
    seconds: TimeInterval = 5.0,
    operation: @escaping @Sendable () async throws -> T
  ) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask {
        try await operation()
      }

      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        throw BareKitTimeoutError(label: label)
      }

      guard let result = try await group.next() else {
        throw BareKitTimeoutError(label: label)
      }

      group.cancelAll()
      return result
    }
  }
}
