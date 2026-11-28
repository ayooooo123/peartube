package com.peartube.app

import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private data class StubResponse(
    val code: Int,
    val body: String = "",
    val headers: Map<String, String> = emptyMap(),
)

private class LoopbackStubServer(
    private val handler: (path: String, query: String) -> StubResponse,
) {
    constructor(simpleHandler: (path: String, query: String) -> Pair<Int, String>, @Suppress("UNUSED_PARAMETER") simple: Boolean) :
        this({ path, query ->
            val (code, body) = simpleHandler(path, query)
            StubResponse(code, body)
        })

    private val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val running = AtomicBoolean(true)
    val port: Int get() = socket.localPort

    private val thread = Thread {
        while (running.get()) {
            val client = runCatching { socket.accept() }.getOrNull() ?: break
            Thread {
                client.use { conn ->
                    conn.soTimeout = 3_000
                    val reader = BufferedReader(InputStreamReader(conn.getInputStream(), Charsets.UTF_8))
                    val requestLine = reader.readLine() ?: return@use
                    // Drain headers
                    while (true) {
                        val line = reader.readLine()
                        if (line.isNullOrEmpty()) break
                    }
                    val target = requestLine.split(' ').getOrNull(1).orEmpty()
                    val qIdx = target.indexOf('?')
                    val path = if (qIdx >= 0) target.substring(0, qIdx) else target
                    val query = if (qIdx >= 0) target.substring(qIdx + 1) else ""
                    val resp = handler(path, query)
                    val bodyBytes = resp.body.toByteArray(Charsets.UTF_8)
                    val statusText = when (resp.code) {
                        200 -> "OK"
                        301 -> "Moved Permanently"
                        302 -> "Found"
                        307 -> "Temporary Redirect"
                        else -> "Not Found"
                    }
                    val extraHeaders = buildString {
                        resp.headers.forEach { (k, v) -> append("$k: $v\r\n") }
                    }
                    val header = "HTTP/1.1 ${resp.code} $statusText\r\n" +
                        "Content-Type: application/json; charset=utf-8\r\n" +
                        "Content-Length: ${bodyBytes.size}\r\n" +
                        extraHeaders +
                        "Connection: close\r\n\r\n"
                    val out = conn.getOutputStream()
                    out.write(header.toByteArray(Charsets.UTF_8))
                    out.write(bodyBytes)
                    out.flush()
                }
            }.start()
        }
    }.apply {
        isDaemon = true
        start()
    }

    fun stop() {
        running.set(false)
        runCatching { socket.close() }
        runCatching { thread.join(500) }
    }
}

class MetaAndThumbHashTest {

    // Exact 25-byte ThumbHash vector from spec/meta-vectors.json (records.cardMovie.thumbHash)
    private val specThumbHashBase64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGA=="
    private val specThumbHashHex = "000102030405060708090a0b0c0d0e0f101112131415161718"

    @After
    fun tearDown() {
        ExternalDiscoveryApi.clearnetRequestHook = null
        ExternalDiscoveryApi.configureLocalMeta(null, false)
        ThumbHash.clearKeysForTest()
    }

