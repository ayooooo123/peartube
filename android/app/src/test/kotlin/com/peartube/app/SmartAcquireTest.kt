package com.peartube.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SmartAcquireTest {

    @Test
    fun detectsYouTubeMusicUrlAsMusicAudioOnly() {
        val info = IdentifyResult(
            kind = "page",
            site = "YouTube",
            title = "Midnight City",
            author = "M83 Official",
            durationSec = 243L,
            audioOnly = false,
            id = "yt:dX3k_QDnzHE",
        )
        val plan = classifyLinkAcquisition(
            url = "https://music.youtube.com/watch?v=dX3k_QDnzHE",
            info = info,
            podcastFormat = PodcastImportFormat.Video,
        )
        assertEquals(DetectedMediaKind.Music, plan.kind)
        assertTrue(plan.audioOnly)
        assertEquals("Midnight City", plan.title)
        assertEquals("M83", plan.artist)
    }

    @Test
    fun detectsTopicChannelAsMusicAndStripsTopicSuffix() {
        val info = IdentifyResult(
            kind = "page",
            site = "YouTube",
            title = "Everything In Its Right Place",
            author = "Radiohead - Topic",
            durationSec = 251L,
            audioOnly = false,
            id = "yt:NUnXxh5U25Y",
        )
        val plan = classifyLinkAcquisition(
            url = "https://www.youtube.com/watch?v=NUnXxh5U25Y",
            info = info,
            podcastFormat = PodcastImportFormat.Video,
        )
        assertEquals(DetectedMediaKind.Music, plan.kind)
        assertTrue(plan.audioOnly)
        assertEquals("Everything In Its Right Place", plan.title)
        assertEquals("Radiohead", plan.artist)
    }

    @Test
    fun detectsVevoOfficialMusicVideoAndSplitsArtistTrack() {
        val info = IdentifyResult(
            kind = "page",
            site = "YouTube",
            title = "Kendrick Lamar - HUMBLE. (Official Music Video)",
            author = "KendrickLamarVEVO",
            durationSec = 183L,
            audioOnly = false,
            id = "yt:tvTRZJ-4EyI",
        )
        val plan = classifyLinkAcquisition(
            url = "https://www.youtube.com/watch?v=tvTRZJ-4EyI",
            info = info,
            podcastFormat = PodcastImportFormat.Video,
        )
        assertEquals(DetectedMediaKind.Music, plan.kind)
        assertTrue(plan.audioOnly)
        assertEquals("Kendrick Lamar", plan.artist)
        assertEquals("HUMBLE.", plan.title)
    }

    @Test
    fun detectsPodcastAndFollowsPodcastImportPreference() {
        val info = IdentifyResult(
            kind = "page",
            site = "YouTube",
            title = "Lex Fridman Podcast #400 - Elon Musk",
            author = "Lex Fridman",
            durationSec = 7200L,
            audioOnly = false,
            id = "yt:JN3KPFbWCy8",
        )
        val audioPlan = classifyLinkAcquisition(
            url = "https://www.youtube.com/watch?v=JN3KPFbWCy8",
            info = info,
            podcastFormat = PodcastImportFormat.Audio,
        )
        assertEquals(DetectedMediaKind.Podcast, audioPlan.kind)
        assertTrue(audioPlan.audioOnly)
        assertEquals("Lex Fridman Podcast #400 - Elon Musk", audioPlan.title)
        assertEquals("Lex Fridman", audioPlan.artist)

        val videoPlan = classifyLinkAcquisition(
            url = "https://www.youtube.com/watch?v=JN3KPFbWCy8",
            info = info,
            podcastFormat = PodcastImportFormat.Video,
        )
        assertEquals(DetectedMediaKind.Podcast, videoPlan.kind)
        assertFalse(videoPlan.audioOnly)
        assertEquals("Lex Fridman Podcast #400 - Elon Musk", videoPlan.title)
        assertEquals("Lex Fridman", videoPlan.artist)
    }

    @Test
    fun detectsRegularLongerYouTubeReviewAsVideo() {
        val info = IdentifyResult(
            kind = "page",
            site = "YouTube",
            title = "MKBHD - iPhone Review",
            author = "Marques Brownlee",
            durationSec = 920L,
            audioOnly = false,
            id = "yt:abc12345678",
        )
        val plan = classifyLinkAcquisition(
            url = "https://www.youtube.com/watch?v=abc12345678",
            info = info,
            podcastFormat = PodcastImportFormat.Audio,
        )
        assertEquals(DetectedMediaKind.Video, plan.kind)
        assertFalse(plan.audioOnly)
        assertEquals("MKBHD - iPhone Review", plan.title)
        assertEquals("Marques Brownlee", plan.artist)
    }

    @Test
    fun preservesDirectMovieMatchAsVideo() {
        val info = IdentifyResult(
            kind = "file",
            site = "",
            title = "Blade Runner 2049 2160p",
            author = "",
            durationSec = 9800L,
            audioOnly = false,
            id = "clip:file99",
            match = IdentifyMatch(id = "imdb:tt1856101", title = "Blade Runner 2049"),
        )
        val plan = classifyLinkAcquisition(
            url = "https://cdn.example.org/Blade.Runner.2049.mkv",
            info = info,
            podcastFormat = PodcastImportFormat.Audio,
        )
        assertEquals(DetectedMediaKind.Video, plan.kind)
        assertFalse(plan.audioOnly)
        assertEquals("Blade Runner 2049", plan.title)
    }

    @Test
    fun smartParsesYouTubeSearchCandidateCleanly() {
        val cand = YouTubeCandidate(
            videoId = "tvTRZJ-4EyI",
            title = "Kendrick Lamar - HUMBLE. (Official Music Video) [4K]",
            channel = "KendrickLamarVEVO",
            durationSec = 183L,
        )
        val plan = smartParseYouTubeCandidate(cand)
        assertEquals(DetectedMediaKind.Music, plan.kind)
        assertTrue(plan.audioOnly)
        assertEquals("Kendrick Lamar", plan.artist)
        assertEquals("HUMBLE.", plan.title)
    }

    @Test
    fun parsesPreferenceEnumsSafely() {
        assertEquals(ShareImportMode.Auto, ShareImportMode.fromId("auto"))
        assertEquals(ShareImportMode.Ask, ShareImportMode.fromId("ask"))
        assertEquals(ShareImportMode.Auto, ShareImportMode.fromId("unknown"))

        assertEquals(PodcastImportFormat.Video, PodcastImportFormat.fromId("video"))
        assertEquals(PodcastImportFormat.Audio, PodcastImportFormat.fromId("audio"))
        assertEquals(PodcastImportFormat.Video, PodcastImportFormat.fromId(null))
    }
}
