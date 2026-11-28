package com.peartube.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.ExternalImageCache
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.ThumbHash
import com.peartube.app.extractImdbId
import com.peartube.app.imdbBackdropUrl
import com.peartube.app.imdbPosterUrl
import com.peartube.app.sleeveHash
import java.util.Locale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

internal fun normalizeHue(seed: Long): Int = ((seed % 360L).toInt() + 360) % 360

internal fun posterKindLabel(kind: LibraryKind): String = when (kind) {
    LibraryKind.Series -> "TV Show"
    LibraryKind.Movie -> "Movie"
    LibraryKind.Clip -> "Video"
    LibraryKind.Album -> "Album"
}

/**
 * Rich atmospheric hero surface matching LUMEN obsidian cinema:
 * real 16:9 IMDb backdrop when [backdropImdb] is present, else 120deg hue gradient + radial orb,
 * with obsidian readability scrim and crisp bottom-aligned content slot.
 */
@Composable
fun HeroPanel(
    hue: Int,
    modifier: Modifier = Modifier,
    small: Boolean = false,
    showOrb: Boolean = true,
    backdropImdb: String? = null,
    backgroundOverlay: (@Composable BoxScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val hInt = ((hue % 360) + 360) % 360
    val shape = if (small) PanelShape else HeroShape
    val startColor = Color.hsl(hInt.toFloat(), 0.60f, 0.30f)
    val endColor = Color.hsl(((hInt + 55) % 360).toFloat(), 0.66f, 0.09f)
    val orbCore = Color.hsl(((hInt + 165) % 360).toFloat(), 0.84f, 0.66f, alpha = 0.82f)
    val orbEdge = Color.hsl(((hInt + 120) % 360).toFloat(), 0.80f, 0.40f, alpha = 0.16f)

    val metaEpoch by ExternalDiscoveryApi.localMetaEpoch.collectAsState()
    val imdbTt = remember(backdropImdb) { extractImdbId(backdropImdb) }
    val backdropUrl = remember(backdropImdb, metaEpoch) { imdbBackdropUrl(backdropImdb) }
    val posterFallbackUrl = remember(backdropImdb, metaEpoch) { imdbPosterUrl(backdropImdb) }
    val backdropBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterFallbackUrl?.let { ExternalImageCache.get(it) }
            ?: ThumbHash.previewBitmapFor(
                backdropUrl,
                posterFallbackUrl,
                imdbTt?.let { "imdb:$it" },
                imdbTt,
            ),
        keys = arrayOf<Any?>(backdropImdb, backdropUrl, posterFallbackUrl, metaEpoch),
    ) {
        val (resolvedBackdrop, resolvedPoster) = if (!backdropImdb.isNullOrBlank()) {
            ExternalDiscoveryApi.resolveImdbArtUrls(backdropImdb)
        } else {
            null to null
        }
        val bUrl = resolvedBackdrop ?: backdropUrl
        val pUrl = resolvedPoster ?: posterFallbackUrl
        if (value == null) {
            ThumbHash.previewBitmapFor(bUrl, pUrl, imdbTt?.let { "imdb:$it" }, imdbTt)?.let { value = it }
        }
        val full = when {
            bUrl != null -> ExternalImageCache.load(bUrl) ?: pUrl?.let { ExternalImageCache.load(it) }
            pUrl != null -> ExternalImageCache.load(pUrl)
            else -> null
        }
        if (full != null) {
            value = full
        }
    }

    Box(
        modifier = modifier
            .heightIn(min = if (small) 196.dp else 248.dp)
            .clip(shape)
            .border(1.dp, Color.White.copy(alpha = 0.10f), shape),
    ) {
        val loadedBackdrop = backdropBitmap
        if (loadedBackdrop != null) {
            Image(
                bitmap = loadedBackdrop,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.matchParentSize(),
            )
            // Rich LUMEN obsidian bottom + left gradient scrim over real cinema backdrop
            Canvas(Modifier.matchParentSize()) {
                drawRect(
                    Brush.horizontalGradient(
                        0.0f to Bg.copy(alpha = 0.86f),
                        0.55f to Bg.copy(alpha = 0.42f),
                        1.0f to Bg.copy(alpha = 0.18f),
                    ),
                )
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Bg.copy(alpha = 0.14f),
                        0.45f to Bg.copy(alpha = 0.36f),
                        1.0f to Bg.copy(alpha = 0.90f),
                    ),
                )
            }
            backgroundOverlay?.invoke(this)
        } else {
            Canvas(Modifier.matchParentSize()) {
                val w = size.width
                val h = size.height
                val rad = 120.0 * PI / 180.0
                val vx = sin(rad).toFloat()
                val vy = (-cos(rad)).toFloat()
                val halfSpan = hypot(w, h) * 0.5f
                val cx = w * 0.5f
                val cy = h * 0.5f
                drawRect(
                    Brush.linearGradient(
                        colors = listOf(startColor, endColor),
                        start = Offset(cx - vx * halfSpan, cy - vy * halfSpan),
                        end = Offset(cx + vx * halfSpan, cy + vy * halfSpan),
                    ),
                )
                if (showOrb) {
                    val orbCenter = Offset(w * 0.82f, h * 0.14f)
                    val orbRadius = max(w, h) * 0.46f
                    drawCircle(
                        brush = Brush.radialGradient(
                            0.0f to orbCore,
                            0.68f to orbEdge,
                            1.0f to Color.Transparent,
                            center = Offset(orbCenter.x - orbRadius * 0.22f, orbCenter.y - orbRadius * 0.22f),
                            radius = orbRadius,
                        ),
                        radius = orbRadius,
                        center = orbCenter,
                    )
                }
            }

            backgroundOverlay?.invoke(this)

            Canvas(Modifier.matchParentSize()) {
                val w = size.width
                val h = size.height
                val diag = hypot(w, h)
                val step = 46.dp.toPx()
                val strokeW = 1.5.dp.toPx()
                rotate(degrees = 28f, pivot = Offset(w * 0.5f, h * 0.5f)) {
                    var x = -diag
                    while (x <= w + diag) {
                        drawLine(
                            color = Color.White.copy(alpha = 0.045f),
                            start = Offset(x, -diag),
                            end = Offset(x, h + diag),
                            strokeWidth = strokeW,
                        )
                        x += step
                    }
                }
                drawRect(
                    Brush.horizontalGradient(
                        0.0f to Color.Black.copy(alpha = 0.50f),
                        0.72f to Color.Transparent,
                    ),
                )
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Color.Transparent,
                        0.55f to Color.Transparent,
                        1.0f to Color.Black.copy(alpha = 0.26f),
                    ),
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomStart)
                .padding(if (small) 18.dp else 22.dp),
            verticalArrangement = Arrangement.spacedBy(if (small) 8.dp else 10.dp),
            content = content,
        )
    }
}

