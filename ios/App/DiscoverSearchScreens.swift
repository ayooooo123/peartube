import SwiftUI

// MARK: - Discover Room

@MainActor
struct DiscoverScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Discover")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(PTColor.ink)
                    Text("Find titles on other relays or follow channels shared on your network.")
                        .font(.subheadline)
                        .foregroundStyle(PTColor.dim)
                    Button {
                        model.openSearch()
                    } label: {
                        Label("Search other relays", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(PTPrimaryButtonStyle())
                    .accessibilityIdentifier("discover.searchRelays")
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

                Text("Planned: Rumble, SoundCloud.")
                    .font(.caption)
                    .foregroundStyle(PTColor.dim)
                    .padding(.top, 8)
            }
            .padding(16)
        }
        .background(PTColor.bg)
        .refreshable { await model.refresh() }
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
            // Single search field (Rule 16)
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
                            else { await model.searchGlobal(model.query) }
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
                                Label("Open link", systemImage: "link")
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
        VStack(alignment: .leading, spacing: 14) {
            Text("Search your library and other relays")
                .font(.headline)
                .foregroundStyle(PTColor.ink)
            Text("Type a title, album, artist, or paste a PearTube link. Press Search to also ask other relays.")
                .font(.subheadline)
                .foregroundStyle(PTColor.dim)

            if !model.catalog.artists.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.catalog.artists.prefix(8)) { artist in
                            PTChipButton(title: artist.name) {
                                model.query = artist.name
                                Task { await model.searchGlobal(artist.name) }
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 12)
    }

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

// MARK: - Add to Library Sheet

@MainActor
struct AddToLibrarySheet: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Open a link or channel key") {
                    TextField("peartube://… or 64-character key", text: $link, axis: .vertical)
                        .lineLimit(1...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("add.linkField")
                    HStack(spacing: 12) {
                        Button("Open link") {
                            let target = link
                            Task { await model.openURI(target) }
                        }
                        .buttonStyle(PTPrimaryButtonStyle(compact: true))
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                        .accessibilityIdentifier("add.open")

                        Spacer()

                        Button {
                            dismiss()
                            model.showScanner = true
                        } label: {
                            Label("Scan QR", systemImage: "qrcode.viewfinder")
                        }
                        .accessibilityIdentifier("add.scan")
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
        .presentationDetents([.medium])
    }
}
