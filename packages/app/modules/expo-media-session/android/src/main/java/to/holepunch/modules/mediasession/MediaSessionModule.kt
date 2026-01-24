package to.holepunch.modules.mediasession

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.drawable.Icon
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
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.media.session.MediaButtonReceiver
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * Singleton bridge for PiP callbacks from MainActivity.
 * MainActivity calls these static methods; the module instance receives the events.
 */
object PipBridge {
    private var moduleInstance: MediaSessionModule? = null
    private var pipEnabledForLegacy: Boolean = false  // For Android < 12 manual entry
    
    fun register(module: MediaSessionModule) {
        moduleInstance = module
    }
    
    fun unregister(module: MediaSessionModule) {
        if (moduleInstance === module) {
            moduleInstance = null
        }
    }
    
    fun setPipEnabledForLegacy(enabled: Boolean) {
        pipEnabledForLegacy = enabled
    }
    
    fun isPipEnabledForLegacy(): Boolean = pipEnabledForLegacy
    
    /**
     * Called from MainActivity.onUserLeaveHint() for Android < 12.
     */
    fun onUserLeaveHint(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ uses auto-enter, skip manual entry
            return
        }
        if (!pipEnabledForLegacy) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: PiP not enabled, skipping")
            return
        }
        moduleInstance?.enterPiPFromCallback(activity)
    }
    
    /**
     * Called from MainActivity.onPictureInPictureModeChanged().
     */
    fun onPictureInPictureModeChanged(activity: Activity, isInPictureInPictureMode: Boolean, newConfig: Configuration?) {
        android.util.Log.d("PipBridge", "onPictureInPictureModeChanged: $isInPictureInPictureMode")
        moduleInstance?.onPipModeChangedFromCallback(activity, isInPictureInPictureMode)
    }
}

class MediaSessionModule : Module() {
    // Use source rect hints to align PiP content with the actual video bounds.
    private val useSourceRectHint = true
    private var mediaSession: MediaSessionCompat? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isSessionActive = false
    private var noisyReceiver: BroadcastReceiver? = null
    private var currentMetadata: MediaMetadataCompat.Builder = MediaMetadataCompat.Builder()
    private var currentPlaybackState: PlaybackStateCompat.Builder = PlaybackStateCompat.Builder()
    private var wasInPipMode = false
    private var pipSourceRect: android.graphics.Rect? = null
    private var lastIsPlaying: Boolean? = null
    private var currentIsPlaying: Boolean = false

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

        OnCreate {
            PipBridge.register(this@MediaSessionModule)
            PipServiceBridge.register(this@MediaSessionModule)
        }

        OnDestroy {
            PipBridge.unregister(this@MediaSessionModule)
            PipServiceBridge.unregister(this@MediaSessionModule)
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

        val playStateChanged = currentIsPlaying != isPlaying
        currentIsPlaying = isPlaying

        mediaSession?.setPlaybackState(currentPlaybackState.build())
        mediaSession?.setMetadata(currentMetadata.build())
        updateNotification()
        
        if (playStateChanged && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val activity = appContext.currentActivity
            if (activity != null && activity.isInPictureInPictureMode) {
                refreshPipParams(activity)
            }
        }
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
            updatePipPlayState(true)
            sendEvent("onRemoteCommand", mapOf("command" to "play"))
        }

        override fun onPause() {
            android.util.Log.d("MediaSession", "onPause callback")
            updatePipPlayState(false)
            sendEvent("onRemoteCommand", mapOf("command" to "pause"))
        }

