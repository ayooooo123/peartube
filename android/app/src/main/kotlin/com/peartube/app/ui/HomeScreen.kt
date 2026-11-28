package com.peartube.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.ExternalImageCache
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibrarySubTab
import com.peartube.app.LibraryTile
import com.peartube.app.MusicState
import com.peartube.app.PeekTarget
import com.peartube.app.Room
import com.peartube.app.Screen
import com.peartube.app.VideoResumeInfo
import com.peartube.app.WatchProgress
import com.peartube.app.findStartedVideos
import com.peartube.app.formatTimeLeft
import com.peartube.app.imdbBackdropUrl
import com.peartube.app.imdbPosterUrl
import com.peartube.app.plural
import com.peartube.app.primaryEntryForVideo
import com.peartube.app.tileFactsLine
import com.peartube.app.tileStateLabel
import com.peartube.app.toTrackItems
import com.peartube.shared.formatBytes

private data class KeepItem(
    val key: String,
    val title: String,
    val subtitle: String,
    val updatedAt: Long,
    val progress: Float,
    val isMusic: Boolean,
    val hue: Int = 0,
    val seed: Long = 0L,
    val monogram: String = "",
    val artist: String = "",
    val albumName: String = "",
    val artUrl: String = "",
    val imdb: String? = null,
    val kindLabel: String = "Video",
    val onClick: () -> Unit,
    val onLongClick: (() -> Unit)? = null,
)

private sealed interface HomeSpotlight {
    data class ContinueVideo(val info: VideoResumeInfo) : HomeSpotlight
    data class FeaturedVideo(val tile: LibraryTile) : HomeSpotlight
    data class FeaturedAlbum(val album: LibraryTile, val isActiveTrack: Boolean, val playing: Boolean) : HomeSpotlight
}

