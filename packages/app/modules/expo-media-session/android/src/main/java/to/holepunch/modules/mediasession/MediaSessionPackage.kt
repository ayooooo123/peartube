package to.holepunch.modules.mediasession

import android.content.Context
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Expo Package for MediaSession module.
 *
 * Note: PiP callbacks are now handled directly in MainActivity via the
 * withMainActivityPiPCallback config plugin, so no lifecycle listener is needed.
 */
class MediaSessionPackage : Package {
    override fun createReactActivityLifecycleListeners(activityContext: Context?): List<ReactActivityLifecycleListener> {
        return emptyList()
    }
}
