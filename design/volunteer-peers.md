# Volunteer peers: stock blind peers, blind relays and private guards for a PearTube channel

Status: design for review. Nothing here is implemented. The build goes to its own branch
after review. Evidence lines name files at PearTube `main` `251e1dbb8` and at the holepunchto
repositories' heads of 2026-11-20 (`blind-peer` `a7f5029` 3.20.0, `blind-peering` `b5f188e`
2.15.0, `blind-peer-cli` `ab6262c` 1.16.4, `blind-peer-docker` `fe5b07f` = image
`tetherto/blind-peer:v1.15.1-r7` with `blind-peer` 3.15.1, `blind-relay` `2960327` 1.6.1,
`blind-relay-service` `7c8d9ec` 2.2.2). The Fargate run in `test/fargate/` measures the
blind peer and blind relay roles against the real network; its numbers are reported with
that run, not here.

## Bottom line

A channel owner should be able to accept three kinds of help from volunteers who run stock
Holepunch software and hand over one public key each:

| Role | What the volunteer runs | What it does for the channel | Verdict |
|---|---|---|---|
| Volunteer blind peer | `blind-peer` (`tetherto/blind-peer` image or `blind-peer-cli`), with `--trusted-peer <the relay's key>` | Holds and serves the channel's cores and media cores | Adopt. PearTube's relay drives it through the stock client `blind-peering`. No PearTube code runs on the volunteer |
| Volunteer blind relay | `blind-relay-service` | Carries a connection between two PearTube peers that cannot holepunch | Already supported by `PEARTUBE_RELAY_THROUGH` (`src/settings.js:19`); add only the setting's place in the UI and the words that explain when it is used |
| Volunteer private guard | PearTube's own guard (`bin/private-relay.js`) packaged like `blind-relay-service` | One hop of the two-hop private route | Keep ours; package it as a standalone service and image. Do not swap it for `blind-relay`: one blind relay sees both ends |

The relay's own replication path (`p2p-replicate`, `src/mirror.js:763-944`) is a different job
(this relay copying other channels onto its own disk) and stays. The HiveRelay seeder
(`src/hiverelay.js`) is the same job as the blind-peer role with an older, PearTube-specific
protocol; it stays for existing operators and new volunteers are pointed at blind peers.

## 1. What a stock blind peer is, and what it can hold for PearTube

A blind peer is a Corestore behind a Hyperswarm with two RPCs, `add-core` and `delete-core`,
and a batch form of `add-core` over `blind-peer-muxer` (`blind-peer/index.js:603-636`). For
every core record it keeps, it opens the core and downloads all of it
(`CoreTracker.refresh`, `:104-122`, `core.download({ start: blocksCleared, end: -1 })`), and it
replicates its whole store on every connection it has (`:593`). It knows nothing about what a
core holds.

How it gets the bytes depends on one flag, `announce`:

