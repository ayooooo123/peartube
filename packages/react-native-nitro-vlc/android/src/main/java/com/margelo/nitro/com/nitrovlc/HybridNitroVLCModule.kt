package com.margelo.nitro.com.nitrovlc

import org.videolan.libvlc.LibVLC

class HybridNitroVLCModule : HybridNitroVLCModuleSpec() {

  override fun getVLCVersion(): String {
    return LibVLC.version()
  }

  override fun getView(viewId: String): HybridNitroVLCViewSpec? {
    return HybridNitroVLCView.registry[viewId]?.get()
  }
}