        override fun onStop() {
            android.util.Log.d("MediaSession", "onStop callback")
            updatePipPlayState(false)
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
    
    private fun updatePipPlayState(isPlaying: Boolean) {
        if (currentIsPlaying == isPlaying) return
        currentIsPlaying = isPlaying
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val activity = appContext.currentActivity
            if (activity != null && activity.isInPictureInPictureMode) {
                refreshPipParams(activity)
            }
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
        if (useSourceRectHint) {
            pipSourceRect?.let { rect ->
                if (!rect.isEmpty) {
                    builder.setSourceRectHint(rect)
                }
            }
        }

        return activity.enterPictureInPictureMode(builder.build())
    }

    private fun setAutoPiP(enabled: Boolean) {
        android.util.Log.d("MediaSession", "setAutoPiP called: enabled=$enabled, SDK=${Build.VERSION.SDK_INT}")
        
        PipBridge.setPipEnabledForLegacy(enabled)
        
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            android.util.Log.d("MediaSession", "Android < 12: using legacy PiP via onUserLeaveHint")
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
            .setSeamlessResizeEnabled(true)
        
        if (useSourceRectHint) {
            pipSourceRect?.let { rect ->
                if (!rect.isEmpty) {
                    builder.setSourceRectHint(rect)
                }
            }
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setActions(buildPipActions(activity))
        }
        
        activity.setPictureInPictureParams(builder.build())
        android.util.Log.d("MediaSession", "PiP params set successfully with seamlessResize=true")
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(true)
            }
            builder.setActions(buildPipActions(activity))
            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("MediaSession", "PiP params updated")
        }
    }
    
    internal fun enterPiPFromCallback(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        
        android.util.Log.d("MediaSession", "enterPiPFromCallback: entering PiP from onUserLeaveHint")
        
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(16, 9))
        
        if (useSourceRectHint) {
            pipSourceRect?.let { rect ->
                if (!rect.isEmpty) {
                    builder.setSourceRectHint(rect)
                }
            }
        }
        
        builder.setActions(buildPipActions(activity))
        
        try {
            activity.enterPictureInPictureMode(builder.build())
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "Failed to enter PiP from callback: ${e.message}")
        }
    }
    
    internal fun onPipModeChangedFromCallback(activity: Activity, isInPip: Boolean) {
        if (isInPip == wasInPipMode) return
        
        wasInPipMode = isInPip
        android.util.Log.d("MediaSession", "PiP mode changed (callback): $isInPip")
        sendPipEvent(activity, isInPip)
        
        if (isInPip && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            refreshPipParams(activity)
            forceLayoutRefresh(activity)
            Handler(Looper.getMainLooper()).postDelayed({
                refreshPipParams(activity)
                forceLayoutRefresh(activity)
                sendPipEvent(activity, isInPip)
            }, 150)
            Handler(Looper.getMainLooper()).postDelayed({
                refreshPipParams(activity)
                forceLayoutRefresh(activity)
                sendPipEvent(activity, isInPip)
            }, 350)
        }
    }

    private fun sendPipEvent(activity: Activity, isInPip: Boolean) {
        val (width, height) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = activity.windowManager.currentWindowMetrics.bounds
            Pair(bounds.width(), bounds.height())
        } else {
            val decorView = activity.window?.decorView
            Pair(decorView?.width ?: 0, decorView?.height ?: 0)
        }
        sendEvent(
            "onPictureInPictureChanged",
            mapOf(
                "isInPictureInPicture" to isInPip,
                "width" to width,
                "height" to height
            )
        )
    }

    private fun forceLayoutRefresh(activity: Activity) {
        try {
            val decorView = activity.window?.decorView ?: return
            val contentView = decorView.findViewById<ViewGroup>(android.R.id.content)
            val rootView = if (contentView != null && contentView.childCount > 0) {
                contentView.getChildAt(0)
            } else {
                decorView
            }

            val (width, height) = getWindowSize(activity)
            decorView.post {
                if (width > 0 && height > 0) {
                    val lp = rootView.layoutParams ?: ViewGroup.LayoutParams(width, height)
                    lp.width = width
                    lp.height = height
                    rootView.layoutParams = lp
                    rootView.layout(0, 0, width, height)
                }
                rootView.requestLayout()
                rootView.invalidate()
            }
            android.util.Log.d("MediaSession", "Forced layout refresh (root resized)")
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "Failed to force layout refresh: ${e.message}")
        }
    }

    private fun getWindowSize(activity: Activity): Pair<Int, Int> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = activity.windowManager.currentWindowMetrics.bounds
            Pair(bounds.width(), bounds.height())
        } else {
            val displayMetrics = activity.resources.displayMetrics
            Pair(displayMetrics.widthPixels, displayMetrics.heightPixels)
        }
    }
    
    private fun refreshPipParams(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        
        try {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(true)
            }
            if (useSourceRectHint) {
                pipSourceRect?.let { rect ->
                    if (!rect.isEmpty) {
                        builder.setSourceRectHint(rect)
                    }
                }
            }
            builder.setActions(buildPipActions(activity))
            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("MediaSession", "Refreshed PiP params")
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "Failed to refresh PiP params: ${e.message}")
        }
    }
    
    private fun buildPipActions(activity: Activity): List<RemoteAction> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return emptyList()
        
        val context = activity.applicationContext
        val actions = mutableListOf<RemoteAction>()
        
        android.util.Log.d("MediaSession", "buildPipActions: currentIsPlaying=$currentIsPlaying")
        
        val rewindIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_PIP_REWIND
        }
        val rewindPendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(
                context,
                REQUEST_REWIND,
                rewindIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            PendingIntent.getService(
                context,
                REQUEST_REWIND,
                rewindIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        actions.add(RemoteAction(
            Icon.createWithResource(context, android.R.drawable.ic_media_rew),
            "Rewind",
            "Rewind 10 seconds",
            rewindPendingIntent
        ))
        
        val playPauseIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = if (currentIsPlaying) ACTION_PIP_PAUSE else ACTION_PIP_PLAY
        }
        val playPausePendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(
                context,
                REQUEST_PLAY_PAUSE,
                playPauseIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            PendingIntent.getService(
                context,
                REQUEST_PLAY_PAUSE,
                playPauseIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val playPauseIcon = if (currentIsPlaying) {
            Icon.createWithResource(context, android.R.drawable.ic_media_pause)
        } else {
            Icon.createWithResource(context, android.R.drawable.ic_media_play)
        }
        val playPauseLabel = if (currentIsPlaying) "Pause" else "Play"
        actions.add(RemoteAction(playPauseIcon, playPauseLabel, playPauseLabel, playPausePendingIntent))
        
        val forwardIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_PIP_FORWARD
        }
        val forwardPendingIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(
                context,
                REQUEST_FORWARD,
                forwardIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            PendingIntent.getService(
                context,
                REQUEST_FORWARD,
                forwardIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        actions.add(RemoteAction(
            Icon.createWithResource(context, android.R.drawable.ic_media_ff),
            "Forward",
            "Forward 10 seconds",
            forwardPendingIntent
        ))
        
        android.util.Log.d("MediaSession", "buildPipActions: built ${actions.size} actions")
        return actions
    }
    
    internal fun handlePipPlay() {
        android.util.Log.d("MediaSession", "handlePipPlay")
        updatePipPlayState(true)
        sendEvent("onRemoteCommand", mapOf("command" to "play"))
    }
    
    internal fun handlePipPause() {
        android.util.Log.d("MediaSession", "handlePipPause")
        updatePipPlayState(false)
        sendEvent("onRemoteCommand", mapOf("command" to "pause"))
    }
    
    internal fun handlePipRewind() {
        android.util.Log.d("MediaSession", "handlePipRewind")
        sendEvent("onRemoteCommand", mapOf("command" to "skipBackward", "interval" to 10))
    }
    
    internal fun handlePipForward() {
        android.util.Log.d("MediaSession", "handlePipForward")
        sendEvent("onRemoteCommand", mapOf("command" to "skipForward", "interval" to 10))
    }

    private fun cleanup() {
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
    
    companion object {
        const val ACTION_PIP_PLAY = "to.holepunch.mediasession.PIP_PLAY"
        const val ACTION_PIP_PAUSE = "to.holepunch.mediasession.PIP_PAUSE"
        const val ACTION_PIP_REWIND = "to.holepunch.mediasession.PIP_REWIND"
        const val ACTION_PIP_FORWARD = "to.holepunch.mediasession.PIP_FORWARD"
        
        private const val REQUEST_PLAY_PAUSE = 1
        private const val REQUEST_REWIND = 2
        private const val REQUEST_FORWARD = 3
    }
}
