package com.peartube.app

import android.app.Application
import android.net.wifi.WifiManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class PearTubeApp : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        model = AppModel(this)
        // LAN discovery's mDNS needs the multicast lock while the app is in front.
        val multicast = getSystemService(WifiManager::class.java)
            .createMulticastLock("PearTube LAN discovery")
            .apply { setReferenceCounted(false) }
        val wifiLock = getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PearTube Cast stream")
            .apply { setReferenceCounted(false) }
        // Keep the worklet and LAN BlobServer pumping while casting to a TV even if the phone screen locks.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                model.inForeground = true
                multicast.acquire()
                wifiLock.acquire()
                model.worker.resume()
            }

            override fun onStop(owner: LifecycleOwner) {
                model.inForeground = false
                model.onBackground()
                if (!model.shouldKeepWorkerAwake()) {
                    model.worker.suspend()
                    if (wifiLock.isHeld) wifiLock.release()
                    if (multicast.isHeld) multicast.release()
                }
            }
        })
    }
}
