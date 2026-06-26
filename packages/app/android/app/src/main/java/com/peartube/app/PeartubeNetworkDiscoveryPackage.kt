package com.peartube.app

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

class PeartubeNetworkDiscoveryPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == "PeartubeNetworkDiscovery") {
      PeartubeNetworkDiscoveryModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        "PeartubeNetworkDiscovery" to ReactModuleInfo(
          "PeartubeNetworkDiscovery",
          PeartubeNetworkDiscoveryModule::class.java.name,
          false,
          false,
          false,
          false,
          false,
        )
      )
    }
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
