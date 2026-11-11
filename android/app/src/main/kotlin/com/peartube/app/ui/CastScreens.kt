package com.peartube.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import kotlinx.coroutines.delay
import org.json.JSONObject
import com.peartube.shared.clock

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CastSheetScreen(model: AppModel) {
    val cast by model.cast.collectAsState()
    val pending by model.pendingCast.collectAsState()
    var scanner by remember { mutableStateOf(false) }
    val title = pending?.title
    LaunchedEffect(Unit) {
        while (true) {
            model.refreshCast()
            delay(3000)
        }
    }
    ModalBottomSheet(onDismissRequest = model::cancelCast, containerColor = CardBg) {
        if (scanner) {
            QrScannerView(onScanned = {
                scanner = false
                model.pairCastByUriOrHost(it)
            }, onClose = { scanner = false })
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().navigationBarsPadding(),
                contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(title?.let { "Play \"$it\" on…" } ?: "Your cinema, any screen.", color = Ink, fontSize = 23.sp,
                            fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        CinemaIcon(CloseIcon, "Close Cast") { model.cancelCast() }
                    }
                }
                item { Text("Nearby Screens", color = Dim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
                if (cast.receivers.isEmpty()) item {
                    Text("Looking for PearTube TV Receivers on your Wi-Fi…", color = Dim, fontSize = 14.sp)
                }
                items(cast.receivers, key = { it.id }) { receiver ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(CardElevated)
                            .clickable(enabled = receiver.current) { model.selectCastReceiver(receiver) }.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Icon(TvIcon, null, tint = Brand, modifier = Modifier.size(28.dp))
                        Column(Modifier.weight(1f)) {
                            Text(receiver.name, color = Ink, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                            Text(
                                if (!receiver.current) "Needs update" else if (receiver.online) "Ready to play" else "Saved screen",
                                color = Dim,
                                fontSize = 12.sp,
                            )
                        }
                        if (!receiver.online && receiver.paired) {
                            CinemaIcon(CloseIcon, "Forget ${receiver.name}") { model.removeCastReceiver(receiver.id) }
                        } else Icon(ChevronRightIcon, null, tint = Dim)
                    }
                }
                item {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Brand.copy(alpha = .14f))
                            .clickable { scanner = true }.padding(20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Icon(QrCodeScannerIcon, null, tint = Brand, modifier = Modifier.size(30.dp))
                        Column {
                            Text("Scan TV QR Code", color = Ink, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                            Text("Point your phone. Meet your screen.", color = Dim, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CastRemoteBar(model: AppModel) {
    val cast by model.cast.collectAsState()
    val session = cast.session ?: return
    val state = session.state
    var expanded by remember { mutableStateOf(false) }
    var scrub by remember { mutableStateOf<Float?>(null) }
    val title = state.entry?.title?.ifBlank { session.receiverName } ?: session.receiverName
    val duration = state.durationMs ?: 0L
    fun control(action: String) { model.sendCastControl(JSONObject().put("action", action)) }
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(28.dp)).background(CardElevated).clickable { expanded = true }
            .padding(start = 18.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(CastConnectedIcon, null, tint = Brand, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(title, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val peerSub = when (state.mode) {
                "private-p2p" -> "${session.receiverName} · Private P2P (${state.p2pPeers} peers)"
                "p2p" -> "${session.receiverName} · P2P Seeding (${state.p2pPeers} peers)"
                else -> session.receiverName
            }
            Text(peerSub, color = Dim, fontSize = 11.sp, maxLines = 1)
        }
        CinemaIcon(if (state.playing) PauseIcon else PlayIcon, if (state.playing) "Pause on TV" else "Play on TV", Brand) { control("togglePlay") }
    }
    if (expanded) ModalBottomSheet(onDismissRequest = { expanded = false }, containerColor = CardBg) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Now playing on ${session.receiverName}", color = Dim, modifier = Modifier.weight(1f))
                CinemaIcon(CloseIcon, "Close remote") { expanded = false }
            }
            Text(title, color = Ink, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            state.error?.let { Text(it, color = Danger) }
            Slider(
                value = scrub ?: state.positionMs.toFloat(),
                onValueChange = { scrub = it },
                valueRange = 0f..duration.coerceAtLeast(1L).toFloat(),
                enabled = duration > 0,
                onValueChangeFinished = {
                    scrub?.let { model.sendCastControl(JSONObject().put("action", "seek").put("positionMs", it.toLong())) }
                    scrub = null
                },
            )
            Text("${clock((scrub?.toLong() ?: state.positionMs))} / ${clock(duration)}", color = Dim, fontSize = 12.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { model.sendCastControl(JSONObject().put("action", "skip").put("deltaMs", -10_000)) }) { Text("-10s", color = Ink) }
                CinemaIcon(if (state.playing) PauseIcon else PlayIcon, if (state.playing) "Pause" else "Play", Brand) { control("togglePlay") }
                TextButton(onClick = { model.sendCastControl(JSONObject().put("action", "skip").put("deltaMs", 10_000)) }) { Text("+10s", color = Ink) }
            }
            TextButton(onClick = { expanded = false; model.switchCastToPhone() }) { Text("Switch to This Phone", color = Brand) }
            TextButton(onClick = { expanded = false; model.detachCasting() }) { Text("Leave Playing on TV (Detach)", color = Ink) }
            TextButton(onClick = { expanded = false; model.stopCasting() }) { Text("Stop Casting", color = Danger) }
        }
    }
}
