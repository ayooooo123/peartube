# Multi-source search and save: UX design

Status: design, 2026-11-20. UI only. The API is the contract in `design/youtube-source.md` §5 and the `POST /v1/search/sources` streaming form. Nothing in `src/` changed.

Scope: the "Find albums" card on the Music tab of `src/ui.js`. It covers source selection, results arriving from two sources at different times, saving YouTube videos as an album, the progress cards, and how a YouTube copy is labelled in the library.

Since `design/unified-library.md` (2026-11-22) this card has no field of its own: the page's one Find field is in the top bar, and the card is the `Not in your library` part of Find. The rest of this document holds.

---

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Results are grouped by source, never interleaved.** Groups have a fixed order: Soulseek first, YouTube second. Each group has its own header, count, progress and error state. A group fills its slot when its answer arrives, and groups never reorder. | The two sources rank by different things: peer queue and slots vs YouTube relevance. Their rows are different units: an album folder vs one video. There is no honest score across them (`youtube-source.md` §5, "no score across sources"). With a fixed order the 3 s YouTube answer shows at once, and nothing moves under the finger when the 25 s Soulseek answer lands later (the existing `pressing` guard in `pollMirrors` protects the same thing). Soulseek goes first because it is the source that can have the better copy. |
| D2 | **Quality advice is given for the whole search, inside the YouTube group header, and again in the save dialog.** The UI does not try to guess which YouTube row "is" which Soulseek album. | The relay cannot prove that a video and a peer folder are the same record. A per-row "better copy elsewhere" badge would be a guess presented as fact. A note that only says what is true ("Peers have FLAC copies above. These are lossy AAC 128 kbps.") points the user to the better copy and still lets them save the other. |
| D3 | **Thumbnails go through the relay, never straight to `i.ytimg.com`.** The page fetches each thumbnail with its token from a new owner-only route, `GET /v1/providers/youtube/thumb/<videoId>`, and shows it as an object URL, as `flacPicture` already does. If the route answers 204 or anything else fails, the row keeps a drawn placeholder. | `COEP: credentialless` would let a no-cors `<img>` from YouTube load. But the page already has a rule that it never contacts third parties (the comment above `albumArt`: Cover Art Archive "would tell it what the relay holds"). A direct load would also send the owner's own IP and the results list to Google, and on an offline e2e run it would log network errors that fail the "no console errors" gate. A fetch to the page's own origin needs nothing from COEP. |
| D4 | **Chips choose sources.** Each chip shows its source's state as text. A source the relay does not register gets no chip at all. With one source there is no chip row. | Turning a source off is a real choice: YouTube costs a request to Google, Soulseek costs about 25 s. A relay without YouTube looks exactly as it does today. |
| D5 | **Save verbs follow what the action does.** Peer folders keep "Mirror": it copies the peer's file exactly. YouTube rows say "Save track" or "Save as album": YouTube re-encoded the audio, so this is not a mirror. Surfaces that show both kinds say "Adding", the word the Library jobs heading already uses. | The verb tells the user, honestly, what kind of copy they will get. |
| D6 | **YouTube save jobs share the Soulseek progress card (`slskJobItem`), which becomes `srcJobItem`.** Progress is counted in tracks, as a stepped bar, with no percentage. | The job shapes already match (`youtube-source.md` §2). Today a YouTube job would land in the Library "Adding" list through `renderJobs`, and that list would show the raw status word `transferring`, because `JOB_TEXT` has no entry for it. |

---

## 1. What exists today (reused, not replaced)

- **Markup** (HTML part of `src/ui.js`):
  - `<h2>Find albums</h2>`
  - `form#slskForm.card` holds `#slskInput` (type=search, placeholder "John Coltrane Blue Train"), `#slskBtn` "Search" and `.hint#slskHint`.
  - Inside the form, in order: `#slskPort` (port note), `.list.slsk-jobs#slskJobs`, `.msg#slskMsg[role=status]`, `.slsk-tools#slskTools` (holds `#slskSort`) and `.list#slskResults`.
  - Under the form: `.card.slsk-browse#slskBrowse`.
  - The album sheet is `dialog#detail` with `#detailBody`.
- **Search:**
  - `$('slskForm').onsubmit` calls `/v1/providers/soulseek/search` and stores `slskLast`.
  - `renderSourceResults()` turns the candidates into folder rows with `slskFolders()`, `slskQuality()` and `slskRate()`. The rows use `.item > .info > .name + .meta` and `.acts`, with `slskMirrorBtn` for Mirror and `openSlskBrowse` for Browse.
- **Jobs:**
  - Card text and progress: `slskJobState`, `slskAmount`, `slskJobItem`.
  - List, button sync and polling: `renderSlskJobs`, `slskSyncButton`, `slskStarted`, `pollMirrors`, `slskActive`.
  - Shared: `MIRROR_ACTIVE`, `noticeJobs` (toasts) and `renderPills` (the "Mirroring" pill).
  - The Library list (`renderJobs`, `jobItem`, `JOB_TEXT`) shows every job whose `plugin !== 'soulseek'`.
- **Status:** `renderSlskStatus()` sets `#slskHint` from `plugin('soulseek')`, renders `slskPortNote` and calls `renderSlskJobs`.
- **Library:**
  - Grouping: `libraryTiles()` → `mergeAlbums()`. Tiles merge by folded artist + album name. Each row is one track with a `copies` count, and it plays the copy that is saved here, or the larger one.
  - Quality text: `shortQuality(d)` gives "FLAC 16-bit 44.1 kHz". `qualityOf(e, d)` gives the full verdict and is the row tooltip. `commonQuality(t)` is what most tracks are. `trackMeta()` shows only what differs from that.
  - Album text: `albumLine(t)` and `albumQuality(t)` are the shelf card line. `albumHead`, `albumHeadLine` and `albumVerdict` fill the sheet header (`[data-am]`, `[data-av]`), and `paintAlbumSheet` repaints those lines.
- **Helpers:** `h`, `$`, `api`, `act`, `say`, `toast`, `plural`, `size`, `rate`, `duration`, `fold`, `plugin(name)`.
- **Classes:** `.card`, `.field`, `.row`, `.grow`, `.hint`, `.btn(.primary|.quiet)`, `.chips`, `.chip[aria-pressed]` (the Library kind filter), `.tag(.ok|.warn|.bad)`, `.item`, `.list`, `.meta(.wrap)`, `.msg`, `.empty`, `.bar-track(.wait)`, `.poster.thumb` (128×72 desktop, 96×54 at ≤640 px), `.slsk-spin`, `.slsk-state`, `.vh`.

---

## 2. Source selection

### 2.1 Placement

The chip row sits directly under the search input, before the hint. You read it as "search [query] in [sources]". The structure:

- `form#srcForm.card` (was `#slskForm`)
  - `.field`
    - `label[for=srcInput]` "Artist or album"
    - `.row`: `input#srcInput` and `button#srcBtn` "Search"
    - `div.src-in` (hidden when the relay has fewer than two sources)
      - `span.label#srcInLabel` "Search in"
      - `div.chips#srcChips[role=group][aria-labelledby=srcInLabel]`
    - `span.hint#srcHint`
    - `div.meta.wrap#srcNote` (explains a chip that is not ready; empty otherwise)

### 2.2 Chip per source

The sources and their order are a UI constant, `SOURCES = [['soulseek', 'Soulseek'], ['youtube', 'YouTube']]`, with the better-copy source first. A chip is drawn only when `S.plugins` has that name.

| State | When (from `GET /v1/plugins`) | Visible text | Element and ARIA | What a press does |
|---|---|---|---|---|
| On | ready, and not in the remembered off-set | `✓ Soulseek` | `button.chip[aria-pressed=true]`, `aria-label="Search Soulseek"` | Turns it off |
| Off | ready, and in the off-set | `Soulseek` | `aria-pressed=false` | Turns it on |
| Not set up | `configured === false` (Soulseek reports `status: 'not configured'` today) | `Soulseek · Set up` | `button.chip.setup` with no `aria-pressed`, `aria-label="Set up Soulseek in Settings"` | Goes to `#settings` and scrolls to `.card[data-group="Sources"]` |
| Unavailable | `status === 'unavailable'` | `YouTube · Not on this device` | `button.chip[aria-disabled=true]`, `aria-describedby=srcNote` | Nothing, but it stays focusable so its reason in `#srcNote` is read out |
| Degraded, on | `status === 'degraded'` | `✓ ⚠ YouTube · May miss results` | `aria-pressed=true` | Turns it off |
| Degraded, off | degraded and in the off-set | `⚠ YouTube · May miss results` | `aria-pressed=false` | Turns it on |

