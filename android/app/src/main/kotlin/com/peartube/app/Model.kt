package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import com.peartube.shared.formatBytes
import java.util.Locale

data class SourceSpec(
    val key: String,
    val kind: String = "channel",
    val alias: String = "",
) {
    fun toJson(): JSONObject = JSONObject()
        .put("key", key)
        .put("kind", kind)
        .apply { if (alias.isNotEmpty()) put("alias", alias) }

    companion object {
        fun from(json: JSONObject) = SourceSpec(
            key = json.optString("key").lowercase(),
            kind = json.optString("kind", "channel"),
            alias = json.optString("alias"),
        )
    }
}

data class Settings(
    val tracker: String = "",
    val mnemonic: String = "",
    val sources: List<SourceSpec> = emptyList(),
    val relayThrough: List<String> = emptyList(),
    val bootstrap: List<String> = emptyList(),
    val lanDiscovery: Boolean = true,
    val privateRouting: Boolean = false,
    val cacheMaxGb: Int = 10,
    val metaSources: List<String> = emptyList(),
    val p2pOnlyMetadata: Boolean = false,
    val seedFullMetadata: Boolean = false,
) {
    val hasSources: Boolean get() = tracker.isNotEmpty() || mnemonic.isNotEmpty() || sources.isNotEmpty()

    fun withSource(spec: SourceSpec): Settings {
        if (tracker == spec.key) return this
        val clean = spec.copy(kind = "channel")
        val updated = sources.filterNot { it.key == clean.key } + clean
        return copy(sources = updated)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("tracker", tracker)
        .apply { if (mnemonic.isNotEmpty()) put("mnemonic", mnemonic) }
        .put("sources", JSONArray().apply { sources.forEach { put(it.toJson()) } })
        .put("relayThrough", JSONArray(relayThrough))
        .put("bootstrap", JSONArray(bootstrap))
        .put("lanDiscovery", lanDiscovery)
        .put("privateRouting", privateRouting)
        .put("cacheMaxGb", cacheMaxGb)
        .put("metaSources", JSONArray(metaSources))
        .put("p2pOnlyMetadata", p2pOnlyMetadata)
        .put("seedFullMetadata", seedFullMetadata)

    fun save(dir: File) {
        dir.mkdirs()
        val tmp = File(dir, "settings.json.tmp")
        tmp.writeText(toJson().toString(2))
        if (!tmp.renameTo(File(dir, "settings.json"))) throw IOException("Cannot save settings.json")
    }

    companion object {
        fun fromJson(json: JSONObject): Settings {
            val srcArr = json.optJSONArray("sources")
            val parsedSources = if (srcArr == null) emptyList() else List(srcArr.length()) { SourceSpec.from(srcArr.getJSONObject(it)) }
            val metaArr = json.optJSONArray("metaSources")
            val parsedMetaSources = if (metaArr == null) {
                emptyList()
            } else {
                List(metaArr.length()) { idx ->
                    when (val item = metaArr.opt(idx)) {
                        is JSONObject -> item.optString("uri").ifBlank { item.optString("key") }
                        is String -> item
                        else -> ""
                    }.trim()
                }.filter { it.isNotEmpty() }
            }
            return Settings(
                tracker = json.optString("tracker"),
                mnemonic = json.optString("mnemonic"),
                sources = parsedSources,
                relayThrough = json.optJSONArray("relayThrough").strings(),
                bootstrap = json.optJSONArray("bootstrap").strings(),
                lanDiscovery = json.optBoolean("lanDiscovery", true),
                privateRouting = json.optBoolean("privateRouting"),
                cacheMaxGb = json.optInt("cacheMaxGb", 10),
                metaSources = parsedMetaSources,
                p2pOnlyMetadata = json.optBoolean("p2pOnlyMetadata", false),
                seedFullMetadata = json.optBoolean("seedFullMetadata", false),
            )
        }

        fun load(dir: File): Settings = try {
            val file = File(dir, "settings.json")
            if (!file.exists()) Settings()
            else fromJson(JSONObject(file.readText()))
        } catch (_: Exception) {
            Settings()
        }
    }
}
data class RouteTraffic(
    val peers: Long = 0,
    val rxBytes: Long = 0,
    val txBytes: Long = 0,
    val downBps: Long = 0,
    val upBps: Long = 0,
) {
    companion object {
        val Zero = RouteTraffic()

        fun from(json: JSONObject?) = if (json == null) Zero else RouteTraffic(
            peers = json.optLong("peers"),
            rxBytes = json.optLong("rxBytes"),
            txBytes = json.optLong("txBytes"),
            downBps = json.optLong("downBps"),
            upBps = json.optLong("upBps"),
        )
    }
}

data class TrafficRoutes(
    val privateRoute: RouteTraffic = RouteTraffic.Zero,
    val publicRoute: RouteTraffic = RouteTraffic.Zero,
    val lan: RouteTraffic = RouteTraffic.Zero,
) {
    val totalPeers: Long get() = lan.peers + publicRoute.peers + privateRoute.peers

    companion object {
        val Empty = TrafficRoutes()

        fun from(json: JSONObject?) = if (json == null) Empty else TrafficRoutes(
            privateRoute = RouteTraffic.from(json.optJSONObject("private")),
            publicRoute = RouteTraffic.from(json.optJSONObject("public")),
            lan = RouteTraffic.from(json.optJSONObject("lan")),
        )
    }
}

data class NetworkHistory(
    val down: List<Long> = emptyList(),
    val up: List<Long> = emptyList(),
) {
    fun append(downBps: Long, upBps: Long, maxSamples: Int = 40): NetworkHistory {
        val nextDown = (down + downBps.coerceAtLeast(0L)).takeLast(maxSamples)
        val nextUp = (up + upBps.coerceAtLeast(0L)).takeLast(maxSamples)
        return NetworkHistory(down = nextDown, up = nextUp)
    }
}

data class SourceInfo(
    val key: String,
    val kind: String,
    val alias: String = "",
    val primary: Boolean = false,
    val writable: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject) = SourceInfo(
            key = json.optString("key"),
            kind = json.optString("kind", "channel"),
            alias = json.optString("alias"),
            primary = json.optBoolean("primary"),
            writable = json.optBoolean("writable"),
        )
    }
}

