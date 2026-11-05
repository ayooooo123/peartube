package com.peartube.receiver

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

/**
 * The receiver's real home. A TV's whole job is to be reachable, so the
 * worklet, the swarm and the pairing code belong to a foreground service that
 * outlives the Activity and the launcher, not to a screen somebody opened.
 *
 * `START_STICKY` asks Android to bring it back after a kill; the boot receiver
 * asks for it again after a reboot.
 */
class ReceiverService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        (application as ReceiverApp).ensureRunning()
        return START_STICKY
    }

    override fun onDestroy() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, "Receiver", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps this TV available to cast to"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, ReceiverActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("PearTube Receiver")
            .setContentText("Ready to receive casts")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "receiver"
        private const val NOTIFICATION_ID = 0x9e21

        /** Starts (or re-raises) the always-on receiver. Safe to call repeatedly. */
        fun start(context: Context) {
            val intent = Intent(context, ReceiverService::class.java)
            context.startForegroundService(intent)
        }
    }
}
