package com.peartube.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.RouteTraffic
import com.peartube.app.TrafficRoutes
import com.peartube.app.formatRate
import com.peartube.shared.formatBytes
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

private enum class NetworkMode(val label: String) {
    Globe("Globe"),
    Swarm("Swarm"),
    Flow("Flow"),
}

private data class RouteMeta(
    val label: String,
    val color: Color,
    val traffic: RouteTraffic,
)

private data class SpherePoint(val x: Float, val y: Float, val z: Float)

private fun routeSpeedRadPerSec(r: RouteTraffic): Float {
    val speed = (r.downBps + r.upBps).toFloat() / 4_200_000f
    return 0.07f + 0.85f * speed.coerceIn(0f, 1f)
}

@Composable
fun NetworkScreen(
    model: AppModel,
    onBack: () -> Unit,
) {
    val status by model.status.collectAsState()
    val settings by model.settings.collectAsState()
    val history by model.networkHistory.collectAsState()
    var mode by rememberSaveable { mutableStateOf(NetworkMode.Globe) }

    val context = LocalContext.current
    val reducedMotion = remember(context) {
        runCatching {
            android.provider.Settings.Global.getFloat(
                context.contentResolver,
                android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            ) == 0f
        }.getOrDefault(false)
    }

    val routes = status?.routes ?: TrafficRoutes.Empty
    val routeList = listOf(
        RouteMeta("Home network", Accent, routes.lan),
        RouteMeta("Internet", BrandHover, routes.publicRoute),
        RouteMeta("Private route", Warn, routes.privateRoute),
    )
    val latestRoutes by rememberUpdatedState(routeList)

    var spin by remember { mutableFloatStateOf(0.6f) }
    var turn0 by remember { mutableFloatStateOf(0.3f) }
    var turn1 by remember { mutableFloatStateOf(1.9f) }
    var turn2 by remember { mutableFloatStateOf(4.1f) }
    var dashPhase by remember { mutableFloatStateOf(0f) }

    LaunchedEffect(reducedMotion) {
        if (reducedMotion) return@LaunchedEffect
        var lastNanos = 0L
        while (true) {
            withFrameNanos { now ->
                if (lastNanos != 0L) {
                    val dt = ((now - lastNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
                    val cur = latestRoutes
                    spin += dt * 0.11f
                    turn0 += dt * routeSpeedRadPerSec(cur[0].traffic)
                    turn1 += dt * routeSpeedRadPerSec(cur[1].traffic)
                    turn2 += dt * routeSpeedRadPerSec(cur[2].traffic)
                    dashPhase = (dashPhase + dt * 34f) % 24f
                }
                lastNanos = now
            }
        }
    }

    // With reduced motion, step slightly only when fresh status arrives.
    LaunchedEffect(status, reducedMotion) {
        if (reducedMotion && status != null) {
            spin += 0.22f
            turn0 += 2f * routeSpeedRadPerSec(routeList[0].traffic)
            turn1 += 2f * routeSpeedRadPerSec(routeList[1].traffic)
            turn2 += 2f * routeSpeedRadPerSec(routeList[2].traffic)
        }
    }

    val totalPeers = routes.totalPeers
    val downBps = status?.downBps ?: 0L
    val upBps = status?.upBps ?: 0L
    val rxBytes = status?.rxBytes ?: 0L
    val txBytes = status?.txBytes ?: 0L
    val cachedBytes = status?.cachedBytes ?: 0L
    val cacheMaxBytes = status?.cacheMaxBytes?.takeIf { it > 0L }
        ?: (settings.cacheMaxGb.coerceAtLeast(1).toLong() * 1_000_000_000L)
    val ratio = status?.reciprocity?.ratio ?: 0.0

    val sceneDesc = remember(totalPeers, routes) {
        if (status == null) {
            "Connecting to peers"
        } else {
            val pluralPeers = if (totalPeers == 1L) "peer" else "peers"
            "$totalPeers $pluralPeers: ${routes.lan.peers} on home network, " +
                "${routes.publicRoute.peers} on internet, ${routes.privateRoute.peers} on private route"
        }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        DetailTopBar(title = "Network", onBack = onBack)

        // Segmented switcher: Globe / Swarm / Flow
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp)
                .clip(ControlShape)
                .background(CardBg)
                .border(1.dp, Line, ControlShape)
                .padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            NetworkMode.entries.forEach { item ->
                val selected = mode == item
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (selected) CardElevated else Color.Transparent)
                        .clickable { mode = item }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = item.label,
                        color = if (selected) Ink else Dim,
                        fontSize = 13.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    )
                }
            }
        }

        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item(key = "scene") {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(CardShape)
                        .background(CardBg)
                        .border(1.dp, Line, CardShape)
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(250.dp)
                            .semantics { contentDescription = sceneDesc },
                    ) {
                        when (mode) {
                            NetworkMode.Globe -> GlobeCanvas(
                                routes = routeList,
                                spin = { spin },
                                turns = { k -> when (k) { 0 -> turn0; 1 -> turn1; else -> turn2 } },
                                modifier = Modifier.fillMaxSize(),
                            )
                            NetworkMode.Swarm -> SwarmCanvas(
                                routes = routeList,
                                turns = { k -> when (k) { 0 -> turn0; 1 -> turn1; else -> turn2 } },
                                modifier = Modifier.fillMaxSize(),
                            )
                            NetworkMode.Flow -> FlowScene(
                                routes = routeList,
                                cachedBytes = cachedBytes,
                                cacheMaxBytes = cacheMaxBytes,
                                dashPhase = { dashPhase },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }

                    // Legend key
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        routeList.forEach { r ->
                            val active = r.traffic.peers > 0L
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                            ) {
                                Box(
                                    Modifier
                                        .size(7.dp)
                                        .clip(CircleShape)
                                        .background(if (active) r.color else Dim.copy(alpha = 0.4f)),
                                )
                                Text(
                                    text = "${r.label} · ${r.traffic.peers}",
                                    color = if (active) Ink else Dim,
                                    fontSize = 11.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }

                    val caption = when {
                        totalPeers == 0L -> "No peers now. Your library still plays from this device."
                        mode == NetworkMode.Flow -> "Width is speed."
                        else -> "Connections, not locations"
                    }
                    Text(
                        text = caption,
                        color = Dim,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            item(key = "rates") {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    RateSparkCard(
                        label = "Receiving",
                        rateText = formatRate(downBps),
                        samples = history.down,
                        accentColor = Accent,
                        modifier = Modifier.weight(1f),
                    )
                    RateSparkCard(
                        label = "Sharing",
                        rateText = formatRate(upBps),
                        samples = history.up,
                        accentColor = BrandHover,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            item(key = "reciprocity") {
                ReciprocityCard(rxBytes = rxBytes, txBytes = txBytes, ratio = ratio)
            }

            item(key = "routes") {
                RoutesCard(
                    routes = routeList,
                    cachedBytes = cachedBytes,
                    cacheMaxBytes = cacheMaxBytes,
                )
            }
        }
    }
}

@Composable
private fun GlobeCanvas(
    routes: List<RouteMeta>,
    spin: () -> Float,
    turns: (Int) -> Float,
    modifier: Modifier = Modifier,
) {
    val points = remember {
        List(380) { i ->
            val y = 1f - (i + 0.5f) / 190f
            val r = sqrt((1f - y * y).coerceAtLeast(0f))
            val a = i * 2.399963f
            SpherePoint(cos(a) * r, y, sin(a) * r)
        }
    }
    val rolls = remember { floatArrayOf(-0.20f, 0.13f, -0.34f) }
    val reaches = remember { floatArrayOf(1.42f, 1.86f, 2.30f) }

    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val cx = w * 0.5f
        val cy = h * 0.48f
        val radius = min(w, h * 1.25f) * 0.21f
        val squash = 0.36f
        val twoPi = (2.0 * PI).toFloat()

        fun orbitPos(k: Int, angle: Float): Triple<Float, Float, Boolean> {
            val x = cos(angle) * radius * reaches[k]
            val y = sin(angle) * radius * reaches[k] * squash
            val s = sin(rolls[k])
            val q = cos(rolls[k])
            return Triple(cx + x * q - y * s, cy + x * s + y * q, sin(angle) > 0f)
        }

        fun drawBand(k: Int, front: Boolean) {
            val meta = routes[k]
            val r = meta.traffic
            val strokePath = Path()
            val startAngle = if (front) 0f else PI.toFloat()
            for (i in 0..40) {
                val (px, py, _) = orbitPos(k, startAngle + (i / 40f) * PI.toFloat())
                if (i == 0) strokePath.moveTo(px, py) else strokePath.lineTo(px, py)
            }
            drawPath(
                path = strokePath,
                color = (if (r.peers > 0L) meta.color else Line).copy(alpha = if (front) 0.52f else 0.22f),
                style = Stroke(width = 1.4.dp.toPx()),
            )
            val count = r.peers.coerceAtMost(36L).toInt()
            if (count <= 0) return
            val turnAngle = turns(k)
            val tail = routeSpeedRadPerSec(r) * 0.55f
            for (i in 0 until count) {
                val a = turnAngle + (i.toFloat() / count) * twoPi
                val (px, py, near) = orbitPos(k, a)
                if (near != front) continue
                for (j in 1..6) {
                    val (tx, ty, tn) = orbitPos(k, a - tail * j / 6f)
                    if (tn == front) {
                        val tr = (if (front) 4.0f else 2.8f) * (1f - j / 8f)
                        val ta = (if (front) 0.5f else 0.22f) * (1f - j / 7f)
                        drawCircle(meta.color.copy(alpha = ta), radius = tr.dp.toPx(), center = Offset(tx, ty))
                    }
                }
                drawCircle(
                    color = meta.color.copy(alpha = if (front) 1f else 0.45f),
                    radius = (if (front) 4.6f else 3.2f).dp.toPx(),
                    center = Offset(px, py),
                )
            }
        }

        // Back orbit halves
        for (k in 2 downTo 0) drawBand(k, front = false)

        // Globe body
        drawCircle(color = CardBg.copy(alpha = 0.94f), radius = radius, center = Offset(cx, cy))
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Brand.copy(alpha = 0.36f), CardBg.copy(alpha = 0.05f)),
                center = Offset(cx - radius * 0.35f, cy - radius * 0.4f),
                radius = radius * 1.1f,
            ),
            radius = radius,
            center = Offset(cx, cy),
        )

        // Fibonacci sphere dots
        val sp = spin()
        val s = sin(sp)
        val q = cos(sp)
        val tilt = 0.38f
        val ts = sin(tilt)
        val tq = cos(tilt)
        for (p in points) {
            val x = p.x * q + p.z * s
            val z0 = -p.x * s + p.z * q
            val y = p.y * tq - z0 * ts
            val z = p.y * ts + z0 * tq
            if (z < -0.05f) continue
            val dotR = (0.65f + z * 0.85f).dp.toPx()
            val alpha = (0.16f + z * 0.5f).coerceIn(0f, 1f)
            drawCircle(
                color = Ink.copy(alpha = alpha),
                radius = dotR,
                center = Offset(cx + x * radius, cy - y * radius),
            )
        }

        // Front orbit halves
        for (k in 0..2) drawBand(k, front = true)
    }
}

