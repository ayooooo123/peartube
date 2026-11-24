package com.peartube.app

import com.peartube.shared.formatBytes
import java.text.Normalizer
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToLong

enum class LibraryKind {
    Movie,
    Series,
    Album,
    Clip,
}

enum class TrackSort(val label: String) {
    Title("Title"),
    Artist("Artist"),
    Album("Album"),
    Size("Size"),
}

data class TileItem(
    val entry: Entry,
    val season: Int? = null,
    val episode: Int? = null,
    val copies: Int = 1,
    val alts: List<Entry> = emptyList(),
)

data class LibraryTile(
    val key: String,
    val kind: LibraryKind,
    val imdb: String? = null,
    val title: String,
    val artist: String = "",
    val album: String = "",
    val releases: Int = 1,
    val keys: List<String> = emptyList(),
    val items: List<TileItem> = emptyList(),
    val saved: Int = 0,
    val partial: Boolean = false,
    val seed: Long = 0L,
    val hue: Int = 0,
) {
    val allSaved: Boolean get() = items.isNotEmpty() && saved == items.size
    val totalSize: Long get() = items.sumOf { it.entry.size }
    val isYoutubeOnly: Boolean get() = kind == LibraryKind.Album && items.isNotEmpty() && items.all { isYt(it.entry) }
    val monogramText: String get() = monogram(if (kind == LibraryKind.Album) album.ifBlank { title } else title)
    val year: String? get() = items.firstNotNullOfOrNull { it.entry.year }
}

data class ArtistGroup(
    val key: String,
    val name: String,
    val albums: List<LibraryTile>,
    val tracks: List<TrackRow>,
) {
    val albumCount: Int get() = albums.size
    val trackCount: Int get() = tracks.size
}

data class TrackRow(
    val album: LibraryTile,
    val item: TileItem,
) {
    val entry: Entry get() = item.entry
    val name: String get() = trackName(entry)
    val artist: String get() = entry.music?.artist?.takeIf { it.isNotBlank() } ?: album.artist
    val albumName: String get() = album.album.ifBlank { album.title }
    val number: String get() = trackNo(entry)
    val size: Long get() = entry.size
}

data class LibraryCatalog(
    val tiles: List<LibraryTile>,
    val albums: List<LibraryTile>,
    val videos: List<LibraryTile>,
    val movies: List<LibraryTile>,
    val series: List<LibraryTile>,
    val clips: List<LibraryTile>,
    val artists: List<ArtistGroup>,
    val allTracks: List<TrackRow>,
) {
    fun tileByKey(key: String): LibraryTile? = tiles.firstOrNull { it.key == key }
    fun albumByKey(key: String): LibraryTile? = albums.firstOrNull { it.key == key }
    fun artistByKey(key: String): ArtistGroup? = artists.firstOrNull { it.key == key }
    fun albumsByArtist(artistName: String, excludeKey: String? = null): List<LibraryTile> {
        val folded = fold(artistName)
        if (folded.isEmpty()) return emptyList()
        return albums.filter { fold(it.artist) == folded && it.key != excludeKey }
    }
    fun tileForEntry(entryKey: String): LibraryTile? =
        tiles.firstOrNull { t -> t.keys.contains(entryKey) || t.items.any { it.entry.key == entryKey || it.alts.any { a -> a.key == entryKey } } }

    companion object {
        val Empty = LibraryCatalog(
            tiles = emptyList(),
            albums = emptyList(),
            videos = emptyList(),
            movies = emptyList(),
            series = emptyList(),
            clips = emptyList(),
            artists = emptyList(),
            allTracks = emptyList(),
        )

        fun build(entries: List<Entry>): LibraryCatalog {
            val tiles = buildTiles(entries)
            val albums = tiles.filter { it.kind == LibraryKind.Album }
            val videos = tiles.filter { it.kind != LibraryKind.Album }
            val movies = videos.filter { it.kind == LibraryKind.Movie }
            val series = videos.filter { it.kind == LibraryKind.Series }
            val clips = videos.filter { it.kind == LibraryKind.Clip }
            val artists = buildArtists(albums)
            val allTracks = albums.flatMap { album -> album.items.map { TrackRow(album, it) } }
            return LibraryCatalog(
                tiles = tiles,
                albums = albums,
                videos = videos,
                movies = movies,
                series = series,
                clips = clips,
                artists = artists,
                allTracks = allTracks,
            )
        }
    }
}

