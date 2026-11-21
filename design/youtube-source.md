# YouTube as a searchable source: design

Status: proposal, 2026-11-20. Research only; nothing in `src/` changed.

## Verdict

- **ubit can already search YouTube.** The shipped `bare-ubit` WASM build answers `info --json 'ytsearch:<query>'` with up to about 20 videos in about 3 s. No new extractor is needed for YouTube search, and none should be written in JS.
- **YouTube Music is not a v1 source.** From this relay's egress, YouTube Music says "not available in your area". Its catalog search returns only user profiles, user playlists and podcasts. The song and album filters return "No results". ubit has no YouTube Music client either. Leave it out until a relay with YouTube Music access can test it.
- **Smallest honest implementation:** a `youtube` provider in `src/providers/youtube.js` built on `ubitInfo` and `downloadPage`, which already exist in `src/identify.js`. Albums get the id namespace `yt:<20hex>`. The library labels them "YouTube · AAC 128 kbps". A new route, `POST /v1/search/sources`, runs every requested provider's existing `search` with `Promise.allSettled`.

Evidence used throughout:
- ubit source: `~/projects/ubit` (upstream `github.com/ayooooo123/ubit`, HEAD `a243219`).
- NewPipe: `github.com/TeamNewPipe/NewPipeExtractor`, pinned to commit `85025eebd6d07090dd6b7da216528d5fa2943b8f` and cited below as `NP/<file>#Lx-Ly`. Base URL: `https://github.com/TeamNewPipe/NewPipeExtractor/blob/85025eebd6d07090dd6b7da216528d5fa2943b8f/extractor/src/main/java/org/schabi/newpipe/extractor/services/youtube/`.

---

## 1. Can `ubit` search?

**Yes, YouTube (web) only.** Evidence:

| Claim | Where |
|---|---|
| A query with the `ytsearch:` prefix, or one that is not a URL and contains a space, goes to `YouTubeExtractor::search` | `~/projects/ubit/linux/src/extractors.hpp:638-643` |
| `search()` sends `POST https://www.youtube.com/youtubei/v1/search?prettyPrint=false` with `context.client = { clientName: "WEB", clientVersion: "2.20261029.11.00", hl: "en", gl: "US" }` and no key, cookie or OAuth | `extractors.hpp:426-439` |
| The result is parsed by walking the tree for `videoRenderer`, `playlistVideoRenderer` and `reelItemRenderer` | `extractors.hpp:394-423` (`collect_items`) |
| Each result has `{ id, title, url, duration, thumbnail }`. **`author` is always `""`**: the 6th constructor argument at line 411 is a literal empty string, even though `ownerText` is in the response | `extractors.hpp:411`, `models.hpp:142-158` |
| Only the first page is returned. A continuation token is collected but never used for search | `extractors.hpp:435-436` |
| Zero results throw `No YouTube results for '<q>'` | `extractors.hpp:437` |
| `ubit info --json` prints `MediaInfo.to_json()`, including `entries[]` | `linux/src/main.cpp:453-477`, `models.hpp:177-195` |
| The shipped WASM contains this code path | `strings node_modules/bare-ubit/ubit.wasm` shows `https://www.youtube.com/youtubei/v1/search?prettyPrint=false` and `2.20261029.11.00` |
| `ubit get` can do audio only: `-a` picks the best AAC audio-only format by default (`prefer_compatible = true`). `--best-codec` picks Opus/WebM instead | `main.cpp:305,314-316`, `engine.hpp:12,56-70,95-98` |
| No YouTube Music client: no `WEB_REMIX`, and nothing routes `music.youtube.com/search` | `grep WEB_REMIX` finds nothing in `linux/src`. `info 'https://music.youtube.com/search?q=mezmerize'` → `error: Could not extract YouTube video ID` |
| The Swift Mac app has the same search (`Sources/Extractors/YouTubeExtractor.swift:618-633`), but the WASM is built from the Linux C++ CLI | `linux/build_wasm.sh` compiles `linux/src/main.cpp` |
| Relay-only: the WASM needs JSPI (`WebAssembly.promising`) and Bare ≥ 1.36 | `node_modules/bare-ubit/index.js:55`, `README.md:12` |

