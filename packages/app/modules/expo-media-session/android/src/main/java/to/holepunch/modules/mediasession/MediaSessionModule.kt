package to.holepunch.modules.mediasession

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Rational
import androidx.core.content.ContextCompat
import androidx.media.session.MediaButtonReceiver
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.roundToInt
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * Simplified PiP bridge for MainActivity callbacks.
 *
 * VLC Android's approach: Set the correct aspect ratio BEFORE entering PiP,
 * then let Android handle the window sizing. Don't fight VLC's surface handling.
 */
object PipBridge {
    private var moduleInstance: MediaSessionModule? = null
    private var pipEnabled: Boolean = false

    @Volatile private var pipAspectRatioWidth: Int = 16
    @Volatile private var pipAspectRatioHeight: Int = 9

    fun register(module: MediaSessionModule) {
        moduleInstance = module
    }

    fun unregister(module: MediaSessionModule) {
        if (moduleInstance === module) {
            moduleInstance = null
        }
    }

    fun setPipEnabled(enabled: Boolean) {
        pipEnabled = enabled
        android.util.Log.d("PipBridge", "setPipEnabled: $enabled")

        // On Android 12+, set PiP params with autoEnterEnabled so the system
        // handles PiP entry automatically when user presses home
        moduleInstance?.updateActivityPipParams(enabled)
    }

    @JvmStatic
    fun isPipEnabled(): Boolean = pipEnabled

    @JvmStatic
    fun setPipAspectRatio(width: Int, height: Int) {
        if (width > 0 && height > 0) {
            pipAspectRatioWidth = width
            pipAspectRatioHeight = height
            android.util.Log.d("PipBridge", "setPipAspectRatio: ${width}x${height}")

            // Update activity PiP params with new aspect ratio
            if (pipEnabled) {
                moduleInstance?.updateActivityPipParams(true)
            }
        }
    }

    @JvmStatic
    fun getPipAspectRatio(): Rational {
        // Use stored dimensions directly, clamping to Android's allowed range
        var w = pipAspectRatioWidth
        var h = pipAspectRatioHeight

        // Ensure valid dimensions
        if (w <= 0 || h <= 0) {
            w = 16
            h = 9
        }

        // Android allows aspect ratios roughly between 1:2.39 and 2.39:1
        val ratio = w.toFloat() / h.toFloat()
        if (ratio < 0.42f) {
            // Too tall, clamp to 1:2.39
            w = 100
            h = 239
        } else if (ratio > 2.39f) {
            // Too wide, clamp to 2.39:1
            w = 239
            h = 100
        }

        android.util.Log.d("PipBridge", "getPipAspectRatio: returning ${w}x${h}")
        return Rational(w, h)
    }

    /**
     * Called from MainActivity.onUserLeaveHint().
     * On Android 12+, PiP auto-enters via setAutoEnterEnabled(true) in setPictureInPictureParams.
     * On older versions (API 26-30), we manually call enterPictureInPictureMode here.
     */
    fun onUserLeaveHint(activity: Activity) {
        android.util.Log.d("PipBridge", "onUserLeaveHint: pipEnabled=$pipEnabled")

        if (!pipEnabled) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: PiP not enabled, skipping")
            return
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: PiP requires API 26+")
            return
        }

