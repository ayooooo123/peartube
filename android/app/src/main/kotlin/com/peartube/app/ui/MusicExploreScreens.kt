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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.LibraryCatalog
import com.peartube.app.YtmAlbumPage
import com.peartube.app.YtmAlbumSummary
import com.peartube.app.YtmArtistPage
import com.peartube.app.YtmArtistSummary
import com.peartube.app.YtmSongItem
import com.peartube.app.fold
import com.peartube.app.plural
import com.peartube.app.sleeveHash

/**
 * RiPlay-style Artist Page backed by live YouTube Music discography + unified PearTube library shelf.
 */
@Composable
fun ExternalArtistDetailScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    browseId: String,
    initialName: String,
    initialArtUrl: String,
    onBack: () -> Unit,
    onOpenLocalAlbum: (String) -> Unit,
    onOpenExternalAlbum: (browseId: String, title: String, artist: String, artUrl: String) -> Unit,
    onOpenExternalArtist: (browseId: String, name: String, artUrl: String) -> Unit,
) {
    val musicState by model.musicState.collectAsState()
    var page by remember(browseId, initialName) { mutableStateOf<YtmArtistPage?>(null) }
    var loading by remember(browseId, initialName) { mutableStateOf(true) }
    var failed by remember(browseId, initialName) { mutableStateOf(false) }

    LaunchedEffect(browseId, initialName) {
        loading = true
        failed = false
        val loaded = ExternalDiscoveryApi.loadYtmArtist(
            browseId = browseId.takeIf { it.isNotBlank() },
            artistName = initialName,
        )
        page = loaded
        loading = false
        failed = loaded == null
    }

    val displayName = page?.name?.ifBlank { initialName } ?: initialName.ifBlank { "Artist" }
    val heroArt = page?.artUrl?.ifBlank { initialArtUrl } ?: initialArtUrl
    val seed = remember(displayName) { sleeveHash(fold(displayName)) }
    val hue = remember(seed) { (((seed % 360L).toInt()) + 360) % 360 }
    val topGlow = Color.hsl(hue.toFloat(), 0.52f, 0.24f, alpha = 0.36f)
    val localAlbums = remember(catalog.albums, displayName) {
        catalog.albumsByArtist(displayName)
    }
    val ownedTrackSignatures = remember(catalog.allTracks) {
        catalog.allTracks.map { "${fold(it.artist)}|${fold(it.name)}" }.toHashSet()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Bg),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(340.dp)
                .background(
                    Brush.verticalGradient(
                        0.0f to topGlow,
                        0.65f to Bg.copy(alpha = 0.85f),
                        1.0f to Bg,
                    ),
                ),
        )

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding(),
            contentPadding = PaddingValues(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item(key = "header") {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CinemaIcon(BackIcon, "Back", Ink, onClick = onBack)
                        Spacer(Modifier.weight(1f))
                        CinemaIcon(
                            icon = SearchIcon,
                            description = "Find lossless",
                            tint = Dim,
                            onClick = { model.openSearchFor(displayName, askRelays = true) },
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    ArtistPortraitCircle(
                        name = displayName,
                        artUrl = heroArt,
                        hue = hue,
                        size = 132.dp,
                    )
                    Spacer(Modifier.height(14.dp))
                    Text(
                        text = displayName,
                        color = Ink,
                        fontSize = 26.sp,
                        lineHeight = 30.sp,
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.7).sp,
                        textAlign = TextAlign.Center,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val meta = listOfNotNull(
                        page?.monthlyListeners?.takeIf { it.isNotBlank() },
                        localAlbums.takeIf { it.isNotEmpty() }?.let { "${plural(it.size, "album", "albums")} in library" },
                    ).joinToString(" · ")
                    if (meta.isNotEmpty()) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = meta,
                            color = Dim,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    val songs = page?.topSongs.orEmpty()
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ExplorePrimaryPill(
                            label = "Play",
                            icon = PlayIcon,
                            enabled = songs.isNotEmpty(),
                            onClick = {
                                model.playYtmSongList(songs, startIndex = 0, sourceLabel = displayName, shuffleOn = false)
                            },
                        )
                        ExploreSecondaryPill(
                            label = "Shuffle",
                            icon = ShuffleIcon,
                            enabled = songs.isNotEmpty(),
                            onClick = {
                                model.playYtmSongList(songs, startIndex = -1, sourceLabel = displayName, shuffleOn = true)
                            },
                        )
                        ExploreSecondaryPill(
                            label = "Lossless",
                            icon = SearchIcon,
                            enabled = true,
                            onClick = { model.openSearchFor(displayName, askRelays = true) },
                        )
                    }
                }
            }

            if (localAlbums.isNotEmpty()) {
                item(key = "local-albums") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            text = "In Your Library",
                            color = Ink,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(localAlbums, key = { "loc-${it.key}" }) { album ->
                                Column(
                                    modifier = Modifier
                                        .width(134.dp)
                                        .clickable { onOpenLocalAlbum(album.key) },
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    AlbumSleeve(
                                        hue = album.hue,
                                        seed = album.seed,
                                        monogramText = album.monogramText,
                                        artist = album.artist,
                                        albumName = album.album.ifBlank { album.title },
                                        cornerRadius = 12.dp,
                                        fontSize = 26.sp,
                                        modifier = Modifier.size(134.dp),
                                    )
                                    Text(
                                        text = album.album.ifBlank { album.title },
                                        color = Ink,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        text = plural(album.items.size, "track", "tracks"),
                                        color = Accent,
                                        fontSize = 11.5.sp,
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            if (loading && page == null) {
                item(key = "loading") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 40.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = BrandHover, strokeWidth = 2.5.dp)
                    }
                }
            } else if (failed) {
                item(key = "empty") {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 24.dp, vertical = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = "Could not load artist discography right now.",
                            color = Dim,
                            fontSize = 14.sp,
                            textAlign = TextAlign.Center,
                        )
                        ExploreSecondaryPill(
                            label = "Search Sources",
                            icon = SearchIcon,
                            enabled = true,
                            onClick = { model.openSearchFor(displayName, askRelays = true) },
                        )
                    }
                }
            }

            val topSongs = page?.topSongs.orEmpty()
            if (topSongs.isNotEmpty()) {
                item(key = "top-songs-title") {
                    Text(
                        text = "Top Songs",
                        color = Ink,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(horizontal = 20.dp),
                    )
                }
                itemsIndexed(topSongs, key = { idx, s -> "song-$idx-${s.videoId}" }) { idx, song ->
                    val inLibrary = "${fold(song.artist.ifBlank { displayName })}|${fold(song.title)}" in ownedTrackSignatures
                    val activeKey = musicState.currentTrack?.let { it.externalVideoId == song.videoId || (fold(it.title) == fold(song.title) && fold(it.artist) == fold(song.artist.ifBlank { displayName })) } == true
                    YtmSongListRow(
                        song = song,
                        indexLabel = null,
                        inLibrary = inLibrary,
                        isActive = activeKey,
                        isBuffering = activeKey && musicState.buffering && musicState.playing,
                        isPlaying = activeKey && musicState.playing,
                        onPlay = {
                            model.playYtmSongList(topSongs, startIndex = idx, sourceLabel = displayName, shuffleOn = false)
                        },
                        onSave = { model.saveYtmSongToLibrary(song) },
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                }
            }

            val albums = page?.albums.orEmpty()
            if (albums.isNotEmpty()) {
                item(key = "albums-shelf") {
                    YtmAlbumCarouselShelf(
                        title = "Albums",
                        albums = albums,
                        onOpenAlbum = { alb ->
                            onOpenExternalAlbum(alb.browseId, alb.title, alb.artist.ifBlank { displayName }, alb.artUrl)
                        },
                    )
                }
            }

            val singles = page?.singles.orEmpty()
            if (singles.isNotEmpty()) {
                item(key = "singles-shelf") {
                    YtmAlbumCarouselShelf(
                        title = "Singles & EPs",
                        albums = singles,
                        onOpenAlbum = { alb ->
                            onOpenExternalAlbum(alb.browseId, alb.title, alb.artist.ifBlank { displayName }, alb.artUrl)
                        },
                    )
                }
            }

            val related = page?.relatedArtists.orEmpty()
            if (related.isNotEmpty()) {
                item(key = "related-artists") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            text = "Fans Also Like",
                            color = Ink,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            items(related, key = { "rel-${it.browseId}" }) { artist ->
                                YtmArtistChipCard(
                                    artist = artist,
                                    onClick = { onOpenExternalArtist(artist.browseId, artist.name, artist.artUrl) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * RiPlay-style Album Page with complete numbered tracklist, 1-tap play/shuffle, and Save to PearTube Music Library.
 */
@Composable
fun ExternalAlbumDetailScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    browseId: String,
    initialTitle: String,
    initialArtist: String,
    initialArtUrl: String,
    onBack: () -> Unit,
    onOpenExternalArtist: (browseId: String, name: String, artUrl: String) -> Unit,
) {
    val musicState by model.musicState.collectAsState()
    var page by remember(browseId, initialTitle, initialArtist) { mutableStateOf<YtmAlbumPage?>(null) }
    var loading by remember(browseId, initialTitle, initialArtist) { mutableStateOf(true) }
    var failed by remember(browseId, initialTitle, initialArtist) { mutableStateOf(false) }

    LaunchedEffect(browseId, initialTitle, initialArtist) {
        loading = true
        failed = false
        val loaded = ExternalDiscoveryApi.loadYtmAlbum(
            browseId = browseId.takeIf { it.isNotBlank() },
            artist = initialArtist,
            albumTitle = initialTitle,
        )
        page = loaded
        loading = false
        failed = loaded == null
    }

    val displayTitle = page?.title?.ifBlank { initialTitle } ?: initialTitle.ifBlank { "Album" }
    val displayArtist = page?.artist?.ifBlank { initialArtist } ?: initialArtist
    val heroArt = page?.artUrl?.ifBlank { initialArtUrl } ?: initialArtUrl
    val seed = remember(displayArtist, displayTitle) { sleeveHash("${fold(displayArtist)}\n${fold(displayTitle)}") }
    val hue = remember(seed) { (((seed % 360L).toInt()) + 360) % 360 }
    val topGlow = Color.hsl(hue.toFloat(), 0.54f, 0.24f, alpha = 0.36f)
    val ownedTrackSignatures = remember(catalog.allTracks) {
        catalog.allTracks.map { "${fold(it.artist)}|${fold(it.name)}" }.toHashSet()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Bg),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(360.dp)
                .background(
                    Brush.verticalGradient(
                        0.0f to topGlow,
                        0.68f to Bg.copy(alpha = 0.85f),
                        1.0f to Bg,
                    ),
                ),
        )

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding(),
            contentPadding = PaddingValues(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "album-header") {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CinemaIcon(BackIcon, "Back", Ink, onClick = onBack)
                        Spacer(Modifier.weight(1f))
                        CinemaIcon(
                            icon = SearchIcon,
                            description = "Find lossless",
                            tint = Dim,
                            onClick = {
                                val q = listOf(displayArtist, displayTitle).filter { it.isNotBlank() }.joinToString(" ")
                                model.openSearchFor(q, askRelays = true)
                            },
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Box(
                        modifier = Modifier
                            .size(204.dp)
                            .shadow(22.dp, RoundedCornerShape(18.dp)),
                    ) {
                        AlbumSleeve(
                            hue = hue,
                            seed = seed,
                            monogramText = displayTitle.take(2).uppercase(),
                            artist = displayArtist,
                            albumName = displayTitle,
                            artUrl = heroArt.takeIf { it.isNotBlank() },
                            cornerRadius = 18.dp,
                            fontSize = 44.sp,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(
                        text = displayTitle,
                        color = Ink,
                        fontSize = 22.sp,
                        lineHeight = 26.sp,
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.5).sp,
                        textAlign = TextAlign.Center,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (displayArtist.isNotBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = displayArtist,
                            color = BrandHover,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            textAlign = TextAlign.Center,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.clickable {
                                onOpenExternalArtist(page?.artistBrowseId.orEmpty(), displayArtist, "")
                            },
                        )
                    }
                    val tracks = page?.tracks.orEmpty()
                    val facts = listOfNotNull(
                        page?.year?.takeIf { it.isNotBlank() },
                        tracks.takeIf { it.isNotEmpty() }?.let { plural(it.size, "track", "tracks") },
                    ).joinToString(" · ")
                    if (facts.isNotEmpty()) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = facts,
                            color = Dim,
                            fontSize = 12.5.sp,
                            maxLines = 1,
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ExplorePrimaryPill(
                            label = "Play",
                            icon = PlayIcon,
                            enabled = tracks.isNotEmpty(),
                            onClick = {
                                model.playYtmSongList(tracks, startIndex = 0, sourceLabel = displayTitle, shuffleOn = false)
                            },
                        )
                        ExploreSecondaryPill(
                            label = "Shuffle",
                            icon = ShuffleIcon,
                            enabled = tracks.isNotEmpty(),
                            onClick = {
                                model.playYtmSongList(tracks, startIndex = -1, sourceLabel = displayTitle, shuffleOn = true)
                            },
                        )
                        ExploreSecondaryPill(
                            label = "Save",
                            icon = AddIcon,
                            enabled = tracks.isNotEmpty(),
                            onClick = { page?.let { model.saveYtmAlbumToLibrary(it) } },
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                }
            }

            if (loading && page == null) {
                item(key = "alb-loading") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 40.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = BrandHover, strokeWidth = 2.5.dp)
                    }
                }
            } else if (failed) {
                item(key = "alb-failed") {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 24.dp, vertical = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = "Could not load album tracklist right now.",
                            color = Dim,
                            fontSize = 14.sp,
                            textAlign = TextAlign.Center,
                        )
                        ExploreSecondaryPill(
                            label = "Find Lossless",
                            icon = SearchIcon,
                            enabled = true,
                            onClick = {
                                val q = listOf(displayArtist, displayTitle).filter { it.isNotBlank() }.joinToString(" ")
                                model.openSearchFor(q, askRelays = true)
                            },
                        )
                    }
                }
            }

            val tracks = page?.tracks.orEmpty()
            itemsIndexed(tracks, key = { idx, t -> "trk-$idx-${t.videoId}" }) { idx, song ->
                val inLibrary = "${fold(song.artist.ifBlank { displayArtist })}|${fold(song.title)}" in ownedTrackSignatures
                val isActive = musicState.currentTrack?.let {
                    it.externalVideoId == song.videoId ||
                        (fold(it.title) == fold(song.title) && fold(it.artist) == fold(song.artist.ifBlank { displayArtist }))
                } == true
                YtmSongListRow(
                    song = song,
                    indexLabel = (idx + 1).toString().padStart(2, '0'),
                    inLibrary = inLibrary,
                    isActive = isActive,
                    isBuffering = isActive && musicState.buffering && musicState.playing,
                    isPlaying = isActive && musicState.playing,
                    onPlay = {
                        model.playYtmSongList(tracks, startIndex = idx, sourceLabel = displayTitle, shuffleOn = false)
                    },
                    onSave = { model.saveYtmSongToLibrary(song) },
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
        }
    }
}

