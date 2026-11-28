package com.peartube.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibrarySubTab
import com.peartube.app.LibraryTile
import com.peartube.app.PeekTarget
import com.peartube.app.Screen
import com.peartube.app.plural
import com.peartube.app.sortTitleKey
import com.peartube.app.tileFactsLine
import java.util.Locale

private enum class CinemaGridSort(val label: String) {
    Title("A–Z"),
    Year("Year"),
}

/**
 * Calm, uncluttered LUMEN Library room with a single flat pill row:
 * Movies | TV Shows | Music (plus Videos only when clips exist).
 */
@Composable
fun LibraryScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenArtist: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
    topPadding: Dp = 12.dp,
    bottomPadding: Dp = 28.dp,
) {
    val activeTab by model.libraryTab.collectAsState()
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val haptics = LocalHapticFeedback.current

    val visibleTabs = remember(catalog.clips.size) {
        if (catalog.clips.isNotEmpty()) {
            LibrarySubTab.entries
        } else {
            LibrarySubTab.entries.filterNot { it == LibrarySubTab.Videos }
        }
    }
    val effectiveTab = if (activeTab == LibrarySubTab.Videos && catalog.clips.isEmpty()) {
        LibrarySubTab.Movies
    } else {
        activeTab
    }

    val movies = remember(catalog.movies) {
        catalog.movies.sortedWith(compareBy<LibraryTile>({ sortTitleKey(it.title) }, { it.title.lowercase(Locale.ROOT) }))
    }
    val series = remember(catalog.series) {
        catalog.series.sortedWith(compareBy<LibraryTile>({ sortTitleKey(it.title) }, { it.title.lowercase(Locale.ROOT) }))
    }
    val clips = remember(catalog.clips) {
        catalog.clips.sortedWith(compareBy<LibraryTile>({ sortTitleKey(it.title) }, { it.title.lowercase(Locale.ROOT) }))
    }

    if (catalog.tiles.isEmpty()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(top = topPadding, bottom = bottomPadding, start = 24.dp, end = 24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(CardElevated)
                        .border(1.dp, GlassBorder, RoundedCornerShape(22.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(LibraryIcon, null, tint = Pearl, modifier = Modifier.size(34.dp))
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    text = "Your Library",
                    color = Ink,
                    fontSize = 22.sp,
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.6).sp,
                )
                Text(
                    text = if (settings.hasSources && status == null) {
                        "Connecting to your channels…"
                    } else {
                        "Follow a channel or paste a link to fill your library."
                    },
                    color = Dim,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(4.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HeroPrimaryButton(
                        text = "Add link",
                        icon = AddIcon,
                        shape = PillShape,
                        onClick = { model.openAddSheet() },
                    )
                    HeroGlassButton(
                        text = "Channels",
                        shape = PillShape,
                        onClick = { model.pushScreen(Screen.Settings) },
                    )
                }
            }
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(top = topPadding),
    ) {
        // Single flat edge-to-edge pill row: Movies | TV Shows | Music (| Videos)
        LazyRow(
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 10.dp),
            contentPadding = PaddingValues(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(visibleTabs, key = { "ltab-${it.name}" }) { tab ->
                val selected = effectiveTab == tab
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(if (selected) Pearl else GlassBg)
                        .then(
                            if (selected) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                        )
                        .clickable { model.selectLibraryTab(tab) }
                        .padding(horizontal = 15.dp, vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = tab.label,
                        color = if (selected) PearlInk else Dim,
                        fontSize = 13.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        maxLines = 1,
                    )
                }
            }
        }

        when (effectiveTab) {
            LibrarySubTab.Movies -> {
                LibraryPosterGridTab(
                    tiles = movies,
                    emptyText = "No movies in your library yet.",
                    onOpenTitle = onOpenTitle,
                    onPeekTitle = { tile ->
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        model.openPeek(PeekTarget.LibraryTitle(tile))
                    },
                    bottomPadding = bottomPadding,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            LibrarySubTab.Series -> {
                LibraryPosterGridTab(
                    tiles = series,
                    emptyText = "No TV shows in your library yet.",
                    onOpenTitle = onOpenTitle,
                    onPeekTitle = { tile ->
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        model.openPeek(PeekTarget.LibraryTitle(tile))
                    },
                    bottomPadding = bottomPadding,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            LibrarySubTab.Music -> {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    ListenScreen(
                        model = model,
                        catalog = catalog,
                        onOpenAlbum = onOpenAlbum,
                        onOpenArtist = onOpenArtist,
                        embedded = true,
                        bottomPadding = bottomPadding,
                    )
                }
            }
            LibrarySubTab.Videos -> {
                LibraryVideosTab(
                    clips = clips,
                    onOpenTitle = onOpenTitle,
                    onPeekTitle = { tile ->
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        model.openPeek(PeekTarget.LibraryTitle(tile))
                    },
                    bottomPadding = bottomPadding,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun LibraryPosterGridTab(
    tiles: List<LibraryTile>,
    emptyText: String,
    onOpenTitle: (String) -> Unit,
    onPeekTitle: (LibraryTile) -> Unit,
    bottomPadding: Dp,
    modifier: Modifier = Modifier,
) {
    var sort by rememberSaveable { mutableStateOf(CinemaGridSort.Title) }
    var savedOnly by rememberSaveable { mutableStateOf(false) }

    if (tiles.isEmpty()) {
        Box(
            modifier = modifier.padding(horizontal = 24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(emptyText, color = Dim, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
        return
    }

    val filtered = remember(tiles, sort, savedOnly) {
        val base = if (savedOnly) tiles.filter { it.allSaved || it.saved > 0 } else tiles
        when (sort) {
            CinemaGridSort.Title -> base.sortedWith(
                compareBy<LibraryTile>({ sortTitleKey(it.title) }, { it.title.lowercase(Locale.ROOT) }),
            )
            CinemaGridSort.Year -> base.sortedWith(
                compareByDescending<LibraryTile> { it.year?.toIntOrNull() ?: 0 }
                    .thenBy { sortTitleKey(it.title) },
            )
        }
    }

    Column(modifier = modifier) {
        // Subtle compact right-aligned sort/filter row: A–Z | Year | Saved
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 10.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CinemaGridSort.entries.forEach { option ->
                    val selected = sort == option
                    QuietFilterPill(
                        label = option.label,
                        selected = selected,
                        onClick = { sort = option },
                    )
                }
                QuietFilterPill(
                    label = "Saved",
                    selected = savedOnly,
                    dotAccent = savedOnly,
                    onClick = { savedOnly = !savedOnly },
                )
            }
        }

        if (filtered.isEmpty()) {
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Nothing saved on this device yet.",
                    color = Dim,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                )
            }
            return
        }

        BoxWithConstraints(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val columns = when {
                maxWidth >= 600.dp -> 4
                maxWidth >= 320.dp -> 3
                else -> 2
            }
            val rows = remember(filtered, columns) { filtered.chunked(columns) }

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = 2.dp, bottom = bottomPadding),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                items(rows.size, key = { idx -> "grid-row-$idx-${rows[idx].firstOrNull()?.key.orEmpty()}" }) { rowIdx ->
                    val rowTiles = rows[rowIdx]
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        rowTiles.forEach { tile ->
                            CinemaPosterCard(
                                tile = tile,
                                onOpen = { onOpenTitle(tile.key) },
                                onLongClick = { onPeekTitle(tile) },
                                modifier = Modifier.weight(1f),
                            )
                        }
                        repeat(columns - rowTiles.size) {
                            Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun QuietFilterPill(
    label: String,
    selected: Boolean,
    dotAccent: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(30.dp)
            .clip(PillShape)
            .background(if (selected) CardElevated else GlassBg)
            .border(
                width = 0.75.dp,
                color = if (selected) FloatingDockBorder else GlassBorder,
                shape = PillShape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (dotAccent) {
            Box(
                modifier = Modifier
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(Accent),
            )
        }
        Text(
            text = label,
            color = if (selected) Ink else Dim,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LibraryVideosTab(
    clips: List<LibraryTile>,
    onOpenTitle: (String) -> Unit,
    onPeekTitle: (LibraryTile) -> Unit,
    bottomPadding: Dp,
    modifier: Modifier = Modifier,
) {
    if (clips.isEmpty()) {
        Box(
            modifier = modifier.padding(horizontal = 24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("No videos in your library yet.", color = Dim, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
        return
    }

    BoxWithConstraints(modifier = modifier) {
        val columns = if (maxWidth >= 560.dp) 2 else 1
        val rows = remember(clips, columns) { clips.chunked(columns) }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(top = 4.dp, bottom = bottomPadding),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            items(rows.size, key = { idx -> "vid-row-$idx-${rows[idx].firstOrNull()?.key.orEmpty()}" }) { rowIdx ->
                val rowClips = rows[rowIdx]
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    rowClips.forEach { tile ->
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .combinedClickable(
                                    onClick = { onOpenTitle(tile.key) },
                                    onLongClick = { onPeekTitle(tile) },
                                ),
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
                                text = tileFactsLine(tile).ifBlank { "Video" },
                                color = Dim,
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    repeat(columns - rowClips.size) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/**
 * Shared 2:3 cinema poster card used across Home, Library shelves, and Library grids.
 * Always renders 2 clean lines below the poster so every grid row has identical vertical alignment.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun CinemaPosterCard(
    tile: LibraryTile,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
) {
    val seasonsCount = remember(tile) {
        if (tile.kind == LibraryKind.Series) {
            tile.items.mapNotNull { it.entry.seasonLabel }.distinct().size
        } else {
            0
        }
    }
    val sub = remember(tile, seasonsCount) {
        when (tile.kind) {
            LibraryKind.Movie -> tile.year?.takeIf { it.isNotBlank() } ?: "Movie"
            LibraryKind.Series -> if (seasonsCount > 0) {
                plural(seasonsCount, "Season", "Seasons")
            } else {
                plural(tile.items.size, "Episode", "Episodes")
            }
            LibraryKind.Clip -> tile.year?.takeIf { it.isNotBlank() } ?: "Video"
            LibraryKind.Album -> tile.artist.ifBlank { "Album" }
        }
    }
    val savedLocally = tile.allSaved

    Column(
        modifier = modifier.combinedClickable(
            onClick = onOpen,
            onLongClick = onLongClick,
        ),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        PosterArt(
            title = tile.title,
            year = tile.year,
            seed = tile.seed,
            kindLabel = posterKindLabel(tile.kind),
            imdb = tile.imdb,
            cornerRadius = 12.dp,
            borderless = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = tile.title,
            color = Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (savedLocally) {
                Box(
                    modifier = Modifier
                        .size(5.dp)
                        .clip(CircleShape)
                        .background(Accent),
                )
            }
            Text(
                text = sub,
                color = Dim,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun LibraryPosterGridCard(
    tile: LibraryTile,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
) = CinemaPosterCard(tile = tile, onOpen = onOpen, modifier = modifier, onLongClick = onLongClick)
