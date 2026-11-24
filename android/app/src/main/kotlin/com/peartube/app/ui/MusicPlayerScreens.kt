package com.peartube.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.RepeatMode
import com.peartube.app.fold
import com.peartube.shared.clock

/**
 * The small player dock sitting right above the bottom navigation bar whenever a music list exists.
 */
@Composable
fun MiniPlayerDock(
    model: AppModel,
    onOpenFull: () -> Unit,
) {
    val state by model.musicState.collectAsState()
    val track = state.currentTrack ?: return
    val progress = state.durationMs?.takeIf { it > 0L }?.let { (state.positionMs.toFloat() / it).coerceIn(0f, 1f) } ?: 0f

    Column(
        Modifier
            .fillMaxWidth()
            .background(CardBg)
            .clickable(onClick = onOpenFull),
    ) {
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth().height(2.dp),
            color = Brand,
            trackColor = Line,
        )
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AlbumSleeve(
                hue = track.hue,
                seed = track.seed,
                monogramText = track.monogramText,
                cornerRadius = 8.dp,
                fontSize = 14.sp,
                modifier = Modifier.size(44.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = track.title,
                    color = Ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val secondLine = if (state.pausedForVideo) {
                    "Paused for a video"
                } else {
                    listOfNotNull(
                        track.artist.takeIf { it.isNotBlank() },
                        track.album.takeIf { it.isNotBlank() },
                    ).joinToString(" · ")
                }
                if (secondLine.isNotEmpty()) {
                    Text(
                        text = secondLine,
                        color = if (state.pausedForVideo) Warn else Dim,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (state.buffering && state.playing) {
                Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Brand, strokeWidth = 2.dp)
                }
            } else {
                CinemaIcon(
                    icon = if (state.playing) PauseIcon else PlayIcon,
                    description = if (state.playing) "Pause" else "Play",
                    tint = Ink,
                    onClick = { model.music.togglePlayPause() },
                )
            }
            CinemaIcon(
                icon = SkipNextIcon,
                description = "Next",
                tint = Ink,
                onClick = { model.music.next() },
            )
        }
    }
}

/**
 * Full-screen music player with sleeve, transport controls, Shuffle/Repeat switches,
 * position indicator ("1 of N"), and the "Up next" queue.
 */
