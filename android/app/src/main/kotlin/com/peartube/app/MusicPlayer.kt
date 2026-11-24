package com.peartube.app

import android.util.AtomicFile
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import kotlin.random.Random

enum class RepeatMode {
    Off,
    All,
    One,
    ;

    fun next(): RepeatMode = when (this) {
        Off -> All
        All -> One
        One -> Off
    }

    companion object {
        fun parse(raw: String?): RepeatMode = when (raw?.lowercase()) {
            "all" -> All
            "one" -> One
            else -> Off
        }
    }
}

data class TrackItem(
    val entry: Entry,
    val title: String,
    val artist: String,
    val album: String,
    val albumKey: String,
    val hue: Int,
    val seed: Long,
    val trackNo: String = "",
    val disc: Int? = null,
    val track: Int? = null,
) {
    val key: String get() = entry.key
    val monogramText: String get() = monogram(album.ifBlank { title })

    fun toJson(): JSONObject = JSONObject()
        .put("entryKey", entry.key)
        .put("entryId", entry.id)
        .put("entryTitle", entry.title)
        .put("entrySize", entry.size)
        .put("entrySha256", entry.sha256)
        .put("entryLocal", entry.local)
        .put("entryCachedBytes", entry.cachedBytes)
        .put("entryStreamUrl", entry.streamUrl)
        .put("entryMagnetUrl", entry.magnetUrl)
        .put("entrySource", entry.source)
        .put("entrySourceKind", entry.sourceKind)
        .put("title", title)
        .put("artist", artist)
        .put("album", album)
        .put("albumKey", albumKey)
        .put("hue", hue)
        .put("seed", seed)
        .put("trackNo", trackNo)
        .apply {
            disc?.let { put("disc", it) }
            track?.let { put("track", it) }
        }

    companion object {
        fun fromJson(json: JSONObject): TrackItem {
            val title = json.optString("title")
            val artist = json.optString("artist")
            val disc = if (json.isNull("disc")) null else json.optInt("disc")
            val track = if (json.isNull("track")) null else json.optInt("track")
            val entry = Entry(
                key = json.getString("entryKey"),
                id = json.optString("entryId"),
                title = json.optString("entryTitle", title),
                size = json.optLong("entrySize"),
                sha256 = json.optString("entrySha256"),
                local = json.optBoolean("entryLocal"),
                cachedBytes = json.optLong("entryCachedBytes"),
                streamUrl = json.optString("entryStreamUrl"),
                magnetUrl = json.optString("entryMagnetUrl"),
                source = json.optString("entrySource"),
                sourceKind = json.optString("entrySourceKind"),
                season = disc,
                episode = track,
                music = MusicMeta(title = title.ifEmpty { null }, artist = artist.ifEmpty { null }),
            )
            return TrackItem(
                entry = entry,
                title = title,
                artist = artist,
                album = json.optString("album"),
                albumKey = json.optString("albumKey"),
                hue = json.optInt("hue"),
                seed = json.optLong("seed"),
                trackNo = json.optString("trackNo"),
                disc = disc,
                track = track,
            )
        }
    }
}

data class MusicState(
    val queue: List<TrackItem> = emptyList(),
    val order: List<Int> = emptyList(),
    val index: Int = -1,
    val sourceLabel: String = "",
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.Off,
    val pausedForVideo: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long? = null,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val error: String? = null,
    val updatedAt: Long = 0L,
) {
    val hasQueue: Boolean get() = order.isNotEmpty() && index in order.indices
    val currentTrack: TrackItem? get() = if (hasQueue) queue.getOrNull(order[index]) else null
    val orderedTracks: List<TrackItem> get() = order.mapNotNull { queue.getOrNull(it) }
    val upNextCount: Int get() = if (hasQueue) (order.size - index - 1).coerceAtLeast(0) else 0
    val positionText: String get() = if (hasQueue) "${index + 1} of ${order.size}" else "0 of 0"
}

data class QueueStep(
    val state: MusicState,
    val openTrack: TrackItem? = null,
    val seekToMs: Long? = null,
    val reachedEnd: Boolean = false,
)

/**
 * Pure queue state transitions and JSON serialization (JVM-testable, no Android framework imports).
 */