Live run against the real service (this machine, egress 149.102.229.145, Datacamp, Istanbul TR):

```
$ bare node_modules/bare-ubit/bin.js --config /tmp/yt-research-ubit info --json 'ytsearch:system of a down mezmerize'
exit=0  real 0m2.875s  -> 11 entries, e.g.
{ "duration": 2173, "id": "Ws8sMtt8VK0", "thumbnail": "https://i.ytimg.com/vi/Ws8sMtt8VK0/mqdefault.jpg",
  "title": "S̲y̲stem of a D̲own - M̲e̲zmerize (Full Album)", "url": "https://www.youtube.com/watch?v=Ws8sMtt8VK0" }
$ ... formats --json 'https://music.youtube.com/watch?v=DmmYAX8Phig'        (5.8 s)
  itag 140 mp4a.40.2 m4a 129495 bps | itag 251 opus webm 136210 bps | 139/249/250 lower
$ ... get --no-library --no-playlist --json -a -o /tmp/yt-research-out 'https://www.youtube.com/watch?v=DmmYAX8Phig'
  {"event":"info","ext":"m4a","quality":"Audio 129k",...}
  {"event":"done",...,"size":4136744}    real 0m20.37s   (251 s track -> 132 kbps file)
```

**Cheapest path.** Use ubit as it is through the existing `resolveUbit` (`src/identify.js:71-83`). That spawns a jailed `bare bare-ubit/bin.js` process, or the `UBIT_BIN` override.
- Do not write a second InnerTube client in JS with `bare-https`. It would duplicate `collect_items` and turn two parsers into two places that can break.
- Do not shell out to anything else.
- Three small ubit changes are worth sending upstream. v1 does not need them:
  1. Fill `author` from `longBylineText` → `ownerText` → `shortBylineText`, the order NewPipe uses (`NP/extractors/YoutubeStreamInfoItemExtractor.java#L186-L192`). This is one line at `extractors.hpp:411`.
  2. Parse `lockupViewModel` items of `contentType == "LOCKUP_CONTENT_TYPE_VIDEO"`, as NewPipe already does (`NP/extractors/YoutubeSearchExtractor.java#L247-L259`). See risk R2.
  3. Read the WEB client version from `sw.js_data`. ubit already fetches that file for `visitorData` (`extractors.hpp:495-502`). NewPipe reads `[0][2][0][0][16]` (`NP/YoutubeParsingHelper.java#L478-L498`).

### What NewPipe does, and what it does not need

- **Search request:** `POST https://www.youtube.com/youtubei/v1/search?prettyPrint=false` with body `{ context, query, params? }` (`NP/extractors/YoutubeSearchExtractor.java#L89-L106`).
  - The context comes from `prepareDesktopJsonBuilder`: `client { hl, gl, clientName: "WEB", clientVersion, originalUrl, platform: "DESKTOP", utcOffsetMinutes: 0 }`, `request { internalExperimentFlags: [], useSsl: true }`, `user { lockedSafetyMode: false }` (`NP/YoutubeParsingHelper.java#L1049-L1076`).
  - Headers: `X-YouTube-Client-Name: 1`, `X-YouTube-Client-Version`, `Origin`/`Referer: https://www.youtube.com`, and the consent cookie `SOCS=CAE=` (`#L1114-L1175`).
  - Filters are opaque protobuf `params` strings, e.g. videos `EgIQAfABAQ==`, all `8AEB` (`NP/linkHandler/YoutubeSearchQueryHandlerFactory.java#L79-L96`).
- **Parsing:** `contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[].itemSectionRenderer.contents[]` → `videoRenderer` | `channelRenderer` | `playlistRenderer` | `lockupViewModel` (`#L162-L260`).
  - Pages come from `continuationItemRenderer.continuationEndpoint.continuationCommand.token` (`#L265-L272`).
  - "Did you mean" comes from `didYouMeanRenderer` / `showingResultsForRenderer` (`#L116-L147`).
