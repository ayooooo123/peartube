package com.peartube.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode as AnimRepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Room
import com.peartube.app.Screen
import com.peartube.app.Status
import com.peartube.app.VideoDisplayMode
import com.peartube.app.player.PlayerHost

@Composable
fun App(model: AppModel, player: PlayerHost) {
    val screen by model.screen.collectAsState()
    val room by model.currentRoom.collectAsState()
    val catalog by model.catalog.collectAsState()
    val status by model.status.collectAsState()
    val cast by model.cast.collectAsState()
    val castReconnecting by model.castReconnecting.collectAsState()
    val lastCastSession by model.lastCastSession.collectAsState()
    val hasCastRemote = cast.session != null || (castReconnecting && lastCastSession != null)
    val musicState by model.musicState.collectAsState()
    val activeVideo by model.activeVideo.collectAsState()
    val videoMode by model.videoMode.collectAsState()
    val showTvs by model.showTvsDialog.collectAsState()
    val showAdd by model.showAddSheet.collectAsState()
    val showMusicPlayer by model.showMusicPlayer.collectAsState()
    val peekTarget by model.peekTarget.collectAsState()
    val showTonightsPick by model.showTonightsPick.collectAsState()
    val acquireJobs by model.acquireJobs.collectAsState()
    val downloads by model.downloads.collectAsState()
    val error by model.error.collectAsState()
    val notice by model.notice.collectAsState()
    val activeTransferCount = remember(acquireJobs, downloads) {
        acquireJobs.count { it.isActive } + downloads.size
    }

    var showHood by remember { mutableStateOf(false) }
    var miniCutoutRect by remember { mutableStateOf<MiniCutoutRect?>(null) }
    val musicSheetOpenFraction = remember { androidx.compose.runtime.mutableFloatStateOf(0f) }

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(notice) {
        notice?.let { snackbar.showSnackbar(it); model.notice.value = null }
    }
    LaunchedEffect(videoMode) {
        if (videoMode != VideoDisplayMode.Mini) {
            miniCutoutRect = null
        }
    }

    val videoFullscreen = activeVideo != null && videoMode == VideoDisplayMode.Fullscreen
    val videoPip = activeVideo != null && videoMode == VideoDisplayMode.Pip
    val videoMini = activeVideo != null && videoMode == VideoDisplayMode.Mini
    val showBrowsing = !videoFullscreen && !videoPip

    BackHandler(
        enabled = !videoFullscreen && !videoPip && !showMusicPlayer &&
            (peekTarget != null || showTonightsPick || showTvs || showHood || showAdd || screen != Screen.Main || room != Room.Home),
    ) {
        when {
            peekTarget != null -> model.closePeek()
            showTonightsPick -> model.showTonightsPick.value = false
            showTvs -> model.cancelCast()
            showHood -> showHood = false
            showAdd -> model.closeAddSheet()
            screen != Screen.Main -> model.popScreen()
            room == Room.Search -> model.toggleSearchRoom()
            room != Room.Home -> model.selectRoom(Room.Home)
        }
    }

    val browsingModifier = if (videoMini && miniCutoutRect != null) {
        val cutout = miniCutoutRect
        Modifier
            .fillMaxSize()
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            .drawWithContent {
                drawContent()
                if (cutout != null && cutout.width > 0f && cutout.height > 0f) {
                    drawRoundRect(
                        color = Color.Transparent,
                        topLeft = Offset(cutout.left, cutout.top),
                        size = Size(cutout.width, cutout.height),
                        cornerRadius = CornerRadius(cutout.cornerRadiusPx, cutout.cornerRadiusPx),
                        blendMode = BlendMode.Clear,
                    )
                }
            }
            .background(Bg)
    } else {
        Modifier
            .fillMaxSize()
            .background(Bg)
    }

    val statusBarTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val navBarBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val floatingTopInset = statusBarTop + 58.dp
    val floatingBottomInset = navBarBottom + 92.dp +
        (if (musicState.hasQueue) 68.dp else 0.dp) +
        (if (hasCastRemote) 56.dp else 0.dp)

    Box(Modifier.fillMaxSize()) {
        // Layer 1: Normal browsing UI (punches transparent rounded cutout when floating video Mini is active,
        // and subtly recesses behind the full-screen music player sheet at 120fps without recomposing)
        if (showBrowsing) {
            Box(
                browsingModifier.graphicsLayer {
                    val open = musicSheetOpenFraction.floatValue
                    if (open > 0.001f) {
                        val s = 1f - (0.045f * open)
                        scaleX = s
                        scaleY = s
                    }
                },
            ) {
                // LUMEN subtle ambient top radial room wash
                AmbientRoomWash(room = room)

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
                            Text(
                                text = message,
                                color = Ink,
                                fontSize = 13.sp,
                                modifier = Modifier.weight(1f).padding(vertical = 10.dp),
                            )
                            CinemaIcon(CloseIcon, "Dismiss error", Ink) { model.error.value = null }
                        }
                    }
                    AnimatedContent(
                        targetState = screen,
                        transitionSpec = {
                            fadeIn(tween(160)) togetherWith fadeOut(tween(120))
                        },
                        modifier = Modifier.weight(1f),
                        label = "PearTube screens",
                    ) { current ->
                        when (current) {
                            Screen.Main -> {
                                // Content fills full viewport & scrolls smoothly underneath floating transparent bars!
                                Box(Modifier.fillMaxSize()) {
                                    val effectiveTop = if (error == null) floatingTopInset else 58.dp
                                    val homeHasHero = catalog.albums.isNotEmpty() || catalog.videos.isNotEmpty()
                                    val homeTopPadding = if (homeHasHero && error == null) 0.dp else effectiveTop
                                    val homeHeroTopInset = if (error == null) statusBarTop + 52.dp else 52.dp
                                    when (room) {
                                        Room.Home -> HomeScreen(
                                            model = model,
                                            catalog = catalog,
                                            onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                            onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                            onOpenMusicPlayer = { model.pushScreen(Screen.MusicPlayerFull) },
                                            topPadding = homeTopPadding,
                                            heroTopInset = homeHeroTopInset,
                                            bottomPadding = floatingBottomInset,
                                        )
                                        Room.Discover -> DiscoverScreen(
                                            model = model,
                                            catalog = catalog,
                                            onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                            topPadding = effectiveTop,
                                            bottomPadding = floatingBottomInset,
                                        )
                                        Room.Library, Room.Listen, Room.Watch -> LibraryScreen(
                                            model = model,
                                            catalog = catalog,
                                            onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                            onOpenArtist = { model.pushScreen(Screen.ArtistDetail(it)) },
                                            onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                            topPadding = effectiveTop,
                                            bottomPadding = floatingBottomInset,
                                        )
                                        Room.Search -> SearchScreen(
                                            model = model,
                                            catalog = catalog,
                                            onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                            onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                                            topPadding = effectiveTop,
                                            bottomPadding = floatingBottomInset,
                                        )
                                    }

                                    // Single-row contextual top header (zero permanent logo chrome stack)
                                    val homeHeroBleed = room == Room.Home && homeHasHero && error == null
                                    RoomTopBar(
                                        room = room,
                                        homeHasHero = homeHeroBleed,
                                        status = status,
                                        activeTransferCount = activeTransferCount,
                                        applyStatusBarPadding = error == null,
                                        onOpenAdd = { model.openAddSheet() },
                                        onToggleSearch = { model.toggleSearchRoom() },
                                        onOpenHood = { showHood = true },
                                        modifier = Modifier.align(Alignment.TopCenter),
                                    )

                                    // Floating Bottom Stack: Auto-Acquire banner + Cast bar + MiniPlayerDock + 3-Tab Spatial Capsule
                                    Column(
                                        modifier = Modifier
                                            .align(Alignment.BottomCenter)
                                            .fillMaxWidth()
                                            .background(
                                                Brush.verticalGradient(
                                                    0.0f to Color.Transparent,
                                                    0.45f to BottomScrimStrong,
                                                    1.0f to Bg,
                                                ),
                                            )
                                            .navigationBarsPadding(),
                                    ) {
                                        AutoAcquireToastBar(model)
                                        CastRemoteBar(model)
                                        MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                                        BottomRoomsBar(
                                            current = room,
                                            onSelect = { model.selectRoom(it) },
                                            onLongPressHome = { showHood = true },
                                            onLongPressDiscover = { model.selectRoom(Room.Search, focusSearch = true) },
                                            onLongPressLibrary = { model.showTonightsPick.value = true },
                                        )
                                    }
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
                                    AutoAcquireToastBar(model)
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
                                    AutoAcquireToastBar(model)
                                    CastRemoteBar(model)
                                    MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                                }
                            }
                            is Screen.ExternalArtistDetail -> {
                                Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                                    Box(Modifier.weight(1f).fillMaxWidth()) {
                                        ExternalArtistDetailScreen(
                                            model = model,
                                            catalog = catalog,
                                            browseId = current.browseId,
                                            initialName = current.name,
                                            initialArtUrl = current.artUrl,
                                            onBack = { model.popScreen() },
                                            onOpenLocalAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
                                            onOpenExternalAlbum = { bid, title, artist, art ->
                                                model.openExternalAlbum(bid, title, artist, art)
                                            },
                                            onOpenExternalArtist = { bid, name, art ->
                                                model.openExternalArtist(bid, name, art)
                                            },
                                        )
                                    }
                                    AutoAcquireToastBar(model)
                                    CastRemoteBar(model)
                                    MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                                }
                            }
                            is Screen.ExternalAlbumDetail -> {
                                Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                                    Box(Modifier.weight(1f).fillMaxWidth()) {
                                        ExternalAlbumDetailScreen(
                                            model = model,
                                            catalog = catalog,
                                            browseId = current.browseId,
                                            initialTitle = current.title,
                                            initialArtist = current.artist,
                                            initialArtUrl = current.artUrl,
                                            onBack = { model.popScreen() },
                                            onOpenExternalArtist = { bid, name, art ->
                                                model.openExternalArtist(bid, name, art)
                                            },
                                        )
                                    }
                                    AutoAcquireToastBar(model)
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
                                    AutoAcquireToastBar(model)
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
                                    AutoAcquireToastBar(model)
                                    CastRemoteBar(model)
                                    MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                                }
                            }
                            Screen.MusicPlayerFull -> Box(Modifier.fillMaxSize().background(Bg))
                            Screen.Network -> {
                                Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                                    Box(Modifier.weight(1f).fillMaxWidth()) {
                                        NetworkScreen(
                                            model = model,
                                            onBack = { model.popScreen() },
                                        )
                                    }
                                    AutoAcquireToastBar(model)
                                    CastRemoteBar(model)
                                    MiniPlayerDock(model, onOpenFull = { model.pushScreen(Screen.MusicPlayerFull) })
                                }
                            }
                            Screen.Settings -> SettingsScreen(model)
                            is Screen.Play -> Box(Modifier.fillMaxSize().background(Bg))
                        }
                    }
                }
                SnackbarHost(
                    snackbar,
                    Modifier
                        .align(Alignment.BottomCenter)
                        .navigationBarsPadding()
                        .padding(bottom = 86.dp, start = 16.dp, end = 16.dp),
                )
            }
        }

        // Layer 1.5: Full-screen Music Player overlay sheet (mounted above live browsing UI so swipe-down
        // reveals the real screen & MiniPlayerDock underneath with zero cross-fade pop)
        if (showBrowsing && showMusicPlayer) {
            MusicPlayerFullScreen(
                model = model,
                onClose = {
                    musicSheetOpenFraction.floatValue = 0f
                    model.closeMusicPlayer()
                },
                onOpenArtist = {
                    musicSheetOpenFraction.floatValue = 0f
                    model.closeMusicPlayer()
                    model.pushScreen(Screen.ArtistDetail(it))
                },
                onOpenAlbum = {
                    musicSheetOpenFraction.floatValue = 0f
                    model.closeMusicPlayer()
                    model.pushScreen(Screen.AlbumDetail(it))
                },
                onOpenFractionChanged = { musicSheetOpenFraction.floatValue = it },
            )
        }

        // Layer 2: Hoisted Video Player Session (persists NativePlayer & Surface across Fullscreen <-> Mini <-> OS PiP)
        val currentVideo = activeVideo
        if (currentVideo != null && videoMode != VideoDisplayMode.Closed) {
            key(currentVideo.entry.key) {
                val extraBottomDp = remember(screen, musicState.hasQueue, hasCastRemote) {
                    var total = 18
                    if (screen == Screen.Main) total += 76
                    if (musicState.hasQueue && screen != Screen.MusicPlayerFull && screen != Screen.Settings) total += 68
                    if (hasCastRemote && screen != Screen.MusicPlayerFull && screen != Screen.Settings) total += 56
                    total.dp
                }
                VideoSessionHost(
                    model = model,
                    host = player,
                    entry = currentVideo.entry,
                    startPositionMs = currentVideo.startPositionMs,
                    mode = videoMode,
                    miniBottomClearance = extraBottomDp,
                    onMiniCutoutChanged = { rect -> miniCutoutRect = rect },
                )
            }
        }
    }

    if (!videoPip) {
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
                onOpenAdd = {
                    showHood = false
                    model.openAddSheet()
                },
                onOpenTvs = {
                    showHood = false
                    model.openCastSheet()
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
        val activePeek = peekTarget
        if (activePeek != null) {
            PeekCardOverlay(
                model = model,
                catalog = catalog,
                target = activePeek,
                onDismiss = { model.closePeek() },
                onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
            )
        }
        if (showTonightsPick) {
            TonightsPickDialog(
                model = model,
                catalog = catalog,
                onDismiss = { model.showTonightsPick.value = false },
                onOpenTitle = { model.pushScreen(Screen.TitleDetail(it)) },
                onOpenAlbum = { model.pushScreen(Screen.AlbumDetail(it)) },
            )
        }
    }
}

