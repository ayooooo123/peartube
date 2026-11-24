import Foundation

// MARK: - Text folding, sleeve hashing, and naming ported from src/ui.js

enum CatalogText {
    private static let smallWords: Set<String> = [
        "a", "an", "the", "of", "and", "in", "on", "to", "for",
        "le", "la", "les", "de", "der", "die", "das"
    ]

    private static func isAccentBase(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        return (v >= 0x0041 && v <= 0x005A) || // A-Z
            (v >= 0x0061 && v <= 0x007A) ||    // a-z
            (v >= 0x00C0 && v <= 0x024F) ||    // Latin Extended
            (v >= 0x1E00 && v <= 0x1EFF) ||    // Latin Extended Additional
            (v >= 0x2C60 && v <= 0x2C7F) ||    // Latin Extended-C
            (v >= 0xA720 && v <= 0xA7FF) ||    // Latin Extended-D
            (v >= 0x0370 && v <= 0x03FF) ||    // Greek & Coptic
            (v >= 0x1F00 && v <= 0x1FFF)       // Greek Extended
    }

    private static func isCombiningDiacritic(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value >= 0x0300 && scalar.value <= 0x036F
    }

    private static func isLetterNumberOrMark(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber,
             .nonspacingMark, .spacingMark, .enclosingMark:
            return true
        default:
            return false
        }
    }

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }

    /// Case, width, punctuation, and Latin/Greek accent folding matching `fold` in `src/ui.js`.
    /// Preserves script-meaningful marks (Cyrillic й/ё, Indic, Arabic).
    static func fold(_ raw: String) -> String {
        let decomposed = raw.lowercased().decomposedStringWithCompatibilityMapping
        var stripped = String.UnicodeScalarView()
        var lastBase: Unicode.Scalar?
        for scalar in decomposed.unicodeScalars {
            if isCombiningDiacritic(scalar) {
                if let base = lastBase, isAccentBase(base) {
                    continue
                }
                stripped.append(scalar)
            } else {
                let mapped: Unicode.Scalar
                if scalar.value == 0x0131 { mapped = "i" }          // Turkish dotless ı
                else if scalar.value == 0x03C2 { mapped = "σ" }     // Greek final sigma ς
                else { mapped = scalar }
                stripped.append(mapped)
                lastBase = mapped
            }
        }
        var out = ""
        var pendingSpace = false
        for scalar in stripped {
            if isLetterNumberOrMark(scalar) {
                if pendingSpace && !out.isEmpty { out.append(" ") }
                pendingSpace = false
                out.unicodeScalars.append(scalar)
            } else {
                pendingSpace = true
            }
        }
        return out
    }

    /// FNV-1a over UTF-16 code units + Murmur3 avalanche, matching `sleeveHash` in `src/ui.js`.
    static func sleeveHash(_ s: String) -> UInt32 {
        var x: UInt32 = 2166136261
        for unit in s.utf16 {
            x = (x ^ UInt32(unit)) &* 16777619
        }
        x ^= x >> 16
        x = x &* 0x85EBCA6B
        x ^= x >> 13
        x = x &* 0xC2B2AE35
        return x ^ (x >> 16)
    }

    /// Monogram from significant words, matching `monogram` in `src/ui.js`.
    static func monogram(_ name: String) -> String {
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "·:/-"))
        let words = name.components(separatedBy: separators).filter { !$0.isEmpty }
        let big = words.filter { !smallWords.contains($0.lowercased()) }
        let chosen = big.isEmpty ? words : big
        var letters: [String] = []
        for word in chosen {
            guard let first = word.first, first.unicodeScalars.contains(where: isLetterOrNumber) else { continue }
            letters.append(String(first))
            if letters.count == 2 { break }
        }
        let joined = letters.joined()
        return (joined.isEmpty ? "♪" : joined).uppercased()
    }

    static func trackName(_ entry: MediaEntry) -> String {
        if let t = entry.music?.title, !t.isEmpty { return t }
        if let tail = entry.mediaID.split(separator: ":").last, !tail.isEmpty {
            return String(tail).uppercased()
        }
        return entry.title.isEmpty ? "Track" : entry.title
    }

    static func trackNumber(_ entry: MediaEntry) -> String {
        guard let s = entry.seasonNumber, let e = entry.episodeNumber else { return "" }
        let prefix = s > 1 ? "\(s)-" : ""
        return "\(prefix)\(String(format: "%02d", e))"
    }

    struct IMDbMatch {
        let imdb: String
        let season: Int?
        let episode: Int?
    }

    private static let imdbRegex = try! NSRegularExpression(pattern: "^imdb:(tt[0-9]+)(?::s([0-9]+)e([0-9]+))?$")
    private static let trailingEpisodeRegex = try! NSRegularExpression(pattern: "\\s+S[0-9]+E[0-9]+$", options: .caseInsensitive)

    static func matchIMDb(_ mediaID: String) -> IMDbMatch? {
        let range = NSRange(mediaID.startIndex..<mediaID.endIndex, in: mediaID)
        guard let m = imdbRegex.firstMatch(in: mediaID, range: range),
              let r1 = Range(m.range(at: 1), in: mediaID) else { return nil }
        let imdb = String(mediaID[r1])
        let s = Range(m.range(at: 2), in: mediaID).flatMap { Int(mediaID[$0]) }
        let e = Range(m.range(at: 3), in: mediaID).flatMap { Int(mediaID[$0]) }
        return IMDbMatch(imdb: imdb, season: s, episode: e)
    }

    static func stripTrailingEpisode(_ title: String) -> String {
        let range = NSRange(title.startIndex..<title.endIndex, in: title)
        return trailingEpisodeRegex.stringByReplacingMatches(in: title, range: range, withTemplate: "")
    }
}

