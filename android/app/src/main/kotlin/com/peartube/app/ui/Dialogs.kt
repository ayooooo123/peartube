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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AcquireJob
import com.peartube.app.AppModel
import com.peartube.app.p2pSummary
import com.peartube.app.parsePeartubeAddUrl
import com.peartube.shared.QrCodeView
import com.peartube.shared.clock
import com.peartube.shared.formatBytes

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UnderTheHoodSheet(
    model: AppModel,
    onClose: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val status by model.status.collectAsState()
    val identity by model.identity.collectAsState()
    val settings by model.settings.collectAsState()
    val copyText = rememberCopyText()
    var engine by remember { mutableStateOf(false) }
    var share by remember { mutableStateOf(false) }
    val peers = status?.let { it.peers + it.lanPeers } ?: 0L

    ModalBottomSheet(
        onDismissRequest = onClose,
        containerColor = CardBg,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Under the Hood", color = Ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                CinemaIcon(CloseIcon, "Close Under the Hood", Ink, onClick = onClose)
            }
            Text(
                if ((status?.lanPeers ?: 0) > 0) "Local network discovery active"
                else if (peers > 0) "Connected to $peers peers"
                else "Looking for peers…",
                color = Accent,
                fontSize = 14.sp,
            )
            HorizontalDivider(color = Line)
            Text("Channels", color = Ink, fontWeight = FontWeight.SemiBold)
            val sources = status?.sources.orEmpty()
            if (sources.isNotEmpty()) {
                sources.forEach { Text(it.alias.ifBlank { "Channel ${it.key.take(8)}" }, color = Dim) }
            } else {
                if (settings.tracker.isNotEmpty()) Text("Primary channel", color = Dim)
                settings.sources.forEach { Text(it.alias.ifBlank { "Channel ${it.key.take(8)}" }, color = Dim) }
            }
            status?.discoveredSources.orEmpty().forEach { found ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(found.title, color = Ink, modifier = Modifier.weight(1f))
                    TextButton(onClick = { model.subscribeDiscovered(found) }) { Text("Follow", color = Brand) }
                }
            }
            TextButton(onClick = onOpenSettings) {
                Icon(AddIcon, null, tint = Brand, modifier = Modifier.size(18.dp))
                Text("Add to library", color = Brand, modifier = Modifier.padding(start = 6.dp))
            }
            status?.channel?.takeIf { it.isNotBlank() }?.let { channel ->
                TextButton(onClick = { share = !share }) {
                    Icon(ShareIcon, null, tint = Brand, modifier = Modifier.size(18.dp))
                    Text("Share My Channel", color = Brand, modifier = Modifier.padding(start = 6.dp))
                }
                AnimatedVisibility(share) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                        QrCodeView("peartube://channel/$channel", Modifier.size(220.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { copyText("peartube://channel/$channel") }) {
                                Text("Copy link", color = Brand)
                            }
                            status?.writer?.takeIf { it.isNotBlank() }?.let { wKey ->
                                TextButton(onClick = { copyText(wKey) }) {
                                    Text("Copy device key", color = Dim)
                                }
                            }
                        }
                    }
                }
                if (identity?.mnemonicSet == true) {
                    TextButton(onClick = { model.copyRecoveryPhrase { copyText(it) } }) {
                        Text("Copy 12-word recovery phrase", color = Brand)
                    }
                }
                identity?.accessUri?.takeIf { it.isNotBlank() }?.let { passUri ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Subscriber pass · Epoch ${identity?.epoch ?: 1L}", color = Dim, modifier = Modifier.weight(1f), fontSize = 13.sp)
                        TextButton(onClick = { copyText(passUri) }) { Text("Copy pass", color = Brand) }
                        TextButton(onClick = { model.rotateSubscriberPass() }) { Text("Rotate", color = Dim) }
                    }
                }
                val linkedWriters = identity?.writers.orEmpty()
                if (linkedWriters.size > 1) {
                    linkedWriters.forEach { w ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "${w.alias.ifBlank { w.key.take(8) }}${if (w.selfDevice) " (this phone)" else " · ${w.role}"}",
                                color = Dim,
                                fontSize = 13.sp,
                                modifier = Modifier.weight(1f),
                            )
                            if (w.key != channel) {
                                TextButton(onClick = { model.revokeLinkedWriter(w.key) }) { Text("Remove", color = Danger) }
                            }
                        }
                    }
                }
            }
            HorizontalDivider(color = Line)
            val savedCache = status?.cachedBytes ?: 0L
            Text(
                if (savedCache > 0L) "Storage · ${formatBytes(savedCache)} cached" else "Storage · No cached files",
                color = Dim,
            )
            TextButton(onClick = { model.clearCache() }) {
                Icon(DeleteSweepIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                Text(
                    if (savedCache > 0L) "Free up cache" else "Compact storage cache",
                    color = Ink,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            HorizontalDivider(color = Line)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { engine = !engine }
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Engine Room", color = Dim, modifier = Modifier.weight(1f))
                Icon(if (engine) ChevronDownIcon else ChevronRightIcon, null, tint = Dim)
            }
            AnimatedVisibility(engine) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("$peers peers · ${sources.size} sources · ${formatBytes(status?.blobBytes ?: 0L)}", color = Dim, fontSize = 12.sp)
                    status?.lan?.let { Text("LAN $it", color = Dim, fontSize = 12.sp) }
                    p2pSummary(status)?.let { Text(it, color = Brand, fontSize = 12.sp) }
                }
            }
        }
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
    ) {
        if (scanner) {
            QrScannerView(
                onScanned = {
                    scanner = false
                    if (it.startsWith("peartube:", true) || it.startsWith("http://", true) || it.startsWith("https://", true)) {
                        model.handleSharedText(it)
                        if (!it.startsWith("http", true) && parsePeartubeAddUrl(it) == null) {
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
                            val facts = buildList {
                                info.durationSec?.let { add(clock(it * 1000L)) }
                                if (info.resolution.isNotBlank()) add(info.resolution)
                                info.size?.let { add(formatBytes(it)) }
                            }.joinToString(" · ")
                            if (facts.isNotBlank()) {
                                Text(facts, color = Dim, fontSize = 12.sp)
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
                                    if (sheet.audioOnly) "Saves into Listen as audio" else "Saves video into Watch",
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

                        PrimaryLightButton(
                            text = if (sheet.submitting) "Starting download…" else "Save to library",
                            icon = DownloadIcon,
                            enabled = !sheet.submitting,
                            onClick = model::submitAcquireFromSheet,
                            modifier = Modifier.fillMaxWidth(),
                        )
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
