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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Entry
import com.peartube.app.LibraryCatalog
import com.peartube.app.LibraryKind
import com.peartube.app.LibraryTile
import com.peartube.app.MusicState
import com.peartube.app.Room
import com.peartube.app.Screen
import com.peartube.app.WatchProgress
import com.peartube.app.formatTimeLeft
import com.peartube.app.plural
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
    val badge: String? = null,
    val onClick: () -> Unit,
)

@Composable
fun HomeScreen(
    model: AppModel,
    catalog: LibraryCatalog,
    onOpenAlbum: (String) -> Unit,
    onOpenTitle: (String) -> Unit,
    onOpenMusicPlayer: () -> Unit,
) {
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val history by model.watchHistory.collectAsState()
    val musicState by model.musicState.collectAsState()

    val keepItems = remember(catalog, history, musicState) {
        buildKeepPlaying(catalog, history, musicState, model, onOpenMusicPlayer)
    }
    val homeAlbums = remember(catalog.albums) { catalog.albums.take(10) }
    val films = remember(catalog.movies, catalog.series) {
        (catalog.movies + catalog.series).sortedBy { it.title.lowercase() }
    }
    val homeVideos = remember(films, catalog.clips) {
        (if (films.isNotEmpty()) films else catalog.clips).take(10)
    }
    val showingClipsOnly = films.isEmpty() && catalog.clips.isNotEmpty()

    if (catalog.tiles.isEmpty() && keepItems.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Nothing in your library yet.", color = Ink, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                if (settings.hasSources && status == null) {
                    Text("Connecting to your channels…", color = Dim, fontSize = 14.sp)
                } else {
                    Text("Follow a channel or paste a link to fill your library.", color = Dim, fontSize = 14.sp)
                }
                Spacer(Modifier.height(4.dp))
                PrimaryLightButton(
                    text = "Add to library",
                    onClick = { model.pushScreen(Screen.Settings) },
                )
            }
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        if (keepItems.isNotEmpty()) {
            item(key = "keep-playing") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionHeader(title = "Keep playing")
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(keepItems, key = { it.key }) { item ->
                            KeepPlayingCard(item)
                        }
                    }
                }
            }
        }

        if (homeAlbums.isNotEmpty()) {
            item(key = "home-albums") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionHeader(
                        title = "Albums",
                        actionLabel = "All albums",
                        onAction = { model.selectRoom(Room.Listen) },
                    )
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
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
                            )
                        }
                    }
                }
            }
        }

        if (homeVideos.isNotEmpty()) {
            item(key = "home-videos") {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SectionHeader(
                        title = if (showingClipsOnly) "Clips" else "Movies and series",
                        actionLabel = if (showingClipsOnly) "All clips" else "All video",
                        onAction = { model.selectRoom(Room.Watch) },
                    )
                    LazyRow(
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(homeVideos, key = { it.key }) { tile ->
                            if (tile.kind == LibraryKind.Clip) {
                                WideVideoShelfCard(tile = tile, onClick = { onOpenTitle(tile.key) })
                            } else {
                                VideoShelfCard(
                                    tile = tile,
                                    history = history,
                                    onOpen = { onOpenTitle(tile.key) },
                                    onQuickPlay = { entry -> model.playEntry(entry) },
                                )
                            }
                        }
                    }
                }
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
                badge = if (tile.kind == LibraryKind.Series) entry.episodeLabel else if (tile.kind == LibraryKind.Movie) "Movie" else "Clip",
                onClick = { model.playEntry(entry) },
            ),
        )
    }

    val curTrack = musicState.currentTrack
    if (curTrack != null && (musicState.playing || musicState.positionMs > 0L || musicState.index > 0 || musicState.pausedForVideo)) {
        val sub = if (musicState.pausedForVideo) {
            "Paused for a video"
        } else {
            "Track ${musicState.index + 1} of ${musicState.order.size}"
        }
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
                onClick = onOpenMusicPlayer,
            ),
        )
    }

    return result.sortedByDescending { it.updatedAt }.take(6)
}

