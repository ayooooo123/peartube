package com.peartube.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Entry
import com.peartube.app.RepeatMode
import com.peartube.app.StreamSaveState
import com.peartube.app.TrackItem
import com.peartube.app.fold
import com.peartube.app.isSc
import com.peartube.app.isYt
import com.peartube.app.plural
import com.peartube.app.resolveStreamSaveState
import com.peartube.shared.clock
import com.peartube.shared.formatBytes
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToLong

private enum class MusicSheetTab {
    NowPlaying,
    UpNext,
}

internal enum class ArtworkSwipeOutcome {
    None,
    DismissDown,
    NextTrack,
    PreviousTrack,
}

internal fun shouldDismissSwipeDown(
    offsetPx: Float,
    velocityYPxPerSec: Float,
    distanceThresholdPx: Float,
    flingVelocityPxPerSec: Float,
    minFlingDistancePx: Float,
): Boolean {
    if (offsetPx >= distanceThresholdPx) return true
    return offsetPx >= minFlingDistancePx && velocityYPxPerSec >= flingVelocityPxPerSec
}

internal fun resolveArtworkSwipe(
    totalX: Float,
    totalY: Float,
    velocityYPxPerSec: Float,
    horizThresholdPx: Float,
    dismissDistancePx: Float,
    flingVelocityPxPerSec: Float,
    minFlingDistancePx: Float,
): ArtworkSwipeOutcome {
    if (totalY > 0f && totalY >= abs(totalX) &&
        shouldDismissSwipeDown(totalY, velocityYPxPerSec, dismissDistancePx, flingVelocityPxPerSec, minFlingDistancePx)
    ) {
        return ArtworkSwipeOutcome.DismissDown
    }
    if (abs(totalX) > abs(totalY)) {
        if (totalX <= -horizThresholdPx) return ArtworkSwipeOutcome.NextTrack
        if (totalX >= horizThresholdPx) return ArtworkSwipeOutcome.PreviousTrack
    }
    return ArtworkSwipeOutcome.None
}

internal data class TrackAudioDetails(
    val formatLabel: String,
    val isLossless: Boolean,
    val sourceLabel: String,
    val outputLabel: String?,
    val sizeLabel: String?,
    val durationLabel: String?,
    val canFindLossless: Boolean,
)

internal fun describeTrackAudio(
    entry: Entry,
    codec: String? = null,
    audioOutput: String? = null,
    durationMs: Long? = null,
    isExternalStream: Boolean = false,
): TrackAudioDetails {
    val normCodec = codec?.trim()?.lowercase(Locale.ROOT).orEmpty()
    val urlLower = entry.streamUrl.substringBefore('?').lowercase(Locale.ROOT)
    val bitrateKbps = if (entry.size > 0L && durationMs != null && durationMs >= 5_000L) {
        ((entry.size * 8.0) / (durationMs / 1000.0) / 1000.0).roundToLong().takeIf { it in 16L..12_000L }
    } else {
        null
    }
    val bitrateSuffix = bitrateKbps?.let { " · $it kbps" }.orEmpty()

    val (formatLabel, isLossless) = when {
        normCodec.startsWith("flac") || urlLower.endsWith(".flac") -> ("FLAC · Lossless$bitrateSuffix") to true
        normCodec.startsWith("alac") || urlLower.endsWith(".alac") -> ("ALAC · Lossless$bitrateSuffix") to true
        normCodec.startsWith("pcm") || normCodec == "wav" || urlLower.endsWith(".wav") || urlLower.endsWith(".aiff") ->
            ("PCM · Lossless$bitrateSuffix") to true
        normCodec == "ape" || normCodec == "wavpack" || normCodec == "wv" || normCodec == "tta" ||
            normCodec == "truehd" || normCodec == "mlp" || normCodec.startsWith("dsd") ->
            ("${normCodec.uppercase(Locale.ROOT)} · Lossless$bitrateSuffix") to true
        normCodec.startsWith("aac") || normCodec.startsWith("mp4a") -> ("AAC$bitrateSuffix") to false
        normCodec.startsWith("opus") -> ("Opus$bitrateSuffix") to false
        normCodec.startsWith("mp3") || normCodec == "mpeg" -> ("MP3$bitrateSuffix") to false
        normCodec.startsWith("vorbis") -> ("Ogg Vorbis$bitrateSuffix") to false
        normCodec.isNotEmpty() -> ("${normCodec.uppercase(Locale.ROOT)}$bitrateSuffix") to false
        isExternalStream -> "AAC · ~128 kbps" to false
        isYt(entry) -> (if (bitrateKbps != null) "AAC · $bitrateKbps kbps" else "AAC · ~128 kbps") to false
        isSc(entry) -> (if (bitrateKbps != null) "Audio · $bitrateKbps kbps" else "Lossy audio") to false
        urlLower.endsWith(".opus") -> ("Opus$bitrateSuffix") to false
        urlLower.endsWith(".m4a") || urlLower.endsWith(".aac") -> ("AAC$bitrateSuffix") to false
        urlLower.endsWith(".mp3") -> ("MP3$bitrateSuffix") to false
        urlLower.endsWith(".ogg") -> ("Ogg Vorbis$bitrateSuffix") to false
        bitrateKbps != null -> "Audio · $bitrateKbps kbps" to false
        else -> "Audio file" to false
    }

    val sourceLabel = when {
        isExternalStream -> "Streaming (YouTube)"
        isYt(entry) -> if (entry.local) "Saved from YouTube" else "YouTube copy (Swarm)"
        isSc(entry) -> if (entry.local) "Saved from SoundCloud" else "SoundCloud copy (Swarm)"
        entry.local -> "Saved on device"
        entry.cachedBytes > 0L && entry.size > 0L && entry.cachedBytes >= entry.size -> "Cached on device"
        else -> "Streaming over swarm"
    }

    val cleanOutput = audioOutput?.trim()?.takeIf { it.isNotEmpty() }?.let { raw ->
        if (!isLossless && raw.startsWith("Lossless", ignoreCase = true)) {
            raw.replaceFirst(Regex("^Lossless", RegexOption.IGNORE_CASE), "PCM")
        } else {
            raw
        }
    }

    val canFindLossless = !isLossless && (isExternalStream || isYt(entry) || isSc(entry) || normCodec.isNotEmpty())
    return TrackAudioDetails(
        formatLabel = formatLabel,
        isLossless = isLossless,
        sourceLabel = sourceLabel,
        outputLabel = cleanOutput,
        sizeLabel = entry.size.takeIf { it > 0L }?.let { formatBytes(it) },
        durationLabel = durationMs?.takeIf { it > 0L }?.let { clock(it) },
        canFindLossless = canFindLossless,
    )
}

