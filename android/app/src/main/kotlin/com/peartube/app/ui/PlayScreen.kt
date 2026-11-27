package com.peartube.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.os.SystemClock
import android.view.OrientationEventListener
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.peartube.shared.clock
import com.peartube.shared.prettyCodec
import com.peartube.shared.setImmersive
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.peartube.app.AppModel
import com.peartube.app.Entry
import com.peartube.app.Screen
import com.peartube.app.VideoControlBridge
import com.peartube.app.VideoDisplayMode
import com.peartube.shared.formatBytes
import com.peartube.app.p2pSummary
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerHost
import com.peartube.app.player.PlayerState
import com.peartube.app.player.Track
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
import java.util.concurrent.atomic.AtomicBoolean
import java.io.File
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.runtime.key

data class MiniCutoutRect(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
    val cornerRadiusPx: Float,
)

private enum class MiniCorner {
    TopStart,
    TopEnd,
    BottomStart,
    BottomEnd,
}

/**
 * Hoisted video playback host that keeps one NativePlayer & PlayerHost surface alive across
 * Fullscreen <-> Floating Mini-Player <-> Android OS Picture-in-Picture transitions.
 */
@Composable
fun VideoSessionHost(
    model: AppModel,
    host: PlayerHost,
    entry: Entry,
    startPositionMs: Long? = null,
    mode: VideoDisplayMode = VideoDisplayMode.Fullscreen,
    miniBottomClearance: Dp = 92.dp,
    onMiniCutoutChanged: (MiniCutoutRect?) -> Unit = {},
) {
    val context = LocalContext.current
    val activity = remember(context) { context.activity() }
    val view = LocalView.current
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
    val liveEntry = remember(entries, entry) {
        entries.firstOrNull { it.key == entry.key } ?: entries.firstOrNull { it.id == entry.id } ?: entry
    }
    var handle by remember { mutableLongStateOf(0L) }
    var openError by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf(PlayerState()) }
    // Where the seek bar is dragged to, or a seek the player has not reached yet.
    var target by remember { mutableStateOf<Long?>(null) }
    var seekedAt by remember { mutableLongStateOf(0L) }
    var scrubbing by remember { mutableStateOf(false) }
    var controls by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    var menuOpen by remember { mutableStateOf(false) }
    var infoOpen by remember { mutableStateOf(false) }
    val isTv = remember(context) {
        (context.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION ||
            context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_LEANBACK)
    }
    var landscapeMode by remember(isTv) { mutableStateOf(isTv) }
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val resumePosition = remember(entry.key) {
        startPositionMs ?: model.watchHistory.value[entry.key]?.takeIf { it.partial }?.positionMs ?: 0L
    }
    var resumePending by remember(entry.key) { mutableStateOf(resumePosition > 0) }
    val latestState by rememberUpdatedState(state)
    val openingScope = rememberCoroutineScope()

    LaunchedEffect(liveEntry.key) {
        runCatching { model.worker.warm(liveEntry.key) }
    }

    DisposableEffect(liveEntry.streamUrl) {
        model.playStarted = false
        openError = null
        model.setPlayerActive(true)
        host.open()
        val soundfont = File(context.filesDir, "soundfont.sf2").takeIf { it.isFile }?.path
        val active = AtomicBoolean(true)
        val opening = openingScope.launch(Dispatchers.IO) {
            var failure: String? = null
            val opened = try {
                NativePlayer.openWithOptions(liveEntry.streamUrl, soundfont, "auto", if (isTv) "exact" else "seamless", false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                failure = "The player did not start: ${e.message ?: e}"
                0L
            }
            withContext(Dispatchers.Main.immediate + NonCancellable) {
                if (active.get()) {
                    openError = failure ?: if (opened == 0L) "The player did not start." else null
                    handle = opened
                } else if (opened != 0L) {
                    NativePlayer.close(opened)
                }
            }
        }
        onDispose {
            active.set(false)
            opening.cancel()
            model.registerVideoControls(null)
            model.updateVideoSourceRect(null)
            model.setPlayerActive(model.musicState.value.playing)
            model.playStarted = false
            model.updateVideoPlaybackState(
                playing = false,
                displayAspect = null,
                positionMs = 0L,
                durationMs = 0L,
                buffering = false,
            )
            model.recordWatchProgress(liveEntry, latestState.positionMs, latestState.durationMs)
            onMiniCutoutChanged(null)
            val opened = handle
            handle = 0L
            host.close()
            if (opened != 0L) NativePlayer.close(opened)
        }
    }

    // Background playback policy: keep playing videos decoding audio seamlessly across screen lock
    // and app switching (MediaPlaybackService keeps AAudio, WakeLock, and P2P blob server alive).
    // Only suspend the native player on ON_STOP when the user had already paused playback.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, handle) {
        val h = handle
        var suspendedByLifecycle = false
        val observer = LifecycleEventObserver { _, event ->
            if (h == 0L) return@LifecycleEventObserver
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    val inPip = activity.isInPictureInPictureMode || model.videoMode.value == VideoDisplayMode.Pip
                    if (!inPip && !latestState.playing) {
                        NativePlayer.suspend(h)
                        suspendedByLifecycle = true
                    }
                }
                Lifecycle.Event.ON_START -> {
                    if (suspendedByLifecycle) {
                        suspendedByLifecycle = false
                        NativePlayer.resume(h)
                    }
                }
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Bridge lockscreen / notification / headset / OS PiP RemoteAction controls into NativePlayer.
    DisposableEffect(handle, liveEntry.key) {
        val h = handle
        if (h != 0L) {
            model.registerVideoControls(
                object : VideoControlBridge {
                    override fun play() {
                        if (handle != h) return
                        runCatching { NativePlayer.play(h) }
                        val st = runCatching { PlayerState.parse(NativePlayer.state(h)) }.getOrNull()
                        if (st != null) {
                            state = st
                            model.updateVideoPlaybackState(
                                playing = st.playing && !st.ended,
                                displayAspect = st.displayAspect,
                                positionMs = st.positionMs,
                                durationMs = st.durationMs,
                                buffering = st.buffering && st.error == null,
                            )
                        }
                    }

                    override fun pause() {
                        if (handle != h) return
                        runCatching { NativePlayer.pause(h) }
                        val st = runCatching { PlayerState.parse(NativePlayer.state(h)) }.getOrNull()
                        if (st != null) {
                            state = st
                            model.updateVideoPlaybackState(
                                playing = st.playing && !st.ended,
                                displayAspect = st.displayAspect,
                                positionMs = st.positionMs,
                                durationMs = st.durationMs,
                                buffering = st.buffering && st.error == null,
                            )
                        }
                    }

                    override fun togglePlayPause() {
                        if (latestState.playing) pause() else play()
                    }

                    override fun seekBy(deltaMs: Long) {
                        val curDur = latestState.durationMs ?: return
                        if (curDur <= 0L) return
                        seekTo((latestState.positionMs + deltaMs).coerceIn(0L, curDur))
                    }

                    override fun seekTo(positionMs: Long) {
                        if (handle != h) return
                        val curDur = latestState.durationMs ?: 0L
                        val clamped = if (curDur > 0L) positionMs.coerceIn(0L, curDur) else positionMs.coerceAtLeast(0L)
                        target = clamped
                        seekedAt = SystemClock.uptimeMillis()
                        runCatching { NativePlayer.seek(h, clamped) }
                    }

                    override fun stop() {
                        model.recordWatchProgress(liveEntry, latestState.positionMs, latestState.durationMs)
                        activity.setImmersive(false, view)
                        model.closeVideo()
                    }
                },
            )
        }
        onDispose {
            if (h != 0L) model.registerVideoControls(null)
        }
    }

    // Events come on change; the clock needs a steadier beat, so poll.
    LaunchedEffect(handle) {
        val h = handle
        if (h == 0L) return@LaunchedEffect
        var ticks = 0
        var waitingSince = SystemClock.uptimeMillis()
        while (true) {
            val st = PlayerState.parse(NativePlayer.state(h))
            st.displayAspect?.let { host.fit(it) }
            st.videoFps?.let { host.matchFrameRate(it) }
            host.shown(st.positionMs)
            state = st
            model.updateVideoPlaybackState(
                playing = st.playing && !st.ended,
                displayAspect = st.displayAspect,
                positionMs = st.positionMs,
                durationMs = st.durationMs,
                buffering = st.buffering && st.error == null,
            )
            if (st.positionMs > 0 || st.durationMs != null) waitingSince = SystemClock.uptimeMillis()
            val waiting = SystemClock.uptimeMillis() - waitingSince
            if (st.positionMs == 0L && st.durationMs == null && st.error == null) {
                if (waiting > 90_000L && openError != "Still waiting for peers to send this video.") {
                    openError = "Still waiting for peers to send this video."
                }
            } else if (openError == "Still waiting for peers to send this video.") {
                openError = null
            }
            if (st.positionMs > 0) model.playStarted = true
            if (resumePending && st.durationMs != null) {
                resumePending = false
                NativePlayer.seek(h, resumePosition.coerceAtMost(st.durationMs))
            }
            if (ticks++ % 16 == 0 || st.ended) model.recordWatchProgress(entry, st.positionMs, st.durationMs)
            target?.let {
                val timeoutMs = if (st.buffering) 12_000L else 2_500L
                if (!scrubbing && ((!st.buffering && abs(st.positionMs - it) < 1_500) || SystemClock.uptimeMillis() - seekedAt > timeoutMs)) target = null
            }
            if (st.ended) {
                model.closeVideo()
                break
            }
            delay(250)
        }
    }

    LaunchedEffect(controls, state.playing, touches, scrubbing, menuOpen, infoOpen, mode) {
        if (mode == VideoDisplayMode.Fullscreen && controls && state.playing && !scrubbing && !menuOpen && !infoOpen) {
            delay(3_000)
            controls = false
        }
    }

    val exitOrientation = if (isTv) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    DisposableEffect(activity, mode, exitOrientation) {
        val fullscreen = mode == VideoDisplayMode.Fullscreen
        activity.setImmersive(fullscreen, view)
        if (fullscreen || mode == VideoDisplayMode.Pip) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        if (!fullscreen) {
            activity.requestedOrientation = exitOrientation
        }
        onDispose {
            activity.requestedOrientation = exitOrientation
            activity.setImmersive(false, view)
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    LaunchedEffect(mode, landscapeMode, isTv) {
        if (mode == VideoDisplayMode.Fullscreen) {
            activity.requestedOrientation = when {
                isTv -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                landscapeMode -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
        } else {
            activity.requestedOrientation = exitOrientation
        }
    }

    val length = state.durationMs ?: 0L
    val shown = target ?: state.positionMs
    val error = openError ?: state.error
    val busy = handle != 0L && state.buffering && error == null
    val hasFirstFrame = state.videoWidth != null && (!state.buffering || state.positionMs > 0L)

    fun show() {
        controls = true
        touches++
    }
    fun toggleOrientation() {
        show()
        landscapeMode = !landscapeMode
    }
    fun leave() {
        model.recordWatchProgress(entry, state.positionMs, state.durationMs)
        activity.setImmersive(false, view)
        activity.requestedOrientation = exitOrientation
        model.closeVideo()
    }
    fun minimize() {
        infoOpen = false
        menuOpen = false
        landscapeMode = false
        model.minimizeVideo()
    }
    fun playPause() {
        show()
        if (handle == 0L) return
        if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
        state = PlayerState.parse(NativePlayer.state(handle))
    }
    fun seekTo(ms: Long) {
        show()
        if (handle == 0L || length <= 0) return
        val to = ms.coerceIn(0L, length)
        target = to
        seekedAt = SystemClock.uptimeMillis()
        NativePlayer.seek(handle, to)
    }

    // Mode 1: Android OS Picture-in-Picture — clean full-bleed video only (no chrome or in-app mini-player!)
    if (mode == VideoDisplayMode.Pip) {
        Box(Modifier.fillMaxSize()) {
            Slot(host, Modifier.fillMaxSize(), onBoundsInWindow = { model.updateVideoSourceRect(it) })
            AnimatedVisibility(!hasFirstFrame && error == null, enter = fadeIn(tween(0)), exit = fadeOut(tween(180))) {
                Box(Modifier.fillMaxSize().background(Color.Black))
            }
        }
        return
    }

    // Mode 2: Premium floating draggable Mini-Player (224dp x 126dp) with spring corner snap & auto-hiding glass controls
    if (mode == VideoDisplayMode.Mini) {
        val videoAspect by model.videoAspectRatio.collectAsState()
        FloatingVideoMiniPlayer(
            host = host,
            title = liveEntry.title,
            aspectRatio = videoAspect,
            playing = state.playing,
            busy = busy,
            hasFirstFrame = hasFirstFrame,
            error = error,
            progress = if (length > 0L) (shown.toFloat() / length).coerceIn(0f, 1f) else 0f,
            bottomClearance = miniBottomClearance,
            onExpand = { model.expandVideo() },
            onTogglePlay = ::playPause,
            onSeekBack = { seekTo(shown - 10_000L) },
            onSeekForward = { seekTo(shown + 10_000L) },
            onClose = ::leave,
            onCutoutChanged = onMiniCutoutChanged,
            onSourceRectChanged = { model.updateVideoSourceRect(it) },
        )
        return
    }

    // Mode 3: Fullscreen cinema
    BackHandler {
        if (infoOpen) infoOpen = false
        else if (!isTv && landscapeMode) landscapeMode = false
        else leave()
    }

    val audio = state.tracks.filter { it.kind == "audio" }
    val subtitles = state.tracks.filter { it.kind == "subtitle" }
    val audioOptions = if (audio.size > 1) audio.map { Option(it.label, it.stream, it.stream == state.audio) } else emptyList()
    val subtitleOptions = if (subtitles.isEmpty()) emptyList() else {
        listOf(Option("Off", -1, subtitles.none { it.stream == state.subtitle })) +
            subtitles.map { Option(it.label, it.stream, it.stream == state.subtitle) }
    }
    val selectAudio: (Int) -> Unit = { if (handle != 0L) NativePlayer.selectAudio(handle, it) }
    val selectSubtitle: (Int) -> Unit = { if (handle != 0L) NativePlayer.selectSubtitle(handle, it) }
    val clockText = when {
        state.durationMs != null -> "${clock(shown)} / ${clock(length)}"
        state.buffering || state.positionMs == 0L -> "Loading…"
        else -> clock(state.positionMs)
    }

    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val minimizeSwipeThresholdPx = remember(density) { with(density) { 88.dp.toPx() } }
    val minimizeMinFlingPx = remember(density) { with(density) { 36.dp.toPx() } }
    val minimizeFlingVelocityPx = remember(density) { with(density) { 850.dp.toPx() } }
    var seekToastSide by remember { mutableIntStateOf(0) }
    var seekToastTick by remember { mutableIntStateOf(0) }
    LaunchedEffect(seekToastTick) {
        if (seekToastTick > 0) {
            delay(750L)
            seekToastSide = 0
        }
    }
    val latestShown by rememberUpdatedState(shown)
    val latestScrubbing by rememberUpdatedState(scrubbing)
    val latestInfoOpen by rememberUpdatedState(infoOpen)

    val overlay: @Composable () -> Unit = {
        Box(
            Modifier.fillMaxSize()
                // The clock as well, for TalkBack and for android/e2e.mjs: the controls hide.
                .semantics { contentDescription = "Video, $clockText" }
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = {
                            controls = !controls
                            touches++
                        },
                        onDoubleTap = { offset ->
                            val w = size.width.toFloat().coerceAtLeast(1f)
                            when {
                                offset.x < w * 0.35f -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    seekTo(latestShown - 10_000L)
                                    seekToastSide = -1
                                    seekToastTick++
                                }
                                offset.x > w * 0.65f -> {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    seekTo(latestShown + 10_000L)
                                    seekToastSide = 1
                                    seekToastTick++
                                }
                                else -> {
                                    controls = !controls
                                    touches++
                                }
                            }
                        },
                        onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            infoOpen = !latestInfoOpen
                            show()
                        },
                    )
                }
                .pointerInput(isTv, minimizeSwipeThresholdPx, minimizeFlingVelocityPx) {
                    var dragDownPx = 0f
                    var minimizedThisDrag = false
                    val velocityTracker = VelocityTracker()
                    detectVerticalDragGestures(
                        onDragStart = {
                            dragDownPx = 0f
                            minimizedThisDrag = false
                            velocityTracker.resetTracking()
                        },
                        onDragEnd = {
                            if (!isTv && !latestScrubbing && !latestInfoOpen && !minimizedThisDrag) {
                                val vy = velocityTracker.calculateVelocity().y
                                if (shouldDismissSwipeDown(dragDownPx, vy, minimizeSwipeThresholdPx, minimizeFlingVelocityPx, minimizeMinFlingPx)) {
                                    minimizedThisDrag = true
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    minimize()
                                }
                            }
                            dragDownPx = 0f
                        },
                        onDragCancel = { dragDownPx = 0f },
                        onVerticalDrag = { change, dragAmount ->
                            if (!isTv && !latestScrubbing && !latestInfoOpen && !minimizedThisDrag) {
                                velocityTracker.addPosition(change.uptimeMillis, change.position)
                                dragDownPx = (dragDownPx + dragAmount).coerceAtLeast(0f)
                                if (dragDownPx > minimizeSwipeThresholdPx) {
                                    minimizedThisDrag = true
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    minimize()
                                }
                            }
                        },
                    )
                },
        ) {
            AnimatedVisibility(
                visible = seekToastSide == -1,
                enter = fadeIn(tween(120)),
                exit = fadeOut(tween(220)),
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 36.dp),
            ) {
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(FloatingDockBg)
                        .border(1.dp, FloatingDockBorder, PillShape)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Text("« 10s", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            AnimatedVisibility(
                visible = seekToastSide == 1,
                enter = fadeIn(tween(120)),
                exit = fadeOut(tween(220)),
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 36.dp),
            ) {
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(FloatingDockBg)
                        .border(1.dp, FloatingDockBorder, PillShape)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                ) {
                    Text("10s »", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            AnimatedVisibility(controls || !state.playing || infoOpen, enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.fillMaxSize().background(Scrim)) {
                    Row(
                        Modifier.align(Alignment.TopStart).fillMaxWidth()
                            .statusBarsPadding()
                            .windowInsetsPadding(WindowInsets.displayCutout)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OverlayButton(BackIcon, "Back", ::leave)
                        if (!isTv) {
                            OverlayButton(MinimizeIcon, "Minimize", ::minimize)
                        }
                        Text(
                            entry.title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 8.dp),
                        )
                        if (subtitleOptions.isNotEmpty()) {
                            TrackPicker(subtitleOptions, selectSubtitle, { menuOpen = it }) { open -> OverlayButton(SubtitlesIcon, "Subtitles", open) }
                        }
                        if (audioOptions.isNotEmpty()) {
                            TrackPicker(audioOptions, selectAudio, { menuOpen = it }) { open -> OverlayButton(AudioIcon, "Audio", open) }
                        }
                        OverlayButton(InfoIcon, "Content info", { infoOpen = !infoOpen; show() })
                        OverlayButton(TvIcon, "Play on a TV", {
                            model.recordWatchProgress(liveEntry, state.positionMs, state.durationMs)
                            model.openTvsPickerForEntry(liveEntry, state.positionMs)
                        })
                    }
                    Row(
                        Modifier.align(Alignment.Center),
                        horizontalArrangement = Arrangement.spacedBy(if (landscape) 56.dp else 36.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OverlayButton(ReplayIcon, "Back 10 seconds", { seekTo(shown - 10_000) }, size = 52.dp, iconSize = 34.dp, badge = "10")
                        if (busy) {
                            Spacer(Modifier.size(64.dp))
                        } else {
                            OverlayButton(
                                if (state.playing) PauseIcon else PlayIcon, if (state.playing) "Pause" else "Play", ::playPause,
                                size = 64.dp, iconSize = 38.dp, filled = true,
                            )
                        }
                        OverlayButton(ReplayIcon, "Forward 10 seconds", { seekTo(shown + 10_000) }, size = 52.dp, iconSize = 34.dp, badge = "10", mirrored = true)
                    }
                    Column(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                            .navigationBarsPadding()
                            .windowInsetsPadding(WindowInsets.displayCutout)
                            .padding(horizontal = 24.dp, vertical = 12.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(clockText, color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(start = 4.dp))
                            if (!isTv) {
                                OverlayButton(
                                    if (landscape) FullscreenExitIcon else FullscreenIcon,
                                    "Toggle orientation",
                                    ::toggleOrientation,
                                )
                            }
                        }
                        SeekBar(
                            fraction = if (length > 0) shown.toFloat() / length else 0f,
                            enabled = handle != 0L && length > 0,
                            onScrub = {
                                scrubbing = true
                                controls = true
                                touches++
                                target = (it.coerceIn(0f, 1f) * length).toLong()
                            },
                            onCommit = {
                                scrubbing = false
                                seekTo((it.coerceIn(0f, 1f) * length).toLong())
                            },
                        )
                    }
                }
            }
            if (busy) {
                CircularProgressIndicator(Modifier.align(Alignment.Center).size(48.dp), color = Color.White, strokeWidth = 3.dp)
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Slot(host, Modifier.fillMaxSize(), onBoundsInWindow = { model.updateVideoSourceRect(it) })
        AnimatedVisibility(!hasFirstFrame && error == null, enter = fadeIn(tween(0)), exit = fadeOut(tween(180))) {
            Box(Modifier.fillMaxSize().background(Color.Black))
        }
        overlay()
        if (error != null) Text(error, color = Danger, modifier = Modifier.align(Alignment.Center).padding(24.dp).background(CardBg, RoundedCornerShape(16.dp)).padding(16.dp))
        if (infoOpen) {
            PlayerInfoPanel(
                model = model,
                entry = liveEntry,
                state = state,
                landscape = landscape,
                onSelectAudio = selectAudio,
                onSeek = ::seekTo,
                onClose = { infoOpen = false },
                onSwitch = { next, preserveTime ->
                    model.recordWatchProgress(liveEntry, state.positionMs, state.durationMs)
                    model.openVideo(next, if (preserveTime) state.positionMs else null)
                },
                modifier = Modifier.align(if (landscape) Alignment.CenterEnd else Alignment.BottomCenter),
            )
        }
    }
}

@Composable
private fun FloatingVideoMiniPlayer(
    host: PlayerHost,
    title: String,
    aspectRatio: Float,
    playing: Boolean,
    busy: Boolean,
    hasFirstFrame: Boolean,
    error: String?,
    progress: Float,
    bottomClearance: Dp,
    onExpand: () -> Unit,
    onTogglePlay: () -> Unit,
    onSeekBack: () -> Unit,
    onSeekForward: () -> Unit,
    onClose: () -> Unit,
    onCutoutChanged: (MiniCutoutRect?) -> Unit,
    onSourceRectChanged: (Rect?) -> Unit,
) {
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val clampedAspect = aspectRatio.takeIf { it.isFinite() }?.coerceIn(1.35f, 2.0f) ?: (16f / 9f)
    val miniW = 224.dp
    val miniH = (miniW / clampedAspect).coerceIn(112.dp, 166.dp)
    val cornerRadius = 18.dp
    val shape = RoundedCornerShape(cornerRadius)
    val cornerRadiusPx = remember(density) { with(density) { cornerRadius.toPx() } }

    var corner by remember { mutableStateOf(MiniCorner.BottomEnd) }
    var initialized by remember { mutableStateOf(false) }
    var dragging by remember { mutableStateOf(false) }
    var showControls by remember { mutableStateOf(true) }
    var touchTick by remember { mutableIntStateOf(0) }
    val posAnim = remember { Animatable(Offset.Zero, Offset.VectorConverter) }

    LaunchedEffect(showControls, playing, touchTick, dragging) {
        if (showControls && playing && !dragging) {
            delay(3_000L)
            showControls = false
        }
    }

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        val marginX = 14.dp
        val topMargin = 68.dp
        val minX = with(density) { marginX.toPx() }
        val maxX = with(density) { (maxWidth - miniW - marginX).coerceAtLeast(marginX).toPx() }
        val minY = with(density) { topMargin.toPx() }
        val maxY = with(density) { (maxHeight - miniH - bottomClearance).coerceAtLeast(topMargin).toPx() }

        fun cornerOffset(c: MiniCorner): Offset = Offset(
            x = when (c) {
                MiniCorner.TopStart, MiniCorner.BottomStart -> minX
                MiniCorner.TopEnd, MiniCorner.BottomEnd -> maxX
            },
            y = when (c) {
                MiniCorner.TopStart, MiniCorner.TopEnd -> minY
                MiniCorner.BottomStart, MiniCorner.BottomEnd -> maxY
            },
        )

        val targetOffset = cornerOffset(corner)
        LaunchedEffect(minX, maxX, minY, maxY, corner) {
            if (!initialized) {
                initialized = true
                posAnim.snapTo(targetOffset)
            } else if (!dragging) {
                posAnim.animateTo(
                    targetValue = targetOffset,
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioMediumBouncy,
                        stiffness = Spring.StiffnessMediumLow,
                    ),
                )
            }
        }

        val currentOffset = if (initialized) posAnim.value else targetOffset

        Box(
            modifier = Modifier
                .offset { IntOffset(currentOffset.x.roundToInt(), currentOffset.y.roundToInt()) }
                .size(miniW, miniH)
                .shadow(24.dp, shape)
                .clip(shape)
                .border(1.dp, GlassBorder, shape)
                .onGloballyPositioned { coords ->
                    val rootPos = coords.positionInRoot()
                    onCutoutChanged(
                        MiniCutoutRect(
                            left = rootPos.x,
                            top = rootPos.y,
                            width = coords.size.width.toFloat(),
                            height = coords.size.height.toFloat(),
                            cornerRadiusPx = cornerRadiusPx,
                        ),
                    )
                }
                .pointerInput(Unit) {
                    detectTapGestures {
                        showControls = !showControls
                        touchTick++
                    }
                }
                .pointerInput(minX, maxX, minY, maxY) {
                    val velocityTracker = VelocityTracker()
                    detectDragGestures(
                        onDragStart = {
                            dragging = true
                            velocityTracker.resetTracking()
                        },
                        onDragEnd = {
                            dragging = false
                            val end = posAnim.value
                            val vel = velocityTracker.calculateVelocity()
                            val midX = (minX + maxX) * 0.5f
                            val midY = (minY + maxY) * 0.5f
                            val projectedX = end.x + vel.x * 0.24f
                            val projectedY = end.y + vel.y * 0.24f
                            val goRight = if (abs(vel.x) > 450f) vel.x > 0f else projectedX >= midX
                            val goBottom = if (abs(vel.y) > 450f) vel.y > 0f else projectedY >= midY
                            val snapped = when {
                                !goRight && !goBottom -> MiniCorner.TopStart
                                goRight && !goBottom -> MiniCorner.TopEnd
                                !goRight -> MiniCorner.BottomStart
                                else -> MiniCorner.BottomEnd
                            }
                            if (snapped != corner) {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            }
                            corner = snapped
                            val dest = cornerOffset(snapped)
                            val initialVel = Offset(
                                x = vel.x.coerceIn(-4500f, 4500f),
                                y = vel.y.coerceIn(-4500f, 4500f),
                            )
                            scope.launch {
                                posAnim.animateTo(
                                    targetValue = dest,
                                    initialVelocity = initialVel,
                                    animationSpec = spring(
                                        dampingRatio = 0.78f,
                                        stiffness = Spring.StiffnessMediumLow,
                                    ),
                                )
                            }
                        },
                        onDragCancel = {
                            dragging = false
                            val dest = cornerOffset(corner)
                            scope.launch {
                                posAnim.animateTo(
                                    targetValue = dest,
                                    animationSpec = spring(
                                        dampingRatio = 0.78f,
                                        stiffness = Spring.StiffnessMediumLow,
                                    ),
                                )
                            }
                        },
                    ) { change, dragAmount ->
                        change.consume()
                        val next = Offset(
                            x = (posAnim.value.x + dragAmount.x).coerceIn(minX, maxX),
                            y = (posAnim.value.y + dragAmount.y).coerceIn(minY, maxY),
                        )
                        velocityTracker.addPosition(change.uptimeMillis, next)
                        scope.launch { posAnim.snapTo(next) }
                    }
                },
        ) {
            Slot(host, Modifier.fillMaxSize(), onBoundsInWindow = onSourceRectChanged)
            if (!hasFirstFrame && error == null) {
                Box(Modifier.fillMaxSize().background(Color.Black))
            }

            // Tap-to-reveal obsidian glass controls (auto-hides after 3 s while playing for unobstructed video)
            AnimatedVisibility(
                visible = showControls || !playing || busy,
                enter = fadeIn(tween(180)),
                exit = fadeOut(tween(220)),
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MiniScrim),
                ) {
                    // Top bar: truncated title + circular 32dp glass Expand & Close buttons
                    Row(
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = title,
                            color = Ink,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        MiniGlassIconButton(
                            icon = ExpandMiniIcon,
                            description = "Expand video",
                            onClick = {
                                touchTick++
                                onExpand()
                            },
                        )
                        MiniGlassIconButton(
                            icon = CloseIcon,
                            description = "Close video",
                            onClick = onClose,
                        )
                    }

                    // Center controls: -10s | 44dp Pearl Play/Pause | +10s
                    Row(
                        modifier = Modifier.align(Alignment.Center),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        MiniSeekGlassButton(
                            description = "Back 10 seconds",
                            mirrored = false,
                            onClick = {
                                touchTick++
                                onSeekBack()
                            },
                        )
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .shadow(10.dp, CircleShape)
                                .clip(CircleShape)
                                .background(Pearl)
                                .clickable {
                                    touchTick++
                                    onTogglePlay()
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (busy) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    color = PearlInk,
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                Icon(
                                    imageVector = if (playing) PauseIcon else PlayIcon,
                                    contentDescription = if (playing) "Pause video" else "Play video",
                                    tint = PearlInk,
                                    modifier = Modifier.size(24.dp),
                                )
                            }
                        }
                        MiniSeekGlassButton(
                            description = "Forward 10 seconds",
                            mirrored = true,
                            onClick = {
                                touchTick++
                                onSeekForward()
                            },
                        )
                    }
                }
            }

            // Crisp 2.5dp hairline progress bar along bottom edge (always visible)
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(2.5.dp),
                color = Pearl,
                trackColor = GlassHighlight,
            )
        }
    }
}

