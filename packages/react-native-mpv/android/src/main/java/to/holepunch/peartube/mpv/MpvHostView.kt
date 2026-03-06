package to.holepunch.peartube.mpv

import android.content.Context
import android.widget.FrameLayout

class MpvHostView(context: Context) : FrameLayout(context) {
  private val playerView = MpvView(context)

  init {
    playerView.layoutParams = LayoutParams(
      LayoutParams.MATCH_PARENT,
      LayoutParams.MATCH_PARENT,
    )
    addView(playerView)
  }

  fun setSourceUri(uri: String) {
    playerView.setSourceUri(uri)
  }

  fun setPaused(paused: Boolean) {
    playerView.setPaused(paused)
  }

  fun seekToSeconds(seconds: Double) {
    playerView.seekToSeconds(seconds)
  }

  fun stopPlayback() {
    playerView.stopPlayback()
  }

  fun release() {
    playerView.teardown()
  }
}
