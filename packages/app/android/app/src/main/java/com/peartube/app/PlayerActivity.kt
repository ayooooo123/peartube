package com.peartube.app

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import to.holepunch.modules.mediasession.NativePlaybackController
import to.holepunch.modules.mediasession.PipBridge
import to.holepunch.modules.mediasession.PlaybackHostBridge
import to.holepunch.modules.mediasession.PlayerActivityPayload

class PlayerActivity : AppCompatActivity(), NativePlaybackController {
  private lateinit var playerView: PlayerView
  private lateinit var slotContainer: FrameLayout
  private var player: ExoPlayer? = null
  private var currentPayload: PlayerActivityPayload? = null
  private var didRequestLaunchIntoPip = false

  private fun getPlayerSlotHeightPx(): Int {
    val width = resources.displayMetrics.widthPixels
    return ((width * 9f) / 16f).toInt()
  }

  private fun getStatusBarHeightPx(): Int {
    val resId = resources.getIdentifier("status_bar_height", "dimen", "android")
    return if (resId > 0) resources.getDimensionPixelSize(resId) else 0
  }

  private val playerListener = object : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
      syncPlaybackState()
      maybeEnterPipOnLaunch()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      syncPlaybackState()
      maybeEnterPipOnLaunch()
    }

    override fun onRenderedFirstFrame() {
      maybeEnterPipOnLaunch()
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) {
      if (videoSize.width > 0 && videoSize.height > 0) {
        PipBridge.setPipAspectRatio(videoSize.width, videoSize.height)
      }
      maybeEnterPipOnLaunch()
    }

    override fun onPlayerError(error: PlaybackException) {
      android.util.Log.e("PlayerActivity", "Playback error", error)
      syncPlaybackState()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.PlayerActivityTheme)
    super.onCreate(savedInstanceState)

    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))

    val slotHeight = getPlayerSlotHeightPx()
    val topInset = getStatusBarHeightPx()

    playerView = PlayerView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
      useController = true
      setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
      setBackgroundColor(Color.BLACK)
      keepScreenOn = true
    }

    slotContainer = FrameLayout(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        slotHeight,
        Gravity.TOP,
      ).apply {
        topMargin = topInset
      }
      setBackgroundColor(Color.BLACK)
      addView(playerView)
    }

    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.TRANSPARENT)
      addView(slotContainer)
    }
    setContentView(root)

    PlaybackHostBridge.registerNativeHostActivity(this)
    applyLaunchPayload(PlayerActivityPayload.fromIntent(intent))
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    applyLaunchPayload(PlayerActivityPayload.fromIntent(intent))
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      maybeEnterPipOnLaunch()
    }
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    PipBridge.onUserLeaveHint(this)
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)
  }

  override fun onDestroy() {
    PlaybackHostBridge.unregisterNativeHostActivity(this)
    PlaybackHostBridge.unregisterNativePlaybackController(this)
    PlaybackHostBridge.setSessionActive(false)
    PlaybackHostBridge.clearNowPlaying()
    PlaybackHostBridge.clearLaunchPayload()
    PipBridge.setPipEnabled(false)

    playerView.player = null
    player?.removeListener(playerListener)
    player?.release()
    player = null

    super.onDestroy()
  }

  override fun play(): Boolean {
    runOnUiThread {
      player?.playWhenReady = true
      player?.play()
      syncPlaybackState()
    }
    return true
  }

  override fun pause(): Boolean {
    runOnUiThread {
      player?.pause()
      syncPlaybackState()
    }
    return true
  }

  override fun stop(reason: String?): Boolean {
    runOnUiThread {
      player?.pause()
      player?.stop()
      syncPlaybackState()
      finish()
    }
    return true
  }

  override fun seekTo(positionMs: Long): Boolean {
    runOnUiThread {
      player?.seekTo(positionMs.coerceAtLeast(0L))
      syncPlaybackState()
    }
    return true
  }

  override fun seekBy(deltaMs: Long): Boolean {
    runOnUiThread {
      val exoPlayer = player ?: return@runOnUiThread
      val durationMs = exoPlayer.duration.takeIf { it != C.TIME_UNSET && it >= 0 } ?: Long.MAX_VALUE
      val target = (exoPlayer.currentPosition + deltaMs).coerceAtLeast(0L).coerceAtMost(durationMs)
      exoPlayer.seekTo(target)
      syncPlaybackState()
    }
    return true
  }

  override fun enterBackgroundAudio(): Boolean {
    runOnUiThread {
      PipBridge.setPipEnabled(false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        moveTaskToBack(true)
      }
    }
    return true
  }

  private fun applyLaunchPayload(payload: PlayerActivityPayload?) {
    if (payload == null || payload.sourceUrl.isBlank()) {
      finish()
      return
    }

    val isSameSession = payload.matchesSession(currentPayload)
    currentPayload = payload
    didRequestLaunchIntoPip = false

    PlaybackHostBridge.rememberLaunchPayload(payload)
    PlaybackHostBridge.registerNativePlaybackController(this, payload)
    PlaybackHostBridge.setNowPlaying(payload.toNowPlayingMetadata())
    PipBridge.setPipEnabled(true)

    val exoPlayer = ensurePlayer()
    val mediaItemBuilder = MediaItem.Builder().setUri(payload.sourceUrl)
    payload.mimeType?.let { mediaItemBuilder.setMimeType(it) }

    if (!isSameSession) {
      exoPlayer.setMediaItem(mediaItemBuilder.build(), payload.startPositionMs)
      exoPlayer.prepare()
    } else if (payload.startPositionMs > 0) {
      exoPlayer.seekTo(payload.startPositionMs)
    }

    exoPlayer.playWhenReady = payload.shouldAutoplay
    syncPlaybackState()
    maybeEnterPipOnLaunch()
  }

  private fun ensurePlayer(): ExoPlayer {
    val existing = player
    if (existing != null) return existing

    val created = ExoPlayer.Builder(this).build().apply {
      val audioAttributes = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build()
      setAudioAttributes(audioAttributes, true)
      setHandleAudioBecomingNoisy(true)
      addListener(playerListener)
    }

    player = created
    playerView.player = created
    return created
  }

  private fun maybeEnterPipOnLaunch() {
    val payload = currentPayload ?: return
    val exoPlayer = player ?: return
    if (!payload.requestPipOnLaunch || didRequestLaunchIntoPip || isInPictureInPictureMode) return
    if (!hasWindowFocus() || playerView.width <= 0 || playerView.height <= 0) return
    if (exoPlayer.playbackState == Player.STATE_IDLE || exoPlayer.playbackState == Player.STATE_ENDED) return

    didRequestLaunchIntoPip = true
    playerView.post {
      if (isFinishing || isDestroyed) return@post
      PipBridge.setPipEnabled(true)
      PipBridge.updatePipSourceRectForCapture(this)
      val entered = PipBridge.enterPictureInPictureDirect(
        this,
        sourceRectHint = PipBridge.getLaunchIntoPipSourceRect(this),
      )
      if (!entered) {
        didRequestLaunchIntoPip = false
      }
    }
  }

  private fun syncPlaybackState() {
    val exoPlayer = player ?: return
    val durationMs = exoPlayer.duration.takeIf { it != C.TIME_UNSET && it >= 0 }
      ?: ((currentPayload?.durationSeconds ?: 0.0) * 1000.0).toLong()
    PlaybackHostBridge.setPlaybackState(
      mapOf(
        "isPlaying" to exoPlayer.isPlaying,
        "position" to (exoPlayer.currentPosition.toDouble() / 1000.0),
        "duration" to (durationMs.toDouble() / 1000.0),
        "rate" to exoPlayer.playbackParameters.speed.toDouble(),
      ),
    )
  }
}
