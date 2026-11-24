import Foundation

// MARK: - Shared URL & Link Extraction

/// Extracts a supported URL, PearTube URI, or 64-hex channel key from raw text
/// (e.g., SoundCloud share sheets, YouTube/Rumble links, `peartube://add?url=…`, or bare keys).
func extractSharedURL(from text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    // 1. Unwrap `peartube://add?url=<encoded>` deep link first.
    if let unwrapped = extractAddDeepLinkTarget(from: trimmed) {
        return unwrapped
    }

    // 2. Look for an embedded `peartube://add?url=...` inside share text.
    if let range = trimmed.range(of: "peartube://[^\\s]+", options: [.regularExpression, .caseInsensitive]) {
        let candidate = stripTrailingPunctuation(String(trimmed[range]))
        if let unwrapped = extractAddDeepLinkTarget(from: candidate) {
            return unwrapped
        }
        return candidate
    }

    // 3. Look for an http(s):// URL anywhere in the text (SoundCloud, YouTube, Rumble, direct links).
    if let range = trimmed.range(of: "https?://[^\\s<>\"'\\u{200B}-\\u{200D}\\u{FEFF}]+", options: [.regularExpression, .caseInsensitive]) {
        let candidate = stripTrailingPunctuation(String(trimmed[range]))
        if let url = URL(string: candidate), let host = url.host, !host.isEmpty {
            return candidate
        }
    }

    // 4. Bare 64-character hex channel key (or standalone 64-hex token in text).
    if trimmed.count == 64 && trimmed.allSatisfy(\.isHexDigit) {
        return trimmed.lowercased()
    }
    if let range = trimmed.range(of: "(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])", options: .regularExpression) {
        return String(trimmed[range]).lowercased()
    }

    return nil
}

/// If `raw` is a `peartube://add?url=<encoded>` deep link, returns the decoded target URL/key.
func extractAddDeepLinkTarget(from raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.lowercased().hasPrefix("peartube://add") else { return nil }
    guard let components = URLComponents(string: trimmed) else { return nil }
    guard components.scheme?.lowercased() == "peartube",
          components.host?.lowercased() == "add" else { return nil }
    guard let rawParam = components.queryItems?.first(where: { $0.name == "url" })?.value else { return nil }
    let value = rawParam.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return nil }
    if value.lowercased().hasPrefix("peartube://add") { return nil }
    return extractSharedURL(from: value) ?? value
}

/// Returns true when a trimmed string is an http(s) web or file URL.
func isHTTPURL(_ raw: String) -> Bool {
    let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return lower.hasPrefix("http://") || lower.hasPrefix("https://")
}

/// Builds a `peartube://add?url=<encoded>` deep link for forwarding from Share Extensions.
func makeAddDeepLink(for target: String) -> URL? {
    let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+#?"))
    guard let encoded = target.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    return URL(string: "peartube://add?url=\(encoded)")
}

private func stripTrailingPunctuation(_ raw: String) -> String {
    var result = raw
    let trimChars: Set<Character> = [".", ",", ";", ":", "!", "?", "\"", "'", ">", "»", "”", "’"]
    while let last = result.last {
        if trimChars.contains(last) {
            result.removeLast()
        } else if last == ")" {
            let opens = result.filter { $0 == "(" }.count
            let closes = result.filter { $0 == ")" }.count
            if closes > opens { result.removeLast() } else { break }
        } else if last == "]" {
            let opens = result.filter { $0 == "[" }.count
            let closes = result.filter { $0 == "]" }.count
            if closes > opens { result.removeLast() } else { break }
        } else {
            break
        }
    }
    return result
}

// MARK: - Source Kinds

enum MediaSourceKind: String, CaseIterable, Codable, Hashable, Identifiable {
    case soulseek
    case youtube
    case soundcloud
    case rumble

    var id: String { rawValue }

    var label: String {
        switch self {
        case .soulseek: return "Soulseek"
        case .youtube: return "YouTube"
        case .soundcloud: return "SoundCloud"
        case .rumble: return "Rumble"
        }
    }

    var icon: String {
        switch self {
        case .soulseek: return "music.note.house"
        case .youtube: return "play.rectangle"
        case .soundcloud: return "waveform"
        case .rumble: return "video"
        }
    }
}

// MARK: - Flexible JSON Helpers

private struct FlexibleString: Decodable {
    let value: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil; return }
        if let s = try? c.decode(String.self) { value = s; return }
        if let i = try? c.decode(Int.self) { value = String(i); return }
        if let d = try? c.decode(Double.self) { value = String(d); return }
        value = nil
    }
}

private struct FlexibleDouble: Decodable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil; return }
        if let d = try? c.decode(Double.self) { value = d; return }
        if let i = try? c.decode(Int.self) { value = Double(i); return }
        if let s = try? c.decode(String.self), let d = Double(s) { value = d; return }
        value = nil
    }
}

