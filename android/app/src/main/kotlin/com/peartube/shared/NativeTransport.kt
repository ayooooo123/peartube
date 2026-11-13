package com.peartube.shared

import kotlinx.coroutines.CompletableDeferred
import org.json.JSONObject
import java.util.function.Consumer

/**
 * libpeartube_native_ffi's C ABI. android/jni/peartube_jni.c implements it.
 * Loading starts on first use, so a JS build never loads either library.
 */
object PearTubeNative {
    init {
        System.loadLibrary("peartube_native_ffi")
        System.loadLibrary("peartube_jni")
    }

    external fun ptAbiVersion(): Int
    external fun ptInit(config: ByteArray, on: Consumer<ByteArray>): Long
    external fun ptSendLine(handle: Long, line: ByteArray): Int
    external fun ptSuspend(handle: Long, lingerMs: Long)
    external fun ptResume(handle: Long)
    external fun ptShutdown(handle: Long)
}

/** The Rust engine: peartube-native behind the C ABI, speaking worker.js's JSON lines. */
class NativeTransport(private val config: JSONObject = JSONObject()) : EngineTransport {
    private val started = CompletableDeferred<Boolean>()
    /** The engine's thread or handle is gone: no line will arrive again. */
    private val stopped = CompletableDeferred<Unit>()
    @Volatile private var handle = 0L

    override suspend fun send(line: ByteArray) {
        if (!started.await()) throw EngineClosedException()
        when (val status = PearTubeNative.ptSendLine(handle, line)) {
            PT_OK -> {}
            // The C ABI has no exit callback: a send is where a dead engine shows. Ending read() makes the
            // bridge fail every call still waiting for a reply, not only this one.
            PT_ERR_UNKNOWN_HANDLE, PT_ERR_BACKEND -> {
                stopped.complete(Unit)
                throw EngineClosedException()
            }
            else -> throw WorkerException("the engine rejected a line ($status)")
        }
    }

    override suspend fun read(onLine: (String) -> Unit) {
        try {
            check(PearTubeNative.ptAbiVersion() == ABI_VERSION) { "the engine's ABI is not $ABI_VERSION" }
            // The engine calls this on one output thread; its bytes live only during the call.
            val consumer = Consumer<ByteArray> { bytes -> onLine(String(bytes, Charsets.UTF_8)) }
            val handle = PearTubeNative.ptInit(config.toString().toByteArray(), consumer)
            check(handle != 0L) { "the engine did not start" }
            this.handle = handle
            started.complete(true)
        } catch (e: Throwable) {
            started.complete(false)
            throw e
        }
        try {
            stopped.await()
        } finally {
            val handle = handle
            if (handle != 0L) PearTubeNative.ptShutdown(handle)
        }
    }

    override fun suspend() {
        if (handle != 0L) PearTubeNative.ptSuspend(handle, SUSPEND_LINGER_MS)
    }

    override fun resume() {
        if (handle != 0L) PearTubeNative.ptResume(handle)
    }

    private companion object {
        const val ABI_VERSION = 1
        const val PT_OK = 0
        const val PT_ERR_UNKNOWN_HANDLE = 4
        const val PT_ERR_BACKEND = 5
        /** Peers linger briefly across a background/foreground switch. */
        const val SUSPEND_LINGER_MS = 2_000L
    }
}
