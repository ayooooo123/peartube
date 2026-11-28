package com.peartube.app

import com.peartube.shared.formatBytes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

private val PEARTUBE_URI_RE = Regex("peartube://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
private val HTTP_URL_RE = Regex("https?://[^\\s<>\"']+", RegexOption.IGNORE_CASE)
private val STANDALONE_HEX64_RE = Regex("(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])")
private val EXACT_HEX64_RE = Regex("^[0-9a-fA-F]{64}$")
private val TRAILING_PUNCT_CHARS = setOf('.', ',', '!', '?', ';', ':', '"', '\'', '<', '>')
private val AUDIO_ONLY_SITES = setOf("soundcloud", "bandcamp", "mixcloud")

private val TERMINAL_JOB_STATUSES = setOf("done", "completed", "complete", "added", "failed", "error", "dead", "cancelled", "canceled")
private val DONE_JOB_STATUSES = setOf("done", "completed", "complete", "added")
private val FAILED_JOB_STATUSES = setOf("failed", "error", "dead")

enum class SearchSource(val id: String, val label: String) {
    Soulseek("soulseek", "Soulseek"),
    YouTube("youtube", "YouTube"),
    SoundCloud("soundcloud", "SoundCloud"),
    Rumble("rumble", "Rumble"),
}

/**
 * Extracts a `peartube://…` URI, a 64-hex channel key, or the first `https?://…` URL
 * (trimming trailing punctuation) from Android Share Sheet text or pasted input.
 */
fun extractSharedUrl(text: String): String? {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return null

    PEARTUBE_URI_RE.find(trimmed)?.value?.let { raw ->
        val cleaned = trimTrailingUrlPunctuation(raw)
        if (cleaned.length > "peartube://".length) return cleaned
    }

    HTTP_URL_RE.find(trimmed)?.value?.let { raw ->
        val cleaned = trimTrailingUrlPunctuation(raw)
        if (cleaned.length > "http://".length) return cleaned
    }

    if (EXACT_HEX64_RE.matches(trimmed)) {
        return trimmed.lowercase(Locale.ROOT)
    }

    STANDALONE_HEX64_RE.find(trimmed)?.value?.let { hex ->
        return hex.lowercase(Locale.ROOT)
    }

    return null
}

/**
 * Parses `peartube://add?url=<encoded>` and returns the decoded `http(s)://` target URL,
 * or `null` if [uri] is not an add deep link.
 */
fun parsePeartubeAddUrl(uri: String): String? {
    val trimmed = uri.trim()
    if (!trimmed.startsWith("peartube://add", ignoreCase = true)) return null
    val parsed = runCatching { URI(trimmed) }.getOrNull() ?: return null
    if (!parsed.host.equals("add", ignoreCase = true)) return null
    val rawQuery = parsed.rawQuery ?: return null
    for (part in rawQuery.split('&')) {
        val eq = part.indexOf('=')
        if (eq <= 0) continue
        val key = part.substring(0, eq)
        if (!key.equals("url", ignoreCase = true)) continue
        val encoded = part.substring(eq + 1)
        val decoded = runCatching { URLDecoder.decode(encoded, "UTF-8") }.getOrNull()?.trim().orEmpty()
        if (decoded.startsWith("http://", ignoreCase = true) || decoded.startsWith("https://", ignoreCase = true)) {
            return decoded
        }
    }
    return null
}

private fun trimTrailingUrlPunctuation(raw: String): String {
    var s = raw.trim()
    while (s.isNotEmpty()) {
        val last = s.last()
        val drop = when {
            last in TRAILING_PUNCT_CHARS -> true
            last == ')' -> s.count { it == ')' } > s.count { it == '(' }
            last == ']' -> s.count { it == ']' } > s.count { it == '[' }
            last == '}' -> s.count { it == '}' } > s.count { it == '{' }
            else -> false
        }
        if (!drop) break
        s = s.dropLast(1)
    }
    return s
}

data class IdentifyMatch(
    val id: String,
    val title: String,
)

data class IdentifyResult(
    val kind: String = "page",
    val site: String = "",
    val title: String = "",
    val author: String = "",
    val durationSec: Long? = null,
    val audioOnly: Boolean = false,
    val id: String = "",
    val music: MusicMeta? = null,
    val match: IdentifyMatch? = null,
    val size: Long? = null,
    val resolution: String = "",
) {
    val isPage: Boolean get() = kind.equals("page", ignoreCase = true)
    val effectiveId: String get() = match?.id?.takeIf { it.isNotBlank() } ?: id
    val effectiveTitle: String get() = match?.title?.takeIf { it.isNotBlank() } ?: music?.title?.takeIf { it.isNotBlank() } ?: title
    val effectiveArtist: String get() = music?.artist?.takeIf { it.isNotBlank() } ?: author

    companion object {
        fun from(json: JSONObject): IdentifyResult {
            val linkObj = json.optJSONObject("link")
            val plainObj = json.optJSONObject("plain")
            val kind = json.optString("kind").ifBlank { linkObj?.optString("kind").orEmpty() }.ifBlank { "page" }
            val site = json.optString("site").ifBlank { linkObj?.optString("site").orEmpty() }
            val title = json.optString("title")
                .ifBlank { plainObj?.optString("title").orEmpty() }
                .ifBlank { linkObj?.optString("name").orEmpty() }
            val author = json.optString("author")
                .ifBlank { json.optString("uploader") }
                .ifBlank { linkObj?.optString("author").orEmpty() }
                .ifBlank { linkObj?.optString("uploader").orEmpty() }
            val durationSec = optPositiveLong(json, "duration")
                ?: linkObj?.let { optPositiveLong(it, "duration") }
            val audioOnly = if (json.has("audioOnly") && !json.isNull("audioOnly")) {
                json.optBoolean("audioOnly")
            } else {
                site.lowercase(Locale.ROOT) in AUDIO_ONLY_SITES
            }
            val id = json.optString("id").ifBlank { plainObj?.optString("id").orEmpty() }
            val music = MusicMeta.from(json.optJSONObject("music"))
            val matchObj = json.optJSONObject("match")
            val match = when {
                matchObj != null -> {
                    val mId = matchObj.optString("id")
                    val mTitle = matchObj.optString("title")
                    if (mId.isNotBlank() || mTitle.isNotBlank()) IdentifyMatch(mId, mTitle) else null
                }
                else -> {
                    val matchId = json.optString("match").takeUnless { json.isNull("match") || it.isBlank() }
                    val cands = json.optJSONArray("candidates")
                    if (matchId != null && cands != null) {
                        (0 until cands.length())
                            .asSequence()
                            .mapNotNull { cands.optJSONObject(it) }
                            .firstOrNull { it.optString("id") == matchId }
                            ?.let { IdentifyMatch(it.optString("id"), it.optString("title", it.optString("name"))) }
                    } else {
                        null
                    }
                }
            }
            val size = optPositiveLong(json, "size") ?: linkObj?.let { optPositiveLong(it, "size") }
            val resolution = json.optString("resolution").ifBlank { linkObj?.optString("resolution").orEmpty() }
            return IdentifyResult(
                kind = kind,
                site = site,
                title = title,
                author = author,
                durationSec = durationSec,
                audioOnly = audioOnly,
                id = id,
                music = music,
                match = match,
                size = size,
                resolution = resolution,
            )
        }
    }
}

data class AcquireJob(
    val jobId: String,
    val id: String = "",
    val title: String = "",
    val plugin: String = "",
    val status: String = "queued",
    val phase: String? = null,
    val bytes: Long = 0L,
    val total: Long? = null,
    val error: String? = null,
    val note: String? = null,
    val retryable: Boolean = false,
    val peer: String? = null,
    val queuePlace: Int? = null,
    val tracksDone: Int? = null,
    val tracksTotal: Int? = null,
) {
    val isActive: Boolean get() = status.lowercase(Locale.ROOT) !in TERMINAL_JOB_STATUSES
    val isDone: Boolean get() = status.lowercase(Locale.ROOT) in DONE_JOB_STATUSES
    val isFailed: Boolean get() = status.lowercase(Locale.ROOT) in FAILED_JOB_STATUSES
    val isRetrying: Boolean get() = phase.equals("retrying", ignoreCase = true)

    val progressFraction: Float?
        get() {
            val tot = total
            if (tot != null && tot > 0L) {
                return (bytes.toFloat() / tot.toFloat()).coerceIn(0f, 1f)
            }
            val td = tracksDone
            val tt = tracksTotal
            if (tt != null && tt > 0 && td != null) {
                return (td.toFloat() / tt.toFloat()).coerceIn(0f, 1f)
            }
            return null
        }

    fun statusLabel(): String {
        val st = status.lowercase(Locale.ROOT)
        val pct = progressFraction?.let { (it * 100f).toInt().coerceIn(0, 100) }
        return when (st) {
            "queued", "pending" -> {
                if (isRetrying) return "Retrying…"
                val q = queuePlace
                if (q != null && q > 0) "Queued (#$q)" else "Queued"
            }
            "downloading", "transferring", "copying", "fetching", "running" -> {
                val td = tracksDone
                val tt = tracksTotal
                when {
                    tt != null && tt > 1 && td != null -> "Downloading ($td/$tt)"
                    pct != null -> "Downloading $pct%"
                    bytes > 0L -> "Downloading ${formatBytes(bytes)}"
                    else -> "Downloading…"
                }
            }
            "saving", "importing", "processing", "muxing", "verifying", "scanning", "publishing", "announcing" -> "Saving"
            "done", "completed", "complete", "added" -> "Added"
            "cancelled", "canceled" -> "Cancelled"
            "failed", "error", "dead" -> if (!error.isNullOrBlank()) "Failed: $error" else "Failed"
            else -> st.replaceFirstChar { it.uppercase(Locale.ROOT) }
        }
    }

    companion object {
        fun from(raw: JSONObject): AcquireJob {
            val json = raw.optJSONObject("job") ?: raw
            return AcquireJob(
                jobId = json.optString("jobId").ifBlank { json.optString("id") },
                id = json.optString("id"),
                title = json.optString("title"),
                plugin = json.optString("plugin"),
                status = json.optString("status", "queued"),
                phase = json.optString("phase").takeUnless { json.isNull("phase") || it.isBlank() },
                bytes = json.optLong("bytes", 0L).coerceAtLeast(0L),
                total = optPositiveLong(json, "total"),
                error = json.optString("error").takeUnless { json.isNull("error") || it.isBlank() },
                note = json.optString("note").takeUnless { json.isNull("note") || it.isBlank() },
                retryable = json.optBoolean("retryable", false),
                peer = json.optString("peer").takeUnless { json.isNull("peer") || it.isBlank() },
                queuePlace = optNonNegativeInt(json, "queuePlace"),
                tracksDone = optNonNegativeInt(json, "tracksDone") ?: optNonNegativeInt(json, "fileIndex"),
                tracksTotal = optNonNegativeInt(json, "tracksTotal") ?: optNonNegativeInt(json, "fileCount"),
            )
        }
    }
}

data class PluginInfo(
    val name: String,
    val enabled: Boolean = false,
    val configured: Boolean = false,
    val connected: Boolean = false,
    val user: String = "",
    val state: String = "",
    val error: String? = null,
) {
    companion object {
        fun from(json: JSONObject): PluginInfo {
            val st = json.optJSONObject("status")
            return PluginInfo(
                name = json.optString("name"),
                enabled = json.optBoolean("enabled", false),
                configured = st?.optBoolean("configured", false) ?: json.optBoolean("configured", false),
                connected = st?.optBoolean("connected", false) ?: json.optBoolean("connected", false),
                user = st?.optString("user").orEmpty().ifBlank { st?.optString("username").orEmpty() },
                state = st?.optString("state").orEmpty(),
                error = st?.optString("error")?.takeUnless { st.isNull("error") || it.isBlank() },
            )
        }
    }
}

data class SoulseekAlbumCandidate(
    val peer: String,
    val folder: String,
    val artist: String = "",
    val album: String = "",
    val year: String = "",
    val quality: String = "",
    val files: List<String> = emptyList(),
    val fileCount: Int = files.size,
    val size: Long = 0L,
    val slotsOpen: Boolean? = null,
    val queue: Int? = null,
) {
    val displayTitle: String
        get() = album.ifBlank { folder.replace('\\', '/').trimEnd('/').substringAfterLast('/') }.ifBlank { "Album" }

    companion object {
        fun listFrom(arr: JSONArray?): List<SoulseekAlbumCandidate> {
            if (arr == null || arr.length() == 0) return emptyList()
            val grouped = mutableListOf<SoulseekAlbumCandidate>()
            val rawFiles = mutableListOf<JSONObject>()
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                if (obj.has("folder") || obj.has("files") || obj.has("album")) {
                    grouped += fromFolderObject(obj)
                } else if (obj.has("filename")) {
                    rawFiles += obj
                }
            }
            if (rawFiles.isNotEmpty()) {
                grouped += groupRawFiles(rawFiles)
            }
            return grouped
        }

        fun fromFolderObject(json: JSONObject): SoulseekAlbumCandidate {
            val peer = json.optString("peer").ifBlank { json.optString("username") }
            val folder = json.optString("folder")
            val files = parseFileList(json.optJSONArray("files"))
            val parsedHint = parseFolderMeta(folder)
            val artist = json.optString("artist").ifBlank { parsedHint.first }
            val album = json.optString("album").ifBlank { parsedHint.second }
            val year = json.optString("year").ifBlank { parsedHint.third }
            val quality = json.optString("quality").ifBlank {
                formatAudioQuality(
                    sampleExt = files.firstOrNull()?.substringAfterLast('.', "") ?: "",
                    bitDepth = optPositiveInt(json, "bit_depth") ?: optPositiveInt(json, "bitDepth"),
                    sampleRate = optPositiveInt(json, "sample_rate") ?: optPositiveInt(json, "sampleRate"),
                    bitrate = optPositiveInt(json, "bitrate"),
                )
            }
            val fileCount = optPositiveInt(json, "fileCount")
                ?: optPositiveInt(json, "tracks")
                ?: files.size
            val size = json.optLong("size", 0L).coerceAtLeast(0L)
            return SoulseekAlbumCandidate(
                peer = peer,
                folder = folder,
                artist = artist,
                album = album,
                year = year,
                quality = quality,
                files = files,
                fileCount = fileCount,
                size = size,
                slotsOpen = if (json.has("slots") && !json.isNull("slots")) json.optBoolean("slots") else null,
                queue = optNonNegativeInt(json, "queue"),
            )
        }

        private fun groupRawFiles(items: List<JSONObject>): List<SoulseekAlbumCandidate> {
            val buckets = LinkedHashMap<Pair<String, String>, MutableList<JSONObject>>()
            for (item in items) {
                val peer = item.optString("username").ifBlank { item.optString("peer") }
                val filename = item.optString("filename")
                if (peer.isBlank() || filename.isBlank()) continue
                val folder = parentFolderOf(filename)
                buckets.getOrPut(peer to folder) { mutableListOf() }.add(item)
            }
            return buckets.map { (key, group) ->
                val (peer, folder) = key
                val first = group.first()
                val filenames = group.map { it.optString("filename") }.filter { it.isNotBlank() }
                val (artist, album, year) = parseFolderMeta(folder)
                val ext = filenames.firstOrNull()?.substringAfterLast('.', "") ?: ""
                val bitDepth = group.mapNotNull { optPositiveInt(it, "bit_depth") }.maxOrNull()
                val sampleRate = group.mapNotNull { optPositiveInt(it, "sample_rate") }.maxOrNull()
                val bitrate = group.mapNotNull { optPositiveInt(it, "bitrate") }.maxOrNull()
                val totalSize = group.sumOf { it.optLong("size", 0L).coerceAtLeast(0L) }
                SoulseekAlbumCandidate(
                    peer = peer,
                    folder = folder,
                    artist = artist,
                    album = album,
                    year = year,
                    quality = formatAudioQuality(ext, bitDepth, sampleRate, bitrate),
                    files = filenames,
                    fileCount = filenames.size,
                    size = totalSize,
                    slotsOpen = if (first.has("slots")) first.optBoolean("slots") else null,
                    queue = optNonNegativeInt(first, "queue"),
                )
            }
        }
    }
}

