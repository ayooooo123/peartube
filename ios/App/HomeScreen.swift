import SwiftUI

@MainActor
struct HomeScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

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

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                if model.entries.isEmpty {
                    emptyLibrary
                } else {
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
