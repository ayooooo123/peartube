import SwiftUI

/// Deterministic drawn album sleeve matching `albumArt` in `src/ui.js`.
/// Uses the album's per-artist wheel `hue`, FNV-1a avalanche `seed`, and `monogram`.
struct SleeveView: View {
    let hue: Int
    let seed: UInt32
    let monogram: String
    var cornerRadius: CGFloat = 10

    private var h1: Double { Double(hue) }
    private var h2: Double { Double((hue + 30 + Int((seed >> 9) % 120)) % 360) }
    private var lightness: Double { Double(42 + Int((seed >> 3) % 16)) / 100.0 }
    private var angle: Double { Double(120 + Int((seed >> 17) % 120)) }
    private var cut: Int { Int((seed >> 25) % 3) }

    private var baseColor: Color { Color.hsl(hue: h1, saturation: 0.62, lightness: lightness) }
    private var deepColor: Color { Color.hsl(hue: h2, saturation: 0.64, lightness: 0.20) }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            ZStack {
                sleeveBackground(size: geo.size)
                Text(monogram)
                    .font(.system(size: max(12, side * 0.34), weight: .bold, design: .default))
                    .tracking(-0.5)
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func sleeveBackground(size: CGSize) -> some View {
        let rad = angle * .pi / 180.0
        let start = UnitPoint(x: 0.5 - cos(rad) * 0.5, y: 0.5 - sin(rad) * 0.5)
        let end = UnitPoint(x: 0.5 + cos(rad) * 0.5, y: 0.5 + sin(rad) * 0.5)
        let shine = RadialGradient(
            colors: [Color.white.opacity(0.22), .clear],
            center: UnitPoint(x: 0.78, y: 0.18),
            startRadius: 0,
            endRadius: max(size.width, size.height) * 0.52
        )

        switch cut {
        case 1:
            // Record cut: concentric subtle rings over a center label
            ZStack {
                RadialGradient(
                    stops: [
                        .init(color: baseColor, location: 0.0),
                        .init(color: baseColor, location: 0.31),
                        .init(color: deepColor, location: 0.32),
                        .init(color: deepColor, location: 1.0)
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: max(size.width, size.height) * 0.72
                )
                Canvas { ctx, canvasSize in
                    let center = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
                    let maxR = hypot(canvasSize.width, canvasSize.height) * 0.55
                    var r: CGFloat = 6
                    while r < maxR {
                        let rect = CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)
                        ctx.stroke(Path(ellipseIn: rect), with: .color(.black.opacity(0.14)), lineWidth: 1)
                        r += 5
                    }
                }
            }
        case 2:
            // Hard split cut at 54%
            ZStack {
                LinearGradient(
                    stops: [
                        .init(color: baseColor, location: 0.0),
                        .init(color: baseColor, location: 0.54),
                        .init(color: deepColor, location: 0.5401),
                        .init(color: deepColor, location: 1.0)
                    ],
                    startPoint: start,
                    endPoint: end
                )
                shine
            }
        default:
            // Sweep cut
            ZStack {
                LinearGradient(colors: [baseColor, deepColor], startPoint: start, endPoint: end)
                shine
            }
        }
    }
}

/// Stacked sleeves representing an artist (Rule 6: no artist photos).
struct ArtistSleeveStack: View {
    let albums: [LibraryTile]

    var body: some View {
        let shown = Array(albums.prefix(3))
        ZStack {
            ForEach(Array(shown.enumerated().reversed()), id: \.offset) { idx, album in
                let shift = CGFloat(idx) * 6
                let scale = 1.0 - CGFloat(idx) * 0.06
                SleeveView(hue: album.hue, seed: album.seed, monogram: album.monogramText, cornerRadius: 10)
                    .scaleEffect(scale, anchor: .topLeading)
                    .offset(x: shift, y: shift)
                    .opacity(idx == 0 ? 1.0 : (idx == 1 ? 0.85 : 0.70))
            }
        }
        .padding(.trailing, shown.count > 1 ? CGFloat(min(shown.count - 1, 2)) * 6 : 0)
        .padding(.bottom, shown.count > 1 ? CGFloat(min(shown.count - 1, 2)) * 6 : 0)
        .aspectRatio(1, contentMode: .fit)
    }
}

/// Atmospheric hero panel backdrop matching `.hero` in `sketch.css`:
/// hue-based gradient, optional top-right radial orb accent, subtle 118° diagonal pinstripes, and left readability scrim.
struct PTHeroBackground: View {
    let hue: Double
    var showOrb: Bool = true

