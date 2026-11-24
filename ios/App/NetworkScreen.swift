import SwiftUI

enum NetworkVizMode: String, CaseIterable, Identifiable {
    case globe = "Globe"
    case swarm = "Swarm"
    case flow = "Flow"

    var id: String { rawValue }
}

private final class NetworkVizClock {
    var lastTimestamp: TimeInterval = 0
    var spin: Double = 0.6
    var turn: [Double] = [0.3, 1.9, 4.1]
    var dashPhase: Double = 0

    func step(now: TimeInterval, routes: [RouteSnapshot]) {
        if lastTimestamp == 0 {
            lastTimestamp = now
            return
        }
        let dt = min(0.1, max(0, now - lastTimestamp))
        lastTimestamp = now
        spin += dt * 0.11
        dashPhase += dt * 28.0
        for k in 0..<min(3, routes.count) {
            let speed = 0.07 + 0.85 * min(1.0, (routes[k].downBps + routes[k].upBps) / 4_200_000.0)
            turn[k] += dt * speed
        }
    }
}

private struct SpherePoint {
    let x: Double
    let y: Double
    let z: Double
}

private let globePoints: [SpherePoint] = (0..<320).map { i in
    let y = 1.0 - (Double(i) + 0.5) / 160.0
    let r = sqrt(max(0, 1.0 - y * y))
    let a = Double(i) * 2.399963
    return SpherePoint(x: cos(a) * r, y: y, z: sin(a) * r)
}

@MainActor
struct NetworkView: View {
    @ObservedObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var mode: NetworkVizMode = .globe
    @State private var vizClock = NetworkVizClock()

    private let routeColors: [Color] = [PTColor.ok, PTColor.brandHover, PTColor.warn]

    private var snap: NetworkSnapshot { model.networkSnapshot }

    private var isWideLayout: Bool { sizeClass == .regular }

    private var sceneCaption: String {
        if snap.totalPeers == 0 {
            return "No peers now. Your library still plays from this device."
        }
        return mode == .flow ? "Width is speed." : "Connections, not locations"
    }

    private var reciprocitySentence: String {
        let rx = snap.rxBytes
        let tx = snap.txBytes
        let ratio = snap.reciprocityRatio
        if rx + tx <= 0 { return "Nothing moved yet." }
        if ratio >= 1.0 { return "You gave more than you took. Thank you." }
        if ratio >= 0.1 { return "You shared \(Int((ratio * 10.0).rounded())) GB for every 10 GB you got." }
        if tx > 0 { return "You mostly receive now. Peers take when they ask." }
        return "You only received so far."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Network view", selection: $mode) {
                ForEach(NetworkVizMode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("network.modePicker")

            if isWideLayout {
                HStack(alignment: .top, spacing: 16) {
                    sceneCard
                        .frame(maxWidth: .infinity)
                    VStack(spacing: 12) {
                        ratePairCard
                        reciprocityCard
                        routesCard
                    }
                    .frame(minWidth: 280, maxWidth: 360)
                }
            } else {
                sceneCard
                ratePairCard
                reciprocityCard
                routesCard
            }
        }
    }

