package com.peartube.app

import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Environment
import android.provider.MediaStore
import android.util.AtomicFile
import com.peartube.shared.formatBytes
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
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

enum class Room(val label: String) {
    Home("Home"),
    Listen("Listen"),
    Watch("Watch"),
    Discover("Discover"),
    Search("Search"),
}

sealed interface Screen {
    data object Main : Screen
    data class AlbumDetail(val albumKey: String) : Screen
    data class ArtistDetail(val artistKey: String) : Screen
    data class TitleDetail(val titleKey: String) : Screen
    data object MusicPlayerFull : Screen
    data object Settings : Screen
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
    val global = MutableStateFlow(GlobalSearch())

    private val prefsFile = AtomicFile(File(dataDir, "ui-prefs.json"))
    val currentRoom = MutableStateFlow(loadLastRoom())
    private val navStack = MutableStateFlow<List<Screen>>(listOf(Screen.Main))
    val screen: StateFlow<Screen> = navStack
        .map { it.lastOrNull() ?: Screen.Main }
        .stateIn(scope, SharingStarted.Eagerly, Screen.Main)

    val catalog: StateFlow<LibraryCatalog> = entries
        .map { LibraryCatalog.build(it) }
        .stateIn(scope, SharingStarted.Eagerly, LibraryCatalog.Empty)

    val cast = MutableStateFlow(CastStatus())
    val pendingCast = MutableStateFlow<PendingCast?>(null)
    val selectedCastReceiver = MutableStateFlow<CastReceiver?>(null)
    val showTvsDialog = MutableStateFlow(false)
    val searchAutoFocus = MutableStateFlow(false)
    val notice = MutableStateFlow<String?>(null)
    val downloads = MutableStateFlow<Map<String, DownloadProgress>>(emptyMap())
    private val downloadJobs = ConcurrentHashMap<String, Job>()
    private val historyFile = AtomicFile(File(dataDir, "watch-history.json"))
    val watchHistory = MutableStateFlow(loadWatchHistory())
    private val historyWrites = Channel<Map<String, WatchProgress>>(Channel.CONFLATED)

    val music = MusicPlayerController(
        scope = scope,
        dataDir = dataDir,
        resolveStreamUrl = { entry -> resolveEntry(entry) },
        onStartingMusic = {
            // Rule 4: Starting music while a video is open closes the video (keeping its place under Keep playing).
            if (screen.value is Screen.Play) {
                popScreen()
            }
        },
        onPlaybackActiveChanged = { active ->
            setPlayerActive(active || screen.value is Screen.Play)
            applyBackgroundPolicy()
        },
    )
    val musicState: StateFlow<MusicState> = music.state

    private fun loadLastRoom(): Room = runCatching {
        val json = JSONObject(prefsFile.openRead().bufferedReader().use { it.readText() })
        Room.entries.firstOrNull { it.name.equals(json.optString("room"), ignoreCase = true) } ?: Room.Home
    }.getOrDefault(Room.Home)

    private fun saveLastRoom(room: Room) {
        scope.launch(Dispatchers.IO) {
            var stream: java.io.FileOutputStream? = null
            try {
                dataDir.mkdirs()
                stream = prefsFile.startWrite()
                stream.write(JSONObject().put("room", room.name).toString().toByteArray(Charsets.UTF_8))
                prefsFile.finishWrite(stream)
            } catch (_: Exception) {
                stream?.let(prefsFile::failWrite)
            }
        }
    }

    fun selectRoom(room: Room, focusSearch: Boolean = false) {
        currentRoom.value = room
        saveLastRoom(room)
        if (focusSearch) searchAutoFocus.value = true
        navStack.value = listOf(Screen.Main)
    }

    fun openSearchFor(term: String, askRelays: Boolean = false) {
        query.value = term
        currentRoom.value = Room.Search
        saveLastRoom(Room.Search)
        navStack.value = listOf(Screen.Main)
        if (askRelays && term.trim().length >= 2) {
            searchGlobal(term)
        }
    }

    fun pushScreen(next: Screen) {
        val stack = navStack.value
        if (stack.lastOrNull() == next) return
        if (next is Screen.Play) {
            // Rule 3: Music waits for a video. Pause music, keep track/position/queue, show Paused for a video.
            music.pauseForVideo()
        }
        navStack.value = stack + next
    }