@Composable
private fun MiniGlassIconButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(MiniButtonBg)
            .border(1.dp, GlassBorder, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = Ink, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun MiniSeekGlassButton(
    description: String,
    mirrored: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(MiniButtonBg)
            .border(1.dp, GlassBorder, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = ReplayIcon,
            contentDescription = description,
            tint = Ink,
            modifier = Modifier
                .size(22.dp)
                .graphicsLayer { if (mirrored) scaleX = -1f },
        )
        Text(
            text = "10",
            color = Ink,
            fontSize = 8.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 3.dp),
        )
    }
}

/** Backwards-compatible entry point delegating to [VideoSessionHost]. */
@Composable
fun PlayScreen(model: AppModel, host: PlayerHost, entry: Entry, startPositionMs: Long? = null) {
    VideoSessionHost(
        model = model,
        host = host,
        entry = entry,
        startPositionMs = startPositionMs,
        mode = VideoDisplayMode.Fullscreen,
    )
}


private fun resolutionTier(w: Int?, h: Int?): String? {
    if (w == null || h == null || w <= 0 || h <= 0) return null
    return when {
        w >= 3800 || h >= 2100 -> "4K UHD"
        w >= 2500 || h >= 1400 -> "1440p QHD"
        w >= 1900 || h >= 1000 -> "1080p HD"
        w >= 1200 || h >= 700 -> "720p HD"
        else -> "SD"
    }
}

