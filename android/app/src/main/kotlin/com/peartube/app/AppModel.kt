package com.peartube.app

import android.app.Application
import android.content.ContentValues
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
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
import kotlinx.coroutines.flow.asStateFlow
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
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

enum class Room(val label: String) {
    Home("Home"),
    Listen("Listen"),
    Watch("Watch"),
    Discover("Discover"),
    Library("Library"),
    Search("Search"),
}

enum class LibrarySubTab(val label: String) {
    Movies("Movies"),
    Series("TV Shows"),
    Music("Music"),
    Videos("Videos"),
}

enum class SearchScope(val label: String) {
    Top("Top"),
    Music("Music"),
    Library("Library"),
    Creators("Creators"),
    Sources("Sources"),
    Relays("Relays"),
}

enum class StreamSaveState {
    Unsaved,
    Saving,
    Saved,
}

internal fun streamSaveLookupKeys(
    trackKey: String,
    videoId: String,
    artist: String,
    title: String,
): Set<String> {
    val keys = LinkedHashSet<String>(3)
    if (trackKey.isNotBlank()) keys.add(trackKey)
    val cleanVid = videoId.trim()
    if (cleanVid.isNotBlank()) keys.add("ytv:$cleanVid")
    val sig = "${fold(artist)}|${fold(title)}"
    if (sig != "|") keys.add("sig:$sig")
    return keys
}

internal fun resolveStreamSaveState(
    track: TrackItem,
    catalog: LibraryCatalog,
    jobs: List<AcquireJob>,
    saveJobMap: Map<String, String>,
    submittingKeys: Set<String>,
    savedKeys: Set<String>,
): StreamSaveState {
    if (!track.isExternalStream) return StreamSaveState.Saved
    val keys = streamSaveLookupKeys(track.key, track.externalVideoId, track.artist, track.title)
    if (keys.any { it in savedKeys }) return StreamSaveState.Saved
    val sig = "${fold(track.artist)}|${fold(track.title)}"
    if (sig != "|" && catalog.allTracks.any { "${fold(it.artist)}|${fold(it.name)}" == sig }) {
        return StreamSaveState.Saved
    }
    val jobsById = jobs.associateBy { it.jobId }
    for (k in keys) {
        val jobId = saveJobMap[k] ?: continue
        val job = jobsById[jobId]
        if (job != null) {
            if (job.isDone) return StreamSaveState.Saved
            if (job.isActive) return StreamSaveState.Saving
        } else {
            return StreamSaveState.Saving
        }
    }
    if (keys.any { it in submittingKeys }) return StreamSaveState.Saving
    return StreamSaveState.Unsaved
}

private val RECENT_SEARCH_HEX_KEY_RE = Regex("^[a-fA-F0-9]{64}$")
private val ACQUIRE_SEASON_EP_RE = Regex(":s\\d{2}e\\d{2,3}$", RegexOption.IGNORE_CASE)
private val ACQUIRE_PROTOCOL_ID_RE = Regex("^[a-z0-9]+:[a-z0-9]+(?::s\\d{2}e\\d{2,3})?$")
private val ACQUIRE_PROTOCOL_BASE_RE = Regex("^[a-z0-9]+:[a-z0-9]+$")
private val ACQUIRE_YT_VID_RE = Regex("(?:[?&]v=|youtu\\.be/|youtube\\.com/shorts/)([A-Za-z0-9_-]{11})")

internal fun normalizeAcquireId(
    rawId: String,
    title: String,
    artist: String,
    url: String,
    audio: Boolean,
): String {
    val cleanId = rawId.trim()
    val lowerId = cleanId.lowercase(Locale.ROOT)
    val ytVid = ACQUIRE_YT_VID_RE.find(url)?.groupValues?.getOrNull(1)
    val isYouTube = !ytVid.isNullOrBlank() ||
        url.contains("youtube.com", ignoreCase = true) ||
        url.contains("youtu.be/", ignoreCase = true) ||
        lowerId.startsWith("yt:")
    if (!audio) {
        if (ACQUIRE_PROTOCOL_ID_RE.matches(cleanId) && !lowerId.startsWith("yt:")) {
            return cleanId
        }
        val seed = ytVid?.let { "yt-video:$it" }
            ?: url.trim().ifBlank { "${artist.trim().lowercase(Locale.ROOT)}|${title.trim().lowercase(Locale.ROOT)}" }
        return "clip:${ExternalImageCache.sha256Hex(seed).take(20)}"
    }
    if (ACQUIRE_PROTOCOL_ID_RE.matches(cleanId) && ACQUIRE_SEASON_EP_RE.containsMatchIn(cleanId)) {
        return cleanId
    }
    if (isYouTube) {
        val hashSeed = listOf(
            artist.trim().lowercase(Locale.ROOT),
            title.trim().lowercase(Locale.ROOT),
            ytVid.orEmpty(),
        ).joinToString("|")
        val hex = ExternalImageCache.sha256Hex(hashSeed).take(20)
        return "yt:$hex:s01e01"
    }
    if (ACQUIRE_PROTOCOL_BASE_RE.matches(cleanId)) {
        return "$cleanId:s01e01"
    }
    val hash = ExternalImageCache.sha256Hex(
        "${artist.trim().lowercase(Locale.ROOT)}|${title.trim().lowercase(Locale.ROOT)}|${url.trim()}",
    ).take(20)
    return "album:$hash:s01e01"
}

internal fun isSearchLink(raw: String): Boolean {
    val trimmed = raw.trim()
    return trimmed.startsWith("peartube://", ignoreCase = true) ||
        trimmed.startsWith("http://", ignoreCase = true) ||
        trimmed.startsWith("https://", ignoreCase = true) ||
        RECENT_SEARCH_HEX_KEY_RE.matches(trimmed)
}

internal fun addRecentSearchTerm(
    current: List<String>,
    rawTerm: String,
    maxCount: Int = 6,
): List<String> {
    val clean = rawTerm.trim()
    if (clean.length < 2 || isSearchLink(clean)) return current
    val deduped = current.filterNot { it.equals(clean, ignoreCase = true) }
    return (listOf(clean) + deduped).take(maxCount)
}

internal fun removeRecentSearchTerm(current: List<String>, term: String): List<String> {
    val clean = term.trim()
    return current.filterNot { it.equals(clean, ignoreCase = true) }
}

internal fun isCastSessionLive(session: CastSession?): Boolean {
    if (session == null) return false
    val st = session.state
    return st.entry != null || st.playing || st.buffering || (st.status != "idle" && !st.ended)
}

internal fun buildCastMediaSnapshot(
    session: CastSession?,
    reconnecting: Boolean,
): MediaSessionSnapshot {
    if (session == null || (!reconnecting && !isCastSessionLive(session))) {
        return MediaSessionSnapshot(active = false)
    }
    val st = session.state
    val entry = st.entry
    val receiverName = session.receiverName.ifBlank { "PearTube TV" }
    val title = entry?.title?.ifBlank { receiverName } ?: receiverName
    val subtitle = when {
        reconnecting -> "Reconnecting to $receiverName…"
        st.playing -> "Playing on $receiverName"
        else -> "Paused on $receiverName"
    }
    val poster = entry?.id?.takeIf { it.isNotBlank() }?.let { imdbPosterUrl(extractImdbId(it)) }
    return MediaSessionSnapshot(
        active = true,
        isVideo = true,
        isCast = true,
        title = title,
        subtitle = subtitle,
        album = receiverName,
        playing = !reconnecting && st.playing,
        buffering = reconnecting || st.buffering,
        positionMs = st.positionMs,
        durationMs = st.durationMs ?: 0L,
        artworkUrl = poster,
    )
}

private val CAST_RECONNECT_BACKOFF_MS = longArrayOf(1_500L, 3_000L, 5_000L, 8_000L, 12_000L, 15_000L)

internal fun nextCastReconnectDelayMs(attempt: Int): Long {
    val idx = attempt.coerceIn(0, CAST_RECONNECT_BACKOFF_MS.lastIndex)
    return CAST_RECONNECT_BACKOFF_MS[idx]
}

interface VideoControlBridge {
    fun play()
    fun pause()
    fun togglePlayPause()
    fun seekBy(deltaMs: Long)
    fun seekTo(positionMs: Long)
    fun stop()
}

enum class VideoDisplayMode {
    Closed,
    Fullscreen,
    Mini,
    Pip,
}

data class ActiveVideo(
    val entry: Entry,
    val startPositionMs: Long? = null,
)

sealed interface Screen {
    data object Main : Screen
    data class AlbumDetail(val albumKey: String) : Screen
    data class ArtistDetail(val artistKey: String) : Screen
    data class ExternalArtistDetail(
        val browseId: String,
        val name: String,
        val artUrl: String = "",
    ) : Screen
    data class ExternalAlbumDetail(
        val browseId: String,
        val title: String,
        val artist: String = "",
        val artUrl: String = "",
    ) : Screen
    data class TitleDetail(val titleKey: String) : Screen
    data class ShelfDetail(val peer: String) : Screen
    data object MusicPlayerFull : Screen
    data object Network : Screen
    data object Settings : Screen
    data class Play(val entry: Entry, val startPositionMs: Long? = null) : Screen
}

sealed interface PeekTarget {
    data class LibraryTitle(val tile: LibraryTile) : PeekTarget
    data class LibraryAlbum(val album: LibraryTile) : PeekTarget
    data class DiscoverCinema(val item: CinemaDiscoverItem) : PeekTarget
    data class DiscoverVideo(val video: ExternalVideoPick) : PeekTarget
    data class DiscoverAlbum(val album: SuggestedAlbum) : PeekTarget
}

data class DownloadProgress(val bytes: Long, val total: Long)