    @Test
    fun decodesSpecVectorThumbHashToValidRgbaAndRejectsCorruptInputs() {
        val raw = ThumbHash.decodeBase64(specThumbHashBase64)
        assertNotNull(raw)
        assertEquals(25, raw!!.size)
        val hex = raw.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        assertEquals(specThumbHashHex, hex)

        val img = ThumbHash.thumbHashToRGBA(raw)
        assertNotNull(img)
        assertTrue("Expected positive width, got ${img!!.width}", img.width > 0)
        assertTrue("Expected positive height, got ${img.height}", img.height > 0)
        assertEquals(14, img.width)
        assertEquals(32, img.height)
        assertEquals(img.width * img.height * 4, img.rgba.size)
        // Non-alpha ThumbHash sets every alpha channel byte to 255
        for (i in 3 until img.rgba.size step 4) {
            assertEquals(0xFF, img.rgba[i].toInt() and 0xFF)
        }

        // Alpha + landscape ThumbHash (hasAlpha=1 -> byte[2] bit 7, isLandscape=1 -> byte[4] bit 7, shortAxis=3)
        val alphaHash = ByteArray(32) { idx -> (idx * 7 + 3).toByte() }
        alphaHash[2] = (alphaHash[2].toInt() or 0x80).toByte()
        alphaHash[3] = ((alphaHash[3].toInt() and 0xF8) or 3).toByte()
        alphaHash[4] = (alphaHash[4].toInt() or 0x80).toByte()
        val alphaImg = ThumbHash.thumbHashToRGBA(alphaHash)
        assertNotNull(alphaImg)
        assertTrue(alphaImg!!.width > alphaImg.height)
        assertEquals(alphaImg.width * alphaImg.height * 4, alphaImg.rgba.size)

        // Graceful null on empty, corrupt, truncated, or zero-axis inputs
        assertNull(ThumbHash.decodeBase64(""))
        assertNull(ThumbHash.decodeBase64("   "))
        assertNull(ThumbHash.decodeBase64("!!!not-valid-base64!!!"))
        assertNull(ThumbHash.decodeThumbHashBitmap(""))
        assertNull(ThumbHash.decodeThumbHashBitmap("!!!corrupt!!!"))
        assertNull(ThumbHash.thumbHashToRGBA(ByteArray(0)))
        assertNull(ThumbHash.thumbHashToRGBA(ByteArray(4)))
        assertNull(ThumbHash.thumbHashToRGBA(ByteArray(10) { 0x03 })) // truncated AC bytes
        val zeroAxis = ByteArray(25) { 0x01 }
        zeroAxis[3] = (zeroAxis[3].toInt() and 0xF8).toByte() // shortAxis == 0
        assertNull(ThumbHash.thumbHashToRGBA(zeroAxis))
    }

