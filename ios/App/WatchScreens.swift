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

enum WatchViewMode: String, CaseIterable, Identifiable {
    case rows = "Rows"
    case tonight = "Tonight"
    case store = "Store"
    case channels = "Channels"

    var id: String { rawValue }
}

private func watchTitleHue(_ title: String) -> Int {
    Int(CatalogText.sleeveHash(title) % 360)
}

private func watchSavedColor(for tile: LibraryTile) -> Color {
    if tile.isFullySaved { return PTColor.ok }
    if tile.saved > 0 || tile.partial { return PTColor.warn }
    return PTColor.dim.opacity(0.6)
}

@MainActor
struct WatchScreen: View {
    @ObservedObject var model: AppModel
    let onNavigate: (AppRoute) -> Void

    @State private var viewMode: WatchViewMode = .rows
    @State private var kind: WatchKindFilter = .all
    @State private var savedOnly = false
    @State private var coverTile: LibraryTile?

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
    private var allFilteredVideos: [LibraryTile] {
        (movies + series + clips).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
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
            VStack(spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("Watch")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(PTColor.ink)
                    if totalCount > 0 {
                        Text(plural(totalCount, "title", "titles"))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(PTColor.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if !allFilteredVideos.isEmpty {
                        Button {
                            model.playRandomVideo(from: allFilteredVideos)
                        } label: {
                            Label("Play something", systemImage: "die.face.5")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(PTColor.ink)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(PTColor.raised, in: Capsule())
                                .overlay(Capsule().strokeBorder(PTColor.line, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Play something")
                        .accessibilityIdentifier("watch.playSomething")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)

                Picker("Watch view", selection: $viewMode) {
                    ForEach(WatchViewMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("watch.modePicker")
                .padding(.horizontal, 16)
                .padding(.bottom, viewMode == .rows && (!model.catalog.allVideos.isEmpty || savedOnly || !model.sourceFilter.isEmpty) ? 0 : 10)

                if viewMode == .rows && (!model.catalog.allVideos.isEmpty || savedOnly || !model.sourceFilter.isEmpty) {
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
                        .padding(.bottom, 10)
                    }
                }
            }

            PTDivider()

            switch viewMode {
            case .rows:
                rowsContent
            case .tonight:
                if allFilteredVideos.isEmpty {
                    ScrollView { emptyWatchState.padding(16) }
                        .background(PTColor.bg)
                        .refreshable { await model.refresh() }
                } else {
                    WatchTonightView(
                        model: model,
                        allVideos: allFilteredVideos,
                        series: series,
                        continueVideos: continueVideos,
                        onNavigate: onNavigate
                    )
                }
            case .store:
                if allFilteredVideos.isEmpty {
                    ScrollView { emptyWatchState.padding(16) }
                        .background(PTColor.bg)
                        .refreshable { await model.refresh() }
                } else {
                    WatchStoreView(
                        model: model,
                        series: series,
                        movies: movies,
                        clips: clips,
                        onOpenCover: { coverTile = $0 }
                    )
                }
            case .channels:
                if allFilteredVideos.isEmpty {
                    ScrollView { emptyWatchState.padding(16) }
                        .background(PTColor.bg)
                        .refreshable { await model.refresh() }
                } else {
                    WatchChannelsView(
                        model: model,
                        series: series,
                        movies: movies,
                        clips: clips,
                        onOpenCover: { coverTile = $0 }
                    )
                }
            }
        }
        .background(PTColor.bg)
        .sheet(item: $coverTile) { tile in
            VideoCoverSheet(
                tile: tile,
                model: model,
                onPlay: { entry in
                    coverTile = nil
                    model.play(entry)
                },
                onDetails: { selected in
                    coverTile = nil
                    onNavigate(.title(selected.key))
                }
            )
        }
    }

    private var featuredHeroSelection: (eyebrow: String, tile: LibraryTile, entry: MediaEntry, facts: String, progress: Double?, isContinue: Bool)? {
        if let cont = continueVideos.first {
            let ep = cont.entry.episode
            let remaining = cont.progress.durationMs > 0
                ? timeLeftText(seconds: cont.progress.remainingSeconds)
                : "Resume at \(clock(cont.progress.positionMs))"
            let facts = [ep, remaining, cont.tile.stateLabel].compactMap { $0 }.joined(separator: " · ")
            return (
                eyebrow: "Continue",
                tile: cont.tile,
                entry: cont.entry,
                facts: facts,
                progress: cont.progress.fraction > 0 ? cont.progress.fraction : nil,
                isContinue: true
            )
        }
        let candidates: [LibraryTile] = {
            switch kind {
            case .all: return moviesAndSeries + clips
            case .movies: return movies
            case .series: return series
            case .clips: return clips
            }
        }()
        for tile in candidates {
            if let entry = model.primaryEntry(for: tile), !entry.locked {
                return (
                    eyebrow: "On this relay",
                    tile: tile,
                    entry: entry,
                    facts: "\(tile.lineText) · \(tile.stateLabel)",
                    progress: nil,
                    isContinue: false
                )
            }
        }
        return nil
    }

    private func featuredHeroCard(
        eyebrow: String,
        tile: LibraryTile,
        entry: MediaEntry,
        facts: String,
        progress: Double?,
        isContinue: Bool
    ) -> some View {
        let hue = Double(watchTitleHue(tile.title))
        return ZStack(alignment: .bottomLeading) {
            PTHeroBackground(hue: hue, showOrb: true)

            VStack(alignment: .leading, spacing: 10) {
                Text(eyebrow)
                    .font(.caption2.weight(.bold))
                    .tracking(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.white.opacity(0.80))

                Text(tile.title)
                    .font(.title.weight(.heavy))
                    .tracking(-0.5)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.white)
                    .lineLimit(2)

                Text(facts)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.90))
                    .lineLimit(1)

                if let progress, progress > 0 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.30))
                            Capsule()
                                .fill(PTColor.brandHover)
                                .frame(width: geo.size.width * max(0.03, min(1, progress)))
                        }
                    }
                    .frame(height: 4)
                    .frame(maxWidth: 360)
                }

