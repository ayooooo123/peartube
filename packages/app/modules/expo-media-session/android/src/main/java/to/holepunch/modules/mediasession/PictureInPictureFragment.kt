package to.holepunch.modules.mediasession

import android.app.Activity
import android.os.Build
import androidx.fragment.app.Fragment

class PictureInPictureFragment : Fragment() {
    private var listener: PictureInPictureListener? = null
    private var lastPipState: Boolean? = null
    private var lastChangeTime: Long = 0L

    fun setListener(listener: PictureInPictureListener) {
        this.listener = listener
    }

    @Deprecated("Deprecated in Java")
    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode)
        
        val now = System.currentTimeMillis()
        if (isInPictureInPictureMode == lastPipState && now - lastChangeTime < DEBOUNCE_MS) {
            android.util.Log.d(TAG, "Debouncing duplicate PiP event: $isInPictureInPictureMode")
            return
        }
        
        lastPipState = isInPictureInPictureMode
        lastChangeTime = now
        
        android.util.Log.d(TAG, "onPictureInPictureModeChanged: $isInPictureInPictureMode")
        listener?.onPictureInPictureModeChange(getActivity(), isInPictureInPictureMode)
    }

    companion object {
        const val TAG = "PictureInPictureFragment"
        const val DEBOUNCE_MS = 100L
    }
}

interface PictureInPictureListener {
    fun onPictureInPictureModeChange(activity: Activity?, isInPictureInPictureMode: Boolean)
}