    @Test
    fun parsesLoopbackMetaContractsMatchingPhase1WireSchema() {
        val cardJson = JSONObject()
            .put("id", "imdb:tt0133093")
            .put("kind", "movie")
            .put("title", "The Matrix")
            .put("subtitle", "Welcome to the Real World")
            .put("year", 1999)
            .put("ratingX10", 87)
            .put("genres", JSONArray().put("Action").put("Sci-Fi"))
            .put("runtimeMin", 136)
            .put("thumbHash", specThumbHashBase64)
            .put("posterHash", "4".repeat(64))
            .put("backdropHash", "5".repeat(64))
            .put("posterUrl", "/v1/art/${"4".repeat(64)}")
            .put("backdropUrl", "/v1/art/${"5".repeat(64)}")
            .put("updatedAt", 1735689600123L)
            .put("source", "a".repeat(64))

        val card = MetaCard.from(cardJson)
        assertEquals("imdb:tt0133093", card.id)
        assertEquals("movie", card.kind)
        assertEquals("The Matrix", card.title)
        assertEquals("Welcome to the Real World", card.subtitle)
        assertEquals(1999, card.year)
        assertEquals(87, card.ratingX10)
        assertEquals(listOf("Action", "Sci-Fi"), card.genres)
        assertEquals(136, card.runtimeMin)
        assertEquals(specThumbHashBase64, card.thumbHash)
        assertEquals("/v1/art/${"4".repeat(64)}", card.posterUrl)
        assertEquals("/v1/art/${"5".repeat(64)}", card.backdropUrl)
        assertEquals(1735689600123L, card.updatedAt)
        assertEquals("a".repeat(64), card.source)

        val detailJson = JSONObject()
            .put("id", "imdb:tt0903747")
            .put("synopsis", "A chemistry teacher turns to manufacturing methamphetamine.")
            .put("cast", JSONArray().put("Bryan Cranston").put("Aaron Paul"))
            .put("directors", JSONArray().put("Vince Gilligan"))
            .put("tags", JSONArray().put("crime").put("drama"))
            .put("backdropHash", "5".repeat(64))
            .put("backdropUrl", "/v1/art/${"5".repeat(64)}")
            .put(
                "items",
                JSONArray().put(
                    JSONObject()
                        .put("label", "Pilot")
                        .put("subId", "imdb:tt0903747:s01e01")
                        .put("season", 1)
                        .put("number", 1)
                        .put("runtimeMin", 58),
                ),
            )
            .put(
                "externalIds",
                JSONArray()
                    .put(JSONObject().put("key", "tmdb").put("value", "1396"))
                    .put(JSONObject().put("key", "tvdb").put("value", "81189")),
            )
            .put("updatedAt", 1735689600789L)
            .put("source", "b".repeat(64))

        val detail = MetaDetail.from(detailJson)
        assertEquals("imdb:tt0903747", detail.id)
        assertEquals(listOf("Bryan Cranston", "Aaron Paul"), detail.cast)
        assertEquals(listOf("Vince Gilligan"), detail.directors)
        assertEquals(listOf("crime", "drama"), detail.tags)
        assertEquals(1, detail.items.size)
        assertEquals("Pilot", detail.items[0].label)
        assertEquals(1, detail.items[0].season)
        assertEquals(1, detail.items[0].number)
        assertEquals(58, detail.items[0].runtimeMin)
        assertEquals("1396", detail.externalIds["tmdb"])
        assertEquals("81189", detail.externalIds["tvdb"])

        val listJson = JSONObject()
            .put("kind", "movie")
            .put("slug", "popular/sci-fi")
            .put("title", "Popular Sci-Fi")
            .put("ids", JSONArray().put("imdb:tt0133093"))
            .put("cards", JSONArray().put(cardJson))
            .put("updatedAt", 1735689601000L)
            .put("source", "a".repeat(64))

        val list = MetaList.from(listJson)
        assertEquals("movie", list.kind)
        assertEquals("popular/sci-fi", list.slug)
        assertEquals("Popular Sci-Fi", list.title)
        assertEquals(listOf("imdb:tt0133093"), list.ids)
        assertEquals(1, list.cards.size)
        assertEquals("The Matrix", list.cards[0].title)

        val hitJson = JSONObject()
            .put("id", "imdb:tt0133093")
            .put("kind", "movie")
            .put("title", "The Matrix")
            .put("subtitle", "Action, Sci-Fi")
            .put("year", 1999)
            .put("score", 980)
            .put("thumbHash", specThumbHashBase64)
            .put("posterHash", "4".repeat(64))
            .put("posterUrl", "/v1/art/${"4".repeat(64)}")
            .put("source", "a".repeat(64))

        val hit = MetaSearchHit.from(hitJson)
        assertEquals("imdb:tt0133093", hit.id)
        assertEquals(980, hit.score)
        assertEquals(specThumbHashBase64, hit.thumbHash)
        assertEquals("/v1/art/${"4".repeat(64)}", hit.posterUrl)

        val sourcesJson = JSONObject()
            .put(
                "sources",
                JSONArray().put(
                    JSONObject()
                        .put("key", "0123456789abcdef".repeat(4))
                        .put("uri", "peartube://meta/${"0123456789abcdef".repeat(4)}?name=Community")
                        .put("alias", "Community")
                        .put("writable", false)
                        .put("seedFull", true)
                        .put("active", true),
                ),
            )
            .put("p2pOnlyMetadata", true)
            .put("seedFullMetadata", false)

        val sourcesState = MetaSourcesState.from(sourcesJson)
        assertEquals(1, sourcesState.sources.size)
        assertEquals("Community", sourcesState.sources[0].alias)
        assertTrue(sourcesState.sources[0].seedFull)
        assertTrue(sourcesState.sources[0].active)
        assertTrue(sourcesState.p2pOnlyMetadata)
        assertFalse(sourcesState.seedFullMetadata)
    }

