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
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
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
 * Interface for external PiP handlers (like VLC) to register themselves.
 * This allows PipHostActivity to be launched without direct module dependencies.
 */
interface PipEntryHandler {
    fun canEnterPip(): Boolean
    fun enterPip(context: Context)
}

/**
 * Singleton bridge for PiP callbacks from MainActivity.
 * MainActivity calls these static methods; the module instance receives the events.
 */
object PipBridge {
    private var moduleInstance: MediaSessionModule? = null
    private var pipEnabled: Boolean = false
    private var statusBarOverlay: android.view.View? = null
    private var overlayEnabled: Boolean = false  // Whether overlay should be visible (controlled by JS)

    // External PiP handler (e.g., VLC's PipHostActivity launcher)
    @Volatile
    private var pipEntryHandler: PipEntryHandler? = null

    /**
     * Register an external PiP handler (called by VLC or other video players).
     * When registered, this handler will be used instead of activity-level PiP.
     */
    @JvmStatic
    fun registerPipEntryHandler(handler: PipEntryHandler?) {
        pipEntryHandler = handler
        android.util.Log.d("PipBridge", "PiP entry handler registered: ${handler != null}")
    }

    /**
     * Check if an external handler can enter PiP.
     */
    fun canExternalHandlerEnterPip(): Boolean {
        return pipEntryHandler?.canEnterPip() == true
    }

    /**
     * Enter PiP using the external handler if available.
     * Returns true if handler was used, false otherwise.
     */
    fun enterPipViaExternalHandler(context: Context): Boolean {
        val handler = pipEntryHandler
        if (handler != null && handler.canEnterPip()) {
            android.util.Log.d("PipBridge", "Entering PiP via external handler")
            handler.enterPip(context)
            return true
        }
        return false
    }

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
    }

    fun isPipEnabled(): Boolean = pipEnabled

    fun isOverlayEnabled(): Boolean = overlayEnabled

    /**
     * Register the native status bar overlay view from MainActivity
     */
    fun setStatusBarOverlay(overlay: android.view.View?) {
        statusBarOverlay = overlay
        android.util.Log.d("PipBridge", "setStatusBarOverlay: overlay=${overlay != null}, overlayEnabled=$overlayEnabled")
        // Apply current state
        updateOverlayVisibility()
    }

    /**
     * Called from JS to enable/disable the overlay (e.g., only show in fullscreen video mode)
     */
    fun setOverlayEnabled(enabled: Boolean) {
        android.util.Log.d("PipBridge", "setOverlayEnabled: enabled=$enabled, overlay=${statusBarOverlay != null}")
        overlayEnabled = enabled
        updateOverlayVisibility()
    }

    /**
     * Force hide the overlay (used before PiP snapshot)
     * Must be synchronous to ensure overlay is hidden before PiP takes its snapshot
     */
    fun hideOverlay() {
        android.util.Log.d("PipBridge", "hideOverlay called")
        // Set visibility directly - onUserLeaveHint is called on main thread
        // so we can safely modify the view without posting
        statusBarOverlay?.visibility = android.view.View.GONE
    }

    /**
     * Show the overlay if it should be visible (overlayEnabled && not in PiP)
     */
    fun showOverlay() {
        android.util.Log.d("PipBridge", "showOverlay called, overlayEnabled=$overlayEnabled")
        if (overlayEnabled) {
            statusBarOverlay?.let { overlay ->
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    overlay.visibility = android.view.View.VISIBLE
                }
            }
        }
    }

    private fun updateOverlayVisibility() {
        val overlay = statusBarOverlay
        if (overlay == null) {
            android.util.Log.w("PipBridge", "updateOverlayVisibility: overlay is null!")
            return
        }
        val newVisibility = if (overlayEnabled) android.view.View.VISIBLE else android.view.View.GONE
        android.util.Log.d("PipBridge", "updateOverlayVisibility: overlayEnabled=$overlayEnabled, setting visibility to ${if (newVisibility == android.view.View.VISIBLE) "VISIBLE" else "GONE"}")
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            overlay.visibility = newVisibility
            android.util.Log.d("PipBridge", "updateOverlayVisibility: visibility set, overlay.visibility=${overlay.visibility}")
        }
    }

    /**
     * Called from MainActivity.onUserLeaveHint() when user is about to leave the app.
     * We use this to enter PiP mode manually for all Android versions to have
     * control over the layout before the PiP snapshot is taken.
     */
    fun onUserLeaveHint(activity: Activity) {
        if (!pipEnabled) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: PiP not enabled, skipping")
            return
        }

        android.util.Log.d("PipBridge", "onUserLeaveHint: hiding overlay and entering PiP")

        // Hide the status bar overlay BEFORE entering PiP (synchronous)
        // This ensures the PiP snapshot doesn't include the black bar
        hideOverlay()

        moduleInstance?.enterPiPFromCallback(activity)
    }

    /**
     * Called from MainActivity.onPictureInPictureModeChanged().
     */
    fun onPictureInPictureModeChanged(activity: Activity, isInPictureInPictureMode: Boolean, newConfig: Configuration?) {
        android.util.Log.d("PipBridge", "onPictureInPictureModeChanged: $isInPictureInPictureMode")

        // Restore overlay visibility when exiting PiP
        if (!isInPictureInPictureMode) {
            showOverlay()
        }

        moduleInstance?.onPipModeChangedFromCallback(activity, isInPictureInPictureMode)
    }
}

