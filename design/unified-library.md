# One library for music and video: "Listen and Watch"

Status: decision, 2026-11-22, updated 2026-11-23 with the sketch sync across all platforms (Relay web UI, Android, iOS, and macOS Desktop): paired Home Listen/Watch actions, Listen `Play all`/`Shuffle` and sortable `Tracks` table, Watch views (`Rows` first, plus `Tonight`, `Video store`, and `Channels`, with `Play something`), and the `Network` visualizations (`Globe`, `Swarm`, `Flow`) using existing `/v1/status` data. The TV receiver is not part of this design.

## 0. Decision

Three directions were built as clickable prototypes and compared on the same album and the same film:

| Direction | Idea | Why it was not chosen, or why it was |
|---|---|---|
| A, one wall | Square sleeves, tall posters and wide clips share one wall | It depends on artwork. A library with missing covers and long titles is hard to scan |
| **B, Listen and Watch** | A Home that joins both, and one room for each kind | **Chosen.** A listener gets the album and its order without another panel. A film gets posters, versions and episodes. Home holds what a person left unfinished, music and video together |
| C, index and stage | One ruled list of everything, with the player beside it | Good for comparing files, but the player takes room from the list and long names need two lines on a phone |

The page before this change had a Library tab (video only, with the tools to add things above it) and a Music tab (albums grouped by artist, with the source search under them). An album opened in a sheet. The music bar had no full view, no way to add to its queue, and said nothing when a film stopped the music.

## 1. Rules that the build follows

1. **One player.** It plays one thing at a time: a track or a video.
2. **A film never enters the music queue.** `Up next` holds tracks only. A series offers `Next episode`.
3. **Music waits for a video.** When a video starts while music plays, the music stops and keeps its track, its time and its list. When the video closes, the small player shows the waiting track, paused, with the line `Paused for a video`. Nothing starts again by itself: only `Play` does.
4. **Music closes a video.** When a person starts music while a video is open, the video closes and keeps its place under `Keep playing`.
5. **Artwork.** Use an embedded cover from a public file that the relay holds. Otherwise draw a sleeve from the album's name. Do not open private or remote files to fill a shelf. Do not contact a public image host for an album cover. A film's poster still comes through the relay (`/v1/poster/<id>`).
6. **No artist photos.** There are none in the system. An artist's picture is a stack of that artist's sleeves.
7. **Where a return visit starts.** The first visit opens Home. A later visit with no link opens the room that the person used last.
8. **Old links keep working.** `#music` opens Listen, `#library` opens Home, `#find` opens Search, and `#tv` opens the TVs dialog.
9. **Recently added needs a real date.** The library does not record when it first saw a title. Until it does, shelves are sorted by title and no shelf is called "new".
10. **Network figures are not part of browsing.** Peer counts and transfer rates are on the Sharing page. The top bar keeps only the states that need an action: the relay cannot be reached, something is being added, a restart is needed, the person is not signed in.
11. **The tools to add things are behind `Add to library`.** They do not stand above the shelves.
12. **Unknown stays unknown.** A length, a year or a format that the page does not know is left out. It is not guessed.
13. **A row plays the list that it is in.** A track row in Tracks, in an artist's tracks or in search results plays that list, in the order shown, from that row. A row on an album page plays the album from that row. `Up next` then holds the rest of that list.
14. **Shuffle is a switch.** `Shuffle` in the player turns shuffle on or off and shows its state. On: the tracks after the one that plays come mixed. Off: the list order comes back after this track. The page remembers the switch, as it remembers `Repeat`. `Shuffle` on an album or an artist starts that list with the switch on.
15. **No control is dimmed without a reason that a person can read.** With one track the player says `1 of 1`, and `Shuffle` and `Next` stay where they are.
16. **One place to search.** The top bar's field searches the library at once, and Enter also asks the sources. Discover has no field of its own.
17. **A film goes to a TV from where it plays.** The video player, a title page and a file row offer `Play on a TV`. There is no TV page: one TV icon in the top bar opens the list of TVs.
18. **Every overlay closes four ways:** a click or tap outside it, Escape, Back, and a visible close control. Back closes the overlay and leaves the page where it was. When the overlay holds typed text, each of those asks `Discard what you typed?` (`Keep editing`, `Discard`); `Cancel` discards without a question.

