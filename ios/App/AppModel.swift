import Foundation
import SwiftUI
import UIKit

struct RouteSnapshot: Equatable {
    let key: String
    let label: String
    let peers: Int
    let downBps: Double
    let upBps: Double
    let rxBytes: Double
    let txBytes: Double
}

struct NetworkSnapshot: Equatable {
    let lan: RouteSnapshot
    let internet: RouteSnapshot
    let privateRoute: RouteSnapshot
    let downBps: Double
    let upBps: Double
    let rxBytes: Double
    let txBytes: Double
    let cachedBytes: Double
    let cacheMaxBytes: Double
    let reciprocityRatio: Double

    var routes: [RouteSnapshot] { [lan, internet, privateRoute] }
    var totalPeers: Int { lan.peers + internet.peers + privateRoute.peers }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var settings = Settings()
    @Published var status: [String: Any] = [:]
    @Published private(set) var downBpsHistory: [Double] = []
    @Published private(set) var upBpsHistory: [Double] = []
    @Published var identity: [String: Any] = [:]
    @Published var entries: [MediaEntry] = [] {
        didSet {
            catalog = LibraryCatalog.build(entries: entries)
            music.restoreIfNeeded(catalog: catalog)
        }
    }
    @Published private(set) var catalog = LibraryCatalog.empty
    @Published var history: [String: WatchProgress] = [:]
    @Published var cast: [String: Any] = [:]
    @Published var selectedReceiver: String?
    @Published var pendingCast: MediaEntry?
    @Published var pendingCastPosition: Double = 0
    @Published var query = ""
    /// A search across relays the app does not follow (src/search.js): the query asked, its rows and when.
    @Published var globalQuery = ""
    @Published var globalRows: [[String: Any]] = []
    @Published var globalBusy = false
    @Published var globalError: String?
    private var globalAskedAt = Date.distantPast
    @Published var filter = "All"
    @Published var sourceFilter = ""
    @Published var room: Room = .home {
        didSet {
            if room != oldValue {
                try? storage?.save(UIPreferences(lastRoom: room), name: "ui-state.json")
            }
        }
    }
    @Published var focusSearchTrigger = 0
    @Published var showAdd = false
    @Published var pendingAddURL: String?
    @Published var identifyURLString = ""
    @Published var identifyBusy = false
    @Published var identifyResult: IdentifyResult?
    @Published var identifyError: String?
    @Published var jobs: [AcquireJob] = []
    private var previousActiveJobIDs: Set<String> = []
    @Published var enabledSources: Set<MediaSourceKind> = Set(MediaSourceKind.allCases)
    @Published var sourceSearchQuery = ""
    @Published var sourceSearchResponse: SourceSearchResponse?
    @Published var sourceSearchBusy = false
    @Published var sourceSearchError: String?
    @Published var saveStates: [String: InlineSaveState] = [:]
    @Published var visitedShelves: [VisitedShelf] = []
    @Published var discoverCreators: [DiscoverCreator] = []
    @Published var discoverFeed: DiscoverFeed?
    @Published var discoverBrowse: DiscoverBrowseResult?
    @Published var discoverLoading = false
    @Published var discoverFollowBusy = false
    @Published var discoverError: String?
    @Published var discoverSourceFilter = ""
    @Published var discoverCreatorFilter = ""
    @Published var discoverActiveTopic = ""
    @Published var soulseekSettings = SoulseekSettings()
    @Published var soulseekSettingsBusy = false
    @Published var soulseekSettingsMessage: String?
    @Published var soulseekSettingsError: String?
    @Published var showMusicPlayer = false
    @Published var showSettings = false
    @Published var showDiagnostics = false
    @Published var showCast = false
    @Published var showRemote = false
    @Published var showScanner = false
    @Published var shareURI: String?
    @Published var error: String?
    @Published var notice: String?
    @Published var downloads: [String: Double] = [:]
    private var downloadTasks: [String: Task<Void, Never>] = [:]
    /// True while the node is starting; follows `node`.
    @Published private(set) var busy = false
    @Published var soundfontBusy = false
    @Published var soundfontPresent = false
    let player = NativePlayer(keepScreenAwake: true)
    let music = MusicController()
    private(set) var storage: AppStorage?
    private var worker: Worker?
    /// The worklet's one-time `init`; `runStart` awaits it so it reaches the worklet first.
    private var workerInit: Task<Void, Never>?
    /// The node's lifecycle. A second start while one runs waits for it instead of reopening the node.
    private enum NodePhase { case idle, starting(Task<Void, Never>), running }
    private var node = NodePhase.idle {
        didSet { if case .starting = node { busy = true } else { busy = false } }
    }
    private var running: Bool { if case .running = node { return true } else { return false } }
    private var background = false
    private var refreshInFlight = false
    private var refreshAgain = false
    private var pollTask: Task<Void, Never>?
    private var historySaved = Date.distantPast
    private var evidenceSaved = Date.distantPast
    private var tickCount = 0

