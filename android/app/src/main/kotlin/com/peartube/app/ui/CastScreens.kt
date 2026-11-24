package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.CastReceiver
import com.peartube.shared.clock
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * TVs dialog (replaces old Cast page): active TV remote + Stop, paired/nearby TVs with actionable
 * states (Ready, Playing, Needs its code, Needs an update), Forget confirmation, and Pair a TV.
 * Never shows a TV's network address.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TvsDialog(model: AppModel) {
    val cast by model.cast.collectAsState()
    val pending by model.pendingCast.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    var pairCode by remember { mutableStateOf("") }
    var forgetTarget by remember { mutableStateOf<CastReceiver?>(null) }
    var discardPrompt by remember { mutableStateOf(false) }
    var scrub by remember { mutableStateOf<Float?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            model.refreshCast()
            delay(3_000)
        }
    }

    fun requestClose() {
        if (pairCode.isNotBlank()) discardPrompt = true else model.cancelCast()
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
                    model.pairCastByUriOrHost(it)
                },
                onClose = { scanner = false },
            )
        } else {
            val session = cast.session
            LazyColumn(
                modifier = Modifier.fillMaxWidth().navigationBarsPadding(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = pending?.let { "Play on a TV" } ?: "TVs",
                            color = Ink,
                            fontSize = 22.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        CinemaIcon(CloseIcon, "Close TVs", Ink) { requestClose() }
                    }
                    pending?.let {
                        Text(
                            text = it.title,
                            color = Dim,
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }

                if (pending != null) {
                    item {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardElevated)
                                .border(1.dp, Line, CardShape)
                                .clickable { model.playPendingOnThisPhone() }
                                .padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(PlayIcon, null, tint = Ink, modifier = Modifier.size(22.dp))
                            Text("This phone", color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                            Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                        }
                    }
                }

                if (session != null) {
                    val state = session.state
                    val duration = state.durationMs ?: 0L
                    val title = state.entry?.title?.ifBlank { session.receiverName } ?: session.receiverName
                    item {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardElevated)
                                .border(1.dp, Line, CardShape)
                                .padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text("Playing on ${session.receiverName}", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                                    Text(title, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                TextButton(onClick = { model.stopCasting() }) {
                                    Text("Stop", color = Danger, fontWeight = FontWeight.SemiBold)
                                }
                            }
                            state.error?.let { Text(it, color = Danger, fontSize = 13.sp) }
                            Slider(
                                value = scrub ?: state.positionMs.toFloat(),
                                onValueChange = { scrub = it },
                                valueRange = 0f..duration.coerceAtLeast(1L).toFloat(),
                                enabled = duration > 0,
                                colors = SliderDefaults.colors(
                                    thumbColor = Brand,
                                    activeTrackColor = Brand,
                                    inactiveTrackColor = Line,
                                ),
                                onValueChangeFinished = {
                                    scrub?.let { model.sendCastControl(JSONObject().put("action", "seek").put("positionMs", it.toLong())) }
                                    scrub = null
                                },
                            )
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(clock(scrub?.toLong() ?: state.positionMs), color = Dim, fontSize = 12.sp)
                                Text(clock(duration), color = Dim, fontSize = 12.sp)
                            }
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                TextButton(onClick = { model.sendCastControl(JSONObject().put("action", "skip").put("deltaMs", -10_000)) }) {
                                    Text("-10 s", color = Ink)
                                }
                                CinemaIcon(
                                    icon = if (state.playing) PauseIcon else PlayIcon,
                                    description = if (state.playing) "Pause" else "Play",
                                    tint = Ink,
                                ) {
                                    model.sendCastControl(JSONObject().put("action", "togglePlay"))
                                }
                                TextButton(onClick = { model.sendCastControl(JSONObject().put("action", "skip").put("deltaMs", 10_000)) }) {
                                    Text("+10 s", color = Ink)
                                }
                            }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                TextButton(onClick = { model.switchCastToPhone() }) {
                                    Text("Play on this phone", color = Brand)
                                }
                                TextButton(onClick = { model.detachCasting() }) {
                                    Text("Leave playing", color = Dim)
                                }
                            }
                        }
                    }
                }

                if (cast.receivers.isEmpty()) {
                    item {
                        Text("No TVs found on this network yet.", color = Dim, fontSize = 14.sp)
                    }
                } else {
                    items(cast.receivers, key = { it.id }) { receiver ->
                        val isPlayingHere = session?.receiverId == receiver.id
                        val statusText = when {
                            !receiver.current -> "Needs an update"
                            isPlayingHere -> "Playing"
                            !receiver.paired && receiver.auth != "open" -> "Needs its code"
                            else -> "Ready"
                        }
                        val statusColor = when (statusText) {
                            "Playing" -> Accent
                            "Needs an update" -> Danger
                            "Needs its code" -> Warn
                            else -> Dim
                        }
                        val canSelect = receiver.current && (receiver.paired || receiver.auth == "open")
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(CardShape)
                                .background(CardElevated)
                                .border(1.dp, if (isPlayingHere) Accent.copy(alpha = 0.4f) else Line, CardShape)
                                .clickable(enabled = canSelect) { model.selectCastReceiver(receiver) }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Icon(TvIcon, null, tint = if (isPlayingHere) Accent else Ink, modifier = Modifier.size(24.dp))
                            Column(Modifier.weight(1f)) {
                                Text(receiver.name, color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(statusText, color = statusColor, fontSize = 12.sp)
                            }
                            if (receiver.paired) {
                                TextButton(onClick = { forgetTarget = receiver }) {
                                    Text("Forget", color = Dim, fontSize = 13.sp)
                                }
                            } else if (canSelect) {
                                Icon(ChevronRightIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }

                item { HorizontalDivider(color = Line) }

                item {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Pair a TV…", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text("Code on the TV", color = Dim, fontSize = 13.sp)
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OutlinedTextField(
                                value = pairCode,
                                onValueChange = { pairCode = it.uppercase().take(12) },
                                singleLine = true,
                                placeholder = { Text("K7M2QX", fontSize = 14.sp) },
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.Characters,
                                    autoCorrectEnabled = false,
                                    imeAction = ImeAction.Done,
                                ),
                                keyboardActions = KeyboardActions(onDone = {
                                    if (pairCode.isNotBlank()) {
                                        model.pairCastByCodeAuto(pairCode)
                                        pairCode = ""
                                    }
                                }),
                                shape = ControlShape,
                                colors = fieldColors(),
                                modifier = Modifier.weight(1f),
                            )
                            PrimaryLightButton(
                                text = "Pair",
                                enabled = pairCode.isNotBlank(),
                                onClick = {
                                    model.pairCastByCodeAuto(pairCode)
                                    pairCode = ""
                                },
                            )
                        }
                        QuietActionButton(
                            text = "Scan TV QR code",
                            icon = QrCodeScannerIcon,
                            onClick = { scanner = true },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }

    forgetTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { forgetTarget = null },
            containerColor = CardElevated,
            title = { Text("Forget ${target.name}?", color = Ink) },
            text = { Text("Pairing again needs the code on the TV.", color = Dim) },
            confirmButton = {
                TextButton(onClick = {
                    model.removeCastReceiver(target.id)
                    forgetTarget = null
                }) {
                    Text("Forget", color = Danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { forgetTarget = null }) {
                    Text("Cancel", color = Ink)
                }
            },
        )
    }

    if (discardPrompt) {
        AlertDialog(
            onDismissRequest = { discardPrompt = false },
            containerColor = CardElevated,
            title = { Text("Discard what you typed?", color = Ink) },
            confirmButton = {
                TextButton(onClick = {
                    discardPrompt = false
                    pairCode = ""
                    model.cancelCast()
                }) {
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
fun CastRemoteBar(model: AppModel) {
    val cast by model.cast.collectAsState()
    val session = cast.session ?: return
    val state = session.state
    val title = state.entry?.title?.ifBlank { session.receiverName } ?: session.receiverName
    Row(
        Modifier
            .fillMaxWidth()
            .background(CardBg)
            .border(1.dp, Line)
            .clickable { model.openCastSheet() }
            .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(TvIcon, null, tint = Accent, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Playing on ${session.receiverName}", color = Accent, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        CinemaIcon(
            icon = if (state.playing) PauseIcon else PlayIcon,
            description = if (state.playing) "Pause" else "Play",
            tint = Ink,
        ) {
            model.sendCastControl(JSONObject().put("action", "togglePlay"))
        }
    }
}