                PTWrapLayout(spacing: 8, rowSpacing: 8) {
                    Button { model.play(entry) } label: {
                        Label(isContinue ? "Continue" : "Play", systemImage: "play.fill")
                    }
                    .buttonStyle(PTHeroPrimaryButtonStyle(compact: true))
                    .accessibilityLabel(isContinue ? "Continue \(tile.title)" : "Play \(tile.title)")
                    .accessibilityIdentifier("watch.hero.play")

                    if allFilteredVideos.count > 1 {
                        Button { model.playRandomVideo(from: allFilteredVideos) } label: {
                            Label("Play something", systemImage: "die.face.5")
                        }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                        .accessibilityLabel("Play a random video")
                        .accessibilityIdentifier("watch.hero.surprise")
                    }

                    Button("Details") { onNavigate(.title(tile.key)) }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                        .accessibilityIdentifier("watch.hero.details")
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .frame(maxWidth: .infinity, minHeight: 224, alignment: .bottomLeading)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
    }

    private var rowsContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if kind == .all, let hero = featuredHeroSelection {
                    featuredHeroCard(
                        eyebrow: hero.eyebrow,
                        tile: hero.tile,
                        entry: hero.entry,
                        facts: hero.facts,
                        progress: hero.progress,
                        isContinue: hero.isContinue
                    )
                }

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
                                                kind: item.tile.kind,
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

// MARK: - Watch: Tonight (Three choices + A–Z index)

@MainActor
private struct WatchTonightView: View {
    @ObservedObject var model: AppModel
    let allVideos: [LibraryTile]
    let series: [LibraryTile]
    let continueVideos: [(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)]
    let onNavigate: (AppRoute) -> Void

    @State private var surpriseKey: String?

    private var continuePick: (tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)? {
        continueVideos.first
    }

