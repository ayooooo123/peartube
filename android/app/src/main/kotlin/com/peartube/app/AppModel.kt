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
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
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
    data class ShelfDetail(val peer: String) : Screen
    data object MusicPlayerFull : Screen
    data object Settings : Screen
    data class Play(val entry: Entry, val startPositionMs: Long? = null) : Screen
}

data class DownloadProgress(val bytes: Long, val total: Long)

data class AddSheetState(
    val rawInput: String = "",
    val identifying: Boolean = false,
    val identified: IdentifyResult? = null,
    val identifyError: String? = null,
    val titleInput: String = "",
    val artistInput: String = "",
    val audioOnly: Boolean = false,
    val submitting: Boolean = false,
    val submitError: String? = null,
)

data class SourceSearchState(
    val query: String = "",
    val requestedSources: Set<SearchSource> = emptySet(),
    val result: SourceSearchResult = SourceSearchResult(),
    val busy: Boolean = false,
    val error: String? = null,
)

data class ShelfBrowserState(
    val peer: String = "",
    val shelf: SoulseekShelf? = null,
    val busy: Boolean = false,
    val error: String? = null,
)

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
    val showAddSheet = MutableStateFlow(false)
    val addSheet = MutableStateFlow(AddSheetState())
    val searchAutoFocus = MutableStateFlow(false)
    val notice = MutableStateFlow<String?>(null)
    val downloads = MutableStateFlow<Map<String, DownloadProgress>>(emptyMap())
    private val downloadJobs = ConcurrentHashMap<String, Job>()
    private val historyFile = AtomicFile(File(dataDir, "watch-history.json"))
    val watchHistory = MutableStateFlow(loadWatchHistory())
    private val historyWrites = Channel<Map<String, WatchProgress>>(Channel.CONFLATED)

    val loopbackApi = LoopbackApi { status.value?.apiUrl }
    val acquireJobs = MutableStateFlow<List<AcquireJob>>(emptyList())
    val plugins = MutableStateFlow<List<PluginInfo>>(emptyList())
    val selectedSources = MutableStateFlow(SearchSource.entries.toSet())
    val sourceSearch = MutableStateFlow(SourceSearchState())
    private val visitedShelvesFile = AtomicFile(File(dataDir, "visited-shelves.json"))
    val visitedShelves = MutableStateFlow(loadVisitedShelves())
    val shelfState = MutableStateFlow(ShelfBrowserState())
    val soulseekSettings = MutableStateFlow(SoulseekPeerSettings())
    val soulseekBusy = MutableStateFlow(false)
    val soulseekError = MutableStateFlow<String?>(null)
    val soulseekMessage = MutableStateFlow<String?>(null)
    private var identifyJob: Job? = null
    private var sourceSearchJob: Job? = null
    private var shelfJob: Job? = null
    private var previousActiveJobIds: Set<String> = emptySet()
    private var lastLoadedApiUrl: String? = null

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
            searchAll(term)
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
        scope.launch {
            status.collect { st ->
                val apiUrl = st?.apiUrl?.takeIf { it.isNotBlank() }
                if (apiUrl != null && apiUrl != lastLoadedApiUrl) {
                    lastLoadedApiUrl = apiUrl
                    refreshAcquireJobs()
                    refreshPlugins()
                    refreshSoulseekSettings()
                }
            }
        }
        scope.launch {
            while (true) {
                val shouldPoll = combine(acquireJobs, showAddSheet, status) { jobs, sheetOpen, st ->
                    !st?.apiUrl.isNullOrBlank() && (sheetOpen || jobs.any { it.isActive })
                }.first { it }
                if (shouldPoll) {
                    refreshAcquireJobs()
                    delay(2_000L)
                }
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
            acquireJobs.value.any { it.isActive } ||
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
        parsePeartubeAddUrl(trimmed)?.let { targetUrl ->
            openAddSheet(prefillUrl = targetUrl, autoIdentify = true)
            return
        }
        if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) {
            openAddSheet(prefillUrl = trimmed, autoIdentify = true)
            return
        }
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

    fun handleSharedText(text: String) {
        val extracted = extractSharedUrl(text)
        if (extracted == null) {
            error.value = "Could not find a link or channel key in the shared text."
            return
        }
        val addTarget = parsePeartubeAddUrl(extracted)
        if (addTarget != null) {
            openAddSheet(prefillUrl = addTarget, autoIdentify = true)
            return
        }
        if (extracted.startsWith("http://", ignoreCase = true) || extracted.startsWith("https://", ignoreCase = true)) {
            openAddSheet(prefillUrl = extracted, autoIdentify = true)
        } else {
            openUriOrKey(extracted)
        }
    }

    fun openAddSheet(prefillUrl: String? = null, autoIdentify: Boolean = false) {
        if (prefillUrl != null) {
            addSheet.value = AddSheetState(rawInput = prefillUrl)
        }
        showAddSheet.value = true
        refreshAcquireJobs()
        if (autoIdentify && !prefillUrl.isNullOrBlank()) {
            identifyUrl(prefillUrl)
        }
    }

    fun closeAddSheet(clearInput: Boolean = false) {
        showAddSheet.value = false
        if (clearInput) {
            identifyJob?.cancel()
            addSheet.value = AddSheetState()
        }
    }

    fun updateAddInput(raw: String) {
        val prev = addSheet.value
        val changed = prev.rawInput.trim() != raw.trim()
        addSheet.value = if (changed) {
            prev.copy(
                rawInput = raw,
                identified = null,
                identifyError = null,
                submitError = null,
            )
        } else {
            prev.copy(rawInput = raw)
        }
    }

    fun updateAddTitle(title: String) {
        addSheet.value = addSheet.value.copy(titleInput = title, submitError = null)
    }

    fun updateAddArtist(artist: String) {
        addSheet.value = addSheet.value.copy(artistInput = artist, submitError = null)
    }

    fun updateAddAudioOnly(audioOnly: Boolean) {
        addSheet.value = addSheet.value.copy(audioOnly = audioOnly, submitError = null)
    }

    fun identifyUrl(rawUrl: String = addSheet.value.rawInput) {
        val url = rawUrl.trim()
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
            addSheet.value = addSheet.value.copy(identifyError = "Paste an http(s) link to identify.")
            return
        }
        identifyJob?.cancel()
        addSheet.value = addSheet.value.copy(
            rawInput = url,
            identifying = true,
            identified = null,
            identifyError = null,
            submitError = null,
        )
        identifyJob = scope.launch {
            if (status.value?.apiUrl.isNullOrBlank()) {
                withTimeoutOrNull(12_000L) {
                    status.first { !it?.apiUrl.isNullOrBlank() }
                }
            }
            val result = loopbackApi.identify(url)
            if (addSheet.value.rawInput.trim() != url) return@launch
            result.fold(
                onSuccess = { info ->
                    addSheet.value = addSheet.value.copy(
                        identifying = false,
                        identified = info,
                        identifyError = null,
                        titleInput = info.effectiveTitle,
                        artistInput = info.effectiveArtist,
                        audioOnly = info.audioOnly,
                    )
                },
                onFailure = { err ->
                    addSheet.value = addSheet.value.copy(
                        identifying = false,
                        identified = null,
                        identifyError = err.message ?: "Could not identify that link.",
                    )
                },
            )
        }
    }

    fun submitAcquireFromSheet() {
        val state = addSheet.value
        val url = state.rawInput.trim()
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
            openUriOrKey(url)
            closeAddSheet(clearInput = true)
            return
        }
        if (state.submitting) return
        val identified = state.identified
        val title = state.titleInput.trim()
            .ifBlank { identified?.effectiveTitle.orEmpty() }
            .ifBlank { url }
        val artist = state.artistInput.trim().ifBlank { identified?.effectiveArtist.orEmpty() }
        val id = identified?.effectiveId?.takeIf { it.isNotBlank() } ?: ""
        val page = identified?.isPage ?: true
        val audio = state.audioOnly
        val music = if (audio || identified?.music != null || artist.isNotBlank()) {
            MusicMeta(
                title = title.takeIf { it.isNotBlank() },
                artist = artist.takeIf { it.isNotBlank() },
            )
        } else {
            null
        }
        addSheet.value = state.copy(submitting = true, submitError = null)
        scope.launch {
            loopbackApi.acquire(
                id = id,
                title = title,
                url = url,
                page = page,
                audio = audio,
                music = music,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    addSheet.value = AddSheetState()
                    notice.value = "Saving ${job.title.ifBlank { title }}…"
                },
                onFailure = { err ->
                    addSheet.value = addSheet.value.copy(
                        submitting = false,
                        submitError = err.message ?: "Could not start download.",
                    )
                },
            )
        }
    }

    private fun recordSubmittedJob(job: AcquireJob) {
        val current = acquireJobs.value.filterNot { it.jobId == job.jobId }
        acquireJobs.value = listOf(job) + current
        if (job.isActive) {
            previousActiveJobIds = previousActiveJobIds + job.jobId
        }
        applyBackgroundPolicy()
        refreshAcquireJobs()
    }

    fun refreshAcquireJobs() {
        if (status.value?.apiUrl.isNullOrBlank()) return
        scope.launch {
            loopbackApi.listJobs().onSuccess { jobs ->
                val newlyCompleted = jobs.filter { it.isDone && it.jobId in previousActiveJobIds }
                val vanishedDone = previousActiveJobIds.filter { oldId -> jobs.none { it.jobId == oldId } }
                if (newlyCompleted.isNotEmpty() || vanishedDone.isNotEmpty()) {
                    refreshes.trySend(Unit)
                    newlyCompleted.firstOrNull()?.let { done ->
                        notice.value = "Added ${done.title.ifBlank { "to library" }}"
                    }
                }
                previousActiveJobIds = jobs.filter { it.isActive }.map { it.jobId }.toSet()
                acquireJobs.value = jobs
                applyBackgroundPolicy()
            }
        }
    }

    fun cancelOrDismissJob(jobId: String) {
        scope.launch {
            loopbackApi.cancelJob(jobId).fold(
                onSuccess = {
                    acquireJobs.value = acquireJobs.value.filterNot { it.jobId == jobId }
                    previousActiveJobIds = previousActiveJobIds - jobId
                    applyBackgroundPolicy()
                    refreshAcquireJobs()
                },
                onFailure = { err ->
                    error.value = err.message ?: "Could not update job."
                },
            )
        }
    }

    fun refreshPlugins() {
        if (status.value?.apiUrl.isNullOrBlank()) return
        scope.launch {
            loopbackApi.listPlugins().onSuccess { list ->
                plugins.value = list
            }
        }
    }

    fun toggleSearchSource(source: SearchSource) {
        val current = selectedSources.value
        selectedSources.value = if (source in current) current - source else current + source
    }

    fun searchAll(rawQuery: String) {
        val q = rawQuery.trim()
        if (q.length < 2) return
        searchGlobal(q)
        searchSources(q, selectedSources.value)
    }

    fun searchSources(rawQuery: String, sources: Set<SearchSource> = selectedSources.value) {
        val q = rawQuery.trim()
        if (q.length < 2) return
        if (sources.isEmpty()) {
            sourceSearch.value = SourceSearchState(
                query = q,
                requestedSources = emptySet(),
                error = "Select at least one source above.",
            )
            return
        }
        sourceSearchJob?.cancel()
        val prev = sourceSearch.value
        sourceSearch.value = SourceSearchState(
            query = q,
            requestedSources = sources,
            result = if (prev.query == q) prev.result else SourceSearchResult(),
            busy = true,
            error = null,
        )
        sourceSearchJob = scope.launch {
            val res = loopbackApi.searchSources(q, sources.map { it.id })
            if (sourceSearch.value.query != q) return@launch
            sourceSearch.value = res.fold(
                onSuccess = { parsed ->
                    sourceSearch.value.copy(result = parsed, busy = false, error = null)
                },
                onFailure = { err ->
                    sourceSearch.value.copy(busy = false, error = err.message ?: "Source search failed.")
                },
            )
        }
    }

    fun saveSoulseekAlbum(candidate: SoulseekAlbumCandidate) {
        scope.launch {
            loopbackApi.mirrorSoulseek(
                peer = candidate.peer,
                folder = candidate.folder,
                artist = candidate.artist,
                album = candidate.displayTitle,
                year = candidate.year.takeIf { it.isNotBlank() },
                files = candidate.files,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Saving ${candidate.displayTitle}…"
                },
                onFailure = { err -> error.value = err.message },
            )
        }
    }

    fun saveSoulseekFolder(peer: String, folder: SoulseekShelfFolder) {
        scope.launch {
            loopbackApi.mirrorSoulseek(
                peer = peer,
                folder = folder.folder,
                artist = folder.artist,
                album = folder.displayTitle,
                year = folder.year.takeIf { it.isNotBlank() },
                files = folder.files,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Saving ${folder.displayTitle}…"
                },
                onFailure = { err -> error.value = err.message },
            )
        }
    }

    fun saveYouTubeTrack(candidate: YouTubeCandidate, artist: String, album: String, year: String? = null) {
        val cleanArtist = artist.trim().ifBlank { candidate.channel.ifBlank { "YouTube" } }
        val cleanAlbum = album.trim().ifBlank { candidate.title }
        scope.launch {
            loopbackApi.mirrorYouTube(
                artist = cleanArtist,
                album = cleanAlbum,
                year = year?.trim()?.takeIf { it.isNotBlank() },
                tracks = listOf(YouTubeTrackInput(videoId = candidate.videoId, title = candidate.title, track = 1, disc = 1)),
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Saving ${candidate.title}…"
                },
                onFailure = { err -> error.value = err.message },
            )
        }
    }

    fun saveSoundCloudTrack(candidate: SoundCloudCandidate) {
        val artist = candidate.artist.ifBlank { "SoundCloud" }
        val album = candidate.album.ifBlank { candidate.title }
        scope.launch {
            loopbackApi.mirrorSoundCloud(
                artist = artist,
                album = album,
                tracks = listOf(
                    SoundCloudTrackInput(
                        trackId = candidate.trackId,
                        url = candidate.url,
                        title = candidate.title,
                        track = 1,
                        disc = 1,
                    ),
                ),
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Saving ${candidate.title}…"
                },
                onFailure = { err -> error.value = err.message },
            )
        }
    }

    fun saveRumbleItem(candidate: RumbleCandidate, audioOnly: Boolean) {
        scope.launch {
            loopbackApi.mirrorRumble(
                title = candidate.title,
                url = candidate.url,
                rumbleId = candidate.rumbleId,
                audio = audioOnly,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = if (audioOnly) "Saving audio for ${candidate.title}…" else "Saving ${candidate.title}…"
                },
                onFailure = { err -> error.value = err.message },
            )
        }
    }

    fun openShelf(peer: String) {
        val clean = peer.trim()
        if (clean.isEmpty()) return
        recordVisitedShelf(clean, folderCount = visitedShelves.value.firstOrNull { it.peer == clean }?.folderCount ?: 0)
        pushScreen(Screen.ShelfDetail(clean))
        loadShelf(clean)
    }

    fun loadShelf(peer: String) {
        val clean = peer.trim()
        if (clean.isEmpty()) return
        shelfJob?.cancel()
        val existing = shelfState.value.takeIf { it.peer == clean }?.shelf
        shelfState.value = ShelfBrowserState(peer = clean, shelf = existing, busy = true, error = null)
        shelfJob = scope.launch {
            val res = loopbackApi.browseSoulseek(clean)
            if (shelfState.value.peer != clean) return@launch
            res.fold(
                onSuccess = { shelf ->
                    shelfState.value = ShelfBrowserState(peer = clean, shelf = shelf, busy = false, error = null)
                    recordVisitedShelf(clean, folderCount = shelf.folders.size)
                },
                onFailure = { err ->
                    shelfState.value = shelfState.value.copy(
                        busy = false,
                        error = err.message ?: "Could not load $clean's shelf.",
                    )
                },
            )
        }
    }

    private fun loadVisitedShelves(): List<VisitedShelf> = runCatching {
        val arr = JSONArray(visitedShelvesFile.openRead().bufferedReader().use { it.readText() })
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(VisitedShelf::from) }.filter { it.peer.isNotBlank() }
    }.getOrDefault(emptyList())

    private fun recordVisitedShelf(peer: String, folderCount: Int) {
        val entry = VisitedShelf(peer = peer, folderCount = folderCount, visitedAt = System.currentTimeMillis())
        val updated = (listOf(entry) + visitedShelves.value.filterNot { it.peer.equals(peer, ignoreCase = true) }).take(30)
        visitedShelves.value = updated
        scope.launch(Dispatchers.IO) {
            var stream: java.io.FileOutputStream? = null
            try {
                dataDir.mkdirs()
                stream = visitedShelvesFile.startWrite()
                val arr = JSONArray().apply { updated.forEach { put(it.toJson()) } }
                stream.write(arr.toString().toByteArray(Charsets.UTF_8))
                visitedShelvesFile.finishWrite(stream)
            } catch (_: Exception) {
                stream?.let(visitedShelvesFile::failWrite)
            }
        }
    }

    fun refreshSoulseekSettings() {
        if (status.value?.apiUrl.isNullOrBlank()) return
        scope.launch {
            loopbackApi.getSoulseekSettings().onSuccess { loaded ->
                soulseekSettings.value = loaded
                soulseekError.value = null
            }
            refreshPlugins()
        }
    }

    fun saveSoulseekSettings(username: String, password: String?, sharePublicMusic: Boolean) {
        soulseekBusy.value = true
        soulseekError.value = null
        soulseekMessage.value = null
        scope.launch {
            val cleanUser = username.trim()
            val effectivePassword = when {
                !password.isNullOrEmpty() -> password
                cleanUser.isEmpty() -> ""
                else -> null
            }
            loopbackApi.updateSoulseekSettings(cleanUser, effectivePassword, sharePublicMusic).fold(
                onSuccess = { updated ->
                    soulseekSettings.value = updated
                    soulseekBusy.value = false
                    soulseekMessage.value = if (updated.username.isNotBlank()) {
                        "Saved Soulseek account for ${updated.username}."
                    } else {
                        "Cleared Soulseek account."
                    }
                    refreshPlugins()
                },
                onFailure = { err ->
                    soulseekBusy.value = false
                    soulseekError.value = err.message ?: "Could not save Soulseek settings."
                },
            )
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