private struct FlexibleInt: Decodable {
    let value: Int?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil; return }
        if let i = try? c.decode(Int.self) { value = i; return }
        if let d = try? c.decode(Double.self) { value = Int(d); return }
        if let s = try? c.decode(String.self), let i = Int(s) { value = i; return }
        value = nil
    }
}

// MARK: - Identify Models

struct IdentifyMatch: Codable, Hashable {
    var id: String
    var title: String
}

struct IdentifyResult: Decodable, Hashable {
    var kind: String
    var site: String
    var title: String
    var author: String
    var duration: Double?
    var audioOnly: Bool
    var id: String
    var music: MusicMeta?
    var match: IdentifyMatch?
    var thumbnail: String?
    var size: Double?

    var isPage: Bool { kind.lowercased() != "file" }

    var siteBadge: String {
        if !site.isEmpty {
            switch site.lowercased() {
            case "youtube": return "YouTube"
            case "soundcloud": return "SoundCloud"
            case "rumble": return "Rumble"
            case "vimeo": return "Vimeo"
            default: return site.prefix(1).uppercased() + site.dropFirst()
            }
        }
        return isPage ? "Web page" : "Direct file"
    }

    private struct LegacyLink: Decodable {
        var kind: String?
        var site: String?
        var name: String?
        var uploader: String?
        var author: String?
        var duration: FlexibleDouble?
        var thumbnail: String?
        var size: FlexibleDouble?
        var audioOnly: Bool?
    }

    private struct LegacyPlain: Decodable {
        var id: String?
        var title: String?
    }

    private struct LegacyCandidate: Decodable {
        var id: String?
        var title: String?
    }

    enum CodingKeys: String, CodingKey {
        case kind, site, title, author, uploader, duration, audioOnly, id, music, match, thumbnail, size
        case link, plain, candidates
    }

    init(
        kind: String = "page",
        site: String = "",
        title: String = "",
        author: String = "",
        duration: Double? = nil,
        audioOnly: Bool = false,
        id: String = "",
        music: MusicMeta? = nil,
        match: IdentifyMatch? = nil,
        thumbnail: String? = nil,
        size: Double? = nil
    ) {
        self.kind = kind
        self.site = site
        self.title = title
        self.author = author
        self.duration = duration
        self.audioOnly = audioOnly
        self.id = id
        self.music = music
        self.match = match
        self.thumbnail = thumbnail
        self.size = size
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let legacyLink = try c.decodeIfPresent(LegacyLink.self, forKey: .link)
        let legacyPlain = try c.decodeIfPresent(LegacyPlain.self, forKey: .plain)
        let legacyCandidates = try c.decodeIfPresent([LegacyCandidate].self, forKey: .candidates) ?? []

        let decodedMatchObj = try? c.decodeIfPresent(IdentifyMatch.self, forKey: .match)
        let decodedMatchStr = (decodedMatchObj == nil) ? (try? c.decodeIfPresent(String.self, forKey: .match)) : nil
        let resolvedMatch: IdentifyMatch?
        if let m = decodedMatchObj {
            resolvedMatch = m
        } else if let mID = decodedMatchStr, !mID.isEmpty {
            let candTitle = legacyCandidates.first(where: { $0.id == mID })?.title ?? legacyPlain?.title ?? ""
            resolvedMatch = IdentifyMatch(id: mID, title: candTitle)
        } else {
            resolvedMatch = nil
        }

        let musicVal = try c.decodeIfPresent(MusicMeta.self, forKey: .music)
        let siteVal = (try c.decodeIfPresent(String.self, forKey: .site)) ?? legacyLink?.site ?? ""
        let kindVal = (try c.decodeIfPresent(String.self, forKey: .kind)) ?? legacyLink?.kind ?? "page"
        let titleVal = (try c.decodeIfPresent(String.self, forKey: .title))
            ?? resolvedMatch?.title
            ?? legacyPlain?.title
            ?? legacyLink?.name
            ?? ""
        let rawAuthor = try c.decodeIfPresent(String.self, forKey: .author)
        let rawUploader = try c.decodeIfPresent(String.self, forKey: .uploader)
        let authorVal = rawAuthor
            ?? rawUploader
            ?? musicVal?.artist
            ?? legacyLink?.author
            ?? legacyLink?.uploader
            ?? ""
        let durationVal = (try c.decodeIfPresent(FlexibleDouble.self, forKey: .duration))?.value
            ?? legacyLink?.duration?.value
        let idVal = (try c.decodeIfPresent(String.self, forKey: .id))
            ?? resolvedMatch?.id
            ?? legacyPlain?.id
            ?? ""
        let explicitAudio = (try c.decodeIfPresent(Bool.self, forKey: .audioOnly)) ?? legacyLink?.audioOnly
        let inferredAudio = siteVal.lowercased().contains("soundcloud") || siteVal.lowercased().contains("bandcamp")

        self.kind = kindVal
        self.site = siteVal
        self.title = titleVal
        self.author = authorVal
        self.duration = durationVal
        self.audioOnly = explicitAudio ?? inferredAudio
        self.id = idVal
        self.music = musicVal
        self.match = resolvedMatch
        self.thumbnail = (try c.decodeIfPresent(String.self, forKey: .thumbnail)) ?? legacyLink?.thumbnail
        self.size = (try c.decodeIfPresent(FlexibleDouble.self, forKey: .size))?.value ?? legacyLink?.size?.value
    }
}

