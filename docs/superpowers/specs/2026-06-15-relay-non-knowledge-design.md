# Relay Non-Knowledge / Conduit Design

> Status: design / discussion draft
> Date: 2026-06-15
> Supersedes the framing of the earlier "relay at-rest encryption" idea.

## TL;DR

The goal is **not confidentiality of the stored bytes**. The goal is **operator
deniability**: a volunteer running a PearTube relay should be able to credibly
say *"I cannot know what I relay, I do not choose it, and I run indiscriminate
infrastructure"* — the same posture that protects Tor-exit and IPFS-pinning
operators.

That is a **non-knowledge / mere-conduit** property, and it is achieved by
*architecture*, not by disk encryption. At-rest encryption is the **weakest**
lever for this fear and is explicitly deprioritized here (see
[Why at-rest is the wrong tool](#why-at-rest-is-the-wrong-tool)).

The two things that actually move the needle:

1. **Blind relays never hold content keys** — they store and serve only
   ciphertext, so "I cannot decrypt what I relay" is a *true, demonstrable
   property of the software* rather than a claim.
2. **Stop the relay from manufacturing evidence of its own knowledge** — today
   the relay writes and *gossips* plaintext records of exactly which channels
   and videos it is serving. That is the first thing to fix
   (see [Plaintext-evidence audit](#plaintext-evidence-audit)).

## Threat model

The fear: an investigation (e.g. FBI) into content that flowed through the
network sweeps in relay operators who never chose, never watched, and could not
read what they relayed. We want the technical facts to support "you can't show
this operator *knew or controlled* the content."

What we are **not** trying to do, because it is not achievable and pretending
otherwise is dangerous:

- We are **not** trying to defeat the fact that a relay *transmitted* bytes. A
  relay's entire job is to advertise cores on the DHT and serve blocks to any
  peer that asks. An investigator becomes a peer, connects to the relay's IP,
  and observes it serving the content. **No disk measure touches this.**
- We are **not** building a way to hide *known-illegal* material or obstruct a
  *specific* lawful process. The legitimate target is minimizing liability for
  operators of *indiscriminate* infrastructure — not evasion of attribution for
  content the operator selected.

## Why at-rest is the wrong tool

| Scenario | At-rest disk encryption | Blind relay (no content keys) |
|---|---|---|
| Live raid (machine running) | ~0 — key in RAM, volume mounted, plaintext | Holds — RAM has only ciphertext + public replication keys |
| Powered-off seizure | Disk opaque, **but** the operator holds the key → compelled-decryption / contempt | Operator never had the content key; nothing to compel |
| Network attribution ("your IP served us the file") | 0 | 0 (see honest limits) |
| "Could the operator know what it was?" | **Yes** — they hold the key | **No** — by construction |

The decisive column is the last one. Deniability is about **knowledge and
control**, and at-rest encryption leaves the operator holding the key, i.e.
*able to know*. Blind relaying removes that ability entirely.

## Design: non-knowledge by construction

### 1. Blind storage / serving (relay never holds content keys)

This is the earlier end-to-end key design, **repurposed from confidentiality to
deniability**:

- Uploaders encrypt blob (and, in the strong mode, thumbnail) cores with content
  keys derived on their own device.
- Keys reach *viewers* out-of-band (share-link fragment, pairing handshake) and
  **never** reach the relay.
- The relay replicates and serves the encrypted blocks using only the public
  core key — exactly what Hypercore replication needs, since block encryption
  sits below the replication/Merkle layer. The relay can `download()` and serve
  ciphertext it cannot decode.
- `blind-peer` (already a dependency) is the right substrate: its protocol role
  never required the content keys. The change is to make the *content itself*
  encrypted so "blind" becomes true at the content layer, not just the protocol
  layer.

Result: the relay process, even fully cooperating under duress, **cannot**
produce plaintext — it has no key in any state.

### 2. Indiscriminate relaying (no content selection)

A "mere conduit" defense collapses the moment the operator *curates*. So:

- The relay should not *choose* channels by content. Discovery-mode relays
  already seed whatever the public feed gossips; that indiscriminate behavior is
  an asset and should be the default, not allowlists hand-picked by content.
- **The `archive` feature is a deliberate *publisher* role, and that is fine** —
  it is a critical function, not a footgun. But it is worth being precise about
  what it means: `peartube-relay archive --url ...` runs `yt-dlp`, downloads
  specific named videos, and republishes them (`packages/cli/src/archive/`,
  `archive-manager.js`). For *that* content the operator genuinely is the
  publisher; there is no "I didn't choose it" defense for the subset an operator
  archives, and that is an accepted trade-off. The key insight is that the two
  roles **coexist on the same node**: an operator is a *publisher* for what it
  archives and a *blind conduit* for what it relays for others. The conduit
  properties protect the latter regardless of the former. And archived content
  should still be served blind (encrypted body, operator-derived key) so that
  *downstream* relays — who did not choose it — keep their non-knowledge
  posture. So: keep archive, but (a) keep its publisher liability scoped to the
  archiving operator, and (b) still encrypt archived bodies for the network's
  benefit.

### 3. (Optional) fragmented storage — no node holds a whole object

The closest technical analog to "you can't prove I stored *that data*": each
relay holds only erasure-coded *fragments* of an encrypted core, so no single
operator stores a recognizable whole object — just opaque partial blocks.
Hypercore does not natively erasure-code across peers; `blind-peer` already
approximates this by only holding what it is asked to. This is a longer-horizon
item, listed for completeness.

## Plaintext-evidence audit

The relay currently **generates and even broadcasts** records that document
precisely what it serves. For a non-knowledge posture these are own-goals: they
are artifacts an investigator would point to as evidence the operator *knew* and
*catalogued* the content. Ordered by severity.

### Critical — published/gossiped to the network (attributable to the operator)

- **`submitRelayCatalogEntry()` gossip** — `packages/cli/src/runtime.js:194-208`
  → `packages/backend/src/public-feed.js:2206`. The relay broadcasts, over the
  public feed, an entry with `channelName`, `previewVideos`, `relayRole: 'cache'`
  and **`relayServing: true`** — i.e. it actively *announces to the entire
  network* "this relay is serving this channel." This is signed/attributable and
  is the strongest self-incriminating artifact. A non-knowledge design cannot
  emit `relayServing: true` keyed to identifiable channel content.
- **`emitFeedEntries()`** — `runtime.js:144-157` re-emits per-channel
  `channelKey` / `publicBeeKey` / `previewVideos` to candidate handlers.

### High — plaintext on the operator's disk

- **`relay-catalog.json`** — `packages/cli/src/catalog.js` (written by
  `service.js` `upsertChannel`, many call sites). Stores per-channel
  `channelKey`, `ownerKey`, `retentionClass`, `bytes`, `previewVideos`,
  `admittedAt`. A literal "here is what I chose to retain" ledger.
- **`relay-status.json`** — `packages/cli/src/status.js` `writeRelayStatus`.
  Includes the full `channels` list, `evictionCandidates` (with `ownerKey`), and
  `seeding.blobAvailability.videos` — per-video `id` / `blobId` the relay has
  confirmed it holds and probed for playability.
- **`cache-channels` in the local metaDb** — `packages/cli/src/cache-manager.js`
  `_persist()` puts `{ driveKey, publicBeeKey, previewVideos, ... }` into the
  Hyperbee. Survives restarts; recoverable from the corestore.

### Medium — in-memory / derived, but leaked into the above

- **Seeding stats** — `packages/cli/src/seeding.js` `collectBlobAvailability` /
  `getStats` build per-video availability detail (ids, blobIds, "playable")
  which flows into `relay-status.json` and the gossiped catalog entry.
- **`previewVideos`** threaded throughout (titles, thumbnails, ids) — every
  layer that carries these is carrying plaintext descriptions of content.

### Remediation themes

1. **Do not announce content-identifying serving state.** Drop or
   content-blind `relayServing`/`channelName`/`previewVideos` in the gossiped
   relay-catalog path. A blind relay can announce *availability of opaque cores*
   by discovery key without naming or previewing them.
2. **Stop persisting plaintext ledgers of retained content.** `relay-catalog.json`
   and `relay-status.json` should be derivable/operational only, not a durable
   plaintext inventory of channel names/owners/video titles. At minimum, gate
   them behind an explicit operator opt-in, and key them by opaque discovery
   keys rather than names/previews.
3. **Separate the publisher role from the conduit role.** Archived content
   carries publisher liability *for the archiving operator by design* — that is
   accepted. Keep it, but still encrypt archived bodies so downstream relays
   stay blind, and avoid letting the archive path widen the plaintext metadata
   the *relay* role emits about everyone else's content.
4. **Carry only what replication needs** (public core keys / discovery keys),
   not human-readable metadata, on the relay path.

## Resolved design choices

### 1. Relay-gossip admission / anti-abuse

Open "seed core X" gossip is not acceptable. It turns one malicious request into
multi-relay disk exhaustion. The v1 rule is:

> Relays may gossip **opaque core refs** to each other, but a relay only commits
> disk after local admission checks pass. Gossip is a hint, not an entitlement.

There are two admission paths with different trust levels:

1. **Ingress registration**: the uploader pushes one accepted relay a seed-core
   registration. This path may arrive from a mobile/backend client, but it is
   still subject to per-source rate and byte budgets.
2. **Relay-to-relay gossip**: an already-running relay forwards only
   `{ coreKey, discoveryKey }` plus non-content operational hints. This path is
   accepted only from configured relay peers, using the existing
   `blind-peer`/`createRelayBlindPeer()` `trustedPubKeys` hook as the first gate.

The relay never treats public feed metadata as storage authority. The storage
authority is the local relay's admission controller.

#### Opaque wire shapes

Canonical message types should be added to `packages/spec/schema.cjs` so JS and
Swift clients agree on field names before Protomux/HRPC wrappers are wired:

```js
RelayCoreRefV1 = {
  schema: 'peartube.relayCoreRef.v1',
  coreKey: '<32-byte hex Hypercore key>',
  discoveryKey: '<32-byte hex discovery key>',
  kind: 'media' | 'thumbnail' | 'metadata' | 'unknown',
  tier: 'cache' | 'archiver',
  byteLengthHint: 0,
  blockLengthHint: 0,
  announcedAt: 0
}

RelayCoreRegisterV1 = {
  schema: 'peartube.relayCoreRegister.v1',
  refs: [RelayCoreRefV1],
  sourcePeerKey: '<optional 32-byte hex peer key>',
  ownerProof: '<optional owner-signed opaque admission proof>',
  nonce: '<random hex>',
  signature: '<optional source signature over the canonical request>'
}

RelayCoreGossipV1 = {
  schema: 'peartube.relayCoreGossip.v1',
  refs: [RelayCoreRefV1],
  relayPeerKey: '<32-byte hex relay peer key>',
  nonce: '<random hex>',
  signature: '<relay signature or secret-stream peer-authenticated envelope>'
}
```

Relay-to-relay gossip carries **opaque keys only**. It must not carry
`channelName`, titles, thumbnails, preview manifests, public search metadata, or
anything derived from them. `kind` is operational, not descriptive.

#### Admission gates

The admission controller applies all of these gates before it calls
`blindPeer.addCore(core)` or starts an eager `core.download({ start: 0, end: -1
})`:

1. **Source gate**
   - Relay-to-relay gossip is ignored unless the remote relay peer key is in
     `config.relay.gossip.trustedPubKeys`.
   - Ingress registration from local owner/uploader paths is accepted only after
     local CLI/backend policy has already decided to publish or seed the upload.
   - Public internet ingress, if enabled later, must require an operator-issued
     token or an owner-signed opaque admission proof. It is off by default.
2. **Shape gate**
   - `coreKey` and `discoveryKey` must be 32-byte hex.
   - `discoveryKey` must equal Hypercore's discovery key for `coreKey`.
   - Duplicates are coalesced by `discoveryKey`; duplicate gossip updates only
     the last-seen counter.
3. **Rate gate**
   - Token buckets per source peer key: refs/minute, bytes/hour, in-flight
     staged cores, and rejected-ref backoff.
   - A global in-flight cap prevents many "valid but slow" cores from pinning
     sockets and download ranges.
4. **Storage-reservation gate**
   - Cache tier reserves only the configured staged/cache budget.
   - Archiver tier reserves the full observed or hinted size before permanent
     admission. Unknown size may be staged briefly, but cannot become a
     permanent archiver commitment until observed.
5. **Core sanity gate**
   - Open the core in a staging session/namespace and wait for a bounded
     `core.update()` from a live peer.
   - Reject empty, unavailable, over-limit, fork-mismatched, or timeout cores.
   - Download at most a small probe range during staging. Full-core download is
     allowed only after storage is reserved.

The local relay may persist an **opaque operational ledger** for crash recovery:
`{ discoveryKey, coreKey, tier, admittedAt, state, byteLength, sourceBucketId }`.
It must not persist human-readable channel/video metadata, owner names, titles,
or previews. Source bucket ids are hashed with a relay-local salt so the status
file is useful for rate accounting without becoming a public identity ledger.

#### Failure modes

- Unknown relay key: ignore and increment a non-content counter.
- Source over rate cap: reject with `rate-limited`; do not re-gossip.
- No live peer during sanity check: reject with `unavailable`; retry only if a
  fresh registration arrives.
- Storage reservation fails: reject with `storage-full` and report operator
  status; do not partially admit.
- Core becomes unavailable mid-download: keep the opaque state as
  `stalled`, release unused reservation, and retry with exponential backoff.

This keeps byte propagation blind without making relays a storage-amplification
service.

### 2. Archiver disk-bound policy (no lease)

There are three explicit node roles. Operators can run more than one role, but
the deniability posture is only as strong as the weakest role on that machine.

| Role | Content choice | Holds content keys? | Disk behavior | When full |
|---|---|---|---|---|
| **Seeder/cache** | Indiscriminate, policy-gated opaque refs | No | Bounded cache/staging budget; evictable by local policy | Evict lowest-priority cache entries, then reject new refs |
| **Blind archiver** | Accepts opaque refs for durable redundancy | No | Eager full download; `enableGc:false`; permanent until manual/operator policy removal | Refuse new permanent refs before commit; never silently drop accepted cores |
| **Publisher archive** | Operator runs `archive` / local mirror and republishes | Owner-derived keys for that published content | Separate publisher quota; deliberate content selection | Archive job fails or queues; existing publisher content is not silently removed |

No lease means there is no "expires at" garbage-collection clock for an accepted
archiver core. Disk pressure is handled by admission and explicit operator
policy, not by pretending time-based expiry preserves permanence.

The blind archiver state machine is:

```text
observed -> staged -> admitted -> downloading -> complete
                   \-> refused-storage-full
                   \-> refused-sanity-check
                   \-> stalled
```

Only `complete` is advertised as an archiver success. `staged`, `admitted`, and
`downloading` are local operational states. A relay may advertise cache
availability while downloading, but it must not claim permanent archiver
redundancy until the full core is present.

When a blind archiver's disk is full:

- It keeps serving already-admitted cores.
- It stops accepting new `tier: 'archiver'` refs and returns
  `ERR_RELAY_ARCHIVE_STORAGE_FULL`.
- It may accept the same ref into the cache tier only if cache budget exists and
  the request allowed fallback; fallback is reported as cache, not archive.
- It surfaces structured status:
  `usedBytes`, `reservedBytes`, `maxBytes`, `admissionPaused`,
  `rejectedSinceFull`, `stalledCores`, and `manualActionRequired`.
- It does not delete accepted archiver cores automatically. If the operator
  wants eviction, that is a separate, explicit retention policy and should be
  documented as weakening the "permanent archiver" promise.

For publisher archives, disk-full is a publisher workflow error. The `archive`
feature stays, but it uses a separate quota namespace so a chosen publisher job
cannot silently crowd out blind conduit capacity or widen what the relay role
emits about other people's content.

### 3. Key distribution without relay knowledge

Byte distribution and key distribution are separate systems. Blind-peer solves
the byte path. The key path must never route decryption keys through relays.

#### Content keys

Each private/key-gated channel has a 32-byte **channel master key** (`CMK`) that
lives only on owner devices and paired/subscribed devices. For each video:

```text
K_video = HKDF-SHA256(CMK, salt = channelId, info = "peartube/video/v1:" || videoId)
keyCommitment = BLAKE2b-256(K_video)
```

The owner-signed video descriptor commits to `keyCommitment`, the encrypted
media core key, the media discovery key, and non-secret operational hints such
as byte length and MIME type. For key-gated/blind tiers, human metadata
(title, description, thumbnails, preview text) is encrypted for viewers and is
not present in relay gossip.

Because Hypercore's `encryptionKey` is per core, the encrypted-media path should
move private videos to **per-video media cores** opened from
`MultiWriterChannel._openBlobs()` or a small helper under it:

```text
mediaCoreName = peartube-video-${channelIdPrefix}-${writerPrefix}-${videoIdHash}
mediaCore = store.get({ name: mediaCoreName, encryptionKey: K_video })
```

The existing shared writer blob core remains for legacy/public unencrypted
content. New private uploads use the per-video encrypted core so the per-video
key model is real, not just metadata.

#### Owner-signed descriptor shape

The exact schema should be generated through `packages/spec/schema.cjs`, but the
semantic shape is:

```js
EncryptedVideoDescriptorV1 = {
  schema: 'peartube.video.encrypted.v1',
  channelId: '<channel key hex>',
  videoId: '<stable channel-local id>',
  mediaCoreKey: '<encrypted Hypercore key hex>',
  mediaDiscoveryKey: '<discovery key hex>',
  thumbnailCoreKey: '<optional encrypted thumbnail core key hex>',
  thumbnailDiscoveryKey: '<optional discovery key hex>',
  keyCommitment: '<BLAKE2b-256(K_video) hex>',
  encryption: 'hypercore-encryption-key',
  keyDerivation: 'hkdf-sha256/cmk/video-v1',
  byteLengthHint: 0,
  mimeType: 'video/mp4',
  signedAt: 0,
  ownerSignature: '<signature over canonical descriptor>'
}
```

Receivers reject any fetched or gossiped key unless
`BLAKE2b-256(candidateKey) === keyCommitment`. This prevents key poisoning even
when keys arrive from untrusted peers.

#### Delivery paths

1. **Single-video share link**
   - The URL fragment carries `K_video` and the descriptor id:
     `#ptv=<descriptorId>&k=<base64url K_video>`.
   - URL fragments are not sent to HTTP servers or relays.
   - The viewer fetches the owner-signed descriptor over normal PearTube
     discovery, verifies `keyCommitment`, then opens the encrypted media core
     with `K_video`.
   - Whoever receives the link can decrypt that video. This is a bearer
     capability; there is no revocation after disclosure.
2. **Subscribe/pairing**
   - Pairing delivers `CMK` through the existing device/channel pairing flow.
   - The viewer derives `K_video` locally for every descriptor and verifies the
     commitment before playback.
   - The relay only sees encrypted media refs and signed opaque descriptors.
3. **Optional gated key-gossip transport**
   - A Protomux key channel can help authorized online viewers re-serve
     per-video keys, but it is only a transport. It is not access control.
   - "Past viewers" means CMK-holding subscribers or owner devices. A
     share-link-only viewer already has `K_video`, but does not satisfy the
     channel-secret proof and does not become a general key server by default.
   - Requests are accepted only with proof of a channel secret relays do not
     hold:

```js
KeyRequestV1 = {
  schema: 'peartube.keyRequest.v1',
  channelId: '<channel key hex>',
  videoId: '<video id>',
  descriptorId: '<descriptor hash/id>',
  keyCommitment: '<expected hash(K_video)>',
  requesterEphemeralPubKey: '<32-byte hex>',
  nonce: '<random hex>',
  proof: 'HMAC(HKDF(CMK, "peartube/key-gossip-access/v1"), canonical request)'
}

KeyResponseV1 = {
  schema: 'peartube.keyResponse.v1',
  descriptorId: '<descriptor hash/id>',
  keyCommitment: '<expected hash(K_video)>',
  encryptedKeyBox: '<K_video encrypted to requesterEphemeralPubKey>',
  responderPubKey: '<32-byte hex>',
  nonce: '<random hex>'
}
```

   - Responders verify the proof before sending anything.
   - Requesters decrypt the box and still verify `keyCommitment`.
   - An open "anyone reply with the key" swarm is explicitly forbidden; that is
     zero gating and would let a relay or investigator simply ask for keys.

#### Mobile availability hole

The architecture deliberately makes always-on relays keyless. That means a new
viewer who lacks `K_video`/`CMK` cannot bootstrap keys from the relay while all
key holders are offline. This is an honest v1 ceiling, not a bug to paper over.

The fallback is an **opt-in always-on key-holder role**:

- Run by the channel owner or a trusted subscriber, not by default relays.
- Holds `CMK` or selected per-video keys and answers gated key requests.
- Should be configured and documented separately from blind relay mode:
  `nodeRole: 'key-holder'` or `nodeRole: 'publisher-key-holder'`.
- If co-hosted with a relay, that machine's deniability collapses for the
  channels whose keys it holds. It is no longer a non-knowledge relay for that
  content.

This is the right trade-off: availability can be bought by trusting an always-on
key holder, but the default relay operator remains unable to decrypt.

#### Sybil harvesting and revocation

The system cannot revoke already-disclosed `K_video` values or a leaked `CMK`.
Mitigations are therefore about limiting future blast radius, not pretending old
access disappears:

- Single-video links share only `K_video`, not `CMK`.
- Sensitive communities should use separate channels or separate future CMKs so
  one leak does not expose unrelated content.
- Key holders rate-limit by requester proof bucket and descriptor id.
- Key responses are encrypted to requester ephemeral keys.
- Future CMK rotation can protect future uploads, but old descriptors encrypted
  under the old CMK remain accessible to anyone who already learned the old key.

### 4. Metadata forwarding: owner-signed, not relay-authored

Lever 2 changes the public-feed/relay path from "relay says I serve this named
channel" to "relay forwards an owner-signed descriptor and separately serves
opaque bytes." The relay may transport signed descriptors, but it must not add
`relayServing: true`, titles, previews, or channel names as its own claim for
other people's content.

For public-browsable tiers, the owner may intentionally publish readable
metadata; that content belongs on public metadata relays whose operators accept
that weaker deniability posture. For blind/key-gated tiers, descriptors visible
to relays are opaque and human metadata is encrypted for key holders.

## Honest limits (do not over-trust this)

- **Network attribution is unaffected.** They can still show "your IP served
  these specific (encrypted) blocks of core X, repeatedly." Non-knowledge is a
  defense about *what you knew*, never about *whether you transmitted*. You
  cannot serve content to the public and also prove you never transmitted it.
- **"Wipe the key when they show up" is a trap.** Destroying data under
  anticipated investigation can itself be a crime (obstruction / spoliation).
  Ephemeral keys as routine hygiene are fine; a raid-triggered kill switch is
  not a legal strategy — it converts a liability problem into a felony. This
  design deliberately contains no panic-wipe.
- **This is ultimately a legal question.** Intermediary-liability doctrine,
  common-carrier / mere-conduit defenses, safe harbors, and compelled-decryption
  law are all jurisdiction-specific and unsettled. The architecture can make the
  *facts* favorable (no knowledge, no selection); it cannot decide the law.
  Worth real counsel and worth reading how the EFF Tor Legal FAQ and the IPFS
  project frame operator protection — they have litigated exactly this.

## Suggested phasing

1. **Stop manufacturing evidence** (highest value, lowest risk): the
   remediation themes above — kill content-identifying gossip, stop durable
   plaintext inventories of relayed content. This improves the posture even
   with zero crypto changes. (Archive stays; it is a separate publisher role.)
2. **Owner-signed metadata forwarding**: relays forward descriptors signed by the
   publisher/owner and stop authoring their own `relayServing` claims tied to
   channel names or previews.
3. **Opaque relay admission and disk policy**: add the seed-core register/gossip
   path with `trustedPubKeys`, per-source caps, core sanity checks, and explicit
   cache vs archiver disk behavior.
4. **Blind content and key distribution** (the real lever): uploader-side
   encryption of per-video media cores; share-link and pairing key delivery;
   optional gated key-gossip and opt-in key-holder availability.
5. **Fragmentation** (optional, longer horizon): no node holds a whole object.

## Resolved former open questions

- **Availability without names**: relays advertise opaque core refs
  (`coreKey` + `discoveryKey`) and owner-signed opaque descriptors. They do not
  advertise titles, previews, or `relayServing` claims for others' content.
- **New-subscriber key bootstrap**: share links carry `K_video`; pairing carries
  `CMK`; optional key-gossip only transports keys to requesters who prove a
  channel secret. If all key holders are offline, a new viewer cannot get keys
  from a keyless relay. The availability fallback is an opt-in trusted
  key-holder node.
- **Migration**: existing relays may already hold plaintext public cores and
  plaintext ledgers. Lever 1 should stop writing new plaintext ledgers, redact or
  remove relay-authored inventories on next startup unless the operator opts in,
  and report that historical public cores remain historical exposure. Migration
  is cleanup and posture improvement; it cannot make old plaintext facts never
  have existed.
