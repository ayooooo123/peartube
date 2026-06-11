# Personal Sync (cross-device subscriptions / playlists / history / settings)

Syncs a single user's private data across **their own** paired devices:
subscriptions, playlists, watch history (+ resume positions), and app settings.

## Why this needed a new primitive (the multi-writer finding)

PearTube's "multi-writer channel" (`MultiWriterChannel`) is built on
`HyperDB.bee(core, def)`. Despite the name, that is **single-writer**: it is a
plain Hyperbee on a single Hypercore (`hyperdb` → `BeeEngine`). There is no
Autobase, no `.base`, no linearizer. A second device that opens a channel by
key gets it **read-only**, and `pairer.js` even notes "HyperDB has no Autobase
waitForWritable path". The project previously migrated *off* Autobase for
channels (see comments in `comments-channel.js`, `api.js`).

So genuine cross-device write — where phone and desktop both write and changes
converge — cannot be done with `HyperDB.bee`. It needs real multi-writer:
**Autobase with a Hyperbee view (the "autobee" pattern)**. That is what
`PersonalStore` is.

## Architecture

- `src/personal/personal-store.js` — `PersonalStore`: an Autobase whose view is
  a Hyperbee (autobee). Each of the user's devices is an Autobase writer added
  via `host.addWriter` inside `apply`. Collections (key prefixes in the view):
  `sub/`, `playlist/`, `playlist-item/`, `history/` (reverse-chronological),
  `resume/`, `setting/`, `writer/`, plus pairing invites.
- `src/personal/personal-manager.js` — owns one `PersonalStore` per identity.
  The **owner** device re-derives its store deterministically from a fixed
  corestore namespace (`peartube-personal:<identityPublicKey>`), so it reopens
  writable across restarts with no persisted key. The bootstrap key is saved on
  the identity record (`personalKey`) so the user's other devices can open it.
- Privacy: the bootstrap key is **never published** (unlike the public channel
  key). Only the user's own devices receive it, through the existing
  BlindPairing device-link flow (`setupPairing` mirrors `ChannelPairer`).

## Integration status

Done (backend, tested):
- `PersonalStore` + `PersonalManager`, wired into `orchestrator.js`
  (`ctx.personal`, `result.personalManager`).
- Subscriptions now read/write the personal store when available, with a
  one-time migration from the legacy device-local `metaDb` `subscriptions`
  array, and a safe metaDb fallback when no identity is active.
- New `api.js` methods: `getPlaylists`, `createPlaylist`, `updatePlaylist`,
  `deletePlaylist`, `addToPlaylist`, `removeFromPlaylist`, `getPlaylistItems`,
  `logWatchHistory`, `getWatchHistory`, `getResumePosition`,
  `listResumePositions`, `setPersonalSetting`, `getPersonalSettings`.
- Tests: `test/personal-store.test.mjs` (brittle, in `npm test`) and
  `test/personal-store-harness.mjs` (`npm run test:personal`) — the harness
  proves two separate corestores both writing and converging, including
  concurrent-write convergence.

Remaining (follow-up):
- HRPC schema (`packages/spec/schema.cjs`) entries for the new methods + JS/Swift
  codegen (`node schema.cjs`) so the app/native shell can call them, plus
  `mobile-handlers.js` / desktop worker passthroughs.
- Switch the active personal store when the active identity changes
  (`personalManager.setActive`) from the `setActiveIdentity` handler.
- Mobile/desktop UI for playlists and watch history.
- Optional: at-rest encryption of the personal store for defense-in-depth
  (today privacy rests on the key staying unpublished).