// MARK: - Acquire Jobs

struct AcquireJob: Identifiable, Decodable, Hashable {
    var jobId: String
    var mediaId: String
    var title: String
    var plugin: String
    var sourceName: String
    var status: String
    var phase: String?
    var bytes: Double
    var total: Double?
    var speed: Double
    var peer: String?
    var queuePlace: Int?
    var file: String?
    var fileIndex: Int?
    var fileCount: Int?
    var error: String?
    var note: String?
    var created: Double

    var id: String { jobId }

    var isActive: Bool {
        switch status.lowercased() {
        case "queued", "copying", "running", "transferring", "announcing":
            return true
        default:
            return false
        }
    }

    var isFailed: Bool { status.lowercased() == "failed" }
    var isDone: Bool { status.lowercased() == "done" }

    var progress: Double? {
        if let total, total > 0 {
            return min(1, max(0, bytes / total))
        }
        if let count = fileCount, count > 1, let idx = fileIndex, idx >= 1 {
            return min(1, max(0, Double(idx - 1) / Double(count)))
        }
        return nil
    }

    var statusLabel: String {
        switch status.lowercased() {
        case "copying": return "Copying from peers"
        case "running": return "Downloading"
        case "transferring":
            if let q = queuePlace, q > 0 { return "Transferring (queue #\(q))" }
            return "Transferring"
        case "announcing": return "Saving to library"
        case "queued":
            if let q = queuePlace, q > 0 { return "Queued on peer (#\(q))" }
            return "Queued"
        case "done": return "Saved"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        default: return status.capitalized
        }
    }

    var sourceBadge: String {
        let name = sourceName.isEmpty ? plugin : sourceName
        switch name.lowercased() {
        case "soulseek": return "Soulseek"
        case "youtube": return "YouTube"
        case "soundcloud": return "SoundCloud"
        case "rumble": return "Rumble"
        case "http-acquire": return "Link"
        default: return name.isEmpty ? "Library" : name
        }
    }

    enum CodingKeys: String, CodingKey {
        case jobId, id, title, plugin, source, status, phase, bytes, total, speed
        case peer, queuePlace, file, fileIndex, fileCount, error, note, created
    }

    init(
        jobId: String,
        mediaId: String = "",
        title: String,
        plugin: String = "",
        sourceName: String = "",
        status: String,
        phase: String? = nil,
        bytes: Double = 0,
        total: Double? = nil,
        speed: Double = 0,
        peer: String? = nil,
        queuePlace: Int? = nil,
        file: String? = nil,
        fileIndex: Int? = nil,
        fileCount: Int? = nil,
        error: String? = nil,
        note: String? = nil,
        created: Double = 0
    ) {
        self.jobId = jobId
        self.mediaId = mediaId
        self.title = title
        self.plugin = plugin
        self.sourceName = sourceName
        self.status = status
        self.phase = phase
        self.bytes = bytes
        self.total = total
        self.speed = speed
        self.peer = peer
        self.queuePlace = queuePlace
        self.file = file
        self.fileIndex = fileIndex
        self.fileCount = fileCount
        self.error = error
        self.note = note
        self.created = created
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let idField = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        self.jobId = (try? c.decodeIfPresent(String.self, forKey: .jobId)) ?? (idField.isEmpty ? UUID().uuidString : idField)
        self.mediaId = idField
        self.title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "Untitled"
        self.plugin = (try? c.decodeIfPresent(String.self, forKey: .plugin)) ?? ""
        // `source` is a String on provider jobs and omitted (or an object) on generic acquirer jobs.
        self.sourceName = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
        self.status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "queued"
        self.phase = try? c.decodeIfPresent(String.self, forKey: .phase)
        self.bytes = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .bytes))?.value ?? 0
        self.total = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .total))?.value
        self.speed = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .speed))?.value ?? 0
        self.peer = try? c.decodeIfPresent(String.self, forKey: .peer)
        self.queuePlace = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .queuePlace))?.value
        self.file = try? c.decodeIfPresent(String.self, forKey: .file)
        self.fileIndex = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .fileIndex))?.value
        self.fileCount = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .fileCount))?.value
        self.error = try? c.decodeIfPresent(String.self, forKey: .error)
        self.note = try? c.decodeIfPresent(String.self, forKey: .note)
        self.created = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .created))?.value ?? 0
    }
}

struct JobsResponse: Decodable {
    var jobs: [AcquireJob]
}

// MARK: - Plugins