private val IMDB_RE = Regex("^imdb:(tt[0-9]+)(?::s([0-9]+)e([0-9]+))?$")
private val TRAILING_EP_RE = Regex("\\s+S[0-9]+E[0-9]+$", RegexOption.IGNORE_CASE)
private val NON_WORD_RE = Regex("[^\\p{L}\\p{N}\\p{M}]+")
private val MONOGRAM_SPLIT_RE = Regex("[\\s·:/-]+")
private val SMALL_WORDS = setOf(
    "a", "an", "the", "of", "and", "in", "on", "to", "for",
    "le", "la", "les", "de", "der", "die", "das",
)

fun isYt(e: Entry): Boolean = e.id.startsWith("yt:")

fun isSaved(e: Entry): Boolean = e.local || (e.size > 0L && e.cachedBytes >= e.size)

fun trackName(e: Entry): String {
    val musicTitle = e.music?.title?.takeIf { it.isNotBlank() }
    if (musicTitle != null) return musicTitle
    val suffix = e.id.substringAfterLast(':', "").uppercase(Locale.ROOT)
    if (suffix.isNotEmpty()) return suffix
    return e.title.ifBlank { "Track" }
}

fun trackNo(e: Entry): String {
    val s = e.season ?: return ""
    val ep = e.episode ?: return ""
    val prefix = if (s > 1) "$s-" else ""
    return "$prefix${ep.toString().padStart(2, '0')}"
}

fun plural(n: Int, singular: String, plural: String): String =
    "$n ${if (n == 1) singular else plural}"

/** Time left in words: "1 h 36 min left", "31 min left". */
fun formatTimeLeft(remainingMs: Long): String {
    val secs = max(0L, remainingMs) / 1000.0
    val m = max(1L, (secs / 60.0).roundToLong())
    val hrs = m / 60L
    val mins = m % 60L
    val parts = if (hrs > 0L) {
        if (mins > 0L) "$hrs h $mins min" else "$hrs h"
    } else {
        "$mins min"
    }
    return "$parts left"
}

fun tileFactsLine(t: LibraryTile): String {
    val n = t.items.size
    return when (t.kind) {
        LibraryKind.Series -> {
            val seasons = t.items.mapNotNull { it.season }.distinct().size
            val prefix = if (seasons > 1) "${plural(seasons, "season", "seasons")} · " else ""
            prefix + plural(n, "episode", "episodes")
        }
        LibraryKind.Album -> {
            val discs = t.items.mapNotNull { it.season }.distinct().size
            val discPart = if (discs > 1) "${plural(discs, "disc", "discs")} · " else ""
            val sizePart = if (t.totalSize > 0L) " · ${formatBytes(t.totalSize)}" else ""
            discPart + plural(n, "track", "tracks") + sizePart
        }
        LibraryKind.Movie -> {
            val e = t.items.firstOrNull()?.entry
            val second = if (n > 1) "$n versions" else e?.let { formatBytes(it.size) }.orEmpty()
            listOfNotNull("Movie", t.year, second.takeIf { it.isNotEmpty() }).joinToString(" · ")
        }
        LibraryKind.Clip -> {
            val e = t.items.firstOrNull()?.entry
            val second = if (n > 1) "$n versions" else e?.let { formatBytes(it.size) }.orEmpty()
            listOfNotNull("Clip", second.takeIf { it.isNotEmpty() }).joinToString(" · ")
        }
    }
}

fun tileStateLabel(t: LibraryTile): Pair<String, Boolean> {
    if (t.items.isNotEmpty() && t.saved == t.items.size) return "Saved here" to true
    if (t.saved > 0 || t.partial) {
        val text = when (t.kind) {
            LibraryKind.Series -> "${t.saved} saved here"
            LibraryKind.Album -> "${t.saved} of ${t.items.size} saved here"
            else -> "Partly saved"
        }
        return text to false
    }
    return "On the network" to false
}

/**
 * Case, width, punctuation, and Latin/Greek accents fold away.
 * Combining marks stay where the script uses them as letters (Cyrillic й/ё, Indic, Arabic).
 * Turkish dotless ı folds to i; Greek final sigma ς folds to σ.
 */
fun fold(s: String?): String {
    if (s.isNullOrEmpty()) return ""
    val normalized = Normalizer.normalize(s.lowercase(Locale.ROOT), Normalizer.Form.NFKD)
    val sb = StringBuilder(normalized.length)
    var i = 0
    while (i < normalized.length) {
        val cp = normalized.codePointAt(i)
        val count = Character.charCount(cp)
        sb.appendCodePoint(cp)
        i += count
        if (isAccentBase(cp)) {
            while (i < normalized.length) {
                val next = normalized.codePointAt(i)
                if (next in 0x0300..0x036F) {
                    i += Character.charCount(next)
                } else {
                    break
                }
            }
        }
    }
    return sb.toString()
        .replace('ı', 'i')
        .replace('ς', 'σ')
        .replace(NON_WORD_RE, " ")
        .trim()
}