- **Not needed:** an API key or OAuth. The parsing helper has no `key=` or `AIza` (grep of `YoutubeParsingHelper.java` finds none).
- **Needed:** a current client version. NewPipe tries, in order:
  1. `sw.js_data` (`#L478-L498`)
  2. the HTML search page's `ytInitialData` `serviceTrackingParams` CSI `cver`, or the regex `INNERTUBE_CONTEXT_CLIENT_VERSION` (`#L500-L543`)
  3. a hardcoded version, checked first against the `guide` endpoint (`#L430-L475`, `#L566-L591`; `NP/ClientsConstants.java#L21` = `2.20260805.01.00`)
- **YouTube Music:** `POST https://music.youtube.com/youtubei/v1/search` with `clientName: "WEB_REMIX"`, client id 67, version `1.20260804.16.00` (`NP/ClientsConstants.java#L25-L27`).
  - Per-type `params`, e.g. songs `Eg-KAQwIARAAGAAgACgAMABqChAEEAUQAxAKEAk%3D` (`NP/extractors/YoutubeMusicSearchExtractor.java#L56-L111`).
  - Results are `tabbedSearchResultsRenderer` → `musicShelfRenderer.contents[].musicResponsiveListItemRenderer` with `flexColumns[0]` = name and `flexColumns[1].runs` = artist / album / duration (`#L193-L199`, `#L261-L297`; `NP/extractors/YoutubeMusicSongOrVideoInfoItemExtractor.java#L39-L86`).
- **Signatures, the n-param and poToken** matter only for downloads, never for search.
  - NewPipe downloads `base.js` to decrypt the `s` signature and the `n` throttling parameter. Without `n`, downloads run at about 50 KB/s (`NP/YoutubeJavaScriptPlayerManager.java#L15-L29`, `#L173-L201`; `NP/extractors/YoutubeStreamExtractor.java#L1246-L1280`).
  - It fetches the player as the visionOS client (`YoutubeStreamExtractor.java#L834`, `#L929-L938`) and accepts an external `PoTokenProvider` (`#L1568-L1597`).
  - **ubit avoids all of this.** It asks the VISIONOS, IOS and TVHTML5 player clients, which return plain `url`s (`extractors.hpp:504-511`). It drops any format that has no `url`, i.e. signatureCipher formats (`extractors.hpp:537-539`). It keeps the first client whose stream tail is actually fetchable (`extractors.hpp:342-351, 568-575`). There is no JS decryption and no poToken.

---

## 2. Provider contract

The shape stays as it is: `{ name, description, run(payload, ctx), info(), search, mirror, listJobs, getJob, cancelJob, stop }`, registered in `src/mirror.js` beside `createSoulseekPlugin` (`mirror.js:1028-1039`). It is reached through the existing `POST /v1/providers/:name/{search,mirror}` routes (`src/http.js:414-423` → `mirror.js:1163-1177`).

### `search({ query, limit = 20 })`

It returns the **same envelope Soulseek returns** (`src/providers/soulseek.js:323-341`): `{ candidates, cap, truncated }`. Any caller of `/v1/providers/<name>/search` can then read either provider the same way.

Implementation: `ubitInfo('ytsearch:' + query, { configDir, timeoutMs: 15_000 })`.
- `ubitInfo` is at `src/identify.js:85-116` and needs to be exported.
- Map `entries[]` to rows. Map ubit's `No YouTube results` error to `candidates: []`.
- `cap` is 20, the first page of results.

### Row shapes: one union, common fields first

