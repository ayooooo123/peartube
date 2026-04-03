package to.holepunch.modules.mediasession

import android.app.Activity
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import kotlin.math.roundToLong

interface NativePlaybackController {
    fun play(): Boolean
    fun pause(): Boolean
    fun stop(reason: String? = null): Boolean
    fun seekTo(positionMs: Long): Boolean
    fun seekBy(deltaMs: Long): Boolean
    fun enterBackgroundAudio(): Boolean
}

class PlayerActivityPayload private constructor(
    private val rawExtras: LinkedHashMap<String, Any?>,
) {
    companion object {
        const val KEY_SESSION_ID = "sessionId"
        const val KEY_VIDEO_ID = "videoId"
        const val KEY_SOURCE_URL = "sourceUrl"
        const val KEY_START_POSITION_MS = "startPositionMs"
        const val KEY_SHOULD_AUTOPLAY = "shouldAutoplay"
        const val KEY_TITLE = "title"
        const val KEY_DESCRIPTION = "description"
        const val KEY_PATH = "path"
        const val KEY_SIZE = "size"
        const val KEY_UPLOADED_AT = "uploadedAt"
        const val KEY_CHANNEL_KEY = "channelKey"
        const val KEY_CHANNEL_NAME = "channelName"
        const val KEY_ARTIST = "artist"
        const val KEY_MIME_TYPE = "mimeType"
        const val KEY_DURATION = "duration"
        const val KEY_THUMBNAIL = "thumbnail"
        const val KEY_REQUEST_PIP_ON_LAUNCH = "requestPipOnLaunch"

        fun fromMap(payload: Map<String, Any?>?): PlayerActivityPayload? {
            val extras = sanitizeExtras(payload) ?: return null
            return fromExtras(extras)
        }

        fun fromIntent(intent: Intent?): PlayerActivityPayload? {
            val bundle = intent?.extras ?: return null
            val extras = linkedMapOf<String, Any?>()
            for (key in bundle.keySet()) {
                when (val value = bundle.get(key)) {
                    is String, is Boolean, is Int, is Long, is Double, is Float -> extras[key] = value
                }
            }
            return fromExtras(extras)
        }

        fun putIntoIntent(intent: Intent, payload: Map<String, Any?>?): Intent {
            val extras = sanitizeExtras(payload) ?: return intent
            extras.forEach { (key, value) -> putExtra(intent, key, value) }
            return intent
        }

        private fun fromExtras(extras: LinkedHashMap<String, Any?>): PlayerActivityPayload? {
            val sourceUrl = extras[KEY_SOURCE_URL] as? String
            if (sourceUrl.isNullOrBlank()) return null
            extras.putIfAbsent(KEY_START_POSITION_MS, 0L)
            extras.putIfAbsent(KEY_SHOULD_AUTOPLAY, false)
            extras.putIfAbsent(KEY_REQUEST_PIP_ON_LAUNCH, false)
            return PlayerActivityPayload(extras)
        }

        private fun sanitizeExtras(payload: Map<String, Any?>?): LinkedHashMap<String, Any?>? {
            if (payload == null) return null
            val extras = linkedMapOf<String, Any?>()
            for ((key, value) in payload) {
                when (value) {
                    is String, is Boolean, is Int, is Long, is Double, is Float -> extras[key] = value
                }
            }
            return extras
        }

        private fun putExtra(intent: Intent, key: String, value: Any?) {
            when (value) {
                is String -> intent.putExtra(key, value)
                is Boolean -> intent.putExtra(key, value)
                is Int -> intent.putExtra(key, value)
                is Long -> intent.putExtra(key, value)
                is Double -> intent.putExtra(key, value)
                is Float -> intent.putExtra(key, value)
            }
        }
    }

    val sessionId: String?
        get() = rawExtras[KEY_SESSION_ID] as? String

    val sourceUrl: String
        get() = rawExtras[KEY_SOURCE_URL] as? String ?: ""

    val startPositionMs: Long
        get() = (rawExtras[KEY_START_POSITION_MS] as? Number)?.toDouble()?.roundToLong() ?: 0L

    val shouldAutoplay: Boolean
        get() = rawExtras[KEY_SHOULD_AUTOPLAY] as? Boolean ?: false

    val title: String?
        get() = rawExtras[KEY_TITLE] as? String

    val description: String?
        get() = rawExtras[KEY_DESCRIPTION] as? String

    val path: String?
        get() = rawExtras[KEY_PATH] as? String

    val videoId: String?
        get() = rawExtras[KEY_VIDEO_ID] as? String

    val size: Long?
        get() = (rawExtras[KEY_SIZE] as? Number)?.toDouble()?.roundToLong()

    val uploadedAt: Long?
        get() = (rawExtras[KEY_UPLOADED_AT] as? Number)?.toDouble()?.roundToLong()

    val channelKey: String?
        get() = rawExtras[KEY_CHANNEL_KEY] as? String

    val mimeType: String?
        get() = rawExtras[KEY_MIME_TYPE] as? String

    val durationSeconds: Double?
        get() = (rawExtras[KEY_DURATION] as? Number)?.toDouble()

    val thumbnail: String?
        get() = rawExtras[KEY_THUMBNAIL] as? String

    val requestPipOnLaunch: Boolean
        get() = rawExtras[KEY_REQUEST_PIP_ON_LAUNCH] as? Boolean ?: false

    fun toMap(requestPipOnLaunchOverride: Boolean? = null): Map<String, Any?> {
        val extras = LinkedHashMap(rawExtras)
        if (requestPipOnLaunchOverride != null) {
            extras[KEY_REQUEST_PIP_ON_LAUNCH] = requestPipOnLaunchOverride
        }
        return extras
    }

    fun buildIntent(context: Context, requestPipOnLaunchOverride: Boolean? = null): Intent {
        val intent = Intent()
            .setComponent(ComponentName(context.packageName, "${context.packageName}.PlayerActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        toMap(requestPipOnLaunchOverride).forEach { (key, value) ->
            putIntoIntent(intent, mapOf(key to value))
        }
        return intent
    }

    fun buildSessionActivityPendingIntent(context: Context, requestCode: Int = 0): PendingIntent {
        return PendingIntent.getActivity(
            context,
            requestCode,
            buildIntent(context, requestPipOnLaunchOverride = false),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun matchesSession(other: PlayerActivityPayload?): Boolean {
        if (other == null) return false
        return sessionId == other.sessionId && sourceUrl == other.sourceUrl
    }

    fun toNowPlayingMetadata(): Map<String, Any?> {
        val metadata = linkedMapOf<String, Any?>(
            "title" to (title ?: "Video"),
            "artist" to (
                (rawExtras[KEY_ARTIST] as? String)
                    ?: (rawExtras[KEY_CHANNEL_NAME] as? String)
                    ?: channelKey
                    ?: "PearTube"
                ),
        )
        durationSeconds?.let { metadata["duration"] = it }
        thumbnail?.let { metadata["artworkUrl"] = it }
        description?.let { metadata["album"] = it }
        return metadata
    }
}

object PlaybackHostBridge {
    @Volatile private var moduleInstance: MediaSessionModule? = null
    @Volatile private var nativePlaybackController: NativePlaybackController? = null
    @Volatile private var nativeHostActivity: Activity? = null
    @Volatile private var lastPlayerActivityPayload: PlayerActivityPayload? = null
    @Volatile private var desiredSessionActive: Boolean? = null
    @Volatile private var lastNowPlaying: Map<String, Any?>? = null
    @Volatile private var lastPlaybackState: Map<String, Any?>? = null

    fun register(module: MediaSessionModule) {
        moduleInstance = module
        desiredSessionActive?.let { module.applySessionActiveFromNative(it) }
        lastNowPlaying?.let { module.applyNowPlayingFromNative(it) }
        lastPlaybackState?.let { module.applyPlaybackStateFromNative(it) }
        module.refreshSessionActivityIntentFromNative()
    }

    fun unregister(module: MediaSessionModule) {
        if (moduleInstance === module) {
            moduleInstance = null
        }
    }

    fun rememberLaunchPayload(payload: PlayerActivityPayload?) {
        if (payload != null) {
            lastPlayerActivityPayload = payload
            moduleInstance?.refreshSessionActivityIntentFromNative()
        }
    }

    fun clearLaunchPayload() {
        lastPlayerActivityPayload = null
        moduleInstance?.refreshSessionActivityIntentFromNative()
    }

    fun currentLaunchPayload(): PlayerActivityPayload? = lastPlayerActivityPayload

    fun registerNativeHostActivity(activity: Activity) {
        nativeHostActivity = activity
        moduleInstance?.refreshSessionActivityIntentFromNative()
    }

    fun unregisterNativeHostActivity(activity: Activity) {
        if (nativeHostActivity === activity) {
            nativeHostActivity = null
            moduleInstance?.refreshSessionActivityIntentFromNative()
        }
    }

    fun currentHostActivity(): Activity? = nativeHostActivity

    fun registerNativePlaybackController(
        controller: NativePlaybackController,
        payload: PlayerActivityPayload? = lastPlayerActivityPayload,
    ) {
        nativePlaybackController = controller
        rememberLaunchPayload(payload)
    }

    fun unregisterNativePlaybackController(controller: NativePlaybackController) {
        if (nativePlaybackController === controller) {
            nativePlaybackController = null
            moduleInstance?.refreshSessionActivityIntentFromNative()
        }
    }

    fun dispatchPlay(): Boolean = nativePlaybackController?.play() == true

    fun dispatchPause(): Boolean = nativePlaybackController?.pause() == true

    fun dispatchStop(reason: String? = null): Boolean = nativePlaybackController?.stop(reason) == true

    fun dispatchSeekTo(positionMs: Long): Boolean = nativePlaybackController?.seekTo(positionMs) == true

    fun dispatchSeekBy(deltaMs: Long): Boolean = nativePlaybackController?.seekBy(deltaMs) == true

    fun dispatchEnterBackgroundAudio(): Boolean = nativePlaybackController?.enterBackgroundAudio() == true

    fun setSessionActive(active: Boolean) {
        desiredSessionActive = active
        moduleInstance?.applySessionActiveFromNative(active)
    }

    fun setNowPlaying(metadata: Map<String, Any?>) {
        lastNowPlaying = metadata.toMap()
        moduleInstance?.applyNowPlayingFromNative(metadata)
    }

    fun setPlaybackState(state: Map<String, Any?>) {
        lastPlaybackState = state.toMap()
        moduleInstance?.applyPlaybackStateFromNative(state)
    }

    fun clearNowPlaying() {
        lastNowPlaying = null
        lastPlaybackState = null
        moduleInstance?.clearNowPlayingFromNative()
    }

    fun buildPlayerActivityPendingIntent(context: Context, requestCode: Int = 0): PendingIntent? {
        return lastPlayerActivityPayload?.buildSessionActivityPendingIntent(context, requestCode)
    }
}
