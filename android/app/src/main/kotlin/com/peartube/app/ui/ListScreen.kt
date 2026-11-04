package com.peartube.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.*

@Composable
internal fun CinemaIcon(icon: ImageVector, description: String, tint: androidx.compose.ui.graphics.Color = Dim, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) { Icon(icon, description, tint = tint, modifier = Modifier.size(23.dp)) }
}

@Composable
fun ListScreen(model: AppModel) {
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
    val cast by model.cast.collectAsState()
    val query by model.query.collectAsState()
    val history by model.watchHistory.collectAsState()
    val downloads by model.downloads.collectAsState()
    var hood by remember { mutableStateOf(false) }
    var scanner by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf("All") }
    var source by remember { mutableStateOf<String?>(null) }
    val focus = LocalFocusManager.current
    val peers = status?.let { it.peers + it.lanPeers } ?: 0L
    val transfer = (status?.downBps ?: 0L) + (status?.upBps ?: 0L) > 0
    val pulse = rememberInfiniteTransition(label = "Swarm breath")
    val glow by pulse.animateFloat(.45f, 1f, infiniteRepeatable(tween(1800), RepeatMode.Reverse), label = "Connection glow")
    val contextual = query.trim().let { it.startsWith("peartube://", true) || Regex("[a-fA-F0-9]{64}").matches(it) }
    val connect = {
        if (contextual) { model.openUriOrKey(query); model.query.value = "" }
        focus.clearFocus()
    }
    val rows = remember(entries, query, filter, source, contextual) {
        entries.distinctBy { it.key }.filter {
            (contextual || query.isBlank() || "${it.title} ${it.id}".contains(query, true)) &&
                (source == null || it.source == source) && when (filter) {
                    "Movies" -> label(it.id) == "Movie"
                    "Series" -> label(it.id) != "Movie"
                    "On Device" -> it.local || (it.size > 0 && it.cachedBytes >= it.size)
                    else -> true
                }
        }.sortedWith(compareBy({ it.title.lowercase() }, { label(it.id) }))
    }
    val groups = remember(rows) { rows.groupBy { if (label(it.id) == "Movie") it.id else seriesKey(it) } }
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable { hood = true }, verticalAlignment = Alignment.CenterVertically) {
                Text("PearTube", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
                Box(Modifier.padding(start = 8.dp).size(6.dp).graphicsLayer { alpha = if (transfer) glow else 1f }.background(if (transfer) Brand else if (peers > 0) Accent else Dim, CircleShape))
            }
            CinemaIcon(if (cast.session != null) CastConnectedIcon else CastIcon, "Cast", if (cast.session != null) Brand else Dim) { model.openCastSheet() }
            CinemaIcon(SettingsIcon, "Settings") { model.screen.value = Screen.Settings }
        }
        OutlinedTextField(query, { model.query.value = it }, singleLine = true,
            placeholder = { Text("Find something to watch…", maxLines = 1, fontSize = 14.sp) },
            leadingIcon = { Icon(SearchIcon, null, tint = Dim) },
            trailingIcon = {
                Row {
                    if (query.isNotEmpty()) CinemaIcon(CloseIcon, "Clear search") { model.query.value = "" }
                    CinemaIcon(QrCodeScannerIcon, "Scan QR code") { scanner = true }
                }
            },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { connect() }), shape = RoundedCornerShape(28.dp), colors = fieldColors(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
        AnimatedVisibility(contextual) {
            Row(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(CardElevated).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                val action = when {
                    query.contains("://receiver/", true) || query.contains("://cast/", true) -> "Connect TV"
                    query.contains("://watch/", true) || query.contains("://stream/", true) -> "Play Stream"
                    query.contains("://access/", true) -> "Unlock Channel"
                    else -> "Connect Channel"
                }
                Text(action, color = Ink, modifier = Modifier.weight(1f))
                TextButton(onClick = { connect() }) { Text("Let's go", color = Brand) }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("All", "Movies", "Series", "On Device").forEach { name ->
                FilterChip(selected = filter == name, onClick = { filter = name }, label = { Text(name) })
            }
            val sources = status?.sources.orEmpty()
            if (sources.size > 1) sources.forEach { channel ->
                FilterChip(selected = source == channel.key, onClick = { source = if (source == channel.key) null else channel.key }, label = { Text(channel.alias.ifBlank { "Channel ${channel.key.take(6)}" }) })
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (groups.isEmpty()) item {
                Column(Modifier.padding(vertical = 40.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (entries.isEmpty()) "Your next cinema moment awaits." else "Nothing here just yet.", color = Ink, fontSize = 19.sp)
                    Text(if (status == null) "Connecting to your channels…" else if (entries.isEmpty()) "Add a channel from the PearTube menu above." else "Try another search or filter.", color = Dim)
                }
            }
            groups.forEach { (key, episodes) ->
                item(key = key) {
                    if (label(episodes.first().id) == "Movie") MovieCard(model, episodes.first(), history[episodes.first().key], downloads[episodes.first().key])
                    else SeriesCard(model, episodes, history, downloads, query.isNotBlank() && !contextual)
                }
            }
        }
        CastRemoteBar(model)
    }
    if (hood) UnderTheHood(model, onClose = { hood = false }, onAdd = { hood = false; model.screen.value = Screen.Settings })
    if (scanner) QrScannerSheet(onScanned = { scanner = false; if (it.startsWith("peartube:", true)) model.openUriOrKey(it) else model.pairCastByUriOrHost(it) }, onClose = { scanner = false })
}

private fun seriesKey(entry: Entry): String = Regex("(?i)(?:imdb:)?(tt\\d+)").find(entry.id)?.groupValues?.get(1)?.lowercase()
    ?: entry.title.replace(Regex("(?i)[ ._-]*s\\d+e\\d+.*$"), "").trim()

internal fun episodeOrder(id: String): Int {
    val code = label(id)
    return (code.substringAfter('S').substringBefore('E').toIntOrNull() ?: 0) * 10_000 +
        (code.substringAfter('E', "0").toIntOrNull() ?: 0)
}

private fun displayTitle(raw: String): Pair<String, String?> {
    val match = Regex("[ ._-]*\\(?((?:19|20)\\d{2})\\)?$").find(raw.trim())
    return if (match != null) raw.substring(0, match.range.first).trim() to match.groupValues[1] else raw to null
}

@Composable
private fun MovieCard(model: AppModel, entry: Entry, progress: WatchProgress?, dl: com.peartube.app.DownloadProgress?) {
    val (title, year) = displayTitle(entry.title)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(CardBg).clickable { model.playEntry(entry) }) {
        Row(Modifier.padding(start = 18.dp, end = 4.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(title, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Movie", color = Dim, fontSize = 12.sp)
                    Text(listOfNotNull(year, formatBytes(entry.size)).joinToString(" · ", prefix = "· "), color = Dim, fontSize = 12.sp)
                }
                SavedNote(entry, dl)
            }
            EntryActions(model, entry, dl != null, null)
        }
        EntryProgress(entry, progress, dl)
    }
}

