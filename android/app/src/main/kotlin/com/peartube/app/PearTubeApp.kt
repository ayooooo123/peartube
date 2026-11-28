package com.peartube.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class PearTubeApp : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        ExternalImageCache.init(this)
        model = AppModel(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                model.onForeground()
            }

            override fun onStop(owner: LifecycleOwner) {
                model.inForeground = false
                model.onBackground()
            }
        })
    }
}
