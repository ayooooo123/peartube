# One library for music and video: "Listen and Watch"

Status: decision, 2026-11-22. This document is the contract for the relay's web page (`src/ui.js`), which is built first. The Android and iPhone apps follow in a later step. The Mac app and the TV receiver are not part of this design.

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
8. **Old links keep working.** `#music` opens Listen and `#library` opens Home.
9. **Recently added needs a real date.** The library does not record when it first saw a title. Until it does, shelves are sorted by title and no shelf is called "new".
10. **Network figures are not part of browsing.** Peer counts and transfer rates are on the Sharing page. The top bar keeps only the states that need an action: the relay cannot be reached, something is being added, a restart is needed, the person is not signed in.
11. **The tools to add things are behind `Add to library`.** They do not stand above the shelves.
12. **Unknown stays unknown.** A length, a year or a format that the page does not know is left out. It is not guessed.

Look: the pictures do the work and the chrome is quiet. No card around every block; space and one-pixel lines separate things. Violet marks state only (what plays, progress, focus). The main action is the light button. No gradient, glow or blur on the page's own chrome.

## 2. Places and their links

| Place | Link | What it holds |
|---|---|---|
| Home | `#home` (also `#library`) | `Keep playing`, then the start of each room |
| Listen | `#listen` (also `#music`), `#listen/artists`, `#listen/tracks` | Albums as square covers, artists, every track |
| An album | `#album/<key>` | Cover, facts, `Play`, `Shuffle`, the track list, more by the artist |
| An artist | `#artist/<name>` | The artist's albums and tracks |
| Watch | `#watch`, `#watch/movies`, `#watch/series`, `#watch/clips` | `Keep watching`, posters, wide clips |
| A title | `#title/<key>` | A movie with its versions, a series with its seasons and episodes, or a clip |
| Find | `#find`, `#find/<words>` | `In your library`, then `Not in your library` |
| Add to library | `#add` | A link, a folder, a catalog, a channel; what is being added now |
| The music player | `#playing` | The cover, the controls and `Up next` |
| Owner pages | `#channels`, `#sharing`, `#tv`, `#settings` | Unchanged |

The video player is not a place. It covers the page, or it stays as a small picture while the person browses, as before.

**Top bar, wide screen:** `PearTube`, then `Home`, `Listen`, `Watch`; at the right the Find field, `Add to library` (a plus), then `Channels`, `Sharing`, `TV`, `Settings`. The room that is open has a line under its word. An album, an artist, the track list and the music player belong to Listen; a title belongs to Watch.

**Narrow screen (640 px and less):** a top bar with the room's name, `Add to library` and `More` (the owner pages and the theme). At the bottom: `Home`, `Listen`, `Watch`, `Find`. The small player sits above that row. The music player covers the whole screen.

## 3. Screens

**Home.** `Keep playing` mixes what is not finished: videos with their time left, and the album of the saved music list. The newest of them is large; the others are rows beside it (under it on a narrow screen). Under that: `Albums` with the link `All albums`, and `Movies and series` with the link `All video`. A library with clips and no movie or series shows `Clips` with the link `All clips` in that place, so Home is not bare. With nothing unfinished, `Keep playing` is absent. With an empty library, Home says `Nothing in your library yet.` and offers `Add to library`.

**Listen.** One control with `Albums`, `Artists`, `Tracks`; the count (`20 albums`); a `Saved here` switch. Albums are a grid of square covers with the album and the artist under each. Artists are a grid of sleeve stacks with the name and `3 albums`. Tracks is one list (title, artist, album) with a filter field.

**An album.** The cover at the left stays in view. Beside it: the word `Album`, the title, the artist (a link), a facts line (`5 tracks · 42 min`), a quieter line (`FLAC 24-bit 96 kHz · 1.6 GB · Saved here`), then `Play`, `Shuffle` and `More`. Then the tracks: number, name, length. The track that plays is marked. Under the tracks: `More by <artist>`. An album from YouTube says `YouTube · AAC 128 kbps` and has the tag `Lossy`.

**An artist.** The word `Artist`, the name, `3 albums · 32 tracks`, `Play`, `Shuffle`; the albums as covers; the first eight tracks and `Show all 32`.

**Watch.** Chips `All`, `Movies`, `Series`, `Clips` with their counts, and `Saved here`. With `All`: `Keep watching` (wide pictures with progress), `Movies and series` (tall posters), `Clips` (wide tiles). With one kind chosen: only that grid.

**Add to library.** The add box with its preview, `Import folder`, `Mirror a catalog`, `Copy a channel`, and the list of what is being added. A finished add stays in the list for six hours or until it is dismissed; a failed one stays until it is dismissed. An album that is saved from a search result shows its progress on the Find page, where the save started.

