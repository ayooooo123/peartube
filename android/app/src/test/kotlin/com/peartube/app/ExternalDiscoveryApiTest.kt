package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalDiscoveryApiTest {

    @Test
    fun extractsPrimaryArtistAndUpsizesArtwork() {
        assertEquals("Miles Davis", ExternalDiscoveryApi.extractPrimaryArtist("Miles Davis & John Coltrane"))
        assertEquals("Daft Punk", ExternalDiscoveryApi.extractPrimaryArtist("Daft Punk feat. Pharrell Williams"))
        assertEquals("Frank Ocean", ExternalDiscoveryApi.extractPrimaryArtist("Frank Ocean, André 3000"))
        assertEquals(
            "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/600x600bb.jpg",
            ExternalDiscoveryApi.upsizeArtworkUrl("http://is1-ssl.mzstatic.com/image/thumb/Music/v4/100x100bb.jpg"),
        )
    }

    @Test
    fun parsesItunesDiscoveryIntoDeduplicatedArtistsSongsAndAlbums() {
        val items = listOf(
            JSONObject()
                .put("trackId", 101L)
                .put("artistName", "Miles Davis & John Coltrane")
                .put("trackName", "So What")
                .put("collectionName", "Kind of Blue")
                .put("primaryGenreName", "Jazz")
                .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg")
                .put("previewUrl", "https://audio-ssl.itunes.apple.com/preview1.m4a")
                .put("trackTimeMillis", 562_000L)
                .put("releaseDate", "1959-08-17T07:00:00Z"),
            JSONObject()
                .put("trackId", 102L)
                .put("artistName", "Miles Davis")
                .put("trackName", "Blue in Green")
                .put("collectionName", "Kind of Blue")
                .put("primaryGenreName", "Jazz")
                .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg")
                .put("previewUrl", "https://audio-ssl.itunes.apple.com/preview2.m4a")
                .put("trackTimeMillis", 337_000L)
                .put("releaseDate", "1959-08-17T07:00:00Z"),
        )
        val parsed = ExternalDiscoveryApi.parseItunesDiscovery("jazz", "", items)
        assertEquals(1, parsed.artists.size)
        assertEquals("Miles Davis", parsed.artists[0].name)
        assertEquals(2, parsed.songs.size)
        assertEquals("So What", parsed.songs[0].title)
        assertEquals(562, parsed.songs[0].durationSecs)
        assertEquals(1, parsed.albums.size)
        assertEquals("Kind of Blue", parsed.albums[0].title)
        assertEquals("1959", parsed.albums[0].year)
        assertTrue(parsed.albums[0].artUrl.endsWith("/600x600bb.jpg"))
    }

    @Test
    fun extractsYtInitialDataAndParsesDirectChannelAndSearch() {
        val html = """
            <html><script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"UC123","title":"3Blue1Brown","channelUrl":"https://www.youtube.com/channel/UC123","avatar":{"thumbnails":[{"url":"https://yt3.googleusercontent.com/pic=s900"}]}}},"header":{"pageHeaderRenderer":{"pageTitle":"3Blue1Brown","content":{"pageHeaderViewModel":{"metadata":{"contentMetadataViewModel":{"metadataRows":[{"metadataParts":[{"text":{"content":"@3blue1brown"}},{"text":{"content":"6.5M subscribers"}}]}]}}}}}}};</script></html>
        """.trimIndent()
        val json = ExternalDiscoveryApi.extractYtInitialData(html)
        assertNotNull(json)
        val direct = ExternalDiscoveryApi.parseDirectYouTubeChannel(requireNotNull(json), "3blue1brown")
        assertNotNull(direct)
        assertEquals("3Blue1Brown", direct?.name)
        assertEquals("@3blue1brown", direct?.handle)
        assertEquals("6.5M subscribers", direct?.subscribers)
        assertEquals("https://www.youtube.com/@3blue1brown", direct?.url)

        val searchJson = JSONObject().put(
            "contents",
            JSONArray().put(
                JSONObject().put(
                    "channelRenderer",
                    JSONObject()
                        .put("channelId", "UC999")
                        .put("title", JSONObject().put("simpleText", "Veritasium"))
                        .put("subscriberCountText", JSONObject().put("simpleText", "@veritasium"))
                        .put("videoCountText", JSONObject().put("simpleText", "16M subscribers"))
                        .put(
                            "thumbnail",
                            JSONObject().put(
                                "thumbnails",
                                JSONArray().put(JSONObject().put("url", "//yt3.ggpht.com/avatar")),
                            ),
                        ),
                ),
            ),
        )
        val search = ExternalDiscoveryApi.parseYouTubeChannelSearch(searchJson)
        assertEquals(1, search.size)
        assertEquals("Veritasium", search[0].name)
        assertEquals("@veritasium", search[0].handle)
        assertEquals("16M subscribers", search[0].subscribers)
        assertEquals("https://yt3.ggpht.com/avatar", search[0].avatarUrl)
    }

    @Test
    fun enforcesHttpsImageDomainAllowlist() {
        assertTrue(ExternalImageCache.isAllowedUrl("https://is1-ssl.mzstatic.com/image/thumb/a.jpg"))
        assertTrue(ExternalImageCache.isAllowedUrl("https://yt3.googleusercontent.com/abc"))
        assertTrue(ExternalImageCache.isAllowedUrl("https://i.ytimg.com/vi/abc/hqdefault.jpg"))
        assertFalse(ExternalImageCache.isAllowedUrl("http://is1-ssl.mzstatic.com/image/thumb/a.jpg"))
        assertFalse(ExternalImageCache.isAllowedUrl("https://evil.example.com/mzstatic.com/a.jpg"))
    }

    @Test
    fun buildsValidatedImdbPosterAndBackdropUrls() {
        assertEquals("tt0133093", extractImdbId("tt0133093"))
        assertEquals("tt0903747", extractImdbId("imdb:tt0903747:s01e02"))
        assertEquals(null, extractImdbId("clip:abc123"))
        assertEquals(null, extractImdbId("tt0133093/../../evil"))
        assertEquals(
            "https://images.metahub.space/poster/medium/tt0133093/img",
            imdbPosterUrl("imdb:tt0133093"),
        )
        assertEquals(
            "https://images.metahub.space/background/medium/tt0903747/img",
            imdbBackdropUrl("tt0903747"),
        )
        assertTrue(ExternalImageCache.isAllowedUrl("https://images.metahub.space/poster/medium/tt0133093/img"))
        assertTrue(ExternalImageCache.isAllowedUrl("https://archive.org/download/example/cover.jpg"))
    }

    @Test
    fun parsesCinemetaCatalogTitleMetaAndImdbSearch() {
        val catalogJson = JSONObject().put(
            "metas",
            JSONArray().put(
                JSONObject()
                    .put("id", "tt15239678")
                    .put("name", "Dune: Part Two")
                    .put("releaseInfo", "2024")
                    .put("imdbRating", "8.5")
                    .put("runtime", "166 min")
                    .put("genres", JSONArray().put("Sci-Fi").put("Adventure"))
                    .put("description", "Paul Atreides unites with Chani and the Fremen.")
                    .put("cast", JSONArray().put("Timothée Chalamet").put("Zendaya"))
                    .put("poster", "https://images.metahub.space/poster/medium/tt15239678/img")
                    .put("background", "https://images.metahub.space/background/medium/tt15239678/img"),
            ),
        ).toString()

        val items = ExternalDiscoveryApi.parseCinemetaCatalog(catalogJson, "movie")
        assertEquals(1, items.size)
        assertEquals("tt15239678", items[0].imdbId)
        assertEquals("Dune: Part Two", items[0].title)
        assertEquals("2024", items[0].year)
        assertEquals("8.5", items[0].rating)
        assertEquals("2h 46m", items[0].runtime)
        assertEquals(listOf("Sci-Fi", "Adventure"), items[0].genres)
        assertEquals(listOf("Timothée Chalamet", "Zendaya"), items[0].cast)

        val metaJson = JSONObject().put(
            "meta",
            JSONObject()
                .put("id", "tt0903747")
                .put("name", "Breaking Bad")
                .put("releaseInfo", "2008–2013")
                .put("imdbRating", "9.5")
                .put("runtime", "49 min")
                .put("genres", JSONArray().put("Crime").put("Drama"))
                .put("description", "A chemistry teacher diagnosed with cancer turns to cooking meth.")
                .put("cast", JSONArray().put("Bryan Cranston").put("Aaron Paul"))
                .put(
                    "videos",
                    JSONArray().put(
                        JSONObject()
                            .put("season", 1)
                            .put("episode", 1)
                            .put("name", "Pilot")
                            .put("overview", "Walter White begins his transformation."),
                    ),
                ),
        ).toString()

        val meta = ExternalDiscoveryApi.parseCinemetaTitleMeta(metaJson, "tt0903747", "series")
        assertNotNull(meta)
        assertEquals("2008", meta?.year)
        assertEquals("9.5", meta?.rating)
        assertEquals("49 min", meta?.runtime)
        val ep = meta?.episodes?.get(1 to 1)
        assertNotNull(ep)
        assertEquals("Pilot", ep?.name)
        assertEquals("https://episodes.metahub.space/tt0903747/1/1/w780.jpg", ep?.thumbnailUrl)

        val searchJson = JSONObject().put(
            "metas",
            JSONArray()
                .put(JSONObject().put("id", "tt9999999").put("name", "Inception: Behind the Scenes"))
                .put(JSONObject().put("id", "tt1375666").put("name", "Inception")),
        ).toString()
        assertEquals("tt1375666", ExternalDiscoveryApi.parseCinemetaSearchBestImdb(searchJson, "Inception"))

        assertTrue(ExternalImageCache.isAllowedUrl("https://episodes.metahub.space/tt0903747/1/1/w780.jpg"))
        assertTrue(ExternalImageCache.isAllowedUrl("https://image.tmdb.org/t/p/w500/abc.jpg"))
        assertTrue(ExternalImageCache.isAllowedUrl("https://m.media-amazon.com/images/M/abc.jpg"))
    }

    @Test
    fun parsesYouTubeVideoSearchSkipsLiveStreamsAndDeduplicates() {
        assertEquals("Popular", CINEMA_GENRES[0])
        assertEquals("Top Rated", CINEMA_GENRES[1])

        val liveRenderer = JSONObject()
            .put("videoId", "live1234567")
            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "24/7 Lofi Live"))))
            .put("ownerText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Lofi Girl"))))

        val validRenderer = JSONObject()
            .put("videoId", "dQw4w9WgXcQ")
            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Why Cinematography Changed"))))
            .put(
                "ownerText",
                JSONObject().put(
                    "runs",
                    JSONArray().put(
                        JSONObject()
                            .put("text", "Nerdwriter1")
                            .put(
                                "navigationEndpoint",
                                JSONObject().put(
                                    "browseEndpoint",
                                    JSONObject().put("canonicalBaseUrl", "/@Nerdwriter1"),
                                ),
                            ),
                    ),
                ),
            )
            .put("lengthText", JSONObject().put("simpleText", "17:03"))
            .put("publishedTimeText", JSONObject().put("simpleText", "3 weeks ago"))

        val duplicateRenderer = JSONObject()
            .put("videoId", "dQw4w9WgXcQ")
            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Duplicate Entry"))))
            .put("ownerText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Nerdwriter1"))))
            .put("lengthText", JSONObject().put("simpleText", "17:03"))

        val secondRenderer = JSONObject()
            .put("videoId", "abc98765432")
            .put("title", JSONObject().put("simpleText", "Inside Quantum Computers"))
            .put(
                "ownerText",
                JSONObject().put(
                    "runs",
                    JSONArray().put(
                        JSONObject()
                            .put("text", "Veritasium")
                            .put(
                                "navigationEndpoint",
                                JSONObject().put(
                                    "browseEndpoint",
                                    JSONObject().put("browseId", "UCHnyfMqiRRG1u-2MsSQLbXA"),
                                ),
                            ),
                    ),
                ),
            )
            .put("lengthText", JSONObject().put("simpleText", "24:18"))
            .put("publishedTimeText", JSONObject().put("simpleText", "2 months ago"))

        val root = JSONObject().put(
            "contents",
            JSONArray()
                .put(JSONObject().put("videoRenderer", liveRenderer))
                .put(JSONObject().put("videoRenderer", validRenderer))
                .put(JSONObject().put("videoRenderer", duplicateRenderer))
                .put(JSONObject().put("videoRenderer", secondRenderer)),
        )

        val picks = ExternalDiscoveryApi.parseYouTubeVideoSearch(root)
        assertEquals(2, picks.size)
        assertEquals("dQw4w9WgXcQ", picks[0].videoId)
        assertEquals("Why Cinematography Changed", picks[0].title)
        assertEquals("Nerdwriter1", picks[0].channelName)
        assertEquals("https://www.youtube.com/@Nerdwriter1", picks[0].channelUrl)
        assertEquals("17:03", picks[0].durationText)
        assertEquals("3 weeks ago", picks[0].publishedText)
        assertEquals("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", picks[0].thumbUrl)
        assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", picks[0].watchUrl)

        assertEquals("abc98765432", picks[1].videoId)
        assertEquals("Inside Quantum Computers", picks[1].title)
        assertEquals("Veritasium", picks[1].channelName)
        assertEquals("https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA", picks[1].channelUrl)
        assertEquals("24:18", picks[1].durationText)
    }

    @Test
    fun parsesYouTubeAudioStreamPicksHighestBitrateMp4WithFullDuration() {
        val payload = JSONObject()
            .put("playabilityStatus", JSONObject().put("status", "OK"))
            .put(
                "streamingData",
                JSONObject().put(
                    "adaptiveFormats",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put("mimeType", "video/mp4; codecs=\"avc1.640028\"")
                                .put("bitrate", 2_500_000)
                                .put("approxDurationMs", "245000")
                                .put("url", "https://rr1.googlevideo.com/video"),
                        )
                        .put(
                            JSONObject()
                                .put("mimeType", "audio/webm; codecs=\"opus\"")
                                .put("bitrate", 160_000)
                                .put("approxDurationMs", "245000")
                                .put("url", "https://rr1.googlevideo.com/opus160"),
                        )
                        .put(
                            JSONObject()
                                .put("mimeType", "audio/mp4; codecs=\"mp4a.40.2\"")
                                .put("bitrate", 64_000)
                                .put("approxDurationMs", "245000")
                                .put("url", "https://rr1.googlevideo.com/aac64"),
                        )
                        .put(
                            JSONObject()
                                .put("mimeType", "audio/mp4; codecs=\"mp4a.40.2\"")
                                .put("bitrate", 131_072)
                                .put("approxDurationMs", "245120")
                                .put("url", "https://rr1.googlevideo.com/aac128"),
                        )
                        .put(
                            JSONObject()
                                .put("mimeType", "audio/mp4; codecs=\"mp4a.40.2\"")
                                .put("bitrate", 256_000)
                                .put("approxDurationMs", "245120")
                                .put("url", ""),
                        ),
                ),
            )
            .toString()

        val resolved = ExternalDiscoveryApi.parseYouTubeAudioStream(payload, "abc123XYZ89")
        assertNotNull(resolved)
        assertEquals("abc123XYZ89", resolved?.videoId)
        assertEquals("https://rr1.googlevideo.com/aac128", resolved?.streamUrl)
        assertEquals(245_120L, resolved?.durationMs)
        assertEquals(YT_VISIONOS_USER_AGENT, resolved?.userAgent)
        assertEquals("https://www.youtube.com/watch?v=abc123XYZ89", resolved?.watchUrl)

        assertEquals(
            "CgtPVk1zcVZJemZCcyjT6aLYBjIKCgJVUxIEGgAg",
            ExternalDiscoveryApi.extractVisitorData("{\"VISITOR_DATA\":\"CgtPVk1zcVZJemZCcyjT6aLYBjIKCgJVUxIEGgAg\"}"),
        )

        val unplayable = JSONObject()
            .put("playabilityStatus", JSONObject().put("status", "LOGIN_REQUIRED"))
            .toString()
        assertEquals(null, ExternalDiscoveryApi.parseYouTubeAudioStream(unplayable, "abc123XYZ89"))
    }

    @Test
    fun parsesYouTubeMusicRadioNextAndCleansTitlesAndThumbs() {
        val radioJson = JSONObject().put(
            "contents",
            JSONArray()
                .put(
                    JSONObject().put(
                        "playlistPanelVideoRenderer",
                        JSONObject()
                            .put("videoId", "ylXk1LBvIqU")
                            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "So What (Official Audio)"))))
                            .put("shortBylineText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Miles Davis - Topic"))))
                            .put("lengthText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "9:24"))))
                            .put(
                                "thumbnail",
                                JSONObject().put(
                                    "thumbnails",
                                    JSONArray().put(JSONObject().put("url", "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj")),
                                ),
                            ),
                    ),
                )
                .put(
                    JSONObject().put(
                        "playlistPanelVideoRenderer",
                        JSONObject()
                            .put("videoId", "-488UORrfJ0")
                            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "All Blues (Official Audio)"))))
                            .put("shortBylineText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Miles Davis"))))
                            .put("lengthText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "11:34"))))
                            .put(
                                "thumbnail",
                                JSONObject().put(
                                    "thumbnails",
                                    JSONArray().put(JSONObject().put("url", "https://lh3.googleusercontent.com/def=w120-h120-l90-rj")),
                                ),
                            ),
                    ),
                )
                .put(
                    JSONObject().put(
                        "playlistPanelVideoRenderer",
                        JSONObject()
                            .put("videoId", "shortBumper")
                            .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Intro"))))
                            .put("shortBylineText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Artist"))))
                            .put("lengthText", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "0:15")))),
                    ),
                ),
        ).toString()

        val tracks = ExternalDiscoveryApi.parseYouTubeRadioNext(radioJson, excludeVideoIds = setOf("ylXk1LBvIqU"))
        assertEquals(1, tracks.size)
        assertEquals("-488UORrfJ0", tracks[0].videoId)
        assertEquals("All Blues", tracks[0].title)
        assertEquals("Miles Davis", tracks[0].artist)
        assertEquals(694, tracks[0].durationSecs)
        assertEquals("https://lh3.googleusercontent.com/def=w544-h544-l90-rj", tracks[0].artUrl)
    }

    @Test
    fun parsesYtmSearchArtistPageAndAlbumPage() {
        val searchJson = JSONObject().put(
            "contents",
            JSONArray()
                .put(
                    JSONObject().put(
                        "musicCardShelfRenderer",
                        JSONObject()
                            .put(
                                "title",
                                JSONObject().put(
                                    "runs",
                                    JSONArray().put(
                                        JSONObject()
                                            .put("text", "Kendrick Lamar")
                                            .put(
                                                "navigationEndpoint",
                                                JSONObject().put(
                                                    "browseEndpoint",
                                                    JSONObject()
                                                        .put("browseId", "UCprAFmT0C6O4X0ToEXpeFTQ")
                                                        .put(
                                                            "browseEndpointContextSupportedConfigs",
                                                            JSONObject().put(
                                                                "browseEndpointContextMusicConfig",
                                                                JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ARTIST"),
                                                            ),
                                                        ),
                                                ),
                                            ),
                                    ),
                                ),
                            )
                            .put("subtitle", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Artist • 147M monthly audience")))),
                    ),
                )
                .put(
                    JSONObject().put(
                        "musicResponsiveListItemRenderer",
                        JSONObject()
                            .put("playlistItemData", JSONObject().put("videoId", "phLb_SoPBlA"))
                            .put(
                                "flexColumns",
                                JSONArray()
                                    .put(
                                        JSONObject().put(
                                            "musicResponsiveListItemFlexColumnRenderer",
                                            JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Not Like Us")))),
                                        ),
                                    )
                                    .put(
                                        JSONObject().put(
                                            "musicResponsiveListItemFlexColumnRenderer",
                                            JSONObject().put(
                                                "text",
                                                JSONObject().put(
                                                    "runs",
                                                    JSONArray()
                                                        .put(JSONObject().put("text", "Song"))
                                                        .put(JSONObject().put("text", " • "))
                                                        .put(JSONObject().put("text", "Kendrick Lamar"))
                                                        .put(JSONObject().put("text", " • "))
                                                        .put(JSONObject().put("text", "4:35")),
                                                ),
                                            ),
                                        ),
                                    ),
                            ),
                    ),
                )
                .put(
                    JSONObject().put(
                        "musicResponsiveListItemRenderer",
                        JSONObject()
                            .put(
                                "navigationEndpoint",
                                JSONObject().put(
                                    "browseEndpoint",
                                    JSONObject()
                                        .put("browseId", "MPREb_wCND3crJyDP")
                                        .put(
                                            "browseEndpointContextSupportedConfigs",
                                            JSONObject().put(
                                                "browseEndpointContextMusicConfig",
                                                JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ALBUM"),
                                            ),
                                        ),
                                ),
                            )
                            .put(
                                "flexColumns",
                                JSONArray()
                                    .put(
                                        JSONObject().put(
                                            "musicResponsiveListItemFlexColumnRenderer",
                                            JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "GNX")))),
                                        ),
                                    )
                                    .put(
                                        JSONObject().put(
                                            "musicResponsiveListItemFlexColumnRenderer",
                                            JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Album • Kendrick Lamar • 2024")))),
                                        ),
                                    ),
                            ),
                    ),
                ),
        ).toString()

        val search = ExternalDiscoveryApi.parseYtmSearch(searchJson, "Kendrick Lamar")
        assertEquals(1, search.artists.size)
        assertEquals("UCprAFmT0C6O4X0ToEXpeFTQ", search.artists[0].browseId)
        assertEquals("Kendrick Lamar", search.artists[0].name)
        assertEquals(1, search.songs.size)
        assertEquals("phLb_SoPBlA", search.songs[0].videoId)
        assertEquals("Not Like Us", search.songs[0].title)
        assertEquals("4:35", search.songs[0].durationText)
        assertEquals(1, search.albums.size)
        assertEquals("MPREb_wCND3crJyDP", search.albums[0].browseId)
        assertEquals("GNX", search.albums[0].title)
        assertEquals("2024", search.albums[0].year)

        val albumJson = JSONObject()
            .put(
                "header",
                JSONObject().put(
                    "musicResponsiveHeaderRenderer",
                    JSONObject()
                        .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "GNX"))))
                        .put("subtitle", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Album • 2024"))))
                        .put("straplineTextOne", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Kendrick Lamar")))),
                ),
            )
            .put(
                "contents",
                JSONArray().put(
                    JSONObject().put(
                        "musicResponsiveListItemRenderer",
                        JSONObject()
                            .put("playlistItemData", JSONObject().put("videoId", "YwUQ_5iV9pY"))
                            .put(
                                "flexColumns",
                                JSONArray().put(
                                    JSONObject().put(
                                        "musicResponsiveListItemFlexColumnRenderer",
                                        JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "wacced out murals")))),
                                    ),
                                ),
                            )
                            .put(
                                "fixedColumns",
                                JSONArray().put(
                                    JSONObject().put(
                                        "musicResponsiveListItemFixedColumnRenderer",
                                        JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "5:18")))),
                                    ),
                                ),
                            ),
                    ),
                ),
            )
            .toString()

        val albumPage = ExternalDiscoveryApi.parseYtmAlbumPage(albumJson, "MPREb_wCND3crJyDP")
        assertNotNull(albumPage)
        assertEquals("GNX", albumPage?.title)
        assertEquals("Kendrick Lamar", albumPage?.artist)
        assertEquals("2024", albumPage?.year)
        assertEquals(1, albumPage?.tracks?.size)
        assertEquals("wacced out murals", albumPage?.tracks?.get(0)?.title)
        assertEquals("5:18", albumPage?.tracks?.get(0)?.durationText)
    }

    @Test
    fun extractsAlbumBrowseIdFromSearchMenuAndInheritsTopResultArtist() {
        val searchJson = JSONObject().put(
            "contents",
            JSONArray().put(
                JSONObject().put(
                    "musicCardShelfRenderer",
                    JSONObject()
                        .put(
                            "title",
                            JSONObject().put(
                                "runs",
                                JSONArray().put(
                                    JSONObject()
                                        .put("text", "Kendrick Lamar")
                                        .put(
                                            "navigationEndpoint",
                                            JSONObject().put(
                                                "browseEndpoint",
                                                JSONObject()
                                                    .put("browseId", "UCprAFmT0C6O4X0ToEXpeFTQ")
                                                    .put(
                                                        "browseEndpointContextSupportedConfigs",
                                                        JSONObject().put(
                                                            "browseEndpointContextMusicConfig",
                                                            JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ARTIST"),
                                                        ),
                                                    ),
                                            ),
                                        ),
                                ),
                            ),
                        )
                        .put("subtitle", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Artist"))))
                        .put(
                            "contents",
                            JSONArray().put(
                                JSONObject().put(
                                    "musicResponsiveListItemRenderer",
                                    JSONObject()
                                        .put("playlistItemData", JSONObject().put("videoId", "AuikIJZpt_8"))
                                        .put(
                                            "flexColumns",
                                            JSONArray()
                                                .put(
                                                    JSONObject().put(
                                                        "musicResponsiveListItemFlexColumnRenderer",
                                                        JSONObject().put("text", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "m.A.A.d city")))),
                                                    ),
                                                )
                                                .put(
                                                    JSONObject().put(
                                                        "musicResponsiveListItemFlexColumnRenderer",
                                                        JSONObject().put(
                                                            "text",
                                                            JSONObject().put(
                                                                "runs",
                                                                JSONArray()
                                                                    .put(JSONObject().put("text", "Song"))
                                                                    .put(JSONObject().put("text", " • "))
                                                                    .put(JSONObject().put("text", "5:50")),
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                        )
                                        .put(
                                            "menu",
                                            JSONObject().put(
                                                "menuRenderer",
                                                JSONObject().put(
                                                    "items",
                                                    JSONArray().put(
                                                        JSONObject().put(
                                                            "menuNavigationItemRenderer",
                                                            JSONObject().put(
                                                                "navigationEndpoint",
                                                                JSONObject().put(
                                                                    "browseEndpoint",
                                                                    JSONObject()
                                                                        .put("browseId", "MPREb_6OR990vuECL")
                                                                        .put(
                                                                            "browseEndpointContextSupportedConfigs",
                                                                            JSONObject().put(
                                                                                "browseEndpointContextMusicConfig",
                                                                                JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ALBUM"),
                                                                            ),
                                                                        ),
                                                                ),
                                                            ),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        ),
                                ),
                            ),
                        ),
                ),
            ),
        ).toString()

        val result = ExternalDiscoveryApi.parseYtmSearch(searchJson, "Kendrick Lamar")
        assertEquals(1, result.songs.size)
        assertEquals("Kendrick Lamar", result.songs[0].artist)
        assertEquals("MPREb_6OR990vuECL", result.songs[0].albumBrowseId)
    }

    @Test
    fun parsesYtmNextTrackMetaWithAlbumYearAndUpsizedArt() {
        val nextJson = JSONObject().put(
            "contents",
            JSONObject().put(
                "playlistPanelVideoRenderer",
                JSONObject()
                    .put("videoId", "9cHbvRUALrc")
                    .put("title", JSONObject().put("runs", JSONArray().put(JSONObject().put("text", "Pink + White"))))
                    .put(
                        "longBylineText",
                        JSONObject().put(
                            "runs",
                            JSONArray()
                                .put(
                                    JSONObject()
                                        .put("text", "Frank Ocean")
                                        .put(
                                            "navigationEndpoint",
                                            JSONObject().put(
                                                "browseEndpoint",
                                                JSONObject()
                                                    .put("browseId", "UCETYiBLjt2v-pcKSgf8pe6g")
                                                    .put(
                                                        "browseEndpointContextSupportedConfigs",
                                                        JSONObject().put(
                                                            "browseEndpointContextMusicConfig",
                                                            JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ARTIST"),
                                                        ),
                                                    ),
                                            ),
                                        ),
                                )
                                .put(JSONObject().put("text", " • "))
                                .put(
                                    JSONObject()
                                        .put("text", "Blonde")
                                        .put(
                                            "navigationEndpoint",
                                            JSONObject().put(
                                                "browseEndpoint",
                                                JSONObject()
                                                    .put("browseId", "MPREb_or9GipYFiAw")
                                                    .put(
                                                        "browseEndpointContextSupportedConfigs",
                                                        JSONObject().put(
                                                            "browseEndpointContextMusicConfig",
                                                            JSONObject().put("pageType", "MUSIC_PAGE_TYPE_ALBUM"),
                                                        ),
                                                    ),
                                            ),
                                        ),
                                )
                                .put(JSONObject().put("text", " • "))
                                .put(JSONObject().put("text", "2016")),
                        ),
                    )
                    .put(
                        "thumbnail",
                        JSONObject().put(
                            "thumbnails",
                            JSONArray().put(
                                JSONObject().put("url", "https://yt3.googleusercontent.com/abc123=w120-h120-l90-rj"),
                            ),
                        ),
                    ),
            ),
        ).toString()

        val meta = ExternalDiscoveryApi.parseYtmNextTrackMeta(nextJson, "9cHbvRUALrc")
        assertNotNull(meta)
        assertEquals("Blonde", meta?.album)
        assertEquals("MPREb_or9GipYFiAw", meta?.albumBrowseId)
        assertEquals("Frank Ocean", meta?.artist)
        assertEquals("2016", meta?.year)
        assertEquals("https://yt3.googleusercontent.com/abc123=w544-h544-l90-rj", meta?.artUrl)
    }

    @Test
    fun picksStudioAlbumArtOverWrongSinglesAndRemembersStreamingArt() {
        val wrongOnly = JSONObject().put(
            "results",
            JSONArray()
                .put(
                    JSONObject()
                        .put("collectionName", "Moon River - Single")
                        .put("artistName", "Frank Ocean")
                        .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/wrong/100x100bb.jpg"),
                )
                .put(
                    JSONObject()
                        .put("collectionName", "Blonde (Instrumental)")
                        .put("artistName", "Frank Ocean")
                        .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/inst/100x100bb.jpg"),
                ),
        ).toString()
        // Neither matches the studio album strongly enough, so caller falls back to YTM instead of showing wrong art.
        assertEquals(null, ExternalDiscoveryApi.pickBestItunesAlbumArt(wrongOnly, "Frank Ocean", "Blonde"))

        val withStudio = JSONObject().put(
            "results",
            JSONArray()
                .put(
                    JSONObject()
                        .put("collectionName", "Currents B-Sides & Remixes - EP")
                        .put("artistName", "Tame Impala")
                        .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/bsides/100x100bb.jpg"),
                )
                .put(
                    JSONObject()
                        .put("collectionName", "Currents")
                        .put("artistName", "Tame Impala")
                        .put("artworkUrl100", "https://is1-ssl.mzstatic.com/image/thumb/currents/100x100bb.jpg"),
                ),
        ).toString()
        assertEquals(
            "https://is1-ssl.mzstatic.com/image/thumb/currents/600x600bb.jpg",
            ExternalDiscoveryApi.pickBestItunesAlbumArt(withStudio, "Tame Impala", "Currents"),
        )

        val streamArt = "https://yt3.googleusercontent.com/blonde_cover=w544-h544-l90-rj"
        ExternalDiscoveryApi.rememberAlbumArtUrl("Frank Ocean & Friends", "Blonde", streamArt)
        assertEquals(streamArt, ExternalDiscoveryApi.cachedAlbumArtUrl("Frank Ocean & Friends", "Blonde"))
        assertEquals(streamArt, ExternalDiscoveryApi.cachedAlbumArtUrl("Frank Ocean", "Blonde"))
    }
}
