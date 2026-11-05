package com.peartube.app

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import to.holepunch.bare.kit.BareKitException
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class WorkerException(message: String) : Exception(message)

/**
 * The P2P worker: a Bare worklet running worklet/worker.js, the relay's own core. We talk
 * to it in newline-delimited JSON over bare-kit's IPC; worker.js documents the messages.
 * bare-kit-kotlin's Ipc queues whole writes in order, so concurrent calls never interleave lines.
 */
class Worker(context: Context) {
    sealed interface Event {
        /** A tracker, channel, peer set, or LAN discovery changed. */
        data object Update : Event

        /** Subscribed sources changed through the loopback HTTP daemon. */
        data class Sources(val list: List<SourceInfo>) : Event


        /** Cast receivers, active cast session, or local TV receiver state changed. */
        data class Cast(val status: CastStatus) : Event

        /** The worker hit an uncaught error. */
        data class Fatal(val message: String) : Event

        /** The worklet closed its IPC; no more replies will come. */
        data object Exited : Event
    }

    private val storeDir = context.noBackupFilesDir
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<Any?>>()
    private val nextId = AtomicLong(1)
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 64)
    val events: SharedFlow<Event> = _events

    // Guards failure and the registration of replies, so a failure can't land between a
    // call's check and its registration and leave the reply unanswered.
    private val lock = Any()
    private var failure: String? = null

    // Worklet.start() blocks until the worklet thread has set Bare up, so starting, suspending
    // and resuming run in order on a thread of their own, never the UI thread. Calls wait for
    // the ipc, which is null if the worker did not start.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lifecycle = Executors.newSingleThreadExecutor { Thread(it, "peartube-worklet") }.asCoroutineDispatcher()
    private val ready = CompletableDeferred<Ipc?>()
    private var worklet: Worklet? = null

    init {
        scope.launch(lifecycle) {
            try {
                val bundle = context.assets.open("worker.bundle").use { it.readBytes() }
                val worklet = Worklet(context)
                // The ipc exists before the worker runs, so nothing it writes at start is missed.
                val ipc = Ipc(worklet)
                worklet.start("/worker.bundle", bundle)
                this@Worker.worklet = worklet
                ready.complete(ipc)
                scope.launch { read(ipc) }
            } catch (e: Throwable) {
                ready.complete(null)
                fail("The P2P worker did not start: ${e.message ?: e}")
            }
        }
    }

    suspend fun start(settings: Settings): Status {
        val legacyPreSynced = settings.tracker.isEmpty() && settings.mnemonic.isEmpty() && settings.sources.size == 1 &&
            File(storeDir, "trackers/${settings.sources[0].key}").isDirectory
        val effectiveTracker = if (legacyPreSynced) settings.sources[0].key else settings.tracker
        val effectiveSources = if (legacyPreSynced) emptyList() else settings.sources
        val folder = when {
            effectiveTracker.isNotEmpty() -> effectiveTracker
            settings.mnemonic.isNotEmpty() -> "linked"
            else -> {
                runCatching { File(storeDir, "trackers/default").deleteRecursively() }
                runCatching { File(storeDir, "trackers/channels").deleteRecursively() }
                "channels-v2"
            }
        }
        // The user's own bootstrap, or nothing at all: `hyperdht`'s built-in table is the one that
        // stays current. Resolving hostnames here pinned the phone to servers that later died
        // (bootstrap1..3.hyperdht.org resolve to hosts the DHT no longer answers on), and a phone
        // that cannot join the public swarm can only ever replay what its LAN peers happen to hold.
        val srcArray = JSONArray().apply { effectiveSources.forEach { put(it.toJson()) } }
        val params = JSONObject()
            .put("storage", File(storeDir, "trackers/$folder").path)
            .put("tracker", if (effectiveTracker.isEmpty()) JSONObject.NULL else effectiveTracker)
            .put("mnemonic", if (settings.mnemonic.isEmpty()) JSONObject.NULL else settings.mnemonic)
            .put("join", settings.mnemonic.isNotEmpty() && effectiveTracker.isEmpty())
            .put("sources", srcArray)
            .put("relayThrough", if (settings.relayThrough.isEmpty()) JSONObject.NULL else JSONArray(settings.relayThrough))
            .put("bootstrap", if (settings.bootstrap.isEmpty()) JSONObject.NULL else JSONArray(settings.bootstrap))
            .put("lan", settings.lanDiscovery)
            .put("privateRouting", settings.privateRouting)
            .put("cacheMaxGb", settings.cacheMaxGb)
        return Status.from(call("start", params) as JSONObject)
    }

    suspend fun status(): Status = Status.from(call("status") as JSONObject)

    /** Applies the playback cache ceiling without restarting the worklet. */
    suspend fun setCacheMax(bytes: Long): Long {
        val res = call("setCacheMax", JSONObject().put("maxBytes", bytes)) as JSONObject
        return res.optLong("cacheMaxBytes", 0L)
    }

    /** Every entry across subscribed trackers and channels. */
    suspend fun search(id: String? = null): List<Entry> {
        val list = call("search", JSONObject().put("id", id ?: JSONObject.NULL)) as JSONArray
        return List(list.length()) { Entry.from(list.getJSONObject(it)) }
    }

    suspend fun focusSource(key: String) {
        call("focusSource", JSONObject().put("key", key))
    }

    suspend fun setPlayerActive(active: Boolean) {
        call("setPlayerActive", JSONObject().put("active", active))
    }

    suspend fun warm(key: String) {
        call("warm", JSONObject().put("key", key))
    }

    private val castDir: String get() = File(storeDir, "cast").path

    suspend fun openUri(uri: String): OpenUriResult =
        OpenUriResult.from(call("openUri", JSONObject().put("uri", uri).put("storage", castDir)) as JSONObject)

    suspend fun removeSource(key: String) {
        call("removeSource", JSONObject().put("key", key))
    }

    suspend fun removeEntry(key: String) {
        call("remove", JSONObject().put("key", key))
    }

    suspend fun identity(revealMnemonic: Boolean = false): IdentityInfo =
        IdentityInfo.from(call("identity", JSONObject().put("revealMnemonic", revealMnemonic)) as JSONObject)

    suspend fun revokeWriter(writer: String, purgeEntries: Boolean = false) {
        call("revokeWriter", JSONObject().put("writer", writer).put("purgeEntries", purgeEntries))
    }

    suspend fun rotateEpoch(): JSONObject =
        call("rotateEpoch", JSONObject()) as JSONObject

    suspend fun clearCache(key: String? = null): Pair<Long, Long> {
        val res = call("clearCache", JSONObject().put("key", key ?: JSONObject.NULL)) as? JSONObject
        return (res?.optLong("clearedBytes", 0L) ?: 0L) to (res?.optLong("reclaimedBytes", 0L) ?: 0L)
    }

    suspend fun castStatus(): CastStatus =
        CastStatus.from(call("castStatus", JSONObject().put("storage", castDir)) as? JSONObject)

    suspend fun castPair(params: JSONObject): CastStatus =
        CastStatus.from(call("castPair", params.put("storage", castDir)) as? JSONObject)

    suspend fun castRemove(id: String): CastStatus =
        CastStatus.from(call("castRemove", JSONObject().put("id", id).put("storage", castDir)) as? JSONObject)

    suspend fun castPlay(receiverId: String, key: String, preferMode: String = "auto", startPositionMs: Long = 0L): CastStatus =
        CastStatus.from(
            call(
                "castPlay",
                JSONObject()
                    .put("storage", castDir)
                    .put("receiverId", receiverId)
                    .put("key", key)
                    .put("preferMode", preferMode)
                    .put("startPositionMs", startPositionMs),
            ) as? JSONObject,
        )


    suspend fun castAttach(receiverId: String): CastStatus =
        CastStatus.from(call("castAttach", JSONObject().put("storage", castDir).put("receiverId", receiverId)) as? JSONObject)
    suspend fun castControl(params: JSONObject): CastStatus =
        CastStatus.from(call("castControl", params.put("storage", castDir)) as? JSONObject)

    suspend fun castStop(stopPlayback: Boolean = true): CastStatus =
        CastStatus.from(call("castStop", JSONObject().put("storage", castDir).put("stopPlayback", stopPlayback)) as? JSONObject)

    /** Stops the worklet's I/O while the app is in the background. */
    fun suspend() {
        scope.launch(lifecycle) { worklet?.suspend() }
    }

    fun resume() {
        scope.launch(lifecycle) { worklet?.resume() }
    }

    private suspend fun call(method: String, params: JSONObject = JSONObject()): Any? {
        val id = nextId.getAndIncrement()
        val reply = CompletableDeferred<Any?>()
        val line = JSONObject().put("id", id).put("method", method).put("params", params).toString() + "\n"
        synchronized(lock) {
            failure?.let { throw WorkerException(it) }
            pending[id] = reply
        }
        try {
            val ipc = ready.await() ?: throw WorkerException(failure ?: "The P2P worker did not start")
            try {
                ipc.write(line.toByteArray())
            } catch (e: BareKitException.Closed) {
                throw WorkerException(failure ?: "The P2P worker stopped")
            }
            return reply.await()
        } finally {
            pending.remove(id)
        }
    }

    private suspend fun read(ipc: Ipc) {
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
        fail("The P2P worker stopped")
    }

    private fun dispatch(line: String) {
        val msg = try {
            JSONObject(line)
        } catch (e: Exception) {
            _events.tryEmit(Event.Fatal("Malformed message from the P2P worker: ${e.message}"))
            return
        }
        if (msg.has("id")) {
            val reply = pending.remove(msg.getLong("id")) ?: return
            if (msg.has("error")) reply.completeExceptionally(WorkerException(msg.optString("error")))
            else reply.complete(msg.opt("result"))
            return
        }
        when (msg.optString("event")) {
            "update" -> _events.tryEmit(Event.Update)
            "sources" -> {
                val arr = msg.optJSONArray("sources")
                if (arr != null) {
                    _events.tryEmit(Event.Sources(List(arr.length()) { SourceInfo.from(arr.getJSONObject(it)) }))
                }
                _events.tryEmit(Event.Update)
            }
            "cast" -> _events.tryEmit(Event.Cast(CastStatus.from(msg.optJSONObject("cast"))))
            "fatal" -> _events.tryEmit(Event.Fatal(msg.optString("error")))
        }
    }

    private fun fail(message: String) {
        synchronized(lock) {
            if (failure != null) return
            failure = message
        }
        pending.values.forEach { it.completeExceptionally(WorkerException(message)) }
        pending.clear()
        _events.tryEmit(Event.Exited)
    }
}
