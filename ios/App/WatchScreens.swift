import SwiftUI

enum WatchKindFilter: String, CaseIterable {
    case all = "All"
    case movies = "Movies"
    case series = "Series"
    case clips = "Clips"

    var idSuffix: String {
        switch self {
        case .all: return "all"
        case .movies: return "movies"
        case .series: return "series"
        case .clips: return "clips"
        }
    }
}

@MainActor
struct WatchScreen: View {
    @ObservedObject var model: AppModel
    let onNavigate: (AppRoute) -> Void

    @State private var kind: WatchKindFilter = .all
    @State private var savedOnly = false

    private func matchesSource(_ tile: LibraryTile) -> Bool {
        guard !model.sourceFilter.isEmpty else { return true }
        return tile.items.contains { $0.entry.source == model.sourceFilter }
    }

    private func filterTiles(_ list: [LibraryTile]) -> [LibraryTile] {
        list.filter { tile in
            matchesSource(tile) && (!savedOnly || tile.isFullySaved)
        }
    }

    private var movies: [LibraryTile] { filterTiles(model.catalog.movies) }
    private var series: [LibraryTile] { filterTiles(model.catalog.series) }
    private var clips: [LibraryTile] { filterTiles(model.catalog.clips) }
    private var moviesAndSeries: [LibraryTile] {
        (movies + series).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
    private var totalCount: Int { movies.count + series.count + clips.count }

    private var continueVideos: [(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)] {
        model.continueVideos.filter { item in
            (model.sourceFilter.isEmpty || item.entry.source == model.sourceFilter)
                && (!savedOnly || item.entry.saved)
        }
    }

    private let twoColumns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    PTChipButton(title: "All", count: totalCount, selected: kind == .all, identifier: "filters.all") { kind = .all }
                    PTChipButton(title: "Movies", count: movies.count, selected: kind == .movies, identifier: "filters.movies") { kind = .movies }
                    PTChipButton(title: "Series", count: series.count, selected: kind == .series, identifier: "filters.series") { kind = .series }
                    PTChipButton(title: "Clips", count: clips.count, selected: kind == .clips, identifier: "filters.clips") { kind = .clips }
                    PTChipButton(title: "Saved here", selected: savedOnly, identifier: "filters.device") { savedOnly.toggle() }
                    if model.sources.count > 1 {
                        ForEach(model.sources, id: \.selfKey) { source in
                            let key = source.string("key")
                            PTChipButton(
                                title: SourceSpec(source).name,
                                selected: model.sourceFilter == key,
                                identifier: "filters.source.\(key)"
                            ) {
                                model.sourceFilter = model.sourceFilter == key ? "" : key
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }

            PTDivider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if kind == .all && !continueVideos.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            PTSectionHeader(title: "Keep watching")
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(alignment: .top, spacing: 12) {
                                    ForEach(continueVideos.prefix(10), id: \.entry.key) { item in
                                        Button { model.play(item.entry) } label: {
                                            VStack(alignment: .leading, spacing: 6) {
                                                WideArtView(
                                                    title: item.tile.title,
                                                    backdropURL: model.backdropURL(imdb: item.tile.imdb),
                                                    posterURL: model.posterURL(imdb: item.tile.imdb),
                                                    progress: item.progress.fraction
                                                )
                                                .frame(width: 224)
                                                Text(item.entry.episode.map { "\(item.tile.title) · \($0)" } ?? item.tile.title)
                                                    .font(.subheadline.weight(.semibold))
                                                    .foregroundStyle(PTColor.ink)
                                                    .lineLimit(1)
                                                Text(item.progress.durationMs > 0 ? timeLeftText(seconds: item.progress.remainingSeconds) : "Resume at \(clock(item.progress.positionMs))")
                                                    .font(.caption)
                                                    .foregroundStyle(PTColor.dim)
                                            }
                                            .frame(width: 224, alignment: .leading)
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityIdentifier("library.continue.\(item.entry.key)")
                                    }
                                }
                            }
                        }
                    }

                    switch kind {
                    case .all:
                        if moviesAndSeries.isEmpty && clips.isEmpty {
                            emptyWatchState
                        } else {
                            if !moviesAndSeries.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    PTSectionHeader(title: "Movies and series")
                                    LazyVGrid(columns: twoColumns, spacing: 18) {
                                        ForEach(moviesAndSeries) { tile in
                                            VideoPosterCard(tile: tile, model: model, width: nil, onNavigate: onNavigate)
                                        }
                                    }
                                }
                            }
                            if !clips.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    PTSectionHeader(title: "Clips")
                                    ForEach(clips) { tile in
                                        ClipWideCard(tile: tile, model: model, width: nil, onNavigate: onNavigate)
                                    }
                                }
                            }
                        }
                    case .movies:
                        if movies.isEmpty { emptyWatchState }
                        else {
                            LazyVGrid(columns: twoColumns, spacing: 18) {
                                ForEach(movies) { tile in
                                    VideoPosterCard(tile: tile, model: model, width: nil, onNavigate: onNavigate)
                                }
                            }
                        }
                    case .series:
                        if series.isEmpty { emptyWatchState }
                        else {
                            LazyVGrid(columns: twoColumns, spacing: 18) {
                                ForEach(series) { tile in
                                    VideoPosterCard(tile: tile, model: model, width: nil, onNavigate: onNavigate)
                                }
                            }
                        }
                    case .clips:
                        if clips.isEmpty { emptyWatchState }
                        else {
                            ForEach(clips) { tile in
                                ClipWideCard(tile: tile, model: model, width: nil, onNavigate: onNavigate)
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

    private var emptyWatchState: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.busy { ProgressView("Connecting to your sources…").tint(PTColor.brand) }
            Text(model.entries.isEmpty ? "Nothing to watch yet." : "Nothing matches this filter.")
                .font(.headline)
                .foregroundStyle(PTColor.ink)
            Text(model.entries.isEmpty
                 ? "Add a channel or open a link to bring movies, series, and clips here."
                 : "Try choosing All or turning off Saved here.")
                .font(.subheadline)
                .foregroundStyle(PTColor.dim)
            if model.entries.isEmpty {
                Button("Add to library") { model.showSettings = true }
                    .buttonStyle(PTPrimaryButtonStyle())
            }
        }
        .padding(.vertical, 28)
    }
}

