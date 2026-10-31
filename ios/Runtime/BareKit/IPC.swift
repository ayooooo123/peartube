import Foundation

/// The host end of the IPC of a worklet, exposed as `Bare.IPC` in the worklet.
///
/// Iterating an IPC yields the data the worklet writes to `Bare.IPC` until the
/// worklet ends its end or the IPC is closed.
public final class IPC: AsyncSequence, @unchecked Sendable {
  public typealias Element = Data

  private let handle: OpaquePointer
  private let poll: OpaquePointer
  private let channel: Channel

  /// Opens the IPC of `worklet`.
  ///
  /// - Throws: ``BareKitError/failed(_:)`` if the worklet already has an IPC or
  ///   has been terminated.
  public init(worklet: Worklet) throws {
    var handle: OpaquePointer?

    var status = bare_ipc_create(worklet.handle, &handle)

    guard status == 0, let handle else { throw BareKitError.failed(status) }

    var poll: OpaquePointer?

    status = bare_ipc_poll_create(handle, &poll)

    guard status == 0, let poll else {
      bare_ipc_destroy(handle)

      throw BareKitError.failed(status)
    }

    self.handle = handle
    self.poll = poll

    channel = Channel(handle, poll)

    bare_ipc_poll_set_data(poll, Unmanaged.passUnretained(channel).toOpaque())

    channel.update()
  }

  deinit {
    bare_ipc_poll_destroy(poll)
    bare_ipc_destroy(handle)

    channel.finish()
  }

  public func makeAsyncIterator() -> AsyncStream<Data>.AsyncIterator {
    channel.data.makeAsyncIterator()
  }

  /// Writes `data` to `Bare.IPC` of the worklet, waiting for room as needed.
  ///
  /// - Throws: ``BareKitError/closed`` if the IPC is ended or closed before all
  ///   of the data is written.
  public func write(_ data: Data) async throws {
    try await withCheckedThrowingContinuation { continuation in
      channel.write(data, continuation)
    }
  }

  /// Ends the data written to `Bare.IPC` once the pending writes complete,
  /// after which the worklet reads end-of-stream while iteration continues.
  /// Writes fail afterwards. Ending twice, or after closing, is a no-op.
  public func end() {
    channel.end()
  }

  /// Closes the IPC, after which iteration ends and writes fail. Closing twice
  /// is a no-op.
  public func close() {
    bare_ipc_close(handle)
  }
}

// Polls call back on a thread owned by the ipc, while writes may come from any
// thread, so the pending writes are guarded by the lock.
private final class Channel: @unchecked Sendable {
  let data: AsyncStream<Data>

  private let handle: OpaquePointer
  private let poll: OpaquePointer
  private let continuation: AsyncStream<Data>.Continuation
  private let lock = NSLock()

  private var buffer = [UInt8](repeating: 0, count: Int(BARE_IPC_READ_BUFFER_SIZE))
  private var reading = true
  private var ending = false
  private var writes: [(data: Data, continuation: CheckedContinuation<Void, Error>)] = []

  init(_ handle: OpaquePointer, _ poll: OpaquePointer) {
    self.handle = handle
    self.poll = poll

    (data, continuation) = AsyncStream.makeStream()
  }

  func write(_ data: Data, _ continuation: CheckedContinuation<Void, Error>) {
    lock.withLock {
      if ending { return continuation.resume(throwing: BareKitError.closed) }

      writes.append((data, continuation))

      flush()
      update()
    }
  }

  func end() {
    lock.withLock {
      if ending { return }

      ending = true

      if writes.isEmpty { bare_ipc_end(handle) }
    }
  }

  func finish() {
    continuation.finish()
  }

  func update() {
    var events: Int32 = 0

    if reading { events |= Int32(bare_ipc_readable) }
    if !writes.isEmpty { events |= Int32(bare_ipc_writable) }

    if events == 0 {
      bare_ipc_poll_stop(poll)
    } else {
      bare_ipc_poll_start(poll, events) { poll, events in
        Unmanaged<Channel>.fromOpaque(bare_ipc_poll_get_data(poll)!).takeUnretainedValue()
          .onpoll(events)
      }
    }
  }

  private func onpoll(_ events: Int32) {
    lock.withLock {
      if events & Int32(bare_ipc_readable) != 0 { drain() }
      if events & Int32(bare_ipc_writable) != 0 { flush() }

      update()
    }
  }

  private func drain() {
    while true {
      let read = buffer.withUnsafeMutableBytes { bare_ipc_read(handle, $0.baseAddress, $0.count) }

      if read > 0 {
        continuation.yield(Data(buffer[0..<Int(read)]))
      } else {
        if read == 0 {
          reading = false
          continuation.finish()
        }

        return
      }
    }
  }

  private func flush() {
    while let write = writes.first {
      let data = write.data

      let written =
        data.isEmpty
        ? 0 : Int(data.withUnsafeBytes { bare_ipc_write(handle, $0.baseAddress, $0.count) })

      if written == bare_ipc_error {
        for write in writes { write.continuation.resume(throwing: BareKitError.closed) }

        writes.removeAll()
      } else if written == bare_ipc_would_block {
        return
      } else if written < data.count {
        writes[0].data = data.subdata(in: written..<data.count)
      } else {
        writes.removeFirst()

        write.continuation.resume()
      }
    }

    if ending { bare_ipc_end(handle) }
  }
}