struct PluginInfo: Identifiable, Decodable, Hashable {
    var name: String
    var description: String
    var searchable: Bool
    var available: Bool?
    var configured: Bool?

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, description, searchable, available, configured
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        self.description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        self.searchable = (try? c.decodeIfPresent(Bool.self, forKey: .searchable)) ?? false
        self.available = try? c.decodeIfPresent(Bool.self, forKey: .available)
        self.configured = try? c.decodeIfPresent(Bool.self, forKey: .configured)
    }
}

struct PluginsResponse: Decodable {
    var plugins: [PluginInfo]
}

// MARK: - Unified Source Search

struct SourceCandidate: Identifiable, Decodable, Hashable {
    var source: String
    var title: String
    var url: String?
    // Soulseek fields
    var username: String?
    var filename: String?
    var slots: Bool
    var queue: Int
    var size: Double?
    var bitrate: Int?
    var sampleRate: Int?
    var bitDepth: Int?
    // Media & streaming provider fields
    var length: Double?
    var lossy: Bool?
    var videoId: String?
    var trackId: String?
    var rumbleId: String?
    var artist: String?
    var album: String?
    var channel: String?
    var thumbnail: String?

    var id: String {
        if let videoId, !videoId.isEmpty { return "yt:\(videoId)" }
        if let trackId, !trackId.isEmpty { return "sc:\(trackId)" }
        if let rumbleId, !rumbleId.isEmpty { return "rm:\(rumbleId)" }
        if let username, let filename, !filename.isEmpty { return "slsk:\(username):\(filename)" }
        if let url, !url.isEmpty { return "\(source):\(url)" }
        return "\(source):\(title)"
    }

    var displayAuthor: String {
        for candidate in [artist, channel, username] {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return ""
    }

    var fileExtension: String {
        guard let filename else { return "" }
        let normalized = filename.replacingOccurrences(of: "\\", with: "/")
        return URL(fileURLWithPath: normalized).pathExtension.uppercased()
    }

    var folderPath: String {
        guard let filename else { return "" }
        let normalized = filename.replacingOccurrences(of: "\\", with: "/")
        guard let lastSlash = normalized.lastIndex(of: "/") else { return "" }
        return String(normalized[..<lastSlash])
    }

    var folderDisplayName: String {
        let path = folderPath
        if path.isEmpty { return title }
        let parts = path.split(separator: "/").map(String.init).filter { !$0.hasPrefix("@@") }
        return parts.last ?? path
    }

    var qualityLabel: String {
        var parts: [String] = []
        let ext = fileExtension
        if !ext.isEmpty { parts.append(ext) }
        if let depth = bitDepth, let rate = sampleRate, depth > 0, rate > 0 {
            let khz = rate % 1000 == 0 ? "\(rate / 1000)" : String(format: "%.1f", Double(rate) / 1000.0)
            parts.append("\(depth)-bit/\(khz)kHz")
        } else if let br = bitrate, br > 0 {
            parts.append("\(br) kbps")
        }
        return parts.joined(separator: " · ")
    }

    enum CodingKeys: String, CodingKey {
        case source, title, url, username, peer, filename, slots, queue, size, bitrate
        case sampleRate, sample_rate, bitDepth, bit_depth, length, duration, lossy
        case videoId, trackId, rumbleId, id, artist, album, channel, author, uploader, thumbnail
    }

    init(
        source: String,
        title: String,
        url: String? = nil,
        username: String? = nil,
        filename: String? = nil,
        slots: Bool = false,
        queue: Int = 0,
        size: Double? = nil,
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        bitDepth: Int? = nil,
        length: Double? = nil,
        lossy: Bool? = nil,
        videoId: String? = nil,
        trackId: String? = nil,
        rumbleId: String? = nil,
        artist: String? = nil,
        album: String? = nil,
        channel: String? = nil,
        thumbnail: String? = nil
    ) {
        self.source = source
        self.title = title
        self.url = url
        self.username = username
        self.filename = filename
        self.slots = slots
        self.queue = queue
        self.size = size
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.bitDepth = bitDepth
        self.length = length
        self.lossy = lossy
        self.videoId = videoId
        self.trackId = trackId
        self.rumbleId = rumbleId
        self.artist = artist
        self.album = album
        self.channel = channel
        self.thumbnail = thumbnail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let src = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""
        let fname = try? c.decodeIfPresent(String.self, forKey: .filename)
        let fallbackTitle = fname?.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        let rawTitle = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        self.source = src
        self.title = rawTitle.isEmpty ? fallbackTitle : rawTitle
        self.url = try? c.decodeIfPresent(String.self, forKey: .url)
        self.username = (try? c.decodeIfPresent(String.self, forKey: .username))
            ?? (try? c.decodeIfPresent(String.self, forKey: .peer))
        self.filename = fname
        self.slots = (try? c.decodeIfPresent(Bool.self, forKey: .slots)) ?? false
        self.queue = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .queue))?.value ?? 0
        self.size = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .size))?.value
        self.bitrate = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bitrate))?.value
        self.sampleRate = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .sampleRate))?.value
            ?? (try? c.decodeIfPresent(FlexibleInt.self, forKey: .sample_rate))?.value
        self.bitDepth = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bitDepth))?.value
            ?? (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bit_depth))?.value
        self.length = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .length))?.value
            ?? (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .duration))?.value
        self.lossy = try? c.decodeIfPresent(Bool.self, forKey: .lossy)

        let genericID = (try? c.decodeIfPresent(FlexibleString.self, forKey: .id))?.value
        self.videoId = (try? c.decodeIfPresent(FlexibleString.self, forKey: .videoId))?.value
            ?? (src == "youtube" ? genericID : nil)
        self.trackId = (try? c.decodeIfPresent(FlexibleString.self, forKey: .trackId))?.value
            ?? (src == "soundcloud" ? genericID : nil)
        self.rumbleId = (try? c.decodeIfPresent(FlexibleString.self, forKey: .rumbleId))?.value
            ?? (src == "rumble" ? genericID : nil)

        self.artist = (try? c.decodeIfPresent(String.self, forKey: .artist))
            ?? (try? c.decodeIfPresent(String.self, forKey: .author))
            ?? (try? c.decodeIfPresent(String.self, forKey: .uploader))
        self.album = try? c.decodeIfPresent(String.self, forKey: .album)
        self.channel = (try? c.decodeIfPresent(String.self, forKey: .channel))
            ?? (try? c.decodeIfPresent(String.self, forKey: .author))
            ?? (try? c.decodeIfPresent(String.self, forKey: .uploader))
        self.thumbnail = try? c.decodeIfPresent(String.self, forKey: .thumbnail)
    }
}