data class AddSheetState(
    val rawInput: String = "",
    val identifying: Boolean = false,
    val identified: IdentifyResult? = null,
    val detectedKind: DetectedMediaKind? = null,
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
    val networkHistory = MutableStateFlow(NetworkHistory())
    val identity = MutableStateFlow<IdentityInfo?>(null)
    val entries = MutableStateFlow<List<Entry>>(emptyList())
    val error = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val searchScope = MutableStateFlow(SearchScope.Top)
    val recentSearches = MutableStateFlow<List<String>>(emptyList())
    val ytmSearch = MutableStateFlow(YtmSearchResult(""))
    val ytmSearchBusy = MutableStateFlow(false)
    val global = MutableStateFlow(GlobalSearch())

    private val prefsFile = AtomicFile(File(dataDir, "ui-prefs.json"))
    val currentRoom = MutableStateFlow(loadLastRoom())
    val shareImportMode = MutableStateFlow(loadShareImportMode())
    val podcastImportFormat = MutableStateFlow(loadPodcastImportFormat())
    val autoAcquireBanner = MutableStateFlow<AutoAcquireBanner?>(null)
    val libraryTab = MutableStateFlow(LibrarySubTab.Movies)
    private var lastNonSearchRoom: Room = currentRoom.value.takeUnless { it == Room.Search } ?: Room.Home
    private val navStack = MutableStateFlow<List<Screen>>(listOf(Screen.Main))
    val screen: StateFlow<Screen> = navStack
        .map { it.lastOrNull() ?: Screen.Main }
        .stateIn(scope, SharingStarted.Eagerly, Screen.Main)

    val catalog: StateFlow<LibraryCatalog> = entries
        .map { LibraryCatalog.build(it) }
        .stateIn(scope, SharingStarted.Eagerly, LibraryCatalog.Empty)

    val cast = MutableStateFlow(CastStatus())
    val castReconnecting = MutableStateFlow(false)
    val lastCastSession = MutableStateFlow<CastSession?>(null)
    val pendingCast = MutableStateFlow<PendingCast?>(null)
    val selectedCastReceiver = MutableStateFlow<CastReceiver?>(null)
    private var stickyCastReceiverId: String? = null
    private var castReconnectJob: Job? = null
    private var castReconnectUntilMs: Long = 0L
    private val castReconnectWindowMs = 5 * 60_000L
    private var workerSuspended: Boolean = false
    val showTvsDialog = MutableStateFlow(false)
    val showAddSheet = MutableStateFlow(false)
    val showMusicPlayer = MutableStateFlow(false)
    val peekTarget = MutableStateFlow<PeekTarget?>(null)
    val showTonightsPick = MutableStateFlow(false)
    val addSheet = MutableStateFlow(AddSheetState())

    fun openMusicPlayer() {
        showMusicPlayer.value = true
    }

    fun closeMusicPlayer() {
        showMusicPlayer.value = false
    }

    fun openPeek(target: PeekTarget) {
        peekTarget.value = target
    }

    fun closePeek() {
        peekTarget.value = null
    }
    val searchAutoFocus = MutableStateFlow(false)
    val notice = MutableStateFlow<String?>(null)
    val streamingSaveJobs = MutableStateFlow<Map<String, String>>(emptyMap())
    val streamingSubmittingKeys = MutableStateFlow<Set<String>>(emptySet())
    val streamingSavedKeys = MutableStateFlow<Set<String>>(emptySet())
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
    private val _metaSourcesState = MutableStateFlow(MetaSourcesState())
    val metaSourcesState: StateFlow<MetaSourcesState> = _metaSourcesState.asStateFlow()
    val metaBusy = MutableStateFlow(false)
    val metaError = MutableStateFlow<String?>(null)
    val metaMessage = MutableStateFlow<String?>(null)
    val discoverCreators = MutableStateFlow<List<DiscoverCreator>>(emptyList())
    val discoverFeed = MutableStateFlow(DiscoverFeed())
    val discoverBrowse = MutableStateFlow<DiscoverBrowseResult?>(null)
    val discoverLoading = MutableStateFlow(false)
    val discoverFollowBusy = MutableStateFlow(false)
    val discoverError = MutableStateFlow<String?>(null)
    val discoverSourceFilter = MutableStateFlow("")
    val discoverCreatorFilter = MutableStateFlow("")
    val discoverActiveTopic = MutableStateFlow<String?>(null)
    val discoverSubmittingIds = MutableStateFlow<Set<String>>(emptySet())

    // LUMEN v4.4 Discover tabs, typeahead creator finder, music discovery, cinema discovery, and full-length streaming
    val discoverTab = MutableStateFlow(DiscoverTab.All)
    val creatorSuggestions = MutableStateFlow<List<CreatorSuggestion>>(emptyList())
    val creatorSuggestBusy = MutableStateFlow(false)
    val musicDiscoverMood = MutableStateFlow("featured")
    val musicDiscoverQuery = MutableStateFlow("")
    val musicDiscoverData = MutableStateFlow<MusicDiscoverData?>(null)
    val musicDiscoverLoading = MutableStateFlow(false)
    val musicDiscoverError = MutableStateFlow<String?>(null)
    val selectedSuggestedArtist = MutableStateFlow<SuggestedArtist?>(null)
    val cinemaDiscoverGenre = MutableStateFlow("Popular")
    val cinemaDiscoverData = MutableStateFlow<CinemaDiscoverData?>(null)
    val cinemaDiscoverLoading = MutableStateFlow(false)
    val cinemaDiscoverError = MutableStateFlow<String?>(null)
    val featuredCreators = MutableStateFlow<List<CreatorSuggestion>>(emptyList())
    val featuredCreatorsLoading = MutableStateFlow(false)
    val externalVideos = MutableStateFlow<List<ExternalVideoPick>>(emptyList())
    val externalVideosTopic = MutableStateFlow("Featured")
    val externalVideosLoading = MutableStateFlow(false)

    // Hoisted video player session (persists across Fullscreen <-> Mini <-> OS PiP)
    val activeVideo = MutableStateFlow<ActiveVideo?>(null)
    val videoMode = MutableStateFlow(VideoDisplayMode.Closed)
    val isVideoPlaying = MutableStateFlow(false)
    val videoPlaying: StateFlow<Boolean> get() = isVideoPlaying
    val videoPositionMs = MutableStateFlow(0L)
    val videoDurationMs = MutableStateFlow(0L)
    val videoBuffering = MutableStateFlow(false)
    val videoAspectRatio = MutableStateFlow(16f / 9f)
    val videoSourceRect = MutableStateFlow<Rect?>(null)
    private var prePipMode: VideoDisplayMode = VideoDisplayMode.Fullscreen
    @Volatile private var videoControlBridge: VideoControlBridge? = null
    @Volatile private var musicSessionActive: Boolean = false

    private var identifyJob: Job? = null
    private var autoAcquireBannerJob: Job? = null
    private var sourceSearchJob: Job? = null
    private var shelfJob: Job? = null
    private var discoverFeedJob: Job? = null
    private var discoverBrowseJob: Job? = null
    private var creatorSuggestJob: Job? = null
    private var ytmSearchJob: Job? = null
    private var musicDiscoverJob: Job? = null
    private var cinemaDiscoverJob: Job? = null
    private var externalVideosJob: Job? = null
    private var externalStreamResolveJob: Job? = null
    private var catalogRefreshBurstJob: Job? = null
    private val cinemaDiscoverCache = ConcurrentHashMap<String, CinemaDiscoverData>()
    private var featuredCreatorsLoaded = false
    private var previousActiveJobIds: Set<String> = emptySet()
    private var lastLoadedApiUrl: String? = null

    val previewPlayer: MusicPreviewPlayer = MusicPreviewPlayer(
        onStartingPreview = {
            if (musicState.value.playing) {
                music.pauseForVideo()
            }
        },
    )

    val music: MusicPlayerController = MusicPlayerController(
        context = app,
        scope = scope,
        dataDir = dataDir,
        resolveStreamUrl = { entry -> resolveEntry(entry) },
        fetchAutoplayTracks = { seed, excludeVideoIds ->
            buildAutoplayRadioBatch(seed, excludeVideoIds)
        },
        onStartingMusic = {
            previewPlayer.stop()
            musicSessionActive = true
            // Rule 4: Starting music while a video is open closes the video (keeping its place under Keep playing).
            if (activeVideo.value != null || screen.value is Screen.Play) {
                closeVideo()
            }
        },
        onPlaybackActiveChanged = { active ->
            if (active) {
                musicSessionActive = true
            } else if (!music.state.value.hasQueue) {
                musicSessionActive = false
            }
            setPlayerActive(active || activeVideo.value != null || screen.value is Screen.Play)
            applyBackgroundPolicy()
        },
    )
    val musicState: StateFlow<MusicState> = music.state

    private fun readUiPrefsJson(): JSONObject? = runCatching {
        JSONObject(prefsFile.openRead().bufferedReader().use { it.readText() })
    }.getOrNull()

    private fun loadLastRoom(): Room {
        val savedName = readUiPrefsJson()?.optString("room").orEmpty()
        val saved = Room.entries.firstOrNull { it.name.equals(savedName, ignoreCase = true) } ?: Room.Home
        return when (saved) {
            Room.Listen, Room.Watch -> Room.Library
            else -> saved
        }
    }

    private fun loadShareImportMode(): ShareImportMode =
        ShareImportMode.fromId(readUiPrefsJson()?.optString("shareImportMode"))

    private fun loadPodcastImportFormat(): PodcastImportFormat =
        PodcastImportFormat.fromId(readUiPrefsJson()?.optString("podcastImportFormat"))

    private fun saveUiPrefs(
        room: Room = currentRoom.value,
        shareMode: ShareImportMode = shareImportMode.value,
        podcastFormat: PodcastImportFormat = podcastImportFormat.value,
    ) {
        scope.launch(Dispatchers.IO) {
            var stream: java.io.FileOutputStream? = null
            try {
                dataDir.mkdirs()
                val json = JSONObject()
                    .put("room", room.name)
                    .put("shareImportMode", shareMode.id)
                    .put("podcastImportFormat", podcastFormat.id)
                stream = prefsFile.startWrite()
                stream.write(json.toString().toByteArray(Charsets.UTF_8))
                prefsFile.finishWrite(stream)
            } catch (_: Exception) {
                stream?.let(prefsFile::failWrite)
            }
        }
    }

    fun setShareImportMode(mode: ShareImportMode) {
        if (shareImportMode.value == mode) return
        shareImportMode.value = mode
        saveUiPrefs(shareMode = mode)
    }

    fun setPodcastImportFormat(format: PodcastImportFormat) {
        if (podcastImportFormat.value == format) return
        podcastImportFormat.value = format
        saveUiPrefs(podcastFormat = format)
    }

    private fun showAutoAcquireBanner(banner: AutoAcquireBanner) {
        autoAcquireBannerJob?.cancel()
        autoAcquireBanner.value = banner
        autoAcquireBannerJob = scope.launch {
            delay(8_000L)
            if (autoAcquireBanner.value?.jobId == banner.jobId) {
                autoAcquireBanner.value = null
            }
        }
    }

    fun dismissAutoAcquireBanner() {
        autoAcquireBannerJob?.cancel()
        autoAcquireBannerJob = null
        autoAcquireBanner.value = null
    }

    fun selectLibraryTab(tab: LibrarySubTab) {
        libraryTab.value = tab
        if (currentRoom.value != Room.Library) {
            selectRoom(Room.Library)
        }
    }

    fun toggleSearchRoom() {
        if (currentRoom.value == Room.Search) {
            selectRoom(lastNonSearchRoom)
        } else {
            selectRoom(Room.Search, focusSearch = true)
        }
    }

    fun selectRoom(room: Room, focusSearch: Boolean = false) {
        val resolvedRoom = when (room) {
            Room.Listen -> {
                libraryTab.value = LibrarySubTab.Music
                Room.Library
            }
            Room.Watch -> {
                val cat = catalog.value
                libraryTab.value = if (cat.movies.isEmpty() && cat.series.isNotEmpty()) {
                    LibrarySubTab.Series
                } else {
                    LibrarySubTab.Movies
                }
                Room.Library
            }
            else -> room
        }
        if (resolvedRoom != Room.Discover) {
            previewPlayer.stop()
        }
        if (resolvedRoom != Room.Search) {
            lastNonSearchRoom = resolvedRoom
        }
        currentRoom.value = resolvedRoom
        showMusicPlayer.value = false
        saveUiPrefs(room = resolvedRoom)
        if (focusSearch) searchAutoFocus.value = true
        navStack.value = listOf(Screen.Main)
        if (resolvedRoom == Room.Discover) {
            loadDiscoverCreators(autoLoadFeed = discoverActiveTopic.value == null)
            if (musicDiscoverData.value == null && !musicDiscoverLoading.value) {
                loadMusicDiscover(musicDiscoverMood.value, musicDiscoverQuery.value)
            }
            if (cinemaDiscoverData.value == null && !cinemaDiscoverLoading.value) {
                loadCinemaDiscover(cinemaDiscoverGenre.value)
            }
            if (externalVideos.value.isEmpty() && !externalVideosLoading.value) {
                loadExternalVideos(externalVideosTopic.value)
            }
            loadFeaturedCreatorsIfNeeded()
        }
    }

    fun recordRecentSearch(term: String) {
        recentSearches.value = addRecentSearchTerm(recentSearches.value, term)
    }

    fun removeRecentSearch(term: String) {
        recentSearches.value = removeRecentSearchTerm(recentSearches.value, term)
    }

    fun clearRecentSearches() {
        recentSearches.value = emptyList()
    }

    fun openSearchFor(term: String, askRelays: Boolean = false) {
        previewPlayer.stop()
        query.value = term
        recordRecentSearch(term)
        searchScope.value = if (term.trim().startsWith("@")) SearchScope.Creators else SearchScope.Top
        currentRoom.value = Room.Search
        showMusicPlayer.value = false
        saveUiPrefs(room = Room.Search)
        navStack.value = listOf(Screen.Main)
        if (askRelays && term.trim().length >= 2) {
            searchAll(term)
        }
    }

    fun pushScreen(next: Screen) {
        if (next is Screen.Play) {
            openVideo(next.entry, next.startPositionMs)
            return
        }
        if (next is Screen.MusicPlayerFull) {
            openMusicPlayer()
            return
        }
        previewPlayer.stop()
        showMusicPlayer.value = false
        val stack = navStack.value
        if (stack.lastOrNull() == next) return
        navStack.value = stack + next
    }

    fun replaceTopScreen(next: Screen) {
        if (next is Screen.Play) {
            openVideo(next.entry, next.startPositionMs)
            return
        }
        if (next is Screen.MusicPlayerFull) {
            openMusicPlayer()
            return
        }
        showMusicPlayer.value = false
        val stack = navStack.value
        navStack.value = if (stack.size <= 1) listOf(Screen.Main, next) else stack.dropLast(1) + next
    }

    fun popScreen() {
        previewPlayer.stop()
        if (showMusicPlayer.value) {
            showMusicPlayer.value = false
            return
        }
        val stack = navStack.value
        navStack.value = if (stack.size > 1) stack.dropLast(1) else listOf(Screen.Main)
    }

    fun goHome() {
        previewPlayer.stop()
        showMusicPlayer.value = false
        navStack.value = listOf(Screen.Main)
    }

    fun openVideo(entry: Entry, startPositionMs: Long? = null) {
        previewPlayer.stop()
        showMusicPlayer.value = false
        // Rule 3: Music waits for a video. Pause music, keep track/position/queue, show Paused for a video.
        music.pauseForVideo()
        musicSessionActive = false
        activeVideo.value = ActiveVideo(entry = entry, startPositionMs = startPositionMs)
        videoMode.value = VideoDisplayMode.Fullscreen
        isVideoPlaying.value = true
        videoBuffering.value = true
        videoPositionMs.value = startPositionMs ?: 0L
        videoDurationMs.value = 0L
        setPlayerActive(true)
        applyBackgroundPolicy()
    }

    fun minimizeVideo() {
        if (activeVideo.value != null) {
            videoMode.value = VideoDisplayMode.Mini
        }
    }

    fun expandVideo() {
        if (activeVideo.value != null) {
            videoMode.value = VideoDisplayMode.Fullscreen
        }
    }

    fun closeVideo() {
        val hadVideo = activeVideo.value != null
        activeVideo.value = null
        videoMode.value = VideoDisplayMode.Closed
        isVideoPlaying.value = false
        videoBuffering.value = false
        videoPositionMs.value = 0L
        videoDurationMs.value = 0L
        videoSourceRect.value = null
        videoControlBridge = null
        playStarted = false
        if (screen.value is Screen.Play) popScreen()
        setPlayerActive(musicState.value.playing)
        applyBackgroundPolicy()
        if (hadVideo) refreshes.trySend(Unit)
    }

    fun hasActivePlayingVideo(): Boolean =
        activeVideo.value != null && videoMode.value != VideoDisplayMode.Closed && isVideoPlaying.value

    fun registerVideoControls(bridge: VideoControlBridge?) {
        videoControlBridge = bridge
    }

    fun updateVideoSourceRect(rect: Rect?) {
        if (videoSourceRect.value != rect) {
            videoSourceRect.value = rect
        }
    }

    fun updateVideoPlaybackState(
        playing: Boolean,
        displayAspect: Float?,
        positionMs: Long = videoPositionMs.value,
        durationMs: Long? = null,
        buffering: Boolean = false,
    ) {
        val playingChanged = isVideoPlaying.value != playing
        if (playingChanged) {
            isVideoPlaying.value = playing
        }
        if (videoBuffering.value != buffering) {
            videoBuffering.value = buffering
        }
        videoPositionMs.value = positionMs.coerceAtLeast(0L)
        if (durationMs != null && durationMs > 0L) {
            videoDurationMs.value = durationMs
        }
        if (displayAspect != null && displayAspect.isFinite() && displayAspect > 0.1f) {
            videoAspectRatio.value = displayAspect
        }
        if (playingChanged) {
            applyBackgroundPolicy()
        } else {
            syncMediaService()
        }
    }

    fun dispatchVideoMediaAction(action: MediaAction, seekPositionMs: Long? = null) {
        val bridge = videoControlBridge
        if (bridge == null) {
            if (action == MediaAction.Stop) closeVideo()
            return
        }
        when (action) {
            MediaAction.Play -> bridge.play()
            MediaAction.Pause -> bridge.pause()
            MediaAction.TogglePlayPause -> bridge.togglePlayPause()
            MediaAction.SkipForward, MediaAction.Next -> bridge.seekBy(10_000L)
            MediaAction.SkipBack, MediaAction.Previous -> bridge.seekBy(-10_000L)
            MediaAction.SeekTo -> seekPositionMs?.let { bridge.seekTo(it) }
            MediaAction.Stop -> bridge.stop()
        }
    }

    fun dispatchMediaAction(action: MediaAction, seekPositionMs: Long? = null) {
        val hasVideo = activeVideo.value != null && videoMode.value != VideoDisplayMode.Closed
        if (hasVideo) {
            dispatchVideoMediaAction(action, seekPositionMs)
            return
        }
        val ms = musicState.value
        val musicActivelyRunning = ms.currentTrack != null && (ms.playing || ms.buffering)
        if (!musicActivelyRunning && (isCastSessionLive(cast.value.session) || castReconnecting.value)) {
            when (action) {
                MediaAction.Play -> sendCastControl(JSONObject().put("action", "play"))
                MediaAction.Pause -> sendCastControl(JSONObject().put("action", "pause"))
                MediaAction.TogglePlayPause -> sendCastControl(JSONObject().put("action", "togglePlay"))
                MediaAction.SkipForward, MediaAction.Next -> sendCastControl(JSONObject().put("action", "skip").put("deltaMs", 10_000))
                MediaAction.SkipBack, MediaAction.Previous -> sendCastControl(JSONObject().put("action", "skip").put("deltaMs", -10_000))
                MediaAction.SeekTo -> seekPositionMs?.let { sendCastControl(JSONObject().put("action", "seek").put("positionMs", it)) }
                MediaAction.Stop -> stopCasting()
            }
            return
        }
        when (action) {
            MediaAction.Play -> music.play()
            MediaAction.Pause -> music.pause()
            MediaAction.TogglePlayPause -> music.togglePlayPause()
            MediaAction.Next -> music.next()
            MediaAction.Previous -> music.previous()
            MediaAction.SkipForward -> music.seekTo(musicState.value.positionMs + 10_000L)
            MediaAction.SkipBack -> music.seekTo((musicState.value.positionMs - 10_000L).coerceAtLeast(0L))
            MediaAction.SeekTo -> seekPositionMs?.let { music.seekTo(it) }
            MediaAction.Stop -> {
                musicSessionActive = false
                music.stopMusic()
            }
        }
    }

    fun currentMediaSnapshot(): MediaSessionSnapshot {
        val vid = activeVideo.value
        if (vid != null && videoMode.value != VideoDisplayMode.Closed) {
            val e = vid.entry
            val sub = buildList {
                if (e.isEpisode) add(e.episodeLabel)
                e.year?.takeIf { it.isNotBlank() }?.let { add(it) }
            }.joinToString(" · ").ifBlank { "PearTube Video" }
            val poster = imdbPosterUrl(extractImdbId(e.id))
            return MediaSessionSnapshot(
                active = true,
                isVideo = true,
                title = e.title.ifBlank { "Video" },
                subtitle = sub,
                album = "PearTube",
                playing = isVideoPlaying.value,
                buffering = videoBuffering.value,
                positionMs = videoPositionMs.value,
                durationMs = videoDurationMs.value,
                artworkUrl = poster,
            )
        }
        val ms = musicState.value
        val track = ms.currentTrack
        if (track != null && (ms.playing || ms.buffering || (musicSessionActive && !ms.pausedForVideo))) {
            val art = track.artUrl.takeIf { it.isNotBlank() }
                ?: ExternalDiscoveryApi.cachedAlbumArtUrl(track.artist, track.album)
            return MediaSessionSnapshot(
                active = true,
                isVideo = false,
                title = track.title.ifBlank { track.album },
                subtitle = track.artist.ifBlank { track.album.ifBlank { track.externalStreamSource.orEmpty() } },
                album = track.album.ifBlank { track.externalStreamSource.orEmpty() },
                playing = ms.playing,
                buffering = ms.buffering,
                positionMs = ms.positionMs,
                durationMs = ms.durationMs ?: 0L,
                artworkUrl = art,
            )
        }
        val castSession = cast.value.session ?: lastCastSession.value.takeIf { castReconnecting.value }
        val castSnapshot = buildCastMediaSnapshot(castSession, reconnecting = cast.value.session == null && castReconnecting.value)
        if (castSnapshot.active) {
            return castSnapshot
        }
        return MediaSessionSnapshot(active = false)
    }

    fun syncMediaService() {
        MediaPlaybackService.sync(app, currentMediaSnapshot())
    }

    fun onSystemPipChanged(inPip: Boolean, isDismissed: Boolean = false) {
        if (inPip) {
            if (activeVideo.value != null) {
                val cur = videoMode.value
                if (cur == VideoDisplayMode.Fullscreen || cur == VideoDisplayMode.Mini) {
                    prePipMode = cur
                }
                videoMode.value = VideoDisplayMode.Pip
                applyBackgroundPolicy()
            }
        } else {
            if (isDismissed) {
                closeVideo()
            } else if (activeVideo.value != null && videoMode.value == VideoDisplayMode.Pip) {
                videoMode.value = VideoDisplayMode.Fullscreen
                applyBackgroundPolicy()
            }
        }
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

    fun playEntry(entry: Entry, localOnly: Boolean = false, startPositionMs: Long? = null) {
        if (entry.locked) {
            error.value = "Subscriber pass needed: paste this channel's peartube://access/… pass in Search or Add to library."
            return
        }
        scope.launch {
            val current = resolveEntry(entry)
            val receiver = if (localOnly) null else (cast.value.session?.receiverId ?: selectedCastReceiver.value?.id)
            val start = startPositionMs ?: (watchHistory.value[current.key]?.takeIf { it.partial }?.positionMs ?: 0L)
            if (receiver != null) {
                castToReceiver(receiver, current.key, "auto", start)
            } else {
                openVideo(current, startPositionMs)
            }
        }
    }

    fun playSurpriseVideo(
        videos: List<LibraryTile> = catalog.value.videos,
        excludeTileKey: String? = null,
    ): LibraryTile? {
        val picked = pickSurpriseVideo(videos, watchHistory.value, excludeKey = excludeTileKey) ?: return null
        val entry = primaryEntryForVideo(picked, watchHistory.value) ?: return null
        playEntry(entry)
        return picked
    }

    fun streamExternalTrack(
        id: String,
        title: String,
        artist: String,
        album: String = "",
        streamUrl: String,
        artUrl: String = "",
        sourceLabel: String = "Streaming",
        saveUrl: String? = null,
        saveKind: String? = null,
    ) {
        val cleanUrl = streamUrl.trim()
        if (cleanUrl.isEmpty()) return
        val extKey = "ext:$id"
        if (music.state.value.currentTrack?.key == extKey) {
            music.togglePlayPause()
            return
        }
        val cleanTitle = title.ifBlank { "Audio stream" }
        val cleanSource = sourceLabel.ifBlank { "Streaming" }
        val seed = sleeveHash("$artist|$album|$cleanTitle|$id")
        val hue = ((seed % 360L).toInt() + 360) % 360
        val entry = Entry(
            key = extKey,
            id = extKey,
            title = cleanTitle,
            size = 0L,
            sha256 = "",
            local = false,
            streamUrl = cleanUrl,
            music = MusicMeta(
                title = cleanTitle,
                artist = artist.takeIf { it.isNotBlank() },
            ),
        )
        val item = TrackItem(
            entry = entry,
            title = cleanTitle,
            artist = artist,
            album = album,
            albumKey = "",
            hue = hue,
            seed = seed,
            artUrl = artUrl,
            externalStreamSource = cleanSource,
            externalSaveUrl = saveUrl?.takeIf { it.isNotBlank() },
            externalSaveKind = saveKind?.takeIf { it.isNotBlank() },
        )
        music.playTrackList(listOf(item), 0, cleanSource, shuffleOn = false)
    }

    private suspend fun buildAutoplayRadioBatch(
        seed: TrackItem,
        excludeVideoIds: Set<String>,
    ): List<TrackItem> {
        val radioPicks = ExternalDiscoveryApi.fetchRadioNext(
            seedVideoId = seed.externalVideoId.takeIf { it.isNotBlank() },
            artist = seed.artist,
            title = seed.title,
            excludeVideoIds = excludeVideoIds,
            limit = 14,
        )
        val libraryTracks = catalog.value.allTracks
        val byArtistTitle = HashMap<String, TrackRow>(libraryTracks.size)
        for (row in libraryTracks) {
            val sig = "${fold(row.artist)}|${fold(row.name)}"
            if (sig != "|" && !byArtistTitle.containsKey(sig)) {
                byArtistTitle[sig] = row
            }
        }
        val out = ArrayList<TrackItem>()
        for (pick in radioPicks) {
            val sig = "${fold(pick.artist)}|${fold(pick.title)}"
            val localMatch = byArtistTitle[sig]
            if (localMatch != null) {
                out.add(trackItemFromRow(localMatch))
            } else {
                val itemSeed = sleeveHash("${pick.artist}|${pick.album}|${pick.title}|${pick.videoId}")
                val hue = ((itemSeed % 360L).toInt() + 360) % 360
                val key = "ext:radio:${pick.videoId}"
                val entry = Entry(
                    key = key,
                    id = key,
                    title = pick.title,
                    size = 0L,
                    sha256 = "",
                    local = false,
                    streamUrl = "",
                    music = MusicMeta(
                        title = pick.title,
                        artist = pick.artist.takeIf { it.isNotBlank() },
                    ),
                )
                if (pick.album.isNotBlank() && pick.artUrl.isNotBlank()) {
                    ExternalDiscoveryApi.rememberAlbumArtUrl(pick.artist, pick.album, pick.artUrl)
                }
                out.add(
                    TrackItem(
                        entry = entry,
                        title = pick.title,
                        artist = pick.artist,
                        album = pick.album,
                        albumKey = "",
                        hue = hue,
                        seed = itemSeed,
                        artUrl = pick.artUrl,
                        externalStreamSource = "Autoplay · Radio",
                        externalSaveUrl = "https://www.youtube.com/watch?v=${pick.videoId}",
                        externalSaveKind = "youtube",
                        externalVideoId = pick.videoId,
                    ),
                )
            }
        }
        // Offline fallback: continue seamlessly from unqueued tracks in the local library.
        if (out.isEmpty() && libraryTracks.isNotEmpty()) {
            val seedArtistFold = fold(seed.artist)
            val sameArtist = libraryTracks.filter { seedArtistFold.isNotEmpty() && fold(it.artist) == seedArtistFold }
            val others = libraryTracks.filter { seedArtistFold.isEmpty() || fold(it.artist) != seedArtistFold }.shuffled()
            (sameArtist.shuffled() + others).take(12).forEach { row ->
                out.add(trackItemFromRow(row))
            }
        }
        return out
    }

    private fun trackItemFromRow(row: TrackRow): TrackItem = TrackItem(
        entry = row.entry,
        title = row.name,
        artist = row.artist,
        album = row.albumName,
        albumKey = row.album.key,
        hue = row.album.hue,
        seed = row.album.seed,
        trackNo = row.number,
        disc = row.item.season,
        track = row.item.episode,
    )

    fun searchMusicCatalog(rawQuery: String) {
        val q = rawQuery.trim()
        ytmSearchJob?.cancel()
        if (q.length < 2 || q.startsWith("@") || isSearchLink(q)) {
            ytmSearch.value = YtmSearchResult("")
            ytmSearchBusy.value = false
            return
        }
        ytmSearchBusy.value = true
        ytmSearchJob = scope.launch {
            delay(260L)
            try {
                val result = ExternalDiscoveryApi.searchYouTubeMusic(q)
                if (query.value.trim() == q) {
                    ytmSearch.value = result
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            } finally {
                if (query.value.trim() == q) {
                    ytmSearchBusy.value = false
                }
            }
        }
    }

    fun openExternalArtist(browseId: String = "", name: String, artUrl: String = "") {
        val cleanName = name.trim()
        val cleanId = browseId.trim()
        if (cleanName.isEmpty() && cleanId.isEmpty()) return
        pushScreen(Screen.ExternalArtistDetail(browseId = cleanId, name = cleanName, artUrl = artUrl))
    }

    fun openExternalAlbum(browseId: String = "", title: String, artist: String = "", artUrl: String = "") {
        val cleanTitle = title.trim()
        val cleanId = browseId.trim()
        if (cleanTitle.isEmpty() && cleanId.isEmpty()) return
        pushScreen(
            Screen.ExternalAlbumDetail(
                browseId = cleanId,
                title = cleanTitle,
                artist = artist.trim(),
                artUrl = artUrl,
            ),
        )
    }

    fun playYtmSongList(
        songs: List<YtmSongItem>,
        startIndex: Int = 0,
        sourceLabel: String = "Music",
        shuffleOn: Boolean? = null,
    ) {
        if (songs.isEmpty()) return
        externalStreamResolveJob?.cancel()
        val libraryTracks = catalog.value.allTracks
        val byArtistTitle = HashMap<String, TrackRow>(libraryTracks.size)
        for (row in libraryTracks) {
            val sig = "${fold(row.artist)}|${fold(row.name)}"
            if (sig != "|" && !byArtistTitle.containsKey(sig)) {
                byArtistTitle[sig] = row
            }
        }
        val items = songs.mapIndexed { idx, song ->
            val sig = "${fold(song.artist)}|${fold(song.title)}"
            val localMatch = byArtistTitle[sig]
            if (localMatch != null) {
                trackItemFromRow(localMatch)
            } else {
                val seed = sleeveHash("${song.artist}|${song.album}|${song.title}|${song.videoId}")
                val hue = ((seed % 360L).toInt() + 360) % 360
                val key = "ext:ytm:${song.videoId}"
                val entry = Entry(
                    key = key,
                    id = key,
                    title = song.title,
                    size = 0L,
                    sha256 = "",
                    local = false,
                    streamUrl = "",
                    music = MusicMeta(
                        title = song.title,
                        artist = song.artist.takeIf { it.isNotBlank() },
                    ),
                )
                if (song.album.isNotBlank() && song.artUrl.isNotBlank()) {
                    ExternalDiscoveryApi.rememberAlbumArtUrl(song.artist, song.album, song.artUrl)
                }
                TrackItem(
                    entry = entry,
                    title = song.title,
                    artist = song.artist,
                    album = song.album,
                    albumKey = "",
                    hue = hue,
                    seed = seed,
                    trackNo = (idx + 1).toString().padStart(2, '0'),
                    disc = 1,
                    track = idx + 1,
                    artUrl = song.artUrl,
                    albumBrowseId = song.albumBrowseId,
                    externalStreamSource = "Streaming",
                    externalSaveUrl = "https://www.youtube.com/watch?v=${song.videoId}",
                    externalSaveKind = "youtube",
                    externalVideoId = song.videoId,
                )
            }
        }
        music.playTrackList(items, startIndex, sourceLabel, shuffleOn = shuffleOn)
        val started = if (startIndex in items.indices) items[startIndex] else items.firstOrNull()
        if (started != null && started.isExternalStream && started.album.isBlank()) {
            enrichStreamingTrackAlbum(started)
        }
    }

    private fun enrichStreamingTrackAlbum(track: TrackItem) {
        if (!track.isExternalStream) return
        scope.launch {
            val meta = runCatching {
                ExternalDiscoveryApi.resolveTrackAlbumMeta(
                    videoId = track.externalVideoId.takeIf { it.isNotBlank() },
                    artist = track.artist,
                    title = track.title,
                    albumBrowseId = track.albumBrowseId,
                )
            }.getOrNull() ?: return@launch
            val resolvedAlbum = meta.album.trim()
            val resolvedArtist = meta.artist.trim().ifBlank { track.artist }
            val resolvedArt = meta.artUrl.trim().ifBlank { track.artUrl }
            if (resolvedAlbum.isNotBlank() && resolvedArt.isNotBlank()) {
                ExternalDiscoveryApi.rememberAlbumArtUrl(resolvedArtist, resolvedAlbum, resolvedArt)
            }
            if (resolvedAlbum.isNotBlank() || resolvedArt != track.artUrl || meta.albumBrowseId.isNotBlank()) {
                music.updateTrackMetadata(
                    trackKey = track.key,
                    album = resolvedAlbum.takeIf { it.isNotBlank() },
                    artist = resolvedArtist.takeIf { it.isNotBlank() && track.artist.isBlank() },
                    artUrl = resolvedArt.takeIf { it.isNotBlank() && track.artUrl.isBlank() },
                    albumBrowseId = meta.albumBrowseId.takeIf { it.isNotBlank() },
                    trackNumber = meta.trackNumber,
                )
            }
        }
    }

    private fun nextTrackNumberForAlbum(artist: String, album: String): Int {
        val fArtist = fold(artist)
        val fAlbum = fold(album)
        if (fAlbum.isEmpty()) return 1
        val existing = catalog.value.albums.firstOrNull { tile ->
            fold(tile.album.ifBlank { tile.title }) == fAlbum &&
                (fArtist.isEmpty() || fold(tile.artist) == fArtist)
        } ?: return 1
        val maxEp = existing.items.mapNotNull { it.episode }.maxOrNull() ?: existing.items.size
        return (maxEp + 1).coerceIn(1, 999)
    }

    fun saveYtmSongToLibrary(song: YtmSongItem) {
        val initialArtist = song.artist.trim().ifBlank { "YouTube" }
        val cleanTitle = song.title.trim().ifBlank { song.videoId }
        val initialAlbum = song.album.trim()
        val watchUrl = "https://www.youtube.com/watch?v=${song.videoId}"
        val trackKeys = streamSaveLookupKeys("ext:ytm:${song.videoId}", song.videoId, initialArtist, cleanTitle)
        streamingSubmittingKeys.value = streamingSubmittingKeys.value + trackKeys
        notice.value = "Saving $cleanTitle to Music library…"
        scope.launch {
            val needsAlbumResolve = initialAlbum.isBlank() || initialAlbum.equals(cleanTitle, ignoreCase = true)
            val resolvedMeta = if (needsAlbumResolve) {
                withTimeoutOrNull(5_000L) {
                    runCatching {
                        ExternalDiscoveryApi.resolveTrackAlbumMeta(
                            videoId = song.videoId,
                            artist = song.artist,
                            title = cleanTitle,
                            albumBrowseId = song.albumBrowseId,
                        )
                    }.getOrNull()
                }
            } else {
                null
            }
            val cleanArtist = resolvedMeta?.artist?.trim()?.takeIf { it.isNotBlank() && song.artist.isBlank() }
                ?: initialArtist
            val cleanAlbum = resolvedMeta?.album?.trim()?.takeIf { it.isNotBlank() }
                ?: initialAlbum.ifBlank { cleanTitle }
            val year = resolvedMeta?.year?.trim()?.takeIf { it.length == 4 }
            val bestArtUrl = song.artUrl.trim().ifBlank { resolvedMeta?.artUrl.orEmpty().trim() }
            if (bestArtUrl.isNotBlank()) {
                ExternalDiscoveryApi.rememberAlbumArtUrl(cleanArtist, cleanAlbum, bestArtUrl)
            }
            val trackNumber = resolvedMeta?.trackNumber?.takeIf { it > 0 }
                ?: nextTrackNumberForAlbum(cleanArtist, cleanAlbum)
            if (status.value?.apiUrl.isNullOrBlank()) {
                withTimeoutOrNull(4_000L) {
                    status.first { !it?.apiUrl.isNullOrBlank() }
                }
            }
            if (!status.value?.apiUrl.isNullOrBlank() && song.videoId.length == 11) {
                loopbackApi.mirrorYouTube(
                    artist = cleanArtist,
                    album = cleanAlbum,
                    year = year,
                    tracks = listOf(YouTubeTrackInput(videoId = song.videoId, title = cleanTitle, track = trackNumber, disc = 1)),
                ).fold(
                    onSuccess = { job ->
                        bindStreamingSaveJob(trackKeys, job)
                        recordSubmittedJob(job)
                        notice.value = "Saving $cleanTitle to Music library…"
                    },
                    onFailure = {
                        acquireMusicUrlDirectly(watchUrl, cleanTitle, cleanArtist, cleanAlbum, trackKeys)
                    },
                )
            } else {
                acquireMusicUrlDirectly(watchUrl, cleanTitle, cleanArtist, cleanAlbum, trackKeys)
            }
        }
    }

    fun saveYtmAlbumToLibrary(album: YtmAlbumPage) {
        if (album.tracks.isEmpty()) return
        val cleanArtist = album.artist.trim().ifBlank { "YouTube" }
        val cleanAlbum = album.title.trim().ifBlank { "Album" }
        if (album.artUrl.isNotBlank()) {
            ExternalDiscoveryApi.rememberAlbumArtUrl(cleanArtist, cleanAlbum, album.artUrl)
        }
        val trackInputs = album.tracks.mapIndexed { idx, t ->
            YouTubeTrackInput(videoId = t.videoId, title = t.title, track = idx + 1, disc = 1)
        }
        notice.value = "Saving $cleanAlbum (${trackInputs.size} tracks) to Music library…"
        scope.launch {
            if (status.value?.apiUrl.isNullOrBlank()) {
                withTimeoutOrNull(4_000L) {
                    status.first { !it?.apiUrl.isNullOrBlank() }
                }
            }
            loopbackApi.mirrorYouTube(
                artist = cleanArtist,
                album = cleanAlbum,
                year = album.year.takeIf { it.isNotBlank() },
                tracks = trackInputs,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Saving $cleanAlbum to Music library…"
                },
                onFailure = {
                    // Fallback to direct music acquire per track if relay YouTube mirror isn't enabled.
                    album.tracks.forEach { t ->
                        acquireMusicUrlDirectly(
                            url = "https://www.youtube.com/watch?v=${t.videoId}",
                            title = t.title,
                            artist = t.artist.ifBlank { cleanArtist },
                            album = cleanAlbum,
                        )
                    }
                },
            )
        }
    }

    fun streamFullSong(
        id: String,
        title: String,
        artist: String,
        album: String = "",
        artUrl: String = "",
        videoId: String? = null,
        sourceLabel: String = "Streaming",
    ) {
        val extKey = "ext:$id"
        if (music.state.value.currentTrack?.key == extKey) {
            music.togglePlayPause()
            return
        }
        externalStreamResolveJob?.cancel()
        val cleanTitle = title.trim().ifBlank { "Audio stream" }
        val cleanArtist = artist.trim()
        val cleanAlbum = album.trim()
        val cleanSource = sourceLabel.trim().ifBlank { "Streaming" }
        if (cleanAlbum.isNotBlank() && artUrl.isNotBlank()) {
            ExternalDiscoveryApi.rememberAlbumArtUrl(cleanArtist, cleanAlbum, artUrl)
        }
        val seed = sleeveHash("$cleanArtist|$cleanAlbum|$cleanTitle|$id")
        val hue = ((seed % 360L).toInt() + 360) % 360
        val placeholderEntry = Entry(
            key = extKey,
            id = extKey,
            title = cleanTitle,
            size = 0L,
            sha256 = "",
            local = false,
            streamUrl = "",
            music = MusicMeta(
                title = cleanTitle,
                artist = cleanArtist.takeIf { it.isNotBlank() },
            ),
        )
        val placeholder = TrackItem(
            entry = placeholderEntry,
            title = cleanTitle,
            artist = cleanArtist,
            album = cleanAlbum,
            albumKey = "",
            hue = hue,
            seed = seed,
            artUrl = artUrl,
            externalStreamSource = cleanSource,
            externalSaveKind = "youtube",
            externalVideoId = videoId?.trim().orEmpty(),
        )
        music.showExternalResolving(placeholder)
        externalStreamResolveJob = scope.launch {
            val resolved = if (!videoId.isNullOrBlank()) {
                ExternalDiscoveryApi.resolveYouTubeAudioStream(videoId.trim())
            } else {
                ExternalDiscoveryApi.resolveFullSongStream(cleanArtist, cleanTitle)
            }
            ensureActive()
            val activeState = music.state.value
            if (activeState.currentTrack?.key != extKey || !activeState.playing) return@launch
            if (resolved != null) {
                val finalEntry = placeholderEntry.copy(streamUrl = resolved.streamUrl)
                val finalTrack = placeholder.copy(
                    entry = finalEntry,
                    streamUserAgent = resolved.userAgent,
                    externalStreamSource = cleanSource,
                    externalSaveUrl = resolved.watchUrl,
                    externalSaveKind = "youtube",
                    externalVideoId = resolved.videoId,
                )
                music.playTrackList(listOf(finalTrack), 0, cleanSource, shuffleOn = false)
                if (cleanAlbum.isBlank()) {
                    enrichStreamingTrackAlbum(finalTrack)
                }
            } else {
                music.stopMusic()
                notice.value = "Could not load full stream for $cleanTitle"
            }
        }
    }

    private fun bindStreamingSaveJob(trackKeys: Set<String>, job: AcquireJob) {
        streamingSubmittingKeys.value = streamingSubmittingKeys.value - trackKeys
        if (job.isDone) {
            streamingSavedKeys.value = streamingSavedKeys.value + trackKeys
            streamingSaveJobs.value = streamingSaveJobs.value - trackKeys
        } else if (!job.isFailed) {
            streamingSaveJobs.value = streamingSaveJobs.value + trackKeys.associateWith { job.jobId }
        }
    }

    fun saveStreamingTrackToLibrary(track: TrackItem) {
        val videoId = track.externalVideoId.trim()
        val saveUrl = track.externalSaveUrl?.trim()?.takeIf { it.isNotBlank() }
        val initialArtist = track.artist.trim().ifBlank { "YouTube" }
        val initialAlbum = track.album.trim()
        val cleanTitle = track.title.trim().ifBlank { videoId.ifBlank { "Track" } }
        val trackKeys = streamSaveLookupKeys(track.key, videoId, initialArtist, cleanTitle)
        val currentState = resolveStreamSaveState(
            track = track,
            catalog = catalog.value,
            jobs = acquireJobs.value,
            saveJobMap = streamingSaveJobs.value,
            submittingKeys = streamingSubmittingKeys.value,
            savedKeys = streamingSavedKeys.value,
        )
        if (currentState != StreamSaveState.Unsaved) return

        if (videoId.isNotBlank()) {
            streamingSubmittingKeys.value = streamingSubmittingKeys.value + trackKeys
            notice.value = "Saving $cleanTitle to Music library…"
            scope.launch {
                val needsAlbumResolve = initialAlbum.isBlank() ||
                    initialAlbum.equals(cleanTitle, ignoreCase = true) ||
                    track.artUrl.isBlank()
                val resolvedMeta = if (needsAlbumResolve) {
                    withTimeoutOrNull(5_000L) {
                        runCatching {
                            ExternalDiscoveryApi.resolveTrackAlbumMeta(
                                videoId = videoId,
                                artist = track.artist,
                                title = cleanTitle,
                                albumBrowseId = track.albumBrowseId,
                            )
                        }.getOrNull()
                    }
                } else {
                    null
                }
                val cleanArtist = resolvedMeta?.artist?.trim()?.takeIf { it.isNotBlank() && track.artist.isBlank() }
                    ?: initialArtist
                val cleanAlbum = when {
                    initialAlbum.isNotBlank() && !initialAlbum.equals(cleanTitle, ignoreCase = true) -> initialAlbum
                    !resolvedMeta?.album.isNullOrBlank() -> resolvedMeta?.album.orEmpty().trim()
                    initialAlbum.isNotBlank() -> initialAlbum
                    else -> cleanTitle
                }
                val year = resolvedMeta?.year?.trim()?.takeIf { it.length == 4 }
                val bestArtUrl = track.artUrl.trim().ifBlank { resolvedMeta?.artUrl.orEmpty().trim() }
                if (bestArtUrl.isNotBlank()) {
                    ExternalDiscoveryApi.rememberAlbumArtUrl(cleanArtist, cleanAlbum, bestArtUrl)
                }
                if (cleanAlbum != track.album || bestArtUrl != track.artUrl) {
                    music.updateTrackMetadata(
                        trackKey = track.key,
                        album = cleanAlbum,
                        artist = cleanArtist.takeIf { track.artist.isBlank() },
                        artUrl = bestArtUrl.takeIf { it.isNotBlank() },
                        albumBrowseId = resolvedMeta?.albumBrowseId?.takeIf { it.isNotBlank() },
                        trackNumber = resolvedMeta?.trackNumber,
                    )
                }
                val resolvedTrackNo = track.track?.takeIf { it > 0 }
                    ?: resolvedMeta?.trackNumber?.takeIf { it > 0 }
                    ?: nextTrackNumberForAlbum(cleanArtist, cleanAlbum)
                val resolvedDisc = track.disc?.takeIf { it > 0 } ?: 1
                if (status.value?.apiUrl.isNullOrBlank()) {
                    withTimeoutOrNull(4_000L) {
                        status.first { !it?.apiUrl.isNullOrBlank() }
                    }
                }
                if (status.value?.apiUrl.isNullOrBlank()) {
                    if (saveUrl != null) {
                        acquireMusicUrlDirectly(
                            url = saveUrl,
                            title = cleanTitle,
                            artist = cleanArtist,
                            album = cleanAlbum,
                            trackKeys = trackKeys,
                        )
                    } else {
                        streamingSubmittingKeys.value = streamingSubmittingKeys.value - trackKeys
                        openSearchForStreamingTrack(track)
                    }
                    return@launch
                }
                loopbackApi.mirrorYouTube(
                    artist = cleanArtist,
                    album = cleanAlbum,
                    year = year,
                    tracks = listOf(
                        YouTubeTrackInput(
                            videoId = videoId,
                            title = cleanTitle,
                            track = resolvedTrackNo,
                            disc = resolvedDisc,
                        ),
                    ),
                ).fold(
                    onSuccess = { job ->
                        bindStreamingSaveJob(trackKeys, job)
                        recordSubmittedJob(job)
                        notice.value = "Saving $cleanTitle to Music library…"
                    },
                    onFailure = {
                        if (saveUrl != null) {
                            acquireMusicUrlDirectly(
                                url = saveUrl,
                                title = cleanTitle,
                                artist = cleanArtist,
                                album = cleanAlbum,
                                trackKeys = trackKeys,
                            )
                        } else {
                            streamingSubmittingKeys.value = streamingSubmittingKeys.value - trackKeys
                            openSearchForStreamingTrack(track)
                        }
                    },
                )
            }
        } else if (saveUrl != null) {
            streamingSubmittingKeys.value = streamingSubmittingKeys.value + trackKeys
            val cleanAlbum = initialAlbum.ifBlank { cleanTitle }
            if (track.artUrl.isNotBlank()) {
                ExternalDiscoveryApi.rememberAlbumArtUrl(initialArtist, cleanAlbum, track.artUrl)
            }
            acquireMusicUrlDirectly(
                url = saveUrl,
                title = cleanTitle,
                artist = initialArtist,
                album = cleanAlbum,
                trackKeys = trackKeys,
            )
        } else {
            openSearchForStreamingTrack(track)
        }
    }

    private fun acquireMusicUrlDirectly(
        url: String,
        title: String,
        artist: String,
        album: String,
        trackKeys: Set<String> = emptySet(),
    ) {
        val cleanUrl = url.trim()
        if (cleanUrl.isBlank()) {
            if (trackKeys.isNotEmpty()) streamingSubmittingKeys.value = streamingSubmittingKeys.value - trackKeys
            return
        }
        val cleanTitle = title.trim().ifBlank { "Track" }
        val cleanArtist = artist.trim()
        val cleanAlbum = album.trim().ifBlank { cleanTitle }
        scope.launch {
            if (status.value?.apiUrl.isNullOrBlank()) {
                withTimeoutOrNull(12_000L) {
                    status.first { !it?.apiUrl.isNullOrBlank() }
                }
            }
            val musicId = normalizeAcquireId("", cleanAlbum, cleanArtist, cleanUrl, audio = true)
            loopbackApi.acquire(
                id = musicId,
                title = cleanAlbum,
                url = cleanUrl,
                page = true,
                audio = true,
                music = MusicMeta(
                    title = cleanTitle,
                    artist = cleanArtist.takeIf { it.isNotBlank() },
                ),
            ).fold(
                onSuccess = { job ->
                    if (trackKeys.isNotEmpty()) bindStreamingSaveJob(trackKeys, job)
                    recordSubmittedJob(job)
                    notice.value = "Saving $cleanTitle to Music library…"
                },
                onFailure = { err ->
                    if (trackKeys.isNotEmpty()) streamingSubmittingKeys.value = streamingSubmittingKeys.value - trackKeys
                    error.value = err.message ?: "Could not save $cleanTitle to Music library."
                },
            )
        }
    }

    private fun openSearchForStreamingTrack(track: TrackItem) {
        closeMusicPlayer()
        if (screen.value is Screen.MusicPlayerFull) {
            popScreen()
        }
        val queryText = listOf(track.artist, track.title)
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .ifBlank { track.album }
        if (queryText.isNotBlank()) {
            openSearchFor(queryText, askRelays = true)
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
                    if (st.session != null && isCastSessionLive(st.session)) {
                        handleCastStatusUpdate(st)
                    }
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
        val session = cast.value.session ?: lastCastSession.value ?: return
        val entry = entries.value.firstOrNull { it.key == session.state.entry?.key } ?: return
        recordWatchProgress(entry, session.state.positionMs, session.state.durationMs)
        selectedCastReceiver.value = null
        stopCasting()
        showTvsDialog.value = false
        openVideo(entry)
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
        val initial = settings.value
        _metaSourcesState.value = MetaSourcesState(
            sources = initial.metaSources.mapNotNull { rawKey ->
                val cleanKey = rawKey.trim()
                if (cleanKey.isEmpty()) return@mapNotNull null
                MetaSourceInfo(
                    key = cleanKey,
                    uri = if (cleanKey.startsWith("peartube://", ignoreCase = true)) cleanKey else "peartube://meta/$cleanKey",
                )
            },
            p2pOnlyMetadata = initial.p2pOnlyMetadata,
            seedFullMetadata = initial.seedFullMetadata,
        )
        ExternalDiscoveryApi.configureLocalMeta(
            apiBaseUrl = null,
            failClosed = initial.privateRouting || initial.p2pOnlyMetadata,
        )
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
                        handleCastStatusUpdate(event.status)
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
                syncLocalMetaConfig()
                if (apiUrl != null && apiUrl != lastLoadedApiUrl) {
                    lastLoadedApiUrl = apiUrl
                    refreshAcquireJobs()
                    refreshPlugins()
                    refreshSoulseekSettings()
                    refreshMetaSources()
                    if (currentRoom.value == Room.Discover) {
                        loadDiscoverCreators(autoLoadFeed = discoverActiveTopic.value == null)
                    }
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
        scope.launch {
            while (true) {
                screen.first { it is Screen.Network }
                while (screen.value is Screen.Network) {
                    if (inForeground) {
                        runCatching { worker.status() }.onSuccess { recordStatus(it) }
                    }
                    delay(1_500L)
                }
            }
        }
        scope.launch {
            musicState.collect { ms ->
                if (ms.playing) {
                    musicSessionActive = true
                } else if (!ms.hasQueue) {
                    musicSessionActive = false
                }
                syncMediaService()
            }
        }
        starts.trySend(settings.value)
        registerNetworkRecoveryCallback()
    }

    private fun registerNetworkRecoveryCallback() {
        runCatching {
            val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch {
                        if (!status.value?.apiUrl.isNullOrBlank()) {
                            loopbackApi.resumeJobs()
                            refreshAcquireJobs()
                        }
                        verifyOrReattachCast()
                    }
                }
            })
        }
    }

    fun onForeground() {
        inForeground = true
        applyBackgroundPolicy(forceResume = true)
        scope.launch {
            if (!status.value?.apiUrl.isNullOrBlank()) {
                loopbackApi.resumeJobs()
                refreshAcquireJobs()
            }
            verifyOrReattachCast()
        }
    }

    /** Storage contribution: persisted, then applied to the live worklet. */
    fun setCacheLimit(gb: Int) {
        val next = settings.value.copy(cacheMaxGb = gb)
        runCatching { next.save(dataDir) }
        settings.value = next
        scope.launch { runCatching { worker.setCacheMax(gb.toLong() * 1_000_000_000L) } }
    }

    fun save(next: Settings) {
        val privacyChanged = settings.value.privateRouting != next.privateRouting ||
            settings.value.p2pOnlyMetadata != next.p2pOnlyMetadata
        next.save(dataDir)
        settings.value = next
        _metaSourcesState.value = _metaSourcesState.value.copy(
            p2pOnlyMetadata = next.p2pOnlyMetadata,
            seedFullMetadata = next.seedFullMetadata,
        )
        status.value = null
        lastLoadedApiUrl = null
        if (privacyChanged) {
            cinemaDiscoverCache.clear()
        }
        syncLocalMetaConfig()
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
        isCastSessionLive(cast.value.session) ||
            (castReconnecting.value && System.currentTimeMillis() < castReconnectUntilMs) ||
            musicState.value.playing ||
            (activeVideo.value != null && videoMode.value != VideoDisplayMode.Closed) ||
            downloads.value.isNotEmpty() ||
            acquireJobs.value.any { it.isActive } ||
            System.currentTimeMillis() < backgroundSyncUntil

    // The one rule for the background: in front, or behind with a cast, active music, a download or
    // the sync window open, the worklet runs and both locks are held; otherwise both stop.
    // While any download or acquire/Soulseek job is active, keep a dataSync Foreground Service
    // running; while playing media or casting to a TV, keep MediaPlaybackService in foreground
    // so Android's Cached App Freezer does not freeze sockets with the screen off.
    @Synchronized
    fun applyBackgroundPolicy(forceResume: Boolean = false) {
        if (inForeground || shouldKeepWorkerAwake()) {
            multicastLock.acquire()
            wifiLock.acquire()
            if (workerSuspended || forceResume) {
                workerSuspended = false
                worker.resume()
            }
        } else {
            if (!workerSuspended) {
                workerSuspended = true
                worker.suspend()
            }
            if (wifiLock.isHeld) wifiLock.release()
            if (multicastLock.isHeld) multicastLock.release()
        }
        TransferService.sync(app, acquireJobs.value, downloads.value)
        MediaPlaybackService.sync(app, currentMediaSnapshot())
    }

    private fun clearStickyCast(cancelJob: Boolean = true) {
        stickyCastReceiverId = null
        lastCastSession.value = null
        castReconnecting.value = false
        castReconnectUntilMs = 0L
        if (cancelJob) {
            castReconnectJob?.cancel()
            castReconnectJob = null
        }
    }

    private fun markCastConnected(session: CastSession) {
        stickyCastReceiverId = session.receiverId
        lastCastSession.value = session
        castReconnecting.value = false
        castReconnectUntilMs = 0L
        castReconnectJob?.cancel()
        castReconnectJob = null
    }

    private fun handleCastStatusUpdate(status: CastStatus) {
        cast.value = status
        val session = status.session
        if (session != null) {
            if (isCastSessionLive(session)) {
                markCastConnected(session)
            } else {
                clearStickyCast()
            }
        } else {
            val targetId = stickyCastReceiverId
            if (targetId != null) {
                scheduleCastReconnect(targetId)
            }
        }
        applyBackgroundPolicy()
    }

    private fun scheduleCastReconnect(receiverId: String, immediate: Boolean = false) {
        castReconnectUntilMs = System.currentTimeMillis() + castReconnectWindowMs
        castReconnecting.value = true
        if (castReconnectJob?.isActive == true) {
            if (!immediate) return
            castReconnectJob?.cancel()
            castReconnectJob = null
        }
        castReconnectJob = scope.launch {
            // Give the engine's own immediate on_close reattach a beat before issuing another attach.
            if (!immediate) delay(1_500L)
            var attempt = 0
            while (stickyCastReceiverId == receiverId &&
                cast.value.session == null &&
                System.currentTimeMillis() < castReconnectUntilMs
            ) {
                val cur = runCatching { worker.castStatus() }.getOrNull()
                if (cur?.session != null) {
                    handleCastStatusUpdate(cur)
                    return@launch
                }
                val attached = runCatching { worker.castAttach(receiverId) }.getOrNull()
                val attachedSession = attached?.session
                if (attached != null && attachedSession != null) {
                    if (isCastSessionLive(attachedSession)) {
                        handleCastStatusUpdate(attached)
                    } else {
                        runCatching { worker.castStop(false) }
                        clearStickyCast(cancelJob = false)
                        cast.value = attached.copy(session = null)
                        applyBackgroundPolicy()
                    }
                    return@launch
                }
                delay(nextCastReconnectDelayMs(attempt))
                attempt++
            }
            if (cast.value.session == null) {
                castReconnecting.value = false
                castReconnectUntilMs = 0L
                applyBackgroundPolicy()
            }
        }
    }

    private suspend fun verifyOrReattachCast() {
        val liveSession = cast.value.session
        if (liveSession != null) {
            if (!isCastSessionLive(liveSession)) return
            val probed = runCatching { worker.castControl(JSONObject().put("action", "status")) }
            probed
                .onSuccess { handleCastStatusUpdate(it) }
                .onFailure {
                    if (stickyCastReceiverId == liveSession.receiverId) {
                        scheduleCastReconnect(liveSession.receiverId, immediate = true)
                    }
                }
            return
        }
        val stickyId = stickyCastReceiverId
        if (stickyId != null) {
            scheduleCastReconnect(stickyId, immediate = true)
            applyBackgroundPolicy()
            return
        }
        val selectedId = selectedCastReceiver.value?.id ?: return
        runCatching { worker.castAttach(selectedId) }.onSuccess { st ->
            if (st.session != null && isCastSessionLive(st.session)) {
                handleCastStatusUpdate(st)
            }
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
        if (trimmed.startsWith("peartube://meta/", ignoreCase = true)) {
            addMetaSource(trimmed)
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
                    val isAudioTrack = !entry.id.startsWith("imdb:") && (
                        entry.season != null ||
                            entry.music != null ||
                            entry.id.startsWith("yt:") ||
                            entry.id.startsWith("sc:") ||
                            entry.id.startsWith("album:") ||
                            entry.id.startsWith("mb:") ||
                            entry.id.startsWith("discogs:")
                        )
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
        recordRecentSearch(q)
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
            runCatching { worker.castStatus() }.onSuccess { handleCastStatusUpdate(it) }.onFailure { error.value = it.message }
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
        if (stickyCastReceiverId == id) clearStickyCast()
        scope.launch {
            runCatching { worker.castRemove(id) }.onSuccess {
                cast.value = it
                applyBackgroundPolicy()
            }
        }
    }

    fun castToReceiver(receiverId: String, key: String, preferMode: String = "auto", startPositionMs: Long = 0L) {
        castReconnectJob?.cancel()
        castReconnectJob = null
        castReconnecting.value = false
        stickyCastReceiverId = receiverId
        scope.launch {
            try {
                val result = worker.castPlay(receiverId, key, preferMode, startPositionMs)
                result.receivers.firstOrNull { it.id == receiverId }?.let { selectedCastReceiver.value = it }
                handleCastStatusUpdate(result)
                pendingCast.value = null
                showTvsDialog.value = false
                if (activeVideo.value != null || screen.value is Screen.Play) closeVideo()
            } catch (e: Exception) {
                if (cast.value.session == null && lastCastSession.value == null) {
                    clearStickyCast()
                    applyBackgroundPolicy()
                }
                error.value = e.message
            }
        }
    }

    fun sendCastControl(params: JSONObject) {
        scope.launch {
            val first = runCatching { worker.castControl(params) }
            if (first.isSuccess) {
                first.getOrNull()?.let { handleCastStatusUpdate(it) }
                return@launch
            }
            val targetId = cast.value.session?.receiverId ?: stickyCastReceiverId ?: selectedCastReceiver.value?.id
            if (targetId != null) {
                val retried = runCatching {
                    worker.castAttach(targetId)
                    worker.castControl(params)
                }
                if (retried.isSuccess) {
                    retried.getOrNull()?.let { handleCastStatusUpdate(it) }
                    return@launch
                }
                error.value = retried.exceptionOrNull()?.message ?: first.exceptionOrNull()?.message
            } else {
                error.value = first.exceptionOrNull()?.message
            }
        }
    }

    fun stopCasting() {
        selectedCastReceiver.value = null
        clearStickyCast()
        applyBackgroundPolicy()
        scope.launch {
            runCatching { worker.castStop(true) }.onSuccess {
                cast.value = it
                applyBackgroundPolicy()
            }
        }
    }

    fun detachCasting() {
        selectedCastReceiver.value = null
        clearStickyCast()
        applyBackgroundPolicy()
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
        val targetUrl = when {
            addTarget != null -> addTarget
            extracted.startsWith("http://", ignoreCase = true) || extracted.startsWith("https://", ignoreCase = true) -> extracted
            else -> null
        }
        if (targetUrl != null) {
            if (shareImportMode.value == ShareImportMode.Auto) {
                autoAcquireSharedUrl(targetUrl)
            } else {
                openAddSheet(prefillUrl = targetUrl, autoIdentify = true)
            }
        } else {
            openUriOrKey(extracted)
        }
    }

    fun autoAcquireSharedUrl(url: String) {
        val cleanUrl = url.trim()
        if (!cleanUrl.startsWith("http://", ignoreCase = true) && !cleanUrl.startsWith("https://", ignoreCase = true)) {
            openAddSheet(prefillUrl = cleanUrl, autoIdentify = false)
            return
        }
        notice.value = "Inspecting link…"
        scope.launch {
            if (status.value?.apiUrl.isNullOrBlank()) {
                withTimeoutOrNull(12_000L) {
                    status.first { !it?.apiUrl.isNullOrBlank() }
                }
            }
            val identified = loopbackApi.identify(cleanUrl)
            identified.fold(
                onSuccess = { info ->
                    val plan = classifyLinkAcquisition(cleanUrl, info, podcastImportFormat.value)
                    val music = if (plan.audioOnly) {
                        MusicMeta(
                            title = plan.title.takeIf { it.isNotBlank() },
                            artist = plan.artist.takeIf { it.isNotBlank() },
                        )
                    } else {
                        null
                    }
                    val announceTitle = if (plan.audioOnly) plan.album.ifBlank { plan.title } else plan.title
                    loopbackApi.acquire(
                        id = normalizeAcquireId(info.effectiveId, announceTitle, plan.artist, cleanUrl, plan.audioOnly),
                        title = announceTitle,
                        url = cleanUrl,
                        page = info.isPage,
                        audio = plan.audioOnly,
                        music = music,
                    ).fold(
                        onSuccess = { job ->
                            recordSubmittedJob(job)
                            notice.value = null
                            showAutoAcquireBanner(
                                AutoAcquireBanner(
                                    jobId = job.jobId,
                                    url = cleanUrl,
                                    info = info,
                                    plan = plan,
                                ),
                            )
                        },
                        onFailure = { err ->
                            notice.value = null
                            addSheet.value = AddSheetState(
                                rawInput = cleanUrl,
                                identified = info,
                                detectedKind = plan.kind,
                                titleInput = plan.title,
                                artistInput = plan.artist,
                                audioOnly = plan.audioOnly,
                                submitError = err.message ?: "Could not start download.",
                            )
                            showAddSheet.value = true
                            refreshAcquireJobs()
                        },
                    )
                },
                onFailure = { err ->
                    notice.value = null
                    addSheet.value = AddSheetState(
                        rawInput = cleanUrl,
                        identifyError = err.message ?: "Could not identify that link.",
                    )
                    showAddSheet.value = true
                    refreshAcquireJobs()
                },
            )
        }
    }

    fun flipAutoAcquireFormat() {
        val banner = autoAcquireBanner.value ?: return
        val flippedAudio = !banner.plan.audioOnly
        val flippedKind = when {
            flippedAudio && banner.plan.kind == DetectedMediaKind.Video -> DetectedMediaKind.Music
            !flippedAudio && banner.plan.kind == DetectedMediaKind.Music -> DetectedMediaKind.Video
            else -> banner.plan.kind
        }
        val flippedPlan = banner.plan.copy(
            kind = flippedKind,
            audioOnly = flippedAudio,
            reason = if (flippedAudio) "Switched to audio" else "Switched to video",
        )
        autoAcquireBannerJob?.cancel()
        scope.launch {
            loopbackApi.cancelJob(banner.jobId)
            acquireJobs.value = acquireJobs.value.filterNot { it.jobId == banner.jobId }
            previousActiveJobIds = previousActiveJobIds - banner.jobId
            val music = if (flippedPlan.audioOnly) {
                MusicMeta(
                    title = flippedPlan.title.takeIf { it.isNotBlank() },
                    artist = flippedPlan.artist.takeIf { it.isNotBlank() },
                )
            } else {
                null
            }
            loopbackApi.acquire(
                id = normalizeAcquireId(banner.info.effectiveId, flippedPlan.title, flippedPlan.artist, banner.url, flippedPlan.audioOnly),
                title = flippedPlan.title,
                url = banner.url,
                page = banner.info.isPage,
                audio = flippedPlan.audioOnly,
                music = music,
            ).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    showAutoAcquireBanner(banner.copy(jobId = job.jobId, plan = flippedPlan))
                },
                onFailure = { err ->
                    dismissAutoAcquireBanner()
                    addSheet.value = AddSheetState(
                        rawInput = banner.url,
                        identified = banner.info,
                        detectedKind = flippedPlan.kind,
                        titleInput = flippedPlan.title,
                        artistInput = flippedPlan.artist,
                        audioOnly = flippedPlan.audioOnly,
                        submitError = err.message ?: "Could not switch format.",
                    )
                    showAddSheet.value = true
                    refreshAcquireJobs()
                },
            )
        }
    }

    fun editAutoAcquire() {
        val banner = autoAcquireBanner.value ?: return
        dismissAutoAcquireBanner()
        scope.launch {
            loopbackApi.cancelJob(banner.jobId)
            acquireJobs.value = acquireJobs.value.filterNot { it.jobId == banner.jobId }
            previousActiveJobIds = previousActiveJobIds - banner.jobId
            applyBackgroundPolicy()
            refreshAcquireJobs()
        }
        addSheet.value = AddSheetState(
            rawInput = banner.url,
            identified = banner.info,
            detectedKind = banner.plan.kind,
            titleInput = banner.plan.title,
            artistInput = banner.plan.artist,
            audioOnly = banner.plan.audioOnly,
        )
        showAddSheet.value = true
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
                detectedKind = null,
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
            detectedKind = null,
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
                    val plan = classifyLinkAcquisition(url, info, podcastImportFormat.value)
                    addSheet.value = addSheet.value.copy(
                        identifying = false,
                        identified = info,
                        detectedKind = plan.kind,
                        identifyError = null,
                        titleInput = plan.title,
                        artistInput = plan.artist,
                        audioOnly = plan.audioOnly,
                    )
                },
                onFailure = { err ->
                    addSheet.value = addSheet.value.copy(
                        identifying = false,
                        identified = null,
                        detectedKind = null,
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
        val id = normalizeAcquireId(
            rawId = identified?.effectiveId?.takeIf { it.isNotBlank() } ?: "",
            title = title,
            artist = artist,
            url = url,
            audio = state.audioOnly,
        )
        val page = identified?.isPage ?: true
        val audio = state.audioOnly
        val music = if (audio) {
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

    private fun scheduleCatalogRefreshBurst() {
        refreshes.trySend(Unit)
        catalogRefreshBurstJob?.cancel()
        catalogRefreshBurstJob = scope.launch {
            delay(1_500L)
            refreshes.trySend(Unit)
            delay(2_500L)
            refreshes.trySend(Unit)
        }
    }

    private fun recordSubmittedJob(job: AcquireJob) {
        val current = acquireJobs.value.filterNot { it.jobId == job.jobId }
        acquireJobs.value = listOf(job) + current
        if (job.isActive) {
            previousActiveJobIds = previousActiveJobIds + job.jobId
        } else if (job.isDone) {
            scheduleCatalogRefreshBurst()
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
                val jobsById = jobs.associateBy { it.jobId }
                val trackedSaves = streamingSaveJobs.value
                if (trackedSaves.isNotEmpty()) {
                    val remaining = LinkedHashMap<String, String>(trackedSaves.size)
                    val newlySavedKeys = HashSet<String>()
                    for ((trackKey, jobId) in trackedSaves) {
                        val job = jobsById[jobId]
                        when {
                            job == null && jobId in vanishedDone -> newlySavedKeys.add(trackKey)
                            job == null -> Unit
                            job.isDone -> newlySavedKeys.add(trackKey)
                            job.isFailed -> Unit
                            else -> remaining[trackKey] = jobId
                        }
                    }
                    if (newlySavedKeys.isNotEmpty()) {
                        streamingSavedKeys.value = streamingSavedKeys.value + newlySavedKeys
                    }
                    if (remaining.size != trackedSaves.size) {
                        streamingSaveJobs.value = remaining
                    }
                }
                if (newlyCompleted.isNotEmpty() || vanishedDone.isNotEmpty()) {
                    scheduleCatalogRefreshBurst()
                    newlyCompleted.firstOrNull()?.let { done ->
                        notice.value = "Saved ${done.title.ifBlank { "track" }} in library"
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

    fun retryJob(jobId: String) {
        scope.launch {
            loopbackApi.retryJob(jobId).fold(
                onSuccess = { job ->
                    recordSubmittedJob(job)
                    notice.value = "Resuming ${job.title.ifBlank { "download" }}…"
                },
                onFailure = { err ->
                    error.value = err.message ?: "Could not retry download."
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
        recordRecentSearch(q)
        searchGlobal(q)
        searchSources(q, selectedSources.value)
    }

    fun searchSources(rawQuery: String, sources: Set<SearchSource> = selectedSources.value) {
        val q = rawQuery.trim()
        if (q.length < 2) return
        recordRecentSearch(q)
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

    private fun syncLocalMetaConfig() {
        val apiUrl = status.value?.apiUrl?.takeIf { it.isNotBlank() }
        val failClosed = settings.value.privateRouting ||
            settings.value.p2pOnlyMetadata ||
            _metaSourcesState.value.p2pOnlyMetadata
        ExternalDiscoveryApi.configureLocalMeta(apiBaseUrl = apiUrl, failClosed = failClosed)
    }

    private suspend fun persistMetaSettings(updated: MetaSourcesState) {
        val next = settings.value.copy(
            metaSources = updated.sources.map { it.key }.filter { it.isNotBlank() },
            p2pOnlyMetadata = updated.p2pOnlyMetadata,
            seedFullMetadata = updated.seedFullMetadata,
        )
        if (next != settings.value) {
            settings.value = next
            withContext(Dispatchers.IO) {
                runCatching { next.save(dataDir) }
            }
        }
    }

    fun refreshMetaSources() {
        if (status.value?.apiUrl.isNullOrBlank()) return
        scope.launch {
            runCatching { loopbackApi.getMetaSources() }
                .onSuccess { loaded ->
                    val prevP2p = _metaSourcesState.value.p2pOnlyMetadata
                    _metaSourcesState.value = loaded
                    metaError.value = null
                    if (prevP2p != loaded.p2pOnlyMetadata) {
                        cinemaDiscoverCache.clear()
                    }
                    syncLocalMetaConfig()
                }
                .onFailure { err ->
                    metaError.value = err.message
                }
        }
    }

    fun addMetaSource(uriOrKey: String, alias: String = "", seedFull: Boolean = false) {
        val clean = uriOrKey.trim()
        if (clean.isEmpty()) {
            metaError.value = "Paste a peartube://meta/… link or 64-hex key."
            return
        }
        metaBusy.value = true
        metaError.value = null
        metaMessage.value = null
        scope.launch {
            runCatching { loopbackApi.addMetaSource(clean, alias = alias, seedFull = seedFull) }
                .onSuccess { updated ->
                    _metaSourcesState.value = updated
                    persistMetaSettings(updated)
                    metaBusy.value = false
                    metaMessage.value = "Added P2P metadata source."
                    cinemaDiscoverCache.clear()
                    syncLocalMetaConfig()
                }
                .onFailure { err ->
                    metaBusy.value = false
                    metaError.value = err.message ?: "Could not add metadata source."
                }
        }
    }

    fun removeMetaSource(key: String) {
        val clean = key.trim()
        if (clean.isEmpty()) return
        metaBusy.value = true
        metaError.value = null
        metaMessage.value = null
        scope.launch {
            runCatching { loopbackApi.removeMetaSource(clean) }
                .onSuccess { updated ->
                    _metaSourcesState.value = updated
                    persistMetaSettings(updated)
                    metaBusy.value = false
                    metaMessage.value = "Removed metadata source."
                    cinemaDiscoverCache.clear()
                    syncLocalMetaConfig()
                }
                .onFailure { err ->
                    metaBusy.value = false
                    metaError.value = err.message ?: "Could not remove metadata source."
                }
        }
    }

    fun setP2pOnlyMetadata(on: Boolean) {
        metaBusy.value = true
        metaError.value = null
        metaMessage.value = null
        scope.launch {
            runCatching { loopbackApi.setMetaToggles(p2pOnlyMetadata = on) }
                .onSuccess { updated ->
                    _metaSourcesState.value = updated
                    persistMetaSettings(updated)
                    metaBusy.value = false
                    metaMessage.value = if (updated.p2pOnlyMetadata) {
                        "Clearnet metadata lookups blocked."
                    } else {
                        "Fallback metadata lookups allowed."
                    }
                    cinemaDiscoverCache.clear()
                    syncLocalMetaConfig()
                }
                .onFailure { err ->
                    metaBusy.value = false
                    metaError.value = err.message ?: "Could not update P2P-only metadata setting."
                }
        }
    }

    fun setSeedFullMetadata(on: Boolean) {
        metaBusy.value = true
        metaError.value = null
        metaMessage.value = null
        scope.launch {
            runCatching { loopbackApi.setMetaToggles(seedFullMetadata = on) }
                .onSuccess { updated ->
                    _metaSourcesState.value = updated
                    persistMetaSettings(updated)
                    metaBusy.value = false
                    metaMessage.value = if (updated.seedFullMetadata) {
                        "Full metadata catalog seeding enabled."
                    } else {
                        "Sparse on-demand metadata mode active."
                    }
                    syncLocalMetaConfig()
                }
                .onFailure { err ->
                    metaBusy.value = false
                    metaError.value = err.message ?: "Could not update metadata seeding setting."
                }
        }
    }

    fun loadDiscoverCreators(autoLoadFeed: Boolean = false) {
        if (status.value?.apiUrl.isNullOrBlank()) return
        scope.launch {
            loopbackApi.listDiscoverCreators().fold(
                onSuccess = { list ->
                    discoverCreators.value = list
                    discoverError.value = null
                    if (autoLoadFeed && list.isNotEmpty()) {
                        loadDiscoverFeed(refresh = false)
                    } else if (list.isEmpty()) {
                        discoverFeed.value = DiscoverFeed()
                    }
                },
                onFailure = { err ->
                    discoverError.value = err.message ?: "Could not load followed creators."
                },
            )
        }
    }

    fun loadDiscoverFeed(refresh: Boolean = false) {
        if (status.value?.apiUrl.isNullOrBlank()) return
        discoverFeedJob?.cancel()
        discoverLoading.value = true
        discoverError.value = null
        val source = discoverSourceFilter.value
        val creatorId = discoverCreatorFilter.value
        discoverFeedJob = scope.launch {
            loopbackApi.getDiscoverFeed(
                source = source,
                creatorId = creatorId,
                refresh = refresh,
                limit = 40,
            ).fold(
                onSuccess = { feed ->
                    discoverFeed.value = feed
                    discoverCreators.value = feed.creators
                    discoverLoading.value = false
                },
                onFailure = { err ->
                    discoverLoading.value = false
                    discoverError.value = err.message ?: "Could not load Discover feed."
                },
            )
        }
    }

    fun followDiscoverCreator(
        input: String,
        name: String? = null,
        source: String? = null,
        channelId: String? = null,
        handle: String? = null,
        onFollowed: (() -> Unit)? = null,
    ) {
        val clean = input.trim()
        if (clean.isEmpty() || discoverFollowBusy.value) return
        discoverFollowBusy.value = true
        discoverError.value = null
        scope.launch {
            loopbackApi.followDiscoverCreator(
                url = clean,
                source = source,
                name = name,
                channelId = channelId,
                handle = handle,
            ).fold(
                onSuccess = { res ->
                    discoverCreators.value = res.creators
                    discoverFollowBusy.value = false
                    val label = res.creator?.displayName?.takeIf { it.isNotBlank() }
                        ?: name?.trim()?.takeIf { it.isNotEmpty() }
                        ?: "creator"
                    notice.value = "Followed $label"
                    onFollowed?.invoke()
                    discoverBrowse.value?.let { current ->
                        val followedUrls = res.creators.map { it.url.lowercase() }.toSet()
                        val followedIds = res.creators.map { it.id }.toSet()
                        val followedKeys = res.creators.map { "${it.source}:${it.name.lowercase()}" }.toSet()
                        discoverBrowse.value = current.copy(
                            creators = current.creators.map { c ->
                                val isNowFollowed = c.id in followedIds ||
                                    c.url.lowercase() in followedUrls ||
                                    "${c.source}:${c.name.lowercase()}" in followedKeys ||
                                    c.url.equals(clean, ignoreCase = true)
                                if (isNowFollowed) c.copy(followed = true) else c
                            },
                        )
                    }
                    if (discoverActiveTopic.value == null) {
                        loadDiscoverFeed(refresh = true)
                    }
                },
                onFailure = { err ->
                    discoverFollowBusy.value = false
                    discoverError.value = err.message ?: "Could not follow creator."
                },
            )
        }
    }

    fun unfollowDiscoverCreator(id: String) {
        val clean = id.trim()
        if (clean.isEmpty()) return
        val unfollowedLabel = discoverCreators.value.firstOrNull { it.id == clean }?.displayName?.takeIf { it.isNotBlank() }
        discoverError.value = null
        scope.launch {
            loopbackApi.unfollowDiscoverCreator(clean).fold(
                onSuccess = { res ->
                    discoverCreators.value = res.creators
                    if (discoverCreatorFilter.value == clean) {
                        discoverCreatorFilter.value = ""
                    }
                    discoverBrowse.value?.let { current ->
                        val followedUrls = res.creators.map { it.url.lowercase() }.toSet()
                        val followedIds = res.creators.map { it.id }.toSet()
                        val followedKeys = res.creators.map { "${it.source}:${it.name.lowercase()}" }.toSet()
                        discoverBrowse.value = current.copy(
                            creators = current.creators.map { c ->
                                val stillFollowed = c.id in followedIds ||
                                    c.url.lowercase() in followedUrls ||
                                    "${c.source}:${c.name.lowercase()}" in followedKeys
                                c.copy(followed = stillFollowed)
                            },
                        )
                    }
                    if (res.creators.isEmpty()) {
                        discoverFeed.value = DiscoverFeed()
                    } else {
                        val cur = discoverFeed.value
                        discoverFeed.value = cur.copy(
                            creators = res.creators,
                            items = cur.items.filterNot { it.creatorId == clean },
                        )
                        if (discoverActiveTopic.value == null) {
                            loadDiscoverFeed(refresh = false)
                        }
                    }
                    notice.value = if (unfollowedLabel != null) "Unfollowed $unfollowedLabel" else "Unfollowed creator"
                },
                onFailure = { err ->
                    discoverError.value = err.message ?: "Could not unfollow creator."
                },
            )
        }
    }

    fun browseDiscoverTopic(query: String) {
        val q = query.trim()
        if (q.isEmpty()) return
        discoverBrowseJob?.cancel()
        discoverActiveTopic.value = q
        discoverLoading.value = true
        discoverError.value = null
        loadExternalVideos(q)
        discoverBrowseJob = scope.launch {
            val res = loopbackApi.browseDiscover(
                query = q,
                sources = listOf("youtube", "soundcloud", "rumble"),
                limit = 12,
            )
            if (discoverActiveTopic.value != q) return@launch
            res.fold(
                onSuccess = { parsed ->
                    discoverBrowse.value = parsed
                    discoverLoading.value = false
                },
                onFailure = { err ->
                    discoverLoading.value = false
                    discoverError.value = err.message ?: "Could not browse \"$q\"."
                },
            )
        }
    }

    fun clearDiscoverBrowse() {
        discoverBrowseJob?.cancel()
        discoverActiveTopic.value = null
        discoverBrowse.value = null
        discoverError.value = null
        discoverLoading.value = false
        if (externalVideosTopic.value != "Featured") {
            loadExternalVideos("Featured")
        }
        if (discoverCreators.value.isNotEmpty()) {
            loadDiscoverFeed(refresh = false)
        }
    }

    fun setDiscoverSourceFilter(source: String) {
        val norm = source.trim().lowercase()
        discoverSourceFilter.value = norm
        val activeCreator = discoverCreatorFilter.value
        if (activeCreator.isNotEmpty() && norm.isNotEmpty()) {
            val match = discoverCreators.value.firstOrNull { it.id == activeCreator }
            if (match != null && match.source != norm) {
                discoverCreatorFilter.value = ""
            }
        }
        if (discoverActiveTopic.value == null && discoverCreators.value.isNotEmpty()) {
            loadDiscoverFeed(refresh = false)
        }
    }

    fun setDiscoverCreatorFilter(creatorId: String) {
        val clean = creatorId.trim()
        discoverCreatorFilter.value = clean
        if (discoverActiveTopic.value != null) {
            discoverBrowseJob?.cancel()
            discoverActiveTopic.value = null
            discoverBrowse.value = null
        }
        if (discoverCreators.value.isNotEmpty()) {
            loadDiscoverFeed(refresh = false)
        }
    }

    fun addDiscoverItemToLibrary(item: DiscoverItem, audioOverride: Boolean? = null) {
        if (item.url.isBlank()) return
        val audio = audioOverride ?: item.audioOnly
        val music = if (audio) {
            item.music ?: MusicMeta(
                title = item.title.takeIf { it.isNotBlank() },
                artist = item.creatorName.takeIf { it.isNotBlank() },
            )
        } else {
            null
        }
        discoverSubmittingIds.value = discoverSubmittingIds.value + item.id
        scope.launch {
            try {
                loopbackApi.acquire(
                    id = normalizeAcquireId(item.acquireId, item.title, item.creatorName, item.url, audio),
                    title = item.title,
                    url = item.url,
                    page = true,
                    audio = audio,
                    music = music,
                ).fold(
                    onSuccess = { job ->
                        recordSubmittedJob(job)
                        notice.value = if (audio) "Saving audio for ${item.title}…" else "Saving ${item.title}…"
                    },
                    onFailure = { err ->
                        error.value = err.message ?: "Could not add ${item.title} to PearTube."
                    },
                )
            } finally {
                discoverSubmittingIds.value = discoverSubmittingIds.value - item.id
            }
        }
    }

    fun setDiscoverTab(tab: DiscoverTab) {
        if (discoverTab.value == tab) return
        if (tab != DiscoverTab.Music) {
            previewPlayer.stop()
        }
        discoverTab.value = tab
        if ((tab == DiscoverTab.Music || tab == DiscoverTab.All) && musicDiscoverData.value == null && !musicDiscoverLoading.value) {
            loadMusicDiscover(musicDiscoverMood.value, musicDiscoverQuery.value)
        }
        if ((tab == DiscoverTab.Cinema || tab == DiscoverTab.All) && cinemaDiscoverData.value == null && !cinemaDiscoverLoading.value) {
            loadCinemaDiscover(cinemaDiscoverGenre.value)
        }
        if (tab == DiscoverTab.Videos || tab == DiscoverTab.All) {
            loadFeaturedCreatorsIfNeeded()
        }
        if (tab == DiscoverTab.Videos && externalVideos.value.isEmpty() && !externalVideosLoading.value) {
            loadExternalVideos(externalVideosTopic.value)
        }
    }

    fun loadExternalVideos(topic: String = externalVideosTopic.value) {
        val normTopic = topic.trim().ifBlank { "Featured" }
        externalVideosTopic.value = normTopic
        externalVideosJob?.cancel()
        externalVideosLoading.value = true
        externalVideosJob = scope.launch {
            try {
                val picks = ExternalDiscoveryApi.discoverYouTubeVideos(normTopic)
                if (externalVideosTopic.value == normTopic) {
                    externalVideos.value = picks
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            } finally {
                if (externalVideosTopic.value == normTopic) {
                    externalVideosLoading.value = false
                }
            }
        }
    }

    fun addExternalVideoToLibrary(video: ExternalVideoPick, audioOnly: Boolean) {
        val apiUrl = status.value?.apiUrl
        if (apiUrl.isNullOrBlank()) {
            openAddSheet(prefillUrl = video.watchUrl)
            return
        }
        val submitKey = "yt:${video.videoId}"
        val parsed = if (audioOnly) {
            smartParseYouTubeCandidate(
                YouTubeCandidate(
                    videoId = video.videoId,
                    title = video.title,
                    channel = video.channelName,
                    url = video.watchUrl,
                ),
            )
        } else {
            null
        }
        val cleanTitle = parsed?.title?.takeIf { it.isNotBlank() } ?: video.title
        val cleanArtist = parsed?.artist?.takeIf { it.isNotBlank() } ?: cleanChannelName(video.channelName)
        val announceTitle = if (audioOnly) parsed?.album?.ifBlank { cleanTitle } ?: cleanTitle else video.title
        val acquireId = normalizeAcquireId("", announceTitle, cleanArtist, video.watchUrl, audioOnly)
        val music = if (audioOnly) {
            MusicMeta(
                title = cleanTitle.takeIf { it.isNotBlank() },
                artist = cleanArtist.takeIf { it.isNotBlank() },
            )
        } else {
            null
        }
        discoverSubmittingIds.value = discoverSubmittingIds.value + submitKey
        scope.launch {
            try {
                loopbackApi.acquire(
                    id = acquireId,
                    title = announceTitle,
                    url = video.watchUrl,
                    page = true,
                    audio = audioOnly,
                    music = music,
                ).fold(
                    onSuccess = { job ->
                        recordSubmittedJob(job)
                        notice.value = if (audioOnly) "Saving $cleanTitle to Music library…" else "Saving ${video.title}…"
                    },
                    onFailure = { err ->
                        error.value = err.message ?: "Could not add ${video.title} to PearTube."
                    },
                )
            } finally {
                discoverSubmittingIds.value = discoverSubmittingIds.value - submitKey
            }
        }
    }

    fun loadCinemaDiscover(genre: String = cinemaDiscoverGenre.value) {
        val normGenre = genre.trim().ifBlank { "Popular" }
        cinemaDiscoverGenre.value = normGenre
        val cached = cinemaDiscoverCache[normGenre]
        if (cached != null) {
            cinemaDiscoverJob?.cancel()
            cinemaDiscoverData.value = cached
            cinemaDiscoverLoading.value = false
            cinemaDiscoverError.value = null
            return
        }
        cinemaDiscoverJob?.cancel()
        cinemaDiscoverLoading.value = true
        cinemaDiscoverError.value = null
        cinemaDiscoverJob = scope.launch {
            try {
                val data = ExternalDiscoveryApi.discoverCinema(normGenre)
                if (data.movies.isNotEmpty() || data.series.isNotEmpty()) {
                    cinemaDiscoverCache[normGenre] = data
                }
                if (cinemaDiscoverGenre.value == normGenre) {
                    cinemaDiscoverData.value = data
                    cinemaDiscoverError.value = null
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (cinemaDiscoverGenre.value == normGenre) {
                    cinemaDiscoverError.value = e.message ?: "Could not load cinema picks."
                }
            } finally {
                if (cinemaDiscoverGenre.value == normGenre) {
                    cinemaDiscoverLoading.value = false
                }
            }
        }
    }

    fun loadFeaturedCreatorsIfNeeded() {
        if (featuredCreatorsLoaded || featuredCreatorsLoading.value) return
        if (featuredCreators.value.isEmpty()) {
            featuredCreators.value = FEATURED_CREATORS
        }
        featuredCreatorsLoading.value = true
        scope.launch {
            try {
                val loaded = ExternalDiscoveryApi.fetchFeaturedCreators()
                if (loaded.isNotEmpty()) {
                    featuredCreators.value = loaded
                    featuredCreatorsLoaded = true
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            } finally {
                featuredCreatorsLoading.value = false
            }
        }
    }

    fun searchCreatorSuggestions(rawQuery: String) {
        val q = rawQuery.trim()
        creatorSuggestJob?.cancel()
        if (q.length < 2 ||
            q.startsWith("http://", ignoreCase = true) ||
            q.startsWith("https://", ignoreCase = true) ||
            q.startsWith("peartube://", ignoreCase = true)
        ) {
            creatorSuggestions.value = emptyList()
            creatorSuggestBusy.value = false
            return
        }
        val localMatches = status.value?.discoveredSources.orEmpty()
            .filter { src ->
                src.title.contains(q, ignoreCase = true) || src.key.startsWith(q, ignoreCase = true)
            }
            .take(3)
            .map { src ->
                CreatorSuggestion(
                    id = "peartube:${src.key}",
                    name = src.title.ifBlank { "Channel ${src.key.take(8)}" },
                    handle = src.via.ifBlank { "LAN channel" },
                    subscribers = "PearTube swarm",
                    avatarUrl = "",
                    url = "peartube://channel/${src.key}",
                    source = "peartube",
                    peartubeChannel = src,
                )
            }
        creatorSuggestions.value = localMatches
        creatorSuggestBusy.value = true
        creatorSuggestJob = scope.launch {
            try {
                val remote = ExternalDiscoveryApi.searchCreatorsTypeahead(q)
                creatorSuggestions.value = (remote + localMatches).distinctBy { it.id }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            } finally {
                creatorSuggestBusy.value = false
            }
        }
    }

    fun clearCreatorSuggestions() {
        creatorSuggestJob?.cancel()
        creatorSuggestions.value = emptyList()
        creatorSuggestBusy.value = false
    }

    fun loadMusicDiscover(mood: String = musicDiscoverMood.value, query: String = musicDiscoverQuery.value) {
        val normMood = mood.trim().lowercase().ifBlank { "featured" }
        val cleanQuery = query.trim()
        musicDiscoverMood.value = normMood
        musicDiscoverQuery.value = cleanQuery
        if (cleanQuery.isEmpty()) {
            selectedSuggestedArtist.value = null
        }
        musicDiscoverJob?.cancel()
        musicDiscoverLoading.value = true
        musicDiscoverError.value = null
        val seeds = catalog.value.artists
            .map { it.name }
            .filter { it.isNotBlank() && it != "Unknown artist" }
        musicDiscoverJob = scope.launch {
            try {
                val data = ExternalDiscoveryApi.discoverMusic(
                    mood = normMood,
                    query = cleanQuery,
                    seedArtists = seeds,
                )
                musicDiscoverData.value = data
                musicDiscoverError.value = null
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                musicDiscoverError.value = e.message ?: "Could not load music suggestions."
            } finally {
                musicDiscoverLoading.value = false
            }
        }
    }

    fun exploreSuggestedArtist(artist: SuggestedArtist) {
        previewPlayer.stop()
        selectedSuggestedArtist.value = artist
        loadMusicDiscover(mood = musicDiscoverMood.value, query = artist.name)
    }

    fun clearSuggestedArtist() {
        previewPlayer.stop()
        selectedSuggestedArtist.value = null
        loadMusicDiscover(mood = musicDiscoverMood.value, query = "")
    }

    @Volatile
    var playStarted: Boolean = false

    private fun recordStatus(st: Status) {
        status.value = st
        networkHistory.value = networkHistory.value.append(st.downBps, st.upBps, maxSamples = 40)
    }

    private suspend fun refresh() {
        try {
            // Keep the worklet's QuickJS thread wide open once video frames are flowing.
            val videoOpen = activeVideo.value != null && videoMode.value != VideoDisplayMode.Closed
            if ((videoOpen || screen.value is Screen.Play) && playStarted) {
                recordStatus(worker.status())
            } else {
                coroutineScope {
                    val st = async { worker.status() }
                    val en = async { worker.search() }
                    val id = async { runCatching { worker.identity(false) }.getOrNull() }
                    recordStatus(st.await())
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
