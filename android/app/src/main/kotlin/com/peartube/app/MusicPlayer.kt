package com.peartube.app

import android.content.Context
import android.util.AtomicFile
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerState
import kotlinx.coroutines.CancellationException
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
    val artUrl: String = "",
    val albumBrowseId: String = "",
    val externalStreamSource: String? = null,
    val externalSaveUrl: String? = null,
    val externalSaveKind: String? = null,
    val streamUserAgent: String = "",
    val externalVideoId: String = "",
) {
    val key: String get() = entry.key
    val monogramText: String get() = monogram(album.ifBlank { title })
    val isExternalStream: Boolean get() = !externalStreamSource.isNullOrBlank()

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
            if (artUrl.isNotBlank()) put("artUrl", artUrl)
            if (albumBrowseId.isNotBlank()) put("albumBrowseId", albumBrowseId)
            externalStreamSource?.takeIf { it.isNotBlank() }?.let { put("externalStreamSource", it) }
            externalSaveUrl?.takeIf { it.isNotBlank() }?.let { put("externalSaveUrl", it) }
            externalSaveKind?.takeIf { it.isNotBlank() }?.let { put("externalSaveKind", it) }
            if (streamUserAgent.isNotBlank()) put("streamUserAgent", streamUserAgent)
            if (externalVideoId.isNotBlank()) put("externalVideoId", externalVideoId)
        }

    companion object {
        fun fromJson(json: JSONObject): TrackItem {
            val title = json.optString("title")
            val artist = json.optString("artist")
            val disc = if (json.isNull("disc")) null else json.optInt("disc")
            val track = if (json.isNull("track")) null else json.optInt("track")
            val artUrl = json.optString("artUrl")
            val albumBrowseId = json.optString("albumBrowseId")
            val externalStreamSource = if (json.isNull("externalStreamSource")) {
                null
            } else {
                json.optString("externalStreamSource").takeIf { it.isNotBlank() }
            }
            val externalSaveUrl = if (json.isNull("externalSaveUrl")) {
                null
            } else {
                json.optString("externalSaveUrl").takeIf { it.isNotBlank() }
            }
            val externalSaveKind = if (json.isNull("externalSaveKind")) {
                null
            } else {
                json.optString("externalSaveKind").takeIf { it.isNotBlank() }
            }
            val streamUserAgent = json.optString("streamUserAgent")
            val externalVideoId = json.optString("externalVideoId")
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
                artUrl = artUrl,
                albumBrowseId = albumBrowseId,
                externalStreamSource = externalStreamSource,
                externalSaveUrl = externalSaveUrl,
                externalSaveKind = externalSaveKind,
                streamUserAgent = streamUserAgent,
                externalVideoId = externalVideoId,
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
    val autoplay: Boolean = true,
    val autoplayLoading: Boolean = false,
    val pausedForVideo: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long? = null,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val error: String? = null,
    val audioCodec: String? = null,
    val audioOutput: String? = null,
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
            audioCodec = null,
            audioOutput = null,
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

    fun toggleAutoplay(state: MusicState, nowMs: Long = System.currentTimeMillis()): MusicState =
        state.copy(autoplay = !state.autoplay, updatedAt = nowMs)

    fun appendAutoplay(
        state: MusicState,
        candidates: List<TrackItem>,
        nowMs: Long = System.currentTimeMillis(),
    ): MusicState {
        if (!state.hasQueue || candidates.isEmpty()) return state
        val seenKeys = HashSet<String>(state.queue.size * 2)
        val seenVideoIds = HashSet<String>(state.queue.size)
        val seenSignatures = HashSet<String>(state.queue.size)
        for (existing in state.queue) {
            seenKeys.add(existing.key)
            if (existing.externalVideoId.isNotBlank()) seenVideoIds.add(existing.externalVideoId)
            val sig = "${fold(existing.artist)}|${fold(existing.title)}"
            if (sig != "|") seenSignatures.add(sig)
        }
        val fresh = ArrayList<TrackItem>()
        for (cand in candidates) {
            if (cand.key in seenKeys) continue
            if (cand.externalVideoId.isNotBlank() && cand.externalVideoId in seenVideoIds) continue
            val sig = "${fold(cand.artist)}|${fold(cand.title)}"
            if (sig != "|" && sig in seenSignatures) continue
            seenKeys.add(cand.key)
            if (cand.externalVideoId.isNotBlank()) seenVideoIds.add(cand.externalVideoId)
            if (sig != "|") seenSignatures.add(sig)
            fresh.add(cand)
        }
        if (fresh.isEmpty()) return state
        val base = state.queue.size
        val nextQueue = state.queue + fresh
        val addedIndices = (base until base + fresh.size).toList()
        return state.copy(
            queue = nextQueue,
            order = state.order + addedIndices,
            updatedAt = nowMs,
        )
    }

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
            audioCodec = null,
            audioOutput = null,
            updatedAt = nowMs,
        )

    fun toJson(state: MusicState): JSONObject = JSONObject()
        .put("shuffle", state.shuffle)
        .put("repeat", state.repeat.name.lowercase())
        .put("autoplay", state.autoplay)
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
            autoplay = json.optBoolean("autoplay", true),
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
    private val context: Context,
    private val scope: CoroutineScope,
    private val dataDir: File,
    private val resolveStreamUrl: suspend (Entry) -> Entry,
    private val fetchAutoplayTracks: suspend (TrackItem, Set<String>) -> List<TrackItem> = { _, _ -> emptyList() },
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
    private var autoplayJob: Job? = null
    private var lastAutoplaySeedKey: String? = null
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

    fun showExternalResolving(placeholder: TrackItem) {
        openJob?.cancel()
        openJob = null
        closeHandle()
        onStartingMusic()
        _state.value = _state.value.copy(
            queue = listOf(placeholder),
            order = listOf(0),
            index = 0,
            sourceLabel = placeholder.externalStreamSource.orEmpty().ifBlank { "Streaming" },
            pausedForVideo = false,
            positionMs = 0L,
            durationMs = null,
            playing = true,
            buffering = true,
            error = null,
            audioCodec = null,
            audioOutput = null,
            updatedAt = System.currentTimeMillis(),
        )
        onPlaybackActiveChanged(true)
    }

    fun playTrackList(
        items: List<TrackItem>,
        startIndex: Int = 0,
        sourceLabel: String = "",
        shuffleOn: Boolean? = null,
    ) {
        if (items.isEmpty()) return
        autoplayJob?.cancel()
        lastAutoplaySeedKey = null
        onStartingMusic()
        val step = MusicQueue.playList(_state.value, items, startIndex, sourceLabel, shuffleOn)
        _state.value = step.state.copy(autoplayLoading = false)
        persist(step.state)
        step.openTrack?.let { openAndPlay(it, seekMs = 0L) }
        maybeRefillAutoplay()
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
        if (cur.playing) pause() else play()
    }

    fun pause() {
        val cur = _state.value
        if (!cur.hasQueue || !cur.playing) return
        val h = handle
        if (h != 0L) runCatching { NativePlayer.pause(h) }
        val paused = cur.copy(playing = false, buffering = false, updatedAt = System.currentTimeMillis())
        _state.value = paused
        persist(paused)
        onPlaybackActiveChanged(false)
    }

    fun play() {
        val cur = _state.value
        val track = cur.currentTrack ?: return
        if (cur.playing && handle != 0L && openedKey == track.key) return
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

    fun next() {
        val step = MusicQueue.next(_state.value, userTriggered = true)
        if (step.openTrack != null) {
            _state.value = step.state
            persist(step.state)
            onStartingMusic()
            openAndPlay(step.openTrack, seekMs = 0L)
            maybeRefillAutoplay()
        } else if (step.reachedEnd) {
            if (_state.value.autoplay && _state.value.hasQueue) {
                maybeRefillAutoplay(advanceWhenReady = true, force = true)
            } else {
                _state.value = step.state
                persist(step.state)
                closeHandle()
                onPlaybackActiveChanged(false)
            }
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
            maybeRefillAutoplay()
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
        if (next.repeat != RepeatMode.One) {
            maybeRefillAutoplay()
        }
    }

    fun toggleAutoplay() {
        val next = MusicQueue.toggleAutoplay(_state.value)
        _state.value = next.copy(autoplayLoading = if (next.autoplay) next.autoplayLoading else false)
        persist(next)
        if (next.autoplay) {
            lastAutoplaySeedKey = null
            maybeRefillAutoplay()
        } else {
            autoplayJob?.cancel()
            autoplayJob = null
        }
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
            step.openTrack != null -> {
                openAndPlay(step.openTrack, seekMs = 0L)
                maybeRefillAutoplay()
            }
            else -> maybeRefillAutoplay()
        }
    }

    fun clearUpNext() {
        autoplayJob?.cancel()
        autoplayJob = null
        val next = MusicQueue.clearUpNext(_state.value).copy(autoplayLoading = false)
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
        autoplayJob?.cancel()
        autoplayJob = null
        lastAutoplaySeedKey = null
        closeHandle()
        val stopped = MusicQueue.stop(_state.value).copy(autoplayLoading = false)
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

    /** Enriches a queued streaming track with resolved album, artist, artUrl, or track number. */
    fun updateTrackMetadata(
        trackKey: String,
        album: String? = null,
        artist: String? = null,
        artUrl: String? = null,
        albumBrowseId: String? = null,
        trackNumber: Int? = null,
    ) {
        val cur = _state.value
        if (cur.queue.isEmpty()) return
        var changed = false
        val updated = cur.queue.map { item ->
            if (item.key != trackKey) {
                item
            } else {
                val nextAlbum = album?.trim()?.takeIf { it.isNotBlank() } ?: item.album
                val nextArtist = artist?.trim()?.takeIf { it.isNotBlank() } ?: item.artist
                val nextArt = artUrl?.trim()?.takeIf { it.isNotBlank() } ?: item.artUrl
                val nextBrowseId = albumBrowseId?.trim()?.takeIf { it.isNotBlank() } ?: item.albumBrowseId
                val nextTrack = trackNumber?.takeIf { it > 0 } ?: item.track
                val nextTrackNo = if (nextTrack != null && item.trackNo.isBlank()) {
                    nextTrack.toString().padStart(2, '0')
                } else {
                    item.trackNo
                }
                if (nextAlbum != item.album ||
                    nextArtist != item.artist ||
                    nextArt != item.artUrl ||
                    nextBrowseId != item.albumBrowseId ||
                    nextTrack != item.track
                ) {
                    changed = true
                    item.copy(
                        album = nextAlbum,
                        artist = nextArtist,
                        artUrl = nextArt,
                        albumBrowseId = nextBrowseId,
                        track = nextTrack,
                        trackNo = nextTrackNo,
                    )
                } else {
                    item
                }
            }
        }
        if (changed) {
            val nextState = cur.copy(queue = updated, updatedAt = System.currentTimeMillis())
            _state.value = nextState
            persist(nextState)
        }
    }

    private fun maybeRefillAutoplay(
        advanceWhenReady: Boolean = false,
        force: Boolean = false,
    ) {
        val cur = _state.value
        if (!cur.autoplay || !cur.hasQueue) return
        if (cur.repeat == RepeatMode.One && !advanceWhenReady) return
        if (!force && cur.upNextCount > 2) return
        val seed = cur.currentTrack ?: return
        if (seed.title.isBlank() && seed.artist.isBlank() && seed.externalVideoId.isBlank()) return
        if (!force && autoplayJob?.isActive == true) return
        if (!force && lastAutoplaySeedKey == seed.key && cur.upNextCount > 0) return

        autoplayJob?.cancel()
        lastAutoplaySeedKey = seed.key
        val existingIds = cur.queue.mapNotNull { it.externalVideoId.takeIf { id -> id.isNotBlank() } }.toSet()
        _state.value = _state.value.copy(autoplayLoading = true)
        autoplayJob = scope.launch {
            val fetched = try {
                fetchAutoplayTracks(seed, existingIds)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                emptyList()
            }
            withContext(Dispatchers.Main.immediate + NonCancellable) {
                val latest = _state.value
                if (!latest.hasQueue || !latest.autoplay) {
                    _state.value = latest.copy(autoplayLoading = false)
                    return@withContext
                }
                val appended = MusicQueue.appendAutoplay(latest, fetched).copy(autoplayLoading = false)
                _state.value = appended
                persist(appended)
                if (advanceWhenReady) {
                    val step = MusicQueue.next(appended, userTriggered = false)
                    _state.value = step.state
                    persist(step.state)
                    if (step.openTrack != null) {
                        onStartingMusic()
                        openAndPlay(step.openTrack, seekMs = 0L)
                        maybeRefillAutoplay()
                    } else {
                        closeHandle()
                        onPlaybackActiveChanged(false)
                    }
                }
            }
        }
    }

    private fun openAndPlay(track: TrackItem, seekMs: Long, autoSkipDepth: Int = 0) {
        openJob?.cancel()
        pollJob?.cancel()
        closeHandle()
        pendingSeekMs = seekMs.takeIf { it > 0L }
        onPlaybackActiveChanged(true)
        openJob = scope.launch {
            var activeTrack = track
            val resolved = if (track.isExternalStream) {
                val existingUrl = track.entry.streamUrl.trim()
                if (existingUrl.isNotBlank()) {
                    track.entry
                } else {
                    // Lazy resolution for infinite radio tracks: resolve fresh playable audio right on open.
                    val fresh = if (track.externalVideoId.isNotBlank()) {
                        ExternalDiscoveryApi.resolveYouTubeAudioStream(track.externalVideoId)
                    } else {
                        ExternalDiscoveryApi.resolveFullSongStream(track.artist, track.title)
                    }
                    if (fresh != null) {
                        val updatedEntry = track.entry.copy(streamUrl = fresh.streamUrl)
                        activeTrack = track.copy(
                            entry = updatedEntry,
                            streamUserAgent = fresh.userAgent,
                            externalVideoId = fresh.videoId,
                            externalSaveUrl = fresh.watchUrl,
                            externalSaveKind = "youtube",
                        )
                        val cur = _state.value
                        val updatedQueue = cur.queue.map { if (it.key == track.key) activeTrack else it }
                        _state.value = cur.copy(
                            queue = updatedQueue,
                            durationMs = fresh.durationMs.takeIf { it > 0L } ?: cur.durationMs,
                        )
                        updatedEntry
                    } else {
                        track.entry
                    }
                }
            } else {
                runCatching { resolveStreamUrl(track.entry) }.getOrDefault(track.entry)
            }
            val rawUrl = resolved.streamUrl.trim()
            if (rawUrl.isBlank()) {
                if (activeTrack.isExternalStream && autoSkipDepth < 3 && _state.value.upNextCount > 0) {
                    val step = MusicQueue.next(_state.value, userTriggered = false)
                    _state.value = step.state
                    persist(step.state)
                    if (step.openTrack != null) {
                        openAndPlay(step.openTrack, seekMs = 0L, autoSkipDepth = autoSkipDepth + 1)
                        return@launch
                    }
                }
                _state.value = _state.value.copy(
                    playing = false,
                    buffering = false,
                    error = "Track stream is not available yet.",
                )
                onPlaybackActiveChanged(false)
                return@launch
            }
            // Bridge direct HTTPS audio streams (YouTube audio/mp4, SoundCloud, direct HTTPS audio)
            // through our loopback HTTP Range proxy so PearTube's native Rust player (`peartube-media`
            // / AAudio) decodes fragmented MP4/Opus/AAC/FLAC with instant startup and seeking.
            val url = if (rawUrl.startsWith("https://", ignoreCase = true)) {
                withContext(Dispatchers.IO) {
                    LocalStreamProxy.register(rawUrl, activeTrack.streamUserAgent)
                }
            } else {
                rawUrl
            }
            val soundfont = SoundFont.file(dataDir).takeIf { it.isFile }?.path
            var failure: String? = null
            val opened = withContext(Dispatchers.IO) {
                try {
                    NativePlayer.openWithOptions(url, soundfont, "auto", "off", false)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
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
                    val activeAudioCodec = ps.tracks
                        .firstOrNull { t -> t.kind == "audio" && (ps.audio == null || t.stream == ps.audio) }
                        ?.codec
                        ?.trim()
                        ?.takeIf { it.isNotEmpty() }
                    val activeAudioOutput = ps.audioOutput?.trim()?.takeIf { it.isNotEmpty() }
                    val cur = _state.value
                    val updated = cur.copy(
                        positionMs = ps.positionMs,
                        durationMs = ps.durationMs ?: cur.durationMs,
                        playing = ps.playing && !ps.ended,
                        buffering = ps.buffering && ps.error == null,
                        error = ps.error,
                        audioCodec = activeAudioCodec ?: cur.audioCodec,
                        audioOutput = activeAudioOutput ?: cur.audioOutput,
                    )
                    _state.value = updated
                    if (++persistCounter % 20 == 0) persist(updated)
                    if (ps.ended) {
                        val step = MusicQueue.next(updated, userTriggered = false)
                        if (step.openTrack != null) {
                            _state.value = step.state
                            persist(step.state)
                            openAndPlay(step.openTrack, seekMs = 0L)
                            maybeRefillAutoplay()
                        } else if (updated.autoplay && updated.hasQueue) {
                            maybeRefillAutoplay(advanceWhenReady = true, force = true)
                        } else {
                            _state.value = step.state
                            persist(step.state)
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