@Composable
private fun SeriesCard(model: AppModel, rows: List<Entry>, history: Map<String, WatchProgress>, downloads: Map<String, com.peartube.app.DownloadProgress>, searching: Boolean) {
    val episodes = rows.distinctBy { it.id }.sortedBy { episodeOrder(it.id) }
    val seasons = episodes.map { label(it.id).substringBefore('E') }.distinct()
    var expanded by remember(seriesKey(episodes.first())) { mutableStateOf(false) }
    var season by remember(seasons) { mutableStateOf(seasons.first()) }
    val latest = episodes.mapNotNull { e -> history[e.key]?.let { e to it } }.maxByOrNull { it.second.updatedAt }
    val resume = latest?.takeIf { it.second.partial }?.first
        ?: latest?.let { pair -> episodes.getOrNull(episodes.indexOf(pair.first) + 1) }
    val next = resume ?: episodes.first()
    val title = episodes.first().title.replace(Regex("(?i)[ ._-]*s\\d+e\\d+.*$"), "").ifBlank { episodes.first().title }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(CardBg)) {
        Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(start = 18.dp, top = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(title, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 2)
                Text("${episodes.size} episodes · ${seasons.size} ${if (seasons.size == 1) "season" else "seasons"}", color = Dim, fontSize = 12.sp)
            }
            CinemaIcon(if (expanded || searching || rows.size <= 2) ChevronDownIcon else ChevronRightIcon, "Expand series") { expanded = !expanded }
        }
        TextButton(onClick = { model.playEntry(next) }, modifier = Modifier.padding(start = 8.dp, bottom = 4.dp)) {
            Icon(PlayIcon, null, tint = Brand, modifier = Modifier.size(18.dp))
            Text("${if (latest != null && resume != null) "Resume" else "Play"} ${label(next.id)}", color = Brand, modifier = Modifier.padding(start = 4.dp))
        }
        AnimatedVisibility(expanded || searching || rows.size <= 2) {
            Column {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    seasons.forEach { s -> FilterChip(selected = season == s, onClick = { season = s }, label = { Text(s) }) }
                }
                episodes.filter { label(it.id).startsWith(season) }.forEach { episode ->
                    val epCode = label(episode.id)
                    val dlName = if (episode.title.contains(epCode, ignoreCase = true)) episode.title else "${episode.title} $epCode"
                    val epDl = downloads[episode.key]
                    HorizontalDivider(color = Line.copy(alpha = .5f))
                    Column {
                        Row(Modifier.fillMaxWidth().clickable { model.playEntry(episode) }.padding(start = 18.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f).padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(epCode, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                Text(formatBytes(episode.size), color = Dim, fontSize = 12.sp)
                                SavedNote(episode, epDl)
                            }
                            EntryActions(model, episode, epDl != null, dlName)
                        }
                        EntryProgress(episode, history[episode.key], epDl)
                    }
                }
            }
        }
    }
}