Look: the pictures do the work and the chrome is quiet. No card around every block; space and one-pixel lines separate things. Violet marks state only (what plays, progress, focus). The main action is the light button. No gradient, glow or blur on the page's own chrome.

## 2. Places and their links

| Place | Link | What it holds |
|---|---|---|
| Home | `#home` (also `#library`) | `Keep playing`, then the start of each room |
| Listen | `#listen` (also `#music`), `#listen/artists`, `#listen/tracks` | Albums as square covers, artists, every track |
| An album | `#album/<key>` | Cover, facts, `Play`, `Shuffle`, the track list, more by the artist |
| An artist | `#artist/<name>` | The artist's albums and tracks |
| Watch | `#watch`, `#watch/movies`, `#watch/series`, `#watch/clips`, `#watch/tonight`, `#watch/shelf`, `#watch/channels` | `Rows` (default: `Keep watching`, posters, wide clips), `Tonight` (three picks + A–Z index), `Video store` (spine shelves), `Channels` (on-now cards + 4-hour guide) |
| A title | `#title/<key>` | A movie with its versions, a series with its seasons and episodes, or a clip |
| Discover | `#discover` | `Search your sources`, followed creators and topics, the shelves that a person visited, more from the artists in the library |
| A shelf | `#shelf/<user>` | What one Soulseek user shares, with a filter |
| Search | `#search`, `#search/<words>` (also `#find`, `#find/<words>`) | `In your library`, then `From your sources` |
| Add to library | `#add` | A link, a folder, a catalog, a channel; what is being added now |
| The music player | `#playing` | The cover, the controls and `Up next` |
| TVs | A dialog from the TV icon (also `#tv`) | The TV that plays now, the paired TVs, and a field for a TV's code |
| Network & Sharing | `#network`, `#network/swarm`, `#network/flow`, `#sharing` | `Globe`, `Swarm`, and `Flow` live route visualizations, Receiving/Sharing sparklines, reciprocity meter, route breakdown, plus relay sharing switches |
| Owner pages | `#channels`, `#settings` | Unchanged |

The video player is not a place. It covers the page, or it stays as a small picture while the person browses, as before.

**Top bar, wide screen:** `PearTube`, then `Home`, `Listen`, `Watch`, `Discover`; the search field; at the right the state pills, `Add` (a plus), the TV icon, then `Channels`, `Sharing`, `Settings` and the theme. The room that is open has a line under its word. An album, an artist, the track list and the music player belong to Listen; a title belongs to Watch; a shelf belongs to Discover.

**Widths.** The bar never makes the page wider than the window. Each range gives up one more thing:

| Width | What changes |
|---|---|
| 1400 px and more | Everything is in one row |
| 1100 to 1399 | `Channels`, `Sharing`, `Settings` and the theme go into `More` |
| 821 to 1099 | `Add` and `PearTube` lose their words; their icons stay |
| 701 to 820 | The search field becomes a search button that opens Search |
| 700 and less | The narrow layout below |

**Narrow screen (700 px and less):** a top bar with the logo, the state pills, `Add`, the TV icon and `More` (the owner pages and the theme). At the bottom five items: `Home`, `Listen`, `Watch`, `Discover`, `Search`. The small player sits above that row. The music player covers the whole screen.

## 3. Screens