// MARK: - Catalog Data Structures

enum TileKind: String, Hashable {
    case movie, show, album, clip
}

struct TileItem: Identifiable, Hashable {
    var entry: MediaEntry
    var season: Int?
    var episode: Int?
    var copies: Int = 1
    var alts: [MediaEntry] = []

    var id: String { entry.key }
}

struct LibraryTile: Identifiable, Hashable {
    var key: String
    var kind: TileKind
    var imdb: String?
    var title: String
    var artist: String = ""
    var album: String = ""
    var releases: Int = 1
    var keys: [String] = []
    var items: [TileItem]
    var saved: Int = 0
    var partial: Bool = false
    var seed: UInt32 = 0
    var hue: Int = 0

    var id: String { key }
    var displayName: String { kind == .album && !album.isEmpty ? album : title }
    var firstEntry: MediaEntry? { items.first?.entry }
    var totalSize: Double { items.reduce(0) { $0 + $1.entry.size } }
    var discCount: Int { Set(items.compactMap(\.season)).count }
    var seasonCount: Int { Set(items.compactMap(\.season)).count }
    var isFullySaved: Bool { !items.isEmpty && saved == items.count }
    var isAllYouTube: Bool { !items.isEmpty && items.allSatisfy { $0.entry.isYouTube } }
    var hasYouTube: Bool { items.contains { $0.entry.isYouTube || $0.alts.contains(where: \.isYouTube) } }
    var monogramText: String { CatalogText.monogram(kind == .album ? album : title) }

    var lineText: String {
        let n = items.count
        switch kind {
        case .show:
            let seasons = seasonCount
            return (seasons > 1 ? "\(plural(seasons, "season", "seasons")) · " : "") + plural(n, "episode", "episodes")
        case .album:
            let discs = discCount
            let tracksPart = (discs > 1 ? "\(plural(discs, "disc", "discs")) · " : "") + plural(n, "track", "tracks")
            return totalSize > 0 ? "\(tracksPart) · \(bytes(totalSize))" : tracksPart
        case .movie:
            let detail = n > 1 ? "\(n) versions" : bytes(firstEntry?.size ?? 0)
            return "Movie · \(detail)"
        case .clip:
            let detail = n > 1 ? "\(n) versions" : bytes(firstEntry?.size ?? 0)
            return "Clip · \(detail)"
        }
    }

    var stateLabel: String {
        if isFullySaved { return "Saved here" }
        if saved > 0 || partial {
            switch kind {
            case .show: return "\(saved) saved here"
            case .album: return "\(saved) of \(items.count) saved here"
            case .movie, .clip: return "Partly saved"
            }
        }
        return "On the network"
    }

    var year: String? {
        items.first?.entry.year
    }
}

