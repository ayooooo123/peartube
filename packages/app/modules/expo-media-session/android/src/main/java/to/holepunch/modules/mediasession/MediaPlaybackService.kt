package to.holepunch.modules.mediasession

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.MediaMetadataCompat
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver

class MediaPlaybackService : Service() {
    
    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "peartube_media_playback_v2"
        private const val CHANNEL_NAME = "Media Playback"
    }
    
    private var mediaSessionToken: MediaSessionCompat.Token? = null
    private var isForeground = false
    
    override fun onBind(intent: Intent?): IBinder? = null
    
    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }
    
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        android.util.Log.d("MediaPlaybackService", "onStartCommand: action=${intent?.action}")
        mediaSessionToken = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra("mediaSessionToken", MediaSessionCompat.Token::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra("mediaSessionToken")
        } ?: mediaSessionToken

        if (mediaSessionToken == null) {
            mediaSessionToken = MediaSessionRegistry.getSession()?.sessionToken
        }

        when (intent?.action) {
            "UPDATE_NOTIFICATION" -> {
                updateNotification()
                return START_NOT_STICKY
            }
            MediaSessionModule.ACTION_PIP_PLAY -> {
                android.util.Log.d("MediaPlaybackService", "PiP play action received")
                ensureForeground()
                PipServiceBridge.onPlay()
                return START_NOT_STICKY
            }
            MediaSessionModule.ACTION_PIP_PAUSE -> {
                android.util.Log.d("MediaPlaybackService", "PiP pause action received")
                ensureForeground()
                PipServiceBridge.onPause()
                return START_NOT_STICKY
            }
            MediaSessionModule.ACTION_PIP_REWIND -> {
                android.util.Log.d("MediaPlaybackService", "PiP rewind action received")
                ensureForeground()
                PipServiceBridge.onRewind()
                return START_NOT_STICKY
            }
            MediaSessionModule.ACTION_PIP_FORWARD -> {
                android.util.Log.d("MediaPlaybackService", "PiP forward action received")
                ensureForeground()
                PipServiceBridge.onForward()
                return START_NOT_STICKY
            }
        }

        ensureForeground()
        return START_NOT_STICKY
    }
    
    override fun onDestroy() {
        super.onDestroy()
        stopForeground(STOP_FOREGROUND_REMOVE)
        isForeground = false
    }

    private fun ensureForeground() {
        if (isForeground) return
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
        } catch (e: Exception) {
            // On Android 12+, startForeground may fail if app is in background
            // (e.g., after a crash when system tries to restart the service)
            android.util.Log.w("MediaPlaybackService", "Failed to start foreground: ${e.message}")
            // Stop the service gracefully instead of crashing
            stopSelf()
        }
    }
    
    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Shows media playback controls"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }
    
    private fun buildNotification(): Notification {
        val contentIntent = packageManager.getLaunchIntentForPackage(packageName)?.let { intent ->
            PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        
        val controller = mediaSessionToken?.let { token ->
            try {
                MediaControllerCompat(this, token)
            } catch (_: Exception) {
                null
            }
        }

        val title = controller?.metadata?.getString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_TITLE)
        val artist = controller?.metadata?.getString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_ARTIST)
        val isPlaying = controller?.playbackState?.state == PlaybackStateCompat.STATE_PLAYING
        val art = controller?.metadata?.getBitmap(MediaMetadataCompat.METADATA_KEY_ART)
            ?: controller?.metadata?.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART)

        fun actionIntent(action: String, requestCode: Int): PendingIntent {
            val intent = Intent(this, MediaPlaybackService::class.java).apply { this.action = action }
            return PendingIntent.getService(
                this,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title ?: "PearTube")
            .setContentText(artist ?: if (isPlaying) "Playing video" else "Paused")
            .setOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setOnlyAlertOnce(true)
        
        contentIntent?.let { builder.setContentIntent(it) }
        
        mediaSessionToken?.let { token ->
            val mediaStyle = androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(token)
                .setShowActionsInCompactView(0, 1, 2)
            
            builder.setStyle(mediaStyle)
            
            builder.addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_media_rew,
                    "Rewind",
                    actionIntent(MediaSessionModule.ACTION_PIP_REWIND, 101)
                )
            )
            
            builder.addAction(
                NotificationCompat.Action(
                    if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                    if (isPlaying) "Pause" else "Play",
                    actionIntent(
                        if (isPlaying) MediaSessionModule.ACTION_PIP_PAUSE else MediaSessionModule.ACTION_PIP_PLAY,
                        102
                    )
                )
            )
            
            builder.addAction(
                NotificationCompat.Action(
                    android.R.drawable.ic_media_ff,
                    "Fast Forward",
                    actionIntent(MediaSessionModule.ACTION_PIP_FORWARD, 103)
                )
            )
        }

        if (art != null) {
            builder.setLargeIcon(art)
        }
        
        return builder.build()
    }

    private fun updateNotification() {
        val notification = buildNotification()
        val manager = getSystemService(NotificationManager::class.java)
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification)
        } else {
            ensureForeground()
        }
    }
}

object PipServiceBridge {
    private var moduleInstance: MediaSessionModule? = null
    
    fun register(module: MediaSessionModule) {
        moduleInstance = module
    }
    
    fun unregister(module: MediaSessionModule) {
        if (moduleInstance === module) {
            moduleInstance = null
        }
    }
    
    fun onPlay() {
        moduleInstance?.handlePipPlay()
    }
    
    fun onPause() {
        moduleInstance?.handlePipPause()
    }
    
    fun onRewind() {
        moduleInstance?.handlePipRewind()
    }
    
    fun onForward() {
        moduleInstance?.handlePipForward()
    }
    
}