/**
 * Album cover sleeve with optional real cover art (from [artUrl] or cached iTunes lookup by [artist]/[albumName]),
 * falling back cleanly to the deterministic drawn vinyl/sweep sleeve and monogram.
 */
@Composable
fun AlbumSleeve(
    hue: Int,
    seed: Long,
    monogramText: String,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 12.dp,
    fontSize: TextUnit = 26.sp,
    artist: String? = null,
    albumName: String? = null,
    artUrl: String? = null,
    borderless: Boolean = false,
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

    val metaEpoch by ExternalDiscoveryApi.localMetaEpoch.collectAsState()
    val thumbKey = remember(artist, albumName) {
        if (!albumName.isNullOrBlank()) ExternalDiscoveryApi.albumArtThumbKey(artist.orEmpty(), albumName) else null
    }
    val initialUrl = remember(artUrl, artist, albumName, metaEpoch) {
        artUrl?.takeIf { it.isNotBlank() }
            ?: if (!albumName.isNullOrBlank()) ExternalDiscoveryApi.cachedAlbumArtUrl(artist.orEmpty(), albumName) else null
    }
    val coverBitmap by produceState<ImageBitmap?>(
        initialValue = initialUrl?.let { ExternalImageCache.get(it) }
            ?: ThumbHash.previewBitmapFor(artUrl, initialUrl, thumbKey),
        keys = arrayOf<Any?>(artUrl, artist, albumName, metaEpoch),
    ) {
        val url = artUrl?.takeIf { it.isNotBlank() }
            ?: if (!albumName.isNullOrBlank()) ExternalDiscoveryApi.resolveAlbumArtUrl(artist.orEmpty(), albumName) else null
        if (value == null) {
            ThumbHash.previewBitmapFor(url, artUrl, thumbKey)?.let { value = it }
        }
        if (!url.isNullOrBlank()) {
            ExternalImageCache.load(url)?.let { value = it }
        }
    }

    Box(
        modifier = modifier
            .aspectRatio(1f)
            .clip(shape)
            .then(if (borderless) Modifier else Modifier.border(0.75.dp, Color.White.copy(alpha = 0.08f), shape)),
        contentAlignment = Alignment.Center,
    ) {
        val loadedCover = coverBitmap
        if (loadedCover != null) {
            Image(
                bitmap = loadedCover,
                contentDescription = albumName ?: monogramText,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
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
        }
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
                artist = shown[2].artist,
                albumName = shown[2].album.ifBlank { shown[2].title },
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
                artist = shown[1].artist,
                albumName = shown[1].album.ifBlank { shown[1].title },
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
                artist = front.artist,
                albumName = front.album.ifBlank { front.title },
                cornerRadius = 12.dp,
                fontSize = 24.sp,
                modifier = Modifier
                    .fillMaxSize(if (shown.size > 1) 0.90f else 1f)
                    .align(Alignment.BottomStart),
            )
        }
    }
}

