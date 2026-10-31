package to.holepunch.bare.kit

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred

/**
 * A Bare runtime running on a thread of its own within the process.
 *
 * Closing a worklet terminates it, so keep it open for as long as it should run. Use [Ipc] to
 * communicate with it.
 *
 * @param context A context of the application, whose application context is handed to the native
 *   addons of the worklet.
 * @throws BareKitException.Failed If the worklet could not be created.
 */
public class Worklet(context: Context, options: Options = Options()) : AutoCloseable {
  /** The options of a worklet. */
  public data class Options(
    /**
     * The memory limit of each JavaScript heap in bytes, or 0 to infer the limit from the amount of
     * physical memory of the device.
     */
    public val memoryLimit: Long = 0
  )

  internal val handle = Native.workletCreate(options.memoryLimit, context.applicationContext)

  private val closed = AtomicBoolean(false)
  private val exited = CompletableDeferred<Int>()

  /**
   * Starts the worklet, running [filename] with [arguments] as `Bare.argv`. A relative [filename]
   * names an asset of the application. The assets listed in `<name>.assets`, one `/<path>` per
   * line, are extracted from `<name>/<path>` before `<name>.bundle` first runs.
   *
   * @param filename The path or URL of the module to run.
   * @param source The source of the module, or `null` to read it from [filename].
   * @param arguments The arguments passed to the module as `Bare.argv`.
   * @throws BareKitException.Failed If the worklet could not be started, such as after [teardown].
   */
  public fun start(
    filename: String,
    source: ByteArray? = null,
    arguments: List<String> = emptyList(),
  ) {
    Native.workletStart(handle, this, filename, source, arguments.toTypedArray())
  }

  /**
   * Suspends the worklet, emitting `suspend` on `Bare`.
   *
   * @param linger How long in milliseconds the worklet may keep running before it idles, or -1 for
   *   as long as the platform allows.
   */
  public fun suspend(linger: Int = -1): Unit = Native.workletSuspend(handle, linger)

  /** Resumes a suspended worklet, emitting `resume` on `Bare`. */
  public fun resume(): Unit = Native.workletResume(handle)

  /**
   * Wakes up a suspended worklet, emitting `wakeup` on `Bare`.
   *
   * @param deadline How long in milliseconds the worklet may run before it idles again, or -1 for
   *   as long as the platform allows.
   */
  public fun wakeup(deadline: Int = -1): Unit = Native.workletWakeup(handle, deadline)

  /** Terminates the worklet. Use [wait] to wait for it to exit. */
  public fun terminate(): Unit = Native.workletTerminate(handle)

  /**
   * Waits for a started worklet to exit, whether on its own or because it was terminated.
   *
   * @return The exit code of the worklet.
   */
  public suspend fun wait(): Int = exited.await()

  /** Terminates the worklet if it is still running and releases it. Closing twice is a no-op. */
  public override fun close() {
    if (closed.compareAndSet(false, true)) Native.workletDestroy(handle)
  }

  // Called from native code on the worklet thread.
  @Suppress("unused")
  private fun onExit(code: Int) {
    exited.complete(code)
  }

  /** The state shared by the worklets of the process. */
  public companion object {
    /** Trades performance for memory. Must be configured before starting the first worklet. */
    public fun optimizeForMemory(enabled: Boolean): Unit = Native.optimizeForMemory(enabled)

    /**
     * Tears down the state shared by the worklets of the process. Every worklet must have been
     * terminated or closed first, and those still exiting are waited for. Must be called at most
     * once, after which starting a worklet fails. A process that runs worklets for as long as it
     * lives need not call it.
     */
    public fun teardown(): Unit = Native.teardown()
  }
}