data class YouTubeCandidate(
    val videoId: String,
    val title: String,
    val channel: String = "",
    val durationSec: Long? = null,
    val url: String = "",
    val bitrateKbps: Int = 128,
) {
    val qualityLabel: String get() = "Lossy · AAC $bitrateKbps kbps"

    companion object {
        fun from(json: JSONObject): YouTubeCandidate {
            val videoId = json.optString("videoId").ifBlank { json.optString("id") }
            val url = json.optString("url").ifBlank {
                if (videoId.isNotBlank()) "https://www.youtube.com/watch?v=$videoId" else ""
            }
            return YouTubeCandidate(
                videoId = videoId,
                title = json.optString("title").ifBlank { videoId },
                channel = json.optString("channel")
                    .ifBlank { json.optString("author") }
                    .ifBlank { json.optString("uploader") },
                durationSec = optPositiveLong(json, "duration") ?: optPositiveLong(json, "length"),
                url = url,
                bitrateKbps = optPositiveInt(json, "bitrate") ?: 128,
            )
        }
    }
}

data class SoundCloudCandidate(
    val trackId: String,
    val title: String,
    val artist: String = "",
    val album: String = "",
    val durationSec: Long? = null,
    val url: String = "",
) {
    companion object {
        fun from(json: JSONObject): SoundCloudCandidate = SoundCloudCandidate(
            trackId = json.optString("trackId").ifBlank { json.optString("id") },
            title = json.optString("title"),
            artist = json.optString("artist")
                .ifBlank { json.optString("author") }
                .ifBlank { json.optString("uploader") },
            album = json.optString("album"),
            durationSec = optPositiveLong(json, "duration") ?: optPositiveLong(json, "length"),
            url = json.optString("url"),
        )
    }
}