/// Groups Soulseek file hits from the same peer and folder into one album card.
struct SoulseekAlbumGroup: Identifiable, Hashable {
    var peer: String
    var folderPath: String
    var folderName: String
    var files: [SourceCandidate]
    var totalSize: Double
    var slots: Bool
    var queue: Int
    var qualityLabel: String

    var id: String { "\(peer)|\(folderPath)" }

    static func group(_ candidates: [SourceCandidate]) -> [SoulseekAlbumGroup] {
        var order: [String] = []
        var buckets: [String: [SourceCandidate]] = [:]
        for item in candidates {
            let peer = item.username ?? "peer"
            let folder = item.folderPath
            let key = "\(peer)|\(folder)"
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(item)
        }
        return order.compactMap { key in
            guard let list = buckets[key], let first = list.first else { return nil }
            let peer = first.username ?? "peer"
            let total = list.reduce(0.0) { $0 + ($1.size ?? 0) }
            let quality = list.map(\.qualityLabel).first(where: { !$0.isEmpty }) ?? ""
            return SoulseekAlbumGroup(
                peer: peer,
                folderPath: first.folderPath,
                folderName: first.folderDisplayName,
                files: list,
                totalSize: total,
                slots: list.contains(where: \.slots),
                queue: list.map(\.queue).min() ?? 0,
                qualityLabel: quality
            )
        }
    }
}

struct SourceSearchResponse: Decodable {
    var query: String
    var sources: [String]
    var grouped: [String: [SourceCandidate]]
    var errors: [String: String]

    var totalResults: Int {
        grouped.values.reduce(0) { $0 + $1.count }
    }

    func results(for source: MediaSourceKind) -> [SourceCandidate] {
        grouped[source.rawValue] ?? []
    }

    private struct ErrorItem: Decodable {
        var source: String?
        var message: String?
    }

    private struct ErrorObject: Decodable {
        var message: String?
        var error: String?
    }

    private struct BySourceObject: Decodable {
        var results: [SourceCandidate]?
        var candidates: [SourceCandidate]?
        var error: String?
    }

    enum CodingKeys: String, CodingKey {
        case query, sources, results, bySource, errors
    }

