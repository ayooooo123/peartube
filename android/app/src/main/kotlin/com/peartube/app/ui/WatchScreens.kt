package com.peartube.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.peartube.app.AppModel
import com.peartube.app.CinemaEpisodeMeta
import com.peartube.app.CinemaTitleMeta
import com.peartube.app.DownloadProgress
import com.peartube.app.Entry
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.ExternalImageCache
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.Screen
import com.peartube.app.VideoResumeInfo
import com.peartube.app.WatchProgress
import com.peartube.app.findStartedVideos
import com.peartube.app.formatDurationWords
import com.peartube.app.formatTimeLeft
import com.peartube.app.imdbBackdropUrl
import com.peartube.app.imdbPosterUrl
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
    Series("TV Shows"),
    Clips("Videos"),
}

@Composable
fun WatchScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenTitle: (String) -> Unit,
    embedded: Boolean = false,
    bottomPadding: Dp = 24.dp,
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
    val startedVideos = remember(allVideos, history) {
        findStartedVideos(allVideos, history)
    }
    val featuredLocal = remember(allVideos) {
        allVideos.firstOrNull { it.allSaved }
            ?: allVideos.firstOrNull { it.saved > 0 }
            ?: allVideos.firstOrNull()
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
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(CardElevated),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(WatchIcon, null, tint = Dim, modifier = Modifier.size(34.dp))
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    if (catalog.albums.isNotEmpty()) "No video yet. Your albums are in Listen." else "Nothing in your library yet.",
                    color = Ink,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(4.dp))
                PrimaryBrandButton("Add to library", onClick = { model.pushScreen(Screen.Settings) })
            }
        }
        return
    }

    val sources = status?.sources.orEmpty()
    val films = remember(shown) { shown.filter { it.kind != LibraryKind.Clip } }
    val clips = remember(shown) { shown.filter { it.kind == LibraryKind.Clip } }

    Column(Modifier.fillMaxSize()) {
        if (!embedded) {
            // Watch display header + count / quick surprise action
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = "Watch",
                    color = Ink,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = (-0.5).sp,
                    modifier = Modifier.weight(1f),
                )
                if (view == WatchView.Store || view == WatchView.Channels) {
                    QuietActionButton(
                        text = "Play something",
                        icon = DiceIcon,
                        onClick = { model.playSurpriseVideo(allVideos.ifEmpty { catalog.videos }) },
                    )
                } else {
                    Text(
                        text = plural(catalog.videos.size, "title", "titles"),
                        color = Dim,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        if (!embedded) {
            // Segmented view switcher: Rows / Tonight / Store / Channels
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp)
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
                            .padding(vertical = 8.dp),
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
        }

        val effectiveView = if (embedded) WatchView.Rows else view
        when (effectiveView) {
            WatchView.Rows -> {
                if (embedded) {
                    // Streamlined single quiet pill filter row: All | Films | Series | Clips (if any) | Saved
                    LazyRow(
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val pills = buildList {
                            add(WatchFilter.All to "All")
                            if (movieCount > 0) add(WatchFilter.Movies to "Movies")
                            if (seriesCount > 0) add(WatchFilter.Series to "TV Shows")
                            if (clipCount > 0) add(WatchFilter.Clips to "Videos")
                        }
                        items(pills, key = { it.first.name }) { (kind, label) ->
                            val selected = filter == kind
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(if (selected) Pearl else GlassBg)
                                    .then(
                                        if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                    )
                                    .clickable { filter = kind }
                                    .padding(horizontal = 14.dp, vertical = 7.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = label,
                                    color = if (selected) PearlInk else Dim,
                                    fontSize = 12.sp,
                                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                )
                            }
                        }
                        item(key = "saved-pill") {
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(if (savedOnly) Brand.copy(alpha = 0.22f) else GlassBg)
                                    .border(
                                        width = 0.75.dp,
                                        color = if (savedOnly) Brand.copy(alpha = 0.65f) else GlassBorder,
                                        shape = PillShape,
                                    )
                                    .clickable { savedOnly = !savedOnly }
                                    .padding(horizontal = 14.dp, vertical = 7.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "Saved",
                                    color = if (savedOnly) Ink else Dim,
                                    fontSize = 12.sp,
                                    fontWeight = if (savedOnly) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                } else {
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
                }

                if (shown.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Text(
                            if (savedOnly) "Nothing here is saved on this device." else "Nothing in this view.",
                            color = Dim,
                            fontSize = 14.sp,
                        )
                    }
                } else if (embedded) {
                    // Airy 2-column real IMDb poster grid (3 columns on tablets), zero nested heroes or heavy card boxes
                    BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                        val columns = if (maxWidth >= 540.dp) 3 else 2
                        val filmRows = remember(films, columns) { films.chunked(columns) }

                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(top = 12.dp, bottom = bottomPadding),
                            verticalArrangement = Arrangement.spacedBy(18.dp),
                        ) {
                            if (filmRows.isNotEmpty()) {
                                items(filmRows.size, key = { idx -> "watch-grid-row-$idx" }) { rowIdx ->
                                    val rowTiles = filmRows[rowIdx]
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 20.dp),
                                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                                    ) {
                                        rowTiles.forEach { tile ->
                                            LibraryPosterGridCard(
                                                tile = tile,
                                                onOpen = { onOpenTitle(tile.key) },
                                                modifier = Modifier.weight(1f),
                                            )
                                        }
                                        repeat(columns - rowTiles.size) {
                                            Spacer(Modifier.weight(1f))
                                        }
                                    }
                                }
                            }

                            if (clips.isNotEmpty()) {
                                if (filmRows.isNotEmpty()) {
                                    item(key = "embedded-clips-head") {
                                        SectionHeader(title = "Clips", modifier = Modifier.padding(top = 8.dp))
                                    }
                                }
                                items(clips, key = { "embedded-clip-${it.key}" }) { tile ->
                                    Column(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 20.dp)
                                            .clickable { onOpenTitle(tile.key) },
                                        verticalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        WideTitleArt(
                                            title = tile.title,
                                            seed = tile.seed,
                                            kindLabel = posterKindLabel(tile.kind),
                                            imdb = tile.imdb,
                                            showTitleOverlay = false,
                                            borderless = true,
                                            modifier = Modifier.fillMaxWidth(),
                                        )
                                        Text(
                                            text = tile.title,
                                            color = Ink,
                                            fontSize = 14.sp,
                                            fontWeight = FontWeight.Medium,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        Text(
                                            text = tileFactsLine(tile),
                                            color = Dim,
                                            fontSize = 12.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                            }
                        }
                    }
                } else {
                    val heroStarted = startedVideos.firstOrNull()
                    val heroFeatured = featuredLocal ?: shown.firstOrNull()
                    LazyColumn(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        if (filter == WatchFilter.All && (heroStarted != null || heroFeatured != null)) {
                            item(key = "watch-featured-hero") {
                                WatchFeaturedHero(
                                    started = heroStarted,
                                    featured = heroFeatured,
                                    onContinue = { info -> model.playEntry(info.entry) },
                                    onPlaySomething = { model.playSurpriseVideo(allVideos.ifEmpty { catalog.videos }) },
                                    onDetails = { tileKey -> onOpenTitle(tileKey) },
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 16.dp),
                                )
                            }
                        }

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
                                                    badge = if (tile.kind == LibraryKind.Series) entry.episodeLabel else null,
                                                    progress = pct,
                                                    kindLabel = posterKindLabel(tile.kind),
                                                    imdb = tile.imdb,
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
                    bottomPadding = bottomPadding,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            WatchView.Store -> {
                WatchStoreView(
                    catalog = catalog,
                    history = history,
                    onInspect = { coverTile = it },
                    bottomPadding = bottomPadding,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            WatchView.Channels -> {
                WatchChannelsView(
                    model = model,
                    catalog = catalog,
                    history = history,
                    onInspect = { coverTile = it },
                    bottomPadding = bottomPadding,
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

// ---- Featured hero banner for Watch Rows

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WatchFeaturedHero(
    started: VideoResumeInfo?,
    featured: LibraryTile?,
    onContinue: (VideoResumeInfo) -> Unit,
    onPlaySomething: () -> Unit,
    onDetails: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val heroTile = started?.tile ?: featured ?: return
    val (stateText, isOk) = tileStateLabel(heroTile)
    val eyebrow = when {
        started != null -> "CONTINUE"
        heroTile.allSaved || heroTile.saved > 0 -> "ON THIS RELAY"
        else -> "FEATURED"
    }
    val isLong = heroTile.title.length > 24
    val factsText = if (started != null) {
        val epPrefix = if (started.tile.kind == LibraryKind.Series && started.entry.isEpisode) {
            "${started.entry.episodeLabel} · "
        } else {
            ""
        }
        val leftPart = if (started.progress.durationMs > 0L) {
            formatTimeLeft(started.progress.durationMs - started.progress.positionMs)
        } else {
            "In progress"
        }
        "$epPrefix$leftPart"
    } else {
        tileFactsLine(heroTile)
    }

    HeroPanel(
        hue = normalizeHue(heroTile.seed),
        showOrb = true,
        backdropImdb = heroTile.imdb,
        modifier = modifier,
    ) {
        Text(
            text = eyebrow,
            color = Color.White.copy(alpha = 0.80f),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.6.sp,
        )
        Text(
            text = heroTile.title.uppercase(Locale.ROOT),
            color = Color.White,
            fontSize = if (isLong) 24.sp else 30.sp,
            lineHeight = if (isLong) 26.sp else 31.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = (-0.7).sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (factsText.isNotBlank()) {
                Text(
                    text = factsText,
                    color = Color.White.copy(alpha = 0.92f),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(if (isOk) Accent else if (heroTile.saved > 0 || heroTile.partial) Warn else Color.White.copy(alpha = 0.45f)),
            )
            Text(
                text = stateText,
                color = Color.White.copy(alpha = 0.86f),
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
        if (started != null && started.progress.positionMs > 0L && started.progress.durationMs > 0L) {
            LinearProgressIndicator(
                progress = { started.fraction.coerceIn(0.03f, 1f) },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(PillShape),
                color = BrandHover,
                trackColor = Color.White.copy(alpha = 0.30f),
            )
        }
        Spacer(Modifier.height(2.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (started != null) {
                HeroPrimaryButton(
                    text = "Continue",
                    icon = PlayIcon,
                    onClick = { onContinue(started) },
                )
                HeroGlassButton(
                    text = "Play something",
                    icon = DiceIcon,
                    onClick = onPlaySomething,
                )
            } else {
                HeroPrimaryButton(
                    text = "Play something",
                    icon = DiceIcon,
                    onClick = onPlaySomething,
                )
            }
            HeroGlassButton(
                text = "Details",
                onClick = { onDetails(heroTile.key) },
            )
        }
    }
}

// ---- Tonight view: three decision cards + A-Z jump strip & alphabetical index

@Composable
private fun WatchTonightView(
    model: AppModel,
    videos: List<LibraryTile>,
    history: Map<String, WatchProgress>,
    onOpenTitle: (String) -> Unit,
    bottomPadding: Dp = 28.dp,
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
        contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
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
                val hue = normalizeHue(tile.seed).toFloat()
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

@OptIn(ExperimentalLayoutApi::class)
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
    val (stateText, isOk) = tileStateLabel(tile)
    val isLong = tile.title.length > 24
    HeroPanel(
        hue = normalizeHue(tile.seed),
        small = true,
        showOrb = true,
        backdropImdb = tile.imdb,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(
            text = eyebrow.uppercase(Locale.ROOT),
            color = Color.White.copy(alpha = 0.80f),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.5.sp,
        )
        Text(
            text = tile.title.uppercase(Locale.ROOT),
            color = Color.White,
            fontSize = if (isLong) 20.sp else 24.sp,
            lineHeight = if (isLong) 22.sp else 25.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = (-0.5).sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = subtitle,
                color = Color.White.copy(alpha = 0.90f),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Text(
                text = "· $stateText",
                color = if (isOk) Accent else Color.White.copy(alpha = 0.78f),
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
        if (progress != null && progress > 0f) {
            LinearProgressIndicator(
                progress = { progress.coerceIn(0.03f, 1f) },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(PillShape),
                color = BrandHover,
                trackColor = Color.White.copy(alpha = 0.30f),
            )
        }
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (primary) {
                HeroPrimaryButton(text = "Play", icon = PlayIcon, onClick = onPlay)
            } else {
                HeroGlassButton(text = "Play", icon = PlayIcon, onClick = onPlay)
            }
            if (secondaryLabel != null && onSecondary != null) {
                HeroGlassButton(text = secondaryLabel, icon = secondaryIcon, onClick = onSecondary)
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
    bottomPadding: Dp = 28.dp,
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
        contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
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
    val heightDp = (164 + (normalizeHue(tile.seed) % 5) * 6).dp
    val hue = normalizeHue(tile.seed).toFloat()
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
    bottomPadding: Dp = 28.dp,
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
        contentPadding = PaddingValues(top = 6.dp, bottom = bottomPadding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item(key = "on-now-head") { SectionHeader("On now") }

        items(channels, key = { "on-now-${it.number}" }) { ch ->
            val live = ch.live
            val liveInto = (live.intoSec + (nowSec - live.fromSec)).coerceIn(0L, live.item.durationSec - 1L)
            val leftSec = (live.item.durationSec - liveInto).coerceAtLeast(1L)
            val pct = (liveInto.toFloat() / live.item.durationSec.toFloat()).coerceIn(0.02f, 1f)
            val isLong = live.item.tile.title.length > 24

            HeroPanel(
                hue = normalizeHue(live.item.tile.seed),
                small = true,
                showOrb = true,
                backdropImdb = live.item.tile.imdb,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
            ) {
                Text(
                    text = "CH ${ch.number} · ${ch.name.uppercase(Locale.ROOT)} · ON NOW",
                    color = Color.White.copy(alpha = 0.80f),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.4.sp,
                )
                Text(
                    text = live.item.tile.title.uppercase(Locale.ROOT),
                    color = Color.White,
                    fontSize = if (isLong) 20.sp else 24.sp,
                    lineHeight = if (isLong) 22.sp else 25.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = (-0.5).sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val subPrefix = if (live.item.tile.kind == LibraryKind.Series) "${live.item.sub} · " else ""
                Text(
                    text = "$subPrefix${formatTimeLeft(leftSec * 1000L)}",
                    color = Color.White.copy(alpha = 0.90f),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                LinearProgressIndicator(
                    progress = { pct },
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(PillShape),
                    color = BrandHover,
                    trackColor = Color.White.copy(alpha = 0.30f),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    HeroPrimaryButton(
                        text = "Watch",
                        icon = PlayIcon,
                        onClick = { model.playEntry(live.item.entry, startPositionMs = liveInto * 1000L) },
                    )
                    HeroGlassButton(
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
                                val hue = normalizeHue(block.item.tile.seed).toFloat()
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
                        kindLabel = posterKindLabel(tile.kind),
                        imdb = tile.imdb,
                        modifier = Modifier.width(126.dp),
                    )
                } else {
                    PosterArt(
                        title = tile.title,
                        year = tile.year,
                        seed = tile.seed,
                        kindLabel = posterKindLabel(tile.kind),
                        imdb = tile.imdb,
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
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PosterArt(
                    title = tile.title,
                    year = tile.year,
                    seed = tile.seed,
                    kindLabel = posterKindLabel(tile.kind),
                    imdb = tile.imdb,
                    modifier = Modifier.width(58.dp),
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(tile.title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${plural(episodes.size, "episode", "episodes")} · ${plural(seasons.size.coerceAtLeast(1), "season", "seasons")}",
                        color = Dim,
                        fontSize = 12.sp,
                    )
                    Text(stateText, color = if (isOk) Accent else Dim, fontSize = 11.sp)
                    TextButton(
                        onClick = { model.playEntry(next) },
                        contentPadding = PaddingValues(horizontal = 0.dp, vertical = 2.dp),
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
                Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(20.dp))
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
                Modifier.padding(start = 12.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PosterArt(
                    title = tile.title,
                    year = tile.year,
                    seed = tile.seed,
                    kindLabel = posterKindLabel(tile.kind),
                    imdb = tile.imdb,
                    modifier = Modifier.width(58.dp),
                )
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
            kindLabel = posterKindLabel(tile.kind),
            imdb = tile.imdb,
            modifier = Modifier.width(116.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
            Text(stateText, color = if (isOk) Accent else Dim, fontSize = 11.sp)
        }
    }
}

private fun formatSeasonLabel(rawSeason: String): String {
    val num = rawSeason.trim().removePrefix("S").removePrefix("s").toIntOrNull()
    return if (num != null) "Season $num" else rawSeason
}

private fun cleanEpisodeFallbackTitle(entry: Entry, showTitle: String, epCode: String): String {
    val epNum = entry.episode
    val raw = entry.title.trim()
    val stripped = raw
        .removePrefix(showTitle)
        .trim()
        .removePrefix("·")
        .removePrefix("-")
        .removePrefix(":")
        .trim()
    val isBareCode = stripped.isEmpty() ||
        stripped.equals(epCode, ignoreCase = true) ||
        raw.equals(showTitle, ignoreCase = true) ||
        raw.equals("$showTitle $epCode", ignoreCase = true) ||
        raw.equals(epCode, ignoreCase = true)
    return if (isBareCode) {
        if (epNum != null) "Episode $epNum" else "Episode"
    } else {
        stripped
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
    val copyText = rememberCopyText()
    val statusBarTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val isSeries = tile.kind == LibraryKind.Series

    val titleMeta by produceState<CinemaTitleMeta?>(
        initialValue = tile.imdb?.let { ExternalDiscoveryApi.cachedTitleMeta(it, isSeries = isSeries) },
        key1 = tile.key,
        key2 = tile.imdb,
    ) {
        if (tile.kind == LibraryKind.Movie || tile.kind == LibraryKind.Series) {
            val resolvedImdb = tile.imdb
                ?: ExternalDiscoveryApi.resolveTitleImdb(tile.title, isSeries = isSeries)
            value = if (resolvedImdb != null) {
                ExternalDiscoveryApi.loadTitleMeta(resolvedImdb, isSeries = isSeries)
            } else {
                null
            }
        }
    }

    val episodes = remember(tile) {
        if (tile.kind == LibraryKind.Series) tile.items.map { it.entry }.distinctBy { it.id } else emptyList()
    }
    val seasons = remember(episodes) { episodes.mapNotNull { it.seasonLabel }.distinct() }
    var selectedSeason by remember(tile.key, seasons) { mutableStateOf(seasons.firstOrNull() ?: "") }
    var primaryMenuOpen by remember { mutableStateOf(false) }
    var synopsisExpanded by remember(tile.key) { mutableStateOf(false) }

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
    val primaryDownload = primaryEntry?.let { downloads[it.key] }
    val primaryCanDelete = primaryEntry != null &&
        status?.let { it.writable && it.channel.isNotEmpty() && it.channel == primaryEntry.source } == true

    val effectiveImdb = tile.imdb ?: titleMeta?.imdbId
    val backdropUrl = remember(effectiveImdb, titleMeta?.backdropUrl) {
        titleMeta?.backdropUrl?.takeIf { it.isNotBlank() } ?: imdbBackdropUrl(effectiveImdb)
    }
    val posterFallbackUrl = remember(effectiveImdb, titleMeta?.posterUrl) {
        titleMeta?.posterUrl?.takeIf { it.isNotBlank() } ?: imdbPosterUrl(effectiveImdb)
    }
    val heroArt by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterFallbackUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterFallbackUrl,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterFallbackUrl?.let { ExternalImageCache.load(it) }
            posterFallbackUrl != null -> ExternalImageCache.load(posterFallbackUrl)
            else -> null
        }
    }

    val displayYear = titleMeta?.year?.takeIf { it.isNotBlank() } ?: tile.year
    val displayRuntime = titleMeta?.runtime?.takeIf { it.isNotBlank() }
    val displayRating = titleMeta?.rating?.takeIf { it.isNotBlank() }

    val metadataParts = remember(tile, displayYear, displayRuntime, seasons.size, episodes.size) {
        when (tile.kind) {
            LibraryKind.Movie -> listOfNotNull(
                displayYear,
                displayRuntime,
                if (displayYear == null && displayRuntime == null) "Movie" else null,
            )
            LibraryKind.Series -> listOfNotNull(
                displayYear,
                if (seasons.isNotEmpty()) plural(seasons.size, "Season", "Seasons") else plural(episodes.size, "Episode", "Episodes"),
                displayRuntime,
            )
            LibraryKind.Clip -> listOfNotNull(
                "Video",
                tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { formatBytes(it) },
            )
            LibraryKind.Album -> listOfNotNull(tile.artist.takeIf { it.isNotBlank() })
        }
    }

    Box(Modifier.fillMaxSize().background(Bg)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Cinematic full-bleed 16:9 IMDb backdrop hero melting smoothly into Bg
            item(key = "title-cinematic-hero") {
                val hue = normalizeHue(tile.seed)
                val heroHeight = 250.dp + statusBarTop
                Column(Modifier.fillMaxWidth()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(heroHeight),
                    ) {
                        val art = heroArt
                        if (art != null) {
                            Image(
                                bitmap = art,
                                contentDescription = tile.title,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                            )
                            Canvas(Modifier.fillMaxSize()) {
                                drawRect(
                                    Brush.verticalGradient(
                                        0.0f to Bg.copy(alpha = 0.65f),
                                        0.30f to Color.Transparent,
                                        0.58f to Bg.copy(alpha = 0.68f),
                                        0.86f to Bg.copy(alpha = 0.94f),
                                        1.0f to Bg,
                                    ),
                                )
                            }
                        } else {
                            val glowA = Color.hsl(hue.toFloat(), 0.48f, 0.24f)
                            val glowB = Color.hsl(((hue + 48) % 360).toFloat(), 0.54f, 0.12f)
                            Canvas(Modifier.fillMaxSize()) {
                                drawRect(
                                    Brush.verticalGradient(
                                        0.0f to glowA,
                                        0.58f to glowB,
                                        1.0f to Bg,
                                    ),
                                )
                                drawCircle(
                                    brush = Brush.radialGradient(
                                        0.0f to Color.hsl(((hue + 140) % 360).toFloat(), 0.60f, 0.48f, alpha = 0.22f),
                                        1.0f to Color.Transparent,
                                        center = Offset(size.width * 0.78f, size.height * 0.25f),
                                        radius = size.width * 0.65f,
                                    ),
                                    radius = size.width * 0.65f,
                                    center = Offset(size.width * 0.78f, size.height * 0.25f),
                                )
                            }
                        }

                        Column(
                            modifier = Modifier
                                .align(Alignment.BottomStart)
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp, vertical = 14.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = tile.title,
                                color = Ink,
                                fontSize = 26.sp,
                                lineHeight = 30.sp,
                                fontFamily = FontFamily.SansSerif,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = (-0.7).sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                if (tile.allSaved) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(Accent),
                                    )
                                }
                                val joined = metadataParts.joinToString(" · ")
                                if (joined.isNotBlank()) {
                                    Text(
                                        text = joined,
                                        color = Ink.copy(alpha = 0.80f),
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (displayRating != null) {
                                    if (joined.isNotBlank()) {
                                        Text("·", color = Dim, fontSize = 13.sp)
                                    }
                                    Text(
                                        text = "★ $displayRating",
                                        color = Warn,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }

                    // Primary Pearl Play/Resume pill + Cast & More icon buttons
                    if (primaryEntry != null) {
                        val playLabel = when {
                            tile.kind == LibraryKind.Series && primaryResume != null -> "Resume ${primaryEntry.episodeLabel}"
                            tile.kind == LibraryKind.Series -> "Play ${primaryEntry.episodeLabel}"
                            primaryResume != null -> "Resume"
                            else -> "Play"
                        }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            HeroPrimaryButton(
                                text = playLabel,
                                icon = PlayIcon,
                                shape = PillShape,
                                onClick = { model.playEntry(primaryEntry) },
                                modifier = Modifier.weight(1f).height(46.dp),
                            )
                            if (!primaryEntry.locked) {
                                Box(
                                    modifier = Modifier
                                        .size(46.dp)
                                        .clip(CircleShape)
                                        .background(GlassBg)
                                        .border(0.75.dp, GlassBorder, CircleShape)
                                        .semantics { contentDescription = "Cast to TV" }
                                        .clickable {
                                            model.openTvsPickerForEntry(
                                                primaryEntry,
                                                history[primaryEntry.key]?.takeIf { it.partial }?.positionMs ?: 0L,
                                            )
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(CastIcon, null, tint = Ink, modifier = Modifier.size(20.dp))
                                }
                            }
                            Box {
                                Box(
                                    modifier = Modifier
                                        .size(46.dp)
                                        .clip(CircleShape)
                                        .background(GlassBg)
                                        .border(0.75.dp, GlassBorder, CircleShape)
                                        .semantics { contentDescription = "More options" }
                                        .clickable { primaryMenuOpen = true },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(MoreVertIcon, null, tint = Ink, modifier = Modifier.size(20.dp))
                                }
                                DropdownMenu(
                                    expanded = primaryMenuOpen,
                                    onDismissRequest = { primaryMenuOpen = false },
                                ) {
                                    if (!primaryEntry.locked) {
                                        if (primaryDownload != null) {
                                            DropdownMenuItem(
                                                text = { Text("Cancel download") },
                                                onClick = {
                                                    primaryMenuOpen = false
                                                    model.cancelDownload(primaryEntry.key)
                                                },
                                            )
                                        } else {
                                            DropdownMenuItem(
                                                text = { Text("Download") },
                                                onClick = {
                                                    primaryMenuOpen = false
                                                    model.downloadEntry(primaryEntry, primaryEntry.title)
                                                },
                                            )
                                        }
                                    }
                                    if (primaryEntry.magnetUrl.isNotBlank()) {
                                        DropdownMenuItem(
                                            text = { Text("Copy link") },
                                            onClick = {
                                                primaryMenuOpen = false
                                                copyText(primaryEntry.magnetUrl)
                                                model.notice.value = "Link copied"
                                            },
                                        )
                                    }
                                    if (!primaryEntry.local && primaryEntry.cachedBytes > 0L) {
                                        DropdownMenuItem(
                                            text = { Text("Free up cache") },
                                            onClick = {
                                                primaryMenuOpen = false
                                                model.clearCache(primaryEntry.key)
                                            },
                                        )
                                    }
                                    if (primaryCanDelete) {
                                        DropdownMenuItem(
                                            text = { Text("Delete", color = Danger) },
                                            onClick = {
                                                primaryMenuOpen = false
                                                model.removeChannelEntry(primaryEntry.key)
                                            },
                                        )
                                    }
                                }
                            }
                        }

                        if (primaryResume != null && primaryResume.durationMs > 0L) {
                            val left = formatTimeLeft(primaryResume.durationMs - primaryResume.positionMs)
                            val frac = (primaryResume.positionMs.toFloat() / primaryResume.durationMs).coerceIn(0.03f, 1f)
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 20.dp)
                                    .padding(top = 12.dp),
                                verticalArrangement = Arrangement.spacedBy(5.dp),
                            ) {
                                LinearProgressIndicator(
                                    progress = { frac },
                                    modifier = Modifier.fillMaxWidth().height(3.dp).clip(PillShape),
                                    color = Pearl,
                                    trackColor = GlassBorder,
                                )
                                Text(left, color = Dim, fontSize = 12.sp)
                            }
                        }
                    }

                    // Rich Cinemeta synopsis, subtle inline genres, and cast line
                    val meta = titleMeta
                    if (meta != null && (meta.genres.isNotEmpty() || meta.description.isNotBlank() || meta.cast.isNotEmpty())) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (meta.genres.isNotEmpty()) {
                                Text(
                                    text = meta.genres.take(4).joinToString(" · "),
                                    color = Dim,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (meta.description.isNotBlank()) {
                                Text(
                                    text = meta.description,
                                    color = Ink.copy(alpha = 0.84f),
                                    fontSize = 13.5.sp,
                                    lineHeight = 20.sp,
                                    maxLines = if (synopsisExpanded) 12 else 3,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.clickable { synopsisExpanded = !synopsisExpanded },
                                )
                            }
                            if (meta.cast.isNotEmpty()) {
                                Text(
                                    text = "Starring ${meta.cast.take(4).joinToString(", ")}",
                                    color = Dim,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }

            if (tile.kind == LibraryKind.Series) {
                if (seasons.size > 1) {
                    item(key = "season-pills") {
                        LazyRow(
                            modifier = Modifier.fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(seasons, key = { "season-$it" }) { s ->
                                val selected = selectedSeason == s
                                Box(
                                    modifier = Modifier
                                        .clip(PillShape)
                                        .background(if (selected) Pearl else GlassBg)
                                        .then(
                                            if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                        )
                                        .clickable { selectedSeason = s }
                                        .padding(horizontal = 14.dp, vertical = 7.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = formatSeasonLabel(s),
                                        color = if (selected) PearlInk else Dim,
                                        fontSize = 13.sp,
                                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
                val seasonEpisodes = episodes.filter { seasons.size <= 1 || it.seasonLabel == selectedSeason }
                item(key = "episodes-head") {
                    SectionHeader(
                        title = if (seasons.size > 1 && selectedSeason.isNotBlank()) {
                            "${formatSeasonLabel(selectedSeason)} · ${plural(seasonEpisodes.size, "Episode", "Episodes")}"
                        } else {
                            "Episodes"
                        },
                    )
                }
                items(seasonEpisodes, key = { it.key }) { episode ->
                    val epCode = episode.episodeLabel
                    val epMeta = if (episode.season != null && episode.episode != null) {
                        titleMeta?.episodes?.get(episode.season to episode.episode)
                    } else {
                        null
                    }
                    val resolvedTitle = epMeta?.name?.takeIf { it.isNotBlank() }
                        ?: cleanEpisodeFallbackTitle(episode, tile.title, epCode)
                    val dlName = if (episode.title.contains(epCode, ignoreCase = true)) episode.title else "${episode.title} $epCode"
                    CleanEpisodeRow(
                        model = model,
                        entry = episode,
                        epCode = epCode,
                        title = resolvedTitle,
                        episodeMeta = epMeta,
                        progress = history[episode.key],
                        download = downloads[episode.key],
                        downloadName = dlName,
                        canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == episode.source } == true,
                    )
                }
            } else if (tile.items.size > 1) {
                item(key = "versions-head") { SectionHeader("Versions") }
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
            } else if (primaryEntry != null) {
                item(key = "single-file-note") {
                    val savedHere = isSaved(primaryEntry)
                    val dl = primaryDownload
                    val note = buildList {
                        primaryEntry.size.takeIf { it > 0L }?.let { add(formatBytes(it)) }
                        when {
                            primaryEntry.locked -> add("Subscriber pass needed")
                            dl != null && dl.total > 0L -> add("Downloading ${(dl.bytes * 100L / dl.total).coerceIn(0L, 100L)}%")
                            dl != null -> add("Downloading ${formatBytes(dl.bytes)}")
                            savedHere -> add("Saved on device")
                            primaryEntry.cachedBytes > 0L -> add("Partly cached")
                            else -> add("Streams over swarm")
                        }
                    }.joinToString(" · ")
                    if (note.isNotBlank()) {
                        Column(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(note, color = if (savedHere) Accent else Dim, fontSize = 12.sp)
                            if (dl != null) {
                                EntryProgressBar(primaryEntry, primaryResume, dl)
                            }
                        }
                    }
                }
            }
        }

        // Floating circular Back button over top-left of backdrop
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(start = 16.dp, top = 8.dp)
                .size(38.dp)
                .clip(CircleShape)
                .background(Bg.copy(alpha = 0.56f))
                .border(0.75.dp, GlassBorder, CircleShape)
                .semantics { contentDescription = "Back" }
                .clickable(onClick = onBack),
            contentAlignment = Alignment.Center,
        ) {
            Icon(BackIcon, null, tint = Ink, modifier = Modifier.size(19.dp))
        }
    }
}

@Composable
private fun CleanEpisodeRow(
    model: AppModel,
    entry: Entry,
    epCode: String,
    title: String,
    episodeMeta: CinemaEpisodeMeta?,
    progress: WatchProgress?,
    download: DownloadProgress?,
    downloadName: String,
    canDelete: Boolean,
) {
    var menu by remember { mutableStateOf(false) }
    val copyText = rememberCopyText()
    val savedHere = isSaved(entry)
    val watched = progress != null && !progress.partial && progress.positionMs > 0L
    val shortBadge = entry.episode?.let { "E$it" } ?: epCode
    val thumbUrl = episodeMeta?.thumbnailUrl?.takeIf { it.isNotBlank() }
    val thumbBitmap by produceState<ImageBitmap?>(
        initialValue = thumbUrl?.let { ExternalImageCache.get(it) },
        key1 = thumbUrl,
    ) {
        value = if (thumbUrl != null) ExternalImageCache.load(thumbUrl) else null
    }
    val watchFrac = if (progress?.partial == true && progress.durationMs > 0L) {
        (progress.positionMs.toFloat() / progress.durationMs.toFloat()).coerceIn(0.04f, 1f)
    } else {
        0f
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, Line.copy(alpha = 0.7f), CardShape)
            .clickable { model.playEntry(entry) },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 10.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Crisp 16:9 episode still thumbnail (112x63dp) with bottom watch progress bar
            val thumbShape = RoundedCornerShape(8.dp)
            Box(
                modifier = Modifier
                    .width(112.dp)
                    .height(63.dp)
                    .clip(thumbShape)
                    .background(CardElevated)
                    .border(0.5.dp, GlassBorder.copy(alpha = 0.65f), thumbShape),
                contentAlignment = Alignment.Center,
            ) {
                val loadedStill = thumbBitmap
                if (loadedStill != null) {
                    Image(
                        bitmap = loadedStill,
                        contentDescription = title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Text(
                        text = shortBadge,
                        color = Dim,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                if (watchFrac > 0f) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomStart)
                            .fillMaxWidth()
                            .height(2.5.dp)
                            .background(Bg.copy(alpha = 0.65f)),
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxHeight()
                                .fillMaxWidth(watchFrac)
                                .background(Pearl),
                        )
                    }
                }
            }

            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = shortBadge,
                        color = Dim,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        fontFamily = FontFamily.Monospace,
                    )
                    if (watched) {
                        Icon(CheckIcon, "Watched", tint = Accent, modifier = Modifier.size(13.dp))
                    } else if (savedHere && !entry.locked) {
                        Box(
                            modifier = Modifier
                                .size(5.dp)
                                .clip(CircleShape)
                                .background(Accent),
                        )
                    }
                    val statusSub = when {
                        entry.locked -> "Pass needed"
                        download != null && download.total > 0L -> "${(download.bytes * 100L / download.total).coerceIn(0L, 100L)}%"
                        download != null -> formatBytes(download.bytes)
                        progress?.partial == true && progress.durationMs > 0L -> formatTimeLeft(progress.durationMs - progress.positionMs)
                        else -> ""
                    }
                    if (statusSub.isNotBlank()) {
                        Text(
                            text = "· $statusSub",
                            color = if (entry.locked) Danger else Dim,
                            fontSize = 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Text(
                    text = title,
                    color = Ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val overview = episodeMeta?.overview?.takeIf { it.isNotBlank() }
                if (overview != null) {
                    Text(
                        text = overview,
                        color = Dim,
                        fontSize = 11.5.sp,
                        lineHeight = 15.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Box {
                CinemaIcon(MoreVertIcon, "Episode options", Dim) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (!entry.locked) {
                        DropdownMenuItem(
                            text = { Text("Cast to TV") },
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
                            onClick = { menu = false; copyText(entry.magnetUrl); model.notice.value = "Link copied" },
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
        if (download != null) {
            EntryProgressBar(entry, progress, download)
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
        savedHere -> "Saved on device"
        entry.cachedBytes > 0L -> "Partly cached"
        else -> "Streams over swarm"
    }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp)
            .clip(CardShape)
            .background(CardBg)
            .border(0.75.dp, Line.copy(alpha = 0.7f), CardShape)
            .clickable { model.playEntry(entry) },
    ) {
        Row(
            Modifier.padding(start = 14.dp, end = 4.dp, top = 11.dp, bottom = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(label, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
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
            Box {
                CinemaIcon(MoreVertIcon, "Version options", Dim) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (!entry.locked) {
                        DropdownMenuItem(
                            text = { Text("Cast to TV") },
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
                            onClick = { menu = false; copyText(entry.magnetUrl); model.notice.value = "Link copied" },
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