data class RumbleCandidate(
    val rumbleId: String,
    val title: String,
    val channel: String = "",
    val durationSec: Long? = null,
    val url: String = "",
) {
    companion object {
        fun from(json: JSONObject): RumbleCandidate = RumbleCandidate(
            rumbleId = json.optString("rumbleId").ifBlank { json.optString("id") },
            title = json.optString("title"),
            channel = json.optString("channel")
                .ifBlank { json.optString("author") }
                .ifBlank { json.optString("uploader") },
            durationSec = optPositiveLong(json, "duration") ?: optPositiveLong(json, "length"),
            url = json.optString("url"),
        )
    }
}

data class SourceSearchResult(
    val query: String = "",
    val sources: List<String> = emptyList(),
    val soulseek: List<SoulseekAlbumCandidate> = emptyList(),
    val youtube: List<YouTubeCandidate> = emptyList(),
    val soundcloud: List<SoundCloudCandidate> = emptyList(),
    val rumble: List<RumbleCandidate> = emptyList(),
    val errors: Map<String, String> = emptyMap(),
) {
    val isEmpty: Boolean
        get() = soulseek.isEmpty() && youtube.isEmpty() && soundcloud.isEmpty() && rumble.isEmpty()

    companion object {
        private fun itemsForSource(json: JSONObject, bySource: JSONObject, source: String): JSONArray? {
            bySource.optJSONArray(source)?.let { return it }
            val nested = bySource.optJSONObject(source)
            nested?.optJSONArray("candidates")?.let { return it }
            nested?.optJSONArray("results")?.let { return it }
            val flat = json.optJSONArray("results") ?: return null
            val matched = JSONArray()
            for (i in 0 until flat.length()) {
                val obj = flat.optJSONObject(i) ?: continue
                if (obj.optString("source").equals(source, ignoreCase = true)) {
                    matched.put(obj)
                }
            }
            return matched.takeIf { it.length() > 0 }
        }

        fun from(json: JSONObject): SourceSearchResult {
            val bySource = json.optJSONObject("bySource") ?: JSONObject()
            val slskArr = itemsForSource(json, bySource, "soulseek")
            val ytArr = itemsForSource(json, bySource, "youtube")
            val scArr = itemsForSource(json, bySource, "soundcloud")
            val rumbleArr = itemsForSource(json, bySource, "rumble")

            val sourcesArr = json.optJSONArray("sources")
            val sources = if (sourcesArr == null) emptyList() else List(sourcesArr.length()) { sourcesArr.optString(it) }.filter { it.isNotBlank() }

            val errors = buildMap {
                val errorsArr = json.optJSONArray("errors")
                if (errorsArr != null) {
                    for (i in 0 until errorsArr.length()) {
                        val item = errorsArr.optJSONObject(i) ?: continue
                        val src = item.optString("source").trim()
                        val msg = item.optString("message").ifBlank { item.optString("error") }.trim()
                        if (src.isNotEmpty() && msg.isNotEmpty()) put(src, msg)
                    }
                }
                val errorsObj = json.optJSONObject("errors")
                if (errorsObj != null) {
                    val keys = errorsObj.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val msg = errorsObj.optString(k).takeUnless { errorsObj.isNull(k) || it.isBlank() }
                        if (msg != null) put(k, msg)
                    }
                }
            }

            return SourceSearchResult(
                query = json.optString("query"),
                sources = sources,
                soulseek = SoulseekAlbumCandidate.listFrom(slskArr),
                youtube = if (ytArr == null) emptyList() else (0 until ytArr.length()).mapNotNull { ytArr.optJSONObject(it)?.let(YouTubeCandidate::from) },
                soundcloud = if (scArr == null) emptyList() else (0 until scArr.length()).mapNotNull { scArr.optJSONObject(it)?.let(SoundCloudCandidate::from) },
                rumble = if (rumbleArr == null) emptyList() else (0 until rumbleArr.length()).mapNotNull { rumbleArr.optJSONObject(it)?.let(RumbleCandidate::from) },
                errors = errors,
            )
        }
    }
}

data class SoulseekShelfFolder(
    val folder: String,
    val artist: String = "",
    val album: String = "",
    val year: String = "",
    val quality: String = "",
    val files: List<String> = emptyList(),
    val fileCount: Int = files.size,
    val size: Long = 0L,
) {
    val displayTitle: String
        get() = album.ifBlank { folder.replace('\\', '/').trimEnd('/').substringAfterLast('/') }.ifBlank { "Folder" }

    companion object {
        fun from(json: JSONObject): SoulseekShelfFolder {
            val folder = json.optString("folder")
            val files = parseFileList(json.optJSONArray("files"))
            val (hintArtist, hintAlbum, hintYear) = parseFolderMeta(folder)
            return SoulseekShelfFolder(
                folder = folder,
                artist = json.optString("artist").ifBlank { hintArtist },
                album = json.optString("album").ifBlank { hintAlbum },
                year = json.optString("year").ifBlank { hintYear },
                quality = json.optString("quality").ifBlank {
                    formatAudioQuality(
                        sampleExt = files.firstOrNull()?.substringAfterLast('.', "") ?: "",
                        bitDepth = optPositiveInt(json, "bit_depth") ?: optPositiveInt(json, "bitDepth"),
                        sampleRate = optPositiveInt(json, "sample_rate") ?: optPositiveInt(json, "sampleRate"),
                        bitrate = optPositiveInt(json, "bitrate"),
                    )
                },
                files = files,
                fileCount = optPositiveInt(json, "fileCount") ?: optPositiveInt(json, "tracks") ?: files.size,
                size = json.optLong("size", 0L).coerceAtLeast(0L),
            )
        }
    }
}

data class SoulseekShelf(
    val peer: String,
    val folders: List<SoulseekShelfFolder> = emptyList(),
) {
    companion object {
        fun from(json: JSONObject): SoulseekShelf {
            val peer = json.optString("peer").ifBlank { json.optString("username") }
            val foldersArr = json.optJSONArray("folders")
            val folders = if (foldersArr != null) {
                (0 until foldersArr.length()).mapNotNull { foldersArr.optJSONObject(it)?.let(SoulseekShelfFolder::from) }
            } else {
                val filesArr = json.optJSONArray("files")
                SoulseekAlbumCandidate.listFrom(filesArr).map { c ->
                    SoulseekShelfFolder(
                        folder = c.folder,
                        artist = c.artist,
                        album = c.album,
                        year = c.year,
                        quality = c.quality,
                        files = c.files,
                        fileCount = c.fileCount,
                        size = c.size,
                    )
                }
            }
            return SoulseekShelf(peer = peer, folders = folders)
        }
    }
}

data class VisitedShelf(
    val peer: String,
    val folderCount: Int = 0,
    val visitedAt: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject()
        .put("peer", peer)
        .put("folderCount", folderCount)
        .put("visitedAt", visitedAt)

    companion object {
        fun from(json: JSONObject): VisitedShelf = VisitedShelf(
            peer = json.optString("peer"),
            folderCount = json.optInt("folderCount", 0),
            visitedAt = json.optLong("visitedAt", 0L),
        )
    }
}

