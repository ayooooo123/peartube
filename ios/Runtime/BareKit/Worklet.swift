import Foundation

/// A Bare runtime running on a thread of its own within the process.
///
/// Releasing a worklet terminates it, so keep a reference for as long as it
/// should run. Use ``IPC`` to communicate with it.
public final class Worklet: @unchecked Sendable {
  /// The options of a worklet.
  public struct Options: Sendable {
    /// The memory limit of each JavaScript heap in bytes, or 0 to infer the
    /// limit from the amount of physical memory of the device.
    public var memoryLimit: Int

    public init(memoryLimit: Int = 0) {
      self.memoryLimit = memoryLimit
    }
  }

  let handle: OpaquePointer

  private let exited: AsyncStream<Int32>.Continuation
  private let termination: Task<Int32?, Never>

  /// Creates a worklet that has not yet started.
  ///
  /// - Throws: ``BareKitError/failed(_:)`` if the worklet could not be created.
  public init(options: Options = Options()) throws {
    var handle: OpaquePointer?

    var options = bare_worklet_options_t(
      version: 0,
      memory_limit: options.memoryLimit,
      platform: .init()
    )

    let status = bare_worklet_create(&options, &handle)

    guard status == 0, let handle else { throw BareKitError.failed(status) }

    self.handle = handle

    let exits: AsyncStream<Int32>

    (exits, exited) = AsyncStream.makeStream()

    termination = Task { await exits.first { _ in true } }
  }

  deinit {
    bare_worklet_destroy(handle)
  }

  /// Trades performance for memory. Must be configured before starting the
  /// first worklet.
  public static func optimizeForMemory(_ enabled: Bool) {
    bare_worklet_optimize_for_memory(enabled)
  }

  /// Tears down the state shared by the worklets of the process. Every worklet
  /// must have been terminated or released first, and those still exiting are
  /// waited for. Must be called at most once, after which starting a worklet
  /// fails. A process that runs worklets for as long as it lives need not call
  /// it.
  public static func teardown() {
    bare_worklet_teardown()
  }

  /// Starts the worklet, running `url` with `arguments` as `Bare.argv`.
  ///
  /// - Parameters:
  ///   - url: The module to run.
  ///   - source: The source of the module, or `nil` to read it from `url`.
  ///   - arguments: The arguments passed to the module as `Bare.argv`.
  /// - Throws: ``BareKitError/failed(_:)`` if the worklet could not be started,
  ///   such as after ``teardown()``.
  public func start(_ url: URL, source: Data? = nil, arguments: [String] = []) throws {
    try start(url.isFileURL ? url.path : url.absoluteString, source: source, arguments: arguments)
  }

  /// Starts the worklet, running `filename` with `arguments` as `Bare.argv`.
  /// A relative `filename` names a resource of the application bundle, which
  /// extensions share with their application.
  ///
  /// - Parameters:
  ///   - filename: The path or URL of the module to run.
  ///   - source: The source of the module, or `nil` to read it from `filename`.
  ///   - arguments: The arguments passed to the module as `Bare.argv`.
  /// - Throws: ``BareKitError/failed(_:)`` if the worklet could not be started,
  ///   such as after ``teardown()``.
  public func start(_ filename: String, source: Data? = nil, arguments: [String] = []) throws {
    // Called exactly once for a worklet that has started, which then owns the
    // continuation.
    let exit = Unmanaged.passRetained(Box(exited)).toOpaque()

    bare_worklet_on_exit(
      handle,
      { code, data in
        let exited = Unmanaged<Box<AsyncStream<Int32>.Continuation>>.fromOpaque(data!)
          .takeRetainedValue().value

        exited.yield(code)
        exited.finish()
      },
      exit
    )

    let status = arguments.withCStrings { argv in
      guard let source else {
        return bare_worklet_start(handle, filename, nil, 0, Int32(arguments.count), argv)
      }

      return source.withUnsafeBytes {
        bare_worklet_start(
          handle, filename, $0.baseAddress, $0.count, Int32(arguments.count), argv)
      }
    }

    if status != 0 {
      Unmanaged<Box<AsyncStream<Int32>.Continuation>>.fromOpaque(exit).release()

      throw BareKitError.failed(status)
    }
  }

  /// Suspends the worklet, emitting `suspend` on `Bare`.
  ///
  /// - Parameter linger: How long in milliseconds the worklet may keep running
  ///   before it idles, or -1 for as long as the platform allows.
  public func suspend(linger: Int32 = -1) {
    bare_worklet_suspend(handle, linger)
  }

  /// Resumes a suspended worklet, emitting `resume` on `Bare`.
  public func resume() {
    bare_worklet_resume(handle)
  }

  /// Wakes up a suspended worklet, emitting `wakeup` on `Bare`.
  ///
  /// - Parameter deadline: How long in milliseconds the worklet may run before
  ///   it idles again, or -1 for as long as the platform allows.
  public func wakeup(deadline: Int32 = -1) {
    bare_worklet_wakeup(handle, deadline)
  }

  /// Terminates the worklet. Use ``wait()`` to wait for it to exit.
  public func terminate() {
    bare_worklet_terminate(handle)
  }

  /// Waits for a started worklet to exit, whether on its own or because it was
  /// terminated.
  ///
  /// - Returns: The exit code of the worklet.
  @discardableResult
  public func wait() async -> Int32 {
    await termination.value!
  }
}

/// An error from Bare Kit.
public enum BareKitError: Error, Equatable {
  /// A call into Bare Kit failed with the status.
  case failed(Int32)
  /// The IPC was closed before the data could be written.
  case closed
}

final class Box<Value> {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}

extension Array where Element == String {
  fileprivate func withCStrings<Result>(
    _ body: (UnsafeMutablePointer<UnsafePointer<CChar>?>) -> Result
  ) -> Result {
    let strings = map { strdup($0) }

    defer { for string in strings { free(string) } }

    var pointers = strings.map { UnsafePointer($0) } + [nil]

    return pointers.withUnsafeMutableBufferPointer { body($0.baseAddress!) }
  }
}
