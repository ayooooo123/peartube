package to.holepunch.modules.mediasession

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Expo Package that registers the MediaSession lifecycle listener.
 * This allows the module to receive onUserLeaveHint callbacks for PiP entry.
 */
class MediaSessionPackage : Package {
    override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> {
        return listOf(MediaSessionReactActivityLifecycleListener())
    }
}