data class SoulseekPeerSettings(
    val username: String = "",
    val passwordSet: Boolean = false,
    val sharePublicMusic: Boolean = false,
) {
    val isConfigured: Boolean get() = username.isNotBlank() && passwordSet

    companion object {
        fun from(json: JSONObject): SoulseekPeerSettings {
            val nested = json.optJSONObject("settings") ?: json
            val userObj = nested.optJSONObject("soulseekUser") ?: nested.optJSONObject("slskUser")
            val passObj = nested.optJSONObject("soulseekPassword") ?: nested.optJSONObject("slskPass")
            val shareObj = nested.optJSONObject("soulseekShare") ?: nested.optJSONObject("slskShare")

            val username = userObj?.optString("value")
                ?: nested.optString("soulseekUser").ifBlank { nested.optString("slskUser") }
            val passwordSet = when {
                passObj != null -> passObj.optBoolean("set", passObj.optString("value").isNotBlank())
                nested.has("soulseekPasswordSet") -> nested.optBoolean("soulseekPasswordSet", false)
                nested.has("soulseekPassword") -> nested.optString("soulseekPassword").isNotBlank()
                nested.has("slskPass") -> nested.optString("slskPass").isNotBlank()
                else -> false
            }
            val share = when {
                shareObj != null -> shareObj.optBoolean("value", false)
                nested.has("soulseekShare") -> nested.optBoolean("soulseekShare", false)
                nested.has("slskShare") -> nested.optBoolean("slskShare", false)
                else -> false
            }
            return SoulseekPeerSettings(
                username = username.trim(),
                passwordSet = passwordSet,
                sharePublicMusic = share,
            )
        }
    }
}

data class YouTubeTrackInput(
    val videoId: String,
    val title: String,
    val track: Int = 1,
    val disc: Int = 1,
)

data class SoundCloudTrackInput(
    val trackId: String,
    val url: String,
    val title: String,
    val track: Int = 1,
    val disc: Int = 1,
)

data class DiscoverCreator(
    val id: String,
    val source: String,
    val handle: String = "",
    val name: String = "",
    val url: String = "",
    val channelId: String = "",
    val avatar: String = "",
    val followedAt: Long = 0L,
    val followed: Boolean = false,
) {
    val displayName: String get() = name.ifBlank { handle }.ifBlank { id }

    companion object {
        fun from(json: JSONObject): DiscoverCreator {
            val id = optCleanString(json, "id")
            val source = optCleanString(json, "source").lowercase(Locale.ROOT)
            val handle = optCleanString(json, "handle")
            val name = optCleanString(json, "name").ifBlank { handle }.ifBlank { id }
            val followedAt = optPositiveLong(json, "followedAt") ?: 0L
            val followed = if (json.has("followed") && !json.isNull("followed")) {
                json.optBoolean("followed", followedAt > 0L)
            } else {
                followedAt > 0L
            }
            return DiscoverCreator(
                id = id,
                source = source,
                handle = handle,
                name = name,
                url = optCleanString(json, "url"),
                channelId = optCleanString(json, "channelId"),
                avatar = optCleanString(json, "avatar").ifBlank { optCleanString(json, "avatarUrl") },
                followedAt = followedAt,
                followed = followed,
            )
        }
    }
}

data class DiscoverItem(
    val id: String,
    val source: String,
    val kind: String = "video",
    val itemId: String = "",
    val title: String = "",
    val creatorId: String = "",
    val creatorName: String = "",
    val creatorUrl: String = "",
    val url: String = "",
    val thumbnail: String = "",
    val durationSec: Long? = null,
    val publishedAt: Long = 0L,
    val acquireId: String = "",
    val audioOnly: Boolean = false,
    val music: MusicMeta? = null,
    val inLibrary: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject): DiscoverItem {
            val source = optCleanString(json, "source").lowercase(Locale.ROOT)
            val kind = optCleanString(json, "kind").ifBlank { if (source in AUDIO_ONLY_SITES) "audio" else "video" }
            val itemId = optCleanString(json, "itemId")
            val url = optCleanString(json, "url")
            val id = optCleanString(json, "id").ifBlank {
                if (source.isNotBlank() && itemId.isNotBlank()) "$source:$itemId" else url
            }
            val title = optCleanString(json, "title").ifBlank { itemId }
            val creatorName = optCleanString(json, "creatorName")
                .ifBlank { optCleanString(json, "creator") }
                .ifBlank { optCleanString(json, "channel") }
                .ifBlank { optCleanString(json, "artist") }
            val audioOnly = if (json.has("audioOnly") && !json.isNull("audioOnly")) {
                json.optBoolean("audioOnly", false)
            } else {
                kind.equals("audio", ignoreCase = true) || source in AUDIO_ONLY_SITES
            }
            val music = if (!json.isNull("music")) MusicMeta.from(json.optJSONObject("music")) else null
            return DiscoverItem(
                id = id,
                source = source,
                kind = kind,
                itemId = itemId,
                title = title,
                creatorId = optCleanString(json, "creatorId"),
                creatorName = creatorName,
                creatorUrl = optCleanString(json, "creatorUrl"),
                url = url,
                thumbnail = optCleanString(json, "thumbnail").ifBlank { optCleanString(json, "thumb") },
                durationSec = optPositiveLong(json, "duration") ?: optPositiveLong(json, "length"),
                publishedAt = optPositiveLong(json, "publishedAt") ?: 0L,
                acquireId = optCleanString(json, "acquireId"),
                audioOnly = audioOnly,
                music = music,
                inLibrary = json.optBoolean("inLibrary", false),
            )
        }
    }
}

data class DiscoverFeedError(
    val source: String = "",
    val creatorId: String = "",
    val name: String = "",
    val message: String = "",
) {
    val label: String
        get() = name.ifBlank {
            source.replaceFirstChar { it.uppercase(Locale.ROOT) }
        }.ifBlank { "Discover" }

    companion object {
        fun from(json: JSONObject): DiscoverFeedError = DiscoverFeedError(
            source = optCleanString(json, "source").lowercase(Locale.ROOT),
            creatorId = optCleanString(json, "creatorId"),
            name = optCleanString(json, "name"),
            message = optCleanString(json, "message").ifBlank { optCleanString(json, "error") },
        )

        fun listFrom(json: JSONObject): List<DiscoverFeedError> {
            val out = mutableListOf<DiscoverFeedError>()
            val arr = json.optJSONArray("errors")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    val parsed = from(obj)
                    if (parsed.message.isNotBlank()) out += parsed
                }
            } else {
                val obj = json.optJSONObject("errors")
                if (obj != null) {
                    val keys = obj.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val msg = optCleanString(obj, k)
                        if (msg.isNotBlank()) {
                            out += DiscoverFeedError(source = k.lowercase(Locale.ROOT), message = msg)
                        }
                    }
                }
            }
            return out
        }
    }
}

data class DiscoverFeed(
    val creators: List<DiscoverCreator> = emptyList(),
    val items: List<DiscoverItem> = emptyList(),
    val errors: List<DiscoverFeedError> = emptyList(),
    val updatedAt: Long = 0L,
) {
    companion object {
        fun from(json: JSONObject): DiscoverFeed {
            val creatorsArr = json.optJSONArray("creators")
            val creators = if (creatorsArr == null) emptyList() else (0 until creatorsArr.length()).mapNotNull {
                creatorsArr.optJSONObject(it)?.let(DiscoverCreator::from)
            }
            val itemsArr = json.optJSONArray("items")
            val items = if (itemsArr == null) emptyList() else (0 until itemsArr.length()).mapNotNull {
                itemsArr.optJSONObject(it)?.let(DiscoverItem::from)
            }
            return DiscoverFeed(
                creators = creators,
                items = items,
                errors = DiscoverFeedError.listFrom(json),
                updatedAt = optPositiveLong(json, "updatedAt") ?: 0L,
            )
        }
    }
}

data class DiscoverBrowseResult(
    val query: String = "",
    val sources: List<String> = emptyList(),
    val creators: List<DiscoverCreator> = emptyList(),
    val items: List<DiscoverItem> = emptyList(),
    val errors: List<DiscoverFeedError> = emptyList(),
) {
    companion object {
        fun from(json: JSONObject): DiscoverBrowseResult {
            val sourcesArr = json.optJSONArray("sources")
            val sources = if (sourcesArr == null) emptyList() else List(sourcesArr.length()) {
                sourcesArr.optString(it).trim().lowercase(Locale.ROOT)
            }.filter { it.isNotBlank() }
            val creatorsArr = json.optJSONArray("creators")
            val creators = if (creatorsArr == null) emptyList() else (0 until creatorsArr.length()).mapNotNull {
                creatorsArr.optJSONObject(it)?.let(DiscoverCreator::from)
            }
            val itemsArr = json.optJSONArray("items")
            val items = if (itemsArr == null) emptyList() else (0 until itemsArr.length()).mapNotNull {
                itemsArr.optJSONObject(it)?.let(DiscoverItem::from)
            }
            return DiscoverBrowseResult(
                query = optCleanString(json, "query"),
                sources = sources,
                creators = creators,
                items = items,
                errors = DiscoverFeedError.listFrom(json),
            )
        }
    }
}

