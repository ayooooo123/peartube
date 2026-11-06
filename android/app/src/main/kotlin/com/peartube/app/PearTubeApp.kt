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
        model = AppModel(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                model.inForeground = true
                model.applyBackgroundPolicy()
            }

            override fun onStop(owner: LifecycleOwner) {
                model.inForeground = false
                model.onBackground()
            }
        })
    }
}