@Composable
private fun SwarmCanvas(
    routes: List<RouteMeta>,
    turns: (Int) -> Float,
    modifier: Modifier = Modifier,
) {
    val ringScales = remember { floatArrayOf(0.42f, 0.70f, 0.96f) }
    val dashed = remember { PathEffect.dashPathEffect(floatArrayOf(10f, 14f), 0f) }

    Canvas(modifier) {
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val maxR = min(size.width, size.height) * 0.44f
        val twoPi = (2.0 * PI).toFloat()

        for (k in 2 downTo 0) {
            val meta = routes[k]
            val r = meta.traffic
            val rad = maxR * ringScales[k]
            val active = r.peers > 0L
            val strokeW = if (active) {
                (1f + 4.5f * ((r.downBps + r.upBps).toFloat() / 4_200_000f).coerceIn(0f, 1f)).dp.toPx()
            } else {
                1.dp.toPx()
            }
            drawCircle(
                color = (if (active) meta.color else Line).copy(alpha = if (active) 0.55f else 0.35f),
                radius = rad,
                center = Offset(cx, cy),
                style = Stroke(width = strokeW, pathEffect = if (active) null else dashed),
            )
            val count = r.peers.coerceAtMost(36L).toInt()
            val turnAngle = turns(k)
            val moving = (r.downBps + r.upBps) > 0L
            for (i in 0 until count) {
                val a = turnAngle * 0.35f + (i.toFloat() / count) * twoPi + k.toFloat()
                val px = cx + cos(a) * rad
                val py = cy + sin(a) * rad
                drawLine(
                    color = meta.color.copy(alpha = 0.22f),
                    start = Offset(cx, cy),
                    end = Offset(px, py),
                    strokeWidth = 1.dp.toPx(),
                )
                if (moving) {
                    val f = (((turnAngle * 0.9f + i * 0.37f) % 1f) + 1f) % 1f
                    drawCircle(
                        color = meta.color.copy(alpha = 0.75f),
                        radius = 2.2.dp.toPx(),
                        center = Offset(px + (cx - px) * f, py + (cy - py) * f),
                    )
                }
                drawCircle(
                    color = meta.color,
                    radius = 5.5.dp.toPx(),
                    center = Offset(px, py),
                )
            }
        }

        // Center node (this device)
        drawCircle(color = CardBg, radius = 22.dp.toPx(), center = Offset(cx, cy))
        drawCircle(color = Brand.copy(alpha = 0.28f), radius = 22.dp.toPx(), center = Offset(cx, cy))
        drawCircle(color = Brand, radius = 12.dp.toPx(), center = Offset(cx, cy))
        drawCircle(color = Color.White.copy(alpha = 0.95f), radius = 4.5.dp.toPx(), center = Offset(cx, cy))
    }
}