private fun aspectRatioLabel(w: Int, h: Int): String {
    if (h <= 0) return "—"
    val r = w.toDouble() / h.toDouble()
    return when {
        abs(r - 16.0 / 9.0) < 0.06 -> "16:9"
        abs(r - 4.0 / 3.0) < 0.06 -> "4:3"
        else -> String.format(Locale.ROOT, "%.2f:1", r)
    }
}

@Composable
private fun SpecRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Dim, fontSize = 12.sp)
        Text(value, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun PlayerInfoPanel(
    model: AppModel,
    entry: Entry,
    state: PlayerState,
    landscape: Boolean,
    onSelectAudio: (Int) -> Unit,
    onSeek: (Long) -> Unit,
    onClose: () -> Unit,
    onSwitch: (Entry, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val entries by model.entries.collectAsState()
    val status by model.status.collectAsState()
    val episodes = remember(entries, entry.id, entry.seriesKey) {
        if (entry.season == null) emptyList()
        else entries.filter { it.season != null && it.seriesKey == entry.seriesKey }
            .distinctBy { it.id }
            .sortedWith(compareBy({ it.season ?: 0 }, { it.episode ?: 0 }))
    }
    val formats = entries.filter { it.id == entry.id }.distinctBy { it.key }
    val seasons = episodes.mapNotNull { it.seasonLabel }.distinct()
    var season by remember(entry.id) { mutableStateOf(entry.seasonLabel ?: "") }

    val videoTrack = state.tracks.firstOrNull { it.kind == "video" }
    val audioTracks = state.tracks.filter { it.kind == "audio" }
    val subTracks = state.tracks.filter { it.kind == "subtitle" }
    val activeAudio = audioTracks.firstOrNull { it.stream == state.audio } ?: audioTracks.firstOrNull()
    val activeSub = subTracks.firstOrNull { it.stream == state.subtitle }

    val resBadge = resolutionTier(state.videoWidth, state.videoHeight)
    val vBadge = videoTrack?.let { prettyCodec(it.codec) }
    val aBadge = activeAudio?.let { prettyCodec(it.codec) }
    val decRaw = state.videoDecoder
    val isHw = decRaw?.lowercase(Locale.ROOT)?.let { "mediacodec" in it || "hardware" in it || "hw" in it } == true

    val depthSuffix = listOfNotNull(
        state.videoBitDepth?.let { "${it}-bit" },
        state.videoChroma,
    ).joinToString(" ").let { if (it.isNotEmpty()) " · $it" else "" }
    val pictureSpec = when {
        state.videoWidth != null && state.videoHeight != null && vBadge != null ->
            "${state.videoWidth} × ${state.videoHeight} (${aspectRatioLabel(state.videoWidth, state.videoHeight)}) · $vBadge$depthSuffix"
        state.videoWidth != null && state.videoHeight != null ->
            "${state.videoWidth} × ${state.videoHeight} (${aspectRatioLabel(state.videoWidth, state.videoHeight)})$depthSuffix"
        vBadge != null -> "$vBadge$depthSuffix"
        else -> "Probing stream…"
    }
    val dynamicSpec = state.videoDynamicRange ?: "SDR"
    val decoderSpec = if (!decRaw.isNullOrBlank()) "$decRaw · ${state.droppedFrames} dropped" else "${state.droppedFrames} dropped frames"
    val bitrateSpec = state.durationMs?.takeIf { it > 1000L && entry.size > 0L }?.let { durMs ->
        val mbps = (entry.size.toDouble() * 8.0) / (durMs.toDouble() / 1000.0) / 1_000_000.0
        String.format(Locale.ROOT, "%.1f Mbps avg · %s", mbps, formatBytes(entry.size))
    } ?: formatBytes(entry.size)
    val audioSpec = activeAudio?.let { a ->
        val lang = (a.language ?: a.title ?: "Default").uppercase(Locale.ROOT)
        val outTxt = state.audioOutput?.let { " · $it" } ?: ""
        "$lang · ${prettyCodec(a.codec)}$outTxt"
    } ?: (state.audioOutput ?: "None")
    val subSpec = when {
        subTracks.isEmpty() -> "None"
        activeSub != null -> "${(activeSub.language ?: activeSub.title ?: "Active").uppercase(Locale.ROOT)} · ${prettyCodec(activeSub.codec)} (of ${subTracks.size})"
        else -> "Off · ${subTracks.size} available (${subTracks.map { prettyCodec(it.codec) }.distinct().joinToString()})"
    }
    val sourceSpec = when {
        entry.local || (entry.size > 0 && entry.cachedBytes >= entry.size) -> "Saved on device · ${formatBytes(entry.size)}"
        entry.cachedBytes > 0 && entry.size > 0 -> "${formatBytes(entry.cachedBytes)} buffered (${((entry.cachedBytes * 100) / entry.size)}%)"
        else -> "Live P2P stream"
    }

    val badges = buildList {
        resBadge?.let { add(it to Brand) }
        state.videoDynamicRange?.takeIf { it != "SDR" }?.let { add(it to Accent) }
        vBadge?.let { add(it to Ink) }
        aBadge?.let { add(it to Ink) }
        decRaw?.takeIf { it.isNotBlank() }?.let { add("${if (isHw) "HW" else "SW"} · $it" to if (isHw) Accent else Dim) }
    }

    Column(
        modifier
            .windowInsetsPadding(WindowInsets.displayCutout)
            .padding(14.dp)
            .widthIn(max = 400.dp)
            .fillMaxWidth()
            .heightIn(max = if (landscape) 440.dp else 540.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(OverlayPanelBg)
            .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(22.dp))
            .verticalScroll(rememberScrollState())
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(entry.title, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(entry.episodeLabel, color = Dim, fontSize = 12.sp)
            }
            CinemaIcon(CloseIcon, "Close content info", Ink, onClose)
        }
        if (badges.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                badges.forEach { (txt, tint) ->
                    Text(
                        txt,
                        color = tint,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(Color.White.copy(alpha = 0.07f))
                            .border(1.dp, Color.White.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Color.Black.copy(alpha = 0.36f))
                .border(1.dp, Line, RoundedCornerShape(14.dp))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SpecRow("Video", pictureSpec)
            SpecRow("Dynamic Range", dynamicSpec)
            SpecRow("Decoder", decoderSpec)
            SpecRow("Bitrate", bitrateSpec)
            SpecRow("Audio", audioSpec)
            SpecRow("Subtitles", subSpec)
            SpecRow("Source", sourceSpec)
        }
        if (state.chapters.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("CHAPTERS", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    state.chapters.forEach { chap ->
                        val active = state.positionMs >= chap.startMs && (chap.endMs == null || state.positionMs < chap.endMs)
                        FilterChip(
                            selected = active,
                            onClick = { onSeek(chap.startMs) },
                            label = { Text("${clock(chap.startMs)} · ${chap.title}", fontSize = 12.sp) },
                        )
                    }
                }
            }
        }
        if (audioTracks.size > 1) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("AUDIO TRACKS", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    audioTracks.forEach { t ->
                        val sel = t.stream == activeAudio?.stream
                        FilterChip(
                            selected = sel,
                            onClick = { onSelectAudio(t.stream) },
                            label = { Text("${(t.language ?: t.title ?: "Track ${t.stream}").uppercase(Locale.ROOT)} · ${prettyCodec(t.codec)}", fontSize = 12.sp) },
                        )
                    }
                }
            }
        }
        if (formats.size > 1) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("VERSIONS", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                formats.forEach { format ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (format.key == entry.key) Brand.copy(alpha = .20f) else Color.White.copy(alpha = 0.04f))
                            .clickable { if (format.key != entry.key) onSwitch(format, true) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "${formatBytes(format.size)} · ${if (format.local) "Saved" else "Stream"}",
                            color = if (format.key == entry.key) Brand else Ink,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f),
                        )
                        if (format.key == entry.key) Icon(CheckIcon, "Selected format", tint = Brand, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
        if (episodes.size > 1) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("EPISODES", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                if (seasons.size > 1) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        seasons.forEach { s -> FilterChip(selected = season == s, onClick = { season = s }, label = { Text(s) }) }
                    }
                }
                Column(Modifier.heightIn(max = 176.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    episodes.filter { seasons.size <= 1 || it.seasonLabel == season }.forEach { episode ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (episode.id == entry.id) Brand.copy(alpha = .20f) else Color.White.copy(alpha = 0.04f))
                                .clickable { if (episode.id != entry.id) onSwitch(episode, false) }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(episode.episodeLabel, color = if (episode.id == entry.id) Brand else Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(formatBytes(episode.size), color = Dim, fontSize = 12.sp, modifier = Modifier.padding(end = 8.dp))
                            if (episode.id == entry.id) Icon(PlayIcon, "Playing", tint = Brand, modifier = Modifier.size(16.dp))
                        }
                    }
                }
            }
        }
        p2pSummary(status)?.let { Text(it, color = Brand, fontSize = 11.sp) }
    }
}