/**
 * Luminous 3D Pearl Orb (warm ivory highlight -> soft pearl -> subtle obsidian rim).
 */
@Composable
internal fun PearlOrb(
    size: Dp,
    modifier: Modifier = Modifier,
) {
    Canvas(
        modifier = modifier
            .size(size)
            .shadow(elevation = 6.dp, shape = CircleShape)
            .clip(CircleShape)
            .border(0.75.dp, GlassBorder, CircleShape),
    ) {
        val w = this.size.width
        val h = this.size.height
        val r = maxOf(w, h) * 0.72f
        drawCircle(
            brush = Brush.radialGradient(
                0.0f to PearlHighlight,
                0.38f to Pearl,
                0.76f to PearlMid,
                1.0f to PearlRim,
                center = Offset(w * 0.32f, h * 0.28f),
                radius = r.coerceAtLeast(1f),
            ),
        )
    }
}

@Composable
private fun AmbientRoomWash(room: Room) {
    val primaryGlow = when (room) {
        Room.Discover -> AmbientBrandGlow
        Room.Library, Room.Listen, Room.Watch -> AmbientAccentGlow
        Room.Home, Room.Search -> AmbientPearlGlow
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp)
            .background(
                Brush.verticalGradient(
                    0.0f to primaryGlow,
                    0.55f to primaryGlow.copy(alpha = 0.04f),
                    1.0f to Color.Transparent,
                ),
            ),
    )
}

