package com.peartube.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

enum class DiscoverTab(val label: String) {
    All("Everything"),
    Cinema("Movies & TV"),
    Videos("Videos"),
    Music("Music"),
}

data class CreatorSuggestion(
    val id: String,
    val name: String,
    val handle: String,
    val subscribers: String,
    val avatarUrl: String,
    val url: String,
    val source: String = "youtube",
    val peartubeChannel: DiscoveredSource? = null,
)

data class SuggestedArtist(
    val name: String,
    val genre: String,
    val artUrl: String,
)

data class SuggestedSong(
    val id: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationSecs: Int,
    val artUrl: String,
    val previewUrl: String,
)

data class SuggestedAlbum(
    val title: String,
    val artist: String,
    val year: String,
    val artUrl: String,
)

data class MusicDiscoverData(
    val mood: String,
    val query: String,
    val artists: List<SuggestedArtist> = emptyList(),
    val songs: List<SuggestedSong> = emptyList(),
    val albums: List<SuggestedAlbum> = emptyList(),
)

data class MusicMood(
    val id: String,
    val label: String,
    val terms: List<String>,
)

val MUSIC_MOODS: List<MusicMood> = listOf(
    MusicMood("featured", "Essential", listOf("Miles Davis", "Radiohead", "Daft Punk", "Frank Ocean")),
    MusicMood("jazz", "Jazz", listOf("John Coltrane", "Bill Evans", "Miles Davis", "Kamasi Washington")),
    MusicMood("electronic", "Electronic", listOf("Daft Punk", "Aphex Twin", "Four Tet", "Boards of Canada")),
    MusicMood("indie", "Indie & Alt", listOf("Radiohead", "Tame Impala", "Beach House", "Khruangbin")),
    MusicMood("hiphop", "Hip-Hop", listOf("Kendrick Lamar", "MF DOOM", "J Dilla", "A Tribe Called Quest")),
    MusicMood("ambient", "Ambient", listOf("Brian Eno", "Nils Frahm", "Max Richter", "Ryuichi Sakamoto")),
    MusicMood("soul", "Soul & R&B", listOf("Frank Ocean", "Erykah Badu", "Marvin Gaye", "D'Angelo")),
    MusicMood("rock", "Rock", listOf("Pink Floyd", "Fleetwood Mac", "Talking Heads", "Led Zeppelin")),
)

data class CinemaDiscoverItem(
    val imdbId: String,
    val kind: String,
    val title: String,
    val year: String,
    val rating: String,
    val runtime: String,
    val genres: List<String>,
    val description: String,
    val posterUrl: String,
    val backdropUrl: String,
    val cast: List<String>,
)

data class CinemaDiscoverData(
    val genre: String,
    val movies: List<CinemaDiscoverItem> = emptyList(),
    val series: List<CinemaDiscoverItem> = emptyList(),
)

data class CinemaEpisodeMeta(
    val season: Int,
    val episode: Int,
    val name: String,
    val overview: String,
    val thumbnailUrl: String,
)

data class CinemaTitleMeta(
    val imdbId: String,
    val kind: String,
    val title: String,
    val year: String,
    val rating: String,
    val runtime: String,
    val genres: List<String>,
    val description: String,
    val cast: List<String>,
    val posterUrl: String,
    val backdropUrl: String,
    val episodes: Map<Pair<Int, Int>, CinemaEpisodeMeta> = emptyMap(),
)

data class ExternalVideoPick(
    val videoId: String,
    val title: String,
    val channelName: String,
    val channelUrl: String,
    val durationText: String,
    val publishedText: String,
    val thumbUrl: String,
    val watchUrl: String,
)

const val YT_VISIONOS_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

const val YT_IOS_USER_AGENT =
    "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)"

data class ResolvedAudioStream(
    val videoId: String,
    val streamUrl: String,
    val durationMs: Long,
    val userAgent: String,
    val watchUrl: String,
)

data class RadioTrackSuggestion(
    val videoId: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationSecs: Int,
    val artUrl: String,
)

data class ResolvedTrackAlbumMeta(
    val album: String = "",
    val albumBrowseId: String = "",
    val artist: String = "",
    val year: String = "",
    val artUrl: String = "",
    val trackNumber: Int? = null,
)

data class YtmArtistSummary(
    val browseId: String,
    val name: String,
    val subscribers: String = "",
    val artUrl: String = "",
)

data class YtmSongItem(
    val videoId: String,
    val title: String,
    val artist: String,
    val artistBrowseId: String = "",
    val album: String = "",
    val albumBrowseId: String = "",
    val durationText: String = "",
    val durationSecs: Int = 0,
    val playsText: String = "",
    val artUrl: String = "",
)

data class YtmAlbumSummary(
    val browseId: String,
    val title: String,
    val artist: String = "",
    val year: String = "",
    val subtitle: String = "",
    val artUrl: String = "",
)

data class YtmSearchResult(
    val query: String,
    val artists: List<YtmArtistSummary> = emptyList(),
    val songs: List<YtmSongItem> = emptyList(),
    val albums: List<YtmAlbumSummary> = emptyList(),
) {
    val isEmpty: Boolean get() = artists.isEmpty() && songs.isEmpty() && albums.isEmpty()
    val totalCount: Int get() = artists.size + songs.size + albums.size
}

data class YtmArtistPage(
    val browseId: String,
    val name: String,
    val monthlyListeners: String = "",
    val description: String = "",
    val artUrl: String = "",
    val topSongs: List<YtmSongItem> = emptyList(),
    val albums: List<YtmAlbumSummary> = emptyList(),
    val singles: List<YtmAlbumSummary> = emptyList(),
    val relatedArtists: List<YtmArtistSummary> = emptyList(),
)

data class YtmAlbumPage(
    val browseId: String,
    val title: String,
    val artist: String = "",
    val artistBrowseId: String = "",
    val year: String = "",
    val subtitle: String = "",
    val artUrl: String = "",
    val tracks: List<YtmSongItem> = emptyList(),
)

val CINEMA_GENRES: List<String> = listOf(
    "Popular",
    "Top Rated",
    "Sci-Fi",
    "Drama",
    "Action",
    "Thriller",
    "Comedy",
    "Documentary",
    "Animation",
)

val FEATURED_CREATORS: List<CreatorSuggestion> = listOf(
    CreatorSuggestion(
        id = "youtube:@mkbhd",
        name = "Marques Brownlee",
        handle = "@mkbhd",
        subscribers = "Tech & reviews",
        avatarUrl = "",
        url = "https://www.youtube.com/@mkbhd",
        source = "youtube",
    ),
    CreatorSuggestion(
        id = "youtube:@veritasium",
        name = "Veritasium",
        handle = "@veritasium",
        subscribers = "Science & physics",
        avatarUrl = "",
        url = "https://www.youtube.com/@veritasium",
        source = "youtube",
    ),
    CreatorSuggestion(
        id = "youtube:@kurzgesagt",
        name = "Kurzgesagt",
        handle = "@kurzgesagt",
        subscribers = "Animated explainers",
        avatarUrl = "",
        url = "https://www.youtube.com/@kurzgesagt",
        source = "youtube",
    ),
    CreatorSuggestion(
        id = "youtube:@3blue1brown",
        name = "3Blue1Brown",
        handle = "@3blue1brown",
        subscribers = "Visual math",
        avatarUrl = "",
        url = "https://www.youtube.com/@3blue1brown",
        source = "youtube",
    ),
    CreatorSuggestion(
        id = "youtube:@Nerdwriter1",
        name = "Nerdwriter1",
        handle = "@Nerdwriter1",
        subscribers = "Film & art essays",
        avatarUrl = "",
        url = "https://www.youtube.com/@Nerdwriter1",
        source = "youtube",
    ),
    CreatorSuggestion(
        id = "youtube:@LinusTechTips",
        name = "Linus Tech Tips",
        handle = "@LinusTechTips",
        subscribers = "Hardware & tech",
        avatarUrl = "",
        url = "https://www.youtube.com/@LinusTechTips",
        source = "youtube",
    ),
)

data class PreviewState(
    val activeId: String? = null,
    val loading: Boolean = false,
    val playing: Boolean = false,
    val error: String? = null,
)

/**
 * Wraps Android MediaPlayer for 30-second iTunes song previews inside the Music Discover room.
 */
class MusicPreviewPlayer(
    private val onStartingPreview: () -> Unit,
) {
    private val _state = MutableStateFlow(PreviewState())
    val state: StateFlow<PreviewState> = _state.asStateFlow()

    private var player: MediaPlayer? = null

    @Synchronized
    fun toggle(songId: String, previewUrl: String) {
        if (previewUrl.isBlank()) return
        val cur = _state.value
        if (cur.activeId == songId && (cur.playing || cur.loading)) {
            stop()
            return
        }
        stop()
        onStartingPreview()
        _state.value = PreviewState(activeId = songId, loading = true, playing = false)
        try {
            val mp = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                setDataSource(previewUrl)
                setOnPreparedListener { ready ->
                    synchronized(this@MusicPreviewPlayer) {
                        if (player !== ready) {
                            runCatching { ready.release() }
                            return@synchronized
                        }
                        try {
                            ready.start()
                            _state.value = PreviewState(activeId = songId, loading = false, playing = true)
                        } catch (e: Exception) {
                            stop()
                            _state.value = PreviewState(error = e.message ?: "Preview failed to play")
                        }
                    }
                }
                setOnCompletionListener {
                    synchronized(this@MusicPreviewPlayer) {
                        if (player === it) {
                            stop()
                        }
                    }
                }
                setOnErrorListener { mpErr, _, _ ->
                    synchronized(this@MusicPreviewPlayer) {
                        if (player === mpErr) {
                            stop()
                            _state.value = PreviewState(error = "Preview unavailable")
                        }
                    }
                    true
                }
                prepareAsync()
            }
            player = mp
        } catch (e: Exception) {
            stop()
            _state.value = PreviewState(error = e.message ?: "Preview failed")
        }
    }

    @Synchronized
    fun stop() {
        val current = player
        player = null
        if (current != null) {
            runCatching {
                current.setOnPreparedListener(null)
                current.setOnCompletionListener(null)
                current.setOnErrorListener(null)
                if (current.isPlaying) current.stop()
            }
            runCatching { current.reset() }
            runCatching { current.release() }
        }
        if (_state.value.activeId != null || _state.value.loading || _state.value.playing) {
            _state.value = PreviewState()
        }
    }
}

private val IMDB_TT_RE = Regex("^tt[0-9]+$")
private val IMDB_ENTRY_RE = Regex("^imdb:(tt[0-9]+)(?::.*)?$")

fun extractImdbId(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    if (IMDB_TT_RE.matches(trimmed)) return trimmed
    return IMDB_ENTRY_RE.matchEntire(trimmed)?.groupValues?.getOrNull(1)
}

fun imdbPosterUrl(imdb: String?): String? {
    val tt = extractImdbId(imdb) ?: return null
    ExternalDiscoveryApi.cachedImdbPosterUrl(tt)?.let { return it }
    if (ExternalDiscoveryApi.isFailClosed()) {
        return ExternalDiscoveryApi.localLegacyArtUrl(tt, isBackdrop = false)
    }
    return "https://images.metahub.space/poster/medium/$tt/img"
}

fun imdbBackdropUrl(imdb: String?): String? {
    val tt = extractImdbId(imdb) ?: return null
    ExternalDiscoveryApi.cachedImdbBackdropUrl(tt)?.let { return it }
    if (ExternalDiscoveryApi.isFailClosed()) {
        return ExternalDiscoveryApi.localLegacyArtUrl(tt, isBackdrop = true)
    }
    return "https://images.metahub.space/background/medium/$tt/img"
}

/**
 * 2-tier (in-memory LRU + persistent disk) cache and allowlisted HTTPS bitmap fetcher for
 * movie/series posters, backdrops, creator avatars, and album covers.
 */
object ExternalImageCache {
    private val cache by lazy { object : LruCache<String, ImageBitmap>(140) {} }
    private val bitmapCache by lazy { object : LruCache<String, Bitmap>(48) {} }
    private val failedUrls = ConcurrentHashMap<String, Long>()
    private const val NEGATIVE_TTL_MS = 10 * 60_000L
    private const val MAX_DISK_FILES = 260

    @Volatile
    private var diskCacheDir: File? = null

    private val allowedDomains = listOf(
        "ytimg.com",
        "ggpht.com",
        "googleusercontent.com",
        "mzstatic.com",
        "sndcdn.com",
        "metahub.space",
        "coverartarchive.org",
        "archive.org",
        "tmdb.org",
        "image.tmdb.org",
        "media-amazon.com",
    )

    fun init(context: Context) {
        val dir = File(context.cacheDir, "lumen-art")
        runCatching { dir.mkdirs() }
        diskCacheDir = dir
    }

    internal fun diskDirectory(): File? = diskCacheDir

    fun isLoopbackUrl(rawUrl: String): Boolean {
        val trimmed = rawUrl.trim()
        if (!trimmed.startsWith("http://", ignoreCase = true) && !trimmed.startsWith("https://", ignoreCase = true)) {
            return false
        }
        val host = runCatching { URI(trimmed).host?.lowercase(Locale.ROOT) }.getOrNull() ?: return false
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    fun isAllowedUrl(rawUrl: String): Boolean {
        val trimmed = rawUrl.trim()
        if (isLoopbackUrl(trimmed)) {
            val path = runCatching { URI(trimmed).rawPath.orEmpty() }.getOrDefault("")
            return path.startsWith("/v1/art/") ||
                path.startsWith("/v1/poster/") ||
                path.startsWith("/v1/backdrop/") ||
                path.startsWith("/v1/discover/thumb/") ||
                path.startsWith("/v1/providers/")
        }
        if (!trimmed.startsWith("https://", ignoreCase = true)) return false
        val host = runCatching { URI(trimmed).host?.lowercase(Locale.ROOT) }.getOrNull() ?: return false
        return allowedDomains.any { domain -> host == domain || host.endsWith(".$domain") }
    }

    fun get(url: String): ImageBitmap? = runCatching { synchronized(cache) { cache.get(url) } }.getOrNull()

    fun getCachedBitmap(url: String): Bitmap? = runCatching { synchronized(bitmapCache) { bitmapCache.get(url) } }.getOrNull()

    internal fun clearNegativeCache() {
        failedUrls.clear()
    }

    fun put(url: String, bitmap: ImageBitmap) {
        runCatching { synchronized(cache) { cache.put(url, bitmap) } }
    }

    private fun putAndroidBitmap(url: String, bmp: Bitmap): ImageBitmap {
        val img = bmp.asImageBitmap()
        runCatching { synchronized(bitmapCache) { bitmapCache.put(url, bmp) } }
        runCatching { synchronized(cache) { cache.put(url, img) } }
        return img
    }

    suspend fun load(rawUrl: String): ImageBitmap? {
        val url = normalizeImageUrl(rawUrl)
        if (!isAllowedUrl(url)) return null
        if (ExternalDiscoveryApi.isFailClosed() && !isLoopbackUrl(url)) return null
        get(url)?.let { return it }
        val bmp = loadBitmap(url) ?: return null
        return get(url) ?: putAndroidBitmap(url, bmp)
    }

    suspend fun loadBitmap(rawUrl: String): Bitmap? = withContext(Dispatchers.IO) {
        val url = normalizeImageUrl(rawUrl)
        if (!isAllowedUrl(url)) return@withContext null
        val failClosed = ExternalDiscoveryApi.isFailClosed()
        if (failClosed && !isLoopbackUrl(url)) return@withContext null
        getCachedBitmap(url)?.let { return@withContext it }

        val failedAt = failedUrls[url]
        if (failedAt != null && System.currentTimeMillis() - failedAt < NEGATIVE_TTL_MS) {
            return@withContext null
        }

        // Tier 2: Persistent disk cache
        val diskFile = diskFileFor(url)
        if (diskFile != null && diskFile.isFile && diskFile.length() > 0L) {
            val fromDisk = runCatching { BitmapFactory.decodeFile(diskFile.path) }.getOrNull()
            if (fromDisk != null) {
                putAndroidBitmap(url, fromDisk)
                return@withContext fromDisk
            } else {
                runCatching { diskFile.delete() }
            }
        }

        // Network fetch with explicit hop-by-hop redirect enforcement
        var currentUrl = url
        var conn: HttpURLConnection? = null
        try {
            var redirects = 0
            while (true) {
                if (!isAllowedUrl(currentUrl)) return@withContext null
                if (failClosed && !isLoopbackUrl(currentUrl)) return@withContext null
                conn?.let { runCatching { it.disconnect() } }
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 5_000
                    readTimeout = 8_000
                    instanceFollowRedirects = false
                    setRequestProperty("Accept", "image/*")
                }
                val code = conn.responseCode
                if (code in 300..399) {
                    val location = conn.getHeaderField("Location")?.trim().orEmpty()
                    if (location.isEmpty() || redirects >= 3) {
                        failedUrls[url] = System.currentTimeMillis()
                        return@withContext null
                    }
                    val resolvedNext = runCatching { URL(URL(currentUrl), location).toString() }.getOrNull()
                    if (resolvedNext.isNullOrBlank()) {
                        failedUrls[url] = System.currentTimeMillis()
                        return@withContext null
                    }
                    val nextUrl = normalizeImageUrl(resolvedNext)
                    if (failClosed && !isLoopbackUrl(nextUrl)) {
                        failedUrls[url] = System.currentTimeMillis()
                        return@withContext null
                    }
                    if (!isAllowedUrl(nextUrl)) {
                        failedUrls[url] = System.currentTimeMillis()
                        return@withContext null
                    }
                    currentUrl = nextUrl
                    redirects++
                    continue
                }
                if (code !in 200..299) {
                    failedUrls[url] = System.currentTimeMillis()
                    return@withContext null
                }
                break
            }
            val activeConn = conn ?: return@withContext null
            val finalUrl = activeConn.url?.toString().orEmpty()
            if (finalUrl.isNotEmpty()) {
                if (!isAllowedUrl(finalUrl)) return@withContext null
                if (failClosed && !isLoopbackUrl(finalUrl)) return@withContext null
            }
            val bytes = activeConn.inputStream.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                var total = 0
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > 5 * 1024 * 1024) return@withContext null
                    out.write(buf, 0, n)
                }
                out.toByteArray()
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (decoded != null) {
                failedUrls.remove(url)
                putAndroidBitmap(url, decoded)
                writeDiskAtomic(diskFile, bytes)
            } else {
                failedUrls[url] = System.currentTimeMillis()
            }
            decoded
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun diskFileFor(url: String): File? {
        val dir = diskCacheDir ?: return null
        return File(dir, "${sha256Hex(url)}.img")
    }

