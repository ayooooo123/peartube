import SwiftUI

enum ListenSection: String, CaseIterable, Identifiable {
    case albums = "Albums"
    case artists = "Artists"
    case tracks = "Tracks"

    var id: String { rawValue }
}

@MainActor
struct ListenScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

    @State private var section: ListenSection = .albums
    @State private var savedOnly = false
    @State private var trackFilter = ""
    @State private var sortField: TrackSortField = .title
    @State private var sortAscending = true

    private var filteredAlbums: [LibraryTile] {
        savedOnly ? model.catalog.albums.filter(\.isFullySaved) : model.catalog.albums
    }

    private var filteredArtists: [ArtistGroup] {
        guard savedOnly else { return model.catalog.artists }
        return model.catalog.artists.compactMap { artist in
            let savedAlbums = artist.albums.filter(\.isFullySaved)
            guard !savedAlbums.isEmpty else { return nil }
            let keys = Set(savedAlbums.map(\.key))
            return ArtistGroup(id: artist.id, name: artist.name, albums: savedAlbums, tracks: artist.tracks.filter { keys.contains($0.albumKey) })
        }
    }

    private var filteredTracks: [TrackRow] {
        model.catalog.sortedTracks(filter: trackFilter, sortBy: sortField, ascending: sortAscending, savedOnly: savedOnly)
    }

    private var countLabel: String {
        switch section {
        case .albums: return plural(filteredAlbums.count, "album", "albums")
        case .artists: return plural(filteredArtists.count, "artist", "artists")
        case .tracks: return plural(filteredTracks.count, "track", "tracks")
        }
    }

    private let twoColumns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 10) {
                Picker("Listen", selection: $section) {
                    ForEach(ListenSection.allCases) { item in
                        Text(item.rawValue).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("listen.picker")

                HStack {
                    Text(countLabel)
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                    Spacer()
                    PTChipButton(title: "Saved here", selected: savedOnly, identifier: "listen.saved") {
                        savedOnly.toggle()
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            PTDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    switch section {
                    case .albums:
                        if filteredAlbums.isEmpty {
                            emptyListenState(savedOnly ? "No albums are saved on this device yet." : "No albums in your library yet.")
                        } else {
                            LazyVGrid(columns: twoColumns, spacing: 18) {
                                ForEach(filteredAlbums) { album in
                                    AlbumTileCard(album: album, model: model, music: music, width: nil, onNavigate: onNavigate)
                                }
                            }
                        }
                    case .artists:
                        if filteredArtists.isEmpty {
                            emptyListenState(savedOnly ? "No artists with saved albums yet." : "No artists in your library yet.")
                        } else {
                            LazyVGrid(columns: twoColumns, spacing: 18) {
                                ForEach(filteredArtists) { artist in
                                    Button { onNavigate(.artist(artist.name)) } label: {
                                        VStack(alignment: .leading, spacing: 8) {
                                            ArtistSleeveStack(albums: artist.albums)
                                            Text(artist.name)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(PTColor.ink)
                                                .lineLimit(1)
                                            Text(plural(artist.albums.count, "album", "albums"))
                                                .font(.caption)
                                                .foregroundStyle(PTColor.dim)
                                                .lineLimit(1)
                                        }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("listen.artist.\(artist.id)")
                                }
                            }
                        }
                    case .tracks:
                        tracksToolbar
                        if filteredTracks.isEmpty {
                            emptyListenState(trackFilter.isEmpty ? "No tracks in your library yet." : "No tracks match \"\(trackFilter)\".")
                        } else {
                            let list = filteredTracks
                            LazyVStack(spacing: 0) {
                                ForEach(Array(list.enumerated()), id: \.element.id) { idx, row in
                                    ListenTrackRow(
                                        row: row,
                                        index: idx,
                                        list: list,
                                        sourceLabel: trackFilter.isEmpty ? "All tracks" : "Tracks · \(trackFilter)",
                                        music: music,
                                        onOpenAlbum: { onNavigate(.album(row.albumKey)) }
                                    )
                                    PTDivider()
                                }
                            }
                        }
                    }
                }
                .padding(16)
            }
            .background(PTColor.bg)
            .refreshable { await model.refresh() }
        }
        .background(PTColor.bg)
    }

    private var tracksToolbar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "line.3.horizontal.decrease")
                    .foregroundStyle(PTColor.dim)
                TextField("Filter tracks", text: $trackFilter)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .foregroundStyle(PTColor.ink)
                    .accessibilityIdentifier("listen.tracks.filter")
                if !trackFilter.isEmpty {
                    Button { trackFilter = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(PTColor.dim)
                    }
                    .accessibilityLabel("Clear track filter")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.control))
            .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))

            Menu {
                ForEach(TrackSortField.allCases) { field in
                    Button {
                        if sortField == field { sortAscending.toggle() }
                        else { sortField = field; sortAscending = (field != .size) }
                    } label: {
                        if sortField == field {
                            Label("\(field.rawValue) (\(sortAscending ? "A-Z" : "Z-A"))", systemImage: sortAscending ? "arrow.up" : "arrow.down")
                        } else {
                            Text(field.rawValue)
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Text("Sort: \(sortField.rawValue)")
                    Image(systemName: sortAscending ? "chevron.up" : "chevron.down").font(.caption2)
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(PTColor.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.control))
                .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))
            }
            .accessibilityIdentifier("listen.tracks.sort")
        }
    }

    private func emptyListenState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message)
                .font(.callout)
                .foregroundStyle(PTColor.dim)
            if model.entries.isEmpty {
                Button("Add to library") { model.showSettings = true }
                    .buttonStyle(PTPrimaryButtonStyle())
            }
        }
        .padding(.vertical, 28)
    }
}