```ts
// Fields every source fills (null = this source cannot know it at search time)
type Common = {
  source: 'soulseek' | 'youtube'   // added by the unified endpoint; providers may omit it
  title: string                    // soulseek: basename(filename); youtube: video title
  length: number | null            // seconds
  size: number | null              // bytes; youtube: null (unknown until downloaded)
  bitrate: number | null           // kbps; youtube: 128 (nominal for AAC itag 140, measured 129.5)
  sample_rate: number | null       // youtube: null
  bit_depth: number | null         // youtube: null
  lossy: true | null               // true = known lossy (all youtube; soulseek .mp3/.aac/.opus/.wma);
                                   // null = cannot tell (a .flac/.wav may be a transcode; .m4a and .ogg hold
                                   // lossless codecs too: ALAC, FLAC)
}
type SoulseekRow = Common & { username: string, slots: boolean, queue: number, filename: string }
type YoutubeRow  = Common & { videoId: string, url: string, channel: string | null, thumbnail: string }
```

How YouTube fills the Soulseek fields:

| Soulseek field | YouTube | Why |
|---|---|---|
| `username` | `channel` (a different key) | It is a publisher, not a peer you can browse or queue on. It is `null` until the ubit author fix lands |
| `slots`, `queue` | absent | YouTube has no upload slots or queue. Sending `slots: true, queue: 0` would invent peer state, and the Soulseek ranking (`normalizeSoulseekCandidates`, `soulseek.js:180-205`) must never sort YouTube rows as "ready peers" |
| `filename` | absent; `title` + `videoId` | There is no file until download |
| `size` | `null` | Knowing it costs a `formats` probe per result (5.8 s each, measured) |
| `bitrate` | `128` | Nominal for the format `get -a` picks (AAC, `engine.hpp:56-70`) |
| `sample_rate`, `bit_depth` | `null` | |
| `length` | `duration` | |

`lossy` is the one new common field. It is `true | null`, never `false`, which follows the "lossless container" rule in `qualityOf` in `src/ui.js`: FLAC proves only that the container is lossless. Soulseek rows get it from the extension in the unified endpoint (`LOSSY_FILE` in `src/mirror.js`), without touching the Soulseek provider; an extension whose container can hold a lossless codec stays `null`.

### `mirror` payload and job

```jsonc
// POST /v1/providers/youtube/mirror
{ "artist": "System of a Down", "album": "Mezmerize", "year": 2005,
  "tracks": [ { "videoId": "Ws8sMtt8VK0", "title": "Soldier Side - Intro", "track": 1, "disc": 1 } ] }
// -> 202-style body, same as soulseek's `{ queued: true, job }`
{ "queued": true, "job": {
  "jobId": "uuid", "plugin": "youtube", "source": "youtube", "id": "yt:3f2a…(20 hex)",
  "title": "System of a Down · Mezmerize", "status": "queued" | "transferring" | "announcing" | "done" | "failed" | "cancelled",
  "phase": "downloading" | "waiting" | "importing", "peer": null, "queuePlace": null,
  "file": "01 - Soldier Side - Intro.m4a", "fileIndex": 1, "fileCount": 11,
  "bytes": 0, "total": null, "speed": 0, "error": null } }
```

The job fields match Soulseek's job (`soulseek.js:422-446`), so the jobs/progress UI renders YouTube jobs without changes. `queuePlace` and `peer` are always `null`.

Mirror steps:
1. For each track, call `downloadPage('https://www.youtube.com/watch?v=' + videoId, tmp, { audio: true, ... })`. That means adding `'-a'` to the args at `src/identify.js:121` when `audio` is set.
2. Run tracks one at a time. The WASM has one connection at a time (`bare-ubit/README.md:44`), so about 20 s per 4-minute track (measured).
3. `renameSync` each file into `<stagingRoot>/<Artist> · <Album>/<NN> - <title>.m4a`.
4. Write `.peartube-album.json` `{ "release": "yt:…", "title": "<Artist> · <Album>", "artist": "<Artist>" }`.
5. Import. Steps 3 to 5 are one step run by the plugin host (`placeAndScan` in `src/mirror.js`): the downloaded tracks stay in the work folder until no other import holds the import folder, then they are moved in, pinned and scanned in the same tick. While the job waits (`status: "announcing"`, `phase: "waiting"`) Cancel works and nothing is placed; after `importWaitMs` (120 s) the job fails with nothing placed. A job that is not `done` leaves nothing for a later scan. The Soulseek provider places its mirrors the same way.

