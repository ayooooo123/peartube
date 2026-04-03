package to.holepunch.modules.mediasession

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Expo Package for MediaSession module.
 *
 * Note: Android PiP callbacks are handled directly in MainActivity, so no
 * lifecycle listener wiring is needed here.
 */
class MediaSessionPackage : Package {
    override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> {
        return emptyList()
    }
}