object MusicQueue {
    fun playList(
        state: MusicState,
        items: List<TrackItem>,
        startIndex: Int,
        sourceLabel: String,
        shuffleOn: Boolean? = null,
        nowMs: Long = System.currentTimeMillis(),
        random: Random = Random.Default,
    ): QueueStep {
        val nextShuffle = shuffleOn ?: state.shuffle
        if (items.isEmpty()) {
            return QueueStep(state.copy(shuffle = nextShuffle))
        }
        val order: List<Int>
        val index: Int
        if (nextShuffle && startIndex < 0) {
            order = items.indices.toList().shuffled(random)
            index = 0
        } else {
            val clamped = startIndex.coerceIn(0, items.lastIndex)
            if (nextShuffle) {
                val head = (0..clamped).toList()
                val tail = ((clamped + 1)..items.lastIndex).toList().shuffled(random)
                order = head + tail
                index = clamped
            } else {
                order = items.indices.toList()
                index = clamped
            }
        }
        val track = items[order[index]]
        val nextState = state.copy(
            queue = items,
            order = order,
            index = index,
            sourceLabel = sourceLabel,
            shuffle = nextShuffle,
            pausedForVideo = false,
            positionMs = 0L,
            durationMs = null,
            playing = true,
            buffering = true,
            error = null,
            updatedAt = nowMs,
        )
        return QueueStep(state = nextState, openTrack = track)
    }

    fun playNext(
        state: MusicState,
        items: List<TrackItem>,
        sourceLabel: String = state.sourceLabel,
        nowMs: Long = System.currentTimeMillis(),
        random: Random = Random.Default,
    ): QueueStep {
        if (items.isEmpty()) return QueueStep(state)
        if (!state.hasQueue) {
            return playList(state, items, 0, sourceLabel.ifBlank { items.first().album }, state.shuffle, nowMs, random)
        }
        val base = state.queue.size
        val nextQueue = state.queue + items
        val addedIndices = (base until base + items.size).toList()
        val insertAt = (state.index + 1).coerceAtMost(state.order.size)
        val nextOrder = state.order.subList(0, insertAt) + addedIndices + state.order.subList(insertAt, state.order.size)
        return QueueStep(state.copy(queue = nextQueue, order = nextOrder, updatedAt = nowMs))
    }

    fun playLast(
        state: MusicState,
        items: List<TrackItem>,
        sourceLabel: String = state.sourceLabel,
        nowMs: Long = System.currentTimeMillis(),
        random: Random = Random.Default,
    ): QueueStep {
        if (items.isEmpty()) return QueueStep(state)
        if (!state.hasQueue) {
            return playList(state, items, 0, sourceLabel.ifBlank { items.first().album }, state.shuffle, nowMs, random)
        }
        val base = state.queue.size
        val nextQueue = state.queue + items
        val addedIndices = (base until base + items.size).toList()
        val nextOrder = state.order + addedIndices
        return QueueStep(state.copy(queue = nextQueue, order = nextOrder, updatedAt = nowMs))
    }

    fun toggleShuffle(
        state: MusicState,
        nowMs: Long = System.currentTimeMillis(),
        random: Random = Random.Default,
    ): MusicState {
        val nextShuffle = !state.shuffle
        if (!state.hasQueue || state.index + 1 >= state.order.size) {
            return state.copy(shuffle = nextShuffle, updatedAt = nowMs)
        }
        val head = state.order.subList(0, state.index + 1)
        val tail = state.order.subList(state.index + 1, state.order.size)
        val nextTail = if (nextShuffle) tail.shuffled(random) else tail.sorted()
        return state.copy(order = head + nextTail, shuffle = nextShuffle, updatedAt = nowMs)
    }

    fun cycleRepeat(state: MusicState, nowMs: Long = System.currentTimeMillis()): MusicState =
        state.copy(repeat = state.repeat.next(), updatedAt = nowMs)

    fun next(
        state: MusicState,
        userTriggered: Boolean,
        nowMs: Long = System.currentTimeMillis(),
    ): QueueStep {
        if (!state.hasQueue) return QueueStep(state)
        if (!userTriggered && state.repeat == RepeatMode.One) {
            return QueueStep(
                state = state.copy(pausedForVideo = false, positionMs = 0L, playing = true, error = null, updatedAt = nowMs),
                openTrack = state.currentTrack,
            )
        }
        val nextIndex = state.index + 1
        if (nextIndex < state.order.size) {
            val track = state.queue[state.order[nextIndex]]
            return QueueStep(
                state = state.copy(
                    index = nextIndex,
                    pausedForVideo = false,
                    positionMs = 0L,
                    durationMs = null,
                    playing = true,
                    buffering = true,
                    error = null,
                    updatedAt = nowMs,
                ),
                openTrack = track,
            )
        }
        if (state.repeat == RepeatMode.All) {
            val track = state.queue[state.order[0]]
            return QueueStep(
                state = state.copy(
                    index = 0,
                    pausedForVideo = false,
                    positionMs = 0L,
                    durationMs = null,
                    playing = true,
                    buffering = true,
                    error = null,
                    updatedAt = nowMs,
                ),
                openTrack = track,
            )
        }
        return QueueStep(
            state = state.copy(playing = false, buffering = false, updatedAt = nowMs),
            reachedEnd = true,
        )
    }