class MediaSessionModule : Module(), PictureInPictureListener {
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
    private var isAutoPipEnabled: Boolean = false
    private var pipFragment: PictureInPictureFragment? = null
    private var pendingLayoutHandler: Handler? = null
    private var pendingLayoutRunnable: Runnable? = null
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

        AsyncFunction("setStatusBarOverlayEnabled") { enabled: Boolean, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    PipBridge.setOverlayEnabled(enabled)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("OVERLAY_ERROR", e.message ?: "Failed to set overlay enabled", e)
                }
            }
        }

        OnCreate {
            PipBridge.register(this@MediaSessionModule)
            PipServiceBridge.register(this@MediaSessionModule)
            attachPipFragment()
            // Native overlay disabled - PipHostActivity handles PiP in a separate window
            // so the React Native layout with inset offsets doesn't affect the PiP snapshot
        }

        OnDestroy {
            PipBridge.unregister(this@MediaSessionModule)
            PipServiceBridge.unregister(this@MediaSessionModule)
            detachPipFragment()
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

        val context = appContext.reactContext ?: return false

        // Use external handler (VLC's PipHostActivity) for clean PiP
        // without React Native layout artifacts causing 50/50 video issue.
        // We intentionally DO NOT fall back to activity-level PiP since
        // it captures the entire activity window including RN layout offsets.
        if (PipBridge.enterPipViaExternalHandler(context)) {
            return true
        }

        android.util.Log.w("MediaSession", "enterPiP: No external handler available, PiP not entered")
        return false
    }

    private fun setAutoPiP(enabled: Boolean) {
        android.util.Log.d("MediaSession", "setAutoPiP called: enabled=$enabled, SDK=${Build.VERSION.SDK_INT}, aspect ratio: ${getPipAspectRatio()}")

        isAutoPipEnabled = enabled
        PipBridge.setPipEnabled(enabled)

        val activity = appContext.currentActivity
        if (activity == null) {
            android.util.Log.e("MediaSession", "No current activity for PiP")
            return
        }

        // Don't use setAutoEnterEnabled - we handle PiP entry manually via onUserLeaveHint
        // This gives us control over layout timing before the PiP snapshot
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(getPipAspectRatio())

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(false)
                builder.setSeamlessResizeEnabled(false)
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
            android.util.Log.d("MediaSession", "setAutoPiP: using manual PiP entry via onUserLeaveHint")
        }
    }
    
    private fun setPipSourceRect(rect: Map<String, Double>) {
        val context = appContext.reactContext ?: return
        val density = context.resources.displayMetrics.density
        
        val x = ((rect["x"] ?: 0.0) * density).toInt()
        val y = ((rect["y"] ?: 0.0) * density).toInt()
        val width = ((rect["width"] ?: 0.0) * density).toInt()
        val height = ((rect["height"] ?: 0.0) * density).toInt()
        
        val newRect = android.graphics.Rect(x, y, x + width, y + height)
        
        val rectChanged = pipSourceRect?.let { oldRect ->
            val tolerance = 5
            !(Math.abs(oldRect.left - newRect.left) < tolerance &&
                Math.abs(oldRect.top - newRect.top) < tolerance &&
                Math.abs(oldRect.width() - newRect.width()) < tolerance &&
                Math.abs(oldRect.height() - newRect.height()) < tolerance)
        } ?: true
        
        pipSourceRect = newRect
        if (rectChanged) {
            android.util.Log.d("MediaSession", "setPipSourceRect: dp(${rect["x"]}, ${rect["y"]}, ${rect["width"]}, ${rect["height"]}) -> px($x, $y, $width, $height) density=$density")
        }
        
        if (isAutoPipEnabled && !wasInPipMode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            reapplyPipParams()
        }
    }
    
    private fun reapplyPipParams() {
        val activity = appContext.currentActivity ?: return
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(getPipAspectRatio())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // IMPORTANT: Never use setAutoEnterEnabled(true) - it bypasses onUserLeaveHint
            // and enters activity-level PiP directly, causing the 50/50 video issue.
            // We handle PiP entry manually via onUserLeaveHint -> PipHostActivity.
            builder.setAutoEnterEnabled(false)
            builder.setSeamlessResizeEnabled(false)
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
        android.util.Log.d("MediaSession", "reapplyPipParams: updated with sourceRect=$pipSourceRect")
    }
    
    private fun setPipAspectRatio(width: Int, height: Int) {
        if (width > 0 && height > 0) {
            pipAspectRatioWidth = width
            pipAspectRatioHeight = height
            android.util.Log.d("MediaSession", "setPipAspectRatio: $width x $height")
            if (isAutoPipEnabled && !wasInPipMode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                reapplyPipParams()
            }
        }
    }
    
    private fun getPipAspectRatio(): Rational {
        return Rational(pipAspectRatioWidth, pipAspectRatioHeight)
    }

    /**
     * Set the display cutout mode for the current activity window.
     * When enabled (fullscreen video), use NEVER to avoid rendering behind cutout.
     * When disabled (or entering PiP), use SHORT_EDGES for edge-to-edge rendering.
     */
    private fun setDisplayCutoutMode(avoidCutout: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return

        val activity = appContext.currentActivity ?: return
        val window = activity.window ?: return

        val mode = if (avoidCutout) {
            android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
        } else {
            android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        android.util.Log.d("MediaSession", "setDisplayCutoutMode: avoidCutout=$avoidCutout, mode=${if (avoidCutout) "NEVER" else "SHORT_EDGES"}")

        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = mode
        }

        // Force the window to re-layout with new cutout mode
        window.decorView.requestApplyInsets()
        window.decorView.requestLayout()
    }

    internal fun enterPiPFromCallback(activity: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        // Use external handler (VLC's PipHostActivity) for clean PiP.
        // We intentionally DO NOT fall back to activity-level PiP since
        // it captures the entire activity window including RN layout offsets,
        // causing the 50/50 video issue (half video, half black).
        if (PipBridge.enterPipViaExternalHandler(activity)) {
            return
        }

        android.util.Log.w("MediaSession", "enterPiPFromCallback: No external handler available, PiP not entered")
    }
    
    private fun setupStatusBarOverlay() {
        val activity = appContext.currentActivity ?: return
        val window = activity.window ?: return
        val decorView = window.decorView as? android.view.ViewGroup ?: return

        // Get status bar height
        var statusBarHeight = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val insets = decorView.rootWindowInsets?.getInsets(android.view.WindowInsets.Type.statusBars())
            statusBarHeight = insets?.top ?: 0
        }
        if (statusBarHeight <= 0) {
            val resourceId = activity.resources.getIdentifier("status_bar_height", "dimen", "android")
            if (resourceId > 0) {
                statusBarHeight = activity.resources.getDimensionPixelSize(resourceId)
            }
        }
        if (statusBarHeight <= 0) {
            statusBarHeight = (24 * activity.resources.displayMetrics.density).toInt()
        }

        android.util.Log.d("MediaSession", "setupStatusBarOverlay: height=$statusBarHeight")

        // Create overlay view
        val overlay = android.view.View(activity).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            visibility = android.view.View.GONE  // Start hidden, JS controls visibility
            tag = "StatusBarOverlay"
        }

        // Add to DecorView
        val params = android.widget.FrameLayout.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            statusBarHeight
        ).apply {
            gravity = android.view.Gravity.TOP
        }

        Handler(Looper.getMainLooper()).post {
            try {
                decorView.addView(overlay, params)
                PipBridge.setStatusBarOverlay(overlay)
                android.util.Log.d("MediaSession", "Status bar overlay added successfully")
            } catch (e: Exception) {
                android.util.Log.e("MediaSession", "Failed to add status bar overlay: ${e.message}")
            }
        }
    }

    private fun attachPipFragment() {
        (appContext.currentActivity as? FragmentActivity)?.let { activity ->
            if (pipFragment != null) return@let
            pipFragment = PictureInPictureFragment().also { fragment ->
                fragment.setListener(this)
                activity.supportFragmentManager
                    .beginTransaction()
                    .add(fragment, PictureInPictureFragment.TAG)
                    .commitAllowingStateLoss()
            }
            android.util.Log.d("MediaSession", "PiP Fragment attached")
        }
    }
    
    private fun detachPipFragment() {
        (appContext.currentActivity as? FragmentActivity)?.let { activity ->
            pipFragment?.let { fragment ->
                activity.supportFragmentManager
                    .beginTransaction()
                    .remove(fragment)
                    .commitAllowingStateLoss()
            }
            pipFragment = null
            android.util.Log.d("MediaSession", "PiP Fragment detached")
        }
    }
    
    override fun onPictureInPictureModeChange(activity: Activity?, isInPip: Boolean) {
        if (activity == null) return
        handlePipModeChange(activity, isInPip)
    }
    
    internal fun onPipModeChangedFromCallback(activity: Activity, isInPip: Boolean) {
        handlePipModeChange(activity, isInPip)
    }
    
    private fun handlePipModeChange(activity: Activity, isInPip: Boolean) {
        if (isInPip == wasInPipMode) return

        wasInPipMode = isInPip
        android.util.Log.d("MediaSession", "PiP mode changed: $isInPip")

        pendingLayoutRunnable?.let { pendingLayoutHandler?.removeCallbacks(it) }

        // VLC handles PiP layout internally via native callbacks
        // We only need to refresh PiP params for the play/pause button state
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (isInPip) {
                refreshPipParams(activity)
            } else {
                // Exiting PiP - request layout refresh to restore full-screen layout
                pendingLayoutHandler = Handler(Looper.getMainLooper())
                pendingLayoutRunnable = Runnable {
                    requestLayoutRefresh(activity)
                }
                pendingLayoutHandler?.postDelayed(pendingLayoutRunnable!!, 100)
            }
        }

        sendPipEvent(activity, isInPip)
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

    private fun requestLayoutRefresh(activity: Activity) {
        try {
            val decorView = activity.window?.decorView ?: return
            decorView.post {
                decorView.requestLayout()
                decorView.invalidate()
            }
            android.util.Log.d("MediaSession", "Layout refresh requested")
        } catch (e: Exception) {
            android.util.Log.e("MediaSession", "Failed to request layout refresh: ${e.message}")
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
                .setAspectRatio(getPipAspectRatio())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(false)
                // IMPORTANT: Never use setAutoEnterEnabled(true) - it bypasses onUserLeaveHint
                // and enters activity-level PiP directly, causing the 50/50 video issue.
                // We handle PiP entry manually via onUserLeaveHint -> PipHostActivity.
                builder.setAutoEnterEnabled(false)
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
            android.util.Log.d("MediaSession", "Refreshed PiP params with sourceRect=$pipSourceRect, autoEnter=$isAutoPipEnabled")
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