    var body: some View {
        Canvas { ctx, size in
            let w = size.width
            let h = size.height
            guard w > 0, h > 0 else { return }

            let fullRect = CGRect(origin: .zero, size: size)

            // Base 120deg linear gradient: hsl(h, 60%, 30%) -> hsl(h + 55, 66%, 9%)
            let c1 = Color.hsl(hue: hue, saturation: 0.60, lightness: 0.30)
            let c2 = Color.hsl(hue: hue + 55, saturation: 0.66, lightness: 0.09)
            ctx.fill(
                Path(fullRect),
                with: .linearGradient(
                    Gradient(colors: [c1, c2]),
                    startPoint: CGPoint(x: w * 0.12, y: 0),
                    endPoint: CGPoint(x: w * 0.88, y: h)
                )
            )

            // Optional radial orb accent (.hero::before)
            if showOrb {
                let orbDiam = max(w * 0.58, h * 0.85)
                let orbX = w - orbDiam + w * 0.06
                let orbY = -h * 0.30
                let orbRect = CGRect(x: orbX, y: orbY, width: orbDiam, height: orbDiam)
                let orbCenter = CGPoint(x: orbRect.minX + orbDiam * 0.35, y: orbRect.minY + orbDiam * 0.35)
                let orbInner = Color.hsl(hue: hue + 165, saturation: 0.84, lightness: 0.66).opacity(0.82)
                let orbMid = Color.hsl(hue: hue + 120, saturation: 0.80, lightness: 0.40).opacity(0.15)
                ctx.fill(
                    Path(ellipseIn: orbRect),
                    with: .radialGradient(
                        Gradient(stops: [
                            .init(color: orbInner, location: 0.0),
                            .init(color: orbMid, location: 0.70),
                            .init(color: orbMid.opacity(0), location: 1.0)
                        ]),
                        center: orbCenter,
                        startRadius: 0,
                        endRadius: orbDiam * 0.62
                    )
                )
            }

            // Subtle diagonal pinstripe overlay (.hero::after 118deg, 46pt gap, 2pt line)
            let rad = 118.0 * Double.pi / 180.0
            let dx = cos(rad)
            let dy = sin(rad)
            let nx = -dy
            let ny = dx
            let span = hypot(w, h)
            let step: Double = 48.0
            var offset = -span
            let cx = w * 0.5
            let cy = h * 0.5
            var stripes = Path()
            while offset <= span {
                let px = cx + nx * offset
                let py = cy + ny * offset
                stripes.move(to: CGPoint(x: px - dx * span, y: py - dy * span))
                stripes.addLine(to: CGPoint(x: px + dx * span, y: py + dy * span))
                offset += step
            }
            ctx.stroke(stripes, with: .color(Color.white.opacity(0.045)), lineWidth: 2)

            // Left readability scrim
            ctx.fill(
                Path(fullRect),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: Color.black.opacity(0.50), location: 0.0),
                        .init(color: Color.clear, location: 0.72)
                    ]),
                    startPoint: CGPoint(x: 0, y: h * 0.5),
                    endPoint: CGPoint(x: w, y: h * 0.5)
                )
            )
        }
        .accessibilityHidden(true)
    }
}

/// 4-variant geometric poster fallback matching `.poster.v0`–`v3` in `sketch.css`.
struct GeometricPosterArt: View {
    let title: String
    let kindLabel: String
    var wide: Bool = false
    var extraBottomPadding: CGFloat = 0