data class DiscoverFollowResponse(
    val creator: DiscoverCreator? = null,
    val creators: List<DiscoverCreator> = emptyList(),
)

data class DiscoverUnfollowResponse(
    val removed: Boolean = false,
    val creators: List<DiscoverCreator> = emptyList(),
)

data class MetaCard(
    val id: String,
    val kind: String = "",
    val title: String = "",
    val subtitle: String = "",
    val year: Int? = null,
    val ratingX10: Int? = null,
    val genres: List<String> = emptyList(),
    val runtimeMin: Int? = null,
    val thumbHash: String = "",
    val posterHash: String = "",
    val backdropHash: String = "",
    val posterUrl: String? = null,
    val backdropUrl: String? = null,
    val updatedAt: Long = 0L,
    val source: String? = null,
) {
    companion object {
        fun from(json: JSONObject): MetaCard {
            val posterHash = optCleanString(json, "posterHash")
            val backdropHash = optCleanString(json, "backdropHash")
            val posterUrl = optCleanString(json, "posterUrl").ifBlank {
                if (posterHash.length == 64) "/v1/art/$posterHash" else ""
            }.takeIf { it.isNotEmpty() }
            val backdropUrl = optCleanString(json, "backdropUrl").ifBlank {
                if (backdropHash.length == 64) "/v1/art/$backdropHash" else ""
            }.takeIf { it.isNotEmpty() }
            return MetaCard(
                id = optCleanString(json, "id"),
                kind = optCleanString(json, "kind").lowercase(Locale.ROOT),
                title = optCleanString(json, "title"),
                subtitle = optCleanString(json, "subtitle"),
                year = optPositiveInt(json, "year"),
                ratingX10 = optPositiveInt(json, "ratingX10"),
                genres = parseStringList(json.optJSONArray("genres")),
                runtimeMin = optPositiveInt(json, "runtimeMin"),
                thumbHash = optCleanString(json, "thumbHash"),
                posterHash = posterHash,
                backdropHash = backdropHash,
                posterUrl = posterUrl,
                backdropUrl = backdropUrl,
                updatedAt = optPositiveLong(json, "updatedAt") ?: 0L,
                source = optCleanString(json, "source").takeIf { it.isNotEmpty() },
            )
        }
    }
}

data class MetaDetailItem(
    val label: String = "",
    val subId: String = "",
    val season: Int? = null,
    val number: Int? = null,
    val runtimeMin: Int? = null,
) {
    companion object {
        fun from(json: JSONObject): MetaDetailItem = MetaDetailItem(
            label = optCleanString(json, "label"),
            subId = optCleanString(json, "subId"),
            season = optPositiveInt(json, "season"),
            number = optPositiveInt(json, "number"),
            runtimeMin = optPositiveInt(json, "runtimeMin"),
        )
    }
}

data class MetaDetail(
    val id: String,
    val synopsis: String = "",
    val cast: List<String> = emptyList(),
    val directors: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val backdropHash: String = "",
    val backdropUrl: String? = null,
    val items: List<MetaDetailItem> = emptyList(),
    val externalIds: Map<String, String> = emptyMap(),
    val updatedAt: Long = 0L,
    val source: String? = null,
) {
    companion object {
        fun from(json: JSONObject): MetaDetail {
            val backdropHash = optCleanString(json, "backdropHash")
            val backdropUrl = optCleanString(json, "backdropUrl").ifBlank {
                if (backdropHash.length == 64) "/v1/art/$backdropHash" else ""
            }.takeIf { it.isNotEmpty() }
            val itemsArr = json.optJSONArray("items")
            val items = if (itemsArr == null) emptyList() else (0 until itemsArr.length()).mapNotNull {
                itemsArr.optJSONObject(it)?.let(MetaDetailItem::from)
            }
            val externalIds = LinkedHashMap<String, String>()
            val extArr = json.optJSONArray("externalIds")
            if (extArr != null) {
                for (i in 0 until extArr.length()) {
                    val obj = extArr.optJSONObject(i) ?: continue
                    val k = optCleanString(obj, "key")
                    val v = optCleanString(obj, "value")
                    if (k.isNotEmpty() && v.isNotEmpty()) externalIds[k] = v
                }
            } else {
                val extObj = json.optJSONObject("externalIds")
                if (extObj != null) {
                    val keys = extObj.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        val v = optCleanString(extObj, k)
                        if (k.isNotBlank() && v.isNotEmpty()) externalIds[k.trim()] = v
                    }
                }
            }
            return MetaDetail(
                id = optCleanString(json, "id"),
                synopsis = optCleanString(json, "synopsis"),
                cast = parseStringList(json.optJSONArray("cast")),
                directors = parseStringList(json.optJSONArray("directors")),
                tags = parseStringList(json.optJSONArray("tags")),
                backdropHash = backdropHash,
                backdropUrl = backdropUrl,
                items = items,
                externalIds = externalIds,
                updatedAt = optPositiveLong(json, "updatedAt") ?: 0L,
                source = optCleanString(json, "source").takeIf { it.isNotEmpty() },
            )
        }
    }
}

data class MetaList(
    val kind: String,
    val slug: String,
    val title: String = "",
    val ids: List<String> = emptyList(),
    val cards: List<MetaCard> = emptyList(),
    val updatedAt: Long = 0L,
    val source: String? = null,
) {
    companion object {
        fun from(json: JSONObject): MetaList {
            val cardsArr = json.optJSONArray("cards")
            val cards = if (cardsArr == null) emptyList() else (0 until cardsArr.length()).mapNotNull {
                cardsArr.optJSONObject(it)?.let(MetaCard::from)
            }
            return MetaList(
                kind = optCleanString(json, "kind").lowercase(Locale.ROOT),
                slug = optCleanString(json, "slug"),
                title = optCleanString(json, "title"),
                ids = parseStringList(json.optJSONArray("ids")),
                cards = cards,
                updatedAt = optPositiveLong(json, "updatedAt") ?: 0L,
                source = optCleanString(json, "source").takeIf { it.isNotEmpty() },
            )
        }
    }
}

data class MetaSearchHit(
    val id: String,
    val kind: String = "",
    val title: String = "",
    val subtitle: String = "",
    val year: Int? = null,
    val score: Int = 0,
    val thumbHash: String = "",
    val posterHash: String = "",
    val posterUrl: String? = null,
    val source: String? = null,
) {
    companion object {
        fun from(json: JSONObject): MetaSearchHit {
            val posterHash = optCleanString(json, "posterHash")
            val posterUrl = optCleanString(json, "posterUrl").ifBlank {
                if (posterHash.length == 64) "/v1/art/$posterHash" else ""
            }.takeIf { it.isNotEmpty() }
            return MetaSearchHit(
                id = optCleanString(json, "id"),
                kind = optCleanString(json, "kind").lowercase(Locale.ROOT),
                title = optCleanString(json, "title"),
                subtitle = optCleanString(json, "subtitle"),
                year = optPositiveInt(json, "year"),
                score = optNonNegativeInt(json, "score") ?: 0,
                thumbHash = optCleanString(json, "thumbHash"),
                posterHash = posterHash,
                posterUrl = posterUrl,
                source = optCleanString(json, "source").takeIf { it.isNotEmpty() },
            )
        }
    }
}

data class MetaSourceInfo(
    val key: String,
    val uri: String = "",
    val alias: String = "",
    val writable: Boolean = false,
    val seedFull: Boolean = false,
    val active: Boolean = true,
) {
    companion object {
        fun from(json: JSONObject): MetaSourceInfo {
            val key = optCleanString(json, "key").lowercase(Locale.ROOT)
            val uri = optCleanString(json, "uri").ifBlank {
                if (key.length == 64) "peartube://meta/$key" else ""
            }
            return MetaSourceInfo(
                key = key,
                uri = uri,
                alias = optCleanString(json, "alias"),
                writable = json.optBoolean("writable", false),
                seedFull = json.optBoolean("seedFull", false),
                active = if (json.has("active") && !json.isNull("active")) json.optBoolean("active", true) else true,
            )
        }
    }
}