    fun previous(
        state: MusicState,
        nowMs: Long = System.currentTimeMillis(),
    ): QueueStep {
        if (!state.hasQueue) return QueueStep(state)
        if (state.positionMs > 3_000L) {
            return QueueStep(
                state = state.copy(positionMs = 0L, pausedForVideo = false, updatedAt = nowMs),
                seekToMs = 0L,
            )
        }
        val prevIndex = when {
            state.index > 0 -> state.index - 1
            state.repeat == RepeatMode.All -> state.order.lastIndex
            else -> return QueueStep(
                state = state.copy(positionMs = 0L, pausedForVideo = false, updatedAt = nowMs),
                seekToMs = 0L,
            )
        }
        val track = state.queue[state.order[prevIndex]]
        return QueueStep(
            state = state.copy(
                index = prevIndex,
                pausedForVideo = false,
                positionMs = 0L,
                durationMs = null,
                playing = true,
                buffering = true,
                error = null,
                updatedAt = nowMs,
            ),
            openTrack = track,
        )
    }

    fun jumpTo(
        state: MusicState,
        orderIndex: Int,
        nowMs: Long = System.currentTimeMillis(),
    ): QueueStep {
        if (orderIndex !in state.order.indices) return QueueStep(state)
        val track = state.queue[state.order[orderIndex]]
        return QueueStep(
            state = state.copy(
                index = orderIndex,
                pausedForVideo = false,
                positionMs = 0L,
                durationMs = null,
                playing = true,
                buffering = true,
                error = null,
                updatedAt = nowMs,
            ),
            openTrack = track,
        )
    }

    fun removeFromQueue(
        state: MusicState,
        orderIndex: Int,
        nowMs: Long = System.currentTimeMillis(),
    ): QueueStep {
        if (orderIndex !in state.order.indices) return QueueStep(state)
        if (state.order.size <= 1) {
            return QueueStep(
                state = state.copy(
                    queue = emptyList(),
                    order = emptyList(),
                    index = -1,
                    sourceLabel = "",
                    pausedForVideo = false,
                    positionMs = 0L,
                    durationMs = null,
                    playing = false,
                    buffering = false,
                    error = null,
                    updatedAt = nowMs,
                ),
                reachedEnd = true,
            )
        }
        val nextOrder = state.order.toMutableList().apply { removeAt(orderIndex) }
        return when {
            orderIndex < state.index -> QueueStep(
                state = state.copy(order = nextOrder, index = state.index - 1, updatedAt = nowMs),
            )
            orderIndex > state.index -> QueueStep(
                state = state.copy(order = nextOrder, updatedAt = nowMs),
            )
            else -> {
                val nextIdx = orderIndex.coerceAtMost(nextOrder.lastIndex)
                val nextTrack = state.queue[nextOrder[nextIdx]]
                QueueStep(
                    state = state.copy(
                        order = nextOrder,
                        index = nextIdx,
                        positionMs = 0L,
                        durationMs = null,
                        buffering = state.playing,
                        error = null,
                        updatedAt = nowMs,
                    ),
                    openTrack = if (state.playing) nextTrack else null,
                )
            }
        }
    }

    fun clearUpNext(state: MusicState, nowMs: Long = System.currentTimeMillis()): MusicState {
        if (!state.hasQueue) return state
        return state.copy(order = state.order.take(state.index + 1), updatedAt = nowMs)
    }

    fun pauseForVideo(state: MusicState, nowMs: Long = System.currentTimeMillis()): MusicState {
        if (!state.hasQueue) return state
        return state.copy(
            playing = false,
            buffering = false,
            pausedForVideo = true,
            updatedAt = nowMs,
        )
    }

