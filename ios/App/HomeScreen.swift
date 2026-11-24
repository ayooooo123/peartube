import SwiftUI

@MainActor
struct HomeScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

    @Environment(\.horizontalSizeClass) private var sizeClass

    private struct ContinueItem: Identifiable {
        enum Payload {
            case video(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)
            case music(track: TrackRow, pausedForVideo: Bool, progress: Double)
        }
        let id: String
        let updatedAt: Double
        let payload: Payload
    }

    private var continueItems: [ContinueItem] {
        var list: [ContinueItem] = model.continueVideos.map { item in
            ContinueItem(
                id: "v:\(item.entry.key)",
                updatedAt: item.progress.updatedAt,
                payload: .video(tile: item.tile, entry: item.entry, progress: item.progress)
            )
        }
        if music.canContinueOnHome, let track = music.currentTrack {
            list.append(ContinueItem(
                id: "m:\(track.entry.key)",
                updatedAt: music.updatedAt,
                payload: .music(track: track, pausedForVideo: music.pausedForVideo, progress: music.progressFraction)
            ))
        }
        return list.sorted { $0.updatedAt > $1.updatedAt }
    }

    private var hasAlbums: Bool { !model.catalog.albums.isEmpty }
    private var hasVideos: Bool { !model.catalog.allVideos.isEmpty }

    private var musicPrimary: Bool {
        guard hasAlbums else { return false }
        guard let latestVideo = model.continueVideos.first else { return true }
        if music.isPlaying { return true }
        return music.canContinueOnHome && music.updatedAt >= latestVideo.progress.updatedAt
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                if model.entries.isEmpty {
                    emptyLibrary
                } else {
                    if hasAlbums || hasVideos {
                        heroPairSection
                    }
                    if !continueItems.isEmpty {
                        keepPlayingSection
                    }
                    if !model.catalog.albums.isEmpty {
                        albumsRail
                    }
                    if !model.catalog.moviesAndSeries.isEmpty {
                        moviesAndSeriesRail
                    } else if !model.catalog.clips.isEmpty {
                        clipsRail
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(PTColor.bg)
        .refreshable { await model.refresh() }
    }

    @ViewBuilder
    private var heroPairSection: some View {
        if sizeClass == .regular && hasAlbums && hasVideos {
            HStack(alignment: .top, spacing: 12) {
                listenHeroCard
                    .frame(maxWidth: .infinity)
                watchHeroCard
                    .frame(maxWidth: .infinity)
            }
        } else {
            VStack(spacing: 12) {
                if hasAlbums {
                    listenHeroCard
                }
                if hasVideos {
                    watchHeroCard
                }
            }
        }
    }

    private var listenHeroCard: some View {
        let cur = music.currentTrack
        let collageAlbums = Array(model.catalog.albums.prefix(4))
        let headline = cur?.title ?? plural(model.catalog.tracks.count, "track", "tracks")
        let facts: String = {
            if let cur {
                return music.pausedForVideo ? "\(cur.displayArtist) · Paused for a video" : cur.displayArtist
            }
            return plural(model.catalog.albums.count, "album", "albums")
        }()

        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Listen")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PTColor.brandRing)
                    .textCase(.uppercase)

                Text(headline)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(PTColor.ink)
                    .lineLimit(2)

                Text(facts)
                    .font(.caption)
                    .foregroundStyle(music.pausedForVideo ? PTColor.warn : PTColor.dim)
                    .lineLimit(1)

                HStack(spacing: 8) {
                    if let cur {
                        let playLabel = music.isPlaying ? "Pause" : "Resume"
                        let playIcon = music.isPlaying ? "pause.fill" : "play.fill"
                        heroActionButton(
                            title: playLabel,
                            icon: playIcon,
                            primary: musicPrimary,
                            accessibilityLabel: "\(playLabel) \(cur.title)",
                            identifier: "home.hero.listen.play"
                        ) {
                            music.togglePlayPause()
                        }
                    } else {
                        heroActionButton(
                            title: "Play all",
                            icon: "play.fill",
                            primary: musicPrimary,
                            accessibilityLabel: "Play all music",
                            identifier: "home.hero.listen.play"
                        ) {
                            music.playTrackList(model.catalog.tracks, startIndex: 0, sourceLabel: "Library", shuffleOn: false)
                        }
                    }

                    heroActionButton(
                        title: "Shuffle",
                        icon: "shuffle",
                        primary: false,
                        accessibilityLabel: "Shuffle library",
                        identifier: "home.hero.listen.shuffle"
                    ) {
                        music.playTrackList(model.catalog.tracks, startIndex: nil, sourceLabel: "Library", shuffleOn: true)
                    }
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if !collageAlbums.isEmpty {
                albumCollage(collageAlbums)
                    .frame(width: 74, height: 74)
                    .accessibilityHidden(true)
            }
        }
        .padding(14)
        .background(
            LinearGradient(
                colors: [Color.hsl(hue: 258, saturation: 0.42, lightness: 0.16), PTColor.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: PTRadius.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PTRadius.card)
                .strokeBorder(PTColor.line, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func albumCollage(_ albums: [LibraryTile]) -> some View {
        if albums.count == 1, let first = albums.first {
            SleeveView(hue: first.hue, seed: first.seed, monogram: first.monogramText, cornerRadius: 8)
        } else {
            let tiles = Array(albums.prefix(4))
            VStack(spacing: 3) {
                HStack(spacing: 3) {
                    if tiles.indices.contains(0) {
                        SleeveView(hue: tiles[0].hue, seed: tiles[0].seed, monogram: tiles[0].monogramText, cornerRadius: 5)
                    }
                    if tiles.indices.contains(1) {
                        SleeveView(hue: tiles[1].hue, seed: tiles[1].seed, monogram: tiles[1].monogramText, cornerRadius: 5)
                    }
                }
                if tiles.count > 2 {
                    HStack(spacing: 3) {
                        if tiles.indices.contains(2) {
                            SleeveView(hue: tiles[2].hue, seed: tiles[2].seed, monogram: tiles[2].monogramText, cornerRadius: 5)
                        }
                        if tiles.indices.contains(3) {
                            SleeveView(hue: tiles[3].hue, seed: tiles[3].seed, monogram: tiles[3].monogramText, cornerRadius: 5)
                        } else {
                            Color.clear
                        }
                    }
                }
            }
        }
    }

    private var watchHeroCard: some View {
        let featured = model.continueVideos.first
        let hue = featured.map { Double(CatalogText.sleeveHash($0.tile.title) % 360) } ?? 20.0
        let headline = featured?.tile.title ?? plural(model.catalog.allVideos.count, "title", "titles")
        let facts: String = {
            if let f = featured {
                let epPrefix = f.entry.episode.map { "\($0) · " } ?? ""
                let remaining = f.progress.durationMs > 0
                    ? timeLeftText(seconds: f.progress.remainingSeconds)
                    : "Resume at \(clock(f.progress.positionMs))"
                return epPrefix + remaining
            }
            return "Films, series and clips"
        }()

        return VStack(alignment: .leading, spacing: 8) {
            Text("Watch")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PTColor.dim)
                .textCase(.uppercase)

            Text(headline)
                .font(.title3.weight(.bold))
                .foregroundStyle(PTColor.ink)
                .lineLimit(2)

            Text(facts)
                .font(.caption)
                .foregroundStyle(PTColor.dim)
                .lineLimit(1)

            if let f = featured, f.progress.fraction > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(PTColor.line)
                        Capsule()
                            .fill(PTColor.brand)
                            .frame(width: geo.size.width * max(0.03, min(1, f.progress.fraction)))
                    }
                }
                .frame(height: 4)
            }

            HStack(spacing: 8) {
                if let f = featured {
                    heroActionButton(
                        title: "Continue",
                        icon: "play.fill",
                        primary: !musicPrimary,
                        accessibilityLabel: "Continue \(f.tile.title)",
                        identifier: "home.hero.watch.continue"
                    ) {
                        model.play(f.entry)
                    }
                }

                heroActionButton(
                    title: "Play something",
                    icon: "die.face.5",
                    primary: featured == nil && !musicPrimary,
                    accessibilityLabel: "Play a random video",
                    identifier: "home.hero.watch.surprise"
                ) {
                    model.playRandomVideo()
                }
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            LinearGradient(
                colors: [Color.hsl(hue: hue, saturation: 0.36, lightness: 0.15), PTColor.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: PTRadius.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PTRadius.card)
                .strokeBorder(PTColor.line, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func heroActionButton(
        title: String,
        icon: String,
        primary: Bool,
        accessibilityLabel: String,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        if primary {
            Button(action: action) {
                Label(title, systemImage: icon)
            }
            .buttonStyle(PTPrimaryButtonStyle(compact: true))
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier(identifier)
        } else {
            Button(action: action) {
                Label(title, systemImage: icon)
            }
            .buttonStyle(PTQuietButtonStyle(compact: true))
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier(identifier)
        }
    }

    private var emptyLibrary: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.busy {
                HStack(spacing: 10) {
                    ProgressView().tint(PTColor.brand)
                    Text("Connecting to your sources…")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                }
            }
            Text("Nothing in your library yet.")
                .font(.title2.weight(.bold))
                .foregroundStyle(PTColor.ink)
            Text(model.settings.hasSources
                 ? "Your followed channels share their catalog once peers connect. You can also search other relays."
                 : "Follow a channel, open a link, or search other relays to start watching and listening.")
                .font(.subheadline)
                .foregroundStyle(PTColor.dim)
            HStack(spacing: 10) {
                Button("Add to library") { model.showSettings = true }
                    .buttonStyle(PTPrimaryButtonStyle())
                    .accessibilityIdentifier("library.addSource")
                Button("Search other relays") { model.openSearch() }
                    .buttonStyle(PTQuietButtonStyle())
                    .accessibilityIdentifier("home.searchRelays")
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 32)
    }

    private var keepPlayingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            PTSectionHeader(title: "Keep playing")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(continueItems.prefix(8)) { item in
                        switch item.payload {
                        case .video(let tile, let entry, let progress):
                            continueVideoCard(tile: tile, entry: entry, progress: progress)
                        case .music(let track, let pausedForVideo, let progress):
                            continueMusicCard(track: track, pausedForVideo: pausedForVideo, progress: progress)
                        }
                    }
                }
            }
        }
    }

    private func continueVideoCard(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress) -> some View {
        Button { model.play(entry) } label: {
            VStack(alignment: .leading, spacing: 8) {
                WideArtView(
                    title: tile.title,
                    backdropURL: model.backdropURL(imdb: tile.imdb),
                    posterURL: model.posterURL(imdb: tile.imdb),
                    progress: progress.fraction
                )
                .frame(width: 240)
                Text(entry.episode.map { "\(tile.title) · \($0)" } ?? tile.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PTColor.ink)
                    .lineLimit(1)
                Text(progress.durationMs > 0 ? timeLeftText(seconds: progress.remainingSeconds) : "Resume at \(clock(progress.positionMs))")
                    .font(.caption)
                    .foregroundStyle(PTColor.dim)
            }
            .frame(width: 240, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("library.continue.\(entry.key)")
    }

    private func continueMusicCard(track: TrackRow, pausedForVideo: Bool, progress: Double) -> some View {
        Button {
            if pausedForVideo || !music.isPlaying {
                music.togglePlayPause()
            } else {
                model.showMusicPlayer = true
            }
        } label: {
            HStack(spacing: 12) {
                SleeveView(hue: track.hue, seed: track.seed, monogram: track.monogramText, cornerRadius: 8)
                    .frame(width: 68, height: 68)
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.albumTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(1)
                    Text(track.title)
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                    Text(pausedForVideo ? "Paused for a video" : (music.isPlaying ? "Playing now" : "Resume album"))
                        .font(.caption)
                        .foregroundStyle(pausedForVideo ? PTColor.warn : PTColor.brandRing)
                        .lineLimit(1)
                    if progress > 0 {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(PTColor.line)
                                Capsule().fill(PTColor.brand).frame(width: geo.size.width * progress)
                            }
                        }
                        .frame(height: 3)
                        .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .frame(width: 248, alignment: .leading)
            .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
            .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("home.continue.music")
    }

    private var albumsRail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PTSectionHeader(title: "Albums", actionTitle: "All albums", actionIdentifier: "home.allAlbums") {
                model.room = .listen
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(model.catalog.albums.prefix(12)) { album in
                        AlbumTileCard(album: album, model: model, music: music, width: 146, onNavigate: onNavigate)
                    }
                }
            }
        }
    }

    private var moviesAndSeriesRail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PTSectionHeader(title: "Movies and series", actionTitle: "All video", actionIdentifier: "home.allVideo") {
                model.room = .watch
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(model.catalog.moviesAndSeries.prefix(14)) { tile in
                        VideoPosterCard(tile: tile, model: model, width: 138, onNavigate: onNavigate)
                    }
                }
            }
        }
    }

    private var clipsRail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PTSectionHeader(title: "Clips", actionTitle: "All clips", actionIdentifier: "home.allClips") {
                model.room = .watch
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(model.catalog.clips.prefix(12)) { tile in
                        ClipWideCard(tile: tile, model: model, width: 224, onNavigate: onNavigate)
                    }
                }
            }
        }
    }
}
