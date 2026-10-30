package com.peartube.app.player

/** Part of the frame, in fractions of its width and height. */
internal data class Crop(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
}

/**
 * Finds black bars encoded into the video itself: a 2.39 film in a 16:9 frame, 4:3 in 16:9.
 * Fitting such a frame to a screen of another shape adds bars on the other axis too, black on
 * all four sides; showing only the lit part lets the picture take the room those bars held.
 *
 * It sees small read-backs of the shown frames. The area it keeps is everything lit in any of
 * them and only ever grows, so a scene that opens up (IMAX shots, subtitles burned into the
 * bars) widens it at once and no picture stays hidden. Dark frames say nothing and are
 * skipped, and nothing is cut until [AGREE] different bright frames are in, so a logo on black
 * or a paused frame cannot set it. No clock: frames drive it.
 */
internal class Letterbox {
    private var width = 0
    private var height = 0
    private var luma = IntArray(0)
    private var previous = IntArray(0)
    private var bright = 0
    // Everything lit so far, in sample pixels, inclusive; empty while right < 0.
    private var left = 0
    private var top = 0
    private var right = -1
    private var bottom = -1

    fun reset() {
        width = 0
        height = 0
        bright = 0
        right = -1
        bottom = -1
    }

    /** Adds a frame read back as [w]x[h] ARGB; returns the part to show, null for all of it. */
    fun add(argb: IntArray, w: Int, h: Int): Crop? {
        if (w != width || h != height) {
            reset()
            width = w
            height = h
            luma = IntArray(w * h)
            previous = IntArray(w * h)
        }
        var sum = 0L
        for (i in 0 until w * h) {
            val c = argb[i]
            val y = (((c shr 16) and 0xff) * 77 + ((c shr 8) and 0xff) * 150 + (c and 0xff) * 29) shr 8
            luma[i] = y
            sum += y
        }
        if (sum < DARK_MEAN.toLong() * w * h) return crop()

        var t = 0
        while (t < h && blackRow(t)) t++
        if (t == h) return crop()
        var b = h - 1
        while (blackRow(b)) b--
        // Row t has a lit pixel, so both scans stop inside the frame.
        var l = 0
        while (blackColumn(l, t, b)) l++
        var r = w - 1
        while (blackColumn(r, t, b)) r--

        if (right < 0) {
            left = l; top = t; right = r; bottom = b
        } else {
            left = minOf(left, l); top = minOf(top, t); right = maxOf(right, r); bottom = maxOf(bottom, b)
        }

        var change = 0L
        for (i in 0 until w * h) change += kotlin.math.abs(luma[i] - previous[i])
        if (bright == 0 || change >= CHANGED.toLong() * w * h) bright++
        luma = previous.also { previous = luma }
        return crop()
    }

    private fun blackRow(y: Int): Boolean {
        val row = y * width
        for (x in 0 until width) if (luma[row + x] > BLACK) return false
        return true
    }

    private fun blackColumn(x: Int, from: Int, to: Int): Boolean {
        for (y in from..to) if (luma[y * width + x] > BLACK) return false
        return true
    }

    private fun crop(): Crop? {
        if (bright < AGREE || right < 0) return null
        // One sample pixel of margin: a picture edge inside a sample pixel blends with the bar
        // and can read black. A bar one sample thin is then no bar at all.
        val l = (left - 1).coerceAtLeast(0)
        val t = (top - 1).coerceAtLeast(0)
        val r = (right + 2).coerceAtMost(width)
        val b = (bottom + 2).coerceAtMost(height)
        if (l == 0 && t == 0 && r == width && b == height) return null
        // Something small lit on black is not a picture with bars around it.
        if ((r - l) * 3 < width || (b - t) * 3 < height) return null
        return Crop(l.toFloat() / width, t.toFloat() / height, r.toFloat() / width, b.toFloat() / height)
    }

    private companion object {
        /** Brightest a bar's pixel reads (0-255 luma): encoded black is 0, picture noise above. */
        const val BLACK = 12
        /** Frames darker on average than this cannot tell a bar from a dark scene. */
        const val DARK_MEAN = 20
        /** Mean change per pixel that makes a frame a different picture, not the same one again. */
        const val CHANGED = 2
        /** Different bright frames seen before anything is cut. */
        const val AGREE = 6
    }
}
