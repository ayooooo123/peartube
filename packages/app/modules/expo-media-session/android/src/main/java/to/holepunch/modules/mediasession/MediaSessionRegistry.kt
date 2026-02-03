package to.holepunch.modules.mediasession

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.content.Context
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat

object MediaSessionRegistry {
    @Volatile private var mediaSession: MediaSessionCompat? = null
    @Volatile private var callback: MediaSessionCompat.Callback? = null
    @Volatile private var metadata: MediaMetadataCompat? = null

    @Synchronized
    fun ensureSession(context: Context): MediaSessionCompat {
        val existing = mediaSession
        if (existing != null) return existing

        val componentName = ComponentName(context, androidx.media.session.MediaButtonReceiver::class.java)
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val sessionIntent = launchIntent?.let { intent ->
            PendingIntent.getActivity(
                context,
                0,
                Intent(intent),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val created = MediaSessionCompat(context, "PearTubeMediaSession", componentName, null).apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            if (sessionIntent != null) {
                setSessionActivity(sessionIntent)
            }
            callback?.let { setCallback(it) }
        }
        mediaSession = created
        return created
    }

    @Synchronized
    fun getSession(): MediaSessionCompat? = mediaSession

    @Synchronized
    fun setCallback(cb: MediaSessionCompat.Callback?) {
        callback = cb
        mediaSession?.setCallback(cb)
    }

    @Synchronized
    fun setMetadata(value: MediaMetadataCompat?) {
        metadata = value
    }

    @Synchronized
    fun getMetadata(): MediaMetadataCompat? = metadata

    @Synchronized
    fun release() {
        mediaSession?.release()
        mediaSession = null
        metadata = null
    }
}
