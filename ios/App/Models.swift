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

func bytes(_ value: Double) -> String { ByteCountFormatter.string(fromByteCount: Int64(max(0, value)), countStyle: .binary) }
func rateText(_ bps: Double) -> String {
    let clamped = max(0, bps)
    if clamped < 1024 { return "\(Int(clamped.rounded())) B/s" }
    return "\(bytes(clamped))/s"
}
func clock(_ ms: Double) -> String {
    let s = max(0, Int(ms / 1000))
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
}
func jsonText(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}

enum Room: String, Codable, CaseIterable, Hashable {
    case home, listen, watch, discover, search

    var label: String {
        switch self {
        case .home: return "Home"
        case .listen: return "Listen"
        case .watch: return "Watch"
        case .discover: return "Discover"
        case .search: return "Search"
        }
    }

    var icon: String {
        switch self {
        case .home: return "house"
        case .listen: return "music.note.list"
        case .watch: return "film"
        case .discover: return "safari"
        case .search: return "magnifyingglass"
        }
    }

    var activeIcon: String {
        switch self {
        case .home: return "house.fill"
        case .listen: return "music.note.list"
        case .watch: return "film.fill"
        case .discover: return "safari.fill"
        case .search: return "magnifyingglass"
        }
    }
}

enum RepeatMode: String, Codable, CaseIterable, Hashable {
    case off, all, one

    var next: RepeatMode {
        switch self {
        case .off: return .all
        case .all: return .one
        case .one: return .off
        }
    }

    var label: String {
        switch self {
        case .off: return "Repeat off"
        case .all: return "Repeat list"
        case .one: return "Repeat track"
        }
    }

    var icon: String {
        switch self {
        case .off, .all: return "repeat"
        case .one: return "repeat.1"
        }
    }
}

struct UIPreferences: Codable {
    var lastRoom: Room = .home
}

struct MusicMeta: Hashable, Codable {
    var title: String?
    var artist: String?

    init(title: String? = nil, artist: String? = nil) {
        self.title = title
        self.artist = artist
    }

    init?(_ json: [String: Any]?) {
        guard let json else { return nil }
        let rawTitle = (json["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawArtist = (json["artist"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let t = (rawTitle?.isEmpty == false) ? rawTitle : nil
        let a = (rawArtist?.isEmpty == false) ? rawArtist : nil
        guard t != nil || a != nil else { return nil }
        self.title = t
        self.artist = a
    }
}

struct SourceSpec: Codable, Hashable {
    var key: String
    var kind = "channel"
    var alias = ""
    var name: String { alias.isEmpty ? "Channel \(key.prefix(8))" : alias }
    var json: [String: Any] { ["key": key, "kind": "channel", "alias": alias] }
    init(key: String, kind: String = "channel", alias: String = "") { self.key = key; self.kind = "channel"; self.alias = alias }
    init(_ json: [String: Any]) { key = json.string("key"); kind = "channel"; alias = json.string("alias") }
}

struct Settings: Codable {
    var tracker = ""
    var mnemonic = ""
    var sources: [SourceSpec] = []
    var relayThrough: [String] = []
    var bootstrap: [String] = []
    var lanDiscovery = true
    var privateRouting = false
    var cacheMaxGb = 10
    var configured = false
    var hasSources: Bool { !tracker.isEmpty || !mnemonic.isEmpty || !sources.isEmpty }
    mutating func add(_ source: SourceSpec) {
        if tracker == source.key { return }
        sources.removeAll { $0.key == source.key }; sources.append(SourceSpec(key: source.key, kind: "channel", alias: source.alias))
    }
    var json: [String: Any] {
        [
            "tracker": tracker,
            "mnemonic": mnemonic,
            "sources": sources.map(\.json),
            "relayThrough": relayThrough,
            "bootstrap": bootstrap,
            "lanDiscovery": lanDiscovery,
            "privateRouting": privateRouting,
            "cacheMaxGb": cacheMaxGb,
            "configured": configured
        ]
    }
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tracker = try c.decodeIfPresent(String.self, forKey: .tracker) ?? ""
        mnemonic = try c.decodeIfPresent(String.self, forKey: .mnemonic) ?? ""
        sources = try c.decodeIfPresent([SourceSpec].self, forKey: .sources) ?? []
        relayThrough = try c.decodeIfPresent([String].self, forKey: .relayThrough) ?? []
        bootstrap = try c.decodeIfPresent([String].self, forKey: .bootstrap) ?? []
        lanDiscovery = try c.decodeIfPresent(Bool.self, forKey: .lanDiscovery) ?? true
        privateRouting = try c.decodeIfPresent(Bool.self, forKey: .privateRouting) ?? false
        cacheMaxGb = try c.decodeIfPresent(Int.self, forKey: .cacheMaxGb) ?? 10
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
    }
}

struct MediaEntry: Identifiable, Hashable {
    var key: String; var mediaID: String; var title: String; var size: Double; var sha256: String
    var local: Bool; var cachedBytes: Double; var isPrivate: Bool; var locked: Bool
    var streamURL: String; var downloadURL: String; var magnetURL: String; var source: String
    var seasonNumber: Int?
    var episodeNumber: Int?
    var seriesKey: String
    var baseTitle: String
    var year: String?
    var music: MusicMeta?
    var id: String { key }