    private var sceneCard: some View {
        let snapshot = snap
        let routes = snapshot.routes
        let a11ySummary = snapshot.totalPeers == 0
            ? "No peers connected"
            : "\(plural(snapshot.totalPeers, "peer", "peers")): " + routes.map { "\($0.peers) on \($0.label.lowercased())" }.joined(separator: ", ")

        return ZStack {
            RadialGradient(
                stops: [
                    .init(color: PTColor.brand.opacity(0.18), location: 0.0),
                    .init(color: PTColor.surface, location: 0.65)
                ],
                center: UnitPoint(x: 0.5, y: 0.42),
                startRadius: 6,
                endRadius: isWideLayout ? 280 : 210
            )
            .background(PTColor.surface)

            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { timeline in
                Canvas { ctx, size in
                    if !reduceMotion {
                        vizClock.step(now: timeline.date.timeIntervalSinceReferenceDate, routes: routes)
                    }
                    switch mode {
                    case .globe:
                        drawGlobe(ctx: &ctx, size: size, routes: routes)
                    case .swarm:
                        drawSwarm(ctx: &ctx, size: size, routes: routes)
                    case .flow:
                        drawFlow(ctx: &ctx, size: size, snapshot: snapshot)
                    }
                }
            }
            .padding(.bottom, 22)
            .accessibilityLabel(a11ySummary)
            .accessibilityIdentifier("network.canvas")

            // Hide route legend overlay on wide layouts where the Routes card sits beside the canvas.
            if !isWideLayout && mode != .flow {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(routes.enumerated()), id: \.element.key) { idx, route in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(routeColors.indices.contains(idx) ? routeColors[idx] : PTColor.dim)
                                .frame(width: 8, height: 8)
                            Text("\(route.label) · \(route.peers)")
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(route.peers > 0 ? PTColor.ink : PTColor.dim)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .allowsHitTesting(false)
            }

            Text(sceneCaption)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PTColor.dim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)
        }
        .frame(height: isWideLayout ? 310 : 232)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private var ratePairCard: some View {
        HStack(spacing: 12) {
            rateColumn(
                title: "Receiving",
                rate: rateText(snap.downBps),
                samples: model.downBpsHistory,
                color: PTColor.ok
            )
            Rectangle()
                .fill(PTColor.line)
                .frame(width: 1)
            rateColumn(
                title: "Sharing",
                rate: rateText(snap.upBps),
                samples: model.upBpsHistory,
                color: PTColor.brandRing
            )
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private func rateColumn(title: String, rate: String, samples: [Double], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(PTColor.dim)
            Text(rate)
                .font(.headline.monospacedDigit())
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            SparklineView(samples: samples, color: color)
                .frame(height: 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var reciprocityCard: some View {
        let rx = snap.rxBytes
        let tx = snap.txBytes
        let total = rx + tx
        let shareFrac = total > 0 ? min(1, max(0, tx / total)) : 0
        let recvFrac = total > 0 ? max(0, 1 - shareFrac) : 0

        return VStack(alignment: .leading, spacing: 8) {
            Text(reciprocitySentence)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(PTColor.ink)

            GeometryReader { geo in
                HStack(spacing: 2) {
                    if shareFrac > 0 {
                        Capsule()
                            .fill(PTColor.brand)
                            .frame(width: max(4, geo.size.width * shareFrac - 1))
                    }
                    if recvFrac > 0 {
                        Capsule()
                            .fill(PTColor.ok)
                            .frame(width: max(4, geo.size.width * recvFrac - 1))
                    }
                    if total <= 0 {
                        Capsule().fill(PTColor.line)
                    }
                }
            }
            .frame(height: 6)

            HStack {
                Text("Shared \(bytes(tx))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PTColor.brandRing)
                Spacer()
                Text("Received \(bytes(rx))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PTColor.ok)
            }
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private var routesCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Routes")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PTColor.dim)
                .textCase(.uppercase)

            ForEach(Array(snap.routes.enumerated()), id: \.element.key) { idx, route in
                HStack(spacing: 8) {
                    Circle()
                        .fill(routeColors[idx])
                        .frame(width: 8, height: 8)
                        .opacity(route.peers > 0 ? 1 : 0.4)
                    Text(route.label)
                        .font(.subheadline)
                        .foregroundStyle(route.peers > 0 ? PTColor.ink : PTColor.dim)
                    Text("\(route.peers)")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(route.peers > 0 ? PTColor.ink : PTColor.dim)
                    Spacer()
                    if route.peers > 0 {
                        Text("↓ \(rateText(route.downBps))  ↑ \(rateText(route.upBps))")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PTColor.dim)
                    } else {
                        Text("No peers")
                            .font(.caption)
                            .foregroundStyle(PTColor.dim.opacity(0.7))
                    }
                }
            }

            PTDivider()
                .padding(.vertical, 2)

            HStack {
                Text("Kept")
                    .font(.caption)
                    .foregroundStyle(PTColor.dim)
                Text("\(bytes(snap.cachedBytes)) of \(bytes(snap.cacheMaxBytes))")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(PTColor.ink)
                Spacer()
            }
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    // MARK: - Canvas Renderers

    private func drawDot(ctx: inout GraphicsContext, x: Double, y: Double, radius: Double, color: Color, alpha: Double) {
        let rect = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
        ctx.fill(Path(ellipseIn: rect), with: .color(color.opacity(alpha)))
    }

    private func drawGlobe(ctx: inout GraphicsContext, size: CGSize, routes: [RouteSnapshot]) {
        let w = Double(size.width)
        let h = Double(size.height)
        guard w > 10, h > 10, routes.count >= 3 else { return }
        let cx = w / 2.0
        let cy = h * 0.47
        let r = min(w, h * 1.2) * 0.22
        let squash = 0.36
        let roll: [Double] = [-0.2, 0.13, -0.34]
        let reach: [Double] = [1.42, 1.86, 2.3]

        func orbitPoint(_ k: Int, _ a: Double) -> (Double, Double, Bool) {
            let x = cos(a) * r * reach[k]
            let y = sin(a) * r * reach[k] * squash
            let s = sin(roll[k])
            let q = cos(roll[k])
            return (cx + x * q - y * s, cy + x * s + y * q, sin(a) > 0)
        }

        func drawBand(_ k: Int, front: Bool) {
            let route = routes[k]
            var orbit = Path()
            let base = front ? 0.0 : .pi
            for i in 0...40 {
                let (x, y, _) = orbitPoint(k, base + Double(i) / 40.0 * .pi)
                if i == 0 { orbit.move(to: CGPoint(x: x, y: y)) }
                else { orbit.addLine(to: CGPoint(x: x, y: y)) }
            }
            let strokeColor = route.peers > 0 ? routeColors[k] : PTColor.line
            ctx.stroke(orbit, with: .color(strokeColor.opacity(front ? 0.52 : 0.22)), lineWidth: 1.2)

            let n = min(route.peers, 36)
            guard n > 0 else { return }
            let speed = 0.07 + 0.85 * min(1.0, (route.downBps + route.upBps) / 4_200_000.0)
            let tail = speed * 0.55
            for i in 0..<n {
                let a = vizClock.turn[k] + Double(i) / Double(n) * (.pi * 2.0)
                let (x, y, near) = orbitPoint(k, a)
                if near != front { continue }
                for j in 1...5 {
                    let (tx, ty, tn) = orbitPoint(k, a - tail * Double(j) / 5.0)
                    if tn == front {
                        let rad = (front ? 4.0 : 2.8) * (1.0 - Double(j) / 7.0)
                        let alpha = (front ? 0.48 : 0.20) * (1.0 - Double(j) / 6.0)
                        drawDot(ctx: &ctx, x: tx, y: ty, radius: rad, color: routeColors[k], alpha: alpha)
                    }
                }
                drawDot(ctx: &ctx, x: x, y: y, radius: front ? 4.8 : 3.4, color: routeColors[k], alpha: front ? 1.0 : 0.45)
            }
        }

        for k in stride(from: 2, through: 0, by: -1) {
            drawBand(k, front: false)
        }

        let globeRect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
        let globePath = Path(ellipseIn: globeRect)
        ctx.fill(globePath, with: .color(PTColor.surface.opacity(0.95)))
        ctx.fill(
            globePath,
            with: .radialGradient(
                Gradient(colors: [PTColor.brand.opacity(0.36), PTColor.surface.opacity(0.05)]),
                center: CGPoint(x: cx - r * 0.35, y: cy - r * 0.4),
                startRadius: r * 0.08,
                endRadius: r * 1.05
            )
        )

        let s = sin(vizClock.spin)
        let q = cos(vizClock.spin)
        let tilt = 0.38
        let ts = sin(tilt)
        let tq = cos(tilt)
        for pt in globePoints {
            let x = pt.x * q + pt.z * s
            let z0 = -pt.x * s + pt.z * q
            let y = pt.y * tq - z0 * ts
            let z = pt.y * ts + z0 * tq
            if z < -0.05 { continue }
            drawDot(ctx: &ctx, x: cx + x * r, y: cy - y * r, radius: 0.7 + z * 0.85, color: PTColor.ink, alpha: 0.16 + z * 0.48)
        }

        for k in 0..<3 {
            drawBand(k, front: true)
        }
    }

    private func drawSwarm(ctx: inout GraphicsContext, size: CGSize, routes: [RouteSnapshot]) {
        let w = Double(size.width)
        let h = Double(size.height)
        guard w > 10, h > 10, routes.count >= 3 else { return }
        let cx = w / 2.0
        let cy = h / 2.0
        let top = min(w, h) * 0.43
        let rings: [Double] = [0.42, 0.70, 0.98]

        for k in stride(from: 2, through: 0, by: -1) {
            let route = routes[k]
            let rad = top * rings[k]
            let ringRect = CGRect(x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2)
            let ringPath = Path(ellipseIn: ringRect)
            let lineWidth = route.peers > 0 ? 1.0 + 4.5 * min(1.0, (route.downBps + route.upBps) / 4_200_000.0) : 1.0
            let strokeStyle = StrokeStyle(lineWidth: lineWidth, dash: route.peers > 0 ? [] : [4, 7])
            let strokeColor = (route.peers > 0 ? routeColors[k] : PTColor.line).opacity(route.peers > 0 ? 0.55 : 0.32)
            ctx.stroke(ringPath, with: .color(strokeColor), style: strokeStyle)

            let n = min(route.peers, 36)
            for i in 0..<n {
                let a = vizClock.turn[k] * 0.35 + Double(i) / Double(n) * (.pi * 2.0) + Double(k)
                let x = cx + cos(a) * rad
                let y = cy + sin(a) * rad
                var spoke = Path()
                spoke.move(to: CGPoint(x: cx, y: cy))
                spoke.addLine(to: CGPoint(x: x, y: y))
                ctx.stroke(spoke, with: .color(routeColors[k].opacity(0.22)), lineWidth: 1)

                if route.downBps + route.upBps > 0 {
                    let rawF = (vizClock.turn[k] * 0.9 + Double(i) * 0.37).truncatingRemainder(dividingBy: 1.0)
                    let f = rawF < 0 ? rawF + 1.0 : rawF
                    drawDot(ctx: &ctx, x: x + (cx - x) * f, y: y + (cy - y) * f, radius: 2.2, color: routeColors[k], alpha: 0.78)
                }
                drawDot(ctx: &ctx, x: x, y: y, radius: 5.5, color: routeColors[k], alpha: 1.0)
            }
        }

        drawDot(ctx: &ctx, x: cx, y: cy, radius: 20, color: PTColor.surface, alpha: 1.0)
        drawDot(ctx: &ctx, x: cx, y: cy, radius: 20, color: PTColor.brand, alpha: 0.28)
        drawDot(ctx: &ctx, x: cx, y: cy, radius: 11, color: PTColor.brand, alpha: 1.0)
        drawDot(ctx: &ctx, x: cx, y: cy, radius: 4.5, color: .white, alpha: 0.95)
    }

    private func drawFlow(ctx: inout GraphicsContext, size: CGSize, snapshot: NetworkSnapshot) {
        let w = Double(size.width)
        let h = Double(size.height)
        let routes = snapshot.routes
        guard w > 40, h > 40, routes.count >= 3 else { return }
        let ys: [Double] = [h * 0.28, h * 0.54, h * 0.80]
        let leftX = w * 0.28
        let boxW = min(92.0, w * 0.28)
        let boxH = h * 0.52
        let boxX = (w - boxW) / 2.0
        let boxY = (h - boxH) / 2.0 + 4.0
        let rightX = w * 0.72

        ctx.draw(Text("Received").font(.caption2.weight(.semibold)).foregroundStyle(PTColor.dim), at: CGPoint(x: 6, y: 14), anchor: .leading)
        ctx.draw(Text("Shared").font(.caption2.weight(.semibold)).foregroundStyle(PTColor.dim), at: CGPoint(x: w - 6, y: 14), anchor: .trailing)

        func ribbonWidth(_ bps: Double) -> Double {
            bps > 0 ? max(3.0, min(28.0, bps / 4_200_000.0 * 28.0)) : 0
        }

        let inW = routes.map { ribbonWidth($0.downBps) }
        let outW = routes.map { ribbonWidth($0.upBps) }

        func stackCenters(_ ws: [Double]) -> [Double] {
            let total = ws.reduce(0, +) + 6.0 * Double(max(0, ws.count - 1))
            var y = boxY + boxH / 2.0 - total / 2.0
            return ws.map { wVal in
                let mid = y + wVal / 2.0
                y += wVal + 6.0
                return mid
            }
        }

        let inY = stackCenters(inW)
        let outY = stackCenters(outW)
        let shortNames = ["Home", "Internet", "Private"]

        for k in 0..<3 {
            let route = routes[k]
            let y = ys[k]
            let color = routeColors[k]
            let labelAlpha = route.peers > 0 ? 1.0 : 0.45

            ctx.draw(
                Text(shortNames[k]).font(.caption2.weight(.semibold)).foregroundStyle(PTColor.ink.opacity(labelAlpha)),
                at: CGPoint(x: 6, y: y - 7),
                anchor: .leading
            )
            ctx.draw(
                Text(route.peers > 0 ? rateText(route.downBps) : "no peers").font(.system(size: 10).monospacedDigit()).foregroundStyle(PTColor.dim),
                at: CGPoint(x: 6, y: y + 7),
                anchor: .leading
            )

            ctx.draw(
                Text(shortNames[k]).font(.caption2.weight(.semibold)).foregroundStyle(PTColor.ink.opacity(labelAlpha)),
                at: CGPoint(x: w - 6, y: y - 7),
                anchor: .trailing
            )
            ctx.draw(
                Text(route.peers > 0 ? rateText(route.upBps) : "no peers").font(.system(size: 10).monospacedDigit()).foregroundStyle(PTColor.dim),
                at: CGPoint(x: w - 6, y: y + 7),
                anchor: .trailing
            )

            if inW[k] > 0 {
                var path = Path()
                path.move(to: CGPoint(x: leftX, y: y))
                let midX = (leftX + boxX) / 2.0
                path.addCurve(
                    to: CGPoint(x: boxX, y: inY[k]),
                    control1: CGPoint(x: midX, y: y),
                    control2: CGPoint(x: midX, y: inY[k])
                )
                ctx.stroke(path, with: .color(color.opacity(0.45)), style: StrokeStyle(lineWidth: inW[k], lineCap: .round))
                ctx.stroke(path, with: .color(color.opacity(0.95)), style: StrokeStyle(lineWidth: 1.5, dash: [5, 7], dashPhase: -vizClock.dashPhase))
            }

            if outW[k] > 0 {
                var path = Path()
                let startX = boxX + boxW
                path.move(to: CGPoint(x: startX, y: outY[k]))
                let midX = (startX + rightX) / 2.0
                path.addCurve(
                    to: CGPoint(x: rightX, y: y),
                    control1: CGPoint(x: midX, y: outY[k]),
                    control2: CGPoint(x: midX, y: y)
                )
                ctx.stroke(path, with: .color(color.opacity(0.45)), style: StrokeStyle(lineWidth: outW[k], lineCap: .round))
                ctx.stroke(path, with: .color(color.opacity(0.95)), style: StrokeStyle(lineWidth: 1.5, dash: [5, 7], dashPhase: -vizClock.dashPhase))
            }
        }

        let tankRect = CGRect(x: boxX, y: boxY, width: boxW, height: boxH)
        let tankPath = Path(roundedRect: tankRect, cornerRadius: 12)
        ctx.fill(tankPath, with: .color(PTColor.raised))
        ctx.stroke(tankPath, with: .color(PTColor.line), lineWidth: 1)

        let full = snapshot.cacheMaxBytes > 0 ? min(1.0, max(0, snapshot.cachedBytes / snapshot.cacheMaxBytes)) : 0
        if full > 0 {
            let pad = 6.0
            let innerH = max(0, boxH - pad * 2)
            let fillH = max(4.0, innerH * full)
            let fillRect = CGRect(x: boxX + pad, y: boxY + pad + (innerH - fillH), width: boxW - pad * 2, height: fillH)
            ctx.fill(Path(roundedRect: fillRect, cornerRadius: 7), with: .color(PTColor.brand.opacity(0.5)))
        }

        ctx.draw(
            Text("This device").font(.caption2.weight(.bold)).foregroundStyle(PTColor.ink),
            at: CGPoint(x: boxX + boxW / 2.0, y: boxY + boxH / 2.0 - 7),
            anchor: .center
        )
        ctx.draw(
            Text("\(bytes(snapshot.cachedBytes)) kept").font(.system(size: 10).monospacedDigit()).foregroundStyle(PTColor.dim),
            at: CGPoint(x: boxX + boxW / 2.0, y: boxY + boxH / 2.0 + 9),
            anchor: .center
        )
    }
}

private struct SparklineView: View {
    let samples: [Double]
    let color: Color

    var body: some View {
        Canvas { ctx, size in
            let w = Double(size.width)
            let h = Double(size.height)
            guard w > 4, h > 4 else { return }
            let list = samples.isEmpty ? [0.0, 0.0] : (samples.count == 1 ? [samples[0], samples[0]] : samples)
            let top = max(1.0, list.max() ?? 1.0)
            var path = Path()
            for (idx, val) in list.enumerated() {
                let x = Double(idx) * (w / Double(max(1, list.count - 1)))
                let y = h - 2.0 - (max(0, val) / top) * (h - 4.0)
                if idx == 0 { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }
            ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }
}