Artist, album and year come **from the caller**. The provider does not guess album metadata from video titles: see §4.

---

## 3. Fidelity: how to label it

What a YouTube copy is:
- AAC-LC in MP4: itag 140, 129,495 bps nominal, file measured at 132 kbps. Or Opus about 136 kbps with `--best-codec`.
- It is always lossy and always a re-encode by YouTube of whatever the label delivered.
- The bare-ubit WASM build has no ffmpeg and only stream-copies (`bare-ubit/README.md:45`). So the file stays honestly AAC-in-M4A and is never wrapped in a lossless container.

Labels:
- **Search row:** `YouTube · AAC 128 kbps · lossy`. Never "HQ", "320", "lossless" or "high quality". If YouTube is the only source for an album, the UI says so; it does not blend the album in silently.
- **Library track line:** `YouTube · AAC 128 kbps`. `qualityOf` / `shortQuality` in `src/ui.js` already print codec + bitrate from `mediaInfo` (`src/resolution.js` names `mp4a` as AAC). The only addition is the word "YouTube", decided from the id prefix `yt:`.
- **Album sheet header** when every copy is `yt:`: `From YouTube · AAC 128 kbps`.
- **Merged tiles.** `mergeAlbums` in `src/ui.js` already merges a `yt:` album with an `mb:`/`album:` album of the same artist and name, and plays "the copy saved here (or the larger one)". A FLAC copy is about 7× larger, so it wins whenever both copies are equally saved. A saved YouTube copy beats an unsaved FLAC, which is correct for playback, and the row still says `YouTube · AAC 128 kbps`. No comparator change is needed.

**Announce marker: no new `source: 'youtube'` field.**
- `source` already means a hex channel or tracker key everywhere: entries' `e.source` (`sourceName(key)` in `src/ui.js`), `catalog.js:133`, and `GET /v1/search?source=` (`src/http.js:290`). Reusing the name would overload it.
- An announce is built from whitelisted fields in `put()` (`src/node/blobs.js:905-915`) and `repost` (`src/mirror.js:213`). A new field would mean three edits, and it would still only be the announcer's own claim.
- **The `yt:` id prefix carries the provenance at zero cost.** `ID` (`src/protocol.js:5`, `/^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/`) already accepts it. `decodeOp` (`protocol.js:241-247`) passes it. Every client already splits ids on `:`.
- Add an `origin` field (not `source`) only if YouTube copies are ever announced under `mb:` ids, which this design forbids.

---

## 4. Music identity

YouTube-sourced albums use the id **`yt:<hex>`**, and tracks use `yt:<hex>:sDDeTTT`.
- `<hex>` = `sha256(albumKey({ albumArtist: artist, album, year })).hex.slice(0, 20)`.
- That is exactly the hex `albumIdentity` gives an untagged-MBID folder as `album:<hex>` (`src/mirror.js:87-117`, `src/tags.js:208-210`).

Why:
- **No collision with `mb:`, `discogs:` or `album:`.** The prefixes are different, so a YouTube copy can never answer `GET /v1/search?id=mb:<release>:s01e03` or a global search for a MusicBrainz release. Someone asking for a release does not silently get 128 kbps AAC. Matching a YouTube upload to a MusicBrainz release is a claim the relay cannot check: track count, edition, remaster.
- **Still groups correctly.** The library tile is decided by artist + album name in `mergeAlbums` (`src/ui.js`), not by release id. So the `yt:` album and a lossless `mb:` album of the same record become one tile, and each track shows its copies. The `yt:<hex>` ↔ `album:<hex>` match is a deterministic cross-reference without a lookup.
- **Two relays agree.** It depends only on artist/album/year, not on a YouTube Music browse id, which this relay cannot fetch (§6, R3).
- **Not used:** YouTube Music `MPREb_…` / `OLAK5uy_…` ids. They contain uppercase letters, `_` and `-`, so `ID` would reject them without hashing. They are geo-dependent. And hashing them gives a second id for the same album on any relay that cannot see YouTube Music.