private fun isAccentBase(cp: Int): Boolean =
    (cp in 'A'.code..'Z'.code) ||
        (cp in 'a'.code..'z'.code) ||
        (cp in 0x00C0..0x024F) ||
        (cp in 0x1E00..0x1EFF) ||
        (cp in 0x2C60..0x2C7F) ||
        (cp in 0xA720..0xA7FF) ||
        (cp in 0x0370..0x03FF) ||
        (cp in 0x1F00..0x1FFF)

/** Deterministic 32-bit unsigned FNV-1a with Murmur3 final avalanche, matching src/ui.js. */
fun sleeveHash(s: String): Long {
    var x = 2166136261L.toInt()
    for (i in s.indices) {
        x = (x xor s[i].code) * 16777619
    }
    x = x xor (x ushr 16)
    x *= 0x85ebca6bL.toInt()
    x = x xor (x ushr 13)
    x *= 0xc2b2ae35L.toInt()
    return (x xor (x ushr 16)).toLong() and 0xFFFFFFFFL
}

fun monogram(name: String?): String {
    val words = (name ?: "").split(MONOGRAM_SPLIT_RE).filter { it.isNotEmpty() }
    val big = words.filter { it.lowercase(Locale.ROOT) !in SMALL_WORDS }
    val source = if (big.isNotEmpty()) big else words
    val picked = StringBuilder(2)
    for (w in source) {
        val cp = w.codePointAt(0)
        if (Character.isLetterOrDigit(cp)) {
            picked.appendCodePoint(cp)
            if (picked.length >= 2) break
        }
    }
    val out = picked.toString()
    return (if (out.isEmpty()) "♪" else out).uppercase(Locale.ROOT)
}

private data class RawTile(
    val key: String,
    val kind: LibraryKind,
    val imdb: String?,
    val title: String,
    val items: MutableList<TileItem> = mutableListOf(),
)

private data class AlbumVote(
    val artist: String,
    val album: String,
    var count: Int = 0,
)

private data class AlbumGroupAcc(
    val artist: String,
    val album: String,
    val parts: MutableList<RawTile> = mutableListOf(),
)

private data class MutableTrackRow(
    var entry: Entry,
    val season: Int?,
    val episode: Int?,
    var copies: Int = 1,
    val alts: MutableList<Entry> = mutableListOf(),
)

fun buildTiles(entries: List<Entry>): List<LibraryTile> {
    val rawTiles = LinkedHashMap<String, RawTile>()
    for (e in entries) {
        val m = IMDB_RE.matchEntire(e.id)
        val music = m == null && e.season != null
        val kind = when {
            m == null && music -> LibraryKind.Album
            m == null -> LibraryKind.Clip
            m.groupValues[2].isNotEmpty() -> LibraryKind.Series
            else -> LibraryKind.Movie
        }
        val key = when (kind) {
            LibraryKind.Clip -> "v:${e.id}/${e.sha256}"
            LibraryKind.Album -> "album:${e.seriesKey.ifEmpty { e.id }}"
            LibraryKind.Series -> "show:${m!!.groupValues[1]}"
            LibraryKind.Movie -> "movie:${m!!.groupValues[1]}"
        }
        val tile = rawTiles.getOrPut(key) {
            RawTile(
                key = key,
                kind = kind,
                imdb = m?.groupValues?.get(1),
                title = e.title.replace(TRAILING_EP_RE, ""),
            )
        }
        val season = if (m != null) m.groupValues[2].toIntOrNull() else e.season
        val episode = if (m != null) m.groupValues[3].toIntOrNull() else e.episode
        tile.items.add(TileItem(entry = e, season = season, episode = episode))
    }

    val result = mutableListOf<LibraryTile>()
    val rawAlbums = mutableListOf<RawTile>()

    for (t in rawTiles.values) {
        if (t.kind == LibraryKind.Album) {
            rawAlbums.add(t)
            continue
        }
        val sortedItems = t.items.sortedWith(
            compareBy<TileItem>({ it.season ?: 0 }, { it.episode ?: 0 }, { -it.entry.size }),
        )
        val savedCount = sortedItems.count { isSaved(it.entry) }
        val partial = sortedItems.any { !isSaved(it.entry) && it.entry.cachedBytes > 0L }
        result.add(
            LibraryTile(
                key = t.key,
                kind = t.kind,
                imdb = t.imdb,
                title = t.title,
                keys = sortedItems.map { it.entry.key },
                items = sortedItems,
                saved = savedCount,
                partial = partial,
                seed = sleeveHash(fold(t.title)),
            ),
        )
    }

    result.addAll(mergeAlbums(rawAlbums))
    return result.sortedWith(
        compareBy<LibraryTile>(
            { (it.album.ifEmpty { it.title }).lowercase(Locale.ROOT) },
            { it.title.lowercase(Locale.ROOT) },
        ),
    )
}

