// dx's MainActivity plus the surfaces the Rust player (peartube-media) draws
// on: video, and subtitles above it. They sit over a slot in the page, in this
// activity rather than one of its own: the worklet serving the stream suspends
// whenever this activity pauses. The controls are in the page.
package dev.dioxus.main

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.content.res.AssetFileDescriptor
import android.graphics.Color
import android.graphics.PixelFormat
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

typealias BuildConfig = com.peartube.app.BuildConfig

class MainActivity : WryActivity() {
    private var webView: WebView? = null
    private var player: PlayerViews? = null
    private val soundFontImport = AtomicReference<SoundFontImport?>()
    private val playerHandler = Handler(Looper.getMainLooper())
    private var wantsPlayer = false
    private var destroying = false
    private val playerFrame = IntArray(4)
    private var hasPlayerFrame = false
    private var closeStarted = 0L
    private var closeReported = false
    private val retirementPoll = Runnable { advancePlayer() }

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

    /** Requests replacement; old views stay attached until native retirement is proved. */
    fun openPlayer() = runOnUiThread {
        if (destroying) return@runOnUiThread
        wantsPlayer = true
        beginPlayerRetirement()
        advancePlayer()
    }

    /** From Rust, on any thread: moves the player over a rect of the page, in CSS pixels. */
    fun setPlayerFrame(left: Float, top: Float, width: Float, height: Float) = runOnUiThread {
        val page = webView ?: return@runOnUiThread
        val content = findViewById<ViewGroup>(android.R.id.content)
        val at = IntArray(2).also { page.getLocationInWindow(it) }
        val origin = IntArray(2).also { content.getLocationInWindow(it) }
        val scale = resources.displayMetrics.density
        playerFrame[0] = at[0] - origin[0] + (left * scale).toInt()
        playerFrame[1] = at[1] - origin[1] + (top * scale).toInt()
        playerFrame[2] = (width * scale).toInt()
        playerFrame[3] = (height * scale).toInt()
        hasPlayerFrame = true
        if (player?.closing == false) player?.place(playerFrame)
    }

    /** Requests close without blocking the UI on native calls or owner joins. */
    fun closePlayer() = runOnUiThread {
        wantsPlayer = false
        beginPlayerRetirement()
        advancePlayer()
    }

    private fun beginPlayerRetirement() {
        val current = player ?: return
        if (!current.closing) {
            closeStarted = SystemClock.uptimeMillis()
            closeReported = false
            current.beginRetirement()
        }
    }

    private fun advancePlayer() {
        playerHandler.removeCallbacks(retirementPoll)
        if (destroying) return
        val current = player
        if (current != null && current.closing) {
            val status = current.retirementStatus()
            if (status != 1) {
                val overdue = SystemClock.uptimeMillis() - closeStarted >= 5_000L
                if (!closeReported && (status == 2 || overdue)) {
                    closeReported = true
                    playerFailure("Player Surface cleanup is ${if (status == 2) "unproved" else "still pending"}; replacement is held.")
                }
                // One coalesced observation, never another native owner.
                playerHandler.postDelayed(retirementPoll, if (closeReported) 1_000L else 50L)
                return
            }
            current.removeRetired()
            player = null
        }
        if (player == null && wantsPlayer) {
            player = PlayerViews(this, playerHandler)
            if (hasPlayerFrame) player?.place(playerFrame)
        }
    }

