package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AcquisitionAndShareTest {

    @Test
    fun extractsUrlsAndKeysFromShareText() {
        assertEquals(
            "https://on.soundcloud.com/xyz123",
            extractSharedUrl("Check out Song on #SoundCloud https://on.soundcloud.com/xyz123."),
        )
        assertEquals(
            "https://youtu.be/dQw4w9WgXcQ?si=abc123",
            extractSharedUrl("Listen to this live set: https://youtu.be/dQw4w9WgXcQ?si=abc123!"),
        )
        assertEquals(
            "https://rumble.com/v5demo1-concert-stream.html",
            extractSharedUrl("https://rumble.com/v5demo1-concert-stream.html"),
        )
        assertEquals(
            "peartube://watch/a1b2c3d4?title=Demo",
            extractSharedUrl("Watch on PearTube: peartube://watch/a1b2c3d4?title=Demo,"),
        )
        assertEquals(
            "peartube://add?url=https%3A%2F%2Fsoundcloud.com%2Fartist-demo%2Ftrack-one",
            extractSharedUrl("peartube://add?url=https%3A%2F%2Fsoundcloud.com%2Fartist-demo%2Ftrack-one"),
        )
        assertEquals(
            "https://soundcloud.com/artist-demo/track-one",
            parsePeartubeAddUrl("peartube://add?url=https%3A%2F%2Fsoundcloud.com%2Fartist-demo%2Ftrack-one"),
        )
        assertNull(parsePeartubeAddUrl("peartube://watch/abc123"))

        val hexKey = "0123456789ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef"
        assertEquals(hexKey.lowercase(), extractSharedUrl("Follow channel $hexKey"))
        assertEquals(hexKey.lowercase(), extractSharedUrl(hexKey))

        assertNull(extractSharedUrl("Just a note with no link or key"))
        assertNull(extractSharedUrl("   "))
    }

    @Test
    fun parsesIdentifyResultForSoundCloudRumbleAndDirectFile() {
        val scJson = JSONObject()
            .put("kind", "page")
            .put("site", "SoundCloud")
            .put("title", "Midnight Groove")
            .put("author", "Synth Collective")
            .put("duration", 215)
            .put("audioOnly", true)
            .put("id", "sc:12345:s01e01")
            .put("music", JSONObject().put("title", "Midnight Groove").put("artist", "Synth Collective"))
        val sc = IdentifyResult.from(scJson)
        assertTrue(sc.isPage)
        assertEquals("SoundCloud", sc.site)
        assertEquals("Midnight Groove", sc.effectiveTitle)
        assertEquals("Synth Collective", sc.effectiveArtist)
        assertEquals(215L, sc.durationSec)
        assertTrue(sc.audioOnly)
        assertEquals("sc:12345:s01e01", sc.effectiveId)

        val rumbleJson = JSONObject()
            .put("kind", "page")
            .put("site", "Rumble")
            .put("title", "Studio Documentary")
            .put("author", "Tape Archive")
            .put("duration", 1840)
            .put("audioOnly", false)
            .put("id", "clip:rumble987")
            .put("resolution", "1080p")
        val rumble = IdentifyResult.from(rumbleJson)
        assertTrue(rumble.isPage)
        assertEquals("Rumble", rumble.site)
        assertFalse(rumble.audioOnly)
        assertEquals(1840L, rumble.durationSec)
        assertEquals("1080p", rumble.resolution)

        val directFileJson = JSONObject()
            .put("kind", "file")
            .put("title", "Metropolis 1927")
            .put("id", "clip:file123")
            .put("size", 2_400_000_000L)
            .put("match", JSONObject().put("id", "imdb:tt0017136").put("title", "Metropolis 1927"))
        val file = IdentifyResult.from(directFileJson)
        assertFalse(file.isPage)
        assertFalse(file.audioOnly)
        assertEquals("imdb:tt0017136", file.effectiveId)
        assertEquals("Metropolis 1927", file.effectiveTitle)
        assertEquals(2_400_000_000L, file.size)
        assertNotNull(file.match)
    }

    @Test
    fun parsesAcquireJobsAndFormatsStatusLabels() {
        val downloading = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-1")
                .put("id", "sc:1:s01e01")
                .put("title", "Blue Train")
                .put("plugin", "soundcloud")
                .put("status", "downloading")
                .put("bytes", 4_500_000L)
                .put("total", 10_000_000L),
        )
        assertTrue(downloading.isActive)
        assertFalse(downloading.isDone)
        assertEquals("Downloading 45%", downloading.statusLabel())

        val queued = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-2")
                .put("title", "Kind of Blue")
                .put("plugin", "soulseek")
                .put("status", "queued")
                .put("peer", "crate_digger")
                .put("queuePlace", 3),
        )
        assertTrue(queued.isActive)
        assertEquals("Queued (#3)", queued.statusLabel())
        assertEquals("crate_digger", queued.peer)

        val albumProgress = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-3")
                .put("title", "Bitches Brew")
                .put("plugin", "soulseek")
                .put("status", "transferring")
                .put("tracksDone", 2)
                .put("tracksTotal", 6),
        )
        assertEquals("Downloading (2/6)", albumProgress.statusLabel())

        val done = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-4")
                .put("title", "Giant Steps")
                .put("status", "done"),
        )
        assertFalse(done.isActive)
        assertTrue(done.isDone)
        assertEquals("Added", done.statusLabel())

        val failed = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-5")
                .put("title", "Broken Link")
                .put("status", "failed")
                .put("error", "Source returned 404"),
        )
        assertFalse(failed.isActive)
        assertTrue(failed.isFailed)
        assertEquals("Failed: Source returned 404", failed.statusLabel())

        val retrying = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-6")
                .put("title", "In Rainbows")
                .put("plugin", "soulseek")
                .put("status", "queued")
                .put("phase", "retrying")
                .put("note", "Connection paused — retrying in 15s (2/5)…"),
        )
        assertTrue(retrying.isActive)
        assertTrue(retrying.isRetrying)
        assertEquals("Retrying…", retrying.statusLabel())
        assertEquals("Connection paused — retrying in 15s (2/5)…", retrying.note)

        val retryableFailed = AcquireJob.from(
            JSONObject()
                .put("jobId", "job-7")
                .put("title", "Kid A")
                .put("plugin", "soulseek")
                .put("status", "failed")
                .put("retryable", true)
                .put("error", "peer offline"),
        )
        assertTrue(retryableFailed.isFailed)
        assertTrue(retryableFailed.retryable)
    }

    @Test
    fun parsesUnifiedSourceSearchResults() {
        val payload = JSONObject()
            .put("query", "miles davis")
            .put("sources", JSONArray(listOf("soulseek", "youtube", "soundcloud", "rumble")))
            .put(
                "bySource",
                JSONObject()
                    .put(
                        "soulseek",
                        JSONObject().put(
                            "candidates",
                            JSONArray().put(
                                JSONObject()
                                    .put("peer", "vinyl_archivist")
                                    .put("folder", "Jazz/Miles Davis - Kind of Blue (1959)")
                                    .put("artist", "Miles Davis")
                                    .put("album", "Kind of Blue")
                                    .put("year", "1959")
                                    .put("quality", "FLAC 24-bit")
                                    .put("files", JSONArray(listOf("01 So What.flac", "02 Freddie Freeloader.flac")))
                                    .put("size", 520_000_000L),
                            ),
                        ),
                    )
                    .put(
                        "youtube",
                        JSONObject().put(
                            "candidates",
                            JSONArray().put(
                                JSONObject()
                                    .put("videoId", "zqNTltOGh5c")
                                    .put("title", "Miles Davis - So What")
                                    .put("channel", "Jazz Classics")
                                    .put("duration", 562)
                                    .put("bitrate", 128),
                            ),
                        ),
                    )
                    .put(
                        "soundcloud",
                        JSONObject().put(
                            "candidates",
                            JSONArray().put(
                                JSONObject()
                                    .put("trackId", "sc-9988")
                                    .put("title", "So What (Live Flip)")
                                    .put("artist", "Beat Kitchen")
                                    .put("duration", 240)
                                    .put("url", "https://soundcloud.com/beat-kitchen/so-what-live"),
                            ),
                        ),
                    )
                    .put(
                        "rumble",
                        JSONObject().put(
                            "candidates",
                            JSONArray().put(
                                JSONObject()
                                    .put("rumbleId", "v4abcde")
                                    .put("title", "Miles Davis 1959 Studio Breakdown")
                                    .put("channel", "Music History")
                                    .put("duration", 910)
                                    .put("url", "https://rumble.com/v4abcde-miles-davis.html"),
                            ),
                        ),
                    ),
            )
            .put("errors", JSONObject())

        val result = SourceSearchResult.from(payload)
        assertEquals("miles davis", result.query)
        assertEquals(4, result.sources.size)
        assertFalse(result.isEmpty)

        assertEquals(1, result.soulseek.size)
        val slsk = result.soulseek[0]
        assertEquals("vinyl_archivist", slsk.peer)
        assertEquals("Miles Davis", slsk.artist)
        assertEquals("Kind of Blue", slsk.album)
        assertEquals("FLAC 24-bit", slsk.quality)
        assertEquals(2, slsk.fileCount)
        assertEquals(520_000_000L, slsk.size)

        assertEquals(1, result.youtube.size)
        val yt = result.youtube[0]
        assertEquals("zqNTltOGh5c", yt.videoId)
        assertEquals("Lossy · AAC 128 kbps", yt.qualityLabel)
        assertEquals(562L, yt.durationSec)

        assertEquals(1, result.soundcloud.size)
        val sc = result.soundcloud[0]
        assertEquals("sc-9988", sc.trackId)
        assertEquals("Beat Kitchen", sc.artist)
        assertEquals("https://soundcloud.com/beat-kitchen/so-what-live", sc.url)

        assertEquals(1, result.rumble.size)
        val rb = result.rumble[0]
        assertEquals("v4abcde", rb.rumbleId)
        assertEquals("Music History", rb.channel)
        assertEquals(910L, rb.durationSec)
    }

    @Test
    fun parsesSoulseekShelfAndSettings() {
        val shelfJson = JSONObject()
            .put("peer", "crate_digger")
            .put(
                "folders",
                JSONArray()
                    .put(
                        JSONObject()
                            .put("folder", "Music/John Coltrane - Blue Train (1957)")
                            .put("artist", "John Coltrane")
                            .put("album", "Blue Train")
                            .put("quality", "FLAC 24-bit")
                            .put("files", JSONArray(listOf("01 Blue Train.flac", "02 Moment's Notice.flac")))
                            .put("size", 410_000_000L),
                    )
                    .put(
                        JSONObject()
                            .put("folder", "Music/Bill Evans - Sunday at the Village Vanguard")
                            .put("artist", "Bill Evans")
                            .put("album", "Sunday at the Village Vanguard")
                            .put("quality", "MP3 320 kbps")
                            .put("files", JSONArray(listOf("01 Gloria's Step.mp3")))
                            .put("size", 95_000_000L),
                    ),
            )

        val shelf = SoulseekShelf.from(shelfJson)
        assertEquals("crate_digger", shelf.peer)
        assertEquals(2, shelf.folders.size)
        assertEquals("Blue Train", shelf.folders[0].album)
        assertEquals("FLAC 24-bit", shelf.folders[0].quality)
        assertEquals(2, shelf.folders[0].fileCount)
        assertEquals("MP3 320 kbps", shelf.folders[1].quality)

        val flatSettings = SoulseekPeerSettings.from(
            JSONObject()
                .put("soulseekUser", "peer_listener")
                .put("soulseekPasswordSet", true)
                .put("soulseekShare", true),
        )
        assertEquals("peer_listener", flatSettings.username)
        assertTrue(flatSettings.passwordSet)
        assertTrue(flatSettings.sharePublicMusic)
        assertTrue(flatSettings.isConfigured)

        val nestedSettings = SoulseekPeerSettings.from(
            JSONObject().put(
                "settings",
                JSONObject()
                    .put("slskUser", JSONObject().put("value", "relay_peer"))
                    .put("slskPass", JSONObject().put("set", true))
                    .put("slskShare", JSONObject().put("value", false)),
            ),
        )
        assertEquals("relay_peer", nestedSettings.username)
        assertTrue(nestedSettings.passwordSet)
        assertFalse(nestedSettings.sharePublicMusic)
    }
}
