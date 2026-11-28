package com.peartube.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AcquireJob
import com.peartube.app.AppModel
import com.peartube.app.DetectedMediaKind
import com.peartube.app.ShareImportMode
import com.peartube.app.classifyLinkAcquisition
import com.peartube.app.parsePeartubeAddUrl
import com.peartube.shared.QrCodeView
import com.peartube.shared.clock
import com.peartube.shared.formatBytes

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnderTheHoodSheet(
    model: AppModel,
    onClose: () -> Unit,
    onOpenNetwork: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenAdd: () -> Unit = {
        onClose()
        model.openAddSheet()
    },
    onOpenTvs: () -> Unit = {
        onClose()
        model.openCastSheet()
    },
) {
    val status by model.status.collectAsState()
    val identity by model.identity.collectAsState()
    val cast by model.cast.collectAsState()
    val castReconnecting by model.castReconnecting.collectAsState()
    val lastCastSession by model.lastCastSession.collectAsState()
    val acquireJobs by model.acquireJobs.collectAsState()
    val downloads by model.downloads.collectAsState()
    val copyText = rememberCopyText()
    var share by remember { mutableStateOf(false) }
    val peers = status?.routes?.totalPeers ?: status?.let { it.peers + it.lanPeers } ?: 0L
    val activeTransfers = acquireJobs.count { it.isActive } + downloads.size
    val activeCast = cast.session ?: lastCastSession.takeIf { castReconnecting }
    val casting = activeCast != null

    ModalBottomSheet(
        onDismissRequest = onClose,
        containerColor = CardBg,
        scrimColor = Bg.copy(alpha = 0.78f),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.statusBarsPadding(),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PearlOrb(size = 28.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "Pearl Node",
                        color = Ink,
                        fontSize = 21.sp,
                        fontFamily = FontFamily.SansSerif,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.6).sp,
                    )
                    Text(
                        text = when {
                            (status?.lanPeers ?: 0L) > 0L -> "Local network discovery active · $peers peers"
                            peers > 0L -> "Connected to $peers peers"
                            else -> "Looking for peers…"
                        },
                        color = if (peers > 0L) Accent else Warn,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
                CinemaIcon(CloseIcon, "Close Pearl Node", Ink, onClick = onClose)
            }

            // Spatial obsidian-glass Quick Action tiles (1 tap to every node control)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    NodeQuickActionTile(
                        icon = GlobeIcon,
                        title = "Network & Swarm",
                        subtitle = if (peers > 0L) "$peers peers" else "Idle",
                        accent = if (peers > 0L) Accent else Dim,
                        onClick = onOpenNetwork,
                        modifier = Modifier.weight(1f),
                    )
                    NodeQuickActionTile(
                        icon = DownloadIcon,
                        title = "Activity",
                        subtitle = if (activeTransfers > 0) "$activeTransfers running" else "Queue empty",
                        accent = if (activeTransfers > 0) BrandHover else Dim,
                        onClick = onOpenAdd,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    NodeQuickActionTile(
                        icon = AddIcon,
                        title = "Add Link / File",
                        subtitle = "URL, QR, or key",
                        accent = Pearl,
                        onClick = onOpenAdd,
                        modifier = Modifier.weight(1f),
                    )
                    NodeQuickActionTile(
                        icon = TvIcon,
                        title = "Cast to TV",
                        subtitle = when {
                            cast.session != null -> cast.session?.receiverName.orEmpty().ifBlank { "Casting" }
                            castReconnecting && activeCast != null -> "Reconnecting…"
                            else -> "Nearby TVs"
                        },
                        accent = if (casting) Accent else Dim,
                        onClick = onOpenTvs,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(CardShape)
                        .background(CardElevated)
                        .border(1.dp, GlassBorder, CardShape)
                        .clickable(onClick = onOpenSettings)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(SettingsIcon, null, tint = Pearl, modifier = Modifier.size(20.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Settings", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text("Channels, Soulseek, routing, storage", color = Dim, fontSize = 12.sp)
                    }
                    Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                }
            }

            // Single calm rounded obsidian card for Your Channel + Storage summary
            val channel = status?.channel.orEmpty()
            val passUri = identity?.accessUri.orEmpty()
            val savedCache = status?.cachedBytes ?: 0L
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(CardShape)
                    .background(CardElevated)
                    .border(1.dp, GlassBorder, CardShape)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = "Your Channel",
                            color = Ink,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = if (channel.isNotBlank()) "${channel.take(12)}…" else "Starting node…",
                            color = Dim,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (channel.isNotBlank()) {
                        Row(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(if (share) Pearl else GlassBg)
                                .then(
                                    if (share) Modifier else Modifier.border(0.75.dp, GlassBorder, PillShape),
                                )
                                .clickable { share = !share }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            Icon(
                                imageVector = ShareIcon,
                                contentDescription = null,
                                tint = if (share) PearlInk else Ink,
                                modifier = Modifier.size(14.dp),
                            )
                            Text(
                                text = "Share",
                                color = if (share) PearlInk else Ink,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                    if (passUri.isNotBlank()) {
                        Box(
                            modifier = Modifier
                                .clip(PillShape)
                                .background(GlassBg)
                                .border(0.75.dp, GlassBorder, PillShape)
                                .clickable {
                                    copyText(passUri)
                                    model.notice.value = "Subscriber pass copied"
                                }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "Copy pass",
                                color = Ink,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }

                if (channel.isNotBlank()) {
                    AnimatedVisibility(share) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        ) {
                            QrCodeView("peartube://channel/$channel", Modifier.size(200.dp))
                            Box(
                                modifier = Modifier
                                    .clip(PillShape)
                                    .background(Pearl)
                                    .clickable {
                                        copyText("peartube://channel/$channel")
                                        model.notice.value = "Channel link copied"
                                    }
                                    .padding(horizontal = 16.dp, vertical = 8.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "Copy channel link",
                                    color = PearlInk,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                        }
                    }
                }

                HorizontalDivider(color = Line.copy(alpha = 0.55f))

                Text(
                    text = if (savedCache > 0L) "Storage · ${formatBytes(savedCache)} cached" else "Storage · No cached files",
                    color = Dim,
                    fontSize = 12.sp,
                )
            }
        }
    }
}

@Composable
private fun NodeQuickActionTile(
    icon: ImageVector,
    title: String,
    subtitle: String,
    accent: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(CardShape)
            .background(CardElevated)
            .border(1.dp, GlassBorder, CardShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(GlassBg)
                    .border(1.dp, GlassBorder, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, null, tint = accent, modifier = Modifier.size(16.dp))
            }
            Text(
                text = title,
                color = Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = subtitle,
            color = Dim,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddToLibrarySheet(
    model: AppModel,
    onClose: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val sheet by model.addSheet.collectAsState()
    val jobs by model.acquireJobs.collectAsState()
    val podcastFormat by model.podcastImportFormat.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    var discardPrompt by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        model.refreshAcquireJobs()
    }

    val trimmed = sheet.rawInput.trim()
    val unwrappedHttp = parsePeartubeAddUrl(trimmed)
        ?: trimmed.takeIf { it.startsWith("http://", ignoreCase = true) || it.startsWith("https://", ignoreCase = true) }
    val isWebUrl = unwrappedHttp != null

    fun requestClose() {
        if (sheet.rawInput.isNotBlank() && !sheet.submitting) {
            discardPrompt = true
        } else {
            onClose()
        }
    }

    fun submit() {
        if (trimmed.isEmpty()) return
        val targetUrl = unwrappedHttp
        if (targetUrl != null) {
            if (sheet.identified != null) {
                model.submitAcquireFromSheet()
            } else {
                model.identifyUrl(targetUrl)
            }
        } else {
            model.openUriOrKey(trimmed)
            model.closeAddSheet(clearInput = true)
        }
    }

    ModalBottomSheet(
        onDismissRequest = ::requestClose,
        containerColor = CardBg,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.statusBarsPadding(),
    ) {
        if (scanner) {
            QrScannerView(
                onScanned = {
                    scanner = false
                    if (it.startsWith("peartube:", true) || it.startsWith("http://", true) || it.startsWith("https://", true)) {
                        model.handleSharedText(it)
                        val isWebTarget = it.startsWith("http", true) || parsePeartubeAddUrl(it) != null
                        if (!isWebTarget || model.shareImportMode.value == ShareImportMode.Auto) {
                            model.closeAddSheet(clearInput = true)
                        }
                    } else {
                        model.pairCastByUriOrHost(it)
                        model.closeAddSheet(clearInput = true)
                    }
                },
                onClose = { scanner = false },
            )
        } else {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Add to library", color = Ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    CinemaIcon(CloseIcon, "Close", Ink, onClick = ::requestClose)
                }
                Text("Paste a SoundCloud, YouTube, Rumble, media URL, or peartube:// link", color = Dim, fontSize = 13.sp)
                OutlinedTextField(
                    value = sheet.rawInput,
                    onValueChange = model::updateAddInput,
                    singleLine = true,
                    placeholder = { Text("https://… or peartube://channel/…", fontSize = 14.sp) },
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    shape = ControlShape,
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    PrimaryLightButton(
                        text = when {
                            isWebUrl && sheet.identifying -> "Identifying…"
                            isWebUrl && sheet.identified == null -> "Identify"
                            isWebUrl && sheet.submitting -> "Saving…"
                            isWebUrl -> "Save to library"
                            else -> "Add"
                        },
                        onClick = ::submit,
                        enabled = trimmed.isNotBlank() && !sheet.identifying && !sheet.submitting,
                        modifier = Modifier.weight(1f),
                    )
                    QuietActionButton(
                        text = "Scan QR",
                        icon = QrCodeScannerIcon,
                        onClick = { scanner = true },
                    )
                }

                if (sheet.identifying) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardElevated)
                            .border(1.dp, Line, CardShape)
                            .padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(
                            color = Brand,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
                        )
                        Text("Inspecting link with ubit…", color = Dim, fontSize = 13.sp)
                    }
                }

                sheet.identifyError?.let { errMsg ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(Danger.copy(alpha = 0.12f))
                            .border(1.dp, Danger.copy(alpha = 0.45f), CardShape)
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(errMsg, color = Ink, fontSize = 13.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            QuietActionButton(
                                text = "Retry",
                                onClick = { if (unwrappedHttp != null) model.identifyUrl(unwrappedHttp) },
                            )
                        }
                    }
                }

                sheet.identified?.let { info ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(CardShape)
                            .background(CardElevated)
                            .border(1.dp, Line, CardShape)
                            .padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val badge = info.site.ifBlank { if (info.isPage) "Web page" else "Direct file" }
                            Box(
                                Modifier
                                    .clip(PillShape)
                                    .background(Brand.copy(alpha = 0.2f))
                                    .padding(horizontal = 10.dp, vertical = 3.dp),
                            ) {
                                Text(badge, color = BrandRing, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            }
                            val detected = sheet.detectedKind
                                ?: classifyLinkAcquisition(unwrappedHttp ?: trimmed, info, podcastFormat).kind
                            val (kindBg, kindFg) = when (detected) {
                                DetectedMediaKind.Music -> Accent.copy(alpha = 0.16f) to Accent
                                DetectedMediaKind.Podcast -> Warn.copy(alpha = 0.16f) to Warn
                                DetectedMediaKind.Video -> GlassBg to Ink
                            }
                            Box(
                                Modifier
                                    .clip(PillShape)
                                    .background(kindBg)
                                    .border(0.75.dp, GlassBorder, PillShape)
                                    .padding(horizontal = 9.dp, vertical = 3.dp),
                            ) {
                                Text(detected.label, color = kindFg, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            }
                            val facts = buildList {
                                info.durationSec?.let { add(clock(it * 1000L)) }
                                if (info.resolution.isNotBlank()) add(info.resolution)
                                info.size?.let { add(formatBytes(it)) }
                            }.joinToString(" · ")
                            if (facts.isNotBlank()) {
                                Text(facts, color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }

                        if (info.author.isNotBlank()) {
                            Text("By ${info.author}", color = Dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }

                        info.match?.let { m ->
                            Text("Matched: ${m.title} (${m.id})", color = Accent, fontSize = 12.sp)
                        }

                        OutlinedTextField(
                            value = sheet.titleInput,
                            onValueChange = model::updateAddTitle,
                            singleLine = true,
                            label = { Text("Title") },
                            shape = ControlShape,
                            colors = fieldColors(),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        OutlinedTextField(
                            value = sheet.artistInput,
                            onValueChange = model::updateAddArtist,
                            singleLine = true,
                            label = { Text("Artist or channel") },
                            shape = ControlShape,
                            colors = fieldColors(),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Row(
                            Modifier
                                .fillMaxWidth()
                                .toggleable(
                                    value = sheet.audioOnly,
                                    role = Role.Switch,
                                    onValueChange = model::updateAddAudioOnly,
                                )
                                .padding(vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("Audio only", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                Text(
                                    if (sheet.audioOnly) "Saves into Library → Music" else "Saves video into Library",
                                    color = Dim,
                                    fontSize = 12.sp,
                                )
                            }
                            Switch(
                                checked = sheet.audioOnly,
                                onCheckedChange = null,
                                colors = SwitchDefaults.colors(checkedTrackColor = Brand),
                            )
                        }

                        sheet.submitError?.let { err ->
                            Text(err, color = Danger, fontSize = 12.sp)
                        }

                        val directStreamUrl = unwrappedHttp.takeIf { sheet.audioOnly && !info.isPage }
                        if (directStreamUrl != null) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                HeroGlassButton(
                                    text = "Stream",
                                    icon = PlayIcon,
                                    shape = PillShape,
                                    onClick = {
                                        val streamTitle = sheet.titleInput.trim()
                                            .ifBlank { info.effectiveTitle }
                                            .ifBlank { "Audio stream" }
                                        val streamArtist = sheet.artistInput.trim()
                                            .ifBlank { info.effectiveArtist }
                                        model.streamExternalTrack(
                                            id = info.effectiveId.ifBlank { directStreamUrl },
                                            title = streamTitle,
                                            artist = streamArtist,
                                            streamUrl = directStreamUrl,
                                            sourceLabel = "Streaming · ubit",
                                            saveUrl = directStreamUrl,
                                            saveKind = "url",
                                        )
                                        model.closeAddSheet(clearInput = true)
                                    },
                                )
                                PrimaryLightButton(
                                    text = if (sheet.submitting) "Starting download…" else "Save to library",
                                    icon = DownloadIcon,
                                    enabled = !sheet.submitting,
                                    onClick = model::submitAcquireFromSheet,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        } else {
                            PrimaryLightButton(
                                text = if (sheet.submitting) "Starting download…" else "Save to library",
                                icon = DownloadIcon,
                                enabled = !sheet.submitting,
                                onClick = model::submitAcquireFromSheet,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                if (jobs.isNotEmpty()) {
                    HorizontalDivider(color = Line)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Adding", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        val active = jobs.count { it.isActive }
                        if (active > 0) {
                            Text("$active running", color = BrandRing, fontSize = 12.sp)
                        }
                    }
                    jobs.forEach { job ->
                        AcquireJobCard(
                            job = job,
                            onAction = { model.cancelOrDismissJob(job.jobId) },
                            onRetry = if (job.isFailed && (job.retryable || job.plugin.equals("soulseek", ignoreCase = true))) {
                                { model.retryJob(job.jobId) }
                            } else {
                                null
                            },
                        )
                    }
                }

                HorizontalDivider(color = Line)
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(CardShape)
                        .background(CardElevated)
                        .clickable {
                            model.closeAddSheet(clearInput = true)
                            onOpenSettings()
                        }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Channel settings", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text("Follow multiple channels or link an account", color = Dim, fontSize = 12.sp)
                    }
                    Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(20.dp))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { model.closeAddSheet(clearInput = true) }) {
                        Text("Close", color = Dim)
                    }
                }
            }
        }
    }

    if (discardPrompt) {
        AlertDialog(
            onDismissRequest = { discardPrompt = false },
            containerColor = CardElevated,
            title = { Text("Discard what you typed?", color = Ink) },
            confirmButton = {
                TextButton(onClick = { discardPrompt = false; model.closeAddSheet(clearInput = true) }) {
                    Text("Discard", color = Danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { discardPrompt = false }) {
                    Text("Keep editing", color = Ink)
                }
            },
        )
    }
}

@Composable
private fun AcquireJobCard(
    job: AcquireJob,
    onAction: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardElevated)
            .border(1.dp, Line, CardShape)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = job.title.ifBlank { job.id.ifBlank { "Item" } },
                    color = Ink,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val statusColor = when {
                    job.isFailed -> Danger
                    job.isDone -> Accent
                    job.isActive -> BrandRing
                    else -> Dim
                }
                val meta = listOfNotNull(
                    job.plugin.takeIf { it.isNotBlank() }?.replaceFirstChar { it.uppercase() },
                    job.peer?.takeIf { it.isNotBlank() },
                    job.statusLabel(),
                ).joinToString(" · ")
                Text(meta, color = statusColor, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val note = job.note?.takeIf { it.isNotBlank() }
                if (note != null) {
                    Text(note, color = Dim, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (onRetry != null) {
                TextButton(onClick = onRetry) {
                    Text("Retry", color = BrandRing, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            TextButton(onClick = onAction) {
                Text(
                    text = if (job.isActive) "Cancel" else "Dismiss",
                    color = if (job.isActive) Danger else Dim,
                    fontSize = 13.sp,
                )
            }
        }
        if (job.isActive) {
            val frac = job.progressFraction
            if (frac != null) {
                LinearProgressIndicator(
                    progress = { frac },
                    color = Brand,
                    trackColor = Line,
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                )
            } else {
                LinearProgressIndicator(
                    color = Brand,
                    trackColor = Line,
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                )
            }
        }
    }
}