    init(query: String = "", sources: [String] = [], grouped: [String: [SourceCandidate]] = [:], errors: [String: String] = [:]) {
        self.query = query
        self.sources = sources
        self.grouped = grouped
        self.errors = errors
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.query = (try? c.decodeIfPresent(String.self, forKey: .query)) ?? ""
        self.sources = (try? c.decodeIfPresent([String].self, forKey: .sources)) ?? []

        var groupedMap: [String: [SourceCandidate]] = [:]
        var errorMap: [String: String] = [:]

        // Support `bySource` as `{ source: [SourceCandidate] }`, `{ source: { results: [...] } }`, or `{ source: Int }` with top-level `results`.
        if let dictArrays = try? c.decodeIfPresent([String: [SourceCandidate]].self, forKey: .bySource) {
            for (src, items) in dictArrays {
                groupedMap[src] = items.map { item in
                    var copy = item
                    if copy.source.isEmpty { copy.source = src }
                    return copy
                }
            }
        } else if let dictObjs = try? c.decodeIfPresent([String: BySourceObject].self, forKey: .bySource) {
            for (src, obj) in dictObjs {
                let list = obj.results ?? obj.candidates ?? []
                groupedMap[src] = list.map { item in
                    var copy = item
                    if copy.source.isEmpty { copy.source = src }
                    return copy
                }
                if let err = obj.error, !err.isEmpty {
                    errorMap[src] = err
                }
            }
        }

        if groupedMap.isEmpty, let flat = try? c.decodeIfPresent([SourceCandidate].self, forKey: .results) {
            for item in flat {
                let key = item.source.isEmpty ? "unknown" : item.source
                groupedMap[key, default: []].append(item)
            }
        }

        // Support `errors` as `{ source: "message" }`, `{ source: { message: "..." } }`, or `[{ source, message }]`.
        if let dictStr = try? c.decodeIfPresent([String: String].self, forKey: .errors) {
            for (k, v) in dictStr where !v.isEmpty { errorMap[k] = v }
        } else if let dictObj = try? c.decodeIfPresent([String: ErrorObject].self, forKey: .errors) {
            for (k, v) in dictObj {
                if let msg = v.message ?? v.error, !msg.isEmpty { errorMap[k] = msg }
            }
        } else if let list = try? c.decodeIfPresent([ErrorItem].self, forKey: .errors) {
            for item in list {
                if let src = item.source, !src.isEmpty, let msg = item.message, !msg.isEmpty {
                    errorMap[src] = msg
                }
            }
        }

        self.grouped = groupedMap
        self.errors = errorMap
    }
}

// MARK: - Soulseek Shelf Browser

struct SoulseekFile: Identifiable, Decodable, Hashable {
    var filename: String
    var size: Double
    var bitrate: Int?
    var sampleRate: Int?
    var bitDepth: Int?
    var length: Double?

    var id: String { filename }

    var leafName: String {
        let normalized = filename.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map(String.init) ?? filename
    }

    var folderPath: String {
        let normalized = filename.replacingOccurrences(of: "\\", with: "/")
        guard let slash = normalized.lastIndex(of: "/") else { return "" }
        return String(normalized[..<slash])
    }

    var folderName: String {
        let path = folderPath
        if path.isEmpty { return "Root" }
        let parts = path.split(separator: "/").map(String.init).filter { !$0.hasPrefix("@@") }
        return parts.last ?? path
    }

    var qualityLabel: String {
        let ext = URL(fileURLWithPath: filename.replacingOccurrences(of: "\\", with: "/")).pathExtension.uppercased()
        var parts: [String] = ext.isEmpty ? [] : [ext]
        if let depth = bitDepth, let rate = sampleRate, depth > 0, rate > 0 {
            let khz = rate % 1000 == 0 ? "\(rate / 1000)" : String(format: "%.1f", Double(rate) / 1000.0)
            parts.append("\(depth)-bit/\(khz)kHz")
        } else if let br = bitrate, br > 0 {
            parts.append("\(br) kbps")
        }
        return parts.joined(separator: " · ")
    }

    enum CodingKeys: String, CodingKey {
        case filename, path, size, bitrate, sampleRate, sample_rate, bitDepth, bit_depth, length, duration
    }

    init(filename: String, size: Double = 0, bitrate: Int? = nil, sampleRate: Int? = nil, bitDepth: Int? = nil, length: Double? = nil) {
        self.filename = filename
        self.size = size
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.bitDepth = bitDepth
        self.length = length
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.filename = (try? c.decodeIfPresent(String.self, forKey: .filename))
            ?? (try? c.decodeIfPresent(String.self, forKey: .path))
            ?? ""
        self.size = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .size))?.value ?? 0
        self.bitrate = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bitrate))?.value
        self.sampleRate = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .sampleRate))?.value
            ?? (try? c.decodeIfPresent(FlexibleInt.self, forKey: .sample_rate))?.value
        self.bitDepth = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bitDepth))?.value
            ?? (try? c.decodeIfPresent(FlexibleInt.self, forKey: .bit_depth))?.value
        self.length = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .length))?.value
            ?? (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .duration))?.value
    }
}

struct SoulseekFolder: Identifiable, Decodable, Hashable {
    var path: String
    var name: String
    var files: [SoulseekFile]
    var totalSize: Double

    var id: String { path.isEmpty ? name : path }

    var qualityLabel: String {
        files.map(\.qualityLabel).first(where: { !$0.isEmpty }) ?? ""
    }

    enum CodingKeys: String, CodingKey {
        case path, folder, name, title, files, size, totalSize
    }

    init(path: String, name: String, files: [SoulseekFile], totalSize: Double? = nil) {
        self.path = path
        self.name = name
        self.files = files
        self.totalSize = totalSize ?? files.reduce(0) { $0 + $1.size }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let pathVal = (try? c.decodeIfPresent(String.self, forKey: .path))
            ?? (try? c.decodeIfPresent(String.self, forKey: .folder))
            ?? ""
        let filesVal = (try? c.decodeIfPresent([SoulseekFile].self, forKey: .files)) ?? []
        let fallbackName = pathVal.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? "Album"
        let nameVal = (try? c.decodeIfPresent(String.self, forKey: .name))
            ?? (try? c.decodeIfPresent(String.self, forKey: .title))
            ?? fallbackName
        let sizeVal = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .totalSize))?.value
            ?? (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .size))?.value
            ?? filesVal.reduce(0) { $0 + $1.size }
        self.path = pathVal
        self.name = nameVal
        self.files = filesVal
        self.totalSize = sizeVal
    }
}