    fun playerFailure(message: String) {
        Log.e("PearTubePlayer", message)
        if (!destroying) Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    /** From Rust, on any thread: the page's own back, when a video ends. */
    fun back() = runOnUiThread {
        webView?.evaluateJavascript("history.back()", null)
    }

    /** From Rust, on any thread. The destination is an app-private temporary path, never a document name. */
    fun pickSoundFont(id: Long, destination: String, maxBytes: Long) {
        val request = SoundFontImport(id, destination, maxBytes)
        if (!soundFontImport.compareAndSet(null, request)) {
            soundFontResult(id, false, "A SoundFont selection is already in progress")
            return
        }
        runOnUiThread {
            try {
                request.checkActive()
                check(!isDestroyed && !isFinishing) { "Activity is no longer available" }
                require(maxBytes >= 0) { "Invalid SoundFont size limit" }
                // A separate registry key gives this request its own result code,
                // without intercepting any of Wry's file/camera/permission results.
                // Never reuse a saved result from an earlier activity/process.
                val launcher = activityResultRegistry.register(
                    "peartube.soundfont.${UUID.randomUUID()}",
                    ActivityResultContracts.StartActivityForResult(),
                ) { result ->
                    if (soundFontImport.get() !== request) return@register
                    when (result.resultCode) {
                        Activity.RESULT_CANCELED -> finishSoundFont(request, false, null)
                        Activity.RESULT_OK -> {
                            val uri = result.data?.data
                            if (uri == null) {
                                finishSoundFont(request, false, "The document picker returned no document")
                            } else {
                                copySoundFont(request, uri)
                            }
                        }
                        else -> finishSoundFont(request, false, "The document picker failed (${result.resultCode})")
                    }
                }
                request.launcher = launcher
                launcher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    // Providers often label SF2 as application/octet-stream.
                    // The Rust owner validates RIFF/SF2 after the bounded copy.
                    type = "*/*"
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                })
            } catch (error: Exception) {
                finishSoundFont(request, false, "Cannot open SoundFont picker: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    /** Cancels a dropped Rust future, including a launch still queued on the UI thread. */
    fun cancelSoundFont(id: Long) {
        val request = soundFontImport.get()?.takeIf { it.id == id } ?: return
        request.cancel()
        runOnUiThread { finishSoundFont(request, false, "SoundFont selection was cancelled") }
    }

    private fun copySoundFont(request: SoundFontImport, uri: Uri) {
        try {
            Thread({
                val error = try {
                    request.copy(contentResolver, uri)
                    null
                } catch (error: Exception) {
                    "Cannot import SoundFont: ${error.message ?: error.javaClass.simpleName}"
                }
                runOnUiThread { finishSoundFont(request, error == null, error) }
            }, "PearTube SoundFont import").start()
        } catch (error: Exception) {
            finishSoundFont(request, false, "Cannot start SoundFont import: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    // UI thread only. Clear the slot before waking Rust so another request may start.
    private fun finishSoundFont(request: SoundFontImport, selected: Boolean, error: String?) {
        if (!soundFontImport.compareAndSet(request, null)) return
        request.launcher?.unregister()
        request.launcher = null
        soundFontResult(request.id, selected, error)
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
        soundFontImport.get()?.let { request ->
            request.cancel()
            finishSoundFont(request, false, "Activity was destroyed during SoundFont selection")
        }
        destroying = true
        wantsPlayer = false
        playerHandler.removeCallbacks(retirementPoll)
        // Framework destruction cannot wait for a stalled native call. Publish
        // invalidation and report pending cleanup; do not invent a receipt.
        player?.destroyWithActivity()
        player = null
        super.onDestroy()
    }

    // UI callbacks admit sources only. Native import/release runs on bounded owners.
    external fun registerSurface(surface: Surface, role: Int): Long
    external fun surfaceRegistrationError(bindingId: Long): String?
    external fun retireSurface(bindingId: Long, keepReceipt: Boolean): Int
    external fun surfaceRetirementStatus(bindingId: Long): Int

    // Registered by mobile/src/soundfont/android.rs before launching a picker.
    external fun soundFontResult(id: Long, selected: Boolean, error: String?)
}

private class SoundFontImport(val id: Long, private val destination: String, private val maxBytes: Long) {
    // Only MainActivity's UI-thread result handling touches the launcher.
    var launcher: ActivityResultLauncher<Intent>? = null
    private val cancellation = CancellationSignal()
    private var cancelled = false
    private var source: AssetFileDescriptor? = null

    @Synchronized
    fun checkActive() {
        if (cancelled) throw IOException("SoundFont import was cancelled")
    }

    fun cancel() {
        val descriptor = synchronized(this) {
            cancelled = true
            source
        }
        // A provider may be blocked in open/read. Settlement does not wait for
        // it: the lock above prevents any further destination creation or write.
        // Closing/cancelling the provider is best-effort and never runs on UI.
        runCatching {
            Thread({
                runCatching { descriptor?.close() }
                runCatching { cancellation.cancel() }
            }, "PearTube SoundFont cancellation").start()
        }
    }

    fun copy(resolver: ContentResolver, uri: Uri) {
        checkActive()
        val descriptor = resolver.openAssetFileDescriptor(uri, "r", cancellation)
            ?: throw IOException("The document provider could not open the selection")
        descriptor.use {
            synchronized(this) {
                checkActive()
                source = descriptor
            }
            try {
                descriptor.createInputStream().use { input ->
                    val output = synchronized(this) {
                        checkActive()
                        FileOutputStream(destination)
                    }
                    output.use {
                        val buffer = ByteArray(64 * 1024)
                        var copied = 0L
                        while (true) {
                            checkActive()
                            val remaining = maxBytes - copied
                            // At most one byte past the limit, even for unknown
                            // provider lengths, zero limits and Long.MAX_VALUE.
                            val wanted = minOf(remaining, (buffer.size - 1).toLong()).toInt() + 1
                            val count = input.read(buffer, 0, wanted)
                            if (count < 0) break
                            if (count == 0) throw IOException("The document provider returned an empty read")
                            if (count.toLong() > remaining) throw IOException("SoundFont exceeds $maxBytes bytes")
                            synchronized(this) {
                                checkActive()
                                output.write(buffer, 0, count)
                            }
                            copied += count
                        }
                    }
                }
            } finally {
                synchronized(this) { source = null }
            }
        }
    }
}

private class PlayerViews(private val activity: MainActivity, handler: Handler) {
    private val root = FrameLayout(activity)
    private val videoCallback = SurfaceCallback(activity, handler, 1)
    private val subtitleCallback = SurfaceCallback(activity, handler, 2)
    var closing = false
        private set
    init {
        val video = SurfaceView(activity)
        video.holder.addCallback(videoCallback)
        val subtitles = SurfaceView(activity)
        subtitles.setZOrderMediaOverlay(true)
        subtitles.holder.setFormat(PixelFormat.TRANSLUCENT)
        subtitles.holder.addCallback(subtitleCallback)
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

    fun place(rect: IntArray) {
        if (closing) return
        root.layoutParams = FrameLayout.LayoutParams(rect[2], rect[3]).apply {
            leftMargin = rect[0]
            topMargin = rect[1]
        }
        root.visibility = View.VISIBLE
    }

    fun beginRetirement() {
        if (closing) return
        closing = true
        root.keepScreenOn = false
        videoCallback.close()
        subtitleCallback.close()
    }

    fun retirementStatus(): Int {
        val video = videoCallback.retirementStatus()
        val subtitles = subtitleCallback.retirementStatus()
        return if (video == 2 || subtitles == 2) 2 else if (video == 1 && subtitles == 1) 1 else 0
    }

    fun removeRetired() {
        (root.parent as? ViewGroup)?.removeView(root)
    }

    fun destroyWithActivity() {
        closing = true
        videoCallback.close(abandonReceipt = true)
        subtitleCallback.close(abandonReceipt = true)
        (root.parent as? ViewGroup)?.removeView(root)
    }
}

private class SurfaceCallback(
    private val activity: MainActivity,
    private val handler: Handler,
    private val role: Int,
) : SurfaceHolder.Callback {
    private var holder: SurfaceHolder? = null
    private var bindingId = 0L
    private var retiring = false
    private var closed = false
    private var admissionDeadline = 0L
    private var admissionFailed = false
    private var cleanupDeadline = 0L
    private var cleanupReported = false
    private var admissionError = "Player Surface is unavailable"
    private val retry = Runnable { admit() }

    override fun surfaceCreated(holder: SurfaceHolder) {
        if (closed) return
        this.holder = holder
        admissionDeadline = 0L
        admissionFailed = false
        admit()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        if (this.holder !== holder) return
        this.holder = null
        handler.removeCallbacks(retry)
        retire(abandonReceipt = false, forced = true)
    }

    private fun admit() {
        handler.removeCallbacks(retry)
        val source = holder ?: return
        if (closed) return
        if (retiring && retirementStatus() != 1) {
            if (!cleanupReported && SystemClock.uptimeMillis() >= cleanupDeadline) {
                cleanupReported = true
                activity.playerFailure("Previous player Surface has not retired")
            }
            // Cleanup does not spend the replacement's admission budget.
            // Retain one observer even after the deadline has been reported.
            handler.postDelayed(retry, if (cleanupReported) 1_000L else 50L)
            return
        }
        if (bindingId != 0L || admissionFailed) return
        if (admissionDeadline == 0L) {
            admissionDeadline = SystemClock.uptimeMillis() + 5_000L
        }
        if (source.surface.isValid) {
            try {
                val id = activity.registerSurface(source.surface, role)
                if (id > 0) {
                    // Save ownership before querying an error or doing anything
                    // else that can throw. Failed binds still own a receipt.
                    bindingId = id
                    val error = activity.surfaceRegistrationError(id)
                    if (error == null) return
                    admissionError = error
                } else {
                    admissionError = "Player Surface admission returned no registration"
                }
            } catch (error: Exception) {
                admissionError = error.message ?: error.javaClass.simpleName
            }
        }
        if (bindingId != 0L) {
            admissionFailed = true
            activity.playerFailure(admissionError)
            retire(abandonReceipt = false)
            handler.postDelayed(retry, 50L)
        } else if (SystemClock.uptimeMillis() < admissionDeadline) {
            handler.postDelayed(retry, 50L)
        } else {
            admissionFailed = true
            activity.playerFailure(admissionError)
        }
    }

    private fun retire(abandonReceipt: Boolean, forced: Boolean = abandonReceipt) {
        if (bindingId == 0L) return
        if (!retiring) {
            cleanupDeadline = SystemClock.uptimeMillis() + 5_000L
            cleanupReported = false
        }
        admissionDeadline = 0L
        retiring = true
        val status = try {
            activity.retireSurface(bindingId, !abandonReceipt)
        } catch (error: Exception) {
            activity.playerFailure("Cannot retire player Surface: ${error.message}")
            2
        }
        if (status == 1 || abandonReceipt) {
            bindingId = 0L
            retiring = false
        }
        if (forced && status != 1) {
            Log.w("PearTubePlayer", "Framework removed Surface role $role before native cleanup completed (status=$status)")
        }
    }

    fun retirementStatus(): Int {
        if (bindingId == 0L) return 1
        return try {
            val status = activity.surfaceRetirementStatus(bindingId)
            if (status == 1) {
                bindingId = 0L
                retiring = false
            }
            status
        } catch (error: Exception) {
            Log.e("PearTubePlayer", "Cannot observe Surface retirement", error)
            2
        }
    }

    fun close(abandonReceipt: Boolean = false) {
        closed = true
        handler.removeCallbacks(retry)
        holder = null
        retire(abandonReceipt)
    }
}
