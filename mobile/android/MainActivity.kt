// dx's MainActivity plus the surfaces the Rust player (peartube-media) draws
// on: video, and subtitles above it. They sit over a slot in the page, in this
// activity rather than one of its own: the worklet serving the stream suspends
// whenever this activity pauses. The controls are in the page.
package dev.dioxus.main

import android.graphics.Color
import android.graphics.PixelFormat
import android.net.wifi.WifiManager
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

typealias BuildConfig = com.peartube.app.BuildConfig

class MainActivity : WryActivity() {
    private var webView: WebView? = null
    private var player: PlayerViews? = null

    // Android drops multicast on Wi-Fi unless an app holds this lock, and LAN
    // discovery finds relays over mDNS. Held while the app is in front; the
    // worklet suspends behind it anyway.
    private val multicastLock by lazy {
        applicationContext.getSystemService(WifiManager::class.java)
            .createMulticastLock("PearTube LAN discovery")
            .apply { setReferenceCounted(false) }
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
    }

    /** From Rust, on any thread: adds the player's surfaces, hidden until setPlayerFrame places them. */
    fun openPlayer() = runOnUiThread {
        player?.remove()
        player = PlayerViews(this)
    }

    /** From Rust, on any thread: moves the player over a rect of the page, in CSS pixels. */
    fun setPlayerFrame(left: Float, top: Float, width: Float, height: Float) = runOnUiThread {
        val page = webView ?: return@runOnUiThread
        val content = findViewById<ViewGroup>(android.R.id.content)
        val at = IntArray(2).also { page.getLocationInWindow(it) }
        val origin = IntArray(2).also { content.getLocationInWindow(it) }
        val scale = resources.displayMetrics.density
        player?.place(
            at[0] - origin[0] + (left * scale).toInt(),
            at[1] - origin[1] + (top * scale).toInt(),
            (width * scale).toInt(),
            (height * scale).toInt(),
        )
    }

    /** From Rust, on any thread: takes the surfaces down. */
    fun closePlayer() = runOnUiThread {
        player?.remove()
        player = null
    }

    /** The page's own back: Rust leaves the play screen when a video ends. */
    fun back() {
        webView?.evaluateJavascript("history.back()", null)
    }

    override fun onStart() {
        super.onStart()
        multicastLock.acquire()
    }

    override fun onStop() {
        super.onStop()
        multicastLock.release()
    }

    override fun onDestroy() {
        player?.remove()
        player = null
        super.onDestroy()
    }

    // In Rust (mobile/src/android_player.rs). A surface comes and goes with
    // its view: placed, stopped, started, removed.
    external fun videoSurface(surface: Surface?)
    external fun subtitleSurface(surface: Surface?)
}

private class PlayerViews(activity: MainActivity) {
    private val root = FrameLayout(activity)

    init {
        val video = SurfaceView(activity)
        video.holder.addCallback(SurfaceCallback(activity::videoSurface))
        val subtitles = SurfaceView(activity)
        subtitles.setZOrderMediaOverlay(true)
        subtitles.holder.setFormat(PixelFormat.TRANSLUCENT)
        subtitles.holder.addCallback(SurfaceCallback(activity::subtitleSurface))
        val fill = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        root.setBackgroundColor(Color.BLACK)
        root.addView(video, fill)
        root.addView(subtitles, FrameLayout.LayoutParams(fill))
        root.keepScreenOn = true
        // Invisible views get no surface: none exists until the page reports
        // where its slot is.
        root.visibility = View.INVISIBLE
        activity.addContentView(root, FrameLayout.LayoutParams(0, 0))
    }

    fun place(left: Int, top: Int, width: Int, height: Int) {
        root.layoutParams = FrameLayout.LayoutParams(width, height).apply {
            leftMargin = left
            topMargin = top
        }
        root.visibility = View.VISIBLE
    }

    fun remove() {
        (root.parent as? ViewGroup)?.removeView(root)
    }
}

private class SurfaceCallback(private val send: (Surface?) -> Unit) : SurfaceHolder.Callback {
    override fun surfaceCreated(holder: SurfaceHolder) = send(holder.surface)
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
    override fun surfaceDestroyed(holder: SurfaceHolder) = send(null)
}