    private var nextEpisodePick: (tile: LibraryTile, entry: MediaEntry, progress: WatchProgress?)? {
        let excludeKey = continuePick?.tile.key
        if let startedSeries = continueVideos.first(where: { $0.tile.key != excludeKey && $0.tile.kind == .show }) {
            return (tile: startedSeries.tile, entry: startedSeries.entry, progress: startedSeries.progress)
        }
        for tile in series where tile.key != excludeKey {
            let hasHistory = tile.items.contains { model.history[$0.entry.key] != nil }
            if hasHistory, let next = model.seriesNext(tile.items.map(\.entry)), next.playable {
                return (tile: tile, entry: next, progress: model.history[next.key])
            }
        }
        return nil
    }

    private var surpriseTile: LibraryTile? {
        if let key = surpriseKey, let found = allVideos.first(where: { $0.key == key }) {
            return found
        }
        return model.pickSurpriseVideo(excluding: nil, from: allVideos)
    }

    private func sortKey(for title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        for prefix in ["the ", "a ", "an "] {
            if lower.hasPrefix(prefix) {
                return String(trimmed.dropFirst(prefix.count))
            }
        }
        return trimmed
    }

    private func letterGroup(for title: String) -> String {
        let key = sortKey(for: title)
        guard let first = key.uppercased().first, first.isASCII && first.isLetter else { return "#" }
        return String(first)
    }

