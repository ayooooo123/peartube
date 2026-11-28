package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.ArtistGroup
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryTile
import com.peartube.app.PeekTarget
import com.peartube.app.Screen
import com.peartube.app.TrackRow
import com.peartube.app.TrackSort
import com.peartube.app.buildArtists
import com.peartube.app.buildTrackRows
import com.peartube.app.fold
import com.peartube.app.isSaved
import com.peartube.app.isYt
import com.peartube.app.plural
import com.peartube.app.tileStateLabel
import com.peartube.app.toTrackItem
import com.peartube.app.toTrackItems
import com.peartube.app.trackName
import com.peartube.app.trackNo
import com.peartube.shared.formatBytes

private enum class ListenTab(val label: String) {
    Albums("Albums"),
    Artists("Artists"),
    Tracks("Tracks"),
}

@Composable
fun ListenScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenArtist: (String) -> Unit,
    embedded: Boolean = false,
    bottomPadding: Dp = 24.dp,
) {
    var tab by rememberSaveable { mutableStateOf(ListenTab.Albums) }
    var savedOnly by rememberSaveable { mutableStateOf(false) }
    var trackFilter by rememberSaveable { mutableStateOf("") }
    var trackSort by rememberSaveable { mutableStateOf(TrackSort.LibraryOrder) }
    var sortAsc by rememberSaveable { mutableStateOf(true) }
    var sortMenu by remember { mutableStateOf(false) }

    val musicState by model.musicState.collectAsState()
    val filteredAlbums = remember(catalog.albums, savedOnly) {
        if (savedOnly) catalog.albums.filter { it.allSaved } else catalog.albums
    }
    val artists = remember(filteredAlbums) { buildArtists(filteredAlbums) }
    val tracks = remember(filteredAlbums, trackFilter, trackSort, sortAsc) {
        buildTrackRows(filteredAlbums, trackFilter, trackSort, sortAsc)
    }
    val allFilteredItems = remember(filteredAlbums) {
        filteredAlbums.flatMap { it.toTrackItems() }
    }
    val visibleTrackItems = remember(tracks) {
        tracks.map { it.toTrackItem() }
    }

    if (catalog.albums.isEmpty() || catalog.allTracks.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    modifier = Modifier
                        .size(72.dp)
                        .clip(RoundedCornerShape(22.dp))
                        .background(CardElevated),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(ListenIcon, null, tint = Dim, modifier = Modifier.size(34.dp))
                }
                Spacer(Modifier.height(2.dp))
                Text("No albums yet.", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text("Follow a channel with music or search other relays.", color = Dim, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                PrimaryBrandButton("Add to library", onClick = { model.pushScreen(Screen.Settings) })
            }
        }
        return
    }

    val countLabel = when (tab) {
        ListenTab.Albums -> plural(filteredAlbums.size, "album", "albums")
        ListenTab.Artists -> plural(artists.size, "artist", "artists")
        ListenTab.Tracks -> plural(tracks.size, "track", "tracks")
    }

    val waitingPaused = musicState.currentTrack != null && !musicState.playing
    val actionItems = if (tab == ListenTab.Tracks) visibleTrackItems else allFilteredItems
    val actionLabel = if (tab == ListenTab.Tracks) "Tracks" else "Library"

    Column(Modifier.fillMaxSize()) {
        if (!embedded) {
            // Listen display header + count
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = "Listen",
                    color = Ink,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = (-0.5).sp,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = countLabel,
                    color = Dim,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }

        if (embedded) {
            // Single compact LUMEN row: ▶ Play (Pearl) + ⇄ Shuffle (glass) + quiet Albums/Artists/Songs when multi-album
            LazyRow(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp),
                contentPadding = PaddingValues(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                item(key = "embedded-play") {
                    val playEnabled = waitingPaused || actionItems.isNotEmpty()
                    Row(
                        modifier = Modifier
                            .height(34.dp)
                            .clip(PillShape)
                            .background(if (playEnabled) Pearl else CardElevated)
                            .clickable(enabled = playEnabled) {
                                if (waitingPaused) {
                                    model.music.togglePlayPause()
                                } else if (actionItems.isNotEmpty()) {
                                    model.music.playTrackList(actionItems, 0, actionLabel, shuffleOn = false)
                                }
                            }
                            .padding(horizontal = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(PlayIcon, null, tint = if (playEnabled) PearlInk else Dim, modifier = Modifier.size(15.dp))
                        Text(
                            text = if (waitingPaused) "Resume" else "Play",
                            color = if (playEnabled) PearlInk else Dim,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                        )
                    }
                }

                item(key = "embedded-shuffle") {
                    Row(
                        modifier = Modifier
                            .height(34.dp)
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(0.75.dp, GlassBorder, PillShape)
                            .clickable(enabled = actionItems.isNotEmpty()) {
                                if (actionItems.isNotEmpty()) {
                                    model.music.playTrackList(actionItems, -1, actionLabel, shuffleOn = true)
                                }
                            }
                            .padding(horizontal = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Icon(ShuffleIcon, null, tint = if (actionItems.isNotEmpty()) Ink else Dim, modifier = Modifier.size(15.dp))
                        Text(
                            text = "Shuffle",
                            color = if (actionItems.isNotEmpty()) Ink else Dim,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                        )
                    }
                }

                if (catalog.albums.size > 1 || catalog.allTracks.size > 1) {
                    items(ListenTab.entries, key = { "em-ltab-${it.name}" }) { item ->
                        val selected = tab == item
                        val label = if (item == ListenTab.Tracks) "Songs" else item.label
                        Box(
                            modifier = Modifier
                                .height(34.dp)
                                .clip(PillShape)
                                .background(if (selected) GlassHighlight else Color.Transparent)
                                .border(
                                    width = 0.75.dp,
                                    color = if (selected) GlassBorder else Line.copy(alpha = 0.5f),
                                    shape = PillShape,
                                )
                                .clickable { tab = item }
                                .padding(horizontal = 12.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = label,
                                color = if (selected) Ink else Dim,
                                fontSize = 12.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        } else {
            // Top actions row: Play all (or Resume when paused) violet primary + Shuffle
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PrimaryBrandButton(
                    text = if (waitingPaused) "Resume" else "Play all",
                    icon = PlayIcon,
                    enabled = waitingPaused || actionItems.isNotEmpty(),
                    onClick = {
                        if (waitingPaused) {
                            model.music.togglePlayPause()
                        } else if (actionItems.isNotEmpty()) {
                            model.music.playTrackList(actionItems, 0, actionLabel, shuffleOn = false)
                        }
                    },
                )
                QuietActionButton(
                    text = "Shuffle",
                    icon = ShuffleIcon,
                    enabled = actionItems.isNotEmpty(),
                    onClick = {
                        if (actionItems.isNotEmpty()) {
                            model.music.playTrackList(actionItems, -1, actionLabel, shuffleOn = true)
                        }
                    },
                )
                Spacer(Modifier.weight(1f))
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

            // Segmented control: Albums / Artists / Tracks
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .clip(ControlShape)
                    .background(CardBg)
                    .border(1.dp, Line, ControlShape)
                    .padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ListenTab.entries.forEach { item ->
                    val selected = tab == item
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selected) CardElevated else Bg.copy(alpha = 0f))
                            .clickable { tab = item }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = item.label,
                            color = if (selected) Ink else Dim,
                            fontSize = 13.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        )
                    }
                }
            }
        }

        if (filteredAlbums.isEmpty() || allFilteredItems.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("No album here is saved on this device.", color = Dim, fontSize = 14.sp)
            }
            return
        }

        val edgePad = if (embedded) 20.dp else 16.dp

        if (tab == ListenTab.Tracks) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = edgePad, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .height(42.dp)
                        .clip(PillShape)
                        .background(CardElevated)
                        .border(0.75.dp, GlassBorder, PillShape)
                        .padding(start = 14.dp, end = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(17.dp))
                    BasicTextField(
                        value = trackFilter,
                        onValueChange = { trackFilter = it },
                        singleLine = true,
                        textStyle = TextStyle(color = Ink, fontSize = 13.5.sp),
                        cursorBrush = SolidColor(Pearl),
                        modifier = Modifier.weight(1f),
                        decorationBox = { innerTextField ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (trackFilter.isEmpty()) {
                                    Text(
                                        text = "Filter songs…",
                                        color = Dim,
                                        fontSize = 13.5.sp,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                innerTextField()
                            }
                        },
                    )
                    if (trackFilter.isNotEmpty()) {
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(GlassHighlight)
                                .semantics { contentDescription = "Clear filter" }
                                .clickable { trackFilter = "" },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(CloseIcon, null, tint = Dim, modifier = Modifier.size(14.dp))
                        }
                    }
                }
                Box {
                    val isDefaultSort = trackSort == TrackSort.LibraryOrder && sortAsc
                    Row(
                        modifier = Modifier
                            .height(42.dp)
                            .clip(PillShape)
                            .background(GlassBg)
                            .border(0.75.dp, GlassBorder, PillShape)
                            .clickable { sortMenu = true }
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(SortIcon, null, tint = Ink, modifier = Modifier.size(16.dp))
                        Text(
                            text = if (trackSort != TrackSort.LibraryOrder) trackSort.label else "Sort",
                            color = Ink,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                        )
                        if (!isDefaultSort) {
                            Icon(
                                imageVector = if (sortAsc) ArrowUpIcon else ArrowDownIcon,
                                contentDescription = if (sortAsc) "Sort ascending" else "Sort descending",
                                tint = Dim,
                                modifier = Modifier.size(13.dp),
                            )
                        }
                    }
                    DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                        TrackSort.entries.forEach { option ->
                            val selected = option == trackSort
                            val dirHint = when {
                                !selected -> ""
                                option == TrackSort.Quality -> if (sortAsc) " (low–high)" else " (best first)"
                                option == TrackSort.Size -> if (sortAsc) " (smallest)" else " (largest)"
                                option == TrackSort.LibraryOrder -> if (sortAsc) " (normal)" else " (reversed)"
                                else -> if (sortAsc) " (A–Z)" else " (Z–A)"
                            }
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        text = "${option.label}$dirHint",
                                        color = if (selected) Brand else Ink,
                                    )
                                },
                                onClick = {
                                    sortMenu = false
                                    if (trackSort == option) {
                                        sortAsc = !sortAsc
                                    } else {
                                        trackSort = option
                                        sortAsc = option != TrackSort.Size && option != TrackSort.Quality
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }

        when (tab) {
            ListenTab.Albums -> {
                val haptics = LocalHapticFeedback.current
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(start = edgePad, end = edgePad, top = 12.dp, bottom = bottomPadding),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(filteredAlbums, key = { it.key }) { album ->
                        AlbumShelfCard(
                            album = album,
                            onOpen = { onOpenAlbum(album.key) },
                            onPlay = {
                                val list = album.toTrackItems()
                                if (list.isNotEmpty()) {
                                    model.music.playTrackList(list, 0, album.album.ifBlank { album.title }, shuffleOn = false)
                                }
                            },
                            onLongClick = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                model.openPeek(PeekTarget.LibraryAlbum(album))
                            },
                            modifier = Modifier.fillMaxWidth(),
                            showPlayOverlay = !embedded,
                            showStateLine = !embedded,
                        )
                    }
                }
            }
            ListenTab.Artists -> {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(start = edgePad, end = edgePad, top = 12.dp, bottom = bottomPadding),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(artists, key = { it.key }) { artist ->
                        Column(
                            modifier = Modifier.fillMaxWidth().clickable { onOpenArtist(artist.key) },
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            ArtistSleeveStack(albums = artist.albums, modifier = Modifier.fillMaxWidth())
                            Text(artist.name, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(plural(artist.albumCount, "album", "albums"), color = Dim, fontSize = 12.sp)
                        }
                    }
                }
            }
            ListenTab.Tracks -> {
                if (tracks.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Text("No track matches those words.", color = Dim, fontSize = 14.sp)
                    }
                } else {
                    val activeKey = musicState.currentTrack?.key
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = bottomPadding),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        itemsIndexed(tracks, key = { idx, row -> "${row.entry.key}-$idx" }) { idx, row ->
                            FlatTrackRow(
                                row = row,
                                isPlaying = row.entry.key == activeKey,
                                onPlay = {
                                    // Rule 13: A row plays the visible list in the order shown, from that row.
                                    val items = tracks.map { it.toTrackItem() }
                                    model.music.playTrackList(items, idx, "Tracks")
                                },
                                onPlayNext = { model.music.playNext(listOf(row.toTrackItem()), row.albumName) },
                                onPlayLast = { model.music.playLast(listOf(row.toTrackItem()), row.albumName) },
                                onOpenAlbum = { onOpenAlbum(row.album.key) },
                                onOpenArtist = {
                                    val key = fold(row.artist)
                                    if (key.isNotEmpty()) onOpenArtist(key)
                                },
                            )
                            HorizontalDivider(color = Line.copy(alpha = 0.45f))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FlatTrackRow(
    row: TrackRow,
    isPlaying: Boolean,
    onPlay: () -> Unit,
    onPlayNext: () -> Unit,
    onPlayLast: () -> Unit,
    onOpenAlbum: () -> Unit,
    onOpenArtist: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val copyText = rememberCopyText()
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onPlay)
            .padding(start = 20.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AlbumSleeve(
            hue = row.album.hue,
            seed = row.album.seed,
            monogramText = row.album.monogramText,
            artist = row.album.artist,
            albumName = row.albumName,
            cornerRadius = 6.dp,
            fontSize = 12.sp,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = row.name,
                color = if (isPlaying) BrandHover else Ink,
                fontSize = 14.sp,
                fontWeight = if (isPlaying) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subLine = listOfNotNull(
                row.artist.takeIf { it.isNotBlank() },
                row.albumName.takeIf { it.isNotBlank() },
            ).joinToString(" · ")
            if (subLine.isNotEmpty()) {
                Text(
                    text = subLine,
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val metaLine = listOfNotNull(
                row.effectiveQualityLabel,
                row.size.takeIf { it > 0L }?.let { formatBytes(it) },
                if (!isSaved(row.entry)) "Streams over swarm" else null,
            ).joinToString(" · ")
            if (metaLine.isNotEmpty()) {
                Text(
                    text = metaLine,
                    color = if (isYt(row.entry)) Warn else Dim,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Box {
            CinemaIcon(MoreVertIcon, "More options") { menu = true }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("Play next") }, onClick = { menu = false; onPlayNext() })
                DropdownMenuItem(text = { Text("Play last") }, onClick = { menu = false; onPlayLast() })
                DropdownMenuItem(text = { Text("Go to album") }, onClick = { menu = false; onOpenAlbum() })
                if (row.artist.isNotBlank()) {
                    DropdownMenuItem(text = { Text("Go to artist") }, onClick = { menu = false; onOpenArtist() })
                }
                if (row.entry.magnetUrl.isNotBlank()) {
                    DropdownMenuItem(
                        text = { Text("Copy link") },
                        onClick = { menu = false; copyText(row.entry.magnetUrl) },
                    )
                }
            }
        }
    }
}

@Composable
fun AlbumDetailScreen(
    model: AppModel,
    album: LibraryTile?,
    catalog: LibraryCatalog,
    onBack: () -> Unit,
    onOpenArtist: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    if (album == null) {
        Box(Modifier.fillMaxSize().background(Bg)) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Album not found.", color = Dim, fontSize = 14.sp)
            }
            FloatingDetailBackButton(
                onBack = onBack,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(start = 16.dp, top = 8.dp),
            )
        }
        return
    }

    val musicState by model.musicState.collectAsState()
    val status by model.status.collectAsState()
    val downloads by model.downloads.collectAsState()
    val copyText = rememberCopyText()
    var moreMenu by remember { mutableStateOf(false) }

    val trackItems = remember(album) { album.toTrackItems() }
    val moreByArtist = remember(catalog, album) { catalog.albumsByArtist(album.artist, excludeKey = album.key) }
    val (stateLabel, isOk) = tileStateLabel(album)
    val facts = listOfNotNull(
        plural(album.items.size, "track", "tracks"),
        stateLabel,
    ).joinToString(" · ")
    val activeKey = musicState.currentTrack?.key
    val albumTitle = album.album.ifBlank { album.title }
    val hue = ((album.hue % 360) + 360) % 360
    val bloomColor = Color.hsl(hue.toFloat(), 0.50f, 0.24f)

    Box(Modifier.fillMaxSize().background(Bg)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item(key = "header") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            Brush.verticalGradient(
                                0.0f to bloomColor,
                                0.62f to bloomColor.copy(alpha = 0.22f),
                                1.0f to Bg,
                            ),
                        ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .statusBarsPadding()
                            .padding(top = 52.dp, bottom = 14.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val sleeveShape = RoundedCornerShape(16.dp)
                        AlbumSleeve(
                            hue = album.hue,
                            seed = album.seed,
                            monogramText = album.monogramText,
                            artist = album.artist,
                            albumName = albumTitle,
                            cornerRadius = 16.dp,
                            fontSize = 44.sp,
                            borderless = true,
                            modifier = Modifier
                                .size(210.dp)
                                .shadow(24.dp, sleeveShape)
                                .border(0.5.dp, GlassBorder, sleeveShape),
                        )

                        Spacer(Modifier.height(4.dp))

                        Text(
                            text = albumTitle,
                            color = Ink,
                            fontSize = 24.sp,
                            lineHeight = 28.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = (-0.6).sp,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 24.dp),
                        )

                        if (album.artist.isNotBlank()) {
                            Text(
                                text = album.artist,
                                color = BrandHover,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.SemiBold,
                                textAlign = TextAlign.Center,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .clip(PillShape)
                                    .clickable { onOpenArtist(fold(album.artist)) }
                                    .padding(horizontal = 10.dp, vertical = 2.dp),
                            )
                        }

                        Row(
                            modifier = Modifier.padding(horizontal = 24.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (album.allSaved) {
                                Box(
                                    modifier = Modifier
                                        .size(6.dp)
                                        .clip(CircleShape)
                                        .background(Accent),
                                )
                            }
                            Text(
                                text = facts,
                                color = if (isOk) Accent else Dim,
                                fontSize = 12.5.sp,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }

                        if (album.isYoutubeOnly) {
                            Text("YouTube · AAC 128 kbps", color = Warn, fontSize = 11.5.sp, fontWeight = FontWeight.Medium)
                        }

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            HeroPrimaryButton(
                                text = "Play",
                                icon = PlayIcon,
                                shape = PillShape,
                                onClick = {
                                    if (trackItems.isNotEmpty()) {
                                        model.music.playTrackList(trackItems, 0, albumTitle, shuffleOn = false)
                                    }
                                },
                                modifier = Modifier.weight(1f).height(46.dp),
                            )
                            HeroGlassButton(
                                text = "Shuffle",
                                icon = ShuffleIcon,
                                shape = PillShape,
                                onClick = {
                                    if (trackItems.isNotEmpty()) {
                                        model.music.playTrackList(trackItems, -1, albumTitle, shuffleOn = true)
                                    }
                                },
                                modifier = Modifier.weight(1f).height(46.dp),
                            )
                            Box {
                                Box(
                                    modifier = Modifier
                                        .size(46.dp)
                                        .clip(CircleShape)
                                        .background(GlassBg)
                                        .border(0.75.dp, GlassBorder, CircleShape)
                                        .semantics { contentDescription = "More options" }
                                        .clickable { moreMenu = true },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(MoreVertIcon, null, tint = Ink, modifier = Modifier.size(20.dp))
                                }
                                DropdownMenu(expanded = moreMenu, onDismissRequest = { moreMenu = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Play next") },
                                        onClick = { moreMenu = false; model.music.playNext(trackItems, albumTitle) },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Play last") },
                                        onClick = { moreMenu = false; model.music.playLast(trackItems, albumTitle) },
                                    )
                                    album.items.firstOrNull()?.entry?.magnetUrl?.takeIf { it.isNotBlank() }?.let { link ->
                                        DropdownMenuItem(
                                            text = { Text("Copy link") },
                                            onClick = { moreMenu = false; copyText(link) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                HorizontalDivider(color = Line.copy(alpha = 0.35f), modifier = Modifier.padding(horizontal = 20.dp))
            }

            itemsIndexed(album.items, key = { idx, item -> "${item.entry.key}-$idx" }) { idx, item ->
                val e = item.entry
                val isPlaying = e.key == activeKey
                val isDl = downloads.containsKey(e.key)
                val canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == e.source } == true
                val metaParts = listOfNotNull(
                    e.music?.artist?.takeIf { it.isNotBlank() && it != album.artist },
                    if (!isSaved(e)) "Streams over swarm" else null,
                    if (isYt(e) && !album.isYoutubeOnly) "YouTube" else null,
                    if (item.copies > 1) "${item.copies} copies" else null,
                ).joinToString(" · ")
                var rowMenu by remember { mutableStateOf(false) }

                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            // Rule 13: A row on an album page plays the album from that row.
                            model.music.playTrackList(trackItems, idx, albumTitle)
                        }
                        .padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(34.dp), contentAlignment = Alignment.CenterStart) {
                        if (isPlaying) {
                            Icon(PlayIcon, "Playing", tint = BrandHover, modifier = Modifier.size(16.dp))
                        } else {
                            Text(
                                text = trackNo(e).ifEmpty { "${idx + 1}" },
                                color = Dim,
                                fontSize = 12.5.sp,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = trackName(e),
                            color = if (isPlaying) BrandHover else Ink,
                            fontSize = 15.sp,
                            fontWeight = if (isPlaying) FontWeight.SemiBold else FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (metaParts.isNotEmpty()) {
                            Text(metaParts, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Box {
                        CinemaIcon(MoreVertIcon, "More options") { rowMenu = true }
                        DropdownMenu(expanded = rowMenu, onDismissRequest = { rowMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Play next") },
                                onClick = { rowMenu = false; model.music.playNext(listOf(trackItems[idx]), albumTitle) },
                            )
                            DropdownMenuItem(
                                text = { Text("Play last") },
                                onClick = { rowMenu = false; model.music.playLast(listOf(trackItems[idx]), albumTitle) },
                            )
                            if (!e.locked) {
                                if (isDl) {
                                    DropdownMenuItem(
                                        text = { Text("Cancel download") },
                                        onClick = { rowMenu = false; model.cancelDownload(e.key) },
                                    )
                                } else {
                                    DropdownMenuItem(
                                        text = { Text("Download") },
                                        onClick = { rowMenu = false; model.downloadEntry(e, trackName(e)) },
                                    )
                                }
                            }
                            if (e.magnetUrl.isNotBlank()) {
                                DropdownMenuItem(
                                    text = { Text("Copy link") },
                                    onClick = { rowMenu = false; copyText(e.magnetUrl) },
                                )
                            }
                            if (!e.local && e.cachedBytes > 0L) {
                                DropdownMenuItem(
                                    text = { Text("Free up cache") },
                                    onClick = { rowMenu = false; model.clearCache(e.key) },
                                )
                            }
                            if (canDelete) {
                                DropdownMenuItem(
                                    text = { Text("Delete", color = Danger) },
                                    onClick = { rowMenu = false; model.removeChannelEntry(e.key) },
                                )
                            }
                        }
                    }
                }
                HorizontalDivider(color = Line.copy(alpha = 0.30f), modifier = Modifier.padding(horizontal = 20.dp))
            }

            if (moreByArtist.isNotEmpty()) {
                item(key = "more-by-artist") {
                    val haptics = LocalHapticFeedback.current
                    Column(Modifier.padding(top = 22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SectionHeader(title = "More by ${album.artist}")
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(moreByArtist, key = { it.key }) { sibling ->
                                AlbumShelfCard(
                                    album = sibling,
                                    onOpen = { onOpenAlbum(sibling.key) },
                                    onPlay = {
                                        val list = sibling.toTrackItems()
                                        if (list.isNotEmpty()) {
                                            model.music.playTrackList(list, 0, sibling.album.ifBlank { sibling.title }, shuffleOn = false)
                                        }
                                    },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        model.openPeek(PeekTarget.LibraryAlbum(sibling))
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }

        FloatingDetailBackButton(
            onBack = onBack,
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(start = 16.dp, top = 8.dp),
        )
    }
}

@Composable
fun ArtistDetailScreen(
    model: AppModel,
    artist: ArtistGroup?,
    onBack: () -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    if (artist == null) {
        Box(Modifier.fillMaxSize().background(Bg)) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Artist not found.", color = Dim, fontSize = 14.sp)
            }
            FloatingDetailBackButton(
                onBack = onBack,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(start = 16.dp, top = 8.dp),
            )
        }
        return
    }

    val musicState by model.musicState.collectAsState()
    var showAllTracks by remember(artist.key) { mutableStateOf(false) }
    var moreMenu by remember { mutableStateOf(false) }
    val allItems = remember(artist) { artist.tracks.map { it.toTrackItem() } }
    val visibleTracks = if (showAllTracks) artist.tracks else artist.tracks.take(8)
    val activeKey = musicState.currentTrack?.key
    val firstHue = artist.albums.firstOrNull()?.hue ?: 255
    val hue = ((firstHue % 360) + 360) % 360
    val bloomColor = Color.hsl(hue.toFloat(), 0.50f, 0.24f)

    Box(Modifier.fillMaxSize().background(Bg)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 32.dp),
        ) {
            item(key = "artist-header") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            Brush.verticalGradient(
                                0.0f to bloomColor,
                                0.62f to bloomColor.copy(alpha = 0.22f),
                                1.0f to Bg,
                            ),
                        ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .statusBarsPadding()
                            .padding(top = 52.dp, bottom = 14.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        ArtistSleeveStack(
                            albums = artist.albums,
                            modifier = Modifier.size(132.dp),
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = artist.name,
                            color = Ink,
                            fontSize = 26.sp,
                            lineHeight = 30.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = (-0.7).sp,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(horizontal = 24.dp),
                        )
                        Text(
                            text = "${plural(artist.albumCount, "album", "albums")} · ${plural(artist.trackCount, "track", "tracks")}",
                            color = Dim,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 20.dp)
                                .padding(top = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            HeroPrimaryButton(
                                text = "Play",
                                icon = PlayIcon,
                                shape = PillShape,
                                onClick = {
                                    if (allItems.isNotEmpty()) {
                                        model.music.playTrackList(allItems, 0, artist.name, shuffleOn = false)
                                    }
                                },
                                modifier = Modifier.weight(1f).height(46.dp),
                            )
                            HeroGlassButton(
                                text = "Shuffle",
                                icon = ShuffleIcon,
                                shape = PillShape,
                                onClick = {
                                    if (allItems.isNotEmpty()) {
                                        model.music.playTrackList(allItems, -1, artist.name, shuffleOn = true)
                                    }
                                },
                                modifier = Modifier.weight(1f).height(46.dp),
                            )
                            Box {
                                Box(
                                    modifier = Modifier
                                        .size(46.dp)
                                        .clip(CircleShape)
                                        .background(GlassBg)
                                        .border(0.75.dp, GlassBorder, CircleShape)
                                        .semantics { contentDescription = "More options" }
                                        .clickable { moreMenu = true },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(MoreVertIcon, null, tint = Ink, modifier = Modifier.size(20.dp))
                                }
                                DropdownMenu(expanded = moreMenu, onDismissRequest = { moreMenu = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Play next") },
                                        onClick = { moreMenu = false; model.music.playNext(allItems, artist.name) },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Play last") },
                                        onClick = { moreMenu = false; model.music.playLast(allItems, artist.name) },
                                    )
                                }
                            }
                        }
                    }
                }
            }

            item(key = "artist-albums") {
                val haptics = LocalHapticFeedback.current
                Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(title = "Albums")
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(artist.albums, key = { it.key }) { album ->
                            AlbumShelfCard(
                                album = album,
                                onOpen = { onOpenAlbum(album.key) },
                                onPlay = {
                                    val list = album.toTrackItems()
                                    if (list.isNotEmpty()) {
                                        model.music.playTrackList(list, 0, album.album.ifBlank { album.title }, shuffleOn = false)
                                    }
                                },
                                onLongClick = {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    model.openPeek(PeekTarget.LibraryAlbum(album))
                                },
                            )
                        }
                    }
                }
            }

            item(key = "tracks-heading") {
                SectionHeader(title = "Top Tracks", modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
            }

            itemsIndexed(visibleTracks, key = { idx, row -> "${row.entry.key}-$idx" }) { idx, row ->
                FlatTrackRow(
                    row = row,
                    isPlaying = row.entry.key == activeKey,
                    onPlay = {
                        // Rule 13: Plays the artist's visible tracks list from this row.
                        model.music.playTrackList(visibleTracks.map { it.toTrackItem() }, idx, artist.name)
                    },
                    onPlayNext = { model.music.playNext(listOf(row.toTrackItem()), artist.name) },
                    onPlayLast = { model.music.playLast(listOf(row.toTrackItem()), artist.name) },
                    onOpenAlbum = { onOpenAlbum(row.album.key) },
                    onOpenArtist = {},
                )
                HorizontalDivider(color = Line.copy(alpha = 0.30f), modifier = Modifier.padding(horizontal = 20.dp))
            }

            if (!showAllTracks && artist.tracks.size > 8) {
                item(key = "show-all") {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        TextButton(onClick = { showAllTracks = true }) {
                            Text("Show all ${artist.tracks.size}", color = BrandHover, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }

        FloatingDetailBackButton(
            onBack = onBack,
            modifier = Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(start = 16.dp, top = 8.dp),
        )
    }
}

@Composable
private fun FloatingDetailBackButton(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
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

@Composable
internal fun DetailTopBar(title: String, onBack: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CinemaIcon(BackIcon, "Back", Ink, onClick = onBack)
        if (title.isNotEmpty()) {
            Text(
                text = title,
                color = Ink,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 6.dp),
            )
        }
    }
}
