package com.peartube.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import androidx.core.content.ContextCompat

class PeartubeNetworkDiscoveryModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  private var multicastLock: WifiManager.MulticastLock? = null
  private var lastError: String? = null

  override fun getName(): String = "PeartubeNetworkDiscovery"

  @ReactMethod
  fun acquireMulticastLock(promise: Promise) {
    try {
      val appContext = reactContext.applicationContext
      val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: throw IllegalStateException("WifiManager unavailable")
      val lock = multicastLock ?: wifiManager.createMulticastLock("peartube-network-discovery").apply {
        setReferenceCounted(false)
        multicastLock = this
      }
      if (!lock.isHeld) lock.acquire()
      lastError = null
      promise.resolve(getDiscoveryNetworkStatusMap())
    } catch (err: Throwable) {
      lastError = err.message ?: err.toString()
      promise.reject("ERR_MULTICAST_LOCK", lastError, err)
    }
  }

  @ReactMethod
  fun releaseMulticastLock(promise: Promise) {
    try {
      multicastLock?.let { lock ->
        if (lock.isHeld) lock.release()
      }
      lastError = null
      promise.resolve(getDiscoveryNetworkStatusMap())
    } catch (err: Throwable) {
      lastError = err.message ?: err.toString()
      promise.reject("ERR_MULTICAST_UNLOCK", lastError, err)
    }
  }

  @ReactMethod
  fun getDiscoveryNetworkStatus(promise: Promise) {
    promise.resolve(getDiscoveryNetworkStatusMap())
  }

  private fun getDiscoveryNetworkStatusMap(): WritableMap {
    val appContext = reactContext.applicationContext
    val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val map = Arguments.createMap()
    map.putBoolean("multicastLockHeld", multicastLock?.isHeld == true)
    map.putBoolean("wifiEnabled", wifiManager?.isWifiEnabled == true)
    map.putInt("sdkVersion", Build.VERSION.SDK_INT)
    map.putBoolean("nearbyWifiPermissionGranted", hasNearbyWifiPermission())
    map.putString("lastError", lastError)
    return map
  }

  private fun hasNearbyWifiPermission(): Boolean {
    return if (Build.VERSION.SDK_INT >= 33) {
      ContextCompat.checkSelfPermission(
        reactContext,
        Manifest.permission.NEARBY_WIFI_DEVICES,
      ) == PackageManager.PERMISSION_GRANTED
    } else {
      true
    }
  }
}