data class DiscoveredSource(
    val key: String,
    val kind: String,
    val title: String,
    val via: String = "",
) {
    companion object {
        fun from(json: JSONObject) = DiscoveredSource(
            key = json.optString("key"),
            kind = json.optString("kind", "channel"),
            title = json.optString("title"),
            via = json.optString("via"),
        )
    }
}

data class Reciprocity(
    val tier: String = "peer",
    val seededBytes: Long = 0,
    val contributingPeers: Long = 0,
    val ratio: Double = 0.0,
    val inflightMax: Long = 128,
) {
    companion object {
        fun from(json: JSONObject?) = if (json == null) Reciprocity() else Reciprocity(
            tier = json.optString("tier", "peer"),
            seededBytes = json.optLong("seededBytes"),
            contributingPeers = json.optLong("contributingPeers"),
            ratio = json.optDouble("ratio", 0.0),
            inflightMax = json.optLong("inflightMax", 128),
        )
    }
}

data class Status(
    val tracker: String,
    val channel: String = "",
    val writer: String,
    val writable: Boolean = false,
    val blobs: String,
    val blobBytes: Long,
    val cachedBytes: Long = 0,
    val cacheMaxBytes: Long = 0,
    val peers: Long,
    val lanPeers: Long,
    val downBps: Long = 0,
    val upBps: Long = 0,
    val rxBytes: Long = 0,
    val txBytes: Long = 0,
    val routes: TrafficRoutes,
    val inflightBlocks: Long = 0,
    val rtt: Long = 0,
    val retransmits: Long = 0,
    val lan: String?,
    val apiUrl: String? = null,
    val sources: List<SourceInfo> = emptyList(),
    val discoveredSources: List<DiscoveredSource> = emptyList(),
    val reciprocity: Reciprocity = Reciprocity(),
) {
    companion object {
        fun from(json: JSONObject): Status {
            val srcArr = json.optJSONArray("sources")
            val discArr = json.optJSONArray("discoveredSources")
            return Status(
                tracker = json.optString("tracker"),
                channel = json.optString("channel"),
                writer = json.optString("writer"),
                writable = json.optBoolean("writable"),
                blobs = json.optString("blobs"),
                blobBytes = json.optLong("blobBytes"),
                cachedBytes = json.optLong("cachedBytes"),
                cacheMaxBytes = json.optLong("cacheMaxBytes"),
                peers = json.optLong("peers"),
                lanPeers = json.optLong("lanPeers"),
                downBps = json.optLong("downBps"),
                upBps = json.optLong("upBps"),
                rxBytes = json.optLong("rxBytes"),
                txBytes = json.optLong("txBytes"),
                routes = TrafficRoutes.from(json.optJSONObject("routes")),
                inflightBlocks = json.optLong("inflightBlocks"),
                rtt = json.optLong("rtt"),
                retransmits = json.optLong("retransmits"),
                lan = json.optString("lan").takeUnless { json.isNull("lan") || it.isEmpty() },
                apiUrl = json.optString("apiUrl").takeUnless { json.isNull("apiUrl") || it.isEmpty() },
                sources = if (srcArr == null) emptyList() else List(srcArr.length()) { SourceInfo.from(srcArr.getJSONObject(it)) },
                discoveredSources = if (discArr == null) emptyList() else List(discArr.length()) { DiscoveredSource.from(discArr.getJSONObject(it)) },
                reciprocity = Reciprocity.from(json.optJSONObject("reciprocity")),
            )
        }
    }
}

