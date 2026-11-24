package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.DownloadProgress
import com.peartube.app.Entry
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.Screen
import com.peartube.app.WatchProgress
import com.peartube.app.formatTimeLeft
import com.peartube.app.isSaved
import com.peartube.app.plural
import com.peartube.app.tileFactsLine
import com.peartube.app.tileStateLabel
import com.peartube.shared.formatBytes

private enum class WatchFilter(val label: String) {
    All("All"),
    Movies("Movies"),
    Series("Series"),
    Clips("Clips"),
}

@Composable
fun WatchScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenTitle: (String) -> Unit,
) {
    val status by model.status.collectAsState()
    val history by model.watchHistory.collectAsState()
    val downloads by model.downloads.collectAsState()

    var filter by rememberSaveable { mutableStateOf(WatchFilter.All) }
    var savedOnly by rememberSaveable { mutableStateOf(false) }
    var sourceKey by rememberSaveable { mutableStateOf<String?>(null) }

    val allVideos = remember(catalog.videos, savedOnly, sourceKey) {
        catalog.videos.filter { tile ->
            (!savedOnly || tile.allSaved) &&
                (sourceKey == null || tile.items.any { it.entry.source == sourceKey })
        }
    }
    val movieCount = remember(allVideos) { allVideos.count { it.kind == LibraryKind.Movie } }
    val seriesCount = remember(allVideos) { allVideos.count { it.kind == LibraryKind.Series } }
    val clipCount = remember(allVideos) { allVideos.count { it.kind == LibraryKind.Clip } }

    val shown = remember(allVideos, filter) {
        when (filter) {
            WatchFilter.All -> allVideos
            WatchFilter.Movies -> allVideos.filter { it.kind == LibraryKind.Movie }
            WatchFilter.Series -> allVideos.filter { it.kind == LibraryKind.Series }
            WatchFilter.Clips -> allVideos.filter { it.kind == LibraryKind.Clip }
        }
    }
    val keepWatching = remember(allVideos, history, filter) {
        if (filter != WatchFilter.All) emptyList()
        else allVideos.mapNotNull { tile ->
            val best = tile.items.mapNotNull { item ->
                val p = history[item.entry.key] ?: return@mapNotNull null
                if (!p.partial) return@mapNotNull null
                val pct = if (p.durationMs > 0L) p.positionMs.toFloat() / p.durationMs else 0f
                if (p.durationMs > 0L && (pct < 0.01f || pct > 0.96f)) return@mapNotNull null
                Triple(item.entry, p, pct)
            }.maxByOrNull { it.second.updatedAt } ?: return@mapNotNull null
            tile to best
        }.sortedByDescending { it.second.second.updatedAt }
    }

    if (catalog.videos.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    if (catalog.albums.isNotEmpty()) "No video yet. Your albums are in Listen." else "Nothing in your library yet.",
                    color = Ink,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(4.dp))
                PrimaryLightButton("Add to library", onClick = { model.pushScreen(Screen.Settings) })
            }
        }
        return
    }

    val sources = status?.sources.orEmpty()
    val films = remember(shown) { shown.filter { it.kind != LibraryKind.Clip } }
    val clips = remember(shown) { shown.filter { it.kind == LibraryKind.Clip } }

    Column(Modifier.fillMaxSize()) {
        LazyRow(
            Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val chips = listOf(
                WatchFilter.All to allVideos.size,
                WatchFilter.Movies to movieCount,
                WatchFilter.Series to seriesCount,
                WatchFilter.Clips to clipCount,
            ).filter { it.first == WatchFilter.All || it.second > 0 }

            items(chips, key = { it.first.name }) { (kind, count) ->
                FilterChip(
                    selected = filter == kind,
                    onClick = { filter = kind },
                    label = { Text("${kind.label} $count", fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = Brand.copy(alpha = 0.22f),
                        selectedLabelColor = Ink,
                    ),
                )
            }
            item(key = "saved-here") {
                FilterChip(
                    selected = savedOnly,
                    onClick = { savedOnly = !savedOnly },
                    label = { Text("Saved here", fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = Brand.copy(alpha = 0.22f),
                        selectedLabelColor = Ink,
                    ),
                )
            }
            if (sources.size > 1) {
                items(sources, key = { "src-${it.key}" }) { ch ->
                    FilterChip(
                        selected = sourceKey == ch.key,
                        onClick = {
                            val next = if (sourceKey == ch.key) null else ch.key
                            sourceKey = next
                            if (next != null) model.focusSource(next)
                        },
                        label = { Text(ch.alias.ifBlank { "Channel ${ch.key.take(6)}" }, fontSize = 12.sp) },
                    )
                }
            }
        }

        if (shown.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(
                    if (savedOnly) "Nothing here is saved on this device." else "Nothing in this view.",
                    color = Dim,
                    fontSize = 14.sp,
                )
            }
            return
        }

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(top = 6.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (keepWatching.isNotEmpty()) {
                item(key = "keep-watching") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SectionHeader("Keep watching")
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(keepWatching, key = { it.second.first.key }) { (tile, triple) ->
                                val (entry, prog, pct) = triple
                                Column(
                                    Modifier.width(210.dp).clickable { model.playEntry(entry) },
                                    verticalArrangement = Arrangement.spacedBy(5.dp),
                                ) {
                                    WideTitleArt(
                                        title = tile.title,
                                        seed = tile.seed,
                                        badge = if (tile.kind == LibraryKind.Series) entry.episodeLabel else if (tile.kind == LibraryKind.Movie) "Movie" else "Clip",
                                        progress = pct,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    Text(
                                        text = if (tile.kind == LibraryKind.Series) "${tile.title} · ${entry.episodeLabel}" else tile.title,
                                        color = Ink,
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = if (prog.durationMs > 0L) formatTimeLeft(prog.durationMs - prog.positionMs) else "In progress",
                                        color = Dim,
                                        fontSize = 12.sp,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            if (films.isNotEmpty()) {
                if (keepWatching.isNotEmpty() || clips.isNotEmpty()) {
                    item(key = "films-head") { SectionHeader("Movies and series") }
                }
                items(films, key = { it.key }) { tile ->
                    WatchVideoCard(
                        model = model,
                        tile = tile,
                        history = history,
                        downloads = downloads,
                        onOpen = { onOpenTitle(tile.key) },
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }
            }

            if (clips.isNotEmpty()) {
                if (films.isNotEmpty() || keepWatching.isNotEmpty()) {
                    item(key = "clips-head") { SectionHeader("Clips") }
                }
                items(clips, key = { it.key }) { tile ->
                    ClipCard(
                        tile = tile,
                        onOpen = { onOpenTitle(tile.key) },
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun WatchVideoCard(
    model: AppModel,
    tile: LibraryTile,
    history: Map<String, WatchProgress>,
    downloads: Map<String, DownloadProgress>,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val first = tile.items.firstOrNull()?.entry ?: return
    val (stateText, isOk) = tileStateLabel(tile)
    if (tile.kind == LibraryKind.Series) {
        val episodes = tile.items.map { it.entry }
        val seasons = episodes.mapNotNull { it.seasonLabel }.distinct()
        val latest = episodes.mapNotNull { e -> history[e.key]?.let { e to it } }.maxByOrNull { it.second.updatedAt }
        val resume = latest?.takeIf { it.second.partial }?.first
            ?: latest?.let { pair -> episodes.getOrNull(episodes.indexOf(pair.first) + 1) }
        val next = resume ?: episodes.first()
        Column(
            modifier
                .fillMaxWidth()
                .clip(CardShape)
                .background(CardBg)
                .border(1.dp, Line, CardShape)
                .clickable(onClick = onOpen)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(tile.title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${plural(episodes.size, "episode", "episodes")} · ${plural(seasons.size.coerceAtLeast(1), "season", "seasons")}",
                        color = Dim,
                        fontSize = 12.sp,
                    )
                    Text(stateText, color = if (isOk) Accent else Dim, fontSize = 11.sp)
                }
                Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(20.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = { model.playEntry(next) },
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Icon(PlayIcon, null, tint = Brand, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text(
                        "${if (latest != null && resume != null) "Resume" else "Play"} ${next.episodeLabel}",
                        color = Brand,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
    } else {
        val progress = history[first.key]
        val dl = downloads[first.key]
        Column(
            modifier
                .fillMaxWidth()
                .clip(CardShape)
                .background(CardBg)
                .border(1.dp, Line, CardShape)
                .clickable(onClick = onOpen),
        ) {
            Row(
                Modifier.padding(start = 14.dp, end = 10.dp, top = 12.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text(tile.title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Movie", color = Dim, fontSize = 12.sp)
                        val detail = listOfNotNull(
                            tile.year,
                            if (tile.items.size > 1) "${tile.items.size} versions" else formatBytes(first.size),
                        ).joinToString(" · ")
                        if (detail.isNotEmpty()) Text("· $detail", color = Dim, fontSize = 12.sp)
                    }
                    Text(stateText, color = if (isOk) Accent else Dim, fontSize = 11.sp)
                }
                CinemaIcon(PlayIcon, "Play ${tile.title}", Ink) { model.playEntry(first) }
            }
            EntryProgressBar(first, progress, dl)
        }
    }
}

@Composable
private fun ClipCard(tile: LibraryTile, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val (stateText, isOk) = tileStateLabel(tile)
    Row(
        modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .clickable(onClick = onOpen)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        WideTitleArt(
            title = tile.title,
            seed = tile.seed,
            badge = "Clip",
            modifier = Modifier.width(116.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
            Text(stateText, color = if (isOk) Accent else Dim, fontSize = 11.sp)
        }
    }
}

@Composable
fun TitleDetailScreen(
    model: AppModel,
    tile: LibraryTile?,
    onBack: () -> Unit,
) {
    if (tile == null) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            DetailTopBar(title = "Title", onBack = onBack)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Title not found.", color = Dim)
            }
        }
        return
    }

    val history by model.watchHistory.collectAsState()
    val downloads by model.downloads.collectAsState()
    val status by model.status.collectAsState()
    val (stateText, isOk) = tileStateLabel(tile)

    val episodes = remember(tile) {
        if (tile.kind == LibraryKind.Series) tile.items.map { it.entry }.distinctBy { it.id } else emptyList()
    }
    val seasons = remember(episodes) { episodes.mapNotNull { it.seasonLabel }.distinct() }
    var selectedSeason by remember(tile.key, seasons) { mutableStateOf(seasons.firstOrNull() ?: "") }

    val primaryEntry = remember(tile, episodes, history) {
        if (tile.kind == LibraryKind.Series && episodes.isNotEmpty()) {
            val latest = episodes.mapNotNull { e -> history[e.key]?.let { e to it } }.maxByOrNull { it.second.updatedAt }
            val resume = latest?.takeIf { it.second.partial }?.first
                ?: latest?.let { pair -> episodes.getOrNull(episodes.indexOf(pair.first) + 1) }
            resume ?: episodes.first()
        } else {
            tile.items.firstOrNull()?.entry
        }
    }
    val primaryResume = primaryEntry?.let { history[it.key]?.takeIf { p -> p.partial } }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        DetailTopBar(title = "", onBack = onBack)
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(key = "title-header") {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (tile.kind == LibraryKind.Clip) {
                            WideTitleArt(title = tile.title, seed = tile.seed, badge = "Clip", modifier = Modifier.width(136.dp))
                        } else {
                            PosterArt(title = tile.title, year = tile.year, seed = tile.seed, modifier = Modifier.width(96.dp))
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                when (tile.kind) {
                                    LibraryKind.Movie -> "Movie"
                                    LibraryKind.Series -> "Series"
                                    LibraryKind.Clip -> "Clip"
                                    LibraryKind.Album -> "Album"
                                },
                                color = Dim,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(tile.title, color = Ink, fontSize = 21.sp, fontWeight = FontWeight.Bold, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            Text(tileFactsLine(tile), color = Dim, fontSize = 13.sp)
                            Text(stateText, color = if (isOk) Accent else Dim, fontSize = 12.sp)
                        }
                    }

                    if (primaryEntry != null) {
                        val playLabel = when {
                            tile.kind == LibraryKind.Series && primaryResume != null -> "Resume ${primaryEntry.episodeLabel}"
                            tile.kind == LibraryKind.Series -> "Next episode · ${primaryEntry.episodeLabel}"
                            primaryResume != null -> "Resume"
                            else -> "Play"
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            PrimaryLightButton(
                                text = playLabel,
                                icon = PlayIcon,
                                onClick = { model.playEntry(primaryEntry) },
                            )
                            if (!primaryEntry.locked) {
                                QuietActionButton(
                                    text = "Play on a TV",
                                    icon = TvIcon,
                                    onClick = {
                                        model.openTvsPickerForEntry(
                                            primaryEntry,
                                            history[primaryEntry.key]?.takeIf { it.partial }?.positionMs ?: 0L,
                                        )
                                    },
                                )
                            }
                        }
                    }
                }
            }

            if (tile.kind == LibraryKind.Series) {
                if (seasons.size > 1) {
                    item(key = "season-chips") {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            seasons.forEach { s ->
                                FilterChip(
                                    selected = selectedSeason == s,
                                    onClick = { selectedSeason = s },
                                    label = { Text(s) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = Brand.copy(alpha = 0.22f),
                                        selectedLabelColor = Ink,
                                    ),
                                )
                            }
                        }
                    }
                }
                val seasonEpisodes = episodes.filter { seasons.size <= 1 || it.seasonLabel == selectedSeason }
                item(key = "episodes-head") { SectionHeader("Episodes") }
                items(seasonEpisodes, key = { it.key }) { episode ->
                    val epCode = episode.episodeLabel
                    val dlName = if (episode.title.contains(epCode, ignoreCase = true)) episode.title else "${episode.title} $epCode"
                    FileVersionRow(
                        model = model,
                        entry = episode,
                        label = epCode,
                        subTitle = episode.title.takeIf { it != tile.title },
                        progress = history[episode.key],
                        download = downloads[episode.key],
                        downloadName = dlName,
                        canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == episode.source } == true,
                    )
                }
            } else {
                item(key = "versions-head") {
                    SectionHeader(if (tile.items.size > 1) "Versions" else "File")
                }
                items(tile.items, key = { it.entry.key }) { item ->
                    val entry = item.entry
                    FileVersionRow(
                        model = model,
                        entry = entry,
                        label = entry.title,
                        subTitle = null,
                        progress = history[entry.key],
                        download = downloads[entry.key],
                        downloadName = entry.title,
                        canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == entry.source } == true,
                    )
                }
            }
        }
    }
}

@Composable
private fun FileVersionRow(
    model: AppModel,
    entry: Entry,
    label: String,
    subTitle: String?,
    progress: WatchProgress?,
    download: DownloadProgress?,
    downloadName: String,
    canDelete: Boolean,
) {
    var menu by remember { mutableStateOf(false) }
    val copyText = rememberCopyText()
    val savedHere = isSaved(entry)
    val stateText = when {
        entry.locked -> "Subscriber pass needed"
        download != null && download.total > 0L -> "Downloading ${(download.bytes * 100L / download.total).coerceIn(0L, 100L)}%"
        download != null -> "Downloading ${formatBytes(download.bytes)}"
        savedHere -> "Saved here"
        entry.cachedBytes > 0L -> "Partly saved"
        else -> "On the network"
    }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .clickable { model.playEntry(entry) },
    ) {
        Row(
            Modifier.padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(label, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (!subTitle.isNullOrBlank()) {
                    Text(subTitle, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (savedHere && !entry.locked) Box(Modifier.size(5.dp).background(Accent, CircleShape))
                    Text(
                        listOfNotNull(
                            entry.size.takeIf { it > 0L }?.let { formatBytes(it) },
                            stateText,
                            progress?.takeIf { it.partial && it.durationMs > 0L }?.let { formatTimeLeft(it.durationMs - it.positionMs) },
                        ).joinToString(" · "),
                        color = if (entry.locked) Danger else if (savedHere) Accent else Dim,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (!entry.locked) {
                CinemaIcon(PlayIcon, "Play $label", Ink) { model.playEntry(entry) }
                CinemaIcon(TvIcon, "Play on a TV", Dim) {
                    model.openTvsPickerForEntry(entry, progress?.takeIf { it.partial }?.positionMs ?: 0L)
                }
            }
            Box {
                CinemaIcon(MoreVertIcon, "More options") { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (!entry.locked) {
                        DropdownMenuItem(
                            text = { Text("Play on a TV") },
                            onClick = {
                                menu = false
                                model.openTvsPickerForEntry(entry, progress?.takeIf { it.partial }?.positionMs ?: 0L)
                            },
                        )
                        if (download != null) {
                            DropdownMenuItem(
                                text = { Text("Cancel download") },
                                onClick = { menu = false; model.cancelDownload(entry.key) },
                            )
                        } else {
                            DropdownMenuItem(
                                text = { Text("Download") },
                                onClick = { menu = false; model.downloadEntry(entry, downloadName) },
                            )
                        }
                    }
                    if (entry.magnetUrl.isNotBlank()) {
                        DropdownMenuItem(
                            text = { Text("Copy link") },
                            onClick = { menu = false; copyText(entry.magnetUrl) },
                        )
                    }
                    if (!entry.local && entry.cachedBytes > 0L) {
                        DropdownMenuItem(
                            text = { Text("Free up cache") },
                            onClick = { menu = false; model.clearCache(entry.key) },
                        )
                    }
                    if (canDelete) {
                        DropdownMenuItem(
                            text = { Text("Delete", color = Danger) },
                            onClick = { menu = false; model.removeChannelEntry(entry.key) },
                        )
                    }
                }
            }
        }
        EntryProgressBar(entry, progress, download)
    }
}

@Composable
private fun EntryProgressBar(entry: Entry, progress: WatchProgress?, dl: DownloadProgress?) {
    val fraction = when {
        dl != null && dl.total > 0L -> (dl.bytes.toFloat() / dl.total).coerceAtLeast(0.02f)
        progress?.partial == true && progress.durationMs > 0L -> progress.positionMs.toFloat() / progress.durationMs
        !entry.local && entry.size > 0L && entry.cachedBytes in 1 until entry.size -> entry.cachedBytes.toFloat() / entry.size
        else -> 0f
    }
    if (fraction > 0f) {
        LinearProgressIndicator(
            progress = { fraction.coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth().height(2.dp),
            color = if (dl != null) Accent else if (progress?.partial == true) Brand else Accent,
            trackColor = Line,
        )
    }
}