struct SoulseekShelf: Decodable, Hashable {
    var peer: String
    var files: [SoulseekFile]
    var folders: [SoulseekFolder]
    var tracks: Int
    var size: Double
    var cached: Bool

    enum CodingKeys: String, CodingKey {
        case peer, username, files, folders, tracks, size, cached
    }

    init(peer: String, files: [SoulseekFile] = [], folders: [SoulseekFolder]? = nil, tracks: Int? = nil, size: Double? = nil, cached: Bool = false) {
        self.peer = peer
        self.files = files
        self.folders = folders ?? Self.groupFolders(files)
        self.tracks = tracks ?? files.count
        self.size = size ?? files.reduce(0) { $0 + $1.size }
        self.cached = cached
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let peerVal = (try? c.decodeIfPresent(String.self, forKey: .peer))
            ?? (try? c.decodeIfPresent(String.self, forKey: .username))
            ?? ""
        let decodedFiles = (try? c.decodeIfPresent([SoulseekFile].self, forKey: .files)) ?? []
        let decodedFolders = try? c.decodeIfPresent([SoulseekFolder].self, forKey: .folders)
        let finalFolders: [SoulseekFolder]
        let finalFiles: [SoulseekFile]
        if let decodedFolders, !decodedFolders.isEmpty {
            finalFolders = decodedFolders
            finalFiles = decodedFiles.isEmpty ? decodedFolders.flatMap(\.files) : decodedFiles
        } else {
            finalFiles = decodedFiles
            finalFolders = Self.groupFolders(decodedFiles)
        }
        self.peer = peerVal
        self.files = finalFiles
        self.folders = finalFolders
        self.tracks = (try? c.decodeIfPresent(FlexibleInt.self, forKey: .tracks))?.value ?? finalFiles.count
        self.size = (try? c.decodeIfPresent(FlexibleDouble.self, forKey: .size))?.value ?? finalFiles.reduce(0) { $0 + $1.size }
        self.cached = (try? c.decodeIfPresent(Bool.self, forKey: .cached)) ?? false
    }

    static func groupFolders(_ files: [SoulseekFile]) -> [SoulseekFolder] {
        var order: [String] = []
        var buckets: [String: [SoulseekFile]] = [:]
        for file in files {
            let folder = file.folderPath
            if buckets[folder] == nil { order.append(folder) }
            buckets[folder, default: []].append(file)
        }
        return order.compactMap { path in
            guard let list = buckets[path], let first = list.first else { return nil }
            return SoulseekFolder(path: path, name: first.folderName, files: list)
        }
    }
}

struct VisitedShelf: Codable, Identifiable, Hashable {
    var peer: String
    var visitedAt: Double
    var trackCount: Int?
    var folderCount: Int?

    var id: String { peer.lowercased() }
}

// MARK: - Soulseek Peer Settings

struct SoulseekSettings: Equatable {
    var user: String = ""
    var passwordSet: Bool = false
    var share: Bool = false

    static func decode(from data: Data) -> SoulseekSettings {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return SoulseekSettings()
        }
        let nested = root["settings"] as? [String: Any]

        func readString(_ keys: [String]) -> String {
            for key in keys {
                if let s = root[key] as? String { return s }
                if let entry = nested?[key] as? [String: Any], let s = entry["value"] as? String { return s }
                if let s = nested?[key] as? String { return s }
            }
            return ""
        }

        func readBool(_ keys: [String]) -> Bool {
            for key in keys {
                if let b = root[key] as? Bool { return b }
                if let entry = nested?[key] as? [String: Any] {
                    if let b = entry["value"] as? Bool { return b }
                    if let b = entry["set"] as? Bool { return b }
                }
                if let b = nested?[key] as? Bool { return b }
            }
            return false
        }

        let user = readString(["soulseekUser", "slskUser"])
        let passStr = readString(["soulseekPassword", "slskPass"])
        let passSet = !passStr.isEmpty || readBool(["soulseekPasswordSet", "slskPassSet", "soulseekPassword", "slskPass"])
        let share = readBool(["soulseekShare", "slskShare"])
        return SoulseekSettings(user: user, passwordSet: passSet, share: share)
    }
}

// MARK: - Inline Save Feedback

enum InlineSaveState: Equatable {
    case idle
    case saving
    case saved(String)
    case failed(String)
}

// MARK: - Loopback HTTP API Client

struct LoopbackApi {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func identify(url: String) async throws -> IdentifyResult {
        try await postJSON("v1/identify", body: ["url": url], timeout: 60)
    }

