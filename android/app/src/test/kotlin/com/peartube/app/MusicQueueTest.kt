package com.peartube.app

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
}