    fun stop(state: MusicState, nowMs: Long = System.currentTimeMillis()): MusicState =
        state.copy(
            queue = emptyList(),
            order = emptyList(),
            index = -1,
            sourceLabel = "",
            pausedForVideo = false,
            positionMs = 0L,
            durationMs = null,
            playing = false,
            buffering = false,
            error = null,
            updatedAt = nowMs,
        )

    fun toJson(state: MusicState): JSONObject = JSONObject()
        .put("shuffle", state.shuffle)
        .put("repeat", state.repeat.name.lowercase())
        .put("index", state.index)
        .put("sourceLabel", state.sourceLabel)
        .put("positionMs", state.positionMs)
        .put("durationMs", state.durationMs ?: JSONObject.NULL)
        .put("pausedForVideo", state.pausedForVideo)
        .put("updatedAt", state.updatedAt)
        .put("order", JSONArray(state.order))
        .put("queue", JSONArray().apply { state.queue.forEach { put(it.toJson()) } })

    fun fromJson(json: JSONObject): MusicState {
        val queueArr = json.optJSONArray("queue")
        val queue = if (queueArr == null) emptyList() else List(queueArr.length()) {
            TrackItem.fromJson(queueArr.getJSONObject(it))
        }
        val orderArr = json.optJSONArray("order")
        val order = if (orderArr == null) {
            queue.indices.toList()
        } else {
            List(orderArr.length()) { orderArr.getInt(it) }.filter { it in queue.indices }
        }
        val rawIndex = json.optInt("index", -1)
        val index = if (order.isEmpty()) -1 else rawIndex.coerceIn(0, order.lastIndex)
        return MusicState(
            queue = queue,
            order = order,
            index = index,
            sourceLabel = json.optString("sourceLabel"),
            shuffle = json.optBoolean("shuffle", false),
            repeat = RepeatMode.parse(json.optString("repeat")),
            pausedForVideo = json.optBoolean("pausedForVideo", false),
            positionMs = json.optLong("positionMs", 0L).coerceAtLeast(0L),
            durationMs = if (json.isNull("durationMs")) null else json.optLong("durationMs").takeIf { it > 0L },
            playing = false,
            buffering = false,
            error = null,
            updatedAt = json.optLong("updatedAt", 0L),
        )
    }
}

/**
 * Manages AAudio-only playback via NativePlayer.openWithOptions (no video Surface needed),
 * 250 ms polling, auto-advance, and AtomicFile persistence in dataDir/music-state.json.
 */