@Composable
private fun SavedNote(entry: Entry, dl: com.peartube.app.DownloadProgress?) {
    if (entry.locked) {
        Text("Subscriber pass needed", color = Danger, fontSize = 11.sp)
    } else if (dl != null) {
        val labelText = if (dl.total > 0L) "Downloading ${(dl.bytes * 100L / dl.total).coerceIn(0L, 100L)}%" else "Downloading ${formatBytes(dl.bytes)}"
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Box(Modifier.size(4.dp).background(Accent, CircleShape))
            Text(labelText, color = Accent, fontSize = 11.sp)
        }
    } else if (entry.local || (entry.size > 0 && entry.cachedBytes >= entry.size)) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Box(Modifier.size(4.dp).background(Accent, CircleShape))
        Text(if (entry.isPrivate) "Saved · Subscribers only" else "Saved", color = Accent, fontSize = 11.sp)
    } else if (entry.isPrivate) {
        Text("Subscribers only", color = Dim, fontSize = 11.sp)
    }
}

@Composable
private fun EntryProgress(entry: Entry, progress: WatchProgress?, dl: com.peartube.app.DownloadProgress?) {
    val fraction = when {
        dl != null && dl.total > 0L -> (dl.bytes.toFloat() / dl.total).coerceAtLeast(0.02f)
        progress?.partial == true && progress.durationMs > 0 -> progress.positionMs.toFloat() / progress.durationMs
        !entry.local && entry.size > 0 && entry.cachedBytes in 1 until entry.size -> entry.cachedBytes.toFloat() / entry.size
        else -> 0f
    }
    if (fraction > 0) LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(2.dp), color = if (dl != null) Accent else if (progress?.partial == true) Brand else Accent, trackColor = Line)
}

