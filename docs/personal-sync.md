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

Done (RPC + lifecycle):
- HRPC schema (`packages/spec/schema.cjs`) message types + 13 commands for
  playlists/history/settings, classified under a new `personal` app namespace
  (`packages/spec/lib/app-rpc-adapter-codegen.cjs`), regenerated via
  `node schema.cjs` (JS + Swift). The generated Swift is copied into
  `packages/desktop-native/Sources/Support/` per the documented workflow (those
  files are gitignored — regenerated at build).
- Backend handlers wired centrally: the new commands are added to
  `SHARED_HANDLER_NAMES` and resolve to `backend.api.<method>` through
  `registerSharedHandlers` — so all platforms (mobile, Electrobun desktop,
  native shell) get them with no per-platform adapter code. The `api.*` methods
  take the decoded request and return the response envelope directly.
- Active personal store follows the active identity: the orchestrator wraps
  `identityManager.setActiveIdentity` / `createIdentity` to call
  `personalManager.setActive`, covering every platform in one place.
- Tests: `test/personal-hrpc-wiring.test.mjs` proves the commands register,
  resolve to the api, and round-trip through a real `PersonalStore` with the
  correct envelopes.

Remaining (follow-up):
- Mobile/desktop UI for playlists and watch history (the RPC surface is ready;
  `mobile-handlers.js` / the desktop worker may add thin convenience wrappers
  if a platform wants a custom shape, but the shared handler already serves all
  three).
- Native Swift shell build is unverified in CI here (codegen ran clean; the
  Xcode build wasn't exercised).
- Optional: at-rest encryption of the personal store for defense-in-depth
  (today privacy rests on the bootstrap key staying unpublished).
