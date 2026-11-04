import Foundation

struct AppFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String { self[key] as? String ?? "" }
    func number(_ key: String) -> Double { (self[key] as? NSNumber)?.doubleValue ?? 0 }
    func flag(_ key: String) -> Bool { (self[key] as? NSNumber)?.boolValue ?? false }
    func object(_ key: String) -> [String: Any] { self[key] as? [String: Any] ?? [:] }
    func objects(_ key: String) -> [[String: Any]] { self[key] as? [[String: Any]] ?? [] }
}

func isKey(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy { (48...57).contains($0.value) || (65...70).contains($0.value) || (97...102).contains($0.value) }
}
func tokens(_ value: String) -> [String] {
    value.components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ","))).filter { !$0.isEmpty }
}
func bytes(_ value: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary) }
func clock(_ ms: Double) -> String {
    let s = max(0, Int(ms / 1000))
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
}
func jsonText(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}

struct SourceSpec: Codable, Hashable, Identifiable {
    var key: String
    var kind = "channel"
    var alias = ""
    var id: String { key }
    var name: String { alias.isEmpty ? "Channel \(key.prefix(8))" : alias }
    var json: [String: Any] { ["key": key, "kind": "channel", "alias": alias] }
    var uri: String {
        var c = URLComponents()
        c.scheme = "peartube"; c.host = "channel"; c.path = "/\(key)"
        if !alias.isEmpty { c.queryItems = [URLQueryItem(name: "name", value: alias)] }
        return c.string ?? "peartube://channel/\(key)"
    }
    init(key: String, kind: String = "channel", alias: String = "") { self.key = key; self.kind = "channel"; self.alias = alias }
    init(_ json: [String: Any]) { key = json.string("key"); kind = "channel"; alias = json.string("alias") }
    static func parse(_ input: String, defaultKind: String = "channel") throws -> SourceSpec {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if isKey(raw) { return SourceSpec(key: raw.lowercased(), kind: "channel") }
        let split = raw.split(separator: ":", maxSplits: 1).map(String.init)
        if split.count == 2, ["channel", "tracker"].contains(split[0].lowercased()), isKey(split[1]) { return SourceSpec(key: split[1].lowercased(), kind: "channel") }
        let normalized = raw.lowercased().hasPrefix("peartube://") ? raw : raw.replacingOccurrences(of: "peartube:", with: "peartube://", options: .caseInsensitive)
        guard let c = URLComponents(string: normalized), c.scheme?.lowercased() == "peartube", let verb = c.host?.lowercased(), ["channel", "tracker", "source", "add"].contains(verb) else { throw AppFailure("Enter a 64-character hexadecimal key or a peartube://channel/ URI.") }
        let key = c.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        guard isKey(key) else { throw AppFailure("Channel keys must contain exactly 64 hexadecimal characters.") }
        let query = c.queryItems ?? []
        var source = SourceSpec(key: key, kind: "channel")
        for item in query {
            if ["name", "alias"].contains(item.name) { source.alias = item.value ?? "" }
        }
        return source
    }
}

struct Settings: Codable {
    var tracker = ""
    var mnemonic = ""
    var sources: [SourceSpec] = []
    var relayThrough: [String] = []
    var bootstrap: [String] = []
    var lanDiscovery = true
    var privateRouting = false
    var configured = false
    var hasSources: Bool { !tracker.isEmpty || !mnemonic.isEmpty || !sources.isEmpty }
    mutating func add(_ source: SourceSpec) {
        if tracker == source.key { return }
        sources.removeAll { $0.key == source.key }; sources.append(SourceSpec(key: source.key, kind: "channel", alias: source.alias))
    }
    static func parse(tracker: String, sources: String, relays: String, bootstrap: String, lan: Bool, privateRouting: Bool, mnemonic: String = "") throws -> Settings {
        var next = Settings()
        if !tracker.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let source = try SourceSpec.parse(tracker, defaultKind: "channel")
            next.tracker = source.key
        }
        let words = mnemonic.lowercased().components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
        if !words.isEmpty {
            guard (words.count == 12 || words.count == 24), words.allSatisfy({ $0.unicodeScalars.allSatisfy { (97...122).contains($0.value) } }) else {
                throw AppFailure("Recovery phrase must be 12 or 24 lowercase English words.")
            }
            next.mnemonic = words.joined(separator: " ")
        }
        for token in sources.components(separatedBy: CharacterSet.newlines.union(CharacterSet(charactersIn: ","))).filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) { next.add(try SourceSpec.parse(token)) }
        next.relayThrough = tokens(relays).map { $0.lowercased() }
        guard next.relayThrough.allSatisfy(isKey) else { throw AppFailure("Each relay key must be 64 hexadecimal characters.") }
        next.bootstrap = tokens(bootstrap)
        for node in next.bootstrap {
            guard let colon = node.lastIndex(of: ":"), !node[..<colon].isEmpty, let port = Int(node[node.index(after: colon)...]), (1...65535).contains(port) else { throw AppFailure("Bootstrap nodes must be host:port with a port from 1 to 65535.") }
        }
        next.lanDiscovery = lan; next.privateRouting = privateRouting; next.configured = true
        return next
    }
}

