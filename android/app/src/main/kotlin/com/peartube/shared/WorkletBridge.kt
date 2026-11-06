package com.peartube.shared

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import to.holepunch.bare.kit.BareKitException
import to.holepunch.bare.kit.Ipc
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class WorkerException(message: String) : Exception(message)

class WorkletBridge(
    private val ready: CompletableDeferred<Ipc?>,
    private val scope: CoroutineScope,
    private val onEvent: (event: String, msg: JSONObject) -> Unit,
    private val onFatal: ((message: String) -> Unit)? = null,
    private val stoppedMessage: String = "The P2P worker stopped",
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
            val ipc = ready.await() ?: throw WorkerException(failure ?: stoppedMessage)
            try {
                ipc.write(line.toByteArray())
            } catch (e: BareKitException.Closed) {
                throw WorkerException(failure ?: stoppedMessage)
            }
            return reply.await()
        } finally {
            pending.remove(id)
        }
    }

    suspend fun read(ipc: Ipc) {
        val incoming = ByteArrayOutputStream()
        ipc.data.collect { bytes ->
            var start = 0
            for (i in bytes.indices) {
                if (bytes[i] == '\n'.code.toByte()) {
                    incoming.write(bytes, start, i - start)
                    dispatch(incoming.toString(Charsets.UTF_8.name()))
                    incoming.reset()
                    start = i + 1
                }
            }
            incoming.write(bytes, start, bytes.size - start)
        }
        fail(stoppedMessage)
    }

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
            onEvent(event, msg)
        }
    }

    fun fail(message: String) {
        synchronized(lock) {
            if (failure != null) return
            failure = message
        }
        pending.values.forEach { it.completeExceptionally(WorkerException(message)) }
        pending.clear()
        onFatal?.invoke(message)
    }
}
