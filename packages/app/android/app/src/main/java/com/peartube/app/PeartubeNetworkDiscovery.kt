package com.peartube.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

data class DiscoveryNetworkStatus(
  val multicastLockHeld: Boolean,
  val wifiEnabled: Boolean,
  val sdkVersion: Int,
  val nearbyWifiPermissionGranted: Boolean,
  val lastError: String?
)

private object DiscoveryLockState {
  @Volatile private var appContext: Context? = null
  @Volatile private var multicastLock: WifiManager.MulticastLock? = null
  @Volatile private var lastError: String? = null

  @Synchronized
  private fun bind(context: Context): Context {
    val resolved = context.applicationContext
    appContext = resolved
    return resolved
  }

  @Synchronized
  fun acquire(context: Context): DiscoveryNetworkStatus {
    val appContext = bind(context)
    try {
      val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: throw IllegalStateException("WifiManager unavailable")
      val lock = multicastLock ?: wifiManager.createMulticastLock("peartube-network-discovery").apply {
        setReferenceCounted(false)
        multicastLock = this
      }
      if (!lock.isHeld) lock.acquire()
      lastError = null
    } catch (err: Throwable) {
      lastError = err.message ?: err.toString()
    }
    return snapshot(appContext)
  }

  @Synchronized
  fun release(context: Context): DiscoveryNetworkStatus {
    val appContext = bind(context)
    try {
      multicastLock?.let { lock ->
        if (lock.isHeld) lock.release()
      }
      lastError = null
    } catch (err: Throwable) {
      lastError = err.message ?: err.toString()
    }
    return snapshot(appContext)
  }

  @Synchronized
  fun snapshot(context: Context): DiscoveryNetworkStatus {
    val appContext = bind(context)
    val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    return DiscoveryNetworkStatus(
      multicastLockHeld = multicastLock?.isHeld == true,
      wifiEnabled = wifiManager?.isWifiEnabled == true,
      sdkVersion = Build.VERSION.SDK_INT,
      nearbyWifiPermissionGranted = hasNearbyWifiPermission(appContext),
      lastError = lastError,
    )
  }

  private fun hasNearbyWifiPermission(context: Context): Boolean {
    return if (Build.VERSION.SDK_INT >= 33) {
      ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.NEARBY_WIFI_DEVICES,
      ) == PackageManager.PERMISSION_GRANTED
    } else {
      true
    }
  }
}

class PeartubeNetworkDiscovery(private val context: Context) {
  private val tag = "PeartubeNetworkDiscovery"

  fun start(): DiscoveryNetworkStatus {
    val status = DiscoveryLockState.acquire(context)
    Log.i(tag, "foreground: multicast lock ${if (status.multicastLockHeld) "held" else "unavailable"}")
    return status
  }

  fun stop(): DiscoveryNetworkStatus {
    val status = DiscoveryLockState.release(context)
    Log.i(tag, "background: multicast lock ${if (status.multicastLockHeld) "held" else "released"}")
    return status
  }

  fun acquireMulticastLock(): DiscoveryNetworkStatus = DiscoveryLockState.acquire(context)

  fun releaseMulticastLock(): DiscoveryNetworkStatus = DiscoveryLockState.release(context)

  fun getDiscoveryNetworkStatus(): DiscoveryNetworkStatus = DiscoveryLockState.snapshot(context)

  fun logException(operation: String, throwable: Throwable) {
    Log.e(tag, "$operation failed", throwable)
  }
}