data class MusicMeta(
    val title: String? = null,
    val artist: String? = null,
) {
    companion object {
        fun from(json: JSONObject?): MusicMeta? {
            if (json == null) return null
            val title = json.optString("title").takeUnless { json.isNull("title") || it.isEmpty() }
            val artist = json.optString("artist").takeUnless { json.isNull("artist") || it.isEmpty() }
            return if (title == null && artist == null) null else MusicMeta(title = title, artist = artist)
        }
    }
}

data class Entry(
    val key: String,
    val id: String,
    val title: String,
    val size: Long,
    val sha256: String,
    val local: Boolean,
    val cachedBytes: Long = 0,
    val isPrivate: Boolean = false,
    val epoch: Long = 0,
    val locked: Boolean = false,
    val streamUrl: String,
    val magnetUrl: String = "",
    val downloadUrl: String? = null,
    val source: String = "",
    val sourceKind: String = "",
    val season: Int? = null,
    val episode: Int? = null,
    val seriesKey: String = "",
    val baseTitle: String = "",
    val year: String? = null,
    val music: MusicMeta? = null,
) {
    val isEpisode: Boolean get() = season != null && episode != null
    val episodeLabel: String get() = if (season != null && episode != null) "S%02dE%02d".format(Locale.ROOT, season, episode) else "Movie"
    val seasonLabel: String? get() = if (season != null) "S%02d".format(Locale.ROOT, season) else null

    companion object {
        fun from(json: JSONObject) = Entry(
            key = json.getString("key"),
            id = json.getString("id"),
            title = json.getString("title"),
            size = json.optLong("size"),
            sha256 = json.optString("sha256"),
            local = json.optBoolean("local"),
            cachedBytes = json.optLong("cachedBytes"),
            isPrivate = json.optBoolean("private"),
            epoch = json.optLong("epoch"),
            locked = json.optBoolean("locked"),
            streamUrl = json.getString("streamUrl"),
            magnetUrl = json.optString("magnetUrl"),
            downloadUrl = json.optString("downloadUrl").takeIf { it.isNotEmpty() },
            source = json.optString("source"),
            sourceKind = json.optString("sourceKind"),
            season = if (json.isNull("season")) null else json.optInt("season"),
            episode = if (json.isNull("episode")) null else json.optInt("episode"),
            seriesKey = json.optString("seriesKey"),
            baseTitle = json.optString("baseTitle", json.getString("title")),
            year = if (json.isNull("year")) null else json.optString("year").takeIf { it.isNotEmpty() },
            music = MusicMeta.from(json.optJSONObject("music")),
        )
    }
}


