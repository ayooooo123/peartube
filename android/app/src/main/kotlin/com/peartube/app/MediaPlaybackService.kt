package com.peartube.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

enum class MediaAction {
    Play,
    Pause,
    TogglePlayPause,
    Next,
    Previous,
    SkipForward,
    SkipBack,
    SeekTo,
    Stop,
}

data class MediaSessionSnapshot(
    val active: Boolean = false,
    val isVideo: Boolean = false,
    val isCast: Boolean = false,
    val title: String = "",
    val subtitle: String = "",
    val album: String = "",
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val artworkUrl: String? = null,
) {
    val structuralKey: String
        get() = "$active|$isVideo|$isCast|$title|$subtitle|$album|$playing|$buffering|$durationMs|${artworkUrl.orEmpty()}"
}

/**
 * Dedicated `mediaPlayback` foreground service owning Android's native [MediaSession],
 * lockscreen / notification shade [Notification.MediaStyle] controls, [AudioFocusRequest],
 * headphone-disconnect (`ACTION_AUDIO_BECOMING_NOISY`) pause, and [PowerManager.PARTIAL_WAKE_LOCK]
 * so both music and video audio survive screen lock and app switching cleanly.
 */
class MediaPlaybackService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var mediaSession: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private var focusContentType = AudioAttributes.CONTENT_TYPE_MUSIC
    private var pausedByTransientFocusLoss = false
    private var noisyReceiverRegistered = false
    private var isForegroundStarted = false

    private var lastSnapshot: MediaSessionSnapshot = MediaSessionSnapshot()
    private var lastArtworkUrl: String? = null
    private var loadedArtwork: Bitmap? = null
    private var artworkJob: Job? = null

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (!lastSnapshot.isCast && intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                pausedByTransientFocusLoss = false
                appModelOrNull()?.dispatchMediaAction(MediaAction.Pause)
            }
        }
    }

    private val focusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        if (lastSnapshot.isCast) return@OnAudioFocusChangeListener
        val model = appModelOrNull() ?: return@OnAudioFocusChangeListener
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                hasAudioFocus = false
                pausedByTransientFocusLoss = false
                model.dispatchMediaAction(MediaAction.Pause)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                val currentlyPlaying = lastSnapshot.playing
                if (currentlyPlaying) {
                    pausedByTransientFocusLoss = true
                    model.dispatchMediaAction(MediaAction.Pause)
                }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
                if (pausedByTransientFocusLoss) {
                    pausedByTransientFocusLoss = false
                    model.dispatchMediaAction(MediaAction.Play)
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        audioManager = getSystemService(AudioManager::class.java)
        ensureChannel()
        initMediaSession()
        registerNoisyReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                appModelOrNull()?.dispatchMediaAction(MediaAction.Stop)
                stopPlaybackForeground()
                return START_NOT_STICKY
            }
            ACTION_PLAY_PAUSE -> {
                appModelOrNull()?.dispatchMediaAction(MediaAction.TogglePlayPause)
                return START_NOT_STICKY
            }
            ACTION_PREV -> {
                val act = if (lastSnapshot.isVideo) MediaAction.SkipBack else MediaAction.Previous
                appModelOrNull()?.dispatchMediaAction(act)
                return START_NOT_STICKY
            }
            ACTION_NEXT -> {
                val act = if (lastSnapshot.isVideo) MediaAction.SkipForward else MediaAction.Next
                appModelOrNull()?.dispatchMediaAction(act)
                return START_NOT_STICKY
            }
            else -> {
                val snapshot = pendingSnapshot ?: appModelOrNull()?.currentMediaSnapshot() ?: MediaSessionSnapshot()
                applySnapshot(snapshot, forceNotification = true)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (activeInstance === this) {
            activeInstance = null
        }
        running = false
        lastStructuralKey = ""
        artworkJob?.cancel()
        unregisterNoisyReceiver()
        abandonAudioFocus()
        releaseWakeLock()
        runCatching {
            mediaSession?.isActive = false
            mediaSession?.release()
        }
        mediaSession = null
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun appModelOrNull(): AppModel? = (application as? PearTubeApp)?.model

    private fun initMediaSession() {
        val session = MediaSession(this, "PearTubeMediaSession")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() {
                pausedByTransientFocusLoss = false
                appModelOrNull()?.dispatchMediaAction(MediaAction.Play)
            }

            override fun onPause() {
                pausedByTransientFocusLoss = false
                appModelOrNull()?.dispatchMediaAction(MediaAction.Pause)
            }

            override fun onSkipToNext() {
                val act = if (lastSnapshot.isVideo) MediaAction.SkipForward else MediaAction.Next
                appModelOrNull()?.dispatchMediaAction(act)
            }

            override fun onSkipToPrevious() {
                val act = if (lastSnapshot.isVideo) MediaAction.SkipBack else MediaAction.Previous
                appModelOrNull()?.dispatchMediaAction(act)
            }

            override fun onFastForward() {
                appModelOrNull()?.dispatchMediaAction(MediaAction.SkipForward)
            }

            override fun onRewind() {
                appModelOrNull()?.dispatchMediaAction(MediaAction.SkipBack)
            }

            override fun onSeekTo(pos: Long) {
                appModelOrNull()?.dispatchMediaAction(MediaAction.SeekTo, seekPositionMs = pos)
            }

            override fun onStop() {
                pausedByTransientFocusLoss = false
                appModelOrNull()?.dispatchMediaAction(MediaAction.Stop)
                stopPlaybackForeground()
            }
        })
        session.isActive = true
        mediaSession = session
    }

    private fun registerNoisyReceiver() {
        if (noisyReceiverRegistered) return
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(noisyReceiver, filter)
            }
            noisyReceiverRegistered = true
        }
    }

    private fun unregisterNoisyReceiver() {
        if (!noisyReceiverRegistered) return
        noisyReceiverRegistered = false
        runCatching { unregisterReceiver(noisyReceiver) }
    }

    internal fun applySnapshot(snapshot: MediaSessionSnapshot, forceNotification: Boolean = false) {
        if (!snapshot.active) {
            stopPlaybackForeground()
            return
        }

        val structureChanged = snapshot.structuralKey != lastSnapshot.structuralKey
        lastSnapshot = snapshot

        if (snapshot.isCast) {
            // Casting plays audio on the TV, never locally: never steal phone audio focus,
            // while holding the foreground service (and wake lock during playback/reconnect)
            // so Android's Cached App Freezer cannot freeze the cast control socket.
            pausedByTransientFocusLoss = false
            abandonAudioFocus()
            if (snapshot.playing || snapshot.buffering) {
                acquireWakeLock()
            } else {
                releaseWakeLock()
            }
        } else if (snapshot.playing) {
            requestAudioFocus(snapshot.isVideo)
            acquireWakeLock()
        } else {
            releaseWakeLock()
            if (!pausedByTransientFocusLoss) {
                abandonAudioFocus()
            }
        }

        refreshArtworkIfNeeded(snapshot.artworkUrl)
        updateMediaSession(snapshot)

        if (forceNotification || structureChanged || !isForegroundStarted) {
            postNotification(snapshot)
        }
    }

    private fun refreshArtworkIfNeeded(url: String?) {
        if (url == lastArtworkUrl) return
        lastArtworkUrl = url
        artworkJob?.cancel()
        if (url.isNullOrBlank()) {
            loadedArtwork = null
            return
        }
        val cached = ExternalImageCache.getCachedBitmap(url)
        if (cached != null) {
            loadedArtwork = cached
            return
        }
        loadedArtwork = null
        artworkJob = serviceScope.launch {
            val bmp = ExternalImageCache.loadBitmap(url)
            if (bmp != null && lastArtworkUrl == url && lastSnapshot.active) {
                loadedArtwork = bmp
                updateMediaSession(lastSnapshot)
                postNotification(lastSnapshot)
            }
        }
    }

    private fun updateMediaSession(snapshot: MediaSessionSnapshot) {
        val session = mediaSession ?: return
        val metaBuilder = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, snapshot.title.ifBlank { "PearTube" })
            .putString(MediaMetadata.METADATA_KEY_ARTIST, snapshot.subtitle)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, snapshot.album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, snapshot.durationMs.coerceAtLeast(0L))
        loadedArtwork?.let { bmp ->
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp)
            metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, bmp)
        }
        session.setMetadata(metaBuilder.build())

        val pbState = when {
            snapshot.playing && snapshot.buffering -> PlaybackState.STATE_BUFFERING
            snapshot.playing -> PlaybackState.STATE_PLAYING
            else -> PlaybackState.STATE_PAUSED
        }
        val actions = PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_FAST_FORWARD or
            PlaybackState.ACTION_REWIND or
            PlaybackState.ACTION_SEEK_TO or
            PlaybackState.ACTION_STOP

        val stateBuilder = PlaybackState.Builder()
            .setActions(actions)
            .setState(
                pbState,
                snapshot.positionMs.coerceAtLeast(0L),
                if (snapshot.playing) 1.0f else 0.0f,
                SystemClock.elapsedRealtime(),
            )
        session.setPlaybackState(stateBuilder.build())
        if (!session.isActive) {
            session.isActive = true
        }
    }

    private fun postNotification(snapshot: MediaSessionSnapshot) {
        val notification = buildNotification(snapshot)
        if (!isForegroundStarted) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
                isForegroundStarted = true
            } catch (_: Exception) {
                // Android 12+ may restrict starting a foreground service while already backgrounded.
                val nm = getSystemService(NotificationManager::class.java)
                runCatching { nm?.notify(NOTIFICATION_ID, notification) }
            }
        } else {
            val nm = getSystemService(NotificationManager::class.java)
            runCatching { nm?.notify(NOTIFICATION_ID, notification) }
        }
    }

    private fun buildNotification(snapshot: MediaSessionSnapshot): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java)
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val openApp = PendingIntent.getActivity(this, 100, launchIntent, pendingFlags)

        val prevIconRes = if (snapshot.isVideo) android.R.drawable.ic_media_rew else android.R.drawable.ic_media_previous
        val prevLabel = if (snapshot.isVideo) "Back 10s" else "Previous"
        val playPauseIconRes = if (snapshot.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val playPauseLabel = if (snapshot.playing) "Pause" else "Play"
        val nextIconRes = if (snapshot.isVideo) android.R.drawable.ic_media_ff else android.R.drawable.ic_media_next
        val nextLabel = if (snapshot.isVideo) "Forward 10s" else "Next"

        val prevAction = Notification.Action.Builder(
            Icon.createWithResource(this, prevIconRes),
            prevLabel,
            servicePendingIntent(ACTION_PREV, 101),
        ).build()

        val playPauseAction = Notification.Action.Builder(
            Icon.createWithResource(this, playPauseIconRes),
            playPauseLabel,
            servicePendingIntent(ACTION_PLAY_PAUSE, 102),
        ).build()

        val nextAction = Notification.Action.Builder(
            Icon.createWithResource(this, nextIconRes),
            nextLabel,
            servicePendingIntent(ACTION_NEXT, 103),
        ).build()

        val stopAction = Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
            "Stop",
            servicePendingIntent(ACTION_STOP, 104),
        ).build()

        val style = Notification.MediaStyle()
            .setShowActionsInCompactView(0, 1, 2)
        mediaSession?.sessionToken?.let { style.setMediaSession(it) }

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(snapshot.title.ifBlank { "PearTube" })
            .setContentText(
                snapshot.subtitle.ifBlank {
                    when {
                        snapshot.isCast -> "Casting to TV"
                        snapshot.isVideo -> "Playing video"
                        else -> "Playing audio"
                    }
                },
            )
            .setContentIntent(openApp)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setOngoing(snapshot.playing || snapshot.isCast)
            .setOnlyAlertOnce(true)
            .addAction(prevAction)
            .addAction(playPauseAction)
            .addAction(nextAction)
            .addAction(stopAction)
            .setStyle(style)

        if (snapshot.album.isNotBlank()) {
            builder.setSubText(snapshot.album)
        }
        loadedArtwork?.let { builder.setLargeIcon(it) }

        return builder.build()
    }

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, MediaPlaybackService::class.java).setAction(action)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getService(this, requestCode, intent, flags)
    }

    private fun requestAudioFocus(isVideo: Boolean) {
        val am = audioManager ?: return
        val desiredType = if (isVideo) AudioAttributes.CONTENT_TYPE_MOVIE else AudioAttributes.CONTENT_TYPE_MUSIC
        if (hasAudioFocus && focusContentType == desiredType) return
        if (hasAudioFocus && focusContentType != desiredType) {
            abandonAudioFocus()
        }
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(desiredType)
            .build()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener(focusChangeListener)
            .build()
        focusRequest = req
        focusContentType = desiredType
        val result = runCatching { am.requestAudioFocus(req) }.getOrDefault(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonAudioFocus() {
        val am = audioManager ?: return
        val req = focusRequest ?: return
        hasAudioFocus = false
        focusRequest = null
        runCatching { am.abandonAudioFocusRequest(req) }
    }

    private fun acquireWakeLock() {
        val existing = wakeLock
        if (existing != null) {
            if (!existing.isHeld) {
                runCatching { existing.acquire(WAKE_LOCK_TIMEOUT_MS) }
            }
            return
        }
        val pm = getSystemService(PowerManager::class.java) ?: return
        val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PearTube:MediaPlaybackWakeLock").apply {
            setReferenceCounted(false)
        }
        wakeLock = lock
        runCatching { lock.acquire(WAKE_LOCK_TIMEOUT_MS) }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        wakeLock = null
        if (lock.isHeld) {
            runCatching { lock.release() }
        }
    }

    private fun stopPlaybackForeground() {
        running = false
        lastStructuralKey = ""
        lastSnapshot = MediaSessionSnapshot()
        pausedByTransientFocusLoss = false
        abandonAudioFocus()
        releaseWakeLock()
        runCatching { mediaSession?.isActive = false }
        if (isForegroundStarted) {
            isForegroundStarted = false
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        }
        stopSelf()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Media playback",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Lockscreen and background playback controls for music and video"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "peartube_media_playback"
        private const val NOTIFICATION_ID = 4103
        private const val WAKE_LOCK_TIMEOUT_MS = 4 * 60 * 60_000L
        private const val POSITION_SYNC_THROTTLE_MS = 2_500L

        private const val ACTION_SYNC = "com.peartube.app.action.MEDIA_SYNC"
        private const val ACTION_PLAY_PAUSE = "com.peartube.app.action.MEDIA_PLAY_PAUSE"
        private const val ACTION_PREV = "com.peartube.app.action.MEDIA_PREV"
        private const val ACTION_NEXT = "com.peartube.app.action.MEDIA_NEXT"
        private const val ACTION_STOP = "com.peartube.app.action.MEDIA_STOP"

        @Volatile
        private var activeInstance: MediaPlaybackService? = null
        @Volatile
        private var pendingSnapshot: MediaSessionSnapshot? = null
        @Volatile
        private var running = false
        @Volatile
        private var lastStructuralKey = ""
        @Volatile
        private var lastPositionSyncAt = 0L

        fun sync(context: Context, snapshot: MediaSessionSnapshot) {
            pendingSnapshot = snapshot
            if (!snapshot.active) {
                if (running || activeInstance != null) {
                    running = false
                    lastStructuralKey = ""
                    lastPositionSyncAt = 0L
                    activeInstance?.applySnapshot(snapshot)
                        ?: runCatching { context.stopService(Intent(context, MediaPlaybackService::class.java)) }
                }
                return
            }

            val now = SystemClock.uptimeMillis()
            val structuralChanged = snapshot.structuralKey != lastStructuralKey
            if (!structuralChanged && running && (now - lastPositionSyncAt) < POSITION_SYNC_THROTTLE_MS) {
                return
            }
            lastStructuralKey = snapshot.structuralKey
            lastPositionSyncAt = now

            val instance = activeInstance
            if (instance != null && running) {
                instance.applySnapshot(snapshot, forceNotification = structuralChanged)
                return
            }

            val intent = Intent(context, MediaPlaybackService::class.java).setAction(ACTION_SYNC)
            val started = runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                true
            }.getOrDefault(false)
            running = started
        }
    }
}