**Home.** At the top, paired quick-start cards for `Listen` (`Resume`/`Pause`/`Play all` and `Shuffle`, with album cover collage) and `Watch` (`Continue` and `Play something`). Below them, `Keep playing` mixes what is not finished: videos with their time left, and the album of the saved music list. Under that: `Albums` with the link `All albums`, and `Movies and series` with the link `All video`. A library with clips and no movie or series shows `Clips` with the link `All clips` in that place, so Home is not bare. With nothing unfinished, `Keep playing` is absent. With an empty library, Home says `Nothing in your library yet.` and offers `Add to library`.

**Listen.** Top actions `Play all` (or `Resume` when a track waits paused) and `Shuffle`; one control with `Albums`, `Artists`, `Tracks`; the count (`20 albums`); a `Saved here` switch. Albums are a grid of square covers with the album and the artist under each. Artists are a grid of sleeve stacks with the name and `3 albums`. Tracks is one sortable table with a filter field: number, title, artist, album, quality, size and length. A press on a column head sorts by it and a second press turns the order; the head says how the list is sorted (`aria-sort`), for a screen reader too. Numbers are right-aligned. A cell that the page does not know stays empty, and such rows sort last. On a narrow screen the table keeps title, artist, quality/size and length, and a `Sort` menu replaces the heads.

**An album.** The cover at the left stays in view. Beside it: the word `Album`, the title, the artist (a link), a facts line (`5 tracks · 42 min`), a quieter line (`FLAC 24-bit 96 kHz · 1.6 GB · Saved here`), then `Play`, `Shuffle` and `More`. Then the tracks: number, name, length. The track that plays is marked. Under the tracks: `More by <artist>`. An album from YouTube says `YouTube · AAC 128 kbps` and has the tag `Lossy`.

**An artist.** The word `Artist`, the name, `3 albums · 32 tracks`, `Play`, `Shuffle`; the albums as covers; the first eight tracks and `Show all 32`.

**Watch.** Four switchable views sharing one library, with `Rows` first, and a `Play something` action that picks a random unwatched title:
- `Rows` (default): chips `All`, `Movies`, `Series`, `Clips` with their counts, and `Saved here`. With `All`: `Keep watching` (wide pictures with progress), `Movies and series` (tall posters), `Clips` (wide tiles). With one kind chosen: only that grid.
- `Tonight` (`#watch/tonight`): three decision cards (`Continue`, `Next episode`, and `Surprise me` with `Another`), then an A–Z letter jump bar and alphabetical index.
- `Video store` (`#watch/shelf`): horizontal shelves of vertical spines for `Series`, `Films`, and `Clips` (sized by kind and season count, tinted by title hue). Selecting a spine opens a cover sheet with `Play`/`Continue` and `Details`.
- `Channels` (`#watch/channels`): three deterministic pseudo-live channels (`CH 1 · Series`, `CH 2 · Films`, `CH 3 · Clips`) showing `on now` cards and a scrollable 4-hour guide.

