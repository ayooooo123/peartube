package com.peartube.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OneHandGesturesTest {
    @Test
    fun swipeDownDismissesByDistanceOrQuickFling() {
        val threshold = 240f
        val flingVel = 2_000f
        val minFlingDist = 80f

        assertTrue(shouldDismissSwipeDown(240f, 0f, threshold, flingVel, minFlingDist))
        assertTrue(shouldDismissSwipeDown(320f, -100f, threshold, flingVel, minFlingDist))
        assertTrue(shouldDismissSwipeDown(95f, 2_400f, threshold, flingVel, minFlingDist))

        assertFalse(shouldDismissSwipeDown(40f, 2_500f, threshold, flingVel, minFlingDist))
        assertFalse(shouldDismissSwipeDown(150f, 400f, threshold, flingVel, minFlingDist))
        assertFalse(shouldDismissSwipeDown(0f, 0f, threshold, flingVel, minFlingDist))
    }

    @Test
    fun artworkSwipeDistinguishesMinimizeAndTrackSkip() {
        val horiz = 160f
        val dismiss = 240f
        val flingVel = 2_000f
        val minFling = 80f

        assertEquals(
            ArtworkSwipeOutcome.DismissDown,
            resolveArtworkSwipe(20f, 260f, 100f, horiz, dismiss, flingVel, minFling),
        )
        assertEquals(
            ArtworkSwipeOutcome.DismissDown,
            resolveArtworkSwipe(-30f, 100f, 2_300f, horiz, dismiss, flingVel, minFling),
        )
        assertEquals(
            ArtworkSwipeOutcome.NextTrack,
            resolveArtworkSwipe(-200f, 25f, 0f, horiz, dismiss, flingVel, minFling),
        )
        assertEquals(
            ArtworkSwipeOutcome.PreviousTrack,
            resolveArtworkSwipe(200f, -15f, 0f, horiz, dismiss, flingVel, minFling),
        )
        assertEquals(
            ArtworkSwipeOutcome.None,
            resolveArtworkSwipe(40f, 30f, 0f, horiz, dismiss, flingVel, minFling),
        )
    }
}