    private fun writeDiskAtomic(target: File?, bytes: ByteArray) {
        val file = target ?: return
        val dir = file.parentFile ?: return
        runCatching {
            if (!dir.exists()) dir.mkdirs()
            val tmp = File(dir, "${file.name}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) {
                tmp.delete()
            }
            pruneDiskCacheIfNeeded(dir)
        }
    }

    private fun pruneDiskCacheIfNeeded(dir: File) {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".img") } ?: return
        if (files.size <= MAX_DISK_FILES) return
        files.sortBy { it.lastModified() }
        val toRemove = files.size - (MAX_DISK_FILES - 40)
        for (i in 0 until toRemove.coerceAtMost(files.size)) {
            runCatching { files[i].delete() }
        }
    }

    internal fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xFF
            sb.append(HEX_CHARS[v ushr 4])
            sb.append(HEX_CHARS[v and 0x0F])
        }
        return sb.toString()
    }

    private val HEX_CHARS = "0123456789abcdef".toCharArray()

    private fun normalizeImageUrl(raw: String): String {
        val trimmed = raw.trim()
        return if (trimmed.startsWith("//")) "https:$trimmed" else trimmed
    }
}

/**
 * Pure Kotlin HttpURLConnection + org.json client for YouTube creator typeahead and Apple iTunes music discovery.
 */
object ExternalDiscoveryApi {
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 7_000
    private const val USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    private const val YT_CONSENT_COOKIE = "CONSENT=YES+cb.20210328-17-p0.en+FX+417"
    private val HANDLE_RE = Regex("^[A-Za-z0-9._-]{2,40}$")
    private val ARTWORK_SIZE_RE = Regex("/\\d+x\\d+bb(\\.[a-zA-Z0-9]+)$")
    private val ARTIST_SPLIT_RE = Regex(
        "\\s*(?:,|&|\\band\\b|\\bfeat\\.?|\\bft\\.?|\\bfeaturing\\b|\\bwith\\b|\\bx\\b)\\s*",
        RegexOption.IGNORE_CASE,
    )
    private val YEAR_FOUR_RE = Regex("(19|20)[0-9]{2}")
    private val RUNTIME_MINS_RE = Regex("^([0-9]+)\\s*(?:min|mins|m)\\b", RegexOption.IGNORE_CASE)
    private val TITLE_STRIP_EP_RE = Regex("\\s+S[0-9]+E[0-9]+$", RegexOption.IGNORE_CASE)
    private val TITLE_STRIP_PAREN_YEAR_RE = Regex("\\s+\\((19|20)[0-9]{2}\\)$")
    private val albumArtUrlCache = ConcurrentHashMap<String, String>()
    private val albumArtNegativeCache = ConcurrentHashMap<String, Long>()
    private val trackAlbumMetaCache = ConcurrentHashMap<String, Pair<Long, ResolvedTrackAlbumMeta>>()
    private val titleImdbCache = ConcurrentHashMap<String, String>()
    private val titleMetaCache = ConcurrentHashMap<String, CinemaTitleMeta>()
    private val imdbPosterUrlCache = ConcurrentHashMap<String, String>()
    private val imdbBackdropUrlCache = ConcurrentHashMap<String, String>()
    private val imdbP2pMissCache = ConcurrentHashMap<String, Long>()
    private val cinemaDiscoverCache = ConcurrentHashMap<String, CinemaDiscoverData>()
    private val externalVideosCache = ConcurrentHashMap<String, Pair<Long, List<ExternalVideoPick>>>()
    private val resolvedAudioCache = ConcurrentHashMap<String, Pair<Long, ResolvedAudioStream>>()
    private val radioNextCache = ConcurrentHashMap<String, Pair<Long, List<RadioTrackSuggestion>>>()
    private val ytmSearchCache = ConcurrentHashMap<String, Pair<Long, YtmSearchResult>>()
    private val ytmArtistCache = ConcurrentHashMap<String, Pair<Long, YtmArtistPage>>()
    private val ytmAlbumCache = ConcurrentHashMap<String, Pair<Long, YtmAlbumPage>>()
    private val VISITOR_DATA_RE = Regex("\"VISITOR_DATA\"\\s*:\\s*\"([^\"]+)\"")
    private val SW_VISITOR_DATA_RE = Regex("\"(Cgt[A-Za-z0-9_-]{10,})\"")
    private val YT_THUMB_SIZE_RE = Regex("=w\\d+-h\\d+[^&\\s]*$")
    private val DURATION_MMSS_RE = Regex("^\\d{1,2}:\\d{2}(?::\\d{2})?$")
    @Volatile private var cachedVisitorData: Pair<Long, String>? = null
    @Volatile private var cachedFeaturedCreators: List<CreatorSuggestion>? = null
    @Volatile private var localApiBaseUrl: String? = null
    @Volatile private var failClosedMeta: Boolean = false
    @Volatile internal var clearnetRequestHook: ((String) -> Unit)? = null
    private val _localMetaEpoch = MutableStateFlow(0)
    val localMetaEpoch: StateFlow<Int> = _localMetaEpoch.asStateFlow()
    private val localMetaClient = LoopbackApi { localApiBaseUrl }
    private const val CINEMA_DISCOVER_DISK_TTL_MS = 30 * 60_000L
    private const val EXTERNAL_VIDEOS_TTL_MS = 15 * 60_000L
    private const val RESOLVED_AUDIO_TTL_MS = 30 * 60_000L
    private const val RADIO_NEXT_TTL_MS = 15 * 60_000L
    private const val YTM_CACHE_TTL_MS = 15 * 60_000L
    private const val VISITOR_DATA_TTL_MS = 15 * 60_000L
    private const val P2P_MISS_TTL_MS = 2 * 60_000L

    /**
     * Thread-safe runtime configuration for P2P-first metadata & fail-closed privacy mode.
     * Updated by [AppModel] whenever the loopback API URL, Private Routing, or P2P-only toggle changes.
     */
    fun configureLocalMeta(apiBaseUrl: String?, failClosed: Boolean) {
        val normalized = apiBaseUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        val changed = localApiBaseUrl != normalized || failClosedMeta != failClosed
        localApiBaseUrl = normalized
        failClosedMeta = failClosed
        if (changed) {
            titleMetaCache.clear()
            cinemaDiscoverCache.clear()
            titleImdbCache.clear()
            imdbPosterUrlCache.clear()
            imdbBackdropUrlCache.clear()
            imdbP2pMissCache.clear()
            albumArtNegativeCache.clear()
            ytmSearchCache.clear()
            ytmArtistCache.clear()
            ytmAlbumCache.clear()
            trackAlbumMetaCache.clear()
            ExternalImageCache.clearNegativeCache()
            _localMetaEpoch.value = _localMetaEpoch.value + 1
        }
    }

    fun isFailClosed(): Boolean = failClosedMeta

    fun currentLocalApiBaseUrl(): String? = localApiBaseUrl

    fun cachedImdbPosterUrl(tt: String): String? = imdbPosterUrlCache[tt]?.takeIf { it.isNotEmpty() }

    fun cachedImdbBackdropUrl(tt: String): String? = imdbBackdropUrlCache[tt]?.takeIf { it.isNotEmpty() }

    internal fun localLegacyArtUrl(tt: String, isBackdrop: Boolean): String? {
        val base = localApiBaseUrl ?: return null
        val kind = if (isBackdrop) "backdrop" else "poster"
        return "$base/v1/$kind/$tt"
    }

    private fun resolveLocalArtUrl(rawPath: String?, hashFallback: String = ""): String {
        val base = localApiBaseUrl ?: return ""
        val path = rawPath?.trim().orEmpty().ifBlank {
            if (hashFallback.length == 64) "/v1/art/$hashFallback" else ""
        }
        if (path.isEmpty()) return ""
        return resolveLoopbackThumbUrl(base, path).orEmpty()
    }

    private fun rememberCardArtAndThumb(card: MetaCard, posterUrl: String, backdropUrl: String) {
        val tt = extractImdbId(card.id)
        if (tt != null) {
            if (posterUrl.isNotBlank()) imdbPosterUrlCache[tt] = posterUrl
            if (backdropUrl.isNotBlank()) imdbBackdropUrlCache[tt] = backdropUrl
        }
        if (card.thumbHash.isNotBlank()) {
            ThumbHash.rememberThumbHash(card.id, card.thumbHash)
            if (tt != null) {
                ThumbHash.rememberThumbHash("imdb:$tt", card.thumbHash)
                ThumbHash.rememberThumbHash(tt, card.thumbHash)
            }
            if (posterUrl.isNotBlank()) ThumbHash.rememberThumbHash(posterUrl, card.thumbHash)
            if (backdropUrl.isNotBlank()) ThumbHash.rememberThumbHash(backdropUrl, card.thumbHash)
        }
    }

    /**
     * Resolves an IMDb poster URL P2P-first (populating cached ThumbHash + local `/v1/art/:hash`),
     * honoring fail-closed privacy mode.
     */
    suspend fun resolveImdbPosterUrl(imdb: String?): String? = withContext(Dispatchers.IO) {
        val tt = extractImdbId(imdb) ?: return@withContext null
        imdbPosterUrlCache[tt]?.takeIf { it.isNotEmpty() }?.let { return@withContext it }
        if (localApiBaseUrl != null) {
            val missedAt = imdbP2pMissCache[tt]
            if (missedAt == null || System.currentTimeMillis() - missedAt >= P2P_MISS_TTL_MS) {
                val card = localMetaClient.getMetaCard("imdb:$tt")
                if (card != null) {
                    val posterUrl = resolveLocalArtUrl(card.posterUrl, card.posterHash)
                    val backdropUrl = resolveLocalArtUrl(card.backdropUrl, card.backdropHash)
                    rememberCardArtAndThumb(card, posterUrl, backdropUrl)
                    imdbP2pMissCache.remove(tt)
                    if (posterUrl.isNotBlank()) return@withContext posterUrl
                } else {
                    imdbP2pMissCache[tt] = System.currentTimeMillis()
                }
            }
        }
        if (failClosedMeta) return@withContext null
        "https://images.metahub.space/poster/medium/$tt/img"
    }

    /**
     * Resolves an IMDb backdrop & poster fallback URL P2P-first (populating cached ThumbHash + local `/v1/art/:hash`),
     * honoring fail-closed privacy mode.
     */
    suspend fun resolveImdbArtUrls(imdb: String?): Pair<String?, String?> = withContext(Dispatchers.IO) {
        val tt = extractImdbId(imdb) ?: return@withContext (null to null)
        val cachedBackdrop = imdbBackdropUrlCache[tt]?.takeIf { it.isNotEmpty() }
        val cachedPoster = imdbPosterUrlCache[tt]?.takeIf { it.isNotEmpty() }
        if (cachedBackdrop != null || cachedPoster != null) {
            return@withContext (cachedBackdrop to cachedPoster)
        }
        if (localApiBaseUrl != null) {
            val missedAt = imdbP2pMissCache[tt]
            if (missedAt == null || System.currentTimeMillis() - missedAt >= P2P_MISS_TTL_MS) {
                val card = localMetaClient.getMetaCard("imdb:$tt")
                if (card != null) {
                    val posterUrl = resolveLocalArtUrl(card.posterUrl, card.posterHash)
                    val backdropUrl = resolveLocalArtUrl(card.backdropUrl, card.backdropHash)
                    rememberCardArtAndThumb(card, posterUrl, backdropUrl)
                    imdbP2pMissCache.remove(tt)
                    if (backdropUrl.isNotBlank() || posterUrl.isNotBlank()) {
                        return@withContext (backdropUrl.ifBlank { null } to posterUrl.ifBlank { null })
                    }
                } else {
                    imdbP2pMissCache[tt] = System.currentTimeMillis()
                }
            }
        }
        if (failClosedMeta) return@withContext (null to null)
        "https://images.metahub.space/background/medium/$tt/img" to "https://images.metahub.space/poster/medium/$tt/img"
    }

    fun cachedTitleImdb(title: String, isSeries: Boolean): String? {
        val key = titleImdbCacheKey(title, isSeries) ?: return null
        return titleImdbCache[key]?.takeIf { it.isNotEmpty() }
    }

    fun cachedTitleMeta(imdb: String?, isSeries: Boolean): CinemaTitleMeta? {
        val tt = extractImdbId(imdb) ?: return null
        val kind = if (isSeries) "series" else "movie"
        return titleMetaCache["$kind:$tt"]
    }

    suspend fun resolveTitleImdb(title: String, isSeries: Boolean): String? = withContext(Dispatchers.IO) {
        val cleanTitle = cleanLookupTitle(title)
        val key = titleImdbCacheKey(cleanTitle, isSeries) ?: return@withContext null
        titleImdbCache[key]?.let { cached ->
            return@withContext cached.takeIf { it.isNotEmpty() }
        }
        val kind = if (isSeries) "series" else "movie"

        // Step 1: P2P metadata search first
        if (localApiBaseUrl != null) {
            val hits = localMetaClient.searchMeta(kind = kind, query = cleanTitle, limit = 8)
            val targetFold = fold(cleanTitle)
            val best = hits.firstOrNull { extractImdbId(it.id) != null && fold(it.title) == targetFold }
                ?: hits.firstOrNull { extractImdbId(it.id) != null }
            val tt = best?.let { extractImdbId(it.id) }
            if (tt != null) {
                val posterUrl = resolveLocalArtUrl(best.posterUrl, best.posterHash)
                if (posterUrl.isNotBlank()) imdbPosterUrlCache[tt] = posterUrl
                if (best.thumbHash.isNotBlank()) {
                    ThumbHash.rememberThumbHash("imdb:$tt", best.thumbHash)
                    ThumbHash.rememberThumbHash(tt, best.thumbHash)
                    if (posterUrl.isNotBlank()) ThumbHash.rememberThumbHash(posterUrl, best.thumbHash)
                }
                titleImdbCache[key] = tt
                return@withContext tt
            }
        }

        // Step 2: Fail closed when Private Routing or P2P-only metadata is active
        if (failClosedMeta) return@withContext null

        val diskDir = ExternalImageCache.diskDirectory()
        val idFile = diskDir?.let { File(it, "imdb_${ExternalImageCache.sha256Hex(key)}.id") }
        if (idFile != null && idFile.isFile) {
            val saved = runCatching { idFile.readText(Charsets.UTF_8).trim() }.getOrNull()
            if (saved != null) {
                titleImdbCache[key] = saved
                return@withContext saved.takeIf { it.isNotEmpty() }
            }
        }
        val encoded = URLEncoder.encode(cleanTitle, "UTF-8").replace("+", "%20")
        val body = httpGetText(
            url = "https://v3-cinemeta.strem.io/catalog/$kind/top/search=$encoded.json",
            headers = mapOf("Accept" to "application/json"),
        ) ?: return@withContext null

        val resolved = parseCinemetaSearchBestImdb(body, cleanTitle).orEmpty()
        titleImdbCache[key] = resolved
        if (idFile != null) {
            runCatching {
                idFile.parentFile?.mkdirs()
                idFile.writeText(resolved, Charsets.UTF_8)
            }
        }
        resolved.takeIf { it.isNotEmpty() }
    }

    suspend fun loadTitleMeta(imdb: String?, isSeries: Boolean): CinemaTitleMeta? = withContext(Dispatchers.IO) {
        val tt = extractImdbId(imdb) ?: return@withContext null
        val kind = if (isSeries) "series" else "movie"
        val cacheKey = "$kind:$tt"
        titleMetaCache[cacheKey]?.let { return@withContext it }

        // Step 1: Query local P2P metadata card & detail first
        if (localApiBaseUrl != null) {
            val canonicalId = "imdb:$tt"
            val (card, detail) = coroutineScope {
                val c = async { localMetaClient.getMetaCard(canonicalId) }
                val d = async { localMetaClient.getMetaDetail(canonicalId) }
                c.await() to d.await()
            }
            if (card != null || detail != null) {
                val posterUrl = resolveLocalArtUrl(card?.posterUrl, card?.posterHash.orEmpty())
                    .ifBlank { if (failClosedMeta) "" else "https://images.metahub.space/poster/medium/$tt/img" }
                val backdropUrl = resolveLocalArtUrl(detail?.backdropUrl ?: card?.backdropUrl, detail?.backdropHash?.ifBlank { card?.backdropHash.orEmpty() } ?: card?.backdropHash.orEmpty())
                    .ifBlank { if (failClosedMeta) "" else "https://images.metahub.space/background/medium/$tt/img" }
                if (card != null) {
                    rememberCardArtAndThumb(card, posterUrl, backdropUrl)
                } else if (backdropUrl.isNotBlank()) {
                    imdbBackdropUrlCache[tt] = backdropUrl
                }
                val episodes = LinkedHashMap<Pair<Int, Int>, CinemaEpisodeMeta>()
                for (item in detail?.items.orEmpty()) {
                    val s = item.season ?: continue
                    val e = item.number ?: continue
                    if (s <= 0 || e <= 0) continue
                    episodes[s to e] = CinemaEpisodeMeta(
                        season = s,
                        episode = e,
                        name = item.label,
                        overview = "",
                        thumbnailUrl = if (failClosedMeta) "" else "https://episodes.metahub.space/$tt/$s/$e/w780.jpg",
                    )
                }
                val rating = card?.ratingX10?.let { "%.1f".format(Locale.ROOT, it / 10.0) }.orEmpty()
                val runtime = card?.runtimeMin?.let { formatCinemaRuntime("$it min") }.orEmpty()
                val meta = CinemaTitleMeta(
                    imdbId = tt,
                    kind = card?.kind?.takeIf { it.isNotBlank() } ?: kind,
                    title = card?.title.orEmpty(),
                    year = card?.year?.toString().orEmpty(),
                    rating = rating,
                    runtime = runtime,
                    genres = card?.genres.orEmpty(),
                    description = detail?.synopsis?.ifBlank { card?.subtitle.orEmpty() } ?: card?.subtitle.orEmpty(),
                    cast = detail?.cast.orEmpty(),
                    posterUrl = posterUrl,
                    backdropUrl = backdropUrl,
                    episodes = episodes,
                )
                titleMetaCache[cacheKey] = meta
                return@withContext meta
            }
        }

        // Step 2: Privacy fail-closed — zero clearnet Cinemeta/Metahub calls
        if (failClosedMeta) return@withContext null

        // Step 3: Clearnet fallback (disk cache + Cinemeta)
        val diskDir = ExternalImageCache.diskDirectory()
        val metaFile = diskDir?.let { File(it, "meta_${kind}_${tt}.json") }
        if (metaFile != null && metaFile.isFile && metaFile.length() > 0L) {
            val savedText = runCatching { metaFile.readText(Charsets.UTF_8) }.getOrNull()
            val fromDisk = savedText?.let { parseCinemetaTitleMeta(it, tt, kind) }
            if (fromDisk != null) {
                titleMetaCache[cacheKey] = fromDisk
                return@withContext fromDisk
            } else {
                runCatching { metaFile.delete() }
            }
        }

        val body = httpGetText(
            url = "https://v3-cinemeta.strem.io/meta/$kind/$tt.json",
            headers = mapOf("Accept" to "application/json"),
        ) ?: return@withContext null

        val parsed = parseCinemetaTitleMeta(body, tt, kind) ?: return@withContext null
        titleMetaCache[cacheKey] = parsed
        if (metaFile != null) {
            runCatching {
                metaFile.parentFile?.mkdirs()
                val tmp = File(metaFile.parentFile, "${metaFile.name}.tmp")
                tmp.writeText(body, Charsets.UTF_8)
                if (!tmp.renameTo(metaFile)) tmp.delete()
            }
        }
        parsed
    }

