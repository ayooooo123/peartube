package com.margelo.nitro.com.nitrovlc

import android.view.View
import android.widget.FrameLayout
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import java.util.WeakHashMap

/**
 * Plain React Native ViewManager for NitroVLCView.
 *
 * This replaces the Nitrogen-generated HybridNitroVLCViewManager which used
 * Fabric's ConcreteState/CachedProp/BorrowingReference machinery and caused
 * SIGSEGV/SIGABRT crashes when ShadowNodes were destroyed on background threads.
 *
 * This ViewManager uses RN's Fabric interop layer (automatic on RN 0.76+),
 * which bridges @ReactProp to Fabric without any CachedProp involvement.
 * Only `viewId` is passed as a prop — all other configuration is done
 * imperatively via NitroVLCModule.getView(viewId).
 */
class NitroVLCViewManager : SimpleViewManager<FrameLayout>() {

  companion object {
    // WeakHashMap: container view → player. Entries are automatically removed
    // when the container is GC'd. This avoids using View.setTag() which
    // BaseViewManager clears during view recycling.
    private val players = WeakHashMap<View, HybridNitroVLCView>()
  }

  override fun getName(): String = "NitroVLCView"

  override fun createViewInstance(reactContext: ThemedReactContext): FrameLayout {
    val container = FrameLayout(reactContext)
    val player = HybridNitroVLCView(reactContext)
    // Add the player's TextureView as a child filling the container
    container.addView(
      player.view,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      )
    )
    players[container] = player
    return container
  }

  @ReactProp(name = "viewId")
  fun setViewId(container: FrameLayout, viewId: String?) {
    val player = players[container] ?: return
    player.viewId = viewId ?: ""
  }

  override fun onDropViewInstance(container: FrameLayout) {
    val player = players.remove(container)
    player?.dispose()
    super.onDropViewInstance(container)
  }
}
