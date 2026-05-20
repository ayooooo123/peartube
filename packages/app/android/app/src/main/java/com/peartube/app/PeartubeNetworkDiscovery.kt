package com.peartube.app

import android.content.Context
import android.util.Log

class PeartubeNetworkDiscovery(private val context: Context) {
  private val tag = "PeartubeNetworkDiscovery"
  private val implementationGaps = mutableListOf<String>()

  fun start() {
    logImplementationGap("start", "Android discovery bridge is not fully implemented yet for ${context.packageName}")
  }

  fun stop() {
    logImplementationGap("stop", "No active network discovery session is currently tracked for ${context.packageName}")
  }

  fun logImplementationGap(feature: String, detail: String) {
    val message = "${feature}: ${detail}"
    implementationGaps.add(message)
    Log.w(tag, message)
  }

  fun logException(operation: String, throwable: Throwable) {
    Log.e(tag, "${operation} failed", throwable)
  }

  fun snapshotImplementationGaps(): List<String> = implementationGaps.toList()

  fun hasContext(): Boolean = context.packageName.isNotBlank()
}
