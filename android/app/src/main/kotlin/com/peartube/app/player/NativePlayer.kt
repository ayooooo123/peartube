package com.peartube.app.player

import android.view.Surface
import org.json.JSONObject

/** libpeartube.so (android/native): peartube-media's player, MediaCodec and AAudio. */
object NativePlayer {
    init {
        System.loadLibrary("peartube")
    }

    /** Opens [url] and starts playing; [soundfont] is the user's SF2 bank for MIDI. */
    @JvmStatic external fun open(url: String, soundfont: String?): Long
    @JvmStatic external fun close(handle: Long)
    @JvmStatic external fun play(handle: Long)
    @JvmStatic external fun pause(handle: Long)
    @JvmStatic external fun seek(handle: Long, ms: Long)

    /** [stream] < 0: no audio. */
    @JvmStatic external fun selectAudio(handle: Long, stream: Int)

    /** [stream] < 0: subtitles off. */
    @JvmStatic external fun selectSubtitle(handle: Long, stream: Int)
    @JvmStatic external fun suspend(handle: Long)
    @JvmStatic external fun resume(handle: Long)
    @JvmStatic external fun state(handle: Long): String

    /** Admits a surface for [role] (1 video, 2 subtitles); returns its registration id. */
    @JvmStatic external fun registerSurface(surface: Surface, role: Int): Long
    @JvmStatic external fun surfaceRegistrationError(id: Long): String?

    /** 0 pending, 1 retired, 2 failed. */
    @JvmStatic external fun retireSurface(id: Long, keepReceipt: Boolean): Int
    @JvmStatic external fun surfaceRetirementStatus(id: Long): Int
}

data class Track(
    val stream: Int,
    val kind: String,
    val codec: String,
    val language: String?,
    val title: String?,
) {
    /** "Commentary (eng) · aac", "eng · aac" or "Track 2 · aac". */
    val label: String
        get() {
            var name = title ?: language ?: "Track $stream"
            if (title != null && language != null) name = "$name ($language)"
            return "$name · $codec"
        }
}

data class PlayerState(
    val positionMs: Long = 0,
    val durationMs: Long? = null,
    val playing: Boolean = true,
    val buffering: Boolean = true,
    val ended: Boolean = false,
    val error: String? = null,
    val tracks: List<Track> = emptyList(),
    val audio: Int? = null,
    val subtitle: Int? = null,
    val videoWidth: Int? = null,
    val videoHeight: Int? = null,
    val videoFps: Float? = null,
    val videoDecoder: String? = null,
    val droppedFrames: Long = 0,
    /** One pixel's width over its height when not square (anamorphic video). */
    val videoPixelAspect: Pair<Int, Int>? = null,
) {
    /** The picture's width over its height as shown: the coded size stretched by the pixel's shape. */
    val displayAspect: Float?
        get() {
            val w = videoWidth?.takeIf { it > 0 } ?: return null
            val h = videoHeight?.takeIf { it > 0 } ?: return null
            val (across, down) = videoPixelAspect ?: (1 to 1)
            return w.toFloat() * across / (h.toFloat() * down)
        }

    companion object {
        fun parse(text: String): PlayerState {
            val json = JSONObject(text)
            val list = json.getJSONArray("tracks")
            fun JSONObject.optText(name: String) = if (isNull(name)) null else getString(name)
            fun JSONObject.optInteger(name: String) = if (isNull(name)) null else getInt(name)
            return PlayerState(
                positionMs = json.getLong("positionMs"),
                durationMs = if (json.isNull("durationMs")) null else json.getLong("durationMs"),
                playing = json.getBoolean("playing"),
                buffering = json.getBoolean("buffering"),
                ended = json.getBoolean("ended"),
                error = json.optText("error"),
                tracks = List(list.length()) {
                    val t = list.getJSONObject(it)
                    Track(t.getInt("stream"), t.getString("kind"), t.getString("codec"), t.optText("language"), t.optText("title"))
                },
                audio = json.optInteger("audio"),
                subtitle = json.optInteger("subtitle"),
                videoWidth = json.optInteger("videoWidth"),
                videoHeight = json.optInteger("videoHeight"),
                videoFps = if (json.isNull("videoFps")) null else json.optDouble("videoFps").toFloat().takeIf { it > 0f },
                videoDecoder = json.optText("videoDecoder"),
                droppedFrames = json.optLong("droppedFrames", 0L),
                videoPixelAspect = json.optJSONArray("videoPixelAspect")?.let { it.getInt(0) to it.getInt(1) },
            )
        }
    }
}
