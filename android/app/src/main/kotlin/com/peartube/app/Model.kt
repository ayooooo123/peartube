package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLDecoder
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
) {
    val hasSources: Boolean get() = tracker.isNotEmpty() || mnemonic.isNotEmpty() || sources.isNotEmpty()

    fun formatSources(): String = sources.joinToString("\n") { s ->
        if (s.alias.isEmpty()) "peartube://channel/${s.key}"
        else "peartube://channel/${s.key}?name=${s.alias}"
    }

    fun withSource(spec: SourceSpec): Settings {
        if (tracker == spec.key) return this
        val clean = spec.copy(kind = "channel")
        val updated = sources.filterNot { it.key == clean.key } + clean
        return copy(sources = updated)
    }

    fun save(dir: File) {
        dir.mkdirs()
        val srcArray = JSONArray().apply { sources.forEach { put(it.toJson()) } }
        val json = JSONObject()
            .put("tracker", tracker)
            .apply { if (mnemonic.isNotEmpty()) put("mnemonic", mnemonic) }
            .put("sources", srcArray)
            .put("relayThrough", JSONArray(relayThrough))
            .put("bootstrap", JSONArray(bootstrap))
            .put("lanDiscovery", lanDiscovery)
            .put("privateRouting", privateRouting)
        val tmp = File(dir, "settings.json.tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(File(dir, "settings.json"))) throw IOException("Cannot save settings.json")
    }

    companion object {
        fun load(dir: File): Settings = try {
            val json = JSONObject(File(dir, "settings.json").readText())
            val srcArr = json.optJSONArray("sources")
            val parsedSources = if (srcArr == null) emptyList() else List(srcArr.length()) { SourceSpec.from(srcArr.getJSONObject(it)) }.filter { isKey(it.key) }
            Settings(
                tracker = json.optString("tracker"),
                mnemonic = json.optString("mnemonic"),
                sources = parsedSources,
                relayThrough = json.optJSONArray("relayThrough").strings(),
                bootstrap = json.optJSONArray("bootstrap").strings(),
                lanDiscovery = json.optBoolean("lanDiscovery", false),
                privateRouting = json.optBoolean("privateRouting"),
            )
        } catch (_: Exception) {
            Settings()
        }

        fun parseSourceToken(raw: String, defaultKind: String = "channel"): SourceSpec {
            val trimmed = raw.trim()
            val lower = trimmed.lowercase()
            if (isKey(lower)) return SourceSpec(lower, defaultKind, "")
            if (':' in lower && !lower.startsWith("peartube:")) {
                val prefix = lower.substringBefore(':')
                val restKey = lower.substringAfter(':')
                if ((prefix == "channel" || prefix == "tracker") && isKey(restKey)) {
                    return SourceSpec(restKey, prefix, "")
                }
            }
            val body = when {
                trimmed.startsWith("peartube://", ignoreCase = true) -> trimmed.substring(11)
                trimmed.startsWith("peartube:", ignoreCase = true) -> trimmed.substring(9)
                else -> throw IllegalArgumentException("Invalid key or peartube:// URI: $trimmed")
            }
            val path = body.substringBefore('?')
            val query = body.substringAfter('?', "")
            val slash = path.indexOf('/')
            require(slash > 0) { "Invalid peartube:// URI: $trimmed" }
            val verb = path.substring(0, slash).lowercase()
            val key = path.substring(slash + 1).trim().lowercase()
            require(isKey(key)) { "Source key in $trimmed is not 64 hex characters." }
            val kind = when (verb) {
                "channel", "tracker", "add", "source" -> defaultKind
                else -> throw IllegalArgumentException("Expected peartube://channel/..., got $verb")
            }
            var alias = ""
            for (pair in query.split('&').filter { it.isNotEmpty() }) {
                val eq = pair.indexOf('=')
                if (eq > 0) {
                    val k = pair.substring(0, eq)
                    val v = runCatching { URLDecoder.decode(pair.substring(eq + 1), "UTF-8") }.getOrDefault(pair.substring(eq + 1))
                    if (k == "name" || k == "alias") alias = v
                }
            }
            return SourceSpec(key, kind, alias)
        }

        fun parse(tracker: String, sourcesRaw: String, relayThrough: String, bootstrap: String, lan: Boolean, privateRouting: Boolean = false, mnemonicRaw: String = ""): Settings {
            var primary = ""
            val sources = mutableListOf<SourceSpec>()
            if (tracker.isNotBlank()) {
                primary = parseSourceToken(tracker, "channel").key
            }
            val words = mnemonicRaw.trim().lowercase(Locale.US).split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (words.isNotEmpty() && (words.size != 12 && words.size != 24 || words.any { w -> w.any { ch -> ch !in 'a'..'z' } })) {
                throw IllegalArgumentException("Recovery phrase must be 12 or 24 lowercase English words.")
            }
            val cleanMnemonic = words.joinToString(" ")
            for (token in sourcesRaw.split('\n', '\r', ',').map { it.trim() }.filter { it.isNotEmpty() }) {
                val spec = parseSourceToken(token, "channel").copy(kind = "channel")
                if (spec.key != primary && sources.none { it.key == spec.key }) sources += spec
            }
            require(primary.isNotEmpty() || cleanMnemonic.isNotEmpty() || sources.isNotEmpty()) { "Add a channel key, a 12-word recovery phrase, or a peartube://channel/ link." }
            val relays = split(relayThrough).map { it.lowercase() }
            relays.firstOrNull { !isKey(it) }?.let { throw IllegalArgumentException("Relay key $it is not 64 hex characters.") }
            val nodes = split(bootstrap)
            nodes.firstOrNull { !isHostPort(it) }?.let { throw IllegalArgumentException("Bootstrap node $it is not host:port.") }
            return Settings(primary, cleanMnemonic, sources, relays, nodes, lan, privateRouting)
        }

        private fun split(list: String) = list.split(',', ' ', '\t', '\n', '\r').filter { it.isNotEmpty() }

        fun isKey(key: String) = key.length == 64 && key.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

        private fun isHostPort(node: String): Boolean {
            val i = node.lastIndexOf(':')
            val port = node.substring(i + 1).toIntOrNull()
            return i > 0 && port != null && port in 1..65535
        }
    }
}
data class RouteTraffic(
    val peers: Long,
    val rxBytes: Long,
    val txBytes: Long,
    val downBps: Long,
    val upBps: Long,
) {
    companion object {
        fun from(json: JSONObject) = RouteTraffic(
            peers = json.getLong("peers"),
            rxBytes = json.getLong("rxBytes"),
            txBytes = json.getLong("txBytes"),
            downBps = json.getLong("downBps"),
            upBps = json.getLong("upBps"),
        )
    }
}

data class TrafficRoutes(
    val privateRoute: RouteTraffic,
    val publicRoute: RouteTraffic,
    val lan: RouteTraffic,
) {
    companion object {
        fun from(json: JSONObject) = TrafficRoutes(
            privateRoute = RouteTraffic.from(json.getJSONObject("private")),
            publicRoute = RouteTraffic.from(json.getJSONObject("public")),
            lan = RouteTraffic.from(json.getJSONObject("lan")),
        )
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
                peers = json.optLong("peers"),
                lanPeers = json.optLong("lanPeers"),
                downBps = json.optLong("downBps"),
                upBps = json.optLong("upBps"),
                rxBytes = json.optLong("rxBytes"),
                txBytes = json.optLong("txBytes"),
                routes = TrafficRoutes.from(json.getJSONObject("routes")),
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
    val source: String = "",
    val sourceKind: String = "",
) {
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
            source = json.optString("source"),
            sourceKind = json.optString("sourceKind"),
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

data class ReceiverInfo(
    val deviceId: String = "",
    val name: String = "PearTube TV",
    val publicKey: String = "",
    val port: Int = 0,
    val pairCode: String = "",
    val pairingUri: String = "",
    val listenUrl: String = "",
) {
    companion object {
        fun from(json: JSONObject) = ReceiverInfo(
            deviceId = json.optString("deviceId"),
            name = json.optString("name", "PearTube TV"),
            publicKey = json.optString("publicKey"),
            port = json.optInt("port"),
            pairCode = json.optString("pairCode"),
            pairingUri = json.optString("pairingUri"),
            listenUrl = json.optString("listenUrl"),
        )
    }
}

data class CastStatus(
    val webReceiverUrl: String? = null,
    val receivers: List<CastReceiver> = emptyList(),
    val session: CastSession? = null,
    val receiverMode: ReceiverInfo? = null,
) {
    companion object {
        fun from(json: JSONObject?): CastStatus {
            if (json == null) return CastStatus()
            val arr = json.optJSONArray("receivers")
            return CastStatus(
                webReceiverUrl = json.optString("webReceiverUrl").takeUnless { json.isNull("webReceiverUrl") || it.isEmpty() },
                receivers = if (arr == null) emptyList() else List(arr.length()) { CastReceiver.from(arr.getJSONObject(it)) },
                session = json.optJSONObject("session")?.let(CastSession::from),
                receiverMode = json.optJSONObject("receiverMode")?.let(ReceiverInfo::from),
            )
        }
    }
}

data class ReceiverCommand(
    val seq: Long = 0L,
    val action: String,
    val entry: CastEntryMeta? = null,
    val mode: String? = null,
    val streamUrl: String? = null,
    val httpStreamUrl: String? = null,
    val startPositionMs: Long = 0L,
    val positionMs: Long? = null,
    val deltaMs: Long? = null,
    val stream: Int? = null,
) {
    companion object {
        fun from(json: JSONObject) = ReceiverCommand(
            seq = json.optLong("seq"),
            action = json.optString("action"),
            entry = json.optJSONObject("entry")?.let(CastEntryMeta::from),
            mode = json.optString("mode").takeUnless { json.isNull("mode") || it.isEmpty() },
            streamUrl = json.optString("streamUrl").takeUnless { json.isNull("streamUrl") || it.isEmpty() },
            httpStreamUrl = json.optString("httpStreamUrl").takeUnless { json.isNull("httpStreamUrl") || it.isEmpty() },
            startPositionMs = json.optLong("startPositionMs"),
            positionMs = if (json.isNull("positionMs")) null else json.optLong("positionMs"),
            deltaMs = if (json.isNull("deltaMs")) null else json.optLong("deltaMs"),
            stream = if (json.isNull("stream")) null else json.optInt("stream"),
        )
    }
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else List(length()) { getString(it) }

fun formatBytes(bytes: Long): String {
    val kb = 1024.0
    val mb = kb * 1024
    val gb = mb * 1024
    return when {
        bytes >= gb -> "%.1f GB".format(Locale.ROOT, bytes / gb)
        bytes >= mb -> "%.1f MB".format(Locale.ROOT, bytes / mb)
        bytes >= kb -> "%.1f KB".format(Locale.ROOT, bytes / kb)
        else -> "$bytes B"
    }
}

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

/** "S01E02" for an episode id (`tt…:s01e02`), else "Movie". */
fun label(id: String): String {
    val s = id.substringAfterLast(':', "")
    val episode = (s.length == 6 || s.length == 7) &&
        s[0].lowercaseChar() == 's' && s[1].isDigit() && s[2].isDigit() &&
        s[3].lowercaseChar() == 'e' && s[4].isDigit() && s[5].isDigit() &&
        (s.length == 6 || s[6].isDigit())
    return if (episode) s.uppercase() else "Movie"
}
