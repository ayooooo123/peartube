package com.margelo.nitro.com.nitrovlc

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ModuleSpec
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class NitroVLCPackage : BaseReactPackage() {
  companion object {
    init {
      NitroVLCOnLoad.initializeNative()
    }
  }

  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext,
  ): NativeModule? {
    return null
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      emptyMap<String, ReactModuleInfo>()
    }
  }

  override fun getViewManagers(reactContext: ReactApplicationContext): List<ModuleSpec> {
    return listOf(ModuleSpec.viewManagerSpec { NitroVLCViewManager() })
  }
}