/// Poster card for a Movie or Series.
/// Poster/title opens TitleScreen; quick play button plays directly (carrying `library.entry.<key>` for movies).
@MainActor
struct VideoPosterCard: View {
    let tile: LibraryTile
    @ObservedObject var model: AppModel
    let width: CGFloat?
    let onNavigate: (AppRoute) -> Void

    private var primaryEntry: MediaEntry? {
        if tile.kind == .show {
            return model.seriesNext(tile.items.map(\.entry))
        }
        return tile.firstEntry
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                Button { onNavigate(.title(tile.key)) } label: {
                    PosterView(title: tile.title, year: tile.year, url: model.posterURL(imdb: tile.imdb))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tile.title)
                .accessibilityIdentifier("library.title.\(tile.key)")

                if let entry = primaryEntry, !entry.locked {
                    Button { model.play(entry) } label: {
                        Image(systemName: "play.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(PTColor.bg)
                            .frame(width: 34, height: 34)
                            .background(PTColor.ink, in: Circle())
                    }
                    .padding(8)
                    .accessibilityLabel("Play \(tile.title)")
                    .accessibilityIdentifier(tile.kind == .show ? "library.seriesResume.\(entry.groupKey)" : "library.entry.\(entry.key)")
                }
            }

            Button { onNavigate(.title(tile.key)) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(1)
                    Text(tile.lineText)
                        .font(.caption)
                        .foregroundStyle(PTColor.dim)
                        .lineLimit(1)
                    Text(tile.stateLabel)
                        .font(.caption2)
                        .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .frame(width: width, alignment: .leading)
    }
}

/// Wide tile card for a Clip.
@MainActor
struct ClipWideCard: View {
    let tile: LibraryTile
    @ObservedObject var model: AppModel
    let width: CGFloat?
    let onNavigate: (AppRoute) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                Button { onNavigate(.title(tile.key)) } label: {
                    WideArtView(
                        title: tile.title,
                        backdropURL: nil,
                        posterURL: nil,
                        progress: tile.firstEntry.flatMap { model.history[$0.key]?.partial == true ? model.history[$0.key]?.fraction : nil }
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("library.title.\(tile.key)")

                if let entry = tile.firstEntry, !entry.locked {
                    Button { model.play(entry) } label: {
                        Image(systemName: "play.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(PTColor.bg)
                            .frame(width: 34, height: 34)
                            .background(PTColor.ink, in: Circle())
                    }
                    .padding(8)
                    .accessibilityLabel("Play \(tile.title)")
                    .accessibilityIdentifier("library.entry.\(entry.key)")
                }
            }

            Button { onNavigate(.title(tile.key)) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PTColor.ink)
                        .lineLimit(1)
                    Text("\(tile.lineText) · \(tile.stateLabel)")
                        .font(.caption)
                        .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .frame(width: width, alignment: .leading)
    }
}

// MARK: - Title Detail Screen (Movie / Series / Clip)

@MainActor
struct TitleScreen: View {
    let tileKey: String
    @ObservedObject var model: AppModel
    @State private var selectedSeason: Int?

