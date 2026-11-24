import SwiftUI

// MARK: - Discover Room

@MainActor
struct DiscoverScreen: View {
    @ObservedObject var model: AppModel
    let onNavigate: (AppRoute) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Discover")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(PTColor.ink)
                    Text("Search Soulseek, YouTube, SoundCloud, Rumble, and other relays, or follow channels on your network.")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                    Button {
                        model.openSearch()
                    } label: {
                        Label("Search sources & relays", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(PTPrimaryButtonStyle())
                    .accessibilityIdentifier("discover.searchRelays")
                }

                // Shelves you visited (persisted in visited-shelves.json)
                if !model.visitedShelves.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        PTSectionHeader(title: "Shelves you visited")
                        VStack(spacing: 0) {
                            ForEach(model.visitedShelves) { shelf in
                                HStack(spacing: 12) {
                                    Button {
                                        onNavigate(.shelf(shelf.peer))
                                    } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: "opticaldisc")
                                                .font(.title3)
                                                .foregroundStyle(PTColor.brandRing)
                                                .frame(width: 38, height: 38)
                                                .background(PTColor.surface, in: RoundedRectangle(cornerRadius: 8))
                                                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(PTColor.line, lineWidth: 1))
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(shelf.peer)
                                                    .font(.subheadline.weight(.semibold))
                                                    .foregroundStyle(PTColor.ink)
                                                    .lineLimit(1)
                                                Text(shelfSubtitle(shelf))
                                                    .font(.caption)
                                                    .foregroundStyle(PTColor.dim)
                                                    .lineLimit(1)
                                            }
                                            Spacer()
                                            Image(systemName: "chevron.right")
                                                .font(.caption)
                                                .foregroundStyle(PTColor.dim)
                                        }
                                        .padding(.vertical, 10)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("discover.shelf.\(shelf.peer)")
                                    .contextMenu {
                                        Button("Browse shelf", systemImage: "folder") {
                                            onNavigate(.shelf(shelf.peer))
                                        }
                                        Button("Remove from history", systemImage: "trash", role: .destructive) {
                                            model.removeVisitedShelf(peer: shelf.peer)
                                        }
                                    }
                                }
                                PTDivider()
                            }
                        }
                    }
                }

                // Channels on your network
                VStack(alignment: .leading, spacing: 12) {
                    PTSectionHeader(title: "Channels on your network")
                    if model.discovered.isEmpty {
                        Text("No channels found on your network right now. Nearby channels appear here automatically.")
                            .font(.subheadline)
                            .foregroundStyle(PTColor.dim)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(model.discovered, id: \.selfKey) { found in
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(found.string("title").isEmpty ? "Channel \(found.string("key").prefix(8))" : found.string("title"))
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(PTColor.ink)
                                        Text("Found on your network")
                                            .font(.caption)
                                            .foregroundStyle(PTColor.dim)
                                    }
                                    Spacer()
                                    Button("Follow") {
                                        Task {
                                            await model.addSource(SourceSpec(
                                                key: found.string("key"),
                                                kind: found.string("kind"),
                                                alias: found.string("title")
                                            ))
                                        }
                                    }
                                    .buttonStyle(PTQuietButtonStyle(compact: true))
                                    .accessibilityIdentifier("sources.follow.\(found.string("key"))")
                                }
                                .padding(.vertical, 12)
                                PTDivider()
                            }
                        }
                    }
                }

                // More from artists you have
                if !model.catalog.artists.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        PTSectionHeader(title: "More from artists you have")
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
                            ForEach(model.catalog.artists.prefix(24)) { artist in
                                Button {
                                    model.openSearch(query: artist.name, askRelays: true)
                                } label: {
                                    Text(artist.name)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(PTColor.ink)
                                        .lineLimit(1)
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .background(PTColor.surface, in: Capsule())
                                        .overlay(Capsule().strokeBorder(PTColor.line, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("discover.artist.\(artist.id)")
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

    private func shelfSubtitle(_ shelf: VisitedShelf) -> String {
        var parts: [String] = []
        if let folders = shelf.folderCount, folders > 0 {
            parts.append(plural(folders, "album", "albums"))
        }
        if let tracks = shelf.trackCount, tracks > 0 {
            parts.append(plural(tracks, "track", "tracks"))
        }
        return parts.isEmpty ? "Soulseek peer shelf" : parts.joined(separator: " · ")
    }
}

// MARK: - Search Room

@MainActor
struct SearchScreen: View {
    @ObservedObject var model: AppModel
    @ObservedObject var music: MusicController
    let onNavigate: (AppRoute) -> Void

    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Single search field
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(PTColor.dim)
                TextField("Search · Blue Train", text: $model.query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .foregroundStyle(PTColor.ink)
                    .submitLabel(model.contextualQuery ? .go : .search)
                    .focused($fieldFocused)
                    .accessibilityIdentifier("search.field")
                    .onSubmit {
                        Task {
                            if model.contextualQuery { await model.openURI(model.query) }
                            else { await model.searchAll(model.query) }
                        }
                    }
                if !model.query.isEmpty {
                    IconButton(title: "Clear search", icon: "xmark.circle.fill", identifier: "search.clear") {
                        model.query = ""
                    }
                    .foregroundStyle(PTColor.dim)
                }
                IconButton(title: "Scan QR code", icon: "qrcode.viewfinder", identifier: "search.scan") {
                    model.showScanner = true
                }
                .foregroundStyle(PTColor.dim)
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.control))
            .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(fieldFocused ? PTColor.brand : PTColor.line, lineWidth: 1))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            PTDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if model.contextualQuery {
                        Button { Task { await model.openURI(model.query) } } label: {
                            HStack {
                                Label(isHTTPURL(model.query) ? "Identify & add link" : "Open link", systemImage: "link")
                                Spacer()
                                Image(systemName: "arrow.right")
                            }
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(PTColor.bg)
                            .padding(14)
                            .background(PTColor.ink, in: RoundedRectangle(cornerRadius: PTRadius.control))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search.open")
                    } else if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        emptySearchPrompt
                    } else {
                        let local = model.catalog.search(model.query)
                        inYourLibrarySection(local)
                        fromYourSourcesSection
                        onOtherRelaysSection
                    }
                }
                .padding(16)
            }
            .background(PTColor.bg)
        }
        .background(PTColor.bg)
        .onChange(of: model.focusSearchTrigger) { _, _ in
            fieldFocused = true
        }
    }

    private var emptySearchPrompt: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Search your library, sources, and relays")
                    .font(.headline)
                    .foregroundStyle(PTColor.ink)
                Text("Type a title, album, artist, or paste a web or PearTube link. Press Search to ask your sources and other relays.")
                    .font(.subheadline)
                    .foregroundStyle(PTColor.dim)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Sources")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PTColor.dim)
                sourceChipsRow
            }

            if !model.catalog.artists.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Artists in your library")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PTColor.dim)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.catalog.artists.prefix(8)) { artist in
                                PTChipButton(title: artist.name) {
                                    model.query = artist.name
                                    Task { await model.searchAll(artist.name) }
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 12)
    }

    private var sourceChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(MediaSourceKind.allCases) { source in
                    let count: Int? = {
                        guard model.sourceSearchQuery == model.query.trimmingCharacters(in: .whitespacesAndNewlines),
                              let resp = model.sourceSearchResponse else { return nil }
                        let n = resp.results(for: source).count
                        return n > 0 ? n : nil
                    }()
                    PTChipButton(
                        title: source.label,
                        count: count,
                        selected: model.enabledSources.contains(source),
                        identifier: "search.source.\(source.rawValue)"
                    ) {
                        model.toggleSource(source)
                    }
                }
            }
        }
    }

    // MARK: - In your library

    @ViewBuilder
    private func inYourLibrarySection(_ results: LibrarySearchResults) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            PTSectionHeader(title: "In your library")

            if results.isEmpty {
                Text("Nothing in your library matches \"\(model.query.trimmingCharacters(in: .whitespacesAndNewlines))\".")
                    .font(.subheadline)
                    .foregroundStyle(PTColor.dim)
            } else {
                if !results.albums.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Albums").font(.caption.weight(.semibold)).foregroundStyle(PTColor.dim)
                        ForEach(results.albums) { album in
                            Button { onNavigate(.album(album.key)) } label: {
                                HStack(spacing: 12) {
                                    SleeveView(hue: album.hue, seed: album.seed, monogram: album.monogramText, cornerRadius: 8)
                                        .frame(width: 46, height: 46)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(album.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(PTColor.ink).lineLimit(1)
                                        Text("\(album.artist.isEmpty ? "Unknown artist" : album.artist) · \(album.lineText)")
                                            .font(.caption).foregroundStyle(PTColor.dim).lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(PTColor.dim)
                                }
                                .padding(.vertical, 8)
                            }
                            .buttonStyle(.plain)
                            PTDivider()
                        }
                    }
                }

                if !results.tracks.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Tracks").font(.caption.weight(.semibold)).foregroundStyle(PTColor.dim)
                        ForEach(Array(results.tracks.prefix(20).enumerated()), id: \.element.id) { idx, row in
                            let isCurrent = music.isCurrentTrack(row.entry.key)
                            HStack(spacing: 12) {
                                Button {
                                    if isCurrent { music.togglePlayPause() }
                                    else { music.playTrackList(results.tracks, startIndex: idx, sourceLabel: "Search · \(model.query)") }
                                } label: {
                                    HStack(spacing: 12) {
                                        SleeveView(hue: row.hue, seed: row.seed, monogram: row.monogramText, cornerRadius: 6)
                                            .frame(width: 40, height: 40)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(row.title)
                                                .font(.subheadline.weight(isCurrent ? .semibold : .regular))
                                                .foregroundStyle(isCurrent ? PTColor.brandRing : PTColor.ink)
                                                .lineLimit(1)
                                            Text("\(row.displayArtist) · \(row.albumTitle)")
                                                .font(.caption).foregroundStyle(PTColor.dim).lineLimit(1)
                                        }
                                        Spacer()
                                        if isCurrent {
                                            Image(systemName: music.isPlaying ? "waveform" : "pause.fill")
                                                .font(.caption).foregroundStyle(PTColor.brand)
                                        }
                                    }
                                    .padding(.vertical, 8)
                                }
                                .buttonStyle(.plain)
                                Menu {
                                    Button("Play next", systemImage: "text.insert") { music.playNext([row], sourceLabel: row.albumTitle) }
                                    Button("Play last", systemImage: "text.append") { music.playLast([row], sourceLabel: row.albumTitle) }
                                    Button("Open album", systemImage: "square.stack") { onNavigate(.album(row.albumKey)) }
                                } label: {
                                    Image(systemName: "ellipsis").foregroundStyle(PTColor.dim).frame(width: 34, height: 40)
                                }
                            }
                            PTDivider()
                        }
                    }
                }

                if !results.moviesAndSeries.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Movies and series").font(.caption.weight(.semibold)).foregroundStyle(PTColor.dim)
                        ForEach(results.moviesAndSeries) { tile in
                            searchVideoRow(tile)
                            PTDivider()
                        }
                    }
                }

                if !results.clips.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Clips").font(.caption.weight(.semibold)).foregroundStyle(PTColor.dim)
                        ForEach(results.clips) { tile in
                            searchVideoRow(tile)
                            PTDivider()
                        }
                    }
                }
            }
        }
    }

    private func searchVideoRow(_ tile: LibraryTile) -> some View {
        let entry = tile.kind == .show ? model.seriesNext(tile.items.map(\.entry)) : tile.firstEntry
        return HStack(spacing: 12) {
            Button { onNavigate(.title(tile.key)) } label: {
                HStack(spacing: 12) {
                    if tile.kind == .clip {
                        WideArtView(title: tile.title, backdropURL: nil, posterURL: nil, cornerRadius: 6)
                            .frame(width: 64)
                    } else {
                        PosterView(title: tile.title, year: tile.year, url: model.posterURL(imdb: tile.imdb), cornerRadius: 6)
                            .frame(width: 38)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tile.title).font(.subheadline.weight(.semibold)).foregroundStyle(PTColor.ink).lineLimit(1)
                        Text("\(tile.lineText) · \(tile.stateLabel)").font(.caption).foregroundStyle(PTColor.dim).lineLimit(1)
                    }
                    Spacer()
                }
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if let entry, !entry.locked {
                Button("Play") { model.play(entry) }
                    .buttonStyle(PTPrimaryButtonStyle(compact: true))
                    .accessibilityIdentifier("library.entry.\(entry.key)")
            }
        }
    }

    // MARK: - From your sources

    private var fromYourSourcesSection: some View {
        let typed = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let asked = model.sourceSearchQuery == typed
        let selectedSources = MediaSourceKind.allCases.filter { model.enabledSources.contains($0) }

        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("From your sources")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(PTColor.ink)
                Spacer()
                if typed.count >= 2 && (!asked || !model.sourceSearchBusy) {
                    Button(asked ? "Search again" : "Search sources") {
                        Task { await model.searchSources(typed) }
                    }
                    .buttonStyle(PTQuietButtonStyle(compact: true))
                    .accessibilityIdentifier("search.askSources")
                }
            }

            sourceChipsRow

            if !asked {
                Text("Press Search or tap Search sources to look across \(selectedSources.isEmpty ? "your sources" : selectedSources.map(\.label).joined(separator: ", ")).")
                    .font(.subheadline)
                    .foregroundStyle(PTColor.dim)
            } else if model.sourceSearchBusy {
                HStack(spacing: 8) {
                    ProgressView().tint(PTColor.brand)
                    Text("Searching \(selectedSources.map(\.label).joined(separator: ", "))…")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                }
                .padding(.vertical, 6)
            } else if let err = model.sourceSearchError {
                Text(err)
                    .font(.subheadline)
                    .foregroundStyle(PTColor.bad)
            } else if let response = model.sourceSearchResponse {
                if response.totalResults == 0 && response.errors.isEmpty {
                    Text("No results from the selected sources.")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                } else {
                    ForEach(selectedSources) { source in
                        let items = response.results(for: source)
                        let err = response.errors[source.rawValue]
                        if !items.isEmpty || err != nil {
                            sourceGroupView(source: source, items: items, error: err)
                        }
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func sourceGroupView(source: MediaSourceKind, items: [SourceCandidate], error: String?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: source.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PTColor.brandRing)
                Text(source.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PTColor.ink)
                if !items.isEmpty {
                    Text("(\(source == .soulseek ? SoulseekAlbumGroup.group(items).count : items.count))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(PTColor.dim)
                }
                Spacer()
            }

            if let error {
                HStack(spacing: 10) {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(PTColor.warn)
                    Spacer()
                    if source == .soulseek && error.localizedCaseInsensitiveContains("config") {
                        Button("Settings") { model.showSettings = true }
                            .buttonStyle(PTQuietButtonStyle(compact: true))
                    }
                }
                .padding(10)
                .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.control))
                .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))
            }

            switch source {
            case .soulseek:
                let groups = SoulseekAlbumGroup.group(items)
                ForEach(groups.prefix(20)) { group in
                    soulseekGroupCard(group)
                }
            case .youtube:
                ForEach(items.prefix(15)) { item in
                    youtubeCard(item)
                }
            case .soundcloud:
                ForEach(items.prefix(15)) { item in
                    soundcloudCard(item)
                }
            case .rumble:
                ForEach(items.prefix(15)) { item in
                    rumbleCard(item)
                }
            }
        }
        .padding(.top, 4)
    }

    private func soulseekGroupCard(_ group: SoulseekAlbumGroup) -> some View {
        let stateKey = "slsk:\(group.id)"
        let state = model.saveStates[stateKey] ?? .idle
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(group.folderName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(2)
                    Text(soulseekMetaLine(group))
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Text(group.slots && group.queue == 0 ? "Ready" : (group.queue > 0 ? "Queue \(group.queue)" : "Peer"))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(group.slots && group.queue == 0 ? PTColor.ok : PTColor.dim)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(PTColor.raised, in: Capsule())
            }

            HStack(spacing: 8) {
                Button {
                    let filePayloads: [[String: Any]] = group.files.compactMap { f in
                        guard let name = f.filename else { return nil }
                        var d: [String: Any] = ["filename": name]
                        if let sz = f.size, sz > 0 { d["size"] = Int64(sz) }
                        return d
                    }
                    Task {
                        await model.mirrorSoulseekAlbum(
                            stateKey: stateKey,
                            peer: group.peer,
                            files: filePayloads,
                            title: group.folderName
                        )
                    }
                } label: {
                    saveButtonLabel("Save album", state: state)
                }
                .buttonStyle(PTPrimaryButtonStyle(compact: true))
                .disabled(state == .saving)
                .accessibilityIdentifier("source.soulseek.save.\(group.peer)")

                Button("Browse shelf") {
                    onNavigate(.shelf(group.peer))
                }
                .buttonStyle(PTQuietButtonStyle(compact: true))
                .accessibilityIdentifier("source.soulseek.browse.\(group.peer)")

                Spacer()
            }

            inlineErrorView(state)
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private func soulseekMetaLine(_ group: SoulseekAlbumGroup) -> String {
        var parts: [String] = [group.peer, plural(group.files.count, "track", "tracks")]
        if !group.qualityLabel.isEmpty { parts.append(group.qualityLabel) }
        if group.totalSize > 0 { parts.append(bytes(group.totalSize)) }
        return parts.joined(separator: " · ")
    }

    private func youtubeCard(_ item: SourceCandidate) -> some View {
        let state = model.saveStates[item.id] ?? .idle
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                sourceThumb(item.thumbnail)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(2)
                    Text(mediaMetaLine(author: item.displayAuthor, duration: item.length, extra: "AAC · 128 kbps"))
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                Button {
                    Task { await model.mirrorYouTubeTrack(item) }
                } label: {
                    saveButtonLabel("Save track", state: state)
                }
                .buttonStyle(PTPrimaryButtonStyle(compact: true))
                .disabled(state == .saving)
                .accessibilityIdentifier("source.youtube.save.\(item.videoId ?? item.id)")
                Spacer()
            }
            inlineErrorView(state)
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private func soundcloudCard(_ item: SourceCandidate) -> some View {
        let state = model.saveStates[item.id] ?? .idle
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                sourceThumb(item.thumbnail)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(2)
                    Text(mediaMetaLine(author: item.displayAuthor, duration: item.length, extra: "SoundCloud"))
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                Button {
                    Task { await model.mirrorSoundCloudTrack(item) }
                } label: {
                    saveButtonLabel("Save track", state: state)
                }
                .buttonStyle(PTPrimaryButtonStyle(compact: true))
                .disabled(state == .saving)
                .accessibilityIdentifier("source.soundcloud.save.\(item.trackId ?? item.id)")
                Spacer()
            }
            inlineErrorView(state)
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private func rumbleCard(_ item: SourceCandidate) -> some View {
        let videoState = model.saveStates["\(item.id):video"] ?? .idle
        let audioState = model.saveStates["\(item.id):audio"] ?? .idle
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                sourceThumb(item.thumbnail)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(2)
                    Text(mediaMetaLine(author: item.displayAuthor, duration: item.length, extra: "Rumble"))
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                Button {
                    Task { await model.mirrorRumbleItem(item, audio: false) }
                } label: {
                    saveButtonLabel("Save video", state: videoState)
                }
                .buttonStyle(PTPrimaryButtonStyle(compact: true))
                .disabled(videoState == .saving)
                .accessibilityIdentifier("source.rumble.saveVideo.\(item.rumbleId ?? item.id)")

                Button {
                    Task { await model.mirrorRumbleItem(item, audio: true) }
                } label: {
                    saveButtonLabel("Save audio", state: audioState)
                }
                .buttonStyle(PTQuietButtonStyle(compact: true))
                .disabled(audioState == .saving)
                .accessibilityIdentifier("source.rumble.saveAudio.\(item.rumbleId ?? item.id)")

                Spacer()
            }
            inlineErrorView(videoState)
            inlineErrorView(audioState)
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    @ViewBuilder
    private func sourceThumb(_ raw: String?) -> some View {
        let resolvedURL: URL? = {
            guard let raw, !raw.isEmpty else { return nil }
            if raw.hasPrefix("/") {
                return model.apiBaseURL?.appendingPathComponent(String(raw.dropFirst()))
            }
            return URL(string: raw)
        }()
        if let resolvedURL {
            AsyncImage(url: resolvedURL) { phase in
                if case .success(let img) = phase {
                    img.resizable().scaledToFill()
                } else {
                    PTColor.raised
                }
            }
            .frame(width: 56, height: 42)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(PTColor.line, lineWidth: 1))
        }
    }

    private func mediaMetaLine(author: String, duration: Double?, extra: String) -> String {
        var parts: [String] = []
        if !author.isEmpty { parts.append(author) }
        if let duration, duration > 0 { parts.append(clock(duration * 1000)) }
        if !extra.isEmpty { parts.append(extra) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func saveButtonLabel(_ title: String, state: InlineSaveState) -> some View {
        switch state {
        case .saving:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Saving…")
            }
        case .saved(let msg):
            Label(msg, systemImage: "checkmark")
        case .idle, .failed:
            Text(title)
        }
    }

    @ViewBuilder
    private func inlineErrorView(_ state: InlineSaveState) -> some View {
        if case .failed(let message) = state {
            Text(message)
                .font(.caption)
                .foregroundStyle(PTColor.bad)
        }
    }

    // MARK: - On other relays

    private var onOtherRelaysSection: some View {
        let typed = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let asked = model.globalQuery == typed
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("On other relays")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(PTColor.ink)
                Spacer()
                if typed.count >= 2 && (!asked || !model.globalBusy) {
                    Button(asked ? "Ask again" : "Ask other relays") {
                        Task { await model.searchGlobal(typed) }
                    }
                    .buttonStyle(PTQuietButtonStyle(compact: true))
                    .accessibilityIdentifier("search.askRelays")
                }
            }

            if !asked {
                Text("Press Search or tap Ask other relays to look on relays you do not follow.")
                    .font(.subheadline)
                    .foregroundStyle(PTColor.dim)
            } else if let err = model.globalError {
                Text(err).font(.subheadline).foregroundStyle(PTColor.bad)
            } else if model.globalRows.isEmpty {
                HStack(spacing: 8) {
                    if model.globalBusy { ProgressView().tint(PTColor.brand) }
                    Text(model.globalBusy ? "Asking relays…" : "No relay has it yet. Answers can take a few seconds.")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                }
            }

            if asked {
                VStack(spacing: 0) {
                    ForEach(model.globalRows, id: \.selfKey) { row in
                        let relays = Int(row.number("relays"))
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(row.string("title"))
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(PTColor.ink)
                                    .lineLimit(2)
                                Text("\(bytes(row.number("size"))) · \(plural(relays, "relay", "relays"))")
                                    .font(.caption)
                                    .foregroundStyle(PTColor.dim)
                            }
                            Spacer()
                            Button("Play") {
                                Task { await model.openURI(row.string("magnetUrl")) }
                            }
                            .buttonStyle(PTPrimaryButtonStyle(compact: true))
                            .accessibilityIdentifier("global.play.\(row.selfKey)")
                        }
                        .padding(.vertical, 10)
                        PTDivider()
                    }
                }
            }
        }
        .padding(.top, 8)
    }
}