        // On Android 12+, auto-enter is handled by setAutoEnterEnabled(true)
        // We set this in updateActivityPipParams(), so no manual entry needed
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: Android 12+, auto-enter handled by system")
            return
        }

        if (activity.isInPictureInPictureMode) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: already in PiP, skipping")
            return
        }

        // Manual PiP entry for Android 8-11 (API 26-30)
        try {
            val aspectRatio = getPipAspectRatio()

            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio)

            val actions = moduleInstance?.buildPipActions(activity) ?: emptyList()
            builder.setActions(actions)

            val params = builder.build()
            val result = activity.enterPictureInPictureMode(params)
            android.util.Log.d("PipBridge", "onUserLeaveHint: enterPictureInPictureMode returned $result")
        } catch (e: Exception) {
            android.util.Log.e("PipBridge", "onUserLeaveHint: failed", e)
        }
    }

    /**
     * Called from MainActivity.onPictureInPictureModeChanged().
     * Notifies both VLC player (directly, bypassing React) and JS layer.
     */
    @JvmStatic
    fun notifyPipModeChanged(activity: Activity, isInPip: Boolean, newConfig: Configuration? = null) {
        android.util.Log.d("PipBridge", "notifyPipModeChanged: isInPip=$isInPip")

        // Notify VLC player directly via reflection (bypasses React prop batching for immediate resize)
        // We use reflection because expo-media-session module doesn't have a direct dependency on VLC module
        val density = activity.resources.displayMetrics.density
        val widthDp = newConfig?.screenWidthDp ?: 0
        val heightDp = newConfig?.screenHeightDp ?: 0
        notifyVlcPlayerBridge(isInPip, widthDp, heightDp, density)

        // Also apply transform directly to all SurfaceViews with a small delay
        // This ensures the transform is applied after Android finishes PiP transition
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.postDelayed({
            applySurfaceViewTransforms(activity, isInPip, newConfig)
        }, 50) // Small delay to let Android settle

        // Still send event to JS for state management
        moduleInstance?.sendPipEvent(activity, isInPip, newConfig)
    }

    /**
     * Apply scale transforms directly to SurfaceViews at the Activity level.
     * This bypasses React Native's layout system entirely.
     */
    private fun applySurfaceViewTransforms(activity: Activity, isInPip: Boolean, newConfig: Configuration?) {
        val surfaceViews = findSurfaceViews(activity.window.decorView)
        android.util.Log.d("PipBridge", "applySurfaceViewTransforms: found ${surfaceViews.size} SurfaceViews, isInPip=$isInPip")

        for (sv in surfaceViews) {
            if (isInPip && newConfig != null) {
                val viewWidth = sv.width
                val viewHeight = sv.height
                if (viewWidth <= 0 || viewHeight <= 0) continue

                // Calculate PiP window size from Configuration
                // Use roundToInt() to match React Native's rounding behavior (vs truncation)
                val density = activity.resources.displayMetrics.density
                val pipWidth = (newConfig.screenWidthDp * density).roundToInt()
                val pipHeight = (newConfig.screenHeightDp * density).roundToInt()

                // Check if View already matches PiP dimensions (within 10px tolerance)
                val viewMatchesPip = kotlin.math.abs(viewWidth - pipWidth) < 10 && kotlin.math.abs(viewHeight - pipHeight) < 10
                if (viewMatchesPip) {
                    // View already resized to PiP, no transform needed
                    android.util.Log.d("PipBridge", "applySurfaceViewTransforms: view=${viewWidth}x${viewHeight} already matches pip=${pipWidth}x${pipHeight}, skipping transform")
                    continue
                }

                // Calculate scale - use width scale so video fills PiP width
                val scaleX = pipWidth.toFloat() / viewWidth
                val scaleY = pipHeight.toFloat() / viewHeight
                val viewIsLandscape = viewWidth >= viewHeight
                val scale = scaleX  // Always use width scale

                // Apply transform with pivot at top-left
                sv.pivotX = 0f
                sv.pivotY = 0f
                sv.scaleX = scale
                sv.scaleY = scale

                android.util.Log.d("PipBridge", "applySurfaceViewTransforms: view=${viewWidth}x${viewHeight} pip=${pipWidth}x${pipHeight} scale=$scale viewLandscape=$viewIsLandscape")
            } else {
                // Reset transforms
                sv.scaleX = 1f
                sv.scaleY = 1f
                sv.pivotX = sv.width / 2f
                sv.pivotY = sv.height / 2f
                android.util.Log.d("PipBridge", "applySurfaceViewTransforms: reset transform")
            }
        }
    }

    /**
     * Find all SurfaceViews in the view hierarchy.
     */
    private fun findSurfaceViews(view: android.view.View): List<android.view.SurfaceView> {
        val result = mutableListOf<android.view.SurfaceView>()
        if (view is android.view.SurfaceView) {
            result.add(view)
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                result.addAll(findSurfaceViews(view.getChildAt(i)))
            }
        }
        return result
    }

    /**
     * Notify VLC player of PiP mode change via reflection.
     * This bypasses React's prop batching for immediate resize.
     */
    private fun notifyVlcPlayerBridge(isInPip: Boolean, widthDp: Int, heightDp: Int, density: Float) {
        try {
            val bridgeClass = Class.forName("com.yuanzhou.vlc.vlcplayer.VlcPlayerBridge")
            val method = bridgeClass.getMethod(
                "notifyPipModeChanged",
                Boolean::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Float::class.javaPrimitiveType
            )
            method.invoke(null, isInPip, widthDp, heightDp, density)
            android.util.Log.d("PipBridge", "notifyVlcPlayerBridge: called successfully")
        } catch (e: ClassNotFoundException) {
            android.util.Log.d("PipBridge", "notifyVlcPlayerBridge: VlcPlayerBridge not available")
        } catch (e: Exception) {
            android.util.Log.e("PipBridge", "notifyVlcPlayerBridge: failed", e)
        }
    }
}