@Composable
private fun EntryActions(model: AppModel, entry: Entry, isDownloading: Boolean, downloadName: String?) {
    var menu by remember { mutableStateOf(false) }
    val status by model.status.collectAsState()
    val clipboard = LocalClipboardManager.current
    val canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == entry.source } == true
    if (!entry.locked) {
        CinemaIcon(CastIcon, "Cast ${entry.title}") { model.castEntryOrSheet(entry, model.watchHistory.value[entry.key]?.takeIf { it.partial }?.positionMs ?: 0L) }
        if (isDownloading) {
            CinemaIcon(CloseIcon, "Cancel download ${entry.title}", Accent) { model.cancelDownload(entry.key) }
        } else {
            CinemaIcon(DownloadIcon, "Download ${entry.title}") { model.downloadEntry(entry, downloadName) }
        }
    }
    Box {
        CinemaIcon(MoreVertIcon, "More options") { menu = true }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (!entry.locked) {
                DropdownMenuItem(text = { Text("Cast to TV…") }, onClick = { menu = false; model.castEntryOrSheet(entry, model.watchHistory.value[entry.key]?.takeIf { it.partial }?.positionMs ?: 0L) })
                if (isDownloading) {
                    DropdownMenuItem(text = { Text("Cancel Download") }, onClick = { menu = false; model.cancelDownload(entry.key) })
                } else {
                    DropdownMenuItem(text = { Text("Download Video") }, onClick = { menu = false; model.downloadEntry(entry, downloadName) })
                }
            }
            if (entry.magnetUrl.isNotBlank()) DropdownMenuItem(text = { Text("Copy Magnet Link") }, onClick = { menu = false; clipboard.setText(AnnotatedString(entry.magnetUrl)) })
            if (!entry.local && entry.cachedBytes > 0) DropdownMenuItem(text = { Text("Free Up Cache") }, onClick = { menu = false; model.clearCache(entry.key) })
            if (canDelete) DropdownMenuItem(text = { Text("Delete from Channel", color = Danger) }, onClick = { menu = false; model.removeChannelEntry(entry.key) })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UnderTheHood(model: AppModel, onClose: () -> Unit, onAdd: () -> Unit) {
    val status by model.status.collectAsState()
    val identity by model.identity.collectAsState()
    val settings by model.settings.collectAsState()
    val clipboard = LocalClipboardManager.current
    var engine by remember { mutableStateOf(false) }
    var share by remember { mutableStateOf(false) }
    val peers = status?.let { it.peers + it.lanPeers } ?: 0L
    ModalBottomSheet(onDismissRequest = onClose, containerColor = CardBg, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Under the Hood", color = Ink, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                CinemaIcon(CloseIcon, "Close Under the Hood", onClick = onClose)
            }
            Text("A little cinema, anywhere.", color = Dim)
            Text(if ((status?.lanPeers ?: 0) > 0) "Local Wi-Fi Turbo active" else if (peers > 0) "Connected to $peers peers" else "Finding your people…", color = Accent)
            HorizontalDivider(color = Line)
            Text("Channels & Account", color = Ink, fontWeight = FontWeight.SemiBold)
            val sources = status?.sources.orEmpty()
            if (sources.isNotEmpty()) sources.forEach { Text(it.alias.ifBlank { "Channel ${it.key.take(8)}" }, color = Dim) }
            else {
                if (settings.tracker.isNotEmpty()) Text("Primary channel", color = Dim)
                settings.sources.forEach { Text(it.alias.ifBlank { "Channel ${it.key.take(8)}" }, color = Dim) }
            }
            status?.discoveredSources.orEmpty().forEach { found ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(found.title, color = Ink, modifier = Modifier.weight(1f))
                    TextButton(onClick = { model.subscribeDiscovered(found) }) { Text("+ Follow", color = Brand) }
                }
            }
            TextButton(onClick = onAdd) { Icon(AddIcon, null, tint = Brand); Text("Add Channel or Link", color = Brand) }
            status?.channel?.takeIf { it.isNotBlank() }?.let { channel ->
                TextButton(onClick = { share = !share }) { Icon(ShareIcon, null, tint = Brand); Text("Share My Channel", color = Brand) }
                AnimatedVisibility(share) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                        QrCodeView("peartube://channel/$channel", Modifier.size(240.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { clipboard.setText(AnnotatedString("peartube://channel/$channel")) }) { Text("Copy Link", color = Brand) }
                            status?.writer?.takeIf { it.isNotBlank() }?.let { wKey ->
                                TextButton(onClick = { clipboard.setText(AnnotatedString(wKey)) }) { Text("Copy Device Key", color = Dim) }
                            }
                        }
                    }
                }
                if (identity?.mnemonicSet == true) {
                    TextButton(onClick = { model.copyRecoveryPhrase { clipboard.setText(AnnotatedString(it)) } }) {
                        Text("Copy 12-Word Recovery Phrase", color = Brand)
                    }
                }
                identity?.accessUri?.takeIf { it.isNotBlank() }?.let { passUri ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Subscriber pass · Epoch ${identity?.epoch ?: 1L}", color = Dim, modifier = Modifier.weight(1f), fontSize = 13.sp)
                        TextButton(onClick = { clipboard.setText(AnnotatedString(passUri)) }) { Text("Copy Pass", color = Brand) }
                        TextButton(onClick = { model.rotateSubscriberPass() }) { Text("Rotate", color = Dim) }
                    }
                }
                val linkedWriters = identity?.writers.orEmpty()
                if (linkedWriters.size > 1) {
                    linkedWriters.forEach { w ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("${w.alias.ifBlank { w.key.take(8) }}${if (w.selfDevice) " (this phone)" else " · ${w.role}"}", color = Dim, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            if (w.key != channel) {
                                TextButton(onClick = { model.revokeLinkedWriter(w.key) }) { Text("Remove", color = Danger) }
                            }
                        }
                    }
                }
            }
            HorizontalDivider(color = Line)
            val savedCache = status?.cachedBytes ?: 0L
            Text(if (savedCache > 0L) "Storage · ${formatBytes(savedCache)} cached" else "Storage · No cached video", color = Dim)
            TextButton(onClick = { model.clearCache() }) {
                Icon(DeleteSweepIcon, null, tint = Dim)
                Text(if (savedCache > 0L) "Free up downloaded cache" else "Compact storage cache", color = Ink)
            }
            HorizontalDivider(color = Line)
            Row(Modifier.fillMaxWidth().clickable { engine = !engine }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Engine Room", color = Dim, modifier = Modifier.weight(1f))
                Icon(if (engine) ChevronDownIcon else ChevronRightIcon, null, tint = Dim)
            }
            AnimatedVisibility(engine) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("$peers peers · ${sources.size} sources · ${formatBytes(status?.blobBytes ?: 0L)}", color = Dim, fontSize = 12.sp)
                    status?.lan?.let { Text("LAN $it", color = Dim, fontSize = 12.sp) }
                    p2pSummary(status)?.let { Text(it, color = Brand, fontSize = 12.sp) }
                }
            }
        }
    }
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Ink, unfocusedTextColor = Ink,
    focusedContainerColor = CardBg, unfocusedContainerColor = CardBg,
    focusedBorderColor = Brand, unfocusedBorderColor = Line,
    focusedPlaceholderColor = Dim, unfocusedPlaceholderColor = Dim, cursorColor = Brand,
)
