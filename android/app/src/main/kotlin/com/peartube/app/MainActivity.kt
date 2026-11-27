package com.peartube.app

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.peartube.app.player.PlayerHost
import com.peartube.app.ui.App
import com.peartube.app.ui.PearTubeTheme
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    private lateinit var player: PlayerHost
    private var pipReceiverRegistered = false

    private val pipActionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val model = (application as? PearTubeApp)?.model ?: return
            when (intent?.action) {
                ACTION_PIP_REWIND -> model.dispatchVideoMediaAction(MediaAction.SkipBack)
                ACTION_PIP_PLAY_PAUSE -> model.dispatchVideoMediaAction(MediaAction.TogglePlayPause)
                ACTION_PIP_FORWARD -> model.dispatchVideoMediaAction(MediaAction.SkipForward)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val model = (application as PearTubeApp).model
        if (savedInstanceState == null) {
            handleIncomingIntent(intent, model)
        }
        player = PlayerHost(this)
        registerPipReceiver()
        observePipParams(model)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { PearTubeTheme { App(model, player) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val model = (application as PearTubeApp).model
        handleIncomingIntent(intent, model)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Android 12+ (API 31+) uses setAutoEnterEnabled(true) for gesture-driven seamless PiP.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
        val model = (application as PearTubeApp).model
        if (model.hasActivePlayingVideo() && !isInPictureInPictureMode) {
            runCatching { enterPictureInPictureMode(buildPipParams(model)) }
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        val model = (application as PearTubeApp).model
        val dismissed = !isInPictureInPictureMode && lifecycle.currentState == Lifecycle.State.CREATED
        model.onSystemPipChanged(inPip = isInPictureInPictureMode, isDismissed = dismissed)
        if (!dismissed) {
            runCatching { setPictureInPictureParams(buildPipParams(model)) }
        }
    }

    override fun onStop() {
        super.onStop()
        val model = (application as PearTubeApp).model
        if (!isInPictureInPictureMode) {
            model.previewPlayer.stop()
        }
    }

    private fun observePipParams(model: AppModel) {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(
                    model.activeVideo,
                    model.videoMode,
                    model.isVideoPlaying,
                    model.videoAspectRatio,
                    model.videoSourceRect,
                ) { _, _, _, _, _ -> Unit }.collect {
                    runCatching { setPictureInPictureParams(buildPipParams(model)) }
                }
            }
        }
    }

    private fun buildPipParams(model: AppModel): PictureInPictureParams {
        // Android PictureInPictureParams requires an aspect ratio between 1/2.39 and 2.39.
        val clamped = model.videoAspectRatio.value.coerceIn(0.42f, 2.38f)
        val numerator = (clamped * 1000f).roundToInt().coerceIn(420, 2380)
        val playing = model.isVideoPlaying.value
        val canAutoPip = model.hasActivePlayingVideo()

        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(numerator, 1000))
            .setActions(buildPipActions(playing))

        model.videoSourceRect.value?.takeIf { !it.isEmpty }?.let { rect ->
            builder.setSourceRectHint(rect)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(canAutoPip)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    private fun buildPipActions(playing: Boolean): List<RemoteAction> {
        val rewIntent = pipPendingIntent(ACTION_PIP_REWIND, 201)
        val toggleIntent = pipPendingIntent(ACTION_PIP_PLAY_PAUSE, 202)
        val fwdIntent = pipPendingIntent(ACTION_PIP_FORWARD, 203)

        val rew = RemoteAction(
            Icon.createWithResource(this, android.R.drawable.ic_media_rew),
            "Back 10s",
            "Seek back 10 seconds",
            rewIntent,
        )
        val toggle = RemoteAction(
            Icon.createWithResource(
                this,
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            ),
            if (playing) "Pause" else "Play",
            if (playing) "Pause video" else "Play video",
            toggleIntent,
        )
        val fwd = RemoteAction(
            Icon.createWithResource(this, android.R.drawable.ic_media_ff),
            "Forward 10s",
            "Seek forward 10 seconds",
            fwdIntent,
        )
        return listOf(rew, toggle, fwd)
    }

    private fun pipPendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(action).setPackage(packageName)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(this, requestCode, intent, flags)
    }

    private fun registerPipReceiver() {
        if (pipReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(ACTION_PIP_REWIND)
            addAction(ACTION_PIP_PLAY_PAUSE)
            addAction(ACTION_PIP_FORWARD)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(pipActionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(pipActionReceiver, filter)
            }
            pipReceiverRegistered = true
        }
    }

    private fun unregisterPipReceiver() {
        if (!pipReceiverRegistered) return
        pipReceiverRegistered = false
        runCatching { unregisterReceiver(pipActionReceiver) }
    }

    private fun handleIncomingIntent(intent: Intent?, model: AppModel) {
        if (intent == null) return
        if (intent.action == Intent.ACTION_SEND) {
            val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
            val sharedSubject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
            val candidate = when {
                extractSharedUrl(sharedText) != null -> sharedText
                extractSharedUrl(sharedSubject) != null -> sharedSubject
                sharedText.isNotBlank() -> sharedText
                else -> sharedSubject
            }
            if (candidate.isNotBlank()) {
                model.handleSharedText(candidate)
            }
            return
        }
        intent.dataString?.takeIf { it.isNotBlank() }?.let { uri ->
            model.handleSharedText(uri)
        }
    }

    override fun onDestroy() {
        unregisterPipReceiver()
        val model = (application as PearTubeApp).model
        model.previewPlayer.stop()
        player.destroy()
        super.onDestroy()
    }

    companion object {
        private const val ACTION_PIP_REWIND = "com.peartube.app.action.PIP_REWIND"
        private const val ACTION_PIP_PLAY_PAUSE = "com.peartube.app.action.PIP_PLAY_PAUSE"
        private const val ACTION_PIP_FORWARD = "com.peartube.app.action.PIP_FORWARD"
    }
}