Statuses that mean ready: Soulseek `connected` or `configured`. `configured` means it is set up and signs in on the first search; the existing `slskMirrorBtn` comment covers that delay. YouTube: `ready`.

The pressed look is the existing `.chip[aria-pressed='true']`: inverted fill and border. It does not rely on colour hue, and the leading ✓ marks "on" even in a monochrome or forced-colours view. The ⚠ glyph and the words mark degraded; the `--warn` colour only adds to them.

`#srcNote` text, one line per chip that is not ready. If the plugin has a `message`, the note shows that message instead of the fallback.

- Soulseek, unavailable: "Soulseek needs a relay with its add-on."
- YouTube, unavailable: "YouTube search needs the relay, not this device."
- YouTube, degraded: "YouTube found nothing lately; its search may be out of date."

### 2.3 Default and memory

- **Default:** every ready or degraded source is on.
- **Memory:** `localStorage['peartube.sourcesOff']` holds a JSON array of the names the user turned off. The UI stores the off-set, not the on-set, for two reasons:
  - A source that becomes usable later (for example Soulseek after setup) arrives on, without a hidden preference to undo.
  - An explicit "no" sticks across reloads.
- **Last query:** kept as today, under the renamed key `peartube.srcQuery`, which replaces `peartube.slskQuery`.

### 2.4 Changing chips after a search

- **Turn a source on while a query is shown:** that source alone is searched for the current query, and its group fills its fixed slot.
- **Turn a source off:** its group is removed at once. If its answer is still streaming in, that answer is ignored when it lands.

Either way the user never has to search again just to add or drop a source.

### 2.5 Hint `#srcHint` (≤ 12 words)

