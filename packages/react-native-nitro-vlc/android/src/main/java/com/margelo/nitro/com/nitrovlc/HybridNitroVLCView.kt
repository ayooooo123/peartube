package com.margelo.nitro.com.nitrovlc

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.net.Uri
import android.view.Surface
import android.util.Log
import android.view.TextureView
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.ReactContext
import com.margelo.nitro.views.RecyclableView
import org.videolan.libvlc.Dialog
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IVLCVout
import org.videolan.libvlc.interfaces.IMedia
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap


class HybridNitroVLCView(private val context: Context) : HybridNitroVLCViewSpec(),
  TextureView.SurfaceTextureListener,
  IVLCVout.OnNewVideoLayoutListener,
  RecyclableView {

  companion object {
    val registry = ConcurrentHashMap<String, WeakReference<HybridNitroVLCView>>()

    /** Called from MediaSessionModule via reflection when PiP mode changes. */
    @JvmStatic
    fun setAllPipMode(active: Boolean) {
      android.util.Log.d("NitroVLC", "setAllPipMode: $active (${registry.size} views)")
      for (entry in registry.values) {
        val view = entry.get() ?: continue
        view.pipModeActive = active
        view.updateLastNonZeroInsetTopPx()
        if (active && view.lastNonZeroInsetTopPx > 0) {
          view.textureView.translationY = -view.lastNonZeroInsetTopPx.toFloat()
        } else if (!active) {
          view.textureView.translationY = 0f
        }
        // Cancel any pending deferred VLC reconfiguration. If it fires during PiP
        // (or right after exit) it can call updateVideoSurfaces() with stale/intermediate
        // dimensions and destabilize the SurfaceTexture.
        view.cancelDeferredSync()
        if (!active) {
          view.clearPipMatrix()
          view.schedulePostPipExitSurfaceSync()
          // Reset surface tracking to the current TextureView bounds so the next PiP
          // entry's heuristics (area-ratio shrink) compare against a stable fullscreen
          // baseline instead of an intermediate value.
          val w = view.textureView.width
          val h = view.textureView.height
          if (w > 0 && h > 0) {
            val prevArea = view.lastAppliedSurfaceWidth.toLong() * view.lastAppliedSurfaceHeight.toLong()
            val nextArea = w.toLong() * h.toLong()
            // Never shrink the baseline here; PiP exit can briefly report the PiP-sized
            // TextureView before fullscreen layout is restored.
            if (nextArea > prevArea) {
              view.lastAppliedSurfaceWidth = w
              view.lastAppliedSurfaceHeight = h
            }
          }
        }
      }
    }

    /** Called from PipBridge via reflection when PiP window size is known/changes. */
    @JvmStatic
    fun setAllPipWindowSize(widthPx: Int, heightPx: Int) {
      for (entry in registry.values) {
        val view = entry.get() ?: continue
        view.applyPipMatrix(widthPx, heightPx)
      }
    }
  }

  private var libVLC: LibVLC? = null
  private var mediaPlayer: MediaPlayer? = null
  private val textureView: TextureView = TextureView(context)
  private var lastVideoInfoHash: String? = null
  private var lastKnownVolume: Int = 100
  private var currentInitOptions: List<String>? = null
  private var videoWidth: Int = 0
  private var videoHeight: Int = 0
  private val playerLock = Any()
  private val reactContext = context as? ReactContext
  private val mainHandler = Handler(Looper.getMainLooper())
  private var isDisposed = false
  private var viewsAttached = false
  private val instanceId = Integer.toHexString(System.identityHashCode(this))
  private var attachedSurfaceTextureId: Int = 0
  // We create our own Surface from the SurfaceTexture instead of using
  // vout.setVideoView(textureView), because setVideoView replaces our
  // SurfaceTextureListener — making onSurfaceTextureDestroyed's "return false"
  // unreachable. VLC's internal handler returns true, destroying the texture
  // during animated transitions (drag) and causing black frames.
  private var currentSurface: Surface? = null

  // Backing fields for imperative setters (no longer Fabric props)
  private var _source: VLCPlayerSource = VLCPlayerSource("", null, null)
  private var _subtitleUri: String? = null
  private var _paused: Boolean? = null
  private var _loop: Boolean? = null
  private var _rate: Double? = null
  private var _volume: Double? = null
  private var _muted: Boolean? = null
  private var _audioTrack: Double? = null
  private var _textTrack: Double? = null
  private var _playInBackground: Boolean? = null
  private var _videoAspectRatio: PlayerAspectRatio? = null
  private var _autoAspectRatio: Boolean? = null
  private var _resizeMode: PlayerResizeMode? = null
  private var _autoplay: Boolean? = null
  private var _acceptInvalidCertificates: Boolean? = null

  // Track last applied surface size to skip redundant updateVideoSurfaces() calls.
  // During animated transitions, onSurfaceTextureSizeChanged fires on every frame —
  // each updateVideoSurfaces() is expensive and can cause VLC rendering interruption.
  private var lastAppliedSurfaceWidth = 0
  private var lastAppliedSurfaceHeight = 0
  private var deferredSurfaceSync: Runnable? = null
  private var postPipExitSurfaceSync: Runnable? = null

  // PiP rendering transform (TextureView matrix). During PiP we keep the TextureView
  // layout stable to avoid SurfaceTexture recreation. The system clips the top-left
  // of the fullscreen-sized view into the PiP window; applying a matrix scales the
  // rendered content into that window region without changing LayoutParams.
  private var lastPipWindowWidthPx: Int = 0
  private var lastPipWindowHeightPx: Int = 0
  private var lastPipViewWidthPx: Int = 0
  private var lastPipViewHeightPx: Int = 0

  private var lastNonZeroInsetTopPx: Int = 0

  // PiP mode flag — set from JS or native PiP callbacks. Prevents ALL VLC
  // reconfiguration (setWindowSize, updateVideoSurfaces) while active.
  // This is more reliable than checking isInPictureInPictureMode on the Activity
  // because the Activity flag may not be set yet during the PiP transition race.
  @Volatile
  var pipModeActive = false

  private fun clearPipMatrix() {
    lastPipWindowWidthPx = 0
    lastPipWindowHeightPx = 0
    lastPipViewWidthPx = 0
    lastPipViewHeightPx = 0
    try {
      textureView.setTransform(null)
      textureView.translationY = 0f
      textureView.invalidate()
    } catch (_: Exception) {
      // ignore
    }
  }

  private fun updateLastNonZeroInsetTopPx() {
    try {
      val insets = ViewCompat.getRootWindowInsets(textureView) ?: return
      val cutoutTop = insets.displayCutout?.safeInsetTop ?: 0
      val statusTop = insets.getInsets(WindowInsetsCompat.Type.statusBars()).top
      val top = kotlin.math.max(cutoutTop, statusTop)
      if (top > 0) lastNonZeroInsetTopPx = top
    } catch (_: Exception) {
      // ignore
    }
  }

  private fun applyPipMatrix(windowWidthPx: Int, windowHeightPx: Int) {
    if (isDisposed) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      runOnUiThread { applyPipMatrix(windowWidthPx, windowHeightPx) }
      return
    }

    if (!isEffectivelyInPip()) {
      clearPipMatrix()
      return
    }

    updateLastNonZeroInsetTopPx()
    if (lastNonZeroInsetTopPx > 0) {
      // Remove the fullscreen cutout offset from the PiP-visible region.
      // This is a visual translation only (no LayoutParams change).
      textureView.translationY = -lastNonZeroInsetTopPx.toFloat()
    }

    val vw = textureView.width
    val vh = textureView.height
    if (vw <= 0 || vh <= 0) return

    if (windowWidthPx <= 0 || windowHeightPx <= 0) return
    if (
      windowWidthPx == lastPipWindowWidthPx &&
      windowHeightPx == lastPipWindowHeightPx &&
      vw == lastPipViewWidthPx &&
      vh == lastPipViewHeightPx
    ) return

    lastPipWindowWidthPx = windowWidthPx
    lastPipWindowHeightPx = windowHeightPx
    lastPipViewWidthPx = vw
    lastPipViewHeightPx = vh

    // Fit content into PiP window while preserving aspect ratio.
    val sx = windowWidthPx.toFloat() / vw.toFloat()
    val sy = windowHeightPx.toFloat() / vh.toFloat()
    val s = kotlin.math.min(sx, sy)
    if (s <= 0f) return

    val scaledW = vw.toFloat() * s
    val scaledH = vh.toFloat() * s
    val dx = (windowWidthPx.toFloat() - scaledW) / 2f
    val dy = (windowHeightPx.toFloat() - scaledH) / 2f

    val m = Matrix()
    m.setScale(s, s)
    m.postTranslate(dx, dy)
    try {
      textureView.setTransform(m)
      textureView.invalidate()
      logSurface("applyPipMatrix window=${windowWidthPx}x${windowHeightPx} view=${vw}x${vh} scale=${s} translate=${dx},${dy}")
    } catch (_: Exception) {
      // ignore
    }
  }

  private fun reapplyPipMatrixIfNeeded() {
    if (lastPipWindowWidthPx <= 0 || lastPipWindowHeightPx <= 0) return
    if (!isEffectivelyInPip()) return
    applyPipMatrix(lastPipWindowWidthPx, lastPipWindowHeightPx)
  }

  private fun schedulePostPipExitSurfaceSync() {
    if (isDisposed) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      runOnUiThread { schedulePostPipExitSurfaceSync() }
      return
    }

    // Cancel any pending work; we only want one "kick".
    postPipExitSurfaceSync?.let { mainHandler.removeCallbacks(it) }

    val runnable = Runnable {
      if (isDisposed) return@Runnable
      if (isEffectivelyInPip()) return@Runnable

      val player = mediaPlayer ?: return@Runnable
      val st = textureView.surfaceTexture ?: return@Runnable
      val w = textureView.width
      val h = textureView.height
      if (w <= 0 || h <= 0) return@Runnable

      try { st.setDefaultBufferSize(w, h) } catch (_: Exception) {}
      try { player.vlcVout.setWindowSize(w, h) } catch (_: Exception) {}
      try { applyAspectRatio() } catch (_: Exception) {}
      try { player.updateVideoSurfaces() } catch (_: Exception) {}
      lastAppliedSurfaceWidth = w
      lastAppliedSurfaceHeight = h
      logSurface("postPipExitSurfaceSync updateVideoSurfaces size=${w}x${h}")
    }

    postPipExitSurfaceSync = runnable
    // Post (no delay): improves resume latency after PiP exit.
    mainHandler.post(runnable)
  }

  // Throttle extremely chatty logs during Reanimated-driven resizes.
  private var lastLayoutLogAtMs: Long = 0
  private var lastSurfaceTextureSizeLogAtMs: Long = 0
  private var lastSurfaceSizeLogAtMs: Long = 0

  // Callbacks — set imperatively via setOn*() methods, NOT via Fabric props
  private var onPlayingCb: ((event: OnPlayingEventProps) -> Unit)? = null
  private var onProgressCb: ((event: OnProgressEventProps) -> Unit)? = null
  private var onPausedCb: ((event: SimpleCallbackEventProps) -> Unit)? = null
  private var onStoppedCb: ((event: SimpleCallbackEventProps) -> Unit)? = null
  private var onBufferingCb: ((event: SimpleCallbackEventProps) -> Unit)? = null
  private var onEndedCb: ((event: SimpleCallbackEventProps) -> Unit)? = null
  private var onErrorCb: ((event: SimpleCallbackEventProps) -> Unit)? = null
  private var onLoadCb: ((event: VideoInfo) -> Unit)? = null

  override val view: View
    get() = textureView

  // viewId is the ONLY Fabric prop — stays as override var
  override var viewId: String = ""
    set(value) {
      if (field == value) return
      val oldValue = field
      field = value
      logSurface("viewId changed old='$oldValue' new='$value'")
      if (oldValue.isNotEmpty()) {
        registry.remove(oldValue)
      }
      if (value.isNotEmpty()) {
        registry[value] = WeakReference(this)
      }
    }

  init {
    textureView.isOpaque = true
    textureView.surfaceTextureListener = this
    textureView.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
      val width = right - left
      val height = bottom - top
      val oldWidth = oldRight - oldLeft
      val oldHeight = oldBottom - oldTop
      // Only reconfigure VLC when the size actually changes, not when just
      // position changes. During PiP drag, parent position changes rapidly but
      // the TextureView size stays constant — calling updateVideoSurfaces() on
      // every position change can disrupt VLC rendering.
      if (width > 0 && height > 0 && (width != oldWidth || height != oldHeight)) {
        val now = SystemClock.uptimeMillis()
        if (now - lastLayoutLogAtMs > 500) {
          lastLayoutLogAtMs = now
          logSurface("onLayoutChange size ${oldWidth}x${oldHeight} -> ${width}x${height} bounds=[$left,$top,$right,$bottom] oldBounds=[$oldLeft,$oldTop,$oldRight,$oldBottom]")
        }
        applySurfaceSize(width, height, reason = "onLayoutChange")
        // If the view size changes during PiP (or during the PiP transition),
        // recompute the matrix even if the PiP window size hasn't changed.
        reapplyPipMatrixIfNeeded()
      }
    }
    logSurface("init textureView created tv=${textureView.width}x${textureView.height} avail=${textureView.isAvailable}")
    // Player is initialized lazily in loadMedia() when the first source arrives.
    // Eagerly calling ensurePlayer() here risks crashing during Fabric view construction,
    // which corrupts the state updater path and causes SIGABRT on the next mount cycle.
  }

  // MARK: - Imperative Property Setters

  override fun setSource(source: VLCPlayerSource) {
    val previous = _source
    _source = source
    if (isDisposed) return
    if (source.uri.isNotBlank()) {
      val sameInitOptions = when {
        previous.initOptions == null && source.initOptions == null -> true
        previous.initOptions != null && source.initOptions != null -> previous.initOptions.contentEquals(source.initOptions)
        else -> false
      }
      if (previous.uri == source.uri && previous.initType == source.initType && sameInitOptions) {
        return
      }
      runOnUiThread {
        if (isDisposed) return@runOnUiThread
        try {
          loadMedia(source)
        } catch (_: Exception) {
          runOnJSThread { if (!isDisposed) onErrorCb?.invoke(SimpleCallbackEventProps(0.0)) }
        }
      }
    }
  }

  override fun setPaused(paused: Boolean) {
    if (_paused == paused) return
    _paused = paused
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try {
        val player = mediaPlayer ?: return@runOnUiThread
        if (paused) {
          player.pause()
        } else {
          player.play()
        }
      } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setLoop(loop: Boolean) {
    _loop = loop
  }

  override fun setRate(rate: Double) {
    if (_rate == rate) return
    _rate = rate
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try {
        val player = mediaPlayer ?: return@runOnUiThread
        player.rate = rate.toFloat()
      } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setVolume(volume: Double) {
    if (_volume == volume) return
    _volume = volume
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try { applyVolume() } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setMuted(muted: Boolean) {
    if (_muted == muted) return
    _muted = muted
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try { applyVolume() } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setAudioTrack(audioTrack: Double) {
    if (_audioTrack == audioTrack) return
    _audioTrack = audioTrack
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try {
        val player = mediaPlayer ?: return@runOnUiThread
        player.setAudioTrack(audioTrack.toInt())
      } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setTextTrack(textTrack: Double) {
    if (_textTrack == textTrack) return
    _textTrack = textTrack
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try {
        val player = mediaPlayer ?: return@runOnUiThread
        player.setSpuTrack(textTrack.toInt())
      } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setSubtitleUri(subtitleUri: String) {
    if (_subtitleUri == subtitleUri) return
    _subtitleUri = subtitleUri
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try {
        val media = mediaPlayer?.media ?: return@runOnUiThread
        if (subtitleUri.isNotBlank()) {
          media.addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 0, subtitleUri))
        }
      } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setPlayInBackground(playInBackground: Boolean) {
    _playInBackground = playInBackground
  }

  override fun setVideoAspectRatio(videoAspectRatio: PlayerAspectRatio) {
    if (_videoAspectRatio == videoAspectRatio) return
    _videoAspectRatio = videoAspectRatio
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try { applyAspectRatio() } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setAutoAspectRatio(autoAspectRatio: Boolean) {
    if (_autoAspectRatio == autoAspectRatio) return
    _autoAspectRatio = autoAspectRatio
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try { applyAspectRatio() } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setResizeMode(resizeMode: PlayerResizeMode) {
    if (_resizeMode == resizeMode) return
    _resizeMode = resizeMode
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      try { applyAspectRatio() } catch (_: Exception) { /* swallow */ }
    }
  }

  override fun setAutoplay(autoplay: Boolean) {
    _autoplay = autoplay
  }

  override fun setAcceptInvalidCertificates(acceptInvalidCertificates: Boolean) {
    _acceptInvalidCertificates = acceptInvalidCertificates
  }

  // MARK: - Playback Methods

  override fun play() {
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      mediaPlayer?.play()
    }
  }

  override fun pause() {
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      mediaPlayer?.pause()
    }
  }

  override fun stop() {
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      mediaPlayer?.stop()
    }
  }

  override fun seek(position: Double) {
    if (isDisposed) return
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      mediaPlayer?.position = position.toFloat()
    }
  }

  // MARK: - Imperative Listener Setters

  override fun setOnPlaying(callback: (event: OnPlayingEventProps) -> Unit) {
    onPlayingCb = callback
  }

  override fun setOnProgress(callback: (event: OnProgressEventProps) -> Unit) {
    onProgressCb = callback
  }

  override fun setOnPaused(callback: (event: SimpleCallbackEventProps) -> Unit) {
    onPausedCb = callback
  }

  override fun setOnStopped(callback: (event: SimpleCallbackEventProps) -> Unit) {
    onStoppedCb = callback
  }

  override fun setOnBuffering(callback: (event: SimpleCallbackEventProps) -> Unit) {
    onBufferingCb = callback
  }

  override fun setOnEnded(callback: (event: SimpleCallbackEventProps) -> Unit) {
    onEndedCb = callback
  }

  override fun setOnError(callback: (event: SimpleCallbackEventProps) -> Unit) {
    onErrorCb = callback
  }

  override fun setOnLoad(callback: (event: VideoInfo) -> Unit) {
    onLoadCb = callback
  }

  // MARK: - TextureView.SurfaceTextureListener

  override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
    if (isDisposed) return
    val stId = Integer.toHexString(System.identityHashCode(surfaceTexture))
    logSurface("onSurfaceTextureAvailable stId=$stId size=${width}x${height} tv=${textureView.width}x${textureView.height} measured=${textureView.measuredWidth}x${textureView.measuredHeight}")
    attachSurface(reason = "onSurfaceTextureAvailable")
    applySurfaceSize(width, height, reason = "onSurfaceTextureAvailable")
    reapplyPipMatrixIfNeeded()
  }

  override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
    if (isDisposed) return
    val stId = Integer.toHexString(System.identityHashCode(surfaceTexture))
    val now = SystemClock.uptimeMillis()
    if (now - lastSurfaceTextureSizeLogAtMs > 500) {
      lastSurfaceTextureSizeLogAtMs = now
      logSurface("onSurfaceTextureSizeChanged stId=$stId size=${width}x${height} tv=${textureView.width}x${textureView.height} measured=${textureView.measuredWidth}x${textureView.measuredHeight}")
    }
    applySurfaceSize(width, height, reason = "onSurfaceTextureSizeChanged")
    reapplyPipMatrixIfNeeded()
  }

  override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
    val stId = Integer.toHexString(System.identityHashCode(surfaceTexture))
    logSurface("onSurfaceTextureDestroyed stId=$stId tvAvail=${textureView.isAvailable} tv=${textureView.width}x${textureView.height}")
    attachedSurfaceTextureId = 0
    if (isDisposed) {
      // View is being torn down — detach VLC and let Android release the surface
      synchronized(playerLock) {
        if (viewsAttached) {
          mediaPlayer?.vlcVout?.detachViews()
          viewsAttached = false
        }
      }
      return true
    }
    // Return false = "don't destroy this SurfaceTexture, I'm still using it."
    // During animated position changes (PiP drag), Android may fire this callback
    // when the view moves through the compositor. Returning false keeps the surface
    // alive so VLC continues rendering without interruption (no black frame gap).
    // Cleanup happens in dispose() → releasePlayerLocked().
    return false
  }

  override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) {
    // No-op — VLC renders directly to the texture
  }

  // MARK: - Lifecycle

  override fun dispose() {
    synchronized(playerLock) {
      if (isDisposed) return
      isDisposed = true
      logSurface("dispose")
      if (viewId.isNotEmpty()) {
        registry.remove(viewId)
      }
      clearCallbacks()
      releasePlayerLocked()
    }
    super.dispose()
  }

  override fun prepareForRecycle() {
    synchronized(playerLock) {
      if (isDisposed) return
      logSurface("prepareForRecycle")
      if (viewId.isNotEmpty()) {
        registry.remove(viewId)
      }
      clearCallbacks()
      releasePlayerLocked()
      lastVideoInfoHash = null
      videoWidth = 0
      videoHeight = 0
    }
  }

  override fun onNewVideoLayout(
    vout: IVLCVout,
    width: Int,
    height: Int,
    visibleWidth: Int,
    visibleHeight: Int,
    sarNum: Int,
    sarDen: Int
  ) {
    if (isDisposed) return
    if (width <= 0 || height <= 0) return
    videoWidth = width
    videoHeight = height
    logSurface("onNewVideoLayout video=${width}x${height} visible=${visibleWidth}x${visibleHeight} sar=${sarNum}/${sarDen}")
    runOnUiThread {
      if (isDisposed) return@runOnUiThread
      val player = mediaPlayer ?: return@runOnUiThread
      // In PiP mode, skip VLC reconfiguration — TextureView scales output automatically.
      // Still emit load info for JS callbacks.
      val inPip = isEffectivelyInPip()
      if (!inPip) {
        applyAspectRatio()
        // Inform VLC about the current window dimensions and force a re-render.
        val w = textureView.width
        val h = textureView.height
        if (w > 0 && h > 0) {
          try {
            player.vlcVout.setWindowSize(w, h)
            player.updateVideoSurfaces()
            logSurface("onNewVideoLayout applied windowSize=${w}x${h} + updateVideoSurfaces")
          } catch (e: Exception) {
            logSurface("onNewVideoLayout updateVideoSurfaces threw: ${e.message}")
          }
        }
      } else {
        logSurface("onNewVideoLayout skipped VLC reconfig (PiP mode)")
      }
      emitLoadIfNeeded()
    }
  }

  // MARK: - Private Helpers

  private fun defaultOptions(): ArrayList<String> {
    return arrayListOf("--network-caching=300", "--file-caching=300")
  }

  private fun ensurePlayer(options: List<String>) {
    if (isDisposed) return
    if (libVLC != null && currentInitOptions == options) return
    logSurface("ensurePlayer initOptions=${options.size} (re)initializing player")
    releasePlayer()
    libVLC = LibVLC(context, options)
    currentInitOptions = options
    mediaPlayer = MediaPlayer(libVLC).apply {
      setEventListener { event -> handlePlayerEvent(event) }
    }
    Dialog.setCallbacks(libVLC, object : Dialog.Callbacks {
      override fun onDisplay(dialog: Dialog.QuestionDialog) {
        val accept = _acceptInvalidCertificates == true
        dialog.postAction(if (accept) 1 else 3)
      }

      override fun onDisplay(dialog: Dialog.ErrorMessage) = Unit
      override fun onDisplay(dialog: Dialog.LoginDialog) {
        dialog.dismiss()
      }
      override fun onDisplay(dialog: Dialog.ProgressDialog) = Unit
      override fun onCanceled(dialog: Dialog) = Unit
      override fun onProgressUpdate(dialog: Dialog.ProgressDialog) = Unit
    })
    attachSurface(reason = "ensurePlayer")
    applyVolume()
    applyAspectRatio()
    // onSurfaceTextureAvailable() may fire before the player is created, so
    // setWindowSize() was a no-op (mediaPlayer was null). Now that the player
    // exists, explicitly set the window size so VLC renders correctly.
    if (textureView.width > 0 && textureView.height > 0) {
      applySurfaceSize(textureView.width, textureView.height, reason = "ensurePlayer")
    }
  }

  private fun attachSurface(reason: String) {
    try {
      val player = mediaPlayer ?: run {
        logSurface("attachSurface skipped: no player reason=$reason")
        return
      }
      if (!textureView.isAvailable) {
        logSurface("attachSurface skipped: texture not available reason=$reason")
        return
      }
      val st = textureView.surfaceTexture ?: run {
        logSurface("attachSurface skipped: surfaceTexture null reason=$reason")
        return
      }
      val stId = System.identityHashCode(st)
      val vout = player.vlcVout
      val wereAttached = vout.areViewsAttached()
      val needsReattach = wereAttached && stId != attachedSurfaceTextureId
      if (needsReattach) {
        logSurface("attachSurface surfaceTexture changed reason=$reason prev=${Integer.toHexString(attachedSurfaceTextureId)} next=${Integer.toHexString(stId)} detaching views")
        try {
          vout.detachViews()
        } catch (_: Exception) {
          // Ignore
        }
        viewsAttached = false
      }
      // Release old Surface before creating a new one from the SurfaceTexture.
      currentSurface?.release()
      currentSurface = Surface(st)
      // Use setVideoSurface instead of setVideoView. setVideoView calls
      // textureView.setSurfaceTextureListener(...) internally, which REPLACES
      // our listener. Without our listener, onSurfaceTextureDestroyed can't
      // return false to keep the texture alive during PiP drag animations.
      // setVideoSurface just provides the Surface for rendering without
      // touching the SurfaceTextureListener.
      vout.setVideoSurface(currentSurface!!, null)
      if (!vout.areViewsAttached()) {
        vout.attachViews(this)
      }
      // Keep our bookkeeping aligned with LibVLC's view attachment state.
      viewsAttached = vout.areViewsAttached()
      attachedSurfaceTextureId = stId

      // Configure VLC's rendering for the current surface dimensions.
      // Called once per surface attachment — subsequent size changes are
      // handled by applySurfaceSize() which only does a full reconfig
      // for large changes (system PiP) and lightweight updates for small
      // incremental changes (Reanimated animation frames).
      // In PiP mode, skip VLC reconfig — TextureView scales automatically.
      val w = textureView.width
      val h = textureView.height
      if (w > 0 && h > 0 && !isEffectivelyInPip()) {
        try {
          st.setDefaultBufferSize(w, h)
          vout.setWindowSize(w, h)
          applyAspectRatio()
          player.updateVideoSurfaces()
          lastAppliedSurfaceWidth = w
          lastAppliedSurfaceHeight = h
          logSurface("attachSurface updateVideoSurfaces ok reason=$reason size=${w}x${h}")
        } catch (e: Exception) {
          logSurface("attachSurface updateVideoSurfaces threw: ${e.message} reason=$reason")
        }
      } else if (isEffectivelyInPip()) {
        logSurface("attachSurface SKIPPED VLC reconfig (PiP) reason=$reason size=${w}x${h}")
      }

      logSurface("attachSurface done reason=$reason stId=${Integer.toHexString(stId)} attached=$viewsAttached")
    } catch (_: Exception) {
      return
    }
  }

  private fun applySurfaceSize(width: Int, height: Int, reason: String) {
    if (isDisposed) return
    if (Looper.myLooper() != Looper.getMainLooper()) {
      runOnUiThread { applySurfaceSize(width, height, reason) }
      return
    }

    if (width <= 0 || height <= 0) return

    // In PiP mode, skip ALL VLC reconfiguration. TextureView automatically scales
    // VLC's rendered output to fit its current bounds. Reconfiguring VLC (Surface
    // recreation, updateVideoSurfaces) during PiP causes visible glitches — the
    // EGL context reinitializes over multiple frames producing artifacts.
    // When exiting PiP, the view resizes back to its original dimensions, which
    // match lastAppliedSurface — so the dedup check below returns early, and VLC
    // continues rendering at its pre-PiP resolution. Zero reconfiguration needed.
    //
    // Block ALL VLC reconfiguration during PiP. Uses isEffectivelyInPip() which
    // checks both the explicit pipModeActive flag (set early) and the Activity's
    // isInPictureInPictureMode (set by the system). Also uses area-ratio heuristic
    // as a last-resort catch for the race where the window resizes before ANY flag is set.
    val tvW = textureView.width
    val tvH = textureView.height
    val effectiveW = if (tvW > 0) tvW else width
    val effectiveH = if (tvH > 0) tvH else height
    val inPip = isEffectivelyInPip()
    val prevArea = lastAppliedSurfaceWidth.toLong() * lastAppliedSurfaceHeight.toLong()
    val newArea = effectiveW.toLong() * effectiveH.toLong()
    val isPipLikeShrink = prevArea > 0 && newArea > 0 && newArea < prevArea / 4
    if (inPip || isPipLikeShrink) {
      deferredSurfaceSync?.let { mainHandler.removeCallbacks(it) }
      logSurface("applySurfaceSize SKIPPED reason=$reason inPip=$inPip pipShrink=$isPipLikeShrink effective=${effectiveW}x${effectiveH} prev=${lastAppliedSurfaceWidth}x${lastAppliedSurfaceHeight}")
      return
    }

    if (effectiveW == lastAppliedSurfaceWidth && effectiveH == lastAppliedSurfaceHeight) return
    val player = mediaPlayer ?: return

    // Detect large size changes (>30% in either dimension).
    // Small incremental changes (Reanimated animation frames: ~1% per frame) get
    // lightweight updates only. Large changes need a full Surface recreate because
    // VLC's EGL context is tied to the old Surface dimensions and won't adapt to
    // new buffer sizes from setDefaultBufferSize alone.
    val prevW = lastAppliedSurfaceWidth
    val prevH = lastAppliedSurfaceHeight
    val isLargeChange = prevW > 0 && prevH > 0 && (
      Math.abs(effectiveW - prevW).toFloat() / prevW.toFloat() > 0.3f ||
      Math.abs(effectiveH - prevH).toFloat() / prevH.toFloat() > 0.3f
    )

    lastAppliedSurfaceWidth = effectiveW
    lastAppliedSurfaceHeight = effectiveH

    val st = textureView.surfaceTexture
    if (st == null) {
      logSurface("applySurfaceSize skipped: no surfaceTexture reason=$reason")
      return
    }

    if (isLargeChange) {
      // Large change: recreate Surface so VLC's EGL context reinitializes
      // at the new resolution. Then reconfigure VLC.
      logSurface("applySurfaceSize LARGE change reason=$reason prev=${prevW}x${prevH} -> ${effectiveW}x${effectiveH}")
      try { st.setDefaultBufferSize(effectiveW, effectiveH) } catch (_: Exception) {}
      currentSurface?.release()
      currentSurface = Surface(st)
      try { player.vlcVout.setVideoSurface(currentSurface!!, null) } catch (_: Exception) {}
      try { player.vlcVout.setWindowSize(effectiveW, effectiveH) } catch (_: Exception) {}
      try { applyAspectRatio() } catch (_: Exception) {}
      try { player.updateVideoSurfaces() } catch (_: Exception) {}
    } else {
      // Small incremental change (animation frame): lightweight metadata only.
      // TextureView scales VLC's output to match the view bounds automatically.
      val now = SystemClock.uptimeMillis()
      if (now - lastSurfaceSizeLogAtMs > 750) {
        lastSurfaceSizeLogAtMs = now
        logSurface("applySurfaceSize small change reason=$reason effective=${effectiveW}x${effectiveH}")
      }
      try { st.setDefaultBufferSize(effectiveW, effectiveH) } catch (_: Exception) {}
      try { player.vlcVout.setWindowSize(effectiveW, effectiveH) } catch (_: Exception) {}
      // Deferred updateVideoSurfaces() disabled: it tends to fire mid-resize and
      // can produce visible flashes. Large changes still do an immediate reconfigure.
    }
  }

  /** Cancel any pending deferred VLC reconfiguration. Called from setAllPipMode(). */
  fun cancelDeferredSync() {
    deferredSurfaceSync?.let { mainHandler.removeCallbacks(it) }
    deferredSurfaceSync = null
  }

  private fun scheduleDeferredSurfaceSync(reason: String) {
    // Disabled (intentionally). Keeping this method as a no-op since existing
    // call sites may remain in older builds.
    return
  }

  private fun applyAspectRatio() {
    if (isDisposed) return
    if (isEffectivelyInPip()) return  // Block VLC reconfig during PiP
    val player = mediaPlayer ?: return

    val aspect = if (_autoAspectRatio == true || _videoAspectRatio == null) {
      null
    } else {
      _videoAspectRatio?.let { aspectRatioString(it) }
    }

    when (_resizeMode) {
      PlayerResizeMode.FILL -> {
        val w = textureView.width
        val h = textureView.height
        if (w > 0 && h > 0) {
          player.setScale(0f)
          player.setAspectRatio("$w:$h")
        }
      }
      PlayerResizeMode.COVER -> {
        player.setAspectRatio(aspect)
        if (videoWidth > 0 && videoHeight > 0) {
          val w = textureView.width.toFloat()
          val h = textureView.height.toFloat()
          if (w > 0f && h > 0f) {
            val scaleW = w / videoWidth.toFloat()
            val scaleH = h / videoHeight.toFloat()
            player.setScale(maxOf(scaleW, scaleH))
          } else {
            player.setScale(0f)
          }
        } else {
          player.setScale(0f)
        }
      }
      PlayerResizeMode.NONE -> {
        player.setAspectRatio(aspect)
        player.setScale(1f)
      }
      PlayerResizeMode.CONTAIN,
      PlayerResizeMode.SCALE_DOWN,
      null -> {
        player.setScale(0f)
        player.setAspectRatio(aspect)
      }
    }
  }

  private fun aspectRatioString(value: PlayerAspectRatio): String {
    return when (value) {
      PlayerAspectRatio.RATIO16X9 -> "16:9"
      PlayerAspectRatio.RATIO1X1 -> "1:1"
      PlayerAspectRatio.RATIO4X3 -> "4:3"
      PlayerAspectRatio.RATIO3X2 -> "3:2"
      PlayerAspectRatio.RATIO21X9 -> "21:9"
      PlayerAspectRatio.RATIO9X16 -> "9:16"
    }
  }

  /**
   * Central PiP check — returns true if we should block VLC reconfiguration.
   * Checks both the explicit [pipModeActive] flag (set early from JS/native)
   * and the Activity's [isInPictureInPictureMode] (set by the system).
   * Using both ensures no race-condition gap.
   */
  private fun isEffectivelyInPip(): Boolean {
    if (pipModeActive) return true
    return try {
      reactContext?.currentActivity?.isInPictureInPictureMode == true
    } catch (_: Exception) {
      false
    }
  }

  private fun applyVolume() {
    if (isDisposed) return
    val player = mediaPlayer ?: return
    val isMuted = _muted == true
    val volumeValue = _volume?.let { (it * 100).toInt() } ?: lastKnownVolume
    if (!isMuted) {
      lastKnownVolume = volumeValue
    }
    player.volume = if (isMuted) 0 else volumeValue
  }

  private fun loadMedia(value: VLCPlayerSource) {
    if (isDisposed) return
    val options = ArrayList(value.initOptions?.toList() ?: defaultOptions())
    ensurePlayer(options)
    val vlc = libVLC ?: run {
      runOnJSThread { if (!isDisposed) onErrorCb?.invoke(SimpleCallbackEventProps(0.0)) }
      return
    }
    val player = mediaPlayer ?: return
    try {
      val media = Media(vlc, Uri.parse(value.uri))
      _subtitleUri?.let { subtitle ->
        if (subtitle.isNotBlank()) {
          try {
            media.addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 0, subtitle))
          } catch (_: Exception) {
            return@let
          }
        }
      }
      player.media = media
    } catch (_: Exception) {
      runOnJSThread { if (!isDisposed) onErrorCb?.invoke(SimpleCallbackEventProps(0.0)) }
      return
    }
    _audioTrack?.let { player.setAudioTrack(it.toInt()) }
    _textTrack?.let { player.setSpuTrack(it.toInt()) }
    applyAspectRatio()

    val shouldAutoplay = _autoplay != false && _paused != true
    if (shouldAutoplay) {
      player.play()
    }
  }

  private fun handlePlayerEvent(event: MediaPlayer.Event) {
    data class PlayerEventPayload(
      val onPlayingEvent: OnPlayingEventProps?,
      val onPausedEvent: SimpleCallbackEventProps?,
      val onStoppedEvent: SimpleCallbackEventProps?,
      val onBufferingEvent: SimpleCallbackEventProps?,
      val onEndedEvent: SimpleCallbackEventProps?,
      val onErrorEvent: SimpleCallbackEventProps?,
      val onProgressEvent: OnProgressEventProps?,
      val shouldEmitLoad: Boolean
    )

    val payload = synchronized(playerLock) {
      if (isDisposed) return
      val player = mediaPlayer ?: return
      var onPlayingEvent: OnPlayingEventProps? = null
      var onPausedEvent: SimpleCallbackEventProps? = null
      var onStoppedEvent: SimpleCallbackEventProps? = null
      var onBufferingEvent: SimpleCallbackEventProps? = null
      var onEndedEvent: SimpleCallbackEventProps? = null
      var onErrorEvent: SimpleCallbackEventProps? = null
      var onProgressEvent: OnProgressEventProps? = null
      var shouldEmitLoad = false

      when (event.type) {
        MediaPlayer.Event.Playing -> {
          val duration = player.length.toDouble()
          onPlayingEvent = OnPlayingEventProps(duration, 0.0, player.isSeekable)
          shouldEmitLoad = true
        }
        MediaPlayer.Event.Paused -> {
          onPausedEvent = SimpleCallbackEventProps(0.0)
        }
        MediaPlayer.Event.Stopped -> {
          onStoppedEvent = SimpleCallbackEventProps(0.0)
        }
        MediaPlayer.Event.Buffering -> {
          // Pass buffering percentage (0.0-100.0) through the target field.
          // JS side uses this to distinguish "still buffering" from "buffer full".
          onBufferingEvent = SimpleCallbackEventProps(event.buffering.toDouble())
        }
        MediaPlayer.Event.EndReached -> {
          onEndedEvent = SimpleCallbackEventProps(0.0)
          if (_loop == true) {
            player.position = 0f
            player.play()
          }
        }
        MediaPlayer.Event.EncounteredError -> {
          onErrorEvent = SimpleCallbackEventProps(0.0)
        }
        MediaPlayer.Event.TimeChanged -> {
          val duration = player.length.toDouble()
          val currentTime = player.time.toDouble()
          val position = if (duration > 0.0) currentTime / duration else 0.0
          val remainingTime = duration - currentTime
          onProgressEvent = OnProgressEventProps(
            duration = duration,
            target = 0.0,
            currentTime = currentTime,
            position = position,
            remainingTime = remainingTime
          )
        }
        else -> Unit
      }

      PlayerEventPayload(
        onPlayingEvent = onPlayingEvent,
        onPausedEvent = onPausedEvent,
        onStoppedEvent = onStoppedEvent,
        onBufferingEvent = onBufferingEvent,
        onEndedEvent = onEndedEvent,
        onErrorEvent = onErrorEvent,
        onProgressEvent = onProgressEvent,
        shouldEmitLoad = shouldEmitLoad
      )
    }

    // Dispatch callbacks on the JS thread — VLC fires events on its
    // own native thread, but Nitro callbacks bridge to JSI/Hermes which
    // is NOT thread-safe.  Must run on mqt_v_js, not any other thread.
    runOnJSThread {
      if (isDisposed) return@runOnJSThread
      payload.onPlayingEvent?.let { onPlayingCb?.invoke(it) }
      payload.onPausedEvent?.let { onPausedCb?.invoke(it) }
      payload.onStoppedEvent?.let { onStoppedCb?.invoke(it) }
      payload.onBufferingEvent?.let { onBufferingCb?.invoke(it) }
      payload.onEndedEvent?.let { onEndedCb?.invoke(it) }
      payload.onErrorEvent?.let { onErrorCb?.invoke(it) }
      payload.onProgressEvent?.let { onProgressCb?.invoke(it) }
      if (payload.shouldEmitLoad) {
        emitLoadIfNeeded()
      }
    }
  }

  private fun emitLoadIfNeeded() {
    var info: VideoInfo? = null
    var shouldEmit = false
    synchronized(playerLock) {
      if (isDisposed) return
      val player = mediaPlayer ?: return
      val nextInfo = buildVideoInfo(player)
      val hash = "${nextInfo.duration}-${nextInfo.videoSize.width}-${nextInfo.videoSize.height}-${nextInfo.audioTracks.size}-${nextInfo.textTracks.size}"
      if (hash != lastVideoInfoHash) {
        lastVideoInfoHash = hash
        info = nextInfo
        shouldEmit = true
      }
    }

    if (shouldEmit) {
      info?.let { videoInfo ->
        runOnJSThread {
          if (!isDisposed) onLoadCb?.invoke(videoInfo)
        }
      }
    }
  }

  private fun buildVideoInfo(player: MediaPlayer): VideoInfo {
    val videoTrack = player.currentVideoTrack
    val audioTracks = player.audioTracks?.map {
      Track(it.id.toDouble(), it.name ?: "")
    }?.toTypedArray() ?: emptyArray()
    val textTracks = player.spuTracks?.map {
      Track(it.id.toDouble(), it.name ?: "")
    }?.toTypedArray() ?: emptyArray()
    return VideoInfo(
      duration = player.length.toDouble(),
      target = 0.0,
      videoSize = VideoSize(
        videoTrack?.width?.toDouble() ?: 0.0,
        videoTrack?.height?.toDouble() ?: 0.0
      ),
      audioTracks = audioTracks,
      textTracks = textTracks
    )
  }

  private fun logSurface(message: String) {
    Log.d("NitroVLC", "[$instanceId][viewId=$viewId] $message")
  }

  private fun runOnJSThread(block: () -> Unit) {
    val ctx = reactContext ?: return
    ctx.runOnJSQueueThread(block)
  }

  private fun runOnUiThread(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  private fun releasePlayer() {
    if (isDisposed) return
    synchronized(playerLock) {
      releasePlayerLocked()
    }
  }

  private fun releasePlayerLocked() {
    deferredSurfaceSync?.let { mainHandler.removeCallbacks(it) }
    deferredSurfaceSync = null
    if (viewsAttached) {
      mediaPlayer?.vlcVout?.detachViews()
      viewsAttached = false
    }
    // Release our Surface AFTER detaching views (so VLC stops using it)
    // but BEFORE releasing the player.
    currentSurface?.release()
    currentSurface = null
    mediaPlayer?.release()
    mediaPlayer = null
    libVLC?.release()
    libVLC = null
    currentInitOptions = null
    lastAppliedSurfaceWidth = 0
    lastAppliedSurfaceHeight = 0
    attachedSurfaceTextureId = 0
  }

  private fun clearCallbacks() {
    onPlayingCb = null
    onProgressCb = null
    onPausedCb = null
    onStoppedCb = null
    onBufferingCb = null
    onEndedCb = null
    onErrorCb = null
    onLoadCb = null
  }
}