    fun replaceTopScreen(next: Screen) {
        if (next is Screen.Play) {
            music.pauseForVideo()
        }
        val stack = navStack.value
        navStack.value = if (stack.size <= 1) listOf(Screen.Main, next) else stack.dropLast(1) + next
    }

    fun popScreen() {
        val stack = navStack.value
        navStack.value = if (stack.size > 1) stack.dropLast(1) else listOf(Screen.Main)
    }

    fun goHome() {
        navStack.value = listOf(Screen.Main)
    }

    fun closeVideo() {
        if (screen.value is Screen.Play) popScreen()
    }

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

    private suspend fun resolveEntry(entry: Entry): Entry {
        val current = runCatching {
            if (entry.sourceKind == "channel" && entry.source.isNotEmpty()) worker.focusSource(entry.source)
            runCatching { worker.warm(entry.key) }
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
        return current
    }

    fun playEntry(entry: Entry, localOnly: Boolean = false) {
        if (entry.locked) {
            error.value = "Subscriber pass needed: paste this channel's peartube://access/… pass in Search or Add to library."
            return
        }
        scope.launch {
            val current = resolveEntry(entry)
            val receiver = if (localOnly) null else (cast.value.session?.receiverId ?: selectedCastReceiver.value?.id)
            val start = watchHistory.value[current.key]?.takeIf { it.partial }?.positionMs ?: 0L
            if (receiver != null) {
                castToReceiver(receiver, current.key, "auto", start)
            } else {
                // Rule 3: Music waits for a video.
                music.pauseForVideo()
                pushScreen(Screen.Play(current))
            }
        }
    }

    fun openCastSheet() {
        pendingCast.value = null
        showTvsDialog.value = true
    }

    fun cancelCast() {
        pendingCast.value = null
        showTvsDialog.value = false
    }

    fun selectCastReceiver(receiver: CastReceiver) {
        selectedCastReceiver.value = receiver
        val pending = pendingCast.value
        if (pending != null) {
            castToReceiver(receiver.id, pending.entryKey, "auto", pending.startPositionMs)
        } else {
            showTvsDialog.value = false
            notice.value = "Ready on ${receiver.name}"
            scope.launch {
                runCatching { worker.castAttach(receiver.id) }.onSuccess { st ->
                    if (st.session?.state?.entry != null) cast.value = st
                }
            }
        }
    }

    fun playPendingOnThisPhone() {
        val pending = pendingCast.value ?: return
        pendingCast.value = null
        showTvsDialog.value = false
        val entry = entries.value.firstOrNull { it.key == pending.entryKey } ?: return
        playEntry(entry, localOnly = true)
    }

    fun switchCastToPhone() {
        val session = cast.value.session ?: return
        val entry = entries.value.firstOrNull { it.key == session.state.entry?.key } ?: return
        recordWatchProgress(entry, session.state.positionMs, session.state.durationMs)
        selectedCastReceiver.value = null
        stopCasting()
        showTvsDialog.value = false
        music.pauseForVideo()
        pushScreen(Screen.Play(entry))
    }

    @Volatile var inForeground: Boolean = true
    // LAN discovery's mDNS needs the multicast lock; a cast stream or music playback needs Wi-Fi at full speed.
    private val wifi = app.getSystemService(WifiManager::class.java)
    private val multicastLock = wifi.createMulticastLock("PearTube LAN discovery").apply { setReferenceCounted(false) }
    private val wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PearTube Cast stream").apply { setReferenceCounted(false) }
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
                        val next = settings.value.copy(sources = event.list)
                        runCatching { next.save(dataDir) }
                        settings.value = next
                    }
                    is Worker.Event.Cast -> {
                        cast.value = event.status
                        applyBackgroundPolicy()
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
                // Later answers to a recent global search arrive as updates: ask the same query again.
                if (globalLive) fetchGlobal()
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
        starts.trySend(settings.value)
    }

    /** Storage contribution: persisted, then applied to the live worklet. */
    fun setCacheLimit(gb: Int) {
        val next = settings.value.copy(cacheMaxGb = gb)
        runCatching { next.save(dataDir) }
        settings.value = next
        scope.launch { runCatching { worker.setCacheMax(gb.toLong() * 1_000_000_000L) } }
    }

