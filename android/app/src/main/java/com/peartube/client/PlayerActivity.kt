package com.peartube.client

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

// Plays one stream URL with libVLC. Most archived files are DivX/Xvid AVIs,
// which Android's own MPEG-4 decoder cannot play; VLC's decoders can. The
// relay serves HTTP Range, so seeking works.
class PlayerActivity : Activity() {
    private lateinit var vlc: LibVLC
    private lateinit var player: MediaPlayer
    private lateinit var controls: LinearLayout
    private lateinit var toggle: ImageButton
    private lateinit var seek: SeekBar
    private lateinit var time: TextView
    private var seeking = false
    private val handler = Handler(Looper.getMainLooper())
    private val hideControls = Runnable { controls.visibility = View.GONE }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)!!
        vlc = LibVLC(this, arrayListOf("--network-caching=3000"))
        player = MediaPlayer(vlc)

        val video = VLCVideoLayout(this)
        toggle = ImageButton(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setImageResource(android.R.drawable.ic_media_pause)
            setOnClickListener { if (player.isPlaying) player.pause() else player.play(); showControls() }
        }
        time = TextView(this).apply { setTextColor(Color.WHITE); setPadding(dp(8), 0, dp(16), 0) }
        seek = SeekBar(this).apply {
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) = showTime(progress)
                override fun onStartTrackingTouch(bar: SeekBar) { seeking = true; handler.removeCallbacks(hideControls) }
                override fun onStopTrackingTouch(bar: SeekBar) {
                    seeking = false
                    player.time = bar.progress * 1000L
                    showControls()
                }
            })
        }
        controls = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0x99000000.toInt())
            setPadding(dp(8), dp(8), dp(8), dp(24))
            addView(toggle)
            addView(seek, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(time)
        }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(video)
            addView(controls, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            setOnClickListener { if (controls.visibility == View.VISIBLE) hideControls.run() else showControls() }
            keepScreenOn = true
        })
        hideSystemBars()

        player.attachViews(video, null, false, false)
        player.setEventListener { event ->
            when (event.type) {
                MediaPlayer.Event.LengthChanged -> seek.max = (event.lengthChanged / 1000).toInt()
                MediaPlayer.Event.TimeChanged -> if (!seeking) seek.progress = (event.timeChanged / 1000).toInt()
                MediaPlayer.Event.Playing -> toggle.setImageResource(android.R.drawable.ic_media_pause)
                MediaPlayer.Event.Paused -> toggle.setImageResource(android.R.drawable.ic_media_play)
                MediaPlayer.Event.EndReached -> finish()
                MediaPlayer.Event.EncounteredError -> offerExternal(url)
            }
        }
        val media = Media(vlc, Uri.parse(url))
        media.setHWDecoderEnabled(true, false)
        player.media = media
        media.release()
        player.play()
        showControls()
    }

    private fun showControls() {
        controls.visibility = View.VISIBLE
        handler.removeCallbacks(hideControls)
        handler.postDelayed(hideControls, 4000)
    }

    private fun showTime(seconds: Int) {
        time.text = "${DateUtils.formatElapsedTime(seconds.toLong())} / ${DateUtils.formatElapsedTime(seek.max.toLong())}"
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // the fullscreen theme covers older versions
        window.insetsController?.apply {
            hide(WindowInsets.Type.systemBars())
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun offerExternal(url: String) {
        if (isFinishing) return
        AlertDialog.Builder(this)
            .setTitle("Can't play this here")
            .setPositiveButton("Open in another app") { _, _ ->
                try {
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), "video/*"))
                } catch (_: ActivityNotFoundException) {
                    Toast.makeText(this, "No other video player installed", Toast.LENGTH_LONG).show()
                }
                finish()
            }
            .setNegativeButton("Close") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onStop() {
        super.onStop()
        player.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(hideControls)
        player.setEventListener(null)
        player.stop()
        player.detachViews()
        player.release()
        vlc.release()
    }

    companion object {
        const val EXTRA_URL = "url"
    }
}