data class WriterInfo(
    val key: String,
    val role: String = "writer",
    val alias: String = "",
    val selfDevice: Boolean = false,
) {
    companion object {
        fun from(json: JSONObject) = WriterInfo(
            key = json.optString("key"),
            role = json.optString("role", "writer"),
            alias = json.optString("alias"),
            selfDevice = json.optBoolean("self"),
        )
    }
}

data class IdentityInfo(
    val channel: String = "",
    val writer: String = "",
    val role: String? = null,
    val writable: Boolean = false,
    val mnemonicSet: Boolean = false,
    val mnemonic: String = "",
    val writers: List<WriterInfo> = emptyList(),
    val epoch: Long = 1L,
    val accessUri: String = "",
) {
    companion object {
        fun from(json: JSONObject): IdentityInfo {
            val arr = json.optJSONArray("writers")
            return IdentityInfo(
                channel = json.optString("channel"),
                writer = json.optString("writer"),
                role = json.optString("role").takeUnless { json.isNull("role") || it.isEmpty() },
                writable = json.optBoolean("writable"),
                mnemonicSet = json.optBoolean("mnemonicSet"),
                mnemonic = json.optString("mnemonic"),
                writers = if (arr == null) emptyList() else List(arr.length()) { WriterInfo.from(arr.getJSONObject(it)) },
                epoch = json.optLong("epoch", 1L),
                accessUri = json.optString("accessUri"),
            )
        }
    }
}

data class OpenUriResult(
    val action: String,
    val source: SourceInfo?,
    val entry: Entry?,
    val receiver: CastReceiver? = null,
) {
    companion object {
        fun from(json: JSONObject) = OpenUriResult(
            action = json.optString("action"),
            source = json.optJSONObject("source")?.let(SourceInfo::from),
            entry = json.optJSONObject("entry")?.let(Entry::from),
            receiver = json.optJSONObject("receiver")?.let(CastReceiver::from),
        )
    }
}

/** One global search row (src/search.js): a file a relay this app does not follow holds whole. Play it with openUri. */
data class GlobalHit(
    val key: String,
    val id: String,
    val title: String,
    val size: Long,
    val relays: Int,
    val magnetUrl: String,
) {
    companion object {
        fun from(json: JSONObject) = GlobalHit(
            key = json.optString("key"),
            id = json.optString("id"),
            title = json.optString("title", json.optString("id")),
            size = json.optLong("size"),
            relays = json.optInt("relays", 1),
            magnetUrl = json.optString("magnetUrl"),
        )
    }
}

/** A search across relays the app does not follow: its query, rows, and when it was last asked. */
data class GlobalSearch(
    val query: String = "",
    val rows: List<GlobalHit> = emptyList(),
    val busy: Boolean = false,
    val error: String? = null,
    val askedAt: Long = 0L,
)

data class PendingCast(val entryKey: String, val title: String, val startPositionMs: Long)

data class WatchProgress(
    val entryKey: String,
    val id: String,
    val positionMs: Long,
    val durationMs: Long,
    val updatedAt: Long,
) {
    val partial: Boolean get() = positionMs > 0 && (durationMs <= 0 || positionMs < durationMs - 10_000)
    fun json() = JSONObject().put("entryKey", entryKey).put("id", id)
        .put("positionMs", positionMs).put("durationMs", durationMs).put("updatedAt", updatedAt)
    companion object {
        fun from(json: JSONObject) = WatchProgress(json.getString("entryKey"), json.getString("id"),
            json.optLong("positionMs"), json.optLong("durationMs"), json.optLong("updatedAt"))
    }
}

data class CastReceiver(
    val id: String,
    val name: String,
    val host: String? = null,
    val port: Int = 0,
    val publicKey: String = "",
    val online: Boolean = false,
    val paired: Boolean = false,
    val p2p: Boolean = false,
    val transport: String = "",
    val auth: String = "code",
    val current: Boolean = true,
) {
    companion object {
        fun from(json: JSONObject) = CastReceiver(
            id = json.optString("id"),
            name = json.optString("name", "PearTube TV"),
            host = json.optString("host").takeUnless { json.isNull("host") || it.isEmpty() },
            port = json.optInt("port"),
            publicKey = json.optString("publicKey"),
            online = json.optBoolean("online"),
            paired = json.optBoolean("paired"),
            p2p = json.optBoolean("p2p"),
            transport = json.optString("transport"),
            auth = json.optString("auth", "code"),
            current = json.optBoolean("current", true),
        )
    }
}