    init(
        key: String,
        mediaID: String,
        title: String,
        size: Double = 0,
        sha256: String = "",
        local: Bool = false,
        cachedBytes: Double = 0,
        isPrivate: Bool = false,
        locked: Bool = false,
        streamURL: String = "",
        downloadURL: String = "",
        magnetURL: String = "",
        source: String = "",
        seasonNumber: Int? = nil,
        episodeNumber: Int? = nil,
        seriesKey: String = "",
        baseTitle: String? = nil,
        year: String? = nil,
        music: MusicMeta? = nil
    ) {
        self.key = key
        self.mediaID = mediaID
        self.title = title
        self.size = size
        self.sha256 = sha256
        self.local = local
        self.cachedBytes = cachedBytes
        self.isPrivate = isPrivate
        self.locked = locked
        self.streamURL = streamURL
        self.downloadURL = downloadURL
        self.magnetURL = magnetURL
        self.source = source
        self.seasonNumber = seasonNumber
        self.episodeNumber = episodeNumber
        self.seriesKey = seriesKey
        self.baseTitle = (baseTitle?.isEmpty == false) ? baseTitle! : title
        self.year = year
        self.music = music
    }

    init(_ j: [String: Any]) {
        key = j.string("key"); mediaID = j.string("id"); title = j.string("title"); size = j.number("size"); sha256 = j.string("sha256")
        local = j.flag("local"); cachedBytes = j.number("cachedBytes"); isPrivate = j.flag("private"); locked = j.flag("locked")
        streamURL = j.string("streamUrl"); downloadURL = j.string("downloadUrl"); magnetURL = j.string("magnetUrl"); source = j.string("source")
        seasonNumber = (j["season"] as? NSNumber)?.intValue
        episodeNumber = (j["episode"] as? NSNumber)?.intValue
        seriesKey = j.string("seriesKey")
        baseTitle = j.string("baseTitle").isEmpty ? title : j.string("baseTitle")
        year = j["year"] as? String
        music = MusicMeta(j["music"] as? [String: Any])
    }

    var episode: String? {
        guard let s = seasonNumber, let e = episodeNumber else { return nil }
        return String(format: "S%02dE%02d", s, e)
    }
    var season: String {
        guard let s = seasonNumber else { return "Movie" }
        return String(format: "S%02d", s)
    }
    var episodeOrder: Int { (seasonNumber ?? 0) * 10000 + (episodeNumber ?? 0) }
    var seriesTitle: String { baseTitle }
    var groupKey: String { seasonNumber != nil ? seriesKey : "movie:\(mediaID)" }
    var saved: Bool { local || (size > 0 && cachedBytes >= size) }
    var playable: Bool { !streamURL.isEmpty && !locked }
    var isYouTube: Bool { mediaID.hasPrefix("yt:") }
    var isAlbumTrack: Bool { !mediaID.hasPrefix("imdb:") && seasonNumber != nil }
    var canQueueAsTrack: Bool { playable && isAlbumTrack && episodeNumber != nil }
    var evidence: [String: Any] { ["key": key, "id": mediaID, "title": title, "size": size, "local": local, "cachedBytes": cachedBytes, "source": source] }
}

struct WatchProgress: Codable {
    var positionMs: Double; var durationMs: Double; var updatedAt: Double
    var partial: Bool { positionMs > 0 && (durationMs <= 0 || positionMs < durationMs - 10000) }
    var fraction: Double { durationMs > 0 ? min(1, max(0, positionMs / durationMs)) : 0 }
    var remainingSeconds: Double { max(0, (durationMs - positionMs) / 1000.0) }
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
    var current: Bool { json.flag("current") }
    var openAuth: Bool { json.string("auth") == "none" }
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
}