struct MediaEntry: Identifiable, Hashable {
    var key: String; var mediaID: String; var title: String; var size: Double; var sha256: String
    var local: Bool; var cachedBytes: Double; var isPrivate: Bool; var epoch: Int; var locked: Bool
    var streamURL: String; var magnetURL: String; var source: String
    var id: String { key }
    init(_ j: [String: Any]) {
        key = j.string("key"); mediaID = j.string("id"); title = j.string("title"); size = j.number("size"); sha256 = j.string("sha256")
        local = j.flag("local"); cachedBytes = j.number("cachedBytes"); isPrivate = j.flag("private"); epoch = Int(j.number("epoch")); locked = j.flag("locked")
        streamURL = j.string("streamUrl"); magnetURL = j.string("magnetUrl"); source = j.string("source")
    }
    var episode: String? { mediaID.range(of: "(?i)s[0-9]{2}e[0-9]{2,3}$", options: .regularExpression).map { String(mediaID[$0]).uppercased() } }
    var season: String { episode.map { String($0.prefix(3)) } ?? "Movie" }
    var episodeOrder: Int {
        guard let e = episode else { return 0 }
        let parts = e.dropFirst().split(separator: "E")
        return (Int(parts[0]) ?? 0) * 10000 + (parts.count > 1 ? Int(parts[1]) ?? 0 : 0)
    }
    var seriesTitle: String { title.replacingOccurrences(of: "(?i)[ ._-]*s[0-9]+e[0-9]+.*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
    var groupKey: String {
        guard episode != nil else { return "movie:\(mediaID)" }
        if let match = mediaID.range(of: "(?i)tt[0-9]+", options: .regularExpression) { return String(mediaID[match]).lowercased() }
        return seriesTitle.lowercased()
    }
    var saved: Bool { local || (size > 0 && cachedBytes >= size) }
    var evidence: [String: Any] { ["key": key, "id": mediaID, "title": title, "size": size, "local": local, "cachedBytes": cachedBytes, "source": source] }
}

struct WatchProgress: Codable {
    var positionMs: Double; var durationMs: Double; var updatedAt: Double
    var partial: Bool { positionMs > 0 && (durationMs <= 0 || positionMs < durationMs - 10000) }
}
struct PlayerTrack: Identifiable {
    let stream: Int; let kind: String; let codec: String; let language: String; let title: String
    var id: Int { stream }
    var label: String { [title, language, codec].filter { !$0.isEmpty }.joined(separator: " · ") }
    init(_ j: [String: Any]) { stream = Int(j.number("stream")); kind = j.string("kind"); codec = j.string("codec"); language = j.string("language"); title = j.string("title") }
}
struct PlaybackState {
    var json: [String: Any] = [:]
    var positionMs: Double { json.number("positionMs") }
    var durationMs: Double { json.number("durationMs") }
    var playing: Bool { json.flag("playing") }
    var buffering: Bool { json.flag("buffering") }
    var ended: Bool { json.flag("ended") }
    var error: String { json.string("error") }
    var tracks: [PlayerTrack] { json.objects("tracks").map(PlayerTrack.init) }
}
struct CastReceiver: Identifiable {
    let json: [String: Any]
    var id: String { json.string("id") }; var name: String { json.string("name") }
    var paired: Bool { json.flag("paired") }; var online: Bool { json.flag("online") }
}

struct AppStorage {
    let root: URL
    let trackers: URL
    let privateFiles: URL
    init(suffix: String? = nil) throws {
        let fm = FileManager.default
        if let suffix, suffix.isEmpty || suffix.count > 80 || !suffix.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) {
            throw AppFailure("The storage suffix must be a basename containing only letters, numbers, - or _.")
        }
        let folderName = suffix.map { "PearTube-e2e-\($0)" } ?? "PearTube"
        root = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent(folderName, isDirectory: true)
        trackers = root.appendingPathComponent("trackers", isDirectory: true)
        privateFiles = root.appendingPathComponent("private", isDirectory: true)
        for folder in [root, trackers, privateFiles] { try fm.createDirectory(at: folder, withIntermediateDirectories: true) }
        var folder = trackers
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: privateFiles.path)
    }
    var soundfont: URL { privateFiles.appendingPathComponent("soundfont.sf2") }
    func load<T: Decodable>(_ name: String, fallback: T) -> T {
        guard let data = try? Data(contentsOf: privateFiles.appendingPathComponent(name)), let result = try? JSONDecoder().decode(T.self, from: data) else { return fallback }
        return result
    }
    func save<T: Encodable>(_ value: T, name: String) throws {
        let data = try JSONEncoder().encode(value)
        try data.write(to: privateFiles.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func trackerStore(_ key: String) throws -> URL {
        var folder = trackers.appendingPathComponent(key.isEmpty ? "default" : key, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try folder.setResourceValues(values)
        return folder
    }
}