@Composable
fun HomeScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
    onOpenMusicPlayer: () -> Unit,
    topPadding: Dp = 0.dp,
    heroTopInset: Dp = 64.dp,
    bottomPadding: Dp = 24.dp,
) {
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val history by model.watchHistory.collectAsState()
    val musicState by model.musicState.collectAsState()
    val haptics = LocalHapticFeedback.current

    val keepItems = remember(catalog, history, musicState) {
        buildKeepPlaying(catalog, history, musicState, model, onOpenMusicPlayer)
    }
    val startedVideos = remember(catalog.videos, history) {
        findStartedVideos(catalog.videos, history)
    }
    val homeAlbums = remember(catalog.albums) { catalog.albums.take(12) }
    val films = remember(catalog.movies, catalog.series) {
        (catalog.movies + catalog.series).sortedBy { it.title.lowercase() }
    }
    val homeVideos = remember(films, catalog.clips) {
        (if (films.isNotEmpty()) films else catalog.clips).take(12)
    }
    val showingClipsOnly = films.isEmpty() && catalog.clips.isNotEmpty()

    val spotlight: HomeSpotlight? = remember(startedVideos, films, catalog.clips, catalog.albums, musicState) {
        val resume = startedVideos.firstOrNull()
        if (resume != null) {
            HomeSpotlight.ContinueVideo(resume)
        } else {
            val featuredVideo = films.firstOrNull { !it.imdb.isNullOrBlank() }
                ?: films.firstOrNull()
                ?: catalog.clips.firstOrNull()
            if (featuredVideo != null) {
                HomeSpotlight.FeaturedVideo(featuredVideo)
            } else {
                val activeAlbum = musicState.currentTrack?.let { cur ->
                    catalog.albums.firstOrNull { it.key == cur.albumKey }
                }
                val album = activeAlbum ?: catalog.albums.firstOrNull()
                album?.let {
                    HomeSpotlight.FeaturedAlbum(
                        album = it,
                        isActiveTrack = activeAlbum != null,
                        playing = activeAlbum != null && musicState.playing,
                    )
                }
            }
        }
    }

    if (catalog.tiles.isEmpty() && keepItems.isEmpty()) {
        Box(
            Modifier
                .fillMaxSize()
                .padding(top = topPadding, bottom = bottomPadding, start = 24.dp, end = 24.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = "Nothing in your library yet.",
                    color = Ink,
                    fontSize = 20.sp,
                    fontFamily = FontFamily.SansSerif,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = if (settings.hasSources && status == null) {
                        "Connecting to your channels…"
                    } else {
                        "Explore creators & music on Discover, or paste a link to add to your library."
                    },
                    color = Dim,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(6.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HeroPrimaryButton(
                        text = "Explore Discover",
                        icon = DiscoverIcon,
                        shape = PillShape,
                        onClick = { model.selectRoom(Room.Discover) },
                    )
                    HeroGlassButton(
                        text = "Add link",
                        icon = AddIcon,
                        shape = PillShape,
                        onClick = { model.openAddSheet() },
                    )
                }
            }
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = topPadding, bottom = bottomPadding),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        if (spotlight != null) {
            item(key = "home-editorial-hero") {
                HomeEditorialHero(
                    spotlight = spotlight,
                    heroTopInset = heroTopInset,
                    fullBleed = topPadding == 0.dp,
                    onPlayVideo = { tile ->
                        val entry = primaryEntryForVideo(tile, history)
                        if (entry != null) model.playEntry(entry) else onOpenTitle(tile.key)
                    },
                    onResumeVideo = { info -> model.playEntry(info.entry) },
                    onOpenTitle = onOpenTitle,
                    onPlayAlbum = { album, isActive ->
                        if (isActive) {
                            model.music.togglePlayPause()
                        } else {
                            val tracks = album.toTrackItems()
                            if (tracks.isNotEmpty()) {
                                model.music.playTrackList(
                                    tracks,
                                    0,
                                    album.album.ifBlank { album.title },
                                    shuffleOn = false,
                                )
                            }
                        }
                    },
                    onOpenAlbum = onOpenAlbum,
                    onLongPress = {
                        when (spotlight) {
                            is HomeSpotlight.ContinueVideo -> model.openPeek(PeekTarget.LibraryTitle(spotlight.info.tile))
                            is HomeSpotlight.FeaturedVideo -> model.openPeek(PeekTarget.LibraryTitle(spotlight.tile))
                            is HomeSpotlight.FeaturedAlbum -> model.openPeek(PeekTarget.LibraryAlbum(spotlight.album))
                        }
                    },
                )
            }
        }

        if (keepItems.isNotEmpty()) {
            item(key = "jump-back-in") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(title = "Jump Back In")
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(keepItems, key = { it.key }) { item ->
                            KeepPlayingCard(item)
                        }
                    }
                }
            }
        }

        if (homeVideos.isNotEmpty()) {
            item(key = "home-videos") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(
                        title = if (showingClipsOnly) "Videos" else "Movies & TV",
                        actionLabel = "See all",
                        onAction = {
                            val targetTab = when {
                                showingClipsOnly -> LibrarySubTab.Videos
                                catalog.movies.isNotEmpty() -> LibrarySubTab.Movies
                                else -> LibrarySubTab.Series
                            }
                            model.selectLibraryTab(targetTab)
                        },
                    )
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(homeVideos, key = { it.key }) { tile ->
                            if (tile.kind == LibraryKind.Clip) {
                                WideVideoShelfCard(
                                    tile = tile,
                                    onClick = { onOpenTitle(tile.key) },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        model.openPeek(PeekTarget.LibraryTitle(tile))
                                    },
                                )
                            } else {
                                CinemaPosterCard(
                                    tile = tile,
                                    onOpen = { onOpenTitle(tile.key) },
                                    onLongClick = {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        model.openPeek(PeekTarget.LibraryTitle(tile))
                                    },
                                    modifier = Modifier.width(128.dp),
                                )
                            }
                        }
                    }
                }
            }
        }

        if (homeAlbums.isNotEmpty()) {
            item(key = "home-albums") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(
                        title = "Albums",
                        actionLabel = "See all",
                        onAction = { model.selectRoom(Room.Listen) },
                    )
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(homeAlbums, key = { it.key }) { album ->
                            AlbumShelfCard(
                                album = album,
                                onOpen = { onOpenAlbum(album.key) },
                                onPlay = {
                                    val tracks = album.toTrackItems()
                                    if (tracks.isNotEmpty()) {
                                        model.music.playTrackList(tracks, 0, album.album.ifBlank { album.title }, shuffleOn = false)
                                    }
                                },
                                onLongClick = {
                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    model.openPeek(PeekTarget.LibraryAlbum(album))
                                },
                                modifier = Modifier.width(136.dp),
                                showPlayOverlay = false,
                                showStateLine = false,
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeEditorialHero(
    spotlight: HomeSpotlight,
    heroTopInset: Dp,
    fullBleed: Boolean,
    onPlayVideo: (LibraryTile) -> Unit,
    onResumeVideo: (VideoResumeInfo) -> Unit,
    onOpenTitle: (String) -> Unit,
    onPlayAlbum: (LibraryTile, Boolean) -> Unit,
    onOpenAlbum: (String) -> Unit,
    onLongPress: (() -> Unit)? = null,
) {
    val imdb = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> spotlight.info.tile.imdb
        is HomeSpotlight.FeaturedVideo -> spotlight.tile.imdb
        is HomeSpotlight.FeaturedAlbum -> null
    }
    val albumForArt = (spotlight as? HomeSpotlight.FeaturedAlbum)?.album
    val hue = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> normalizeHue(spotlight.info.tile.seed)
        is HomeSpotlight.FeaturedVideo -> normalizeHue(spotlight.tile.seed)
        is HomeSpotlight.FeaturedAlbum -> ((spotlight.album.hue % 360) + 360) % 360
    }

    val backdropUrl = remember(imdb) { imdbBackdropUrl(imdb) }
    val posterFallbackUrl = remember(imdb) { imdbPosterUrl(imdb) }
    val cachedAlbumUrl = remember(albumForArt) {
        albumForArt?.let { ExternalDiscoveryApi.cachedAlbumArtUrl(it.artist, it.album.ifBlank { it.title }) }
    }
    val heroArt by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterFallbackUrl?.let { ExternalImageCache.get(it) }
            ?: cachedAlbumUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterFallbackUrl,
        key3 = albumForArt?.key,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterFallbackUrl?.let { ExternalImageCache.load(it) }
            posterFallbackUrl != null -> ExternalImageCache.load(posterFallbackUrl)
            albumForArt != null -> {
                val url = ExternalDiscoveryApi.resolveAlbumArtUrl(
                    albumForArt.artist,
                    albumForArt.album.ifBlank { albumForArt.title },
                )
                if (!url.isNullOrBlank()) ExternalImageCache.load(url) else null
            }
            else -> null
        }
    }

    val eyebrow = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> "CONTINUE WATCHING"
        is HomeSpotlight.FeaturedVideo -> when (spotlight.tile.kind) {
            LibraryKind.Series -> "FEATURED TV SHOW"
            LibraryKind.Clip -> "FEATURED VIDEO"
            else -> "FEATURED MOVIE"
        }
        is HomeSpotlight.FeaturedAlbum -> if (spotlight.isActiveTrack) "NOW PLAYING" else "FEATURED ALBUM"
    }

    val title = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> spotlight.info.tile.title
        is HomeSpotlight.FeaturedVideo -> spotlight.tile.title
        is HomeSpotlight.FeaturedAlbum -> spotlight.album.album.ifBlank { spotlight.album.title }
    }

    val metadata = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> {
            val info = spotlight.info
            val epPrefix = if (info.tile.kind == LibraryKind.Series && info.entry.isEpisode) {
                "${info.entry.episodeLabel} · "
            } else {
                ""
            }
            val leftPart = if (info.progress.durationMs > 0L) {
                formatTimeLeft(info.progress.durationMs - info.progress.positionMs)
            } else {
                "In progress"
            }
            "$epPrefix$leftPart"
        }
        is HomeSpotlight.FeaturedVideo -> {
            val tile = spotlight.tile
            when (tile.kind) {
                LibraryKind.Movie -> listOfNotNull("Movie", tile.year).joinToString(" · ")
                LibraryKind.Series -> listOfNotNull(
                    "TV Show",
                    tileFactsLine(tile).takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                else -> tileFactsLine(tile).ifBlank { "Video" }
            }
        }
        is HomeSpotlight.FeaturedAlbum -> {
            val a = spotlight.album
            listOfNotNull(
                a.artist.takeIf { it.isNotBlank() },
                plural(a.items.size, "track", "tracks"),
            ).joinToString(" · ")
        }
    }

    val progressFraction: Float? = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> {
            val p = spotlight.info.progress
            if (p.positionMs > 0L && p.durationMs > 0L) spotlight.info.fraction.coerceIn(0.03f, 1f) else null
        }
        else -> null
    }

    val primaryLabel = when (spotlight) {
        is HomeSpotlight.ContinueVideo -> "Resume"
        is HomeSpotlight.FeaturedVideo -> "Play"
        is HomeSpotlight.FeaturedAlbum -> when {
            spotlight.playing -> "Pause"
            spotlight.isActiveTrack -> "Resume"
            else -> "Play"
        }
    }
    val primaryIcon = if (spotlight is HomeSpotlight.FeaturedAlbum && spotlight.playing) PauseIcon else PlayIcon

    val statusBarBleed = if (fullBleed) (heroTopInset - 56.dp).coerceAtLeast(0.dp) else 0.dp
    val heroHeight = 320.dp + statusBarBleed
    val haptics = LocalHapticFeedback.current

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(heroHeight)
            .then(
                if (onLongPress != null) {
                    Modifier.combinedClickable(
                        onClick = {
                            when (spotlight) {
                                is HomeSpotlight.ContinueVideo -> onOpenTitle(spotlight.info.tile.key)
                                is HomeSpotlight.FeaturedVideo -> onOpenTitle(spotlight.tile.key)
                                is HomeSpotlight.FeaturedAlbum -> onOpenAlbum(spotlight.album.key)
                            }
                        },
                        onLongClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress()
                        },
                    )
                } else {
                    Modifier
                },
            ),
    ) {
        val loadedArt = heroArt
        if (loadedArt != null) {
            Image(
                bitmap = loadedArt,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            // Soft obsidian scrim: gentle top veil for floating bar + seamless melt into Bg at bottom
            Canvas(Modifier.fillMaxSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Bg.copy(alpha = 0.28f),
                        0.34f to Color.Transparent,
                        0.62f to Bg.copy(alpha = 0.70f),
                        0.86f to Bg.copy(alpha = 0.94f),
                        1.0f to Bg,
                    ),
                )
            }
        } else {
            val glowA = Color.hsl(hue.toFloat(), 0.50f, 0.24f)
            val glowB = Color.hsl(((hue + 48) % 360).toFloat(), 0.56f, 0.12f)
            Canvas(Modifier.fillMaxSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to glowA,
                        0.55f to glowB,
                        1.0f to Bg,
                    ),
                )
                drawCircle(
                    brush = Brush.radialGradient(
                        0.0f to Color.hsl(((hue + 150) % 360).toFloat(), 0.65f, 0.48f, alpha = 0.24f),
                        1.0f to Color.Transparent,
                        center = Offset(size.width * 0.78f, size.height * 0.24f),
                        radius = size.width * 0.65f,
                    ),
                    radius = size.width * 0.65f,
                    center = Offset(size.width * 0.78f, size.height * 0.24f),
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomStart)
                .padding(
                    start = 20.dp,
                    end = 20.dp,
                    top = if (fullBleed) heroTopInset else 16.dp,
                    bottom = 14.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = eyebrow,
                color = Pearl.copy(alpha = 0.78f),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.6.sp,
                maxLines = 1,
            )
            Text(
                text = title,
                color = Ink,
                fontSize = 30.sp,
                lineHeight = 34.sp,
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Bold,
                letterSpacing = (-0.8).sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (metadata.isNotBlank()) {
                Text(
                    text = metadata,
                    color = Ink.copy(alpha = 0.78f),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (progressFraction != null) {
                LinearProgressIndicator(
                    progress = { progressFraction },
                    modifier = Modifier
                        .fillMaxWidth(0.55f)
                        .height(3.dp)
                        .clip(PillShape),
                    color = Pearl,
                    trackColor = Color.White.copy(alpha = 0.24f),
                )
            }
            Spacer(Modifier.height(4.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                HeroPrimaryButton(
                    text = primaryLabel,
                    icon = primaryIcon,
                    shape = PillShape,
                    onClick = {
                        when (spotlight) {
                            is HomeSpotlight.ContinueVideo -> onResumeVideo(spotlight.info)
                            is HomeSpotlight.FeaturedVideo -> onPlayVideo(spotlight.tile)
                            is HomeSpotlight.FeaturedAlbum -> onPlayAlbum(spotlight.album, spotlight.isActiveTrack)
                        }
                    },
                )
                HeroGlassButton(
                    text = "Details",
                    shape = PillShape,
                    onClick = {
                        when (spotlight) {
                            is HomeSpotlight.ContinueVideo -> onOpenTitle(spotlight.info.tile.key)
                            is HomeSpotlight.FeaturedVideo -> onOpenTitle(spotlight.tile.key)
                            is HomeSpotlight.FeaturedAlbum -> onOpenAlbum(spotlight.album.key)
                        }
                    },
                )
            }
        }
    }
}

private fun buildKeepPlaying(
    catalog: LibraryCatalog,
    history: Map<String, WatchProgress>,
    musicState: MusicState,
    model: AppModel,
    onOpenMusicPlayer: () -> Unit,
): List<KeepItem> {
    val result = mutableListOf<KeepItem>()
    for (tile in catalog.videos) {
        val best = tile.items
            .mapNotNull { item ->
                val p = history[item.entry.key] ?: return@mapNotNull null
                if (!p.partial) return@mapNotNull null
                val pct = if (p.durationMs > 0L) p.positionMs.toFloat() / p.durationMs else 0f
                if (p.durationMs > 0L && (pct < 0.01f || pct > 0.96f)) return@mapNotNull null
                Triple(item.entry, p, pct)
            }
            .maxByOrNull { it.second.updatedAt } ?: continue

        val (entry, prog, pct) = best
        val title = if (tile.kind == LibraryKind.Series && entry.isEpisode) {
            "${tile.title} · ${entry.episodeLabel}"
        } else {
            tile.title
        }
        val subtitle = if (prog.durationMs > 0L) {
            formatTimeLeft(prog.durationMs - prog.positionMs)
        } else {
            "In progress"
        }
        result.add(
            KeepItem(
                key = "v:${entry.key}",
                title = title,
                subtitle = subtitle,
                updatedAt = prog.updatedAt,
                progress = pct,
                isMusic = false,
                seed = tile.seed,
                imdb = tile.imdb,
                kindLabel = posterKindLabel(tile.kind),
                onClick = { model.playEntry(entry) },
                onLongClick = { model.openPeek(PeekTarget.LibraryTitle(tile)) },
            ),
        )
    }

    val curTrack = musicState.currentTrack
    if (curTrack != null && (musicState.playing || musicState.positionMs > 0L || musicState.index > 0 || musicState.pausedForVideo)) {
        val sub = if (musicState.pausedForVideo) {
            "Paused for a video"
        } else if (curTrack.isExternalStream) {
            curTrack.externalStreamSource ?: "Streaming"
        } else {
            "Track ${musicState.index + 1} of ${musicState.order.size}"
        }
        val albumTile = catalog.albumByKey(curTrack.albumKey)
        result.add(
            KeepItem(
                key = "m:${curTrack.albumKey}:${curTrack.key}",
                title = curTrack.album.ifBlank { curTrack.title },
                subtitle = sub,
                updatedAt = musicState.updatedAt,
                progress = musicState.durationMs?.takeIf { it > 0L }?.let { musicState.positionMs.toFloat() / it } ?: 0f,
                isMusic = true,
                hue = curTrack.hue,
                seed = curTrack.seed,
                monogram = curTrack.monogramText,
                artist = curTrack.artist,
                albumName = curTrack.album.ifBlank { curTrack.title },
                artUrl = curTrack.artUrl,
                onClick = onOpenMusicPlayer,
                onLongClick = albumTile?.let { alb ->
                    { model.openPeek(PeekTarget.LibraryAlbum(alb)) }
                } ?: if (curTrack.isExternalStream) {
                    {
                        model.openPeek(
                            PeekTarget.DiscoverAlbum(
                                com.peartube.app.SuggestedAlbum(
                                    title = curTrack.album.ifBlank { curTrack.title },
                                    artist = curTrack.artist,
                                    year = "",
                                    artUrl = curTrack.artUrl,
                                ),
                            ),
                        )
                    }
                } else {
                    null
                },
            ),
        )
    }

    return result.sortedByDescending { it.updatedAt }.take(6)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun KeepPlayingCard(item: KeepItem) {
    val haptics = LocalHapticFeedback.current
    Column(
        modifier = Modifier
            .width(if (item.isMusic) 136.dp else 208.dp)
            .combinedClickable(
                onClick = item.onClick,
                onLongClick = item.onLongClick?.let { cb ->
                    {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        cb()
                    }
                },
            ),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (item.isMusic) {
            AlbumSleeve(
                hue = item.hue,
                seed = item.seed,
                monogramText = item.monogram,
                artist = item.artist,
                albumName = item.albumName,
                artUrl = item.artUrl.takeIf { it.isNotBlank() },
                borderless = true,
                modifier = Modifier.fillMaxWidth(),
                fontSize = 24.sp,
            )
        } else {
            WideTitleArt(
                title = item.title,
                seed = item.seed,
                badge = null,
                progress = item.progress,
                kindLabel = item.kindLabel,
                imdb = item.imdb,
                showTitleOverlay = false,
                borderless = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(
            text = item.title,
            color = Ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = item.subtitle,
            color = if (item.subtitle == "Paused for a video") Warn else Dim,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AlbumShelfCard(
    album: LibraryTile,
    onOpen: () -> Unit,
    onPlay: () -> Unit,
    modifier: Modifier = Modifier.width(136.dp),
    showPlayOverlay: Boolean = false,
    showStateLine: Boolean = false,
    onLongClick: (() -> Unit)? = null,
) {
    val (stateText, isOk) = tileStateLabel(album)
    Column(
        modifier = modifier.combinedClickable(
            onClick = onOpen,
            onLongClick = onLongClick,
        ),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AlbumSleeve(
            hue = album.hue,
            seed = album.seed,
            monogramText = album.monogramText,
            artist = album.artist,
            albumName = album.album.ifBlank { album.title },
            cornerRadius = 14.dp,
            borderless = true,
            modifier = Modifier.fillMaxWidth(),
            overlay = if (showPlayOverlay) {
                {
                    Box(
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(8.dp)
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(Bg.copy(alpha = 0.78f))
                            .clickable(onClick = onPlay),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(PlayIcon, "Play ${album.album.ifBlank { album.title }}", tint = Ink, modifier = Modifier.size(16.dp))
                    }
                }
            } else {
                null
            },
        )
        Text(
            text = album.album.ifBlank { album.title },
            color = Ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = album.artist.ifBlank { plural(album.items.size, "track", "tracks") },
            color = Dim,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (showStateLine && isOk) {
            Text(stateText, color = Accent, fontSize = 11.sp, maxLines = 1)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WideVideoShelfCard(
    tile: LibraryTile,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val sizeText = tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { formatBytes(it) }
    Column(
        modifier = Modifier
            .width(204.dp)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick,
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
        Text(tile.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(listOfNotNull("Video", sizeText).joinToString(" · "), color = Dim, fontSize = 12.sp, maxLines = 1)
    }
}