// Darker at the edges, where the buttons and the clock are.
private val Scrim = Brush.verticalGradient(
    0f to Color.Black.copy(alpha = 0.6f),
    0.3f to Color.Black.copy(alpha = 0.15f),
    0.6f to Color.Black.copy(alpha = 0.15f),
    1f to Color.Black.copy(alpha = 0.75f),
)

/** Where the native picture goes: PlayerHost keeps its views over this box. */
@Composable
private fun Slot(
    host: PlayerHost,
    modifier: Modifier,
    onBoundsInWindow: ((Rect) -> Unit)? = null,
) {
    Box(
        modifier.onGloballyPositioned {
            val b = it.boundsInWindow()
            val left = b.left.roundToInt()
            val top = b.top.roundToInt()
            val width = b.width.roundToInt()
            val height = b.height.roundToInt()
            host.place(left, top, width, height)
            if (width > 0 && height > 0) {
                onBoundsInWindow?.invoke(Rect(left, top, left + width, top + height))
            }
        },
    )
}

@Composable
private fun OverlayButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    size: Dp = 48.dp,
    iconSize: Dp = 26.dp,
    filled: Boolean = false,
    badge: String? = null,
    mirrored: Boolean = false,
) {
    Box(
        Modifier.size(size).clip(CircleShape)
            .background(if (filled) Color.Black.copy(alpha = 0.45f) else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = Color.White, modifier = Modifier.size(iconSize).graphicsLayer { if (mirrored) scaleX = -1f })
        // The replay arrow's circle sits a little below the middle of its box.
        badge?.let { Text(it, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp)) }
    }
}