    private var alphabeticalSections: [(letter: String, tiles: [LibraryTile])] {
        let sorted = allVideos.sorted {
            sortKey(for: $0.title).localizedCaseInsensitiveCompare(sortKey(for: $1.title)) == .orderedAscending
        }
        var grouped: [String: [LibraryTile]] = [:]
        var order: [String] = []
        for tile in sorted {
            let letter = letterGroup(for: tile.title)
            if grouped[letter] == nil {
                order.append(letter)
            }
            grouped[letter, default: []].append(tile)
        }
        return order.map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    VStack(spacing: 12) {
                        if let cont = continuePick {
                            decisionCard(
                                eyebrow: "Continue",
                                tile: cont.tile,
                                entry: cont.entry,
                                subtitle: (cont.entry.episode.map { "\($0) · " } ?? "") + (cont.progress.durationMs > 0 ? timeLeftText(seconds: cont.progress.remainingSeconds) : "Resume at \(clock(cont.progress.positionMs))"),
                                progress: cont.progress.fraction,
                                primary: true,
                                showAnother: false
                            )
                        }
                        if let next = nextEpisodePick {
                            let sub: String = {
                                let ep = next.entry.episode ?? "Next episode"
                                if let p = next.progress, p.partial, p.durationMs > 0 {
                                    return "\(ep) · \(timeLeftText(seconds: p.remainingSeconds))"
                                }
                                return "\(ep) · \(next.tile.stateLabel)"
                            }()
                            decisionCard(
                                eyebrow: "Next episode",
                                tile: next.tile,
                                entry: next.entry,
                                subtitle: sub,
                                progress: next.progress?.partial == true ? next.progress?.fraction : nil,
                                primary: continuePick == nil,
                                showAnother: false
                            )
                        }
                        if let pick = surpriseTile, let entry = model.primaryEntry(for: pick) {
                            decisionCard(
                                eyebrow: "Surprise me",
                                tile: pick,
                                entry: entry,
                                subtitle: "\(pick.lineText) · \(pick.stateLabel)",
                                progress: nil,
                                primary: continuePick == nil && nextEpisodePick == nil,
                                showAnother: allVideos.count > 1
                            )
                        }
                    }

                    let sections = alphabeticalSections
                    if !sections.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(sections, id: \.letter) { section in
                                    Button(section.letter) {
                                        withAnimation(.easeInOut(duration: 0.2)) {
                                            proxy.scrollTo("az-\(section.letter)", anchor: .top)
                                        }
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.ink)
                                    .frame(minWidth: 30, minHeight: 30)
                                    .background(PTColor.surface, in: RoundedRectangle(cornerRadius: 7))
                                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(PTColor.line, lineWidth: 1))
                                    .accessibilityLabel("Jump to \(section.letter)")
                                }
                            }
                        }
                        .padding(.top, 4)

                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(sections, id: \.letter) { section in
                                Text(section.letter)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(PTColor.brandRing)
                                    .padding(.top, 14)
                                    .padding(.bottom, 6)
                                    .id("az-\(section.letter)")

                                ForEach(section.tiles) { tile in
                                    let entry = model.primaryEntry(for: tile)
                                    let prog = entry.flatMap { model.history[$0.key] }
                                    Button { onNavigate(.title(tile.key)) } label: {
                                        HStack(spacing: 10) {
                                            RoundedRectangle(cornerRadius: 3)
                                                .fill(Color.hsl(hue: Double(watchTitleHue(tile.title)), saturation: 0.55, lightness: 0.45))
                                                .frame(width: 10, height: 18)
                                            Text(tile.title)
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(PTColor.ink)
                                                .lineLimit(1)
                                            Spacer(minLength: 8)
                                            Text(prog?.partial == true && (prog?.durationMs ?? 0) > 0
                                                 ? timeLeftText(seconds: prog?.remainingSeconds ?? 0)
                                                 : tile.lineText)
                                                .font(.caption)
                                                .foregroundStyle(PTColor.dim)
                                                .lineLimit(1)
                                            Circle()
                                                .fill(watchSavedColor(for: tile))
                                                .frame(width: 7, height: 7)
                                        }
                                        .padding(.vertical, 10)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
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
            .onAppear {
                if surpriseKey == nil {
                    surpriseKey = model.pickSurpriseVideo(excluding: nil, from: allVideos)?.key
                }
            }
        }
    }

    private func decisionCard(
        eyebrow: String,
        tile: LibraryTile,
        entry: MediaEntry,
        subtitle: String,
        progress: Double?,
        primary: Bool,
        showAnother: Bool
    ) -> some View {
        let hue = Double(watchTitleHue(tile.title))
        return ZStack(alignment: .bottomLeading) {
            PTHeroBackground(hue: hue, showOrb: true)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(eyebrow)
                        .font(.caption2.weight(.bold))
                        .tracking(1.4)
                        .foregroundStyle(Color.white.opacity(0.80))
                        .textCase(.uppercase)
                    Spacer()
                    Circle()
                        .fill(watchSavedColor(for: tile))
                        .frame(width: 7, height: 7)
                }

                Text(tile.title)
                    .font(.title3.weight(.heavy))
                    .tracking(-0.4)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.white)
                    .lineLimit(2)

                Text(subtitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.88))
                    .lineLimit(1)

                if let progress, progress > 0 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.30))
                            Capsule().fill(PTColor.brandHover).frame(width: geo.size.width * max(0.03, min(1, progress)))
                        }
                    }
                    .frame(height: 4)
                }

                PTWrapLayout(spacing: 8, rowSpacing: 8) {
                    if primary {
                        Button { model.play(entry) } label: {
                            Label("Play", systemImage: "play.fill")
                        }
                        .buttonStyle(PTHeroPrimaryButtonStyle(compact: true))
                    } else {
                        Button { model.play(entry) } label: {
                            Label("Play", systemImage: "play.fill")
                        }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                    }

                    if showAnother {
                        Button {
                            surpriseKey = model.pickSurpriseVideo(excluding: tile.key, from: allVideos)?.key
                        } label: {
                            Label("Another", systemImage: "die.face.5")
                        }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                        .accessibilityIdentifier("watch.tonight.another")
                    }

                    Button("Details") { onNavigate(.title(tile.key)) }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .frame(maxWidth: .infinity, minHeight: 168, alignment: .bottomLeading)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }
}

// MARK: - Watch: Video Store (Spine shelves + Cover sheet)

