package com.peartube.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastSessionPolicyTest {
    private fun sampleSession(
        status: String = "playing",
        playing: Boolean = true,
        buffering: Boolean = false,
        ended: Boolean = false,
        entry: CastEntryMeta? = CastEntryMeta(
            key = "k1",
            id = "imdb:tt15239678",
            title = "Dune: Part Two",
            size = 42_000_000_000L,
        ),
    ) = CastSession(
        receiverId = "tv-1",
        receiverName = "PearTube TV · Google TV Streamer",
        transport = "lan",
        state = CastPlaybackState(
            status = status,
            entry = entry,
            positionMs = 123_456L,
            durationMs = 9_960_000L,
            playing = playing,
            buffering = buffering,
            ended = ended,
        ),
    )

    @Test
    fun liveSessionDetectsActivePausedAndIdleStates() {
        assertFalse(isCastSessionLive(null))
        assertTrue(isCastSessionLive(sampleSession(status = "playing", playing = true)))
        assertTrue(isCastSessionLive(sampleSession(status = "paused", playing = false)))
        assertTrue(isCastSessionLive(sampleSession(status = "loading", playing = false, buffering = true, entry = null)))
        assertFalse(isCastSessionLive(sampleSession(status = "idle", playing = false, buffering = false, ended = false, entry = null)))
        assertFalse(isCastSessionLive(sampleSession(status = "ended", playing = false, buffering = false, ended = true, entry = null)))
    }

    @Test
    fun playingCastBuildsActiveCastMediaSnapshotWithPoster() {
        val snap = buildCastMediaSnapshot(sampleSession(), reconnecting = false)
        assertTrue(snap.active)
        assertTrue(snap.isVideo)
        assertTrue(snap.isCast)
        assertTrue(snap.playing)
        assertFalse(snap.buffering)
        assertEquals("Dune: Part Two", snap.title)
        assertEquals("Playing on PearTube TV · Google TV Streamer", snap.subtitle)
        assertEquals(123_456L, snap.positionMs)
        assertEquals(9_960_000L, snap.durationMs)
        assertEquals("https://images.metahub.space/poster/medium/tt15239678/img", snap.artworkUrl)
    }

    @Test
    fun pausedCastKeepsForegroundServiceSnapshotAlive() {
        val snap = buildCastMediaSnapshot(sampleSession(status = "paused", playing = false), reconnecting = false)
        assertTrue(snap.active)
        assertTrue(snap.isCast)
        assertFalse(snap.playing)
        assertEquals("Paused on PearTube TV · Google TV Streamer", snap.subtitle)
    }

    @Test
    fun reconnectingCastKeepsServiceAliveWithBufferingSubtitle() {
        val snap = buildCastMediaSnapshot(sampleSession(status = "playing", playing = true), reconnecting = true)
        assertTrue(snap.active)
        assertTrue(snap.isCast)
        assertFalse(snap.playing)
        assertTrue(snap.buffering)
        assertEquals("Reconnecting to PearTube TV · Google TV Streamer…", snap.subtitle)
    }

    @Test
    fun idleCastStopsMediaService() {
        val snap = buildCastMediaSnapshot(
            sampleSession(status = "idle", playing = false, buffering = false, ended = false, entry = null),
            reconnecting = false,
        )
        assertFalse(snap.active)
        assertFalse(snap.isCast)
        assertNull(snap.artworkUrl)
    }

    @Test
    fun reconnectBackoffCapsAtFifteenSeconds() {
        assertEquals(1_500L, nextCastReconnectDelayMs(0))
        assertEquals(3_000L, nextCastReconnectDelayMs(1))
        assertEquals(5_000L, nextCastReconnectDelayMs(2))
        assertEquals(8_000L, nextCastReconnectDelayMs(3))
        assertEquals(12_000L, nextCastReconnectDelayMs(4))
        assertEquals(15_000L, nextCastReconnectDelayMs(5))
        assertEquals(15_000L, nextCastReconnectDelayMs(99))
    }
}