struct TrackRow: Identifiable, Hashable {
    let entry: MediaEntry
    let albumKey: String
    let albumTitle: String
    let artist: String
    let title: String
    let number: String
    let disc: Int
    let track: Int
    let hue: Int
    let seed: UInt32
    let monogramText: String
    let copies: Int
    let alts: [MediaEntry]

    var id: String { entry.key }
    var displayArtist: String { artist.isEmpty ? "Unknown artist" : artist }
}

struct ArtistGroup: Identifiable, Hashable {
    let id: String
    let name: String
    let albums: [LibraryTile]
    let tracks: [TrackRow]
}

enum TrackSortField: String, CaseIterable, Identifiable {
    case title = "Title"
    case artist = "Artist"
    case album = "Album"
    case size = "Size"

    var id: String { rawValue }
}

struct LibrarySearchResults {
    let albums: [LibraryTile]
    let tracks: [TrackRow]
    let moviesAndSeries: [LibraryTile]
    let clips: [LibraryTile]

    var isEmpty: Bool {
        albums.isEmpty && tracks.isEmpty && moviesAndSeries.isEmpty && clips.isEmpty
    }
}

// MARK: - Catalog Builder

struct LibraryCatalog {
    static let empty = LibraryCatalog(tiles: [], albums: [], movies: [], series: [], clips: [], artists: [], tracks: [])

    let tiles: [LibraryTile]
    let albums: [LibraryTile]
    let movies: [LibraryTile]
    let series: [LibraryTile]
    let clips: [LibraryTile]
    let artists: [ArtistGroup]
    let tracks: [TrackRow]

