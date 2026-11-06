package com.peartube.app

import android.content.Context
import com.peartube.shared.WorkerException
import com.peartube.shared.WorkletBridge
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
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet
import java.io.File
import java.util.concurrent.Executors

class Worker(context: Context) {
    sealed interface Event {
        data object Update : Event
        data class Sources(val list: List<SourceInfo>) : Event
        data class Cast(val status: CastStatus) : Event
        data class Fatal(val message: String) : Event
        data object Exited : Event
    }

    private val storeDir = context.noBackupFilesDir
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 64)
    val events: SharedFlow<Event> = _events

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lifecycle = Executors.newSingleThreadExecutor { Thread(it, "peartube-worklet") }.asCoroutineDispatcher()
    private val ready = CompletableDeferred<Ipc?>()
    private var worklet: Worklet? = null

    private val bridge = WorkletBridge(
        ready = ready,
        scope = scope,
        onEvent = ::dispatchEvent,
        onFatal = { _events.tryEmit(Event.Exited) },
        stoppedMessage = "The P2P worker stopped",
    )

    init {
        scope.launch(lifecycle) {
            try {
                val bundle = context.assets.open("worker.bundle").use { it.readBytes() }
                val worklet = Worklet(context)
                val ipc = Ipc(worklet)
                worklet.start("/worker.bundle", bundle)
                this@Worker.worklet = worklet
                ready.complete(ipc)
                scope.launch { bridge.read(ipc) }
                // Casting works before (and between) node starts once the worklet knows where pairings live.
                scope.launch { runCatching { call("init", JSONObject().put("castStorage", File(storeDir, "cast").path)) } }
            } catch (e: Throwable) {
                ready.complete(null)
                bridge.fail("The P2P worker did not start: ${e.message ?: e}")
            }
        }
    }

    suspend fun start(settings: Settings): Status {
        val legacyPreSynced = settings.tracker.isEmpty() && settings.mnemonic.isEmpty() && settings.sources.size == 1 &&
            File(storeDir, "trackers/${settings.sources[0].key}").isDirectory
        val effectiveSettings = if (legacyPreSynced) {
            settings.copy(tracker = settings.sources[0].key, sources = emptyList())
        } else {
            settings
        }
        if (effectiveSettings.tracker.isEmpty() && effectiveSettings.mnemonic.isEmpty()) {
            runCatching { File(storeDir, "trackers/default").deleteRecursively() }
            runCatching { File(storeDir, "trackers/channels").deleteRecursively() }
        }
        val params = JSONObject()
            .put("trackersDir", File(storeDir, "trackers").path)
            .put("defaultFolder", "channels-v2")
            .put("settings", effectiveSettings.toJson())
        return Status.from(call("start", params) as JSONObject)
    }

    suspend fun normalizeSettings(raw: JSONObject, requireChannel: Boolean): Settings {
        val params = JSONObject()
            .put("settings", raw)
            .put("requireChannel", requireChannel)
        val res = call("normalizeSettings", params) as JSONObject
        return Settings.fromJson(res)
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

    suspend fun openUri(uri: String): OpenUriResult =
        OpenUriResult.from(call("openUri", JSONObject().put("uri", uri)) as JSONObject)

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
        CastStatus.from(call("castStatus") as? JSONObject)

    suspend fun castPair(params: JSONObject): CastStatus =
        CastStatus.from(call("castPair", params) as? JSONObject)

    suspend fun castRemove(id: String): CastStatus =
        CastStatus.from(call("castRemove", JSONObject().put("id", id)) as? JSONObject)

    suspend fun castPlay(receiverId: String, key: String, preferMode: String = "auto", startPositionMs: Long = 0L): CastStatus =
        CastStatus.from(
            call(
                "castPlay",
                JSONObject()
                    .put("receiverId", receiverId)
                    .put("key", key)
                    .put("preferMode", preferMode)
                    .put("startPositionMs", startPositionMs),
            ) as? JSONObject,
        )

    suspend fun castAttach(receiverId: String): CastStatus =
        CastStatus.from(call("castAttach", JSONObject().put("receiverId", receiverId)) as? JSONObject)

    suspend fun castControl(params: JSONObject): CastStatus =
        CastStatus.from(call("castControl", params) as? JSONObject)

    suspend fun castStop(stopPlayback: Boolean = true): CastStatus =
        CastStatus.from(call("castStop", JSONObject().put("stopPlayback", stopPlayback)) as? JSONObject)

    /** Stops the worklet's I/O while the app is in the background. */
    fun suspend() {
        scope.launch(lifecycle) { worklet?.suspend() }
    }

    fun resume() {
        scope.launch(lifecycle) { worklet?.resume() }
    }

    private suspend fun call(method: String, params: JSONObject = JSONObject()): Any? =
        bridge.call(method, params)

    private fun dispatchEvent(event: String, msg: JSONObject) {
        when (event) {
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
}