    @Test
    fun resolvesP2pMetadataFirstAndFailClosedBlocksAllClearnetRequests() = runBlocking {
        val posterHash = "4".repeat(64)
        val backdropHash = "5".repeat(64)
        val albumHash = "6".repeat(64)

        val localHits = AtomicInteger(0)
        val server = LoopbackStubServer(simpleHandler = { path, query ->
            localHits.incrementAndGet()
            when {
                path == "/v1/meta/card/imdb%3Att0133093" || path == "/v1/meta/card/imdb:tt0133093" -> {
                    200 to JSONObject()
                        .put("id", "imdb:tt0133093")
                        .put("kind", "movie")
                        .put("title", "The Matrix")
                        .put("subtitle", "Welcome to the Real World")
                        .put("year", 1999)
                        .put("ratingX10", 87)
                        .put("genres", JSONArray().put("Action").put("Sci-Fi"))
                        .put("runtimeMin", 136)
                        .put("thumbHash", specThumbHashBase64)
                        .put("posterHash", posterHash)
                        .put("backdropHash", backdropHash)
                        .put("posterUrl", "/v1/art/$posterHash")
                        .put("backdropUrl", "/v1/art/$backdropHash")
                        .toString()
                }
                path == "/v1/meta/detail/imdb%3Att0133093" || path == "/v1/meta/detail/imdb:tt0133093" -> {
                    200 to JSONObject()
                        .put("id", "imdb:tt0133093")
                        .put("synopsis", "A hacker learns the truth about reality.")
                        .put("cast", JSONArray().put("Keanu Reeves").put("Carrie-Anne Moss"))
                        .put("backdropHash", backdropHash)
                        .put("backdropUrl", "/v1/art/$backdropHash")
                        .put(
                            "items",
                            JSONArray().put(
                                JSONObject()
                                    .put("label", "Chapter 1")
                                    .put("season", 1)
                                    .put("number", 1),
                            ),
                        )
                        .toString()
                }
                path == "/v1/meta/list/movie/popular" -> {
                    200 to JSONObject()
                        .put("kind", "movie")
                        .put("slug", "popular")
                        .put("title", "Popular Movies")
                        .put(
                            "cards",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "imdb:tt0133093")
                                    .put("kind", "movie")
                                    .put("title", "The Matrix")
                                    .put("year", 1999)
                                    .put("ratingX10", 87)
                                    .put("runtimeMin", 136)
                                    .put("thumbHash", specThumbHashBase64)
                                    .put("posterHash", posterHash)
                                    .put("posterUrl", "/v1/art/$posterHash"),
                            ),
                        )
                        .toString()
                }
                path == "/v1/meta/list/album/featured" -> {
                    200 to JSONObject()
                        .put("kind", "album")
                        .put("slug", "featured")
                        .put(
                            "cards",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "mb:4b1a8e46-9d5c-4c32-8a4f-7a8e0e43a001")
                                    .put("kind", "album")
                                    .put("title", "Homogenic")
                                    .put("subtitle", "Björk")
                                    .put("year", 1997)
                                    .put("posterHash", albumHash)
                                    .put("posterUrl", "/v1/art/$albumHash")
                                    .put("thumbHash", specThumbHashBase64),
                            ),
                        )
                        .toString()
                }
                path == "/v1/meta/search" && query.contains("kind=album") && query.contains("Homogenic") -> {
                    200 to JSONObject()
                        .put(
                            "hits",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "mb:4b1a8e46-9d5c-4c32-8a4f-7a8e0e43a001")
                                    .put("kind", "album")
                                    .put("title", "Homogenic")
                                    .put("subtitle", "Björk")
                                    .put("year", 1997)
                                    .put("posterHash", albumHash)
                                    .put("posterUrl", "/v1/art/$albumHash")
                                    .put("thumbHash", specThumbHashBase64),
                            ),
                        )
                        .toString()
                }
                else -> 404 to """{"error":"not found"}"""
            }
        }, simple = true)
        try {
            val baseUrl = "http://127.0.0.1:${server.port}"
            val clearnetAttempts = AtomicInteger(0)
            ExternalDiscoveryApi.clearnetRequestHook = { clearnetAttempts.incrementAndGet() }
            ExternalDiscoveryApi.configureLocalMeta(apiBaseUrl = baseUrl, failClosed = true)

            // 1. P2P hit resolves CinemaTitleMeta + caches ThumbHash + local /v1/art/:hash URLs
            val meta = ExternalDiscoveryApi.loadTitleMeta("imdb:tt0133093", isSeries = false)
            assertNotNull(meta)
            assertEquals("tt0133093", meta!!.imdbId)
            assertEquals("The Matrix", meta.title)
            assertEquals("1999", meta.year)
            assertEquals("8.7", meta.rating)
            assertEquals("2h 16m", meta.runtime)
            assertEquals(listOf("Action", "Sci-Fi"), meta.genres)
            assertEquals(listOf("Keanu Reeves", "Carrie-Anne Moss"), meta.cast)
            assertEquals("A hacker learns the truth about reality.", meta.description)
            assertEquals("$baseUrl/v1/art/$posterHash", meta.posterUrl)
            assertEquals("$baseUrl/v1/art/$backdropHash", meta.backdropUrl)
            assertEquals("Chapter 1", meta.episodes[1 to 1]?.name)
            assertEquals(specThumbHashBase64, ThumbHash.thumbHashFor("imdb:tt0133093"))
            assertTrue(ExternalImageCache.isAllowedUrl("$baseUrl/v1/art/$posterHash"))

            // 2. P2P cinema discover hit
            val cinema = ExternalDiscoveryApi.discoverCinema("Popular")
            assertEquals(1, cinema.movies.size)
            assertEquals("The Matrix", cinema.movies[0].title)
            assertEquals("$baseUrl/v1/art/$posterHash", cinema.movies[0].posterUrl)

            // 3. P2P music discover & search in fail-closed mode
            val music = ExternalDiscoveryApi.discoverMusic("featured")
            assertEquals(1, music.albums.size)
            assertEquals("Homogenic", music.albums[0].title)
            assertEquals("$baseUrl/v1/art/$albumHash", music.albums[0].artUrl)

            val ytmRes = ExternalDiscoveryApi.searchYouTubeMusic("Homogenic")
            assertEquals(1, ytmRes.albums.size)
            assertEquals("Homogenic", ytmRes.albums[0].title)

            // 4. P2P MISS in fail-closed mode -> returns null / empty with ZERO clearnet calls!
            val missedTitle = ExternalDiscoveryApi.loadTitleMeta("tt9999999", isSeries = false)
            assertNull(missedTitle)
            val missedImdb = ExternalDiscoveryApi.resolveTitleImdb("Nonexistent Film", isSeries = false)
            assertNull(missedImdb)
            val missedCinema = ExternalDiscoveryApi.discoverCinema("Comedy")
            assertTrue(missedCinema.movies.isEmpty())
            assertTrue(missedCinema.series.isEmpty())
            val missedMusic = ExternalDiscoveryApi.discoverMusic("jazz", query = "Unknown Artist XYZ")
            assertTrue(missedMusic.albums.isEmpty())
            assertTrue(missedMusic.songs.isEmpty())
            val missedAlbumArt = ExternalDiscoveryApi.resolveAlbumArtUrl("Unknown Artist", "Unknown Album")
            assertNull(missedAlbumArt)
            val missedVideos = ExternalDiscoveryApi.discoverYouTubeVideos("Featured")
            assertTrue(missedVideos.isEmpty())
            val missedCreators = ExternalDiscoveryApi.searchCreatorsTypeahead("veritasium")
            assertTrue(missedCreators.isEmpty())

            assertTrue("Expected local loopback P2P queries to run", localHits.get() > 0)
            assertEquals("Expected ZERO clearnet requests in fail-closed mode", 0, clearnetAttempts.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun settingsRoundTripsMetadataFieldsAndLoadsV050JsonCleanly() {
        val metaKey = "0123456789abcdef".repeat(4)
        val original = Settings(
            tracker = "a".repeat(64),
            sources = listOf(SourceSpec(key = "b".repeat(64), kind = "channel", alias = "Movies")),
            lanDiscovery = false,
            privateRouting = true,
            cacheMaxGb = 25,
            metaSources = listOf(metaKey),
            p2pOnlyMetadata = true,
            seedFullMetadata = true,
        )

        val serialized = original.toJson()
        val parsed = Settings.fromJson(JSONObject(serialized.toString()))
        assertEquals(listOf(metaKey), parsed.metaSources)
        assertTrue(parsed.p2pOnlyMetadata)
        assertTrue(parsed.seedFullMetadata)
        assertEquals(original, parsed)

        // v0.5.0 settings.json without metaSources / p2pOnlyMetadata / seedFullMetadata
        val legacyJson = JSONObject()
            .put("tracker", "c".repeat(64))
            .put("sources", JSONArray())
            .put("relayThrough", JSONArray())
            .put("bootstrap", JSONArray())
            .put("lanDiscovery", true)
            .put("privateRouting", false)
            .put("cacheMaxGb", 10)
        val legacyParsed = Settings.fromJson(legacyJson)
        assertEquals("c".repeat(64), legacyParsed.tracker)
        assertTrue(legacyParsed.metaSources.isEmpty())
        assertFalse(legacyParsed.p2pOnlyMetadata)
        assertFalse(legacyParsed.seedFullMetadata)
    }

    @Test
    fun discoverCinemaSciFiHitsGenreSlashSciFiShelfFirstAndMusicIsP2pFirstWhenNotFailClosed() = runBlocking {
        val posterHash = "7".repeat(64)
        val albumHash = "8".repeat(64)
        val requestedPaths = java.util.Collections.synchronizedList(ArrayList<String>())
        val server = LoopbackStubServer { path, query ->
            requestedPaths.add(path)
            when {
                path == "/v1/meta/list/movie/genre/sci-fi" -> StubResponse(
                    200,
                    JSONObject()
                        .put("kind", "movie")
                        .put("slug", "genre/sci-fi")
                        .put("title", "Sci-Fi")
                        .put(
                            "cards",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "imdb:tt0083658")
                                    .put("kind", "movie")
                                    .put("title", "Blade Runner")
                                    .put("year", 1982)
                                    .put("ratingX10", 81)
                                    .put("runtimeMin", 117)
                                    .put("posterHash", posterHash)
                                    .put("posterUrl", "/v1/art/$posterHash"),
                            ),
                        )
                        .toString(),
                )
                path == "/v1/meta/list/album/featured" -> StubResponse(
                    200,
                    JSONObject()
                        .put("kind", "album")
                        .put("slug", "featured")
                        .put(
                            "cards",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "mb:album-1")
                                    .put("kind", "album")
                                    .put("title", "Selected Ambient Works")
                                    .put("subtitle", "Aphex Twin")
                                    .put("year", 1992)
                                    .put("posterHash", albumHash)
                                    .put("posterUrl", "/v1/art/$albumHash"),
                            ),
                        )
                        .toString(),
                )
                path == "/v1/meta/search" && query.contains("kind=album") && query.contains("Aphex") -> StubResponse(
                    200,
                    JSONObject()
                        .put(
                            "hits",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "mb:album-1")
                                    .put("kind", "album")
                                    .put("title", "Selected Ambient Works")
                                    .put("subtitle", "Aphex Twin")
                                    .put("year", 1992)
                                    .put("posterHash", albumHash)
                                    .put("posterUrl", "/v1/art/$albumHash"),
                            ),
                        )
                        .toString(),
                )
                else -> StubResponse(404, """{"error":"not found"}""")
            }
        }
        try {
            val baseUrl = "http://127.0.0.1:${server.port}"
            val clearnetAttempts = AtomicInteger(0)
            ExternalDiscoveryApi.clearnetRequestHook = { clearnetAttempts.incrementAndGet() }

            val epochBefore = ExternalDiscoveryApi.localMetaEpoch.value
            ExternalDiscoveryApi.configureLocalMeta(apiBaseUrl = baseUrl, failClosed = false)
            assertTrue(ExternalDiscoveryApi.localMetaEpoch.value > epochBefore)

            // 1. Sci-Fi cinema discover hits /v1/meta/list/movie/genre/sci-fi FIRST
            val sciFi = ExternalDiscoveryApi.discoverCinema("Sci-Fi")
            assertEquals(1, sciFi.movies.size)
            assertEquals("Blade Runner", sciFi.movies[0].title)
            assertTrue(
                "Expected /v1/meta/list/movie/genre/sci-fi in $requestedPaths",
                requestedPaths.contains("/v1/meta/list/movie/genre/sci-fi"),
            )

            // 2. Music discover, search, and track album meta resolve P2P-first even when failClosed == false
            val music = ExternalDiscoveryApi.discoverMusic("featured")
            assertEquals(1, music.albums.size)
            assertEquals("Selected Ambient Works", music.albums[0].title)

            val searchRes = ExternalDiscoveryApi.searchYouTubeMusic("Aphex")
            assertEquals(1, searchRes.albums.size)
            assertEquals("Selected Ambient Works", searchRes.albums[0].title)

            val trackAlbum = ExternalDiscoveryApi.resolveTrackAlbumMeta(
                videoId = null,
                artist = "Aphex Twin",
                title = "Xtal",
            )
            assertNotNull(trackAlbum)
            assertEquals("Selected Ambient Works", trackAlbum!!.album)

            assertEquals("Expected zero clearnet calls when P2P answers", 0, clearnetAttempts.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun externalImageCacheRefusesLoopbackRedirectToExternalHostInFailClosedMode() = runBlocking {
        val loopbackHits = AtomicInteger(0)
        val server = LoopbackStubServer { path, _ ->
            loopbackHits.incrementAndGet()
            when (path) {
                "/v1/poster/tt0133093" -> StubResponse(
                    code = 302,
                    headers = mapOf("Location" to "https://images.metahub.space/poster/medium/tt0133093/img"),
                )
                "/v1/poster/hop1" -> StubResponse(
                    code = 302,
                    headers = mapOf("Location" to "/v1/art/${"a".repeat(64)}"),
                )
                "/v1/art/${"a".repeat(64)}" -> StubResponse(code = 404)
                else -> StubResponse(code = 404)
            }
        }
        try {
            val baseUrl = "http://127.0.0.1:${server.port}"
            ExternalDiscoveryApi.configureLocalMeta(apiBaseUrl = baseUrl, failClosed = true)

            // Loopback 302 -> external https://images.metahub.space/... MUST be refused without following
            val refused = ExternalImageCache.loadBitmap("$baseUrl/v1/poster/tt0133093")
            assertNull(refused)
            assertEquals("Expected exactly 1 loopback hit before refusing external redirect", 1, loopbackHits.get())

            // Loopback 302 -> loopback /v1/art/... IS followed (hitting both hop1 and target)
            val followed = ExternalImageCache.loadBitmap("$baseUrl/v1/poster/hop1")
            assertNull(followed)
            assertEquals("Expected loopback-to-loopback redirect to follow hop1 -> target", 3, loopbackHits.get())
        } finally {
            server.stop()
        }
    }
}