private fun mergeAlbums(rawAlbums: List<RawTile>): List<LibraryTile> {
    val groups = LinkedHashMap<String, AlbumGroupAcc>()
    for (t in rawAlbums) {
        val votes = LinkedHashMap<String, AlbumVote>()
        for (item in t.items) {
            val a = item.entry.music?.artist.orEmpty()
            val prefix = "$a · "
            val name = if (a.isNotEmpty() && item.entry.title.startsWith(prefix)) {
                item.entry.title.substring(prefix.length)
            } else {
                item.entry.title
            }
            val voteKey = "$a\n$name"
            val vote = votes.getOrPut(voteKey) { AlbumVote(a, name) }
            vote.count++
        }
        val top = votes.values.maxByOrNull { it.count } ?: AlbumVote("", t.title, 1)
        val id = "${fold(top.artist)}\n${fold(top.album)}"
        val group = groups.getOrPut(id) { AlbumGroupAcc(top.artist, top.album) }
        group.parts.add(t)
    }

    val merged = groups.values.map { acc ->
        val parts = acc.parts.sortedWith(compareBy<RawTile>({ -it.items.size }, { it.key }))
        val all = parts.flatMap { it.items }.sortedWith(
            compareBy<TileItem>(
                { it.season ?: 0 },
                { it.episode ?: 0 },
                { if (isSaved(it.entry)) 0 else 1 },
                { -it.entry.size },
            ),
        )
        val deduped = mutableListOf<MutableTrackRow>()
        for (item in all) {
            val prev = deduped.lastOrNull()
            if (prev != null &&
                prev.season == item.season &&
                prev.episode == item.episode &&
                fold(trackName(prev.entry)) == fold(trackName(item.entry))
            ) {
                prev.copies++
                prev.alts.add(item.entry)
            } else {
                deduped.add(MutableTrackRow(item.entry, item.season, item.episode))
            }
        }
        val named = LinkedHashMap<String, MutableTrackRow>()
        for (row in deduped) {
            if (!isYt(row.entry)) {
                val foldedName = fold(trackName(row.entry))
                if (!named.containsKey(foldedName)) named[foldedName] = row
            }
        }
        val rows = deduped.filter { row ->
            val twin = if (isYt(row.entry) && row.alts.none { !isYt(it) }) {
                named[fold(trackName(row.entry))]
            } else {
                null
            }
            if (twin == null) {
                true
            } else {
                if (isSaved(row.entry) && !isSaved(twin.entry)) {
                    val tmp = twin.entry
                    twin.entry = row.entry
                    row.entry = tmp
                }
                twin.copies += row.copies
                twin.alts.add(row.entry)
                twin.alts.addAll(row.alts)
                false
            }
        }.map { r ->
            TileItem(
                entry = r.entry,
                season = r.season,
                episode = r.episode,
                copies = r.copies,
                alts = r.alts.toList(),
            )
        }
        val artist = acc.artist
        val album = acc.album
        val seed = sleeveHash("${fold(artist)}\n${fold(album)}")
        LibraryTile(
            key = parts.first().key,
            kind = LibraryKind.Album,
            imdb = null,
            title = if (artist.isNotEmpty()) "$artist · $album" else album,
            artist = artist,
            album = album,
            releases = parts.count { p -> !p.items.all { isYt(it.entry) } },
            keys = parts.flatMap { p -> p.items.map { it.entry.key } },
            items = rows,
            saved = rows.count { isSaved(it.entry) },
            partial = rows.any { !isSaved(it.entry) && it.entry.cachedBytes > 0L },
            seed = seed,
            hue = 0,
        )
    }.toMutableList()

    // 6-slot per-artist hue wheel so up to six sibling albums never share a hue.
    val byArtist = LinkedHashMap<String, MutableList<Int>>()
    for (idx in merged.indices) {
        val k = fold(merged[idx].artist)
        byArtist.getOrPut(k) { mutableListOf() }.add(idx)
    }
    for (indices in byArtist.values) {
        val used = HashSet<Int>()
        for (idx in indices.sortedBy { merged[it].seed }) {
            val seed = merged[idx].seed
            var slot = ((seed % 360L) / 60L).toInt()
            var tries = 0
            while (tries < 6 && slot in used) {
                slot = (slot + 1) % 6
                tries++
            }
            used.add(slot)
            val hue = slot * 60 + ((seed ushr 11) % 36L).toInt()
            merged[idx] = merged[idx].copy(hue = hue)
        }
    }
    return merged
}

