package com.peartube.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import android.view.OrientationEventListener
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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
import com.peartube.app.formatBytes
import com.peartube.app.label
import com.peartube.app.p2pSummary
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerHost
import com.peartube.app.player.PlayerState
import com.peartube.app.player.Track
import kotlinx.coroutines.delay
import java.io.File
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.runtime.key

/** An edge-to-edge cinema, with content details tucked behind the info control. */
@Composable
fun PlayScreen(model: AppModel, host: PlayerHost, entry: Entry, startPositionMs: Long? = null) {
    val context = LocalContext.current
    val activity = remember(context) { context.activity() }
    val view = LocalView.current
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
    val liveEntry = remember(entries, entry) { entries.firstOrNull { it.key == entry.key } ?: entry }
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
    val resumePosition = remember(entry.key) { startPositionMs ?: model.watchHistory.value[entry.key]?.takeIf { it.partial }?.positionMs ?: 0L }
    var resumePending by remember(entry.key) { mutableStateOf(resumePosition > 0) }
    val latestState by rememberUpdatedState(state)

    DisposableEffect(entry.streamUrl) {
        host.open()
        val soundfont = File(context.filesDir, "soundfont.sf2").takeIf { it.isFile }?.path
        val opened = try {
            NativePlayer.open(entry.streamUrl, soundfont)
        } catch (e: Throwable) {
            openError = "The player did not start: ${e.message ?: e}"
            0L
        }
        handle = opened
        onDispose {
            model.recordWatchProgress(entry, latestState.positionMs, latestState.durationMs)
            handle = 0L
            host.close()
            if (opened != 0L) NativePlayer.close(opened)
        }
    }

    // The worklet serving the stream suspends with the app; so does the player.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, handle) {
        val h = handle
        val observer = LifecycleEventObserver { _, event ->
            if (h == 0L) return@LifecycleEventObserver
            when (event) {
                Lifecycle.Event.ON_STOP -> NativePlayer.suspend(h)
                Lifecycle.Event.ON_START -> NativePlayer.resume(h)
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Events come on change; the clock needs a steadier beat, so poll.
    LaunchedEffect(handle) {
        val h = handle
        if (h == 0L) return@LaunchedEffect
        var ticks = 0
        while (true) {
            val st = PlayerState.parse(NativePlayer.state(h))
            st.displayAspect?.let { host.fit(it) }
            st.videoFps?.let { host.matchFrameRate(it) }
            host.shown(st.positionMs)
            state = st
            if (resumePending && st.durationMs != null) {
                resumePending = false
                NativePlayer.seek(h, resumePosition.coerceAtMost(st.durationMs))
            }
            if (ticks++ % 16 == 0 || st.ended) model.recordWatchProgress(entry, st.positionMs, st.durationMs)
            // A seek is done once the player is near it; it may land on an earlier keyframe.
            target?.let {
                val timeoutMs = if (st.buffering) 12_000L else 2_500L
                if (!scrubbing && ((!st.buffering && abs(st.positionMs - it) < 1_500) || SystemClock.uptimeMillis() - seekedAt > timeoutMs)) target = null
            }
            if (st.ended) {
                model.screen.value = Screen.List
                break
            }
            delay(250)
        }
    }

    LaunchedEffect(controls, state.playing, touches, scrubbing, menuOpen, infoOpen) {
        if (controls && state.playing && !scrubbing && !menuOpen && !infoOpen) {
            delay(3_000)
            controls = false
        }
    }

    val exitOrientation = if (isTv) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    DisposableEffect(activity, exitOrientation) {
        activity.immersive(true, view)
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose {
            activity.requestedOrientation = exitOrientation
            activity.immersive(false, view)
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    LaunchedEffect(landscapeMode, isTv) {
        activity.requestedOrientation = when {
            isTv -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            landscapeMode -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    val length = state.durationMs ?: 0L
    val shown = target ?: state.positionMs
    val error = openError ?: state.error
    val busy = handle != 0L && state.buffering && error == null

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
        activity.immersive(false, view)
        activity.requestedOrientation = exitOrientation
        model.screen.value = Screen.List
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
    BackHandler { if (infoOpen) infoOpen = false else if (!isTv && landscapeMode) landscapeMode = false else leave() }

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

    val overlay: @Composable () -> Unit = {
        Box(
            Modifier.fillMaxSize()
                // The clock as well, for TalkBack and for android/e2e.mjs: the controls hide.
                .semantics { contentDescription = "Video, $clockText" }
                .pointerInput(Unit) {
                    detectTapGestures {
                        controls = !controls
                        touches++
                    }
                },
        ) {
            AnimatedVisibility(controls || !state.playing || infoOpen, enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.fillMaxSize().background(Scrim)) {
                    Row(
                        Modifier.align(Alignment.TopStart).fillMaxWidth()
                            .statusBarsPadding()
                            .windowInsetsPadding(WindowInsets.displayCutout)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        OverlayButton(BackIcon, "Back", ::leave)
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
                        OverlayButton(CastIcon, "Cast to TV", {
                            model.recordWatchProgress(liveEntry, state.positionMs, state.durationMs)
                            model.castEntryOrSheet(liveEntry, state.positionMs)
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

    val hasFirstFrame = state.videoWidth != null && (!state.buffering || state.positionMs > 0L)
    Box(Modifier.fillMaxSize()) {
        Slot(host, Modifier.fillMaxSize())
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
                onClose = { infoOpen = false },
                onSwitch = { next, preserveTime ->
                    model.recordWatchProgress(liveEntry, state.positionMs, state.durationMs)
                    model.screen.value = Screen.Play(next, if (preserveTime) state.positionMs else null)
                },
                modifier = Modifier.align(if (landscape) Alignment.CenterEnd else Alignment.BottomCenter),
            )
        }
    }
}

private fun prettyCodec(raw: String): String = when (raw.lowercase(Locale.ROOT)) {
    "hevc", "h265" -> "HEVC · H.265"
    "h264", "avc", "avc1" -> "AVC · H.264"
    "av1" -> "AV1"
    "vp9" -> "VP9"
    "vp8" -> "VP8"
    "mpeg4", "xvid", "divx" -> "MPEG-4"
    "mpeg2video", "mpeg2" -> "MPEG-2"
    "vc1" -> "VC-1"
    "eac3", "ec-3" -> "Dolby E-AC-3"
    "ac3" -> "Dolby AC-3"
    "truehd" -> "Dolby TrueHD"
    "dts", "dca" -> "DTS"
    "flac" -> "FLAC Lossless"
    "alac" -> "ALAC Lossless"
    "aac" -> "AAC"
    "opus" -> "Opus"
    "vorbis" -> "Vorbis"
    "mp3" -> "MP3"
    "subrip", "srt" -> "SubRip"
    "ass", "ssa" -> "ASS"
    "hdmv_pgs_subtitle", "pgs" -> "PGS"
    "dvd_subtitle", "vobsub" -> "VobSub"
    else -> raw.uppercase(Locale.ROOT)
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
    onClose: () -> Unit,
    onSwitch: (Entry, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val entries by model.entries.collectAsState()
    val status by model.status.collectAsState()
    val showId = Regex("(?i)(?:imdb:)?(tt\\d+)").find(entry.id)?.groupValues?.get(1)
    val episodes = remember(entries, entry.id) {
        if (label(entry.id) == "Movie") emptyList()
        else entries.filter { candidate ->
            label(candidate.id) != "Movie" &&
                (candidate.title == entry.title || (showId != null &&
                    Regex("(?i)(?:imdb:)?(tt\\d+)").find(candidate.id)?.groupValues?.get(1) == showId))
        }.distinctBy { it.id }.sortedBy { episodeOrder(it.id) }
    }
    val formats = entries.filter { it.id == entry.id }.distinctBy { it.key }
    val seasons = episodes.map { label(it.id).substringBefore('E') }.distinct()
    var season by remember(entry.id) { mutableStateOf(label(entry.id).substringBefore('E')) }

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

    val pictureSpec = when {
        state.videoWidth != null && state.videoHeight != null && vBadge != null ->
            "${state.videoWidth} × ${state.videoHeight} (${aspectRatioLabel(state.videoWidth, state.videoHeight)}) · $vBadge"
        state.videoWidth != null && state.videoHeight != null ->
            "${state.videoWidth} × ${state.videoHeight} (${aspectRatioLabel(state.videoWidth, state.videoHeight)})"
        vBadge != null -> vBadge
        else -> "Probing stream…"
    }
    val decoderSpec = if (!decRaw.isNullOrBlank()) "$decRaw · ${state.droppedFrames} dropped" else "${state.droppedFrames} dropped frames"
    val bitrateSpec = state.durationMs?.takeIf { it > 1000L && entry.size > 0L }?.let { durMs ->
        val mbps = (entry.size.toDouble() * 8.0) / (durMs.toDouble() / 1000.0) / 1_000_000.0
        String.format(Locale.ROOT, "%.1f Mbps avg · %s", mbps, formatBytes(entry.size))
    } ?: formatBytes(entry.size)
    val audioSpec = activeAudio?.let { a ->
        val lang = (a.language ?: a.title ?: "Default").uppercase(Locale.ROOT)
        val count = if (audioTracks.size > 1) " (${audioTracks.size} tracks)" else ""
        "$lang · ${prettyCodec(a.codec)}$count"
    } ?: "None"
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
            .background(Color(0xF00F131C))
            .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(22.dp))
            .verticalScroll(rememberScrollState())
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(entry.title, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(label(entry.id), color = Dim, fontSize = 12.sp)
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
            SpecRow("Decoder", decoderSpec)
            SpecRow("Bitrate", bitrateSpec)
            SpecRow("Audio", audioSpec)
            SpecRow("Subtitles", subSpec)
            SpecRow("Source", sourceSpec)
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
                    episodes.filter { seasons.size <= 1 || label(it.id).startsWith(season) }.forEach { episode ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(if (episode.id == entry.id) Brand.copy(alpha = .20f) else Color.White.copy(alpha = 0.04f))
                                .clickable { if (episode.id != entry.id) onSwitch(episode, false) }
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(label(episode.id), color = if (episode.id == entry.id) Brand else Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
private fun Slot(host: PlayerHost, modifier: Modifier) {
    Box(
        modifier.onGloballyPositioned {
            val b = it.boundsInWindow()
            host.place(b.left.roundToInt(), b.top.roundToInt(), b.width.roundToInt(), b.height.roundToInt())
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


internal fun clock(ms: Long): String {
    val s = ms.coerceAtLeast(0L) / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    else "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}

/**
 * Fullscreen hides the system bars and lays the window out edge to edge, past the camera
 * cutout: the picture centres on the whole display, and the controls pad themselves clear
 * of the cutout.
 */
internal fun Activity.immersive(on: Boolean, view: View) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val bars = WindowCompat.getInsetsController(window, view)
    if (on) {
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
    } else {
        bars.isAppearanceLightStatusBars = false
        bars.isAppearanceLightNavigationBars = false
        bars.show(WindowInsetsCompat.Type.systemBars())
    }
    window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (on) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
    }
}

internal tailrec fun Context.activity(): Activity = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> error("The play screen needs an activity")
}