- `announce: false` (the default, and forced for every requester the volunteer did not list in
  `--trusted-peer`, `:784-787`): the blind peer joins no topic. It downloads the core over the
  connection of whoever asked for it and over any other connection it already has. For
  PearTube that means the owner's relay uploads every byte itself, once per volunteer, and no
  PearTube peer can find the volunteer: PearTube finds peers by topic (the channel's discovery
  key and, for 48 titles at a time, a video's discovery key, `src/node/network.js:9-10,169-192`),
  never by a list of keys.
- `announce: true` (only from a trusted requester): the blind peer joins the core's own
  discovery key on the DHT, as client too while it is behind (`_announceCore`, `:727-774`), and
  downloads from anyone. If the channel's bootstrap core is one of the announced cores, the
  blind peer sits on the channel topic like any PearTube peer: followers connect to it, ask it
  for the oplogs and, over the same connection, for any media core it stores
  (Corestore serves every stored core a connection names). Viewers that look a title up by
  its topic find it as well.

So for PearTube the volunteer must trust the relay's key. That is the one setting the
volunteer types, and it is a documented flag of the stock CLI (`blind-peer-cli/README.md:31`).

What it can hold, core by core:

| PearTube core | Blind peer holds it | How followers use it | Notes |
|---|---|---|---|
| Channel bootstrap core (the channel key) | yes | it is the channel topic; followers connect and replay | `seedableCores` lists it (`src/index.js:204-205`) |
| Writer cores (linked devices) | yes | Autobee replays them; wakeup hints name them | sent with `referrer: <channel key>` so the blind peer announces them to peers on the channel's wakeup session (`blind-peer/index.js:184-200`, Autobee consumes hints at `autobee/index.js:464`) |
| Stamped view and system cores (fast-forward landing) | yes | a cold follower lands on them with the owner offline | `seedableCores` adds them after 16 flushes (`src/index.js:206-219`); without them a follower replays from the first op, which is slower, not wrong |
| Per-video media cores (`512 KiB` blocks, `blockOffset: 0`) | yes, whole | viewers stream Range reads from any peer that has the blocks | one core per video; `announce: true` puts each on its own topic as well |
| Legacy shared `blobSlots` cores | yes, whole | same | a blind peer cannot hold one slice of a shared core; it is all or nothing, and `rechunkLegacyBlobs` makes this moot |
| Encrypted (private) videos | ciphertext only | a viewer with the `peartube://access/…` pass decrypts | the blind peer never gets the `EpochKey`; this is the "blind" case the design is named for |
| The relay's private files (`settings.json`, `jobs.json`, `identity.json`, `kept-copies.json`) | never sent | | they are not Hypercores and must not become ones |
| HiveRelay beacon cores | no | | HiveRelay-only wire; not sent |

What it cannot do: run `apply` (it stores oplogs, it never derives a view, so it cannot lie
about the channel's state), write to the channel, answer `/v1/*`, speak `peartube/bulk-busy`,
`peartube/search/v2` or the cast protocol, or keep a *slice* of a core.

Two properties of the stock server shape the rest of the design:

- Announced cores are never garbage collected (`:495`), and `delete-core` is accepted only
  from a trusted peer (`:993-996`). A full volunteer stops finishing downloads; it does not
  evict.
- A trusted peer may delete any core on that blind peer, including cores another owner added.
  A volunteer who helps several channels should run one blind peer per owner.

Two facts from running the stock image on this machine against the real channel
(2026-11-21, `test/fargate/smoke/`), both of which the implementation must build in:

- **The client and the server must be matched, and a mismatch fails silently.**
  `blind-peering` 2.12.0 and later send `add-cores` as a `protomux-request`
  (`requestAddCores`, `blind-peer-muxer` 1.8); the stock image's `blind-peer` 3.15.1 carries
  muxer 1.6.0, which only has the fire-and-forget `sendCores` message. Against it, a 2.14.0
  client's `addCore()` resolved (it resolves on connection, `blind-peering/index.js:281`),
  the blind peer logged "Paired muxer with peer" and never received a request, and nothing
  was stored. `blind-peering` 2.11.0 (the last fire-and-forget client) worked at once: 18
  requests received, 18 cores announced. The relay therefore treats "the volunteer reported
  a length" as the only sign of success, never the client's promise, and the UI says
  "No answer from this volunteer" until the first remote length arrives. Version floor for
  v1: pin `blind-peering` 2.11.x until the volunteer image carries muxer 1.8 or later.
- **The volunteer runs `--active-corestore`.** With the stock default (a passive Corestore)
  the blind peer fetched the media cores from the home relays but never the channel's
  bootstrap core: the relay's own session on that core is passive (`autobee/lib/boot.js:42-44`),
  and two passive sides never open the channel. With `--active-corestore` (documented as
  "useful for blind peers dedicated to seeding", `blind-peer-cli/bin.js:58-61`) the same
  blind peer learned the bootstrap core's length (1917 blocks) within 30 s and filled it. The
  volunteer instructions carry that flag beside `--trusted-peer`.

## 2. Volunteer blind peer: the design

### 2.1 Client library

Use `blind-peering` as is (`new BlindPeering(dht, store, { blindPeers, wakeup, pick })`,
`blind-peering/README.md:13-46`). It batches `add-core` requests, reconnects with backoff,
replicates the relay's store on the connection (`blind-peering/index.js:607-610`) and shares
PearTube's single `ProtomuxWakeup`. Version floor: a release whose `blind-peer-muxer` is
accepted by the oldest blind peer a volunteer is likely to run; the stock image carries
`blind-peer` 3.15.1 with muxer 1.6.0, the client at head uses muxer 1.9.0. The Fargate run
proves the pair that ships today; the implementation pins what that run used.

Open point, with the default: `addAutobase(channel)` or `addCore` per core? Default:
`addCore` per core, from `node.seedableCores({ includeCached })` (`src/index.js:195-244`),
which is already PearTube's own list of what a seeder should hold (bootstrap, stamped views
and landed cores after 16 flushes, writer cores, owned media, legacy slots, and complete
cached copies when asked). `addAutobase` expects an Autobase (`auto.core`, `'anchor'`,
`'appending'`, `'writer'` events, `blind-peering/index.js:658-690`); PearTube's channel is
`autobee` 2.12.1, its own implementation (`autobee/index.js:35`), and matching its events is
work with no gain over the list PearTube already keeps. If the implementation finds that
Autobee satisfies `addAutobase` as it is, use it for the channel cores and keep `addCore` for
media; the writer-core logic in `addWriterCores` (`:937-973`) is the only thing lost.

### 2.2 Identity: the relay needs a stable key

Today a relay's swarm key pair is new at every start (`src/node/network.js:69,76` pass
`keyPair || undefined`; `bin/relay.js` passes none). The volunteer's `--trusted-peer` names
the Noise key of the connection, and `blind-peering` connects with the DHT's default key pair
(`blind-peering/index.js:466-469`). So a relay gets a persistent swarm key pair:
`store.createKeyPair('peartube-relay-swarm')` from the Corestore's primary key, passed as
`keyPair` to `createNode` by `bin/relay.js` only. Apps keep a fresh key per start. The key is
shown on the Sharing tab as "Your relay key: give it to a volunteer".