    init() {
        do {
            let args = ProcessInfo.processInfo.arguments
            let suffixIndex = args.firstIndex(of: "-peartube-storage")
            let suffix = suffixIndex.flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
            let storage = try AppStorage(suffix: suffix); self.storage = storage
            settings = storage.load("settings.json", fallback: Settings())
            history = storage.load("watch-history.json", fallback: [String: WatchProgress]())
            let prefs = storage.load("ui-state.json", fallback: UIPreferences())
            room = prefs.lastRoom
            let musicState = storage.load("music-state.json", fallback: PersistedMusicState())
            music.loadPersisted(musicState)
            visitedShelves = storage.load("visited-shelves.json", fallback: [VisitedShelf]())
            soundfontPresent = FileManager.default.fileExists(atPath: storage.soundfont.path)

            music.onBeforeStartMusic = { [weak self] in self?.closePlaybackForMusic() }
            music.onWarmKey = { [weak self] key in
                Task { _ = try? await self?.worker?.request("warm", ["key": key]) }
            }
            music.soundfontPath = { [weak self] in
                guard let self, self.soundfontPresent else { return nil }
                return self.storage?.soundfont.path
            }
            music.onSaveState = { [weak self] state in
                try? self?.storage?.save(state, name: "music-state.json")
            }
            music.onNotice = { [weak self] message in
                self?.notice = message
            }

            let worker = try Worker(); self.worker = worker
            worker.onEvent = { [weak self] event in self?.receive(event) }
            // The worklet takes its cast storage once, before any other method reaches it (the Mac and the
            // phone send it the moment their worker exists). `runStart` waits for this before `start`.
            let castStorage = self.castStorage
            workerInit = Task { _ = try? await worker.request("init", ["castStorage": castStorage]) }
            Task { await start() }
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let self else { return }
                    self.music.poll()
                    if self.background { continue }
                    self.player.poll(); self.tickCount += 1
                    self.recordProgress()
                    if self.tickCount % 8 == 0 {
                        await self.refresh()
                        if self.hasActiveJobs || self.showAdd {
                            await self.refreshJobs(silent: true)
                        }
                    }
                    self.writeEvidence()
                }
            }
        } catch { self.error = error.localizedDescription; showSettings = true }
    }

    func normalizeSettings(_ raw: [String: Any], requireChannel: Bool = false) async throws -> Settings {
        guard let worker else { throw AppFailure("The embedded worker is unavailable.") }
        let res = try await worker.request("normalizeSettings", ["settings": raw, "requireChannel": requireChannel]) as? [String: Any] ?? [:]
        let data = try JSONSerialization.data(withJSONObject: res)
        return try JSONDecoder().decode(Settings.self, from: data)
    }

    // Launch arguments (UI tests, dev runs) apply once per launch, so a later Settings save sticks.
    private var launchArgumentsApplied = false
    private func applyLaunchArguments() async throws {
        guard !launchArgumentsApplied else { return }
        let args = ProcessInfo.processInfo.arguments
        func argument(_ name: String) -> String? { guard let i = args.firstIndex(of: name), args.indices.contains(i + 1) else { return nil }; return args[i + 1] }
        guard ["-peartube-tracker", "-peartube-bootstrap", "-peartube-lan", "-peartube-relays", "-peartube-private"].contains(where: { argument($0) != nil }) else { launchArgumentsApplied = true; return }
        // Start from everything saved (phrase, cache limit, …) and overlay only what the arguments name.
        var raw = settings.json
        if let v = argument("-peartube-tracker") { raw["tracker"] = v }
        if let v = argument("-peartube-relays") { raw["relayThrough"] = v }
        if let v = argument("-peartube-bootstrap") { raw["bootstrap"] = v }
        if let v = argument("-peartube-lan") { raw["lanDiscovery"] = v.lowercased() == "true" }
        if let v = argument("-peartube-private") { raw["privateRouting"] = v.lowercased() == "true" }
        var next = try await normalizeSettings(raw, requireChannel: false)
        next.configured = true
        settings = next
        try storage?.save(settings, name: "settings.json")
        launchArgumentsApplied = true
    }
    func start() async {
        if case .starting(let current) = node { await current.value; return }
        let task = Task { await runStart() }
        node = .starting(task)
        await task.value
    }
    private func runStart() async {
        defer { writeEvidence(force: true) }
        guard let worker, let storage else { node = .idle; return }
        do {
            _ = await workerInit?.value
            try await applyLaunchArguments()
            let params: [String: Any] = [
                "trackersDir": storage.trackers.path,
                "defaultFolder": "default",
                "settings": settings.json
            ]
            status = try await worker.request("start", params) as? [String: Any] ?? [:]
            recordNetworkSample()
            node = .running
            await refreshCast()
            await refresh()
            await refreshJobs(silent: true)
            await loadSoulseekSettings()
        } catch { node = .idle; self.error = error.localizedDescription }
    }
    func save(_ next: Settings) async {
        guard !busy else { return }
        do {
            try storage?.save(next, name: "settings.json")
            recordProgress(force: true); player.close(); music.stop()
            settings = next; entries = []; status = [:]; downBpsHistory = []; upBpsHistory = []; sourceFilter = ""; showSettings = false
            await start()
        } catch { self.error = error.localizedDescription }
    }
    private func receive(_ event: [String: Any]) {
        switch event.string("event") {
        case "update": Task {
            await refresh()
            // Later answers to a recent global search arrive as updates: ask the same query again.
            if !globalBusy && Date().timeIntervalSince(globalAskedAt) < 60 { await fetchGlobal() }
        }
        case "cast": cast = event.object("cast"); recordProgress(); reconcileBackground()
        case "sources":
            settings.sources = event.objects("sources").map(SourceSpec.init)
            do { try storage?.save(settings, name: "settings.json") } catch { self.error = error.localizedDescription }
            Task { await refresh() }
        case "fatal": error = event.string("error").isEmpty ? "The embedded P2P worker stopped." : event.string("error")
        default: break
        }
        writeEvidence(force: true)
    }
    func refresh() async {
        guard running, !background || !session.isEmpty else { return }
        if refreshInFlight { refreshAgain = true; return }
        refreshInFlight = true
        defer { refreshInFlight = false }
        repeat {
            refreshAgain = false
            do {
                guard let worker else { return }
                status = try await worker.request("status") as? [String: Any] ?? [:]
                recordNetworkSample()
                let rows = try await worker.request("search", ["id": NSNull()]) as? [[String: Any]] ?? []
                if let ident = try? await worker.request("identity", ["revealMnemonic": false]) as? [String: Any] { identity = ident }
                var seen = Set<String>()
                entries = rows.map(MediaEntry.init).filter { !$0.key.isEmpty && seen.insert($0.key).inserted }
                if showCast || showRemote || !session.isEmpty { await refreshCast() }
            } catch { self.error = error.localizedDescription; break }
        } while refreshAgain && running
        writeEvidence(force: true)
    }
    var apiBaseURL: URL? {
        let raw = status.string("apiUrl")
        return raw.isEmpty ? nil : URL(string: raw)
    }
    var loopback: LoopbackApi? { apiBaseURL.map { LoopbackApi(baseURL: $0) } }
    var activeJobs: [AcquireJob] { jobs.filter(\.isActive) }
    var hasActiveJobs: Bool { jobs.contains(where: \.isActive) }
    func posterURL(imdb: String?) -> URL? {
        guard let imdb, !imdb.isEmpty, let apiBaseURL else { return nil }
        return apiBaseURL.appendingPathComponent("v1/poster/\(imdb)")
    }
    func backdropURL(imdb: String?) -> URL? {
        guard let imdb, !imdb.isEmpty, let apiBaseURL else { return nil }
        return apiBaseURL.appendingPathComponent("v1/backdrop/\(imdb)")
    }
    func discoverImageURL(_ path: String) -> URL? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("/") {
            guard let apiBaseURL else { return nil }
            return URL(string: trimmed, relativeTo: apiBaseURL)?.absoluteURL
        }
        return URL(string: trimmed)
    }
    var sources: [[String: Any]] { status.objects("sources") }
    var discovered: [[String: Any]] { status.objects("discoveredSources") }
    var receivers: [CastReceiver] { cast.objects("receivers").map { CastReceiver(json: $0) } }
    var session: [String: Any] { cast.object("session") }
    var remoteState: PlaybackState { PlaybackState(json: session.object("state")) }
    var contextualQuery: Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed.count == 64 && trimmed.allSatisfy(\.isHexDigit))
            || trimmed.lowercased().hasPrefix("peartube:")
            || isHTTPURL(trimmed)
    }
    var visibleEntries: [MediaEntry] {
        entries.filter { entry in
            (contextualQuery || query.isEmpty || "\(entry.title) \(entry.mediaID)".localizedCaseInsensitiveContains(query)) &&
            (sourceFilter.isEmpty || entry.source == sourceFilter) &&
            (filter != "Movies" || entry.episode == nil) && (filter != "Series" || entry.episode != nil) && (filter != "On Device" || entry.saved)
        }.sorted { a, b in a.title.localizedStandardCompare(b.title) == .orderedAscending }
    }
    var continueEntries: [MediaEntry] {
        entries.filter { !$0.isAlbumTrack && history[$0.key]?.partial == true }
            .sorted { (history[$0.key]?.updatedAt ?? 0) > (history[$1.key]?.updatedAt ?? 0) }
    }
    var continueVideos: [(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)] {
        var out: [(tile: LibraryTile, entry: MediaEntry, progress: WatchProgress)] = []
        for tile in catalog.allVideos {
            for item in tile.items {
                if let p = history[item.entry.key], p.partial {
                    out.append((tile: tile, entry: item.entry, progress: p))
                }
            }
        }
        return out.sorted { $0.progress.updatedAt > $1.progress.updatedAt }
    }
    func seriesNext(_ episodes: [MediaEntry]) -> MediaEntry? {
        let ordered = episodes.sorted { $0.episodeOrder < $1.episodeOrder }
        guard let latest = ordered.filter({ history[$0.key] != nil }).max(by: { (history[$0.key]?.updatedAt ?? 0) < (history[$1.key]?.updatedAt ?? 0) }) else { return ordered.first }
        if history[latest.key]?.partial == true { return latest }
        guard let i = ordered.firstIndex(of: latest), ordered.indices.contains(i + 1) else { return ordered.first }
        return ordered[i + 1]
    }
    func resumePosition(_ entry: MediaEntry) -> Double { history[entry.key].flatMap { $0.partial ? $0.positionMs : nil } ?? 0 }

    var networkSnapshot: NetworkSnapshot {
        let routesDict = status.object("routes")
        func makeRoute(_ key: String, label: String, fallbackPeers: Int = 0) -> RouteSnapshot {
            let r = routesDict.object(key)
            let peers = r["peers"] != nil ? Int(r.number("peers")) : fallbackPeers
            return RouteSnapshot(
                key: key,
                label: label,
                peers: max(0, peers),
                downBps: max(0, r.number("downBps")),
                upBps: max(0, r.number("upBps")),
                rxBytes: max(0, r.number("rxBytes")),
                txBytes: max(0, r.number("txBytes"))
            )
        }
        let lan = makeRoute("lan", label: "Home network", fallbackPeers: Int(status.number("lanPeers")))
        let internet = makeRoute("public", label: "Internet", fallbackPeers: Int(status.number("peers")))
        let priv = makeRoute("private", label: "Private route")
        let rx = max(0, status.number("rxBytes"))
        let tx = max(0, status.number("txBytes"))
        let cached = max(0, status.number("cachedBytes"))
        let rawMax = status.number("cacheMaxBytes")
        let cacheMax = rawMax > 0 ? rawMax : Double(max(1, settings.cacheMaxGb)) * 1024.0 * 1024.0 * 1024.0
        let rec = status.object("reciprocity")
        let ratio = rec["ratio"] != nil ? max(0, rec.number("ratio")) : (rx > 0 ? tx / rx : 0)
        return NetworkSnapshot(
            lan: lan,
            internet: internet,
            privateRoute: priv,
            downBps: max(0, status.number("downBps")),
            upBps: max(0, status.number("upBps")),
            rxBytes: rx,
            txBytes: tx,
            cachedBytes: cached,
            cacheMaxBytes: cacheMax,
            reciprocityRatio: ratio
        )
    }

    private func recordNetworkSample() {
        guard !status.isEmpty else { return }
        downBpsHistory.append(max(0, status.number("downBps")))
        upBpsHistory.append(max(0, status.number("upBps")))
        if downBpsHistory.count > 40 {
            downBpsHistory.removeFirst(downBpsHistory.count - 40)
        }
        if upBpsHistory.count > 40 {
            upBpsHistory.removeFirst(upBpsHistory.count - 40)
        }
    }

    func primaryEntry(for tile: LibraryTile) -> MediaEntry? {
        if tile.kind == .show {
            return seriesNext(tile.items.map(\.entry))
        }
        return tile.firstEntry
    }

    func pickSurpriseVideo(excluding excludedTileKey: String? = nil, from poolSource: [LibraryTile]? = nil) -> LibraryTile? {
        let base = (poolSource ?? catalog.allVideos).filter { tile in
            guard let entry = primaryEntry(for: tile) else { return false }
            return entry.playable
        }
        guard !base.isEmpty else { return nil }
        let candidates = base.filter { $0.key != excludedTileKey }
        let usable = candidates.isEmpty ? base : candidates
        func isUnwatched(_ tile: LibraryTile) -> Bool {
            !tile.items.contains { (history[$0.entry.key]?.positionMs ?? 0) > 0 }
        }
        func isSaved(_ tile: LibraryTile) -> Bool {
            tile.isFullySaved || tile.saved > 0
        }
        let savedUnwatched = usable.filter { isSaved($0) && isUnwatched($0) }
        if let pick = savedUnwatched.randomElement() { return pick }
        let anyUnwatched = usable.filter { isUnwatched($0) }
        if let pick = anyUnwatched.randomElement() { return pick }
        let anySaved = usable.filter { isSaved($0) }
        if let pick = anySaved.randomElement() { return pick }
        return usable.randomElement()
    }

    func playRandomVideo(excluding excludedTileKey: String? = nil, from poolSource: [LibraryTile]? = nil) {
        guard let tile = pickSurpriseVideo(excluding: excludedTileKey, from: poolSource),
              let entry = primaryEntry(for: tile) else { return }
        play(entry)
    }

    func openSearch(query text: String? = nil, askRelays: Bool = false) {
        room = .search
        if let text {
            query = text
            if askRelays {
                Task { await searchAll(text) }
            }
        } else {
            focusSearchTrigger += 1
        }
    }

    func play(_ entry: MediaEntry, at position: Double? = nil, localOnly: Bool = false) {
        if entry.locked {
            error = "Subscriber pass needed: paste this channel's peartube://access/… pass to unlock."
            return
        }
        if entry.canQueueAsTrack {
            if let row = catalog.trackRow(forKey: entry.key) {
                if let album = catalog.tile(forKey: row.albumKey) {
                    let tracks = catalog.tracks(forAlbum: album)
                    let idx = tracks.firstIndex { $0.entry.key == entry.key } ?? 0
                    music.playTrackList(tracks, startIndex: idx, sourceLabel: album.album.isEmpty ? album.title : album.album)
                } else {
                    music.playTrackList([row], startIndex: 0, sourceLabel: row.albumTitle)
                }
                return
            }
        }
        let start = position ?? resumePosition(entry)
        if !localOnly, let receiver = session["receiverId"] as? String ?? selectedReceiver {
            Task { await castPlay(receiver: receiver, entry: entry, position: start) }; return
        }
        // Rule 3: Music waits for a video. Pause music, keep its track/position/queue, and mark `Paused for a video`.
        music.pauseForVideo()
        showMusicPlayer = false
        recordProgress(force: true)
        let warmKey = entry.key
        Task { _ = try? await self.worker?.request("warm", ["key": warmKey]) }
        let sf2 = soundfontPresent ? storage?.soundfont.path : nil
        player.open(entry, at: start, soundfont: sf2)
        showSettings = false
        writeEvidence(force: true)
    }

    func switchFormat(_ entry: MediaEntry) {
        let position = player.state.positionMs
        let paused = !player.state.playing
        recordProgress(force: true)
        let warmKey = entry.key
        Task { _ = try? await self.worker?.request("warm", ["key": warmKey]) }
        player.open(entry, at: position, paused: paused, soundfont: soundfontPresent ? storage?.soundfont.path : nil)
    }

    func closePlayback() {
        recordProgress(force: true)
        player.close(deactivateAudioSession: !music.isPlaying)
        writeEvidence(force: true)
    }

    /// Rule 4: Starting music closes an open video while preserving its watch position for Keep playing.
    private func closePlaybackForMusic() {
        guard player.entry != nil else { return }
        recordProgress(force: true)
        player.close(deactivateAudioSession: false)
        writeEvidence(force: true)
    }

    func recordProgress(force: Bool = false) {
        let key = player.entry?.key ?? session.object("state").object("entry").string("key")
        let playback = player.entry == nil ? remoteState : player.state
        guard !key.isEmpty, playback.positionMs > 0 else { return }
        let previous = history[key]
        if force || previous?.positionMs != playback.positionMs || previous?.durationMs != playback.durationMs {
            history[key] = WatchProgress(positionMs: playback.positionMs, durationMs: playback.durationMs, updatedAt: Date().timeIntervalSince1970 * 1000)
        }
        if force || Date().timeIntervalSince(historySaved) > 5 {
            do { try storage?.save(history, name: "watch-history.json"); historySaved = Date() } catch { self.error = error.localizedDescription }
        }
    }
    func clearHistory() { history = [:]; do { try storage?.save(history, name: "watch-history.json") } catch { self.error = error.localizedDescription } }
    func openURI(_ raw: String) async {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Handle `peartube://add?url=<encoded>` deep links (from Share Extension or external links).
        if let deepTarget = extractAddDeepLinkTarget(from: trimmed) {
            if isHTTPURL(deepTarget) {
                openAddSheet(with: deepTarget)
                return
            }
            // Fall through to open non-HTTP targets (peartube://channel/... or 64-hex key).
            await openURI(deepTarget)
            return
        }

        // Direct web/media URLs (SoundCloud, YouTube, Rumble, direct files) open Add to Library + ubit identify.
        if isHTTPURL(trimmed) {
            openAddSheet(with: trimmed)
            return
        }

        let input = trimmed
        do {
            guard let worker else { throw AppFailure("The embedded worker is unavailable.") }
            if !running { await start() }
            guard running else { throw AppFailure("The P2P worker has not started.") }
            let result = try await worker.request("openUri", ["uri": input]) as? [String: Any] ?? [:]
            if !result.object("source").isEmpty {
                let spec = SourceSpec(result.object("source")); settings.add(spec); settings.configured = true
                try storage?.save(settings, name: "settings.json"); showSettings = false; showAdd = false
            }
            if !result.object("entry").isEmpty {
                showAdd = false
                play(MediaEntry(result.object("entry")))
            }
            if result.string("action") == "receiver" {
                showAdd = false
                await refreshCast()
                let id = result.object("receiver").string("id")
                guard let receiver = receivers.first(where: { $0.id == id }) else { throw AppFailure("The paired receiver is missing from the saved TV list.") }
                await selectReceiver(receiver)
            }
            query = ""; await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func openAddSheet(with url: String) {
        let target = extractSharedURL(from: url) ?? url.trimmingCharacters(in: .whitespacesAndNewlines)
        pendingAddURL = target
        identifyResult = nil
        identifyError = nil
        showAdd = true
        if isHTTPURL(target) {
            Task { await identifyURL(target) }
        }
        Task { await refreshJobs(silent: true) }
    }

    func resetIdentify() {
        identifyURLString = ""
        identifyResult = nil
        identifyError = nil
        identifyBusy = false
    }

    private func ensureLoopback() async throws -> LoopbackApi {
        if !running { await start() }
        if let api = loopback { return api }
        if running { await refresh() }
        guard let api = loopback else {
            throw AppFailure("The local peer engine is not ready yet.")
        }
        return api
    }

    func identifyURL(_ raw: String) async {
        guard let extracted = extractSharedURL(from: raw), isHTTPURL(extracted) else { return }
        identifyURLString = extracted
        identifyBusy = true
        identifyError = nil
        identifyResult = nil
        defer { if identifyURLString == extracted { identifyBusy = false } }
        do {
            let api = try await ensureLoopback()
            let result = try await api.identify(url: extracted)
            if identifyURLString == extracted {
                identifyResult = result
            }
        } catch {
            if identifyURLString == extracted {
                identifyError = error.localizedDescription
            }
        }
    }

    func acquireURL(
        url: String,
        id: String,
        title: String,
        page: Bool,
        audioOnly: Bool,
        artist: String
    ) async -> Bool {
        let cleanURL = extractSharedURL(from: url) ?? url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isHTTPURL(cleanURL) else {
            identifyError = "Enter an http(s) link."
            return false
        }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = cleanTitle.isEmpty ? "Untitled" : cleanTitle
        let cleanArtist = artist.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanId = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalId = cleanId.isEmpty
            ? "clip:\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased())"
            : cleanId
        let music: MusicMeta? = (audioOnly || !cleanArtist.isEmpty)
            ? MusicMeta(title: finalTitle, artist: cleanArtist.isEmpty ? nil : cleanArtist)
            : nil
        do {
            let api = try await ensureLoopback()
            let job = try await api.acquire(
                id: finalId,
                title: finalTitle,
                url: cleanURL,
                page: page,
                audio: audioOnly,
                music: music
            )
            upsertJob(job)
            await refreshJobs(silent: true)
            notice = "Added to library queue: \(finalTitle)"
            return true
        } catch {
            identifyError = error.localizedDescription
            return false
        }
    }

    private func upsertJob(_ job: AcquireJob) {
        jobs.removeAll { $0.jobId == job.jobId }
        jobs.insert(job, at: 0)
        reconcileBackground()
    }

    func refreshJobs(silent: Bool = false) async {
        guard running, let api = loopback else { return }
        do {
            let next = try await api.listJobs()
            let nowActive = Set(next.filter(\.isActive).map(\.jobId))
            let completedNow = previousActiveJobIDs.contains { id in
                next.first(where: { $0.jobId == id })?.isDone == true
            }
            previousActiveJobIDs = nowActive
            jobs = next.sorted { lhs, rhs in
                if lhs.isActive != rhs.isActive { return lhs.isActive }
                return lhs.created > rhs.created
            }
            reconcileBackground()
            if completedNow {
                await refresh()
            }
        } catch {
            if !silent { self.error = error.localizedDescription }
        }
    }

    func cancelOrDismissJob(_ jobId: String) async {
        do {
            let api = try await ensureLoopback()
            try await api.cancelJob(jobId: jobId)
            jobs.removeAll { $0.jobId == jobId && !$0.isActive }
            await refreshJobs(silent: true)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func toggleSource(_ source: MediaSourceKind) {
        if enabledSources.contains(source) {
            enabledSources.remove(source)
        } else {
            enabledSources.insert(source)
        }
    }

    func searchAll(_ raw: String) async {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        async let globalTask: Void = searchGlobal(q)
        async let sourceTask: Void = searchSources(q)
        _ = await (globalTask, sourceTask)
    }

    func searchSources(_ raw: String) async {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        let selected = MediaSourceKind.allCases.filter { enabledSources.contains($0) }
        sourceSearchQuery = q
        sourceSearchError = nil
        if selected.isEmpty {
            sourceSearchResponse = SourceSearchResponse(query: q)
            sourceSearchError = "Select at least one source above to search."
            return
        }
        sourceSearchBusy = true
        defer { if sourceSearchQuery == q { sourceSearchBusy = false } }
        do {
            let api = try await ensureLoopback()
            let response = try await api.searchSources(query: q, sources: selected)
            if sourceSearchQuery == q {
                sourceSearchResponse = response
            }
        } catch {
            if sourceSearchQuery == q {
                sourceSearchError = error.localizedDescription
            }
        }
    }

    func mirrorSoulseekAlbum(stateKey: String, peer: String, files: [[String: Any]], title: String) async {
        saveStates[stateKey] = .saving
        do {
            let api = try await ensureLoopback()
            let job = try await api.mirrorSoulseek(peer: peer, files: files, title: title)
            upsertJob(job)
            saveStates[stateKey] = .saved("Queued")
            await refreshJobs(silent: true)
            notice = "Saving \(title) from \(peer)"
        } catch {
            saveStates[stateKey] = .failed(error.localizedDescription)
        }
    }

    func mirrorYouTubeTrack(_ candidate: SourceCandidate) async {
        guard let videoId = candidate.videoId, !videoId.isEmpty else {
            saveStates[candidate.id] = .failed("Missing video ID.")
            return
        }
        saveStates[candidate.id] = .saving
        let (artist, trackTitle) = splitArtistAndTitle(candidate.title, fallbackAuthor: candidate.displayAuthor, defaultArtist: "YouTube")
        let album = candidate.album.flatMap { $0.isEmpty ? nil : $0 } ?? trackTitle
        do {
            let api = try await ensureLoopback()
            let job = try await api.mirrorYouTube(
                artist: artist,
                album: album,
                tracks: [["videoId": videoId, "title": trackTitle, "track": 1, "disc": 1]]
            )
            upsertJob(job)
            saveStates[candidate.id] = .saved("Queued")
            await refreshJobs(silent: true)
            notice = "Saving track: \(trackTitle)"
        } catch {
            saveStates[candidate.id] = .failed(error.localizedDescription)
        }
    }

    func mirrorSoundCloudTrack(_ candidate: SourceCandidate) async {
        saveStates[candidate.id] = .saving
        let (artist, trackTitle) = splitArtistAndTitle(candidate.title, fallbackAuthor: candidate.displayAuthor, defaultArtist: "SoundCloud")
        let album = candidate.album.flatMap { $0.isEmpty ? nil : $0 } ?? trackTitle
        var track: [String: Any] = ["title": trackTitle, "track": 1, "disc": 1]
        if let tid = candidate.trackId, !tid.isEmpty { track["trackId"] = tid }
        if let u = candidate.url, !u.isEmpty { track["url"] = u }
        do {
            let api = try await ensureLoopback()
            let job = try await api.mirrorSoundCloud(artist: artist, album: album, tracks: [track])
            upsertJob(job)
            saveStates[candidate.id] = .saved("Queued")
            await refreshJobs(silent: true)
            notice = "Saving track: \(trackTitle)"
        } catch {
            saveStates[candidate.id] = .failed(error.localizedDescription)
        }
    }

    func mirrorRumbleItem(_ candidate: SourceCandidate, audio: Bool) async {
        let stateKey = "\(candidate.id):\(audio ? "audio" : "video")"
        guard let url = candidate.url, !url.isEmpty else {
            saveStates[stateKey] = .failed("Missing Rumble URL.")
            return
        }
        saveStates[stateKey] = .saving
        do {
            let api = try await ensureLoopback()
            let job = try await api.mirrorRumble(title: candidate.title, url: url, rumbleId: candidate.rumbleId, audio: audio)
            upsertJob(job)
            saveStates[stateKey] = .saved(audio ? "Audio queued" : "Video queued")
            await refreshJobs(silent: true)
            notice = "Saving \(audio ? "audio" : "video"): \(candidate.title)"
        } catch {
            saveStates[stateKey] = .failed(error.localizedDescription)
        }
    }

    private func splitArtistAndTitle(_ rawTitle: String, fallbackAuthor: String, defaultArtist: String) -> (String, String) {
        let cleanAuthor = fallbackAuthor.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTitle = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanAuthor.isEmpty {
            return (cleanAuthor, cleanTitle.isEmpty ? "Untitled" : cleanTitle)
        }
        for sep in [" - ", " – ", " — "] {
            if let range = cleanTitle.range(of: sep) {
                let left = String(cleanTitle[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                let right = String(cleanTitle[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !left.isEmpty && !right.isEmpty { return (left, right) }
            }
        }
        return (defaultArtist, cleanTitle.isEmpty ? "Untitled" : cleanTitle)
    }

    func browseSoulseekShelf(peer: String, refresh: Bool = false) async throws -> SoulseekShelf {
        recordVisitedShelf(peer: peer)
        let api = try await ensureLoopback()
        let shelf = try await api.browseSoulseek(peer: peer, refresh: refresh)
        recordVisitedShelf(peer: shelf.peer.isEmpty ? peer : shelf.peer, trackCount: shelf.tracks, folderCount: shelf.folders.count)
        return shelf
    }

    func recordVisitedShelf(peer: String, trackCount: Int? = nil, folderCount: Int? = nil) {
        let clean = peer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let existing = visitedShelves.first { $0.peer.caseInsensitiveCompare(clean) == .orderedSame }
        visitedShelves.removeAll { $0.peer.caseInsensitiveCompare(clean) == .orderedSame }
        let entry = VisitedShelf(
            peer: clean,
            visitedAt: Date().timeIntervalSince1970 * 1000,
            trackCount: trackCount ?? existing?.trackCount,
            folderCount: folderCount ?? existing?.folderCount
        )
        visitedShelves.insert(entry, at: 0)
        if visitedShelves.count > 30 {
            visitedShelves = Array(visitedShelves.prefix(30))
        }
        try? storage?.save(visitedShelves, name: "visited-shelves.json")
    }

    func removeVisitedShelf(peer: String) {
        visitedShelves.removeAll { $0.peer.caseInsensitiveCompare(peer) == .orderedSame }
        try? storage?.save(visitedShelves, name: "visited-shelves.json")
    }

    // MARK: - Discover v2

    func discoverStateKey(for item: DiscoverItem, audioOverride: Bool = false) -> String {
        audioOverride ? "discover:\(item.id):audio" : "discover:\(item.id)"
    }

    func isDiscoverItemInLibrary(_ item: DiscoverItem) -> Bool {
        if item.inLibrary { return true }
        if !item.acquireId.isEmpty {
            if entries.contains(where: { $0.mediaID.caseInsensitiveCompare(item.acquireId) == .orderedSame }) {
                return true
            }
            if jobs.contains(where: { $0.isDone && $0.mediaId.caseInsensitiveCompare(item.acquireId) == .orderedSame }) {
                return true
            }
        }
        return false
    }

    func isDiscoverItemAdding(_ item: DiscoverItem, audioOverride: Bool = false) -> Bool {
        let key = discoverStateKey(for: item, audioOverride: audioOverride)
        if saveStates[key] == .saving { return true }
        if !audioOverride, !item.acquireId.isEmpty {
            return jobs.contains(where: { $0.isActive && $0.mediaId.caseInsensitiveCompare(item.acquireId) == .orderedSame })
        }
        return false
    }

    func isDiscoverCreatorFollowed(_ item: DiscoverItem) -> Bool {
        let itemURL = item.creatorUrl.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let itemName = item.creatorName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return discoverCreators.contains { c in
            if !item.creatorId.isEmpty && c.id == item.creatorId { return true }
            if !itemURL.isEmpty && c.url.lowercased() == itemURL { return true }
            if !itemName.isEmpty && c.source.lowercased() == item.source.lowercased() && c.name.lowercased() == itemName {
                return true
            }
            return false
        }
    }

    func loadDiscoverCreators() async {
        do {
            let api = try await ensureLoopback()
            discoverCreators = try await api.listDiscoverCreators()
        } catch {
            discoverError = error.localizedDescription
        }
    }

    func loadDiscoverFeed(refresh: Bool = false) async {
        discoverLoading = true
        discoverError = nil
        defer { discoverLoading = false }
        do {
            let api = try await ensureLoopback()
            let feed = try await api.getDiscoverFeed(
                source: discoverSourceFilter.isEmpty ? nil : discoverSourceFilter,
                creatorId: discoverCreatorFilter.isEmpty ? nil : discoverCreatorFilter,
                refresh: refresh
            )
            discoverFeed = feed
            discoverCreators = feed.creators
        } catch {
            discoverError = error.localizedDescription
        }
    }

    @discardableResult
    func followDiscoverCreator(url: String, name: String? = nil) async -> Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        discoverFollowBusy = true
        discoverError = nil
        defer { discoverFollowBusy = false }
        do {
            let api = try await ensureLoopback()
            let res = try await api.followDiscoverCreator(url: trimmed, name: name)
            discoverCreators = res.creators
            if var browse = discoverBrowse, let followed = res.creator {
                browse.creators = browse.creators.map { c in
                    var copy = c
                    if c.id == followed.id || c.url.caseInsensitiveCompare(followed.url) == .orderedSame {
                        copy.followed = true
                    }
                    return copy
                }
                discoverBrowse = browse
            }
            notice = "Following \(res.creator?.displayName ?? "creator")"
            await loadDiscoverFeed(refresh: false)
            return true
        } catch {
            discoverError = error.localizedDescription
            return false
        }
    }

    func unfollowDiscoverCreator(id: String) async {
        guard !id.isEmpty else { return }
        discoverFollowBusy = true
        discoverError = nil
        defer { discoverFollowBusy = false }
        do {
            let api = try await ensureLoopback()
            let res = try await api.unfollowDiscoverCreator(id: id)
            discoverCreators = res.creators
            if discoverCreatorFilter == id {
                discoverCreatorFilter = ""
            }
            await loadDiscoverFeed(refresh: false)
        } catch {
            discoverError = error.localizedDescription
        }
    }

    func browseDiscoverTopic(_ topic: String) async {
        let trimmed = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clearDiscoverBrowse()
            return
        }
        discoverActiveTopic = trimmed
        discoverLoading = true
        discoverError = nil
        let sources = discoverSourceFilter.isEmpty ? ["youtube", "soundcloud", "rumble"] : [discoverSourceFilter]
        defer {
            if discoverActiveTopic == trimmed {
                discoverLoading = false
            }
        }
        do {
            let api = try await ensureLoopback()
            let res = try await api.browseDiscover(query: trimmed, sources: sources, limit: 12)
            if discoverActiveTopic == trimmed {
                discoverBrowse = res
            }
        } catch {
            if discoverActiveTopic == trimmed {
                discoverError = error.localizedDescription
            }
        }
    }

    func clearDiscoverBrowse() {
        discoverActiveTopic = ""
        discoverBrowse = nil
        discoverError = nil
    }

    func addDiscoverItem(_ item: DiscoverItem, audioOverride: Bool = false) async {
        let stateKey = discoverStateKey(for: item, audioOverride: audioOverride)
        saveStates[stateKey] = .saving
        let finalId = item.acquireId.isEmpty
            ? "clip:\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased())"
            : item.acquireId
        let audio = audioOverride ? true : item.audioOnly
        let music: MusicMeta? = audioOverride
            ? MusicMeta(title: item.title, artist: item.creatorName.isEmpty ? nil : item.creatorName)
            : item.music
        do {
            let api = try await ensureLoopback()
            let job = try await api.acquire(
                id: finalId,
                title: item.title,
                url: item.url,
                page: true,
                audio: audio,
                music: music
            )
            upsertJob(job)
            saveStates[stateKey] = .saved(audioOverride ? "Adding audio…" : "Adding…")
            await refreshJobs(silent: true)
            notice = "Added to PearTube: \(item.title)"
        } catch {
            saveStates[stateKey] = .failed(error.localizedDescription)
        }
    }

    func loadSoulseekSettings() async {
        guard let api = loopback else { return }
        if let loaded = try? await api.getSettings() {
            soulseekSettings = loaded
        }
    }

    func saveSoulseekSettings(user: String, password: String, share: Bool) async {
        soulseekSettingsBusy = true
        soulseekSettingsMessage = nil
        soulseekSettingsError = nil
        defer { soulseekSettingsBusy = false }
        do {
            let api = try await ensureLoopback()
            let updated = try await api.updateSoulseekSettings(
                user: user.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password.isEmpty ? nil : password,
                share: share
            )
            soulseekSettings = updated
            soulseekSettingsMessage = "Soulseek settings saved."
        } catch {
            soulseekSettingsError = error.localizedDescription
        }
    }
    /// Asks relays the app does not follow for `raw`. Later answers come back with the next minute's updates.
    func searchGlobal(_ raw: String) async {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        if globalQuery != q { globalRows = [] }
        globalQuery = q; globalError = nil; globalAskedAt = Date()
        await fetchGlobal()
    }
    private func fetchGlobal() async {
        let q = globalQuery
        globalBusy = true
        defer { if globalQuery == q { globalBusy = false } }
        do {
            guard let worker else { throw AppFailure("The embedded worker is unavailable.") }
            let rows = try await worker.request("searchGlobal", ["query": q]) as? [[String: Any]] ?? []
            if globalQuery == q { globalRows = rows }
        } catch { if globalQuery == q { globalError = error.localizedDescription } }
    }
    func addSource(_ spec: SourceSpec) async {
        do {
            guard let worker else { return }
            if !running { await start() }
            _ = try await worker.request("addSource", spec.json)
            settings.add(spec); settings.configured = true
            try storage?.save(settings, name: "settings.json"); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func removeSource(_ key: String) async {
        if settings.tracker == key {
            var next = settings; next.tracker = ""; await save(next); return
        }
        do {
            _ = try await worker?.request("removeSource", ["key": key])
            settings.sources.removeAll { $0.key == key }; try storage?.save(settings, name: "settings.json"); await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func clearCache(_ key: String? = nil) async {
        do {
            let result = try await worker?.request("clearCache", ["key": key as Any? ?? NSNull()]) as? [String: Any] ?? [:]
            notice = "Cache compacted · \(bytes(result.number("clearedBytes"))) freed"; await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func removeChannelEntry(_ key: String) async {
        do {
            _ = try await worker?.request("remove", ["key": key])
            notice = "Removed from channel"; await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func canDelete(_ entry: MediaEntry) -> Bool {
        status.flag("writable") && !status.string("channel").isEmpty && status.string("channel") == entry.source
    }
    func rotateSubscriberPass() async {
        do {
            let res = try await worker?.request("rotateEpoch", [:]) as? [String: Any] ?? [:]
            notice = "Rotated to epoch \(Int(res.number("epoch")))"; await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func revokeLinkedWriter(_ writerKey: String) async {
        do {
            _ = try await worker?.request("revokeWriter", ["writer": writerKey, "purgeEntries": false])
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func copyRecoveryPhrase() async {
        do {
            let res = try await worker?.request("identity", ["revealMnemonic": true]) as? [String: Any] ?? [:]
            let phrase = res.string("mnemonic")
            guard !phrase.isEmpty else { throw AppFailure("No recovery phrase saved on this iPhone.") }
            UIPasteboard.general.string = phrase
            notice = "Copied 12-word recovery phrase"
        } catch { self.error = error.localizedDescription }
    }

    private var castStorage: String { storage?.privateFiles.appendingPathComponent("cast", isDirectory: true).path ?? "" }
    private func castRequest(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        guard let worker else { throw AppFailure("The embedded worker is unavailable.") }
        let result = try await worker.request(method, params) as? [String: Any] ?? [:]
        cast = result; reconcileBackground(); writeEvidence(force: true)
        return result
    }
    func refreshCast() async {
        do { _ = try await castRequest("castStatus") } catch { self.error = error.localizedDescription }
    }
    func chooseCast(_ entry: MediaEntry? = nil) {
        worker?.refreshDiscovery()
        pendingCast = entry ?? player.entry
        pendingCastPosition = player.entry?.key == pendingCast?.key ? player.state.positionMs : pendingCast.map(resumePosition) ?? 0
        showCast = true
        Task { await refreshCast() }
    }
    func selectReceiver(_ receiver: CastReceiver) async {
        guard receiver.paired || receiver.openAuth else { error = "Enter this TV's six-character code or scan its QR code first."; return }
        selectedReceiver = receiver.id
        if let pendingCast { await castPlay(receiver: receiver.id, entry: pendingCast, position: pendingCastPosition) }
        else {
            do { _ = try await castRequest("castAttach", ["receiverId": receiver.id]); showCast = false; notice = "Ready on \(receiver.name)" } catch { self.error = error.localizedDescription }
        }
    }
    func pairReceiver(id: String, code: String, address: String = "") async {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard value.count == 6, value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { error = "Enter the six-character code shown on the TV."; return }
        let raw = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty && raw.isEmpty { error = "Choose a TV or enter its link before pairing."; return }
        await pair(id.isEmpty ? ["code": value, "address": raw] : ["id": id, "code": value], unpaired: "Paired. Choose the TV to connect.")
    }
    func pairURI(_ input: String) async {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.lowercased().hasPrefix("peartube:") { await openURI(raw); return }
        await pair(["address": raw], unpaired: nil)
    }
    /// Pairs through the worklet (which reads a typed address) and connects to the receiver it saved.
    private func pair(_ params: [String: Any], unpaired: String?) async {
        do {
            let pairedID = try await castRequest("castPair", params).string("pairedId")
            if let receiver = receivers.first(where: { $0.paired && $0.id == pairedID }) { await selectReceiver(receiver) }
            else if let unpaired { notice = unpaired }
        } catch { self.error = error.localizedDescription }
    }
    func forgetReceiver(_ id: String) async {
        do { _ = try await castRequest("castRemove", ["id": id]); if selectedReceiver == id { selectedReceiver = nil } } catch { self.error = error.localizedDescription }
    }
    func castPlay(receiver: String, entry: MediaEntry, position: Double) async {
        do {
            _ = try await castRequest("castPlay", ["receiverId": receiver, "key": entry.key, "preferMode": "auto", "startPositionMs": position])
            recordProgress(force: true); player.close(deactivateAudioSession: !music.isPlaying); pendingCast = nil; showCast = false; selectedReceiver = receiver
        } catch { self.error = error.localizedDescription }
    }
    func control(_ action: String, _ params: [String: Any] = [:]) async {
        do { var payload = params; payload["action"] = action; _ = try await castRequest("castControl", payload) } catch { self.error = error.localizedDescription }
    }
    func stopCast(stopPlayback: Bool) async {
        recordProgress(force: true)
        do { _ = try await castRequest("castStop", ["stopPlayback": stopPlayback]); selectedReceiver = nil; showRemote = false } catch { self.error = error.localizedDescription }
    }
    func transferBack() async {
        let meta = session.object("state").object("entry")
        guard let entry = entries.first(where: { $0.key == meta.string("key") }) else { error = "This cast entry is not available in your current sources."; return }
        let position = remoteState.positionMs; let paused = !remoteState.playing
        do {
            _ = try await castRequest("castStop", ["stopPlayback": true]); selectedReceiver = nil; showRemote = false
            music.pauseForVideo()
            player.open(entry, at: position, paused: paused, soundfont: soundfontPresent ? storage?.soundfont.path : nil)
        } catch { self.error = error.localizedDescription }
    }
    func sceneChanged(_ phase: ScenePhase) {
        if phase == .background {
            background = true; recordProgress(force: true); player.suspend(); reconcileBackground(); writeEvidence(force: true)
        } else if phase == .active {
            background = false
            worker?.resume()
            worker?.refreshDiscovery()
            player.resume(); Task { await refresh() }
        }
    }
    private func reconcileBackground() {
        let keepAwake = !session.isEmpty || !downloads.isEmpty || hasActiveJobs || music.isPlaying
        if background && !keepAwake { worker?.suspend() } else { worker?.resume() }
    }
    func download(_ entry: MediaEntry) {
        guard downloadTasks[entry.key] == nil, let url = URL(string: entry.downloadURL.isEmpty ? entry.streamURL : entry.downloadURL) else { return }
        downloads[entry.key] = 0
        notice = "Downloading \(entry.title) to Files…"
        let key = entry.key
        let rawTitle = entry.episode.map { entry.title.localizedCaseInsensitiveContains($0) ? entry.title : "\(entry.title) \($0)" } ?? entry.title
        downloadTasks[key] = Task { [weak self] in
            guard let self else { return }
            _ = try? await self.worker?.request("warm", ["key": key])
            do {
                let savedName = try await Self.streamToDocuments(url: url, fallbackTitle: rawTitle, expectedSize: Int64(entry.size)) { written in
                    await MainActor.run { self.downloads[key] = Double(written) }
                }
                self.notice = "Saved \(savedName) to Files"
            } catch is CancellationError {
                self.notice = nil
            } catch {
                self.error = "Download failed: \(error.localizedDescription)"
            }
            self.downloads.removeValue(forKey: key)
            self.downloadTasks.removeValue(forKey: key)
            self.reconcileBackground()
        }
    }
    func cancelDownload(_ key: String) {
        downloadTasks.removeValue(forKey: key)?.cancel()
        downloads.removeValue(forKey: key)
        reconcileBackground()
    }
    nonisolated private static func filenameFromDisposition(_ disposition: String?) -> String? {
        guard let disposition else { return nil }
        if let match = disposition.range(of: "filename\\*\\s*=\\s*UTF-8''([^;]+)", options: [.regularExpression, .caseInsensitive]) {
            let encoded = String(disposition[match]).replacingOccurrences(of: "filename*=", with: "", options: .caseInsensitive)
                .trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "UTF-8''", with: "", options: .caseInsensitive)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            if let decoded = encoded.removingPercentEncoding, !decoded.isEmpty {
                return decoded
            }
        }
        if let match = disposition.range(of: "filename\\s*=\\s*\"([^\"]+)\"", options: [.regularExpression, .caseInsensitive]) {
            let raw = String(disposition[match])
            if let firstQuote = raw.firstIndex(of: "\""), let lastQuote = raw.lastIndex(of: "\""), firstQuote < lastQuote {
                let name = String(raw[raw.index(after: firstQuote)..<lastQuote]).trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { return name }
            }
        }
        if let match = disposition.range(of: "filename\\s*=\\s*([^;\\s]+)", options: [.regularExpression, .caseInsensitive]) {
            let raw = String(disposition[match]).replacingOccurrences(of: "filename=", with: "", options: .caseInsensitive).trimmingCharacters(in: .whitespaces)
            if !raw.isEmpty { return raw }
        }
        return nil
    }
    nonisolated private static func streamToDocuments(url: URL, fallbackTitle: String, expectedSize: Int64, onProgress: @Sendable @escaping (Int64) async -> Void) async throws -> String {
        let (bytes, response) = try await URLSession.shared.bytes(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 && http.statusCode != 206 {
            throw AppFailure("Stream answered HTTP \(http.statusCode)")
        }
        let clean = fallbackTitle.replacingOccurrences(of: "[/\\\\:*?\"<>|\\x00-\\x1f]+", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let fallback = clean.isEmpty ? "PearTube Video.mkv" : (clean.hasSuffix(".mkv") ? clean : "\(clean).mkv")
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        let rawName = filenameFromDisposition(disposition) ?? fallback
        let fileName = rawName.replacingOccurrences(of: "[/\\\\:*?\"<>|\\x00-\\x1f]+", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let docDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw AppFailure("Documents directory unavailable")
        }
        let docs = docDir.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        let finalURL = docs.appendingPathComponent(fileName)
        let partURL = docs.appendingPathComponent(".\(fileName).part")
        try? FileManager.default.removeItem(at: partURL)
        FileManager.default.createFile(atPath: partURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partURL)
        var written: Int64 = 0
        do {
            var buf = Data()
            buf.reserveCapacity(262_144)
            var lastUpdate = Date.distantPast
            for try await b in bytes {
                buf.append(b)
                if buf.count >= 262_144 {
                    try Task.checkCancellation()
                    try handle.write(contentsOf: buf)
                    written += Int64(buf.count)
                    buf.removeAll(keepingCapacity: true)
                    if Date().timeIntervalSince(lastUpdate) >= 0.2 {
                        lastUpdate = Date()
                        await onProgress(written)
                    }
                }
            }
            if !buf.isEmpty {
                try Task.checkCancellation()
                try handle.write(contentsOf: buf)
                written += Int64(buf.count)
            }
            try handle.synchronize()
            try handle.close()
            if expectedSize > 0 && written != expectedSize {
                throw AppFailure("Incomplete download (\(written) of \(expectedSize) bytes)")
            }
            if FileManager.default.fileExists(atPath: finalURL.path) { try FileManager.default.removeItem(at: finalURL) }
            try FileManager.default.moveItem(at: partURL, to: finalURL)
            return fileName
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: partURL)
            throw error
        }
    }
    func importSoundfont(_ url: URL) async {
        guard let storage, !soundfontBusy else { return }
        soundfontBusy = true
        defer { soundfontBusy = false }
        do {
            let destination = storage.soundfont
            try await Task.detached(priority: .userInitiated) { try SoundfontImport.copy(url, to: destination) }.value
            soundfontPresent = true; notice = "SoundFont imported. It will be used when the next media file opens."
        } catch { self.error = error.localizedDescription }
    }
    func removeSoundfont() {
        do { if let storage, FileManager.default.fileExists(atPath: storage.soundfont.path) { try FileManager.default.removeItem(at: storage.soundfont) }; soundfontPresent = false } catch { self.error = error.localizedDescription }
    }
    func writeEvidence(force: Bool = false) {
        guard ProcessInfo.processInfo.arguments.contains("-peartube-e2e") else { return }
        guard force || Date().timeIntervalSince(evidenceSaved) >= 1 else { return }
        evidenceSaved = Date()
        let document = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        let playerState = player.state.json
        let evidence: [String: Any] = ["schemaVersion": 1, "timestamp": Date().timeIntervalSince1970, "workerStarted": running,
            "screen": player.entry != nil ? "player" : showSettings ? "settings" : room.rawValue, "background": background,
            "settings": ["tracker": settings.tracker, "sources": settings.sources.map(\.json), "bootstrap": settings.bootstrap, "lanDiscovery": settings.lanDiscovery, "privateRouting": settings.privateRouting],
            "status": status, "entries": entries.map(\.evidence), "visibleEntryKeys": visibleEntries.map(\.key),
            "player": ["entryKey": player.entry?.key as Any? ?? NSNull(), "state": playerState],
            "cast": ["receivers": cast.objects("receivers").map { ["id": $0.string("id"), "name": $0.string("name"), "online": $0.flag("online"), "paired": $0.flag("paired")] }, "session": session],
            "error": error as Any? ?? NSNull()]
        do {
            guard let document else { return }
            let data = try JSONSerialization.data(withJSONObject: redact(evidence), options: [.sortedKeys, .prettyPrinted])
            try data.write(to: document.appendingPathComponent("e2e-state.json"), options: .atomic)
        } catch { /* Evidence failures must not interrupt actual playback. */ }
    }
    private func redact(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            return dict.reduce(into: [String: Any]()) { output, pair in
                if !["token", "apitoken", "paircode", "pairinguri", "seed", "secretkey", "privatekey", "streamurl", "httpstreamurl", "magneturl", "webreceiverurl"].contains(pair.key.lowercased()) { output[pair.key] = redact(pair.value) }
            }
        }
        if let array = value as? [Any] { return array.map(redact) }
        if let text = value as? String {
            return text.replacingOccurrences(of: "(?i)(token|apiToken|pairCode|seed|secretKey|privateKey)=([^&\\s]+)", with: "$1=[REDACTED]", options: .regularExpression)
        }
        return value
    }
}

enum SoundfontImport {
    static func copy(_ source: URL, to destination: URL) throws {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".soundfont-\(UUID().uuidString).tmp")
        defer { try? fm.removeItem(at: temporary) }
        guard fm.createFile(atPath: temporary.path, contents: nil) else { throw AppFailure("Cannot create the SoundFont import.") }
        let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }
        let output = try FileHandle(forWritingTo: temporary); defer { try? output.close() }
        var length = 0
        while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty {
            length += chunk.count
            guard length <= 256 * 1024 * 1024 else { throw AppFailure("SoundFont exceeds the 256 MiB import limit.") }
            try output.write(contentsOf: chunk)
        }
        try output.synchronize()
        let validation = try FileHandle(forReadingFrom: temporary); defer { try? validation.close() }
        guard let header = try validation.read(upToCount: 12), header.count == 12,
              String(data: header[0..<4], encoding: .ascii) == "RIFF", String(data: header[8..<12], encoding: .ascii) == "sfbk" else { throw AppFailure("Select a complete SoundFont 2 (.sf2) file.") }
        let declared = (0..<4).reduce(UInt64(0)) { $0 | UInt64(header[4 + $1]) << UInt64(8 * $1) }
        guard UInt64(length) == declared + 8 else { throw AppFailure("The SoundFont is truncated or has an invalid RIFF length.") }
        if fm.fileExists(atPath: destination.path) { _ = try fm.replaceItemAt(destination, withItemAt: temporary) }
        else { try fm.moveItem(at: temporary, to: destination) }
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
    }
}
