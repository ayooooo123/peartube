import SwiftUI

/// Design tokens from `design/tokens.json` (dark theme, violet brand).
enum PTColor {
    static let bg = Color(hex: 0x08090C)
    static let surface = Color(hex: 0x101218)
    static let raised = Color(hex: 0x171A22)
    static let line = Color(hex: 0x232733)
    static let ink = Color(hex: 0xF2F4F8)
    static let dim = Color(hex: 0x98A0B3)
    static let brand = Color(hex: 0x9147FF)
    static let brandHover = Color(hex: 0xA866FF)
    static let brandRing = Color(hex: 0xB98BFF)
    static let ok = Color(hex: 0x45D08A)
    static let warn = Color(hex: 0xE8B45C)
    static let bad = Color(hex: 0xFF7D7D)
}

enum PTRadius {
    static let control: CGFloat = 10
    static let card: CGFloat = 14
    static let panel: CGFloat = 18
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }

    /// Converts CSS-style HSL (hue in degrees 0..<360, saturation 0...1, lightness 0...1) to sRGB Color.
    static func hsl(hue: Double, saturation: Double, lightness: Double) -> Color {
        let h = ((hue.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
        let c = (1.0 - abs(2.0 * lightness - 1.0)) * saturation
        let x = c * (1.0 - abs((h / 60.0).truncatingRemainder(dividingBy: 2.0) - 1.0))
        let m = lightness - c / 2.0
        let (r, g, b): (Double, Double, Double)
        switch h {
        case 0..<60: (r, g, b) = (c, x, 0)
        case 60..<120: (r, g, b) = (x, c, 0)
        case 120..<180: (r, g, b) = (0, c, x)
        case 180..<240: (r, g, b) = (0, x, c)
        case 240..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return Color(.sRGB, red: r + m, green: g + m, blue: b + m, opacity: 1.0)
    }
}

/// High-contrast white primary button inside atmospheric hero panels.
struct PTHeroPrimaryButtonStyle: ButtonStyle {
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.bold) : .callout.weight(.bold))
            .foregroundStyle(Color(hex: 0x111111))
            .padding(.horizontal, compact ? 14 : 18)
            .padding(.vertical, compact ? 9 : 11)
            .background(
                Color.white.opacity(configuration.isPressed ? 0.84 : 1.0),
                in: RoundedRectangle(cornerRadius: compact ? PTRadius.control : 12)
            )
    }
}

/// Translucent frosted secondary button inside atmospheric hero panels.
struct PTHeroSecondaryButtonStyle: ButtonStyle {
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        let radius: CGFloat = compact ? PTRadius.control : 12
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .callout.weight(.semibold))
            .foregroundStyle(Color.white)
            .padding(.horizontal, compact ? 13 : 16)
            .padding(.vertical, compact ? 9 : 11)
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: radius)
                        .fill(.ultraThinMaterial)
                        .opacity(0.32)
                    RoundedRectangle(cornerRadius: radius)
                        .fill(Color.white.opacity(configuration.isPressed ? 0.34 : 0.16))
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.white.opacity(0.28), lineWidth: 1)
            )
    }
}

/// Wrapping horizontal layout for hero action rows so buttons never truncate on narrow screens.
struct PTWrapLayout: Layout {
    var spacing: CGFloat = 8
    var rowSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            usedWidth = max(usedWidth, x + size.width)
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return CGSize(width: min(maxWidth, usedWidth), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}

/// Primary action button: light fill on dark background, matching `design/unified-library.md`.
struct PTPrimaryButtonStyle: ButtonStyle {
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.semibold) : .callout.weight(.semibold))
            .foregroundStyle(PTColor.bg)
            .padding(.horizontal, compact ? 14 : 18)
            .padding(.vertical, compact ? 9 : 11)
            .background(PTColor.ink.opacity(configuration.isPressed ? 0.82 : 1.0), in: RoundedRectangle(cornerRadius: PTRadius.control))
    }
}

/// Quiet secondary action button: raised dark surface with a 1pt border.
struct PTQuietButtonStyle: ButtonStyle {
    var compact = false
    var active = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .subheadline.weight(.medium) : .callout.weight(.medium))
            .foregroundStyle(active ? PTColor.brandRing : PTColor.ink)
            .padding(.horizontal, compact ? 12 : 16)
            .padding(.vertical, compact ? 8 : 10)
            .background(
                (active ? PTColor.brand.opacity(0.18) : PTColor.raised)
                    .opacity(configuration.isPressed ? 0.75 : 1.0),
                in: RoundedRectangle(cornerRadius: PTRadius.control)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PTRadius.control)
                    .strokeBorder(active ? PTColor.brand.opacity(0.7) : PTColor.line, lineWidth: 1)
            )
    }
}

/// Capsule filter chip used in Watch, Listen, and Discover.
struct PTChipButton: View {
    let title: String
    var count: Int? = nil
    var selected: Bool = false
    var identifier: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                if let count {
                    Text("\(count)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(selected ? PTColor.brandRing : PTColor.dim)
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? PTColor.ink : PTColor.dim)
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(selected ? PTColor.brand.opacity(0.22) : PTColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? PTColor.brand : PTColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .modifier(OptionalIdentifier(id: identifier))
    }
}

struct OptionalIdentifier: ViewModifier {
    let id: String?
    func body(content: Content) -> some View {
        if let id { content.accessibilityIdentifier(id) }
        else { content }
    }
}

struct PTSectionHeader: View {
    let title: String
    var actionTitle: String? = nil
    var actionIdentifier: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(PTColor.ink)
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(PTColor.dim)
                    .modifier(OptionalIdentifier(id: actionIdentifier))
            }
        }
    }
}

struct PTDivider: View {
    var body: some View {
        Rectangle().fill(PTColor.line).frame(height: 1)
    }
}

// MARK: - Formatting helpers matching design/unified-library.md

func plural(_ n: Int, _ one: String, _ many: String) -> String {
    "\(n) \(n == 1 ? one : many)"
}

/// Formats remaining time in words: "1 h 36 min left", "31 min left".
func timeLeftText(seconds: Double) -> String {
    let totalMinutes = max(1, Int((max(0, seconds) / 60.0).rounded()))
    let hours = totalMinutes / 60
    let mins = totalMinutes % 60
    if hours > 0 {
        return mins > 0 ? "\(hours) h \(mins) min left" : "\(hours) h left"
    }
    return "\(mins) min left"
}

func whereLabel(for entry: MediaEntry) -> String {
    if entry.saved { return "Saved here" }
    if entry.cachedBytes > 0 { return "Partly saved" }
    return "On the network"
}
