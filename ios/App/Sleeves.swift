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

/// 2:3 film/series poster loaded from the local relay `/v1/poster/<imdb>`, with a quiet fallback.
struct PosterView: View {
    let title: String
    let year: String?
    let url: URL?
    var cornerRadius: CGFloat = 10

    var body: some View {
        ZStack {
            PTColor.raised
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .aspectRatio(2.0 / 3.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(PTColor.line, lineWidth: 1)
        )
    }

    private var fallback: some View {
        VStack(spacing: 6) {
            Text(CatalogText.monogram(title))
                .font(.title2.weight(.bold))
                .foregroundStyle(PTColor.dim)
            if let year, !year.isEmpty {
                Text(year)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(PTColor.dim.opacity(0.8))
            }
        }
        .padding(8)
    }
}

/// 16:9 wide tile artwork for Keep playing/watching and Clips.
struct WideArtView: View {
    let title: String
    let backdropURL: URL?
    let posterURL: URL?
    var progress: Double? = nil
    var cornerRadius: CGFloat = 10

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            PTColor.raised
            if let url = backdropURL ?? posterURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        if let posterURL, posterURL != url {
                            AsyncImage(url: posterURL) { p2 in
                                if case .success(let img) = p2 { img.resizable().scaledToFill() }
                                else { letterFallback }
                            }
                        } else {
                            letterFallback
                        }
                    default:
                        letterFallback
                    }
                }
            } else {
                letterFallback
            }

            if let progress, progress > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.black.opacity(0.55))
                        Rectangle().fill(PTColor.brand).frame(width: geo.size.width * min(1, max(0, progress)))
                    }
                    .frame(height: 3)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
        .aspectRatio(16.0 / 9.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(PTColor.line, lineWidth: 1)
        )
    }

    private var letterFallback: some View {
        Text(String(CatalogText.monogram(title).prefix(1)))
            .font(.title.weight(.bold))
            .foregroundStyle(PTColor.dim)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