    var moviesAndSeries: [LibraryTile] {
        (movies + series).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    var allVideos: [LibraryTile] {
        (movies + series + clips).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    func tile(forKey key: String) -> LibraryTile? {
        tiles.first { $0.key == key }
    }

    func artist(named name: String) -> ArtistGroup? {
        let folded = CatalogText.fold(name)
        return artists.first { $0.id == folded }
    }

    func trackRow(forKey key: String) -> TrackRow? {
        tracks.first { $0.entry.key == key }
    }

    func tracks(forAlbum tile: LibraryTile) -> [TrackRow] {
        tile.items.map { item in
            let rowArtist = item.entry.music?.artist ?? tile.artist
            return TrackRow(
                entry: item.entry,
                albumKey: tile.key,
                albumTitle: tile.album.isEmpty ? tile.title : tile.album,
                artist: rowArtist,
                title: CatalogText.trackName(item.entry),
                number: CatalogText.trackNumber(item.entry),
                disc: item.season ?? 1,
                track: item.episode ?? 0,
                hue: tile.hue,
                seed: tile.seed,
                monogramText: tile.monogramText,
                copies: item.copies,
                alts: item.alts
            )
        }
    }

    func sortedTracks(filter: String, sortBy: TrackSortField, ascending: Bool, savedOnly: Bool) -> [TrackRow] {
        let q = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = tracks.filter { row in
            if savedOnly && !row.entry.saved { return false }
            if q.isEmpty { return true }
            return row.title.localizedCaseInsensitiveContains(q)
                || row.artist.localizedCaseInsensitiveContains(q)
                || row.albumTitle.localizedCaseInsensitiveContains(q)
        }
        return filtered.sorted { a, b in
            let order: ComparisonResult
            switch sortBy {
            case .title:
                order = a.title.localizedCaseInsensitiveCompare(b.title)
            case .artist:
                let aa = a.artist, ba = b.artist
                if aa.isEmpty != ba.isEmpty { return !aa.isEmpty }
                order = aa.localizedCaseInsensitiveCompare(ba)
            case .album:
                order = a.albumTitle.localizedCaseInsensitiveCompare(b.albumTitle)
            case .size:
                if a.entry.size == b.entry.size {
                    order = a.title.localizedCaseInsensitiveCompare(b.title)
                } else {
                    return ascending ? a.entry.size < b.entry.size : a.entry.size > b.entry.size
                }
            }
            if order == .orderedSame {
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
            return ascending ? order == .orderedAscending : order == .orderedDescending
        }
    }

    func search(_ rawQuery: String) -> LibrarySearchResults {
        let q = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            return LibrarySearchResults(albums: [], tracks: [], moviesAndSeries: [], clips: [])
        }
        let foldedQuery = CatalogText.fold(q)
        let words = foldedQuery.split(separator: " ").map(String.init)
        func matches(_ fields: String...) -> Bool {
            let hay = fields.joined(separator: " ")
            if hay.localizedCaseInsensitiveContains(q) { return true }
            guard !words.isEmpty else { return false }
            let foldedHay = CatalogText.fold(hay)
            return words.allSatisfy { foldedHay.contains($0) }
        }

        let matchedAlbums = albums.filter { matches($0.album, $0.artist, $0.title) }
        let matchedTracks = tracks.filter { matches($0.title, $0.artist, $0.albumTitle, $0.entry.mediaID) }
        let matchedMoviesAndSeries = moviesAndSeries.filter { tile in
            matches(tile.title, tile.imdb ?? "", tile.items.first?.entry.mediaID ?? "")
                || tile.items.contains { matches($0.entry.title, $0.entry.mediaID) }
        }
        let matchedClips = clips.filter { tile in
            matches(tile.title, tile.items.first?.entry.mediaID ?? "")
        }
        return LibrarySearchResults(
            albums: matchedAlbums,
            tracks: matchedTracks,
            moviesAndSeries: matchedMoviesAndSeries,
            clips: matchedClips
        )
    }

    static func build(entries: [MediaEntry]) -> LibraryCatalog {
        var tileMap: [String: LibraryTile] = [:]

        for entry in entries {
            let imdbMatch = CatalogText.matchIMDb(entry.mediaID)
            let isMusic = imdbMatch == nil && entry.seasonNumber != nil
            let kind: TileKind
            if let m = imdbMatch {
                kind = m.season != nil ? .show : .movie
            } else {
                kind = isMusic ? .album : .clip
            }

            let key: String
            switch kind {
            case .clip:
                key = "v:\(entry.mediaID)/\(entry.sha256)"
            case .album:
                let sk = entry.seriesKey.isEmpty ? entry.mediaID : entry.seriesKey
                key = "album:\(sk)"
            case .movie:
                key = "movie:\(imdbMatch!.imdb)"
            case .show:
                key = "show:\(imdbMatch!.imdb)"
            }

            let item = TileItem(
                entry: entry,
                season: imdbMatch?.season ?? entry.seasonNumber,
                episode: imdbMatch?.episode ?? entry.episodeNumber
            )

            if var existing = tileMap[key] {
                existing.items.append(item)
                tileMap[key] = existing
            } else {
                tileMap[key] = LibraryTile(
                    key: key,
                    kind: kind,
                    imdb: imdbMatch?.imdb,
                    title: CatalogText.stripTrailingEpisode(entry.title),
                    items: [item]
                )
            }
        }

        // Finalize non-album tiles
        var rawAlbums: [LibraryTile] = []
        var nonAlbumTiles: [LibraryTile] = []

        for (_, var tile) in tileMap {
            if tile.kind == .album {
                rawAlbums.append(tile)
                continue
            }
            tile.items.sort { a, b in
                let sa = a.season ?? 0, sb = b.season ?? 0
                if sa != sb { return sa < sb }
                let ea = a.episode ?? 0, eb = b.episode ?? 0
                if ea != eb { return ea < eb }
                return a.entry.size > b.entry.size
            }
            tile.saved = tile.items.filter { $0.entry.saved }.count
            tile.partial = tile.items.contains { !$0.entry.saved && $0.entry.cachedBytes > 0 }
            tile.keys = tile.items.map { $0.entry.key }
            nonAlbumTiles.append(tile)
        }

        let mergedAlbums = mergeAlbums(rawAlbums)
        let allTiles = (nonAlbumTiles + mergedAlbums).sorted { a, b in
            let na = a.album.isEmpty ? a.title : a.album
            let nb = b.album.isEmpty ? b.title : b.album
            let cmp = na.localizedCompare(nb)
            if cmp != .orderedSame { return cmp == .orderedAscending }
            return a.title.localizedCompare(b.title) == .orderedAscending
        }

        let albums = allTiles.filter { $0.kind == .album }
        let movies = allTiles.filter { $0.kind == .movie }
        let series = allTiles.filter { $0.kind == .show }
        let clips = allTiles.filter { $0.kind == .clip }

        // Build tracks across all albums
        var allTracks: [TrackRow] = []
        for album in albums {
            for item in album.items {
                let rowArtist = item.entry.music?.artist ?? album.artist
                allTracks.append(TrackRow(
                    entry: item.entry,
                    albumKey: album.key,
                    albumTitle: album.album.isEmpty ? album.title : album.album,
                    artist: rowArtist,
                    title: CatalogText.trackName(item.entry),
                    number: CatalogText.trackNumber(item.entry),
                    disc: item.season ?? 1,
                    track: item.episode ?? 0,
                    hue: album.hue,
                    seed: album.seed,
                    monogramText: album.monogramText,
                    copies: item.copies,
                    alts: item.alts
                ))
            }
        }
        allTracks.sort { $0.title.localizedCompare($1.title) == .orderedAscending }

        // Group artists
        var artistMap: [String: (name: String, albums: [LibraryTile])] = [:]
        for album in albums {
            let name = album.artist.isEmpty ? "Unknown artist" : album.artist
            let folded = CatalogText.fold(name)
            if var group = artistMap[folded] {
                group.albums.append(album)
                artistMap[folded] = group
            } else {
                artistMap[folded] = (name: name, albums: [album])
            }
        }
        let artists = artistMap.map { folded, group -> ArtistGroup in
            let albumKeys = Set(group.albums.map(\.key))
            let artistTracks = group.albums.flatMap { album -> [TrackRow] in
                album.items.map { item in
                    TrackRow(
                        entry: item.entry,
                        albumKey: album.key,
                        albumTitle: album.album.isEmpty ? album.title : album.album,
                        artist: item.entry.music?.artist ?? album.artist,
                        title: CatalogText.trackName(item.entry),
                        number: CatalogText.trackNumber(item.entry),
                        disc: item.season ?? 1,
                        track: item.episode ?? 0,
                        hue: album.hue,
                        seed: album.seed,
                        monogramText: album.monogramText,
                        copies: item.copies,
                        alts: item.alts
                    )
                }
            }.filter { albumKeys.contains($0.albumKey) }
            return ArtistGroup(id: folded, name: group.name, albums: group.albums, tracks: artistTracks)
        }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }

        return LibraryCatalog(
            tiles: allTiles,
            albums: albums,
            movies: movies,
            series: series,
            clips: clips,
            artists: artists,
            tracks: allTracks
        )
    }

    /// Ports `mergeAlbums` from `src/ui.js` lines 1939-2020.
    private static func mergeAlbums(_ rawAlbums: [LibraryTile]) -> [LibraryTile] {
        struct AlbumVote {
            let artist: String
            let name: String
            var count: Int
        }
        struct AlbumBucket {
            let artist: String
            let album: String
            var parts: [LibraryTile]
        }

        var buckets: [String: AlbumBucket] = [:]
        var bucketOrder: [String] = []

        for tile in rawAlbums {
            var votes: [String: AlbumVote] = [:]
            for item in tile.items {
                let a = item.entry.music?.artist ?? ""
                let prefix = "\(a) · "
                let name = (!a.isEmpty && item.entry.title.hasPrefix(prefix))
                    ? String(item.entry.title.dropFirst(prefix.count))
                    : item.entry.title
                let voteKey = "\(a)\n\(name)"
                if var v = votes[voteKey] {
                    v.count += 1
                    votes[voteKey] = v
                } else {
                    votes[voteKey] = AlbumVote(artist: a, name: name, count: 1)
                }
            }
            guard let top = votes.values.max(by: { a, b in
                if a.count != b.count { return a.count < b.count }
                return "\(a.artist)\n\(a.name)" > "\(b.artist)\n\(b.name)"
            }) else { continue }

            let id = "\(CatalogText.fold(top.artist))\n\(CatalogText.fold(top.name))"
            if var bucket = buckets[id] {
                bucket.parts.append(tile)
                buckets[id] = bucket
            } else {
                buckets[id] = AlbumBucket(artist: top.artist, album: top.name, parts: [tile])
                bucketOrder.append(id)
            }
        }

        var albums: [LibraryTile] = bucketOrder.compactMap { bucketID in
            guard var bucket = buckets[bucketID] else { return nil }
            bucket.parts.sort { x, y in
                if x.items.count != y.items.count { return x.items.count > y.items.count }
                return x.key < y.key
            }

            let allItems = bucket.parts.flatMap(\.items).sorted { a, b in
                let sa = a.season ?? 0, sb = b.season ?? 0
                if sa != sb { return sa < sb }
                let ea = a.episode ?? 0, eb = b.episode ?? 0
                if ea != eb { return ea < eb }
                if a.entry.saved != b.entry.saved { return a.entry.saved }
                return a.entry.size > b.entry.size
            }

            // Deduplicate identical (season, episode, folded track name)
            var deduped: [TileItem] = []
            for item in allItems {
                if let lastIdx = deduped.indices.last,
                   deduped[lastIdx].season == item.season,
                   deduped[lastIdx].episode == item.episode,
                   CatalogText.fold(CatalogText.trackName(deduped[lastIdx].entry)) == CatalogText.fold(CatalogText.trackName(item.entry)) {
                    deduped[lastIdx].copies += 1
                    deduped[lastIdx].alts.append(item.entry)
                } else {
                    deduped.append(TileItem(entry: item.entry, season: item.season, episode: item.episode, copies: 1, alts: []))
                }
            }

            // Merge YouTube copies onto matching non-YT named track
            var namedIndex: [String: Int] = [:]
            for idx in deduped.indices {
                let item = deduped[idx]
                let foldedName = CatalogText.fold(CatalogText.trackName(item.entry))
                if !item.entry.isYouTube && namedIndex[foldedName] == nil {
                    namedIndex[foldedName] = idx
                }
            }

            var keep = Array(repeating: true, count: deduped.count)
            for idx in deduped.indices {
                let item = deduped[idx]
                let isPureYT = item.entry.isYouTube && !item.alts.contains(where: { !$0.isYouTube })
                guard isPureYT,
                      let twinIdx = namedIndex[CatalogText.fold(CatalogText.trackName(item.entry))],
                      twinIdx != idx else { continue }

                var mergedEntry = item.entry
                if item.entry.saved && !deduped[twinIdx].entry.saved {
                    let oldTwin = deduped[twinIdx].entry
                    deduped[twinIdx].entry = item.entry
                    mergedEntry = oldTwin
                }
                deduped[twinIdx].copies += item.copies
                deduped[twinIdx].alts.append(mergedEntry)
                deduped[twinIdx].alts.append(contentsOf: item.alts)
                keep[idx] = false
            }

            let rows = zip(deduped, keep).compactMap { $0.1 ? $0.0 : nil }
            let seed = CatalogText.sleeveHash("\(CatalogText.fold(bucket.artist))\n\(CatalogText.fold(bucket.album))")
            let displayTitle = bucket.artist.isEmpty ? bucket.album : "\(bucket.artist) · \(bucket.album)"
            let releases = bucket.parts.filter { !$0.items.allSatisfy { $0.entry.isYouTube } }.count
            let allKeys = bucket.parts.flatMap { $0.items.map { $0.entry.key } }

            return LibraryTile(
                key: bucket.parts[0].key,
                kind: .album,
                imdb: nil,
                title: displayTitle,
                artist: bucket.artist,
                album: bucket.album,
                releases: releases,
                keys: allKeys,
                items: rows,
                saved: rows.filter { $0.entry.saved }.count,
                partial: rows.contains { !$0.entry.saved && $0.entry.cachedBytes > 0 },
                seed: seed,
                hue: 0
            )
        }

        // 6-slot per-artist hue wheel so sibling albums never share a hue
        var byArtist: [String: [Int]] = [:]
        for idx in albums.indices {
            let k = CatalogText.fold(albums[idx].artist)
            byArtist[k, default: []].append(idx)
        }
        for indices in byArtist.values {
            var used = Set<Int>()
            let sorted = indices.sorted { albums[$0].seed < albums[$1].seed }
            for idx in sorted {
                let seed = albums[idx].seed
                var slot = Int((seed % 360) / 60)
                for _ in 0..<6 where used.contains(slot) {
                    slot = (slot + 1) % 6
                }
                used.insert(slot)
                albums[idx].hue = slot * 60 + Int((seed >> 11) % 36)
            }
        }

        return albums
    }
}
