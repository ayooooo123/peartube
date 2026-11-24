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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.peartube.app.LibraryKind
import com.peartube.app.Room
import com.peartube.app.findIn
import com.peartube.app.plural
import com.peartube.app.tileFactsLine
import com.peartube.app.toTrackItem
import com.peartube.app.toTrackItems
import com.peartube.shared.formatBytes

private val HEX_KEY_RE = Regex("^[a-fA-F0-9]{64}$")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DiscoverScreen(
    model: AppModel,
    catalog: LibraryCatalog,
) {
    val status by model.status.collectAsState()
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
                Text("Ask other relays for albums, movies, or series you do not have yet.", color = Dim, fontSize = 14.sp)
                PrimaryLightButton(
                    text = "Search other relays",
                    icon = SearchIcon,
                    onClick = { model.selectRoom(Room.Search, focusSearch = true) },
                )
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
    val autoFocus by model.searchAutoFocus.collectAsState()
    val musicState by model.musicState.collectAsState()
    var scanner by remember { mutableStateOf(false) }

    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    LaunchedEffect(autoFocus) {
        if (autoFocus) {
            runCatching { focusRequester.requestFocus() }
            model.searchAutoFocus.value = false
        }
    }

    val trimmed = query.trim()
    val isLink = trimmed.startsWith("peartube://", ignoreCase = true) || HEX_KEY_RE.matches(trimmed)

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

    val submit = {
        if (isLink) {
            model.openUriOrKey(trimmed)
            model.query.value = ""
        } else if (trimmed.length >= 2) {
            model.searchGlobal(trimmed)
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
            placeholder = { Text("Blue Train", fontSize = 14.sp) },
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
                Text("Search your library and other relays", color = Dim, fontSize = 14.sp)
                if (sampleArtists.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        sampleArtists.forEach { name ->
                            AssistChip(
                                onClick = { model.openSearchFor(name, askRelays = false) },
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
                                    // Rule 13: Track row in search results plays that list from that row.
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

    if (scanner) {
        QrScannerSheet(
            onScanned = {
                scanner = false
                if (it.startsWith("peartube:", true)) model.openUriOrKey(it) else model.pairCastByUriOrHost(it)
            },
            onClose = { scanner = false },
        )
    }
}
