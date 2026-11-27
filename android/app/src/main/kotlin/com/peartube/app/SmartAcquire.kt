package com.peartube.app

import java.net.URI
import java.util.Locale

enum class ShareImportMode(val id: String, val label: String) {
    Auto("auto", "Auto-save"),
    Ask("ask", "Always ask"),
    ;

    companion object {
        fun fromId(id: String?): ShareImportMode =
            entries.firstOrNull { it.id.equals(id?.trim(), ignoreCase = true) } ?: Auto
    }
}

enum class PodcastImportFormat(val id: String, val label: String) {
    Video("video", "Video"),
    Audio("audio", "Audio only"),
    ;

    companion object {
        fun fromId(id: String?): PodcastImportFormat =
            entries.firstOrNull { it.id.equals(id?.trim(), ignoreCase = true) } ?: Video
    }
}

enum class DetectedMediaKind(val label: String) {
    Music("Music"),
    Podcast("Podcast"),
    Video("Video"),
}

data class SmartAcquirePlan(
    val kind: DetectedMediaKind,
    val title: String,
    val artist: String,
    val album: String,
    val audioOnly: Boolean,
    val reason: String,
)

data class AutoAcquireBanner(
    val jobId: String,
    val url: String,
    val info: IdentifyResult,
    val plan: SmartAcquirePlan,
)

private val MUSIC_TITLE_MARKERS = listOf(
    "(official audio)",
    "[official audio]",
    "official audio",
    "(official video)",
    "[official video]",
    "(official music video)",
    "[official music video]",
    "official music video",
    "(lyric video)",
    "[lyric video]",
    "(official lyric video)",
    "[official lyric video]",
    "official lyric",
    "(lyrics)",
    "[lyrics]",
    "(audio)",
    "[audio]",
    "audio only",
    "(visualizer)",
    "[visualizer]",
    "(official visualizer)",
    "[official visualizer]",
    "(music video)",
    "[music video]",
    "(remix)",
    "[remix]",
    "(acoustic)",
    "(remastered",
    "feat.",
    "ft.",
    "prod.",
    "full album",
)

private val PODCAST_MARKERS = listOf(
    "podcast",
    "full episode",
    "episode ",
    "ep.",
    "ep #",
    "interview",
    "joe rogan",
    "lex fridman",
    "huberman",
    "wvfrm",
    "waveform",
)

private val LONG_TALK_NUMBER_RE = Regex("#\\d+")
private val LONG_TALK_MARKERS = listOf(" with ", " talk", " discussion", " q&a")
private val DASH_SPLIT_RE = Regex("\\s+[-–—]\\s+")
private val MULTI_SPACE_RE = Regex("\\s+")

private val NOISY_BRACKET_RE = Regex(
    pattern = "\\s*[(\\[](?:official\\s+(?:music\\s+)?video|official\\s+audio|official\\s+lyric\\s+video|official\\s+visualizer|lyric\\s+video|lyrics|audio|visualizer|music\\s+video|4k(?:\\s+remaster(?:ed)?)?|hd|hq|uhd|1080p|2160p|remaster(?:ed)?|explicit)[)\\]]",
    option = RegexOption.IGNORE_CASE,
)

private val NOISY_PIPE_SUFFIX_RE = Regex(
    pattern = "\\s*\\|\\s*(?:official\\s+(?:music\\s+)?video|official\\s+audio|official\\s+lyric\\s+video|lyric\\s+video|lyrics|visualizer|music\\s+video|audio|4k(?:\\s+remaster(?:ed)?)?|hd|hq).*$",
    option = RegexOption.IGNORE_CASE,
)

private val TRAILING_TOPIC_RE = Regex("\\s*-\\s*topic$", RegexOption.IGNORE_CASE)
private val TRAILING_VEVO_RE = Regex("\\s*vevo$", RegexOption.IGNORE_CASE)
private val TRAILING_OFFICIAL_RE = Regex("\\s+official$", RegexOption.IGNORE_CASE)
private val TRAILING_MUSIC_RE = Regex("\\s+music$", RegexOption.IGNORE_CASE)

internal fun cleanChannelName(raw: String): String {
    var s = raw.trim()
    if (s.isEmpty()) return ""
    var changed = true
    while (changed) {
        changed = false
        val stripped = when {
            TRAILING_TOPIC_RE.containsMatchIn(s) -> TRAILING_TOPIC_RE.replace(s, "").trim()
            TRAILING_VEVO_RE.containsMatchIn(s) -> TRAILING_VEVO_RE.replace(s, "").trim()
            TRAILING_OFFICIAL_RE.containsMatchIn(s) -> TRAILING_OFFICIAL_RE.replace(s, "").trim()
            TRAILING_MUSIC_RE.containsMatchIn(s) -> TRAILING_MUSIC_RE.replace(s, "").trim()
            else -> s
        }
        if (stripped != s && stripped.length >= 2) {
            s = stripped
            changed = true
        }
    }
    return MULTI_SPACE_RE.replace(s, " ").trim()
}

internal fun cleanMediaTitle(raw: String): String {
    var s = raw.trim()
    if (s.isEmpty()) return ""
    s = NOISY_PIPE_SUFFIX_RE.replace(s, "")
    s = NOISY_BRACKET_RE.replace(s, "")
    s = MULTI_SPACE_RE.replace(s, " ").trim()
    return s.trimEnd('-', '–', '—', '|').trim()
}

