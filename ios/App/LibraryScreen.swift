import SwiftUI

enum AppRoute: Hashable {
    case album(String)
    case artist(String)
    case title(String)
    case shelf(String)
}

extension Dictionary where Key == String, Value == Any {
    var selfKey: String { string("key") }
}

@MainActor
struct MainShellView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                topBar
                PTDivider()
                roomContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(PTColor.bg)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .album(let key):
                    AlbumScreen(albumKey: key, model: model, music: music) { path.append($0) }
                case .artist(let name):
                    ArtistScreen(artistName: name, model: model, music: music) { path.append($0) }
                case .title(let key):
                    TitleScreen(tileKey: key, model: model)
                case .shelf(let peer):
                    ShelfScreen(peer: peer, model: model)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if !model.session.isEmpty {
                    RemoteBar(model: model)
                }
                if music.hasQueue {
                    MusicDockBar(model: model, music: music)
                }
                PTDivider()
                bottomTabBar
            }
            .background(PTColor.surface.ignoresSafeArea(edges: .bottom))
        }
        .onChange(of: model.room) { _, _ in
            if !path.isEmpty { path = NavigationPath() }
        }
    }

    private var topBar: some View {
        HStack(spacing: 4) {
            Button { model.showDiagnostics = true } label: {
                HStack(spacing: 6) {
                    Text("PearTube")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    if model.busy {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(PTColor.brand)
                    }
                }
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("PearTube status")
            .accessibilityIdentifier("library.hood")

            Spacer(minLength: 4)

            liveNetworkPill

            if model.hasActiveJobs {
                Button {
                    model.showAdd = true
                } label: {
                    HStack(spacing: 5) {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(PTColor.brandRing)
                        Text(model.activeJobs.count > 1 ? "Adding \(model.activeJobs.count)…" : "Adding…")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(PTColor.ink)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(PTColor.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(PTColor.brand.opacity(0.6), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Adding to library")
                .accessibilityIdentifier("library.adding")
            }

            IconButton(title: "Add to library", icon: "plus", identifier: "library.add") {
                model.showAdd = true
            }
            .foregroundStyle(PTColor.ink)

            Button { model.chooseCast() } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "tv")
                        .font(.title3)
                        .foregroundStyle(PTColor.ink)
                        .frame(minWidth: 40, minHeight: 44)
                    if !model.session.isEmpty {
                        Circle()
                            .fill(PTColor.ok)
                            .frame(width: 8, height: 8)
                            .offset(x: -5, y: 9)
                    }
                }
            }
            .accessibilityLabel("TVs")
            .accessibilityIdentifier("library.cast")

            IconButton(title: "Settings", icon: "gearshape", identifier: "library.settings") {
                model.showSettings = true
            }
            .foregroundStyle(PTColor.ink)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
        .background(PTColor.bg)
    }

    private var liveNetworkPill: some View {
        let snap = model.networkSnapshot
        let totalRate = snap.downBps + snap.upBps
        let labelText: String = {
            if model.hasActiveJobs {
                return "\(snap.totalPeers)"
            }
            if totalRate >= 1024 {
                return "\(snap.totalPeers) · \(rateText(totalRate))"
            }
            return plural(snap.totalPeers, "peer", "peers")
        }()

        return Button {
            model.showDiagnostics = true
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(snap.totalPeers > 0 ? PTColor.ok : PTColor.dim.opacity(0.6))
                    .frame(width: 6, height: 6)
                Text(labelText)
                    .font(.caption.weight(.medium).monospacedDigit())
                    .foregroundStyle(snap.totalPeers > 0 ? PTColor.ink : PTColor.dim)
                    .lineLimit(1)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(PTColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(PTColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Network: \(plural(snap.totalPeers, "peer", "peers"))")
        .accessibilityIdentifier("library.network")
    }

    @ViewBuilder
    private var roomContent: some View {
        switch model.room {
        case .home:
            HomeScreen(model: model, music: music) { path.append($0) }
        case .listen:
            ListenScreen(model: model, music: music) { path.append($0) }
        case .watch:
            WatchScreen(model: model) { path.append($0) }
        case .discover:
            DiscoverScreen(model: model) { path.append($0) }
        case .search:
            SearchScreen(model: model, music: music) { path.append($0) }
        }
    }

    private var bottomTabBar: some View {
        HStack(spacing: 0) {
            ForEach(Room.allCases, id: \.self) { room in
                let selected = model.room == room
                Button {
                    if model.room == room {
                        if !path.isEmpty { path = NavigationPath() }
                    } else {
                        model.room = room
                    }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: selected ? room.activeIcon : room.icon)
                            .font(.system(size: 19, weight: selected ? .semibold : .regular))
                        Text(room.label)
                            .font(.caption2.weight(selected ? .semibold : .regular))
                            .lineLimit(1)
                    }
                    .foregroundStyle(selected ? PTColor.brand : PTColor.dim)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 9)
                    .padding(.bottom, 6)
                    .overlay(alignment: .top) {
                        if selected {
                            Rectangle()
                                .fill(PTColor.brand)
                                .frame(height: 2)
                                .padding(.horizontal, 14)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(room.label)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("nav.\(room.rawValue)")
            }
        }
        .background(PTColor.surface)
    }
}
