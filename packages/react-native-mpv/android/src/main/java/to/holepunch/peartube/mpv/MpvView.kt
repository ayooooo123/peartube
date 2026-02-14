package to.holepunch.peartube.mpv

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import android.view.TextureView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import dev.jdtech.mpv.MPVLib
import java.util.Collections
import java.util.WeakHashMap

class MpvView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, MPVLib.EventObserver {
  companion object {
    private const val TAG = "MpvView"
    private val registry: MutableSet<MpvView> = Collections.newSetFromMap(WeakHashMap())

    @Volatile
    private var pipTransitionUntilUptimeMs: Long = 0

    @Volatile
    private var pipExpandedByBridge: Boolean = false

    @JvmStatic
    fun setPipExpandedByBridge(expanded: Boolean) {
      pipExpandedByBridge = expanded
      if (!expanded) {
        registry.toList().forEach { it.clearPipMatrix() }
      }
    }

    @JvmStatic
    fun setAllPipTransitionUntilUptimeMs(untilUptimeMs: Long) {
      pipTransitionUntilUptimeMs = maxOf(pipTransitionUntilUptimeMs, untilUptimeMs)
    }

    @JvmStatic
    fun setAllPipMode(active: Boolean) {
      registry.toList().forEach {
        it.pipModeActive = active
        if (!active) {
          it.clearPipMatrix()
          it.schedulePostPipExitSurfaceSync()
        }
      }
    }

    @JvmStatic
    fun setAllPipWindowSize(widthPx: Int, heightPx: Int) {
      registry.toList().forEach {
        it.pipWindowWidthPx = widthPx
        it.pipWindowHeightPx = heightPx
        it.applyPipMatrixIfNeeded()
      }
    }

    @JvmStatic
    fun setAllPlaybackPaused(paused: Boolean) {
      registry.toList().forEach { it.setPaused(paused) }
    }
  }

  private val reactContext = context as? ReactContext
  private var surface: Surface? = null
  private var initialized = false
  private var sourceUri: String? = null
  private var sourceHeaders: Map<String, String>? = null
  private var paused = true
  private var pipModeActive = false
  private var pipWindowWidthPx = 0
  private var pipWindowHeightPx = 0
  private var hasLoadEventFired = false
  private var lastDurationMs = 0.0
  private var lastPipWindowAppliedW = 0
  private var lastPipWindowAppliedH = 0
  private var lastViewAppliedW = 0
  private var lastViewAppliedH = 0
  private var postPipExitSurfaceSync: Runnable? = null
  private var pendingEndFileError: Runnable? = null
  private var lastLoadStartedAtMs: Long = 0
  private var lastNonZeroInsetTopPx: Int = 0
  private val mainHandler = Handler(Looper.getMainLooper())

  init {
    surfaceTextureListener = this
    isOpaque = false
    registry.add(this)
  }

  fun setSource(source: ReadableMap?) {
    val uri = source?.getString("uri") ?: return
    val sameUri = sourceUri == uri
    Log.d(TAG, "setSource uri=$uri initialized=$initialized sameUri=$sameUri")
    sourceUri = uri
    sourceHeaders = sourceToHeaders(source)
    if (initialized) {
      if (sameUri) {
        return
      }
      configureAndLoad(uri)
    }
  }

  fun setPaused(paused: Boolean) {
    this.paused = paused
    if (!initialized) return
    Log.d(TAG, "setPaused paused=$paused")
    MPVLib.setPropertyBoolean("pause", paused)
    if (paused) emitSimpleEvent("onPaused", 0.0) else emitPlayingEvent()
  }

  fun setRate(rate: Double) {
    if (!initialized) return
    MPVLib.setPropertyDouble("speed", rate)
  }

  fun setVolume(volume: Double) {
    if (!initialized) return
    MPVLib.setPropertyDouble("volume", (volume * 100.0).coerceIn(0.0, 100.0))
  }

  fun setMuted(muted: Boolean) {
    if (!initialized) return
    MPVLib.setPropertyBoolean("mute", muted)
  }

  fun setResizeMode(mode: String) {
    if (!initialized) return
    when (mode) {
      "cover" -> {
        MPVLib.setPropertyDouble("panscan", 1.0)
        MPVLib.setPropertyString("keepaspect", "yes")
      }
      "stretch" -> {
        MPVLib.setPropertyDouble("panscan", 0.0)
        MPVLib.setPropertyString("keepaspect", "no")
      }
      else -> {
        MPVLib.setPropertyDouble("panscan", 0.0)
        MPVLib.setPropertyString("keepaspect", "yes")
      }
    }
  }