class MediaSessionModule : Module() {
    private var mediaSession: MediaSessionCompat? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var isSessionActive = false
    private var noisyReceiver: BroadcastReceiver? = null
    private var currentMetadata: MediaMetadataCompat.Builder = MediaMetadataCompat.Builder()
    private var currentPlaybackState: PlaybackStateCompat.Builder = PlaybackStateCompat.Builder()
    private var wasInPipMode = false
    private var lastIsPlaying: Boolean? = null
    private var currentIsPlaying: Boolean = false
    private var isAutoPipEnabled: Boolean = false
    private var pipAspectRatioWidth: Int = 16
    private var pipAspectRatioHeight: Int = 9

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

        AsyncFunction("setPictureInPictureAspectRatio") { width: Int, height: Int, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    setPipAspectRatio(width, height)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("PIP_ERROR", e.message ?: "Failed to set PiP aspect ratio", e)
                }
            }
        }

        // Kept for backwards compatibility but does nothing now
        AsyncFunction("setPictureInPictureSourceRect") { _: Map<String, Double>, promise: Promise ->
            promise.resolve(null)
        }

        // Kept for backwards compatibility but does nothing now
        AsyncFunction("setStatusBarOverlayEnabled") { _: Boolean, promise: Promise ->
            promise.resolve(null)
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

        // Update PiP actions when play state changes
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
            sendEvent("onRemoteCommand", mapOf("command" to "nextTrack"))
        }

        override fun onSkipToPrevious() {
            sendEvent("onRemoteCommand", mapOf("command" to "previousTrack"))
        }

        override fun onSeekTo(pos: Long) {
            sendEvent("onRemoteCommand", mapOf("command" to "seekTo", "position" to (pos / 1000.0)))
        }

        override fun onFastForward() {
            sendEvent("onRemoteCommand", mapOf("command" to "skipForward", "interval" to 10))
        }

        override fun onRewind() {
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

        try {
            val aspectRatio = getPipAspectRatio()

            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(false)
            }

            builder.setActions(buildPipActions(activity))

            return activity.enterPictureInPictureMode(builder.build())
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "enterPiP: failed", e)
            return false
        }
    }

    private fun setAutoPiP(enabled: Boolean) {
        android.util.Log.d("MediaSession", "setAutoPiP: enabled=$enabled")

        isAutoPipEnabled = enabled
        PipBridge.setPipEnabled(enabled)
    }

    /**
     * Update the activity's PiP params so the system knows we support PiP.
     * On Android 12+, this enables auto-enter PiP when user presses home.
     */
    internal fun updateActivityPipParams(enabled: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val activity = appContext.currentActivity ?: return

        try {
            val aspectRatio = PipBridge.getPipAspectRatio()

            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(false)
                // This is the key - auto-enter PiP when going to background
                builder.setAutoEnterEnabled(enabled)
            }

            builder.setActions(buildPipActions(activity))

            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("MediaSession", "updateActivityPipParams: enabled=$enabled, aspectRatio=$aspectRatio")
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "updateActivityPipParams: failed", e)
        }
    }

    private fun setPipAspectRatio(width: Int, height: Int) {
        if (width > 0 && height > 0) {
            pipAspectRatioWidth = width
            pipAspectRatioHeight = height
            PipBridge.setPipAspectRatio(width, height)
            android.util.Log.d("MediaSession", "setPipAspectRatio: $width x $height")
        }
    }

    private fun getPipAspectRatio(): Rational {
        val ratio = Rational(pipAspectRatioWidth, pipAspectRatioHeight)
        val min = 0.418f
        val max = 2.39f
        val clamped = ratio.toFloat().coerceIn(min, max)
        return Rational((clamped * 1000).toInt(), 1000)
    }

    private fun refreshPipParams(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!activity.isInPictureInPictureMode) return

        try {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(getPipAspectRatio())

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(false)
            }

            builder.setActions(buildPipActions(activity))
            activity.setPictureInPictureParams(builder.build())
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "refreshPipParams failed: ${e.message}")
        }
    }

    internal fun buildPipActions(activity: Activity): List<RemoteAction> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return emptyList()

        val context = activity.applicationContext
        val actions = mutableListOf<RemoteAction>()

        // Rewind action
        val rewindIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_PIP_REWIND
        }
        val rewindPendingIntent = PendingIntent.getForegroundService(
            context,
            REQUEST_REWIND,
            rewindIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        actions.add(RemoteAction(
            Icon.createWithResource(context, android.R.drawable.ic_media_rew),
            "Rewind",
            "Rewind 10 seconds",
            rewindPendingIntent
        ))

        // Play/Pause action
        val playPauseIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = if (currentIsPlaying) ACTION_PIP_PAUSE else ACTION_PIP_PLAY
        }
        val playPausePendingIntent = PendingIntent.getForegroundService(
            context,
            REQUEST_PLAY_PAUSE,
            playPauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val playPauseIcon = if (currentIsPlaying) {
            Icon.createWithResource(context, android.R.drawable.ic_media_pause)
        } else {
            Icon.createWithResource(context, android.R.drawable.ic_media_play)
        }
        val playPauseLabel = if (currentIsPlaying) "Pause" else "Play"
        actions.add(RemoteAction(playPauseIcon, playPauseLabel, playPauseLabel, playPausePendingIntent))

        // Forward action
        val forwardIntent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_PIP_FORWARD
        }
        val forwardPendingIntent = PendingIntent.getForegroundService(
            context,
            REQUEST_FORWARD,
            forwardIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        actions.add(RemoteAction(
            Icon.createWithResource(context, android.R.drawable.ic_media_ff),
            "Forward",
            "Forward 10 seconds",
            forwardPendingIntent
        ))

        return actions
    }

    internal fun sendPipEvent(activity: Activity, isInPip: Boolean, newConfig: Configuration? = null) {
        // Send dp values to JS - React Native styles use dp, not pixels
        val density = activity.resources.displayMetrics.density
        val (width, height) = if (newConfig != null && isInPip) {
            // Configuration gives us dp values directly
            android.util.Log.d("MediaSession", "sendPipEvent: using Configuration: ${newConfig.screenWidthDp}dp x ${newConfig.screenHeightDp}dp")
            Pair(newConfig.screenWidthDp, newConfig.screenHeightDp)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Window metrics are in pixels, convert to dp
            val bounds = activity.windowManager.currentWindowMetrics.bounds
            val wDp = (bounds.width() / density).toInt()
            val hDp = (bounds.height() / density).toInt()
            android.util.Log.d("MediaSession", "sendPipEvent: using WindowMetrics: ${bounds.width()}x${bounds.height()}px -> ${wDp}x${hDp}dp")
            Pair(wDp, hDp)
        } else {
            // DecorView dimensions are in pixels, convert to dp
            val decorView = activity.window?.decorView
            val wDp = ((decorView?.width ?: 0) / density).toInt()
            val hDp = ((decorView?.height ?: 0) / density).toInt()
            Pair(wDp, hDp)
        }

        android.util.Log.d("MediaSession", "sendPipEvent: isInPip=$isInPip, dimensions=${width}x${height}dp")

        wasInPipMode = isInPip

        sendEvent("onPictureInPictureChanged", mapOf(
            "isInPictureInPicture" to isInPip,
            "width" to width,
            "height" to height
        ))
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
