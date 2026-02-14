package to.holepunch.peartube.mpv

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.annotations.ReactProp

class MpvPlayerViewManager : SimpleViewManager<MpvView>() {
  override fun getName(): String = "MpvPlayerView"

  override fun createViewInstance(reactContext: ThemedReactContext): MpvView {
    return MpvView(reactContext)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> {
    return MapBuilder.builder<String, Any>()
      .put("onLoad", MapBuilder.of("registrationName", "onLoad"))
      .put("onProgress", MapBuilder.of("registrationName", "onProgress"))
      .put("onPlaying", MapBuilder.of("registrationName", "onPlaying"))
      .put("onPaused", MapBuilder.of("registrationName", "onPaused"))
      .put("onBuffering", MapBuilder.of("registrationName", "onBuffering"))
      .put("onEnded", MapBuilder.of("registrationName", "onEnded"))
      .put("onError", MapBuilder.of("registrationName", "onError"))
      .put("onVideoStateChange", MapBuilder.of("registrationName", "onVideoStateChange"))
      .build()
      .toMutableMap()
  }

  override fun getCommandsMap(): MutableMap<String, Int> {
    return MapBuilder.of(
      "play", COMMAND_PLAY,
      "pause", COMMAND_PAUSE,
      "stop", COMMAND_STOP,
      "seekToSeconds", COMMAND_SEEK_SECONDS,
    )
  }

  override fun receiveCommand(root: MpvView, commandId: String?, args: com.facebook.react.bridge.ReadableArray?) {
    when (commandId) {
      "play" -> root.setPaused(false)
      "pause" -> root.setPaused(true)
      "stop" -> root.stopPlayback()
      "seekToSeconds" -> {
        val seconds = args?.getDouble(0) ?: return
        root.seekToSeconds(seconds)
      }
    }
  }

  override fun receiveCommand(root: MpvView, commandId: Int, args: com.facebook.react.bridge.ReadableArray?) {
    when (commandId) {
      COMMAND_PLAY -> root.setPaused(false)
      COMMAND_PAUSE -> root.setPaused(true)
      COMMAND_STOP -> root.stopPlayback()
      COMMAND_SEEK_SECONDS -> {
        val seconds = args?.getDouble(0) ?: return
        root.seekToSeconds(seconds)
      }
    }
  }

  @ReactProp(name = "source")
  fun setSource(view: MpvView, source: ReadableMap?) {
    view.setSource(source)
  }

  @ReactProp(name = "paused", defaultBoolean = true)
  fun setPaused(view: MpvView, paused: Boolean) {
    view.setPaused(paused)
  }

  @ReactProp(name = "rate", defaultFloat = 1f)
  fun setRate(view: MpvView, rate: Float) {
    view.setRate(rate.toDouble())
  }

  @ReactProp(name = "volume", defaultFloat = 1f)
  fun setVolume(view: MpvView, volume: Float) {
    view.setVolume(volume.toDouble())
  }

  @ReactProp(name = "muted", defaultBoolean = false)
  fun setMuted(view: MpvView, muted: Boolean) {
    view.setMuted(muted)
  }

  @ReactProp(name = "seek")
  fun setSeek(view: MpvView, seek: Double) {
    view.setSeekFraction(seek)
  }

  @ReactProp(name = "resizeMode")
  fun setResizeMode(view: MpvView, resizeMode: String?) {
    view.setResizeMode(resizeMode ?: "contain")
  }

  override fun onDropViewInstance(view: MpvView) {
    super.onDropViewInstance(view)
    view.teardown()
  }

  companion object {
    private const val COMMAND_PLAY = 1
    private const val COMMAND_PAUSE = 2
    private const val COMMAND_STOP = 3
    private const val COMMAND_SEEK_SECONDS = 4
  }
}