  fun setSeekFraction(fraction: Double) {
    if (!initialized || fraction.isNaN() || fraction < 0.0) return
    val durationSec = MPVLib.getPropertyDouble("duration/full") ?: MPVLib.getPropertyDouble("duration") ?: 0.0
    if (durationSec <= 0) return
    val targetSec = durationSec * fraction.coerceIn(0.0, 1.0)
    seekToSeconds(targetSec)
  }

  fun seekToSeconds(seconds: Double) {
    if (!initialized || seconds.isNaN()) return
    MPVLib.command(arrayOf("seek", seconds.toString(), "absolute"))
  }

  fun stopPlayback() {
    if (!initialized) return
    MPVLib.command(arrayOf("stop"))
    emitSimpleEvent("onPaused", 0.0)
  }

  override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
    try {
      Log.d(TAG, "surface available ${width}x${height}")
      surface = Surface(surfaceTexture)
      MPVLib.create(context.applicationContext)
      initOptions()
      MPVLib.init()
      MPVLib.attachSurface(surface!!)
      MPVLib.setPropertyString("android-surface-size", "${width}x${height}")
      MPVLib.addObserver(this)
      observeProperties()
      initialized = true
      sourceUri?.let { configureAndLoad(it) }
    } catch (error: Exception) {
      Log.e(TAG, "mpv init failed", error)
      emitError(error.message ?: "mpv init failed")
    }
  }

  override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
    if (!initialized) return
    if (isEffectivelyInPip()) return
    MPVLib.setPropertyString("android-surface-size", "${width}x${height}")
  }

  override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
    Log.d(TAG, "surface destroyed")
    teardown()
    return true
  }

  override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) {
  }

  override fun eventProperty(property: String) {
  }

  override fun eventProperty(property: String, value: Long) {
    if (property == "width" || property == "height") {
      val width = MPVLib.getPropertyInt("width") ?: 0
      val height = MPVLib.getPropertyInt("height") ?: 0
      if (width > 0 && height > 0) {
        Log.d(TAG, "video layout ${width}x${height}")
        emitVideoState(width, height)
      }
    }
  }

  override fun eventProperty(property: String, value: Double) {
    when (property) {
      "time-pos" -> {
        val durationSec = MPVLib.getPropertyDouble("duration/full") ?: MPVLib.getPropertyDouble("duration") ?: 0.0
        lastDurationMs = durationSec * 1000.0
        emitProgress(value * 1000.0, lastDurationMs)
      }
      "duration/full", "duration" -> {
        val width = MPVLib.getPropertyInt("width") ?: 0
        val height = MPVLib.getPropertyInt("height") ?: 0
        lastDurationMs = value * 1000.0
        if (!hasLoadEventFired && lastDurationMs > 0 && width > 0 && height > 0) {
          Log.d(TAG, "onLoad durationMs=$lastDurationMs width=$width height=$height")
          hasLoadEventFired = true
          emitLoad(lastDurationMs, width, height)
        }
      }
    }
  }

  override fun eventProperty(property: String, value: Boolean) {
    when (property) {
      "paused-for-cache" -> emitSimpleEvent("onBuffering", if (value) 0.0 else 100.0)
      "eof-reached" -> if (value) emitSimpleEvent("onEnded", 0.0)
    }
  }

  override fun eventProperty(property: String, value: String) {
    if (property == "path") {
      Log.d(TAG, "path=$value")
    }
  }

  override fun event(eventId: Int) {
    val MPV_EVENT_FILE_LOADED = 8
    val MPV_EVENT_END_FILE = 7
    Log.d(TAG, "event id=$eventId paused=$paused durationMs=$lastDurationMs")
    when (eventId) {
      MPV_EVENT_FILE_LOADED -> {
        Log.d(TAG, "file loaded")
        cancelPendingEndFileError()
        if (!paused) {
          MPVLib.setPropertyBoolean("pause", false)
          emitPlayingEvent()
        }
      }
      MPV_EVENT_END_FILE -> {
        val sinceLoadMs = SystemClock.uptimeMillis() - lastLoadStartedAtMs
        if (lastDurationMs <= 1000.0 && !isInPipTransition()) {
          if (!hasLoadEventFired || sinceLoadMs < 1200) {
            Log.w(TAG, "end_file provisional during startup durationMs=$lastDurationMs sinceLoadMs=$sinceLoadMs")
            scheduleEndFileError()
          } else {
            Log.e(TAG, "end_file treated as error durationMs=$lastDurationMs sinceLoadMs=$sinceLoadMs")
            emitError("Unable to play media")
          }
        } else {
          cancelPendingEndFileError()
          Log.d(TAG, "end_file treated as ended durationMs=$lastDurationMs")
          emitSimpleEvent("onEnded", 0.0)
        }
      }
    }
  }

  fun teardown() {
    Log.d(TAG, "teardown initialized=$initialized")
    cancelPendingEndFileError()
    if (initialized) {
      MPVLib.removeObserver(this)
      MPVLib.detachSurface()
      MPVLib.destroy()
      initialized = false
    }
    surface?.release()
    surface = null
    registry.remove(this)
  }

  private fun isInPipTransition(): Boolean {
    return pipModeActive || SystemClock.uptimeMillis() <= pipTransitionUntilUptimeMs ||
      (pipWindowWidthPx > 0 && pipWindowHeightPx > 0)
  }

  private fun isEffectivelyInPip(): Boolean {
    return pipModeActive || (pipWindowWidthPx > 0 && pipWindowHeightPx > 0)
  }

  private fun sourceToHeaders(source: ReadableMap): Map<String, String> {
    val headersMap = source.getMap("headers") ?: return emptyMap()
    return headersMap.toHashMap().mapNotNull { (key, value) ->
      if (key is String && value is String) key to value else null
    }.toMap()
  }

  private fun initOptions() {
    MPVLib.setOptionString("profile", "fast")
    MPVLib.setOptionString("vo", "gpu")
    MPVLib.setOptionString("gpu-context", "android")
    MPVLib.setOptionString("opengl-es", "yes")
    MPVLib.setOptionString("hwdec", "auto-copy")
    MPVLib.setOptionString("ao", "audiotrack,opensles")
    MPVLib.setOptionString("cache", "yes")
    MPVLib.setOptionString("cache-secs", "30")
    MPVLib.setOptionString("network-timeout", "60")
    MPVLib.setOptionString("tls-verify", "no")
    MPVLib.setOptionString("force-seekable", "yes")
    MPVLib.setOptionString("http-reconnect", "yes")
    MPVLib.setOptionString("stream-reconnect", "yes")
    MPVLib.setOptionString("demuxer-lavf-o", "live_start_index=0,prefer_x_start=1,http_persistent=0")
    MPVLib.setOptionString("vd-lavc-o", "strict=-2")
    sourceHeaders?.let { headers ->
      val userAgent = headers["User-Agent"]
      if (!userAgent.isNullOrBlank()) {
        MPVLib.setOptionString("user-agent", userAgent)
      }
      val otherHeaders = headers.filterKeys { it != "User-Agent" }
      if (otherHeaders.isNotEmpty()) {
        val headerFields = otherHeaders.map { (key, value) -> "$key: $value" }.joinToString(",")
        MPVLib.setOptionString("http-header-fields", headerFields)
      }
    }
  }

  private fun observeProperties() {
    val MPV_FORMAT_NONE = 0
    val MPV_FORMAT_FLAG = 3
    val MPV_FORMAT_INT64 = 4
    val MPV_FORMAT_DOUBLE = 5
    MPVLib.observeProperty("time-pos", MPV_FORMAT_DOUBLE)
    MPVLib.observeProperty("duration/full", MPV_FORMAT_DOUBLE)
    MPVLib.observeProperty("duration", MPV_FORMAT_DOUBLE)
    MPVLib.observeProperty("width", MPV_FORMAT_INT64)
    MPVLib.observeProperty("height", MPV_FORMAT_INT64)
    MPVLib.observeProperty("paused-for-cache", MPV_FORMAT_FLAG)
    MPVLib.observeProperty("eof-reached", MPV_FORMAT_FLAG)
    MPVLib.observeProperty("track-list", MPV_FORMAT_NONE)
    MPVLib.observeProperty("path", MPV_FORMAT_NONE)
  }

  private fun configureAndLoad(url: String) {
    cancelPendingEndFileError()
    hasLoadEventFired = false
    lastDurationMs = 0.0
    lastLoadStartedAtMs = SystemClock.uptimeMillis()
    Log.d(TAG, "configureAndLoad paused=$paused url=$url")
    MPVLib.command(arrayOf("loadfile", url))
    MPVLib.setPropertyBoolean("pause", paused)
  }

  private fun scheduleEndFileError() {
    cancelPendingEndFileError()
    val task = Runnable {
      pendingEndFileError = null
      if (hasLoadEventFired || lastDurationMs > 1000.0 || isInPipTransition()) {
        return@Runnable
      }
      Log.e(TAG, "end_file confirmed as error after grace")
      emitError("Unable to play media")
    }
    pendingEndFileError = task
    mainHandler.postDelayed(task, 1200)
  }

  private fun cancelPendingEndFileError() {
    pendingEndFileError?.let { mainHandler.removeCallbacks(it) }
    pendingEndFileError = null
  }

  private fun applyPipMatrixIfNeeded() {
    if (!isEffectivelyInPip()) {
      clearPipMatrix()
      return
    }

    if (pipExpandedByBridge) return

    updateLastNonZeroInsetTopPx()
    if (lastNonZeroInsetTopPx > 0) {
      translationY = -lastNonZeroInsetTopPx.toFloat()
    }

    val windowW = pipWindowWidthPx
    val windowH = pipWindowHeightPx
    val viewW = width
    val viewH = height
    if (windowW <= 0 || windowH <= 0 || viewW <= 0 || viewH <= 0) return

    if (
      windowW == lastPipWindowAppliedW &&
      windowH == lastPipWindowAppliedH &&
      viewW == lastViewAppliedW &&
      viewH == lastViewAppliedH
    ) {
      return
    }

    lastPipWindowAppliedW = windowW
    lastPipWindowAppliedH = windowH
    lastViewAppliedW = viewW
    lastViewAppliedH = viewH

    val sx = windowW.toFloat() / viewW.toFloat()
    val sy = windowH.toFloat() / viewH.toFloat()
    val scale = minOf(sx, sy)
    if (scale <= 0f) return

    val dx = (windowW - viewW * scale) * 0.5f
    val dy = (windowH - viewH * scale) * 0.5f

    val matrix = Matrix()
    matrix.setScale(scale, scale)
    matrix.postTranslate(dx, dy)
    setTransform(matrix)
    invalidate()
  }

  private fun clearPipMatrix() {
    lastPipWindowAppliedW = 0
    lastPipWindowAppliedH = 0
    lastViewAppliedW = 0
    lastViewAppliedH = 0
    translationY = 0f
    setTransform(null)
    invalidate()
  }

  private fun updateLastNonZeroInsetTopPx() {
    try {
      val insets = ViewCompat.getRootWindowInsets(this) ?: return
      val cutoutTop = insets.displayCutout?.safeInsetTop ?: 0
      val statusTop = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
      val top = kotlin.math.max(cutoutTop, statusTop)
      if (top > 0) {
        lastNonZeroInsetTopPx = top
      }
    } catch (_: Exception) {
    }
  }

  private fun schedulePostPipExitSurfaceSync() {
    postPipExitSurfaceSync?.let { mainHandler.removeCallbacks(it) }
    val task = Runnable {
      postPipExitSurfaceSync = null
      if (!initialized || isEffectivelyInPip()) return@Runnable
      val w = width
      val h = height
      if (w > 0 && h > 0) {
        MPVLib.setPropertyString("android-surface-size", "${w}x${h}")
      }
    }
    postPipExitSurfaceSync = task
    mainHandler.postDelayed(task, 160)
  }

  private fun emitLoad(durationMs: Double, width: Int, height: Int) {
    val event = Arguments.createMap().apply {
      putDouble("duration", durationMs)
      putMap("videoSize", Arguments.createMap().apply {
        putInt("width", width)
        putInt("height", height)
      })
    }
    emit("onLoad", event)
  }

  private fun emitProgress(currentMs: Double, durationMs: Double) {
    val event = Arguments.createMap().apply {
      putDouble("currentTime", currentMs)
      putDouble("duration", durationMs)
      putDouble("position", if (durationMs > 0) currentMs / durationMs else 0.0)
      putDouble("remainingTime", (durationMs - currentMs).coerceAtLeast(0.0))
      putDouble("target", 0.0)
    }
    emit("onProgress", event)
  }

  private fun emitPlayingEvent() {
    val durationSec = MPVLib.getPropertyDouble("duration/full") ?: MPVLib.getPropertyDouble("duration") ?: 0.0
    val event = Arguments.createMap().apply {
      putDouble("duration", durationSec * 1000.0)
      putBoolean("seekable", durationSec > 0)
      putDouble("target", 0.0)
    }
    emit("onPlaying", event)
  }

  private fun emitSimpleEvent(name: String, target: Double) {
    val event = Arguments.createMap().apply {
      putDouble("target", target)
    }
    emit(name, event)
  }

  private fun emitError(message: String) {
    Log.e(TAG, "emitError message=$message")
    val event = Arguments.createMap().apply {
      putDouble("target", 0.0)
      putString("message", message)
    }
    emit("onError", event)
  }

  private fun emitVideoState(width: Int, height: Int) {
    val event = Arguments.createMap().apply {
      putString("type", "onNewVideoLayout")
      putInt("mVideoWidth", width)
      putInt("mVideoHeight", height)
    }
    emit("onVideoStateChange", event)
    applyPipMatrixIfNeeded()
  }

  private fun emit(eventName: String, event: com.facebook.react.bridge.WritableMap) {
    val react = reactContext ?: return
    react
      .getJSModule(RCTEventEmitter::class.java)
      .receiveEvent(id, eventName, event)
  }
}