Core changes this needs:
- `src/providers/soulseek.js:36` `RELEASE_ID`: add `|yt:[0-9a-f]{20}`.
  - Its only consumer is `readAlbumPin` (`src/mirror.js:124`).
  - Soulseek's own `parseRelease` (`soulseek.js:73-80`) uses a separate literal regex and must **not** accept `yt:`. A lossless mirror must never be pinned into the YouTube namespace.
- `src/mirror.js:379`, the ledger regex in `albumFor`: add `yt:[0-9a-f]{20}`, so re-scans keep the id.
- `readAlbumPin` (`mirror.js:121-128`) returns `{ release, title, artist }`. `albumFor` (`mirror.js:384-386`) uses the pin's `title`. `inferMediaMeta` (`mirror.js:57`) falls back to `album.artist` for `music.artist`.
  - This is required because `readTags` reads only FLAC/Ogg/MP3 (`src/tags.js:178-181`), so an `.m4a` has no tags.
  - Without `music.artist`, `mergeAlbums` cannot merge the YouTube tile with the lossless one.
- `src/protocol.js:13` `MEDIA_FILE`: add `m4a`. Today `listMedia` (`mirror.js:350,357`) would skip every file ubit writes with `-a`.
  - The alternative is `--best-codec` (Opus in `.webm`, already accepted). That needs no protocol change but gives a less portable codec.

---

## 5. Unified search API

```jsonc
// POST /v1/search/sources   (owner-only: every POST passes requireOwner, src/http.js:211)
{ "query": "mezmerize", "sources": ["soulseek", "youtube"], "limit": 50, "timeoutMs": 20000 }
```

- `query`: required, trimmed, non-empty. Otherwise 400.
- `sources`: optional. The default is every registered provider that has `search`. Unknown names → **400** `{ error: "Unknown source: x (known: soulseek, youtube)" }`. That is a caller bug, not a partial failure.
- `limit`: **per source**, clamped to each provider's cap (Soulseek 200, YouTube 20).
- `timeoutMs`: a deadline per source. Default 20 s, clamped to 1-30 s. Soulseek's own window is 5 s (`soulseek.js:230`).

```jsonc
// 200, always when the request itself is valid (Soulseek row values are illustrative; the YouTube row is the live result in §1)
{
  "query": "mezmerize",
  "results": [
    { "source": "soulseek", "title": "01 - Soldier Side.flac", "length": 63, "size": 7340032,
      "bitrate": null, "sample_rate": 44100, "bit_depth": 16, "lossy": null,
      "username": "MoistOwlett", "slots": true, "queue": 0, "filename": "Music\\SOAD\\Mezmerize\\01 - Soldier Side.flac" },
    { "source": "youtube", "title": "System Of A Down - Radio/Video (Official Audio)", "length": 251, "size": null,
      "bitrate": 128, "sample_rate": null, "bit_depth": null, "lossy": true,
      "videoId": "DmmYAX8Phig", "url": "https://www.youtube.com/watch?v=DmmYAX8Phig", "channel": null,
      "thumbnail": "https://i.ytimg.com/vi/DmmYAX8Phig/mqdefault.jpg" }
  ],
  "bySource":  { "soulseek": 37, "youtube": 11 },
  "truncated": { "soulseek": true, "youtube": false },
  "errors": []
}
```

- **Order:** grouped by source, in the order of `sources`. Each block keeps its provider's own ranking. There is no score across sources: a Soulseek queue position and YouTube relevance cannot be compared.
- **Partial failure:**
  - Each provider runs under `Promise.allSettled` with the deadline.
  - A rejected or timed-out source contributes `0` to `bySource` and one entry to `errors`, for example: `{ "source": "youtube", "status": 504, "message": "YouTube did not answer in 20 s" }`, `{ "source": "soulseek", "status": 400, "message": "Soulseek is not configured" }`, `{ "source": "youtube", "status": 502, "message": "<ubit's error line verbatim>" }`.
  - `status` is the provider error's `.status`, else 502.
  - Messages pass through the providers' existing scrubbers. Soulseek's `scrub` (`soulseek.js:337`) already removes credentials.
  - The response stays **200** even if every source failed. Clients detect total failure with `errors.length === sources.length`. One shape means one code path in the UI.