/// Reusable album sleeve tile with quick Play button.
@MainActor
struct AlbumTileCard: View {
    let album: LibraryTile
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let width: CGFloat?
    let onNavigate: (AppRoute) -> Void

    private var isPlayingThisAlbum: Bool {
        music.currentTrack?.albumKey == album.key && music.isPlaying
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                Button { onNavigate(.album(album.key)) } label: {
                    SleeveView(hue: album.hue, seed: album.seed, monogram: album.monogramText, cornerRadius: 10)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(album.displayName) by \(album.artist.isEmpty ? "Unknown artist" : album.artist)")
                .accessibilityIdentifier("listen.album.\(album.key)")

                Button {
                    let tracks = model.catalog.tracks(forAlbum: album)
                    if music.currentTrack?.albumKey == album.key {
                        music.togglePlayPause()
                    } else {
                        music.playTrackList(tracks, startIndex: 0, sourceLabel: album.displayName)
                    }
                } label: {
                    Image(systemName: isPlayingThisAlbum ? "pause.fill" : "play.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(PTColor.bg)
                        .frame(width: 34, height: 34)
                        .background(PTColor.ink, in: Circle())
                }
                .padding(8)
                .accessibilityLabel(isPlayingThisAlbum ? "Pause \(album.displayName)" : "Play \(album.displayName)")
                .accessibilityIdentifier("listen.album.play.\(album.key)")
            }

            Button { onNavigate(.album(album.key)) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(album.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(music.currentTrack?.albumKey == album.key ? PTColor.brandRing : PTColor.ink)
                        .lineLimit(1)
                    Text(album.artist.isEmpty ? "Unknown artist" : album.artist)
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .frame(width: width, alignment: .leading)
    }
}

@MainActor
private struct ListenTrackRow: View {
    let row: TrackRow
    let index: Int
    let list: [TrackRow]
    let sourceLabel: String
    @ObservedObject var music: MusicController
    let onOpenAlbum: () -> Void

    private var isCurrent: Bool { music.isCurrentTrack(row.entry.key) }

    var body: some View {
        HStack(spacing: 12) {
            Button {
                if isCurrent {
                    music.togglePlayPause()
                } else {
                    music.playTrackList(list, startIndex: index, sourceLabel: sourceLabel)
                }
            } label: {
                HStack(spacing: 12) {
                    SleeveView(hue: row.hue, seed: row.seed, monogram: row.monogramText, cornerRadius: 6)
                        .frame(width: 42, height: 42)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .font(.subheadline.weight(isCurrent ? .semibold : .regular))
                            .foregroundStyle(isCurrent ? PTColor.brandRing : PTColor.ink)
                            .lineLimit(1)
                        Text("\(row.displayArtist) · \(row.albumTitle)")
                            .font(.caption)
                            .foregroundStyle(PTColor.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if isCurrent {
                        Image(systemName: music.isPlaying ? "waveform" : "pause.fill")
                            .font(.caption)
                            .foregroundStyle(PTColor.brand)
                    } else if row.entry.size > 0 {
                        Text(bytes(row.entry.size))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PTColor.dim)
                    }
                }
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("listen.track.\(row.entry.key)")

            Menu {
                Button("Play next", systemImage: "text.insert") { music.playNext([row], sourceLabel: row.albumTitle) }
                Button("Play last", systemImage: "text.append") { music.playLast([row], sourceLabel: row.albumTitle) }
                Button("Open album", systemImage: "square.stack") { onOpenAlbum() }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(PTColor.dim)
                    .frame(width: 36, height: 44)
            }
            .accessibilityLabel("More actions for \(row.title)")
        }
    }
}

// MARK: - Album Detail Screen

@MainActor
struct AlbumScreen: View {
    let albumKey: String
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

    private var album: LibraryTile? { model.catalog.tile(forKey: albumKey) }

    var body: some View {
        ScrollView {
            if let album {
                let tracks = model.catalog.tracks(forAlbum: album)
                let moreByArtist = model.catalog.albums.filter {
                    $0.key != album.key && !album.artist.isEmpty && CatalogText.fold($0.artist) == CatalogText.fold(album.artist)
                }

                VStack(alignment: .leading, spacing: 20) {
                    // Header
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .top, spacing: 16) {
                            SleeveView(hue: album.hue, seed: album.seed, monogram: album.monogramText, cornerRadius: 12)
                                .frame(width: 128, height: 128)

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Album")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.dim)
                                Text(album.displayName)
                                    .font(.title3.weight(.bold))
                                    .foregroundStyle(PTColor.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                if !album.artist.isEmpty {
                                    Button(album.artist) { onNavigate(.artist(album.artist)) }
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(PTColor.brandRing)
                                        .accessibilityIdentifier("album.artistLink")
                                }
                                Text("\(album.lineText) · \(album.stateLabel)")
                                    .font(.caption)
                                    .foregroundStyle(album.isFullySaved ? PTColor.ok : PTColor.dim)
                                if album.isAllYouTube {
                                    Text("YouTube · Lossy")
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(PTColor.warn)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(PTColor.raised, in: Capsule())
                                        .overlay(Capsule().strokeBorder(PTColor.line, lineWidth: 1))
                                }
                            }
                        }

                        // Primary actions
                        HStack(spacing: 10) {
                            Button {
                                music.playTrackList(tracks, startIndex: 0, sourceLabel: album.displayName, shuffleOn: false)
                            } label: {
                                Label("Play", systemImage: "play.fill")
                            }
                            .buttonStyle(PTPrimaryButtonStyle())
                            .accessibilityIdentifier("album.play")

                            Button {
                                music.playTrackList(tracks, startIndex: nil, sourceLabel: album.displayName, shuffleOn: true)
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                            }
                            .buttonStyle(PTQuietButtonStyle())
                            .accessibilityIdentifier("album.shuffle")

                            Menu {
                                Button("Play next", systemImage: "text.insert") { music.playNext(tracks, sourceLabel: album.displayName) }
                                Button("Play last", systemImage: "text.append") { music.playLast(tracks, sourceLabel: album.displayName) }
                                if let uri = album.firstEntry?.magnetURL, !uri.isEmpty {
                                    ShareLink("Share link", item: uri)
                                    Button("Show sharing QR", systemImage: "qrcode") { model.shareURI = uri }
                                }
                                if let first = album.firstEntry, model.canDelete(first) {
                                    Button("Delete album from channel", systemImage: "trash", role: .destructive) {
                                        Task {
                                            for key in album.keys { await model.removeChannelEntry(key) }
                                        }
                                    }
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .foregroundStyle(PTColor.ink)
                                    .frame(width: 42, height: 42)
                                    .background(PTColor.raised, in: RoundedRectangle(cornerRadius: PTRadius.control))
                                    .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))
                            }
                            .accessibilityLabel("More")
                            .accessibilityIdentifier("album.more")
                        }
                    }

                    PTDivider()

                    // Tracklist
                    let discs = Array(Set(tracks.map(\.disc))).sorted()
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if discs.count > 1 {
                            ForEach(discs, id: \.self) { disc in
                                Text("Disc \(disc)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.dim)
                                    .padding(.top, 12)
                                    .padding(.bottom, 6)
                                let discTracks = tracks.filter { $0.disc == disc }
                                ForEach(discTracks) { row in
                                    if let fullIdx = tracks.firstIndex(of: row) {
                                        albumTrackRow(row: row, index: fullIdx, allTracks: tracks, album: album)
                                        PTDivider()
                                    }
                                }
                            }
                        } else {
                            ForEach(Array(tracks.enumerated()), id: \.element.id) { idx, row in
                                albumTrackRow(row: row, index: idx, allTracks: tracks, album: album)
                                PTDivider()
                            }
                        }
                    }

                    // More by artist
                    if !moreByArtist.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            PTSectionHeader(title: "More by \(album.artist)")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(alignment: .top, spacing: 14) {
                                    ForEach(moreByArtist) { sibling in
                                        AlbumTileCard(album: sibling, model: model, music: music, width: 136, onNavigate: onNavigate)
                                    }
                                }
                            }
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(16)
            } else {
                Text("This album is no longer in your library.")
                    .foregroundStyle(PTColor.dim)
                    .padding(24)
            }
        }
        .background(PTColor.bg)
        .navigationTitle(album?.displayName ?? "Album")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func albumTrackRow(row: TrackRow, index: Int, allTracks: [TrackRow], album: LibraryTile) -> some View {
        let isCurrent = music.isCurrentTrack(row.entry.key)
        let diffArtist = !row.artist.isEmpty && row.artist != album.artist ? row.artist : nil
        let notSaved = row.entry.saved ? nil : whereLabel(for: row.entry)
        let copiesNote = row.copies > 1 ? "\(row.copies) copies" : nil
        let subtitle = [diffArtist, notSaved, copiesNote].compactMap { $0 }.joined(separator: " · ")

        return HStack(spacing: 12) {
            Button {
                if isCurrent {
                    music.togglePlayPause()
                } else {
                    music.playTrackList(allTracks, startIndex: index, sourceLabel: album.displayName)
                }
            } label: {
                HStack(spacing: 12) {
                    Group {
                        if isCurrent {
                            Image(systemName: music.isPlaying ? "waveform" : "pause.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(PTColor.brand)
                        } else {
                            Text(row.track > 0 ? "\(row.track)" : row.number)
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(PTColor.dim)
                        }
                    }
                    .frame(width: 28, alignment: .trailing)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .font(.subheadline.weight(isCurrent ? .semibold : .regular))
                            .foregroundStyle(isCurrent ? PTColor.brandRing : PTColor.ink)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if !subtitle.isEmpty {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(PTColor.dim)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    if row.entry.size > 0 {
                        Text(bytes(row.entry.size))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(PTColor.dim)
                    }
                }
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("album.track.\(row.entry.key)")

            Menu {
                Button("Play next", systemImage: "text.insert") { music.playNext([row], sourceLabel: album.displayName) }
                Button("Play last", systemImage: "text.append") { music.playLast([row], sourceLabel: album.displayName) }
                if !row.entry.locked {
                    if model.downloads[row.entry.key] != nil {
                        Button("Cancel download", systemImage: "xmark.circle", role: .destructive) { model.cancelDownload(row.entry.key) }
                    } else {
                        Button("Download", systemImage: "arrow.down.circle") { model.download(row.entry) }
                    }
                }
                if !row.entry.magnetURL.isEmpty {
                    ShareLink("Share link", item: row.entry.magnetURL)
                }
                if model.canDelete(row.entry) {
                    Button("Delete from channel", systemImage: "trash", role: .destructive) {
                        Task { await model.removeChannelEntry(row.entry.key) }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(PTColor.dim)
                    .frame(width: 34, height: 44)
            }
            .accessibilityLabel("More actions for \(row.title)")
        }
    }
}

// MARK: - Artist Detail Screen

@MainActor
struct ArtistScreen: View {
    let artistName: String
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

    @State private var showAllTracks = false
    private let twoColumns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    private var artist: ArtistGroup? { model.catalog.artist(named: artistName) }

    var body: some View {
        ScrollView {
            if let artist {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Artist")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PTColor.dim)
                        Text(artist.name)
                            .font(.title.weight(.bold))
                            .foregroundStyle(PTColor.ink)
                        Text("\(plural(artist.albums.count, "album", "albums")) · \(plural(artist.tracks.count, "track", "tracks"))")
                            .font(.subheadline)
                            .foregroundStyle(PTColor.dim)

                        HStack(spacing: 10) {
                            Button {
                                music.playTrackList(artist.tracks, startIndex: 0, sourceLabel: artist.name, shuffleOn: false)
                            } label: {
                                Label("Play", systemImage: "play.fill")
                            }
                            .buttonStyle(PTPrimaryButtonStyle())
                            .accessibilityIdentifier("artist.play")

                            Button {
                                music.playTrackList(artist.tracks, startIndex: nil, sourceLabel: artist.name, shuffleOn: true)
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                            }
                            .buttonStyle(PTQuietButtonStyle())
                            .accessibilityIdentifier("artist.shuffle")

                            Menu {
                                Button("Play next", systemImage: "text.insert") { music.playNext(artist.tracks, sourceLabel: artist.name) }
                                Button("Play last", systemImage: "text.append") { music.playLast(artist.tracks, sourceLabel: artist.name) }
                                Button("Search other relays", systemImage: "magnifyingglass") {
                                    model.openSearch(query: artist.name, askRelays: true)
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .foregroundStyle(PTColor.ink)
                                    .frame(width: 42, height: 42)
                                    .background(PTColor.raised, in: RoundedRectangle(cornerRadius: PTRadius.control))
                                    .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))
                            }
                            .accessibilityLabel("More")
                        }
                        .padding(.top, 6)
                    }

                    // Albums
                    VStack(alignment: .leading, spacing: 12) {
                        PTSectionHeader(title: "Albums")
                        LazyVGrid(columns: twoColumns, spacing: 18) {
                            ForEach(artist.albums) { album in
                                AlbumTileCard(album: album, model: model, music: music, width: nil, onNavigate: onNavigate)
                            }
                        }
                    }

                    // Tracks (first 8 + Show all N)
                    if !artist.tracks.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            PTSectionHeader(title: "Tracks")
                            let displayed = showAllTracks ? artist.tracks : Array(artist.tracks.prefix(8))
                            LazyVStack(spacing: 0) {
                                ForEach(Array(displayed.enumerated()), id: \.element.id) { idx, row in
                                    ListenTrackRow(
                                        row: row,
                                        index: idx,
                                        list: artist.tracks,
                                        sourceLabel: artist.name,
                                        music: music,
                                        onOpenAlbum: { onNavigate(.album(row.albumKey)) }
                                    )
                                    PTDivider()
                                }
                            }
                            if !showAllTracks && artist.tracks.count > 8 {
                                Button("Show all \(artist.tracks.count)") { showAllTracks = true }
                                    .buttonStyle(PTQuietButtonStyle(compact: true))
                                    .padding(.top, 6)
                                    .accessibilityIdentifier("artist.showAllTracks")
                            }
                        }
                    }
                }
                .padding(16)
            } else {
                Text("This artist is no longer in your library.")
                    .foregroundStyle(PTColor.dim)
                    .padding(24)
            }
        }
        .background(PTColor.bg)
        .navigationTitle(artistName)
        .navigationBarTitleDisplayMode(.inline)
    }
}
