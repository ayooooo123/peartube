package to.holepunch.modules.mediasession

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Bitmap
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Rational
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

class MediaSessionModule : Module() {
    private var mediaSession: MediaSessionCompat? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isSessionActive = false
    private var noisyReceiver: BroadcastReceiver? = null
    private var currentMetadata: MediaMetadataCompat.Builder = MediaMetadataCompat.Builder()
    private var currentPlaybackState: PlaybackStateCompat.Builder = PlaybackStateCompat.Builder()
    private var wasInPipMode = false
    private var pipPollingHandler: Handler? = null
    private var pipPollingRunnable: Runnable? = null
    private var pipSourceRect: android.graphics.Rect? = null
    private var lastIsPlaying: Boolean? = null

    override fun definition() = ModuleDefinition {
        Name("MediaSession")

        Events(
            "onRemoteCommand",
            "onAudioInterruption",
            "onAudioRouteChange",
            "onPictureInPictureChanged"
        )

        AsyncFunction("setActive") { active: Boolean, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    setSessionActive(active)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to set session active", e)
                }
            }
        }

        AsyncFunction("setNowPlaying") { metadata: Map<String, Any?>, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    updateNowPlaying(metadata)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to update now playing", e)
                }
            }
        }

        AsyncFunction("setPlaybackState") { state: Map<String, Any?>, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    updatePlaybackState(state)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to update playback state", e)
                }
            }
        }

        AsyncFunction("clearNowPlaying") { promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    clearNowPlayingInfo()
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to clear now playing", e)
                }
            }
        }

        AsyncFunction("enterPictureInPicture") { promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    val result = enterPiP()
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("PIP_ERROR", e.message ?: "Failed to enter PiP", e)
                }
            }
        }

        AsyncFunction("setAutoPictureInPicture") { enabled: Boolean, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    setAutoPiP(enabled)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("PIP_ERROR", e.message ?: "Failed to set auto PiP", e)
                }
            }
        }

        AsyncFunction("isPictureInPictureSupported") { promise: Promise ->
            val context = appContext.reactContext ?: run {
                promise.resolve(false)
                return@AsyncFunction
            }
            val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_PICTURE_IN_PICTURE)
            promise.resolve(supported)
        }

        AsyncFunction("setPictureInPictureSourceRect") { rect: Map<String, Double>, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    setPipSourceRect(rect)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("PIP_ERROR", e.message ?: "Failed to set PiP source rect", e)
                }
            }
        }

        OnDestroy {
            cleanup()
        }
    }

    private fun setSessionActive(active: Boolean) {
        val context = appContext.reactContext ?: return

        if (active) {
            if (mediaSession == null) {
                val componentName = ComponentName(context, androidx.media.session.MediaButtonReceiver::class.java)
                mediaSession = MediaSessionCompat(context, "PearTubeMediaSession", componentName, null).apply {
                    setCallback(mediaSessionCallback)
                    setFlags(
                        MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                        MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
                    )
                }
            }

            mediaSession?.isActive = true
            registerNoisyReceiver()
            startForegroundService()
            isSessionActive = true
        } else {
            mediaSession?.isActive = false
            abandonAudioFocus()
            unregisterNoisyReceiver()
            stopForegroundService()
            isSessionActive = false
        }
    }

    private suspend fun updateNowPlaying(metadata: Map<String, Any?>) {
        (metadata["title"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_TITLE, it)
        }
        (metadata["artist"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, it)
        }
        (metadata["album"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, it)
        }
        (metadata["duration"] as? Number)?.let {
            currentMetadata.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (it.toDouble() * 1000).toLong())
        }

        (metadata["artworkUrl"] as? String)?.let { url ->
            withContext(Dispatchers.IO) {
                try {
                    val bitmap = URL(url).openStream().use { android.graphics.BitmapFactory.decodeStream(it) }
                    if (bitmap != null) {
                        currentMetadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, bitmap)
                    }
                } catch (_: Exception) {}
            }
        }

        mediaSession?.setMetadata(currentMetadata.build())
        updateNotification()
    }

    private fun updatePlaybackState(state: Map<String, Any?>) {
        val isPlaying = state["isPlaying"] as? Boolean ?: false
        val position = ((state["position"] as? Number)?.toDouble() ?: 0.0) * 1000
        val rate = (state["rate"] as? Number)?.toFloat() ?: 1.0f
        val duration = ((state["duration"] as? Number)?.toDouble() ?: 0.0) * 1000

        currentMetadata.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration.toLong())

        val playbackState = if (isPlaying) {
            PlaybackStateCompat.STATE_PLAYING
        } else {
            PlaybackStateCompat.STATE_PAUSED
        }

        val actions = PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or
                PlaybackStateCompat.ACTION_STOP or
                PlaybackStateCompat.ACTION_SEEK_TO or
                PlaybackStateCompat.ACTION_FAST_FORWARD or
                PlaybackStateCompat.ACTION_REWIND

        currentPlaybackState
            .setState(playbackState, position.toLong(), if (isPlaying) rate else 0f)
            .setActions(actions)

        if (isSessionActive && lastIsPlaying != isPlaying) {
            lastIsPlaying = isPlaying
            if (isPlaying) {
                requestAudioFocus()
            } else {
                abandonAudioFocus()
            }
        }

        mediaSession?.setPlaybackState(currentPlaybackState.build())
        mediaSession?.setMetadata(currentMetadata.build())
        updateNotification()
    }

    private fun clearNowPlayingInfo() {
        currentMetadata = MediaMetadataCompat.Builder()
        currentPlaybackState = PlaybackStateCompat.Builder()
        mediaSession?.setMetadata(null)
        mediaSession?.setPlaybackState(null)
        stopForegroundService()
    }

    private val mediaSessionCallback = object : MediaSessionCompat.Callback() {
        override fun onPlay() {
            android.util.Log.d("MediaSession", "onPlay callback")
            sendEvent("onRemoteCommand", mapOf("command" to "play"))
        }

        override fun onPause() {
            android.util.Log.d("MediaSession", "onPause callback")
            sendEvent("onRemoteCommand", mapOf("command" to "pause"))
        }

        override fun onStop() {
            android.util.Log.d("MediaSession", "onStop callback")
            sendEvent("onRemoteCommand", mapOf("command" to "stop"))
        }

        override fun onSkipToNext() {
            android.util.Log.d("MediaSession", "onSkipToNext callback")
            sendEvent("onRemoteCommand", mapOf("command" to "nextTrack"))
        }

        override fun onSkipToPrevious() {
            android.util.Log.d("MediaSession", "onSkipToPrevious callback")
            sendEvent("onRemoteCommand", mapOf("command" to "previousTrack"))
        }

        override fun onSeekTo(pos: Long) {
            sendEvent("onRemoteCommand", mapOf("command" to "seekTo", "position" to (pos / 1000.0)))
        }

        override fun onFastForward() {
            android.util.Log.d("MediaSession", "onFastForward callback")
            sendEvent("onRemoteCommand", mapOf("command" to "skipForward", "interval" to 10))
        }

        override fun onRewind() {
            android.util.Log.d("MediaSession", "onRewind callback")
            sendEvent("onRemoteCommand", mapOf("command" to "skipBackward", "interval" to 10))
        }
    }

    private fun requestAudioFocus() {
        val context = appContext.reactContext ?: return
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build()

            audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(audioAttributes)
                .setAcceptsDelayedFocusGain(true)
                .setOnAudioFocusChangeListener { focusChange ->
                    handleAudioFocusChange(focusChange)
                }
                .build()

            audioManager?.requestAudioFocus(audioFocusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                { focusChange -> handleAudioFocusChange(focusChange) },
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audioManager?.abandonAudioFocus(null)
        }
    }

    private fun handleAudioFocusChange(focusChange: Int) {
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                sendEvent("onAudioInterruption", mapOf("type" to "began"))
                sendEvent("onRemoteCommand", mapOf("command" to "pause"))
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                sendEvent("onAudioInterruption", mapOf("type" to "began"))
                sendEvent("onRemoteCommand", mapOf("command" to "pause"))
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                sendEvent("onAudioInterruption", mapOf("type" to "began"))
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                sendEvent("onAudioInterruption", mapOf("type" to "ended", "shouldResume" to true))
            }
        }
    }

    private fun registerNoisyReceiver() {
        val context = appContext.reactContext ?: return
        if (noisyReceiver != null) return

        noisyReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                    sendEvent("onAudioRouteChange", mapOf("reason" to "oldDeviceUnavailable"))
                    sendEvent("onRemoteCommand", mapOf("command" to "pause"))
                }
            }
        }

        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        ContextCompat.registerReceiver(
            context,
            noisyReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun unregisterNoisyReceiver() {
        val context = appContext.reactContext ?: return
        noisyReceiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: Exception) {}
            noisyReceiver = null
        }
    }

    private fun startForegroundService() {
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            putExtra("mediaSessionToken", mediaSession?.sessionToken)
        }
        ContextCompat.startForegroundService(context, intent)
    }

    private fun stopForegroundService() {
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java)
        context.stopService(intent)
    }

    private fun updateNotification() {
        if (!isSessionActive || mediaSession == null) return
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = "UPDATE_NOTIFICATION"
            putExtra("mediaSessionToken", mediaSession?.sessionToken)
        }
        context.startService(intent)
    }

    private fun enterPiP(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false

        val activity = appContext.currentActivity ?: return false

        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
        pipSourceRect?.let { rect ->
            if (!rect.isEmpty) {
                builder.setSourceRectHint(rect)
            }
        }

        return activity.enterPictureInPictureMode(builder.build())
    }

    private fun setAutoPiP(enabled: Boolean) {
        android.util.Log.d("MediaSession", "setAutoPiP called: enabled=$enabled, SDK=${Build.VERSION.SDK_INT}")
        
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            android.util.Log.d("MediaSession", "Auto PiP not supported (requires Android 12+)")
            return
        }

        val activity = appContext.currentActivity
        if (activity == null) {
            android.util.Log.e("MediaSession", "No current activity for PiP")
            return
        }
        
        android.util.Log.d("MediaSession", "Setting PiP params on activity: ${activity.javaClass.name}")

        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
            .setAutoEnterEnabled(enabled)
            .setSeamlessResizeEnabled(false)
        
        pipSourceRect?.let { rect ->
            if (!rect.isEmpty) {
                builder.setSourceRectHint(rect)
            }
        }
        
        activity.setPictureInPictureParams(builder.build())
        android.util.Log.d("MediaSession", "PiP params set successfully with seamlessResize=false")
        
        if (enabled) {
            startPipPolling()
        } else {
            stopPipPolling()
        }
    }
    
    private fun setPipSourceRect(rect: Map<String, Double>) {
        val x = rect["x"]?.toInt() ?: 0
        val y = rect["y"]?.toInt() ?: 0
        val width = rect["width"]?.toInt() ?: 0
        val height = rect["height"]?.toInt() ?: 0
        
        pipSourceRect = android.graphics.Rect(x, y, x + width, y + height)
        android.util.Log.d("MediaSession", "PiP sourceRect set to: $pipSourceRect (x=$x, y=$y, w=$width, h=$height)")
        
        val activity = appContext.currentActivity ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity.isInPictureInPictureMode) {
            android.util.Log.d("MediaSession", "Skipping PiP params update while already in PiP")
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .setSourceRectHint(pipSourceRect)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(false)
            }
            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("MediaSession", "PiP params updated with sourceRect")
        }
    }
    
    private fun startPipPolling() {
        if (pipPollingHandler != null) return
        
        pipPollingHandler = Handler(Looper.getMainLooper())
        pipPollingRunnable = object : Runnable {
            override fun run() {
                checkPipModeChanged()
                pipPollingHandler?.postDelayed(this, 200)
            }
        }
        pipPollingHandler?.post(pipPollingRunnable!!)
        android.util.Log.d("MediaSession", "Started PiP polling")
    }
    
    private fun stopPipPolling() {
        pipPollingRunnable?.let { pipPollingHandler?.removeCallbacks(it) }
        pipPollingHandler = null
        pipPollingRunnable = null
        android.util.Log.d("MediaSession", "Stopped PiP polling")
    }

    private fun checkPipModeChanged() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val activity = appContext.currentActivity ?: return
            val isInPip = activity.isInPictureInPictureMode
            if (isInPip != wasInPipMode) {
                val wasInPip = wasInPipMode
                wasInPipMode = isInPip
                android.util.Log.d("MediaSession", "PiP mode changed: $isInPip")
                sendEvent("onPictureInPictureChanged", mapOf("isInPictureInPicture" to isInPip))
                
                if (isInPip && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Handler(Looper.getMainLooper()).postDelayed({
                        try {
                            val builder = PictureInPictureParams.Builder()
                                .setAspectRatio(Rational(16, 9))
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                builder.setSeamlessResizeEnabled(false)
                            }
                            pipSourceRect?.let { rect ->
                                if (!rect.isEmpty) {
                                    builder.setSourceRectHint(rect)
                                }
                            }
                            activity.setPictureInPictureParams(builder.build())
                            android.util.Log.d("MediaSession", "Refreshed PiP params after entering PiP")
                        } catch (e: Exception) {
                            android.util.Log.e("MediaSession", "Failed to refresh PiP params: ${e.message}")
                        }
                    }, 100)
                }
            }
        }
    }

    private fun cleanup() {
        stopPipPolling()
        if (isSessionActive) {
            abandonAudioFocus()
            unregisterNoisyReceiver()
            stopForegroundService()
            mediaSession?.isActive = false
            mediaSession?.release()
            mediaSession = null
            isSessionActive = false
        }
    }
}