data class MetaSourcesState(
    val sources: List<MetaSourceInfo> = emptyList(),
    val p2pOnlyMetadata: Boolean = false,
    val seedFullMetadata: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject): MetaSourcesState {
            val arr = json.optJSONArray("sources")
            val sources = if (arr == null) emptyList() else (0 until arr.length()).mapNotNull {
                arr.optJSONObject(it)?.let(MetaSourceInfo::from)
            }.filter { it.key.isNotEmpty() }
            return MetaSourcesState(
                sources = sources,
                p2pOnlyMetadata = json.optBoolean("p2pOnlyMetadata", false),
                seedFullMetadata = json.optBoolean("seedFullMetadata", false),
            )
        }
    }
}

/**
 * Resolves a proxied thumbnail path (`/v1/discover/thumb/...` or `/v1/providers/.../thumb/...`)
 * against the local loopback [apiUrl]. Refuses non-loopback external URLs so the UI never dials third parties.
 */
fun resolveLoopbackThumbUrl(apiUrl: String?, rawPath: String): String? {
    val path = rawPath.trim()
    if (path.isEmpty()) return null
    if (path.startsWith("/")) {
        val base = apiUrl?.trim()?.trimEnd('/') ?: return null
        if (base.isEmpty()) return null
        return "$base$path"
    }
    if (path.startsWith("http://127.0.0.1:", ignoreCase = true) ||
        path.startsWith("http://localhost:", ignoreCase = true)
    ) {
        return path
    }
    return null
}

class LoopbackApiException(message: String, val statusCode: Int? = null) : IOException(message)

/**
 * HTTP client for the device's own loopback peer API (`status.apiUrl`).
 * All network I/O runs on [Dispatchers.IO] and surfaces structured failures instead of failing silently.
 */
class LoopbackApi(private val baseUrlProvider: () -> String?) {

    suspend fun identify(url: String): Result<IdentifyResult> = requestJson(
        method = "POST",
        path = "/v1/identify",
        body = JSONObject().put("url", url),
        readTimeoutMs = 60_000,
    ).mapCatching { IdentifyResult.from(it) }