/**
 * Floating 58dp obsidian-glass mini-player dock sitting above BottomRoomsBar with a 2dp hairline
 * progress bar along the bottom edge and Play/Pause, Next, and Close/Stop controls.
 */
@Composable
fun MiniPlayerDock(
    model: AppModel,
    onOpenFull: () -> Unit,
) {
    val state by model.musicState.collectAsState()
    val catalog by model.catalog.collectAsState()
    val acquireJobs by model.acquireJobs.collectAsState()
    val saveJobMap by model.streamingSaveJobs.collectAsState()
    val submittingKeys by model.streamingSubmittingKeys.collectAsState()
    val savedKeys by model.streamingSavedKeys.collectAsState()
    val track = state.currentTrack ?: return
    val saveState = remember(track.key, track.externalVideoId, catalog.allTracks, acquireJobs, saveJobMap, submittingKeys, savedKeys) {
        resolveStreamSaveState(track, catalog, acquireJobs, saveJobMap, submittingKeys, savedKeys)
    }
    val progress = state.durationMs?.takeIf { it > 0L }
        ?.let { (state.positionMs.toFloat() / it).coerceIn(0f, 1f) }
        ?: 0f
    val pillShape = RoundedCornerShape(16.dp)
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val latestOnOpenFull by rememberUpdatedState(onOpenFull)
    val horizThresholdPx = remember(density) { with(density) { 72.dp.toPx() } }
    val upThresholdPx = remember(density) { with(density) { 48.dp.toPx() } }
    val maxDragPx = remember(density) { with(density) { 140.dp.toPx() } }
    val dragX = remember { Animatable(0f) }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, bottom = 8.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = dragX.value * 0.45f }
                .shadow(16.dp, pillShape)
                .clip(pillShape)
                .background(FloatingDockBg)
                .border(1.dp, FloatingDockBorder, pillShape)
                .pointerInput(horizThresholdPx, upThresholdPx) {
                    var totalX = 0f
                    var totalY = 0f
                    detectDragGestures(
                        onDragStart = {
                            totalX = 0f
                            totalY = 0f
                            scope.launch { dragX.stop() }
                        },
                        onDragEnd = {
                            when {
                                abs(totalY) > abs(totalX) && totalY < -upThresholdPx -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    latestOnOpenFull()
                                }
                                totalX < -horizThresholdPx -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    model.music.next()
                                }
                                totalX > horizThresholdPx -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    model.music.previous()
                                }
                            }
                            scope.launch {
                                dragX.animateTo(
                                    targetValue = 0f,
                                    animationSpec = spring(
                                        dampingRatio = Spring.DampingRatioMediumBouncy,
                                        stiffness = Spring.StiffnessMediumLow,
                                    ),
                                )
                            }
                        },
                        onDragCancel = {
                            scope.launch {
                                dragX.animateTo(
                                    targetValue = 0f,
                                    animationSpec = spring(
                                        dampingRatio = Spring.DampingRatioMediumBouncy,
                                        stiffness = Spring.StiffnessMediumLow,
                                    ),
                                )
                            }
                        },
                    ) { change, dragAmount ->
                        totalX += dragAmount.x
                        totalY += dragAmount.y
                        if (abs(totalX) >= abs(totalY)) {
                            change.consume()
                            val clamped = totalX.coerceIn(-maxDragPx, maxDragPx)
                            scope.launch { dragX.snapTo(clamped) }
                        } else if (totalY < 0f) {
                            change.consume()
                        }
                    }
                }
                .clickable(onClick = onOpenFull),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(start = 8.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AlbumSleeve(
                    hue = track.hue,
                    seed = track.seed,
                    monogramText = track.monogramText,
                    artist = track.artist,
                    albumName = track.album.ifBlank { track.title },
                    artUrl = track.artUrl.takeIf { it.isNotBlank() },
                    cornerRadius = 10.dp,
                    fontSize = 13.sp,
                    modifier = Modifier.size(42.dp),
                )
                Spacer(Modifier.width(10.dp))
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(1.dp),
                ) {
                    Text(
                        text = track.title,
                        color = Ink,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val secondLine = when {
                        state.pausedForVideo -> "Paused for a video"
                        track.isExternalStream && saveState == StreamSaveState.Saved -> {
                            if (track.artist.isNotBlank()) "✓ Saved in library · ${track.artist}" else "✓ Saved in library"
                        }
                        track.isExternalStream && saveState == StreamSaveState.Saving -> {
                            if (track.artist.isNotBlank()) "Saving to library… · ${track.artist}" else "Saving to library…"
                        }
                        track.isExternalStream -> {
                            val src = track.externalStreamSource.orEmpty().ifBlank { "Streaming" }
                            if (track.artist.isNotBlank()) "● $src · ${track.artist}" else "● $src"
                        }
                        else -> listOfNotNull(
                            track.artist.takeIf { it.isNotBlank() },
                            track.album.takeIf { it.isNotBlank() },
                        ).joinToString(" · ")
                    }
                    if (secondLine.isNotEmpty()) {
                        Text(
                            text = secondLine,
                            color = when {
                                state.pausedForVideo -> Warn
                                track.isExternalStream && saveState == StreamSaveState.Saved -> Accent
                                track.isExternalStream -> BrandHover
                                else -> Dim
                            },
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (state.buffering && state.playing) {
                    Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(18.dp), color = Pearl, strokeWidth = 2.dp)
                    }
                } else {
                    CinemaIcon(
                        icon = if (state.playing) PauseIcon else PlayIcon,
                        description = if (state.playing) "Pause" else "Play",
                        tint = Pearl,
                        onClick = { model.music.togglePlayPause() },
                    )
                }
                if (track.isExternalStream && state.order.size <= 1) {
                    when (saveState) {
                        StreamSaveState.Saving -> {
                            Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(Modifier.size(16.dp), color = BrandHover, strokeWidth = 2.dp)
                            }
                        }
                        StreamSaveState.Saved -> {
                            Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                                Icon(
                                    imageVector = CheckIcon,
                                    contentDescription = "Saved in library",
                                    tint = Accent,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                        StreamSaveState.Unsaved -> {
                            CinemaIcon(
                                icon = AddIcon,
                                description = "Save to library",
                                tint = Pearl,
                                onClick = {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    model.saveStreamingTrackToLibrary(track)
                                },
                            )
                        }
                    }
                } else {
                    CinemaIcon(
                        icon = SkipNextIcon,
                        description = "Next",
                        tint = Ink,
                        onClick = { model.music.next() },
                    )
                }
                CinemaIcon(
                    icon = CloseIcon,
                    description = "Stop music",
                    tint = Dim,
                    onClick = { model.music.stopMusic() },
                )
            }
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.dp),
                color = Brand,
                trackColor = GlassHighlight,
            )
        }
    }
}

