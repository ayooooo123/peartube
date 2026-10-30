package com.peartube.receiver

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerHost
import com.peartube.app.player.PlayerState
import com.peartube.app.player.Track
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.min
import kotlin.math.roundToInt

private val TvBg = Color(0xFF0A0C10)
private val TvCard = Color(0xFF131720)
private val TvCardElevated = Color(0xFF1C2230)
private val TvLine = Color(0xFF232A38)
private val TvInk = Color(0xFFF3F5FA)
private val TvDim = Color(0xFF8A93A6)
private val TvBrand = Color(0xFF9147FF)
private val TvAccent = Color(0xFF4ADE80)
private val TvDanger = Color(0xFFFF6B6B)

private val TvScrim = Brush.verticalGradient(
    0f to Color.Black.copy(alpha = 0.78f),
    0.26f to Color.Transparent,
    0.62f to Color.Transparent,
    1f to Color.Black.copy(alpha = 0.90f),
)

class ReceiverActivity : ComponentActivity() {
    private lateinit var player: PlayerHost

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val worker = (application as ReceiverApp).worker
        player = PlayerHost(this)
        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = TvBrand,
                    background = TvBg,
                    surface = TvBg,
                    onBackground = TvInk,
                    onSurface = TvInk,
                ),
            ) {
                DumbTvReceiverScreen(activity = this, worker = worker, host = player)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        (application as ReceiverApp).worker.activityResumed = true
    }

    override fun onPause() {
        (application as ReceiverApp).worker.activityResumed = false
        super.onPause()
    }

    override fun onDestroy() {
        player.destroy()
        super.onDestroy()
    }
}

@Composable
private fun TvQrCode(data: String, modifier: Modifier = Modifier) {
    val matrix = remember(data) {
        QRCodeWriter().encode(
            data,
            BarcodeFormat.QR_CODE,
            1,
            1,
            mapOf(
                EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
                EncodeHintType.MARGIN to 3,
            ),
        )
    }
    Canvas(modifier.aspectRatio(1f).clip(RoundedCornerShape(18.dp)).background(Color.White)) {
        val module = (min(size.width, size.height) / matrix.width).toInt()
        if (module > 0) {
            val left = ((size.width - matrix.width * module) / 2).toInt()
            val top = ((size.height - matrix.height * module) / 2).toInt()
            for (y in 0 until matrix.height) {
                for (x in 0 until matrix.width) {
                    if (matrix[x, y]) {
                        drawRect(
                            Color.Black,
                            Offset((left + x * module).toFloat(), (top + y * module).toFloat()),
                            Size(module.toFloat(), module.toFloat()),
                        )
                    }
                }
            }
        }
    }
}

