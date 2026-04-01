package to.holepunch.modules.mediasession

import android.app.Activity
import android.app.ActivityManager
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
import android.os.SystemClock
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
 */
object PipBridge {
    private var moduleInstance: MediaSessionModule? = null
    private var pipEnabled: Boolean = false
    private var suppressNextMainActivityUserLeaveHint: Boolean = false
    @Volatile private var mainActivityDelegatedPipHandoffUntilUptimeMs: Long = 0
    @Volatile private var lastIsInPip: Boolean = false
    @Volatile private var surfaceViewInsetPx: Float = 0f

    // PiP enter/exit can briefly drop focus and trigger lifecycle/audio-focus churn.
    // Track a short transition window so we can avoid treating that as a user dismissal.
    @Volatile private var pipTransitionUntilUptimeMs: Long = 0

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

    private fun markPipTransition() {
        pipTransitionUntilUptimeMs = SystemClock.uptimeMillis() + 2200
    }

    fun isInPipTransition(): Boolean {
        return SystemClock.uptimeMillis() <= pipTransitionUntilUptimeMs
    }

    fun setPipEnabled(enabled: Boolean) {
        pipEnabled = enabled
        android.util.Log.d("PipBridge", "setPipEnabled: $enabled")

        // On Android 12+, set PiP params with autoEnterEnabled so the system
        // handles PiP entry automatically when user presses home
        moduleInstance?.updateActivityPipParams(enabled)
    }

    fun suppressNextMainUserLeaveHint() {
        suppressNextMainActivityUserLeaveHint = true
    }

    fun markMainActivityDelegatedPipHandoff() {
        mainActivityDelegatedPipHandoffUntilUptimeMs = SystemClock.uptimeMillis() + 2200
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
     * Keep this self-contained and deterministic across repeated PiP cycles:
     * always build fresh PiP params, apply them to the activity, then enter PiP.
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

        if (activity.isInPictureInPictureMode) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: already in PiP, skipping")
            return
        }

        if (!isPipHostActivity(activity)) {
            android.util.Log.d("PipBridge", "onUserLeaveHint: skip non-pip-host activity ${activity.javaClass.name}")
            return
        }

        val isMainActivity = activity.javaClass.name == "${activity.packageName}.MainActivity"
        if (isMainActivity && suppressNextMainActivityUserLeaveHint) {
            suppressNextMainActivityUserLeaveHint = false
            android.util.Log.d("PipBridge", "onUserLeaveHint: suppressing one MainActivity PiP enter")
            return
        }

        markPipTransition()
        android.util.Log.d("PipBridge", "onUserLeaveHint: PiP transition marked")