    private fun cinemaGenreToSlugs(genre: String): List<String> {
        val lower = genre.trim().lowercase(Locale.ROOT)
        return when (lower) {
            "", "popular" -> listOf("popular", "top")
            "top rated", "top-rated" -> listOf("top-rated", "top_rated")
            else -> {
                val slug = lower.replace(Regex("[^a-z0-9]+"), "-").trim('-')
                if (slug.isEmpty()) listOf("popular") else listOf("genre/$slug", slug, "popular/$slug")
            }
        }
    }

    private suspend fun fetchLocalMetaListForSlugs(kind: String, slugs: List<String>): MetaList? {
        for (slug in slugs) {
            val list = localMetaClient.getMetaList(kind, slug)
            if (list != null && list.cards.isNotEmpty()) return list
        }
        return null
    }

    private fun metaCardToCinemaDiscoverItem(card: MetaCard, fallbackKind: String): CinemaDiscoverItem {
        val tt = extractImdbId(card.id) ?: card.id
        val posterUrl = resolveLocalArtUrl(card.posterUrl, card.posterHash)
            .ifBlank { if (failClosedMeta || !tt.startsWith("tt")) "" else "https://images.metahub.space/poster/medium/$tt/img" }
        val backdropUrl = resolveLocalArtUrl(card.backdropUrl, card.backdropHash)
            .ifBlank { if (failClosedMeta || !tt.startsWith("tt")) "" else "https://images.metahub.space/background/medium/$tt/img" }
        rememberCardArtAndThumb(card, posterUrl, backdropUrl)
        return CinemaDiscoverItem(
            imdbId = tt,
            kind = card.kind.ifBlank { fallbackKind },
            title = card.title,
            year = card.year?.toString().orEmpty(),
            rating = card.ratingX10?.let { "%.1f".format(Locale.ROOT, it / 10.0) }.orEmpty(),
            runtime = card.runtimeMin?.let { formatCinemaRuntime("$it min") }.orEmpty(),
            genres = card.genres,
            description = card.subtitle,
            posterUrl = posterUrl,
            backdropUrl = backdropUrl,
            cast = emptyList(),
        )
    }

    suspend fun discoverCinema(genre: String = "Popular"): CinemaDiscoverData = withContext(Dispatchers.IO) {
        val normGenre = genre.trim().ifBlank { "Popular" }
        cinemaDiscoverCache[normGenre]?.let { return@withContext it }

        // Step 1: Query local P2P metadata lists first
        if (localApiBaseUrl != null) {
            val slugs = cinemaGenreToSlugs(normGenre)
            val (movieList, seriesList) = coroutineScope {
                val m = async { fetchLocalMetaListForSlugs("movie", slugs) }
                val s = async { fetchLocalMetaListForSlugs("series", slugs) }
                m.await() to s.await()
            }
            val p2pMovies = movieList?.cards.orEmpty()
                .filter { it.title.isNotBlank() }
                .map { metaCardToCinemaDiscoverItem(it, "movie") }
            val p2pSeries = seriesList?.cards.orEmpty()
                .filter { it.title.isNotBlank() }
                .map { metaCardToCinemaDiscoverItem(it, "series") }
            if (p2pMovies.isNotEmpty() || p2pSeries.isNotEmpty()) {
                val data = CinemaDiscoverData(genre = normGenre, movies = p2pMovies, series = p2pSeries)
                cinemaDiscoverCache[normGenre] = data
                return@withContext data
            }
        }

        // Step 2: Fail closed with zero clearnet calls
        if (failClosedMeta) return@withContext CinemaDiscoverData(genre = normGenre)

        // Step 3: Clearnet fallback (disk cache + Cinemeta catalog)
        val diskDir = ExternalImageCache.diskDirectory()
        val diskKey = ExternalImageCache.sha256Hex(normGenre.lowercase(Locale.ROOT))
        val movieFile = diskDir?.let { File(it, "cinema_movie_${diskKey}.json") }
        val seriesFile = diskDir?.let { File(it, "cinema_series_${diskKey}.json") }
        val now = System.currentTimeMillis()
        if (movieFile != null && seriesFile != null &&
            movieFile.isFile && seriesFile.isFile &&
            now - movieFile.lastModified() < CINEMA_DISCOVER_DISK_TTL_MS &&
            now - seriesFile.lastModified() < CINEMA_DISCOVER_DISK_TTL_MS
        ) {
            val mText = runCatching { movieFile.readText(Charsets.UTF_8) }.getOrNull()
            val sText = runCatching { seriesFile.readText(Charsets.UTF_8) }.getOrNull()
            if (!mText.isNullOrBlank() && !sText.isNullOrBlank()) {
                val movies = parseCinemetaCatalog(mText, "movie")
                val series = parseCinemetaCatalog(sText, "series")
                if (movies.isNotEmpty() || series.isNotEmpty()) {
                    val data = CinemaDiscoverData(genre = normGenre, movies = movies, series = series)
                    cinemaDiscoverCache[normGenre] = data
                    return@withContext data
                }
            }
        }

        val isPopular = normGenre.equals("Popular", ignoreCase = true)
        val isTopRated = normGenre.equals("Top Rated", ignoreCase = true)
        val encodedGenre = URLEncoder.encode(normGenre, "UTF-8").replace("+", "%20")
        val moviesUrl = when {
            isPopular -> "https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json"
            isTopRated -> "https://cinemeta-catalogs.strem.io/imdbRating/catalog/movie/imdbRating.json"
            else -> "https://cinemeta-catalogs.strem.io/top/catalog/movie/top/genre=$encodedGenre.json"
        }
        val seriesUrl = when {
            isPopular -> "https://cinemeta-catalogs.strem.io/top/catalog/series/top.json"
            isTopRated -> "https://cinemeta-catalogs.strem.io/imdbRating/catalog/series/imdbRating.json"
            else -> "https://cinemeta-catalogs.strem.io/top/catalog/series/top/genre=$encodedGenre.json"
        }

        val (moviesBody, seriesBody) = coroutineScope {
            val m = async { httpGetText(moviesUrl, mapOf("Accept" to "application/json")) }
            val s = async { httpGetText(seriesUrl, mapOf("Accept" to "application/json")) }
            m.await() to s.await()
        }

        val movies = moviesBody?.let { parseCinemetaCatalog(it, "movie") }.orEmpty()
        val series = seriesBody?.let { parseCinemetaCatalog(it, "series") }.orEmpty()
        val data = CinemaDiscoverData(genre = normGenre, movies = movies, series = series)
        if (movies.isNotEmpty() || series.isNotEmpty()) {
            cinemaDiscoverCache[normGenre] = data
            if (movieFile != null && !moviesBody.isNullOrBlank()) {
                runCatching {
                    movieFile.parentFile?.mkdirs()
                    movieFile.writeText(moviesBody, Charsets.UTF_8)
                }
            }
            if (seriesFile != null && !seriesBody.isNullOrBlank()) {
                runCatching {
                    seriesFile.parentFile?.mkdirs()
                    seriesFile.writeText(seriesBody, Charsets.UTF_8)
                }
            }
        }
        data
    }