private fun formatClock(ms: Long): String {
    val s = ms.coerceAtLeast(0L) / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    else "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}

private fun formatStorageFree(bytes: Long, external: Boolean): String? {
    if (bytes <= 0L) return null
    val gb = bytes.toDouble() / (1024.0 * 1024.0 * 1024.0)
    val sizeTxt = if (gb >= 950.0) String.format(Locale.US, "%.2f TB", gb / 1024.0)
    else String.format(Locale.US, "%.1f GB", gb)
    return if (external) "$sizeTxt external seed drive ready" else "$sizeTxt internal seed storage · external drive not in use"
}

private fun prettyCodec(raw: String): String = when (raw.lowercase(Locale.ROOT)) {
    "h264", "avc", "avc1" -> "H.264"
    "h265", "hevc", "hev1", "hvc1" -> "HEVC"
    "av1", "av01" -> "AV1"
    "vp9" -> "VP9"
    "truehd", "mlp" -> "TrueHD"
    "eac3" -> "E-AC-3"
    "ac3" -> "AC-3"
    "dts", "dca" -> "DTS"
    "flac" -> "FLAC"
    "alac" -> "ALAC"
    "aac" -> "AAC"
    "opus" -> "Opus"
    "vorbis" -> "Vorbis"
    "mp3" -> "MP3"
    "subrip", "srt" -> "SRT"
    "ass", "ssa" -> "ASS"
    "hdmv_pgs_subtitle", "pgs" -> "PGS"
    "dvd_subtitle", "vobsub" -> "VobSub"
    else -> raw.uppercase(Locale.ROOT)
}

private fun shortTrackBadge(track: Track?): String {
    if (track == null) return "None"
    val lang = (track.language ?: track.title ?: "#${track.stream}").trim().uppercase(Locale.ROOT)
    return "$lang · ${prettyCodec(track.codec)}"
}

private fun fullTrackTitle(track: Track): String {
    val parts = buildList {
        track.title?.takeIf { it.isNotBlank() }?.let(::add)
        track.language?.takeIf { it.isNotBlank() }?.uppercase(Locale.ROOT)?.let(::add)
        add(prettyCodec(track.codec))
    }
    return parts.distinct().joinToString(" · ")
}

private fun Activity.setImmersive(on: Boolean, view: View) {
    WindowCompat.setDecorFitsSystemWindows(window, !on)
    val bars = WindowCompat.getInsetsController(window, view)
    if (on) {
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
    } else {
        bars.show(WindowInsetsCompat.Type.systemBars())
    }
}

private fun tracksSignature(st: PlayerState): String =
    "${st.tracks.size}:${st.tracks.firstOrNull()?.stream ?: -1}:${st.tracks.lastOrNull()?.stream ?: -1}"

private fun playerStateJson(
    st: PlayerState,
    endedOverride: Boolean = st.ended,
    includeTracks: Boolean = true,
): JSONObject {
    val obj = JSONObject()
        .put("positionMs", st.positionMs)
        .put("durationMs", st.durationMs ?: JSONObject.NULL)
        .put("playing", st.playing && !endedOverride)
        .put("buffering", st.buffering && !endedOverride)
        .put("ended", endedOverride)
        .put("error", st.error ?: JSONObject.NULL)
        .put("audio", st.audio ?: -1)
        .put("subtitle", st.subtitle ?: -1)
        .put("videoDecoder", st.videoDecoder ?: JSONObject.NULL)
        .put("droppedFrames", st.droppedFrames)
    // Only pack the full track catalog when it actually changed, sparing QuickJS and Kotlin repeated 48-track JSON churn.
    if (includeTracks) {
        val tracks = JSONArray().apply {
            st.tracks.forEach { t ->
                put(
                    JSONObject()
                        .put("stream", t.stream)
                        .put("kind", t.kind)
                        .put("codec", t.codec)
                        .put("language", t.language ?: JSONObject.NULL)
                        .put("title", t.title ?: JSONObject.NULL),
                )
            }
        }
        obj.put("tracks", tracks)
    }
    return obj
}

@Composable
private fun TvControlButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Color = TvInk,
    primary: Boolean = false,
    onInteraction: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val bg = when {
        focused && primary -> TvBrand
        focused -> TvCardElevated
        primary -> TvBrand.copy(alpha = 0.82f)
        else -> Color.Black.copy(alpha = 0.62f)
    }
    val borderCol = when {
        focused -> TvAccent
        primary -> TvBrand
        else -> Color.White.copy(alpha = 0.18f)
    }
    Box(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(bg)
            .border(if (focused) 2.dp else 1.dp, borderCol, RoundedCornerShape(14.dp))
            .onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onInteraction()
            }
            .clickable {
                onInteraction()
                onClick()
            }
            .padding(horizontal = 18.dp, vertical = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (focused && !primary && accent == TvInk) Color.White else accent,
            fontSize = 15.sp,
            fontWeight = if (focused || primary) FontWeight.Bold else FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun TvSeekBar(
    positionMs: Long,
    durationMs: Long?,
    onSeek: (Long) -> Unit,
    onInteraction: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    var barWidthPx by remember { mutableIntStateOf(1) }
    val dur = (durationMs ?: 0L).coerceAtLeast(0L)
    val frac = if (dur > 0L) (positionMs.toFloat() / dur.toFloat()).coerceIn(0f, 1f) else 0f

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (focused) Color.White.copy(alpha = 0.08f) else Color.Transparent)
            .border(if (focused) 1.5.dp else 0.dp, if (focused) TvAccent else Color.Transparent, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onInteraction()
            }
            .onPreviewKeyEvent { ev ->
                if (!focused || ev.type != KeyEventType.KeyDown || dur <= 0L) return@onPreviewKeyEvent false
                when (ev.nativeKeyEvent.keyCode) {
                    KeyEvent.KEYCODE_DPAD_LEFT -> {
                        onInteraction()
                        onSeek((positionMs - 10_000L).coerceAtLeast(0L))
                        true
                    }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        onInteraction()
                        onSeek((positionMs + 10_000L).coerceAtMost(dur))
                        true
                    }
                    else -> false
                }
            }
            .focusable()
            .onGloballyPositioned { barWidthPx = it.size.width.coerceAtLeast(1) }
            .pointerInput(dur) {
                if (dur > 0L) {
                    detectTapGestures { offset ->
                        onInteraction()
                        val target = ((offset.x / barWidthPx.toFloat()).coerceIn(0f, 1f) * dur.toFloat()).toLong()
                        onSeek(target)
                    }
                }
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(if (focused) 12.dp else 8.dp), contentAlignment = Alignment.CenterStart) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(if (focused) 8.dp else 6.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.24f)),
            )
            Box(
                Modifier
                    .fillMaxWidth(frac)
                    .height(if (focused) 8.dp else 6.dp)
                    .clip(CircleShape)
                    .background(if (focused) TvAccent else TvBrand),
            )
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "${formatClock(positionMs)} / ${durationMs?.let(::formatClock) ?: "--:--"}",
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
            )
            if (focused) {
                Text(
                    "◀ / ▶ Scrub ±10s",
                    color = TvAccent,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

private enum class TvOverlaySheet { Audio, Subtitles, Info }

@Composable
private fun DumbTvReceiverScreen(activity: Activity, worker: ReceiverWorker, host: PlayerHost) {
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val info by worker.info.collectAsState()
    val workerErr by worker.error.collectAsState()

    var handle by remember { mutableLongStateOf(0L) }
    var activeTitle by remember { mutableStateOf("PearTube Cast") }
    var initialMode by remember { mutableStateOf("http") }
    var state by remember { mutableStateOf(PlayerState()) }
    var openError by remember { mutableStateOf<String?>(null) }
    var pendingSeekMs by remember { mutableStateOf<Long?>(null) }
    var hudVisible by remember { mutableStateOf(true) }
    var hudTouches by remember { mutableIntStateOf(0) }
    var overlaySheet by remember { mutableStateOf<TvOverlaySheet?>(null) }

    val stageFocus = remember { FocusRequester() }
    val playBtnFocus = remember { FocusRequester() }
    val sheetFirstFocus = remember { FocusRequester() }

    fun touchHud() {
        hudVisible = true
        hudTouches++
    }

    fun syncStateSoon() {
        val h = handle
        if (h == 0L) return
        scope.launch {
            delay(80)
            if (handle == h) {
                runCatching { PlayerState.parse(NativePlayer.state(h)) }.getOrNull()?.let { snap ->
                    state = snap
                    runCatching { worker.reportState(playerStateJson(snap)) }
                }
            }
        }
    }

    fun closeStream() {
        val h = handle
        handle = 0L
        overlaySheet = null
        worker.isStreaming = false
        pendingSeekMs = null
        state = PlayerState()
        if (h != 0L) {
            host.close()
            NativePlayer.close(h)
        }
    }

    fun stopAndReport() {
        scope.launch {
            runCatching {
                worker.reportState(
                    JSONObject()
                        .put("idle", true)
                        .put("playing", false)
                        .put("buffering", false)
                        .put("ended", true)
                        .put("positionMs", 0),
                )
            }
        }
        closeStream()
    }

    DisposableEffect(Unit) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val tvName = Build.MODEL?.takeIf { it.isNotBlank() }?.let { "PearTube TV · $it" } ?: "PearTube TV"
        scope.launch {
            runCatching { worker.ensureStarted(tvName, openAuth = true, forceRefreshStorage = true) }
                .onFailure { openError = it.message }
        }
        onDispose {
            closeStream()
            activity.setImmersive(false, view)
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    DisposableEffect(handle != 0L) {
        val playingVideo = handle != 0L
        activity.setImmersive(playingVideo, view)
        if (playingVideo) {
            view.requestFocus()
            runCatching { playBtnFocus.requestFocus() }
        }
        onDispose {}
    }

    LaunchedEffect(hudVisible, overlaySheet, handle) {
        if (overlaySheet != null) {
            delay(80)
            runCatching { sheetFirstFocus.requestFocus() }
        } else if (handle != 0L && hudVisible) {
            delay(80)
            runCatching { playBtnFocus.requestFocus() }
        }
    }

    LaunchedEffect(Unit) {
        worker.commands.collect { cmd ->
            if (cmd.seq <= worker.lastHandledSeq) return@collect
            worker.lastHandledSeq = cmd.seq
            touchHud()
            when (cmd.action) {
                "load" -> {
                    val url = cmd.streamUrl ?: cmd.httpStreamUrl
                    if (url.isNullOrBlank()) {
                        openError = "Cast load arrived without a playable stream URL"
                        return@collect
                    }
                    closeStream()
                    openError = null
                    overlaySheet = null
                    activeTitle = cmd.title
                    initialMode = cmd.mode ?: "http"
                    pendingSeekMs = cmd.startPositionMs.takeIf { it > 0L }
                    host.open()
                    val opened = runCatching { NativePlayer.open(url, null) }
                        .onFailure {
                            host.close()
                            openError = "Player could not start: ${it.message}"
                        }
                        .getOrDefault(0L)
                    if (opened != 0L) {
                        handle = opened
                        worker.isStreaming = true
                    } else {
                        host.close()
                    }
                }
                "play" -> if (handle != 0L) { NativePlayer.play(handle); syncStateSoon() }
                "pause" -> if (handle != 0L) { NativePlayer.pause(handle); syncStateSoon() }
                "togglePlay" -> if (handle != 0L) {
                    if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
                    syncStateSoon()
                }
                "seek" -> if (handle != 0L && cmd.positionMs != null) {
                    NativePlayer.seek(handle, cmd.positionMs.coerceAtLeast(0L))
                    syncStateSoon()
                }
                "skip" -> if (handle != 0L && cmd.deltaMs != null) {
                    val next = (state.positionMs + cmd.deltaMs).coerceAtLeast(0L)
                    val clamped = state.durationMs?.let { next.coerceAtMost(it) } ?: next
                    NativePlayer.seek(handle, clamped)
                    syncStateSoon()
                }
                "selectAudio" -> if (handle != 0L && cmd.stream != null) {
                    NativePlayer.selectAudio(handle, cmd.stream)
                    syncStateSoon()
                }
                "selectSubtitle" -> if (handle != 0L) {
                    NativePlayer.selectSubtitle(handle, cmd.stream ?: -1)
                    syncStateSoon()
                }
                "stop" -> closeStream()
            }
        }
    }

    // Hold the freshest snapshot off-Compose so hidden-HUD movie playback causes zero UI recompositions.
    val latestHolder = remember(handle) { object { var snap: PlayerState? = null; var reportedTracksSig: String = "" } }

    LaunchedEffect(hudVisible, overlaySheet, handle) {
        if ((hudVisible || overlaySheet != null) && handle != 0L) {
            val snap = runCatching { PlayerState.parse(NativePlayer.state(handle)) }.getOrNull() ?: latestHolder.snap
            if (snap != null) {
                latestHolder.snap = snap
                state = snap
            }
        }
    }

    LaunchedEffect(handle) {
        val h = handle
        if (h == 0L) return@LaunchedEffect
        var ticks = 0
        while (handle == h) {
            val uiOpen = hudVisible || overlaySheet != null
            val fast = uiOpen || pendingSeekMs != null || state.buffering
            if (fast || ticks % 4 == 0) {
                val snap = runCatching { PlayerState.parse(NativePlayer.state(h)) }.getOrNull()
                if (snap != null) {
                    latestHolder.snap = snap
                    snap.displayAspect?.let { host.fit(it) }
                    snap.videoFps?.let { host.matchFrameRate(it) }
                    host.shown(snap.positionMs)
                    // Keep AndroidComposeView dead-still while the HUD is tucked away unless playback status visibly shifted.
                    val visibleChange = uiOpen ||
                        snap.playing != state.playing ||
                        snap.buffering != state.buffering ||
                        snap.error != state.error ||
                        snap.ended != state.ended ||
                        snap.audio != state.audio ||
                        snap.subtitle != state.subtitle ||
                        snap.tracks.size != state.tracks.size
                    if (visibleChange) {
                        state = snap
                    }
                    val seek = pendingSeekMs
                    if (seek != null && snap.durationMs != null) {
                        pendingSeekMs = null
                        NativePlayer.seek(h, seek)
                    }
                    val sig = tracksSignature(snap)
                    val includeTracks = sig != latestHolder.reportedTracksSig
                    if (snap.ended) {
                        latestHolder.reportedTracksSig = sig
                        scope.launch { runCatching { worker.reportState(playerStateJson(snap, endedOverride = true, includeTracks = includeTracks)) } }
                        closeStream()
                        break
                    }
                    if (ticks % 4 == 0 || includeTracks) {
                        latestHolder.reportedTracksSig = sig
                        scope.launch { runCatching { worker.reportState(playerStateJson(snap, includeTracks = includeTracks)) } }
                    }
                }
            }
            ticks++
            delay(250)
        }
    }

    LaunchedEffect(hudVisible, hudTouches, state.playing, overlaySheet, handle) {
        if (handle != 0L && hudVisible && overlaySheet == null && state.playing && state.error == null) {
            delay(5000)
            hudVisible = false
            runCatching { stageFocus.requestFocus() }
        }
    }

    BackHandler(enabled = handle != 0L) {
        when {
            overlaySheet != null -> {
                overlaySheet = null
                touchHud()
            }
            hudVisible && state.playing && state.error == null -> {
                hudVisible = false
                runCatching { stageFocus.requestFocus() }
            }
            else -> stopAndReport()
        }
    }

    if (handle == 0L) {
        Box(
            Modifier.fillMaxSize().background(TvBg).safeDrawingPadding().padding(32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                Modifier
                    .widthIn(max = 860.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(26.dp))
                    .background(TvCard)
                    .border(1.dp, TvLine, RoundedCornerShape(26.dp))
                    .padding(36.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(36.dp),
            ) {
                Box(Modifier.size(230.dp), contentAlignment = Alignment.Center) {
                    val uri = info?.pairingUri.orEmpty()
                    if (uri.isNotEmpty()) TvQrCode(uri, Modifier.fillMaxSize())
                    else CircularProgressIndicator(color = TvAccent)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "READY TO CAST",
                        color = TvAccent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.4.sp,
                    )
                    Text(
                        info?.name ?: "PearTube TV",
                        color = TvInk,
                        fontSize = 30.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "Open PearTube on your phone or Mac, tap Cast, and pick this TV — or scan the QR code to beam a video straight here.",
                        color = TvDim,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                    )
                    val netAndDisk = listOfNotNull(
                        info?.listenUrl?.takeIf { it.isNotEmpty() },
                        info?.let { formatStorageFree(it.storageFreeBytes, it.externalStorage) },
                    ).joinToString("  ·  ")
                    if (netAndDisk.isNotEmpty()) {
                        Text(
                            netAndDisk,
                            color = if (info?.externalStorage == true) TvAccent else TvDim,
                            fontSize = 13.sp,
                        )
                    }
                    (openError ?: workerErr)?.let { err ->
                        Text(err, color = TvDanger, fontSize = 13.sp)
                    }
                }
            }
        }
        return
    }

    val effectiveMode = info?.mode ?: initialMode
    val badgeTxt = when (effectiveMode) {
        "private-p2p" -> "PRIVATE 2-HOP P2P"
        "p2p" -> "P2P SWARM PEER"
        else -> "LAN STREAM"
    }
    val audioTracks = remember(state.tracks) { state.tracks.filter { it.kind == "audio" } }
    val subTracks = remember(state.tracks) { state.tracks.filter { it.kind == "subtitle" } }
    val activeAudio = audioTracks.firstOrNull { it.stream == state.audio } ?: audioTracks.firstOrNull()
    val activeSub = subTracks.firstOrNull { it.stream == state.subtitle }
    val showHud = hudVisible || overlaySheet != null || !state.playing || state.error != null

    Box(
        Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val code = ev.nativeKeyEvent.keyCode
                when (code) {
                    KeyEvent.KEYCODE_BACK,
                    KeyEvent.KEYCODE_ESCAPE -> {
                        if (ev.nativeKeyEvent.repeatCount == 0) {
                            when {
                                overlaySheet != null -> {
                                    overlaySheet = null
                                    touchHud()
                                }
                                hudVisible && state.playing && state.error == null -> {
                                    hudVisible = false
                                    runCatching { stageFocus.requestFocus() }
                                }
                                else -> stopAndReport()
                            }
                        }
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                        touchHud()
                        if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
                        syncStateSoon()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_PLAY -> {
                        touchHud()
                        NativePlayer.play(handle)
                        syncStateSoon()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                        touchHud()
                        NativePlayer.pause(handle)
                        syncStateSoon()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_REWIND -> {
                        touchHud()
                        NativePlayer.seek(handle, (state.positionMs - 10_000L).coerceAtLeast(0L))
                        syncStateSoon()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                        touchHud()
                        val next = state.positionMs + 10_000L
                        NativePlayer.seek(handle, state.durationMs?.let { next.coerceAtMost(it) } ?: next)
                        syncStateSoon()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_STOP -> {
                        stopAndReport()
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_CAPTIONS -> {
                        touchHud()
                        overlaySheet = if (overlaySheet == TvOverlaySheet.Subtitles) null else TvOverlaySheet.Subtitles
                        return@onPreviewKeyEvent true
                    }
                    KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK -> {
                        touchHud()
                        overlaySheet = if (overlaySheet == TvOverlaySheet.Audio) null else TvOverlaySheet.Audio
                        return@onPreviewKeyEvent true
                    }
                }
                if (!showHud) {
                    when (code) {
                        KeyEvent.KEYCODE_DPAD_LEFT -> {
                            touchHud()
                            NativePlayer.seek(handle, (state.positionMs - 10_000L).coerceAtLeast(0L))
                            syncStateSoon()
                            return@onPreviewKeyEvent true
                        }
                        KeyEvent.KEYCODE_DPAD_RIGHT -> {
                            touchHud()
                            val next = state.positionMs + 10_000L
                            NativePlayer.seek(handle, state.durationMs?.let { next.coerceAtMost(it) } ?: next)
                            syncStateSoon()
                            return@onPreviewKeyEvent true
                        }
                        KeyEvent.KEYCODE_DPAD_CENTER,
                        KeyEvent.KEYCODE_ENTER,
                        KeyEvent.KEYCODE_NUMPAD_ENTER,
                        KeyEvent.KEYCODE_SPACE -> {
                            touchHud()
                            if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
                            syncStateSoon()
                            return@onPreviewKeyEvent true
                        }
                        KeyEvent.KEYCODE_DPAD_UP,
                        KeyEvent.KEYCODE_DPAD_DOWN,
                        KeyEvent.KEYCODE_MENU,
                        KeyEvent.KEYCODE_INFO -> {
                            touchHud()
                            return@onPreviewKeyEvent true
                        }
                    }
                } else {
                    hudTouches++
                }
                false
            }
            .focusRequester(stageFocus)
            .focusable()
            .clickable {
                if (overlaySheet != null) {
                    overlaySheet = null
                } else {
                    hudVisible = !hudVisible
                    if (hudVisible) {
                        hudTouches++
                        scope.launch { delay(30); runCatching { playBtnFocus.requestFocus() } }
                    }
                }
            },
    ) {
        Box(
            Modifier.fillMaxSize().onGloballyPositioned {
                val b = it.boundsInWindow()
                host.place(b.left.roundToInt(), b.top.roundToInt(), b.width.roundToInt(), b.height.roundToInt())
            },
        )
        if (state.buffering && state.error == null) {
            CircularProgressIndicator(color = Color.White, modifier = Modifier.align(Alignment.Center))
        }
        state.error?.let { errTxt ->
            Column(
                Modifier
                    .align(Alignment.Center)
                    .widthIn(max = 560.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(TvCard.copy(alpha = 0.94f))
                    .border(1.dp, TvDanger, RoundedCornerShape(20.dp))
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("Playback Error", color = TvDanger, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text(errTxt, color = TvInk, fontSize = 14.sp)
            }
        }
        if (showHud) {
            Column(
                Modifier.fillMaxSize().background(TvScrim).padding(horizontal = 32.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            activeTitle,
                            color = Color.White,
                            fontSize = 24.sp,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val resSpec = if (state.videoWidth != null && state.videoHeight != null) {
                            "${state.videoWidth}×${state.videoHeight}"
                        } else null
                        val subLine = listOfNotNull(
                            resSpec,
                            state.videoDecoder?.let(::prettyCodec),
                            info?.p2pPeers?.takeIf { it > 0 }?.let { "$it peers" },
                        ).joinToString(" · ")
                        if (subLine.isNotEmpty()) {
                            Text(subLine, color = TvDim, fontSize = 13.sp, maxLines = 1)
                        }
                    }
                    Text(
                        badgeTxt,
                        color = TvAccent,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .padding(start = 12.dp)
                            .clip(RoundedCornerShape(99.dp))
                            .background(Color.Black.copy(alpha = 0.55f))
                            .border(1.dp, TvAccent, RoundedCornerShape(99.dp))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }

                Column(
                    Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    TvSeekBar(
                        positionMs = state.positionMs,
                        durationMs = state.durationMs,
                        onSeek = { targetMs ->
                            NativePlayer.seek(handle, targetMs)
                            syncStateSoon()
                        },
                        onInteraction = ::touchHud,
                    )
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        TvControlButton(
                            label = if (state.playing) "Pause" else "Play",
                            primary = true,
                            onInteraction = ::touchHud,
                            onClick = {
                                if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
                                syncStateSoon()
                            },
                            modifier = Modifier.focusRequester(playBtnFocus),
                        )
                        TvControlButton(
                            label = "-10s",
                            onInteraction = ::touchHud,
                            onClick = {
                                NativePlayer.seek(handle, (state.positionMs - 10_000L).coerceAtLeast(0L))
                                syncStateSoon()
                            },
                        )
                        TvControlButton(
                            label = "+10s",
                            onInteraction = ::touchHud,
                            onClick = {
                                val next = state.positionMs + 10_000L
                                NativePlayer.seek(handle, state.durationMs?.let { next.coerceAtMost(it) } ?: next)
                                syncStateSoon()
                            },
                        )
                        if (audioTracks.isNotEmpty()) {
                            TvControlButton(
                                label = "Audio · ${shortTrackBadge(activeAudio)}",
                                onInteraction = ::touchHud,
                                onClick = {
                                    overlaySheet = if (overlaySheet == TvOverlaySheet.Audio) null else TvOverlaySheet.Audio
                                },
                            )
                        }
                        if (subTracks.isNotEmpty()) {
                            TvControlButton(
                                label = "Subtitles · ${activeSub?.let(::shortTrackBadge) ?: "Off"}",
                                onInteraction = ::touchHud,
                                onClick = {
                                    overlaySheet = if (overlaySheet == TvOverlaySheet.Subtitles) null else TvOverlaySheet.Subtitles
                                },
                            )
                        }
                        TvControlButton(
                            label = "Info",
                            onInteraction = ::touchHud,
                            onClick = {
                                overlaySheet = if (overlaySheet == TvOverlaySheet.Info) null else TvOverlaySheet.Info
                            },
                        )
                        Spacer(Modifier.width(8.dp))
                        TvControlButton(
                            label = "Stop",
                            accent = TvDanger,
                            onInteraction = ::touchHud,
                            onClick = ::stopAndReport,
                        )
                    }
                }
            }
        }

        overlaySheet?.let { sheet ->
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.60f))
                    .clickable { overlaySheet = null },
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    Modifier
                        .widthIn(max = 560.dp)
                        .fillMaxWidth(0.88f)
                        .heightIn(max = 460.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(TvCard)
                        .border(1.dp, TvLine, RoundedCornerShape(22.dp))
                        .clickable(enabled = false) {}
                        .padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    val header = when (sheet) {
                        TvOverlaySheet.Audio -> "Audio Track (${audioTracks.size})"
                        TvOverlaySheet.Subtitles -> "Subtitles (${subTracks.size})"
                        TvOverlaySheet.Info -> "Stream & Decoder Info"
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(header, color = TvInk, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        TvControlButton(
                            label = "Close",
                            onInteraction = ::touchHud,
                            onClick = { overlaySheet = null },
                            modifier = if (sheet == TvOverlaySheet.Info) Modifier.focusRequester(sheetFirstFocus) else Modifier,
                        )
                    }
                    when (sheet) {
                        TvOverlaySheet.Audio -> {
                            LazyColumn(
                                Modifier.weight(1f, fill = false),
                                contentPadding = PaddingValues(vertical = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                itemsIndexed(audioTracks, key = { _, t -> t.stream }) { idx, track ->
                                    val selected = track.stream == activeAudio?.stream
                                    TvControlButton(
                                        label = "${if (selected) "✓  " else ""}${fullTrackTitle(track)}",
                                        primary = selected,
                                        onInteraction = ::touchHud,
                                        onClick = {
                                            NativePlayer.selectAudio(handle, track.stream)
                                            overlaySheet = null
                                            syncStateSoon()
                                        },
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .then(if (idx == 0) Modifier.focusRequester(sheetFirstFocus) else Modifier),
                                    )
                                }
                            }
                        }
                        TvOverlaySheet.Subtitles -> {
                            LazyColumn(
                                Modifier.weight(1f, fill = false),
                                contentPadding = PaddingValues(vertical = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                item(key = -1) {
                                    val offSelected = activeSub == null
                                    TvControlButton(
                                        label = "${if (offSelected) "✓  " else ""}Subtitles Off",
                                        primary = offSelected,
                                        onInteraction = ::touchHud,
                                        onClick = {
                                            NativePlayer.selectSubtitle(handle, -1)
                                            overlaySheet = null
                                            syncStateSoon()
                                        },
                                        modifier = Modifier.fillMaxWidth().focusRequester(sheetFirstFocus),
                                    )
                                }
                                itemsIndexed(subTracks, key = { _, t -> t.stream }) { _, track ->
                                    val selected = track.stream == activeSub?.stream
                                    TvControlButton(
                                        label = "${if (selected) "✓  " else ""}${fullTrackTitle(track)}",
                                        primary = selected,
                                        onInteraction = ::touchHud,
                                        onClick = {
                                            NativePlayer.selectSubtitle(handle, track.stream)
                                            overlaySheet = null
                                            syncStateSoon()
                                        },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                            }
                        }
                        TvOverlaySheet.Info -> {
                            val resTxt = if (state.videoWidth != null && state.videoHeight != null) {
                                "${state.videoWidth} × ${state.videoHeight}"
                            } else "Probing…"
                            val vCodec = state.tracks.firstOrNull { it.kind == "video" }?.codec?.let(::prettyCodec) ?: "—"
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                InfoRow("Title", activeTitle)
                                InfoRow("Picture", "$resTxt · $vCodec")
                                InfoRow("Decoder", "${state.videoDecoder ?: "MediaCodec"} · ${state.droppedFrames} dropped frames")
                                InfoRow("Audio", shortTrackBadge(activeAudio))
                                InfoRow("Subtitles", activeSub?.let(::shortTrackBadge) ?: "Off")
                                InfoRow("Network", "$badgeTxt · ${info?.p2pPeers ?: 0} P2P peers")
                                info?.let { formatStorageFree(it.storageFreeBytes, it.externalStorage) }?.let { diskTxt ->
                                    InfoRow("Seed Storage", diskTxt)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = TvDim, fontSize = 14.sp)
        Text(
            value,
            color = TvInk,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 16.dp),
        )
    }
}