class MusicPlayerController(
    private val scope: CoroutineScope,
    private val dataDir: File,
    private val resolveStreamUrl: suspend (Entry) -> Entry,
    private val onStartingMusic: () -> Unit,
    private val onPlaybackActiveChanged: (Boolean) -> Unit,
) {
    private val stateFile = AtomicFile(File(dataDir, "music-state.json"))
    private val _state = MutableStateFlow(loadPersisted())
    val state: StateFlow<MusicState> = _state.asStateFlow()

    private var handle: Long = 0L
    private var openedKey: String? = null
    private var openJob: Job? = null
    private var pollJob: Job? = null
    private var pendingSeekMs: Long? = null
    private var persistCounter = 0

    private fun loadPersisted(): MusicState = runCatching {
        val text = stateFile.openRead().bufferedReader().use { it.readText() }
        MusicQueue.fromJson(JSONObject(text))
    }.getOrDefault(MusicState())

    private fun persist(snapshot: MusicState) {
        scope.launch(Dispatchers.IO) {
            var stream: FileOutputStream? = null
            try {
                dataDir.mkdirs()
                stream = stateFile.startWrite()
                stream.write(MusicQueue.toJson(snapshot).toString().toByteArray(Charsets.UTF_8))
                stateFile.finishWrite(stream)
            } catch (_: Exception) {
                stream?.let(stateFile::failWrite)
            }
        }
    }

    fun playTrackList(
        items: List<TrackItem>,
        startIndex: Int = 0,
        sourceLabel: String = "",
        shuffleOn: Boolean? = null,
    ) {
        if (items.isEmpty()) return
        onStartingMusic()
        val step = MusicQueue.playList(_state.value, items, startIndex, sourceLabel, shuffleOn)
        _state.value = step.state
        persist(step.state)
        step.openTrack?.let { openAndPlay(it, seekMs = 0L) }
    }

    fun playNext(items: List<TrackItem>, sourceLabel: String = "") {
        if (items.isEmpty()) return
        val wasEmpty = !_state.value.hasQueue
        if (wasEmpty) onStartingMusic()
        val step = MusicQueue.playNext(_state.value, items, sourceLabel)
        _state.value = step.state
        persist(step.state)
        step.openTrack?.let { openAndPlay(it, seekMs = 0L) }
    }

    fun playLast(items: List<TrackItem>, sourceLabel: String = "") {
        if (items.isEmpty()) return
        val wasEmpty = !_state.value.hasQueue
        if (wasEmpty) onStartingMusic()
        val step = MusicQueue.playLast(_state.value, items, sourceLabel)
        _state.value = step.state
        persist(step.state)
        step.openTrack?.let { openAndPlay(it, seekMs = 0L) }
    }

    fun togglePlayPause() {
        val cur = _state.value
        val track = cur.currentTrack ?: return
        if (cur.playing) {
            val h = handle
            if (h != 0L) runCatching { NativePlayer.pause(h) }
            val paused = cur.copy(playing = false, buffering = false, updatedAt = System.currentTimeMillis())
            _state.value = paused
            persist(paused)
            onPlaybackActiveChanged(false)
        } else {
            onStartingMusic()
            val resumed = cur.copy(pausedForVideo = false, playing = true, error = null, updatedAt = System.currentTimeMillis())
            _state.value = resumed
            persist(resumed)
            val h = handle
            if (h != 0L && openedKey == track.key) {
                runCatching { NativePlayer.play(h) }
                onPlaybackActiveChanged(true)
                ensurePolling(h)
            } else {
                openAndPlay(track, seekMs = cur.positionMs)
            }
        }
    }

    fun next() {
        val step = MusicQueue.next(_state.value, userTriggered = true)
        _state.value = step.state
        persist(step.state)
        if (step.openTrack != null) {
            onStartingMusic()
            openAndPlay(step.openTrack, seekMs = 0L)
        } else if (step.reachedEnd) {
            closeHandle()
            onPlaybackActiveChanged(false)
        }
    }

    fun previous() {
        val step = MusicQueue.previous(_state.value)
        _state.value = step.state
        persist(step.state)
        when {
            step.openTrack != null -> {
                onStartingMusic()
                openAndPlay(step.openTrack, seekMs = 0L)
            }
            step.seekToMs != null -> seekTo(step.seekToMs)
        }
    }

    fun jumpTo(orderIndex: Int) {
        val step = MusicQueue.jumpTo(_state.value, orderIndex)
        _state.value = step.state
        persist(step.state)
        step.openTrack?.let {
            onStartingMusic()
            openAndPlay(it, seekMs = 0L)
        }
    }

    fun seekTo(ms: Long) {
        val cur = _state.value
        val dur = cur.durationMs
        val target = if (dur != null && dur > 0L) ms.coerceIn(0L, dur) else ms.coerceAtLeast(0L)
        _state.value = cur.copy(positionMs = target, updatedAt = System.currentTimeMillis())
        val h = handle
        if (h != 0L) {
            runCatching { NativePlayer.seek(h, target) }
        } else {
            pendingSeekMs = target
        }
    }

    fun toggleShuffle() {
        val next = MusicQueue.toggleShuffle(_state.value)
        _state.value = next
        persist(next)
    }

    fun cycleRepeat() {
        val next = MusicQueue.cycleRepeat(_state.value)
        _state.value = next
        persist(next)
    }

    fun removeFromQueue(orderIndex: Int) {
        val step = MusicQueue.removeFromQueue(_state.value, orderIndex)
        _state.value = step.state
        persist(step.state)
        when {
            step.reachedEnd -> {
                closeHandle()
                onPlaybackActiveChanged(false)
            }
            step.openTrack != null -> openAndPlay(step.openTrack, seekMs = 0L)
        }
    }

    fun clearUpNext() {
        val next = MusicQueue.clearUpNext(_state.value)
        _state.value = next
        persist(next)
    }

    /** Rule 3: Music waits for a video. Pauses audio, retains track, position, and queue. */
    fun pauseForVideo() {
        val cur = _state.value
        if (!cur.hasQueue) return
        val wasActive = cur.playing || handle != 0L || openJob?.isActive == true
        if (!wasActive && cur.pausedForVideo) return
        openJob?.cancel()
        openJob = null
        val h = handle
        if (h != 0L) {
            runCatching { NativePlayer.pause(h) }
        }
        pollJob?.cancel()
        pollJob = null
        // Close the native handle so the video player owns audio cleanly, while keeping track & position.
        closeHandle()
        val waiting = MusicQueue.pauseForVideo(cur)
        _state.value = waiting
        persist(waiting)
        onPlaybackActiveChanged(false)
    }

    fun stopMusic() {
        openJob?.cancel()
        openJob = null
        closeHandle()
        val stopped = MusicQueue.stop(_state.value)
        _state.value = stopped
        persist(stopped)
        onPlaybackActiveChanged(false)
    }

    /** Updates entry metadata/streamUrls when fresh catalog entries arrive from the worker. */
    fun refreshEntries(entries: List<Entry>) {
        val cur = _state.value
        if (cur.queue.isEmpty() || entries.isEmpty()) return
        val byKey = entries.associateBy { it.key }
        var changed = false
        val updated = cur.queue.map { item ->
            val fresh = byKey[item.key]
            if (fresh != null && fresh.streamUrl != item.entry.streamUrl) {
                changed = true
                item.copy(entry = fresh)
            } else {
                item
            }
        }
        if (changed) {
            _state.value = cur.copy(queue = updated)
        }
    }

    private fun openAndPlay(track: TrackItem, seekMs: Long) {
        openJob?.cancel()
        pollJob?.cancel()
        closeHandle()
        pendingSeekMs = seekMs.takeIf { it > 0L }
        onPlaybackActiveChanged(true)
        openJob = scope.launch {
            val resolved = runCatching { resolveStreamUrl(track.entry) }.getOrDefault(track.entry)
            if (resolved.streamUrl.isBlank()) {
                _state.value = _state.value.copy(
                    playing = false,
                    buffering = false,
                    error = "Track stream is not available yet.",
                )
                onPlaybackActiveChanged(false)
                return@launch
            }
            val soundfont = SoundFont.file(dataDir).takeIf { it.isFile }?.path
            var failure: String? = null
            val opened = withContext(Dispatchers.IO) {
                try {
                    NativePlayer.openWithOptions(resolved.streamUrl, soundfont, "auto", "off", false)
                } catch (e: Throwable) {
                    failure = "The player did not start: ${e.message ?: e}"
                    0L
                }
            }
            withContext(Dispatchers.Main.immediate + NonCancellable) {
                val stillCurrent = _state.value.currentTrack?.key == track.key && _state.value.playing
                if (!stillCurrent) {
                    if (opened != 0L) runCatching { NativePlayer.close(opened) }
                    return@withContext
                }
                if (opened == 0L) {
                    _state.value = _state.value.copy(
                        playing = false,
                        buffering = false,
                        error = failure ?: "The player did not start.",
                    )
                    onPlaybackActiveChanged(false)
                    return@withContext
                }
                handle = opened
                openedKey = track.key
                ensurePolling(opened)
            }
        }
    }

    private fun ensurePolling(h: Long) {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (handle == h && h != 0L) {
                val ps = runCatching { PlayerState.parse(NativePlayer.state(h)) }.getOrNull()
                if (ps != null) {
                    val seek = pendingSeekMs
                    if (seek != null && ps.durationMs != null && ps.durationMs > 0L) {
                        pendingSeekMs = null
                        runCatching { NativePlayer.seek(h, seek.coerceAtMost(ps.durationMs)) }
                    }
                    val cur = _state.value
                    val updated = cur.copy(
                        positionMs = ps.positionMs,
                        durationMs = ps.durationMs ?: cur.durationMs,
                        playing = ps.playing && !ps.ended,
                        buffering = ps.buffering && ps.error == null,
                        error = ps.error,
                    )
                    _state.value = updated
                    if (++persistCounter % 20 == 0) persist(updated)
                    if (ps.ended) {
                        val step = MusicQueue.next(updated, userTriggered = false)
                        _state.value = step.state
                        persist(step.state)
                        if (step.openTrack != null) {
                            openAndPlay(step.openTrack, seekMs = 0L)
                        } else {
                            closeHandle()
                            onPlaybackActiveChanged(false)
                        }
                        break
                    }
                    if (!ps.playing && !ps.buffering) {
                        // Stay attached while paused so togglePlayPause is instant, just poll slower.
                        delay(500)
                        continue
                    }
                }
                delay(250)
            }
        }
    }

    private fun closeHandle() {
        pollJob?.cancel()
        pollJob = null
        val h = handle
        handle = 0L
        openedKey = null
        if (h != 0L) {
            runCatching { NativePlayer.close(h) }
        }
    }
}