    suspend fun fetchFeaturedCreators(): List<CreatorSuggestion> = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext emptyList()
        cachedFeaturedCreators?.let { return@withContext it }
        val resolved = coroutineScope {
            FEATURED_CREATORS.map { fallback ->
                async {
                    val handle = fallback.handle.removePrefix("@").trim()
                    val direct = if (handle.isNotEmpty()) fetchDirectYouTubeHandle(handle) else null
                    val live = if (direct != null && direct.avatarUrl.isNotBlank()) {
                        direct
                    } else if (handle.isNotEmpty()) {
                        fetchYouTubeChannelSearch("@$handle").firstOrNull { cand ->
                            cand.handle.removePrefix("@").equals(handle, ignoreCase = true) && cand.avatarUrl.isNotBlank()
                        } ?: fetchYouTubeChannelSearch("@$handle").firstOrNull { it.avatarUrl.isNotBlank() }
                            ?: direct
                    } else {
                        null
                    }
                    if (live != null) {
                        live.copy(
                            name = fallback.name.ifBlank { live.name },
                            subscribers = live.subscribers.ifBlank { fallback.subscribers },
                            avatarUrl = live.avatarUrl.ifBlank { fallback.avatarUrl },
                        )
                    } else {
                        fallback
                    }
                }
            }.awaitAll()
        }
        if (resolved.any { it.avatarUrl.isNotBlank() }) {
            cachedFeaturedCreators = resolved
        }
        resolved
    }

    suspend fun discoverYouTubeVideos(topic: String = "Featured"): List<ExternalVideoPick> = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext emptyList()
        val normTopic = topic.trim().ifBlank { "Featured" }
        val cacheKey = normTopic.lowercase(Locale.ROOT)
        val now = System.currentTimeMillis()
        externalVideosCache[cacheKey]?.let { (cachedAt, cachedList) ->
            if (now - cachedAt < EXTERNAL_VIDEOS_TTL_MS && cachedList.isNotEmpty()) {
                return@withContext cachedList
            }
        }

        val searchQuery = when (cacheKey) {
            "featured" -> "video essay cinema science tech documentary"
            "documentaries" -> "full documentary science history nature"
            "tech" -> "tech review engineering deep dive"
            "science" -> "science physics space explained"
            "film essays" -> "film essay cinematography analysis"
            "podcasts" -> "podcast interview longform conversation"
            "gaming" -> "game design retrospective documentary"
            else -> normTopic
        }

        val encoded = URLEncoder.encode(searchQuery, "UTF-8")
        val html = httpGetText(
            url = "https://www.youtube.com/results?search_query=$encoded&sp=EgIQAQ%3D%3D",
            headers = mapOf(
                "User-Agent" to USER_AGENT,
                "Accept-Language" to "en-US,en;q=0.9",
                "Cookie" to YT_CONSENT_COOKIE,
            ),
        ) ?: return@withContext emptyList()

        val json = extractYtInitialData(html) ?: return@withContext emptyList()
        val parsed = parseYouTubeVideoSearch(json)
        if (parsed.isNotEmpty()) {
            externalVideosCache[cacheKey] = System.currentTimeMillis() to parsed
        }
        parsed
    }

    suspend fun resolveYouTubeAudioStream(videoId: String): ResolvedAudioStream? = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext null
        val cleanId = videoId.trim()
        if (cleanId.isEmpty()) return@withContext null
        val now = System.currentTimeMillis()
        resolvedAudioCache[cleanId]?.let { (ts, cached) ->
            if (now - ts < RESOLVED_AUDIO_TTL_MS) return@withContext cached
        }
        // Match ubit's primary client: VISIONOS 1.02 + watch-page VISITOR_DATA requires no GVS PO token
        // so full-track Range requests succeed from start to tail without 403s past 1 MiB.
        val visitorData = fetchYouTubeVisitorData(cleanId)
        val visionClient = JSONObject()
            .put("clientName", "VISIONOS")
            .put("clientVersion", "1.02")
            .put("hl", "en")
            .put("gl", "US")
            .put("userAgent", YT_VISIONOS_USER_AGENT)
            .put("deviceMake", "Apple")
            .put("deviceModel", "RealityDevice17,1")
            .put("osName", "visionOS")
            .put("osVersion", "26.5.23O471")
            .apply {
                if (visitorData.isNotEmpty()) put("visitorData", visitorData)
            }
        val visionPayload = JSONObject()
            .put("videoId", cleanId)
            .put("contentCheckOk", true)
            .put("racyCheckOk", true)
            .put("context", JSONObject().put("client", visionClient))
        val visionHeaders = LinkedHashMap<String, String>().apply {
            put("Content-Type", "application/json")
            put("User-Agent", YT_VISIONOS_USER_AGENT)
            put("X-YouTube-Client-Name", "101")
            put("X-YouTube-Client-Version", "1.02")
            put("Origin", "https://www.youtube.com")
            if (visitorData.isNotEmpty()) put("X-Goog-Visitor-Id", visitorData)
        }
        val visionBody = httpPostText(
            url = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            body = visionPayload.toString(),
            headers = visionHeaders,
        )
        val visionResolved = visionBody?.let { parseYouTubeAudioStream(it, cleanId, YT_VISIONOS_USER_AGENT) }
        if (visionResolved != null) {
            resolvedAudioCache[cleanId] = System.currentTimeMillis() to visionResolved
            return@withContext visionResolved
        }

        // Fallback to IOS if VISIONOS is unavailable for a specific video.
        val iosPayload = JSONObject()
            .put("videoId", cleanId)
            .put("contentCheckOk", true)
            .put("racyCheckOk", true)
            .put(
                "context",
                JSONObject().put(
                    "client",
                    JSONObject()
                        .put("clientName", "IOS")
                        .put("clientVersion", "20.10.4")
                        .put("hl", "en")
                        .put("gl", "US")
                        .apply {
                            if (visitorData.isNotEmpty()) put("visitorData", visitorData)
                        },
                ),
            )
        val iosBody = httpPostText(
            url = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            body = iosPayload.toString(),
            headers = mapOf(
                "Content-Type" to "application/json",
                "User-Agent" to YT_IOS_USER_AGENT,
            ),
        ) ?: return@withContext null
        val iosResolved = parseYouTubeAudioStream(iosBody, cleanId, YT_IOS_USER_AGENT) ?: return@withContext null
        resolvedAudioCache[cleanId] = System.currentTimeMillis() to iosResolved
        iosResolved
    }

    private fun fetchYouTubeVisitorData(videoId: String): String {
        val now = System.currentTimeMillis()
        cachedVisitorData?.let { (ts, vd) ->
            if (now - ts < VISITOR_DATA_TTL_MS && vd.isNotEmpty()) return vd
        }
        val watchHtml = httpGetText(
            url = "https://www.youtube.com/watch?v=$videoId&bpctr=9999999999&has_verified=1",
            headers = mapOf(
                "User-Agent" to USER_AGENT,
                "Accept-Language" to "en-US,en;q=0.9",
                "Cookie" to YT_CONSENT_COOKIE,
            ),
        )
        val fromWatch = watchHtml?.let { extractVisitorData(it) }.orEmpty()
        if (fromWatch.isNotEmpty()) {
            cachedVisitorData = now to fromWatch
            return fromWatch
        }
        val sw = httpGetText(
            url = "https://www.youtube.com/sw.js_data",
            headers = mapOf("User-Agent" to USER_AGENT),
        )
        val fromSw = sw?.let { SW_VISITOR_DATA_RE.find(it)?.groupValues?.getOrNull(1) }.orEmpty()
        if (fromSw.isNotEmpty()) {
            cachedVisitorData = now to fromSw
        }
        return fromSw
    }

    internal fun extractVisitorData(html: String): String {
        return VISITOR_DATA_RE.find(html)?.groupValues?.getOrNull(1)?.trim().orEmpty()
    }

    suspend fun resolveFullSongStream(artist: String, title: String): ResolvedAudioStream? = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext null
        val cleanArtist = artist.trim()
        val cleanTitle = title.trim()
        if (cleanArtist.isEmpty() && cleanTitle.isEmpty()) return@withContext null
        val cacheKey = "${cleanArtist.lowercase(Locale.ROOT)}|${cleanTitle.lowercase(Locale.ROOT)}"
        val now = System.currentTimeMillis()
        resolvedAudioCache[cacheKey]?.let { (ts, cached) ->
            if (now - ts < RESOLVED_AUDIO_TTL_MS) return@withContext cached
        }
        val baseQuery = listOf(cleanArtist, cleanTitle).filter { it.isNotEmpty() }.joinToString(" ")
        val candidates = discoverYouTubeVideos("$baseQuery official audio").ifEmpty {
            discoverYouTubeVideos(baseQuery)
        }
        val pick = candidates.firstOrNull { (parseDurationTextSeconds(it.durationText) ?: 0) >= 60 }
            ?: candidates.firstOrNull()
            ?: return@withContext null
        val resolved = resolveYouTubeAudioStream(pick.videoId) ?: return@withContext null
        resolvedAudioCache[cacheKey] = System.currentTimeMillis() to resolved
        resolved
    }

    /**
     * Fetches YouTube Music's curated RDAMVM Up Next radio queue for infinite playback (matching RiPlay/RiMusic).
     * Resolves a seed videoId from artist+title when the currently playing track is a local library file.
     */
    suspend fun fetchRadioNext(
        seedVideoId: String?,
        artist: String,
        title: String,
        excludeVideoIds: Set<String> = emptySet(),
        limit: Int = 14,
    ): List<RadioTrackSuggestion> = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext emptyList()
        val seedId = seedVideoId?.trim()?.takeIf { it.length == 11 } ?: run {
            val baseQuery = listOf(artist.trim(), title.trim()).filter { it.isNotEmpty() }.joinToString(" ")
            if (baseQuery.length < 2) return@withContext emptyList()
            val candidates = discoverYouTubeVideos("$baseQuery official audio").ifEmpty {
                discoverYouTubeVideos(baseQuery)
            }
            val pick = candidates.firstOrNull { (parseDurationTextSeconds(it.durationText) ?: 0) in 60..900 }
                ?: candidates.firstOrNull()
            pick?.videoId?.trim().orEmpty()
        }
        if (seedId.length != 11) return@withContext emptyList()

        val now = System.currentTimeMillis()
        val rawList = radioNextCache[seedId]?.takeIf { now - it.first < RADIO_NEXT_TTL_MS }?.second ?: run {
            val payload = JSONObject()
                .put("videoId", seedId)
                .put("playlistId", "RDAMVM$seedId")
                .put("isAudioOnly", true)
                .put(
                    "context",
                    JSONObject().put(
                        "client",
                        JSONObject()
                            .put("clientName", "WEB_REMIX")
                            .put("clientVersion", "1.20250301.01.00")
                            .put("hl", "en")
                            .put("gl", "US"),
                    ),
                )
            val body = httpPostText(
                url = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false",
                body = payload.toString(),
                headers = mapOf(
                    "Content-Type" to "application/json",
                    "User-Agent" to USER_AGENT,
                    "Origin" to "https://music.youtube.com",
                ),
            ) ?: return@withContext emptyList()
            val parsed = parseYouTubeRadioNext(body, excludeVideoIds = setOf(seedId), limit = 30)
            if (parsed.isNotEmpty()) {
                radioNextCache[seedId] = System.currentTimeMillis() to parsed
            }
            parsed
        }
        val excluded = excludeVideoIds + seedId
        rawList.filter { it.videoId !in excluded }.take(limit)
    }

    internal fun parseYouTubeRadioNext(
        body: String,
        excludeVideoIds: Set<String> = emptySet(),
        limit: Int = 20,
    ): List<RadioTrackSuggestion> {
        return try {
            val root = JSONObject(body)
            val out = ArrayList<RadioTrackSuggestion>()
            val seen = HashSet<String>(excludeVideoIds)
            collectRadioRenderers(root, out, seen, limit)
            out
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            emptyList()
        }
    }

    private fun collectRadioRenderers(
        node: Any?,
        out: MutableList<RadioTrackSuggestion>,
        seen: MutableSet<String>,
        limit: Int,
    ) {
        if (node == null || out.size >= limit) return
        when (node) {
            is JSONObject -> {
                val renderer = node.optJSONObject("playlistPanelVideoRenderer")
                if (renderer != null) {
                    parseRadioRenderer(renderer)?.let { track ->
                        if (seen.add(track.videoId)) {
                            out.add(track)
                        }
                    }
                    if (out.size >= limit) return
                }
                val keys = node.keys()
                while (keys.hasNext() && out.size < limit) {
                    val key = keys.next()
                    if (key == "playlistPanelVideoRenderer") continue
                    collectRadioRenderers(node.opt(key), out, seen, limit)
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    if (out.size >= limit) break
                    collectRadioRenderers(node.opt(i), out, seen, limit)
                }
            }
        }
    }

    private fun parseRadioRenderer(r: JSONObject): RadioTrackSuggestion? {
        val videoId = r.optString("videoId").trim()
        if (videoId.length != 11) return null
        val rawTitle = readYtText(r.optJSONObject("title")).trim()
        if (rawTitle.isEmpty()) return null
        val durationText = readYtText(r.optJSONObject("lengthText")).trim()
        val durationSecs = parseDurationTextSeconds(durationText) ?: return null
        // Skip very short bumpers or hour-long full-album compilations in radio autoplay.
        if (durationSecs < 45 || durationSecs > 1200) return null

        val shortByline = readYtText(r.optJSONObject("shortBylineText")).trim()
        val longRuns = r.optJSONObject("longBylineText")?.optJSONArray("runs")
        var artist = shortByline
        var album = ""
        if (longRuns != null) {
            for (i in 0 until longRuns.length()) {
                val run = longRuns.optJSONObject(i) ?: continue
                val text = run.optString("text").trim()
                if (text.isEmpty() || text == "•" || text == "·" || text == "&" || text == ",") continue
                val pageType = run.optJSONObject("navigationEndpoint")
                    ?.optJSONObject("browseEndpoint")
                    ?.optJSONObject("browseEndpointContextSupportedConfigs")
                    ?.optJSONObject("browseEndpointContextMusicConfig")
                    ?.optString("pageType")
                    .orEmpty()
                if (artist.isEmpty() && (pageType.contains("ARTIST") || i == 0)) {
                    artist = text
                } else if (album.isEmpty() && pageType == "MUSIC_PAGE_TYPE_ALBUM") {
                    album = text
                }
            }
        }
        val cleanedTitle = cleanMediaTitle(rawTitle).ifBlank { rawTitle }
        val cleanedArtist = cleanChannelName(artist.substringBefore(" • ").substringBefore(" · ").trim())
        val rawThumb = lastThumbnailUrl(r.optJSONObject("thumbnail")?.optJSONArray("thumbnails"))
        val upsizedThumb = normalizeThumb(rawThumb).let { url ->
            if (url.contains("lh3.googleusercontent.com")) {
                YT_THUMB_SIZE_RE.replace(url, "=w544-h544-l90-rj")
            } else {
                url.ifBlank { "https://i.ytimg.com/vi/$videoId/hqdefault.jpg" }
            }
        }
        return RadioTrackSuggestion(
            videoId = videoId,
            title = cleanedTitle,
            artist = cleanedArtist,
            album = album,
            durationSecs = durationSecs,
            artUrl = upsizedThumb,
        )
    }

    private fun ytmPost(endpoint: String, payload: JSONObject): String? {
        payload.put(
            "context",
            JSONObject().put(
                "client",
                JSONObject()
                    .put("clientName", "WEB_REMIX")
                    .put("clientVersion", "1.20250301.01.00")
                    .put("hl", "en")
                    .put("gl", "US"),
            ),
        )
        return httpPostText(
            url = "https://music.youtube.com/youtubei/v1/$endpoint?prettyPrint=false",
            body = payload.toString(),
            headers = mapOf(
                "Content-Type" to "application/json",
                "User-Agent" to USER_AGENT,
                "Origin" to "https://music.youtube.com",
            ),
        )
    }

    private fun upsizeYtmThumb(rawUrl: String, fallbackVideoId: String = ""): String {
        val norm = normalizeThumb(rawUrl)
        return when {
            norm.contains("googleusercontent.com") -> YT_THUMB_SIZE_RE.replace(norm, "=w544-h544-l90-rj")
            norm.isNotEmpty() -> norm
            fallbackVideoId.length == 11 -> "https://i.ytimg.com/vi/$fallbackVideoId/hqdefault.jpg"
            else -> ""
        }
    }

    /**
     * Resolves canonical album metadata (album name, browseId, year, track number, high-res art)
     * for a streaming song when the search/source row omitted its album.
     */
    suspend fun resolveTrackAlbumMeta(
        videoId: String?,
        artist: String,
        title: String,
        albumBrowseId: String = "",
    ): ResolvedTrackAlbumMeta? = withContext(Dispatchers.IO) {
        val cleanVid = videoId?.trim().orEmpty()
        val cleanArtist = artist.trim()
        val cleanTitle = title.trim()
        val cleanBrowseId = albumBrowseId.trim()
        val cacheKey = when {
            cleanVid.length == 11 -> "vid:$cleanVid"
            cleanBrowseId.isNotEmpty() -> "bid:$cleanBrowseId|${fold(cleanTitle)}"
            else -> "sig:${fold(cleanArtist)}|${fold(cleanTitle)}"
        }
        val now = System.currentTimeMillis()
        trackAlbumMetaCache[cacheKey]?.let { (ts, cached) ->
            if (now - ts < YTM_CACHE_TTL_MS) return@withContext cached
        }

        // Step 1: Query local P2P metadata first whenever loopback API is configured
        if (localApiBaseUrl != null) {
            val term = listOf(extractPrimaryArtist(cleanArtist), cleanTitle)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (term.length >= 2) {
                val hits = localMetaClient.searchMeta(kind = "album", query = term, limit = 6)
                val first = hits.firstOrNull { it.title.isNotBlank() }
                if (first != null) {
                    val artUrl = resolveLocalArtUrl(first.posterUrl, first.posterHash)
                    if (first.thumbHash.isNotBlank()) {
                        ThumbHash.rememberThumbHash(first.id, first.thumbHash)
                        if (artUrl.isNotBlank()) ThumbHash.rememberThumbHash(artUrl, first.thumbHash)
                    }
                    val localResolved = ResolvedTrackAlbumMeta(
                        album = first.title,
                        albumBrowseId = first.id,
                        artist = first.subtitle.ifBlank { cleanArtist },
                        year = first.year?.toString().orEmpty(),
                        artUrl = artUrl,
                    )
                    trackAlbumMetaCache[cacheKey] = System.currentTimeMillis() to localResolved
                    if (artUrl.isNotBlank()) {
                        rememberAlbumArtUrl(localResolved.artist, localResolved.album, artUrl)
                    }
                    return@withContext localResolved
                }
            }
        }

        // Step 2: Fail closed with zero clearnet calls
        if (failClosedMeta) return@withContext null

        var resolved: ResolvedTrackAlbumMeta? = null
        if (cleanVid.length == 11) {
            val nextBody = ytmPost(
                "next",
                JSONObject()
                    .put("videoId", cleanVid)
                    .put("isAudioOnly", true),
            )
            if (nextBody != null) {
                resolved = parseYtmNextTrackMeta(nextBody, cleanVid)
            }
        }

        val targetBrowseId = resolved?.albumBrowseId?.takeIf { it.isNotBlank() } ?: cleanBrowseId
        val needsAlbumTitle = resolved?.album.isNullOrBlank() ||
            resolved?.album.equals(cleanTitle, ignoreCase = true)
        if (targetBrowseId.isNotEmpty() && (needsAlbumTitle || resolved?.trackNumber == null)) {
            val albumPage = loadYtmAlbum(
                browseId = targetBrowseId,
                artist = resolved?.artist?.ifBlank { cleanArtist } ?: cleanArtist,
                albumTitle = resolved?.album.orEmpty(),
            )
            if (albumPage != null) {
                val trackIdx = albumPage.tracks.indexOfFirst { t ->
                    (cleanVid.length == 11 && t.videoId == cleanVid) ||
                        (cleanTitle.isNotBlank() && fold(t.title) == fold(cleanTitle))
                }.takeIf { it >= 0 }?.plus(1)
                resolved = ResolvedTrackAlbumMeta(
                    album = albumPage.title.ifBlank { resolved?.album.orEmpty() },
                    albumBrowseId = albumPage.browseId.ifBlank { targetBrowseId },
                    artist = albumPage.artist.ifBlank { resolved?.artist.orEmpty() }.ifBlank { cleanArtist },
                    year = albumPage.year.ifBlank { resolved?.year.orEmpty() },
                    artUrl = albumPage.artUrl.ifBlank { resolved?.artUrl.orEmpty() },
                    trackNumber = trackIdx ?: resolved?.trackNumber,
                )
            }
        }

        if (resolved == null || resolved.album.isBlank()) {
            val term = listOf(extractPrimaryArtist(cleanArtist), cleanTitle)
                .filter { it.isNotBlank() }
                .joinToString(" ")
            if (term.length >= 2) {
                val encoded = URLEncoder.encode(term, "UTF-8")
                val body = httpGetText(
                    url = "https://itunes.apple.com/search?term=$encoded&media=music&entity=song&limit=6",
                    headers = mapOf("Accept" to "application/json"),
                )
                val fromItunes = body?.let { parseItunesTrackAlbumMeta(it, cleanArtist, cleanTitle) }
                if (fromItunes != null && fromItunes.album.isNotBlank()) {
                    resolved = ResolvedTrackAlbumMeta(
                        album = resolved?.album?.takeIf { it.isNotBlank() } ?: fromItunes.album,
                        albumBrowseId = resolved?.albumBrowseId.orEmpty(),
                        artist = resolved?.artist?.takeIf { it.isNotBlank() } ?: fromItunes.artist,
                        year = resolved?.year?.takeIf { it.isNotBlank() } ?: fromItunes.year,
                        artUrl = resolved?.artUrl?.takeIf { it.isNotBlank() } ?: fromItunes.artUrl,
                        trackNumber = resolved?.trackNumber ?: fromItunes.trackNumber,
                    )
                }
            }
        }

        if (resolved != null && (resolved.album.isNotBlank() || resolved.artUrl.isNotBlank())) {
            trackAlbumMetaCache[cacheKey] = System.currentTimeMillis() to resolved
            if (resolved.album.isNotBlank() && resolved.artUrl.isNotBlank()) {
                rememberAlbumArtUrl(resolved.artist.ifBlank { cleanArtist }, resolved.album, resolved.artUrl)
            }
        }
        resolved
    }

    internal fun parseYtmNextTrackMeta(body: String, targetVideoId: String): ResolvedTrackAlbumMeta? {
        return try {
            val root = JSONObject(body)
            var matched: ResolvedTrackAlbumMeta? = null
            var firstAny: ResolvedTrackAlbumMeta? = null
            fun walk(node: Any?) {
                if (matched != null || node == null) return
                when (node) {
                    is JSONObject -> {
                        val r = node.optJSONObject("playlistPanelVideoRenderer")
                        if (r != null) {
                            val vid = r.optString("videoId").trim()
                            val runs = r.optJSONObject("longBylineText")?.optJSONArray("runs")
                            var artist = ""
                            var album = ""
                            var albumBrowseId = ""
                            var year = ""
                            if (runs != null) {
                                for (i in 0 until runs.length()) {
                                    val run = runs.optJSONObject(i) ?: continue
                                    val text = run.optString("text").trim()
                                    if (text.isEmpty() || text == "•" || text == "·" || text == "&" || text == ",") continue
                                    val be = run.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")
                                    val bid = be?.optString("browseId").orEmpty().trim()
                                    val pt = be?.optJSONObject("browseEndpointContextSupportedConfigs")
                                        ?.optJSONObject("browseEndpointContextMusicConfig")
                                        ?.optString("pageType")
                                        .orEmpty()
                                    when {
                                        pt == "MUSIC_PAGE_TYPE_ARTIST" && artist.isEmpty() -> artist = text
                                        pt == "MUSIC_PAGE_TYPE_ALBUM" && album.isEmpty() -> {
                                            album = text
                                            albumBrowseId = bid
                                        }
                                        YEAR_FOUR_RE.matches(text) && year.isEmpty() -> year = text
                                        artist.isEmpty() && i == 0 -> artist = text
                                    }
                                }
                            }
                            if (artist.isEmpty()) {
                                artist = readYtText(r.optJSONObject("shortBylineText")).trim()
                            }
                            val thumb = upsizeYtmThumb(
                                lastThumbnailUrl(r.optJSONObject("thumbnail")?.optJSONArray("thumbnails")),
                                fallbackVideoId = vid,
                            )
                            val candidate = ResolvedTrackAlbumMeta(
                                album = album.trim(),
                                albumBrowseId = albumBrowseId,
                                artist = cleanChannelName(artist.substringBefore(" • ").substringBefore(" · ").trim()),
                                year = year,
                                artUrl = thumb,
                            )
                            if (firstAny == null) firstAny = candidate
                            if (targetVideoId.isEmpty() || vid == targetVideoId) {
                                matched = candidate
                            }
                            return
                        }
                        val keys = node.keys()
                        while (keys.hasNext() && matched == null) {
                            val key = keys.next()
                            if (key == "playlistPanelVideoRenderer") continue
                            walk(node.opt(key))
                        }
                    }
                    is JSONArray -> {
                        for (i in 0 until node.length()) {
                            if (matched != null) break
                            walk(node.opt(i))
                        }
                    }
                }
            }
            walk(root)
            matched ?: firstAny
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun parseItunesTrackAlbumMeta(
        body: String,
        artist: String,
        title: String,
    ): ResolvedTrackAlbumMeta? {
        return try {
            val root = JSONObject(body)
            val arr = root.optJSONArray("results") ?: return null
            val targetTitle = fold(title)
            val targetArtist = fold(extractPrimaryArtist(artist))
            var bestScore = Int.MIN_VALUE
            var best: ResolvedTrackAlbumMeta? = null
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val col = obj.optString("collectionName").trim()
                val trk = obj.optString("trackName").trim()
                val art = obj.optString("artistName").trim()
                if (col.isEmpty() || trk.isEmpty()) continue
                val fCol = fold(col)
                val fTrk = fold(trk)
                val fArt = fold(art)
                var score = 0
                when {
                    targetTitle.isNotEmpty() && fTrk == targetTitle -> score += 60
                    targetTitle.isNotEmpty() && (fTrk.contains(targetTitle) || targetTitle.contains(fTrk)) -> score += 30
                    targetTitle.isNotEmpty() -> score -= 40
                }
                when {
                    targetArtist.isNotEmpty() && fArt == targetArtist -> score += 50
                    targetArtist.isNotEmpty() && (fArt.contains(targetArtist) || targetArtist.contains(fArt)) -> score += 25
                    targetArtist.isNotEmpty() -> score -= 50
                }
                if (col.endsWith(" - Single", ignoreCase = true) || fCol == fTrk) score -= 10
                if (fCol.contains("karaoke") || fCol.contains("tribute") || fCol.contains("instrumental")) score -= 45
                if (score > bestScore && score >= 40) {
                    bestScore = score
                    val release = obj.optString("releaseDate").trim()
                    val yr = if (release.length >= 4 && release.substring(0, 4).all { it.isDigit() }) {
                        release.substring(0, 4)
                    } else {
                        ""
                    }
                    val rawArt = obj.optString("artworkUrl100").ifBlank { obj.optString("artworkUrl60") }
                    val artUrl = upsizeArtworkUrl(rawArt).takeIf { ExternalImageCache.isAllowedUrl(it) }.orEmpty()
                    val trackNo = obj.optInt("trackNumber", 0).takeIf { it > 0 }
                    best = ResolvedTrackAlbumMeta(
                        album = col.removeSuffix(" - Single").removeSuffix(" - EP").trim(),
                        artist = art.ifBlank { artist },
                        year = yr,
                        artUrl = artUrl,
                        trackNumber = trackNo,
                    )
                }
            }
            best
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    suspend fun searchYouTubeMusic(query: String): YtmSearchResult = withContext(Dispatchers.IO) {
        val clean = query.trim()
        if (clean.length < 2) return@withContext YtmSearchResult(query = clean)
        val cacheKey = clean.lowercase(Locale.ROOT)
        val now = System.currentTimeMillis()
        ytmSearchCache[cacheKey]?.let { (ts, cached) ->
            if (now - ts < YTM_CACHE_TTL_MS) return@withContext cached
        }
        // Step 1: Query local P2P metadata first whenever loopback API is configured
        if (localApiBaseUrl != null) {
            val (albumHits, artistHits) = coroutineScope {
                val a = async { localMetaClient.searchMeta(kind = "album", query = clean, limit = 12) }
                val ar = async { localMetaClient.searchMeta(kind = "artist", query = clean, limit = 8) }
                a.await() to ar.await()
            }
            val albums = albumHits.mapNotNull { hit ->
                if (hit.title.isBlank()) return@mapNotNull null
                val artUrl = resolveLocalArtUrl(hit.posterUrl, hit.posterHash)
                if (hit.thumbHash.isNotBlank()) {
                    ThumbHash.rememberThumbHash(hit.id, hit.thumbHash)
                    if (artUrl.isNotBlank()) ThumbHash.rememberThumbHash(artUrl, hit.thumbHash)
                    albumArtCacheKey(hit.subtitle, hit.title)?.let { ThumbHash.rememberThumbHash("alb:$it", hit.thumbHash) }
                }
                if (artUrl.isNotBlank() && hit.subtitle.isNotBlank()) {
                    rememberAlbumArtUrl(hit.subtitle, hit.title, artUrl)
                }
                YtmAlbumSummary(
                    browseId = hit.id,
                    title = hit.title,
                    artist = hit.subtitle,
                    year = hit.year?.toString().orEmpty(),
                    subtitle = hit.subtitle,
                    artUrl = artUrl,
                )
            }
            val artists = artistHits.mapNotNull { hit ->
                if (hit.title.isBlank()) return@mapNotNull null
                val artUrl = resolveLocalArtUrl(hit.posterUrl, hit.posterHash)
                if (hit.thumbHash.isNotBlank()) {
                    ThumbHash.rememberThumbHash(hit.id, hit.thumbHash)
                    if (artUrl.isNotBlank()) ThumbHash.rememberThumbHash(artUrl, hit.thumbHash)
                }
                YtmArtistSummary(
                    browseId = hit.id,
                    name = hit.title,
                    subscribers = hit.subtitle,
                    artUrl = artUrl,
                )
            }
            val res = YtmSearchResult(query = clean, artists = artists, songs = emptyList(), albums = albums)
            if (!res.isEmpty) {
                ytmSearchCache[cacheKey] = System.currentTimeMillis() to res
                return@withContext res
            }
        }
        // Step 2: Fail closed with zero clearnet calls
        if (failClosedMeta) return@withContext YtmSearchResult(query = clean)
        val body = ytmPost("search", JSONObject().put("query", clean))
            ?: return@withContext YtmSearchResult(query = clean)
        val parsed = parseYtmSearch(body, clean)
        if (!parsed.isEmpty) {
            ytmSearchCache[cacheKey] = System.currentTimeMillis() to parsed
        }
        parsed
    }

    suspend fun loadYtmArtist(browseId: String?, artistName: String = ""): YtmArtistPage? = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext null
        val resolvedId = browseId?.trim()?.takeIf { it.isNotEmpty() } ?: run {
            val cleanName = artistName.trim()
            if (cleanName.length < 2) return@withContext null
            val res = searchYouTubeMusic(cleanName)
            val targetFold = fold(cleanName)
            res.artists.firstOrNull { fold(it.name) == targetFold }?.browseId
                ?: res.artists.firstOrNull()?.browseId
                ?: res.songs.firstOrNull { it.artistBrowseId.isNotBlank() }?.artistBrowseId
                .orEmpty()
        }
        if (resolvedId.isEmpty()) return@withContext null
        val now = System.currentTimeMillis()
        ytmArtistCache[resolvedId]?.let { (ts, cached) ->
            if (now - ts < YTM_CACHE_TTL_MS) return@withContext cached
        }
        val body = ytmPost("browse", JSONObject().put("browseId", resolvedId)) ?: return@withContext null
        val parsed = parseYtmArtistPage(body, resolvedId, fallbackName = artistName) ?: return@withContext null
        ytmArtistCache[resolvedId] = System.currentTimeMillis() to parsed
        parsed
    }

    suspend fun loadYtmAlbum(
        browseId: String?,
        artist: String = "",
        albumTitle: String = "",
    ): YtmAlbumPage? = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext null
        val resolvedId = browseId?.trim()?.takeIf { it.isNotEmpty() } ?: run {
            val query = listOf(artist.trim(), albumTitle.trim()).filter { it.isNotEmpty() }.joinToString(" ")
            if (query.length < 2) return@withContext null
            val res = searchYouTubeMusic(query)
            val targetAlbum = fold(albumTitle)
            res.albums.firstOrNull { targetAlbum.isNotEmpty() && fold(it.title).contains(targetAlbum) }?.browseId
                ?: res.albums.firstOrNull()?.browseId
                ?: res.songs.firstOrNull { it.albumBrowseId.isNotBlank() }?.albumBrowseId
                .orEmpty()
        }
        if (resolvedId.isEmpty()) return@withContext null
        val now = System.currentTimeMillis()
        ytmAlbumCache[resolvedId]?.let { (ts, cached) ->
            if (now - ts < YTM_CACHE_TTL_MS) return@withContext cached
        }
        val body = ytmPost("browse", JSONObject().put("browseId", resolvedId)) ?: return@withContext null
        val parsed = parseYtmAlbumPage(body, resolvedId, fallbackTitle = albumTitle, fallbackArtist = artist)
            ?: return@withContext null
        ytmAlbumCache[resolvedId] = System.currentTimeMillis() to parsed
        parsed
    }

    internal fun parseYtmSearch(body: String, query: String): YtmSearchResult {
        return try {
            val root = JSONObject(body)
            val artists = ArrayList<YtmArtistSummary>()
            val songs = ArrayList<YtmSongItem>()
            val albums = ArrayList<YtmAlbumSummary>()
            val seenArtists = HashSet<String>()
            val seenSongs = HashSet<String>()
            val seenAlbums = HashSet<String>()
            collectYtmSearchItems(root, artists, songs, albums, seenArtists, seenSongs, seenAlbums)
            YtmSearchResult(
                query = query,
                artists = artists.take(10),
                songs = songs.take(20),
                albums = albums.take(12),
            )
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            YtmSearchResult(query = query)
        }
    }

    private fun collectYtmSearchItems(
        node: Any?,
        artists: MutableList<YtmArtistSummary>,
        songs: MutableList<YtmSongItem>,
        albums: MutableList<YtmAlbumSummary>,
        seenArtists: MutableSet<String>,
        seenSongs: MutableSet<String>,
        seenAlbums: MutableSet<String>,
        defaultArtist: String = "",
    ) {
        if (node == null) return
        when (node) {
            is JSONObject -> {
                val card = node.optJSONObject("musicCardShelfRenderer")
                if (card != null) {
                    parseYtmCardShelfTopResult(card, artists, songs, albums, seenArtists, seenSongs, seenAlbums)
                }
                val row = node.optJSONObject("musicResponsiveListItemRenderer")
                if (row != null) {
                    parseYtmListRow(row, artists, songs, albums, seenArtists, seenSongs, seenAlbums, defaultArtist)
                    return
                }
                val keys = node.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    if (k == "musicCardShelfRenderer" || k == "musicResponsiveListItemRenderer") continue
                    collectYtmSearchItems(node.opt(k), artists, songs, albums, seenArtists, seenSongs, seenAlbums, defaultArtist)
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    collectYtmSearchItems(node.opt(i), artists, songs, albums, seenArtists, seenSongs, seenAlbums, defaultArtist)
                }
            }
        }
    }

    private fun parseYtmCardShelfTopResult(
        card: JSONObject,
        artists: MutableList<YtmArtistSummary>,
        songs: MutableList<YtmSongItem>,
        albums: MutableList<YtmAlbumSummary>,
        seenArtists: MutableSet<String>,
        seenSongs: MutableSet<String>,
        seenAlbums: MutableSet<String>,
    ) {
        val titleRuns = card.optJSONObject("title")?.optJSONArray("runs")
        val title = readYtText(card.optJSONObject("title")).trim()
        val subtitle = readYtText(card.optJSONObject("subtitle")).trim()
        val nav = titleRuns?.optJSONObject(0)?.optJSONObject("navigationEndpoint")
        val browse = nav?.optJSONObject("browseEndpoint")
        val browseId = browse?.optString("browseId").orEmpty().trim()
        val pageType = browse?.optJSONObject("browseEndpointContextSupportedConfigs")
            ?.optJSONObject("browseEndpointContextMusicConfig")
            ?.optString("pageType")
            .orEmpty()
        val watchVideoId = nav?.optJSONObject("watchEndpoint")?.optString("videoId").orEmpty().trim()
        val thumb = upsizeYtmThumb(
            lastThumbnailUrl(
                card.optJSONObject("thumbnail")
                    ?.optJSONObject("musicThumbnailRenderer")
                    ?.optJSONObject("thumbnail")
                    ?.optJSONArray("thumbnails"),
            ),
            fallbackVideoId = watchVideoId,
        )
        val nestedDefaultArtist = if (pageType == "MUSIC_PAGE_TYPE_ARTIST" && title.isNotEmpty()) title else ""
        when {
            pageType == "MUSIC_PAGE_TYPE_ARTIST" && browseId.isNotEmpty() && title.isNotEmpty() -> {
                if (seenArtists.add(browseId)) {
                    val subs = subtitle.substringAfter("•", "").trim().ifBlank { subtitle }
                    artists.add(0, YtmArtistSummary(browseId = browseId, name = title, subscribers = subs, artUrl = thumb))
                }
            }
            pageType == "MUSIC_PAGE_TYPE_ALBUM" && browseId.isNotEmpty() && title.isNotEmpty() -> {
                if (seenAlbums.add(browseId)) {
                    val year = YEAR_FOUR_RE.find(subtitle)?.value.orEmpty()
                    val artistPart = subtitle.split("•").map { it.trim() }
                        .firstOrNull { it.isNotEmpty() && !it.equals("Album", true) && !it.equals("EP", true) && !it.equals("Single", true) && !YEAR_FOUR_RE.matches(it) }
                        .orEmpty()
                    albums.add(0, YtmAlbumSummary(browseId = browseId, title = title, artist = artistPart, year = year, subtitle = subtitle, artUrl = thumb))
                }
            }
            watchVideoId.length == 11 && title.isNotEmpty() -> {
                if (seenSongs.add(watchVideoId)) {
                    val parts = subtitle.split("•").map { it.trim() }
                    val durText = parts.firstOrNull { DURATION_MMSS_RE.matches(it) }.orEmpty()
                    val artistPart = parts.firstOrNull {
                        it.isNotEmpty() && !it.equals("Song", true) && !it.equals("Video", true) && !DURATION_MMSS_RE.matches(it) && !it.contains("plays", true) && !it.contains("views", true)
                    }.orEmpty()
                    val menuAlbumBrowseId = extractMenuAlbumBrowseId(card.optJSONObject("menu"))
                    songs.add(
                        0,
                        YtmSongItem(
                            videoId = watchVideoId,
                            title = cleanMediaTitle(title).ifBlank { title },
                            artist = cleanChannelName(artistPart),
                            albumBrowseId = menuAlbumBrowseId,
                            durationText = durText,
                            durationSecs = parseDurationTextSeconds(durText) ?: 0,
                            artUrl = thumb,
                        ),
                    )
                }
            }
        }
        val contents = card.optJSONArray("contents")
        if (contents != null) {
            for (i in 0 until contents.length()) {
                collectYtmSearchItems(
                    contents.opt(i),
                    artists,
                    songs,
                    albums,
                    seenArtists,
                    seenSongs,
                    seenAlbums,
                    defaultArtist = nestedDefaultArtist,
                )
            }
        }
    }

    private fun extractMenuAlbumBrowseId(menu: JSONObject?): String {
        val items = menu?.optJSONObject("menuRenderer")?.optJSONArray("items") ?: return ""
        for (i in 0 until items.length()) {
            val be = items.optJSONObject(i)
                ?.optJSONObject("menuNavigationItemRenderer")
                ?.optJSONObject("navigationEndpoint")
                ?.optJSONObject("browseEndpoint")
                ?: continue
            val pt = be.optJSONObject("browseEndpointContextSupportedConfigs")
                ?.optJSONObject("browseEndpointContextMusicConfig")
                ?.optString("pageType")
                .orEmpty()
            if (pt == "MUSIC_PAGE_TYPE_ALBUM") {
                val bid = be.optString("browseId").trim()
                if (bid.isNotEmpty()) return bid
            }
        }
        return ""
    }

    private fun parseYtmListRow(
        r: JSONObject,
        artists: MutableList<YtmArtistSummary>,
        songs: MutableList<YtmSongItem>,
        albums: MutableList<YtmAlbumSummary>,
        seenArtists: MutableSet<String>,
        seenSongs: MutableSet<String>,
        seenAlbums: MutableSet<String>,
        defaultArtist: String = "",
    ) {
        val flex = r.optJSONArray("flexColumns") ?: return
        val col0 = flex.optJSONObject(0)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text")
        val col1 = flex.optJSONObject(1)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text")
        val title = readYtText(col0).trim()
        if (title.isEmpty()) return
        val subtitle = readYtText(col1).trim()
        val nav = r.optJSONObject("navigationEndpoint")
        val browse = nav?.optJSONObject("browseEndpoint")
        val browseId = browse?.optString("browseId").orEmpty().trim()
        val pageType = browse?.optJSONObject("browseEndpointContextSupportedConfigs")
            ?.optJSONObject("browseEndpointContextMusicConfig")
            ?.optString("pageType")
            .orEmpty()
        val videoId = r.optJSONObject("playlistItemData")?.optString("videoId").orEmpty().trim()
            .ifBlank {
                col0?.optJSONArray("runs")?.optJSONObject(0)
                    ?.optJSONObject("navigationEndpoint")
                    ?.optJSONObject("watchEndpoint")
                    ?.optString("videoId")
                    .orEmpty()
                    .trim()
            }
        val thumb = upsizeYtmThumb(
            lastThumbnailUrl(
                r.optJSONObject("thumbnail")
                    ?.optJSONObject("musicThumbnailRenderer")
                    ?.optJSONObject("thumbnail")
                    ?.optJSONArray("thumbnails"),
            ),
            fallbackVideoId = videoId,
        )

        when {
            pageType == "MUSIC_PAGE_TYPE_ARTIST" && browseId.isNotEmpty() -> {
                if (seenArtists.add(browseId)) {
                    val subs = subtitle.substringAfter("•", "").trim()
                    artists.add(YtmArtistSummary(browseId = browseId, name = title, subscribers = subs, artUrl = thumb))
                }
            }
            pageType == "MUSIC_PAGE_TYPE_ALBUM" && browseId.isNotEmpty() -> {
                if (seenAlbums.add(browseId)) {
                    val year = YEAR_FOUR_RE.find(subtitle)?.value.orEmpty()
                    val artistPart = subtitle.split("•").map { it.trim() }
                        .firstOrNull { it.isNotEmpty() && !it.equals("Album", true) && !it.equals("EP", true) && !it.equals("Single", true) && !YEAR_FOUR_RE.matches(it) }
                        .orEmpty()
                    albums.add(YtmAlbumSummary(browseId = browseId, title = title, artist = artistPart, year = year, subtitle = subtitle, artUrl = thumb))
                }
            }
            videoId.length == 11 -> {
                if (seenSongs.add(videoId)) {
                    parseYtmSongFromRow(r, videoId, title, thumb, defaultArtist = defaultArtist)?.let { songs.add(it) }
                }
            }
        }
    }

    private fun parseYtmSongFromRow(
        r: JSONObject,
        videoId: String,
        rawTitle: String,
        thumb: String,
        defaultArtist: String = "",
        defaultAlbum: String = "",
    ): YtmSongItem? {
        val flex = r.optJSONArray("flexColumns")
        var artist = ""
        var artistBrowseId = ""
        var album = ""
        var albumBrowseId = ""
        var durationText = ""
        var playsText = ""

        if (flex != null) {
            for (c in 1 until flex.length()) {
                val runs = flex.optJSONObject(c)
                    ?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")
                    ?.optJSONObject("text")
                    ?.optJSONArray("runs") ?: continue
                for (i in 0 until runs.length()) {
                    val run = runs.optJSONObject(i) ?: continue
                    val text = run.optString("text").trim()
                    if (text.isEmpty() || text == "•" || text == "·" || text == "&" || text == ",") continue
                    val be = run.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")
                    val bid = be?.optString("browseId").orEmpty().trim()
                    val pt = be?.optJSONObject("browseEndpointContextSupportedConfigs")
                        ?.optJSONObject("browseEndpointContextMusicConfig")
                        ?.optString("pageType")
                        .orEmpty()
                    when {
                        pt == "MUSIC_PAGE_TYPE_ARTIST" -> {
                            if (artist.isEmpty()) {
                                artist = text
                                artistBrowseId = bid
                            }
                        }
                        pt == "MUSIC_PAGE_TYPE_ALBUM" -> {
                            if (album.isEmpty()) {
                                album = text
                                albumBrowseId = bid
                            }
                        }
                        DURATION_MMSS_RE.matches(text) -> durationText = text
                        text.contains("play", ignoreCase = true) || text.contains("view", ignoreCase = true) -> playsText = text
                        !text.equals("Song", true) && !text.equals("Video", true) && artist.isEmpty() && c == 1 -> {
                            artist = text
                        }
                    }
                }
            }
        }
        if (albumBrowseId.isEmpty()) {
            albumBrowseId = extractMenuAlbumBrowseId(r.optJSONObject("menu"))
        }
        if (durationText.isEmpty()) {
            val fixed = r.optJSONArray("fixedColumns")
            val fixedText = readYtText(
                fixed?.optJSONObject(0)
                    ?.optJSONObject("musicResponsiveListItemFixedColumnRenderer")
                    ?.optJSONObject("text"),
            ).trim()
            if (DURATION_MMSS_RE.matches(fixedText)) {
                durationText = fixedText
            }
        }
        val cleanTitle = cleanMediaTitle(rawTitle).ifBlank { rawTitle }
        val cleanArtist = cleanChannelName(artist.ifBlank { defaultArtist })
        return YtmSongItem(
            videoId = videoId,
            title = cleanTitle,
            artist = cleanArtist,
            artistBrowseId = artistBrowseId,
            album = album.ifBlank { defaultAlbum },
            albumBrowseId = albumBrowseId,
            durationText = durationText,
            durationSecs = parseDurationTextSeconds(durationText) ?: 0,
            playsText = playsText,
            artUrl = thumb,
        )
    }

    internal fun parseYtmArtistPage(body: String, browseId: String, fallbackName: String = ""): YtmArtistPage? {
        return try {
            val root = JSONObject(body)
            val headerObj = root.optJSONObject("header")
            val immersive = headerObj?.optJSONObject("musicImmersiveHeaderRenderer")
            val visual = headerObj?.optJSONObject("musicVisualHeaderRenderer")
            val hdr = immersive ?: visual
            val name = readYtText(hdr?.optJSONObject("title")).trim().ifBlank { fallbackName.trim() }
            if (name.isEmpty()) return null
            val listeners = readYtText(immersive?.optJSONObject("monthlyListenerCount")).trim()
                .ifBlank { readYtText(immersive?.optJSONObject("subscriptionButton")?.optJSONObject("subscribeButtonRenderer")?.optJSONObject("longSubscriberCountText")).trim() }
            val description = readYtText(immersive?.optJSONObject("description")).trim()
            val artUrl = upsizeYtmThumb(
                lastThumbnailUrl(
                    hdr?.optJSONObject("thumbnail")
                        ?.optJSONObject("musicThumbnailRenderer")
                        ?.optJSONObject("thumbnail")
                        ?.optJSONArray("thumbnails")
                        ?: visual?.optJSONObject("foregroundThumbnail")
                            ?.optJSONObject("musicThumbnailRenderer")
                            ?.optJSONObject("thumbnail")
                            ?.optJSONArray("thumbnails"),
                ),
            )

            val topSongs = ArrayList<YtmSongItem>()
            val albums = ArrayList<YtmAlbumSummary>()
            val singles = ArrayList<YtmAlbumSummary>()
            val related = ArrayList<YtmArtistSummary>()
            val seenSongs = HashSet<String>()
            val seenAlbums = HashSet<String>()
            val seenRelated = HashSet<String>()

            fun walk(node: Any?) {
                when (node) {
                    is JSONObject -> {
                        val shelf = node.optJSONObject("musicShelfRenderer")
                        if (shelf != null) {
                            val items = shelf.optJSONArray("contents")
                            if (items != null) {
                                for (i in 0 until items.length()) {
                                    val r = items.optJSONObject(i)?.optJSONObject("musicResponsiveListItemRenderer") ?: continue
                                    val vid = r.optJSONObject("playlistItemData")?.optString("videoId").orEmpty().trim()
                                    if (vid.length != 11 || !seenSongs.add(vid)) continue
                                    val flex = r.optJSONArray("flexColumns") ?: continue
                                    val rawTitle = readYtText(
                                        flex.optJSONObject(0)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text"),
                                    ).trim()
                                    if (rawTitle.isEmpty()) continue
                                    val thumb = upsizeYtmThumb(
                                        lastThumbnailUrl(
                                            r.optJSONObject("thumbnail")
                                                ?.optJSONObject("musicThumbnailRenderer")
                                                ?.optJSONObject("thumbnail")
                                                ?.optJSONArray("thumbnails"),
                                        ),
                                        fallbackVideoId = vid,
                                    )
                                    parseYtmSongFromRow(r, vid, rawTitle, thumb, defaultArtist = name)?.let {
                                        topSongs.add(it.copy(artistBrowseId = it.artistBrowseId.ifBlank { browseId }))
                                    }
                                }
                            }
                            return
                        }
                        val carousel = node.optJSONObject("musicCarouselShelfRenderer")
                        if (carousel != null) {
                            val shelfTitle = readYtText(
                                carousel.optJSONObject("header")
                                    ?.optJSONObject("musicCarouselShelfBasicHeaderRenderer")
                                    ?.optJSONObject("title"),
                            ).trim()
                            val isSinglesShelf = shelfTitle.contains("single", ignoreCase = true) || shelfTitle.contains("ep", ignoreCase = true)
                            val items = carousel.optJSONArray("contents")
                            if (items != null) {
                                for (i in 0 until items.length()) {
                                    val card = items.optJSONObject(i)?.optJSONObject("musicTwoRowItemRenderer") ?: continue
                                    val itemTitle = readYtText(card.optJSONObject("title")).trim()
                                    if (itemTitle.isEmpty()) continue
                                    val sub = readYtText(card.optJSONObject("subtitle")).trim()
                                    val be = card.optJSONObject("navigationEndpoint")?.optJSONObject("browseEndpoint")
                                    val bid = be?.optString("browseId").orEmpty().trim()
                                    val pt = be?.optJSONObject("browseEndpointContextSupportedConfigs")
                                        ?.optJSONObject("browseEndpointContextMusicConfig")
                                        ?.optString("pageType")
                                        .orEmpty()
                                    val thumb = upsizeYtmThumb(
                                        lastThumbnailUrl(
                                            card.optJSONObject("thumbnailRenderer")
                                                ?.optJSONObject("musicThumbnailRenderer")
                                                ?.optJSONObject("thumbnail")
                                                ?.optJSONArray("thumbnails"),
                                        ),
                                    )
                                    if (pt == "MUSIC_PAGE_TYPE_ALBUM" && bid.isNotEmpty() && seenAlbums.add(bid)) {
                                        val yr = YEAR_FOUR_RE.find(sub)?.value.orEmpty()
                                        val summary = YtmAlbumSummary(
                                            browseId = bid,
                                            title = itemTitle,
                                            artist = name,
                                            year = yr,
                                            subtitle = sub,
                                            artUrl = thumb,
                                        )
                                        if (isSinglesShelf) singles.add(summary) else albums.add(summary)
                                    } else if (pt == "MUSIC_PAGE_TYPE_ARTIST" && bid.isNotEmpty() && bid != browseId && seenRelated.add(bid)) {
                                        related.add(YtmArtistSummary(browseId = bid, name = itemTitle, subscribers = sub, artUrl = thumb))
                                    }
                                }
                            }
                            return
                        }
                        val keys = node.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            if (k == "musicShelfRenderer" || k == "musicCarouselShelfRenderer") continue
                            walk(node.opt(k))
                        }
                    }
                    is JSONArray -> {
                        for (i in 0 until node.length()) walk(node.opt(i))
                    }
                }
            }
            walk(root)
            YtmArtistPage(
                browseId = browseId,
                name = name,
                monthlyListeners = listeners,
                description = description,
                artUrl = artUrl,
                topSongs = topSongs.take(15),
                albums = albums.take(20),
                singles = singles.take(16),
                relatedArtists = related.take(12),
            )
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun parseYtmAlbumPage(
        body: String,
        browseId: String,
        fallbackTitle: String = "",
        fallbackArtist: String = "",
    ): YtmAlbumPage? {
        return try {
            val root = JSONObject(body)
            var title = fallbackTitle.trim()
            var artist = fallbackArtist.trim()
            var artistBrowseId = ""
            var subtitle = ""
            var year = ""
            var artUrl = ""
            val tracks = ArrayList<YtmSongItem>()
            val seen = HashSet<String>()

            fun walk(node: Any?) {
                when (node) {
                    is JSONObject -> {
                        val hdr = node.optJSONObject("musicResponsiveHeaderRenderer")
                            ?: node.optJSONObject("musicDetailHeaderRenderer")
                        if (hdr != null) {
                            val t = readYtText(hdr.optJSONObject("title")).trim()
                            if (t.isNotEmpty()) title = t
                            val sub = readYtText(hdr.optJSONObject("subtitle")).trim()
                            if (sub.isNotEmpty()) {
                                subtitle = sub
                                year = YEAR_FOUR_RE.find(sub)?.value.orEmpty()
                            }
                            val strapRuns = hdr.optJSONObject("straplineTextOne")?.optJSONArray("runs")
                            val strapText = readYtText(hdr.optJSONObject("straplineTextOne")).trim()
                            if (strapText.isNotEmpty()) {
                                artist = cleanChannelName(strapText)
                                val firstBid = strapRuns?.optJSONObject(0)
                                    ?.optJSONObject("navigationEndpoint")
                                    ?.optJSONObject("browseEndpoint")
                                    ?.optString("browseId")
                                    .orEmpty()
                                    .trim()
                                if (firstBid.isNotEmpty()) artistBrowseId = firstBid
                            }
                            val thumbRaw = lastThumbnailUrl(
                                hdr.optJSONObject("thumbnail")
                                    ?.optJSONObject("musicThumbnailRenderer")
                                    ?.optJSONObject("thumbnail")
                                    ?.optJSONArray("thumbnails"),
                            )
                            if (thumbRaw.isNotEmpty()) artUrl = upsizeYtmThumb(thumbRaw)
                        }
                        val row = node.optJSONObject("musicResponsiveListItemRenderer")
                        if (row != null) {
                            val vid = row.optJSONObject("playlistItemData")?.optString("videoId").orEmpty().trim()
                            if (vid.length == 11 && seen.add(vid)) {
                                val flex = row.optJSONArray("flexColumns")
                                val rawTrackTitle = readYtText(
                                    flex?.optJSONObject(0)?.optJSONObject("musicResponsiveListItemFlexColumnRenderer")?.optJSONObject("text"),
                                ).trim()
                                if (rawTrackTitle.isNotEmpty()) {
                                    parseYtmSongFromRow(
                                        r = row,
                                        videoId = vid,
                                        rawTitle = rawTrackTitle,
                                        thumb = artUrl.ifBlank { "https://i.ytimg.com/vi/$vid/hqdefault.jpg" },
                                        defaultArtist = artist,
                                        defaultAlbum = title,
                                    )?.let { song ->
                                        tracks.add(
                                            song.copy(
                                                album = title,
                                                albumBrowseId = browseId,
                                                artist = song.artist.ifBlank { artist },
                                                artistBrowseId = song.artistBrowseId.ifBlank { artistBrowseId },
                                                artUrl = artUrl.ifBlank { song.artUrl },
                                            ),
                                        )
                                    }
                                }
                            }
                            return
                        }
                        val keys = node.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            if (k == "musicResponsiveListItemRenderer") continue
                            walk(node.opt(k))
                        }
                    }
                    is JSONArray -> {
                        for (i in 0 until node.length()) walk(node.opt(i))
                    }
                }
            }
            walk(root)
            if (title.isEmpty() && tracks.isEmpty()) return null
            YtmAlbumPage(
                browseId = browseId,
                title = title,
                artist = artist,
                artistBrowseId = artistBrowseId,
                year = year,
                subtitle = subtitle,
                artUrl = artUrl,
                tracks = tracks,
            )
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun parseYouTubeAudioStream(
        body: String,
        videoId: String,
        userAgent: String = YT_VISIONOS_USER_AGENT,
    ): ResolvedAudioStream? {
        return try {
            val root = JSONObject(body)
            val status = root.optJSONObject("playabilityStatus")?.optString("status").orEmpty()
            if (status != "OK") return null
            val formats = root.optJSONObject("streamingData")?.optJSONArray("adaptiveFormats") ?: return null
            data class AudioCand(val url: String, val isMp4: Boolean, val bitrate: Long, val durationMs: Long)
            val allAudio = ArrayList<AudioCand>()
            for (i in 0 until formats.length()) {
                val f = formats.optJSONObject(i) ?: continue
                val mime = f.optString("mimeType").trim()
                val url = f.optString("url").trim()
                if (url.isEmpty() || !mime.startsWith("audio/", ignoreCase = true)) continue
                val bitrate = f.optLong("bitrate", 0L).coerceAtLeast(0L)
                val approxDur = f.optString("approxDurationMs").toLongOrNull()
                    ?: f.optLong("approxDurationMs", 0L)
                allAudio.add(
                    AudioCand(
                        url = url,
                        isMp4 = mime.startsWith("audio/mp4", ignoreCase = true),
                        bitrate = bitrate,
                        durationMs = approxDur.coerceAtLeast(0L),
                    ),
                )
            }
            if (allAudio.isEmpty()) return null
            val mp4Pool = allAudio.filter { it.isMp4 }
            val best = (if (mp4Pool.isNotEmpty()) mp4Pool else allAudio).maxByOrNull { it.bitrate } ?: return null
            val fallbackDurMs = root.optJSONObject("videoDetails")
                ?.optString("lengthSeconds")
                ?.toLongOrNull()
                ?.takeIf { it > 0L }
                ?.times(1000L)
                ?: 0L
            val durMs = if (best.durationMs > 0L) best.durationMs else fallbackDurMs
            ResolvedAudioStream(
                videoId = videoId,
                streamUrl = best.url,
                durationMs = durMs,
                userAgent = userAgent,
                watchUrl = "https://www.youtube.com/watch?v=$videoId",
            )
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    private fun parseDurationTextSeconds(raw: String): Int? {
        val parts = raw.trim().split(':')
        if (parts.size < 2 || parts.size > 3) return null
        var total = 0
        for (part in parts) {
            val n = part.trim().toIntOrNull() ?: return null
            if (n < 0) return null
            total = total * 60 + n
        }
        return total
    }

    private fun cleanLookupTitle(raw: String): String {
        var cleaned = raw.trim().replace(TITLE_STRIP_EP_RE, "").trim()
        val withoutParenYear = cleaned.replace(TITLE_STRIP_PAREN_YEAR_RE, "").trim()
        if (withoutParenYear.isNotEmpty()) cleaned = withoutParenYear
        return cleaned
    }

    private fun titleImdbCacheKey(title: String, isSeries: Boolean): String? {
        val cleaned = cleanLookupTitle(title).lowercase(Locale.ROOT)
        if (cleaned.length < 2) return null
        return "${if (isSeries) "series" else "movie"}|$cleaned"
    }

    internal fun formatCinemaRuntime(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.equals("null", ignoreCase = true) || trimmed.equals("N/A", ignoreCase = true)) {
            return ""
        }
        val match = RUNTIME_MINS_RE.find(trimmed)
        val totalMins = match?.groupValues?.getOrNull(1)?.toIntOrNull()
        if (totalMins != null && totalMins >= 60) {
            val hrs = totalMins / 60
            val mins = totalMins % 60
            return if (mins > 0) "${hrs}h ${mins}m" else "${hrs}h"
        }
        return trimmed
    }

    internal fun parseCinemetaCatalog(body: String, kind: String): List<CinemaDiscoverItem> {
        return try {
            val root = JSONObject(body)
            val metas = root.optJSONArray("metas") ?: return emptyList()
            val out = ArrayList<CinemaDiscoverItem>()
            val seen = HashSet<String>()
            for (i in 0 until metas.length()) {
                val obj = metas.optJSONObject(i) ?: continue
                val tt = extractImdbId(obj.optString("imdb_id").ifBlank { obj.optString("id") }) ?: continue
                if (!seen.add(tt)) continue
                val title = obj.optString("name").trim()
                if (title.isEmpty()) continue
                val year = extractCinemaYear(obj.optString("releaseInfo").ifBlank { obj.optString("year") })
                val rating = cleanCinemaField(obj.optString("imdbRating"))
                val runtime = formatCinemaRuntime(obj.optString("runtime"))
                val genres = readStringArray(obj.optJSONArray("genres") ?: obj.optJSONArray("genre"))
                val description = cleanCinemaField(obj.optString("description"))
                val cast = readStringArray(obj.optJSONArray("cast"))
                val rawPoster = normalizeThumb(obj.optString("poster"))
                val posterUrl = rawPoster.takeIf { ExternalImageCache.isAllowedUrl(it) }
                    ?: imdbPosterUrl(tt).orEmpty()
                val rawBackdrop = normalizeThumb(obj.optString("background"))
                val backdropUrl = rawBackdrop.takeIf { ExternalImageCache.isAllowedUrl(it) }
                    ?: imdbBackdropUrl(tt).orEmpty()
                out.add(
                    CinemaDiscoverItem(
                        imdbId = tt,
                        kind = kind,
                        title = title,
                        year = year,
                        rating = rating,
                        runtime = runtime,
                        genres = genres,
                        description = description,
                        posterUrl = posterUrl,
                        backdropUrl = backdropUrl,
                        cast = cast,
                    ),
                )
                if (out.size >= 24) break
            }
            out
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            emptyList()
        }
    }

    internal fun parseCinemetaTitleMeta(body: String, fallbackImdb: String, kind: String): CinemaTitleMeta? {
        return try {
            val root = JSONObject(body)
            val meta = root.optJSONObject("meta") ?: return null
            val tt = extractImdbId(meta.optString("imdb_id").ifBlank { meta.optString("id") }) ?: fallbackImdb
            val title = meta.optString("name").trim()
            val year = extractCinemaYear(meta.optString("releaseInfo").ifBlank { meta.optString("year") })
            val rating = cleanCinemaField(meta.optString("imdbRating"))
            val runtime = formatCinemaRuntime(meta.optString("runtime"))
            val genres = readStringArray(meta.optJSONArray("genres") ?: meta.optJSONArray("genre"))
            val description = cleanCinemaField(meta.optString("description"))
            val cast = readStringArray(meta.optJSONArray("cast"))
            val rawPoster = normalizeThumb(meta.optString("poster"))
            val posterUrl = rawPoster.takeIf { ExternalImageCache.isAllowedUrl(it) }
                ?: imdbPosterUrl(tt).orEmpty()
            val rawBackdrop = normalizeThumb(meta.optString("background"))
            val backdropUrl = rawBackdrop.takeIf { ExternalImageCache.isAllowedUrl(it) }
                ?: imdbBackdropUrl(tt).orEmpty()

            val episodes = LinkedHashMap<Pair<Int, Int>, CinemaEpisodeMeta>()
            val videos = meta.optJSONArray("videos")
            if (videos != null) {
                for (i in 0 until videos.length()) {
                    val v = videos.optJSONObject(i) ?: continue
                    val season = v.optInt("season", -1)
                    val ep = v.optInt("episode", v.optInt("number", -1))
                    if (season <= 0 || ep <= 0) continue
                    val epName = cleanCinemaField(v.optString("name").ifBlank { v.optString("title") })
                    val overview = cleanCinemaField(v.optString("overview").ifBlank { v.optString("description") })
                    val rawThumb = normalizeThumb(v.optString("thumbnail"))
                    val thumbUrl = rawThumb.takeIf { ExternalImageCache.isAllowedUrl(it) }
                        ?: "https://episodes.metahub.space/$tt/$season/$ep/w780.jpg"
                    episodes[season to ep] = CinemaEpisodeMeta(
                        season = season,
                        episode = ep,
                        name = epName,
                        overview = overview,
                        thumbnailUrl = thumbUrl,
                    )
                }
            }

            CinemaTitleMeta(
                imdbId = tt,
                kind = kind,
                title = title,
                year = year,
                rating = rating,
                runtime = runtime,
                genres = genres,
                description = description,
                cast = cast,
                posterUrl = posterUrl,
                backdropUrl = backdropUrl,
                episodes = episodes,
            )
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun parseCinemetaSearchBestImdb(body: String, targetTitle: String): String? {
        return try {
            val root = JSONObject(body)
            val metas = root.optJSONArray("metas") ?: return null
            val targetFold = targetTitle.trim().lowercase(Locale.ROOT)
            var fallback: String? = null
            for (i in 0 until metas.length()) {
                val obj = metas.optJSONObject(i) ?: continue
                val tt = extractImdbId(obj.optString("imdb_id").ifBlank { obj.optString("id") }) ?: continue
                if (fallback == null) fallback = tt
                val name = obj.optString("name").trim().lowercase(Locale.ROOT)
                if (name == targetFold) return tt
            }
            fallback
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    private fun extractCinemaYear(raw: String): String {
        val cleaned = cleanCinemaField(raw)
        if (cleaned.isEmpty()) return ""
        return YEAR_FOUR_RE.find(cleaned)?.value.orEmpty()
    }

    private fun cleanCinemaField(raw: String): String {
        val trimmed = raw.trim()
        return if (trimmed.isEmpty() || trimmed.equals("null", ignoreCase = true) || trimmed.equals("N/A", ignoreCase = true)) {
            ""
        } else {
            trimmed
        }
    }

    private fun readStringArray(arr: JSONArray?): List<String> {
        if (arr == null || arr.length() == 0) return emptyList()
        val list = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val item = cleanCinemaField(arr.optString(i))
            if (item.isNotEmpty()) list.add(item)
        }
        return list
    }

    fun rememberAlbumArtUrl(artist: String, album: String, artUrl: String) {
        val cleanUrl = artUrl.trim()
        if (cleanUrl.isEmpty() || !ExternalImageCache.isAllowedUrl(cleanUrl)) return
        val keys = LinkedHashSet<String>(2)
        albumArtCacheKey(artist, album)?.let { keys.add(it) }
        val primary = extractPrimaryArtist(artist)
        if (primary.isNotBlank() && !primary.equals(artist.trim(), ignoreCase = true)) {
            albumArtCacheKey(primary, album)?.let { keys.add(it) }
        }
        val diskDir = ExternalImageCache.diskDirectory()
        for (key in keys) {
            albumArtUrlCache[key] = cleanUrl
            albumArtNegativeCache.remove(key)
            if (diskDir != null) {
                runCatching {
                    diskDir.mkdirs()
                    val metaFile = File(diskDir, "alb_${ExternalImageCache.sha256Hex(key)}.url")
                    val tmp = File(diskDir, "${metaFile.name}.tmp")
                    tmp.writeText(cleanUrl, Charsets.UTF_8)
                    if (!tmp.renameTo(metaFile)) tmp.delete()
                }
            }
        }
    }

    fun cachedAlbumArtUrl(artist: String, album: String): String? {
        val key = albumArtCacheKey(artist, album) ?: return null
        albumArtUrlCache[key]?.takeIf { it.isNotEmpty() }?.let { return it }
        val primary = extractPrimaryArtist(artist)
        if (primary.isNotBlank() && !primary.equals(artist.trim(), ignoreCase = true)) {
            albumArtCacheKey(primary, album)?.let { pk ->
                albumArtUrlCache[pk]?.takeIf { it.isNotEmpty() }?.let { return it }
            }
        }
        return null
    }

    suspend fun resolveAlbumArtUrl(artist: String, album: String): String? = withContext(Dispatchers.IO) {
        val key = albumArtCacheKey(artist, album) ?: return@withContext null
        cachedAlbumArtUrl(artist, album)?.let { cached ->
            if (!failClosedMeta || ExternalImageCache.isLoopbackUrl(cached)) {
                return@withContext cached
            }
        }

        val failedAt = albumArtNegativeCache[key]
        if (failedAt != null && System.currentTimeMillis() - failedAt < 10 * 60_000L) {
            return@withContext null
        }

        val cleanArtist = extractPrimaryArtist(artist)
        val cleanAlbum = album.trim()
        val term = listOf(cleanArtist, cleanAlbum).filter { it.isNotBlank() }.joinToString(" ")
        if (term.length < 2) return@withContext null

        // Step 1: Check local P2P metadata search for album artwork first
        if (localApiBaseUrl != null) {
            val hits = localMetaClient.searchMeta(kind = "album", query = term, limit = 6)
            val targetAlbum = fold(cleanAlbum)
            val targetArtist = fold(cleanArtist)
            val matched = hits.firstOrNull { hit ->
                val fTitle = fold(hit.title)
                val fSub = fold(hit.subtitle)
                (targetAlbum.isEmpty() || fTitle == targetAlbum || fTitle.contains(targetAlbum) || targetAlbum.contains(fTitle)) &&
                    (targetArtist.isEmpty() || fSub.isEmpty() || fSub.contains(targetArtist) || targetArtist.contains(fSub)) &&
                    (!hit.posterUrl.isNullOrBlank() || hit.posterHash.length == 64 || hit.thumbHash.isNotBlank())
            }
            if (matched != null) {
                val p2pUrl = resolveLocalArtUrl(matched.posterUrl, matched.posterHash)
                if (matched.thumbHash.isNotBlank()) {
                    ThumbHash.rememberThumbHash("alb:$key", matched.thumbHash)
                    if (p2pUrl.isNotBlank()) ThumbHash.rememberThumbHash(p2pUrl, matched.thumbHash)
                }
                if (p2pUrl.isNotBlank()) {
                    rememberAlbumArtUrl(artist, album, p2pUrl)
                    return@withContext p2pUrl
                }
            }
        }

        // Step 2: Fail closed when Private Routing or P2P-only metadata is active
        if (failClosedMeta) return@withContext null

        val diskDir = ExternalImageCache.diskDirectory()
        val candidateKeys = buildList {
            add(key)
            val primary = extractPrimaryArtist(artist)
            if (primary.isNotBlank() && !primary.equals(artist.trim(), ignoreCase = true)) {
                albumArtCacheKey(primary, album)?.let { add(it) }
            }
        }
        for (ck in candidateKeys) {
            val metaFile = diskDir?.let { File(it, "alb_${ExternalImageCache.sha256Hex(ck)}.url") }
            if (metaFile != null && metaFile.isFile) {
                val saved = runCatching { metaFile.readText(Charsets.UTF_8).trim() }.getOrNull().orEmpty()
                if (saved.isNotEmpty() && ExternalImageCache.isAllowedUrl(saved)) {
                    albumArtUrlCache[key] = saved
                    return@withContext saved
                }
            }
        }

        val encoded = URLEncoder.encode(term, "UTF-8")
        val body = httpGetText(
            url = "https://itunes.apple.com/search?term=$encoded&media=music&entity=album&limit=8",
            headers = mapOf("Accept" to "application/json"),
        )
        var resolved = body?.let { pickBestItunesAlbumArt(it, cleanArtist, cleanAlbum) }.orEmpty()

        // Fall back to YouTube Music album/song search when iTunes misses or returns unrelated singles.
        if (resolved.isEmpty()) {
            val ytm = searchYouTubeMusic(term)
            val targetAlbum = fold(cleanAlbum)
            val targetArtist = fold(cleanArtist)
            val matchedAlbum = ytm.albums.firstOrNull { alb ->
                val fTitle = fold(alb.title)
                val fArt = fold(alb.artist)
                (targetAlbum.isEmpty() || fTitle == targetAlbum || fTitle.contains(targetAlbum) || targetAlbum.contains(fTitle)) &&
                    (targetArtist.isEmpty() || fArt.isEmpty() || fArt.contains(targetArtist) || targetArtist.contains(fArt)) &&
                    alb.artUrl.isNotBlank()
            } ?: ytm.albums.firstOrNull { alb ->
                val fTitle = fold(alb.title)
                targetAlbum.isNotEmpty() && (fTitle == targetAlbum || fTitle.contains(targetAlbum)) && alb.artUrl.isNotBlank()
            }
            val matchedSong = if (matchedAlbum == null) {
                ytm.songs.firstOrNull { s ->
                    val fArt = fold(s.artist)
                    val fTitle = fold(s.title)
                    s.artUrl.isNotBlank() &&
                        (targetArtist.isEmpty() || fArt.contains(targetArtist) || targetArtist.contains(fArt)) &&
                        (targetAlbum.isEmpty() || fold(s.album).contains(targetAlbum) || fTitle.contains(targetAlbum))
                }
            } else {
                null
            }
            resolved = (matchedAlbum?.artUrl ?: matchedSong?.artUrl).orEmpty()
                .takeIf { ExternalImageCache.isAllowedUrl(it) }
                .orEmpty()
        }

        if (resolved.isNotEmpty()) {
            rememberAlbumArtUrl(artist, album, resolved)
            return@withContext resolved
        }
        albumArtNegativeCache[key] = System.currentTimeMillis()
        null
    }

    internal fun pickBestItunesAlbumArt(body: String, artist: String, album: String): String? {
        return try {
            val root = JSONObject(body)
            val arr = root.optJSONArray("results") ?: return null
            val targetAlbum = fold(album)
            val targetArtist = fold(artist)
            val wantsSingle = targetAlbum.contains("single")
            val wantsRemix = targetAlbum.contains("remix") || targetAlbum.contains("b sides")
            val wantsInstrumental = targetAlbum.contains("instrumental") || targetAlbum.contains("karaoke")
            var bestScore = Int.MIN_VALUE
            var bestUrl: String? = null
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val col = item.optString("collectionName").trim()
                val art = item.optString("artistName").trim()
                val rawArt = item.optString("artworkUrl100").ifBlank { item.optString("artworkUrl60") }
                val upsized = upsizeArtworkUrl(rawArt).takeIf { ExternalImageCache.isAllowedUrl(it) } ?: continue
                val fCol = fold(col)
                val fArt = fold(art)
                var score = 0
                when {
                    targetAlbum.isNotEmpty() && fCol == targetAlbum -> score += 80
                    targetAlbum.isNotEmpty() && (fCol.contains(targetAlbum) || targetAlbum.contains(fCol)) -> score += 45
                    targetAlbum.isNotEmpty() -> score -= 60
                }
                when {
                    targetArtist.isNotEmpty() && fArt == targetArtist -> score += 60
                    targetArtist.isNotEmpty() && (fArt.contains(targetArtist) || targetArtist.contains(fArt)) -> score += 35
                    targetArtist.isNotEmpty() -> score -= 60
                }
                if (!wantsSingle && (col.endsWith(" - Single", ignoreCase = true) || col.endsWith(" - EP", ignoreCase = true))) {
                    score -= 25
                }
                if (!wantsRemix && (fCol.contains("remix") || fCol.contains("b sides") || fCol.contains("drumless"))) {
                    score -= 30
                }
                if (!wantsInstrumental && (fCol.contains("instrumental") || fCol.contains("karaoke") || fCol.contains("tribute") || fCol.contains("cover"))) {
                    score -= 70
                }
                if (score > bestScore && score >= 50) {
                    bestScore = score
                    bestUrl = upsized
                }
            }
            bestUrl
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun albumArtThumbKey(artist: String, album: String): String? =
        albumArtCacheKey(artist, album)?.let { "alb:$it" }

    private fun albumArtCacheKey(artist: String, album: String): String? {
        val a = fold(artist)
        val b = fold(album)
        if (b.isEmpty()) return null
        return "$a|$b"
    }

    suspend fun searchCreatorsTypeahead(query: String): List<CreatorSuggestion> = withContext(Dispatchers.IO) {
        if (failClosedMeta) return@withContext emptyList()
        val trimmed = query.trim()
        if (trimmed.length < 2) return@withContext emptyList()
        if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true) ||
            trimmed.startsWith("peartube://", ignoreCase = true)
        ) {
            return@withContext emptyList()
        }

        val cleanHandle = trimmed.removePrefix("@").trim()
        val tryDirectHandle = trimmed.startsWith("@") || (!trimmed.contains(' ') && HANDLE_RE.matches(cleanHandle))

        coroutineScope {
            val directDeferred = if (tryDirectHandle && cleanHandle.length >= 2) {
                async { fetchDirectYouTubeHandle(cleanHandle) }
            } else {
                null
            }
            val searchDeferred = async { fetchYouTubeChannelSearch(trimmed) }

            val direct = directDeferred?.await()
            val searchResults = searchDeferred.await()

            val combined = ArrayList<CreatorSuggestion>()
            val seen = HashSet<String>()

            fun addUnique(item: CreatorSuggestion) {
                val handleKey = item.handle.removePrefix("@").lowercase(Locale.ROOT)
                val urlKey = item.url.lowercase(Locale.ROOT)
                val idKey = item.id.lowercase(Locale.ROOT)
                val dedupKey = handleKey.ifBlank { idKey.ifBlank { urlKey } }
                if (dedupKey.isNotEmpty() && seen.add(dedupKey)) {
                    combined.add(item)
                }
            }

            if (direct != null) {
                addUnique(direct)
            }
            searchResults.forEach { addUnique(it) }
            combined.take(8)
        }
    }

    suspend fun discoverMusic(
        mood: String,
        query: String = "",
        seedArtists: List<String> = emptyList(),
    ): MusicDiscoverData = withContext(Dispatchers.IO) {
        val cleanQuery = query.trim()
        val normalizedMood = mood.trim().lowercase(Locale.ROOT).ifBlank { "featured" }

        // Step 1: Query local P2P metadata first whenever loopback API is configured
        if (localApiBaseUrl != null) {
            val albums = ArrayList<SuggestedAlbum>()
            val artists = ArrayList<SuggestedArtist>()
            val seenArtists = HashSet<String>()
            if (cleanQuery.isNotEmpty()) {
                val hits = localMetaClient.searchMeta(kind = "album", query = cleanQuery, limit = 20)
                for (hit in hits) {
                    if (hit.title.isBlank()) continue
                    val artUrl = resolveLocalArtUrl(hit.posterUrl, hit.posterHash)
                    if (hit.thumbHash.isNotBlank()) {
                        ThumbHash.rememberThumbHash(hit.id, hit.thumbHash)
                        if (artUrl.isNotBlank()) ThumbHash.rememberThumbHash(artUrl, hit.thumbHash)
                        albumArtThumbKey(hit.subtitle, hit.title)?.let { ThumbHash.rememberThumbHash(it, hit.thumbHash) }
                    }
                    if (artUrl.isNotBlank() && hit.subtitle.isNotBlank()) {
                        rememberAlbumArtUrl(hit.subtitle, hit.title, artUrl)
                    }
                    albums.add(
                        SuggestedAlbum(
                            title = hit.title,
                            artist = hit.subtitle,
                            year = hit.year?.toString().orEmpty(),
                            artUrl = artUrl,
                        ),
                    )
                    val aName = hit.subtitle.trim()
                    if (aName.isNotEmpty() && seenArtists.add(aName.lowercase(Locale.ROOT))) {
                        artists.add(SuggestedArtist(name = aName, genre = "Music", artUrl = artUrl))
                    }
                }
            } else {
                val list = localMetaClient.getMetaList("album", normalizedMood)
                    ?: if (normalizedMood != "featured") localMetaClient.getMetaList("album", "featured") else null
                for (card in list?.cards.orEmpty()) {
                    if (card.title.isBlank()) continue
                    val artUrl = resolveLocalArtUrl(card.posterUrl, card.posterHash)
                    rememberCardArtAndThumb(card, artUrl, "")
                    if (card.thumbHash.isNotBlank()) {
                        albumArtThumbKey(card.subtitle, card.title)?.let { ThumbHash.rememberThumbHash(it, card.thumbHash) }
                    }
                    if (artUrl.isNotBlank() && card.subtitle.isNotBlank()) {
                        rememberAlbumArtUrl(card.subtitle, card.title, artUrl)
                    }
                    albums.add(
                        SuggestedAlbum(
                            title = card.title,
                            artist = card.subtitle,
                            year = card.year?.toString().orEmpty(),
                            artUrl = artUrl,
                        ),
                    )
                    val aName = card.subtitle.trim()
                    if (aName.isNotEmpty() && seenArtists.add(aName.lowercase(Locale.ROOT))) {
                        artists.add(
                            SuggestedArtist(
                                name = aName,
                                genre = card.genres.firstOrNull().orEmpty().ifBlank { "Music" },
                                artUrl = artUrl,
                            ),
                        )
                    }
                }
            }
            if (albums.isNotEmpty() || artists.isNotEmpty()) {
                return@withContext MusicDiscoverData(
                    mood = normalizedMood,
                    query = cleanQuery,
                    artists = artists,
                    songs = emptyList(),
                    albums = albums,
                )
            }
        }

        // Step 2: Fail closed with zero clearnet calls
        if (failClosedMeta) {
            return@withContext MusicDiscoverData(mood = normalizedMood, query = cleanQuery)
        }

        val termsWithLimit: List<Pair<String, Int>> = when {
            cleanQuery.isNotEmpty() -> listOf(cleanQuery to 45)
            normalizedMood == "library" && seedArtists.isNotEmpty() -> {
                seedArtists
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .distinctBy { it.lowercase(Locale.ROOT) }
                    .take(3)
                    .map { it to 16 }
            }
            else -> {
                val preset = MUSIC_MOODS.firstOrNull { it.id == normalizedMood } ?: MUSIC_MOODS.first()
                preset.terms.take(4).map { it to 12 }
            }
        }

        val batches = coroutineScope {
            termsWithLimit.map { (term, limit) ->
                async { fetchItunesSongs(term, limit) }
            }.awaitAll()
        }

        // Round-robin interleave so every artist/seed gets represented in the top rows.
        val interleaved = ArrayList<JSONObject>()
        val maxLen = batches.maxOfOrNull { it.size } ?: 0
        for (i in 0 until maxLen) {
            for (batch in batches) {
                if (i < batch.size) {
                    interleaved.add(batch[i])
                }
            }
        }

        parseItunesDiscovery(normalizedMood, cleanQuery, interleaved)
    }

    private fun fetchDirectYouTubeHandle(handle: String): CreatorSuggestion? {
        val encoded = URLEncoder.encode(handle, "UTF-8").replace("+", "%20")
        val html = httpGetText(
            url = "https://www.youtube.com/@$encoded",
            headers = mapOf(
                "User-Agent" to USER_AGENT,
                "Accept-Language" to "en-US,en;q=0.9",
                "Cookie" to YT_CONSENT_COOKIE,
            ),
        ) ?: return null
        val json = extractYtInitialData(html) ?: return null
        return parseDirectYouTubeChannel(json, handle)
    }

    private fun fetchYouTubeChannelSearch(query: String): List<CreatorSuggestion> {
        val encoded = URLEncoder.encode(query, "UTF-8")
        val html = httpGetText(
            url = "https://www.youtube.com/results?search_query=$encoded&sp=EgIQAg%3D%3D",
            headers = mapOf(
                "User-Agent" to USER_AGENT,
                "Accept-Language" to "en-US,en;q=0.9",
                "Cookie" to YT_CONSENT_COOKIE,
            ),
        ) ?: return emptyList()
        val json = extractYtInitialData(html) ?: return emptyList()
        return parseYouTubeChannelSearch(json)
    }

    private fun fetchItunesSongs(term: String, limit: Int): List<JSONObject> {
        val encoded = URLEncoder.encode(term, "UTF-8")
        val body = httpGetText(
            url = "https://itunes.apple.com/search?term=$encoded&media=music&entity=song&limit=$limit",
            headers = mapOf("Accept" to "application/json"),
        ) ?: return emptyList()
        return try {
            val root = JSONObject(body)
            val arr = root.optJSONArray("results") ?: return emptyList()
            List(arr.length()) { arr.optJSONObject(it) }.filterNotNull()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun httpPostText(url: String, body: String, headers: Map<String, String>): String? {
        if (!ExternalImageCache.isLoopbackUrl(url)) {
            if (failClosedMeta) return null
            clearnetRequestHook?.invoke(url)
        }
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                instanceFollowRedirects = true
                doOutput = true
                headers.forEach { (k, v) -> setRequestProperty(k, v) }
            }
            val payloadBytes = body.toByteArray(Charsets.UTF_8)
            conn.outputStream.use { it.write(payloadBytes) }
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val sb = StringBuilder()
                val buf = CharArray(8192)
                var total = 0
                while (true) {
                    val n = reader.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > 2_500_000) break
                    sb.append(buf, 0, n)
                }
                sb.toString()
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    private fun httpGetText(url: String, headers: Map<String, String>): String? {
        if (!ExternalImageCache.isLoopbackUrl(url)) {
            if (failClosedMeta) return null
            clearnetRequestHook?.invoke(url)
        }
        var currentUrl = url
        for (hop in 0..3) {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    instanceFollowRedirects = false
                    headers.forEach { (k, v) -> setRequestProperty(k, v) }
                }
                val code = conn.responseCode
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    val loc = conn.getHeaderField("Location")?.trim().orEmpty()
                    if (loc.isEmpty() || hop == 3) return null
                    val next = runCatching { URL(URL(currentUrl), loc).toString() }.getOrNull() ?: return null
                    if (!next.startsWith("https://", ignoreCase = true)) return null
                    currentUrl = next
                    continue
                }
                if (code !in 200..299) return null
                return conn.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                    val sb = StringBuilder()
                    val buf = CharArray(8192)
                    var total = 0
                    while (true) {
                        val n = reader.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > 2_500_000) break
                        sb.append(buf, 0, n)
                    }
                    sb.toString()
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                return null
            } finally {
                runCatching { conn?.disconnect() }
            }
        }
        return null
    }

    internal fun extractPrimaryArtist(rawArtist: String): String {
        val trimmed = rawArtist.trim()
        if (trimmed.isEmpty()) return ""
        val first = ARTIST_SPLIT_RE.split(trimmed, limit = 2).firstOrNull()?.trim().orEmpty()
        return first.ifBlank { trimmed }
    }

    internal fun upsizeArtworkUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) return ""
        val https = when {
            trimmed.startsWith("//") -> "https:$trimmed"
            trimmed.startsWith("http://", ignoreCase = true) -> "https://${trimmed.substring(7)}"
            else -> trimmed
        }
        return ARTWORK_SIZE_RE.replace(https, "/600x600bb$1")
    }

    internal fun parseItunesDiscovery(
        mood: String,
        query: String,
        results: List<JSONObject>,
    ): MusicDiscoverData {
        val artists = ArrayList<SuggestedArtist>()
        val seenArtists = HashSet<String>()
        val songs = ArrayList<SuggestedSong>()
        val seenSongs = HashSet<String>()
        val albums = ArrayList<SuggestedAlbum>()
        val seenAlbums = HashSet<String>()

        for (item in results) {
            val rawArtist = item.optString("artistName").trim()
            val primaryArtist = extractPrimaryArtist(rawArtist)
            val trackName = item.optString("trackName").trim()
            val collectionName = item.optString("collectionName").trim()
            val artUrl = upsizeArtworkUrl(
                item.optString("artworkUrl100").ifBlank { item.optString("artworkUrl60") },
            )
            val genre = item.optString("primaryGenreName").trim()
            val previewUrl = item.optString("previewUrl").trim()
            val trackId = item.optLong("trackId", 0L)
            val durationSecs = (item.optLong("trackTimeMillis", 0L) / 1000L).toInt().coerceAtLeast(0)
            val releaseDate = item.optString("releaseDate").trim()
            val year = if (releaseDate.length >= 4 && releaseDate.substring(0, 4).all { it.isDigit() }) {
                releaseDate.substring(0, 4)
            } else {
                ""
            }

            if (primaryArtist.isNotEmpty() && artists.size < 8) {
                val aKey = primaryArtist.lowercase(Locale.ROOT)
                if (seenArtists.add(aKey)) {
                    artists.add(
                        SuggestedArtist(
                            name = primaryArtist,
                            genre = genre.ifBlank { "Music" },
                            artUrl = artUrl,
                        ),
                    )
                }
            }

            if (trackName.isNotEmpty() && rawArtist.isNotEmpty() && songs.size < 12) {
                val sKey = "${primaryArtist.lowercase(Locale.ROOT)}|${trackName.lowercase(Locale.ROOT)}"
                if (seenSongs.add(sKey)) {
                    val id = if (trackId > 0L) "itunes:$trackId" else "itunes:$sKey"
                    songs.add(
                        SuggestedSong(
                            id = id,
                            title = trackName,
                            artist = rawArtist,
                            album = collectionName,
                            durationSecs = durationSecs,
                            artUrl = artUrl,
                            previewUrl = previewUrl,
                        ),
                    )
                }
            }

            if (collectionName.isNotEmpty() && primaryArtist.isNotEmpty() && albums.size < 8) {
                val albKey = "${primaryArtist.lowercase(Locale.ROOT)}|${collectionName.lowercase(Locale.ROOT)}"
                if (seenAlbums.add(albKey)) {
                    albums.add(
                        SuggestedAlbum(
                            title = collectionName,
                            artist = primaryArtist,
                            year = year,
                            artUrl = artUrl,
                        ),
                    )
                }
            }
        }

        return MusicDiscoverData(
            mood = mood,
            query = query,
            artists = artists,
            songs = songs,
            albums = albums,
        )
    }

    internal fun extractYtInitialData(html: String): JSONObject? {
        val markers = listOf("var ytInitialData = ", "window[\"ytInitialData\"] = ", "ytInitialData = ")
        var startIdx = -1
        for (marker in markers) {
            val pos = html.indexOf(marker)
            if (pos >= 0) {
                val brace = html.indexOf('{', pos + marker.length)
                if (brace >= 0) {
                    startIdx = brace
                    break
                }
            }
        }
        if (startIdx < 0) return null

        var depth = 0
        var inString = false
        var escaped = false
        var endIdx = -1
        for (i in startIdx until html.length) {
            val ch = html[i]
            if (inString) {
                if (escaped) {
                    escaped = false
                } else if (ch == '\\') {
                    escaped = true
                } else if (ch == '"') {
                    inString = false
                }
            } else {
                when (ch) {
                    '"' -> inString = true
                    '{' -> depth++
                    '}' -> {
                        depth--
                        if (depth == 0) {
                            endIdx = i
                            break
                        }
                    }
                }
            }
        }
        if (endIdx <= startIdx) return null
        return try {
            JSONObject(html.substring(startIdx, endIdx + 1))
        } catch (_: Exception) {
            null
        }
    }

    internal fun parseDirectYouTubeChannel(root: JSONObject, fallbackHandle: String): CreatorSuggestion? {
        val meta = root.optJSONObject("metadata")?.optJSONObject("channelMetadataRenderer")
        val header = root.optJSONObject("header")
        val pageHeader = header?.optJSONObject("pageHeaderRenderer")
        val pageModel = pageHeader?.optJSONObject("content")?.optJSONObject("pageHeaderViewModel")
        val c4 = header?.optJSONObject("c4TabbedHeaderRenderer")

        val channelId = meta?.optString("externalId").orEmpty()
            .ifBlank { c4?.optString("channelId").orEmpty() }
        val name = meta?.optString("title").orEmpty()
            .ifBlank { pageHeader?.optString("pageTitle").orEmpty() }
            .ifBlank { c4?.optString("title").orEmpty() }
            .trim()
        if (name.isEmpty()) return null

        val canonicalUrl = meta?.optString("channelUrl").orEmpty().ifBlank {
            val vanity = meta?.optString("vanityChannelUrl").orEmpty()
            if (vanity.isNotBlank()) vanity else "https://www.youtube.com/@$fallbackHandle"
        }

        var handle = ""
        var subscribers = ""
        val metaRows = pageModel
            ?.optJSONObject("metadata")
            ?.optJSONObject("contentMetadataViewModel")
            ?.optJSONArray("metadataRows")
        if (metaRows != null) {
            for (r in 0 until metaRows.length()) {
                val parts = metaRows.optJSONObject(r)?.optJSONArray("metadataParts") ?: continue
                for (p in 0 until parts.length()) {
                    val text = parts.optJSONObject(p)?.optJSONObject("text")?.optString("content").orEmpty().trim()
                    if (text.startsWith("@") && handle.isEmpty()) {
                        handle = text
                    } else if (text.contains("subscriber", ignoreCase = true) && subscribers.isEmpty()) {
                        subscribers = text
                    }
                }
            }
        }

        if (handle.isEmpty()) {
            val c4Handle = readYtText(c4?.optJSONObject("channelHandleText"))
            handle = c4Handle.ifBlank { "@${fallbackHandle.removePrefix("@")}" }
        }
        if (subscribers.isEmpty()) {
            subscribers = readYtText(c4?.optJSONObject("subscriberCountText"))
        }

        val avatar = lastThumbnailUrl(meta?.optJSONObject("avatar")?.optJSONArray("thumbnails"))
            .ifBlank {
                lastThumbnailUrl(
                    pageModel?.optJSONObject("image")
                        ?.optJSONObject("decoratedAvatarViewModel")
                        ?.optJSONObject("avatar")
                        ?.optJSONObject("avatarViewModel")
                        ?.optJSONObject("image")
                        ?.optJSONArray("sources"),
                )
            }
            .ifBlank { lastThumbnailUrl(c4?.optJSONObject("avatar")?.optJSONArray("thumbnails")) }

        return CreatorSuggestion(
            id = if (channelId.isNotBlank()) "youtube:$channelId" else "youtube:${handle.lowercase(Locale.ROOT)}",
            name = name,
            handle = handle,
            subscribers = subscribers,
            avatarUrl = normalizeThumb(avatar),
            url = if (handle.startsWith("@")) "https://www.youtube.com/$handle" else canonicalUrl,
            source = "youtube",
        )
    }

    internal fun parseYouTubeChannelSearch(root: JSONObject): List<CreatorSuggestion> {
        val found = ArrayList<CreatorSuggestion>()
        collectChannelRenderers(root, found, limit = 10)
        return found
    }

    internal fun parseYouTubeVideoSearch(json: JSONObject): List<ExternalVideoPick> {
        val found = ArrayList<ExternalVideoPick>()
        val seen = HashSet<String>()
        collectVideoRenderers(json, found, seen, limit = 14)
        return found
    }

    private fun collectVideoRenderers(
        node: Any?,
        out: MutableList<ExternalVideoPick>,
        seen: MutableSet<String>,
        limit: Int,
    ) {
        if (node == null || out.size >= limit) return
        when (node) {
            is JSONObject -> {
                val renderer = node.optJSONObject("videoRenderer")
                if (renderer != null) {
                    parseVideoRenderer(renderer)?.let { pick ->
                        if (seen.add(pick.videoId)) {
                            out.add(pick)
                        }
                    }
                    if (out.size >= limit) return
                }
                val keys = node.keys()
                while (keys.hasNext() && out.size < limit) {
                    val key = keys.next()
                    if (key == "videoRenderer") continue
                    collectVideoRenderers(node.opt(key), out, seen, limit)
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    if (out.size >= limit) break
                    collectVideoRenderers(node.opt(i), out, seen, limit)
                }
            }
        }
    }

    private fun parseVideoRenderer(r: JSONObject): ExternalVideoPick? {
        val videoId = r.optString("videoId").trim()
        if (videoId.isEmpty()) return null
        val durationText = readYtText(r.optJSONObject("lengthText")).trim()
        if (durationText.isEmpty()) return null
        val title = readYtText(r.optJSONObject("title")).trim()
        if (title.isEmpty()) return null

        val ownerObj = r.optJSONObject("ownerText")
            ?: r.optJSONObject("longBylineText")
            ?: r.optJSONObject("shortBylineText")
        val channelName = readYtText(ownerObj).trim()
        val channelEndpoint = ownerObj
            ?.optJSONArray("runs")
            ?.optJSONObject(0)
            ?.optJSONObject("navigationEndpoint")
            ?.optJSONObject("browseEndpoint")
        val canonicalBase = channelEndpoint?.optString("canonicalBaseUrl").orEmpty().trim()
        val browseId = channelEndpoint?.optString("browseId").orEmpty().trim()
        val channelUrl = when {
            canonicalBase.startsWith("/") -> "https://www.youtube.com$canonicalBase"
            browseId.isNotEmpty() -> "https://www.youtube.com/channel/$browseId"
            else -> ""
        }
        val publishedText = readYtText(r.optJSONObject("publishedTimeText")).trim()

        return ExternalVideoPick(
            videoId = videoId,
            title = title,
            channelName = channelName,
            channelUrl = channelUrl,
            durationText = durationText,
            publishedText = publishedText,
            thumbUrl = "https://i.ytimg.com/vi/$videoId/hqdefault.jpg",
            watchUrl = "https://www.youtube.com/watch?v=$videoId",
        )
    }

    private fun collectChannelRenderers(node: Any?, out: MutableList<CreatorSuggestion>, limit: Int) {
        if (node == null || out.size >= limit) return
        when (node) {
            is JSONObject -> {
                val renderer = node.optJSONObject("channelRenderer")
                if (renderer != null) {
                    parseChannelRenderer(renderer)?.let { out.add(it) }
                    if (out.size >= limit) return
                }
                val keys = node.keys()
                while (keys.hasNext() && out.size < limit) {
                    val key = keys.next()
                    if (key == "channelRenderer") continue
                    collectChannelRenderers(node.opt(key), out, limit)
                }
            }
            is JSONArray -> {
                for (i in 0 until node.length()) {
                    if (out.size >= limit) break
                    collectChannelRenderers(node.opt(i), out, limit)
                }
            }
        }
    }

    private fun parseChannelRenderer(r: JSONObject): CreatorSuggestion? {
        val channelId = r.optString("channelId").trim()
        val name = readYtText(r.optJSONObject("title")).trim()
        if (name.isEmpty()) return null

        val canonicalBase = r.optJSONObject("navigationEndpoint")
            ?.optJSONObject("browseEndpoint")
            ?.optString("canonicalBaseUrl")
            .orEmpty()
            .trim()

        val subText = readYtText(r.optJSONObject("subscriberCountText")).trim()
        val vidText = readYtText(r.optJSONObject("videoCountText")).trim()

        // YouTube's modern layout often places @handle in subscriberCountText and subscriber count in videoCountText.
        val handle = when {
            subText.startsWith("@") -> subText
            canonicalBase.startsWith("/@") -> canonicalBase.removePrefix("/")
            else -> ""
        }
        val subscribers = when {
            vidText.contains("subscriber", ignoreCase = true) -> vidText
            subText.contains("subscriber", ignoreCase = true) -> subText
            else -> ""
        }

        val url = when {
            handle.startsWith("@") -> "https://www.youtube.com/$handle"
            canonicalBase.startsWith("/") -> "https://www.youtube.com$canonicalBase"
            channelId.isNotEmpty() -> "https://www.youtube.com/channel/$channelId"
            else -> return null
        }

        val avatar = lastThumbnailUrl(r.optJSONObject("thumbnail")?.optJSONArray("thumbnails"))
        return CreatorSuggestion(
            id = if (channelId.isNotEmpty()) "youtube:$channelId" else "youtube:${url.lowercase(Locale.ROOT)}",
            name = name,
            handle = handle,
            subscribers = subscribers,
            avatarUrl = normalizeThumb(avatar),
            url = url,
            source = "youtube",
        )
    }

    private fun readYtText(obj: JSONObject?): String {
        if (obj == null) return ""
        val simple = obj.optString("simpleText")
        if (simple.isNotEmpty()) return simple
        val runs = obj.optJSONArray("runs") ?: return ""
        val sb = StringBuilder()
        for (i in 0 until runs.length()) {
            sb.append(runs.optJSONObject(i)?.optString("text").orEmpty())
        }
        return sb.toString()
    }

    private fun lastThumbnailUrl(arr: JSONArray?): String {
        if (arr == null || arr.length() == 0) return ""
        for (i in arr.length() - 1 downTo 0) {
            val url = arr.optJSONObject(i)?.optString("url").orEmpty().trim()
            if (url.isNotEmpty()) return url
        }
        return ""
    }

    private fun normalizeThumb(raw: String): String {
        val trimmed = raw.trim()
        return when {
            trimmed.startsWith("//") -> "https:$trimmed"
            trimmed.startsWith("http://", ignoreCase = true) -> "https://${trimmed.substring(7)}"
            else -> trimmed
        }
    }
}
