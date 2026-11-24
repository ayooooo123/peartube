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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.peartube.app.AppModel
import com.peartube.app.DownloadProgress
import com.peartube.app.Entry
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.Screen
import com.peartube.app.WatchProgress
import com.peartube.app.findStartedVideos
import com.peartube.app.formatDurationWords
import com.peartube.app.formatTimeLeft
import com.peartube.app.indexLetter
import com.peartube.app.isSaved
import com.peartube.app.nextEpisodeForSeries
import com.peartube.app.pickSurpriseVideo
import com.peartube.app.plural
import com.peartube.app.primaryEntryForVideo
import com.peartube.app.sortTitleKey
import com.peartube.app.tileFactsLine
import com.peartube.app.tileStateLabel
import com.peartube.shared.formatBytes
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Calendar
import java.util.Locale

private enum class WatchView(val label: String) {
    Rows("Rows"),
    Tonight("Tonight"),
    Store("Store"),
    Channels("Channels"),
}

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

    var view by rememberSaveable { mutableStateOf(WatchView.Rows) }
    var filter by rememberSaveable { mutableStateOf(WatchFilter.All) }
    var savedOnly by rememberSaveable { mutableStateOf(false) }
    var sourceKey by rememberSaveable { mutableStateOf<String?>(null) }
    var coverTile by remember { mutableStateOf<LibraryTile?>(null) }

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
        // Segmented view switcher: Rows / Tonight / Store / Channels
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp)
                .clip(ControlShape)
                .background(CardBg)
                .border(1.dp, Line, ControlShape)
                .padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            WatchView.entries.forEach { item ->
                val selected = view == item
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (selected) CardElevated else Color.Transparent)
                        .clickable { view = item }
                        .padding(vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = item.label,
                        color = if (selected) Ink else Dim,
                        fontSize = 12.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        maxLines = 1,
                    )
                }
            }
        }

        // Top action bar: Play something + count
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            QuietActionButton(
                text = "Play something",
                icon = DiceIcon,
                onClick = { model.playSurpriseVideo(allVideos.ifEmpty { catalog.videos }) },
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = plural(catalog.videos.size, "title", "titles"),
                color = Dim,
                fontSize = 12.sp,
            )
        }

        when (view) {
            WatchView.Rows -> {
                LazyRow(
                    Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
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
                } else {
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
            WatchView.Tonight -> {
                WatchTonightView(
                    model = model,
                    videos = catalog.videos,
                    history = history,
                    onOpenTitle = onOpenTitle,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            WatchView.Store -> {
                WatchStoreView(
                    catalog = catalog,
                    history = history,
                    onInspect = { coverTile = it },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            WatchView.Channels -> {
                WatchChannelsView(
                    model = model,
                    catalog = catalog,
                    history = history,
                    onInspect = { coverTile = it },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
        }
    }

    coverTile?.let { tile ->
        VideoCoverDialog(
            tile = tile,
            history = history,
            onDismiss = { coverTile = null },
            onPlay = { entry ->
                coverTile = null
                model.playEntry(entry)
            },
            onDetails = {
                coverTile = null
                onOpenTitle(tile.key)
            },
        )
    }
}

// ---- Tonight view: three decision cards + A-Z jump strip & alphabetical index

@Composable
private fun WatchTonightView(
    model: AppModel,
    videos: List<LibraryTile>,
    history: Map<String, WatchProgress>,
    onOpenTitle: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val started = remember(videos, history) { findStartedVideos(videos, history) }
    val startedByTile = remember(started) { started.associateBy { it.tile.key } }
    val continueInfo = remember(started) { started.firstOrNull { it.progress.positionMs > 0L } }
    val nextSeriesCard = remember(videos, history, started, continueInfo) {
        val fromStarted = started.firstOrNull { it.tile.kind == LibraryKind.Series && it.tile.key != continueInfo?.tile?.key }
        if (fromStarted != null) {
            fromStarted.tile to fromStarted.entry
        } else {
            val activeSeries = videos.firstOrNull { tile ->
                tile.kind == LibraryKind.Series &&
                    tile.key != continueInfo?.tile?.key &&
                    tile.items.any { history.containsKey(it.entry.key) }
            }
            activeSeries?.let { s -> nextEpisodeForSeries(s, history)?.let { ep -> s to ep } }
        }
    }

    var surpriseKey by rememberSaveable { mutableStateOf<String?>(null) }
    val surpriseTile = remember(videos, history, surpriseKey) {
        videos.firstOrNull { it.key == surpriseKey } ?: pickSurpriseVideo(videos, history)
    }

    val sortedVideos = remember(videos) {
        videos.sortedWith(compareBy<LibraryTile>({ sortTitleKey(it.title) }, { it.title.lowercase(Locale.ROOT) }))
    }
    val grouped = remember(sortedVideos) {
        val map = LinkedHashMap<Char, MutableList<LibraryTile>>()
        for (tile in sortedVideos) {
            map.getOrPut(indexLetter(tile.title)) { mutableListOf() }.add(tile)
        }
        map.entries.map { it.key to it.value.toList() }
    }
    val letters = remember(grouped) { grouped.map { it.first } }

    // Precompute LazyColumn item indices for each letter header.
    val headerCountBeforeIndex = (if (continueInfo != null) 1 else 0) +
        (if (nextSeriesCard != null) 1 else 0) +
        (if (surpriseTile != null) 1 else 0) +
        (if (letters.isNotEmpty()) 1 else 0)
    val letterOffsets = remember(grouped, headerCountBeforeIndex) {
        val offsets = HashMap<Char, Int>()
        var cursor = headerCountBeforeIndex
        for ((letter, groupTiles) in grouped) {
            offsets[letter] = cursor
            cursor += 1 + groupTiles.size
        }
        offsets
    }

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(top = 6.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (continueInfo != null) {
            item(key = "tonight-continue") {
                val epLabel = if (continueInfo.tile.kind == LibraryKind.Series && continueInfo.entry.isEpisode) {
                    "${continueInfo.entry.episodeLabel} · "
                } else {
                    ""
                }
                val timePart = if (continueInfo.progress.durationMs > 0L) {
                    formatTimeLeft(continueInfo.progress.durationMs - continueInfo.progress.positionMs)
                } else {
                    "In progress"
                }
                TonightDecisionCard(
                    eyebrow = "Continue",
                    tile = continueInfo.tile,
                    subtitle = "$epLabel$timePart",
                    progress = if (continueInfo.progress.durationMs > 0L) continueInfo.fraction else null,
                    primary = true,
                    onPlay = { model.playEntry(continueInfo.entry) },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }

        if (nextSeriesCard != null) {
            item(key = "tonight-next") {
                val (seriesTile, nextEp) = nextSeriesCard
                val epProg = history[nextEp.key]?.takeIf { it.partial }
                val sub = if (epProg != null && epProg.durationMs > 0L) {
                    "${nextEp.episodeLabel} · ${formatTimeLeft(epProg.durationMs - epProg.positionMs)}"
                } else {
                    "${nextEp.episodeLabel} · ${tileFactsLine(seriesTile)}"
                }
                val frac = epProg?.takeIf { it.durationMs > 0L }?.let { it.positionMs.toFloat() / it.durationMs }
                TonightDecisionCard(
                    eyebrow = "Next episode",
                    tile = seriesTile,
                    subtitle = sub,
                    progress = frac,
                    primary = continueInfo == null,
                    onPlay = { model.playEntry(nextEp) },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }

        if (surpriseTile != null) {
            item(key = "tonight-surprise") {
                val entry = primaryEntryForVideo(surpriseTile, history)
                TonightDecisionCard(
                    eyebrow = "Surprise me",
                    tile = surpriseTile,
                    subtitle = tileFactsLine(surpriseTile),
                    progress = null,
                    primary = continueInfo == null && nextSeriesCard == null,
                    onPlay = { entry?.let { model.playEntry(it) } },
                    secondaryLabel = "Another",
                    secondaryIcon = DiceIcon,
                    onSecondary = {
                        val next = pickSurpriseVideo(videos, history, excludeKey = surpriseTile.key)
                        surpriseKey = next?.key
                    },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }

        if (letters.isNotEmpty()) {
            item(key = "az-strip") {
                LazyRow(
                    Modifier.fillMaxWidth().padding(top = 6.dp),
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(letters, key = { "az-btn-$it" }) { ch ->
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(CardBg)
                                .border(1.dp, Line, RoundedCornerShape(8.dp))
                                .clickable {
                                    val targetIdx = letterOffsets[ch] ?: return@clickable
                                    scope.launch { listState.animateScrollToItem(targetIdx) }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(ch.toString(), color = Ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }

        grouped.forEach { (letter, groupTiles) ->
            item(key = "az-head-$letter") {
                Text(
                    text = letter.toString(),
                    color = Dim,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 2.dp),
                )
            }
            items(groupTiles, key = { "az-row-${it.key}" }) { tile ->
                val resume = startedByTile[tile.key]
                val (_, isOk) = tileStateLabel(tile)
                val hue = (tile.seed % 360L).toFloat()
                val sub = if (resume != null) {
                    val epPrefix = if (tile.kind == LibraryKind.Series && resume.entry.isEpisode) "${resume.entry.episodeLabel} · " else ""
                    val leftPart = if (resume.progress.durationMs > 0L) formatTimeLeft(resume.progress.durationMs - resume.progress.positionMs) else "In progress"
                    "$epPrefix$leftPart"
                } else {
                    tileFactsLine(tile)
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenTitle(tile.key) }
                        .padding(horizontal = 16.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        Modifier
                            .width(4.dp)
                            .height(26.dp)
                            .clip(PillShape)
                            .background(Color.hsl(hue, 0.55f, 0.50f)),
                    )
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sub, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (isOk) Accent else if (tile.saved > 0 || tile.partial) Warn else Line),
                    )
                }
                HorizontalDivider(color = Line.copy(alpha = 0.45f), modifier = Modifier.padding(horizontal = 16.dp))
            }
        }
    }
}

@Composable
private fun TonightDecisionCard(
    eyebrow: String,
    tile: LibraryTile,
    subtitle: String,
    progress: Float?,
    primary: Boolean,
    onPlay: () -> Unit,
    modifier: Modifier = Modifier,
    secondaryLabel: String? = null,
    secondaryIcon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    onSecondary: (() -> Unit)? = null,
) {
    val hue = (tile.seed % 360L).toFloat()
    val tint = Color.hsl(hue, 0.34f, 0.15f)
    val (stateText, isOk) = tileStateLabel(tile)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(Brush.linearGradient(listOf(tint, CardBg)))
            .border(1.dp, Line, CardShape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(eyebrow, color = if (primary) BrandRing else Dim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Text(tile.title, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(subtitle, color = Dim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text("· $stateText", color = if (isOk) Accent else Dim, fontSize = 12.sp, maxLines = 1)
        }
        if (progress != null && progress > 0f) {
            LinearProgressIndicator(
                progress = { progress.coerceIn(0.03f, 1f) },
                modifier = Modifier.fillMaxWidth().height(3.dp).clip(PillShape),
                color = Brand,
                trackColor = Line,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (primary) {
                PrimaryLightButton(text = "Play", icon = PlayIcon, onClick = onPlay)
            } else {
                QuietActionButton(text = "Play", icon = PlayIcon, onClick = onPlay)
            }
            if (secondaryLabel != null && onSecondary != null) {
                QuietActionButton(text = secondaryLabel, icon = secondaryIcon, onClick = onSecondary)
            }
        }
    }
}

// ---- Video store view: horizontal shelves of vertical spines + cover dialog

@Composable
private fun WatchStoreView(
    catalog: LibraryCatalog,
    history: Map<String, WatchProgress>,
    onInspect: (LibraryTile) -> Unit,
    modifier: Modifier = Modifier,
) {
    val startedKeys = remember(catalog.videos, history) {
        findStartedVideos(catalog.videos, history).map { it.tile.key }.toSet()
    }
    val shelves = remember(catalog) {
        buildList {
            if (catalog.series.isNotEmpty()) add("Series" to catalog.series)
            if (catalog.movies.isNotEmpty()) add("Films" to catalog.movies)
            if (catalog.clips.isNotEmpty()) add("Clips" to catalog.clips.take(120))
        }
    }

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(top = 6.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        shelves.forEach { (heading, tiles) ->
            item(key = "store-shelf-$heading") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionHeader(title = heading)
                    Column {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.Bottom,
                        ) {
                            items(tiles, key = { "spine-${it.key}" }) { tile ->
                                VideoSpine(
                                    tile = tile,
                                    inProgress = tile.key in startedKeys,
                                    onClick = { onInspect(tile) },
                                )
                            }
                        }
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp)
                                .height(6.dp)
                                .clip(RoundedCornerShape(bottomStart = 4.dp, bottomEnd = 4.dp))
                                .background(CardElevated)
                                .border(1.dp, Line, RoundedCornerShape(bottomStart = 4.dp, bottomEnd = 4.dp)),
                        )
                    }
                }
            }
        }
    }
}

private fun Modifier.verticalSpineText(): Modifier = layout { measurable, constraints ->
    val placeable = measurable.measure(
        constraints.copy(
            minWidth = constraints.minHeight,
            maxWidth = constraints.maxHeight,
            minHeight = constraints.minWidth,
            maxHeight = constraints.maxWidth,
        ),
    )
    layout(placeable.height, placeable.width) {
        placeable.place(
            x = (placeable.height - placeable.width) / 2,
            y = (placeable.width - placeable.height) / 2,
        )
    }
}.rotate(-90f)

@Composable
private fun VideoSpine(
    tile: LibraryTile,
    inProgress: Boolean,
    onClick: () -> Unit,
) {
    val seasons = remember(tile) {
        if (tile.kind == LibraryKind.Series) {
            tile.items.mapNotNull { it.season }.distinct().size.coerceAtLeast(1)
        } else {
            1
        }
    }
    val widthDp = when (tile.kind) {
        LibraryKind.Series -> (46 + 8 * seasons.coerceAtMost(5)).dp
        LibraryKind.Movie -> 44.dp
        LibraryKind.Clip -> 34.dp
        LibraryKind.Album -> 40.dp
    }
    val heightDp = (164 + (tile.seed % 5L).toInt() * 6).dp
    val hue = (tile.seed % 360L).toFloat()
    val bodyTop = Color.hsl(hue, 0.42f, 0.24f)
    val bodyBottom = Color.hsl((hue + 14f) % 360f, 0.36f, 0.14f)
    val edge = Color.hsl(hue, 0.48f, 0.38f)
    val shape = RoundedCornerShape(topStart = 5.dp, topEnd = 5.dp, bottomStart = 2.dp, bottomEnd = 2.dp)

    Column(
        modifier = Modifier
            .width(widthDp)
            .height(heightDp)
            .clip(shape)
            .background(Brush.verticalGradient(listOf(bodyTop, bodyBottom)))
            .border(1.dp, if (inProgress) Brand else edge.copy(alpha = 0.55f), shape)
            .clickable(onClick = onClick)
            .padding(vertical = 7.dp, horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        if (tile.kind == LibraryKind.Series) {
            Text(
                text = "×${tile.items.size}",
                color = Ink.copy(alpha = 0.85f),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        } else {
            Spacer(Modifier.height(6.dp))
        }

        Box(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(vertical = 4.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = tile.title,
                color = Ink,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.verticalSpineText(),
            )
        }

        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(
                    when {
                        tile.allSaved -> Accent
                        tile.saved > 0 || tile.partial -> Warn
                        else -> Color.White.copy(alpha = 0.25f)
                    },
                ),
        )
    }
}

// ---- Channels view: 3 deterministic pseudo-live channels + 4-hour guide

private const val FALLBACK_EPISODE_SEC = 42L * 60L
private const val FALLBACK_MOVIE_SEC = 100L * 60L
private const val FALLBACK_CLIP_SEC = 20L * 60L
private const val GUIDE_SPAN_SEC = 4L * 3600L

private data class ChannelProgramme(
    val tile: LibraryTile,
    val entry: Entry,
    val sub: String,
    val durationSec: Long,
)

private data class ChannelBlock(
    val item: ChannelProgramme,
    val fromSec: Long,
    val toSec: Long,
    val intoSec: Long,
    val isLive: Boolean,
)

private data class LaidChannel(
    val number: Int,
    val name: String,
    val blocks: List<ChannelBlock>,
    val live: ChannelBlock,
)

private fun formatHhMm(secOfDay: Long): String {
    val norm = ((secOfDay % 86400L) + 86400L) % 86400L
    val h = norm / 3600L
    val m = (norm % 3600L) / 60L
    return "%02d:%02d".format(Locale.ROOT, h, m)
}

private fun buildChannelProgrammes(
    tiles: List<LibraryTile>,
    kind: LibraryKind,
    history: Map<String, WatchProgress>,
): List<ChannelProgramme> {
    val saved = tiles.filter { it.saved > 0 || it.allSaved }
    val source = if (saved.isNotEmpty()) saved else tiles
    return when (kind) {
        LibraryKind.Series -> source.flatMap { tile ->
            tile.items.take(6).map { item ->
                val knownSec = history[item.entry.key]?.durationMs?.takeIf { it > 0L }?.div(1000L)
                ChannelProgramme(
                    tile = tile,
                    entry = item.entry,
                    sub = item.entry.episodeLabel,
                    durationSec = (knownSec ?: FALLBACK_EPISODE_SEC).coerceAtLeast(60L),
                )
            }
        }
        LibraryKind.Movie -> source.mapNotNull { tile ->
            val entry = tile.items.firstOrNull()?.entry ?: return@mapNotNull null
            val knownSec = history[entry.key]?.durationMs?.takeIf { it > 0L }?.div(1000L)
            val dur = (knownSec ?: FALLBACK_MOVIE_SEC).coerceAtLeast(60L)
            ChannelProgramme(
                tile = tile,
                entry = entry,
                sub = formatDurationWords(dur),
                durationSec = dur,
            )
        }
        LibraryKind.Clip -> source.mapNotNull { tile ->
            val entry = tile.items.firstOrNull()?.entry ?: return@mapNotNull null
            val knownSec = history[entry.key]?.durationMs?.takeIf { it > 0L }?.div(1000L)
            val dur = (knownSec ?: FALLBACK_CLIP_SEC).coerceAtLeast(60L)
            ChannelProgramme(
                tile = tile,
                entry = entry,
                sub = formatDurationWords(dur),
                durationSec = dur,
            )
        }
        LibraryKind.Album -> emptyList()
    }
}

private fun layoutChannel(
    number: Int,
    name: String,
    programmes: List<ChannelProgramme>,
    startSec: Long,
    nowSec: Long,
): LaidChannel? {
    if (programmes.isEmpty()) return null
    val total = programmes.sumOf { it.durationSec }.coerceAtLeast(60L)
    var at = ((startSec % total) + total) % total
    var idx = 0
    while (at >= programmes[idx].durationSec) {
        at -= programmes[idx].durationSec
        idx = (idx + 1) % programmes.size
    }
    val blocks = mutableListOf<ChannelBlock>()
    var cursor = startSec
    val endLimit = startSec + GUIDE_SPAN_SEC
    while (cursor < endLimit) {
        val item = programmes[idx]
        val remaining = (item.durationSec - at).coerceAtLeast(60L)
        val to = minOf(cursor + remaining, endLimit)
        val live = nowSec >= cursor && nowSec < cursor + remaining
        blocks.add(ChannelBlock(item = item, fromSec = cursor, toSec = to, intoSec = at, isLive = live))
        cursor += remaining
        at = 0L
        idx = (idx + 1) % programmes.size
    }
    val liveBlock = blocks.firstOrNull { it.isLive } ?: blocks.first()
    return LaidChannel(number = number, name = name, blocks = blocks, live = liveBlock)
}

@Composable
private fun WatchChannelsView(
    model: AppModel,
    catalog: LibraryCatalog,
    history: Map<String, WatchProgress>,
    onInspect: (LibraryTile) -> Unit,
    modifier: Modifier = Modifier,
) {
    var clockTick by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000L)
            clockTick = System.currentTimeMillis()
        }
    }

    val schedule = remember(catalog, history, clockTick) {
        val cal = Calendar.getInstance().apply { timeInMillis = clockTick }
        val nowSec = cal.get(Calendar.HOUR_OF_DAY) * 3600L + cal.get(Calendar.MINUTE) * 60L + cal.get(Calendar.SECOND)
        val startSec = (nowSec / 1800L) * 1800L
        val channels = listOfNotNull(
            layoutChannel(1, "Series", buildChannelProgrammes(catalog.series, LibraryKind.Series, history), startSec, nowSec),
            layoutChannel(2, "Films", buildChannelProgrammes(catalog.movies, LibraryKind.Movie, history), startSec, nowSec),
            layoutChannel(3, "Clips", buildChannelProgrammes(catalog.clips, LibraryKind.Clip, history), startSec, nowSec),
        )
        Triple(startSec, nowSec, channels)
    }
    val (startSec, nowSec, channels) = schedule

    if (channels.isEmpty()) {
        Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Text("No video channels available yet.", color = Dim, fontSize = 14.sp)
        }
        return
    }

    val dpPerMin = 4.dp
    val channelColWidth = 84.dp
    val guideScroll = rememberScrollState()

    LazyColumn(
        modifier = modifier,
        contentPadding = PaddingValues(top = 6.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "on-now-head") { SectionHeader("On now") }

        items(channels, key = { "on-now-${it.number}" }) { ch ->
            val live = ch.live
            val liveInto = (live.intoSec + (nowSec - live.fromSec)).coerceIn(0L, live.item.durationSec - 1L)
            val leftSec = (live.item.durationSec - liveInto).coerceAtLeast(1L)
            val pct = (liveInto.toFloat() / live.item.durationSec.toFloat()).coerceIn(0.02f, 1f)
            val hue = (live.item.tile.seed % 360L).toFloat()
            val tint = Color.hsl(hue, 0.34f, 0.15f)

            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .clip(CardShape)
                    .background(Brush.linearGradient(listOf(tint, CardBg)))
                    .border(1.dp, Line, CardShape)
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "CH ${ch.number} · ${ch.name} · on now",
                    color = BrandRing,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = live.item.tile.title,
                    color = Ink,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val subPrefix = if (live.item.tile.kind == LibraryKind.Series) "${live.item.sub} · " else ""
                Text(
                    text = "$subPrefix${formatTimeLeft(leftSec * 1000L)}",
                    color = Dim,
                    fontSize = 12.sp,
                )
                LinearProgressIndicator(
                    progress = { pct },
                    modifier = Modifier.fillMaxWidth().height(3.dp).clip(PillShape),
                    color = Brand,
                    trackColor = Line,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    PrimaryLightButton(
                        text = "Watch",
                        icon = PlayIcon,
                        onClick = { model.playEntry(live.item.entry, startPositionMs = liveInto * 1000L) },
                    )
                    QuietActionButton(
                        text = "Info",
                        onClick = { onInspect(live.item.tile) },
                    )
                }
            }
        }

        item(key = "guide-head") {
            SectionHeader("4-hour guide", modifier = Modifier.padding(top = 6.dp))
        }

        item(key = "guide-grid") {
            val totalGuideWidth = channelColWidth + dpPerMin * 240f
            val nowOffsetDp = channelColWidth + dpPerMin * ((nowSec - startSec).coerceAtLeast(0L) / 60f)
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp)
                    .clip(CardShape)
                    .background(CardBg)
                    .border(1.dp, Line, CardShape)
                    .horizontalScroll(guideScroll)
                    .padding(vertical = 10.dp),
            ) {
                Column(
                    modifier = Modifier.width(totalGuideWidth),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // Time ruler row
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Today",
                            color = Dim,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.width(channelColWidth).padding(start = 10.dp),
                        )
                        for (slot in 0 until 8) {
                            Text(
                                text = formatHhMm(startSec + slot * 1800L),
                                color = Dim,
                                fontSize = 11.sp,
                                modifier = Modifier.width(dpPerMin * 30f),
                            )
                        }
                    }

                    HorizontalDivider(color = Line, modifier = Modifier.width(totalGuideWidth))

                    // Channel rows
                    channels.forEach { ch ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.height(54.dp),
                        ) {
                            Column(
                                modifier = Modifier.width(channelColWidth).padding(horizontal = 10.dp),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text("CH ${ch.number}", color = Dim, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                Text(ch.name, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            }
                            ch.blocks.forEach { block ->
                                val mins = ((block.toSec - block.fromSec).toFloat() / 60f).coerceAtLeast(12f)
                                val blockWidth = (dpPerMin * mins - 4.dp).coerceAtLeast(52.dp)
                                val hue = (block.item.tile.seed % 360L).toFloat()
                                val bg = Color.hsl(hue, 0.34f, if (block.isLive) 0.22f else 0.14f)
                                Column(
                                    modifier = Modifier
                                        .padding(end = 4.dp)
                                        .width(blockWidth)
                                        .fillMaxHeight()
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(bg)
                                        .border(
                                            width = if (block.isLive) 1.5.dp else 1.dp,
                                            color = if (block.isLive) Brand else Line,
                                            shape = RoundedCornerShape(8.dp),
                                        )
                                        .clickable { onInspect(block.item.tile) }
                                        .padding(horizontal = 8.dp, vertical = 6.dp),
                                    verticalArrangement = Arrangement.Center,
                                ) {
                                    Text(
                                        text = block.item.tile.title,
                                        color = Ink,
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    val sub = if (block.item.tile.kind == LibraryKind.Series) {
                                        "${block.item.sub} · ${formatHhMm(block.fromSec)}"
                                    } else {
                                        formatHhMm(block.fromSec)
                                    }
                                    Text(
                                        text = sub,
                                        color = Dim,
                                        fontSize = 10.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }

                // Vertical live "now" marker
                Box(Modifier.matchParentSize()) {
                    Box(
                        Modifier
                            .offset(x = nowOffsetDp)
                            .width(2.dp)
                            .fillMaxHeight()
                            .background(Brand.copy(alpha = 0.8f)),
                    )
                }
            }
        }
    }
}

// ---- Cover modal dialog (used by Video store spines and Channels guide blocks)

@Composable
private fun VideoCoverDialog(
    tile: LibraryTile,
    history: Map<String, WatchProgress>,
    onDismiss: () -> Unit,
    onPlay: (Entry) -> Unit,
    onDetails: () -> Unit,
) {
    val primaryEntry = remember(tile, history) { primaryEntryForVideo(tile, history) }
    val prog = primaryEntry?.let { history[it.key]?.takeIf { p -> p.partial } }
    val (stateText, isOk) = tileStateLabel(tile)
    val facts = listOfNotNull(
        tileFactsLine(tile).takeIf { it.isNotBlank() },
        tile.totalSize.takeIf { it > 0L }?.let { formatBytes(it) },
    ).joinToString(" · ")

    Dialog(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(PanelShape)
                .background(CardBg)
                .border(1.dp, Line, PanelShape)
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = tile.title,
                    color = Ink,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                CinemaIcon(CloseIcon, "Close", Ink, onClick = onDismiss)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                if (tile.kind == LibraryKind.Clip) {
                    WideTitleArt(
                        title = tile.title,
                        seed = tile.seed,
                        badge = "Clip",
                        modifier = Modifier.width(126.dp),
                    )
                } else {
                    PosterArt(
                        title = tile.title,
                        year = tile.year,
                        seed = tile.seed,
                        modifier = Modifier.width(90.dp),
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (facts.isNotBlank()) {
                        Text(facts, color = Dim, fontSize = 13.sp)
                    }
                    Text(stateText, color = if (isOk) Accent else Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    if (prog != null) {
                        val epPrefix = if (tile.kind == LibraryKind.Series && primaryEntry.isEpisode) "${primaryEntry.episodeLabel} · " else ""
                        val timeText = if (prog.durationMs > 0L) formatTimeLeft(prog.durationMs - prog.positionMs) else "In progress"
                        Text("$epPrefix$timeText", color = Ink, fontSize = 12.sp)
                        if (prog.durationMs > 0L) {
                            LinearProgressIndicator(
                                progress = { (prog.positionMs.toFloat() / prog.durationMs.toFloat()).coerceIn(0.03f, 1f) },
                                modifier = Modifier.fillMaxWidth().height(3.dp).clip(PillShape),
                                color = Brand,
                                trackColor = Line,
                            )
                        }
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (primaryEntry != null) {
                    PrimaryLightButton(
                        text = if (prog != null) "Continue" else "Play",
                        icon = PlayIcon,
                        onClick = { onPlay(primaryEntry) },
                        modifier = Modifier.weight(1f),
                    )
                }
                QuietActionButton(
                    text = "Details",
                    onClick = onDetails,
                )
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
                            val detailFacts = when (tile.kind) {
                                LibraryKind.Movie -> listOfNotNull(
                                    tile.year,
                                    tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { formatBytes(it) },
                                    if (tile.items.size > 1) plural(tile.items.size, "version", "versions") else null,
                                ).joinToString(" · ")
                                LibraryKind.Clip -> tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { formatBytes(it) } ?: ""
                                else -> tileFactsLine(tile)
                            }
                            if (detailFacts.isNotBlank()) {
                                Text(detailFacts, color = Dim, fontSize = 13.sp)
                            }
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
