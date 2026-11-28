package com.peartube.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.peartube.app.AppModel
import com.peartube.app.CINEMA_GENRES
import com.peartube.app.CinemaDiscoverItem
import com.peartube.app.CinemaTitleMeta
import com.peartube.app.DiscoverTab
import com.peartube.app.ExternalDiscoveryApi
import com.peartube.app.ExternalImageCache
import com.peartube.app.ExternalVideoPick
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.PeekTarget
import com.peartube.app.Room
import com.peartube.app.SuggestedAlbum
import com.peartube.app.SuggestedArtist
import com.peartube.app.WatchProgress
import com.peartube.app.imdbBackdropUrl
import com.peartube.app.imdbPosterUrl
import com.peartube.app.isSaved
import com.peartube.app.plural
import com.peartube.app.primaryEntryForVideo
import com.peartube.app.sleeveHash
import com.peartube.app.tileFactsLine
import com.peartube.app.tileStateLabel
import com.peartube.app.toTrackItems
import com.peartube.shared.formatBytes
import kotlin.random.Random

private val PeekCardShape = RoundedCornerShape(24.dp)

@Composable
fun PeekCardOverlay(
    model: AppModel,
    catalog: LibraryCatalog,
    target: PeekTarget,
    onDismiss: () -> Unit,
    onOpenTitle: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(target) {
        visible = true
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Bg.copy(alpha = 0.82f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss,
                ),
            contentAlignment = Alignment.Center,
        ) {
            AnimatedVisibility(
                visible = visible,
                enter = fadeIn(tween(170)) + scaleIn(initialScale = 0.92f, animationSpec = tween(200)),
                exit = fadeOut(tween(120)),
            ) {
                Box(
                    modifier = Modifier
                        .widthIn(max = 360.dp)
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp)
                        .shadow(28.dp, PeekCardShape)
                        .clip(PeekCardShape)
                        .background(CardBg)
                        .border(1.dp, FloatingDockBorder, PeekCardShape)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = {},
                        ),
                ) {
                    when (target) {
                        is PeekTarget.LibraryTitle -> LibraryTitlePeekContent(
                            model = model,
                            tile = target.tile,
                            onDismiss = onDismiss,
                            onOpenTitle = onOpenTitle,
                        )
                        is PeekTarget.LibraryAlbum -> LibraryAlbumPeekContent(
                            model = model,
                            album = target.album,
                            onDismiss = onDismiss,
                            onOpenAlbum = onOpenAlbum,
                        )
                        is PeekTarget.DiscoverCinema -> DiscoverCinemaPeekContent(
                            model = model,
                            catalog = catalog,
                            item = target.item,
                            onDismiss = onDismiss,
                            onOpenTitle = onOpenTitle,
                        )
                        is PeekTarget.DiscoverVideo -> DiscoverVideoPeekContent(
                            model = model,
                            video = target.video,
                            onDismiss = onDismiss,
                        )
                        is PeekTarget.DiscoverAlbum -> DiscoverAlbumPeekContent(
                            model = model,
                            album = target.album,
                            onDismiss = onDismiss,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LibraryTitlePeekContent(
    model: AppModel,
    tile: LibraryTile,
    onDismiss: () -> Unit,
    onOpenTitle: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val history by model.watchHistory.collectAsState()
    val downloads by model.downloads.collectAsState()
    val isSeries = tile.kind == LibraryKind.Series
    val primaryEntry = remember(tile, history) { primaryEntryForVideo(tile, history) }
    val resumePos = primaryEntry?.let { history[it.key]?.takeIf { p -> p.partial }?.positionMs }
    val hasResume = resumePos != null && resumePos > 0L

    val meta by produceState<CinemaTitleMeta?>(
        initialValue = tile.imdb?.let { ExternalDiscoveryApi.cachedTitleMeta(it, isSeries = isSeries) },
        key1 = tile.key,
        key2 = tile.imdb,
    ) {
        val imdb = tile.imdb ?: ExternalDiscoveryApi.resolveTitleImdb(tile.title, isSeries = isSeries)
        value = if (!imdb.isNullOrBlank()) {
            ExternalDiscoveryApi.loadTitleMeta(imdb, isSeries = isSeries)
        } else {
            null
        }
    }

    val backdropUrl = meta?.backdropUrl?.takeIf { it.isNotBlank() } ?: imdbBackdropUrl(tile.imdb)
    val posterUrl = meta?.posterUrl?.takeIf { it.isNotBlank() } ?: imdbPosterUrl(tile.imdb)
    val artBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterUrl,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterUrl?.let { ExternalImageCache.load(it) }
            posterUrl != null -> ExternalImageCache.load(posterUrl)
            else -> null
        }
    }

    val (stateLabel, savedAll) = remember(tile) { tileStateLabel(tile) }
    val sizeText = remember(primaryEntry, tile) {
        (primaryEntry?.size?.takeIf { it > 0L } ?: tile.totalSize.takeIf { it > 0L })?.let { formatBytes(it) }
    }
    val statusPillText = remember(stateLabel, sizeText) {
        listOfNotNull(stateLabel, sizeText).joinToString(" · ")
    }
    val alreadySaved = savedAll || (primaryEntry != null && isSaved(primaryEntry))
    val isDownloading = primaryEntry != null && primaryEntry.key in downloads

    val year = meta?.year?.takeIf { it.isNotBlank() } ?: tile.year
    val runtime = meta?.runtime?.takeIf { it.isNotBlank() }
    val rating = meta?.rating?.takeIf { it.isNotBlank() }
    val description = meta?.description?.takeIf { it.isNotBlank() }

    Column(modifier = Modifier.fillMaxWidth()) {
        PeekBackdropHeader(
            bitmap = artBitmap,
            title = tile.title,
            seed = tile.seed,
            badgeText = statusPillText,
            badgeAccent = alreadySaved,
            onDismiss = onDismiss,
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = tile.title,
                    color = Ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                PeekMetadataLine(
                    year = year,
                    runtime = runtime,
                    rating = rating,
                    fallback = tileFactsLine(tile),
                )
            }

            if (description != null) {
                Text(
                    text = description,
                    color = Dim,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = if (hasResume) "Resume" else "Play",
                icon = PlayIcon,
                shape = PillShape,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onDismiss()
                    if (primaryEntry != null) {
                        model.playEntry(primaryEntry)
                    } else {
                        onOpenTitle(tile.key)
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PeekGlassPillButton(
                    text = "Cast",
                    icon = CastIcon,
                    onClick = {
                        onDismiss()
                        if (primaryEntry != null) {
                            model.openTvsPickerForEntry(primaryEntry, resumePos ?: 0L)
                        } else {
                            model.openCastSheet()
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = when {
                        alreadySaved -> "Offline"
                        isDownloading -> "Saving…"
                        else -> "Download"
                    },
                    icon = if (alreadySaved) CheckIcon else DownloadIcon,
                    tint = if (alreadySaved) Accent else Ink,
                    enabled = !alreadySaved && !isDownloading && primaryEntry != null,
                    onClick = {
                        if (primaryEntry != null) {
                            model.downloadEntry(primaryEntry)
                            onDismiss()
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = "Details",
                    icon = InfoIcon,
                    onClick = {
                        onDismiss()
                        onOpenTitle(tile.key)
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun LibraryAlbumPeekContent(
    model: AppModel,
    album: LibraryTile,
    onDismiss: () -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val albumTitle = album.album.ifBlank { album.title }
    val (stateLabel, savedAll) = remember(album) { tileStateLabel(album) }
    val glowHue = ((album.hue % 360) + 360) % 360
    val topGlow = Color.hsl(glowHue.toFloat(), 0.56f, 0.24f, alpha = 0.45f)
    val tracks = remember(album) { album.toTrackItems() }

    Column(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        0.0f to topGlow,
                        0.72f to CardBg.copy(alpha = 0.86f),
                        1.0f to CardBg,
                    ),
                )
                .padding(top = 18.dp, bottom = 12.dp),
        ) {
            PeekCloseCircle(
                onDismiss = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(end = 14.dp),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(top = 8.dp),
            ) {
                AlbumSleeve(
                    hue = album.hue,
                    seed = album.seed,
                    monogramText = album.monogramText,
                    artist = album.artist,
                    albumName = albumTitle,
                    cornerRadius = 16.dp,
                    borderless = true,
                    fontSize = 28.sp,
                    modifier = Modifier
                        .size(136.dp)
                        .shadow(18.dp, RoundedCornerShape(16.dp)),
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = albumTitle,
                    color = Ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (album.artist.isNotBlank()) {
                    Text(
                        text = album.artist,
                        color = Ink.copy(alpha = 0.84f),
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    text = "${plural(album.items.size, "track", "tracks")} · $stateLabel",
                    color = if (savedAll) Accent else Dim,
                    fontSize = 12.sp,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = "Play Now",
                icon = PlayIcon,
                shape = PillShape,
                enabled = tracks.isNotEmpty(),
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    if (tracks.isNotEmpty()) {
                        model.music.playTrackList(tracks, 0, albumTitle, shuffleOn = false)
                    }
                    onDismiss()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PeekGlassPillButton(
                    text = "Play Next",
                    icon = QueueMusicIcon,
                    enabled = tracks.isNotEmpty(),
                    onClick = {
                        if (tracks.isNotEmpty()) {
                            model.music.playNext(tracks, albumTitle)
                            model.notice.value = "Playing $albumTitle next"
                        }
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = "Shuffle",
                    icon = ShuffleIcon,
                    enabled = tracks.isNotEmpty(),
                    onClick = {
                        if (tracks.isNotEmpty()) {
                            model.music.playTrackList(tracks, 0, albumTitle, shuffleOn = true)
                        }
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = "Open",
                    icon = InfoIcon,
                    onClick = {
                        onDismiss()
                        onOpenAlbum(album.key)
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun DiscoverCinemaPeekContent(
    model: AppModel,
    catalog: LibraryCatalog,
    item: CinemaDiscoverItem,
    onDismiss: () -> Unit,
    onOpenTitle: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val isSeries = item.kind == "series"
    val fullMeta by produceState<CinemaTitleMeta?>(
        initialValue = ExternalDiscoveryApi.cachedTitleMeta(item.imdbId, isSeries = isSeries),
        key1 = item.imdbId,
        key2 = isSeries,
    ) {
        value = ExternalDiscoveryApi.loadTitleMeta(item.imdbId, isSeries = isSeries)
    }

    val backdropUrl = fullMeta?.backdropUrl?.takeIf { it.isNotBlank() }
        ?: item.backdropUrl.takeIf { it.isNotBlank() }
        ?: imdbBackdropUrl(item.imdbId)
    val posterUrl = fullMeta?.posterUrl?.takeIf { it.isNotBlank() }
        ?: item.posterUrl.takeIf { it.isNotBlank() }
        ?: imdbPosterUrl(item.imdbId)
    val artBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterUrl,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterUrl?.let { ExternalImageCache.load(it) }
            posterUrl != null -> ExternalImageCache.load(posterUrl)
            else -> null
        }
    }

    val inLibraryTile = remember(catalog.videos, item.imdbId) {
        catalog.videos.firstOrNull { it.imdb.equals(item.imdbId, ignoreCase = true) }
    }
    val year = fullMeta?.year?.takeIf { it.isNotBlank() } ?: item.year
    val runtime = fullMeta?.runtime?.takeIf { it.isNotBlank() } ?: item.runtime
    val rating = fullMeta?.rating?.takeIf { it.isNotBlank() } ?: item.rating
    val genres = fullMeta?.genres?.takeIf { it.isNotEmpty() } ?: item.genres
    val description = fullMeta?.description?.takeIf { it.isNotBlank() } ?: item.description
    val firstGenre = genres.firstOrNull()?.takeIf { it.isNotBlank() }

    Column(modifier = Modifier.fillMaxWidth()) {
        PeekBackdropHeader(
            bitmap = artBitmap,
            title = item.title,
            seed = sleeveHash(item.title),
            badgeText = if (inLibraryTile != null) "In your library" else "PEEK",
            badgeAccent = inLibraryTile != null,
            onDismiss = onDismiss,
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = item.title,
                    color = Ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                PeekMetadataLine(
                    year = year,
                    runtime = runtime,
                    rating = rating,
                    fallback = if (isSeries) "TV Show" else "Movie",
                )
                if (genres.isNotEmpty()) {
                    Text(
                        text = genres.take(3).joinToString(" · "),
                        color = BrandHover,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (description.isNotBlank()) {
                Text(
                    text = description,
                    color = Dim,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = if (inLibraryTile != null) "Open in Library" else "Find on PearTube",
                icon = if (inLibraryTile != null) PlayIcon else SearchIcon,
                shape = PillShape,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onDismiss()
                    if (inLibraryTile != null) {
                        onOpenTitle(inLibraryTile.key)
                    } else {
                        model.openSearchFor(item.title, askRelays = true)
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (firstGenre != null) {
                    val targetGenre = mapToDiscoverGenre(firstGenre)
                    PeekGlassPillButton(
                        text = "More $targetGenre",
                        icon = SparklesIcon,
                        onClick = {
                            onDismiss()
                            model.selectRoom(Room.Discover)
                            model.setDiscoverTab(DiscoverTab.Cinema)
                            model.loadCinemaDiscover(targetGenre)
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
                PeekGlassPillButton(
                    text = "Full Info",
                    icon = InfoIcon,
                    onClick = {
                        onDismiss()
                        if (inLibraryTile != null) {
                            onOpenTitle(inLibraryTile.key)
                        } else {
                            model.openSearchFor(item.title, askRelays = false)
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun DiscoverVideoPeekContent(
    model: AppModel,
    video: ExternalVideoPick,
    onDismiss: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val copyText = rememberCopyText()
    val thumbBitmap by produceState<ImageBitmap?>(
        initialValue = video.thumbUrl.takeIf { it.isNotBlank() }?.let { ExternalImageCache.get(it) },
        key1 = video.thumbUrl,
    ) {
        value = if (video.thumbUrl.isNotBlank()) ExternalImageCache.load(video.thumbUrl) else null
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(176.dp)
                .background(CardElevated),
            contentAlignment = Alignment.Center,
        ) {
            val loaded = thumbBitmap
            if (loaded != null) {
                Image(
                    bitmap = loaded,
                    contentDescription = video.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Icon(
                    imageVector = WatchIcon,
                    contentDescription = null,
                    tint = SourceYoutube.copy(alpha = 0.65f),
                    modifier = Modifier.size(36.dp),
                )
            }
            Canvas(Modifier.fillMaxSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Bg.copy(alpha = 0.30f),
                        0.50f to Color.Transparent,
                        0.84f to CardBg.copy(alpha = 0.88f),
                        1.0f to CardBg,
                    ),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(14.dp)
                    .clip(PillShape)
                    .background(Bg.copy(alpha = 0.72f))
                    .border(0.75.dp, SourceYoutube.copy(alpha = 0.50f), PillShape)
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text(
                    text = "YouTube",
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            PeekCloseCircle(
                onDismiss = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(14.dp),
            )
            if (video.durationText.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(horizontal = 14.dp, vertical = 10.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(Bg.copy(alpha = 0.82f))
                        .padding(horizontal = 7.dp, vertical = 3.dp),
                ) {
                    Text(
                        text = video.durationText,
                        color = Ink,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = video.title,
                    color = Ink,
                    fontSize = 18.sp,
                    lineHeight = 22.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.4).sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val meta = listOfNotNull(
                    video.channelName.takeIf { it.isNotBlank() },
                    video.publishedText.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (meta.isNotEmpty()) {
                    Text(
                        text = meta,
                        color = Dim,
                        fontSize = 12.5.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = "Add Video",
                icon = AddIcon,
                shape = PillShape,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    model.addExternalVideoToLibrary(video, audioOnly = false)
                    onDismiss()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PeekGlassPillButton(
                    text = "Audio Only",
                    icon = AudioIcon,
                    onClick = {
                        model.addExternalVideoToLibrary(video, audioOnly = true)
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = "Copy Link",
                    icon = CopyIcon,
                    onClick = {
                        copyText(video.watchUrl)
                        model.notice.value = "Link copied"
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun DiscoverAlbumPeekContent(
    model: AppModel,
    album: SuggestedAlbum,
    onDismiss: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val glowHue = normalizeHue(sleeveHash("${album.artist}-${album.title}"))
    val topGlow = Color.hsl(glowHue.toFloat(), 0.54f, 0.24f, alpha = 0.42f)

    Column(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(
                        0.0f to topGlow,
                        0.72f to CardBg.copy(alpha = 0.86f),
                        1.0f to CardBg,
                    ),
                )
                .padding(top = 18.dp, bottom = 12.dp),
        ) {
            PeekCloseCircle(
                onDismiss = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(end = 14.dp),
            )
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(top = 8.dp),
            ) {
                ExternalArtwork(
                    url = album.artUrl,
                    title = album.title,
                    cornerRadius = 16.dp,
                    modifier = Modifier
                        .size(136.dp)
                        .shadow(18.dp, RoundedCornerShape(16.dp)),
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, bottom = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = album.title,
                    color = Ink,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val sub = listOfNotNull(
                    album.artist.takeIf { it.isNotBlank() },
                    album.year.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (sub.isNotEmpty()) {
                    Text(
                        text = sub,
                        color = Dim,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = "Find Lossless",
                icon = SearchIcon,
                shape = PillShape,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onDismiss()
                    model.openSearchFor("${album.artist} ${album.title}".trim(), askRelays = true)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            PeekGlassPillButton(
                text = "Explore Artist",
                icon = SparklesIcon,
                onClick = {
                    onDismiss()
                    model.selectRoom(Room.Discover)
                    model.setDiscoverTab(DiscoverTab.Music)
                    model.exploreSuggestedArtist(
                        SuggestedArtist(
                            name = album.artist,
                            genre = "",
                            artUrl = album.artUrl,
                        ),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private sealed interface PickCandidate {
    val stableKey: String
    data class LibVideo(val tile: LibraryTile) : PickCandidate {
        override val stableKey: String get() = "lib-v:${tile.key}"
    }
    data class LibAlbum(val album: LibraryTile) : PickCandidate {
        override val stableKey: String get() = "lib-a:${album.key}"
    }
    data class DiscCinema(val item: CinemaDiscoverItem) : PickCandidate {
        override val stableKey: String get() = "disc-c:${item.imdbId}"
    }
}

@Composable
fun TonightsPickDialog(
    model: AppModel,
    catalog: LibraryCatalog,
    onDismiss: () -> Unit,
    onOpenTitle: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val history by model.watchHistory.collectAsState()
    val cinemaData by model.cinemaDiscoverData.collectAsState()
    val cinemaLoading by model.cinemaDiscoverLoading.collectAsState()

    val hasLibraryContent = catalog.movies.isNotEmpty() ||
        catalog.series.isNotEmpty() ||
        catalog.albums.isNotEmpty() ||
        catalog.clips.isNotEmpty()

    LaunchedEffect(hasLibraryContent, cinemaData) {
        if (!hasLibraryContent && cinemaData == null && !cinemaLoading) {
            model.loadCinemaDiscover("Popular")
        }
    }

    val weightedPool: List<PickCandidate> = remember(catalog, history, cinemaData, hasLibraryContent) {
        if (hasLibraryContent) {
            buildList<PickCandidate> {
                val videos = catalog.movies + catalog.series + catalog.clips
                for (tile in videos) {
                    val c = PickCandidate.LibVideo(tile)
                    val watched = tile.items.any { item ->
                        val p = history[item.entry.key]
                        p != null && p.durationMs > 0L && (p.positionMs.toFloat() / p.durationMs) > 0.90f
                    }
                    val weight = 1 + (if (!watched) 1 else 0) + (if (tile.allSaved) 1 else 0)
                    repeat(weight) { add(c) }
                }
                for (album in catalog.albums) {
                    val c = PickCandidate.LibAlbum(album)
                    val weight = 1 + (if (album.allSaved) 1 else 0)
                    repeat(weight) { add(c) }
                }
            }
        } else {
            val items = (cinemaData?.movies.orEmpty() + cinemaData?.series.orEmpty())
            items.map { PickCandidate.DiscCinema(it) }
        }
    }

    val distinctKeys = remember(weightedPool) { weightedPool.map { it.stableKey }.toSet() }
    var currentPick by remember { mutableStateOf<PickCandidate?>(null) }

    fun rollNext(excludeKey: String?): PickCandidate? {
        if (weightedPool.isEmpty()) return null
        val filtered = if (excludeKey != null && distinctKeys.size > 1) {
            weightedPool.filter { it.stableKey != excludeKey }
        } else {
            weightedPool
        }
        val source = if (filtered.isNotEmpty()) filtered else weightedPool
        return source[Random.nextInt(source.size)]
    }

    LaunchedEffect(weightedPool) {
        val cur = currentPick
        if (cur == null || cur.stableKey !in distinctKeys) {
            currentPick = rollNext(excludeKey = null)
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Bg.copy(alpha = 0.82f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onDismiss,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .widthIn(max = 360.dp)
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .shadow(28.dp, PeekCardShape)
                    .clip(PeekCardShape)
                    .background(CardBg)
                    .border(1.dp, FloatingDockBorder, PeekCardShape)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = {},
                    ),
            ) {
                val pick = currentPick
                if (pick == null) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "TONIGHT'S PICK",
                                color = BrandHover,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                letterSpacing = 1.5.sp,
                                modifier = Modifier.weight(1f),
                            )
                            PeekCloseCircle(onDismiss = onDismiss)
                        }
                        if (cinemaLoading) {
                            CircularProgressIndicator(color = Pearl, strokeWidth = 2.dp, modifier = Modifier.size(26.dp))
                            Text("Finding something great…", color = Dim, fontSize = 13.sp)
                        } else {
                            Text(
                                text = "Add titles or explore Discover to roll a pick.",
                                color = Dim,
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center,
                            )
                            HeroPrimaryButton(
                                text = "Explore Discover",
                                icon = DiscoverIcon,
                                shape = PillShape,
                                onClick = {
                                    onDismiss()
                                    model.selectRoom(Room.Discover)
                                },
                                modifier = Modifier.fillMaxWidth().height(44.dp),
                            )
                        }
                    }
                } else {
                    AnimatedContent(
                        targetState = pick,
                        transitionSpec = {
                            (fadeIn(tween(180)) + scaleIn(initialScale = 0.94f, animationSpec = tween(200))) togetherWith
                                fadeOut(tween(120))
                        },
                        label = "tonightsPickTransition",
                    ) { active ->
                        TonightsPickCardBody(
                            model = model,
                            pick = active,
                            history = history,
                            canRollAgain = distinctKeys.size > 1,
                            onRollAgain = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                currentPick = rollNext(excludeKey = active.stableKey)
                            },
                            onDismiss = onDismiss,
                            onOpenTitle = onOpenTitle,
                            onOpenAlbum = onOpenAlbum,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TonightsPickCardBody(
    model: AppModel,
    pick: PickCandidate,
    history: Map<String, WatchProgress>,
    canRollAgain: Boolean,
    onRollAgain: () -> Unit,
    onDismiss: () -> Unit,
    onOpenTitle: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val sourceLabel = if (pick is PickCandidate.DiscCinema) "From Discover" else "From your library"

    val imdbId = when (pick) {
        is PickCandidate.LibVideo -> pick.tile.imdb
        is PickCandidate.DiscCinema -> pick.item.imdbId
        is PickCandidate.LibAlbum -> null
    }
    val isSeries = when (pick) {
        is PickCandidate.LibVideo -> pick.tile.kind == LibraryKind.Series
        is PickCandidate.DiscCinema -> pick.item.kind == "series"
        is PickCandidate.LibAlbum -> false
    }
    val titleText = when (pick) {
        is PickCandidate.LibVideo -> pick.tile.title
        is PickCandidate.LibAlbum -> pick.album.album.ifBlank { pick.album.title }
        is PickCandidate.DiscCinema -> pick.item.title
    }

    val meta by produceState<CinemaTitleMeta?>(
        initialValue = imdbId?.let { ExternalDiscoveryApi.cachedTitleMeta(it, isSeries = isSeries) },
        key1 = pick.stableKey,
    ) {
        value = when (pick) {
            is PickCandidate.LibVideo -> {
                val resolved = pick.tile.imdb ?: ExternalDiscoveryApi.resolveTitleImdb(pick.tile.title, isSeries = isSeries)
                if (!resolved.isNullOrBlank()) ExternalDiscoveryApi.loadTitleMeta(resolved, isSeries = isSeries) else null
            }
            is PickCandidate.DiscCinema -> ExternalDiscoveryApi.loadTitleMeta(pick.item.imdbId, isSeries = isSeries)
            is PickCandidate.LibAlbum -> null
        }
    }

    val backdropUrl = when (pick) {
        is PickCandidate.LibVideo -> meta?.backdropUrl?.takeIf { it.isNotBlank() } ?: imdbBackdropUrl(pick.tile.imdb)
        is PickCandidate.DiscCinema -> meta?.backdropUrl?.takeIf { it.isNotBlank() }
            ?: pick.item.backdropUrl.takeIf { it.isNotBlank() }
            ?: imdbBackdropUrl(pick.item.imdbId)
        is PickCandidate.LibAlbum -> null
    }
    val posterUrl = when (pick) {
        is PickCandidate.LibVideo -> meta?.posterUrl?.takeIf { it.isNotBlank() } ?: imdbPosterUrl(pick.tile.imdb)
        is PickCandidate.DiscCinema -> meta?.posterUrl?.takeIf { it.isNotBlank() }
            ?: pick.item.posterUrl.takeIf { it.isNotBlank() }
            ?: imdbPosterUrl(pick.item.imdbId)
        is PickCandidate.LibAlbum -> null
    }
    val artBitmap by produceState<ImageBitmap?>(
        initialValue = backdropUrl?.let { ExternalImageCache.get(it) }
            ?: posterUrl?.let { ExternalImageCache.get(it) },
        key1 = backdropUrl,
        key2 = posterUrl,
    ) {
        value = when {
            backdropUrl != null -> ExternalImageCache.load(backdropUrl)
                ?: posterUrl?.let { ExternalImageCache.load(it) }
            posterUrl != null -> ExternalImageCache.load(posterUrl)
            else -> null
        }
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        // Eyebrow header row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 14.dp, top = 14.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "TONIGHT'S PICK",
                color = BrandHover,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 1.5.sp,
            )
            Box(
                modifier = Modifier
                    .clip(PillShape)
                    .background(GlassBg)
                    .border(0.75.dp, GlassBorder, PillShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(
                    text = sourceLabel,
                    color = Dim,
                    fontSize = 10.5.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.weight(1f))
            PeekCloseCircle(onDismiss = onDismiss)
        }

        // Artwork zone
        when (pick) {
            is PickCandidate.LibAlbum -> {
                val glowHue = ((pick.album.hue % 360) + 360) % 360
                val topGlow = Color.hsl(glowHue.toFloat(), 0.56f, 0.24f, alpha = 0.42f)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(
                            Brush.verticalGradient(
                                0.0f to topGlow,
                                0.80f to CardBg.copy(alpha = 0.85f),
                                1.0f to CardBg,
                            ),
                        )
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    AlbumSleeve(
                        hue = pick.album.hue,
                        seed = pick.album.seed,
                        monogramText = pick.album.monogramText,
                        artist = pick.album.artist,
                        albumName = titleText,
                        cornerRadius = 16.dp,
                        borderless = true,
                        fontSize = 30.sp,
                        modifier = Modifier
                            .size(156.dp)
                            .shadow(18.dp, RoundedCornerShape(16.dp)),
                    )
                }
            }
            is PickCandidate.LibVideo, is PickCandidate.DiscCinema -> {
                val seed = when (pick) {
                    is PickCandidate.LibVideo -> pick.tile.seed
                    is PickCandidate.DiscCinema -> sleeveHash(pick.item.title)
                    is PickCandidate.LibAlbum -> 0L
                }
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(176.dp)
                        .background(CardElevated),
                ) {
                    val loaded = artBitmap
                    if (loaded != null) {
                        Image(
                            bitmap = loaded,
                            contentDescription = titleText,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.fillMaxSize(),
                        )
                    } else {
                        val hue = normalizeHue(seed)
                        Canvas(Modifier.fillMaxSize()) {
                            drawRect(
                                Brush.verticalGradient(
                                    0.0f to Color.hsl(hue.toFloat(), 0.48f, 0.24f),
                                    1.0f to CardBg,
                                ),
                            )
                        }
                    }
                    Canvas(Modifier.fillMaxSize()) {
                        drawRect(
                            Brush.verticalGradient(
                                0.0f to Color.Transparent,
                                0.62f to CardBg.copy(alpha = 0.55f),
                                1.0f to CardBg,
                            ),
                        )
                    }
                }
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = titleText,
                    color = Ink,
                    fontSize = 21.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.5).sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                when (pick) {
                    is PickCandidate.LibVideo -> {
                        PeekMetadataLine(
                            year = meta?.year?.takeIf { it.isNotBlank() } ?: pick.tile.year,
                            runtime = meta?.runtime?.takeIf { it.isNotBlank() },
                            rating = meta?.rating?.takeIf { it.isNotBlank() },
                            fallback = tileFactsLine(pick.tile),
                        )
                    }
                    is PickCandidate.LibAlbum -> {
                        val sub = listOfNotNull(
                            pick.album.artist.takeIf { it.isNotBlank() },
                            plural(pick.album.items.size, "track", "tracks"),
                        ).joinToString(" · ")
                        Text(sub, color = Dim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    is PickCandidate.DiscCinema -> {
                        PeekMetadataLine(
                            year = meta?.year?.takeIf { it.isNotBlank() } ?: pick.item.year,
                            runtime = meta?.runtime?.takeIf { it.isNotBlank() } ?: pick.item.runtime,
                            rating = meta?.rating?.takeIf { it.isNotBlank() } ?: pick.item.rating,
                            fallback = if (isSeries) "TV Show" else "Movie",
                        )
                    }
                }
            }

            val synopsis = when (pick) {
                is PickCandidate.LibVideo -> meta?.description?.takeIf { it.isNotBlank() }
                is PickCandidate.DiscCinema -> meta?.description?.takeIf { it.isNotBlank() }
                    ?: pick.item.description.takeIf { it.isNotBlank() }
                is PickCandidate.LibAlbum -> null
            }
            if (synopsis != null) {
                Text(
                    text = synopsis,
                    color = Dim,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(2.dp))

            HeroPrimaryButton(
                text = if (pick is PickCandidate.DiscCinema) "Find on PearTube" else "Play Now",
                icon = if (pick is PickCandidate.DiscCinema) SearchIcon else PlayIcon,
                shape = PillShape,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    onDismiss()
                    when (pick) {
                        is PickCandidate.LibVideo -> {
                            val entry = primaryEntryForVideo(pick.tile, history)
                            if (entry != null) model.playEntry(entry) else onOpenTitle(pick.tile.key)
                        }
                        is PickCandidate.LibAlbum -> {
                            val tracks = pick.album.toTrackItems()
                            if (tracks.isNotEmpty()) {
                                model.music.playTrackList(tracks, 0, titleText, shuffleOn = false)
                            } else {
                                onOpenAlbum(pick.album.key)
                            }
                        }
                        is PickCandidate.DiscCinema -> {
                            model.openSearchFor(pick.item.title, askRelays = true)
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PeekGlassPillButton(
                    text = "Roll Again",
                    icon = DiceIcon,
                    enabled = canRollAgain,
                    onClick = onRollAgain,
                    modifier = Modifier.weight(1f),
                )
                PeekGlassPillButton(
                    text = "Details",
                    icon = InfoIcon,
                    onClick = {
                        onDismiss()
                        when (pick) {
                            is PickCandidate.LibVideo -> onOpenTitle(pick.tile.key)
                            is PickCandidate.LibAlbum -> onOpenAlbum(pick.album.key)
                            is PickCandidate.DiscCinema -> model.openSearchFor(pick.item.title, askRelays = false)
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun PeekBackdropHeader(
    bitmap: ImageBitmap?,
    title: String,
    seed: Long,
    badgeText: String,
    badgeAccent: Boolean,
    onDismiss: () -> Unit,
) {
    val hue = normalizeHue(seed)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(176.dp)
            .background(CardElevated),
    ) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap,
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            Canvas(Modifier.fillMaxSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to Bg.copy(alpha = 0.34f),
                        0.46f to Color.Transparent,
                        0.82f to CardBg.copy(alpha = 0.88f),
                        1.0f to CardBg,
                    ),
                )
            }
        } else {
            val glowA = Color.hsl(hue.toFloat(), 0.48f, 0.24f)
            val glowB = Color.hsl(((hue + 48) % 360).toFloat(), 0.54f, 0.14f)
            Canvas(Modifier.fillMaxSize()) {
                drawRect(
                    Brush.verticalGradient(
                        0.0f to glowA,
                        0.60f to glowB,
                        1.0f to CardBg,
                    ),
                )
                drawCircle(
                    brush = Brush.radialGradient(
                        0.0f to Color.hsl(((hue + 140) % 360).toFloat(), 0.62f, 0.46f, alpha = 0.24f),
                        1.0f to Color.Transparent,
                        center = Offset(size.width * 0.80f, size.height * 0.25f),
                        radius = size.width * 0.60f,
                    ),
                    radius = size.width * 0.60f,
                    center = Offset(size.width * 0.80f, size.height * 0.25f),
                )
            }
        }

        if (badgeText.isNotBlank()) {
            Row(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(14.dp)
                    .clip(PillShape)
                    .background(Bg.copy(alpha = 0.72f))
                    .border(
                        width = 0.75.dp,
                        color = if (badgeAccent) Accent.copy(alpha = 0.45f) else GlassBorder,
                        shape = PillShape,
                    )
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(if (badgeAccent) Accent else Dim),
                )
                Text(
                    text = badgeText,
                    color = if (badgeAccent) Accent else Dim,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        PeekCloseCircle(
            onDismiss = onDismiss,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(14.dp),
        )
    }
}

@Composable
private fun PeekCloseCircle(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(Bg.copy(alpha = 0.64f))
            .border(0.75.dp, GlassBorder, CircleShape)
            .semantics { contentDescription = "Close" }
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Icon(CloseIcon, null, tint = Ink, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun PeekMetadataLine(
    year: String?,
    runtime: String?,
    rating: String?,
    fallback: String,
) {
    val leadParts = listOfNotNull(
        year?.takeIf { it.isNotBlank() },
        runtime?.takeIf { it.isNotBlank() },
    )
    if (leadParts.isEmpty() && rating.isNullOrBlank()) {
        if (fallback.isNotBlank()) {
            Text(fallback, color = Dim, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        return
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (leadParts.isNotEmpty()) {
            Text(
                text = leadParts.joinToString(" · "),
                color = Dim,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!rating.isNullOrBlank()) {
            if (leadParts.isNotEmpty()) {
                Text("·", color = Dim, fontSize = 13.sp)
            }
            Text(
                text = "★ $rating",
                color = Warn,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun PeekGlassPillButton(
    text: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Ink,
    enabled: Boolean = true,
) {
    val effectiveTint = if (enabled) tint else tint.copy(alpha = 0.45f)
    Row(
        modifier = modifier
            .height(38.dp)
            .clip(PillShape)
            .background(if (enabled) GlassBg else GlassBg.copy(alpha = 0.50f))
            .border(0.75.dp, GlassBorder, PillShape)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 10.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = effectiveTint,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(5.dp))
        Text(
            text = text,
            color = effectiveTint,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun mapToDiscoverGenre(genre: String): String {
    val trimmed = genre.trim()
    val direct = CINEMA_GENRES.firstOrNull { it.equals(trimmed, ignoreCase = true) }
    if (direct != null) return direct
    return when (trimmed.lowercase()) {
        "science fiction", "sci-fi & fantasy", "scifi" -> "Sci-Fi"
        "action & adventure" -> "Action"
        else -> trimmed
    }
}
