import Foundation
import XCTest
#if canImport(PearTube)
@testable import PearTube
#endif

final class DiscoverModelsTests: XCTestCase {
    func testDecodeDiscoverCreatorFullAndMinimal() throws {
        let fullJSON = Data("""
        {
          "id": "youtube:UC1234567890123456789012",
          "source": "youtube",
          "handle": "@veritasium",
          "name": "Veritasium",
          "url": "https://www.youtube.com/channel/UC1234567890123456789012",
          "channelId": "UC1234567890123456789012",
          "avatar": "/v1/discover/thumb/0123456789abcdef0123",
          "followedAt": 1730000000000,
          "followed": true
        }
        """.utf8)

        let full = try JSONDecoder().decode(DiscoverCreator.self, from: fullJSON)
        XCTAssertEqual(full.id, "youtube:UC1234567890123456789012")
        XCTAssertEqual(full.source, "youtube")
        XCTAssertEqual(full.sourceBadge, "YouTube")
        XCTAssertEqual(full.handle, "@veritasium")
        XCTAssertEqual(full.displayName, "Veritasium")
        XCTAssertEqual(full.channelId, "UC1234567890123456789012")
        XCTAssertEqual(full.avatar, "/v1/discover/thumb/0123456789abcdef0123")
        XCTAssertEqual(full.followedAt, 1730000000000)
        XCTAssertEqual(full.followed, true)

        // Resilient decoding when optional fields are omitted or null.
        let minimalJSON = Data("""
        {
          "source": "rumble",
          "url": "https://rumble.com/c/example",
          "channelId": "c/example",
          "avatar": null,
          "followedAt": "1730000000500"
        }
        """.utf8)

        let minimal = try JSONDecoder().decode(DiscoverCreator.self, from: minimalJSON)
        XCTAssertEqual(minimal.id, "rumble:c/example")
        XCTAssertEqual(minimal.sourceBadge, "Rumble")
        XCTAssertEqual(minimal.avatar, "")
        XCTAssertEqual(minimal.followedAt, 1730000000500)
        XCTAssertNil(minimal.followed)
    }

    func testDecodeDiscoverItemVideoAndAudio() throws {
        let soundcloudJSON = Data("""
        {
          "id": "soundcloud:987654321",
          "source": "soundcloud",
          "kind": "audio",
          "itemId": 987654321,
          "title": "Midnight Tape",
          "creatorId": "soundcloud:42",
          "creatorName": "Tape Artist",
          "creatorUrl": "https://soundcloud.com/tapeartist",
          "url": "https://soundcloud.com/tapeartist/midnight-tape",
          "thumbnail": "/v1/discover/thumb/abcdef0123456789abcd",
          "duration": "245",
          "publishedAt": 1730100000000,
          "acquireId": "sc:1234567890ab:s01e01",
          "audioOnly": true,
          "music": { "title": "Midnight Tape", "artist": "Tape Artist" },
          "inLibrary": true
        }
        """.utf8)

        let audio = try JSONDecoder().decode(DiscoverItem.self, from: soundcloudJSON)
        XCTAssertEqual(audio.id, "soundcloud:987654321")
        XCTAssertEqual(audio.sourceBadge, "SoundCloud")
        XCTAssertEqual(audio.itemId, "987654321")
        XCTAssertEqual(audio.duration, 245)
        XCTAssertEqual(audio.durationText, "4:05")
        XCTAssertEqual(audio.acquireId, "sc:1234567890ab:s01e01")
        XCTAssertTrue(audio.audioOnly)
        XCTAssertEqual(audio.music?.artist, "Tape Artist")
        XCTAssertTrue(audio.inLibrary)

        // Resilient decoding when optional fields are null/missing.
        let minimalVideoJSON = Data("""
        {
          "source": "youtube",
          "itemId": "dQw4w9WgXcQ",
          "title": "Sample Video",
          "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "duration": null,
          "music": null
        }
        """.utf8)

        let video = try JSONDecoder().decode(DiscoverItem.self, from: minimalVideoJSON)
        XCTAssertEqual(video.id, "youtube:dQw4w9WgXcQ")
        XCTAssertEqual(video.kind, "video")
        XCTAssertEqual(video.creatorName, "YouTube")
        XCTAssertNil(video.duration)
        XCTAssertNil(video.durationText)
        XCTAssertFalse(video.audioOnly)
        XCTAssertFalse(video.inLibrary)
    }

