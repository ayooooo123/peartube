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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
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
import com.peartube.app.ArtistGroup
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryTile
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
) {
    var tab by rememberSaveable { mutableStateOf(ListenTab.Albums) }
    var savedOnly by rememberSaveable { mutableStateOf(false) }
    var trackFilter by rememberSaveable { mutableStateOf("") }
    var trackSort by rememberSaveable { mutableStateOf(TrackSort.Title) }
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

    if (catalog.albums.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("No albums yet.", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text("Follow a channel with music or search other relays.", color = Dim, fontSize = 14.sp)
                Spacer(Modifier.height(4.dp))
                PrimaryLightButton("Add to library", onClick = { model.pushScreen(Screen.Settings) })
            }
        }
        return
    }

    val countLabel = when (tab) {
        ListenTab.Albums -> plural(filteredAlbums.size, "album", "albums")
        ListenTab.Artists -> plural(artists.size, "artist", "artists")
        ListenTab.Tracks -> plural(tracks.size, "track", "tracks")
    }

    Column(Modifier.fillMaxSize()) {
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

        // Count + Saved here switch
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(countLabel, color = Dim, fontSize = 13.sp, modifier = Modifier.weight(1f))
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

        if (tab == ListenTab.Tracks) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = trackFilter,
                    onValueChange = { trackFilter = it },
                    singleLine = true,
                    placeholder = { Text("Filter tracks", fontSize = 13.sp) },
                    leadingIcon = { Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(18.dp)) },
                    trailingIcon = if (trackFilter.isNotEmpty()) {
                        { CinemaIcon(CloseIcon, "Clear filter") { trackFilter = "" } }
                    } else null,
                    shape = ControlShape,
                    colors = fieldColors(),
                    modifier = Modifier.weight(1f),
                )
                Box {
                    QuietActionButton(
                        text = "${trackSort.label} ${if (sortAsc) "↑" else "↓"}",
                        icon = SortIcon,
                        onClick = { sortMenu = true },
                    )
                    DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                        TrackSort.entries.forEach { option ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        text = if (option == trackSort) "${option.label} (${if (sortAsc) "A–Z" else "Z–A"})" else option.label,
                                        color = if (option == trackSort) Brand else Ink,
                                    )
                                },
                                onClick = {
                                    sortMenu = false
                                    if (trackSort == option) sortAsc = !sortAsc
                                    else {
                                        trackSort = option
                                        sortAsc = option != TrackSort.Size
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }

        if (filteredAlbums.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text("No album here is saved on this device.", color = Dim, fontSize = 14.sp)
            }
            return
        }

        when (tab) {
            ListenTab.Albums -> {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(16.dp),
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
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            ListenTab.Artists -> {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    contentPadding = PaddingValues(16.dp),
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
                        contentPadding = PaddingValues(bottom = 24.dp),
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
            .padding(start = 16.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AlbumSleeve(
            hue = row.album.hue,
            seed = row.album.seed,
            monogramText = row.album.monogramText,
            cornerRadius = 6.dp,
            fontSize = 12.sp,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = row.name,
                color = if (isPlaying) Brand else Ink,
                fontSize = 14.sp,
                fontWeight = if (isPlaying) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = listOfNotNull(
                    row.artist.takeIf { it.isNotBlank() },
                    row.albumName.takeIf { it.isNotBlank() },
                    row.size.takeIf { it > 0L }?.let { formatBytes(it) },
                ).joinToString(" · "),
                color = Dim,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
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
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            DetailTopBar(title = "Album", onBack = onBack)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Album not found.", color = Dim)
            }
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
        album.totalSize.takeIf { it > 0L }?.let { formatBytes(it) },
        stateLabel,
    ).joinToString(" · ")
    val activeKey = musicState.currentTrack?.key
    val albumTitle = album.album.ifBlank { album.title }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        DetailTopBar(title = "", onBack = onBack)
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
        ) {
            item(key = "header") {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        AlbumSleeve(
                            hue = album.hue,
                            seed = album.seed,
                            monogramText = album.monogramText,
                            fontSize = 32.sp,
                            modifier = Modifier.size(124.dp),
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Album", color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            Text(albumTitle, color = Ink, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            if (album.artist.isNotBlank()) {
                                Text(
                                    text = album.artist,
                                    color = Brand,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.clickable { onOpenArtist(fold(album.artist)) },
                                )
                            }
                            Text(facts, color = if (isOk) Accent else Dim, fontSize = 12.sp)
                            if (album.isYoutubeOnly) {
                                Text("YouTube · Lossy", color = Warn, fontSize = 12.sp)
                            }
                        }
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        PrimaryLightButton(
                            text = "Play",
                            icon = PlayIcon,
                            onClick = {
                                if (trackItems.isNotEmpty()) {
                                    model.music.playTrackList(trackItems, 0, albumTitle, shuffleOn = false)
                                }
                            },
                        )
                        QuietActionButton(
                            text = "Shuffle",
                            icon = ShuffleIcon,
                            onClick = {
                                if (trackItems.isNotEmpty()) {
                                    model.music.playTrackList(trackItems, -1, albumTitle, shuffleOn = true)
                                }
                            },
                        )
                        Box {
                            QuietActionButton(text = "More", onClick = { moreMenu = true })
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
                HorizontalDivider(color = Line, modifier = Modifier.padding(top = 8.dp))
            }

            itemsIndexed(album.items, key = { idx, item -> "${item.entry.key}-$idx" }) { idx, item ->
                val e = item.entry
                val isPlaying = e.key == activeKey
                val isDl = downloads.containsKey(e.key)
                val canDelete = status?.let { it.writable && it.channel.isNotEmpty() && it.channel == e.source } == true
                val metaParts = listOfNotNull(
                    e.music?.artist?.takeIf { it.isNotBlank() && it != album.artist },
                    if (!isSaved(e)) "On the network" else null,
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
                        .padding(start = 18.dp, end = 4.dp, top = 11.dp, bottom = 11.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(34.dp), contentAlignment = Alignment.CenterStart) {
                        if (isPlaying) {
                            Icon(PlayIcon, "Playing", tint = Brand, modifier = Modifier.size(16.dp))
                        } else {
                            Text(trackNo(e).ifEmpty { "${idx + 1}" }, color = Dim, fontSize = 13.sp)
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = trackName(e),
                            color = if (isPlaying) Brand else Ink,
                            fontSize = 15.sp,
                            fontWeight = if (isPlaying) FontWeight.SemiBold else FontWeight.Normal,
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
                HorizontalDivider(color = Line.copy(alpha = 0.4f))
            }

            if (moreByArtist.isNotEmpty()) {
                item(key = "more-by-artist") {
                    Column(Modifier.padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        SectionHeader(title = "More by ${album.artist}")
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 16.dp),
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
                                )
                            }
                        }
                    }
                }
            }
        }
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
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            DetailTopBar(title = "Artist", onBack = onBack)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Artist not found.", color = Dim)
            }
        }
        return
    }

    val musicState by model.musicState.collectAsState()
    var showAllTracks by remember(artist.key) { mutableStateOf(false) }
    var moreMenu by remember { mutableStateOf(false) }
    val allItems = remember(artist) { artist.tracks.map { it.toTrackItem() } }
    val visibleTracks = if (showAllTracks) artist.tracks else artist.tracks.take(8)
    val activeKey = musicState.currentTrack?.key

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        DetailTopBar(title = "", onBack = onBack)
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
        ) {
            item(key = "artist-header") {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text("Artist", color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                    Text(artist.name, color = Ink, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                    Text(
                        "${plural(artist.albumCount, "album", "albums")} · ${plural(artist.trackCount, "track", "tracks")}",
                        color = Dim,
                        fontSize = 13.sp,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        PrimaryLightButton(
                            text = "Play",
                            icon = PlayIcon,
                            onClick = {
                                if (allItems.isNotEmpty()) {
                                    model.music.playTrackList(allItems, 0, artist.name, shuffleOn = false)
                                }
                            },
                        )
                        QuietActionButton(
                            text = "Shuffle",
                            icon = ShuffleIcon,
                            onClick = {
                                if (allItems.isNotEmpty()) {
                                    model.music.playTrackList(allItems, -1, artist.name, shuffleOn = true)
                                }
                            },
                        )
                        Box {
                            QuietActionButton(text = "More", onClick = { moreMenu = true })
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

            item(key = "artist-albums") {
                Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionHeader(title = "Albums")
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp),
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
                            )
                        }
                    }
                }
            }

            item(key = "tracks-heading") {
                SectionHeader(title = "Tracks", modifier = Modifier.padding(top = 18.dp))
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
                HorizontalDivider(color = Line.copy(alpha = 0.4f))
            }

            if (!showAllTracks && artist.tracks.size > 8) {
                item(key = "show-all") {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        TextButton(onClick = { showAllTracks = true }) {
                            Text("Show all ${artist.tracks.size}", color = Brand, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun DetailTopBar(title: String, onBack: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(52.dp)
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