    fun save(next: Settings) {
        next.save(dataDir)
        settings.value = next
        status.value = null
        entries.value = emptyList()
        navStack.value = listOf(Screen.Main)
        starts.trySend(next)
    }

    // A followed channel keeps catching up after the app leaves the screen: the worklet and its LAN
    // sockets stay up for a bounded window, so the library is not frozen at whatever it held when the
    // phone went down. Past the window it sleeps exactly as before.
    private var backgroundSyncUntil = 0L
    private val backgroundSyncWindowMs = 2 * 60_000L

    fun onBackground() {
        if (settings.value.hasSources) {
            backgroundSyncUntil = System.currentTimeMillis() + backgroundSyncWindowMs
            scope.launch {
                kotlinx.coroutines.delay(backgroundSyncWindowMs + 1_000L)
                applyBackgroundPolicy()
            }
        }
        applyBackgroundPolicy()
    }

    fun setPlayerActive(active: Boolean) {
        scope.launch { runCatching { worker.setPlayerActive(active) } }
    }

    private fun shouldKeepWorkerAwake(): Boolean =
        cast.value.session != null ||
            musicState.value.playing ||
            downloads.value.isNotEmpty() ||
            System.currentTimeMillis() < backgroundSyncUntil

    // The one rule for the background: in front, or behind with a cast, active music, a download or
    // the sync window open, the worklet runs and both locks are held; otherwise both stop.
    @Synchronized
    fun applyBackgroundPolicy() {
        if (inForeground || shouldKeepWorkerAwake()) {
            multicastLock.acquire()
            wifiLock.acquire()
            worker.resume()
        } else {
            worker.suspend()
            if (wifiLock.isHeld) wifiLock.release()
            if (multicastLock.isHeld) multicastLock.release()
        }
    }

