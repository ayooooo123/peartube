// dx's MainActivity plus a libVLC player. The webview plays no AVI, and plays
// MKVs silent: it decodes none of the AC-3, E-AC-3, TrueHD and DTS audio most
// of them carry. libVLC plays both. Its view sits over a slot in the page, in
// this activity rather than one of its own: the worklet serving the stream
// suspends whenever this activity pauses.
package dev.dioxus.main

import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

typealias BuildConfig = com.peartube.app.BuildConfig

class MainActivity : WryActivity() {
    private var webView: WebView? = null
    private var vlc: LibVLC? = null
    private var player: Player? = null

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
    }

    /** From Rust, on any thread: plays url in a view that setPlayerFrame places. */
    fun play(url: String) = runOnUiThread {
        player?.release()
        val lib = vlc ?: LibVLC(this, arrayListOf("--network-caching=3000")).also { vlc = it }
        player = Player(this, lib, url)
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

    /** From Rust, on any thread: takes the player down. */
    fun closePlayer() = runOnUiThread {
        player?.release()
        player = null
    }

    /** The page's own back: Rust closes the player when it leaves the play screen. */
    fun back() {
        webView?.evaluateJavascript("history.back()", null)
    }

    override fun onPause() {
        super.onPause()
        player?.pause()
    }

    override fun onStart() {
        super.onStart()
        player?.showVideo()
    }

    override fun onStop() {
        super.onStop()
        player?.hideVideo()
    }

    override fun onDestroy() {
        player?.release()
        player = null
        vlc?.release()
        vlc = null
        super.onDestroy()
    }
}

private class Player(private val activity: MainActivity, vlc: LibVLC, url: String) {
    private val player = MediaPlayer(vlc)
    private val handler = Handler(Looper.getMainLooper())
    private val hideControls = Runnable { controls.visibility = View.GONE }
    private val toggle = ImageButton(activity)
    private val seek = SeekBar(activity)
    private val time = TextView(activity)
    private val message = TextView(activity)
    private val controls = LinearLayout(activity)
    private val root = FrameLayout(activity)
    private val video = VLCVideoLayout(activity)
    private var seeking = false

    init {
        toggle.setBackgroundColor(Color.TRANSPARENT)
        toggle.setImageResource(android.R.drawable.ic_media_pause)
        toggle.setOnClickListener { if (player.isPlaying) player.pause() else player.play(); showControls() }
        time.setTextColor(Color.WHITE)
        time.setPadding(dp(8), 0, dp(8), 0)
        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) = showTime(progress)
            override fun onStartTrackingTouch(bar: SeekBar) { seeking = true; handler.removeCallbacks(hideControls) }
            override fun onStopTrackingTouch(bar: SeekBar) {
                seeking = false
                player.time = bar.progress * 1000L
                showControls()
            }
        })
        controls.gravity = Gravity.CENTER_VERTICAL
        controls.setBackgroundColor(0x99000000.toInt())
        controls.setPadding(dp(4), 0, dp(4), 0)
        controls.addView(toggle)
        controls.addView(seek, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        controls.addView(time)
        message.setTextColor(Color.WHITE)
        message.gravity = Gravity.CENTER
        message.visibility = View.GONE
        root.setBackgroundColor(Color.BLACK)
        root.addView(video)
        root.addView(message, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(controls, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        // Clickable, so taps stop here instead of reaching the page below.
        root.setOnClickListener { if (controls.visibility == View.VISIBLE) hideControls.run() else showControls() }
        root.keepScreenOn = true
        // Hidden until the page reports where its slot is.
        root.visibility = View.INVISIBLE
        activity.addContentView(root, FrameLayout.LayoutParams(0, 0))

        player.attachViews(video, null, false, false)
        player.setEventListener { event ->
            when (event.type) {
                MediaPlayer.Event.LengthChanged -> seek.max = (event.lengthChanged / 1000).toInt()
                MediaPlayer.Event.TimeChanged -> if (!seeking) seek.progress = (event.timeChanged / 1000).toInt()
                MediaPlayer.Event.Playing -> toggle.setImageResource(android.R.drawable.ic_media_pause)
                MediaPlayer.Event.Paused -> toggle.setImageResource(android.R.drawable.ic_media_play)
                MediaPlayer.Event.EndReached -> activity.back()
                MediaPlayer.Event.EncounteredError -> {
                    message.text = "VLC could not play this stream."
                    message.visibility = View.VISIBLE
                }
            }
        }
        val media = Media(vlc, Uri.parse(url))
        media.setHWDecoderEnabled(true, false)
        player.media = media
        media.release()
        player.play()
        showControls()
    }

    fun place(left: Int, top: Int, width: Int, height: Int) {
        root.layoutParams = FrameLayout.LayoutParams(width, height).apply {
            leftMargin = left
            topMargin = top
        }
        root.visibility = View.VISIBLE
    }

    fun pause() = player.pause()

    // The video surface goes away while the activity is stopped, and VLC
    // draws on a new one only once its video track is selected again.
    fun hideVideo() {
        player.setVideoTrackEnabled(false)
        player.detachViews()
    }

    fun showVideo() {
        if (player.vlcVout.areViewsAttached()) return
        player.attachViews(video, null, false, false)
        player.setVideoTrackEnabled(true)
    }

    fun release() {
        handler.removeCallbacks(hideControls)
        player.setEventListener(null)
        player.stop()
        player.detachViews()
        player.release()
        (root.parent as? ViewGroup)?.removeView(root)
    }

    private fun showControls() {
        controls.visibility = View.VISIBLE
        handler.removeCallbacks(hideControls)
        handler.postDelayed(hideControls, 4000)
    }

    private fun showTime(seconds: Int) {
        time.text = "${DateUtils.formatElapsedTime(seconds.toLong())} / ${DateUtils.formatElapsedTime(seek.max.toLong())}"
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
}
