package to.holepunch.bare.kit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow

/**
 * The host end of the IPC of a worklet, exposed as `Bare.IPC` in the worklet.
 *
 * @throws BareKitException.Failed If the worklet already has an IPC or has been terminated.
 */
public class Ipc(worklet: Worklet) : AutoCloseable {
  private val handle = Native.ipcCreate(worklet.handle)
  private val received = Channel<ByteArray>(Channel.UNLIMITED)

  // Polls call back on a thread owned by the IPC, while writes may come from any thread, so the
  // state below is guarded by the lock.
  private val lock = Any()
  private val buffer = ByteArray(READ_BUFFER_SIZE)
  private val writes = ArrayDeque<Write>()
  private var reading = true
  private var ending = false
  private var closed = false

  private val poll =
    try {
      Native.pollCreate(handle, this)
    } catch (error: BareKitException) {
      Native.ipcDestroy(handle)

      throw error
    }

  init {
    synchronized(lock) { update() }
  }

  /**
   * The data the worklet writes to `Bare.IPC`, until the worklet ends its end or the IPC is closed.
   * It can be collected only once.
   */
  public val data: Flow<ByteArray> = received.consumeAsFlow()

  /**
   * Writes [data] to `Bare.IPC` of the worklet, waiting for room as needed.
   *
   * @throws BareKitException.Closed If the IPC is ended or closed before all of the data is
   *   written.
   */
  public suspend fun write(data: ByteArray) {
    val written = CompletableDeferred<Unit>()

    synchronized(lock) {
      if (closed || ending) throw BareKitException.Closed()

      writes.addLast(Write(data, written))

      flush()
      update()
    }

    written.await()
  }

  /**
   * Ends the data written to `Bare.IPC` once the pending writes complete, after which the worklet
   * reads end-of-stream while [data] keeps collecting. Writes fail afterwards. Ending twice, or
   * after closing, is a no-op.
   */
  public fun end() {
    synchronized(lock) {
      if (closed || ending) return

      ending = true

      if (writes.isEmpty()) Native.ipcEnd(handle)
    }
  }

  /**
   * Closes the IPC and releases it, after which collection ends and writes fail. Closing twice is a
   * no-op.
   */
  public override fun close() {
    synchronized(lock) {
      if (closed) return

      closed = true

      fail()

      received.close()
    }

    // Outside of the lock, as destroying the poll waits for a running callback, which takes it.
    Native.pollDestroy(poll)
    Native.ipcDestroy(handle)
  }

  // Called from native code on the thread owned by the IPC.
  @Suppress("unused")
  private fun onPoll(events: Int) {
    synchronized(lock) {
      if (closed) return

      if (events and READABLE != 0) drain()
      if (events and WRITABLE != 0) flush()

      update()
    }
  }

  private fun update() {
    var events = 0

    if (reading) events = events or READABLE
    if (writes.isNotEmpty()) events = events or WRITABLE

    if (events == 0) Native.pollStop(poll) else Native.pollStart(poll, events)
  }

  private fun drain() {
    while (true) {
      val read = Native.ipcRead(handle, buffer)

      if (read > 0) {
        received.trySend(buffer.copyOf(read))
      } else {
        if (read == 0) {
          reading = false

          received.close()
        }

        return
      }
    }
  }

  private fun flush() {
    while (true) {
      val write = writes.firstOrNull() ?: return drained()

      val remaining = write.data.size - write.offset

      val written =
        if (remaining == 0) 0 else Native.ipcWrite(handle, write.data, write.offset, remaining)

      when {
        written == ERROR -> return fail()
        written == WOULD_BLOCK -> return
        written < remaining -> write.offset += written
        else -> {
          writes.removeFirst()

          write.written.complete(Unit)
        }
      }
    }
  }

  private fun drained() {
    if (ending) Native.ipcEnd(handle)
  }

  private fun fail() {
    for (write in writes) write.written.completeExceptionally(BareKitException.Closed())

    writes.clear()
  }

  private class Write(val data: ByteArray, val written: CompletableDeferred<Unit>) {
    var offset = 0
  }

  private companion object {
    const val READ_BUFFER_SIZE = 64 * 1024

    const val READABLE = 0x1
    const val WRITABLE = 0x2

    const val WOULD_BLOCK = -1
    const val ERROR = -2
  }
}