// MARK: - Soulseek Shelf Browser

@MainActor
struct ShelfScreen: View {
    let peer: String
    @ObservedObject var model: AppModel
    @State private var shelf: SoulseekShelf?
    @State private var loading = true
    @State private var error: String?
    @State private var filterText = ""
    @State private var expandedFolders: Set<String> = []

    private var filteredFolders: [SoulseekFolder] {
        guard let shelf else { return [] }
        let q = filterText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return shelf.folders }
        return shelf.folders.filter { folder in
            folder.name.localizedCaseInsensitiveContains(q)
                || folder.path.localizedCaseInsensitiveContains(q)
                || folder.files.contains { $0.leafName.localizedCaseInsensitiveContains(q) }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(peer)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(PTColor.ink)
                    if let shelf {
                        Text("\(plural(shelf.folders.count, "album", "albums")) · \(plural(shelf.tracks, "track", "tracks")) · \(bytes(shelf.size))")
                            .font(.subheadline)
                            .foregroundStyle(PTColor.dim)
                    } else {
                        Text("Soulseek peer shelf")
                            .font(.subheadline)
                            .foregroundStyle(PTColor.dim)
                    }
                }

                if shelf != nil {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(PTColor.dim)
                        TextField("Filter shelf…", text: $filterText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(PTColor.ink)
                            .accessibilityIdentifier("shelf.filter")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.control))
                    .overlay(RoundedRectangle(cornerRadius: PTRadius.control).strokeBorder(PTColor.line, lineWidth: 1))
                }

                if loading {
                    HStack(spacing: 10) {
                        ProgressView().tint(PTColor.brand)
                        Text("Browsing \(peer)'s shelf…")
                            .font(.subheadline)
                            .foregroundStyle(PTColor.dim)
                    }
                    .padding(.vertical, 24)
                } else if let error {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(PTColor.bad)
                        Button("Try again") {
                            Task { await load(refresh: true) }
                        }
                        .buttonStyle(PTQuietButtonStyle(compact: true))
                    }
                    .padding(.vertical, 12)
                } else if filteredFolders.isEmpty {
                    Text(filterText.isEmpty ? "\(peer) has no shared audio files right now." : "No folders match \"\(filterText)\".")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                        .padding(.vertical, 16)
                } else {
                    ForEach(filteredFolders) { folder in
                        shelfFolderCard(folder)
                    }
                }
            }
            .padding(16)
        }
        .background(PTColor.bg)
        .navigationTitle("Shelf")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load(refresh: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(loading)
                .accessibilityIdentifier("shelf.refresh")
            }
        }
        .task(id: peer) {
            await load(refresh: false)
        }
    }

    private func shelfFolderCard(_ folder: SoulseekFolder) -> some View {
        let stateKey = "shelf:\(peer)|\(folder.id)"
        let state = model.saveStates[stateKey] ?? .idle
        let expanded = expandedFolders.contains(folder.id)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Button {
                    if expanded { expandedFolders.remove(folder.id) }
                    else { expandedFolders.insert(folder.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(folder.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PTColor.ink)
                            .multilineTextAlignment(.leading)
                        Text(folderMetaLine(folder))
                            .font(.caption)
                            .foregroundStyle(PTColor.dim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)

                Button {
                    let payloads: [[String: Any]] = folder.files.map { f in
                        var d: [String: Any] = ["filename": f.filename]
                        if f.size > 0 { d["size"] = Int64(f.size) }
                        return d
                    }
                    Task {
                        await model.mirrorSoulseekAlbum(
                            stateKey: stateKey,
                            peer: peer,
                            files: payloads,
                            title: folder.name
                        )
                    }
                } label: {
                    switch state {
                    case .saving:
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.mini)
                            Text("Saving…")
                        }
                    case .saved(let msg):
                        Label(msg, systemImage: "checkmark")
                    case .idle, .failed:
                        Text("Save album")
                    }
                }
                .buttonStyle(PTPrimaryButtonStyle(compact: true))
                .disabled(state == .saving)
                .accessibilityIdentifier("shelf.save.\(folder.name)")
            }

            if case .failed(let message) = state {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(PTColor.bad)
            }

            if expanded {
                PTDivider()
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(folder.files) { file in
                        HStack(spacing: 8) {
                            Text(file.leafName)
                                .font(.caption)
                                .foregroundStyle(PTColor.ink)
                                .lineLimit(1)
                            Spacer()
                            if file.size > 0 {
                                Text(bytes(file.size))
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(PTColor.dim)
                            }
                        }
                    }
                }
            }
        }
        .padding(12)
        .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
        .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
    }

    private func folderMetaLine(_ folder: SoulseekFolder) -> String {
        var parts: [String] = [plural(folder.files.count, "track", "tracks")]
        if !folder.qualityLabel.isEmpty { parts.append(folder.qualityLabel) }
        if folder.totalSize > 0 { parts.append(bytes(folder.totalSize)) }
        return parts.joined(separator: " · ")
    }

    private func load(refresh: Bool) async {
        loading = true
        error = nil
        do {
            shelf = try await model.browseSoulseekShelf(peer: peer, refresh: refresh)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

// MARK: - Add to Library Sheet

@MainActor
struct AddToLibrarySheet: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var link = ""
    @State private var editTitle = ""
    @State private var editArtist = ""
    @State private var audioOnly = false
    @State private var saving = false

    private var extractedInput: String? {
        extractSharedURL(from: link)
    }

    private var looksLikeWebURL: Bool {
        guard let extractedInput else { return false }
        return isHTTPURL(extractedInput)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("SoundCloud, YouTube, Rumble, peartube://… or 64-hex key", text: $link, axis: .vertical)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("add.linkField")

                    HStack(spacing: 12) {
                        if looksLikeWebURL {
                            Button {
                                guard let target = extractedInput else { return }
                                Task { await model.identifyURL(target) }
                            } label: {
                                if model.identifyBusy {
                                    HStack(spacing: 6) {
                                        ProgressView().controlSize(.mini)
                                        Text("Identifying…")
                                    }
                                } else {
                                    Text("Identify link")
                                }
                            }
                            .buttonStyle(PTQuietButtonStyle(compact: true))
                            .disabled(model.identifyBusy)
                            .accessibilityIdentifier("add.identify")
                        } else {
                            Button("Open link") {
                                let target = extractedInput ?? link
                                Task { await model.openURI(target) }
                            }
                            .buttonStyle(PTPrimaryButtonStyle(compact: true))
                            .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                            .accessibilityIdentifier("add.open")
                        }

                        Spacer()

                        Button {
                            dismiss()
                            model.showScanner = true
                        } label: {
                            Label("Scan QR", systemImage: "qrcode.viewfinder")
                        }
                        .accessibilityIdentifier("add.scan")
                    }
                } header: {
                    Text("Paste a link or channel key")
                } footer: {
                    Text("Share links from SoundCloud, YouTube, Rumble, or direct media files to save them directly on this device.")
                }

                // Identify preview card for http(s) links
                if looksLikeWebURL {
                    if model.identifyBusy {
                        Section("Preview") {
                            HStack(spacing: 10) {
                                ProgressView().tint(PTColor.brand)
                                Text("Reading link details…")
                                    .font(.subheadline)
                                    .foregroundStyle(PTColor.dim)
                            }
                            .padding(.vertical, 4)
                        }
                    } else if let err = model.identifyError {
                        Section("Preview") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(err)
                                    .font(.subheadline)
                                    .foregroundStyle(PTColor.bad)
                                Button("Retry") {
                                    if let target = extractedInput {
                                        Task { await model.identifyURL(target) }
                                    }
                                }
                                .buttonStyle(PTQuietButtonStyle(compact: true))
                            }
                        }
                    } else if let preview = model.identifyResult {
                        Section("Preview") {
                            HStack(spacing: 8) {
                                Text(preview.siteBadge)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.brandRing)
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 4)
                                    .background(PTColor.brand.opacity(0.18), in: Capsule())
                                if let dur = preview.duration, dur > 0 {
                                    Text(clock(dur * 1000))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(PTColor.dim)
                                }
                                if let sz = preview.size, sz > 0 {
                                    Text(bytes(sz))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(PTColor.dim)
                                }
                                Spacer()
                            }

                            TextField("Title", text: $editTitle)
                                .accessibilityIdentifier("add.preview.title")
                            TextField("Artist (optional)", text: $editArtist)
                                .accessibilityIdentifier("add.preview.artist")
                            Toggle("Audio only", isOn: $audioOnly)
                                .accessibilityIdentifier("add.preview.audioOnly")

                            Button {
                                guard let target = extractedInput else { return }
                                saving = true
                                Task {
                                    let ok = await model.acquireURL(
                                        url: target,
                                        id: preview.match?.id ?? preview.id,
                                        title: editTitle.isEmpty ? preview.title : editTitle,
                                        page: preview.isPage,
                                        audioOnly: audioOnly,
                                        artist: editArtist
                                    )
                                    saving = false
                                    if ok {
                                        link = ""
                                        editTitle = ""
                                        editArtist = ""
                                        model.resetIdentify()
                                    }
                                }
                            } label: {
                                HStack {
                                    Spacer()
                                    if saving { ProgressView().controlSize(.small) }
                                    Text(saving ? "Adding…" : "Save to library").bold()
                                    Spacer()
                                }
                            }
                            .buttonStyle(PTPrimaryButtonStyle())
                            .disabled(saving || editTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("add.save")
                        }
                    }
                }

                // Active & recent jobs
                if !model.jobs.isEmpty {
                    Section("Downloads & saves") {
                        ForEach(model.jobs) { job in
                            jobRow(job)
                        }
                    }
                }

                Section("More") {
                    Button {
                        dismiss()
                        model.showSettings = true
                    } label: {
                        Label("Channels & network settings", systemImage: "gearshape")
                    }
                    .accessibilityIdentifier("add.openSettings")
                }
            }
            .navigationTitle("Add to library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("add.close")
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            consumePendingURL()
            if let existing = model.identifyResult {
                applyPreview(existing)
            }
            Task { await model.refreshJobs(silent: true) }
        }
        .onChange(of: model.pendingAddURL) { _, _ in
            consumePendingURL()
        }
        .onChange(of: model.identifyResult) { _, next in
            if let next { applyPreview(next) }
        }
        .task(id: link) {
            guard let target = extractedInput, isHTTPURL(target) else {
                if !looksLikeWebURL && !model.identifyURLString.isEmpty {
                    model.resetIdentify()
                }
                return
            }
            if model.identifyURLString == target && (model.identifyBusy || model.identifyResult != nil) {
                return
            }
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            await model.identifyURL(target)
        }
    }

    private func consumePendingURL() {
        guard let pending = model.pendingAddURL, !pending.isEmpty else { return }
        link = pending
        model.pendingAddURL = nil
    }

    private func applyPreview(_ preview: IdentifyResult) {
        editTitle = preview.match?.title.isEmpty == false ? preview.match!.title : (preview.music?.title ?? preview.title)
        editArtist = preview.music?.artist ?? preview.author
        audioOnly = preview.audioOnly
    }

    private func jobRow(_ job: AcquireJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(job.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(2)
                    Text(jobMetaLine(job))
                        .font(.caption)
                        .foregroundStyle(job.isFailed ? PTColor.bad : (job.isDone ? PTColor.ok : PTColor.dim))
                }
                Spacer(minLength: 8)
                Button(job.isActive ? "Cancel" : "Dismiss", role: job.isActive ? .destructive : nil) {
                    Task { await model.cancelOrDismissJob(job.jobId) }
                }
                .font(.caption.weight(.medium))
                .accessibilityIdentifier("job.action.\(job.jobId)")
            }

            if job.isActive {
                if let progress = job.progress {
                    ProgressView(value: progress)
                        .tint(PTColor.brand)
                } else {
                    ProgressView()
                        .tint(PTColor.brand)
                }
            }

            if let err = job.error, !err.isEmpty {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(PTColor.bad)
            } else if let note = job.note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(PTColor.dim)
            }
        }
        .padding(.vertical, 4)
    }

    private func jobMetaLine(_ job: AcquireJob) -> String {
        var parts: [String] = [job.sourceBadge, job.statusLabel]
        if let count = job.fileCount, count > 1, let idx = job.fileIndex {
            parts.append("Track \(idx)/\(count)")
        }
        if let total = job.total, total > 0 {
            parts.append("\(bytes(job.bytes)) / \(bytes(total))")
        } else if job.bytes > 0 {
            parts.append(bytes(job.bytes))
        }
        if job.speed > 0 && job.isActive {
            parts.append("\(bytes(job.speed))/s")
        }
        return parts.joined(separator: " · ")
    }
}
