package to.holepunch.bare.kit

import android.content.Context

internal object Native {
  init {
    System.loadLibrary("bare-kit")
  }

  @JvmStatic external fun optimizeForMemory(enabled: Boolean)

  @JvmStatic external fun teardown()

  @JvmStatic external fun workletCreate(memoryLimit: Long, context: Context): Long

  @JvmStatic external fun workletDestroy(handle: Long)

  @JvmStatic
  external fun workletStart(
    handle: Long,
    receiver: Worklet,
    filename: String,
    source: ByteArray?,
    arguments: Array<String>,
  )

  @JvmStatic external fun workletSuspend(handle: Long, linger: Int)

  @JvmStatic external fun workletResume(handle: Long)

  @JvmStatic external fun workletWakeup(handle: Long, deadline: Int)

  @JvmStatic external fun workletTerminate(handle: Long)

  @JvmStatic external fun ipcCreate(worklet: Long): Long

  @JvmStatic external fun ipcClose(handle: Long)

  @JvmStatic external fun ipcEnd(handle: Long)

  @JvmStatic external fun ipcDestroy(handle: Long)

  @JvmStatic external fun ipcRead(handle: Long, buffer: ByteArray): Int

  @JvmStatic external fun ipcWrite(handle: Long, buffer: ByteArray, offset: Int, length: Int): Int

  @JvmStatic external fun pollCreate(ipc: Long, receiver: Any): Long

  @JvmStatic external fun pollDestroy(handle: Long)

  @JvmStatic external fun pollStart(handle: Long, events: Int)

  @JvmStatic external fun pollStop(handle: Long)
}