    fun openUriOrKey(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            try {
                val res = worker.openUri(trimmed)
                res.source?.let { src ->
                    val next = settings.value.withSource(SourceSpec(src.key, src.kind, src.alias))
                    next.save(dataDir)
                    settings.value = next
                    navStack.value = listOf(Screen.Main)
                    notice.value = "Followed ${src.alias.ifBlank { "channel" }}"
                    // The worklet only parsed the link: no node is running, so start one, whatever was followed before.
                    if (status.value == null) starts.trySend(next)
                }
                res.entry?.let { entry ->
                    val isAudioTrack = !entry.id.startsWith("imdb:") && entry.season != null
                    if (isAudioTrack) {
                        val item = TrackItem(
                            entry = entry,
                            title = trackName(entry),
                            artist = entry.music?.artist.orEmpty(),
                            album = entry.title,
                            albumKey = "album:${entry.seriesKey.ifEmpty { entry.id }}",
                            hue = (sleeveHash(fold(entry.title)) % 360L).toInt(),
                            seed = sleeveHash(fold(entry.title)),
                            trackNo = trackNo(entry),
                            disc = entry.season,
                            track = entry.episode,
                        )
                        music.playTrackList(listOf(item), 0, item.album.ifBlank { item.title })
                    } else {
                        music.pauseForVideo()
                        pushScreen(Screen.Play(entry))
                    }
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

    /** Asks relays the app does not follow for [query]. Later answers come back with the next minute's updates. */
    fun searchGlobal(query: String) {
        val q = query.trim()
        if (q.length < 2) return
        val prev = global.value
        global.value = GlobalSearch(query = q, rows = if (prev.query == q) prev.rows else emptyList(), askedAt = System.currentTimeMillis())
        fetchGlobal()
    }

    private fun fetchGlobal() {
        val q = global.value.query
        global.value = global.value.copy(busy = true)
        scope.launch {
            val res = runCatching { worker.searchGlobal(q) }
            if (global.value.query != q) return@launch
            global.value = res.fold(
                { global.value.copy(rows = it, busy = false, error = null) },
                { global.value.copy(busy = false, error = it.message) },
            )
        }
    }

    private val globalLive: Boolean
        get() = global.value.let { !it.busy && it.askedAt > 0 && System.currentTimeMillis() - it.askedAt < 60_000 }

    fun castEntryOrSheet(entry: Entry, startPositionMs: Long = 0L) {
        val activeId = cast.value.session?.receiverId ?: selectedCastReceiver.value?.id
        if (activeId != null) {
            castToReceiver(activeId, entry.key, "auto", startPositionMs)
        } else {
            pendingCast.value = PendingCast(entry.key, entry.title, startPositionMs)
            showTvsDialog.value = true
        }
    }

    fun openTvsPickerForEntry(entry: Entry, startPositionMs: Long = 0L) {
        pendingCast.value = PendingCast(entry.key, entry.title, startPositionMs)
        showTvsDialog.value = true
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

    fun pairCastByCode(id: String, code: String) = pairCast(
        JSONObject().put("id", id).put("code", code.trim().uppercase()),
        "This TV did not finish connecting. Check the code on the TV.",
    )

    fun pairCastByCodeAuto(code: String) {
        val clean = code.trim().uppercase()
        if (clean.isEmpty()) return
        val target = cast.value.receivers.firstOrNull { it.current && !it.paired && it.online }
            ?: cast.value.receivers.firstOrNull { it.current && !it.paired }
            ?: cast.value.receivers.firstOrNull { it.current }
        if (target != null) {
            pairCastByCode(target.id, clean)
        } else {
            pairCast(
                JSONObject().put("code", clean),
                "No TV answered that code. Make sure the TV is on this network.",
            )
        }
    }

    fun pairCastByUriOrHost(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.startsWith("peartube:", ignoreCase = true)) openUriOrKey(trimmed)
        else pairCast(JSONObject().put("address", trimmed), "Couldn't identify that screen. Select it on Wi-Fi or scan its TV QR code.")
    }

    private fun pairCast(params: JSONObject, unpaired: String) {
        scope.launch {
            runCatching { worker.castPair(params) }
                .onSuccess { (result, pairedId) ->
                    cast.value = result
                    val receiver = result.receivers.firstOrNull { it.id == pairedId && it.paired }
                    if (receiver != null) selectCastReceiver(receiver) else error.value = unpaired
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
                showTvsDialog.value = false
                if (screen.value is Screen.Play) popScreen()
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
                applyBackgroundPolicy()
            }
        }
    }

    fun detachCasting() {
        selectedCastReceiver.value = null
        scope.launch {
            runCatching { worker.castStop(false) }.onSuccess {
                cast.value = it
                applyBackgroundPolicy()
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
                notice.value = when {
                    reclaimed > 0L -> "Freed ${formatBytes(reclaimed)} on device"
                    cleared > 0L -> "Cleared ${formatBytes(cleared)} from cache"
                    else -> "Storage cache compacted"
                }
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun downloadEntry(entry: Entry, nameOverride: String? = null) {
        if (downloadJobs.containsKey(entry.key)) return
        val url = entry.downloadUrl ?: entry.streamUrl
        if (url.isBlank()) {
            error.value = "This file has no local stream URL yet"
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
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 45_000
                    requestMethod = "GET"
                }
                val status = conn.responseCode
                if (status != 200 && status != 206) error("Stream answered HTTP $status")
                val ext = Regex("filename=\"[^\"]*(\\.[A-Za-z0-9]{1,5})\"").find(conn.getHeaderField("Content-Disposition") ?: "")?.groupValues?.get(1) ?: ".mkv"
                val mime = conn.contentType ?: "application/octet-stream"
                val cleanBase = rawTitle.replace(Regex("[/\\\\:*?\"<>|\\x00-\\x1f]+"), " ").replace(Regex("\\s+"), " ").trim().take(160).ifEmpty { "PearTube File" }
                val fileName = if (cleanBase.endsWith(ext, ignoreCase = true)) cleanBase else "$cleanBase$ext"

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
                val input = conn.inputStream
                resolver.openOutputStream(uri)?.use { out ->
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
                applyBackgroundPolicy()
            }
        }
        downloadJobs[entry.key] = job
    }

    fun cancelDownload(key: String) {
        downloadJobs.remove(key)?.cancel()
        downloads.value = downloads.value - key
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
                    val loaded = en.await()
                    entries.value = loaded
                    music.refreshEntries(loaded)
                    id.await()?.let { identity.value = it }
                }
            }
        } catch (e: Exception) {
            error.value = e.message
        }
    }
}
