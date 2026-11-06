package com.peartube.receiver

import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.os.Environment
import android.os.StatFs
import com.peartube.shared.WorkletBridge
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import to.holepunch.bare.kit.Ipc
import to.holepunch.bare.kit.Worklet
import java.io.File

data class TvReceiverInfo(
    val deviceId: String = "",
    val name: String = "PearTube TV",
    val publicKey: String = "",
    val port: Int = 0,
    val pairCode: String = "",
    val pairingUri: String = "",
    val listenUrl: String = "",
    val mode: String? = null,
    val p2pPeers: Long = 0L,
    val storageFreeBytes: Long = 0L,
    val externalStorage: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject): TvReceiverInfo {
            val st = json.optJSONObject("state")
            return TvReceiverInfo(
                deviceId = json.optString("deviceId"),
                name = json.optString("name", "PearTube TV"),
                publicKey = json.optString("publicKey"),
                port = json.optInt("port"),
                pairCode = json.optString("pairCode"),
                pairingUri = json.optString("pairingUri"),
                listenUrl = json.optString("listenUrl"),
                mode = st?.optString("mode")?.takeUnless { st.isNull("mode") || it.isEmpty() },
                p2pPeers = st?.optLong("p2pPeers") ?: 0L,
                storageFreeBytes = json.optLong("storageFreeBytes", 0L),
                externalStorage = json.optBoolean("externalStorage", false),
            )
        }
    }
}

data class TvCommand(
    val seq: Long = 0L,
    val action: String,
    val title: String = "PearTube Cast",
    val mode: String? = null,
    val streamUrl: String? = null,
    val httpStreamUrl: String? = null,
    val startPositionMs: Long = 0L,
    val positionMs: Long? = null,
    val deltaMs: Long? = null,
    val stream: Int? = null,
) {
    companion object {
        fun from(json: JSONObject): TvCommand {
            val entry = json.optJSONObject("entry")
            return TvCommand(
                seq = json.optLong("seq"),
                action = json.optString("action"),
                title = entry?.optString("title")?.takeIf { it.isNotBlank() } ?: "PearTube Cast",
                mode = json.optString("mode").takeUnless { json.isNull("mode") || it.isEmpty() },
                streamUrl = json.optString("streamUrl").takeUnless { json.isNull("streamUrl") || it.isEmpty() },
                httpStreamUrl = json.optString("httpStreamUrl").takeUnless { json.isNull("httpStreamUrl") || it.isEmpty() },
                startPositionMs = json.optLong("startPositionMs"),
                positionMs = if (json.isNull("positionMs")) null else json.optLong("positionMs"),
                deltaMs = if (json.isNull("deltaMs")) null else json.optLong("deltaMs"),
                stream = if (json.isNull("stream")) null else json.optInt("stream"),
            )
        }
    }
}

class ReceiverWorker(private val appContext: Context) {
    private val castDir = File(appContext.noBackupFilesDir, "cast").path

    val info = MutableStateFlow<TvReceiverInfo?>(null)
    val error = MutableStateFlow<String?>(null)
    private val _commands = MutableSharedFlow<TvCommand>(replay = 1, extraBufferCapacity = 32)
    val commands: SharedFlow<TvCommand> = _commands

    @Volatile var isStreaming: Boolean = false
    @Volatile var activityResumed: Boolean = false
    @Volatile var lastHandledSeq: Long = 0L
    private val startLock = Mutex()
    private var activePeerDir: String = ""

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val ready = CompletableDeferred<Ipc?>()
    private var worklet: Worklet? = null

    private val bridge = WorkletBridge(
        ready = ready,
        scope = scope,
        onEvent = ::dispatchEvent,
        onFatal = { error.value = it },
        stoppedMessage = "Receiver engine stopped",
    )

    init {
        scope.launch(Dispatchers.IO) {
            try {
                val bundle = appContext.assets.open("worker.bundle").use { it.readBytes() }
                val w = Worklet(appContext)
                val pipe = Ipc(w)
                w.start("/worker.bundle", bundle)
                worklet = w
                ready.complete(pipe)
                scope.launch { bridge.read(pipe) }
            } catch (e: Throwable) {
                ready.complete(null)
                bridge.fail("Receiver engine failed to start: ${e.message ?: e}")
            }
        }
    }

    /** Picks the mounted external SSD / expanded volume with the most free space for P2P seed storage. */
    fun pickPeerStorageDir(): File {
        val internal = File(appContext.noBackupFilesDir, "cast").apply { mkdirs() }
        var bestDir = internal
        var bestAvail = runCatching { StatFs(internal.path).availableBytes }.getOrDefault(0L)
        val candidates = buildList {
            runCatching { appContext.getExternalFilesDirs(null) }.getOrNull()?.filterNotNull()?.let(::addAll)
            runCatching { appContext.externalMediaDirs }.getOrNull()?.filterNotNull()?.let(::addAll)
        }
        for (base in candidates) {
            val state = runCatching { Environment.getExternalStorageState(base) }.getOrDefault("")
            if (state != Environment.MEDIA_MOUNTED) continue
            val dir = File(base, "peer-seed")
            if (!runCatching { dir.mkdirs(); dir.isDirectory && dir.canWrite() }.getOrDefault(false)) continue
            val avail = runCatching { StatFs(dir.path).availableBytes }.getOrDefault(0L)
            if (avail > bestAvail + (4L shl 30)) {
                bestAvail = avail
                bestDir = dir
            }
        }
        return bestDir
    }

    suspend fun ensureStarted(name: String, openAuth: Boolean = true, forceRefreshStorage: Boolean = false): TvReceiverInfo = startLock.withLock {
        val chosenPeer = pickPeerStorageDir().path
        val existing = info.value
        if (existing != null && (!forceRefreshStorage || chosenPeer == activePeerDir || isStreaming)) {
            return@withLock existing
        }
        activePeerDir = chosenPeer
        call("init", JSONObject().put("castStorage", castDir))
        val params = JSONObject()
            .put("peerStorage", chosenPeer)
            .put("name", name)
            .put("openAuth", openAuth)
        val res = TvReceiverInfo.from(call("receiverStart", params) as JSONObject)
        info.value = res
        res
    }

    suspend fun reportState(state: JSONObject) {
        call("receiverReportState", JSONObject().put("state", state))
    }

    private suspend fun call(method: String, params: JSONObject = JSONObject()): Any? =
        bridge.call(method, params)

    private fun dispatchEvent(event: String, msg: JSONObject) {
        when (event) {
            "cast" -> {
                msg.optJSONObject("cast")?.optJSONObject("receiverMode")?.let {
                    info.value = TvReceiverInfo.from(it)
                }
            }
            "receiverCommand" -> {
                msg.optJSONObject("command")?.let { raw ->
                    val cmd = TvCommand.from(raw)
                    if (cmd.action == "load" && !activityResumed) {
                        runCatching {
                            @Suppress("DEPRECATION")
                            appContext.getSystemService(PowerManager::class.java)
                                .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "peartube:cast-wake")
                                .acquire(3000L)
                            appContext.startActivity(
                                Intent(appContext, ReceiverActivity::class.java)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                            )
                        }
                    }
                    _commands.tryEmit(cmd)
                }
            }
            "fatal" -> error.value = msg.optString("error")
        }
    }
}