/**
 * 4-variant geometric poster art matching sketch.css (.poster.v0 through .poster.v3):
 * v0 off-center circle, v1 diagonal pinstripes, v2 rotated band, v3 stroked ring, chosen by hue % 4.
 */
@Composable
private fun GeometricPosterCanvas(
    hue: Int,
    modifier: Modifier = Modifier,
) {
    val hInt = ((hue % 360) + 360) % 360
    val variant = hInt % 4
    val top = Color.hsl(hInt.toFloat(), 0.58f, 0.36f)
    val bottom = Color.hsl(((hInt + 48) % 360).toFloat(), 0.64f, 0.11f)

    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val rad = 165.0 * PI / 180.0
        val vx = sin(rad).toFloat()
        val vy = (-cos(rad)).toFloat()
        val halfSpan = hypot(w, h) * 0.5f
        val cx = w * 0.5f
        val cy = h * 0.5f

        drawRect(
            Brush.linearGradient(
                colors = listOf(top, bottom),
                start = Offset(cx - vx * halfSpan, cy - vy * halfSpan),
                end = Offset(cx + vx * halfSpan, cy + vy * halfSpan),
            ),
        )

        when (variant) {
            0 -> {
                // v0: off-center circle (inset: -18% -42% 44% 22%)
                drawOval(
                    color = Color.hsl(((hInt + 170) % 360).toFloat(), 0.78f, 0.62f, alpha = 0.62f),
                    topLeft = Offset(w * 0.22f, -h * 0.18f),
                    size = Size(w * 1.20f, h * 0.74f),
                )
            }
            1 -> {
                // v1: diagonal pinstripes (118deg)
                val diag = hypot(w, h)
                val step = (w * 0.10f).coerceAtLeast(10.dp.toPx())
                val strokeW = (w * 0.014f).coerceAtLeast(1.2.dp.toPx())
                rotate(degrees = 28f, pivot = Offset(cx, cy)) {
                    var x = -diag
                    while (x <= w + diag) {
                        drawLine(
                            color = Color.White.copy(alpha = 0.10f),
                            start = Offset(x, -diag),
                            end = Offset(x, h + diag),
                            strokeWidth = strokeW,
                        )
                        x += step
                    }
                }
            }
            2 -> {
                // v2: rotated band (-16deg)
                rotate(degrees = -16f, pivot = Offset(w * 0.5f, h * 0.43f)) {
                    drawRect(
                        color = Color.hsl(((hInt + 140) % 360).toFloat(), 0.78f, 0.56f, alpha = 0.62f),
                        topLeft = Offset(-w * 0.30f, h * 0.26f),
                        size = Size(w * 1.60f, h * 0.34f),
                    )
                }
            }
            else -> {
                // v3: stroked ring (right: -22%; top: -12%; width: 92%)
                val ringRadius = w * 0.46f
                val ringStroke = (w * 0.09f).coerceAtLeast(5.dp.toPx())
                drawCircle(
                    color = Color.hsl(((hInt + 200) % 360).toFloat(), 0.82f, 0.72f, alpha = 0.50f),
                    radius = ringRadius,
                    center = Offset(w * 0.76f, -h * 0.12f + ringRadius),
                    style = Stroke(width = ringStroke),
                )
            }
        }

        // Bottom readability scrim so white uppercase titles always pop
        drawRect(
            Brush.verticalGradient(
                0.0f to Color.Transparent,
                0.42f to Color.Transparent,
                1.0f to Color.Black.copy(alpha = 0.46f),
            ),
        )
    }
}