    private var hue: Int { Int(CatalogText.sleeveHash(title) % 360) }
    private var variant: Int { hue % 4 }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let pad = wide ? max(6, w * 0.055) : max(6, w * 0.09)
            let isLong = wide ? title.count > 26 : title.count > 22

            ZStack(alignment: .bottomLeading) {
                Canvas { ctx, size in
                    let cw = size.width
                    let ch = size.height
                    guard cw > 0, ch > 0 else { return }

                    let rect = CGRect(origin: .zero, size: size)
                    let topColor = Color.hsl(hue: Double(hue), saturation: 0.58, lightness: 0.36)
                    let botColor = Color.hsl(hue: Double(hue + 48), saturation: 0.64, lightness: 0.11)
                    ctx.fill(
                        Path(rect),
                        with: .linearGradient(
                            Gradient(colors: [topColor, botColor]),
                            startPoint: CGPoint(x: cw * 0.36, y: 0),
                            endPoint: CGPoint(x: cw * 0.64, y: ch)
                        )
                    )

                    switch variant {
                    case 0:
                        // v0: off-center circle (inset: -18% -42% 44% 22%)
                        let circleRect = CGRect(
                            x: cw * 0.22,
                            y: -ch * 0.18,
                            width: cw * 1.20,
                            height: ch * 0.74
                        )
                        let fill = Color.hsl(hue: Double(hue + 170), saturation: 0.78, lightness: 0.62).opacity(0.62)
                        ctx.fill(Path(ellipseIn: circleRect), with: .color(fill))
                    case 1:
                        // v1: diagonal stripes (118deg, 9cqi gap, 1cqi stripe)
                        let rad = 118.0 * Double.pi / 180.0
                        let dx = cos(rad)
                        let dy = sin(rad)
                        let nx = -dy
                        let ny = dx
                        let span = hypot(cw, ch)
                        let step = max(6.0, cw * 0.10)
                        let stripeW = max(1.0, cw * 0.012)
                        var offset = -span
                        var stripes = Path()
                        while offset <= span {
                            let px = cw * 0.5 + nx * offset
                            let py = ch * 0.5 + ny * offset
                            stripes.move(to: CGPoint(x: px - dx * span, y: py - dy * span))
                            stripes.addLine(to: CGPoint(x: px + dx * span, y: py + dy * span))
                            offset += step
                        }
                        ctx.stroke(stripes, with: .color(Color.white.opacity(0.10)), lineWidth: stripeW)
                    case 2:
                        // v2: angled band (left -30%, right -30%, top 26%, height 34%, rotate -16deg)
                        let bandRect = CGRect(x: -cw * 0.30, y: ch * 0.26, width: cw * 1.60, height: ch * 0.34)
                        let center = CGPoint(x: bandRect.midX, y: bandRect.midY)
                        let angle = -16.0 * Double.pi / 180.0
                        let transform = CGAffineTransform(translationX: center.x, y: center.y)
                            .rotated(by: angle)
                            .translatedBy(x: -center.x, y: -center.y)
                        let fill = Color.hsl(hue: Double(hue + 140), saturation: 0.78, lightness: 0.56).opacity(0.62)
                        ctx.fill(Path(bandRect).applying(transform), with: .color(fill))
                    default:
                        // v3: stroked ring (right -22%, top -12%, width 92%, border 9cqi)
                        let diam = cw * 0.92
                        let ringRect = CGRect(x: cw - diam + cw * 0.22, y: -ch * 0.12, width: diam, height: diam)
                        let stroke = Color.hsl(hue: Double(hue + 200), saturation: 0.82, lightness: 0.72).opacity(0.50)
                        ctx.stroke(Path(ellipseIn: ringRect), with: .color(stroke), lineWidth: max(3, cw * 0.09))
                    }

                    // Bottom readability wash
                    ctx.fill(
                        Path(rect),
                        with: .linearGradient(
                            Gradient(stops: [
                                .init(color: .clear, location: 0.45),
                                .init(color: Color.black.opacity(0.32), location: 1.0)
                            ]),
                            startPoint: CGPoint(x: cw * 0.5, y: 0),
                            endPoint: CGPoint(x: cw * 0.5, y: ch)
                        )
                    )
                }

                if w < 56 {
                    Text(CatalogText.monogram(title))
                        .font(.system(size: max(11, w * 0.34), weight: .heavy))
                        .foregroundStyle(Color.white.opacity(0.92))
                        .lineLimit(1)
                        .frame(width: w, height: h)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(kindLabel)
                            .font(.system(size: max(8.5, w * (wide ? 0.036 : 0.062)), weight: .bold))
                            .tracking(1.4)
                            .textCase(.uppercase)
                            .foregroundStyle(Color.white.opacity(0.85))
                            .lineLimit(1)

                        Spacer(minLength: 4)

                        Text(title)
                            .font(.system(
                                size: max(11, w * (wide ? (isLong ? 0.068 : 0.095) : (isLong ? 0.10 : 0.145))),
                                weight: .heavy
                            ))
                            .tracking(-0.3)
                            .textCase(.uppercase)
                            .foregroundStyle(Color.white)
                            .lineLimit(wide ? 3 : (isLong ? 6 : 4))
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: wide ? w * 0.78 : .infinity, alignment: .leading)
                    }
                    .padding(.top, pad)
                    .padding(.horizontal, pad)
                    .padding(.bottom, pad + extraBottomPadding)
                    .frame(width: w, height: h, alignment: .bottomLeading)
                }
            }
            .frame(width: w, height: h)
            .clipped()
        }
        .accessibilityHidden(true)
    }
}

