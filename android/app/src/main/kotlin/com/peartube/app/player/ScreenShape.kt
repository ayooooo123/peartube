package com.peartube.app.player

/** A rectangle in pixels. */
internal data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
    fun overlaps(o: Box) = left < o.right && o.left < right && top < o.bottom && o.top < bottom
}

/**
 * A rounded screen corner: the quarter circle's centre and radius, and the way from the centre
 * to the corner ([sx], [sy]: -1 left/top, 1 right/bottom). Past the arc the screen shows nothing.
 */
internal data class Corner(val x: Float, val y: Float, val radius: Float, val sx: Int, val sy: Int)

/**
 * The largest box of [shape] (width over height) inside a [w]x[h] slot whose every pixel the
 * screen shows: no corner of it past a rounded corner's arc, none of it over a camera hole. The
 * plain fit is tried centred, then pushed clear of each hole along each axis; whichever lets
 * the picture be largest wins, the centre on a tie. Without corners or holes it is the plain
 * centred fit.
 */
internal fun visibleFit(w: Float, h: Float, shape: Float, corners: List<Corner>, holes: List<Box>): Box {
    val (fullW, fullH) = if (w > h * shape) h * shape to h else w to w / shape

    fun shown(b: Box): Boolean = holes.none { it.overlaps(b) } && corners.all { c ->
        val dx = ((if (c.sx < 0) b.left else b.right) - c.x) * c.sx
        val dy = ((if (c.sy < 0) b.top else b.bottom) - c.y) * c.sy
        dx <= 0f || dy <= 0f || dx * dx + dy * dy <= c.radius * c.radius
    }

    // The area a picture may take: the slot, or the slot beside one side of a hole.
    val areas = buildList {
        add(Box(0f, 0f, w, h))
        for (hole in holes) {
            if (hole.right < w) add(Box(hole.right, 0f, w, h))
            if (hole.left > 0f) add(Box(0f, 0f, hole.left, h))
            if (hole.bottom < h) add(Box(0f, hole.bottom, w, h))
            if (hole.top > 0f) add(Box(0f, 0f, w, hole.top))
        }
    }

    var best: Box? = null
    for (area in areas) {
        val cx = (area.left + area.right) / 2
        val cy = (area.top + area.bottom) / 2
        val most = minOf(1f, area.width / fullW, area.height / fullH)
        fun at(scale: Float) = Box(cx - fullW * scale / 2, cy - fullH * scale / 2, cx + fullW * scale / 2, cy + fullH * scale / 2)
        if (most <= 0f || (best != null && most * fullW <= best.width)) continue
        // A smaller centred box only moves its corners inward, so the largest shown scale is
        // found by halving.
        val scale = if (shown(at(most))) most else {
            var lo = 0f
            var hi = most
            repeat(24) {
                val mid = (lo + hi) / 2
                if (shown(at(mid))) lo = mid else hi = mid
            }
            lo
        }
        val box = at(scale)
        if (scale > 0f && (best == null || box.width > best.width + 0.5f)) best = box
    }
    return best ?: Box((w - fullW) / 2, (h - fullH) / 2, (w + fullW) / 2, (h + fullH) / 2)
}