- **Where it lives:**
  - `mirror.js` gets `searchSources({ query, sources, limit, timeoutMs })` next to `searchProvider` (`mirror.js:1163-1167`). It reads `res.candidates` from each provider and adds `source` and `lossy`.
  - `http.js` gets an 8-line route next to `/v1/search/global` (`http.js:272`).
  - The existing `/v1/providers/:name/search` stays as it is for single-source callers.

---

## 6. Risks that bite in production

- **R1 · Client-context rot (low for search).**
  - ubit hardcodes WEB `2.20261029.11.00` in two places (`extractors.hpp:428,445`). Today's live version from `sw.js_data` is `2.20261119.07.00`.
  - Measured: the stale version still returns 19 `videoRenderer`, and even `2.20200101.00.00` returns 20. `1.0` → HTTP 404.
  - YouTube tolerates old versions for a long time, then cuts them. Fix upstream with `sw.js_data` discovery (§1, change 3).
- **R2 · Renderer rot (the real one).**
  - YouTube is moving list items to `lockupViewModel`. Today the main search response already has 3 `lockupViewModel` beside 19 `videoRenderer`. A playlist-filtered search (`params: EgIQAw==`) returns 21 `lockupViewModel` and **0** `playlistRenderer`.
  - NewPipe already parses video lockups (`NP/extractors/YoutubeSearchExtractor.java#L247-L259`; `YoutubeStreamInfoItemLockupExtractor.java`). ubit does not (`extractors.hpp:394-423`).
  - When videos flip, ubit search returns nothing and throws `No YouTube results` (`extractors.hpp:437`), which **cannot be told apart from a real empty result**.
  - Mitigation in the provider: `info()` reports `lastSearchAt`, `lastResultCount` and `emptyStreak`. Three empty results in a row for queries longer than 3 characters → `status: 'degraded'` with the message "YouTube search returned nothing 3 times; the extractor may be out of date". Fix upstream (§1, change 2).
- **R3 · Geo and datacenter egress.**
  - From this relay (Datacamp, Istanbul): `https://music.youtube.com/?ucbcb=1` serves "YouTube Music is not available in your area".
  - WEB_REMIX search with NewPipe's current version `1.20260804.16.00` returns only Profile, Playlist and Podcast rows. The song and album `params` return `messageRenderer` "No results". Literal and decoded `%3D` both fail, and so do the old `EgWKAQ…` params.
  - YouTube web search and the download worked from the same IP. This is why YouTube Music is cut from v1.
  - Per-video geo blocks show up as the player's `reason`. NewPipe tells them apart by text: "country", "Music Premium", "members", "payment" (`NP/extractors/YoutubeStreamExtractor.java#L869-L927`). ubit passes the last reason through (`extractors.hpp:520-524`). Show it verbatim on the job.
- **R4 · Bot checks and rate limits.**
  - Datacenter IPs get "Sign in to confirm you're not a bot" on the player endpoint. NewPipe raises `SignInConfirmNotBotException` (`#L894-L898`) and relies on a poToken provider (`#L1568-L1597`). ubit has neither.
  - The failure is per job and must be shown verbatim. No retries on a loop. Search spawns one WASM process per call, about 3 s. The UI must search on submit, not per keystroke.
- **R5 · Age-gated, private and members-only videos** cannot be fetched anonymously (`NP/...YoutubeStreamExtractor.java#L879-L883`).
  - ubit only tries `SAPISIDHASH` if a cookie jar exists in `/config` (`extractors.hpp:379-388`). The relay's config folder has none, and **it should stay that way**: putting a Google account on a relay risks that account.
  - Such a track fails with YouTube's own reason. The album finishes with the other tracks, and the job error names the track.