private val SheetTopRoundedShape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)

/**
 * Flagship Apple Music / VisionOS-grade obsidian glass music player sheet with 120fps
 * coordinate-stable swipe-down dismiss over the live browsing UI, segmented Now Playing | Up Next
 * switcher, editorial typography, audio quality badge, and pearl controls.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun MusicPlayerFullScreen(
    model: AppModel,
    onClose: () -> Unit,
    onOpenArtist: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
    onOpenFractionChanged: (Float) -> Unit = {},
) {
    val state by model.musicState.collectAsState()
    val catalog by model.catalog.collectAsState()
    val acquireJobs by model.acquireJobs.collectAsState()
    val saveJobMap by model.streamingSaveJobs.collectAsState()
    val submittingKeys by model.streamingSubmittingKeys.collectAsState()
    val savedKeys by model.streamingSavedKeys.collectAsState()
    val track = state.currentTrack
    var scrub by remember { mutableStateOf<Float?>(null) }
    var activeTab by remember { mutableStateOf(MusicSheetTab.NowPlaying) }
    var showTrackInfo by remember { mutableStateOf(false) }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val fullHeightPx = constraints.maxHeight.toFloat().coerceAtLeast(1f)
        val sheetOffsetPx = remember { mutableFloatStateOf(fullHeightPx) }
        val artworkDragPx = remember { mutableFloatStateOf(0f) }
        var sheetAnimJob by remember { mutableStateOf<Job?>(null) }
        var artworkAnimJob by remember { mutableStateOf<Job?>(null) }
        var dismissing by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val density = LocalDensity.current
        val haptics = LocalHapticFeedback.current
        val latestOnClose by rememberUpdatedState(onClose)
        val latestOnOpenFractionChanged by rememberUpdatedState(onOpenFractionChanged)
        val latestScrub by rememberUpdatedState(scrub)
        val dismissThresholdPx = remember(density, fullHeightPx) {
            minOf(with(density) { 112.dp.toPx() }, fullHeightPx * 0.24f)
        }
        val minFlingDistancePx = remember(density) { with(density) { 28.dp.toPx() } }
        val flingVelocityPx = remember(density) { with(density) { 700.dp.toPx() } }
        val artworkSwipeThresholdPx = remember(density) { with(density) { 64.dp.toPx() } }
        val artworkMaxDragPx = remember(density) { with(density) { 120.dp.toPx() } }

        fun setSheetOffset(px: Float) {
            val clamped = px.coerceIn(0f, fullHeightPx)
            sheetOffsetPx.floatValue = clamped
            latestOnOpenFractionChanged(1f - (clamped / fullHeightPx).coerceIn(0f, 1f))
        }

        fun animateOpen() {
            sheetAnimJob?.cancel()
            sheetAnimJob = scope.launch {
                animate(
                    initialValue = sheetOffsetPx.floatValue,
                    targetValue = 0f,
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioNoBouncy,
                        stiffness = 420f,
                    ),
                ) { value, _ ->
                    setSheetOffset(value)
                }
            }
        }

        fun animateDismiss(velocityY: Float = 0f, afterDismiss: (() -> Unit)? = null) {
            if (dismissing) return
            dismissing = true
            sheetAnimJob?.cancel()
            sheetAnimJob = scope.launch {
                val start = sheetOffsetPx.floatValue
                animate(
                    initialValue = start,
                    targetValue = fullHeightPx,
                    initialVelocity = velocityY.coerceAtLeast(0f),
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioNoBouncy,
                        stiffness = 520f,
                    ),
                ) { value, _ ->
                    setSheetOffset(value)
                }
                latestOnOpenFractionChanged(0f)
                afterDismiss?.invoke()
                latestOnClose()
            }
        }

        fun animateSnapBack(velocityY: Float = 0f) {
            if (dismissing) return
            sheetAnimJob?.cancel()
            sheetAnimJob = scope.launch {
                animate(
                    initialValue = sheetOffsetPx.floatValue,
                    targetValue = 0f,
                    initialVelocity = velocityY.coerceAtMost(0f),
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioNoBouncy,
                        stiffness = 500f,
                    ),
                ) { value, _ ->
                    setSheetOffset(value)
                }
            }
        }

        fun finishSheetDrag(velocityY: Float) {
            if (dismissing) return
            val cur = sheetOffsetPx.floatValue
            if (shouldDismissSwipeDown(cur, velocityY, dismissThresholdPx, flingVelocityPx, minFlingDistancePx)) {
                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                animateDismiss(velocityY)
            } else if (cur > 0f) {
                animateSnapBack(velocityY)
            }
        }

        LaunchedEffect(Unit) {
            animateOpen()
        }

        DisposableEffect(Unit) {
            onDispose {
                latestOnOpenFractionChanged(0f)
            }
        }

        BackHandler(enabled = !dismissing) {
            animateDismiss()
        }

        val nestedScrollConnection = remember(dismissThresholdPx, flingVelocityPx, minFlingDistancePx, fullHeightPx) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (source != NestedScrollSource.UserInput || dismissing) return Offset.Zero
                    val cur = sheetOffsetPx.floatValue
                    if (cur > 0f && available.y < 0f) {
                        sheetAnimJob?.cancel()
                        val next = (cur + available.y).coerceAtLeast(0f)
                        setSheetOffset(next)
                        return Offset(0f, next - cur)
                    }
                    return Offset.Zero
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (source != NestedScrollSource.UserInput || dismissing) return Offset.Zero
                    if (available.y > 0f) {
                        sheetAnimJob?.cancel()
                        val cur = sheetOffsetPx.floatValue
                        val next = (cur + available.y).coerceIn(0f, fullHeightPx)
                        setSheetOffset(next)
                        return Offset(0f, next - cur)
                    }
                    return Offset.Zero
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (sheetOffsetPx.floatValue > 0f) {
                        finishSheetDrag(available.y)
                        return available
                    }
                    return Velocity.Zero
                }
            }
        }

        // Smooth backdrop scrim behind the sliding sheet (draw-phase only, zero recomposition)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .drawBehind {
                    val open = 1f - (sheetOffsetPx.floatValue / fullHeightPx).coerceIn(0f, 1f)
                    if (open > 0.001f) {
                        drawRect(Bg.copy(alpha = 0.74f * open))
                    }
                },
        )

        // Non-translated gesture host: keeps pointer coordinates 100% stable in screen space so the
        // sheet tracks the thumb 1:1 at 120Hz with zero translation feedback oscillation.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .nestedScroll(nestedScrollConnection)
                .pointerInput(dismissThresholdPx, flingVelocityPx, fullHeightPx) {
                    val velocityTracker = VelocityTracker()
                    detectVerticalDragGestures(
                        onDragStart = {
                            if (dismissing) return@detectVerticalDragGestures
                            sheetAnimJob?.cancel()
                            sheetAnimJob = null
                            velocityTracker.resetTracking()
                        },
                        onDragEnd = { finishSheetDrag(velocityTracker.calculateVelocity().y) },
                        onDragCancel = { finishSheetDrag(0f) },
                        onVerticalDrag = { change, dragAmount ->
                            if (latestScrub != null || dismissing) return@detectVerticalDragGestures
                            velocityTracker.addPosition(change.uptimeMillis, change.position)
                            val cur = sheetOffsetPx.floatValue
                            val next = (cur + dragAmount).coerceIn(0f, fullHeightPx)
                            if (next > 0f || dragAmount > 0f) {
                                change.consume()
                                setSheetOffset(next)
                            }
                        },
                    )
                },
        ) {
            if (track == null) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            val y = sheetOffsetPx.floatValue.coerceIn(0f, fullHeightPx)
                            translationY = y
                            shape = SheetTopRoundedShape
                            clip = y > 0.5f
                        }
                        .background(Bg)
                        .statusBarsPadding()
                        .navigationBarsPadding(),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CinemaIcon(MinimizeIcon, "Close player", Ink, onClick = { animateDismiss() })
                        Text("Now Playing", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Nothing in the music queue.", color = Dim, fontSize = 14.sp)
                    }
                }
                return@Box
            }

            val durationMs = state.durationMs ?: 0L
            val shownPos = scrub?.toLong() ?: state.positionMs
            val ordered = state.orderedTracks
            val saveState = remember(track.key, track.externalVideoId, catalog.allTracks, acquireJobs, saveJobMap, submittingKeys, savedKeys) {
                resolveStreamSaveState(track, catalog, acquireJobs, saveJobMap, submittingKeys, savedKeys)
            }
            val audioDetails = remember(
                track.entry.key,
                track.entry.size,
                track.entry.local,
                track.entry.streamUrl,
                state.audioCodec,
                state.audioOutput,
                state.durationMs,
                track.isExternalStream,
                saveState,
            ) {
                val base = describeTrackAudio(
                    entry = track.entry,
                    codec = state.audioCodec,
                    audioOutput = state.audioOutput,
                    durationMs = state.durationMs,
                    isExternalStream = track.isExternalStream,
                )
                if (track.isExternalStream && saveState == StreamSaveState.Saved) {
                    base.copy(sourceLabel = "Saved in library")
                } else {
                    base
                }
            }
            val artworkScale by animateFloatAsState(
                targetValue = if (state.playing) 1f else 0.91f,
                animationSpec = tween(260),
                label = "artworkScale",
            )
            val glowHue = ((track.hue % 360) + 360) % 360
            val topGlow = Color.hsl(glowHue.toFloat(), 0.56f, 0.24f, alpha = 0.34f)

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        val y = sheetOffsetPx.floatValue.coerceIn(0f, fullHeightPx)
                        translationY = y
                        shape = SheetTopRoundedShape
                        clip = y > 0.5f
                    }
                    .background(Bg),
            ) {
                // Subtle ambient obsidian gradient tinted by the active sleeve hue
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.verticalGradient(
                                0.0f to topGlow,
                                0.42f to Bg,
                                1.0f to Bg,
                            ),
                        ),
                )

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .statusBarsPadding()
                        .navigationBarsPadding(),
                ) {
                    // Grabber handle + header
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 10.dp, bottom = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(width = 36.dp, height = 4.dp)
                                .clip(PillShape)
                                .background(GlassBorder),
                        )
                        Spacer(Modifier.height(10.dp))
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CinemaIcon(MinimizeIcon, "Close player", Ink, onClick = { animateDismiss() })
                    Box(
                        modifier = Modifier.weight(1f),
                        contentAlignment = Alignment.Center,
                    ) {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(1.dp, GlassBorder, PillShape)
                                .padding(3.dp),
                            horizontalArrangement = Arrangement.spacedBy(2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            PlayerTabPill(
                                label = "Now Playing",
                                selected = activeTab == MusicSheetTab.NowPlaying,
                                onClick = { activeTab = MusicSheetTab.NowPlaying },
                            )
                            PlayerTabPill(
                                label = "Up Next (${ordered.size})",
                                selected = activeTab == MusicSheetTab.UpNext,
                                onClick = { activeTab = MusicSheetTab.UpNext },
                            )
                        }
                    }
                    CinemaIcon(
                        icon = InfoIcon,
                        description = "Track info",
                        tint = if (showTrackInfo) Ink else Dim,
                        onClick = { showTrackInfo = true },
                    )
                }
            }

            if (activeTab == MusicSheetTab.NowPlaying) {
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp)
                        .padding(top = 4.dp, bottom = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            modifier = Modifier
                                .sizeIn(maxWidth = 300.dp, maxHeight = 300.dp)
                                .aspectRatio(1f, matchHeightConstraintsFirst = true)
                                .pointerInput(artworkSwipeThresholdPx) {
                                    var totalX = 0f
                                    detectHorizontalDragGestures(
                                        onDragStart = {
                                            totalX = 0f
                                            artworkAnimJob?.cancel()
                                            artworkAnimJob = null
                                        },
                                        onDragEnd = {
                                            when {
                                                totalX <= -artworkSwipeThresholdPx -> {
                                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                    model.music.next()
                                                }
                                                totalX >= artworkSwipeThresholdPx -> {
                                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                    model.music.previous()
                                                }
                                            }
                                            artworkAnimJob?.cancel()
                                            artworkAnimJob = scope.launch {
                                                animate(
                                                    initialValue = artworkDragPx.floatValue,
                                                    targetValue = 0f,
                                                    animationSpec = spring(
                                                        dampingRatio = Spring.DampingRatioNoBouncy,
                                                        stiffness = 460f,
                                                    ),
                                                ) { value, _ ->
                                                    artworkDragPx.floatValue = value
                                                }
                                            }
                                        },
                                        onDragCancel = {
                                            artworkAnimJob?.cancel()
                                            artworkAnimJob = scope.launch {
                                                animate(
                                                    initialValue = artworkDragPx.floatValue,
                                                    targetValue = 0f,
                                                    animationSpec = spring(
                                                        dampingRatio = Spring.DampingRatioNoBouncy,
                                                        stiffness = 460f,
                                                    ),
                                                ) { value, _ ->
                                                    artworkDragPx.floatValue = value
                                                }
                                            }
                                        },
                                        onHorizontalDrag = { change, dragAmount ->
                                            if (dismissing || sheetOffsetPx.floatValue > 0f) return@detectHorizontalDragGestures
                                            change.consume()
                                            totalX += dragAmount
                                            artworkDragPx.floatValue = totalX.coerceIn(-artworkMaxDragPx, artworkMaxDragPx)
                                        },
                                    )
                                }
                                .graphicsLayer {
                                    scaleX = artworkScale
                                    scaleY = artworkScale
                                    translationX = artworkDragPx.floatValue * 0.45f
                                }
                                .shadow(24.dp, RoundedCornerShape(20.dp))
                                .clip(RoundedCornerShape(20.dp))
                                .combinedClickable(
                                    onClick = {},
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        showTrackInfo = true
                                    },
                                ),
                        ) {
                            AlbumSleeve(
                                hue = track.hue,
                                seed = track.seed,
                                monogramText = track.monogramText,
                                artist = track.artist,
                                albumName = track.album.ifBlank { track.title },
                                artUrl = track.artUrl.takeIf { it.isNotBlank() },
                                cornerRadius = 20.dp,
                                fontSize = 52.sp,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }

                    if (state.pausedForVideo) {
                        Text(
                            text = "Paused for a video",
                            color = Warn,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }

                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = track.title,
                            color = Ink,
                            fontSize = 20.sp,
                            lineHeight = 24.sp,
                            fontFamily = FontFamily.SansSerif,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = (-0.5).sp,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (track.artist.isNotBlank()) {
                            Text(
                                text = track.artist,
                                color = BrandHover,
                                fontSize = 14.sp,
                                lineHeight = 18.sp,
                                fontWeight = FontWeight.Medium,
                                textAlign = TextAlign.Center,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        onClose()
                                        if (track.isExternalStream) {
                                            model.openExternalArtist(name = track.artist)
                                        } else {
                                            onOpenArtist(fold(track.artist))
                                        }
                                    },
                            )
                        }
                        if (track.album.isNotBlank() && !track.album.equals(track.title, ignoreCase = true)) {
                            Text(
                                text = track.album,
                                color = Dim,
                                fontSize = 12.5.sp,
                                lineHeight = 16.sp,
                                textAlign = TextAlign.Center,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        onClose()
                                        if (track.isExternalStream || track.albumKey.isBlank()) {
                                            model.openExternalAlbum(
                                                browseId = track.albumBrowseId,
                                                title = track.album,
                                                artist = track.artist,
                                                artUrl = track.artUrl,
                                            )
                                        } else {
                                            onOpenAlbum(track.albumKey)
                                        }
                                    },
                            )
                        }

                        // Compact single-row streaming badge + Save to Library / Saved in library state
                        if (track.isExternalStream) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 4.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (saveState == StreamSaveState.Saved) {
                                    Row(
                                        modifier = Modifier
                                            .height(34.dp)
                                            .clip(PillShape)
                                            .background(GlassBg)
                                            .border(1.dp, Accent.copy(alpha = 0.5f), PillShape)
                                            .padding(horizontal = 14.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Icon(
                                            imageVector = CheckIcon,
                                            contentDescription = null,
                                            tint = Accent,
                                            modifier = Modifier.size(15.dp),
                                        )
                                        Text(
                                            text = "Saved in library",
                                            color = Accent,
                                            fontSize = 12.sp,
                                            fontWeight = FontWeight.SemiBold,
                                            maxLines = 1,
                                        )
                                    }
                                } else {
                                    Row(
                                        modifier = Modifier
                                            .weight(1f, fill = false)
                                            .height(34.dp)
                                            .clip(PillShape)
                                            .background(GlassBg)
                                            .border(1.dp, Brand.copy(alpha = 0.45f), PillShape)
                                            .padding(horizontal = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        Box(
                                            modifier = Modifier
                                                .size(6.dp)
                                                .clip(CircleShape)
                                                .background(BrandHover),
                                        )
                                        Text(
                                            text = track.externalStreamSource.orEmpty().ifBlank { "Streaming" },
                                            color = BrandHover,
                                            fontSize = 11.5.sp,
                                            fontWeight = FontWeight.SemiBold,
                                            letterSpacing = 0.2.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    if (saveState == StreamSaveState.Saving) {
                                        Row(
                                            modifier = Modifier
                                                .height(34.dp)
                                                .clip(PillShape)
                                                .background(GlassBg)
                                                .border(1.dp, GlassBorder, PillShape)
                                                .padding(horizontal = 14.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        ) {
                                            CircularProgressIndicator(
                                                modifier = Modifier.size(13.dp),
                                                color = Pearl,
                                                strokeWidth = 1.8.dp,
                                            )
                                            Text(
                                                text = "Saving…",
                                                color = Ink,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                maxLines = 1,
                                            )
                                        }
                                    } else {
                                        Row(
                                            modifier = Modifier
                                                .height(34.dp)
                                                .clip(PillShape)
                                                .background(Pearl)
                                                .clickable { model.saveStreamingTrackToLibrary(track) }
                                                .padding(horizontal = 14.dp),
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                                        ) {
                                            Icon(
                                                imageVector = AddIcon,
                                                contentDescription = null,
                                                tint = PearlInk,
                                                modifier = Modifier.size(15.dp),
                                            )
                                            Text(
                                                text = "Save to Library",
                                                color = PearlInk,
                                                fontSize = 12.sp,
                                                fontWeight = FontWeight.SemiBold,
                                                maxLines = 1,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    state.error?.let { err ->
                        Text(
                            text = err,
                            color = Danger,
                            fontSize = 12.sp,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    // Scrubber & clocks
                    Column(Modifier.fillMaxWidth()) {
                        Slider(
                            value = shownPos.toFloat(),
                            onValueChange = { scrub = it },
                            valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
                            enabled = durationMs > 0L,
                            onValueChangeFinished = {
                                scrub?.let { model.music.seekTo(it.toLong()) }
                                scrub = null
                            },
                            colors = SliderDefaults.colors(
                                thumbColor = Pearl,
                                activeTrackColor = Pearl,
                                inactiveTrackColor = GlassBorder,
                                disabledThumbColor = Dim,
                                disabledActiveTrackColor = Dim,
                                disabledInactiveTrackColor = Line,
                            ),
                        )
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(clock(shownPos), color = Dim, fontSize = 12.sp, maxLines = 1)
                            Text(
                                text = if (durationMs > 0L) clock(durationMs) else "—",
                                color = Dim,
                                fontSize = 12.sp,
                                maxLines = 1,
                            )
                        }
                    }

                    // Balanced transport controls with 58dp circular Pearl Play/Pause
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CinemaIcon(
                            icon = ShuffleIcon,
                            description = "Shuffle",
                            tint = if (state.shuffle) Brand else Dim,
                            onClick = { model.music.toggleShuffle() },
                        )
                        CinemaIcon(
                            icon = SkipPreviousIcon,
                            description = "Previous",
                            tint = Ink,
                            onClick = { model.music.previous() },
                        )
                        Box(
                            modifier = Modifier
                                .size(58.dp)
                                .shadow(12.dp, CircleShape)
                                .clip(CircleShape)
                                .background(Pearl)
                                .clickable { model.music.togglePlayPause() },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (state.buffering && state.playing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(24.dp),
                                    color = PearlInk,
                                    strokeWidth = 2.5.dp,
                                )
                            } else {
                                Icon(
                                    imageVector = if (state.playing) PauseIcon else PlayIcon,
                                    contentDescription = if (state.playing) "Pause" else "Play",
                                    tint = PearlInk,
                                    modifier = Modifier.size(28.dp),
                                )
                            }
                        }
                        CinemaIcon(
                            icon = SkipNextIcon,
                            description = "Next",
                            tint = Ink,
                            onClick = { model.music.next() },
                        )
                        CinemaIcon(
                            icon = if (state.repeat == RepeatMode.One) RepeatOneIcon else RepeatIcon,
                            description = "Repeat",
                            tint = if (state.repeat == RepeatMode.Off) Dim else Brand,
                            onClick = { model.music.cycleRepeat() },
                        )
                    }

                    // Autoplay, Queue, Cast & Stop thumb-zone utility pills
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            modifier = Modifier
                                .height(38.dp)
                                .clip(PillShape)
                                .background(if (state.autoplay) Brand.copy(alpha = 0.22f) else GlassBg)
                                .border(
                                    width = 1.dp,
                                    color = if (state.autoplay) Brand.copy(alpha = 0.65f) else GlassBorder,
                                    shape = PillShape,
                                )
                                .clickable { model.music.toggleAutoplay() }
                                .padding(horizontal = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(
                                imageVector = InfinityIcon,
                                contentDescription = "Toggle Autoplay",
                                tint = if (state.autoplay) BrandHover else Dim,
                                modifier = Modifier.size(15.dp),
                            )
                            Text(
                                text = "Autoplay",
                                color = if (state.autoplay) BrandHover else Dim,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                            )
                        }
                        Row(
                            modifier = Modifier
                                .height(38.dp)
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(1.dp, GlassBorder, PillShape)
                                .clickable { activeTab = MusicSheetTab.UpNext }
                                .padding(horizontal = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(QueueMusicIcon, "Up Next queue", tint = Ink, modifier = Modifier.size(15.dp))
                            Text(
                                text = if (ordered.size > 1) "Queue · ${ordered.size}" else "Queue",
                                color = Ink,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                            )
                        }
                        Row(
                            modifier = Modifier
                                .height(38.dp)
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(1.dp, GlassBorder, PillShape)
                                .clickable { model.openCastSheet() }
                                .padding(horizontal = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(CastIcon, "Cast to TV", tint = Ink, modifier = Modifier.size(15.dp))
                            Text("Cast", color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                        }
                        Row(
                            modifier = Modifier
                                .height(38.dp)
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(1.dp, GlassBorder, PillShape)
                                .clickable {
                                    animateDismiss { model.music.stopMusic() }
                                }
                                .padding(horizontal = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(CloseIcon, "Stop playback", tint = Dim, modifier = Modifier.size(15.dp))
                            Text("Stop", color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                        }
                    }
                }
            } else {
                // Full-height Up Next tab with RiPlay-style infinite Autoplay header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "Up Next · ${plural(ordered.size, "track", "tracks")}",
                            color = Ink,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val queueSub = when {
                            state.autoplayLoading -> "Finding similar tracks…"
                            state.autoplay -> "Infinite radio on"
                            state.sourceLabel.isNotBlank() -> "Playing from ${state.sourceLabel}"
                            else -> "Autoplay off"
                        }
                        Text(
                            text = queueSub,
                            color = if (state.autoplay) BrandHover else Dim,
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Row(
                        modifier = Modifier
                            .height(32.dp)
                            .clip(PillShape)
                            .background(if (state.autoplay) Pearl else GlassBg)
                            .border(
                                width = if (state.autoplay) 0.dp else 1.dp,
                                color = if (state.autoplay) Color.Transparent else GlassBorder,
                                shape = PillShape,
                            )
                            .clickable { model.music.toggleAutoplay() }
                            .padding(horizontal = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        if (state.autoplayLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(12.dp),
                                color = if (state.autoplay) PearlInk else BrandHover,
                                strokeWidth = 1.6.dp,
                            )
                        } else {
                            Icon(
                                imageVector = InfinityIcon,
                                contentDescription = "Autoplay",
                                tint = if (state.autoplay) PearlInk else Dim,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                        Text(
                            text = if (state.autoplay) "On" else "Off",
                            color = if (state.autoplay) PearlInk else Dim,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                        )
                    }
                    if (state.upNextCount > 0) {
                        TextButton(onClick = { model.music.clearUpNext() }) {
                            Text("Clear", color = Dim, fontSize = 13.sp)
                        }
                    }
                }
                HorizontalDivider(color = Line.copy(alpha = 0.7f))

                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    itemsIndexed(ordered, key = { orderIdx, item -> "$orderIdx-${item.key}" }) { orderIdx, item ->
                        val isPast = orderIdx < state.index
                        val isCurrent = orderIdx == state.index
                        val rowShape = RoundedCornerShape(14.dp)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(rowShape)
                                .background(if (isCurrent) Brand.copy(alpha = 0.14f) else CardBg.copy(alpha = 0.65f))
                                .border(
                                    width = 1.dp,
                                    color = if (isCurrent) Brand.copy(alpha = 0.45f) else Line.copy(alpha = 0.55f),
                                    shape = rowShape,
                                )
                                .clickable { model.music.jumpTo(orderIdx) }
                                .padding(start = 10.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                AlbumSleeve(
                                    hue = item.hue,
                                    seed = item.seed,
                                    monogramText = item.monogramText,
                                    artist = item.artist,
                                    albumName = item.album.ifBlank { item.title },
                                    artUrl = item.artUrl.takeIf { it.isNotBlank() },
                                    cornerRadius = 8.dp,
                                    fontSize = 12.sp,
                                    modifier = Modifier.size(40.dp),
                                )
                                if (isCurrent) {
                                    Box(
                                        modifier = Modifier
                                            .size(40.dp)
                                            .clip(RoundedCornerShape(8.dp))
                                            .background(Bg.copy(alpha = 0.55f)),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(
                                            imageVector = if (state.playing) PauseIcon else PlayIcon,
                                            contentDescription = "Now playing",
                                            tint = Pearl,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(
                                    text = item.title,
                                    color = when {
                                        isCurrent -> BrandHover
                                        isPast -> Dim.copy(alpha = 0.65f)
                                        else -> Ink
                                    },
                                    fontSize = 14.sp,
                                    fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                val sub = listOfNotNull(
                                    item.artist.takeIf { it.isNotBlank() },
                                    item.album.takeIf { it.isNotBlank() },
                                    if (isCurrent && durationMs > 0L) clock(durationMs)
                                    else item.entry.size.takeIf { it > 0L }?.let { formatBytes(it) },
                                ).joinToString(" · ")
                                if (sub.isNotEmpty()) {
                                    Text(
                                        text = sub,
                                        color = if (isPast) Dim.copy(alpha = 0.5f) else Dim,
                                        fontSize = 12.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                            if (orderIdx > state.index) {
                                IconButton(
                                    onClick = { model.music.removeFromQueue(orderIdx) },
                                    modifier = Modifier.size(40.dp),
                                ) {
                                    Icon(
                                        imageVector = CloseIcon,
                                        contentDescription = "Remove from Up Next",
                                        tint = Dim,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                // Thumb-zone footer on Up Next so switching back to Now Playing or minimizing never requires top reach
                HorizontalDivider(color = Line.copy(alpha = 0.6f))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        modifier = Modifier
                            .weight(1f)
                            .height(40.dp)
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(1.dp, GlassBorder, PillShape)
                            .clickable { activeTab = MusicSheetTab.NowPlaying }
                            .padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    ) {
                        Icon(MusicNoteIcon, null, tint = Ink, modifier = Modifier.size(16.dp))
                        Text("Now Playing", color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    }
                    Row(
                        modifier = Modifier
                            .weight(1f)
                            .height(40.dp)
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(1.dp, GlassBorder, PillShape)
                            .clickable { animateDismiss() }
                            .padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                    ) {
                        Icon(MinimizeIcon, null, tint = Dim, modifier = Modifier.size(16.dp))
                        Text("Minimize", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    }
                }
            }
        }
    }

    if (showTrackInfo) {
        TrackInfoSheet(
            track = track,
            details = audioDetails,
            saveState = saveState,
            onDismiss = { showTrackInfo = false },
            onSaveToLibrary = {
                showTrackInfo = false
                model.saveStreamingTrackToLibrary(track)
            },
            onOpenAlbum = {
                showTrackInfo = false
                onClose()
                onOpenAlbum(track.albumKey)
            },
            onOpenArtist = {
                showTrackInfo = false
                onClose()
                if (track.isExternalStream) {
                    model.openExternalArtist(name = track.artist)
                } else {
                    onOpenArtist(fold(track.artist))
                }
            },
            onFindLossless = {
                showTrackInfo = false
                onClose()
                val query = listOf(track.artist, track.title).filter { it.isNotBlank() }.joinToString(" ")
                model.openSearchFor(query, askRelays = true)
            },
        )
    }
    }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun TrackInfoSheet(
    track: TrackItem,
    details: TrackAudioDetails,
    saveState: StreamSaveState,
    onDismiss: () -> Unit,
    onSaveToLibrary: () -> Unit,
    onOpenAlbum: () -> Unit,
    onOpenArtist: () -> Unit,
    onFindLossless: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = CardBg,
        contentColor = Ink,
        dragHandle = {
            Box(
                modifier = Modifier
                    .padding(top = 12.dp, bottom = 8.dp)
                    .size(width = 36.dp, height = 4.dp)
                    .clip(PillShape)
                    .background(GlassBorder),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AlbumSleeve(
                    hue = track.hue,
                    seed = track.seed,
                    monogramText = track.monogramText,
                    artist = track.artist,
                    albumName = track.album.ifBlank { track.title },
                    artUrl = track.artUrl.takeIf { it.isNotBlank() },
                    cornerRadius = 10.dp,
                    fontSize = 18.sp,
                    modifier = Modifier.size(52.dp),
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = track.title,
                        color = Ink,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val subtitle = listOfNotNull(
                        track.artist.takeIf { it.isNotBlank() },
                        track.album.takeIf { it.isNotBlank() && !it.equals(track.title, ignoreCase = true) },
                    ).joinToString(" · ")
                    if (subtitle.isNotEmpty()) {
                        Text(
                            text = subtitle,
                            color = Dim,
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(GlassBg)
                    .border(0.5.dp, GlassBorder, RoundedCornerShape(16.dp))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TrackInfoRow(
                    label = "Format",
                    value = details.formatLabel,
                    valueColor = if (details.isLossless) Accent else Ink,
                )
                details.outputLabel?.let { out ->
                    HorizontalDivider(color = Line, thickness = 0.5.dp)
                    TrackInfoRow(label = "Output", value = out)
                }
                HorizontalDivider(color = Line, thickness = 0.5.dp)
                TrackInfoRow(label = "Source", value = details.sourceLabel)
                details.durationLabel?.let { dur ->
                    HorizontalDivider(color = Line, thickness = 0.5.dp)
                    TrackInfoRow(label = "Duration", value = dur)
                }
                details.sizeLabel?.let { size ->
                    HorizontalDivider(color = Line, thickness = 0.5.dp)
                    TrackInfoRow(label = "File size", value = size)
                }
            }

            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (track.isExternalStream) {
                    when (saveState) {
                        StreamSaveState.Saved -> TrackInfoActionChip(
                            label = "Saved in library",
                            icon = CheckIcon,
                            primary = false,
                            onClick = onDismiss,
                        )
                        StreamSaveState.Saving -> TrackInfoActionChip(
                            label = "Saving…",
                            icon = AddIcon,
                            primary = false,
                            onClick = {},
                        )
                        StreamSaveState.Unsaved -> TrackInfoActionChip(
                            label = "Save to Library",
                            icon = AddIcon,
                            primary = true,
                            onClick = onSaveToLibrary,
                        )
                    }
                }
                if (details.canFindLossless) {
                    TrackInfoActionChip(
                        label = "Find Lossless",
                        icon = SearchIcon,
                        primary = !track.isExternalStream,
                        onClick = onFindLossless,
                    )
                }
                if (!track.isExternalStream && track.albumKey.isNotBlank()) {
                    TrackInfoActionChip(
                        label = "Go to Album",
                        icon = MusicNoteIcon,
                        primary = false,
                        onClick = onOpenAlbum,
                    )
                }
                if (track.artist.isNotBlank()) {
                    TrackInfoActionChip(
                        label = "Go to Artist",
                        icon = SparklesIcon,
                        primary = false,
                        onClick = onOpenArtist,
                    )
                }
            }
        }
    }
}

@Composable
private fun TrackInfoRow(
    label: String,
    value: String,
    valueColor: Color = Ink,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = Dim,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = value,
            color = valueColor,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.End,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

@Composable
private fun TrackInfoActionChip(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    primary: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(36.dp)
            .clip(PillShape)
            .background(if (primary) Pearl else GlassBg)
            .border(
                width = if (primary) 0.dp else 0.5.dp,
                color = if (primary) Color.Transparent else GlassBorder,
                shape = PillShape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (primary) PearlInk else Ink,
            modifier = Modifier.size(15.dp),
        )
        Text(
            text = label,
            color = if (primary) PearlInk else Ink,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun PlayerTabPill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .clip(PillShape)
            .background(if (selected) Pearl else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) PearlInk else Dim,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}
