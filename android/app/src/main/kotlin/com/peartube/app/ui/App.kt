package com.peartube.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Room
import com.peartube.app.Screen
import com.peartube.app.Status
import com.peartube.app.formatRate
import com.peartube.app.player.PlayerHost

@Composable
fun App(model: AppModel, player: PlayerHost) {
    val screen by model.screen.collectAsState()
    val room by model.currentRoom.collectAsState()
    val catalog by model.catalog.collectAsState()
    val status by model.status.collectAsState()
    val cast by model.cast.collectAsState()
    val showTvs by model.showTvsDialog.collectAsState()
    val showAdd by model.showAddSheet.collectAsState()
    val acquireJobs by model.acquireJobs.collectAsState()
    val error by model.error.collectAsState()
    val notice by model.notice.collectAsState()
    val activeAcquireCount = remember(acquireJobs) { acquireJobs.count { it.isActive } }

    var showHood by remember { mutableStateOf(false) }

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(notice) {
        notice?.let { snackbar.showSnackbar(it); model.notice.value = null }
    }

    BackHandler(enabled = showTvs || showHood || showAdd || screen != Screen.Main || room != Room.Home) {
        when {
            showTvs -> model.cancelCast()
            showHood -> showHood = false
            showAdd -> model.closeAddSheet()
            screen != Screen.Main -> model.popScreen()
            room != Room.Home -> model.selectRoom(Room.Home)
        }
    }

    val clearBehind = screen is Screen.Play
    Box(Modifier.fillMaxSize().then(if (clearBehind) Modifier else Modifier.background(Bg))) {
        Column(Modifier.fillMaxSize()) {
            error?.let { message ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .background(Danger.copy(alpha = 0.16f))
                        .padding(start = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(message, color = Ink, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
                    CinemaIcon(CloseIcon, "Dismiss error", Ink) { model.error.value = null }
                }
            }
            AnimatedContent(
                targetState = screen,
                transitionSpec = {
                    val touchesSurface = initialState is Screen.Play || targetState is Screen.Play
                    if (touchesSurface) EnterTransition.None togetherWith ExitTransition.None
                    else fadeIn(tween(160)) togetherWith fadeOut(tween(120))
                },
                contentKey = {
                    when (it) {
                        is Screen.Play -> Screen.Play::class
                        else -> it
                    }
                },
                modifier = Modifier.weight(1f),
                label = "PearTube screens",
            ) { current ->
                when (current) {
                    Screen.Main -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            TopAppBarRow(
                                status = status,
                                casting = cast.session != null,
                                activeAcquireCount = activeAcquireCount,
                                applyStatusBarPadding = error == null,
                                onOpenHood = { showHood = true },
                                onOpenNetwork = { model.pushScreen(Screen.Network) },
                                onOpenAdd = { model.openAddSheet() },
                                onOpenTvs = { model.openCastSheet() },
                                onOpenSettings = { model.pushScreen(Screen.Settings) },
                            )
                            HorizontalDivider(color = Line.copy(alpha = 0.7f))
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                when (room) {
                                    Room.Home -> HomeScreen(
                                        model = model,
                                        catalog = catalog,
                                        onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                        onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                        onOpenMusicPlayer = { model.pushScreen(Screen.MusicPlayerFull) },
                                    )
                                    Room.Listen -> ListenScreen(
                                        model = model,
                                        catalog = catalog,
                                        onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                        onOpenArtist = { model.pushScreen(Screen.ArtistDetail(it)) },
                                    )
                                    Room.Watch -> WatchScreen(
                                        model = model,
                                        catalog = catalog,
                                        onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                    )
                                    Room.Discover -> DiscoverScreen(model = model, catalog = catalog)
                                    Room.Search -> SearchScreen(
                                        model = model,
                                        catalog = catalog,
                                        onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                        onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                    )
                                }
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                            BottomRoomsBar(
                                current = room,
                                onSelect = { model.selectRoom(it) },
                            )
                        }
                    }
                    is Screen.AlbumDetail -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                AlbumDetailScreen(
                                    model = model,
                                    album = catalog.albumByKey(current.albumKey),
                                    catalog = catalog,
                                    onBack = { model.popScreen() },
                                    onOpenArtist = { model.pushScreen(Screen.ArtistDetail(it)) },
                                    onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                )
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                        }
                    }
                    is Screen.ArtistDetail -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                ArtistDetailScreen(
                                    model = model,
                                    artist = catalog.artistByKey(current.artistKey),
                                    onBack = { model.popScreen() },
                                    onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                )
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                        }
                    }
                    is Screen.TitleDetail -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                TitleDetailScreen(
                                    model = model,
                                    tile = catalog.tileByKey(current.titleKey),
                                    onBack = { model.popScreen() },
                                )
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                        }
                    }
                    is Screen.ShelfDetail -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                ShelfDetailScreen(
                                    model = model,
                                    peer = current.peer,
                                    onBack = { model.popScreen() },
                                )
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                        }
                    }
                    Screen.MusicPlayerFull -> MusicPlayerFullScreen(
                        model = model,
                        onClose = { model.popScreen() },
                        onOpenArtist = { model.pushScreen(Screen.ArtistDetail(it)) },
                        onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                    )
                    Screen.Network -> {
                        Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                NetworkScreen(
                                    model = model,
                                    onBack = { model.popScreen() },
                                )
                            }
                            CastRemoteBar(model)
                            MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                        }
                    }
                    Screen.Settings -> SettingsScreen(model)
                    is Screen.Play -> key(current.entry.key) {
                        PlayScreen(model, player, current.entry, current.startPositionMs)
                    }
                }
            }
        }
        SnackbarHost(
            snackbar,
            Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 72.dp, start = 16.dp, end = 16.dp),
        )
    }

    if (showHood) {
        UnderTheHoodSheet(
            model = model,
            onClose = { showHood = false },
            onOpenNetwork = {
                showHood = false
                model.pushScreen(Screen.Network)
            },
            onOpenSettings = {
                showHood = false
                model.pushScreen(Screen.Settings)
            },
        )
    }
    if (showAdd) {
        AddToLibrarySheet(
            model = model,
            onClose = { model.closeAddSheet() },
            onOpenSettings = { model.pushScreen(Screen.Settings) },
        )
    }
    if (showTvs) {
        TvsDialog(model)
    }
}