@Composable
internal fun YtmSongListRow(
    song: YtmSongItem,
    indexLabel: String?,
    inLibrary: Boolean,
    isActive: Boolean,
    isBuffering: Boolean,
    isPlaying: Boolean,
    onPlay: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val rowShape = RoundedCornerShape(14.dp)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(rowShape)
            .background(if (isActive) Brand.copy(alpha = 0.16f) else CardBg.copy(alpha = 0.72f))
            .border(
                width = 0.5.dp,
                color = if (isActive) Brand.copy(alpha = 0.5f) else GlassBorder,
                shape = rowShape,
            )
            .clickable(onClick = onPlay)
            .padding(start = 10.dp, end = 6.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (indexLabel != null) {
            Box(
                modifier = Modifier.width(30.dp),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    isBuffering -> CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        color = BrandHover,
                        strokeWidth = 1.8.dp,
                    )
                    isActive -> Icon(
                        imageVector = if (isPlaying) PauseIcon else PlayIcon,
                        contentDescription = null,
                        tint = BrandHover,
                        modifier = Modifier.size(16.dp),
                    )
                    else -> Text(
                        text = indexLabel,
                        color = Dim,
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
        } else {
            val seed = sleeveHash("${song.artist}|${song.title}|${song.videoId}")
            val hue = (((seed % 360L).toInt()) + 360) % 360
            Box(modifier = Modifier.size(46.dp)) {
                AlbumSleeve(
                    hue = hue,
                    seed = seed,
                    monogramText = song.title.take(2).uppercase(),
                    artist = song.artist,
                    albumName = song.album.ifBlank { song.title },
                    artUrl = song.artUrl.takeIf { it.isNotBlank() },
                    cornerRadius = 10.dp,
                    fontSize = 15.sp,
                    modifier = Modifier.fillMaxSize(),
                )
                if (isActive) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .clip(RoundedCornerShape(10.dp))
                            .background(Bg.copy(alpha = 0.55f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (isBuffering) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                color = Pearl,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                imageVector = if (isPlaying) PauseIcon else PlayIcon,
                                contentDescription = null,
                                tint = Pearl,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.width(12.dp))
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = song.title,
                color = if (isActive) BrandHover else Ink,
                fontSize = 14.5.sp,
                fontWeight = if (isActive) FontWeight.SemiBold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = listOfNotNull(
                song.artist.takeIf { it.isNotBlank() },
                song.album.takeIf { it.isNotBlank() && indexLabel == null },
                song.playsText.takeIf { it.isNotBlank() && indexLabel == null },
                if (inLibrary) "In library" else null,
            ).joinToString(" · ")
            if (sub.isNotEmpty()) {
                Text(
                    text = sub,
                    color = if (inLibrary) Accent else Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (song.durationText.isNotBlank()) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = song.durationText,
                color = Dim,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }
        Spacer(Modifier.width(4.dp))
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .clickable(onClick = onSave),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (inLibrary) CheckIcon else AddIcon,
                contentDescription = if (inLibrary) "In library" else "Add to Music library",
                tint = if (inLibrary) Accent else Dim,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
internal fun YtmArtistChipCard(
    artist: YtmArtistSummary,
    onClick: () -> Unit,
) {
    val seed = sleeveHash(fold(artist.name))
    val hue = (((seed % 360L).toInt()) + 360) % 360
    Column(
        modifier = Modifier
            .width(92.dp)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ArtistPortraitCircle(
            name = artist.name,
            artUrl = artist.artUrl,
            hue = hue,
            size = 80.dp,
        )
        Text(
            text = artist.name,
            color = Ink,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        if (artist.subscribers.isNotBlank()) {
            Text(
                text = artist.subscribers.substringBefore(" monthly").substringBefore(" subscribers"),
                color = Dim,
                fontSize = 10.5.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
internal fun YtmAlbumCarouselShelf(
    title: String,
    albums: List<YtmAlbumSummary>,
    onOpenAlbum: (YtmAlbumSummary) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = title,
            color = Ink,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(albums, key = { "ytm-alb-${it.browseId}" }) { alb ->
                YtmAlbumCard(album = alb, onClick = { onOpenAlbum(alb) })
            }
        }
    }
}

@Composable
internal fun YtmAlbumCard(
    album: YtmAlbumSummary,
    onClick: () -> Unit,
) {
    val seed = sleeveHash("${fold(album.artist)}\n${fold(album.title)}")
    val hue = (((seed % 360L).toInt()) + 360) % 360
    Column(
        modifier = Modifier
            .width(134.dp)
            .clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AlbumSleeve(
            hue = hue,
            seed = seed,
            monogramText = album.title.take(2).uppercase(),
            artist = album.artist,
            albumName = album.title,
            artUrl = album.artUrl.takeIf { it.isNotBlank() },
            cornerRadius = 12.dp,
            fontSize = 24.sp,
            modifier = Modifier.size(134.dp),
        )
        Text(
            text = album.title,
            color = Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val sub = listOfNotNull(
            album.year.takeIf { it.isNotBlank() },
            album.artist.takeIf { it.isNotBlank() },
        ).joinToString(" · ").ifBlank { album.subtitle }
        if (sub.isNotEmpty()) {
            Text(
                text = sub,
                color = Dim,
                fontSize = 11.5.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ArtistPortraitCircle(
    name: String,
    artUrl: String,
    hue: Int,
    size: androidx.compose.ui.unit.Dp,
) {
    val seed = sleeveHash(fold(name))
    Box(
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .border(0.5.dp, GlassBorder, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        AlbumSleeve(
            hue = hue,
            seed = seed,
            monogramText = name.take(2).uppercase(),
            artist = name,
            albumName = name,
            artUrl = artUrl.takeIf { it.isNotBlank() },
            cornerRadius = size / 2,
            fontSize = (size.value * 0.28f).sp,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun ExplorePrimaryPill(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(40.dp)
            .clip(PillShape)
            .background(if (enabled) Pearl else GlassBg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (enabled) PearlInk else Dim,
            modifier = Modifier.size(17.dp),
        )
        Text(
            text = label,
            color = if (enabled) PearlInk else Dim,
            fontSize = 13.5.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

@Composable
private fun ExploreSecondaryPill(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(40.dp)
            .clip(PillShape)
            .background(GlassBg)
            .border(0.5.dp, GlassBorder, PillShape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (enabled) Ink else Dim,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = label,
            color = if (enabled) Ink else Dim,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
    }
}
