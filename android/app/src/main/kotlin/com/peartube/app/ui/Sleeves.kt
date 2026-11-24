package com.peartube.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.LibraryTile
import com.peartube.app.monogram
import com.peartube.app.sleeveHash
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Deterministic drawn album sleeve matching src/ui.js (albumArt):
 * three cuts (sweep, vinyl record grooves, split), deterministic hue pair, and album monogram.
 */
@Composable
fun AlbumSleeve(
    hue: Int,
    seed: Long,
    monogramText: String,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
    fontSize: TextUnit = 26.sp,
    overlay: (@Composable BoxScope.() -> Unit)? = null,
) {
    val h1 = ((hue % 360) + 360) % 360
    val h2 = (h1 + 30 + ((seed ushr 9) % 120L).toInt()) % 360
    val lightness = (42 + ((seed ushr 3) % 16L).toInt()) / 100f
    val angleDeg = 120 + ((seed ushr 17) % 120L).toInt()
    val cut = ((seed ushr 25) % 3L).toInt()

    val base = Color.hsl(h1.toFloat(), 0.62f, lightness)
    val deep = Color.hsl(h2.toFloat(), 0.64f, 0.20f)
    val shape = RoundedCornerShape(cornerRadius)

    Box(
        modifier = modifier
            .aspectRatio(1f)
            .clip(shape)
            .border(1.dp, Color.White.copy(alpha = 0.08f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val rad = (angleDeg - 90.0) * PI / 180.0
            val dx = (cos(rad) * w * 0.5f).toFloat()
            val dy = (sin(rad) * h * 0.5f).toFloat()
            val start = Offset(w * 0.5f - dx, h * 0.5f - dy)
            val end = Offset(w * 0.5f + dx, h * 0.5f + dy)

            when (cut) {
                0 -> {
                    drawRect(Brush.linearGradient(listOf(base, deep), start, end))
                    drawRect(
                        Brush.radialGradient(
                            colors = listOf(Color.White.copy(alpha = 0.22f), Color.Transparent),
                            center = Offset(w * 0.78f, h * 0.18f),
                            radius = min(w, h) * 0.65f,
                        ),
                    )
                }
                1 -> {
                    val center = Offset(w * 0.5f, h * 0.5f)
                    val radius = min(w, h) * 0.5f
                    drawRect(
                        Brush.radialGradient(
                            0.0f to base,
                            0.31f to base,
                            0.32f to deep,
                            1.0f to deep,
                            center = center,
                            radius = radius * 1.42f,
                        ),
                    )
                    var r = radius * 0.42f
                    val step = (radius * 0.09f).coerceAtLeast(3f)
                    while (r < radius * 1.4f) {
                        drawCircle(
                            color = Color.Black.copy(alpha = 0.16f),
                            radius = r,
                            center = center,
                            style = Stroke(width = 1.dp.toPx()),
                        )
                        r += step
                    }
                }
                else -> {
                    drawRect(
                        Brush.linearGradient(
                            0.0f to base,
                            0.535f to base,
                            0.545f to deep,
                            1.0f to deep,
                            start = start,
                            end = end,
                        ),
                    )
                    drawRect(
                        Brush.radialGradient(
                            colors = listOf(Color.White.copy(alpha = 0.22f), Color.Transparent),
                            center = Offset(w * 0.78f, h * 0.18f),
                            radius = min(w, h) * 0.65f,
                        ),
                    )
                }
            }
        }
        Text(
            text = monogramText,
            color = Color.White.copy(alpha = 0.92f),
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.5).sp,
            maxLines = 1,
        )
        overlay?.invoke(this)
    }
}

/**
 * Rule 6: No artist photos. An artist's picture is a stack of that artist's sleeves.
 */