    private var tile: LibraryTile? { model.catalog.tile(forKey: tileKey) }

    var body: some View {
        ScrollView {
            if let tile {
                VStack(alignment: .leading, spacing: 20) {
                    header(tile)
                    PTDivider()
                    switch tile.kind {
                    case .show:
                        seriesBody(tile)
                    case .movie, .clip, .album:
                        versionsBody(tile)
                    }
                }
                .padding(16)
            } else {
                Text("This title is no longer in your library.")
                    .foregroundStyle(PTColor.dim)
                    .padding(24)
            }
        }
        .background(PTColor.bg)
        .navigationTitle(tile?.title ?? "Title")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func header(_ tile: LibraryTile) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if tile.kind == .clip {
                WideArtView(title: tile.title, backdropURL: nil, posterURL: nil)
            } else {
                HStack(alignment: .top, spacing: 16) {
                    PosterView(title: tile.title, year: tile.year, url: model.posterURL(imdb: tile.imdb))
                        .frame(width: 112)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(tile.kind == .show ? "Series" : "Movie")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PTColor.dim)
                        Text(tile.title)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(PTColor.ink)
                        if let year = tile.year, !year.isEmpty {
                            Text(year).font(.subheadline).foregroundStyle(PTColor.dim)
                        }
                        Text("\(tile.lineText) · \(tile.stateLabel)")
                            .font(.caption)
                            .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                    }
                }
            }

            if tile.kind == .clip {
                VStack(alignment: .leading, spacing: 4) {
                    Text(tile.title).font(.title3.weight(.bold)).foregroundStyle(PTColor.ink)
                    Text("\(tile.lineText) · \(tile.stateLabel)")
                        .font(.caption)
                        .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                }
            }

            // Primary actions
            let primaryEntry = tile.kind == .show ? model.seriesNext(tile.items.map(\.entry)) : tile.firstEntry
            if let entry = primaryEntry {
                let dl = model.downloads[entry.key]
                HStack(spacing: 10) {
                    Button { model.play(entry) } label: {
                        let label: String = {
                            if tile.kind == .show {
                                let ep = entry.episode ?? ""
                                return model.history[entry.key]?.partial == true ? "Resume \(ep)" : "Next episode · \(ep)"
                            }
                            return model.history[entry.key]?.partial == true ? "Resume" : "Play"
                        }()
                        Label(label, systemImage: "play.fill")
                    }
                    .buttonStyle(PTPrimaryButtonStyle())
                    .disabled(entry.locked)
                    .accessibilityIdentifier("title.play.\(entry.key)")

                    if !entry.locked {
                        Button { model.chooseCast(entry) } label: {
                            Label("Play on a TV", systemImage: "tv")
                        }
                        .buttonStyle(PTQuietButtonStyle())
                        .accessibilityIdentifier("title.cast.\(entry.key)")
                    }

                    Menu {
                        if !entry.locked {
                            if dl != nil {
                                Button("Cancel download", systemImage: "xmark.circle", role: .destructive) { model.cancelDownload(entry.key) }
                            } else {
                                Button("Download", systemImage: "arrow.down.circle") { model.download(entry) }
                            }
                        }
                        if !entry.magnetURL.isEmpty {
                            ShareLink("Share link", item: entry.magnetURL)
                            Button("Show sharing QR", systemImage: "qrcode") { model.shareURI = entry.magnetURL }
                        }
                        if !entry.local && entry.cachedBytes > 0 {
                            Button("Free up cache", systemImage: "internaldrive", role: .destructive) {
                                Task { await model.clearCache(entry.key) }
                            }
                        }
                        if model.canDelete(entry) {
                            Button("Delete from channel", systemImage: "trash", role: .destructive) {
                                Task { await model.removeChannelEntry(entry.key) }
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
                }

                if let dl, entry.size > 0 {
                    ProgressView(value: min(1, max(0.02, dl / entry.size)))
                        .tint(PTColor.brand)
                }
            }
        }
    }

    @ViewBuilder
    private func seriesBody(_ tile: LibraryTile) -> some View {
        let grouped = Dictionary(grouping: tile.items, by: { $0.season ?? 1 })
        let seasons = grouped.keys.sorted()
        let activeSeason = selectedSeason ?? seasons.first ?? 1
        let seasonItems = (grouped[activeSeason] ?? []).sorted { ($0.episode ?? 0) < ($1.episode ?? 0) }
        // Deduplicate multiple versions per episode in the main list
        let episodes = Dictionary(grouping: seasonItems, by: { $0.entry.mediaID })
            .values
            .compactMap { $0.sorted { $0.entry.size > $1.entry.size }.first }
            .sorted { ($0.episode ?? 0) < ($1.episode ?? 0) }

        if seasons.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(seasons, id: \.self) { season in
                        PTChipButton(
                            title: String(format: "Season %d", season),
                            selected: activeSeason == season,
                            identifier: "library.season.\(tile.key).S\(String(format: "%02d", season))"
                        ) {
                            selectedSeason = season
                        }
                    }
                }
            }
        }