@Composable
fun MusicPlayerFullScreen(
    model: AppModel,
    onClose: () -> Unit,
    onOpenArtist: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
) {
    val state by model.musicState.collectAsState()
    val track = state.currentTrack
    var scrub by remember { mutableStateOf<Float?>(null) }

    if (track == null) {
        Column(Modifier.fillMaxSize().background(Bg).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                CinemaIcon(CloseIcon, "Close player", Ink, onClick = onClose)
                Text("Now playing", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            }
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Nothing in the music queue.", color = Dim)
            }
        }
        return
    }

    val durationMs = state.durationMs ?: 0L
    val shownPos = scrub?.toLong() ?: state.positionMs
    val ordered = state.orderedTracks

    Column(
        Modifier
            .fillMaxSize()
            .background(Bg)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CinemaIcon(CloseIcon, "Close player", Ink, onClick = onClose)
            Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                Text(
                    text = state.sourceLabel.ifBlank { track.album.ifBlank { "Music" } },
                    color = Dim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(state.positionText, color = Ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
            TextButton(onClick = { model.music.stopMusic(); onClose() }) {
                Text("Stop", color = Dim, fontSize = 13.sp)
            }
        }

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(bottom = 28.dp),
        ) {
            item(key = "player-stage") {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    AlbumSleeve(
                        hue = track.hue,
                        seed = track.seed,
                        monogramText = track.monogramText,
                        cornerRadius = 16.dp,
                        fontSize = 56.sp,
                        modifier = Modifier.fillMaxWidth(0.76f),
                    )
                    if (state.pausedForVideo) {
                        Text(
                            text = "Paused for a video",
                            color = Warn,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            text = track.title,
                            color = Ink,
                            fontSize = 21.sp,
                            fontWeight = FontWeight.Bold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (track.artist.isNotBlank()) {
                                Text(
                                    text = track.artist,
                                    color = Brand,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.clickable {
                                        onClose()
                                        onOpenArtist(fold(track.artist))
                                    },
                                )
                            }
                            if (track.artist.isNotBlank() && track.album.isNotBlank()) {
                                Text("·", color = Dim, fontSize = 14.sp)
                            }
                            if (track.album.isNotBlank()) {
                                Text(
                                    text = track.album,
                                    color = Dim,
                                    fontSize = 14.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.clickable {
                                        onClose()
                                        onOpenAlbum(track.albumKey)
                                    },
                                )
                            }
                        }
                    }

                    state.error?.let { err ->
                        Text(err, color = Danger, fontSize = 13.sp, modifier = Modifier.fillMaxWidth())
                    }

                    Column(Modifier.fillMaxWidth()) {
                        Slider(
                            value = shownPos.toFloat(),
                            onValueChange = { scrub = it },
                            valueRange = 0f..durationMs.coerceAtLeast(1L).toFloat(),
                            enabled = durationMs > 0L,
                            onValueChangeFinished = {
                                scrub?.let { model.music.seekTo(it.toLong()) }
                                scrub = null
                            },
                            colors = SliderDefaults.colors(
                                thumbColor = Brand,
                                activeTrackColor = Brand,
                                inactiveTrackColor = Line,
                            ),
                        )
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(clock(shownPos), color = Dim, fontSize = 12.sp)
                            Text(if (durationMs > 0L) clock(durationMs) else "—", color = Dim, fontSize = 12.sp)
                        }
                    }

                    // Transport controls (Rule 15: Shuffle and Next stay active and undimmed even on 1 of 1)
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CinemaIcon(
                            icon = ShuffleIcon,
                            description = "Shuffle",
                            tint = if (state.shuffle) Brand else Dim,
                            onClick = { model.music.toggleShuffle() },
                        )
                        CinemaIcon(
                            icon = SkipPreviousIcon,
                            description = "Previous",
                            tint = Ink,
                            onClick = { model.music.previous() },
                        )
                        Box(
                            modifier = Modifier
                                .size(60.dp)
                                .clip(CircleShape)
                                .background(Ink)
                                .clickable { model.music.togglePlayPause() },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (state.buffering && state.playing) {
                                CircularProgressIndicator(Modifier.size(26.dp), color = Bg, strokeWidth = 2.5.dp)
                            } else {
                                Icon(
                                    imageVector = if (state.playing) PauseIcon else PlayIcon,
                                    contentDescription = if (state.playing) "Pause" else "Play",
                                    tint = Bg,
                                    modifier = Modifier.size(30.dp),
                                )
                            }
                        }
                        CinemaIcon(
                            icon = SkipNextIcon,
                            description = "Next",
                            tint = Ink,
                            onClick = { model.music.next() },
                        )
                        CinemaIcon(
                            icon = if (state.repeat == RepeatMode.One) RepeatOneIcon else RepeatIcon,
                            description = "Repeat",
                            tint = if (state.repeat == RepeatMode.Off) Dim else Brand,
                            onClick = { model.music.cycleRepeat() },
                        )
                    }
                }
                HorizontalDivider(color = Line, modifier = Modifier.padding(top = 12.dp))
            }

            item(key = "up-next-head") {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 20.dp, end = 8.dp, top = 14.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Up next", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                        if (state.sourceLabel.isNotBlank()) {
                            Text("Playing from ${state.sourceLabel}", color = Dim, fontSize = 12.sp)
                        }
                    }
                    if (state.upNextCount > 0) {
                        TextButton(onClick = { model.music.clearUpNext() }) {
                            Text("Clear", color = Dim, fontSize = 13.sp)
                        }
                    }
                }
            }

            itemsIndexed(ordered, key = { orderIdx, item -> "$orderIdx-${item.key}" }) { orderIdx, item ->
                val isPast = orderIdx < state.index
                val isCurrent = orderIdx == state.index
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { model.music.jumpTo(orderIdx) }
                        .padding(start = 20.dp, end = 6.dp, top = 10.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.width(26.dp), contentAlignment = Alignment.CenterStart) {
                        if (isCurrent) {
                            Icon(PlayIcon, "Playing", tint = Brand, modifier = Modifier.size(16.dp))
                        } else {
                            Text(
                                "${orderIdx + 1}",
                                color = if (isPast) Dim.copy(alpha = 0.5f) else Dim,
                                fontSize = 12.sp,
                            )
                        }
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = item.title,
                            color = when {
                                isCurrent -> Brand
                                isPast -> Dim.copy(alpha = 0.65f)
                                else -> Ink
                            },
                            fontSize = 14.sp,
                            fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val sub = listOfNotNull(
                            item.artist.takeIf { it.isNotBlank() },
                            item.album.takeIf { it.isNotBlank() },
                        ).joinToString(" · ")
                        if (sub.isNotEmpty()) {
                            Text(
                                text = sub,
                                color = if (isPast) Dim.copy(alpha = 0.5f) else Dim,
                                fontSize = 12.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (orderIdx > state.index) {
                        IconButton(onClick = { model.music.removeFromQueue(orderIdx) }, modifier = Modifier.size(40.dp)) {
                            Icon(CloseIcon, "Remove from Up next", tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }
                HorizontalDivider(color = Line.copy(alpha = 0.35f))
            }
        }
    }
}