private func posterKindLabel(for kind: TileKind?, defaultLabel: String) -> String {
    switch kind {
    case .show: return "SERIES"
    case .movie: return "FILM"
    case .clip: return "CLIP"
    case .album: return "ALBUM"
    case nil: return defaultLabel
    }
}

/// 2:3 film/series poster loaded from the local relay `/v1/poster/<imdb>`, with a 4-variant geometric poster fallback.
struct PosterView: View {
    let title: String
    let year: String?
    var kind: TileKind? = nil
    let url: URL?
    var cornerRadius: CGFloat = 10

    private var kindLabel: String { posterKindLabel(for: kind, defaultLabel: "FILM") }

    var body: some View {
        Color.clear
            .aspectRatio(2.0 / 3.0, contentMode: .fit)
            .overlay {
                ZStack {
                    GeometricPosterArt(title: title, kindLabel: kindLabel, wide: false)
                    if let url {
                        AsyncImage(url: url) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFill()
                            }
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
            )
    }
}

/// 16:9 wide tile artwork for Keep playing/watching and Clips, with a 4-variant geometric poster fallback.
struct WideArtView: View {
    let title: String
    var kind: TileKind? = nil
    let backdropURL: URL?
    let posterURL: URL?
    var progress: Double? = nil
    var cornerRadius: CGFloat = 10

    private var kindLabel: String { posterKindLabel(for: kind, defaultLabel: "CLIP") }
    private var hasProgress: Bool { (progress ?? 0) > 0 }

    var body: some View {
        Color.clear
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .overlay {
                ZStack(alignment: .bottomLeading) {
                    GeometricPosterArt(
                        title: title,
                        kindLabel: kindLabel,
                        wide: true,
                        extraBottomPadding: hasProgress ? 4 : 0
                    )
                    if let url = backdropURL ?? posterURL {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFill()
                            case .failure:
                                if let posterURL, posterURL != url {
                                    AsyncImage(url: posterURL) { p2 in
                                        if case .success(let img) = p2 {
                                            img.resizable().scaledToFill()
                                        }
                                    }
                                }
                            default:
                                EmptyView()
                            }
                        }
                    }

                    if let progress, progress > 0 {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(Color.black.opacity(0.55))
                                Rectangle()
                                    .fill(PTColor.brandHover)
                                    .frame(width: geo.size.width * min(1, max(0, progress)))
                            }
                            .frame(height: 3)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
            )
    }
}