/**
 * Single-row contextual LUMEN top header:
 * - Home (with Hero): floats ONLY quiet 36dp Search + live Status pill at top-right over hero fade
 * - Home (empty): PearTube title + Search + Status pill
 * - Discover: bold "Discover" + Search + Status pill
 * - Library: bold "Library" + circular + Add + Search + compact Status dot circle
 * - Search: circular Back + bold "Search" + compact Status dot circle
 */
@Composable
private fun RoomTopBar(
    room: Room,
    homeHasHero: Boolean,
    status: Status?,
    activeTransferCount: Int,
    applyStatusBarPadding: Boolean,
    onOpenAdd: () -> Unit,
    onToggleSearch: () -> Unit,
    onOpenHood: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val peers = status?.routes?.totalPeers ?: 0L
    val pillLabel = when {
        activeTransferCount > 0 -> "↓ $activeTransferCount"
        peers == 1L -> "1 peer"
        peers > 1L -> "$peers peers"
        else -> "Swarm"
    }
    val statusDotColor = when {
        activeTransferCount > 0 -> Brand
        peers > 0L -> Accent
        else -> Warn
    }
    val dotAlpha = if (activeTransferCount > 0) {
        val pulse = rememberInfiniteTransition(label = "transferPulse")
        val animated by pulse.animateFloat(
            initialValue = 0.45f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(750),
                repeatMode = AnimRepeatMode.Reverse,
            ),
            label = "transferDotAlpha",
        )
        animated
    } else {
        1.0f
    }

    val solidHeader = !homeHasHero
    val headerBrush = if (solidHeader) {
        Brush.verticalGradient(
            0.0f to Bg,
            0.86f to Bg,
            0.94f to TopBarFadeMid,
            1.0f to Color.Transparent,
        )
    } else {
        Brush.verticalGradient(
            0.0f to Bg.copy(alpha = 0.78f),
            0.60f to Bg.copy(alpha = 0.36f),
            1.0f to Color.Transparent,
        )
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(headerBrush)
            .padding(bottom = if (solidHeader) 14.dp else 4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (applyStatusBarPadding) Modifier.statusBarsPadding() else Modifier)
                .heightIn(min = 48.dp)
                .padding(horizontal = 20.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            when (room) {
                Room.Home -> {
                    if (!homeHasHero) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(9.dp),
                        ) {
                            PearlOrb(size = 24.dp)
                            Text(
                                text = "PearTube",
                                color = Ink,
                                fontSize = 22.sp,
                                fontWeight = FontWeight.Bold,
                                letterSpacing = (-0.5).sp,
                                maxLines = 1,
                                softWrap = false,
                            )
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    TopCircleButton(
                        icon = SearchIcon,
                        description = "Search",
                        onClick = onToggleSearch,
                    )
                    TopStatusPill(
                        label = pillLabel,
                        dotColor = statusDotColor,
                        dotAlpha = dotAlpha,
                        highlighted = peers > 0L || activeTransferCount > 0,
                        onClick = onOpenHood,
                    )
                }
                Room.Discover -> {
                    Text(
                        text = "Discover",
                        color = Ink,
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.7).sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    TopCircleButton(
                        icon = SearchIcon,
                        description = "Search",
                        onClick = onToggleSearch,
                    )
                    TopStatusPill(
                        label = pillLabel,
                        dotColor = statusDotColor,
                        dotAlpha = dotAlpha,
                        highlighted = peers > 0L || activeTransferCount > 0,
                        onClick = onOpenHood,
                    )
                }
                Room.Library, Room.Listen, Room.Watch -> {
                    Text(
                        text = "Library",
                        color = Ink,
                        fontSize = 28.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.7).sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    TopCircleButton(
                        icon = AddIcon,
                        description = "Add to library",
                        onClick = onOpenAdd,
                    )
                    TopCircleButton(
                        icon = SearchIcon,
                        description = "Search",
                        onClick = onToggleSearch,
                    )
                    TopStatusDotCircle(
                        label = pillLabel,
                        dotColor = statusDotColor,
                        dotAlpha = dotAlpha,
                        highlighted = peers > 0L || activeTransferCount > 0,
                        onClick = onOpenHood,
                    )
                }
                Room.Search -> {
                    TopCircleButton(
                        icon = BackIcon,
                        description = "Back from search",
                        onClick = onToggleSearch,
                    )
                    Text(
                        text = "Search",
                        color = Ink,
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.6).sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f).padding(start = 4.dp),
                    )
                    TopStatusDotCircle(
                        label = pillLabel,
                        dotColor = statusDotColor,
                        dotAlpha = dotAlpha,
                        highlighted = peers > 0L || activeTransferCount > 0,
                        onClick = onOpenHood,
                    )
                }
            }
        }
    }
}