**Find.** One field for everything. Typing narrows the library at once: `In your library`, in the groups `Albums`, `Tracks`, `Movies and series`, `Clips`. Enter also looks outside: `Not in your library`, in the groups `Soulseek`, `YouTube`, `On other relays`. Chips above those groups show which of them a search asks, and each can be turned off. The page never searches outside the library without that key press. A pasted link offers `Add to library`.

**The small player (the dock).** It shows only when there is a music list. Its top edge is the progress line, which is also the seek control. Left: cover, track, `artist · album` (links). Centre: `Previous`, `Play` or `Pause`, `Next`, the times. Right: `Shuffle`, `Repeat`, `Up next`, `Volume`, `Open player`. On a narrow screen it is one row: cover, two lines, `Play` or `Pause`, `Next`.

**The music player.** Wide screen: at the left the cover, the track, the artist, the seek bar with both times, `Shuffle`, `Previous`, `Play` or `Pause`, `Next`, `Repeat`, and `Volume`. At the right, like the back of a sleeve: `Playing from`, the album, and the list. Tracks that are done are dim, the one that plays is marked, and what comes after the album is under `Then`. A row can be removed, and `Clear` empties what is still to come. Narrow screen: the same parts in one column, over the whole screen.

**Adding to the list.** An album, an artist and a track row offer `Play next` and `Play last`. Both keep the track that plays.

**A small video picture and the dock** do not cover each other: the picture stands above the dock.

## 4. Words on screen

| Where | Before | Now |
|---|---|---|
| Rooms | `Library`, `Music` | `Home`, `Listen`, `Watch`, `Find` |
| Unfinished things | `Continue watching` | `Keep playing` (Home), `Keep watching` (Watch) |
| Adding | `Add a video or channel` | `Add to library` |
| Kinds of video | `Shows`, `Videos` | `Series`, `Clips` |
| Where a copy is | `Saved here`, `Partly saved`, `On the network` | Unchanged |
| The search field | `Artist or album`, `Title or IMDb id`, `Search library`, `Search music` | One field: label `Find`, example `Blue Train` |
| Find, nothing typed | (none) | `Type a title or artist, or paste a link.` |
| Result groups | `Find music`, `Search all relays` | `In your library`, `Not in your library`; inside it `On other relays`, `Soulseek`, `YouTube` |
| Saving from a source | `Mirror`, `Mirror track`, `Mirror folder` | `Save album`, `Save track`, `Save folder` |
| The list of coming tracks | `Queue`, a button that reads `1 of 2` | `Up next`; inside the player `Playing from`, `Then`, `Clear` |
| Adding to that list | (none) | `Play next`, `Play last` |
| Music stopped by a video | (nothing) | `Paused for a video` |
| Player controls | `Previous track`, `Next track`, `Queue` | `Previous`, `Play`, `Pause`, `Next`, `Shuffle`, `Repeat`, `Volume`, `Up next`, `Open player`, `Close player` |
| Video player | `Audio track`, `Subtitles`, a format line | `Audio`, `Subtitles`; the format is under `File info` |
| Counts | `N album(s)` | `1 album`, `20 albums`, `5 tracks`, `12 movies`, `4 series`, `6 clips` |
| Time left | `12:30 left` | `1 h 36 min left`, `31 min left` |

Rules for every string: sentence case; no word of the plumbing (ports, peer names, plugin names, job states, protocol names, hashes); a hint or a tooltip has 12 words or fewer; each field has a label and an example, not an instruction; each control that is only an icon has a label and the same text as its tooltip. Facts on one line are joined by a middle dot: `1958 · 5 tracks · 42 min`. A fact that a person chooses by, such as `FLAC 24-bit 96 kHz` or `2160p · Dolby Vision`, is not plumbing.

## 5. Data: what the screens use, and what is missing

This change adds nothing to the HTTP API. The page uses what it used before: `/v1/entries`, `/v1/entries/info`, `/v1/poster/<id>`, `/v1/backdrop/<id>`, the stream links, and two keys in the browser's own storage (the position in each video, and the music list with its position).

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

- The links `#music`, `#library`, `#channels`, `#sharing`, `#tv`, `#settings`.
- The saved music list and the saved video positions of a browser that used the page before.
- The controls that other tools and tests address by name: the small player `#np` with `#npSeek`, `#npPlay`, `#npNext`; the video player's controls; `#detail` with `[data-album]`, `[data-play]` and `[data-download]`.
- The source search (its chips, its streamed groups, the save dialog for YouTube, the progress of a save). It moves under Find; it does not change.
- Light and dark themes, and both widths that the page is checked at: 1440 × 900 and 390 × 844.

## 8. Not built

- The Android and iPhone apps (next step), the Mac app, the TV receiver.
- A cover route, a first-seen date, lengths in lists, years, descriptions, episode names and pictures (section 5).
- Reordering `Up next` by dragging. A row can be removed and the rest cleared.
- Playlists, favourites, ratings, play counts, lyrics, a sleep timer.
- A queue for video.
- The same position on two devices.
- Saving a whole video from YouTube. The existing action saves the sound and says so.
