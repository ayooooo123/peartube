package to.holepunch.modules.mediasession

import android.app.Activity
import android.util.Log
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Lifecycle listener that intercepts onUserLeaveHint to trigger PiP entry.
 * This is registered via MediaSessionPackage and called by Expo's ReactActivityDelegateWrapper.
 *
 * This approach is necessary because MainActivity overrides don't work reliably
 * with Expo's managed workflow - the activity delegate wrapper handles lifecycle events.
 */
class MediaSessionReactActivityLifecycleListener : ReactActivityLifecycleListener {

    companion object {
        private const val TAG = "MediaSessionLifecycle"
    }

    override fun onUserLeaveHint(activity: Activity?) {
        if (activity == null) {
            Log.w(TAG, "onUserLeaveHint: activity is null")
            return
        }

        Log.d(TAG, "onUserLeaveHint: triggering PipBridge")
        PipBridge.onUserLeaveHint(activity)
    }
}