- **R6 · When the extractor breaks.**
  - ubit is a WASM blob pinned in `node_modules/bare-ubit` (0.1.0). A fix means: edit `~/projects/ubit/linux/src/extractors.hpp`, run `linux/build_wasm.sh`, copy `dist/ubit.wasm`, publish `bare-ubit`, bump the dependency.
  - The emergency hatch is already built in: `UBIT_BIN` points at a native, newer `ubit` without a release (`src/identify.js:72-73`). This gives up the jail, so it is for the operator only.
  - Isolation rule: YouTube failing must never fail Soulseek search or jobs. `allSettled` and separate job maps guarantee that.
- **R7 · Platform.** The YouTube provider is relay-only. Phone and Mac worklets run QuickJS without JSPI. There, `info()` returns `{ status: 'unavailable', reason: 'needs the relay' }`, like Soulseek's addon state.
- **R8 · Terms.** YouTube's Terms of Service forbid downloading outside their apps. That is a policy choice for the operator, not a technical one. Labelling the copies honestly does not change it.

---

## 7. Smallest implementation (file by file)

| File | Change | Size |
|---|---|---|
| `src/identify.js` | `export` `ubitInfo`; `downloadPage(..., { audio })` adds `'-a'` to the args at line 121 | ~4 lines |
| `src/providers/youtube.js` (new) | `createYoutubePlugin({ stagingRoot, placeAndScan, info, download, onchange })`: `search` → `{ candidates, cap: 20, truncated }`; `mirror` → sequential `downloadPage` into the work folder, then `placeAndScan(place, ctx, { cancelled })` (move in, pin and scan as one step once no other import holds the folder); `listJobs` / `getJob` / `cancelJob` with Soulseek's job shape; `info()` with the R2 health fields | ~200 lines |
| `src/mirror.js` | register the plugin after Soulseek (it needs `ubitConfigDir` passed in from `bin/relay.js:37`); `searchSources`; `readAlbumPin` → `{ release, title, artist }`; `albumFor` and `inferMediaMeta` use the pin's title/artist; ledger regex `yt:` | ~45 lines |
| `src/providers/soulseek.js:36` | `RELEASE_ID` adds `yt:[0-9a-f]{20}` (not `parseRelease`) | 1 line |
| `src/protocol.js:13` | `MEDIA_FILE` adds `m4a` | 1 token |
| `src/http.js` | `POST /v1/search/sources` route | ~8 lines |
| `bin/relay.js` | pass `ubitConfigDir` into `createMirrorHost` options | ~1 line |
| `src/ui.js` (MusicUX owns it) | "YouTube" before codec/bitrate for `yt:` ids; a source column and filter chips on the search sheet | small |
| `test/youtube-provider.test.js` (new) | `UBIT_BIN` = a fake script that prints fixed `info` JSON: row mapping, empty → `[]`, failure → `errors[]` while Soulseek results still return, `yt:` id hex equals `album:` hex | ~80 lines |

Checks for whoever implements it: `npm run lint`, `node test/youtube-provider.test.js`, `node test/soulseek-plugin.test.js`, `node test/ui.e2e.js`. Then a live run on the relay: `curl -XPOST :8195/v1/search/sources -d '{"query":"mezmerize","sources":["soulseek","youtube"]}'`.

## 8. What to cut

- **YouTube Music search.** It is geo-blocked from this relay, the `params` blobs already fail, and it needs a second client (WEB_REMIX). Revisit as `ytmsearch:` inside ubit, with an availability probe that hits `music/get_search_suggestions` the way `NP/YoutubeParsingHelper.java#L622-L661` does.
- A JS InnerTube client, pagination/continuations, "did you mean".
- Signature/n-param/poToken work, cookies, age-gate bypass.
- Guessing album metadata from video titles ("Artist - Song (Official Audio)"); MusicBrainz matching for YouTube albums.
- An `origin`/`source` field in the announce; a scoring model across sources; a search cache.
- Video (non-audio) YouTube mirroring through this provider. Page links already handle video through `acquire.js`.
