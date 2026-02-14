package to.holepunch.peartube.mpv

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ModuleSpec
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class MpvPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider { emptyMap<String, ReactModuleInfo>() }
  }

  override fun getViewManagers(reactContext: ReactApplicationContext): List<ModuleSpec> {
    return listOf(ModuleSpec.viewManagerSpec { MpvPlayerViewManager() })
  }
}
