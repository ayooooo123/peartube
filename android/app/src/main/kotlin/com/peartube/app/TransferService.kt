package com.peartube.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Lightweight `dataSync` foreground service kept alive strictly while Soulseek, ubit, or file
 * downloads are running. Keeps Android's Cached App Freezer from pausing sockets when the screen
 * locks or the user switches apps, and stops itself the instant the queue empties.
 */
class TransferService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty().ifBlank { "Downloading to PearTube" }
        val detail = intent?.getStringExtra(EXTRA_DETAIL).orEmpty().ifBlank { "Keeping transfers active in background" }
        val progress = intent?.getIntExtra(EXTRA_PROGRESS, -1) ?: -1

        acquireWakeLock()
        val notification = buildNotification(title, detail, progress)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: Exception) {
            // Android 12+ may refuse background foreground-service starts if the app was already
            // backgrounded before the job started; durable `.part` resume handles that cleanly.
            releaseWakeLock()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
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
        val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PearTube:TransferWakeLock").apply {
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

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Downloads",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Active Soulseek, media, and file downloads"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, detail: String, progress: Int): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent(this, MainActivity::class.java)
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val openApp = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(detail)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openApp)

        if (progress in 0..100) {
            builder.setProgress(100, progress, false)
        } else {
            builder.setProgress(0, 0, true)
        }
        return builder.build()
    }

    companion object {
        private const val CHANNEL_ID = "peartube_transfers"
        private const val NOTIFICATION_ID = 4102
        private const val WAKE_LOCK_TIMEOUT_MS = 2 * 60 * 60_000L

        private const val ACTION_SYNC = "com.peartube.app.action.TRANSFER_SYNC"
        private const val ACTION_STOP = "com.peartube.app.action.TRANSFER_STOP"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_DETAIL = "detail"
        private const val EXTRA_PROGRESS = "progress"

        @Volatile
        private var running = false
        @Volatile
        private var lastKey = ""

        fun sync(
            context: Context,
            jobs: List<AcquireJob>,
            localDownloads: Map<String, DownloadProgress>,
        ) {
            val activeJobs = jobs.filter { it.isActive }
            val totalActive = activeJobs.size + localDownloads.size
            if (totalActive == 0) {
                if (running) {
                    running = false
                    lastKey = ""
                    runCatching { context.stopService(Intent(context, TransferService::class.java)) }
                }
                return
            }

            val lead = activeJobs.firstOrNull()
            val title = when {
                lead != null && totalActive > 1 -> "${lead.title.ifBlank { "Downloading" }} (+${totalActive - 1} more)"
                lead != null -> lead.title.ifBlank { "Downloading to PearTube" }
                localDownloads.size == 1 -> "Saving to Downloads"
                else -> "Saving ${localDownloads.size} files to Downloads"
            }
            val detail = when {
                lead != null -> lead.note?.takeIf { it.isNotBlank() } ?: lead.statusLabel()
                else -> "Keeping transfers active in background"
            }
            val leadFraction = lead?.progressFraction
            val progress = when {
                leadFraction != null -> (leadFraction * 100f).toInt().coerceIn(0, 100)
                localDownloads.isNotEmpty() -> {
                    val bytes = localDownloads.values.sumOf { it.bytes }
                    val total = localDownloads.values.sumOf { it.total }
                    if (total > 0L) ((bytes * 100L) / total).toInt().coerceIn(0, 100) else -1
                }
                else -> -1
            }

            val key = "$title|$detail|$progress"
            if (running && key == lastKey) return
            lastKey = key

            val intent = Intent(context, TransferService::class.java).apply {
                action = ACTION_SYNC
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_DETAIL, detail)
                putExtra(EXTRA_PROGRESS, progress)
            }
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