    func testDecodeDiscoverFeedWithPartialErrors() throws {
        let feedJSON = Data("""
        {
          "creators": [
            {
              "id": "youtube:UCabcdefghijklmnopqrstuv",
              "source": "youtube",
              "handle": "@tech",
              "name": "Tech Channel",
              "url": "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
              "channelId": "UCabcdefghijklmnopqrstuv",
              "avatar": "/v1/discover/thumb/0123456789abcdef0123",
              "followedAt": 1730000000000
            }
          ],
          "items": [
            {
              "id": "youtube:abc123def45",
              "source": "youtube",
              "kind": "video",
              "itemId": "abc123def45",
              "title": "Deep Dive",
              "creatorId": "youtube:UCabcdefghijklmnopqrstuv",
              "creatorName": "Tech Channel",
              "creatorUrl": "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
              "url": "https://www.youtube.com/watch?v=abc123def45",
              "thumbnail": "/v1/discover/thumb/0123456789abcdef0123",
              "duration": 612,
              "publishedAt": 1730200000000,
              "acquireId": "clip:0123456789abcdef",
              "audioOnly": false,
              "music": null,
              "inLibrary": false
            }
          ],
          "errors": [
            {
              "creatorId": "rumble:c/example",
              "source": "rumble",
              "name": "Example Rumble",
              "message": "Rumble answered 403"
            }
          ],
          "updatedAt": 1730200005000
        }
        """.utf8)

        let feed = try JSONDecoder().decode(DiscoverFeed.self, from: feedJSON)
        XCTAssertEqual(feed.creators.count, 1)
        XCTAssertEqual(feed.items.count, 1)
        XCTAssertEqual(feed.items[0].durationText, "10:12")
        XCTAssertEqual(feed.errors.count, 1)
        XCTAssertEqual(feed.errors[0].displayLabel, "Example Rumble")
        XCTAssertEqual(feed.errors[0].message, "Rumble answered 403")
        XCTAssertEqual(feed.updatedAt, 1730200005000)

        // Empty object decodes cleanly with defaults.
        let emptyFeed = try JSONDecoder().decode(DiscoverFeed.self, from: Data("{}".utf8))
        XCTAssertTrue(emptyFeed.creators.isEmpty)
        XCTAssertTrue(emptyFeed.items.isEmpty)
        XCTAssertTrue(emptyFeed.errors.isEmpty)
        XCTAssertEqual(emptyFeed.updatedAt, 0)
    }

    func testDecodeDiscoverBrowseResultAndRoundTrip() throws {
        let browseJSON = Data("""
        {
          "query": "Science",
          "sources": ["youtube", "soundcloud", "rumble"],
          "creators": [
            {
              "id": "youtube:abc123456789",
              "source": "youtube",
              "handle": "",
              "name": "Science Lab",
              "url": "https://www.youtube.com/watch?v=xyz12345678",
              "channelId": "",
              "avatar": "/v1/discover/thumb/11112222333344445555",
              "followedAt": 0,
              "followed": false
            }
          ],
          "items": [
            {
              "id": "youtube:xyz12345678",
              "source": "youtube",
              "kind": "video",
              "itemId": "xyz12345678",
              "title": "Quantum Explained",
              "creatorId": "youtube:abc123456789",
              "creatorName": "Science Lab",
              "creatorUrl": "https://www.youtube.com/watch?v=xyz12345678",
              "url": "https://www.youtube.com/watch?v=xyz12345678",
              "thumbnail": "/v1/discover/thumb/11112222333344445555",
              "duration": 900,
              "publishedAt": 0,
              "acquireId": "clip:fedcba9876543210",
              "audioOnly": false,
              "music": null,
              "inLibrary": false
            }
          ],
          "errors": [
            {
              "source": "rumble",
              "status": 502,
              "message": "No answer in 15 s"
            }
          ]
        }
        """.utf8)

        let browse = try JSONDecoder().decode(DiscoverBrowseResult.self, from: browseJSON)
        XCTAssertEqual(browse.query, "Science")
        XCTAssertEqual(browse.sources, ["youtube", "soundcloud", "rumble"])
        XCTAssertEqual(browse.creators.count, 1)
        XCTAssertEqual(browse.creators[0].followed, false)
        XCTAssertEqual(browse.items.count, 1)
        XCTAssertEqual(browse.errors.count, 1)
        XCTAssertEqual(browse.errors[0].displayLabel, "Rumble")
        XCTAssertEqual(browse.errors[0].status, 502)

        // Codable round-trip check.
        let encoded = try JSONEncoder().encode(browse)
        let decoded = try JSONDecoder().decode(DiscoverBrowseResult.self, from: encoded)
        XCTAssertEqual(decoded, browse)
    }
}