@Composable
private fun KeepPlayingCard(item: KeepItem) {
    Column(
        modifier = Modifier
            .width(if (item.isMusic) 144.dp else 210.dp)
            .clickable(onClick = item.onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (item.isMusic) {
            AlbumSleeve(
                hue = item.hue,
                seed = item.seed,
                monogramText = item.monogram,
                modifier = Modifier.fillMaxWidth(),
                fontSize = 24.sp,
            )
        } else {
            WideTitleArt(
                title = item.title,
                seed = item.seed,
                badge = item.badge,
                progress = item.progress,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Text(item.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            item.subtitle,
            color = if (item.subtitle == "Paused for a video") Warn else Dim,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
fun AlbumShelfCard(
    album: LibraryTile,
    onOpen: () -> Unit,
    onPlay: () -> Unit,
    modifier: Modifier = Modifier.width(148.dp),
) {
    val (stateText, isOk) = tileStateLabel(album)
    Column(
        modifier = modifier.clickable(onClick = onOpen),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AlbumSleeve(
            hue = album.hue,
            seed = album.seed,
            monogramText = album.monogramText,
            modifier = Modifier.fillMaxWidth(),
            overlay = {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(8.dp)
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Bg.copy(alpha = 0.80f))
                        .clickable(onClick = onPlay),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(PlayIcon, "Play ${album.album.ifBlank { album.title }}", tint = Ink, modifier = Modifier.size(18.dp))
                }
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
        if (isOk) {
            Text(stateText, color = Accent, fontSize = 11.sp, maxLines = 1)
        }
    }
}

@Composable
private fun VideoShelfCard(
    tile: LibraryTile,
    history: Map<String, WatchProgress>,
    onOpen: () -> Unit,
    onQuickPlay: (Entry) -> Unit,
) {
    val nextEntry = remember(tile, history) {
        if (tile.kind == LibraryKind.Series) {
            val episodes = tile.items.map { it.entry }
            val latest = episodes.mapNotNull { e -> history[e.key]?.let { e to it } }.maxByOrNull { it.second.updatedAt }
            val resume = latest?.takeIf { it.second.partial }?.first
                ?: latest?.let { pair -> episodes.getOrNull(episodes.indexOf(pair.first) + 1) }
            resume ?: episodes.firstOrNull()
        } else {
            tile.items.firstOrNull()?.entry
        }
    }
    val hasResume = remember(tile, history, nextEntry) {
        nextEntry != null && history[nextEntry.key]?.partial == true
    }
    val actionTag = when {
        tile.kind == LibraryKind.Series && nextEntry != null -> "${if (hasResume) "Resume" else "Play"} ${nextEntry.episodeLabel}"
        tile.kind == LibraryKind.Movie -> "Movie"
        else -> "Clip"
    }
    val (stateText, isOk) = tileStateLabel(tile)

    Column(
        modifier = Modifier
            .width(142.dp)
            .clickable(onClick = onOpen),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PosterArt(
            title = tile.title,
            year = tile.year,
            seed = tile.seed,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(tile.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (nextEntry != null) {
            Text(
                text = actionTag,
                color = if (tile.kind == LibraryKind.Series) Brand else Dim,
                fontSize = 12.sp,
                fontWeight = if (tile.kind == LibraryKind.Series) FontWeight.Medium else FontWeight.Normal,
                maxLines = 1,
                modifier = if (tile.kind == LibraryKind.Series) {
                    Modifier.clickable { onQuickPlay(nextEntry) }
                } else {
                    Modifier
                },
            )
        }
        val subFacts = if (isOk) {
            stateText
        } else if (tile.kind == LibraryKind.Movie) {
            listOfNotNull(
                tile.year,
                tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { com.peartube.shared.formatBytes(it) },
            ).joinToString(" · ").ifBlank { stateText }
        } else {
            tileFactsLine(tile)
        }
        Text(
            text = subFacts,
            color = if (isOk) Accent else Dim,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun WideVideoShelfCard(tile: LibraryTile, onClick: () -> Unit) {
    val sizeText = tile.items.firstOrNull()?.entry?.size?.takeIf { it > 0L }?.let { formatBytes(it) }
    Column(
        modifier = Modifier.width(204.dp).clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        WideTitleArt(title = tile.title, seed = tile.seed, badge = "Clip", modifier = Modifier.fillMaxWidth())
        Text(tile.title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(listOfNotNull("Clip", sizeText).joinToString(" · "), color = Dim, fontSize = 12.sp, maxLines = 1)
    }
}
