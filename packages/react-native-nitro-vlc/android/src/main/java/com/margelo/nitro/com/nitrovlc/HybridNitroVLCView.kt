package com.margelo.nitro.com.nitrovlc

import android.content.Context
import android.net.Uri
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.margelo.nitro.views.RecyclableView
import org.videolan.libvlc.Dialog
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IVLCVout
import org.videolan.libvlc.interfaces.IMedia

class HybridNitroVLCView(private val context: Context) : HybridNitroVLCViewSpec(),
  SurfaceHolder.Callback,
  IVLCVout.OnNewVideoLayoutListener,
  RecyclableView {

  private var libVLC: LibVLC? = null
  private var mediaPlayer: MediaPlayer? = null
  private val surfaceView: SurfaceView = SurfaceView(context)
  private var lastVideoInfoHash: String? = null
  private var lastKnownVolume: Int = 100
  private var currentInitOptions: List<String>? = null
  private var videoWidth: Int = 0
  private var videoHeight: Int = 0
  private val playerLock = Any()
  private var isDisposed = false
  private var viewsAttached = false

  override val view: SurfaceView
    get() = surfaceView

  override var source: VLCPlayerSource = VLCPlayerSource("", null, null)
    set(value) {
      field = value
      if (isDisposed) return
      if (value.uri.isNotBlank()) {
        loadMedia(value)
      }
    }

  override var subtitleUri: String? = null
    set(value) {
      field = value
      if (isDisposed) return
      val media = mediaPlayer?.media ?: return
      value?.let {
        media.addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 0, it))
      }
    }

  override var paused: Boolean? = null
    set(value) {
      field = value
      if (isDisposed) return
      val player = mediaPlayer ?: return
      if (value == true) {
        player.pause()
      } else {
        player.play()
      }
    }

  override var loop: Boolean? = null

  override var rate: Double? = null
    set(value) {
      field = value
      if (isDisposed) return
      val player = mediaPlayer ?: return
      value?.let { player.rate = it.toFloat() }
    }

  override var seek: Double? = null
    set(value) {
      field = value
      if (isDisposed) return
      val player = mediaPlayer ?: return
      value?.let {
        if (it in 0.0..1.0) {
          player.position = it.toFloat()
        }
      }
    }

  override var volume: Double? = null
    set(value) {
      field = value
      if (isDisposed) return
      applyVolume()
    }

  override var muted: Boolean? = null
    set(value) {
      field = value
      if (isDisposed) return
      applyVolume()
    }

  override var audioTrack: Double? = null
    set(value) {
      field = value
      if (isDisposed) return
      val player = mediaPlayer ?: return
      value?.let { player.setAudioTrack(it.toInt()) }
    }

  override var textTrack: Double? = null
    set(value) {
      field = value
      if (isDisposed) return
      val player = mediaPlayer ?: return
      value?.let { player.setSpuTrack(it.toInt()) }
    }

  override var playInBackground: Boolean? = null

  override var videoAspectRatio: PlayerAspectRatio? = null
    set(value) {
      field = value
      if (isDisposed) return
      applyAspectRatio()
    }

  override var autoAspectRatio: Boolean? = null
    set(value) {
      field = value
      if (isDisposed) return
      applyAspectRatio()
    }

  override var resizeMode: PlayerResizeMode? = null
    set(value) {
      field = value
      if (isDisposed) return
      applyAspectRatio()
    }

  override var autoplay: Boolean? = null

  override var acceptInvalidCertificates: Boolean? = null

  override var onPlaying: ((event: OnPlayingEventProps) -> Unit)? = null
  override var onProgress: ((event: OnProgressEventProps) -> Unit)? = null
  override var onPaused: ((event: SimpleCallbackEventProps) -> Unit)? = null
  override var onStopped: ((event: SimpleCallbackEventProps) -> Unit)? = null
  override var onBuffering: ((event: SimpleCallbackEventProps) -> Unit)? = null
  override var onEnded: ((event: SimpleCallbackEventProps) -> Unit)? = null
  override var onError: ((event: SimpleCallbackEventProps) -> Unit)? = null
  override var onLoad: ((event: VideoInfo) -> Unit)? = null

  init {
    surfaceView.holder.addCallback(this)
    surfaceView.addOnLayoutChangeListener { _, left, top, right, bottom, _, _, _, _ ->
      val width = right - left
      val height = bottom - top
      if (width > 0 && height > 0) {
        applySurfaceSize(width, height)
      }
    }
    ensurePlayer(defaultOptions())
  }

  override fun play() {
    if (isDisposed) return
    mediaPlayer?.play()
  }

  override fun pause() {
    if (isDisposed) return
    mediaPlayer?.pause()
  }

  override fun stop() {
    if (isDisposed) return
    mediaPlayer?.stop()
  }

  override fun seek(position: Double) {
    if (isDisposed) return
    mediaPlayer?.position = position.toFloat()
  }

  override fun setVolume(volume: Double) {
    if (isDisposed) return
    this.volume = volume
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    if (isDisposed) return
    attachSurface(holder)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    if (isDisposed) return
    applySurfaceSize(width, height)
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    synchronized(playerLock) {
      if (viewsAttached) {
        mediaPlayer?.vlcVout?.detachViews()
        viewsAttached = false
      }
    }
  }

  override fun dispose() {
    synchronized(playerLock) {
      if (isDisposed) return
      isDisposed = true
      clearCallbacks()
      releasePlayerLocked()
    }
    super.dispose()
  }

  override fun prepareForRecycle() {
    synchronized(playerLock) {
      if (isDisposed) return
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
    applyAspectRatio()
    emitLoadIfNeeded()
  }

  private fun defaultOptions(): List<String> {
    return listOf("--network-caching=300", "--file-caching=300")
  }

  private fun ensurePlayer(options: List<String>) {
    if (isDisposed) return
    if (libVLC != null && currentInitOptions == options) return
    releasePlayer()
    libVLC = LibVLC(context, options)
    currentInitOptions = options
    mediaPlayer = MediaPlayer(libVLC).apply {
      setEventListener { event -> handlePlayerEvent(event) }
    }
    Dialog.setCallbacks(libVLC, object : Dialog.Callbacks {
      override fun onDisplay(dialog: Dialog.QuestionDialog) {
        val accept = acceptInvalidCertificates == true
        // Action 1 = accept, Action 3 = dismiss (matches iOS behavior)
        dialog.postAction(if (accept) 1 else 3)
      }

      override fun onDisplay(dialog: Dialog.ErrorMessage) = Unit
      override fun onDisplay(dialog: Dialog.LoginDialog) {
        dialog.dismiss() // Dismiss login dialogs
      }
      override fun onDisplay(dialog: Dialog.ProgressDialog) = Unit
      override fun onCanceled(dialog: Dialog) = Unit
      override fun onProgressUpdate(dialog: Dialog.ProgressDialog) = Unit
    })
    attachSurface(surfaceView.holder)
    applyVolume()
    applyAspectRatio()
  }

  private fun attachSurface(holder: SurfaceHolder) {
    try {
      val player = mediaPlayer ?: return
      if (holder.surface == null || !holder.surface.isValid) return
      val vout = player.vlcVout
      vout.setVideoSurface(holder.surface, holder)
      if (!vout.areViewsAttached()) {
        vout.attachViews(this)
        viewsAttached = true
      }
    } catch (_: Exception) {
      return
    }
  }

  private fun applySurfaceSize(width: Int, height: Int) {
    if (isDisposed) return
    val player = mediaPlayer ?: return
    player.vlcVout.setWindowSize(width, height)
    applyAspectRatio()
    try {
      player.updateVideoSurfaces()
    } catch (_: Exception) {
      return
    }
  }

  private fun applyAspectRatio() {
    if (isDisposed) return
    val player = mediaPlayer ?: return

    // Determine the explicit aspect ratio (null = let VLC use video's natural ratio)
    val aspect = if (autoAspectRatio == true || videoAspectRatio == null) {
      null
    } else {
      videoAspectRatio?.let { aspectRatioString(it) }
    }

    when (resizeMode) {
      PlayerResizeMode.FILL -> {
        // Stretch to fill: set aspect ratio to container dimensions
        val w = surfaceView.width
        val h = surfaceView.height
        if (w > 0 && h > 0) {
          player.setScale(0f)
          player.setAspectRatio("$w:$h")
        }
      }
      PlayerResizeMode.COVER -> {
        // Fill container preserving aspect ratio (may crop)
        player.setAspectRatio(aspect)
        if (videoWidth > 0 && videoHeight > 0) {
          val w = surfaceView.width.toFloat()
          val h = surfaceView.height.toFloat()
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
        // Native size, no scaling
        player.setAspectRatio(aspect)
        player.setScale(1f)
      }
      PlayerResizeMode.CONTAIN,
      PlayerResizeMode.SCALE_DOWN,
      null -> {
        // Fit inside container preserving aspect ratio (VLC default)
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

  private fun applyVolume() {
    if (isDisposed) return
    val player = mediaPlayer ?: return
    val isMuted = muted == true
    val volumeValue = volume?.let { (it * 100).toInt() } ?: lastKnownVolume
    if (!isMuted) {
      lastKnownVolume = volumeValue
    }
    player.volume = if (isMuted) 0 else volumeValue
  }

  private fun loadMedia(value: VLCPlayerSource) {
    if (isDisposed) return
    val vlc = libVLC ?: run {
      onError?.invoke(SimpleCallbackEventProps(0.0))
      return
    }
    val options = value.initOptions?.toList() ?: defaultOptions()
    ensurePlayer(options)
    val player = mediaPlayer ?: return
    try {
      val media = Media(vlc, Uri.parse(value.uri))
      subtitleUri?.let {
        try {
          media.addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 0, it))
        } catch (_: Exception) {
          return@let
        }
      }
      player.media = media
    } catch (_: Exception) {
      onError?.invoke(SimpleCallbackEventProps(0.0))
      return
    }
    audioTrack?.let { player.setAudioTrack(it.toInt()) }
    textTrack?.let { player.setSpuTrack(it.toInt()) }
    applyAspectRatio()

    val shouldAutoplay = autoplay != false && paused != true
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
          onBufferingEvent = SimpleCallbackEventProps(0.0)
        }
        MediaPlayer.Event.EndReached -> {
          onEndedEvent = SimpleCallbackEventProps(0.0)
          if (loop == true) {
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

    payload.onPlayingEvent?.let { onPlaying?.invoke(it) }
    payload.onPausedEvent?.let { onPaused?.invoke(it) }
    payload.onStoppedEvent?.let { onStopped?.invoke(it) }
    payload.onBufferingEvent?.let { onBuffering?.invoke(it) }
    payload.onEndedEvent?.let { onEnded?.invoke(it) }
    payload.onErrorEvent?.let { onError?.invoke(it) }
    payload.onProgressEvent?.let { onProgress?.invoke(it) }
    if (payload.shouldEmitLoad) {
      emitLoadIfNeeded()
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
      info?.let { onLoad?.invoke(it) }
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

  private fun releasePlayer() {
    if (isDisposed) return
    synchronized(playerLock) {
      releasePlayerLocked()
    }
  }

  private fun releasePlayerLocked() {
    if (viewsAttached) {
      mediaPlayer?.vlcVout?.detachViews()
      viewsAttached = false
    }
    mediaPlayer?.release()
    mediaPlayer = null
    libVLC?.release()
    libVLC = null
    currentInitOptions = null
  }

  private fun clearCallbacks() {
    onPlaying = null
    onProgress = null
    onPaused = null
    onStopped = null
    onBuffering = null
    onEnded = null
    onError = null
    onLoad = null
  }
}
