package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.LibraryCatalog
import com.peartube.app.Room
import com.peartube.app.RumbleCandidate
import com.peartube.app.Screen
import com.peartube.app.SearchSource
import com.peartube.app.SoulseekAlbumCandidate
import com.peartube.app.SoulseekShelfFolder
import com.peartube.app.SoundCloudCandidate
import com.peartube.app.YouTubeCandidate
import com.peartube.app.findIn
import com.peartube.app.plural
import com.peartube.app.tileFactsLine
import com.peartube.app.toTrackItem
import com.peartube.app.toTrackItems
import com.peartube.shared.clock
import com.peartube.shared.formatBytes

private val HEX_KEY_RE = Regex("^[a-fA-F0-9]{64}$")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DiscoverScreen(
    model: AppModel,
    catalog: LibraryCatalog,
) {
    val status by model.status.collectAsState()
    val visitedShelves by model.visitedShelves.collectAsState()
    val discovered = status?.discoveredSources.orEmpty()
    val artistNames = remember(catalog.artists) {
        catalog.artists.map { it.name }.filter { it.isNotBlank() && it != "Unknown artist" }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item(key = "discover-search-cta") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Discover", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Text("Search Soulseek, YouTube, SoundCloud, Rumble, and other relays for albums, videos, and tracks.", color = Dim, fontSize = 14.sp)
                PrimaryLightButton(
                    text = "Search sources & relays",
                    icon = SearchIcon,
                    onClick = { model.selectRoom(Room.Search, focusSearch = true) },
                )
            }
        }

        if (visitedShelves.isNotEmpty()) {
            item(key = "discover-shelves") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Shelves you visited", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    visitedShelves.forEach { shelf ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { model.openShelf(shelf.peer) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(shelf.peer, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                val sub = if (shelf.folderCount > 0) {
                                    "Soulseek · ${plural(shelf.folderCount, "folder", "folders")}"
                                } else {
                                    "Soulseek shelf"
                                }
                                Text(sub, color = Dim, fontSize = 12.sp)
                            }
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }

        item(key = "discover-network") {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Channels on your network", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                if (discovered.isEmpty()) {
                    Text("No channels announced on your Wi-Fi right now.", color = Dim, fontSize = 13.sp)
                } else {
                    discovered.forEach { found ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(found.title.ifBlank { "Channel ${found.key.take(8)}" }, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                                if (found.via.isNotBlank()) {
                                    Text(found.via, color = Dim, fontSize = 12.sp)
                                }
                            }
                            TextButton(onClick = { model.subscribeDiscovered(found) }) {
                                Text("Follow", color = Brand, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }

        if (artistNames.isNotEmpty()) {
            item(key = "discover-artists") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("More from artists you have", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        artistNames.take(24).forEach { name ->
                            AssistChip(
                                onClick = { model.openSearchFor(name, askRelays = true) },
                                label = { Text(name, color = Ink, fontSize = 13.sp) },
                                colors = AssistChipDefaults.assistChipColors(containerColor = CardBg),
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SearchScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
) {
    val query by model.query.collectAsState()
    val global by model.global.collectAsState()
    val sourceSearch by model.sourceSearch.collectAsState()
    val selectedSources by model.selectedSources.collectAsState()
    val soulseekSettings by model.soulseekSettings.collectAsState()
    val plugins by model.plugins.collectAsState()
    val autoFocus by model.searchAutoFocus.collectAsState()
    val musicState by model.musicState.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    var pendingYouTubeSave by remember { mutableStateOf<YouTubeCandidate?>(null) }

    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    androidx.compose.runtime.LaunchedEffect(autoFocus) {
        if (autoFocus) {
            runCatching { focusRequester.requestFocus() }
            model.searchAutoFocus.value = false
        }
    }

    val trimmed = query.trim()
    val isLink = trimmed.startsWith("peartube://", ignoreCase = true) ||
        trimmed.startsWith("http://", ignoreCase = true) ||
        trimmed.startsWith("https://", ignoreCase = true) ||
        HEX_KEY_RE.matches(trimmed)

    val matcher = remember(trimmed) { findIn(trimmed) }
    val matchedAlbums = remember(catalog.albums, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.albums.filter { matcher.matches(it.title) || matcher.matches(it.album) || matcher.matches(it.artist) }
    }
    val matchedTracks = remember(catalog.allTracks, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.allTracks.filter { matcher.matchesTrack(it.name, "${it.album.title} ${it.artist}") }
    }
    val matchedFilms = remember(catalog.movies, catalog.series, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else (catalog.movies + catalog.series).filter { matcher.matches(it.title) }
    }
    val matchedClips = remember(catalog.clips, matcher, isLink) {
        if (isLink || matcher.isEmpty) emptyList()
        else catalog.clips.filter { matcher.matches(it.title) }
    }

    val soulseekPlugin = remember(plugins) { plugins.firstOrNull { it.name.equals("soulseek", ignoreCase = true) } }
    val soulseekConfigured = soulseekSettings.isConfigured || (soulseekPlugin?.configured == true)

    val submit = {
        if (isLink) {
            model.handleSharedText(trimmed)
            model.query.value = ""
        } else if (trimmed.length >= 2) {
            model.searchAll(trimmed)
        }
        focusManager.clearFocus()
    }

    val sampleArtists = remember(catalog.artists) {
        catalog.artists.map { it.name }.filter { it.isNotBlank() && it != "Unknown artist" }.take(8)
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { model.query.value = it },
            singleLine = true,
            label = { Text("Search") },
            placeholder = { Text("Blue Train, artist, or link", fontSize = 14.sp) },
            leadingIcon = { Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(20.dp)) },
            trailingIcon = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (query.isNotEmpty()) CinemaIcon(CloseIcon, "Clear search") { model.query.value = "" }
                    CinemaIcon(QrCodeScannerIcon, "Scan QR code") { scanner = true }
                }
            },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Search,
            ),
            keyboardActions = KeyboardActions(onSearch = { submit() }),
            shape = ControlShape,
            colors = fieldColors(),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .focusRequester(focusRequester),
        )

        if (isLink) {
            Row(
                Modifier
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .fillMaxWidth()
                    .clip(CardShape)
                    .background(CardElevated)
                    .border(1.dp, Line, CardShape)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("This is a link.", color = Ink, fontSize = 14.sp, modifier = Modifier.weight(1f))
                PrimaryLightButton("Add to library", onClick = submit)
            }
        }

        if (trimmed.isEmpty()) {
            Column(
                Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Search your library, your sources, and other relays", color = Dim, fontSize = 14.sp)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SearchSource.entries.forEach { src ->
                        val selected = src in selectedSources
                        FilterChip(
                            selected = selected,
                            onClick = { model.toggleSearchSource(src) },
                            label = { Text(src.label, fontSize = 12.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = Brand.copy(alpha = 0.22f),
                                selectedLabelColor = Ink,
                            ),
                        )
                    }
                }
                if (sampleArtists.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        sampleArtists.forEach { name ->
                            AssistChip(
                                onClick = { model.openSearchFor(name, askRelays = true) },
                                label = { Text(name, color = Ink, fontSize = 13.sp) },
                                colors = AssistChipDefaults.assistChipColors(containerColor = CardBg),
                            )
                        }
                    }
                }
            }
        } else if (!isLink) {
            val activeKey = musicState.currentTrack?.key
            LazyColumn(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(top = 8.dp, bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                val hasLibraryHits = matchedAlbums.isNotEmpty() || matchedTracks.isNotEmpty() || matchedFilms.isNotEmpty() || matchedClips.isNotEmpty()
                item(key = "in-library-head") {
                    Text(
                        "In your library",
                        color = Ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                    if (!hasLibraryHits) {
                        Text(
                            "Nothing in your library matches \"$trimmed\".",
                            color = Dim,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }

                if (matchedAlbums.isNotEmpty()) {
                    item(key = "search-albums") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SectionHeader("Albums (${matchedAlbums.size})")
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(matchedAlbums.take(12), key = { it.key }) { album ->
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
                }

                if (matchedTracks.isNotEmpty()) {
                    val shownTracks = matchedTracks.take(12)
                    item(key = "search-tracks-head") {
                        SectionHeader("Tracks (${matchedTracks.size})")
                    }
                    itemsIndexed(shownTracks, key = { idx, r -> "st-${r.entry.key}-$idx" }) { idx, row ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    model.music.playTrackList(shownTracks.map { it.toTrackItem() }, idx, "Search · $trimmed")
                                }
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AlbumSleeve(
                                hue = row.album.hue,
                                seed = row.album.seed,
                                monogramText = row.album.monogramText,
                                cornerRadius = 6.dp,
                                fontSize = 11.sp,
                                modifier = Modifier.size(38.dp),
                            )
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    row.name,
                                    color = if (row.entry.key == activeKey) Brand else Ink,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    listOfNotNull(row.artist.takeIf { it.isNotBlank() }, row.albumName).joinToString(" · "),
                                    color = Dim,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                        HorizontalDivider(color = Line.copy(alpha = 0.4f))
                    }
                }

                if (matchedFilms.isNotEmpty()) {
                    item(key = "search-films-head") { SectionHeader("Movies and series (${matchedFilms.size})") }
                    items(matchedFilms.take(12), key = { "sf-${it.key}" }) { tile ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp)
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { onOpenTitle(tile.key) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
                            }
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }

                if (matchedClips.isNotEmpty()) {
                    item(key = "search-clips-head") { SectionHeader("Clips (${matchedClips.size})") }
                    items(matchedClips.take(12), key = { "sc-${it.key}" }) { tile ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp)
                                .clip(CardShape)
                                .background(CardBg)
                                .border(1.dp, Line, CardShape)
                                .clickable { onOpenTitle(tile.key) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(tile.title, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(tileFactsLine(tile), color = Dim, fontSize = 12.sp)
                            }
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }

                // From your sources (Soulseek, YouTube, SoundCloud, Rumble)
                item(key = "from-your-sources") {
                    HorizontalDivider(color = Line, modifier = Modifier.padding(top = 6.dp))
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val askedSources = sourceSearch.query == trimmed
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("From your sources", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (!askedSources || !sourceSearch.busy) {
                                QuietActionButton(
                                    text = "Ask your sources",
                                    onClick = { if (trimmed.length >= 2) model.searchAll(trimmed) },
                                )
                            }
                        }

                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            SearchSource.entries.forEach { src ->
                                val selected = src in selectedSources
                                FilterChip(
                                    selected = selected,
                                    onClick = { model.toggleSearchSource(src) },
                                    label = { Text(src.label, fontSize = 12.sp) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = Brand.copy(alpha = 0.22f),
                                        selectedLabelColor = Ink,
                                    ),
                                )
                            }
                        }

                        if (SearchSource.Soulseek in selectedSources && !soulseekConfigured) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(CardShape)
                                    .background(CardBg)
                                    .border(1.dp, Line, CardShape)
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    "Sign in to Soulseek in Settings to search peer shelves.",
                                    color = Dim,
                                    fontSize = 12.sp,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = { model.pushScreen(Screen.Settings) }) {
                                    Text("Settings", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                }
                            }
                        }

                        when {
                            trimmed.length < 2 -> Text("Type at least two characters to search your sources.", color = Dim, fontSize = 13.sp)
                            !askedSources -> Text("Press Search or Ask your sources to look on Soulseek, YouTube, SoundCloud, and Rumble.", color = Dim, fontSize = 13.sp)
                            sourceSearch.busy -> Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(color = Brand, strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                                Text("Searching your sources…", color = Dim, fontSize = 13.sp)
                            }
                            sourceSearch.error != null -> Text(sourceSearch.error ?: "", color = Danger, fontSize = 13.sp)
                            sourceSearch.result.isEmpty && sourceSearch.result.errors.isEmpty() ->
                                Text("No results from the selected sources for \"$trimmed\".", color = Dim, fontSize = 13.sp)
                        }

                        if (askedSources && sourceSearch.result.errors.isNotEmpty()) {
                            sourceSearch.result.errors.forEach { (srcName, msg) ->
                                Text("${srcName.replaceFirstChar { it.uppercase() }}: $msg", color = Warn, fontSize = 12.sp)
                            }
                        }

                        if (askedSources && sourceSearch.result.soulseek.isNotEmpty()) {
                            Text("Soulseek (${sourceSearch.result.soulseek.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.soulseek.take(20).forEach { item ->
                                SoulseekResultCard(
                                    item = item,
                                    onSave = { model.saveSoulseekAlbum(item) },
                                    onBrowseShelf = { model.openShelf(item.peer) },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.youtube.isNotEmpty()) {
                            Text("YouTube (${sourceSearch.result.youtube.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.youtube.take(20).forEach { item ->
                                YouTubeResultCard(
                                    item = item,
                                    onSave = { pendingYouTubeSave = item },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.soundcloud.isNotEmpty()) {
                            Text("SoundCloud (${sourceSearch.result.soundcloud.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.soundcloud.take(20).forEach { item ->
                                SoundCloudResultCard(
                                    item = item,
                                    onSave = { model.saveSoundCloudTrack(item) },
                                )
                            }
                        }

                        if (askedSources && sourceSearch.result.rumble.isNotEmpty()) {
                            Text("Rumble (${sourceSearch.result.rumble.size})", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            sourceSearch.result.rumble.take(20).forEach { item ->
                                RumbleResultCard(
                                    item = item,
                                    onSaveVideo = { model.saveRumbleItem(item, audioOnly = false) },
                                    onSaveAudio = { model.saveRumbleItem(item, audioOnly = true) },
                                )
                            }
                        }
                    }
                }

                item(key = "global-relays") {
                    HorizontalDivider(color = Line, modifier = Modifier.padding(top = 6.dp))
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val asked = global.query == trimmed
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("On other relays", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (!asked || !global.busy) {
                                QuietActionButton(
                                    text = "Ask other relays",
                                    onClick = { if (trimmed.length >= 2) model.searchGlobal(trimmed) },
                                )
                            }
                        }
                        val note = when {
                            trimmed.length < 2 -> "Type at least two characters to ask other relays."
                            !asked -> "Press Search or Ask other relays to look outside your channels."
                            global.error != null -> global.error
                            global.rows.isEmpty() -> if (global.busy) "Asking other relays…" else "No relay has it yet. Answers can take a few seconds."
                            else -> null
                        }
                        if (note != null) Text(note, color = Dim, fontSize = 13.sp)
                        if (asked) {
                            global.rows.forEach { row ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(CardShape)
                                        .background(CardBg)
                                        .border(1.dp, Line, CardShape)
                                        .padding(start = 14.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                        Text(row.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        Text(
                                            "${formatBytes(row.size)} · ${plural(row.relays, "relay", "relays")}",
                                            color = Dim,
                                            fontSize = 12.sp,
                                        )
                                    }
                                    TextButton(onClick = { model.openUriOrKey(row.magnetUrl) }) {
                                        Text("Play", color = Brand, fontWeight = FontWeight.SemiBold)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pendingYouTubeSave?.let { yt ->
        YouTubeSaveDialog(
            candidate = yt,
            onDismiss = { pendingYouTubeSave = null },
            onConfirm = { artist, album, year ->
                pendingYouTubeSave = null
                model.saveYouTubeTrack(yt, artist = artist, album = album, year = year)
            },
        )
    }

    if (scanner) {
        QrScannerSheet(
            onScanned = {
                scanner = false
                if (it.startsWith("peartube:", true) || it.startsWith("http://", true) || it.startsWith("https://", true)) {
                    model.handleSharedText(it)
                } else {
                    model.pairCastByUriOrHost(it)
                }
            },
            onClose = { scanner = false },
        )
    }
}

@Composable
fun ShelfDetailScreen(
    model: AppModel,
    peer: String,
    onBack: () -> Unit,
) {
    val state by model.shelfState.collectAsState()
    var filter by remember { mutableStateOf("") }

    val folders = remember(state.shelf, state.peer, peer, filter) {
        val all = if (state.peer == peer) state.shelf?.folders.orEmpty() else emptyList()
        val f = filter.trim()
        if (f.isEmpty()) all
        else all.filter {
            it.displayTitle.contains(f, ignoreCase = true) ||
                it.artist.contains(f, ignoreCase = true) ||
                it.folder.contains(f, ignoreCase = true)
        }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CinemaIcon(BackIcon, "Back", Ink, onClick = onBack)
            Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                Text(peer, color = Ink, fontSize = 18.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val count = if (state.peer == peer) state.shelf?.folders?.size ?: 0 else 0
                Text(
                    if (count > 0) "Soulseek shelf · ${plural(count, "folder", "folders")}" else "Soulseek shelf",
                    color = Dim,
                    fontSize = 12.sp,
                )
            }
            CinemaIcon(ReplayIcon, "Refresh shelf", Dim) { model.loadShelf(peer) }
        }
        HorizontalDivider(color = Line)

        OutlinedTextField(
            value = filter,
            onValueChange = { filter = it },
            singleLine = true,
            placeholder = { Text("Filter folders or artists", fontSize = 13.sp) },
            leadingIcon = { Icon(SearchIcon, null, tint = Dim, modifier = Modifier.size(18.dp)) },
            trailingIcon = if (filter.isNotEmpty()) {
                { CinemaIcon(CloseIcon, "Clear filter") { filter = "" } }
            } else null,
            shape = ControlShape,
            colors = fieldColors(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        )

        when {
            state.busy && folders.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(color = Brand)
                        Text("Browsing $peer's shelf…", color = Dim, fontSize = 14.sp)
                    }
                }
            }
            state.error != null && folders.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(state.error ?: "Could not load shelf.", color = Danger, fontSize = 14.sp)
                        QuietActionButton(text = "Retry", onClick = { model.loadShelf(peer) })
                    }
                }
            }
            folders.isEmpty() -> {
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                    Text(
                        if (filter.isNotBlank()) "No folder matches \"$filter\"." else "No shared folders found for $peer.",
                        color = Dim,
                        fontSize = 14.sp,
                    )
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(folders, key = { it.folder.ifBlank { "${it.artist}-${it.album}" } }) { folder ->
                        ShelfFolderCard(
                            folder = folder,
                            onSave = { model.saveSoulseekFolder(peer, folder) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SoulseekResultCard(
    item: SoulseekAlbumCandidate,
    onSave: () -> Unit,
    onBrowseShelf: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(item.displayTitle, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val artistLine = listOfNotNull(
                    item.artist.takeIf { it.isNotBlank() },
                    item.year.takeIf { it.isNotBlank() },
                    item.peer.takeIf { it.isNotBlank() }?.let { "from $it" },
                ).joinToString(" · ")
                if (artistLine.isNotBlank()) {
                    Text(artistLine, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (item.quality.isNotBlank()) {
                SourceBadge(text = item.quality, highlight = item.quality.startsWith("FLAC", ignoreCase = true))
            }
        }
        val facts = buildList {
            if (item.fileCount > 0) add(plural(item.fileCount, "file", "files"))
            if (item.size > 0L) add(formatBytes(item.size))
            if (item.slotsOpen == true && item.queue == 0) add("Ready now")
            else if (item.queue != null && item.queue > 0) add("Queue ${item.queue}")
        }.joinToString(" · ")
        if (facts.isNotBlank()) {
            Text(facts, color = Dim, fontSize = 12.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryLightButton(text = "Save album", onClick = onSave)
            if (item.peer.isNotBlank()) {
                QuietActionButton(text = "Browse shelf", onClick = onBrowseShelf)
            }
        }
    }
}

@Composable
private fun ShelfFolderCard(
    folder: SoulseekShelfFolder,
    onSave: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(folder.displayTitle, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (folder.artist.isNotBlank()) {
                    Text(folder.artist, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (folder.quality.isNotBlank()) {
                SourceBadge(text = folder.quality, highlight = folder.quality.startsWith("FLAC", ignoreCase = true))
            }
        }
        val facts = buildList {
            if (folder.fileCount > 0) add(plural(folder.fileCount, "file", "files"))
            if (folder.size > 0L) add(formatBytes(folder.size))
        }.joinToString(" · ")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(facts, color = Dim, fontSize = 12.sp, modifier = Modifier.weight(1f))
            PrimaryLightButton(text = "Save album", onClick = onSave)
        }
    }
}

@Composable
private fun YouTubeResultCard(
    item: YouTubeCandidate,
    onSave: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = item.qualityLabel, highlight = false)
            val meta = listOfNotNull(
                item.channel.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row {
            PrimaryLightButton(text = "Save track", onClick = onSave)
        }
    }
}

@Composable
private fun SoundCloudResultCard(
    item: SoundCloudCandidate,
    onSave: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = "SoundCloud", highlight = false)
            val meta = listOfNotNull(
                item.artist.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row {
            PrimaryLightButton(text = "Save track", onClick = onSave)
        }
    }
}

@Composable
private fun RumbleResultCard(
    item: RumbleCandidate,
    onSaveVideo: () -> Unit,
    onSaveAudio: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SourceBadge(text = "Rumble", highlight = false)
            val meta = listOfNotNull(
                item.channel.takeIf { it.isNotBlank() },
                item.durationSec?.let { clock(it * 1000L) },
            ).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryLightButton(text = "Save video", onClick = onSaveVideo)
            QuietActionButton(text = "Save audio", onClick = onSaveAudio)
        }
    }
}

@Composable
private fun SourceBadge(text: String, highlight: Boolean) {
    Box(
        Modifier
            .clip(PillShape)
            .background(if (highlight) Accent.copy(alpha = 0.16f) else CardElevated)
            .border(1.dp, if (highlight) Accent.copy(alpha = 0.45f) else Line, PillShape)
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text(
            text = text,
            color = if (highlight) Accent else Dim,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun YouTubeSaveDialog(
    candidate: YouTubeCandidate,
    onDismiss: () -> Unit,
    onConfirm: (artist: String, album: String, year: String) -> Unit,
) {
    var artist by remember(candidate.videoId) { mutableStateOf(candidate.channel.ifBlank { "YouTube" }) }
    var album by remember(candidate.videoId) { mutableStateOf(candidate.title) }
    var year by remember(candidate.videoId) { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = CardElevated,
        title = { Text("Save to Listen", color = Ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(candidate.title, color = Dim, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                OutlinedTextField(
                    value = artist,
                    onValueChange = { artist = it },
                    singleLine = true,
                    label = { Text("Artist") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = album,
                    onValueChange = { album = it },
                    singleLine = true,
                    label = { Text("Album") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = year,
                    onValueChange = { year = it },
                    singleLine = true,
                    label = { Text("Year (optional)") },
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = artist.isNotBlank() && album.isNotBlank(),
                onClick = { onConfirm(artist, album, year) },
            ) {
                Text("Save", color = Brand, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = Dim)
            }
        },
    )
}
