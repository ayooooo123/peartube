package to.holepunch.modules.mediasession

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class MediaControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        val command = intent?.getStringExtra(EXTRA_MEDIA_ACTION) ?: intent?.action
        android.util.Log.d("MediaControlReceiver", "Received MediaControl event: $command")
        when (command) {
            EVENT_PLAY, MediaSessionModule.ACTION_PIP_PLAY -> PipBridge.onPipPlayAction()
            EVENT_PAUSE, MediaSessionModule.ACTION_PIP_PAUSE -> PipBridge.onPipPauseAction()
            EVENT_BACKGROUND, MediaSessionModule.ACTION_PIP_BACKGROUND_AUDIO -> PipBridge.onPipBackgroundAudioAction()
        }
    }

    companion object {
        const val EXTRA_MEDIA_ACTION = "MediaAction"
        const val EVENT_PLAY = "Play"
        const val EVENT_PAUSE = "Pause"
        const val EVENT_BACKGROUND = "Background"
    }
}