        try {
            val aspectRatio = getPipAspectRatio()
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio)
            // Use the same stable fullscreen source rect here as in
            // updateActivityPipParams(). Avoid feeding transient mini-player bounds
            // into native PiP entry.
            builder.setSourceRectHint(getFullscreenSourceRect(activity))
            builder.setActions(moduleInstance?.buildPipActions(activity) ?: emptyList())

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(true)
            }

            val params = builder.build()
            activity.setPictureInPictureParams(params)
            activity.enterPictureInPictureMode(params)
            android.util.Log.d("PipBridge", "onUserLeaveHint: entered PiP mode directly")
        } catch (e: Exception) {
            android.util.Log.e("PipBridge", "onUserLeaveHint: PiP failed", e)
        }
    }

    fun getFullscreenSourceRect(activity: Activity): android.graphics.Rect {
        val display = activity.windowManager.defaultDisplay
        val size = android.graphics.Point()
        display.getRealSize(size)
        return android.graphics.Rect(0, 0, size.x, size.y)
    }

    /**
     * Update PiP params with accurate sourceRectHint right before auto-enter captures.
     * On Android 12+/16, sourceRectHint tells the system which area of the window
     * contains the video content for PiP cropping.
     */
    @JvmStatic
    fun updatePipSourceRectForCapture(activity: Activity) {
        try {
            val rootView = activity.window.decorView
            val videoViews = findVideoViews(rootView)
            var sourceRect: android.graphics.Rect? = null
            for (vv in videoViews) {
                if (vv.width <= 0 || vv.height <= 0) continue
                val loc = IntArray(2)
                vv.getLocationInWindow(loc)
                sourceRect = android.graphics.Rect(loc[0], loc[1], loc[0] + vv.width, loc[1] + vv.height)
                break
            }
            if (sourceRect == null) return

            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(getPipAspectRatio())
                .setSourceRectHint(sourceRect)
                .setSeamlessResizeEnabled(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setAutoEnterEnabled(true)
            }
            val actions = moduleInstance?.buildPipActions(activity) ?: emptyList()
            builder.setActions(actions)
            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("PipBridge", "updatePipSourceRectForCapture: sourceRect=$sourceRect")
        } catch (e: Exception) {
            android.util.Log.e("PipBridge", "updatePipSourceRectForCapture failed", e)
        }
    }

    fun getLaunchIntoPipSourceRect(activity: Activity): android.graphics.Rect {
        return getVideoSourceRect(activity) ?: getFullscreenSourceRect(activity)
    }

    fun normalizeSourceRectHint(rect: android.graphics.Rect): android.graphics.Rect {
        val ratio = getPipAspectRatio()
        val rw = ratio.numerator.toFloat()
        val rh = ratio.denominator.toFloat()
        val w = rect.width().toFloat()
        val h = rect.height().toFloat()
        if (w <= 0 || h <= 0) return rect
        val targetH = w * rh / rw
        if (targetH <= h) {
            val inset = ((h - targetH) / 2).toInt()
            return android.graphics.Rect(rect.left, rect.top + inset, rect.right, rect.bottom - inset)
        }
        val targetW = h * rw / rh
        val inset = ((w - targetW) / 2).toInt()
        return android.graphics.Rect(rect.left + inset, rect.top, rect.right - inset, rect.bottom)
    }

    fun getAspectMatchedFullscreenSourceRect(activity: Activity): android.graphics.Rect {
        return normalizeSourceRectHint(getFullscreenSourceRect(activity))
    }

    fun enterPictureInPictureDirect(
        activity: Activity,
        sourceRectHint: android.graphics.Rect? = null,
    ): Boolean {
        if (!pipEnabled) return false
        if (activity.isInPictureInPictureMode) return true
        if (!isPipHostActivity(activity)) return false
        return try {
            markPipTransition()
            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(getPipAspectRatio())
                .setSeamlessResizeEnabled(true)
            builder.setSourceRectHint(sourceRectHint ?: getAspectMatchedFullscreenSourceRect(activity))
            val actions = moduleInstance?.buildPipActions(activity) ?: emptyList()
            builder.setActions(actions)
            activity.enterPictureInPictureMode(builder.build())
        } catch (e: Exception) {
            android.util.Log.e("PipBridge", "enterPictureInPictureDirect failed", e)
            false
        }
    }

    fun notifyPipBoundsChanged(activity: Activity, newConfig: Configuration) {
        notifyPipModeChanged(activity, true, newConfig)
    }

    private fun isPipHostActivity(activity: Activity): Boolean {
        val className = activity.javaClass.name
        return className == "${activity.packageName}.MainActivity"
    }

    @JvmStatic
    fun notifyPipModeChanged(activity: Activity, isInPip: Boolean, newConfig: Configuration? = null) {
        android.util.Log.d("PipBridge", "notifyPipModeChanged: isInPip=$isInPip")

        val didStateChange = isInPip != lastIsInPip
        if (didStateChange) {
            markPipTransition()

            val isMainActivity = activity.javaClass.name.endsWith(".MainActivity")

            // Don't manipulate views on MainActivity during PiP.
            // Auto-enter captures the correct layout. Any view changes
            // (hiding, resizing, translating) trigger native relayout
            // which shifts the video in the PiP window.

            // Apply SurfaceView transforms (skipped for MainActivity)
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            handler.postDelayed({
                applySurfaceViewTransforms(activity, isInPip, newConfig)
            }, 50)

            lastIsInPip = isInPip

            if (!isInPip) {
                // Check window size for logging, but ALWAYS proceed with restore.
                // Skipping restore when the window is still PiP-sized left the app
                // in a half-PiP state where JS never got the exit event and couldn't
                // re-arm auto-PiP for subsequent cycles.
                val windowMetrics = activity.windowManager.currentWindowMetrics
                val windowBounds = windowMetrics.bounds
                val display = activity.windowManager.defaultDisplay
                val screenSize = android.graphics.Point()
                display.getRealSize(screenSize)
                val stillPipSized = windowBounds.width() < screenSize.x * 0.8f
                if (stillPipSized) {
                    android.util.Log.d("PipBridge", "notifyPipModeChanged: window still PiP-sized (${windowBounds.width()}x${windowBounds.height()} vs ${screenSize.x}x${screenSize.y}), proceeding with restore anyway")
                }
                run {
                    // Only run the dismissal-pause logic for real PiP exits
                    run {
                        val handler = android.os.Handler(android.os.Looper.getMainLooper())
                        fun isAppProcessVisible(): Boolean {
                            val info = ActivityManager.RunningAppProcessInfo()
                            ActivityManager.getMyMemoryState(info)
                            return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
                                info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
                        }

                        fun maybePauseAfterDismissal(attempt: Int) {
                            if (activity.isDestroyed || activity.isFinishing) return
                            if (isAppProcessVisible()) return
                            if (attempt >= 8) {
                                notifyPipDismissed()
                                return
                            }
                            handler.postDelayed({ maybePauseAfterDismissal(attempt + 1) }, 250)
                        }
                        handler.postDelayed({ maybePauseAfterDismissal(0) }, 350)
                    }
                }
            }
        }

        // Send PiP event to JS for state management.
        // The overlay renders a simplified video-only view during PiP.
        moduleInstance?.sendPipEvent(activity, isInPip, newConfig)
    }

    fun notifyPipDismissed() {
        android.util.Log.d("PipBridge", "notifyPipDismissed: stopping playback")
        moduleInstance?.handlePipStop()
    }

    fun onPipPlayAction() {
        moduleInstance?.handlePipPlay()
    }

    fun onPipPauseAction() {
        moduleInstance?.handlePipPause()
    }

    fun onPipBackgroundAudioAction() {
        moduleInstance?.handlePipBackgroundAudio()
    }

    fun setSurfaceViewInset(topInsetPx: Float) {
        surfaceViewInsetPx = topInsetPx
        val activity = moduleInstance?.appContext?.currentActivity ?: return
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            val surfaceViews = findSurfaceViews(activity.window.decorView)
            for (sv in surfaceViews) {
                if (!activity.isInPictureInPictureMode) {
                    sv.setZOrderMediaOverlay(false)
                    sv.translationY = surfaceViewInsetPx
                }
            }
        }
    }

    /**
     * Apply scale transforms directly to SurfaceViews at the Activity level.
     * This bypasses React Native's layout system entirely.
     */
    private fun applySurfaceViewTransforms(activity: Activity, isInPip: Boolean, newConfig: Configuration?) {
        // Skip SurfaceView transforms on MainActivity — the JS side handles PiP layout
        // via Reanimated. Native scale transforms on SurfaceView cause shifts because
        // the compositor surface doesn't respond to View transforms.
        val isMainActivity = activity.javaClass.name.endsWith(".MainActivity")
        if (isMainActivity) return

        val surfaceViews = findSurfaceViews(activity.window.decorView)
        android.util.Log.d("PipBridge", "applySurfaceViewTransforms: found ${surfaceViews.size} SurfaceViews, isInPip=$isInPip")

        for (sv in surfaceViews) {
            if (isInPip && newConfig != null) {
                sv.setZOrderMediaOverlay(false)
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

                // Calculate scale - use width scale so video fills PiP width
                val scaleX = pipWidth.toFloat() / viewWidth
                val scaleY = pipHeight.toFloat() / viewHeight
                val viewIsLandscape = viewWidth >= viewHeight
                val scale = if (viewMatchesPip) 1f else scaleX  // Always use width scale

                // Apply transform with pivot at top-left
                sv.pivotX = 0f
                sv.pivotY = 0f
                sv.scaleX = scale
                sv.scaleY = scale
                // Avoid applying translations during PiP drag to prevent jitter
                sv.translationX = 0f
                sv.translationY = 0f

                android.util.Log.d("PipBridge", "applySurfaceViewTransforms: view=${viewWidth}x${viewHeight} pip=${pipWidth}x${pipHeight} scale=$scale viewLandscape=$viewIsLandscape")
            } else {
                sv.setZOrderMediaOverlay(false)
                // Reset transforms
                sv.scaleX = 1f
                sv.scaleY = 1f
                sv.pivotX = sv.width / 2f
                sv.pivotY = sv.height / 2f
                sv.translationX = 0f
                sv.translationY = surfaceViewInsetPx
                android.util.Log.d("PipBridge", "applySurfaceViewTransforms: reset transform")
            }
        }
    }

    /**
     * Find all video rendering views (SurfaceView + TextureView) in the hierarchy.
     */
    private fun findVideoViews(view: android.view.View): List<android.view.View> {
        val result = mutableListOf<android.view.View>()
        if (view is android.view.SurfaceView || view is android.view.TextureView) {
            result.add(view)
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                result.addAll(findVideoViews(view.getChildAt(i)))
            }
        }
        return result
    }

    /** Legacy: find SurfaceViews only (for setZOrderMediaOverlay / translationY). */
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

    private fun getSafeInsetTopPx(activity: Activity): Int {
        val decorView = activity.window?.decorView ?: return 0
        val insets = androidx.core.view.ViewCompat.getRootWindowInsets(decorView)
        if (insets != null) {
            val cutoutTop = insets.displayCutout?.safeInsetTop ?: 0
            val statusTop = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
            return kotlin.math.max(cutoutTop, statusTop)
        }
        return 0
    }

    private fun getVideoSourceRect(activity: Activity): android.graphics.Rect? {
        val decorView = activity.window?.decorView ?: return null
        val videoViews = findVideoViews(decorView)
        if (videoViews.isEmpty()) return null

        var bestRect: android.graphics.Rect? = null
        var bestArea = 0
        for (v in videoViews) {
            val rect = android.graphics.Rect()
            if (v.getGlobalVisibleRect(rect) && rect.width() > 0 && rect.height() > 0) {
                val area = rect.width() * rect.height()
                if (area > bestArea) {
                    bestArea = area
                    bestRect = rect
                }
            }
        }
        return bestRect
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
    private var previousSystemUiFlags: Int? = null
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

        AsyncFunction("startCastForegroundService") { title: String, subtitle: String, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    startCastForegroundService(title, subtitle)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to start cast foreground service", e)
                }
            }
        }

        AsyncFunction("updateCastForegroundService") { title: String, subtitle: String, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    updateCastForegroundService(title, subtitle)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to update cast foreground service", e)
                }
            }
        }

        AsyncFunction("stopCastForegroundService") { promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    stopCastForegroundService()
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("MEDIA_SESSION_ERROR", e.message ?: "Failed to stop cast foreground service", e)
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
                    promise.reject("PIP_ERROR", e.message ?: "Failed to set Auto PiP", e)
                }
            }
        }

        AsyncFunction("enterBackgroundAudioMode") { promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                try {
                    val activity = appContext.currentActivity
                    if (activity != null) {
                        setAutoPiP(false)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                            activity.moveTaskToBack(true)
                        }
                    }
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("PIP_ERROR", e.message ?: "Failed to enter background audio mode", e)
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
            // Re-set PiP params with fresh sourceRectHint from actual video view position.
            // This keeps Android 12+ auto-PiP transition animation accurate as video layout changes.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                updateActivityPipParams(isAutoPipEnabled)
            }
            promise.resolve(null)
        }

        // Kept for backwards compatibility but does nothing now
        AsyncFunction("setStatusBarOverlayEnabled") { enabled: Boolean, promise: Promise ->
            CoroutineScope(Dispatchers.Main).launch {
                val activity = appContext.currentActivity
                if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                    promise.resolve(null)
                    return@launch
                }

                val window = activity.window ?: run {
                    promise.resolve(null)
                    return@launch
                }

                val params = window.attributes
                params.layoutInDisplayCutoutMode = if (enabled) {
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER
                } else {
                    android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
                }
                window.attributes = params

                val decorView = window.decorView
                if (enabled) {
                    if (previousSystemUiFlags == null) {
                        previousSystemUiFlags = decorView.systemUiVisibility
                    }
                    val clearedFlags = decorView.systemUiVisibility and
                        android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN.inv() and
                        android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE.inv() and
                        android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION.inv()
                    decorView.systemUiVisibility = clearedFlags
                } else {
                    previousSystemUiFlags?.let {
                        decorView.systemUiVisibility = it
                    }
                    previousSystemUiFlags = null
                }

                androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, enabled)
                promise.resolve(null)
            }
        }

        AsyncFunction("setSurfaceViewInset") { topInsetDp: Double, promise: Promise ->
            val activity = appContext.currentActivity
            val context = appContext.reactContext
            if (context == null) {
                promise.resolve(null)
                return@AsyncFunction
            }
            val density = context.resources.displayMetrics.density
            val insetPx = if (topInsetDp < 0 && activity != null) {
                getSafeInsetTopPx(activity).toFloat()
            } else {
                (topInsetDp * density).toFloat()
            }
            PipBridge.setSurfaceViewInset(insetPx)
            promise.resolve(null)
        }

        OnCreate {
            PipBridge.register(this@MediaSessionModule)
            PipServiceBridge.register(this@MediaSessionModule)
            MediaSessionRegistry.setCallback(mediaSessionCallback)
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
            mediaSession = MediaSessionRegistry.ensureSession(context)
            mediaSession?.setCallback(mediaSessionCallback)
            setSessionActivityIfAvailable(context)
            mediaSession?.isActive = true
            registerNoisyReceiver()
            startForegroundService()
            startMediaBrowserService()
            isSessionActive = true
        } else {
            mediaSession?.isActive = false
            abandonAudioFocus()
            unregisterNoisyReceiver()
            stopForegroundService()
            stopMediaBrowserService()
            isSessionActive = false
        }
    }



    private fun getSafeInsetTopPx(activity: Activity): Int {
        val decorView = activity.window?.decorView ?: return 0
        val insets = androidx.core.view.ViewCompat.getRootWindowInsets(decorView)
        if (insets != null) {
            val cutoutTop = insets.displayCutout?.safeInsetTop ?: 0
            val statusTop = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
            return kotlin.math.max(cutoutTop, statusTop)
        }
        return 0
    }

    private suspend fun updateNowPlaying(metadata: Map<String, Any?>) {
        (metadata["title"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_TITLE, it)
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, it)
        }
        (metadata["artist"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, it)
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, it)
        }
        (metadata["album"] as? String)?.let {
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, it)
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_DESCRIPTION, it)
        }
        (metadata["duration"] as? Number)?.let {
            currentMetadata.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (it.toDouble() * 1000).toLong())
        }

        (metadata["artworkUrl"] as? String)?.let { url ->
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ART_URI, url)
            currentMetadata.putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, url)
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
        MediaSessionRegistry.setMetadata(currentMetadata.build())
        updateNotification()
    }

    private fun setSessionActivityIfAvailable(context: Context) {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launchIntent != null) {
            val pendingIntent = PendingIntent.getActivity(
                context,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            mediaSession?.setSessionActivity(pendingIntent)
        }
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
            // Audio focus is managed by react-native-video's ExoPlayer directly.
            // Our MediaSession should NOT compete for audio focus — doing so prevents
            // ExoPlayer from starting playback (it stays in ready-but-not-playing state).
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
        MediaSessionRegistry.setMetadata(null)
        stopForegroundService()
    }

    private val mediaSessionCallback = object : MediaSessionCompat.Callback() {
        override fun onPlay() {
            android.util.Log.d("MediaSession", "onPlay callback")
            // JS/react-native-video owns desired playback state. Do not optimistically
            // flip MediaSession/PiP actions here before the player state is actually
            // reconciled back through setPlaybackState().
            sendEvent("onRemoteCommand", mapOf("command" to "play"))
        }

        override fun onPause() {
            android.util.Log.d("MediaSession", "onPause callback")

            // Some Android 14+ devices briefly deliver MediaSession pause during PiP exit
            // (focus/window transition). Pausing the native player here introduces an
            // audible gap. During the PiP transition window, keep audio running.
            val activity = appContext.currentActivity
            val suppress = PipBridge.isInPipTransition() && (activity == null || !activity.isInPictureInPictureMode)
            if (suppress) {
                android.util.Log.d("MediaSession", "onPause suppressed during PiP transition")
                // Still notify JS for state reconciliation; JS layer may ignore spurious pause.
                sendEvent("onRemoteCommand", mapOf("command" to "pause"))
                return
            }

            sendEvent("onRemoteCommand", mapOf("command" to "pause"))
        }

        override fun onStop() {
            android.util.Log.d("MediaSession", "onStop callback")

            val activity = appContext.currentActivity
            val suppress = PipBridge.isInPipTransition() && (activity == null || !activity.isInPictureInPictureMode)
            if (suppress) {
                android.util.Log.d("MediaSession", "onStop suppressed during PiP transition")
                sendEvent("onRemoteCommand", mapOf("command" to "stop"))
                return
            }

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
        // During PiP enter/exit, some devices briefly report transient focus loss.
        // Treat that as non-fatal to keep audio seamless.
        if (PipBridge.isInPipTransition()) {
            when (focusChange) {
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                    android.util.Log.d("MediaSession", "handleAudioFocusChange: ignoring transient focus loss during PiP transition")
                    return
                }
                AudioManager.AUDIOFOCUS_LOSS -> {
                    // Some builds can emit a short-lived LOSS during PiP exit.
                    // Avoid pausing the native player unless the loss persists.
                    android.util.Log.d("MediaSession", "handleAudioFocusChange: ignoring focus LOSS during PiP transition")
                    return
                }
            }
        }

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

    private fun startCastForegroundService(title: String, subtitle: String) {
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_CAST_START
            putExtra(EXTRA_CAST_TITLE, title)
            putExtra(EXTRA_CAST_SUBTITLE, subtitle)
            putExtra("mediaSessionToken", mediaSession?.sessionToken)
        }
        context.startService(intent)
    }

    private fun updateCastForegroundService(title: String, subtitle: String) {
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_CAST_UPDATE
            putExtra(EXTRA_CAST_TITLE, title)
            putExtra(EXTRA_CAST_SUBTITLE, subtitle)
            putExtra("mediaSessionToken", mediaSession?.sessionToken)
        }
        context.startService(intent)
    }

    private fun stopCastForegroundService() {
        val context = appContext.reactContext ?: return
        val intent = Intent(context, MediaPlaybackService::class.java).apply {
            action = ACTION_CAST_STOP
        }
        context.startService(intent)
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

            val sourceRect = getVideoSourceRect(activity)
            if (sourceRect != null) {
                builder.setSourceRectHint(sourceRect)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+ supports seamless PiP resizing. For video playback we want
                // the system to resize the activity/window smoothly to avoid disruptive
                // surface churn during PiP enter/exit.
                builder.setSeamlessResizeEnabled(true)
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
        val className = activity.javaClass.name
        val isPipHostActivity = className == "${activity.packageName}.MainActivity"

        // CRITICAL: never set autoEnterEnabled=false while PiP is enabled at the
        // bridge level. On Android 12+ with seamless PiP, isInPictureInPictureMode
        // can lag behind the actual PiP state, so checking it is not reliable.
        // Only allow autoEnterEnabled=false when pipEnabled is explicitly false
        // (meaning the video was actually closed / PiP should be fully disabled).
        val effectiveEnabled = if (PipBridge.isPipEnabled()) true else enabled

        try {
            val aspectRatio = PipBridge.getPipAspectRatio()

            val builder = PictureInPictureParams.Builder()
                .setAspectRatio(aspectRatio)

            // SIMPLIFIED FOR RELIABILITY: on MainActivity, use a stable fullscreen
            // source rect instead of the transformed mini-player rect. The mini-player
            // overlay can move/scale independently, and feeding those transient bounds
            // into Android PiP has caused silent PiP entry failures.
            val sourceRect = PipBridge.getFullscreenSourceRect(activity)
            builder.setSourceRectHint(sourceRect)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Favor reliability over fancy transition behavior. Mini-player PiP
                // entry has been unstable with transformed layouts, so keep params
                // simple and only arm auto-enter.
                builder.setAutoEnterEnabled(effectiveEnabled && isPipHostActivity)
            }

            builder.setActions(buildPipActions(activity))

            activity.setPictureInPictureParams(builder.build())
            android.util.Log.d("MediaSession", "updateActivityPipParams: enabled=$effectiveEnabled (requested=$enabled, inPip=${activity.isInPictureInPictureMode}), aspectRatio=$aspectRatio sourceRect=$sourceRect")
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

    private fun getVideoSourceRect(activity: Activity): android.graphics.Rect? {
        val decorView = activity.window?.decorView ?: return null
        val videoViews = findVideoViews(decorView)
        if (videoViews.isEmpty()) return null

        var bestRect: android.graphics.Rect? = null
        var bestArea = 0
        for (v in videoViews) {
            if (v.width <= 0 || v.height <= 0) continue
            val loc = IntArray(2)
            v.getLocationOnScreen(loc)
            // Calculate actual video content bounds within the SurfaceView.
            // Media3 PlayerView letterboxes (RESIZE_MODE_FIT): video is centered
            // within the surface with aspect-ratio-preserving fit.
            val surfW = v.width.toFloat()
            val surfH = v.height.toFloat()
            val pipRatio = PipBridge.getPipAspectRatio()
            val vidAspect = pipRatio.numerator.toFloat() / pipRatio.denominator.toFloat()
            val fitW: Float
            val fitH: Float
            if (surfW / surfH > vidAspect) {
                // Surface is wider than video — pillarboxed
                fitH = surfH
                fitW = surfH * vidAspect
            } else {
                // Surface is taller than video — letterboxed
                fitW = surfW
                fitH = surfW / vidAspect
            }
            val offsetX = ((surfW - fitW) / 2).toInt()
            val offsetY = ((surfH - fitH) / 2).toInt()
            val rect = android.graphics.Rect(
                loc[0] + offsetX,
                loc[1] + offsetY,
                loc[0] + offsetX + fitW.toInt(),
                loc[1] + offsetY + fitH.toInt()
            )
            android.util.Log.d("MediaSession", "getVideoSourceRect: ${v.javaClass.simpleName} surface=${v.width}x${v.height} at (${loc[0]},${loc[1]}) videoContent=$rect aspect=$vidAspect")
            val area = rect.width() * rect.height()
            if (area > bestArea) {
                bestArea = area
                bestRect = rect
            }
        }
        return bestRect
    }

    private fun findVideoViews(view: android.view.View): List<android.view.View> {
        val result = mutableListOf<android.view.View>()
        if (view is android.view.SurfaceView || view is android.view.TextureView) {
            result.add(view)
        }
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                result.addAll(findVideoViews(view.getChildAt(i)))
            }
        }
        return result
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

            val sourceRect = getVideoSourceRect(activity)
            if (sourceRect != null) {
                builder.setSourceRectHint(sourceRect)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // See enterPiP(): prefer seamless resize for video playback.
                builder.setSeamlessResizeEnabled(true)
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

        // Match Grayjay's proven setup: background-audio first, play/pause second,
        // dispatched through a BroadcastReceiver instead of a foreground service.
        val backgroundAudioIntent = Intent(context, MediaControlReceiver::class.java).apply {
            action = ACTION_PIP_BACKGROUND_AUDIO
            putExtra(MediaControlReceiver.EXTRA_MEDIA_ACTION, MediaControlReceiver.EVENT_BACKGROUND)
        }
        val backgroundAudioPendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_BACKGROUND_AUDIO,
            backgroundAudioIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        actions.add(RemoteAction(
            Icon.createWithResource(context, R.drawable.ic_pip_background),
            "Background",
            "Keep playing in background audio",
            backgroundAudioPendingIntent
        ))

        val playPauseIntent = Intent(context, MediaControlReceiver::class.java).apply {
            action = if (currentIsPlaying) ACTION_PIP_PAUSE else ACTION_PIP_PLAY
            putExtra(
                MediaControlReceiver.EXTRA_MEDIA_ACTION,
                if (currentIsPlaying) MediaControlReceiver.EVENT_PAUSE else MediaControlReceiver.EVENT_PLAY,
            )
        }
        val playPausePendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_PLAY_PAUSE,
            playPauseIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val playPauseIcon = Icon.createWithResource(
            context,
            if (currentIsPlaying) R.drawable.ic_pip_pause else R.drawable.ic_pip_play
        )
        val playPauseLabel = if (currentIsPlaying) "Pause" else "Play"
        actions.add(RemoteAction(playPauseIcon, playPauseLabel, playPauseLabel, playPausePendingIntent))

        android.util.Log.d("MediaSession", "buildPipActions: count=${actions.size} labels=${actions.map { it.title }} currentIsPlaying=$currentIsPlaying")
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
            "height" to height,
            // Helps JS restore correct play state on PiP exit.
            "isPlaying" to currentIsPlaying
        ))
    }

    internal fun handlePipPlay() {
        android.util.Log.d("MediaSession", "handlePipPlay")
        sendEvent("onRemoteCommand", mapOf("command" to "play"))
    }

    internal fun handlePipPause() {
        android.util.Log.d("MediaSession", "handlePipPause")
        sendEvent("onRemoteCommand", mapOf("command" to "pause"))
    }

    internal fun handlePipStop() {
        android.util.Log.d("MediaSession", "handlePipStop")
        sendEvent("onRemoteCommand", mapOf("command" to "stop", "reason" to "pip-dismissed"))
    }

    internal fun handlePipBackgroundAudio() {
        android.util.Log.d("MediaSession", "handlePipBackgroundAudio")
        sendEvent("onRemoteCommand", mapOf("command" to "backgroundAudio"))
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
            stopMediaBrowserService()
            mediaSession?.isActive = false
            mediaSession?.release()
            mediaSession = null
            isSessionActive = false
        }
    }

    private fun startMediaBrowserService() {
        val context = appContext.reactContext ?: return
        try {
            context.startService(Intent(context, PearTubeMediaBrowserService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("MediaSession", "Failed to start media browser service: ${e.message}")
        }
    }

    private fun stopMediaBrowserService() {
        val context = appContext.reactContext ?: return
        try {
            context.stopService(Intent(context, PearTubeMediaBrowserService::class.java))
        } catch (e: Exception) {
            android.util.Log.w("MediaSession", "Failed to stop media browser service: ${e.message}")
        }
    }

    companion object {
        const val ACTION_PIP_PLAY = "to.holepunch.mediasession.PIP_PLAY"
        const val ACTION_PIP_PAUSE = "to.holepunch.mediasession.PIP_PAUSE"
        const val ACTION_PIP_REWIND = "to.holepunch.mediasession.PIP_REWIND"
        const val ACTION_PIP_FORWARD = "to.holepunch.mediasession.PIP_FORWARD"
        const val ACTION_PIP_BACKGROUND_AUDIO = "to.holepunch.mediasession.PIP_BACKGROUND_AUDIO"
        const val ACTION_CAST_START = "to.holepunch.mediasession.CAST_START"
        const val ACTION_CAST_UPDATE = "to.holepunch.mediasession.CAST_UPDATE"
        const val ACTION_CAST_STOP = "to.holepunch.mediasession.CAST_STOP"
        const val EXTRA_CAST_TITLE = "castTitle"
        const val EXTRA_CAST_SUBTITLE = "castSubtitle"

        private const val REQUEST_PLAY_PAUSE = 1
        private const val REQUEST_REWIND = 2
        private const val REQUEST_FORWARD = 3
        private const val REQUEST_BACKGROUND_AUDIO = 4
    }
}