@Composable
private fun TopCircleButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(GlassBg)
            .border(0.75.dp, GlassBorder, CircleShape)
            .semantics { contentDescription = description }
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Ink,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun TopStatusPill(
    label: String,
    dotColor: Color,
    dotAlpha: Float,
    highlighted: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .height(36.dp)
            .clip(PillShape)
            .background(GlassBg)
            .border(
                width = 0.75.dp,
                color = if (highlighted) FloatingDockBorder else GlassBorder,
                shape = PillShape,
            )
            .semantics { contentDescription = "Swarm status: $label" }
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dotColor.copy(alpha = dotAlpha)),
        )
        Text(
            text = label,
            color = Ink,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun TopStatusDotCircle(
    label: String,
    dotColor: Color,
    dotAlpha: Float,
    highlighted: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(GlassBg)
            .border(
                width = 0.75.dp,
                color = if (highlighted) FloatingDockBorder else GlassBorder,
                shape = CircleShape,
            )
            .semantics { contentDescription = "Swarm status: $label" }
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(9.dp)
                .clip(CircleShape)
                .background(dotColor.copy(alpha = dotAlpha)),
        )
    }
}

private data class DockRoomTab(
    val room: Room,
    val label: String,
    val icon: ImageVector,
)

private val DOCK_TABS = listOf(
    DockRoomTab(Room.Home, "Home", HomeIcon),
    DockRoomTab(Room.Discover, "Discover", DiscoverIcon),
    DockRoomTab(Room.Library, "Library", LibraryIcon),
)