    suspend fun acquire(
        id: String,
        title: String,
        url: String,
        page: Boolean,
        audio: Boolean,
        music: MusicMeta? = null,
    ): Result<AcquireJob> {
        val source = JSONObject()
            .put("url", url)
            .put("page", page)
            .put("audio", audio)
        val payload = JSONObject()
            .put("id", id)
            .put("title", title)
            .put("source", source)
        if (music != null && (!music.title.isNullOrBlank() || !music.artist.isNullOrBlank())) {
            payload.put(
                "music",
                JSONObject().apply {
                    music.title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
                    music.artist?.takeIf { it.isNotBlank() }?.let { put("artist", it) }
                },
            )
        }
        return requestJson(
            method = "POST",
            path = "/v1/acquire",
            body = payload,
            readTimeoutMs = 20_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun listJobs(): Result<List<AcquireJob>> = requestJson(
        method = "GET",
        path = "/v1/jobs",
        readTimeoutMs = 10_000,
    ).mapCatching { json ->
        val arr = json.optJSONArray("jobs") ?: return@mapCatching emptyList()
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(AcquireJob::from) }
    }

    suspend fun cancelJob(jobId: String): Result<Unit> {
        val encoded = URLEncoder.encode(jobId, "UTF-8")
        return requestJson(
            method = "DELETE",
            path = "/v1/jobs/$encoded",
            readTimeoutMs = 10_000,
        ).map { }
    }

    suspend fun retryJob(jobId: String): Result<AcquireJob> {
        val encoded = URLEncoder.encode(jobId, "UTF-8")
        return requestJson(
            method = "POST",
            path = "/v1/jobs/$encoded/retry",
            body = JSONObject(),
            readTimeoutMs = 15_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun resumeJobs(): Result<Int> = requestJson(
        method = "POST",
        path = "/v1/jobs/resume",
        body = JSONObject(),
        readTimeoutMs = 10_000,
    ).mapCatching { json -> json.optInt("resumed", 0) }

    suspend fun listPlugins(): Result<List<PluginInfo>> = requestJson(
        method = "GET",
        path = "/v1/plugins",
        readTimeoutMs = 10_000,
    ).mapCatching { json ->
        val arr = json.optJSONArray("plugins") ?: return@mapCatching emptyList()
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(PluginInfo::from) }
    }

    suspend fun searchSources(query: String, sources: List<String>): Result<SourceSearchResult> {
        val payload = JSONObject()
            .put("query", query)
            .put("sources", JSONArray(sources))
            .put("stream", false)
        return requestJson(
            method = "POST",
            path = "/v1/search/sources",
            body = payload,
            readTimeoutMs = 45_000,
        ).mapCatching { SourceSearchResult.from(it) }
    }

    suspend fun mirrorSoulseek(
        peer: String,
        folder: String,
        artist: String,
        album: String,
        year: String? = null,
        files: List<String> = emptyList(),
    ): Result<AcquireJob> {
        val payload = JSONObject()
            .put("username", peer)
            .put("peer", peer)
            .put("folder", folder)
            .put("artist", artist)
            .put("album", album)
            .apply {
                if (!year.isNullOrBlank()) put("year", year)
                if (files.isNotEmpty()) put("files", JSONArray(files))
            }
        return requestJson(
            method = "POST",
            path = "/v1/providers/soulseek/mirror",
            body = payload,
            readTimeoutMs = 20_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun browseSoulseek(peer: String): Result<SoulseekShelf> = requestJson(
        method = "POST",
        path = "/v1/providers/soulseek/browse",
        body = JSONObject().put("username", peer).put("peer", peer),
        readTimeoutMs = 40_000,
    ).mapCatching { SoulseekShelf.from(it) }

    suspend fun mirrorYouTube(
        artist: String,
        album: String,
        year: String? = null,
        tracks: List<YouTubeTrackInput>,
    ): Result<AcquireJob> {
        val trackArr = JSONArray()
        tracks.forEach { t ->
            trackArr.put(
                JSONObject()
                    .put("videoId", t.videoId)
                    .put("title", t.title)
                    .put("track", t.track)
                    .put("disc", t.disc),
            )
        }
        val payload = JSONObject()
            .put("artist", artist)
            .put("album", album)
            .apply { if (!year.isNullOrBlank()) put("year", year) }
            .put("tracks", trackArr)
        return requestJson(
            method = "POST",
            path = "/v1/providers/youtube/mirror",
            body = payload,
            readTimeoutMs = 20_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun mirrorSoundCloud(
        artist: String,
        album: String,
        tracks: List<SoundCloudTrackInput>,
    ): Result<AcquireJob> {
        val trackArr = JSONArray()
        tracks.forEach { t ->
            trackArr.put(
                JSONObject()
                    .put("trackId", t.trackId)
                    .put("url", t.url)
                    .put("title", t.title)
                    .put("track", t.track)
                    .put("disc", t.disc),
            )
        }
        val payload = JSONObject()
            .put("artist", artist)
            .put("album", album)
            .put("tracks", trackArr)
        return requestJson(
            method = "POST",
            path = "/v1/providers/soundcloud/mirror",
            body = payload,
            readTimeoutMs = 20_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun mirrorRumble(
        title: String,
        url: String,
        rumbleId: String,
        audio: Boolean,
    ): Result<AcquireJob> {
        val payload = JSONObject()
            .put("title", title)
            .put("url", url)
            .put("rumbleId", rumbleId)
            .put("audio", audio)
        return requestJson(
            method = "POST",
            path = "/v1/providers/rumble/mirror",
            body = payload,
            readTimeoutMs = 20_000,
        ).mapCatching { AcquireJob.from(it) }
    }

    suspend fun getSoulseekSettings(): Result<SoulseekPeerSettings> = requestJson(
        method = "GET",
        path = "/v1/settings",
        readTimeoutMs = 10_000,
    ).mapCatching { SoulseekPeerSettings.from(it) }

    suspend fun updateSoulseekSettings(
        username: String,
        password: String?,
        sharePublicMusic: Boolean,
    ): Result<SoulseekPeerSettings> {
        val payload = JSONObject()
            .put("slskUser", username.trim())
            .put("slskShare", sharePublicMusic)
        if (!password.isNullOrEmpty()) {
            payload.put("slskPass", password)
        }
        return requestJson(
            method = "PUT",
            path = "/v1/settings",
            body = payload,
            readTimeoutMs = 15_000,
        ).mapCatching { SoulseekPeerSettings.from(it) }
    }

    suspend fun listDiscoverCreators(): Result<List<DiscoverCreator>> = requestJson(
        method = "GET",
        path = "/v1/discover/creators",
        readTimeoutMs = 10_000,
    ).mapCatching { json ->
        val arr = json.optJSONArray("creators") ?: return@mapCatching emptyList()
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(DiscoverCreator::from) }
    }

    suspend fun followDiscoverCreator(
        url: String,
        source: String? = null,
        name: String? = null,
        channelId: String? = null,
        handle: String? = null,
    ): Result<DiscoverFollowResponse> {
        val payload = JSONObject().put("url", url.trim()).apply {
            source?.trim()?.takeIf { it.isNotEmpty() }?.let { put("source", it.lowercase(Locale.ROOT)) }
            name?.trim()?.takeIf { it.isNotEmpty() }?.let { put("name", it) }
            channelId?.trim()?.takeIf { it.isNotEmpty() }?.let { put("channelId", it) }
            handle?.trim()?.takeIf { it.isNotEmpty() }?.let { put("handle", it) }
        }
        return requestJson(
            method = "POST",
            path = "/v1/discover/creators",
            body = payload,
            readTimeoutMs = 25_000,
        ).mapCatching { json ->
            val creator = json.optJSONObject("creator")?.let(DiscoverCreator::from)
            val arr = json.optJSONArray("creators")
            val list = if (arr == null) emptyList() else (0 until arr.length()).mapNotNull {
                arr.optJSONObject(it)?.let(DiscoverCreator::from)
            }
            DiscoverFollowResponse(creator = creator, creators = list)
        }
    }

    suspend fun unfollowDiscoverCreator(id: String): Result<DiscoverUnfollowResponse> {
        val encoded = URLEncoder.encode(id, "UTF-8").replace("+", "%20")
        return requestJson(
            method = "DELETE",
            path = "/v1/discover/creators/$encoded",
            readTimeoutMs = 10_000,
        ).mapCatching { json ->
            val arr = json.optJSONArray("creators")
            val list = if (arr == null) emptyList() else (0 until arr.length()).mapNotNull {
                arr.optJSONObject(it)?.let(DiscoverCreator::from)
            }
            DiscoverUnfollowResponse(
                removed = json.optBoolean("removed", false),
                creators = list,
            )
        }
    }

    suspend fun getDiscoverFeed(
        source: String = "",
        creatorId: String = "",
        refresh: Boolean = false,
        limit: Int = 40,
    ): Result<DiscoverFeed> {
        val params = buildList {
            val s = source.trim().lowercase(Locale.ROOT)
            val c = creatorId.trim()
            if (s.isNotEmpty()) add("source=${URLEncoder.encode(s, "UTF-8")}")
            if (c.isNotEmpty()) add("creator=${URLEncoder.encode(c, "UTF-8")}")
            if (refresh) add("refresh=1")
            add("limit=${limit.coerceIn(1, 100)}")
        }
        val query = params.joinToString("&")
        return requestJson(
            method = "GET",
            path = "/v1/discover/feed?$query",
            readTimeoutMs = 35_000,
        ).mapCatching { DiscoverFeed.from(it) }
    }

    suspend fun browseDiscover(
        query: String,
        sources: List<String> = listOf("youtube", "soundcloud", "rumble"),
        limit: Int = 12,
    ): Result<DiscoverBrowseResult> {
        val payload = JSONObject()
            .put("query", query.trim())
            .put("sources", JSONArray(sources))
            .put("limit", limit.coerceIn(1, 20))
        return requestJson(
            method = "POST",
            path = "/v1/discover/browse",
            body = payload,
            readTimeoutMs = 45_000,
        ).mapCatching { DiscoverBrowseResult.from(it) }
    }

    suspend fun getMetaCard(id: String): MetaCard? {
        val clean = id.trim()
        if (clean.isEmpty()) return null
        val encoded = URLEncoder.encode(clean, "UTF-8").replace("+", "%20")
        return requestJson(
            method = "GET",
            path = "/v1/meta/card/$encoded",
            readTimeoutMs = 8_000,
        ).mapCatching { json ->
            val card = MetaCard.from(json)
            card.takeIf { it.id.isNotBlank() }
        }.getOrNull()
    }

    suspend fun getMetaDetail(id: String): MetaDetail? {
        val clean = id.trim()
        if (clean.isEmpty()) return null
        val encoded = URLEncoder.encode(clean, "UTF-8").replace("+", "%20")
        return requestJson(
            method = "GET",
            path = "/v1/meta/detail/$encoded",
            readTimeoutMs = 8_000,
        ).mapCatching { json ->
            val detail = MetaDetail.from(json)
            detail.takeIf { it.id.isNotBlank() }
        }.getOrNull()
    }

    suspend fun getMetaList(kind: String, slug: String): MetaList? {
        val cleanKind = kind.trim().lowercase(Locale.ROOT)
        val cleanSlug = slug.trim().lowercase(Locale.ROOT).trim('/')
        if (cleanKind.isEmpty() || cleanSlug.isEmpty()) return null
        val encodedKind = URLEncoder.encode(cleanKind, "UTF-8").replace("+", "%20")
        val encodedSlug = cleanSlug.split('/').joinToString("/") { part ->
            URLEncoder.encode(part, "UTF-8").replace("+", "%20")
        }
        return requestJson(
            method = "GET",
            path = "/v1/meta/list/$encodedKind/$encodedSlug",
            readTimeoutMs = 10_000,
        ).mapCatching { json ->
            val list = MetaList.from(json)
            list.takeIf { it.kind.isNotBlank() || it.cards.isNotEmpty() || it.ids.isNotEmpty() }
        }.getOrNull()
    }

    suspend fun searchMeta(kind: String = "", query: String, limit: Int = 20): List<MetaSearchHit> {
        val cleanQuery = query.trim()
        if (cleanQuery.isEmpty()) return emptyList()
        val params = buildList {
            val cleanKind = kind.trim().lowercase(Locale.ROOT)
            if (cleanKind.isNotEmpty()) add("kind=${URLEncoder.encode(cleanKind, "UTF-8")}")
            add("q=${URLEncoder.encode(cleanQuery, "UTF-8")}")
            add("limit=${limit.coerceIn(1, 64)}")
        }
        return requestJson(
            method = "GET",
            path = "/v1/meta/search?${params.joinToString("&")}",
            readTimeoutMs = 8_000,
        ).mapCatching { json ->
            val arr = json.optJSONArray("hits") ?: return@mapCatching emptyList()
            val fallbackSource = optCleanString(json, "source").takeIf { it.isNotEmpty() }
            (0 until arr.length()).mapNotNull { idx ->
                arr.optJSONObject(idx)?.let { obj ->
                    val hit = MetaSearchHit.from(obj)
                    if (hit.id.isBlank()) null
                    else if (hit.source == null && fallbackSource != null) hit.copy(source = fallbackSource)
                    else hit
                }
            }
        }.getOrDefault(emptyList())
    }

    suspend fun getMetaSources(): MetaSourcesState = requestJson(
        method = "GET",
        path = "/v1/meta/sources",
        readTimeoutMs = 10_000,
    ).mapCatching { MetaSourcesState.from(it) }.getOrThrow()

    suspend fun addMetaSource(
        uriOrKey: String,
        alias: String = "",
        seedFull: Boolean = false,
    ): MetaSourcesState {
        val clean = uriOrKey.trim()
        if (clean.isEmpty()) throw LoopbackApiException("Enter a peartube://meta/… link or 64-hex key.")
        val payload = JSONObject().apply {
            if (clean.startsWith("peartube://", ignoreCase = true)) {
                put("uri", clean)
            } else {
                put("key", clean)
            }
            val cleanAlias = alias.trim()
            if (cleanAlias.isNotEmpty()) put("alias", cleanAlias)
            put("seedFull", seedFull)
        }
        return requestJson(
            method = "POST",
            path = "/v1/meta/sources",
            body = payload,
            readTimeoutMs = 15_000,
        ).mapCatching { MetaSourcesState.from(it) }.getOrThrow()
    }

    suspend fun removeMetaSource(key: String): MetaSourcesState {
        val cleanKey = key.trim().lowercase(Locale.ROOT)
        if (cleanKey.isEmpty()) throw LoopbackApiException("Metadata source key is required.")
        val encoded = URLEncoder.encode(cleanKey, "UTF-8").replace("+", "%20")
        val json = requestJson(
            method = "DELETE",
            path = "/v1/meta/sources/$encoded",
            readTimeoutMs = 15_000,
        ).getOrThrow()
        if (json.has("p2pOnlyMetadata") && json.has("seedFullMetadata")) {
            return MetaSourcesState.from(json)
        }
        return runCatching { getMetaSources() }.getOrElse { MetaSourcesState.from(json) }
    }

    suspend fun setMetaToggles(
        p2pOnlyMetadata: Boolean? = null,
        seedFullMetadata: Boolean? = null,
    ): MetaSourcesState {
        if (p2pOnlyMetadata == null && seedFullMetadata == null) {
            return getMetaSources()
        }
        val payload = JSONObject().apply {
            if (p2pOnlyMetadata != null) put("p2pOnlyMetadata", p2pOnlyMetadata)
            if (seedFullMetadata != null) put("seedFullMetadata", seedFullMetadata)
        }
        return requestJson(
            method = "POST",
            path = "/v1/meta/sources",
            body = payload,
            readTimeoutMs = 15_000,
        ).mapCatching { MetaSourcesState.from(it) }.getOrThrow()
    }

    private suspend fun requestJson(
        method: String,
        path: String,
        body: JSONObject? = null,
        readTimeoutMs: Int = 15_000,
    ): Result<JSONObject> = withContext(Dispatchers.IO) {
        val base = baseUrlProvider()?.trim()?.trimEnd('/')
        if (base.isNullOrEmpty()) {
            return@withContext Result.failure(
                LoopbackApiException("The local peer engine is still starting. Wait a moment and try again."),
            )
        }
        var conn: HttpURLConnection? = null
        try {
            val target = URL("$base$path")
            conn = (target.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 8_000
                readTimeout = readTimeoutMs
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                }
            }
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                conn.outputStream.use { it.write(bytes) }
            }
            val code = conn.responseCode
            val text = runCatching {
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            }.getOrDefault("")

            if (code !in 200..299) {
                val serverError = runCatching {
                    JSONObject(text).optString("error").takeIf { it.isNotBlank() }
                }.getOrNull()
                val message = serverError ?: when (code) {
                    404 -> "This feature is not available on this peer yet (HTTP 404)."
                    501 -> "This extractor is not available on this device (HTTP 501)."
                    503 -> "The local peer engine or source is currently unavailable (HTTP 503)."
                    else -> "Local peer answered HTTP $code."
                }
                return@withContext Result.failure(LoopbackApiException(message, code))
            }

            if (text.isBlank()) {
                return@withContext Result.success(JSONObject())
            }
            val trimmed = text.trim()
            val parsed = if (trimmed.startsWith("[")) {
                JSONObject().put("items", JSONArray(trimmed))
            } else {
                JSONObject(trimmed)
            }
            Result.success(parsed)
        } catch (e: Exception) {
            val msg = e.message?.takeIf { it.isNotBlank() } ?: "Could not reach the local peer engine."
            Result.failure(LoopbackApiException(msg))
        } finally {
            runCatching { conn?.disconnect() }
        }
    }
}

private fun optCleanString(json: JSONObject, key: String): String =
    if (!json.has(key) || json.isNull(key)) "" else json.optString(key).trim()

private fun parseStringList(arr: JSONArray?): List<String> {
    if (arr == null || arr.length() == 0) return emptyList()
    val out = ArrayList<String>(arr.length())
    for (i in 0 until arr.length()) {
        if (arr.isNull(i)) continue
        val s = arr.optString(i).trim()
        if (s.isNotEmpty()) out += s
    }
    return out
}

private fun optPositiveLong(json: JSONObject, key: String): Long? {
    if (!json.has(key) || json.isNull(key)) return null
    val raw = json.opt(key)
    val value = when (raw) {
        is Number -> raw.toLong()
        is String -> raw.toDoubleOrNull()?.toLong() ?: -1L
        else -> -1L
    }
    return value.takeIf { it > 0L }
}

private fun optPositiveInt(json: JSONObject, key: String): Int? {
    val v = optPositiveLong(json, key) ?: return null
    return v.toInt().takeIf { it > 0 }
}

private fun optNonNegativeInt(json: JSONObject, key: String): Int? {
    if (!json.has(key) || json.isNull(key)) return null
    val raw = json.opt(key)
    val value = when (raw) {
        is Number -> raw.toInt()
        is String -> raw.toIntOrNull() ?: -1
        else -> -1
    }
    return value.takeIf { it >= 0 }
}

private fun parseFileList(arr: JSONArray?): List<String> {
    if (arr == null) return emptyList()
    val out = ArrayList<String>(arr.length())
    for (i in 0 until arr.length()) {
        val item = arr.opt(i)
        when (item) {
            is String -> if (item.isNotBlank()) out += item
            is JSONObject -> {
                val path = item.optString("filename").ifBlank { item.optString("path") }.ifBlank { item.optString("name") }
                if (path.isNotBlank()) out += path
            }
        }
    }
    return out
}

private fun parentFolderOf(path: String): String {
    val norm = path.replace('\\', '/')
    val idx = norm.lastIndexOf('/')
    return if (idx > 0) norm.substring(0, idx) else norm
}

private val YEAR_IN_FOLDER_RE = Regex("\\b(1[89]\\d{2}|20\\d{2})\\b")
private val YEAR_WRAP_RE = Regex("\\(\\s*(1[89]\\d{2}|20\\d{2})\\s*\\)|\\[\\s*(1[89]\\d{2}|20\\d{2})\\s*\\]")
private val DISC_DIR_RE = Regex("^(cd|disc|disk)\\s*\\d{1,2}$", RegexOption.IGNORE_CASE)

private fun parseFolderMeta(folder: String): Triple<String, String, String> {
    val parts = folder.replace('\\', '/')
        .split('/')
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("@@") }
    if (parts.isEmpty()) return Triple("", "", "")
    val at = if (parts.size >= 2 && DISC_DIR_RE.matches(parts.last())) parts.size - 2 else parts.size - 1
    val albumDir = parts[at]
    val parentDir = if (at >= 1) parts[at - 1] else ""
    val year = YEAR_IN_FOLDER_RE.find(albumDir)?.groupValues?.get(1).orEmpty()
    val stripped = YEAR_WRAP_RE.replace(albumDir, "").trim()
    val split = stripped.split(Regex("\\s+[-–—]\\s+"))
    return when {
        split.size >= 2 && YEAR_IN_FOLDER_RE.matches(split[0].trim()) ->
            Triple(parentDir, split.drop(1).joinToString(" - ").trim(), year)
        split.size >= 2 ->
            Triple(split[0].trim(), split.drop(1).joinToString(" - ").trim(), year)
        else ->
            Triple(parentDir, stripped.ifBlank { albumDir }, year)
    }
}

private fun formatAudioQuality(
    sampleExt: String,
    bitDepth: Int?,
    sampleRate: Int?,
    bitrate: Int?,
): String {
    val ext = sampleExt.lowercase(Locale.ROOT)
    val codec = when (ext) {
        "flac" -> "FLAC"
        "alac" -> "ALAC"
        "wav" -> "WAV"
        "aiff", "aif" -> "AIFF"
        "mp3" -> "MP3"
        "m4a", "aac" -> "AAC"
        "opus" -> "Opus"
        "ogg" -> "Vorbis"
        else -> ext.uppercase(Locale.ROOT)
    }
    return when {
        codec in setOf("FLAC", "ALAC", "WAV", "AIFF") && bitDepth != null && sampleRate != null -> {
            val khz = if (sampleRate % 1000 == 0) "${sampleRate / 1000} kHz" else "%.1f kHz".format(Locale.ROOT, sampleRate / 1000.0)
            "$codec ${bitDepth}-bit/$khz"
        }
        codec in setOf("FLAC", "ALAC", "WAV", "AIFF") && bitDepth != null -> "$codec ${bitDepth}-bit"
        codec in setOf("FLAC", "ALAC", "WAV", "AIFF") -> codec
        codec.isNotBlank() && bitrate != null -> "$codec $bitrate kbps"
        codec.isNotBlank() -> codec
        bitrate != null -> "$bitrate kbps"
        else -> ""
    }
}