**Network (`#network`, `#network/swarm`, `#network/flow`, and top of `#sharing`).** Three views that share the live numbers from `/v1/status`: `Globe` (three orbital route bands around a dotted globe), `Swarm` (concentric route rings around this node), and `Flow` (received/shared ribbons into and out of this node's cache). Beside the picture: live `Receiving` and `Sharing` rate cards with sparklines, a reciprocity meter comparing shared vs received bytes, per-route peer counts and rates (`Home network`, `Internet`, `Private route`), and storage kept. Animations pause when reduced motion is preferred. On the relay page, the existing Sharing controls stay below the visualizations so all owner toggles remain in one place.

**Add to library.** The add box with its preview, `Import folder`, `Mirror a catalog`, `Copy a channel`, and the list of what is being added. A finished add stays in the list for six hours or until it is dismissed; a failed one stays until it is dismissed. An album that is saved from a search result shows its progress on the Search page, where the save started.

**Search.** One field for everything: the top bar's field, or on a narrow screen the field at the top of Search. Typing narrows the library at once: `In your library`, in the groups `Albums`, `Tracks`, `Movies and series`, `Clips`. Enter, or `Ask your sources`, also looks outside: `From your sources`, in the groups `Soulseek`, `YouTube`, `SoundCloud`, `Rumble`, `On other relays`. Chips above those groups show which of them a search asks, and each can be turned off. The page never asks a source without that key press or that button. A pasted link offers `Add to library`.

**Discover.** One main action at the top: `Search your sources`, which puts the cursor in the top bar's field (on a narrow screen it opens Search). Then `Shelves you visited`: the Soulseek users whose shared files the person opened, the newest first, each with its number of folders and when it was opened. Then `More from artists you have`: a chip for each artist in the library. A press on a chip opens Search with that artist in the field and asks the sources there, so the answers and their `Save` buttons stand in one place; nothing asks a source before a press.

**A shelf.** The user's shared albums as rows (album, artist, quality, files, size) with a filter field and `Save` on each. `Back` returns to the place the person came from: the search that offered the shelf, else Discover. An album that the library holds already says `In your library` and links to it.

**TVs.** The TV icon in the top bar opens a dialog: the TV that plays now, with its remote (back, ten seconds either way, play or pause, stop) and `Stop`; the paired TVs, each with one state that a person can act on: `Ready`, `Playing`, `Needs its code`, or `Needs an update`, and `Forget`, which asks first, because pairing again needs the TV's code; then `Pair a TV…` with the field `Code on the TV` (example `K7M2QX`). A TV's network address is never shown. While a TV plays, the icon has a green dot. A TV that does not answer is named in the message after a play fails; the list does not guess that a TV is away.

**Play on a TV.** A menu: `This browser`, then each TV with its state and, when it cannot play, the reason beside it, then `Pair a TV…`. Choosing a TV starts the film there, and the page becomes its remote.

**The small player (the dock).** It shows only when there is a music list. Its top edge is the progress line, which is also the seek control. Left: cover, track, `artist · album` (links). Centre: `Previous`, `Play` or `Pause`, `Next`, the times. Right: `Shuffle`, `Repeat`, `Up next`, `Volume`, `Open player`. On a narrow screen it is one row: cover, two lines, `Play` or `Pause`, `Next`.

**The music player.** Wide screen: at the left the cover, the track, the artist, the seek bar with both times, `Shuffle`, `Previous`, `Play` or `Pause`, `Next`, `Repeat`, and `Volume`. At the right, like the back of a sleeve: `Playing from`, the album, and the list. Tracks that are done are dim, the one that plays is marked, and what comes after the album is under `Then`. A row can be removed, and `Clear` empties what is still to come. Narrow screen: the same parts in one column, over the whole screen.

**Adding to the list.** An album, an artist and a track row offer `Play next` and `Play last`. Both keep the track that plays.

**A small video picture and the dock** do not cover each other: the picture stands above the dock.

## 4. Words on screen

| Where | Before | Now |
|---|---|---|
| Rooms | `Library`, `Music`, `Find` | `Home`, `Listen`, `Watch`, `Discover`, `Search` |
| Unfinished things | `Continue watching` | `Keep playing` (Home), `Keep watching` (Watch) |
| Adding | `Add a video or channel` | `Add to library` |
| Kinds of video | `Shows`, `Videos` | `Series`, `Clips` |
| Where a copy is | `Saved here`, `Partly saved`, `On the network` | Unchanged |
| The search field | `Artist or album`, `Title or IMDb id`, `Search library`, `Search music` | One field: label `Search`, example `Blue Train` |
| Search, nothing typed | (none) | `Search your library and your sources`, with a few artists as chips |
| Result groups | `Find music`, `Search all relays` | `In your library`, `From your sources`; inside it `Soulseek`, `YouTube`, `SoundCloud`, `Rumble`, `On other relays` |
| Saving from a source | `Mirror`, `Mirror track`, `Mirror folder` | `Save album`, `Save track`, `Save folder`, `Save video` |
| TVs | A `TV` page, `Cast` | The TV icon (label `TVs`), `Play on a TV`, `This browser`, `Pair a TV…`, `Code on the TV`, `Remote`, `Stop`, `Forget` |
| The list of coming tracks | `Queue`, a button that reads `1 of 2` | `Up next`; inside the player `Playing from`, `Then`, `Clear` |
| Adding to that list | (none) | `Play next`, `Play last` |
| Music stopped by a video | (nothing) | `Paused for a video` |
| Player controls | `Previous track`, `Next track`, `Queue` | `Previous`, `Play`, `Pause`, `Next`, `Shuffle`, `Repeat`, `Volume`, `Up next`, `Open player`, `Close player` |
| Video player | `Audio track`, `Subtitles`, a format line | `Audio`, `Subtitles`; the format is under `File info` |
| Counts | `N album(s)` | `1 album`, `20 albums`, `5 tracks`, `12 movies`, `4 series`, `6 clips` |
| Time left | `12:30 left` | `1 h 36 min left`, `31 min left` |

Rules for every string: sentence case; no word of the plumbing (ports, peer names, plugin names, job states, protocol names, hashes); a hint or a tooltip has 12 words or fewer; each field has a label and an example, not an instruction; each control that is only an icon has a label and the same text as its tooltip. Facts on one line are joined by a middle dot: `1958 · 5 tracks · 42 min`. A fact that a person chooses by, such as `FLAC 24-bit 96 kHz` or `2160p · Dolby Vision`, is not plumbing.

## 5. Data: what the screens use, and what is missing

This change adds nothing to the HTTP API. The page uses what it used before: `/v1/entries`, `/v1/entries/info`, `/v1/poster/<id>`, `/v1/backdrop/<id>`, the stream links, the source search (`POST /v1/search/sources`, `POST /v1/search/global`), Soulseek's browse route, the cast routes (`/v1/cast/status`, `pair`, `play`, `control`, `stop`, `receivers/<id>`), and keys in the browser's own storage: the position in each video, the music list with its position, the shuffle and repeat switches, and the shelves that a person visited.

| Data a person might expect | What exists | What the page shows |
|---|---|---|
| A cover for every album | An embedded picture in a public FLAC file that the relay holds | The picture if one is available, or a drawn sleeve |
| Track lengths in every list | A length only for a file that the relay holds, has open, or read before | Lengths on the album page and in the player; none in the list of all tracks |
| Album, album artist and year as fields | Album and artist packed into the title; no year | The page splits the title, as before; no year on an album |
| The date a title was first seen | Nothing that reaches the page | Shelves by title; no shelf called "new" |
| What was played on another device | Nothing; positions live in each browser | `Keep playing` shows this browser's unfinished things |
| A description, a director, genres, a running time | Nothing | Not shown |
| Names and pictures of episodes | Nothing | The episode's number and the file's title; no picture |
| A picture and a length for a clip | Nothing | A wide tile with the clip's first letter, and the word `Clip` |

Possible later additions are a route for embedded or folder art, a private date for the first time a node saw a file, fields for album and artist, and lengths in the track listings. Descriptions and episode names would need a cached title record. Each addition needs its own decision and a row in the Rust parity list. None can require the relay to open private or remote files when a person scrolls.

## 6. The page file and the Rust relay

The Rust relay's image builds its page from this repository: it copies `src/ui.js` and `web/assets` into an empty folder and imports `page` from `src/ui.js`, with no other file of the app and no `node_modules`. So `src/ui.js` stays one self-contained file that exports `page`. `test/ui-page.test.js` does what the image does and fails when the page needs a file outside those two paths.

Inside the file, each concern has its own named section in the styles, in the markup and in the script, so that a later change can move sections into files of their own without a hand edit. Such a split is a separate decision: it needs either a generated `src/ui.js` or one more copied path in the Rust relay's image.

For this change the parity row is **shared page, no native port**. Both relays serve the same routes and the same page. Only the browser reads and writes the playback positions and the order of songs. There is no new HTTP field, channel operation, or file for the Rust relay to implement or migrate.

## 7. Kept on purpose

- The links `#music`, `#library`, `#find` (it opens Search), `#tv` (it opens the TVs dialog), `#channels`, `#sharing`, `#settings`.
- The saved music list and the saved video positions of a browser that used the page before.
- The controls that other tools and tests address by name: the small player `#np` with `#npSeek`, `#npPlay`, `#npNext`; the video player's controls; `#detail` with `[data-album]`, `[data-play]` and `[data-download]`.
- The source search (its chips, its streamed groups, the save dialog for YouTube, the progress of a save). It stays under Search; it does not change.
- Light and dark themes, and both widths that the page is checked at: 1440 × 900 and 390 × 844.

## 8. Not built (deferred for relay API + Rust parity)

- The TV receiver.
- Relay-side poster caching (`/v1/poster/:tt` still redirects to Cinemeta; approved 2026-11-23 for a follow-up relay + Rust parity PR).
- Per-peer Network rows, daily transfer history, route-colored video seek bar, and optional country table (`Places on the globe`, deferred 2026-11-23).
- A cover route, a first-seen date, lengths in lists, years, descriptions, episode names and pictures (section 5).
- Reordering `Up next` by dragging. A row can be removed and the rest cleared.
- Playlists, favourites, ratings, play counts, lyrics, a sleep timer.
- A queue for video.
- The same position on two devices.
- Saving a whole video from YouTube. The existing action saves the sound and says so.
- Editing the details of an entry (`Edit album` / `Edit details`). Approved 2026-11-23 without a year field and without persisting across file replacement; needs one owner-only route on the relay and one method on the node plus a Rust parity row.
- A quality that is stored when a file is added. Until then, Tracks shows a quality only for a file whose header the relay has read.

## 9. Answers to the owner's questions, and the inputs taken

The owner saw the sketch of these parts and gave his inputs on 2026-11-22. These are the answers, and what the build does with each.

1. **Discover is a fourth room.** It stands in the bar next to Home, Listen and Watch, with the same weight. It is not a view inside Listen, because a shelf is a place a person returns to, and a room keeps its own address and its own place in history. It holds the shelves a person visited and the artists of the library; it has no field of its own.
2. **The phone bar has five items:** `Home`, `Listen`, `Watch`, `Discover`, `Search`. Five items fit a 390 px row at 56 px each with no sideways scroll; the words are short, and each item carries an icon above its word.
3. **The TV entry is an icon in the top bar.** The TV page is gone. The icon opens a dialog with the paired TVs, the remote of the one that plays, and the field for a TV's code. The video player, a title page and a file row offer `Play on a TV` where the film plays.
4. **The parts that need no relay work come first.** Discover, the one Search, the TVs dialog, the top bar's widths, the Tracks table, the albums' Play and Shuffle, and the metadata edit all read what the relay already serves. Nothing in this change asks the relay for a new route or a new field, so the Rust relay serves the same page with no change of its own.
5. **All of this work goes into one draft pull request.** Nothing merges before the v0.4.45 tag.

**One clear place to search.** The top bar's field is the only field for a search. On a wide screen it stands in the bar on every page. On a narrow screen it takes the first row of Search, so the room's own page holds it at the top. Discover's one main action puts the cursor in that field, and a press on an artist chip opens Search with the name in it and asks the sources there. A person never meets two fields that mean the same thing.

**The owner's Soulseek question.** Search finds albums on Soulseek peers. A download starts only when the person presses `Save` on a result; a request to a peer, a place in its queue and a transfer that stalls are all shown on the save's card, with the peer's own state. Nothing downloads by itself, and a search alone transfers no file.

**The metadata edit needs relay work, so it stopped at the design.** A corrected title must change the channel for every follower, which needs a new owner-only write on the relay and on the node, and that is a contract change for the Rust port. The sketch shows the edit; the page does not offer it yet. The build resumes when the owner decides that route.
