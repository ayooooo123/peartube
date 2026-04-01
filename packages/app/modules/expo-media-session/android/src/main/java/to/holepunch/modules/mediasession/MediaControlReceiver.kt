package to.holepunch.modules.mediasession

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class MediaControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        when (intent?.action) {
            MediaSessionModule.ACTION_PIP_PLAY -> PipBridge.onPipPlayAction()
            MediaSessionModule.ACTION_PIP_PAUSE -> PipBridge.onPipPauseAction()
            MediaSessionModule.ACTION_PIP_BACKGROUND_AUDIO -> PipBridge.onPipBackgroundAudioAction()
        }
    }
}