/**
 * Floating 3-tab spatial full-capsule bottom dock matching LUMEN mobile demos:
 * Home | Discover | Library
 * Long-pressing each tab triggers its thumb-zone shortcut:
 * Home -> Swarm / Node sheet, Discover -> Instant Search, Library -> Tonight's Pick.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BottomRoomsBar(
    current: Room,
    onSelect: (Room) -> Unit,
    onLongPressHome: () -> Unit,
    onLongPressDiscover: () -> Unit,
    onLongPressLibrary: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp)
            .padding(bottom = 10.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .shadow(20.dp, PillShape)
                .clip(PillShape)
                .background(FloatingDockBg)
                .border(1.dp, FloatingDockBorder, PillShape)
                .padding(horizontal = 5.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            DOCK_TABS.forEach { tab ->
                val isSelected = when (tab.room) {
                    Room.Library -> current == Room.Library || current == Room.Listen || current == Room.Watch
                    else -> current == tab.room
                }
                val tint = if (isSelected) Pearl else Dim
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(PillShape)
                        .background(if (isSelected) GlassHighlight else Color.Transparent)
                        .semantics {
                            role = Role.Tab
                            selected = isSelected
                        }
                        .combinedClickable(
                            onClick = {
                                if (!isSelected) {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                }
                                onSelect(tab.room)
                            },
                            onLongClick = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                when (tab.room) {
                                    Room.Home -> onLongPressHome()
                                    Room.Discover -> onLongPressDiscover()
                                    Room.Library -> onLongPressLibrary()
                                    else -> {}
                                }
                            },
                        )
                        .padding(vertical = 3.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = null,
                        tint = tint,
                        modifier = Modifier.size(19.dp),
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = tab.label,
                        color = tint,
                        fontSize = 10.sp,
                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun AutoAcquireToastBar(model: AppModel) {
    val banner by model.autoAcquireBanner.collectAsState()
    AnimatedVisibility(
        visible = banner != null,
        enter = fadeIn(tween(160)),
        exit = fadeOut(tween(140)),
    ) {
        val current = banner ?: return@AnimatedVisibility
        val plan = current.plan
        val displayTitle = if (plan.artist.isNotBlank() && !plan.title.contains(plan.artist, ignoreCase = true)) {
            "${plan.artist} — ${plan.title}"
        } else {
            plan.title
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp)
                .shadow(14.dp, CardShape)
                .clip(CardShape)
                .background(FloatingDockBg)
                .border(1.dp, FloatingDockBorder, CardShape)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(Accent),
                )
                Text(
                    text = "Saving as ${if (plan.audioOnly) "Audio" else "Video"}",
                    color = Accent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    softWrap = false,
                )
                Text(
                    text = "·",
                    color = Dim,
                    fontSize = 12.sp,
                )
                Text(
                    text = displayTitle,
                    color = Ink,
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier
                        .size(26.dp)
                        .clip(CircleShape)
                        .semantics { contentDescription = "Dismiss saving banner" }
                        .clickable { model.dismissAutoAcquireBanner() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = CloseIcon,
                        contentDescription = null,
                        tint = Dim,
                        modifier = Modifier.size(15.dp),
                    )
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(GlassBg)
                        .border(0.75.dp, GlassBorder, PillShape)
                        .clickable { model.flipAutoAcquireFormat() }
                        .padding(horizontal = 11.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "Flip to ${if (plan.audioOnly) "Video" else "Audio"}",
                        color = Ink,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                }
                Box(
                    modifier = Modifier
                        .clip(PillShape)
                        .background(GlassBg)
                        .border(0.75.dp, GlassBorder, PillShape)
                        .clickable { model.editAutoAcquire() }
                        .padding(horizontal = 11.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "Edit",
                        color = Ink,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}