@MainActor
private struct WatchStoreView: View {
    @ObservedObject var model: AppModel
    let series: [LibraryTile]
    let movies: [LibraryTile]
    let clips: [LibraryTile]
    let onOpenCover: (LibraryTile) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if !series.isEmpty {
                    shelfSection(title: "Series", tiles: series)
                }
                if !movies.isEmpty {
                    shelfSection(title: "Films", tiles: movies)
                }
                if !clips.isEmpty {
                    shelfSection(title: "Clips", tiles: Array(clips.prefix(120)))
                }
            }
            .padding(.vertical, 16)
        }
        .background(PTColor.bg)
        .refreshable { await model.refresh() }
    }

    private func shelfSection(title: String, tiles: [LibraryTile]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(PTColor.ink)
                Text("\(tiles.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(PTColor.dim)
            }
            .padding(.horizontal, 16)

            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .bottom, spacing: 5) {
                        ForEach(tiles) { tile in
                            spineButton(tile)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                }
                Rectangle()
                    .fill(PTColor.line)
                    .frame(height: 4)
                    .padding(.horizontal, 12)
            }
        }
    }

    private func spineButton(_ tile: LibraryTile) -> some View {
        let hue = watchTitleHue(tile.title)
        let width: CGFloat = {
            switch tile.kind {
            case .show: return CGFloat(min(76, 40 + 8 * max(1, tile.seasonCount)))
            case .movie: return 40
            case .clip, .album: return 32
            }
        }()
        let height: CGFloat = 158 + CGFloat((hue % 5) * 6)
        let isStarted = tile.items.contains { model.history[$0.entry.key]?.partial == true }
        let labelHeight = max(60, height - 52)

        return Button { onOpenCover(tile) } label: {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(Color.hsl(hue: Double(hue), saturation: 0.65, lightness: 0.52))
                    .frame(height: 5)

                if tile.kind == .show {
                    Text("×\(tile.items.count)")
                        .font(.system(size: 10, weight: .bold).monospacedDigit())
                        .foregroundStyle(Color.white.opacity(0.85))
                        .padding(.top, 5)
                }

                Spacer(minLength: 4)

                Text(tile.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.92))
                    .lineLimit(1)
                    .frame(width: labelHeight, height: width - 6, alignment: .leading)
                    .rotationEffect(.degrees(-90))
                    .frame(width: width - 6, height: labelHeight)

                Spacer(minLength: 4)

                Circle()
                    .fill(watchSavedColor(for: tile))
                    .frame(width: 6, height: 6)
                    .padding(.bottom, 7)
            }
            .frame(width: width, height: height)
            .background(Color.hsl(hue: Double(hue), saturation: 0.46, lightness: 0.21))
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(isStarted ? PTColor.brand : Color.white.opacity(0.12), lineWidth: isStarted ? 1.5 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(tile.title), \(tile.lineText)")
    }
}

@MainActor
private struct VideoCoverSheet: View {
    let tile: LibraryTile
    @ObservedObject var model: AppModel
    let onPlay: (MediaEntry) -> Void
    let onDetails: (LibraryTile) -> Void
    @Environment(\.dismiss) private var dismiss

    private var primaryEntry: MediaEntry? { model.primaryEntry(for: tile) }
    private var progress: WatchProgress? { primaryEntry.flatMap { model.history[$0.key] } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if tile.kind == .clip {
                        WideArtView(
                            title: tile.title,
                            kind: tile.kind,
                            backdropURL: nil,
                            posterURL: nil,
                            progress: progress?.partial == true ? progress?.fraction : nil
                        )
                    } else {
                        HStack(alignment: .top, spacing: 16) {
                            PosterView(title: tile.title, year: tile.year, kind: tile.kind, url: model.posterURL(imdb: tile.imdb))
                                .frame(width: 112)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(tile.kind == .show ? "Series" : "Film")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.dim)
                                Text(tile.title)
                                    .font(.title3.weight(.bold))
                                    .foregroundStyle(PTColor.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(tile.lineText)
                                    .font(.caption)
                                    .foregroundStyle(PTColor.dim)
                                if tile.totalSize > 0 {
                                    Text(bytes(tile.totalSize))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(PTColor.dim)
                                }
                                HStack(spacing: 6) {
                                    Circle()
                                        .fill(watchSavedColor(for: tile))
                                        .frame(width: 7, height: 7)
                                    Text(tile.stateLabel)
                                        .font(.caption)
                                        .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                                }
                            }
                        }
                    }