| Sources on | Copy |
|---|---|
| Soulseek and YouTube | Finds albums on peers and tracks on YouTube. |
| Soulseek only | Finds albums on peers and mirrors them here. *(today's copy)* |
| YouTube only | Finds YouTube videos and saves their audio here. |
| None on | Pick a source to search. |
| None usable | No search source works on this device. |

---

## 3. Results when answers arrive at different times

### 3.1 Flow

1. **Submit** (Enter or **Search**):
   - Abort the previous search (`AbortController`).
   - Draw a pending header for every source that is on.
   - Say in `#srcMsg[role=status]`: "Searching Soulseek and YouTube for “mezmerize”."
2. **Request** `POST /v1/search/sources {query, sources: on, stream: true}` through `fetch` with the token header. `api()` cannot stream, so its header and 401 handling move into a shared `authHeaders()`.
3. **Each `event: source`** fills that source's group and adds one line to `#srcMsg`, for example "YouTube: 11 videos." or "Soulseek: 12 albums from 9 peers."
4. **`event: done`** stops the timers. If the reply is `application/json` rather than a stream, the same handler runs once per entry of `bySource`/`errors`.
5. **Search stays enabled** while results arrive. A new submit replaces the old search, so a 25 s wait never locks the box.

Search runs only on submit, never on each keystroke (`youtube-source.md` R4).

Live-region rule:
- `#srcMsg` announces only three kinds of line: the start, each source's arrival, and failures.
- The ticking seconds sit in `aria-hidden` spans in the group headers.
- This fixes a problem in today's submit handler: it rewrites the `role=status` element `#slskMsg` every second, so a screen reader hears "Searching peers… 1 s, 2 s…".

### 3.2 Results summary (jump links)

`nav#srcSummary[aria-label="Results by source"]` is one line under the chips once a search starts. It has one link per group (`a[href="#srcGroup-youtube"]`):

- While waiting: `Soulseek …  ·  YouTube 11 videos`
- When both have answered: `Soulseek 12 albums  ·  YouTube 11 videos`
- For a source that is off: `Soulseek off`

Why: at 390 px, 12 Soulseek folders push YouTube 1,500 px down. One tap jumps past them. Screen-reader users also get a heading per group (h3).

### 3.3 Group header

`section.src-group#srcGroup-<name>[aria-labelledby=srcHead-<name>]` contains:

- `div.src-head`
  - `h3#srcHead-<name>[tabindex=-1]`: the source's display name. For YouTube it adds a ` span.tag` reading "Lossy".
  - `span.count`: the facts, or the pending progress.
  - The group's own tools. Soulseek gets `#slskTools` with `#slskSort` and its existing hint. YouTube has none.
- `div.src-note`: the advice line or the state line.
- `div.list`: `#slskResults` or `#ytResults`.

### 3.4 Group states and exact copy

The waiting state is a progress line, not skeleton rows. The number of results is unknown and may be zero. Skeleton rows would promise rows that may never come, and two 64 px skeletons would push the fast YouTube answer off a phone screen.

| State | Soulseek | YouTube |
|---|---|---|
| Pending | `◌ Searching peers… 7 s` (spinner `.slsk-spin`). Under it in `.meta`: "Replies trickle in for about 25 s." | `◌ Searching YouTube… 2 s` |
| Results | Count: "12 albums · 9 peers · 21 s" | Count: "11 videos · 3 s" |
| Results, truncated | Adds `.meta`: "Showing the first 200 files. Add a word to narrow it." | Adds `.meta`: "Showing the first 20 videos. Add a word to narrow it." |
| Empty | "No matching albums found in 21 s." and `.meta` "Try fewer words, such as the album name." | "No videos found for “mezmerize”." When the source is degraded, add: "YouTube search may be out of date." |
| Error 504 | "Soulseek did not answer in 20 s." plus `button.btn.quiet` **Try again** | "YouTube did not answer in 20 s." plus **Try again** |
| Error 400 not configured | "Soulseek is not set up." plus `button.btn` **Open Settings** | n/a |
| Error, any other | "Soulseek search failed: ‹message›" plus **Try again** | "YouTube search failed: ‹message›" plus **Try again** |
| Off | Group not drawn. The summary says "Soulseek off". | Same |

Error lines use `div.msg.err[role=alert]` inside the group. **Try again** searches only that source with the current query (§2.4 path).

If the request itself fails (network, 401, or 400 for an unknown source), `#srcMsg` gets the `api()` error text with class `err`, and the pending groups are removed.

### 3.5 Which way the user is steered

Every YouTube group carries one `div.src-note#ytNote`. Its copy depends on the Soulseek group's state at that moment, and it is rewritten when Soulseek lands. Every line is 12 words or fewer.

| Soulseek state | `#ytNote` copy | Extra |
|---|---|---|
| Pending | Peers are still answering; better copies may appear above. | — |
| Has a lossless-container folder (`.flac`, `.wav`, `.alac`, `.aiff`) | Peers have FLAC copies above. These are lossy AAC 128 kbps. | `button.btn.quiet` **Show peer copies**: focuses `#srcHead-soulseek`. "FLAC" is the most common such extension, in upper case. |
| Has only lossy folders | Peers have copies above. Compare before saving. | **Show peer copies** |
| Empty | Only YouTube has this. Copies are lossy AAC 128 kbps. | — |
| Error | Peers could not be searched. YouTube copies are lossy AAC 128 kbps. | — |
| Off or not set up | Peers not searched. YouTube copies are lossy AAC 128 kbps. | When not set up: **Set up Soulseek** |

YouTube rows are never hidden, dimmed or put behind a toggle. The note, the fixed order and the label on every row do the steering.

---

## 4. Rows

### 4.1 Telling the source at a glance

Every row carries its source in four ways, none of which is colour:

1. **The group heading** above the rows.
2. **A leading text tag**, `span.tag.src-tag`, reading "Soulseek" or "YouTube".
3. **A left visual of a different shape:**
   - Soulseek: a 40×40 folder glyph tile, `.src-glyph`.
   - YouTube: a 16:9 thumbnail with a duration badge.
4. **A different meta pattern** (below).

The display names are always "Soulseek" and "YouTube" with capitals. The lowercase ids `soulseek` and `youtube` never appear on screen, which the e2e `PLUGIN_IDS` gate enforces.

### 4.2 Soulseek folder row (extends `renderSourceResults`, renamed `renderSlskResults`)

```
[▤] Mezmerize (2005) [FLAC]                                   [Browse] [Mirror]
    Soulseek · FLAC 16-bit/44.1 kHz · 11 tracks · 312 MB
    Ready now · no queue · from peer_name
```

- **Name:** `g.title`, as today.
- **Meta line 1:**
  - `Soulseek · ‹FORMAT› ‹slskQuality(g)› · ‹n› matching tracks · ‹size›`
  - FORMAT is the most common file extension in upper case. That is new: `slskFormat(g)`.
  - A folder whose `lossy === true` rows are the majority adds ` · lossy`.
- **Meta line 2, peer readiness, in words:**
  - `Ready now` when `slots && !queue`
  - `Slots open · queue 12`
  - `Slots full · queue 12`
  - followed by ` · from ‹username›`
- **Buttons:** unchanged: **Browse**, and **Mirror** / **Mirror track** via `slskMirrorBtn`.

Why two lines: today's single line puts "Slots open · No queue · 16-bit/44.1 kHz · 312 MB · 11 matching tracks · user" on one ellipsis-clipped line, and at 390 px the quality is cut off. The first line now carries what the copy is, the second whether it will come.

### 4.3 YouTube video row (new `ytRow(r)`)

```
[☐] ┌────────┐ System Of A Down - Radio/Video (Official Audio)            [Save track]
    │ thumb  │ YouTube · AAC 128 kbps · lossy
    └───4:11─┘ SystemOfADownVEVO
```

- **Selection:** `label.yt-pick-row` wraps the `input[type=checkbox]`, the thumbnail and the text, so the whole row is the tap target.
  - The checkbox's accessible name comes from `aria-label="Select “‹title›”"`.
  - When selected, a `span.tag` "Track ‹n›" shows the order the selection gives it.
- **Thumbnail:** `div.poster.thumb.yt-thumb` (128×72, or 96×54 at ≤ 640 px) with `span.yt-dur` (duration, bottom right, `--on-media` text on `rgba(0,0,0,.72)`). It has `aria-hidden=true`; the duration is also in the text for screen readers.
- **Name:** `r.title`, clamped to two lines (`.item .name`).
- **Meta line 1:** fixed: `YouTube · AAC 128 kbps · lossy`. It comes from the constant `YT_LABEL + ' · lossy'`, not from the row's fields: the label is a promise about what the save produces.
- **Meta line 2:** `duration(r.length)`, then ` · ‹channel›` when `channel` is not null.
- **Full-album video:** when `length >= 1200` or the title matches `/full album/i`, add `span.tag` "Full album video". The button then reads **Save as one track**.
- **Button:** `button.btn` **Save track**, `aria-label="Save “‹title›” as a track"`. After a save the button follows the job, as `slskSyncButton` does: Waiting → Track 3 of 11 → Adding → Saved. A failed or cancelled save gives the button back.
- **Never shown:** the video URL, `videoId`, or the `thumbnail` URL. There are no outbound links. A link to youtube.com is the one thing on this page that would leave the relay.

### 4.4 Thumbnails under `COEP: credentialless` and at 390 px

- **Source:** `ytThumb(videoId)` fetches `GET /v1/providers/youtube/thumb/<videoId>` with `authHeaders()`, makes an object URL and inserts `img.sleeve-img`-style cover art (`alt=""`, `object-fit: cover`).
  - The UI never uses `r.thumbnail`.
  - The relay maps the id to `https://i.ytimg.com/vi/<id>/mqdefault.jpg` (320×180, enough at 2× for 128×72). It checks the id against `^[A-Za-z0-9_-]{11}$`, so nothing else can be fetched, and caches the image in memory.
  - The route is owner-only: add its path to `ownerPath`, so the relay is not an open image proxy. It answers **204** when it has no image. A 4xx or 5xx would show up as a red network line in DevTools and fail the e2e console gate.
- **Loading:**
  - Lazy, through one `IntersectionObserver` with `rootMargin: '300px'`, at most 4 fetches in flight.
  - Object URLs are cached per `videoId` in `ytThumbs: Map`, so a redraw does not fetch again.
  - URLs are revoked when a new search replaces the results, except for selected rows, whose thumbnails the dialog reuses.
- **Placeholder** (no image yet, or none): a `--raised` box with a centred 20 px play glyph in `--dim` and the duration badge. It reads the same in light and dark.
- **At 390 px:** the thumbnail is 96×54, beside the text. The checkbox is 20 px inside a 44 px-tall hit area. The buttons wrap to a full-width `.acts` row under the text (existing `.item:not(.job) .acts { width: 100% }`).

### 4.5 Selection bar

- `div.yt-pick#ytPick[role=region][aria-label="Selected videos"]` is sticky at the bottom of the YouTube group: `position: sticky; bottom: 12px`, and `bottom: calc(var(--np-h) + 12px)` under `body.np-on`. It is hidden while nothing is selected.
- **Text** `#ytPickText`: "1 selected" or "3 selected". When some picks came from an earlier query: "3 selected · 1 from an earlier search".
- **Buttons:**
  - `#ytPickSave` (primary): **Save track** for 1, **Save 3 as album** for more.
  - `#ytPickClear` (quiet): **Clear**.
- **Persistence:** the selection is a `Map` keyed by `videoId`. It survives new searches, so an album can be gathered from several searches ("Soldier Side", then "B.Y.O.B."). It is cleared after a save, or by **Clear**.
- **Announcement:** a change of count is announced through `#srcMsg` as "3 videos selected."

---

## 5. YouTube save flow

### 5.1 Entry points

- **Save track** on a row opens the dialog with that one video.
- **Save N as album** in the selection bar opens it with the selection, in selection order.

### 5.2 Dialog `dialog#ytSave[aria-labelledby=ytSaveTitle]`

It is a separate dialog, not `#detail`. `renderMusic` redraws `#detail` whenever it is open (`if ($('detail').open) renderDetail()`), and that redraw would wipe a half-filled form. The CSS shares `#detail`'s rules: `#detail, #ytSave { … }`.

```
┌ Save from YouTube ───────────────────────────────────────── [Close] ┐
│ 3 tracks · lossy AAC 128 kbps                                       │
│ ▌Peers offered FLAC for this search.                                │  ← #ytSaveNote (only when true)
│                                                                     │
│ Artist                                                              │
│ [ System of a Down                                             ]    │
│ Album                                                               │
│ [ Mezmerize                                                    ]    │
│ Year (optional)                                                     │
│ [ 2005 ]                                                            │
│ Suggested from the video titles. Check them.                        │  ← .hint, shown only if anything was prefilled
│                                                                     │
│ Tracks                                                              │
│  1 ▕th▏ [ Soldier Side - Intro            ]  1:03  [↑][↓][✕]      │
│  2 ▕th▏ [ B.Y.O.B.                        ]  4:15  [↑][↓][✕]      │
│  3 ▕th▏ [ Revenga                         ]  3:48  [↑][↓][✕]      │
│ Numbered in this order on disc 1.                                   │
│                                                                     │
│ [msg: errors, role=alert]                                           │
│ [ Save 3 tracks ]  [ Cancel ]                                       │
└─────────────────────────────────────────────────────────────────────┘
```

Fields. Each has a visible label and a placeholder example, as the e2e gate requires.

| Id | Label | Type | Placeholder | Rules |
|---|---|---|---|---|
| `ytArtist` | Artist | text, `required`, `autocomplete=off` | System of a Down | Trimmed, not empty |
| `ytAlbum` | Album | text, `required` | Mezmerize | Trimmed, not empty |
| `ytYear` | Year (optional) | text, `inputmode=numeric`, `maxlength=4` | 2005 | Empty, or `/^\\d{4}$/` (write `\\d` in `ui.js`) |
| `ytTrack-<i>` | `aria-label="Title of track ‹n›"` | text, `required` | The video's own title | Trimmed, not empty |

- Tracks are an `ol#ytTracks` inside `fieldset > legend` "Tracks". Each `li` has its number, a 48×27 thumbnail (reused from `ytThumbs`), the title input, the duration, and three icon buttons:
  - **Move up**, `aria-label="Move ‹title› up"`, disabled on the first row.
  - **Move down**, disabled on the last row.
  - **Remove**, `aria-label="Remove ‹title›"`, disabled when only one track is left.
  - The buttons are 32 px on a fine pointer and 44 px on `(pointer: coarse)`.
  - There is no drag-only reordering.
- After a move, focus stays on the same button of the moved row, and `#ytSaveMsg` (polite) says "B.Y.O.B. is now track 1."
- Track numbers are the list position (1…n). `disc` is always 1. The contract allows more discs; v1 has no disc control because the source has no disc concept.
- The dialog has a summary line under its title, `div.meta#ytSaveSub`: "3 tracks · lossy AAC 128 kbps" (one track: "1 track · lossy AAC 128 kbps").
- `#ytSaveNote` is a `.slsk-port.alert`-style note with `role=note`. It holds at most one line each, in this order:
  1. The library already has this album (`libraryHas(artist, album)` by `fold()`, the `mergeAlbums` key), re-checked 300 ms after the last edit to either field: "Your library has this album: FLAC 16-bit 44.1 kHz." (the tile's `commonQuality`).
  2. The current search's Soulseek group has a lossless-container folder: "Peers offered FLAC for this search."
  3. Any selected video is a full-album video: "One long video saves as one track."
- Buttons: **Save track** or **Save ‹n› tracks** (`#ytSaveBtn`, primary, `type=submit`), and **Cancel** (`#ytSaveCancel`). The **Close** button at the top uses the `#detail .bar` pattern.

### 5.3 Prefilled suggestions (`ytSuggest(rows)`)

All are suggestions in editable fields. If any field was prefilled, the hint "Suggested from the video titles. Check them." shows. The rules run in this order:

1. **Artist from a shared title prefix.** Split each title at the first ` - `, ` – ` or ` — `. If at least half of the videos share the same left part (compared with `fold`), that part is the Artist and each right part is a track title.
2. **Else the channel name**, with ` - Topic` and a trailing `VEVO` or ` Official` removed, when `channel` is not null.
3. **Else nothing** (the placeholder shows).
4. **Cleaning track titles:** remove noise in brackets: `(Official Video)`, `(Official Audio)`, `(Official Music Video)`, `(Lyric Video)`, `(Lyrics)`, `(Visualizer)`, `[HD]`, `[HQ]`, `[4K]`. This also keeps uploader claims like "HQ" out of the library's track names.
5. **Album from a full-album title:** a single selected video titled `Artist - Album (Full Album)` gives Album = "Album", and a four-digit year in the title gives Year.
6. **Album for one track:** the cleaned song title, with the hint "A single usually uses the song name as album." in place of the general hint.
7. **Album and year otherwise:** empty. The album name is never guessed from a song title for a multi-track save.

### 5.4 Submit and confirmation

1. **Client checks** (first failure only, in `#ytSaveMsg[role=alert]`, with focus moved to the field):
   - "Add the artist, e.g. System of a Down."
   - "Add the album name, e.g. Mezmerize."
   - "Year is four digits, e.g. 2005."
   - "Every track needs a title."
2. **Request:** `POST /v1/providers/youtube/mirror {artist, album, year?, tracks: [{videoId, title, track, disc: 1}]}` through `act(#ytSaveBtn, …, 'ytSaveMsg')`. While it runs the button reads "Saving…".
3. **Success:**
   - Close the dialog.
   - Remove the saved videos from the selection.
   - Map each `videoId` to `job.jobId` in `ytStarted` (the same idea as `slskStarted`).
   - Add the job to `S.jobs`, then call `renderMirrors()` and `pollMirrors()`.
   - Toast: `Saving “Mezmerize” from YouTube`.
   - Focus the new job card's name (`[data-job="<id>"] .name[tabindex=-1]`).
4. **Server error:** the dialog stays open and the relay's message is shown verbatim in `#ytSaveMsg`.
5. **Esc / Cancel / Close:** the dialog closes and focus returns to the control that opened it (the row's **Save track** or `#ytPickSave`).

---

## 6. Jobs

### 6.1 Where they show

- `#slskJobs` becomes `div.list.src-jobs#srcJobs[aria-label="Adding"]`, in the same place: under the form fields, above the results. It lists jobs whose `plugin` is in `SOURCES`, active first, then newest, at most 5 (today's `renderSlskJobs` rule).
- `renderJobs` (Library "Adding") filters out every `SOURCES` plugin, not just `'soulseek'`. That fixes the raw `transferring` word described in D6.
- Pill (`renderPills`):
  - Text: "Adding" for one job, "Adding 2 albums" for more, counted over every `SOURCES` job.
  - A percentage is added only when every active job has `total > 0`, which is today's rule. Any YouTube job therefore removes it.
  - Pressing it scrolls to `#srcJobs`.
- `noticeJobs` toasts for both plugins:
  - Done: `Added “System of a Down · Mezmerize” to your library` (today's wording).
  - Failed, Soulseek: `Could not mirror “…”: ‹error›`.
  - Failed, YouTube: `Could not save “…” from YouTube: ‹error›`.

### 6.2 YouTube job card (`srcJobItem` → `ytJobState`)

```
System of a Down · Mezmerize                                   [Cancel]
Downloading track 3 of 11 from YouTube
03 - Revenga.m4a
14.2 MB so far · 1.1 MB/s
▰▰▱▱▱▱▱▱▱▱▱      ← 11 steps: 2 done, 1 in progress (shimmer), 8 to go
```

| `status` / `phase` | State line (`.slsk-state`) | Button text (short) | Tone |
|---|---|---|---|
| queued | Waiting to start | Waiting | — |
| transferring, `fileCount > 1` | Downloading track ‹i› of ‹n› from YouTube | Track ‹i› of ‹n› | — |
| transferring, one file | Downloading from YouTube | Saving | — |
| announcing, `phase: waiting` (another import holds the folder; nothing placed; Cancel works; indeterminate bar, valuetext "Waiting") | Waiting for another import to finish | Waiting | — |
| announcing, `phase: importing` (no Cancel button: nothing is left to cancel) | Adding to your library | Adding | — |
| done | Saved · ‹n› tracks · ‹size› · YouTube · AAC 128 kbps | Saved | ok |
| done with skipped tracks (needs a contract field, §10) | Saved ‹k› of ‹n› tracks | Saved ‹k› of ‹n› | warn |
| failed | Failed | Failed | bad |
| cancelled | Cancelled | (button given back) | — |

- **Track line** (`.meta`, while active): `j.file`.
- **Amount line** (`.meta.slsk-amount`): `‹size(bytes)› so far · ‹rate(speed)›`, plus ` · no data for 40 s` when `idleMs > 15000`.
  - It never says "of ‹total›" and never shows a percentage: `total` is null.
- **Progress without a total:**
  - **Several tracks:** `div.bar-steps[role=progressbar][aria-valuemin=0][aria-valuemax=n][aria-valuenow=i-1][aria-valuetext="2 of 11 tracks saved"]`.
    - One segment per track: done = `--brand`, current = `--brand-soft` with a moving sheen, to go = `--raised`.
    - Above 30 tracks it falls back to one `.bar-track` whose width is `(i-1)/n`. That width is still a count of tracks, not of bytes, and no number is printed.
  - **One track:** `div.bar-track.indef[role=progressbar][aria-valuetext="Downloading"]` (no `aria-valuenow`), with a sliding 30% bar.
  - Under `prefers-reduced-motion`, the sheen and the slide stop and show a static `--dim` fill.
- **Failure explanation:** `j.error` is shown verbatim (`.meta.err.wrap`). If it matches a known pattern, one plain line in `.meta.wrap` goes under it:

  | Error matches | Extra line |
  |---|---|
  | `/not a bot/i` | YouTube is refusing this relay for now. Try later. |
  | `/country\|not available in your/i` | Not available where this relay is. |
  | `/age\|sign in to confirm your age/i` | Needs a signed-in account; this relay has none. |
  | `/private\|members/i` | Private or members-only video. |

- **Buttons:** **Open album** once done (it finds the tile by the job's album id; see §10), **Cancel** while active, **Dismiss** after. These are today's `slskJobItem` buttons.

---

## 7. Library labelling

Constants: `YT_LABEL = 'YouTube · AAC 128 kbps'` and `isYt = e => e.id.startsWith('yt:')`. No surface ever says "lossless", "HQ" or "high quality" for a `yt:` copy.

### 7.1 One function for "what is this copy"

`copyQuality(e, d) = isYt(e) ? YT_LABEL : shortQuality(d)`.

- `commonQuality(t)` and `trackMeta()` call it in place of `shortQuality`.
- The YouTube label is known from the id, without reading the header, so the shelf never shows an empty line for a YouTube album.
- `qualityOf(e, d)` (the row tooltip, counted as a hint, ≤ 12 words): for `yt:` it returns "YouTube · AAC 128 kbps · lossy copy". Without this, the existing code would print "AAC · 44.1 kHz · 132 kbps", which is accurate but does not say where the copy came from.

### 7.2 Album that is only from YouTube

- **Shelf card** (`albumLine`): `YouTube · AAC 128 kbps` (plus the state when the album is not all saved here, as today).
- **Sheet header:**
  - `[data-am]` (`albumHeadLine`): "11 tracks · 41 min · 52 MB".
  - `[data-av]` (`albumVerdict`): **From YouTube · AAC 128 kbps**.
- **Track rows:** following the existing "say only what differs" rule, a clean YouTube album has one-line rows. The header carries the label, and each row's tooltip says it too.

### 7.3 Merged album: a YouTube copy and a FLAC copy

`mergeAlbums` already folds a `yt:` album and an `mb:`/`album:` album with the same artist and name into one tile. Each row plays the copy that is saved here, or the larger one, so FLAC wins when both are saved. Two small extensions:

- `mergeAlbums` keeps the other copies: `items.push({ ...i, copies: 1, alts: [] })`, and `prev.alts.push(i.e)` where it now increments `copies`.
- Its result gains `ytParts` (the number of folded parts whose items are all `yt:`). `releases` counts only the other parts, so "from 2 releases" is not printed just because a YouTube copy exists.

New line `[data-ay]` in the sheet header (`albumAlso(t)`), drawn only when the tile mixes `yt:` and other copies:

| Case | `[data-av]` | `[data-ay]` |
|---|---|---|
| FLAC plays on every row; a YouTube copy also exists | FLAC 16-bit 44.1 kHz · lossless container · 1,020 kbps file (today) | Also from YouTube · AAC 128 kbps. FLAC plays first. |
| YouTube plays (saved here); the FLAC copy is only on the network | From YouTube · AAC 128 kbps | A FLAC copy is on the network. |
| Mixed: some tracks exist only as YouTube | (common, e.g. FLAC …) | 3 tracks only from YouTube · AAC 128 kbps. |

Track rows (`trackMeta`):

| Row | Second line |
|---|---|
| Plays FLAC, `alts` includes a `yt:` copy | Also from YouTube *(replaces "2 copies")* |
| Plays the `yt:` copy while the album's common quality is FLAC | YouTube · AAC 128 kbps |
| Plays FLAC, another FLAC copy | 2 copies *(today)* |

Shelf card of a merged album: `‹common quality› · also YouTube`, for example "FLAC 16-bit 44.1 kHz · also YouTube".

Why the label is drawn from the id and not from the file header: the header says "AAC", which is true of any AAC file. "YouTube" is the provenance the owner needs in order to judge the copy, and `yt:` is where that fact lives (`youtube-source.md` §3).

---

## 8. Keyboard, screen reader, touch, widths, themes

### 8.1 Focus order (Music tab, Find music card)

`#srcInput` → `#srcBtn` → chips in source order → `#srcSummary` links → (Adding jobs: each card's buttons) → Soulseek group: `#slskSort`, then each row's **Browse**, **Mirror** → YouTube group: **Show peer copies** (when shown), then for each row the checkbox and **Save track** → `#ytPickSave`, `#ytPickClear` → `#slskBrowse`.

Tab order follows the visual order. The sticky selection bar sits after the YouTube rows in the DOM, so Tab reaches it after the last row. Its sticky position is visual only.

### 8.2 Keys

- **Enter** in `#srcInput` searches.
- **Space or Enter** on a chip toggles it.
  - This needs one guard. Today's global music `keydown` handler (the one that skips `INPUT|SELECT|TEXTAREA`) takes Space on any focused button while a queue exists and toggles playback instead.
  - Add `BUTTON` and `A` to its skip list. A focused Play button keeps working, because its native click does the same thing.
- **Esc** closes `#ytSave` (native `dialog`). Focus returns to the opener.
- **In the dialog:** Tab goes Artist → Album → Year → for each track: title, ↑, ↓, ✕ → Save → Cancel → Close. **Enter** in any text field submits.

### 8.3 Screen reader

- `#srcMsg` (polite) announces: search start, each source's arrival with its count, a source's failure, and selection count changes. It never announces ticking seconds.
- Group headings are `h3`, so heading navigation moves between sources. **Show peer copies** and the summary links move focus to the `h3[tabindex=-1]`.
- Each row's buttons name their row: "Save “B.Y.O.B.” as a track", plus today's Mirror and Browse labels.
- Each chip's state is in `aria-pressed`, or `aria-disabled` with `aria-describedby=srcNote`.
- Progress bars are `role=progressbar` with `aria-valuetext` (§6.2).
- The "Lossy" tag and the label are real text, not icons.

### 8.4 Touch targets

- `@media (pointer: coarse)`: `.chip` min-height 40 px. The dialog's ↑ ↓ ✕ buttons are 44×44. The YouTube row's `label` hit area is the whole row, at least 72 px high. Buttons stay `.btn` at 38 px, as on the rest of the page.
- At ≤ 640 px, `#ytPick` spans the card width and its buttons share the row equally (`flex: 1`).

### 8.5 Widths (1440 and 390) and themes

- **No sideways scroll:**
  - Titles use `overflow-wrap: anywhere` (`.item .name` already does).
  - Meta lines in the new rows use `.meta.wrap`, so they wrap rather than clip at 390.
  - The thumbnail is a fixed `flex: none` width.
  - Chips wrap (`.chips` is `flex-wrap: wrap`).
  - `#srcSummary` wraps at `·`.
  - The dialog is `width: min(760px, calc(100% - 24px))`, from `#detail`.
- **Themes:** every new colour is a token: `--raised`, `--line`, `--dim`, `--brand`, `--brand-soft`, `--warn`. The only fixed colour is the duration badge's dark scrim, which always sits on an image or placeholder and uses `--on-media` text.
- **Light theme check:** the "Lossy" tag is `.tag`, neutral, not `.tag.warn`. Lossy is a fact, not a problem.

---

## 9. Layout sketches

### 9.1 Desktop, 1440 px (main column), YouTube arrived, Soulseek pending

```
Music  12
[ shelf of albums … ]

Find music
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Artist or album                                                                          │
│ [ system of a down mezmerize                                               ] [ Search ]  │
│ Search in   ( ✓ Soulseek )  ( ✓ YouTube )                                               │
│ Finds albums on peers and tracks on YouTube.                                             │
│                                                                                          │
│ Soulseek …  ·  YouTube 11 videos                                   ← #srcSummary links   │
│                                                                                          │
│ Soulseek                                              ◌ Searching peers… 7 s             │
│ Replies trickle in for about 25 s.                                                       │
│                                                                                          │
│ YouTube [Lossy]                                                     11 videos · 3 s      │
│ Peers are still answering; better copies may appear above.                               │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ☐ ┌──────────┐ System Of A Down - Radio/Video (Official Audio)         [Save track] │ │
│ │   │  thumb   │ [YouTube] AAC 128 kbps · lossy                                        │ │
│ │   └─────4:11─┘ 4:11 · SystemOfADownVEVO                                             │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ☑ ┌──────────┐ System of a Down - B.Y.O.B. [Track 1]                   [Save track] │ │
│ │   │  thumb   │ [YouTube] AAC 128 kbps · lossy                                        │ │
│ │   └─────4:15─┘ 4:15                                                                 │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│   …                                                                                      │
│ ┌ 1 selected ──────────────────────────────────────── [ Save track ]  [ Clear ] ┐ sticky │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Desktop, both answered, a job running

```
│ Adding                                                                                   │
│ ┌──────────────────────────────────────────────────────────────────────────── [Cancel] ┐ │
│ │ System of a Down · Mezmerize                                                         │ │
│ │ Downloading track 3 of 11 from YouTube                                               │ │
│ │ 03 - Revenga.m4a                                                                     │ │
│ │ 14.2 MB so far · 1.1 MB/s                                                            │ │
│ │ ▰▰▰▰▰▰▰ ▰▰▰▰▰▰▰ ▒▒▒▒▒▒▒ ▱▱▱▱▱▱▱ ▱▱▱▱▱▱▱ ▱▱▱▱▱▱▱ ▱▱▱▱▱▱▱ ▱▱▱▱▱▱▱ …                   │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│ Soulseek 12 albums  ·  YouTube 11 videos                                                 │
│                                                                                          │
│ Soulseek                                             12 albums · 9 peers · 21 s          │
│ [ Ready to send first ▾ ]  A queue means the peer sends to others first.                 │
│ ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [▤] Mezmerize (2005) [FLAC]                                      [Browse] [Mirror]   │ │
│ │     [Soulseek] FLAC 16-bit/44.1 kHz · 11 matching tracks · 312 MB                    │ │
│ │     Ready now · no queue · from peer_name                                            │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│   …                                                                                      │
│ YouTube [Lossy]                                                     11 videos · 3 s      │
│ Peers have FLAC copies above. These are lossy AAC 128 kbps.  [Show peer copies]          │
│   …                                                                                      │
```

### 9.3 Phone, 390 px

```
┌ 390 ────────────────────────────────┐
│ Find music                          │
│ ┌─────────────────────────────────┐ │
│ │ Artist or album                 │ │
│ │ [ mezmerize          ][Search]  │ │
│ │ Search in                       │ │
│ │ (✓ Soulseek) (✓ YouTube)        │ │
│ │ Finds albums on peers and       │ │
│ │ tracks on YouTube.              │ │
│ │ Soulseek … · YouTube 11 videos  │ │
│ │                                 │ │
│ │ Soulseek  ◌ Searching peers… 7 s│ │
│ │ Replies trickle in for about    │ │
│ │ 25 s.                           │ │
│ │                                 │ │
│ │ YouTube [Lossy]  11 videos · 3 s│ │
│ │ Peers are still answering;      │ │
│ │ better copies may appear above. │ │
│ │ ┌─────────────────────────────┐ │ │
│ │ │☐┌───────┐ System Of A Down -│ │ │
│ │ │ │ thumb │ Radio/Video (Offi…│ │ │
│ │ │ └──4:11─┘ [YouTube] AAC 128 │ │ │
│ │ │ kbps · lossy · 4:11         │ │ │
│ │ │ [ Save track ]              │ │ │
│ │ └─────────────────────────────┘ │ │
│ │  …                              │ │
│ │ ┌ 2 selected ─────────────────┐ │ │
│ │ │[Save 2 as album] [ Clear  ] │ │ │  sticky, above the music bar
│ │ └─────────────────────────────┘ │ │
│ └─────────────────────────────────┘ │
│ ▔▔▔▔▔▔ music bar (when playing) ▔▔▔ │
└─────────────────────────────────────┘
```

### 9.4 Save dialog at 390 px

```
┌ 366 ──────────────────────────────┐
│                          [Close]  │
│ Save from YouTube                 │
│ 2 tracks · lossy AAC 128 kbps     │
│ ▌Peers offered FLAC for this      │
│ ▌search.                          │
│ Artist                            │
│ [ System of a Down             ]  │
│ Album                             │
│ [ Mezmerize                    ]  │
│ Year (optional)                   │
│ [ 2005 ]                          │
│ Suggested from the video titles.  │
│ Check them.                       │
│ Tracks                            │
│ 1 [ B.Y.O.B.                   ]  │
│   4:15        [↑] [↓] [✕]         │  44 px targets
│ 2 [ Revenga                    ]  │
│   3:48        [↑] [↓] [✕]         │
│ Numbered in this order on disc 1. │
│ [  Save 2 tracks  ] [ Cancel ]    │
└───────────────────────────────────┘
```

### 9.5 Album sheet, merged copy

```
┌ ███████ ┐  Mezmerize
│ sleeve  │  System of a Down
│  168px  │  11 tracks · 36 min · 391 MB
└─────────┘  FLAC 16-bit 44.1 kHz · lossless container · 1,020 kbps file
             Also from YouTube · AAC 128 kbps. FLAC plays first.
             [▶ Play] [Shuffle] [Delete]
 1  Soldier Side - Intro                          1:03
    Also from YouTube
 2  B.Y.O.B.                                      4:15
    Also from YouTube
12  Soldier Side (Live)                           4:01      ← only in the YouTube copy
    YouTube · AAC 128 kbps
```

---

## 10. Copy deck

### 10.1 Form and chips

| Where | Copy |
|---|---|
| `h2` (was "Find albums") | Find music |
| `label[for=srcInput]` | Artist or album |
| `#srcInput` placeholder | John Coltrane Blue Train |
| `#srcBtn` | Search |
| Chip group label | Search in |
| Chip, on | ✓ Soulseek / ✓ YouTube |
| Chip, not set up | Soulseek · Set up |
| Chip, unavailable | YouTube · Not on this device |
| Chip, degraded | ⚠ YouTube · May miss results |
| Hints | see §2.5 |
| `#srcNote` | see §2.2 |
| Search start (status) | Searching Soulseek and YouTube for “‹query›”. / Searching YouTube for “‹query›”. |
| Source arrival (status) | Soulseek: 12 albums from 9 peers. / YouTube: 11 videos. / YouTube found nothing. / YouTube search failed. |
| No source on, at submit | Pick a source to search. (in `#srcMsg`, `err`) |
| Summary links | Soulseek 12 albums · YouTube 11 videos / Soulseek … / Soulseek off |

### 10.2 Groups

Group states: §3.4. Advice: §3.5.

### 10.3 Rows

| Row part | Copy |
|---|---|
| Soulseek meta 1 | Soulseek · FLAC 16-bit/44.1 kHz · 11 matching tracks · 312 MB |
| Soulseek meta 2 | Ready now · no queue · from ‹user› / Slots open · queue 12 · from ‹user› / Slots full · queue 12 · from ‹user› |
| YouTube meta 1 | YouTube · AAC 128 kbps · lossy |
| YouTube meta 2 | 4:11 · ‹channel› |
| YouTube tags | Lossy (group header) · Full album video · Track 2 |
| YouTube buttons | Save track · Save as one track |
| Selection bar | 3 selected · 3 selected · 1 from an earlier search · Save 3 as album · Save track · Clear |

### 10.4 Dialog

| Part | Copy |
|---|---|
| Title | Save from YouTube |
| Subline | 3 tracks · lossy AAC 128 kbps |
| Labels and placeholders | Artist / System of a Down · Album / Mezmerize · Year (optional) / 2005 · Tracks |
| Hints | Suggested from the video titles. Check them. · A single usually uses the song name as album. · Numbered in this order on disc 1. |
| Notes | Your library has this album: ‹quality›. · Peers offered FLAC for this search. · One long video saves as one track. |
| Errors | Add the artist, e.g. System of a Down. · Add the album name, e.g. Mezmerize. · Year is four digits, e.g. 2005. · Every track needs a title. · ‹relay message verbatim› |
| Move announcement | ‹title› is now track ‹n›. |
| Buttons | Save track · Save 3 tracks · Saving… · Cancel · Close · Move ‹title› up · Move ‹title› down · Remove ‹title› |

### 10.5 Jobs, toasts and pill

| Part | Copy |
|---|---|
| Job card | §6.2 |
| Toast, start | Saving “‹album›” from YouTube |
| Toast, done | Added “‹artist› · ‹album›” to your library |
| Toast, failed | Could not save “‹title›” from YouTube: ‹error› |
| Pill | Adding · Adding 2 albums · Adding 2 albums 34% (only when every total is known) |

### 10.6 Library

| Part | Copy |
|---|---|
| Labels | §7 |
| Shelf line | YouTube · AAC 128 kbps · FLAC 16-bit 44.1 kHz · also YouTube |
| Sheet header | From YouTube · AAC 128 kbps · Also from YouTube · AAC 128 kbps. FLAC plays first. · A FLAC copy is on the network. · 3 tracks only from YouTube · AAC 128 kbps. |
| Track line | YouTube · AAC 128 kbps · Also from YouTube |
| Track tooltip | YouTube · AAC 128 kbps · lossy copy |

---

## 11. Component states

| Component | States |
|---|---|
| Chip row `#srcChips` | hidden (fewer than 2 registered sources) · shown |
| Chip | on · off · not set up · unavailable · degraded-on · degraded-off · focused |
| Search form | idle (last query restored) · searching (Search stays enabled; a new submit replaces the search) · request failed (`#srcMsg.err`) · no source on |
| Summary `#srcSummary` | hidden (no search yet) · partial (`…` for pending) · complete · contains "off" entries |
| Source group | pending · results · results+truncated · empty · empty+degraded (YouTube) · error 504 · error 400 not configured · error other · not drawn (off) |
| YouTube advice `#ytNote` | Soulseek pending · peers have lossless · peers have lossy only · Soulseek empty · Soulseek error · Soulseek off / not set up |
| Soulseek row | ready now · slots open + queue · slots full · lossy · Mirror idle / Starting / Queued at n / % / Saved / Failed (today's `slskMirrorBtn` states) |
| YouTube row | unselected · selected (Track n tag) · full-album variant · thumb loading (placeholder) · thumb shown · thumb none (placeholder) · saving (button synced to job) · saved · save failed (button given back) |
| Selection bar `#ytPick` | hidden · 1 selected · n selected · n selected including earlier searches |
| Save dialog `#ytSave` | open with prefills · open without prefills · library-has-album note · peers-had-lossless note · full-album note · validation error · submitting · server error · closed |
| Dialog track row | first (↑ disabled) · middle · last (↓ disabled) · only (✕ disabled) · just moved (focus kept, announced) |
| Source job card | Soulseek: today's states · YouTube: queued · transferring multi · transferring single · announcing (waiting) · announcing (importing) · done · done with skips · failed (+ explanation) · cancelled |
| Progress bar | steps (n ≤ 30) · fallback single bar (n > 30) · indeterminate (one track) · reduced motion (static) |
| Album shelf card | YouTube only · merged ("also YouTube") · not YouTube (today) |
| Album sheet | YouTube only · merged, FLAC plays · merged, YouTube plays · merged, tracks only from YouTube |

---

## 12. Implementation map

### 12.1 Constants and helpers (new)

| Name | Purpose |
|---|---|
| `SOURCES` | `[['soulseek', 'Soulseek'], ['youtube', 'YouTube']]`: order, display names, membership tests |
| `SOURCE_NAMES` | `new Set(SOURCES.map(s => s[0]))` |
| `YT_LABEL` | `'YouTube · AAC 128 kbps'` |
| `isYt(e)` | `e.id.startsWith('yt:')` |
| `authHeaders(json)` | Factored out of `api()`. `api()` and the streaming search both use it. A 401 runs the same `needsToken` / `#authForm` path. |
| `sourceState(name)` | → `{ state: 'on' \| 'off' \| 'setup' \| 'unavailable', degraded, note }` from `plugin(name)` and the off-set |
| `sourcesOff()` / `setSourceOff(name, off)` | Read and write `localStorage['peartube.sourcesOff']` |
| `readEvents(res, on)` | Minimal SSE reader over `res.body.pipeThrough(new TextDecoderStream())`. Splits on `'\\n\\n'` (escaped as written inside the `ui.js` template literal) and calls `on(event, JSON.parse(data))`. Uses no backticks. |
| `slskFormat(g)` | Most common file extension of a folder, in upper case |
| `copyQuality(e, d)` | §7.1 |
| `libraryHas(artist, album)` | The album tile whose `fold(artist)` and `fold(album)` match, or null |

### 12.2 Functions to extend or rename (clean cutover, no aliases)

| Today | Becomes | Change |
|---|---|---|
| `$('slskForm').onsubmit` | `$('srcForm').onsubmit` → `searchSources(query, names)` | Streaming request, `AbortController`, per-group state `srcRun = { query, started, groups: Map }`, per-group timers |
| `renderSlskStatus()` | `renderSourcesStatus()` | Draws the chips (`renderSourceChips`), `#srcHint`, `#srcNote`, `slskPortNote` (unchanged) and `renderSrcJobs()`. Callers: `renderMusic`, `renderMirrors`. |
| `renderSourceResults()` | `renderSlskResults()` | Body of the Soulseek group only. New two-line meta (§4.2). Reads `srcRun.groups.get('soulseek')` instead of `slskLast`. The `slskMsg` summary moves to the group header count. |
| `slskJobState(j)` | `jobState(j)` | Dispatch: `j.plugin === 'youtube' ? ytJobState(j) : <today's body>` |
| `slskAmount(j)` | unchanged | Already prints "so far" when `total` is null |
| `slskJobItem(j)` | `srcJobItem(j)` | Progress via `jobProgress(j)`. The YouTube failure explanation line. "Open album" for YouTube finds its tile by album id (§13). |
| `renderSlskJobs()` | `renderSrcJobs()` | Filter `SOURCE_NAMES.has(j.plugin)`, box `#srcJobs`. Syncs `button[data-src-key]`. |
| `slskSyncButton(b)` | `srcSyncButton(b)` | Reads `slskStarted` or `ytStarted` according to `b.dataset.srcKey`'s prefix (`s:` / `y:`). Short text from `jobState`. |
| `slskMirrorBtn` | unchanged name | Sets `data-src-key="s:" + g.key` instead of `data-slsk-key` |
| `slskActive(j)` | `srcActive(j)` | `SOURCE_NAMES.has(j.plugin) && MIRROR_ACTIVE.has(j.status)`. Used by `pollMirrors`. |
| `renderPills()` | — | Mirror filter → `srcActive`; text "Adding" (§6.1); click scrolls to `#srcJobs` |
| `noticeJobs()` | — | Both plugins; YouTube wording (§6.1) |
| `renderJobs()` | — | Filter `!SOURCE_NAMES.has(j.plugin)` |
| `qualityOf(e, d)` | — | `yt:` branch (§7.1) |
| `commonQuality(t)`, `trackMeta(...)` | — | Use `copyQuality`. `trackMeta` gains the `alts` rule (§7.3). |
| `albumLine(t)` | — | YouTube-only and "also YouTube" (§7.2, §7.3) |
| `albumVerdict(t)` | — | YouTube-only returns "From " + `YT_LABEL` |
| `albumHead(t)` | — | Adds `div.meta[data-ay]` with `albumAlso(t)`. `paintAlbumSheet` repaints `[data-ay]`. |
| `albumHeadLine(t)` | — | "from N releases" counts only the parts that are not YouTube |
| `mergeAlbums(tiles)` | — | `alts` per item, and `ytParts` (§7.3) |
| global `keydown` (music keys) | — | Skips `BUTTON` and `A` targets (§8.2) |
| `#detail` CSS rules | `#detail, #ytSave` | Shared dialog look |

### 12.3 New functions

`renderSourceChips`, `renderSrcSummary`, `renderSrcGroup(name)` (header, note and body dispatch), `srcGroupHead(name)`, `renderYtNote()`, `renderYtResults()`, `ytRow(r)`, `ytThumb(videoId, box)` with `ytThumbs: Map` and `ytThumbIO`, `renderYtPick()` with `ytPicked: Map`, `openYtSave(rows, opener)`, `ytSuggest(rows)`, `ytCleanTitle(s)`, `renderYtSaveTracks()`, `ytSaveNotes()`, `submitYtSave(ev)`, `ytJobState(j)`, `jobProgress(j)`, `ytFailHint(error)`, `albumAlso(t)`.

### 12.4 Element ids

- **Renamed:** `slskForm`→`srcForm`, `slskInput`→`srcInput`, `slskBtn`→`srcBtn`, `slskHint`→`srcHint`, `slskMsg`→`srcMsg`, `slskJobs`→`srcJobs`.
- **Kept** (they are still Soulseek-only): `slskPort`, `slskTools`, `slskSort`, `slskResults` (now inside `#srcGroup-soulseek`), `slskBrowse` and its children.
- **New:** `srcInLabel`, `srcChips`, `srcNote`, `srcSummary`, `srcGroups` (container), `srcGroup-soulseek`, `srcGroup-youtube`, `srcHead-soulseek`, `srcHead-youtube`, `ytNote`, `ytResults`, `ytPick`, `ytPickText`, `ytPickSave`, `ytPickClear`, `ytSave`, `ytSaveTitle`, `ytSaveSub`, `ytSaveNote`, `ytSaveForm`, `ytArtist`, `ytAlbum`, `ytYear`, `ytSaveHint`, `ytTracks`, `ytTrack-<i>`, `ytSaveMsg`, `ytSaveBtn`, `ytSaveCancel`, `ytSaveClose`.

### 12.5 New CSS classes

All go in the "Soulseek sources" CSS block, renamed "Sources". All colours are tokens.

| Class | Purpose |
|---|---|
| `.src-in` | Label and chips on one row; wraps |
| `.chip .st` | Smaller state words in a chip |
| `.chip.setup` | Dashed border |
| `.chip[aria-disabled=true]` | `opacity: .6` |
| `.src-group` | Margin above |
| `.src-head` | Flex, wrap, baseline; `h3` plus `.count` pushed right |
| `.src-note` | `.meta.wrap` look |
| `.src-tag` | `.tag` variant, no colour change |
| `.src-glyph` | 40×40 `--raised` tile with the folder SVG |
| `.yt-thumb` | Relative-positioned `.poster.thumb` |
| `.yt-dur` | Duration badge |
| `.yt-pick-row` | Label covering the row; 44 px minimum |
| `.yt-pick` | Sticky bar: `--surface`, `--line` border, shadow, `z-index` below `.np` |
| `body.np-on .yt-pick` | `bottom: calc(var(--np-h) + 12px)` |
| `.bar-steps`, `.bar-steps > i(.done\|.now)` | Stepped progress bar |
| `.bar-track.indef` | Indeterminate bar |
| `@media (prefers-reduced-motion: reduce)` | Static fallbacks for both bars |
| `@media (pointer: coarse)` | Chip and icon-button sizes |

### 12.6 Build order

1. **Constants and helpers** (§12.1). Refactor `api()` onto `authHeaders()`.
2. **Markup:** replace the `#slskForm` block with §2.1 plus `#srcSummary`, `#srcJobs`, `#srcMsg` and `#srcGroups`. Move `#slskTools` and `#slskResults` into a `section#srcGroup-soulseek` template built by JS. Add `dialog#ytSave` after `dialog#detail`. Rename `h2` to "Find music".
3. **CSS** (§12.5), and `#detail, #ytSave` sharing.
4. **Chips:** `renderSourceChips`, the off-set memory, `#srcHint` / `#srcNote`. `renderSlskStatus` becomes `renderSourcesStatus`, with every caller migrated.
5. **Streaming search:** `searchSources`, `readEvents`, group pending/result/empty/error/truncated states, summary links, status announcements, re-search of a single source from a chip or **Try again**.
6. **Soulseek group:** `renderSlskResults` with two-line rows and `slskFormat`. The sort select works on the Soulseek group only.
7. **YouTube group:** `ytRow`, the thumbnail pipeline (needs the relay route; until it exists the placeholder is the whole design and nothing breaks), `#ytNote` advice.
8. **Selection and dialog:** `ytPicked`, `#ytPick`, `openYtSave`, `ytSuggest` / `ytCleanTitle`, reorder and remove, notes, validation, `submitYtSave`, `ytStarted`.
9. **Jobs:** `jobState` dispatch, `ytJobState`, `jobProgress`, `srcJobItem`, `renderSrcJobs`, `srcSyncButton`, `srcActive`, `renderPills`, `noticeJobs`, the `renderJobs` filter.
10. **Library:** `copyQuality`, the `qualityOf` branch, `commonQuality`, `trackMeta`, `mergeAlbums` (`alts`, `ytParts`), `albumLine`, `albumVerdict`, `albumHeadLine`, `albumHead` `[data-ay]`, `paintAlbumSheet`.
11. **Global music `keydown` guard** (§8.2).
12. **Template-literal hygiene:** search the new script for backticks (none) and for single-backslash regex escapes (`\d`, `\s`, `\n` must be written `\\d`, `\\s`, `\\n`).
13. **e2e** (§12.7).

### 12.7 Checks `test/ui.e2e.js` should gain

Setup:
- Extend `fakeUbit` so that `info --json 'ytsearch:<q>'` prints a fixed `{ entries: [...] }` with three videos, including one titled "Test Band - Dawn (Official Audio)" and one with `duration: 2200` titled "Test Band - First Light (Full Album)". A query containing `fail` exits 1 with `error: boom`.
- `get` writes a small `.m4a` file. Point `UBIT_BIN` at the stub.
- Add `'youtube'` to `PLUGIN_IDS`.

1. **Chips:**
   - On `#music`, `#srcChips` has a button with text "YouTube" and `aria-pressed="true"`.
   - Soulseek without an account shows "Soulseek · Set up", with no `aria-pressed`.
   - Clicking the YouTube chip, then reloading, leaves `aria-pressed="false"`, and `localStorage['peartube.sourcesOff']` holds `["youtube"]`. Turn it back on.
2. **Streaming arrival:**
   - Type "test band" and press Enter. Within 5 s, `#srcGroup-youtube .yt-pick-row` count is 3.
   - Every YouTube row's text includes "YouTube" and "AAC 128 kbps" and "lossy".
   - The text of `#srcGroups`, with the video titles removed, matches none of `/lossless|\bHQ\b|high quality/i`.
3. **Source without colour:** every row in `#srcGroups .item` has a `.src-tag` whose text is "Soulseek" or "YouTube".
4. **Thumbnails:**
   - CDP `Network.requestWillBeSent` records no URL on `ytimg.com` or `youtube.com` during the whole run.
   - `.yt-thumb` has either an `img` or the placeholder.
   - The browser issues list stays empty.
5. **Error isolation:** search "fail". `#srcGroup-youtube [role=alert]` contains "YouTube search failed", and `#srcMsg` is not an error.
6. **Advice copy:** with Soulseek off or not set up, `#ytNote` reads "Peers not searched. YouTube copies are lossy AAC 128 kbps."
7. **Save as album:**
   - Select two rows. `#ytPickText` = "2 selected". Click `#ytPickSave`. `#ytSave` is open.
   - `#ytArtist` is prefilled "Test Band". `#ytTrack-0` = "Dawn" (cleaned).
   - Type album "Morning", year "2020". Move track 2 up with its ↑ button. The focused element is still that row's ↑ button.
   - Submit. Intercept the request body (CDP `Fetch` or `waitApi` on `/v1/jobs`): `tracks[0].track === 1` and the order matches the dialog.
   - The dialog closes, and the `#srcJobs` card text contains "from YouTube" and no `%` character.
   - Fewer than 4 interactions after the dialog opens (`result.interactions.ytSave`).
8. **Done and labelled:**
   - Wait for the job `done`. A toast includes "to your library".
   - The Music shelf card "Morning" has `[data-aq]` = "YouTube · AAC 128 kbps".
   - Its sheet `[data-av]` = "From YouTube · AAC 128 kbps".
   - No element in `#detailBody` contains "lossless".
9. **Merged album:** save a YouTube copy as artist "Test Band", album "First Light" (the FLAC album the test already imports). The shelf shows one "First Light" card whose line ends "also YouTube", and `[data-ay]` contains "FLAC plays first".
10. **Single track:** **Save track** on one row opens `#ytSave` with `#ytAlbum` prefilled with the song name. The button text is "Save track".
11. **Keyboard:**
    - Start a music queue, focus the YouTube chip and press Space: `aria-pressed` flips and `audioEl.paused` is unchanged.
    - `Escape` closes `#ytSave` and `document.activeElement` is the opener.
12. **Taste gates:** run the existing 4-way loop with results on screen, and once more with `#ytSave` open, at 1440×900 and 390×844, light and dark. The gates cover sideways scroll, plugin ids, hints ≤ 12 words (including the `title` tooltips "YouTube · AAC 128 kbps · lossy copy"), labelled fields with placeholders, and no raw JSON. Screenshots: `music-sources-<w>-<scheme>` and `yt-save-<w>-<scheme>`.

---

## 13. Contract fields this design needs that are missing

1. **`GET /v1/providers/youtube/thumb/<videoId>`** (owner-only): image bytes with `cache-control: private, max-age=86400`, or **204** when unavailable. D3 depends on it. Without it, rows show the placeholder.
2. **Plugin status values:**
   - Soulseek reports `status: 'not configured'` today (`src/providers/soulseek.js` `info()`), which is not in the contract's list.
   - Either add it to the enum, or guarantee `configured: boolean` on every source. The UI keys "Set up" on `configured === false`.
3. **Job identity fields** that `slskJobItem` already relies on but the contract list omits: `jobId`, `created`, `idleMs`, and the album id (`id: "yt:<hex>"`, present in `youtube-source.md` §2) or `sha256s` on done. "Open album" and the 1-hour "recent" filter need them.
4. **Partial success:** when a YouTube album finishes with some tracks refused (`youtube-source.md` R5), the done job needs `failedTracks: [{ title, error }]`, or at least `savedCount`. Otherwise the card can only say "Saved · 11 tracks", which would be false.
5. **(Optional) `searchable: true`** on `/v1/plugins` rows, so the chip list could come from the relay instead of the UI constant `SOURCES`. Without it the constant is fine. Not blocking.