fun buildArtists(albums: List<LibraryTile>): List<ArtistGroup> {
    val byArtist = LinkedHashMap<String, MutableList<LibraryTile>>()
    for (album in albums) {
        val artistKey = fold(album.artist).ifEmpty { "unknown" }
        byArtist.getOrPut(artistKey) { mutableListOf() }.add(album)
    }
    return byArtist.entries.map { (key, list) ->
        val displayName = list.firstNotNullOfOrNull { it.artist.takeIf { a -> a.isNotBlank() } } ?: "Unknown artist"
        val sortedAlbums = list.sortedBy { it.album.lowercase(Locale.ROOT) }
        val tracks = sortedAlbums.flatMap { alb -> alb.items.map { TrackRow(alb, it) } }
        ArtistGroup(
            key = key,
            name = displayName,
            albums = sortedAlbums,
            tracks = tracks,
        )
    }.sortedBy { it.name.lowercase(Locale.ROOT) }
}

class QueryMatcher(words: String) {
    private val need = fold(words).split(' ').filter { it.isNotEmpty() }

    val isEmpty: Boolean get() = need.isEmpty()

    fun matches(text: String): Boolean {
        if (need.isEmpty()) return false
        val t = fold(text)
        return need.all { w -> t.contains(w) }
    }

    fun matchesTrack(name: String, context: String): Boolean {
        if (need.isEmpty()) return false
        val n = fold(name)
        return need.any { w -> n.contains(w) } && matches("$name $context")
    }
}

fun findIn(words: String): QueryMatcher = QueryMatcher(words)

fun buildTrackRows(
    albums: List<LibraryTile>,
    filter: String = "",
    sort: TrackSort = TrackSort.Title,
    ascending: Boolean = true,
): List<TrackRow> {
    val all = albums.flatMap { album -> album.items.map { TrackRow(album, it) } }
    val matcher = findIn(filter)
    val filtered = if (matcher.isEmpty) {
        all
    } else {
        all.filter { row ->
            matcher.matchesTrack(row.name, "${row.album.title} ${row.artist}")
        }
    }
    val dir = if (ascending) 1 else -1
    return filtered.sortedWith { a, b ->
        when (sort) {
            TrackSort.Title -> compareStringsUnknownLast(a.name, b.name, dir)
            TrackSort.Artist -> compareStringsUnknownLast(a.artist, b.artist, dir)
                .takeIf { it != 0 } ?: compareStringsUnknownLast(a.albumName, b.albumName, 1)
            TrackSort.Album -> compareStringsUnknownLast(a.albumName, b.albumName, dir)
                .takeIf { it != 0 } ?: compareValues(a.item.season ?: 0, b.item.season ?: 0)
                .takeIf { it != 0 } ?: compareValues(a.item.episode ?: 0, b.item.episode ?: 0)
            TrackSort.Size -> compareLongsUnknownLast(a.size, b.size, dir)
        }
    }
}

private fun compareStringsUnknownLast(a: String, b: String, dir: Int): Int {
    val aEmpty = a.isBlank()
    val bEmpty = b.isBlank()
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    return a.lowercase(Locale.ROOT).compareTo(b.lowercase(Locale.ROOT)) * dir
}

private fun compareLongsUnknownLast(a: Long, b: Long, dir: Int): Int {
    val aUnknown = a <= 0L
    val bUnknown = b <= 0L
    if (aUnknown && bUnknown) return 0
    if (aUnknown) return 1
    if (bUnknown) return -1
    return a.compareTo(b) * dir
}

fun TrackRow.toTrackItem(): TrackItem = TrackItem(
    entry = entry,
    title = name,
    artist = artist,
    album = albumName,
    albumKey = album.key,
    hue = album.hue,
    seed = album.seed,
    trackNo = number,
    disc = item.season,
    track = item.episode,
)

fun LibraryTile.toTrackItems(): List<TrackItem> = items.map { item ->
    TrackRow(this, item).toTrackItem()
}