data class CastEntryMeta(
    val key: String = "",
    val id: String = "",
    val title: String = "",
    val size: Long = 0L,
    val sha256: String = "",
) {
    companion object {
        fun from(json: JSONObject) = CastEntryMeta(
            key = json.optString("key"),
            id = json.optString("id"),
            title = json.optString("title"),
            size = json.optLong("size"),
            sha256 = json.optString("sha256"),
        )
    }
}

data class CastPlaybackState(
    val status: String = "idle",
    val mode: String? = null,
    val entry: CastEntryMeta? = null,
    val positionMs: Long = 0L,
    val durationMs: Long? = null,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val ended: Boolean = false,
    val p2pPeers: Long = 0L,
    val cachedBytes: Long = 0L,
    val seeding: Boolean = false,
    val error: String? = null,
) {
    companion object {
        fun from(json: JSONObject?) = if (json == null) CastPlaybackState() else CastPlaybackState(
            status = json.optString("status", "idle"),
            mode = json.optString("mode").takeUnless { json.isNull("mode") || it.isEmpty() },
            entry = json.optJSONObject("entry")?.let(CastEntryMeta::from),
            positionMs = json.optLong("positionMs"),
            durationMs = if (json.isNull("durationMs")) null else json.optLong("durationMs"),
            playing = json.optBoolean("playing"),
            buffering = json.optBoolean("buffering"),
            ended = json.optBoolean("ended"),
            p2pPeers = json.optLong("p2pPeers"),
            cachedBytes = json.optLong("cachedBytes"),
            seeding = json.optBoolean("seeding"),
            error = json.optString("error").takeUnless { json.isNull("error") || it.isEmpty() },
        )
    }
}

data class CastSession(
    val receiverId: String,
    val receiverName: String,
    val transport: String = "",
    val state: CastPlaybackState = CastPlaybackState(),
) {
    companion object {
        fun from(json: JSONObject) = CastSession(
            receiverId = json.optString("receiverId"),
            receiverName = json.optString("receiverName", "PearTube TV"),
            transport = json.optString("transport"),
            state = CastPlaybackState.from(json.optJSONObject("state")),
        )
    }
}

data class CastStatus(
    val receivers: List<CastReceiver> = emptyList(),
    val session: CastSession? = null,
) {
    companion object {
        fun from(json: JSONObject?): CastStatus {
            if (json == null) return CastStatus()
            val arr = json.optJSONArray("receivers")
            return CastStatus(
                receivers = if (arr == null) emptyList() else List(arr.length()) { CastReceiver.from(arr.getJSONObject(it)) },
                session = json.optJSONObject("session")?.let(CastSession::from),
            )
        }
    }
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else List(length()) { getString(it) }

fun formatRate(bps: Long): String =
    if (bps <= 0L) "0 B/s" else "${formatBytes(bps)}/s"

fun p2pSummary(status: Status?): String? {
    val st = status ?: return null
    val routes = listOf("Private" to st.routes.privateRoute, "Public DHT" to st.routes.publicRoute, "LAN" to st.routes.lan)
    if (st.downBps <= 0 && st.upBps <= 0 && st.inflightBlocks <= 0 &&
        routes.all { (_, route) -> route.rxBytes == 0L && route.txBytes == 0L }) return null
    val rtt = if (st.rtt > 0) " · ${st.rtt} ms" else ""
    val paths = routes.joinToString(" · ") { (name, route) ->
        "$name ↓ ${formatBytes(route.rxBytes)} ↑ ${formatBytes(route.txBytes)}"
    }
    return "P2P ↓ ${formatBytes(st.downBps)}/s · ↑ ${formatBytes(st.upBps)}/s · ${st.inflightBlocks} blks$rtt\n$paths"
}