private fun extractHostLower(url: String): String =
    runCatching { URI(url.trim()).host?.lowercase(Locale.ROOT).orEmpty() }.getOrDefault("")

private fun isPodcastOrLongTalk(rawTitle: String, rawAuthor: String, durationSec: Long?): Boolean {
    val titleLower = rawTitle.lowercase(Locale.ROOT)
    val authorLower = rawAuthor.lowercase(Locale.ROOT)
    if (PODCAST_MARKERS.any { marker -> titleLower.contains(marker) || authorLower.contains(marker) }) {
        return true
    }
    if (durationSec != null && durationSec >= 1800L) {
        if (LONG_TALK_NUMBER_RE.containsMatchIn(rawTitle)) return true
        if (LONG_TALK_MARKERS.any { marker -> titleLower.contains(marker) }) return true
    }
    return false
}

private fun splitArtistTrack(rawTitle: String): Pair<String, String>? {
    val parts = DASH_SPLIT_RE.split(rawTitle.trim(), limit = 2)
    if (parts.size != 2) return null
    val left = cleanMediaTitle(parts[0])
    val right = cleanMediaTitle(parts[1])
    if (left.length !in 2..45 || right.length !in 2..80) return null
    return left to right
}

fun classifyLinkAcquisition(
    url: String,
    info: IdentifyResult,
    podcastFormat: PodcastImportFormat,
): SmartAcquirePlan {
    val matched = info.match
    if (matched != null && !info.audioOnly) {
        val matchedTitle = matched.title.trim().ifBlank { cleanMediaTitle(info.effectiveTitle) }.ifBlank { info.title.trim() }
        return SmartAcquirePlan(
            kind = DetectedMediaKind.Video,
            title = matchedTitle,
            artist = cleanChannelName(info.effectiveArtist),
            album = "",
            audioOnly = false,
            reason = "Matched catalog title",
        )
    }

    val rawTitle = info.effectiveTitle.ifBlank { info.title }.trim()
    val rawAuthor = info.effectiveArtist.ifBlank { info.author }.trim()
    val cleanedAuthor = cleanChannelName(rawAuthor)
    val cleanedTitle = cleanMediaTitle(rawTitle).ifBlank { rawTitle }
    val host = extractHostLower(url)
    val titleLower = rawTitle.lowercase(Locale.ROOT)
    val authorLower = rawAuthor.lowercase(Locale.ROOT)

    val podcastSignal = isPodcastOrLongTalk(rawTitle, rawAuthor, info.durationSec)
    val splitPair = splitArtistTrack(rawTitle)

    val musicReason = when {
        info.audioOnly -> "Audio source"
        host == "music.youtube.com" -> "YouTube Music link"
        authorLower.endsWith(" - topic") || authorLower.endsWith("vevo") -> "Music artist channel"
        MUSIC_TITLE_MARKERS.any { titleLower.contains(it) } -> "Music title marker"
        splitPair != null && !podcastSignal && (info.durationSec == null || info.durationSec <= 900L) -> "Artist - Track title"
        else -> null
    }

    if (musicReason != null) {
        val effectiveSplit = if (!podcastSignal) splitPair else null
        val finalArtist = if (effectiveSplit != null) {
            cleanChannelName(effectiveSplit.first).ifBlank { effectiveSplit.first }
        } else {
            cleanedAuthor
        }
        val finalTitle = effectiveSplit?.second ?: cleanedTitle
        val album = info.music?.title
            ?.trim()
            ?.takeIf { it.isNotBlank() && !it.equals(finalTitle, ignoreCase = true) }
            .orEmpty()
        return SmartAcquirePlan(
            kind = DetectedMediaKind.Music,
            title = finalTitle,
            artist = finalArtist,
            album = album,
            audioOnly = true,
            reason = musicReason,
        )
    }

    if (podcastSignal) {
        val audioOnly = podcastFormat == PodcastImportFormat.Audio
        return SmartAcquirePlan(
            kind = DetectedMediaKind.Podcast,
            title = cleanedTitle,
            artist = cleanedAuthor,
            album = "",
            audioOnly = audioOnly,
            reason = if (audioOnly) "Podcast preference: audio" else "Podcast preference: video",
        )
    }

    return SmartAcquirePlan(
        kind = DetectedMediaKind.Video,
        title = cleanedTitle,
        artist = cleanedAuthor,
        album = "",
        audioOnly = false,
        reason = "Video link",
    )
}

fun smartParseYouTubeCandidate(candidate: YouTubeCandidate): SmartAcquirePlan {
    val url = candidate.url.ifBlank {
        if (candidate.videoId.isNotBlank()) "https://www.youtube.com/watch?v=${candidate.videoId}" else ""
    }
    val info = IdentifyResult(
        kind = "page",
        site = "YouTube",
        title = candidate.title,
        author = candidate.channel,
        durationSec = candidate.durationSec,
        audioOnly = true,
        id = if (candidate.videoId.isNotBlank()) "yt:${candidate.videoId}" else "",
    )
    return classifyLinkAcquisition(
        url = url,
        info = info,
        podcastFormat = PodcastImportFormat.Audio,
    )
}
