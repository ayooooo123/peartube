package com.peartube.shared

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class WorkerException(message: String) : Exception(message)

/** The engine is gone: the transport has nothing to send to. */
class EngineClosedException(cause: Throwable? = null) : Exception(cause)

/** One newline-delimited JSON line channel to the P2P engine, whichever engine it is. */
interface EngineTransport {
    /** Sends one newline-terminated line, waiting until the engine accepts lines. */
    suspend fun send(line: ByteArray)

    /** Reads the engine's lines until it stops. */
    suspend fun read(onLine: (String) -> Unit)

    /** Drops the engine's peers in the background; its storage stays open. */
    fun suspend() {}

    fun resume() {}
}

/**
 * The app's side of the engine contract: a line with an `id` gets one reply, an
 * event line carries `event`. The transport is the Bare worklet's IPC or the
 * native C ABI; every engine speaks the same JSON lines.
 */
class EngineBridge(
    private val transport: EngineTransport,
    private val onEvent: (event: String, msg: JSONObject) -> Unit,
    private val onFatal: ((message: String) -> Unit)? = null,
    private val stoppedMessage: String = "The P2P engine stopped",
) {
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<Any?>>()
    private val nextId = AtomicLong(1)
    private val lock = Any()
    private var failure: String? = null

    suspend fun call(method: String, params: JSONObject = JSONObject()): Any? {
        val id = nextId.getAndIncrement()
        val reply = CompletableDeferred<Any?>()
        val line = JSONObject().put("id", id).put("method", method).put("params", params).toString() + "\n"
        synchronized(lock) {
            failure?.let { throw WorkerException(it) }
            pending[id] = reply
        }
        try {
            try {
                transport.send(line.toByteArray())
            } catch (e: EngineClosedException) {
                throw WorkerException(failure ?: stoppedMessage)
            }
            return reply.await()
        } finally {
            pending.remove(id)
        }
    }

    /** Runs until the engine stops, then fails every pending call. */
    suspend fun read() {
        try {
            transport.read(::dispatch)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            fail(e.message ?: stoppedMessage)
            return
        }
        fail(stoppedMessage)
    }

    fun suspend() = transport.suspend()

    fun resume() = transport.resume()

    fun fail(message: String) {
        synchronized(lock) {
            if (failure != null) return
            failure = message
        }
        pending.values.forEach { it.completeExceptionally(WorkerException(message)) }
        pending.clear()
        onFatal?.invoke(message)
    }

    /** Runs on the engine's output thread: never let an exception escape into the engine. */
    private fun dispatch(line: String) {
        val msg = runCatching { JSONObject(line) }.getOrNull() ?: return
        if (msg.has("id")) {
            val reply = pending.remove(msg.getLong("id")) ?: return
            if (msg.has("error")) reply.completeExceptionally(WorkerException(msg.optString("error")))
            else reply.complete(msg.opt("result"))
            return
        }
        val event = msg.optString("event")
        if (event.isNotEmpty()) {
            try {
                onEvent(event, msg)
            } catch (e: Exception) {
                Log.e("PearTube", "the $event handler failed", e)
            }
        }
    }
}
