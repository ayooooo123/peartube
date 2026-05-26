package com.peartube.app

import android.app.Activity
import android.app.Application
import android.content.res.Configuration
import android.os.Bundle

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

import com.peartube.app.PeartubeNetworkDiscovery

class MainApplication : Application(), ReactApplication {

  private val networkDiscovery by lazy { PeartubeNetworkDiscovery(this) }
  private var startedActivityCount = 0

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
          add(PeartubeNetworkDiscoveryPackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    try {
      networkDiscovery.start()
    } catch (t: Throwable) {
      networkDiscovery.logException("startup", t)
    }
    loadReactNative(this)
    registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityStarted(activity: Activity) {
        startedActivityCount += 1
        if (startedActivityCount == 1) {
          try {
            networkDiscovery.start()
          } catch (t: Throwable) {
            networkDiscovery.logException("foreground", t)
          }
        }
      }
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivityStopped(activity: Activity) {
        startedActivityCount = (startedActivityCount - 1).coerceAtLeast(0)
        if (startedActivityCount == 0) {
          try {
            networkDiscovery.stop()
          } catch (t: Throwable) {
            networkDiscovery.logException("background", t)
          }
        }
      }
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
