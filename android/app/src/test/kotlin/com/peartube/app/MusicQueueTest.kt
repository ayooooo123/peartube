package com.peartube.app

import com.peartube.app.ui.describeTrackAudio
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class MusicQueueTest {
    private fun track(n: Int, album: String = "Blue Train", artist: String = "John Coltrane"): TrackItem {
        val e = Entry(
            key = "track-$n",
            id = "mb:bt:s01e0$n",
            title = "$artist · $album",
            size = 10_000_000L * n,
            sha256 = "sha-$n",
            local = true,
            streamUrl = "http://127.0.0.1:8175/blob/$n",
            season = 1,
            episode = n,
            seriesKey = "mb:bt",
            music = MusicMeta(title = "Song $n", artist = artist),
        )
        return TrackItem(
            entry = e,
            title = "Song $n",
            artist = artist,
            album = album,
            albumKey = "album:mb:bt",
            hue = 120,
            seed = 1234L,
            trackNo = "0$n",
            disc = 1,
            track = n,
        )
    }

    @Test
    fun playListStartsAtRowNAndKeepsRemainingInOrder() {
        val tracks = (1..5).map { track(it) }
        val step = MusicQueue.playList(MusicState(), tracks, startIndex = 2, sourceLabel = "Blue Train", shuffleOn = false)
        assertEquals(2, step.state.index)
        assertEquals("track-3", step.openTrack?.key)
        assertEquals(listOf(0, 1, 2, 3, 4), step.state.order)
        assertEquals("3 of 5", step.state.positionText)
        assertEquals(2, step.state.upNextCount)
    }

    @Test
    fun toggleShuffleMixesTailAndRestoresOriginalOrderWhenOff() {
        val tracks = (1..8).map { track(it) }
        val start = MusicQueue.playList(MusicState(), tracks, startIndex = 1, sourceLabel = "Blue Train", shuffleOn = false).state

        val shuffled = MusicQueue.toggleShuffle(start, random = Random(42))
        assertTrue(shuffled.shuffle)
        assertEquals(1, shuffled.index)
        assertEquals(listOf(0, 1), shuffled.order.take(2))
        assertEquals((2..7).toSet(), shuffled.order.drop(2).toSet())
        assertTrue(shuffled.order.drop(2) != (2..7).toList())

        val restored = MusicQueue.toggleShuffle(shuffled)
        assertFalse(restored.shuffle)
        assertEquals((0..7).toList(), restored.order)
        assertEquals(1, restored.index)
    }

    @Test
    fun repeatModesOffAllAndOne() {
        val tracks = (1..2).map { track(it) }
        val base = MusicQueue.playList(MusicState(), tracks, startIndex = 1, sourceLabel = "Blue Train", shuffleOn = false).state

        // Repeat Off at end stops
        val endOff = MusicQueue.next(base, userTriggered = false)
        assertTrue(endOff.reachedEnd)
        assertFalse(endOff.state.playing)

        // Repeat All wraps to 0
        val allState = MusicQueue.cycleRepeat(base)
        assertEquals(RepeatMode.All, allState.repeat)
        val wrapped = MusicQueue.next(allState, userTriggered = false)
        assertEquals(0, wrapped.state.index)
        assertEquals("track-1", wrapped.openTrack?.key)

        // Repeat One replays same track on auto-advance, but user Next advances/stops
        val oneState = MusicQueue.cycleRepeat(allState)
        assertEquals(RepeatMode.One, oneState.repeat)
        val autoRepeat = MusicQueue.next(oneState, userTriggered = false)
        assertEquals(1, autoRepeat.state.index)
        assertEquals("track-2", autoRepeat.openTrack?.key)

        // Cycle again returns to Off
        assertEquals(RepeatMode.Off, MusicQueue.cycleRepeat(oneState).repeat)
    }

    @Test
    fun playNextPlayLastRemoveAndClearUpNext() {
        val initial = (1..3).map { track(it) }
        var state = MusicQueue.playList(MusicState(), initial, startIndex = 0, sourceLabel = "Album A", shuffleOn = false).state

        val extraNext = track(10, album = "Album B")
        state = MusicQueue.playNext(state, listOf(extraNext)).state
        assertEquals(listOf("track-1", "track-10", "track-2", "track-3"), state.orderedTracks.map { it.key })
        assertEquals(0, state.index)

        val extraLast = track(20, album = "Album C")
        state = MusicQueue.playLast(state, listOf(extraLast)).state
        assertEquals(listOf("track-1", "track-10", "track-2", "track-3", "track-20"), state.orderedTracks.map { it.key })

        // Remove upcoming track at order index 2 ("track-2")
        state = MusicQueue.removeFromQueue(state, 2).state
        assertEquals(listOf("track-1", "track-10", "track-3", "track-20"), state.orderedTracks.map { it.key })

        // Clear Up next keeps only up to current index
        state = MusicQueue.clearUpNext(state)
        assertEquals(listOf("track-1"), state.orderedTracks.map { it.key })
        assertEquals(0, state.upNextCount)
    }

    @Test
    fun pauseForVideoPreservesTrackPositionAndQueueAndPersistsToJson() {
        val tracks = (1..3).map { track(it) }
        val playing = MusicQueue.playList(MusicState(), tracks, startIndex = 1, sourceLabel = "Blue Train", shuffleOn = false)
            .state
            .copy(positionMs = 47_500L, durationMs = 240_000L, repeat = RepeatMode.All)

        val waiting = MusicQueue.pauseForVideo(playing)
        assertTrue(waiting.pausedForVideo)
        assertFalse(waiting.playing)
        assertEquals(1, waiting.index)
        assertEquals(47_500L, waiting.positionMs)
        assertEquals(3, waiting.order.size)

        val json = MusicQueue.toJson(waiting)
        val restored = MusicQueue.fromJson(json)
        assertEquals(waiting.index, restored.index)
        assertEquals(waiting.positionMs, restored.positionMs)
        assertEquals(waiting.durationMs, restored.durationMs)
        assertEquals(waiting.repeat, restored.repeat)
        assertEquals(waiting.shuffle, restored.shuffle)
        assertTrue(restored.pausedForVideo)
        assertFalse(restored.playing)
        assertNotNull(restored.currentTrack)
        assertEquals("track-2", restored.currentTrack?.key)
    }

    @Test
    fun externalStreamTrackRoundTripsThroughJson() {
        val extEntry = Entry(
            key = "ext:preview:999",
            id = "ext:preview:999",
            title = "Naima",
            size = 0L,
            sha256 = "",
            local = false,
            streamUrl = "https://audio-ssl.itunes.apple.com/preview.m4a",
            music = MusicMeta(title = "Naima", artist = "John Coltrane"),
        )
        val item = TrackItem(
            entry = extEntry,
            title = "Naima",
            artist = "John Coltrane",
            album = "Giant Steps",
            albumKey = "",
            hue = 210,
            seed = 9876L,
            artUrl = "https://is1-ssl.mzstatic.com/cover.jpg",
            externalStreamSource = "Streaming · Preview",
            externalSaveUrl = "https://example.com/naima.flac",
            externalSaveKind = "preview",
        )
        assertTrue(item.isExternalStream)

        val state = MusicQueue.playList(MusicState(), listOf(item), 0, "Streaming · Preview", shuffleOn = false).state
        val restored = MusicQueue.fromJson(MusicQueue.toJson(state))
        val restoredTrack = restored.currentTrack
        assertNotNull(restoredTrack)
        assertTrue(restoredTrack?.isExternalStream == true)
        assertEquals("https://is1-ssl.mzstatic.com/cover.jpg", restoredTrack?.artUrl)
        assertEquals("Streaming · Preview", restoredTrack?.externalStreamSource)
        assertEquals("https://example.com/naima.flac", restoredTrack?.externalSaveUrl)
        assertEquals("preview", restoredTrack?.externalSaveKind)
        assertEquals("https://audio-ssl.itunes.apple.com/preview.m4a", restoredTrack?.entry?.streamUrl)

        val localTrack = track(1)
        assertFalse(localTrack.isExternalStream)
        val localRestored = TrackItem.fromJson(localTrack.toJson())
        assertFalse(localRestored.isExternalStream)
        assertEquals("", localRestored.artUrl)
        assertEquals(null, localRestored.externalStreamSource)
    }

    @Test
    fun trackItemRoundTripsStreamUserAgentAndExternalVideoId() {
        val extEntry = Entry(
            key = "ext:yt:dQw4w9WgXcQ",
            id = "ext:yt:dQw4w9WgXcQ",
            title = "Never Gonna Give You Up",
            size = 0L,
            sha256 = "",
            local = false,
            streamUrl = "https://rr1.googlevideo.com/videoplayback",
            music = MusicMeta(title = "Never Gonna Give You Up", artist = "Rick Astley"),
        )
        val item = TrackItem(
            entry = extEntry,
            title = "Never Gonna Give You Up",
            artist = "Rick Astley",
            album = "Whenever You Need Somebody",
            albumKey = "",
            hue = 180,
            seed = 42L,
            artUrl = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            externalStreamSource = "Streaming · YouTube",
            externalSaveUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            externalSaveKind = "youtube",
            streamUserAgent = YT_IOS_USER_AGENT,
            externalVideoId = "dQw4w9WgXcQ",
        )
        val restored = TrackItem.fromJson(item.toJson())
        assertEquals(YT_IOS_USER_AGENT, restored.streamUserAgent)
        assertEquals("dQw4w9WgXcQ", restored.externalVideoId)
        assertEquals("Streaming · YouTube", restored.externalStreamSource)
        assertEquals("https://www.youtube.com/watch?v=dQw4w9WgXcQ", restored.externalSaveUrl)
        assertEquals("youtube", restored.externalSaveKind)
    }

    @Test
    fun describeTrackAudioNeverMislabelsYouTubeOrLargeLocalFilesAsLossless() {
        val ytLocal = Entry(
            key = "k-yt",
            id = "yt:0123456789abcdef0123:s01e01",
            title = "So What",
            size = 9_122_346L,
            sha256 = "sha1",
            local = true,
            streamUrl = "http://127.0.0.1:8175/blob/k-yt",
        )
        val ytDetails = describeTrackAudio(ytLocal, codec = "aac", audioOutput = "Lossless · 32-bit float 44.1 kHz · 2.0", durationMs = 563_617L)
        assertFalse(ytDetails.isLossless)
        assertTrue(ytDetails.formatLabel.startsWith("AAC"))
        assertFalse(ytDetails.formatLabel.contains("Lossless", ignoreCase = true))
        assertEquals("PCM · 32-bit float 44.1 kHz · 2.0", ytDetails.outputLabel)
        assertTrue(ytDetails.canFindLossless)

        // A large local file (25 MB) with unknown codec must NEVER claim Lossless!
        val bigUnknownLocal = Entry(
            key = "k-big",
            id = "album:0123456789abcdef0123:s01e01",
            title = "Live Set",
            size = 25_000_000L,
            sha256 = "sha2",
            local = true,
            streamUrl = "http://127.0.0.1:8175/blob/k-big",
        )
        val bigDetails = describeTrackAudio(bigUnknownLocal, codec = null, durationMs = 1_800_000L)
        assertFalse(bigDetails.isLossless)
        assertFalse(bigDetails.formatLabel.contains("Lossless", ignoreCase = true))

        // Only a real lossless codec (FLAC/ALAC/PCM) reports Lossless.
        val flacDetails = describeTrackAudio(bigUnknownLocal, codec = "flac", durationMs = 240_000L)
        assertTrue(flacDetails.isLossless)
        assertTrue(flacDetails.formatLabel.startsWith("FLAC · Lossless"))
        assertFalse(flacDetails.canFindLossless)
    }

    @Test
    fun autoplayTogglePersistsAndAppendsDeduplicatedRadioTracks() {
        val base = MusicQueue.playList(MusicState(), listOf(track(1)), startIndex = 0, sourceLabel = "Blue Train", shuffleOn = false).state
        assertTrue(base.autoplay)

        val dupBySignature = track(99).copy(title = "Song 1", artist = "John Coltrane")
        val fresh1 = track(2)
        val fresh2 = track(3)
        val appended = MusicQueue.appendAutoplay(base, listOf(dupBySignature, fresh1, fresh2, fresh1))
        assertEquals(listOf("track-1", "track-2", "track-3"), appended.orderedTracks.map { it.key })

        val toggledOff = MusicQueue.toggleAutoplay(appended)
        assertFalse(toggledOff.autoplay)
        val restored = MusicQueue.fromJson(MusicQueue.toJson(toggledOff))
        assertFalse(restored.autoplay)
    }

    @Test
    fun resolveStreamSaveStateTransitionsUnsavedToSavingToSaved() {
        val extEntry = Entry(
            key = "ext:ytm:ylXk1LBvIqU",
            id = "ext:ytm:ylXk1LBvIqU",
            title = "So What",
            size = 0L,
            sha256 = "",
            local = false,
            streamUrl = "https://rr1.googlevideo.com/audio",
            music = MusicMeta(title = "So What", artist = "Miles Davis"),
        )
        val streamingTrack = TrackItem(
            entry = extEntry,
            title = "So What",
            artist = "Miles Davis",
            album = "Kind of Blue",
            albumKey = "",
            hue = 210,
            seed = 1L,
            externalStreamSource = "Streaming",
            externalVideoId = "ylXk1LBvIqU",
        )
        val keys = streamSaveLookupKeys(streamingTrack.key, streamingTrack.externalVideoId, streamingTrack.artist, streamingTrack.title)

        // Initially unsaved
        assertEquals(
            StreamSaveState.Unsaved,
            resolveStreamSaveState(streamingTrack, LibraryCatalog.Empty, emptyList(), emptyMap(), emptySet(), emptySet()),
        )

        // Immediately submitting -> Saving
        assertEquals(
            StreamSaveState.Saving,
            resolveStreamSaveState(streamingTrack, LibraryCatalog.Empty, emptyList(), emptyMap(), keys, emptySet()),
        )

        // Active acquire job -> Saving
        val runningJob = AcquireJob(jobId = "j1", id = "yt:abc:s01e01", title = "So What", status = "running", bytes = 100L, total = 1000L, error = null)
        assertEquals(
            StreamSaveState.Saving,
            resolveStreamSaveState(streamingTrack, LibraryCatalog.Empty, listOf(runningJob), keys.associateWith { "j1" }, emptySet(), emptySet()),
        )

        // Job done -> Saved
        val doneJob = runningJob.copy(status = "done")
        assertEquals(
            StreamSaveState.Saved,
            resolveStreamSaveState(streamingTrack, LibraryCatalog.Empty, listOf(doneJob), keys.associateWith { "j1" }, emptySet(), emptySet()),
        )

        // Present in library catalog -> Saved even without tracked job
        val libCatalog = LibraryCatalog.build(
            listOf(
                Entry(
                    key = "lib-1",
                    id = "yt:0123456789abcdef0123:s01e01",
                    title = "Kind of Blue",
                    size = 9_000_000L,
                    sha256 = "sha1",
                    local = true,
                    streamUrl = "http://127.0.0.1:8175/blob/lib-1",
                    season = 1,
                    episode = 1,
                    seriesKey = "yt:0123456789abcdef0123",
                    music = MusicMeta(title = "So What", artist = "Miles Davis"),
                ),
            ),
        )
        assertEquals(
            StreamSaveState.Saved,
            resolveStreamSaveState(streamingTrack, libCatalog, emptyList(), emptyMap(), emptySet(), emptySet()),
        )
    }
}