@Composable
fun ArtistSleeveStack(
    albums: List<LibraryTile>,
    modifier: Modifier = Modifier,
) {
    val shown = albums.take(3)
    Box(
        modifier = modifier.aspectRatio(1f),
        contentAlignment = Alignment.BottomStart,
    ) {
        if (shown.size >= 3) {
            AlbumSleeve(
                hue = shown[2].hue,
                seed = shown[2].seed,
                monogramText = shown[2].monogramText,
                cornerRadius = 10.dp,
                fontSize = 16.sp,
                modifier = Modifier
                    .fillMaxSize(0.84f)
                    .align(Alignment.TopEnd),
            )
        }
        if (shown.size >= 2) {
            AlbumSleeve(
                hue = shown[1].hue,
                seed = shown[1].seed,
                monogramText = shown[1].monogramText,
                cornerRadius = 10.dp,
                fontSize = 18.sp,
                modifier = Modifier
                    .fillMaxSize(0.88f)
                    .align(Alignment.Center)
                    .offset(x = 2.dp, y = (-2).dp),
            )
        }
        val front = shown.firstOrNull()
        if (front != null) {
            AlbumSleeve(
                hue = front.hue,
                seed = front.seed,
                monogramText = front.monogramText,
                cornerRadius = 12.dp,
                fontSize = 24.sp,
                modifier = Modifier
                    .fillMaxSize(if (shown.size > 1) 0.90f else 1f)
                    .align(Alignment.BottomStart),
            )
        }
    }
}

/** Wide art for clips and unfinished videos (16:9 aspect). */
@Composable
fun WideTitleArt(
    title: String,
    modifier: Modifier = Modifier,
    seed: Long = sleeveHash(title),
    badge: String? = null,
    progress: Float = 0f,
) {
    val h1 = (seed % 360L).toFloat()
    val deep = Color.hsl(h1, 0.28f, 0.14f)
    val mid = Color.hsl((h1 + 28f) % 360f, 0.34f, 0.22f)
    val letter = monogram(title).take(1)
    Box(
        modifier = modifier
            .aspectRatio(16f / 9f)
            .clip(CardShape)
            .background(Brush.linearGradient(listOf(mid, deep)))
            .border(1.dp, Line, CardShape),
    ) {
        Text(
            text = letter,
            color = Ink.copy(alpha = 0.28f),
            fontSize = 40.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.align(Alignment.Center),
        )
        if (!badge.isNullOrBlank()) {
            Text(
                text = badge,
                color = Ink,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(8.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(Bg.copy(alpha = 0.78f))
                    .padding(horizontal = 7.dp, vertical = 3.dp),
            )
        }
        if (progress > 0f) {
            Canvas(
                Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxSize(),
            ) {
                val barH = 3.dp.toPx()
                val y = size.height - barH / 2f
                drawLine(Color.Black.copy(alpha = 0.55f), Offset(0f, y), Offset(size.width, y), barH)
                drawLine(Brand, Offset(0f, y), Offset(size.width * progress.coerceIn(0f, 1f), y), barH)
            }
        }
    }
}

/** Quiet poster-proportioned card header for movies & series (no external image host needed). */
@Composable
fun PosterArt(
    title: String,
    year: String?,
    modifier: Modifier = Modifier,
    seed: Long = sleeveHash(title),
) {
    val h1 = (seed % 360L).toFloat()
    val top = Color.hsl(h1, 0.30f, 0.20f)
    val bottom = Color.hsl((h1 + 25f) % 360f, 0.25f, 0.10f)
    Box(
        modifier = modifier
            .aspectRatio(2f / 3f)
            .clip(CardShape)
            .background(Brush.verticalGradient(listOf(top, bottom)))
            .border(1.dp, Line, CardShape)
            .padding(10.dp),
    ) {
        Text(
            text = monogram(title),
            color = Ink.copy(alpha = 0.16f),
            fontSize = 36.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.align(Alignment.Center),
        )
        if (!year.isNullOrBlank()) {
            Text(
                text = year,
                color = Dim,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.align(Alignment.TopStart),
            )
        }
        Text(
            text = title,
            color = Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.BottomStart),
        )
    }
}
