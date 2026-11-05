package com.peartube.app

import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.AtomicFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

sealed interface Screen {
    data object List : Screen
    data object Settings : Screen
    data object Cast : Screen
    data class Play(val entry: Entry, val startPositionMs: Long? = null) : Screen
}

data class DownloadProgress(val bytes: Long, val total: Long)

/** The app's state. Lives with the process, so it outlasts the activity. */
class AppModel(private val app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val dataDir = app.filesDir

    val worker = Worker(app)
    val settings = MutableStateFlow(Settings.load(dataDir))
    val status = MutableStateFlow<Status?>(null)
    val identity = MutableStateFlow<IdentityInfo?>(null)
    val entries = MutableStateFlow<List<Entry>>(emptyList())
    val error = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val quickAdd = MutableStateFlow("")
    val screen = MutableStateFlow<Screen>(if (!settings.value.hasSources) Screen.Settings else Screen.List)

    val cast = MutableStateFlow(CastStatus())
    val pendingCast = MutableStateFlow<PendingCast?>(null)
    val selectedCastReceiver = MutableStateFlow<CastReceiver?>(null)
    val notice = MutableStateFlow<String?>(null)
    val downloads = MutableStateFlow<Map<String, DownloadProgress>>(emptyMap())
    private val downloadJobs = ConcurrentHashMap<String, Job>()
    private val historyFile = AtomicFile(File(dataDir, "watch-history.json"))
    val watchHistory = MutableStateFlow(loadWatchHistory())
    private val historyWrites = Channel<Map<String, WatchProgress>>(Channel.CONFLATED)

    private fun loadWatchHistory(): Map<String, WatchProgress> = runCatching {
        val json = JSONObject(historyFile.openRead().bufferedReader().use { it.readText() })
        json.keys().asSequence().associateWith { WatchProgress.from(json.getJSONObject(it)) }
    }.getOrDefault(emptyMap())

    fun recordWatchProgress(entry: Entry, positionMs: Long, durationMs: Long?) {
        if (positionMs <= 0) return
        val progress = WatchProgress(entry.key, entry.id, positionMs, durationMs ?: 0L, System.currentTimeMillis())
        watchHistory.value = watchHistory.value + (entry.key to progress)
        historyWrites.trySend(watchHistory.value)
    }

    fun playEntry(entry: Entry) {
        if (entry.locked) {
            error.value = "Subscriber pass needed: paste this channel's peartube://access/… pass in the search bar."
            return
        }
        scope.launch {
            val current = runCatching {
                if (entry.sourceKind == "channel" && entry.source.isNotEmpty()) worker.focusSource(entry.source)
                val options = worker.search(entry.id)
                options.firstOrNull { it.sha256 == entry.sha256 && it.source == entry.source }
                    ?: options.firstOrNull { it.sha256 == entry.sha256 }
                    ?: options.firstOrNull()
            }.getOrNull() ?: entry
            if (current.key != entry.key) {
                entries.value = entries.value.map {
                    if (it.id == current.id && it.sha256 == current.sha256) current else it
                }
            }
            val receiver = cast.value.session?.receiverId ?: selectedCastReceiver.value?.id
            val start = watchHistory.value[current.key]?.takeIf { it.partial }?.positionMs ?: 0L
            if (receiver != null) castToReceiver(receiver, current.key, "auto", start)
            else screen.value = Screen.Play(current)
        }
    }

    fun openCastSheet() {
        pendingCast.value = null
        screen.value = Screen.Cast
    }

    fun cancelCast() {
        pendingCast.value = null
        screen.value = Screen.List
    }

    fun selectCastReceiver(receiver: CastReceiver) {
        selectedCastReceiver.value = receiver
        val pending = pendingCast.value
        if (pending != null) castToReceiver(receiver.id, pending.entryKey, "auto", pending.startPositionMs)
        else {
            screen.value = Screen.List
            notice.value = "Ready on ${receiver.name}"
            scope.launch {
                runCatching { worker.castAttach(receiver.id) }.onSuccess { st ->
                    if (st.session?.state?.entry != null) cast.value = st
                }
            }
        }
    }

    fun switchCastToPhone() {
        val session = cast.value.session ?: return
        val entry = entries.value.firstOrNull { it.key == session.state.entry?.key } ?: return
        recordWatchProgress(entry, session.state.positionMs, session.state.durationMs)
        selectedCastReceiver.value = null
        stopCasting()
        screen.value = Screen.Play(entry)
    }
    @Volatile var inForeground: Boolean = true
    val soundFontSelected = MutableStateFlow(SoundFont.file(dataDir).isFile)
    val soundFontBusy = MutableStateFlow(false)
    val soundFontError = MutableStateFlow<String?>(null)

    private val starts = Channel<Settings>(Channel.UNLIMITED)
    private val refreshes = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch(Dispatchers.IO) {
            for (history in historyWrites) {
                val json = JSONObject()
                history.forEach { (key, progress) -> json.put(key, progress.json()) }
                var stream: java.io.FileOutputStream? = null
                try {
                    stream = historyFile.startWrite()
                    stream.write(json.toString().toByteArray(Charsets.UTF_8))
                    historyFile.finishWrite(stream)
                } catch (_: Exception) {
                    stream?.let(historyFile::failWrite)
                }
            }
        }
        scope.launch {
            worker.events.collect { event ->
                when (event) {
                    Worker.Event.Update -> refreshes.trySend(Unit)
                    is Worker.Event.Sources -> {
                        val synced = event.list.filter { !it.primary && !it.writable }.map { SourceSpec(it.key, it.kind, it.alias) }
                        val next = settings.value.copy(sources = synced)
                        runCatching { next.save(dataDir) }
                        settings.value = next
                    }
                    is Worker.Event.Cast -> {
                        cast.value = event.status
                        if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
                    }
                    is Worker.Event.Fatal -> error.value = event.message
                    Worker.Event.Exited -> error.value = "The P2P worker stopped"
                }
            }
        }
        scope.launch {
            for (next in starts) {
                try {
                    worker.start(next)
                    refresh()
                } catch (e: Exception) {
                    error.value = e.message
                }
            }
        }
        scope.launch {
            for (unit in refreshes) {
                refresh()
                kotlinx.coroutines.delay(250)
            }
        }
        scope.launch {
            var wasPlaying = false
            screen.collect { cur ->
                val playing = cur is Screen.Play
                if (wasPlaying && !playing) refreshes.trySend(Unit)
                wasPlaying = playing
            }
        }
        if (settings.value.hasSources) starts.trySend(settings.value)
    }

    fun save(next: Settings) {
        next.save(dataDir)
        settings.value = next
        status.value = null
        entries.value = emptyList()
        screen.value = Screen.List
        starts.trySend(next)
    }

    // A followed channel keeps catching up after the app leaves the screen: the worklet and its LAN
    // sockets stay up for a bounded window, so the library is not frozen at whatever it held when the
    // phone went down. Past the window it sleeps exactly as before.
    private var backgroundSyncUntil = 0L
    private val backgroundSyncWindowMs = 2 * 60_000L

    fun onBackground() {
        if (!settings.value.hasSources) return
        backgroundSyncUntil = System.currentTimeMillis() + backgroundSyncWindowMs
        scope.launch {
            kotlinx.coroutines.delay(backgroundSyncWindowMs + 1_000L)
            if (!inForeground && System.currentTimeMillis() >= backgroundSyncUntil && !shouldKeepWorkerAwake()) {
                worker.suspend()
            }
        }
    }

    fun setPlayerActive(active: Boolean) {
        scope.launch { runCatching { worker.setPlayerActive(active) } }
    }

    fun shouldKeepWorkerAwake(): Boolean =
        cast.value.session != null || downloads.value.isNotEmpty() || System.currentTimeMillis() < backgroundSyncUntil

    fun openUriOrKey(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return
        val isReceiverUri = trimmed.startsWith("peartube://receiver/", ignoreCase = true) ||
            trimmed.startsWith("peartube://cast/", ignoreCase = true)
        if (!settings.value.hasSources && !isReceiverUri) {
            val candidate = if (trimmed.startsWith("peartube:", ignoreCase = true)) trimmed else "peartube://channel/$trimmed"
            runCatching { Settings.parseSourceToken(candidate, "channel") }.onSuccess { spec ->
                val next = settings.value.withSource(spec)
                runCatching { save(next) }.onFailure { error.value = it.message }
                return
            }
        }
        scope.launch {
            try {
                val res = worker.openUri(trimmed)
                res.source?.let { src ->
                    val next = settings.value.withSource(SourceSpec(src.key, src.kind, src.alias))
                    next.save(dataDir)
                    settings.value = next
                    screen.value = Screen.List
                }
                res.entry?.let { entry ->
                    screen.value = Screen.Play(entry)
                }
                if (res.action == "receiver") {
                    cast.value = worker.castStatus()
                    val receiver = res.receiver ?: error("This TV didn't share its identity. Please scan again.")
                    selectCastReceiver(receiver)
                }
                refresh()
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun castEntryOrSheet(entry: Entry, startPositionMs: Long = 0L) {
        val activeId = cast.value.session?.receiverId ?: selectedCastReceiver.value?.id
        if (activeId != null) {
            castToReceiver(activeId, entry.key, "auto", startPositionMs)
        } else {
            pendingCast.value = PendingCast(entry.key, entry.title, startPositionMs)
            screen.value = Screen.Cast
        }
    }

    fun refreshCast() {
        scope.launch {
            runCatching { worker.castStatus() }.onSuccess { cast.value = it }.onFailure { error.value = it.message }
        }
    }

    fun focusSource(key: String) {
        scope.launch {
            runCatching {
                worker.focusSource(key)
                refresh()
            }
        }
    }

    fun pairCastByCode(id: String, code: String) {
        scope.launch {
            val target = cast.value.receivers.firstOrNull { it.id == id }
            runCatching { worker.castPair(JSONObject().put("id", id).put("code", code)) }
                .onSuccess { result ->
                    cast.value = result
                    val receiver = result.receivers.firstOrNull { it.id == id && it.paired }
                        ?: result.receivers.firstOrNull { it.paired && target != null &&
                            ((it.publicKey.isNotEmpty() && it.publicKey == target.publicKey) ||
                                (it.host != null && it.host == target.host && it.port == target.port)) }
                    if (receiver != null) selectCastReceiver(receiver)
                    else error.value = "This TV didn't finish connecting. Please scan its QR code."
                }
                .onFailure { error.value = it.message }
        }
    }

    fun pairCastByUriOrHost(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.startsWith("peartube:", ignoreCase = true)) {
            openUriOrKey(trimmed)
            return
        }
        val uri = Uri.parse(if (trimmed.startsWith("http")) trimmed else "http://$trimmed")
        if (uri.getQueryParameter("uri")?.startsWith("peartube:") == true) {
            openUriOrKey(uri.getQueryParameter("uri")!!)
            return
        }
        val payload = if (':' in trimmed || trimmed.startsWith("http")) {
            JSONObject().put("host", uri.host).put("port", uri.port.takeIf { it > 0 } ?: 8176)
        } else JSONObject().put("publicKey", trimmed)
        scope.launch {
            runCatching { worker.castPair(payload) }
                .onSuccess { result ->
                    cast.value = result
                    val receiver = result.receivers.firstOrNull { it.paired &&
                        (if (payload.has("publicKey")) it.publicKey == trimmed
                        else it.host == uri.host && it.port == payload.optInt("port")) }
                    if (receiver != null) selectCastReceiver(receiver)
                    else error.value = "Couldn't identify that screen. Select it on Wi-Fi or scan its TV QR code."
                }
                .onFailure { error.value = it.message }
        }
    }

    fun removeCastReceiver(id: String) {
        scope.launch {
            runCatching { worker.castRemove(id) }.onSuccess { cast.value = it }
        }
    }

    fun castToReceiver(receiverId: String, key: String, preferMode: String = "auto", startPositionMs: Long = 0L) {
        scope.launch {
            try {
                cast.value = worker.castPlay(receiverId, key, preferMode, startPositionMs)
                pendingCast.value = null
                screen.value = Screen.List
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun sendCastControl(params: JSONObject) {
        scope.launch {
            runCatching { worker.castControl(params) }.onSuccess { cast.value = it }.onFailure { error.value = it.message }
        }
    }

    fun stopCasting() {
        selectedCastReceiver.value = null
        scope.launch {
            runCatching { worker.castStop(true) }.onSuccess {
                cast.value = it
                if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
            }
        }
    }

    fun detachCasting() {
        selectedCastReceiver.value = null
        scope.launch {
            runCatching { worker.castStop(false) }.onSuccess {
                cast.value = it
                if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
            }
        }
    }


    fun subscribeDiscovered(disc: DiscoveredSource) {
        openUriOrKey("peartube://channel/${disc.key}?name=${disc.title}")
    }

    fun removeChannelEntry(key: String) {
        scope.launch {
            runCatching { worker.removeEntry(key) }
                .onSuccess { notice.value = "Removed from channel"; refresh() }
                .onFailure { error.value = it.message }
        }
    }

    fun rotateSubscriberPass() {
        scope.launch {
            runCatching { worker.rotateEpoch() }
                .onSuccess { res -> notice.value = "Rotated to epoch ${res.optLong("epoch", 1L)}"; refresh() }
                .onFailure { error.value = it.message }
        }
    }

    fun revokeLinkedWriter(writerKey: String) {
        scope.launch {
            runCatching { worker.revokeWriter(writerKey) }
                .onSuccess { refresh() }
                .onFailure { error.value = it.message }
        }
    }

    fun copyRecoveryPhrase(onPhrase: (String) -> Unit) {
        scope.launch {
            runCatching { worker.identity(true) }
                .onSuccess { ident ->
                    if (ident.mnemonic.isNotBlank()) {
                        onPhrase(ident.mnemonic)
                        notice.value = "Copied 12-word recovery phrase"
                    } else {
                        error.value = "No recovery phrase saved on this phone"
                    }
                }
                .onFailure { error.value = it.message }
        }
    }
    fun clearCache(key: String? = null) {
        scope.launch {
            try {
                notice.value = "Clearing cache & compacting storage…"
                val (cleared, reclaimed) = worker.clearCache(key)
                refresh()
                fun fmt(b: Long): String {
                    val mb = b / (1024.0 * 1024.0)
                    return when {
                        b >= 1024L * 1024L * 1024L -> String.format(java.util.Locale.US, "%.2f GB", mb / 1024.0)
                        b >= 1024L * 1024L -> String.format(java.util.Locale.US, "%.1f MB", mb)
                        else -> "${maxOf(1L, b / 1024L)} KB"
                    }
                }
                notice.value = when {
                    reclaimed > 0L -> "Freed ${fmt(reclaimed)} on device"
                    cleared > 0L -> "Cleared ${fmt(cleared)} from cache"
                    else -> "Storage cache compacted"
                }
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun downloadEntry(entry: Entry, nameOverride: String? = null) {
        if (downloadJobs.containsKey(entry.key)) return
        if (entry.streamUrl.isBlank()) {
            error.value = "This video has no local stream URL yet"
            return
        }
        val rawTitle = (nameOverride ?: entry.title).ifBlank { entry.id }
        downloads.value = downloads.value + (entry.key to DownloadProgress(0L, entry.size))
        notice.value = "Downloading $rawTitle to Downloads…"
        val job = scope.launch(Dispatchers.IO) {
            var itemUri: Uri? = null
            var conn: HttpURLConnection? = null
            try {
                runCatching { worker.warm(entry.key) }
                conn = (URL(entry.streamUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 45_000
                    requestMethod = "GET"
                }
                val status = conn.responseCode
                if (status != 200 && status != 206) error("Stream answered HTTP $status")
                val input = conn.inputStream
                val head = ByteArray(256)
                var headLen = 0
                while (headLen < head.size) {
                    ensureActive()
                    val n = input.read(head, headLen, head.size - headLen)
                    if (n < 0) break
                    headLen += n
                }
                val (ext, mime) = sniffContainer(head, headLen)
                val cleanBase = rawTitle.replace(Regex("[/\\\\:*?\"<>|\\x00-\\x1f]+"), " ").replace(Regex("\\s+"), " ").trim().take(160).ifEmpty { "PearTube Video" }
                val knownExt = Regex("\\.(mkv|mp4|webm|mov|avi|m4v|ts|ogv|ogg|flac|mp3)$", RegexOption.IGNORE_CASE)
                val fileName = if (knownExt.containsMatchIn(cleanBase)) cleanBase else "$cleanBase$ext"

                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val resolver = app.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: error("Cannot create file in Downloads")
                itemUri = uri
                var written = 0L
                var lastTick = 0L
                val buf = ByteArray(256 * 1024)
                resolver.openOutputStream(uri)?.use { out ->
                    if (headLen > 0) {
                        out.write(head, 0, headLen)
                        written += headLen
                        downloads.value = downloads.value + (entry.key to DownloadProgress(written, entry.size))
                    }
                    while (true) {
                        ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        written += n
                        val now = System.currentTimeMillis()
                        if (now - lastTick >= 200L) {
                            lastTick = now
                            downloads.value = downloads.value + (entry.key to DownloadProgress(written, entry.size))
                        }
                    }
                    out.flush()
                } ?: error("Cannot open Downloads output stream")

                if (entry.size > 0L && written != entry.size) {
                    error("Incomplete download ($written of ${entry.size} bytes)")
                }
                resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                itemUri = null
                notice.value = "Saved $fileName to Downloads"
            } catch (ce: CancellationException) {
                itemUri?.let { runCatching { app.contentResolver.delete(it, null, null) } }
                throw ce
            } catch (e: Exception) {
                itemUri?.let { runCatching { app.contentResolver.delete(it, null, null) } }
                error.value = "Download failed: ${e.message ?: e}"
            } finally {
                runCatching { conn?.disconnect() }
                downloadJobs.remove(entry.key)
                downloads.value = downloads.value - entry.key
                if (!inForeground && !shouldKeepWorkerAwake()) {
                    withContext(Dispatchers.Main) { worker.suspend() }
                }
            }
        }
        downloadJobs[entry.key] = job
    }

    fun cancelDownload(key: String) {
        downloadJobs.remove(key)?.cancel()
        downloads.value = downloads.value - key
    }

    private fun sniffContainer(b: ByteArray, len: Int): Pair<String, String> {
        fun ascii(off: Int, n: Int) = if (off + n <= len) String(b, off, n, Charsets.ISO_8859_1) else ""
        if (len >= 4 && b[0] == 0x1a.toByte() && b[1] == 0x45.toByte() && b[2] == 0xdf.toByte() && b[3] == 0xa3.toByte()) {
            return if (ascii(0, minOf(len, 128)).lowercase().contains("webm")) ".webm" to "video/webm"
            else ".mkv" to "video/x-matroska"
        }
        if (len >= 12 && ascii(4, 4) in setOf("ftyp", "moov", "mdat", "free", "wide", "skip")) {
            return if (ascii(8, 4) == "qt  ") ".mov" to "video/quicktime" else ".mp4" to "video/mp4"
        }
        if (len >= 12 && ascii(0, 4) == "RIFF" && ascii(8, 4) == "AVI ") return ".avi" to "video/x-msvideo"
        if (len >= 4 && ascii(0, 4) == "OggS") return ".ogv" to "video/ogg"
        if (len >= 4 && ascii(0, 4) == "fLaC") return ".flac" to "audio/flac"
        if (len >= 3 && ascii(0, 3) == "ID3") return ".mp3" to "audio/mpeg"
        if (len >= 1 && b[0] == 0x47.toByte() && (len < 189 || b[188] == 0x47.toByte())) return ".ts" to "video/mp2t"
        return ".mkv" to "application/octet-stream"
    }
    fun importSoundFont(uri: Uri) = soundFontJob { SoundFont.import(app.contentResolver, uri, dataDir) }

    fun clearSoundFont() = soundFontJob { SoundFont.clear(dataDir) }

    private fun soundFontJob(work: () -> Unit) {
        soundFontBusy.value = true
        soundFontError.value = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { work() }
            } catch (e: Exception) {
                soundFontError.value = e.message
            }
            soundFontSelected.value = SoundFont.file(dataDir).isFile
            soundFontBusy.value = false
        }
    }

    @Volatile
    var playStarted: Boolean = false

    private suspend fun refresh() {
        if (!settings.value.hasSources) return
        try {
            // Keep the worklet's QuickJS thread wide open once video frames are flowing.
            if (screen.value is Screen.Play && playStarted) {
                status.value = worker.status()
            } else {
                coroutineScope {
                    val st = async { worker.status() }
                    val en = async { worker.search() }
                    val id = async { runCatching { worker.identity(false) }.getOrNull() }
                    status.value = st.await()
                    entries.value = en.await()
                    id.await()?.let { identity.value = it }
                }
            }
        } catch (e: Exception) {
            error.value = e.message
        }
    }
}
