package com.peartube.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LibraryCatalogTest {
    private fun entry(
        key: String,
        id: String,
        title: String,
        size: Long = 10_000_000L,
        sha256: String = "sha-$key",
        local: Boolean = false,
        cachedBytes: Long = 0L,
        season: Int? = null,
        episode: Int? = null,
        seriesKey: String = "",
        music: MusicMeta? = null,
        year: String? = null,
    ) = Entry(
        key = key,
        id = id,
        title = title,
        size = size,
        sha256 = sha256,
        local = local,
        cachedBytes = cachedBytes,
        streamUrl = "http://127.0.0.1:8175/blob/$key",
        season = season,
        episode = episode,
        seriesKey = seriesKey,
        baseTitle = title,
        year = year,
        music = music,
    )

    @Test
    fun parsesMusicMetaFromEntryJson() {
        val withMusic = Entry.from(
            JSONObject()
                .put("key", "k1")
                .put("id", "mb:abc:s01e01")
                .put("title", "John Coltrane · Blue Train")
                .put("size", 42_000_000L)
                .put("streamUrl", "http://127.0.0.1:8175/b/1")
                .put("season", 1)
                .put("episode", 1)
                .put("seriesKey", "mb:abc")
                .put("music", JSONObject().put("title", "Blue Train").put("artist", "John Coltrane")),
        )
        assertEquals("Blue Train", withMusic.music?.title)
        assertEquals("John Coltrane", withMusic.music?.artist)

        val withoutMusic = Entry.from(
            JSONObject()
                .put("key", "k2")
                .put("id", "imdb:tt0133093")
                .put("title", "The Matrix")
                .put("size", 1_000_000_000L)
                .put("streamUrl", "http://127.0.0.1:8175/b/2"),
        )
        assertNull(withoutMusic.music)
    }

    @Test
    fun classifiesMovieSeriesAlbumAndClip() {
        val entries = listOf(
            entry("m1", "imdb:tt0133093", "The Matrix", size = 4_000_000_000L, year = "1999"),
            entry("m2", "imdb:tt0133093", "The Matrix", size = 8_000_000_000L, year = "1999"),
            entry("s2", "imdb:tt0903747:s01e02", "Breaking Bad S01E02", season = 1, episode = 2, seriesKey = "imdb:tt0903747"),
            entry("s1", "imdb:tt0903747:s01e01", "Breaking Bad S01E01", season = 1, episode = 1, seriesKey = "imdb:tt0903747"),
            entry(
                "a1",
                "mb:rel1:s01e01",
                "John Coltrane · Blue Train",
                season = 1,
                episode = 1,
                seriesKey = "mb:rel1",
                music = MusicMeta(title = "Blue Train", artist = "John Coltrane"),
            ),
            entry("c1", "clip:demo1", "Concert Clip", season = null, episode = null),
        )

        val catalog = LibraryCatalog.build(entries)
        assertEquals(1, catalog.movies.size)
        assertEquals(2, catalog.movies[0].items.size)
        assertEquals("m2", catalog.movies[0].items[0].entry.key) // larger movie version first

        assertEquals(1, catalog.series.size)
        assertEquals("Breaking Bad", catalog.series[0].title)
        assertEquals(listOf("s1", "s2"), catalog.series[0].items.map { it.entry.key })

        assertEquals(1, catalog.albums.size)
        assertEquals("Blue Train", catalog.albums[0].album)
        assertEquals("John Coltrane", catalog.albums[0].artist)

        assertEquals(1, catalog.clips.size)
        assertEquals("Concert Clip", catalog.clips[0].title)
    }

    @Test
    fun mergesMultipleAlbumReleasesDedupsCopiesAndMergesYoutubeCopy() {
        val entries = listOf(
            // Release 1 (3 tracks, track 3 has one bad album tag that should lose majority vote)
            entry("r1-1", "mb:rel1:s01e01", "Miles Davis · Kind of Blue", size = 40_000_000L, season = 1, episode = 1, seriesKey = "mb:rel1", music = MusicMeta("So What", "Miles Davis")),
            entry("r1-2", "mb:rel1:s01e02", "Miles Davis · Kind of Blue", size = 35_000_000L, season = 1, episode = 2, seriesKey = "mb:rel1", music = MusicMeta("Freddie Freeloader", "Miles Davis")),
            entry("r1-3", "mb:rel1:s01e03", "Untitled album", size = 30_000_000L, season = 1, episode = 3, seriesKey = "mb:rel1", music = MusicMeta("Blue in Green", "Miles Davis")),
            // Release 2 (duplicate of track 1, saved locally -> should win over r1-1)
            entry("r2-1", "discogs:rel2:s01e01", "Miles Davis · Kind of Blue", size = 25_000_000L, local = true, season = 1, episode = 1, seriesKey = "discogs:rel2", music = MusicMeta("So What", "Miles Davis")),
            // YouTube copy of "Blue in Green" numbered differently (track 9) -> should fold into track 3
            entry("yt-9", "yt:vid9:s01e09", "Miles Davis · Kind of Blue", size = 5_000_000L, season = 1, episode = 9, seriesKey = "yt:album9", music = MusicMeta("Blue in Green", "Miles Davis")),
        )

        val catalog = LibraryCatalog.build(entries)
        assertEquals(1, catalog.albums.size)
        val album = catalog.albums[0]
        assertEquals("Miles Davis", album.artist)
        assertEquals("Kind of Blue", album.album)
        assertEquals(3, album.items.size)
        // Saved copy from release 2 wins track 1 and carries r1-1 as alt
        assertEquals("r2-1", album.items[0].entry.key)
        assertEquals(2, album.items[0].copies)
        assertEquals(listOf("r1-1"), album.items[0].alts.map { it.key })
        // YouTube copy folded onto Blue in Green
        assertEquals("r1-3", album.items[2].entry.key)
        assertEquals(2, album.items[2].copies)
        assertTrue(album.items[2].alts.any { it.key == "yt-9" })
        // All 5 original announce keys retained on the merged album tile
        assertEquals(5, album.keys.size)
    }

    @Test
    fun spacesUpToSixSiblingAlbumsAcrossSixHueSlots() {
        val entries = (1..6).map { i ->
            entry(
                key = "k$i",
                id = "mb:alb$i:s01e01",
                title = "Aphex Twin · Album $i",
                season = 1,
                episode = 1,
                seriesKey = "mb:alb$i",
                music = MusicMeta("Track 1", "Aphex Twin"),
            )
        }
        val albums = LibraryCatalog.build(entries).albums
        assertEquals(6, albums.size)
        val slots = albums.map { it.hue / 60 }.toSet()
        assertEquals(setOf(0, 1, 2, 3, 4, 5), slots)
    }

    @Test
    fun foldHandlesLatinGreekTurkishAndCyrillic() {
        assertEquals("cafe creme", fold("Café Crème!"))
        assertEquals("οδυσσεασ", fold("Ὀδυσσέας"))
        assertEquals("istanbul diyarbakir", fold("İstanbul Diyarbakır"))
        // Cyrillic й and ё keep their combining marks distinct from и and е
        assertNotEquals(fold("й"), fold("и"))
        assertNotEquals(fold("ё"), fold("е"))
    }

    @Test
    fun monogramAndHashAndTimeLeft() {
        assertEquals("DS", monogram("The Dark Side of the Moon"))
        assertEquals("LS", monogram("A Love Supreme"))
        assertEquals("♪", monogram("---"))
        assertEquals(624097086L, sleeveHash("miles davis\nkind of blue"))
        assertEquals(3124787571L, sleeveHash("john coltrane\nblue train"))
        assertNotEquals(sleeveHash("blue train"), sleeveHash("giant steps"))
        assertEquals("1 h 36 min left", formatTimeLeft((96L * 60L) * 1000L))
        assertEquals("31 min left", formatTimeLeft((31L * 60L) * 1000L))
        assertEquals("1 min left", formatTimeLeft(5_000L))
    }

    @Test
    fun trackRowsFilterAndSortUnknownLast() {
        val entries = listOf(
            entry("a", "mb:1:s01e01", "Coltrane · Blue Train", size = 0L, season = 1, episode = 1, seriesKey = "mb:1", music = MusicMeta("Blue Train", "Coltrane")),
            entry("b", "mb:1:s01e02", "Coltrane · Blue Train", size = 20_000_000L, season = 1, episode = 2, seriesKey = "mb:1", music = MusicMeta("Moment's Notice", "Coltrane")),
            entry("c", "mb:1:s01e03", "Coltrane · Blue Train", size = 50_000_000L, season = 1, episode = 3, seriesKey = "mb:1", music = MusicMeta("Locomotion", "Coltrane")),
        )
        val catalog = LibraryCatalog.build(entries)
        val bySizeDesc = buildTrackRows(catalog.albums, sort = TrackSort.Size, ascending = false)
        // Unknown size (0L) always sorts last even in descending order
        assertEquals(listOf("c", "b", "a"), bySizeDesc.map { it.entry.key })

        val filtered = buildTrackRows(catalog.albums, filter = "notice")
        assertEquals(1, filtered.size)
        assertEquals("b", filtered[0].entry.key)
        assertFalse(findIn("notice").matchesTrack("Blue Train", "Coltrane"))
    }

    @Test
    fun stripsDuplicateTrailingYearFromMovieAndSeriesTitles() {
        val entries = listOf(
            entry("m1", "imdb:tt1375666", "Inception 2010", year = "2010"),
            entry("m2", "imdb:tt0816692", "Interstellar (2014)", year = "2014"),
            entry("m3", "imdb:tt8579674", "1917", year = "2019"),
            entry("m4", "imdb:tt1190080", "2012", year = "2012"),
        )
        val movies = LibraryCatalog.build(entries).movies.associateBy { it.imdb }
        assertEquals("Inception", movies["tt1375666"]?.title)
        assertEquals("Interstellar", movies["tt0816692"]?.title)
        assertEquals("1917", movies["tt8579674"]?.title)
        assertEquals("2012", movies["tt1190080"]?.title)
    }

    @Test
    fun classifiesSingleAcquiredMusicTrackWithoutSeasonIntoAlbumsAndTracks() {
        val entries = listOf(
            entry(
                key = "yt-humble",
                id = "yt:abc123",
                title = "HUMBLE.",
                season = null,
                episode = null,
                seriesKey = "",
                music = MusicMeta(title = "HUMBLE.", artist = "Kendrick Lamar"),
            ),
        )
        val catalog = LibraryCatalog.build(entries)
        assertEquals(1, catalog.albums.size)
        assertEquals(0, catalog.clips.size)
        assertEquals("Kendrick Lamar", catalog.albums[0].artist)
        assertEquals("HUMBLE.", catalog.albums[0].album)
        assertEquals(1, catalog.artists.size)
        assertEquals("Kendrick Lamar", catalog.artists[0].name)
        assertEquals(1, catalog.allTracks.size)
        assertEquals("HUMBLE.", catalog.allTracks[0].name)
        assertEquals("Kendrick Lamar", catalog.allTracks[0].artist)

        val protocolIdRe = Regex("^[a-z0-9]+:[a-z0-9]+(?::s\\d{2}e\\d{2,3})?$")
        val ytAudioId1 = normalizeAcquireId("yt:dQw4w9WgXcQ", "Never Gonna Give You Up", "Rick Astley", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", audio = true)
        val ytAudioId2 = normalizeAcquireId("", "Never Gonna Give You Up", "Rick Astley", "https://youtu.be/dQw4w9WgXcQ", audio = true)
        assertTrue(ytAudioId1.startsWith("yt:") && ytAudioId1.endsWith(":s01e01"))
        assertTrue(protocolIdRe.matches(ytAudioId1))
        assertEquals(ytAudioId1, ytAudioId2)

        val ytVideoId = normalizeAcquireId("yt:dQw4w9WgXcQ", "Demo Clip", "Channel", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", audio = false)
        assertTrue(ytVideoId.startsWith("clip:"))
        assertTrue(protocolIdRe.matches(ytVideoId))

        assertEquals(
            "sc:12345:s01e01",
            normalizeAcquireId("sc:12345", "Track", "Artist", "https://soundcloud.com/a/b", audio = true),
        )
        assertEquals(
            "mb:rel1:s01e03",
            normalizeAcquireId("mb:rel1:s01e03", "Track", "Artist", "https://example.com/a.flac", audio = true),
        )
        assertTrue(
            normalizeAcquireId("", "Track", "Artist", "https://example.com/a.flac", audio = true)
                .matches(Regex("^album:[0-9a-f]{20}:s01e01$")),
        )
        assertEquals(
            "imdb:tt0133093",
            normalizeAcquireId("imdb:tt0133093", "The Matrix", "", "https://example.com/matrix.mkv", audio = false),
        )
    }

    @Test
    fun stripsSafeSegmentedArtistPrefixWhenMergingSavedYouTubeAlbum() {
        val entries = listOf(
            Entry(
                key = "yt:abc1234567890abcdef1:s01e01/src/blob:0",
                id = "yt:abc1234567890abcdef1:s01e01",
                title = "AC DC · Back in Black",
                size = 5_000_000L,
                sha256 = "aaa",
                local = true,
                streamUrl = "http://127.0.0.1:8174/v1/blob?a",
                season = 1,
                episode = 1,
                seriesKey = "yt:abc1234567890abcdef1",
                music = MusicMeta(title = "Hells Bells", artist = "AC/DC"),
            ),
        )
        val cat = LibraryCatalog.build(entries)
        assertEquals(1, cat.albums.size)
        assertEquals("Back in Black", cat.albums[0].album)
        assertEquals("AC/DC", cat.albums[0].artist)
        assertEquals("Hells Bells", cat.allTracks[0].name)
    }
}