### 2.3 Adding and removing a volunteer

Setting `blindPeers`: a list, `live: true` (applied in place, like `hiverelays`,
`src/settings.js:30-42`), each entry `<64 hex key>` with an optional `=<GB budget>`
(`key=200`). Env `PEARTUBE_BLIND_PEERS`, same form, comma separated, as the starting value.
Saved like every other setting in `settings.json` (`0600`). The UI: a "Volunteer seeders" card
on the Sharing tab in the shape of the HiveRelays card (`src/ui.js:769-784,4006-4043`): an
add field for the key, one row per volunteer with its state, and Remove. Over HTTP it is
`/v1/settings` (existing owner-guarded route) plus the plugin's `info()` in `/v1/plugins`;
no new route. The rust port gets a `PARITY.md` row.

Remove: the relay sends `delete-core` for every core *it* added to that volunteer (it is
trusted, so it may), best effort while the volunteer answers, then forgets the key. What it
added is kept in private `blind-peers.json` beside `jobs.json` (per key: the cores sent, the
time, and the last proof), so a restart knows what to remove and what to check.

Defaults on the open points: budget per volunteer 100 GB (the stock blind peer's own
default, `blind-peer-cli/README.md:36`), `includeCached` off (a volunteer helps with what the
owner published; copies the relay caches for viewers are not the owner's to hand out), the
relay sends nothing to a volunteer it has not reached once.

### 2.4 Which cores, in what order

A new mirror plugin, `blind-peer-seed`, registered beside `hiverelay-seed` in `src/mirror.js`
and fed by the same `node.seedableCores()`:

1. Channel cores first, `priority: 1` (NORMAL), `referrer: <channel key>` for the bootstrap
   and writer cores, `referrer: null` for views and landed cores: bootstrap core, writer
   cores, then the stamped views and landed cores. `announce: true` on the bootstrap core is
   what puts the volunteer on the channel topic.
2. Media cores, `priority: 0` (LOW), `referrer: null`, `announce: true`, newest published first
   (the catalog's order; a new title is what viewers ask for most), until the volunteer's
   budget is reached, counted from the entries' `size`. Private (encrypted) videos are
   included; they are ciphertext to the volunteer and the viewer's pass decrypts.
3. On every catalog change (the node's `onchange`) the plugin sends new cores and, when a
   video is removed from the channel, `delete-core` for its core on every volunteer that has
   it.

Why newest first and not smallest first or by views: PearTube keeps no view counts, and a
volunteer's value is the title people are opening this week.

The volunteer's connection is bulk traffic. The plugin hands `blind-peering`'s sockets to the
traffic gate (`src/traffic.js`) the way HiveRelay connections are paced, so uploads to
volunteers yield to viewers; with `announce: true` the volunteer also pulls from other peers,
so the owner's uplink is not the only source.

### 2.5 Checking that the volunteer holds the data

Two checks, both from public Hypercore state, nothing new on the wire:

- Continuous: on the relay's own connection to the volunteer, each core's `core.peers` entry
  for the volunteer's key reports `remoteLength` and `remoteContiguousLength`. The row in the
  UI reads "Holding 212 of 214 videos, channel up to date" from that. This is the volunteer's
  claim.
- Proof, once a day per volunteer by default (setting `blindPeerCheckHours`, `live`): the
  relay opens a throwaway in-memory Corestore, connects it to the volunteer only, and reads
  one random block of one random core it sent. Hypercore verifies the block against the
  core's tree, and because the throwaway store has no other peer the block came from the
  volunteer. One block per check (512 KiB for media). The result and time go to
  `blind-peers.json` and the UI shows "Proved 3 h ago" or "Failed proof: <time>".

A volunteer that fails three proofs in a row is marked "Not holding" and stays listed; the
owner decides to remove it.

### 2.6 Volunteer gone, volunteer full

- Gone: `blind-peering` reconnects with backoff (`blind-peering/lib/backoff.js`). The row says
  "Not reached for 2 d". Nothing is deleted on the relay's side; the owner's own copy is the
  primary and no PearTube path depends on a volunteer. After 30 days unreachable the row says
  "Gone" and the key stays until the owner removes it.
- Full: announced cores are never evicted (`blind-peer/index.js:495`), so a full volunteer
  shows as `remoteContiguousLength` stopping short on the newest cores. The row says
  "Full: holding n of N". The relay then stops sending new cores to it and, if the owner
  lowers the budget, sends `delete-core` for the oldest media cores it added beyond the new
  budget. It never deletes cores it did not add.
- Disk below the relay's own reserve: not a volunteer concern; the relay's existing reserve
  logic is untouched.

### 2.7 Trust and privacy: what a volunteer sees

- Every core key it is asked to hold, so every public oplog (titles, ids, sha256, sizes) and
  every public video in the clear. That is what any PearTube peer sees too.
- Private videos as ciphertext only.
- The relay's stable swarm key and address, and the keys and addresses of every peer that
  connects to it, like any seeder. `blind-peer` keeps top-k counters by peer key, referrer and
  address for abuse control (`blind-peer/index.js:304-310`).
- Wakeup hints on the channel's discovery key: writer keys and lengths.

It never gets: writer secret keys, `identity.json`, device links, source URLs, tokens, the
relay's settings, viewers that do not connect to it, or the `EpochKey` of a private video.

What the owner grants the volunteer: nothing beyond the right to serve. What the volunteer
grants the owner by `--trusted-peer`: the right to make it announce cores and to delete cores
on it. The documentation for volunteers says both sentences and recommends one blind peer per
owner.

### 2.8 Fit with the relay's existing code

| Existing path | Job | With volunteers |
|---|---|---|
| `p2p-replicate` (`src/mirror.js:763-944`) | this relay copies a followed channel's media to its own disk | unchanged; a volunteer cannot run it (it is PearTube code) |
| `hiverelay-seed` (`src/hiverelay.js`) | recruits p2p-hiverelay seeders over HTTP and `hiverelay-seed` | unchanged for existing operators; the new plugin is its sibling and shares `seedableCores`, the traffic gate and the Sharing tab; removal is a later decision after the blind-peer path has run for a release |
| `announceCache`, 48-topic rotation (`src/node/network.js:9-10,169-225`) | what a relay advertises on the DHT | unchanged; a volunteer with `announce: true` advertises every core it holds, which is the point |
| `PEARTUBE_RELAY_THROUGH` (`src/settings.js:19`, `src/node/network.js:77`) | relay fallback for connections | unchanged; see section 3 |
| `src/traffic.js` | bulk pacing | gains the volunteer sockets as bulk peers |

Effort: plugin about 400 lines, three settings keys, one UI card, `bin/relay.js` key pair and
wiring, one E2E test that runs the stock `blind-peer` package in-process on a testnet
(`new BlindPeer(storage, { trustedPubKeys, bootstrap })`, as `blind-peer`'s own tests do) and
proves: cores land on it, a follower with the relay offline syncs the channel and streams a
video from the volunteer alone, the proof read succeeds and fails when the volunteer's blocks
are cleared, remove deletes what was added and nothing else; plus the port's parity rows.

## 3. Volunteer blind relay

A blind relay is a TURN-like forwarder: two peers that each hold a pairing token open a
`blind-relay` Protomux channel to it, it creates one raw UDX stream per side and splices them
(`blind-relay/index.js:160-206,298-318`, `stream.relayTo(remote.stream)`). It sees both peers'
Noise keys, both addresses and the token, and forwards encrypted frames. `blind-relay-service`
runs one behind a persisted key (`bin.mjs:75`, `store.createKeyPair('blind-relay')`) on UDP
49737 and publishes pairing and stream counters to a `dht-prometheus` scraper (`:99-180`).

PearTube already uses it: `PEARTUBE_RELAY_THROUGH` (`src/settings.js:19`, type `keys`, applied
at the next start) becomes Hyperswarm's `relayThrough`, and PearTube answers only a forced
relay (`src/node/network.js:77`: `force ? keys : null`). Hyperswarm forces one after
`HOLEPUNCH_ABORTED`, `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, `CANNOT_HOLEPUNCH` or
`REMOTE_NOT_HOLEPUNCHABLE` (`hyperswarm/index.js:225-231,674-681`); a stock hyperdht server
also pairs with a relay the *dialing* side names (`hyperdht/lib/server.js:429-430`), so a
viewer behind a NAT that cannot be punched reaches any PearTube relay through the volunteer
without the relay knowing the relay key.

Design points and defaults:

- Keep PearTube's "forced only" rule. Hyperswarm's stock rule also relays whenever the local
  NAT is randomized (`hyperswarm/index.js:688-692`), which would push a relay's whole traffic
  through volunteers on many home routers.
- The key goes where the viewers are: the setting already exists in the apps' settings
  (`src/app-settings.js`, "relays"). The owner cannot push it to viewers. Default for v1: the
  channel page shows the owner's relay keys for people to paste; a channel-carried list of
  suggested relays is a protocol change (`decodeOp`, `apply`) and is not in this design.
- Separate role, separate setting, separate volunteer: a relay volunteer needs bandwidth, not
  disk, and sees connection metadata, not content.

## 4. Volunteer private guard

PearTube's private route is two hops, `Peer_A -> Guard_A <-> Guard_B <- Peer_B`
(`src/private-overlay.js:1-5`): a guard is a HyperDHT node with `firewalled: false` and a
stable key (`:229-230`, seed from `PEARTUBE_GUARD_SEED` or random), announced on
`GUARD_TOPICS` (`:19,262-264`), that splices two raw UDX streams per circuit
(`allocRawStream` + `HyperDHT.connectRawStream` + `relayTo`, `:161-170,426-432,466-473`) under
role separation and /24-diverse hop checks (`:457-465`). `bin/private-relay.js` runs it alone
with no Corestore and no disk, under Node or Bare, and `bin/relay.js` starts it as a child when
`privateGuard` is on.

What `blind-relay` could give a guard:

| Part | Reuse | Why |
|---|---|---|
| The splice | nothing to take | both already use the same public primitive, udx `relayTo`, on `dht.createRawStream` streams; `blind-relay` learns the peer's address from its first packet (`BlindRelayLink._onfirewall`, `:345-349`), the guard pins it to the control connection's address (`:165`) |
| Pairing | no | `blind-relay` pairs two links that present one token to *one* server (`BlindRelayPair`, `:264-277`). The guard's circuit crosses two servers and reuses a registered route for many circuits (`routes`, `MAX_ROUTES_PER_CONN`, `ROUTE_TTL_MS`, `:22-29`), with the far endpoint asked per circuit (`OP_INC_OPEN`). Mapping that onto `pair`/`unpair` would make Peer_B pre-pair one token per expected circuit |
| Key handling | the pattern, not the code | `blind-relay-service` persists its key in a Corestore (`bin.mjs:40,75`); the guard takes a seed from the environment. A volunteer guard should persist a seed file in its data directory (mode `0600`, made on first start) and print the public key, as `bin/private-relay.js` already does (`:19-24`) |
| Packaging | the pattern | `blind-relay-service`: an npm bin for Node and Bare, pino JSON logs, `graceful-goodbye`, optional `hyper-instrument` registration with a `dht-prometheus` scraper (`bin.mjs:77-184`). The guard has the bin and JSON logs; it lacks a persisted key, metrics and a published small image |

Why not swap the guard for `blind-relay`: one blind relay sees both endpoints' keys and
addresses and the token that links them; the two-hop route exists so that no single machine
sees both ends. A blind relay as Guard_B would also need Peer_B to hold a session and a token
per circuit, which is the registration model the guard replaced.

A standalone volunteer guard needs: the existing `bin/private-relay.js` as its own npm package
(`peartube-private-guard`, dependencies `hyperdht`, `b4a`, `sodium-universal`,
`compact-encoding`, `noise-secret-stream`, plus `ipv6Groups` moved out of `src/protocol.js` or
copied with its test); a persisted seed; a reachable UDP port (it runs with
`firewalled: false`, so the volunteer must forward the port; document this as the one
requirement); `hyper-instrument` metrics behind `--scraper-public-key/--scraper-secret` with
the guard's `stats()` (routes, circuits, DHT ops); a readiness probe; a `node:22-alpine` and a
Bare image published beside the relay image; and a version in its `hello` so a guard on another
version is refused, as today. Effort: about a day, no change to the guard's wire.

Default: package our guard like `blind-relay-service`; keep `blind-relay` for the
connection-relay role only.

## 5. Open points and the recommended default on each

| Point | Options | Default |
|---|---|---|
| Client call | `addAutobase(channel)` vs `addCore` per core | `addCore` per core from `seedableCores()`; try `addAutobase` only if Autobee satisfies it as is |
| Relay identity for volunteers | new key per start (today) vs persistent swarm key | persistent `store.createKeyPair('peartube-relay-swarm')` for relays only |
| Where the setting lives | `settings.json` + UI vs env only | setting, `live`, `PEARTUBE_BLIND_PEERS` as the starting value, UI card on Sharing |
| Budget per volunteer | fixed vs per key | per key `key=GB`, default 100 GB |
| Media order | newest first vs smallest first vs by health | newest first |
| Cached copies | send vs do not | do not (`includeCached` off) |
| Proof cadence | per hour vs per day vs on demand | per day, plus a "Check now" button |
| Volunteer full | stop sending vs delete oldest | stop sending; delete only when the owner lowers the budget |
| Untrusted volunteer (no `--trusted-peer`) | push anyway vs refuse | refuse and say why: nobody could find it |
| HiveRelay | remove now vs keep | keep; point new volunteers at blind peers; decide removal after one release |
| Relay keys for viewers | channel op vs paste | paste (v1); a channel op is a protocol change for later |
| Guard packaging | own package and image vs run the relay image with `PEARTUBE_PRIVATE_RELAY=1` | own package and image; the relay image stays able to run it |

## 6. What the Fargate run proves and does not prove

It runs the stock blind peer image exactly as a volunteer would (`--trusted-peer <owner key>`
and `--max-storage`), with the owner's client outside the task, and measures it as a seeder:
time to first byte and to the full subset, bytes served, CPU and memory. It runs
`blind-relay-service` as a volunteer relay would and measures pairing time, forwarded bytes,
throughput, added latency and streams per task. It does not run the plugin above (not
written), does not test private videos on a volunteer, and does not test `delete-core` or the
proof read against the stock server; those are the E2E test's job on the implementation
branch.