                    if tile.kind == .clip {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(tile.title)
                                .font(.title3.weight(.bold))
                                .foregroundStyle(PTColor.ink)
                            Text("\(tile.lineText) · \(tile.stateLabel)")
                                .font(.caption)
                                .foregroundStyle(tile.isFullySaved ? PTColor.ok : PTColor.dim)
                        }
                    }

                    if let p = progress, p.partial {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(p.durationMs > 0 ? timeLeftText(seconds: p.remainingSeconds) : "Resume at \(clock(p.positionMs))")
                                .font(.caption)
                                .foregroundStyle(PTColor.brandRing)
                            if p.fraction > 0 {
                                GeometryReader { geo in
                                    ZStack(alignment: .leading) {
                                        Capsule().fill(PTColor.line)
                                        Capsule().fill(PTColor.brand).frame(width: geo.size.width * max(0.03, min(1, p.fraction)))
                                    }
                                }
                                .frame(height: 4)
                            }
                        }
                    }

                    HStack(spacing: 10) {
                        if let entry = primaryEntry, !entry.locked {
                            Button { onPlay(entry) } label: {
                                Label(progress?.partial == true ? "Continue" : "Play", systemImage: "play.fill")
                            }
                            .buttonStyle(PTPrimaryButtonStyle())
                        }

                        Button("Details") { onDetails(tile) }
                            .buttonStyle(PTQuietButtonStyle())
                    }
                }
                .padding(16)
            }
            .background(PTColor.bg)
            .navigationTitle(tile.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Watch: Channels (Pseudo-live 3-channel guide)

@MainActor
private struct WatchChannelsView: View {
    @ObservedObject var model: AppModel
    let series: [LibraryTile]
    let movies: [LibraryTile]
    let clips: [LibraryTile]
    let onOpenCover: (LibraryTile) -> Void

    private struct ProgrammeItem {
        let tile: LibraryTile
        let entry: MediaEntry
        let title: String
        let sub: String?
        let seconds: Int
        let hasKnownDuration: Bool
    }

    private struct GuideBlock: Identifiable {
        let id: String
        let item: ProgrammeItem
        let from: Int
        let to: Int
        let into: Int
        let live: Bool
    }

    private struct ChannelSchedule: Identifiable {
        let number: Int
        let name: String
        let blocks: [GuideBlock]
        let liveBlock: GuideBlock

        var id: Int { number }
    }

    private let minuteWidth: CGFloat = 4.0
    private let channelColWidth: CGFloat = 84.0
    private let guideSpanSeconds = 4 * 3600

    private func programme(for kind: TileKind) -> [ProgrammeItem] {
        switch kind {
        case .show:
            var out: [ProgrammeItem] = []
            for tile in series {
                for item in tile.items.prefix(6) where item.entry.playable {
                    let known = model.history[item.entry.key]?.durationMs ?? 0
                    let hasKnown = known >= 60_000
                    let secs = hasKnown ? Int((known / 1000.0).rounded()) : 42 * 60
                    let epLabel = item.entry.episode ?? (item.episode.map { "E\($0)" } ?? "E1")
                    out.append(ProgrammeItem(
                        tile: tile,
                        entry: item.entry,
                        title: tile.title,
                        sub: epLabel,
                        seconds: max(300, secs),
                        hasKnownDuration: hasKnown
                    ))
                }
            }
            return out
        case .movie:
            return movies.compactMap { tile in
                guard let entry = tile.firstEntry, entry.playable else { return nil }
                let known = model.history[entry.key]?.durationMs ?? 0
                let hasKnown = known >= 60_000
                let secs = hasKnown ? Int((known / 1000.0).rounded()) : 100 * 60
                return ProgrammeItem(tile: tile, entry: entry, title: tile.title, sub: nil, seconds: max(600, secs), hasKnownDuration: hasKnown)
            }
        case .clip:
            return clips.compactMap { tile in
                guard let entry = tile.firstEntry, entry.playable else { return nil }
                let known = model.history[entry.key]?.durationMs ?? 0
                let hasKnown = known >= 60_000
                let secs = hasKnown ? Int((known / 1000.0).rounded()) : 20 * 60
                return ProgrammeItem(tile: tile, entry: entry, title: tile.title, sub: nil, seconds: max(300, secs), hasKnownDuration: hasKnown)
            }
        case .album:
            return []
        }
    }

    private func buildSchedules(nowSeconds: Int) -> (start: Int, channels: [ChannelSchedule]) {
        let start = (nowSeconds / 1800) * 1800
        let specs: [(Int, String, [ProgrammeItem])] = [
            (1, "Series", programme(for: .show)),
            (2, "Films", programme(for: .movie)),
            (3, "Clips", programme(for: .clip))
        ]
        let built: [ChannelSchedule] = specs.compactMap { number, name, list in
            guard !list.isEmpty else { return nil }
            let total = max(1, list.reduce(0) { $0 + $1.seconds })
            var at = start % total
            var idx = 0
            while at >= list[idx].seconds {
                at -= list[idx].seconds
                idx = (idx + 1) % list.count
            }
            var blocks: [GuideBlock] = []
            var cursor = start
            var blockSeq = 0
            while cursor < start + guideSpanSeconds {
                let it = list[idx]
                let from = cursor
                let len = max(1, it.seconds - at)
                let to = min(from + len, start + guideSpanSeconds)
                let isLive = nowSeconds >= from && nowSeconds < from + len
                blocks.append(GuideBlock(
                    id: "\(number)-\(blockSeq)-\(it.entry.key)",
                    item: it,
                    from: from,
                    to: to,
                    into: at,
                    live: isLive
                ))
                cursor = from + len
                at = 0
                idx = (idx + 1) % list.count
                blockSeq += 1
            }
            guard let live = blocks.first(where: \.live) ?? blocks.first else { return nil }
            return ChannelSchedule(number: number, name: name, blocks: blocks, liveBlock: live)
        }
        return (start, built)
    }

    private func hhmm(_ seconds: Int) -> String {
        let wrapped = ((seconds % 86400) + 86400) % 86400
        return String(format: "%02d:%02d", wrapped / 3600, (wrapped % 3600) / 60)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { timeline in
            let comps = Calendar.current.dateComponents([.hour, .minute, .second], from: timeline.date)
            let nowSeconds = (comps.hour ?? 0) * 3600 + (comps.minute ?? 0) * 60 + (comps.second ?? 0)
            let built = buildSchedules(nowSeconds: nowSeconds)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if built.channels.isEmpty {
                        Text("No playable video channels yet.")
                            .font(.callout)
                            .foregroundStyle(PTColor.dim)
                            .padding(.vertical, 24)
                    } else {
                        VStack(spacing: 12) {
                            ForEach(built.channels) { ch in
                                onNowCard(channel: ch, nowSeconds: nowSeconds)
                            }
                        }

                        PTSectionHeader(title: "4-hour guide")
                            .padding(.top, 4)

                        guideGrid(start: built.start, nowSeconds: nowSeconds, channels: built.channels)
                    }
                }
                .padding(16)
            }
            .background(PTColor.bg)
            .refreshable { await model.refresh() }
        }
    }

    private func onNowCard(channel: ChannelSchedule, nowSeconds: Int) -> some View {
        let block = channel.liveBlock
        let into = max(0, min(block.item.seconds, block.into + (nowSeconds - block.from)))
        let remaining = max(60, block.item.seconds - into)
        let frac = block.item.seconds > 0 ? Double(into) / Double(block.item.seconds) : 0
        let hue = Double(watchTitleHue(block.item.title))
        let facts = [block.item.sub, timeLeftText(seconds: Double(remaining))].compactMap { $0 }.joined(separator: " · ")

        return ZStack(alignment: .bottomLeading) {
            PTHeroBackground(hue: hue, showOrb: true)

            VStack(alignment: .leading, spacing: 8) {
                Text("CH \(channel.number) · \(channel.name) · on now")
                    .font(.caption2.weight(.bold))
                    .tracking(1.4)
                    .foregroundStyle(Color.white.opacity(0.82))
                    .textCase(.uppercase)

                Text(block.item.title)
                    .font(.title3.weight(.heavy))
                    .tracking(-0.4)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.white)
                    .lineLimit(2)

                Text(facts)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.white.opacity(0.88))
                    .lineLimit(1)

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.30))
                        Capsule().fill(PTColor.brandHover).frame(width: geo.size.width * max(0.03, min(1, frac)))
                    }
                }
                .frame(height: 4)

                PTWrapLayout(spacing: 8, rowSpacing: 8) {
                    Button {
                        let seekMs: Double? = block.item.hasKnownDuration ? Double(into) * 1000.0 : nil
                        model.play(block.item.entry, at: seekMs)
                    } label: {
                        Label("Watch", systemImage: "play.fill")
                    }
                    .buttonStyle(PTHeroPrimaryButtonStyle(compact: true))
                    .accessibilityLabel("Watch channel \(channel.number): \(block.item.title)")

                    Button("Details") { onOpenCover(block.item.tile) }
                        .buttonStyle(PTHeroSecondaryButtonStyle(compact: true))
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .frame(maxWidth: .infinity, minHeight: 168, alignment: .bottomLeading)
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }

    private func guideGrid(start: Int, nowSeconds: Int, channels: [ChannelSchedule]) -> some View {
        let slots = guideSpanSeconds / 1800
        let nowOffset = channelColWidth + CGFloat(max(0, nowSeconds - start)) / 60.0 * minuteWidth

        return ScrollView(.horizontal, showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    // Time axis
                    HStack(spacing: 0) {
                        Text("Today")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(PTColor.dim)
                            .frame(width: channelColWidth, alignment: .leading)
                        ForEach(0..<slots, id: \.self) { slot in
                            Text(hhmm(start + slot * 1800))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(PTColor.dim)
                                .frame(width: 30.0 * minuteWidth, alignment: .leading)
                        }
                    }
                    .padding(.bottom, 2)

                    // Channel rows
                    ForEach(channels) { ch in
                        HStack(spacing: 4) {
                            HStack(spacing: 5) {
                                Text("\(ch.number)")
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(PTColor.dim)
                                Text(ch.name)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(PTColor.ink)
                                    .lineLimit(1)
                            }
                            .frame(width: channelColWidth - 4, alignment: .leading)

                            ForEach(ch.blocks) { block in
                                let width = max(56, CGFloat(block.to - block.from) / 60.0 * minuteWidth - 4)
                                let hue = Double(watchTitleHue(block.item.title))
                                Button { onOpenCover(block.item.tile) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(block.item.title)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(PTColor.ink)
                                            .lineLimit(1)
                                        Text([block.item.sub, hhmm(block.from)].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption2.monospacedDigit())
                                            .foregroundStyle(PTColor.dim)
                                            .lineLimit(1)
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 7)
                                    .frame(width: width, alignment: .leading)
                                    .background(
                                        Color.hsl(hue: hue, saturation: 0.36, lightness: block.live ? 0.22 : 0.14),
                                        in: RoundedRectangle(cornerRadius: 8)
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 8)
                                            .strokeBorder(block.live ? PTColor.brand : PTColor.line, lineWidth: block.live ? 1.5 : 1)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(10)

                Rectangle()
                    .fill(PTColor.brand)
                    .frame(width: 2)
                    .offset(x: nowOffset + 10, y: 24)
                    .allowsHitTesting(false)
            }
            .background(PTColor.surface, in: RoundedRectangle(cornerRadius: PTRadius.card))
            .overlay(RoundedRectangle(cornerRadius: PTRadius.card).strokeBorder(PTColor.line, lineWidth: 1))
        }
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
                    PosterView(title: tile.title, year: tile.year, kind: tile.kind, url: model.posterURL(imdb: tile.imdb))
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
                        kind: tile.kind,
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
                WideArtView(title: tile.title, kind: tile.kind, backdropURL: nil, posterURL: nil)
            } else {
                HStack(alignment: .top, spacing: 16) {
                    PosterView(title: tile.title, year: tile.year, kind: tile.kind, url: model.posterURL(imdb: tile.imdb))
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
