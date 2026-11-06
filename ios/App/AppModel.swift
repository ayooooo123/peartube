import Foundation
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    @Published var settings = Settings()
    @Published var status: [String: Any] = [:]
    @Published var identity: [String: Any] = [:]
    @Published var entries: [MediaEntry] = []
    @Published var history: [String: WatchProgress] = [:]
    @Published var cast: [String: Any] = [:]
    @Published var selectedReceiver: String?
    @Published var pendingCast: MediaEntry?
    @Published var pendingCastPosition: Double = 0
    @Published var query = ""
    @Published var filter = "All"
    @Published var sourceFilter = ""
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
    @Published var busy = false
    @Published var soundfontBusy = false
    @Published var soundfontPresent = false
    let player = NativePlayer()
    private(set) var storage: AppStorage?
    private var worker: Worker?
    private var started = false
    private var background = false
    private var workerSuspended = false
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
            soundfontPresent = FileManager.default.fileExists(atPath: storage.soundfont.path)
            let worker = try Worker(); self.worker = worker
            worker.onEvent = { [weak self] event in self?.receive(event) }
            let hasLaunchArgs = ["-peartube-tracker", "-peartube-bootstrap", "-peartube-lan", "-peartube-relays", "-peartube-private"].contains(where: { name in
                guard let i = args.firstIndex(of: name), args.indices.contains(i + 1) else { return false }
                return true
            })
            showSettings = !hasLaunchArgs && !settings.configured && !settings.hasSources
            Task { await start() }
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let self else { return }
                    if self.background { continue }
                    self.player.poll(); self.tickCount += 1
                    self.recordProgress()
                    if self.tickCount % 8 == 0 { await self.refresh() }
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

    private func applyLaunchArguments() async throws {
        let args = ProcessInfo.processInfo.arguments
        func argument(_ name: String) -> String? { guard let i = args.firstIndex(of: name), args.indices.contains(i + 1) else { return nil }; return args[i + 1] }
        guard ["-peartube-tracker", "-peartube-bootstrap", "-peartube-lan", "-peartube-relays", "-peartube-private"].contains(where: { argument($0) != nil }) else { return }
        let raw: [String: Any] = [
            "tracker": argument("-peartube-tracker") ?? settings.tracker,
            "sources": settings.sources.map(\.json),
            "relayThrough": argument("-peartube-relays") ?? settings.relayThrough.joined(separator: "\n"),
            "bootstrap": argument("-peartube-bootstrap") ?? settings.bootstrap.joined(separator: "\n"),
            "lanDiscovery": argument("-peartube-lan").map { $0.lowercased() == "true" } ?? settings.lanDiscovery,
            "privateRouting": argument("-peartube-private").map { $0.lowercased() == "true" } ?? settings.privateRouting
        ]
        var next = try await normalizeSettings(raw, requireChannel: false)
        next.configured = true
        settings = next
        try storage?.save(settings, name: "settings.json")
    }
    func start() async {
        guard let worker, let storage else { return }
        busy = true; started = false
        defer { busy = false; writeEvidence(force: true) }
        do {
            try await applyLaunchArguments()
            _ = try await worker.request("init", ["castStorage": castStorage])
            let params: [String: Any] = [
                "trackersDir": storage.trackers.path,
                "defaultFolder": "default",
                "settings": settings.json
            ]
            status = try await worker.request("start", params) as? [String: Any] ?? [:]
            started = true
            await refreshCast()
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func save(_ next: Settings) async {
        guard !busy else { return }
        do {
            try storage?.save(next, name: "settings.json")
            recordProgress(force: true); player.close()
            settings = next; entries = []; status = [:]; sourceFilter = ""; showSettings = false
            await start()
        } catch { self.error = error.localizedDescription }
    }
    private func receive(_ event: [String: Any]) {
        switch event.string("event") {
        case "update": Task { await refresh() }
        case "cast": cast = event.object("cast"); recordProgress(); reconcileBackground()
        case "sources":
            settings.sources = event.objects("sources").filter { !$0.flag("primary") && !$0.flag("writable") }.map(SourceSpec.init)
            do { try storage?.save(settings, name: "settings.json") } catch { self.error = error.localizedDescription }
            Task { await refresh() }
        case "fatal": error = event.string("error").isEmpty ? "The embedded P2P worker stopped." : event.string("error")
        default: break
        }
        writeEvidence(force: true)
    }
    func refresh() async {
        guard started, !background || !session.isEmpty else { return }
        if refreshInFlight { refreshAgain = true; return }
        refreshInFlight = true
        defer { refreshInFlight = false }
        repeat {
            refreshAgain = false
            do {
                guard let worker else { return }
                status = try await worker.request("status") as? [String: Any] ?? [:]
                let rows = try await worker.request("search", ["id": NSNull()]) as? [[String: Any]] ?? []
                if let ident = try? await worker.request("identity", ["revealMnemonic": false]) as? [String: Any] { identity = ident }
                var seen = Set<String>()
                entries = rows.map(MediaEntry.init).filter { !$0.key.isEmpty && seen.insert($0.key).inserted }
                if showCast || showRemote || !session.isEmpty { await refreshCast() }
            } catch { self.error = error.localizedDescription; break }
        } while refreshAgain && started
        writeEvidence(force: true)
    }
    var sources: [[String: Any]] { status.objects("sources") }
    var discovered: [[String: Any]] { status.objects("discoveredSources") }
    var receivers: [CastReceiver] { cast.objects("receivers").map { CastReceiver(json: $0) } }
    var session: [String: Any] { cast.object("session") }
    var remoteState: PlaybackState { PlaybackState(json: session.object("state")) }
    var contextualQuery: Bool { (query.count == 64 && query.allSatisfy(\.isHexDigit)) || query.lowercased().hasPrefix("peartube:") }
    var smartAction: String {
        let q = query.lowercased()
        if q.contains("watch/") || q.contains("stream/") { return "Play Stream" }
        if q.contains("access/") { return "Unlock Channel" }
        return "Connect Channel"
    }
    var visibleEntries: [MediaEntry] {
        entries.filter { entry in
            (contextualQuery || query.isEmpty || "\(entry.title) \(entry.mediaID)".localizedCaseInsensitiveContains(query)) &&
            (sourceFilter.isEmpty || entry.source == sourceFilter) &&
            (filter != "Movies" || entry.episode == nil) && (filter != "Series" || entry.episode != nil) && (filter != "On Device" || entry.saved)
        }.sorted { a, b in a.title.localizedStandardCompare(b.title) == .orderedAscending }
    }
    var continueEntries: [MediaEntry] {
        entries.filter { history[$0.key]?.partial == true }.sorted { (history[$0.key]?.updatedAt ?? 0) > (history[$1.key]?.updatedAt ?? 0) }
    }
    func seriesNext(_ episodes: [MediaEntry]) -> MediaEntry? {
        let ordered = episodes.sorted { $0.episodeOrder < $1.episodeOrder }
        guard let latest = ordered.filter({ history[$0.key] != nil }).max(by: { (history[$0.key]?.updatedAt ?? 0) < (history[$1.key]?.updatedAt ?? 0) }) else { return ordered.first }
        if history[latest.key]?.partial == true { return latest }
        guard let i = ordered.firstIndex(of: latest), ordered.indices.contains(i + 1) else { return ordered.first }
        return ordered[i + 1]
    }
    func resumePosition(_ entry: MediaEntry) -> Double { history[entry.key].flatMap { $0.partial ? $0.positionMs : nil } ?? 0 }
    func play(_ entry: MediaEntry, at position: Double? = nil, localOnly: Bool = false) {
        if entry.locked {
            error = "Subscriber pass needed: paste this channel's peartube://access/… pass to unlock."
            return
        }
        let start = position ?? resumePosition(entry)
        if !localOnly, let receiver = session["receiverId"] as? String ?? selectedReceiver {
            Task { await castPlay(receiver: receiver, entry: entry, position: start) }; return
        }
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
    func closePlayback() { recordProgress(force: true); player.close(); writeEvidence(force: true) }
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
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        do {
            guard let worker else { throw AppFailure("The embedded worker is unavailable.") }
            if !started { await start() }
            guard started else { throw AppFailure("The P2P worker has not started.") }
            let result = try await worker.request("openUri", ["uri": input]) as? [String: Any] ?? [:]
            if !result.object("source").isEmpty {
                let spec = SourceSpec(result.object("source")); settings.add(spec); settings.configured = true
                try storage?.save(settings, name: "settings.json"); showSettings = false
            }
            if !result.object("entry").isEmpty { play(MediaEntry(result.object("entry"))) }
            if result.string("action") == "receiver" {
                await refreshCast()
                let id = result.object("receiver").string("id")
                guard let receiver = receivers.first(where: { $0.id == id }) else { throw AppFailure("The paired receiver is missing from the saved screen list.") }
                await selectReceiver(receiver)
            }
            query = ""; await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func addSource(_ spec: SourceSpec) async {
        do {
            guard let worker else { return }
            if !started { await start() }
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
        guard receiver.paired || receiver.json.string("auth") == "none" else { error = "Enter this screen's six-character code or scan its QR code first."; return }
        selectedReceiver = receiver.id
        if let pendingCast { await castPlay(receiver: receiver.id, entry: pendingCast, position: pendingCastPosition) }
        else {
            do { _ = try await castRequest("castAttach", ["receiverId": receiver.id]); showCast = false; notice = "Ready on \(receiver.name)" } catch { self.error = error.localizedDescription }
        }
    }
    func pairReceiver(id: String, code: String, address: String = "") async {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard value.count == 6, value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { error = "Enter the six-character pairing code shown on the TV."; return }
        do {
            let target = receivers.first { $0.id == id }
            var params: [String: Any] = ["id": id, "code": value]
            if id.isEmpty {
                let raw = address.trimmingCharacters(in: .whitespacesAndNewlines)
                if raw.count == 64 && raw.allSatisfy(\.isHexDigit) { params["publicKey"] = raw.lowercased() }
                else if let url = URLComponents(string: raw.contains("://") ? raw : "http://\(raw)"), let host = url.host, !host.isEmpty {
                    params["host"] = host; params["port"] = url.port ?? 8176
                } else { throw AppFailure("Choose a screen or enter its host:port before pairing.") }
            }
            _ = try await castRequest("castPair", params)
            if let receiver = receivers.first(where: {
                guard $0.paired else { return false }
                if !id.isEmpty && $0.id == id { return true }
                let publicKey = params["publicKey"] as? String ?? target?.json.string("publicKey") ?? ""
                if !publicKey.isEmpty && $0.json.string("publicKey") == publicKey { return true }
                let host = params["host"] as? String ?? target?.json.string("host") ?? ""
                let port = params["port"] as? Int ?? Int(target?.json.number("port") ?? 0)
                return !host.isEmpty && $0.json.string("host") == host && Int($0.json.number("port")) == port
            }) { await selectReceiver(receiver) }
            else { notice = "Paired. Choose the saved screen to connect." }
        } catch { self.error = error.localizedDescription }
    }
    func pairURI(_ input: String) async {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.lowercased().hasPrefix("peartube:") { await openURI(raw); return }
        do {
            let normalized = raw.contains("://") ? raw : "http://\(raw)"
            if let c = URLComponents(string: normalized), let uri = c.queryItems?.first(where: { $0.name == "uri" })?.value, uri.lowercased().hasPrefix("peartube:") { await openURI(uri); return }
            var params: [String: Any] = [:]
            if raw.count == 64 && raw.allSatisfy(\.isHexDigit) { params["publicKey"] = raw.lowercased() }
            else if let c = URLComponents(string: normalized), let host = c.host, !host.isEmpty { params = ["host": host, "port": c.port ?? 8176] }
            else { throw AppFailure("Enter a receiver URI or host:port.") }
            _ = try await castRequest("castPair", params)
            if let receiver = receivers.first(where: { $0.paired && (params["publicKey"] as? String == $0.json.string("publicKey") || (params["host"] as? String == $0.json.string("host") && (params["port"] as? Int) == Int($0.json.number("port")))) }) { await selectReceiver(receiver) }
        } catch { self.error = error.localizedDescription }
    }
    func forgetReceiver(_ id: String) async {
        do { _ = try await castRequest("castRemove", ["id": id]); if selectedReceiver == id { selectedReceiver = nil } } catch { self.error = error.localizedDescription }
    }
    func castPlay(receiver: String, entry: MediaEntry, position: Double) async {
        do {
            _ = try await castRequest("castPlay", ["receiverId": receiver, "key": entry.key, "preferMode": "auto", "startPositionMs": position])
            recordProgress(force: true); player.close(); pendingCast = nil; showCast = false; selectedReceiver = receiver
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
            player.open(entry, at: position, paused: paused, soundfont: soundfontPresent ? storage?.soundfont.path : nil)
        } catch { self.error = error.localizedDescription }
    }
    func sceneChanged(_ phase: ScenePhase) {
        if phase == .background {
            background = true; recordProgress(force: true); player.suspend(); reconcileBackground(); writeEvidence(force: true)
        } else if phase == .active {
            background = false
            if workerSuspended { worker?.resume(); workerSuspended = false }
            worker?.refreshDiscovery()
            player.resume(); Task { await refresh() }
        }
    }
    private func reconcileBackground() {
        let keepAwake = !session.isEmpty || !downloads.isEmpty
        if background && !keepAwake && !workerSuspended { worker?.suspend(); workerSuspended = true }
        else if keepAwake && workerSuspended { worker?.resume(); workerSuspended = false }
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
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!.appendingPathComponent("Downloads", isDirectory: true)
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
        let evidence: [String: Any] = ["schemaVersion": 1, "timestamp": Date().timeIntervalSince1970, "workerStarted": started,
            "screen": player.entry != nil ? "player" : showSettings ? "settings" : "library", "background": background,
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