/** A thin bar, thicker under the finger: tap or drag to seek. [fraction] is the position. */
@Composable
private fun SeekBar(fraction: Float, enabled: Boolean, onScrub: (Float) -> Unit, onCommit: (Float) -> Unit) {
    val scrub by rememberUpdatedState(onScrub)
    val commit by rememberUpdatedState(onCommit)
    var active by remember { mutableStateOf(false) }
    var dragFraction by remember { mutableStateOf(0f) }
    Canvas(
        Modifier.fillMaxWidth().height(44.dp)
            .semantics { contentDescription = "Seek" }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures {
                    val f = (it.x / size.width).coerceIn(0f, 1f)
                    scrub(f)
                    commit(f)
                }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures(
                    onDragStart = {
                        active = true
                        dragFraction = (it.x / size.width).coerceIn(0f, 1f)
                        scrub(dragFraction)
                    },
                    onDragEnd = {
                        active = false
                        commit(dragFraction)
                    },
                    onDragCancel = {
                        active = false
                        commit(dragFraction)
                    },
                ) { change, _ ->
                    change.consume()
                    dragFraction = (change.position.x / size.width).coerceIn(0f, 1f)
                    scrub(dragFraction)
                }
            },
    ) {
        val y = size.height / 2
        val x = size.width * fraction.coerceIn(0f, 1f)
        val stroke = (if (active) 5.dp else 3.dp).toPx()
        drawLine(Color.White.copy(alpha = 0.35f), Offset(0f, y), Offset(size.width, y), stroke, StrokeCap.Round)
        drawLine(Brand, Offset(0f, y), Offset(x, y), stroke, StrokeCap.Round)
        if (enabled) drawCircle(Brand, (if (active) 9.dp else 6.dp).toPx(), Offset(x, y))
    }
}

private data class Option(val label: String, val stream: Int, val selected: Boolean)

/** A menu of tracks, opened from [anchor]; the current one is ticked. */
@Composable
private fun TrackPicker(options: List<Option>, onSelect: (Int) -> Unit, onOpen: (Boolean) -> Unit, anchor: @Composable (open: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val notify by rememberUpdatedState(onOpen)
    val set = { value: Boolean ->
        open = value
        notify(value)
    }
    // Turning the phone swaps the chips below the picture for the fullscreen top bar; a picker
    // that leaves with its menu up must not keep the controls from hiding.
    DisposableEffect(Unit) { onDispose { if (open) notify(false) } }
    Box {
        anchor { set(true) }
        DropdownMenu(expanded = open, onDismissRequest = { set(false) }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label, color = Ink) },
                    leadingIcon = {
                        if (option.selected) Icon(CheckIcon, "Selected", tint = Brand) else Spacer(Modifier.size(24.dp))
                    },
                    onClick = {
                        set(false)
                        onSelect(option.stream)
                    },
                )
            }
        }
    }
}



internal tailrec fun Context.activity(): Activity = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> error("The play screen needs an activity")
}
