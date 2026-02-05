package com.margelo.nitro.com.nitrovlc

import android.content.Context
import android.net.Uri
import android.view.SurfaceHolder
import android.view.SurfaceView
import org.videolan.libvlc.Dialog
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IVLCVout

class HybridNitroVLCView(private val context: Context) : HybridNitroVLCViewSpec(),
  SurfaceHolder.Callback,
  IVLCVout.OnNewVideoLayoutListener {

  private var libVLC: LibVLC? = null
  private var mediaPlayer: MediaPlayer? = null
  private val surfaceView: SurfaceView = SurfaceView(context)
  private var lastVideoInfoHash: String? = null
  private var lastKnownVolume: Int = 100
  private var currentInitOptions: List<String>? = null
  private var videoWidth: Int = 0
  private var videoHeight: Int = 0

  override val view: SurfaceView
    get() = surfaceView

  override var source: VLCPlayerSource = VLCPlayerSource("", null, null)
    set(value) {
      field = value
      if (value.uri.isNotBlank()) {
        loadMedia(value)
      }
    }

  override var subtitleUri: String? = null
    set(value) {
      field = value
      val player = mediaPlayer ?: return
      value?.let {
        player.addSlave(Media.Slave.Type.Subtitle, it, true)
      }
    }

  override var paused: Boolean? = null
    set(value) {
      field = value
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
      val player = mediaPlayer ?: return
      value?.let { player.rate = it.toFloat() }
    }

  override var seek: Double? = null
    set(value) {
      field = value
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
      applyVolume()
    }

  override var muted: Boolean? = null
    set(value) {
      field = value
      applyVolume()
    }

  override var audioTrack: Double? = null
    set(value) {
      field = value
      val player = mediaPlayer ?: return
      value?.let { player.setAudioTrack(it.toInt()) }
    }

  override var textTrack: Double? = null
    set(value) {
      field = value
      val player = mediaPlayer ?: return
      value?.let { player.setSpuTrack(it.toInt()) }
    }

  override var playInBackground: Boolean? = null

  override var videoAspectRatio: PlayerAspectRatio? = null
    set(value) {
      field = value
      applyAspectRatio()
    }

  override var autoAspectRatio: Boolean? = null
    set(value) {
      field = value
      applyAspectRatio()
    }

  override var resizeMode: PlayerResizeMode? = null
    set(value) {
      field = value
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
    mediaPlayer?.play()
  }

  override fun pause() {
    mediaPlayer?.pause()
  }

  override fun stop() {
    mediaPlayer?.stop()
  }

  override fun seek(position: Double) {
    mediaPlayer?.position = position.toFloat()
  }

  override fun setVolume(volume: Double) {
    this.volume = volume
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    attachSurface(holder)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    applySurfaceSize(width, height)
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    mediaPlayer?.vlcVout?.detachViews()
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
        dialog.postAction(if (accept) 1 else 2)
      }

      override fun onDisplay(dialog: Dialog.ErrorMessage) = Unit
      override fun onDisplay(dialog: Dialog.LoginDialog) = Unit
      override fun onDisplay(dialog: Dialog.ProgressDialog) = Unit
      override fun onCanceled(dialog: Dialog) = Unit
      override fun onProgressUpdate(dialog: Dialog.ProgressDialog) = Unit
    })
    attachSurface(surfaceView.holder)
    applyVolume()
    applyAspectRatio()
  }

  private fun attachSurface(holder: SurfaceHolder) {
    val player = mediaPlayer ?: return
    if (holder.surface == null || !holder.surface.isValid) return
    val vout = player.vlcVout
    vout.setVideoSurface(holder.surface, holder)
    if (!vout.areViewsAttached()) {
      vout.attachViews(this)
    }
  }

  private fun applySurfaceSize(width: Int, height: Int) {
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
    val player = mediaPlayer ?: return
    val auto = autoAspectRatio == true
    val aspect = if (auto) {
      val width = surfaceView.width
      val height = surfaceView.height
      if (width > 0 && height > 0) "$width:$height" else null
    } else {
      videoAspectRatio?.let { aspectRatioString(it) }
    }
    val mode = resizeMode
    when (mode) {
      PlayerResizeMode.FILL -> {
        player.setScale(0f)
        player.setAspectRatio(null)
      }
      PlayerResizeMode.COVER,
      PlayerResizeMode.CONTAIN,
      PlayerResizeMode.NONE,
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

  private fun applyVolume() {
    val player = mediaPlayer ?: return
    val isMuted = muted == true
    val volumeValue = volume?.let { (it * 100).toInt() } ?: lastKnownVolume
    if (!isMuted) {
      lastKnownVolume = volumeValue
    }
    player.volume = if (isMuted) 0 else volumeValue
  }

  private fun loadMedia(value: VLCPlayerSource) {
    val options = value.initOptions?.toList() ?: defaultOptions()
    ensurePlayer(options)
    val player = mediaPlayer ?: return
    val media = Media(libVLC, Uri.parse(value.uri))
    player.media = media
    media.release()

    subtitleUri?.let { player.addSlave(Media.Slave.Type.Subtitle, it, true) }
    audioTrack?.let { player.setAudioTrack(it.toInt()) }
    textTrack?.let { player.setSpuTrack(it.toInt()) }
    applyAspectRatio()

    val shouldAutoplay = autoplay != false && paused != true
    if (shouldAutoplay) {
      player.play()
    }
  }

  private fun handlePlayerEvent(event: MediaPlayer.Event) {
    val player = mediaPlayer ?: return
    when (event.type) {
      MediaPlayer.Event.Playing -> {
        val duration = player.length.toDouble()
        onPlaying?.invoke(OnPlayingEventProps(duration, 0.0, player.isSeekable))
        emitLoadIfNeeded()
      }
      MediaPlayer.Event.Paused -> {
        onPaused?.invoke(SimpleCallbackEventProps(0.0))
      }
      MediaPlayer.Event.Stopped -> {
        onStopped?.invoke(SimpleCallbackEventProps(0.0))
      }
      MediaPlayer.Event.Buffering -> {
        onBuffering?.invoke(SimpleCallbackEventProps(0.0))
      }
      MediaPlayer.Event.EndReached -> {
        onEnded?.invoke(SimpleCallbackEventProps(0.0))
      }
      MediaPlayer.Event.EncounteredError -> {
        onError?.invoke(SimpleCallbackEventProps(0.0))
      }
      MediaPlayer.Event.TimeChanged -> {
        val duration = player.length.toDouble()
        val currentTime = player.time.toDouble()
        val position = if (duration > 0.0) currentTime / duration else 0.0
        val remainingTime = duration - currentTime
        onProgress?.invoke(
          OnProgressEventProps(
            duration = duration,
            target = 0.0,
            currentTime = currentTime,
            position = position,
            remainingTime = remainingTime
          )
        )
      }
      else -> Unit
    }
  }

  private fun emitLoadIfNeeded() {
    val player = mediaPlayer ?: return
    val info = buildVideoInfo(player) ?: return
    val hash = "${info.duration}-${info.videoSize.width}-${info.videoSize.height}-${info.audioTracks.size}-${info.textTracks.size}"
    if (hash != lastVideoInfoHash) {
      lastVideoInfoHash = hash
      onLoad?.invoke(info)
    }
  }

  private fun buildVideoInfo(player: MediaPlayer): VideoInfo? {
    val videoTrack = player.currentVideoTrack ?: return null
    val audioTracks = player.audioTracks?.map {
      Track(it.id.toDouble(), it.name ?: "")
    }?.toTypedArray() ?: emptyArray()
    val textTracks = player.spuTracks?.map {
      Track(it.id.toDouble(), it.name ?: "")
    }?.toTypedArray() ?: emptyArray()
    return VideoInfo(
      duration = player.length.toDouble(),
      target = 0.0,
      videoSize = VideoSize(videoTrack.width.toDouble(), videoTrack.height.toDouble()),
      audioTracks = audioTracks,
      textTracks = textTracks
    )
  }

  private fun releasePlayer() {
    mediaPlayer?.vlcVout?.detachViews()
    mediaPlayer?.release()
    mediaPlayer = null
    libVLC?.release()
    libVLC = null
  }
}