        LazyVStack(spacing: 0) {
            ForEach(episodes) { item in
                let entry = item.entry
                let versions = seasonItems.filter { $0.entry.mediaID == entry.mediaID }.map(\.entry)
                fileRow(entry: entry, label: entry.episode.map { "\($0) · \(entry.title)" } ?? entry.title, versions: versions)
                PTDivider()
            }
        }
    }

    @ViewBuilder
    private func versionsBody(_ tile: LibraryTile) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(tile.items.count > 1 ? "Versions" : "File")
                .font(.headline)
                .foregroundStyle(PTColor.ink)
            LazyVStack(spacing: 0) {
                ForEach(tile.items) { item in
                    fileRow(entry: item.entry, label: item.entry.title, versions: [])
                    PTDivider()
                }
            }
        }
    }

    private func fileRow(entry: MediaEntry, label: String, versions: [MediaEntry]) -> some View {
        let dl = model.downloads[entry.key]
        let progress = model.history[entry.key]

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Button { model.play(entry) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(label)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(PTColor.ink)
                            .multilineTextAlignment(.leading)
                        if let dl {
                            let pct = entry.size > 0 ? Int(min(100, (dl * 100) / max(1, entry.size))) : 0
                            Text("Downloading \(entry.size > 0 ? "\(pct)%" : bytes(dl))")
                                .font(.caption)
                                .foregroundStyle(PTColor.brandRing)
                        } else {
                            let lock = entry.locked ? " · Subscriber pass needed" : (entry.isPrivate ? " · Subscribers only" : "")
                            Text("\(bytes(entry.size)) · \(whereLabel(for: entry))\(lock)")
                                .font(.caption)
                                .foregroundStyle(entry.locked ? PTColor.bad : PTColor.dim)
                        }
                        if let progress, progress.partial {
                            Text(progress.durationMs > 0 ? timeLeftText(seconds: progress.remainingSeconds) : "Resume at \(clock(progress.positionMs))")
                                .font(.caption2)
                                .foregroundStyle(PTColor.brandRing)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("library.entry.\(entry.key)")

                if !entry.locked {
                    IconButton(title: "Play on a TV", icon: "tv", identifier: "library.cast.\(entry.key)") {
                        model.chooseCast(entry)
                    }
                    .foregroundStyle(PTColor.dim)
                }

                Menu {
                    if !entry.locked {
                        Button("Play", systemImage: "play.fill") { model.play(entry) }
                        Button("Play on a TV", systemImage: "tv") { model.chooseCast(entry) }
                        if versions.count > 1 {
                            Menu("Versions") {
                                ForEach(versions) { v in
                                    Button("\(v.title) · \(bytes(v.size))") { model.play(v) }
                                }
                            }
                        }
                        if dl != nil {
                            Button("Cancel download", systemImage: "xmark.circle", role: .destructive) { model.cancelDownload(entry.key) }
                        } else {
                            Button("Download", systemImage: "arrow.down.circle") { model.download(entry) }
                        }
                    }
                    if !entry.magnetURL.isEmpty {
                        ShareLink("Share link", item: entry.magnetURL)
                        Button("Show sharing QR", systemImage: "qrcode") { model.shareURI = entry.magnetURL }
                    }
                    if !entry.local && entry.cachedBytes > 0 {
                        Button("Free up cache", role: .destructive) { Task { await model.clearCache(entry.key) } }
                    }
                    if model.canDelete(entry) {
                        Button("Delete from channel", systemImage: "trash", role: .destructive) {
                            Task { await model.removeChannelEntry(entry.key) }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(PTColor.dim)
                        .frame(width: 34, height: 44)
                }
                .accessibilityIdentifier("library.more.\(entry.key)")
            }

            if let dl, entry.size > 0 {
                ProgressView(value: min(1, max(0.02, dl / entry.size))).tint(PTColor.brand)
            } else if let progress, progress.partial, progress.durationMs > 0 {
                ProgressView(value: progress.fraction).tint(PTColor.brand)
            }
        }
    }
}
