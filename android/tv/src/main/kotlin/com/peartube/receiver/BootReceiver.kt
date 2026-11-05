package com.peartube.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * A TV that must be reachable after a power cut: bring the receiver service
 * back on boot and after the APK is replaced.
 *
 * Android 15 restricts which foreground-service types a boot receiver may
 * start, and an OEM build may refuse outright. A refused start must not be
 * silent: it is logged, and the launcher path (`ReceiverActivity` also starts
 * the service) remains the guaranteed one.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON" -> {
                try {
                    ReceiverService.start(context)
                } catch (error: Throwable) {
                    Log.w(TAG, "Boot start refused (${intent.action}); the launcher will raise the receiver", error)
                }
            }
        }
    }

    private companion object {
        const val TAG = "PearTubeReceiver"
    }
}