    func acquire(
        id: String,
        title: String,
        url: String,
        page: Bool,
        audio: Bool,
        music: MusicMeta? = nil
    ) async throws -> AcquireJob {
        var source: [String: Any] = ["url": url, "page": page]
        if audio { source["audio"] = true }
        var payload: [String: Any] = [
            "id": id,
            "title": title,
            "source": source
        ]
        if let music {
            var musicDict: [String: Any] = [:]
            if let t = music.title, !t.isEmpty { musicDict["title"] = t }
            if let a = music.artist, !a.isEmpty { musicDict["artist"] = a }
            if !musicDict.isEmpty { payload["music"] = musicDict }
        }
        return try await postJSON("v1/acquire", body: payload, timeout: 30)
    }

    func listJobs() async throws -> [AcquireJob] {
        let response: JobsResponse = try await getJSON("v1/jobs", timeout: 15)
        return response.jobs
    }

    func cancelJob(jobId: String) async throws {
        let encoded = jobId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? jobId
        _ = try await requestRaw(method: "DELETE", path: "v1/jobs/\(encoded)", body: nil, timeout: 15)
    }

    func listPlugins() async throws -> [PluginInfo] {
        let response: PluginsResponse = try await getJSON("v1/plugins", timeout: 15)
        return response.plugins
    }

    func searchSources(query: String, sources: [MediaSourceKind]) async throws -> SourceSearchResponse {
        let payload: [String: Any] = [
            "query": query,
            "sources": sources.map(\.rawValue),
            "stream": false
        ]
        return try await postJSON("v1/search/sources", body: payload, timeout: 45)
    }

    func browseSoulseek(peer: String, refresh: Bool = false) async throws -> SoulseekShelf {
        var payload: [String: Any] = ["peer": peer, "username": peer]
        if refresh { payload["refresh"] = true }
        return try await postJSON("v1/providers/soulseek/browse", body: payload, timeout: 45)
    }

    func mirrorSoulseek(peer: String, files: [[String: Any]], title: String? = nil) async throws -> AcquireJob {
        var payload: [String: Any] = [
            "peer": peer,
            "username": peer,
            "files": files
        ]
        if let title, !title.isEmpty { payload["title"] = title }
        return try await postJSON("v1/providers/soulseek/mirror", body: payload, timeout: 30)
    }

    func mirrorYouTube(artist: String, album: String, year: String? = nil, tracks: [[String: Any]]) async throws -> AcquireJob {
        var payload: [String: Any] = [
            "artist": artist,
            "album": album,
            "tracks": tracks
        ]
        if let year, !year.isEmpty { payload["year"] = year }
        return try await postJSON("v1/providers/youtube/mirror", body: payload, timeout: 30)
    }

    func mirrorSoundCloud(artist: String, album: String, tracks: [[String: Any]]) async throws -> AcquireJob {
        let payload: [String: Any] = [
            "artist": artist,
            "album": album,
            "tracks": tracks
        ]
        return try await postJSON("v1/providers/soundcloud/mirror", body: payload, timeout: 30)
    }

    func mirrorRumble(title: String, url: String, rumbleId: String?, audio: Bool) async throws -> AcquireJob {
        var payload: [String: Any] = [
            "title": title,
            "url": url,
            "audio": audio
        ]
        if let rumbleId, !rumbleId.isEmpty { payload["rumbleId"] = rumbleId }
        return try await postJSON("v1/providers/rumble/mirror", body: payload, timeout: 30)
    }

    func getSettings() async throws -> SoulseekSettings {
        let data = try await requestRaw(method: "GET", path: "v1/settings", body: nil, timeout: 15)
        return SoulseekSettings.decode(from: data)
    }

    func updateSoulseekSettings(user: String, password: String?, share: Bool) async throws -> SoulseekSettings {
        var payload: [String: Any] = [
            "soulseekUser": user,
            "soulseekShare": share
        ]
        if let password, !password.isEmpty {
            payload["soulseekPassword"] = password
        }
        let data = try await requestRaw(method: "PUT", path: "v1/settings", body: payload, timeout: 20)
        return SoulseekSettings.decode(from: data)
    }

    // MARK: - Transport

    private func getJSON<T: Decodable>(_ path: String, timeout: TimeInterval) async throws -> T {
        let data = try await requestRaw(method: "GET", path: path, body: nil, timeout: timeout)
        return try decode(T.self, from: data)
    }

    private func postJSON<T: Decodable>(_ path: String, body: [String: Any], timeout: TimeInterval) async throws -> T {
        let data = try await requestRaw(method: "POST", path: path, body: body, timeout: timeout)
        return try decode(T.self, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw AppFailure("Unexpected response from peer engine: \(error.localizedDescription)")
        }
    }

    private func requestRaw(method: String, path: String, body: [String: Any]?, timeout: TimeInterval) async throws -> Data {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let errObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = errObj["error"] as? String, !msg.isEmpty {
                throw AppFailure(msg)
            }
            throw AppFailure("Peer engine answered HTTP \(http.statusCode)")
        }
        return data
    }
}