@Composable
private fun FlowScene(
    routes: List<RouteMeta>,
    cachedBytes: Long,
    cacheMaxBytes: Long,
    dashPhase: () -> Float,
    modifier: Modifier = Modifier,
) {
    val fillFrac = if (cacheMaxBytes > 0L) {
        (cachedBytes.toFloat() / cacheMaxBytes.toFloat()).coerceIn(0f, 1f)
    } else {
        0f
    }

    Box(modifier) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val ys = floatArrayOf(h * 0.28f, h * 0.54f, h * 0.80f)

            fun ribbonWidth(bps: Long): Float =
                if (bps <= 0L) 0f else (bps.toFloat() / 4_200_000f * 26f).coerceIn(2.5f, 26f).dp.toPx()

            val inW = FloatArray(3) { ribbonWidth(routes[it].traffic.downBps) }
            val outW = FloatArray(3) { ribbonWidth(routes[it].traffic.upBps) }

            fun stackedYs(ws: FloatArray): FloatArray {
                val gap = 4.dp.toPx()
                val total = ws.sum() + gap * 2f
                var y = h * 0.54f - total / 2f
                return FloatArray(3) { i ->
                    val mid = y + ws[i] / 2f
                    y += ws[i] + gap
                    mid
                }
            }

            val inY = stackedYs(inW)
            val outY = stackedYs(outW)
            val tankLeft = w * 0.38f
            val tankRight = w * 0.62f
            val tankTop = h * 0.24f
            val tankHeight = h * 0.60f
            val leftStart = w * 0.25f
            val rightEnd = w * 0.75f
            val phase = dashPhase()
            val dashEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 14f), -phase)

            for (k in 0..2) {
                val color = routes[k].color
                if (inW[k] > 0f) {
                    val p = Path().apply {
                        moveTo(leftStart, ys[k])
                        cubicTo(
                            (leftStart + tankLeft) * 0.5f, ys[k],
                            (leftStart + tankLeft) * 0.5f, inY[k],
                            tankLeft, inY[k],
                        )
                    }
                    drawPath(p, color = color.copy(alpha = 0.55f), style = Stroke(width = inW[k], cap = StrokeCap.Round))
                    drawPath(p, color = Color.White.copy(alpha = 0.55f), style = Stroke(width = 1.5.dp.toPx(), pathEffect = dashEffect))
                } else {
                    val p = Path().apply {
                        moveTo(leftStart, ys[k])
                        cubicTo(
                            (leftStart + tankLeft) * 0.5f, ys[k],
                            (leftStart + tankLeft) * 0.5f, h * 0.54f,
                            tankLeft, h * 0.54f,
                        )
                    }
                    drawPath(p, color = Line.copy(alpha = 0.45f), style = Stroke(width = 1.dp.toPx()))
                }
                if (outW[k] > 0f) {
                    val p = Path().apply {
                        moveTo(tankRight, outY[k])
                        cubicTo(
                            (tankRight + rightEnd) * 0.5f, outY[k],
                            (tankRight + rightEnd) * 0.5f, ys[k],
                            rightEnd, ys[k],
                        )
                    }
                    drawPath(p, color = color.copy(alpha = 0.55f), style = Stroke(width = outW[k], cap = StrokeCap.Round))
                    drawPath(p, color = Color.White.copy(alpha = 0.55f), style = Stroke(width = 1.5.dp.toPx(), pathEffect = dashEffect))
                } else {
                    val p = Path().apply {
                        moveTo(tankRight, h * 0.54f)
                        cubicTo(
                            (tankRight + rightEnd) * 0.5f, h * 0.54f,
                            (tankRight + rightEnd) * 0.5f, ys[k],
                            rightEnd, ys[k],
                        )
                    }
                    drawPath(p, color = Line.copy(alpha = 0.45f), style = Stroke(width = 1.dp.toPx()))
                }
            }

            // Center storage tank
            val tankWidth = tankRight - tankLeft
            val tankCorner = CornerRadius(14.dp.toPx(), 14.dp.toPx())
            drawRoundRect(
                color = CardElevated,
                topLeft = Offset(tankLeft, tankTop),
                size = Size(tankWidth, tankHeight),
                cornerRadius = tankCorner,
            )
            if (fillFrac > 0f) {
                val inset = 6.dp.toPx()
                val innerH = (tankHeight - inset * 2f) * fillFrac
                drawRoundRect(
                    color = Brand.copy(alpha = 0.48f),
                    topLeft = Offset(tankLeft + inset, tankTop + tankHeight - inset - innerH),
                    size = Size(tankWidth - inset * 2f, innerH),
                    cornerRadius = CornerRadius(8.dp.toPx(), 8.dp.toPx()),
                )
            }
            drawRoundRect(
                color = Line,
                topLeft = Offset(tankLeft, tankTop),
                size = Size(tankWidth, tankHeight),
                cornerRadius = tankCorner,
                style = Stroke(width = 1.dp.toPx()),
            )
        }

        // Top headers for Flow columns
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("Received", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Medium)
            Text("Shared", color = Dim, fontSize = 11.sp, fontWeight = FontWeight.Medium)
        }

        // Left route labels
        Column(
            Modifier
                .align(Alignment.CenterStart)
                .fillMaxWidth(0.26f)
                .fillMaxHeight()
                .padding(top = 24.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.SpaceEvenly,
        ) {
            routes.forEach { r ->
                val active = r.traffic.peers > 0L
                Column {
                    Text(
                        text = r.label.replace("Home network", "Home"),
                        color = if (active) Ink else Dim,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = if (active) formatRate(r.traffic.downBps) else "no peers",
                        color = if (active) r.color else Dim.copy(alpha = 0.7f),
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        // Center device label
        Column(
            Modifier
                .align(Alignment.Center)
                .padding(top = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("This device", color = Ink, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            Text("${formatBytes(cachedBytes)} kept", color = Dim, fontSize = 10.sp)
        }

        // Right route labels
        Column(
            Modifier
                .align(Alignment.CenterEnd)
                .fillMaxWidth(0.26f)
                .fillMaxHeight()
                .padding(top = 24.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.SpaceEvenly,
            horizontalAlignment = Alignment.End,
        ) {
            routes.forEach { r ->
                val active = r.traffic.peers > 0L
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = r.label.replace("Home network", "Home"),
                        color = if (active) Ink else Dim,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = if (active) formatRate(r.traffic.upBps) else "no peers",
                        color = if (active) r.color else Dim.copy(alpha = 0.7f),
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun RateSparkCard(
    label: String,
    rateText: String,
    samples: List<Long>,
    accentColor: Color,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(label, color = Dim, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        Text(
            text = rateText,
            color = accentColor,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Canvas(Modifier.fillMaxWidth().height(34.dp)) {
            val w = size.width
            val h = size.height
            if (samples.isEmpty()) {
                drawLine(
                    color = accentColor.copy(alpha = 0.35f),
                    start = Offset(0f, h - 2.dp.toPx()),
                    end = Offset(w, h - 2.dp.toPx()),
                    strokeWidth = 1.5.dp.toPx(),
                )
                return@Canvas
            }
            val top = (samples.maxOrNull() ?: 1L).coerceAtLeast(1L).toFloat()
            val denom = (samples.size - 1).coerceAtLeast(1)
            val padY = 2.dp.toPx()
            val usableH = (h - padY * 2f).coerceAtLeast(1f)
            val line = Path()
            val fill = Path()
            samples.forEachIndexed { idx, value ->
                val x = if (samples.size == 1) w else (idx.toFloat() / denom) * w
                val y = padY + usableH * (1f - (value.toFloat() / top).coerceIn(0f, 1f))
                if (idx == 0) {
                    line.moveTo(x, y)
                    fill.moveTo(x, h)
                    fill.lineTo(x, y)
                } else {
                    line.lineTo(x, y)
                    fill.lineTo(x, y)
                }
            }
            if (samples.size == 1) {
                val y = padY + usableH * (1f - (samples[0].toFloat() / top).coerceIn(0f, 1f))
                line.moveTo(0f, y)
                line.lineTo(w, y)
                fill.reset()
                fill.moveTo(0f, h)
                fill.lineTo(0f, y)
                fill.lineTo(w, y)
                fill.lineTo(w, h)
                fill.close()
            } else {
                fill.lineTo(w, h)
                fill.close()
            }
            drawPath(
                path = fill,
                brush = Brush.verticalGradient(listOf(accentColor.copy(alpha = 0.24f), Color.Transparent)),
            )
            drawPath(
                path = line,
                color = accentColor,
                style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}

@Composable
private fun ReciprocityCard(
    rxBytes: Long,
    txBytes: Long,
    ratio: Double,
) {
    val total = rxBytes + txBytes
    val shareFrac = if (total > 0L) (txBytes.toFloat() / total.toFloat()).coerceIn(0f, 1f) else 0f
    val recvFrac = if (total > 0L) (1f - shareFrac).coerceIn(0f, 1f) else 0f
    val sentence = when {
        total == 0L -> "Nothing moved yet."
        ratio >= 1.0 -> "You gave more than you took. Thank you."
        ratio >= 0.1 -> "You shared ${(ratio * 10.0).roundToInt()} GB for every 10 GB you got."
        txBytes > 0L -> "You mostly receive now. Peers take when they ask."
        else -> "You only received so far."
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(sentence, color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        Row(
            Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(PillShape)
                .background(Line),
        ) {
            if (shareFrac > 0f) {
                Box(
                    Modifier
                        .weight(shareFrac.coerceAtLeast(0.01f))
                        .fillMaxHeight()
                        .background(BrandHover),
                )
            }
            if (recvFrac > 0f) {
                Box(
                    Modifier
                        .weight(recvFrac.coerceAtLeast(0.01f))
                        .fillMaxHeight()
                        .background(Accent),
                )
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Shared ${formatBytes(txBytes)}", color = BrandHover, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            Text("Received ${formatBytes(rxBytes)}", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun RoutesCard(
    routes: List<RouteMeta>,
    cachedBytes: Long,
    cacheMaxBytes: Long,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(CardShape)
            .background(CardBg)
            .border(1.dp, Line, CardShape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("Routes", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        routes.forEach { r ->
            val active = r.traffic.peers > 0L
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(if (active) r.color else Dim.copy(alpha = 0.4f)),
                )
                Text(
                    text = r.label,
                    color = if (active) Ink else Dim,
                    fontSize = 14.sp,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = r.traffic.peers.toString(),
                    color = if (active) Ink else Dim,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                if (active) {
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = "↓ ${formatRate(r.traffic.downBps)}  ↑ ${formatRate(r.traffic.upBps)}",
                        color = Dim,
                        fontSize = 12.sp,
                        maxLines = 1,
                    )
                }
            }
        }
        HorizontalDivider(color = Line)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Storage kept", color = Dim, fontSize = 13.sp)
            Text(
                text = "${formatBytes(cachedBytes)} of ${formatBytes(cacheMaxBytes)}",
                color = Ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