/** Wide art for clips and unfinished videos (16:9 aspect), loading real IMDb backdrop when available. */
@Composable
fun WideTitleArt(
    title: String,
    modifier: Modifier = Modifier,
    seed: Long = sleeveHash(title),
    badge: String? = null,
    progress: Float = 0f,
    kindLabel: String? = null,
    imdb: String? = null,
    showTitleOverlay: Boolean = true,
    borderless: Boolean = false,
) {
    val hue = normalizeHue(seed)
    val eyebrow = (
        kindLabel ?: when (badge?.lowercase(Locale.ROOT)) {
            "clip", "video" -> "Video"
            "movie", "film" -> "Movie"
            "series", "tv show" -> "TV Show"
            else -> if (badge.isNullOrBlank()) "Video" else "TV Show"
        }
        ).uppercase(Locale.ROOT)
    val extraPill = badge?.takeIf {
        it.isNotBlank() &&
            !it.equals("Clip", ignoreCase = true) &&
            !it.equals("Video", ignoreCase = true) &&
            !it.equals("Movie", ignoreCase = true) &&
            !it.equals("Film", ignoreCase = true) &&
            !it.equals("Series", ignoreCase = true) &&
            !it.equals("TV Show", ignoreCase = true)
    }
    val metaEpoch by ExternalDiscoveryApi.localMetaEpoch.collectAsState()
    val isLong = title.length > 34
    val imdbTt = remember(imdb) { extractImdbId(imdb) }
    val backdropUrl = remember(imdb, metaEpoch) { imdbBackdropUrl(imdb) }
    val posterFallbackUrl = remember(imdb, metaEpoch) { imdbPosterUrl(imdb) }
    val loadedBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterFallbackUrl?.let { ExternalImageCache.get(it) }
            ?: ThumbHash.previewBitmapFor(
                backdropUrl,
                posterFallbackUrl,
                imdbTt?.let { "imdb:$it" },
                imdbTt,
            ),
        keys = arrayOf<Any?>(imdb, backdropUrl, posterFallbackUrl, metaEpoch),
    ) {
        val (resolvedBackdrop, resolvedPoster) = if (!imdb.isNullOrBlank()) {
            ExternalDiscoveryApi.resolveImdbArtUrls(imdb)
        } else {
            null to null
        }
        val bUrl = resolvedBackdrop ?: backdropUrl
        val pUrl = resolvedPoster ?: posterFallbackUrl
        if (value == null) {
            ThumbHash.previewBitmapFor(bUrl, pUrl, imdbTt?.let { "imdb:$it" }, imdbTt)?.let { value = it }
        }
        val full = when {
            bUrl != null -> ExternalImageCache.load(bUrl) ?: pUrl?.let { ExternalImageCache.load(it) }
            pUrl != null -> ExternalImageCache.load(pUrl)
            else -> null
        }
        if (full != null) {
            value = full
        }
    }

    BoxWithConstraints(
        modifier = modifier
            .aspectRatio(16f / 9f)
            .clip(CardShape)
            .then(if (borderless) Modifier else Modifier.border(0.75.dp, Color.White.copy(alpha = 0.08f), CardShape)),
    ) {
        val pad = (maxWidth * 0.055f).coerceIn(8.dp, 14.dp)
        val kindSp = (maxWidth.value * 0.042f).coerceIn(8.5f, 11f).sp
        val titleRatio = if (isLong) 0.068f else 0.092f
        val titleSp = (maxWidth.value * titleRatio).coerceIn(11f, 19f).sp
        val titleLineSp = (titleSp.value * 1.04f).sp

        val realArt = loadedBitmap
        if (realArt != null) {
            Image(
                bitmap = realArt,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.matchParentSize(),
            )
            // Subtle bottom dark scrim so progress bar (and optional overlay) stay legible over backdrops
            Canvas(Modifier.matchParentSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Color.Transparent,
                        0.55f to Color.Transparent,
                        1.0f to Color.Black.copy(alpha = if (showTitleOverlay) 0.72f else 0.48f),
                    ),
                )
            }
        } else {
            GeometricPosterCanvas(hue = hue, modifier = Modifier.matchParentSize())
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopStart)
                .padding(pad),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (realArt == null) {
                Text(
                    text = eyebrow,
                    color = Color.White.copy(alpha = 0.86f),
                    fontSize = kindSp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = 1.4.sp,
                    maxLines = 1,
                )
            } else {
                Box(Modifier)
            }
            if (extraPill != null) {
                Text(
                    text = extraPill,
                    color = Color.White,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(Color.Black.copy(alpha = 0.62f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }

        if (realArt == null || showTitleOverlay) {
            Text(
                text = if (realArt != null) title else title.uppercase(Locale.ROOT),
                color = Color.White,
                fontSize = if (realArt != null) (maxWidth.value * 0.065f).coerceIn(11f, 15f).sp else titleSp,
                lineHeight = if (realArt != null) (maxWidth.value * 0.075f).coerceIn(13f, 18f).sp else titleLineSp,
                fontWeight = if (realArt != null) FontWeight.SemiBold else FontWeight.ExtraBold,
                letterSpacing = if (realArt != null) 0.sp else (-0.4).sp,
                maxLines = if (realArt != null) 1 else if (isLong) 3 else 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth(0.88f)
                    .padding(
                        start = pad,
                        end = pad,
                        bottom = if (progress > 0f) pad + 8.dp else pad,
                    ),
            )
        }

        if (progress > 0f) {
            Canvas(
                Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .padding(horizontal = pad, vertical = 7.dp)
                    .height(3.dp),
            ) {
                val r = CornerRadius(size.height / 2f, size.height / 2f)
                drawRoundRect(
                    color = Color.White.copy(alpha = 0.28f),
                    size = size,
                    cornerRadius = r,
                )
                drawRoundRect(
                    color = Pearl,
                    size = Size(size.width * progress.coerceIn(0.03f, 1f), size.height),
                    cornerRadius = r,
                )
            }
        }
    }
}

/** 2:3 movie/series poster loading real IMDb/Cinemeta poster art with a calm obsidian fallback. */
@Composable
fun PosterArt(
    title: String,
    year: String?,
    modifier: Modifier = Modifier,
    seed: Long = sleeveHash(title),
    kindLabel: String = "Movie",
    imdb: String? = null,
    posterUrlOverride: String? = null,
    cornerRadius: Dp = 12.dp,
    borderless: Boolean = false,
) {
    val hue = normalizeHue(seed)
    val shape = RoundedCornerShape(cornerRadius)
    val isSeries = kindLabel.equals("Series", ignoreCase = true) || kindLabel.equals("TV Show", ignoreCase = true)
    val isClip = kindLabel.equals("Clip", ignoreCase = true) || kindLabel.equals("Video", ignoreCase = true)

    val metaEpoch by ExternalDiscoveryApi.localMetaEpoch.collectAsState()
    val imdbTt = remember(imdb) { extractImdbId(imdb) }
    val initialUrl = remember(posterUrlOverride, imdb, title, isSeries, isClip, metaEpoch) {
        posterUrlOverride?.takeIf { it.isNotBlank() }
            ?: imdbPosterUrl(imdb)
            ?: if (!isClip) {
                ExternalDiscoveryApi.cachedTitleImdb(title, isSeries = isSeries)?.let { imdbPosterUrl(it) }
            } else {
                null
            }
    }
    val loadedBitmap by produceState<ImageBitmap?>(
        initialValue = initialUrl?.let { ExternalImageCache.get(it) }
            ?: ThumbHash.previewBitmapFor(
                posterUrlOverride,
                initialUrl,
                imdbTt?.let { "imdb:$it" },
                imdbTt,
            ),
        keys = arrayOf<Any?>(posterUrlOverride, imdb, "$title|$isSeries|$isClip", metaEpoch),
    ) {
        val directUrl = posterUrlOverride?.takeIf { it.isNotBlank() }
            ?: if (!imdb.isNullOrBlank()) ExternalDiscoveryApi.resolveImdbPosterUrl(imdb) else null
        val resolvedTt = imdbTt ?: if (directUrl == null && !isClip) {
            ExternalDiscoveryApi.resolveTitleImdb(title, isSeries = isSeries)
        } else {
            null
        }
        val resolvedUrl = directUrl ?: resolvedTt?.let { ExternalDiscoveryApi.resolveImdbPosterUrl(it) }
        if (value == null) {
            ThumbHash.previewBitmapFor(
                resolvedUrl,
                posterUrlOverride,
                resolvedTt?.let { "imdb:$it" },
                resolvedTt,
            )?.let { value = it }
        }
        if (!resolvedUrl.isNullOrBlank()) {
            ExternalImageCache.load(resolvedUrl)?.let { value = it }
        }
    }

    Box(
        modifier = modifier
            .aspectRatio(2f / 3f)
            .clip(shape),
        contentAlignment = Alignment.Center,
    ) {
        val realPoster = loadedBitmap
        if (realPoster != null) {
            Image(
                bitmap = realPoster,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            // Razor-thin edge so dark movie posters remain cleanly framed against obsidian Bg
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .border(
                        width = if (borderless) 0.5.dp else 0.75.dp,
                        color = GlassBorder.copy(alpha = 0.55f),
                        shape = shape,
                    ),
            )
            return@Box
        }

        // Calm, refined LUMEN obsidian cinema placeholder (no screaming neon or duplicated ALL-CAPS title)
        val tintWash = Color.hsl(hue.toFloat(), 0.44f, 0.36f, alpha = 0.14f)
        Canvas(Modifier.fillMaxSize()) {
            drawRect(
                Brush.verticalGradient(
                    0.0f to CardElevated,
                    1.0f to CardBg,
                ),
            )
            drawRect(
                Brush.radialGradient(
                    0.0f to tintWash,
                    1.0f to Color.Transparent,
                    center = Offset(size.width * 0.25f, size.height * 0.20f),
                    radius = max(size.width, size.height) * 0.85f,
                ),
            )
        }
        Box(
            modifier = Modifier
                .fillMaxSize()
                .border(0.75.dp, GlassBorder, shape),
        )
        Icon(
            imageVector = if (isSeries) TvIcon else WatchIcon,
            contentDescription = title,
            tint = Pearl.copy(alpha = 0.30f),
            modifier = Modifier.size(26.dp),
        )
    }
}