@Composable
private fun TopAppBarRow(
    status: Status?,
    casting: Boolean,
    activeAcquireCount: Int,
    applyStatusBarPadding: Boolean,
    onOpenHood: () -> Unit,
    onOpenNetwork: () -> Unit,
    onOpenAdd: () -> Unit,
    onOpenTvs: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val peers = status?.routes?.totalPeers ?: 0L
    val totalBps = (status?.downBps ?: 0L) + (status?.upBps ?: 0L)
    val netLabel = when {
        totalBps > 0L -> "$peers · ${formatRate(totalBps)}"
        peers == 1L -> "1 peer"
        else -> "$peers peers"
    }
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (applyStatusBarPadding) Modifier.statusBarsPadding() else Modifier)
            .heightIn(min = 54.dp)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .clickable(onClick = onOpenHood)
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "PearTube",
                    color = Ink,
                    fontSize = 21.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    softWrap = false,
                )
            }
            Spacer(Modifier.width(8.dp))
            Row(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .clip(PillShape)
                    .background(CardElevated)
                    .border(1.dp, if (peers > 0L) Accent.copy(alpha = 0.4f) else Line, PillShape)
                    .semantics { contentDescription = "Network: $netLabel" }
                    .clickable(onClick = onOpenNetwork)
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(6.dp)
                        .background(if (peers > 0L) Accent else Dim, CircleShape),
                )
                Spacer(Modifier.width(5.dp))
                Text(
                    text = netLabel,
                    color = if (peers > 0L) Ink else Dim,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    softWrap = false,
                )
            }
        }
        if (activeAcquireCount > 0) {
            Row(
                modifier = Modifier
                    .padding(start = 4.dp, end = 4.dp)
                    .clip(PillShape)
                    .background(CardElevated)
                    .border(1.dp, Brand.copy(alpha = 0.55f), PillShape)
                    .clickable(onClick = onOpenAdd)
                    .padding(horizontal = 9.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(7.dp)
                        .background(Brand, CircleShape),
                )
                Spacer(Modifier.width(5.dp))
                Text(
                    text = if (activeAcquireCount == 1) "Adding…" else "Adding $activeAcquireCount…",
                    color = Ink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
        CinemaIcon(AddIcon, "Add to library", Ink, onClick = onOpenAdd)
        IconButton(onClick = onOpenTvs, modifier = Modifier.size(44.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(TvIcon, "TVs", tint = if (casting) Ink else Dim, modifier = Modifier.size(22.dp))
                if (casting) {
                    Box(
                        Modifier
                            .align(Alignment.TopEnd)
                            .size(7.dp)
                            .background(Accent, CircleShape),
                    )
                }
            }
        }
        CinemaIcon(SettingsIcon, "Settings", Dim, onClick = onOpenSettings)
    }
}

@Composable
private fun BottomRoomsBar(
    current: Room,
    onSelect: (Room) -> Unit,
) {
    HorizontalDivider(color = Line)
    Row(
        Modifier
            .fillMaxWidth()
            .background(Bg)
            .heightIn(min = 60.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Room.entries.forEach { room ->
            val selected = room == current
            val tint = if (selected) Brand else Dim
            Column(
                modifier = Modifier
                    .weight(1f)
                    .selectable(selected = selected, role = Role.Tab, onClick = { onSelect(room) })
                    .padding(vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Icon(
                    imageVector = roomIcon(room),
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(22.dp),
                )
                Text(
                    text = room.label,
                    color = tint,
                    fontSize = 11.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun roomIcon(room: Room): ImageVector = when (room) {
    Room.Home -> HomeIcon
    Room.Listen -> ListenIcon
    Room.Watch -> WatchIcon
    Room.Discover -> DiscoverIcon
    Room.Search -> SearchIcon
}
