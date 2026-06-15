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
- **The `archive` feature is the opposite of a conduit** and is the single
  biggest liability footgun in the codebase. `peartube-relay archive --url ...`
  runs `yt-dlp`, *downloads specific named videos*, and *republishes* them with
  plaintext source URLs, titles, and descriptions (`packages/cli/src/archive/`,
  `archive-manager.js`). Any operator who enables archiving is actively
  acquiring and publishing selected content — there is no non-knowledge defense
  left for them. This should be loudly documented as a distinct, higher-exposure
  mode, kept off by default, and never conflated with "just relaying."

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
3. **Quarantine the archive mode.** Treat `archive` as an explicitly
   higher-liability, off-by-default capability with its own documentation; never
   present it as part of "running a relay."
4. **Carry only what replication needs** (public core keys / discovery keys),
   not human-readable metadata, on the relay path.

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
   plaintext inventories, quarantine archive. This improves the posture even
   with zero crypto changes.
2. **Blind content** (the real lever): uploader-side encryption of blob cores;
   keys delivered to viewers, never to relays; relay serves ciphertext.
3. **Fragmentation** (optional, longer horizon): no node holds a whole object.

## Open questions

- How do blind relays advertise availability usefully without naming content?
  (Discovery-key-only announcements vs. the current named/previewed feed.)
- New-subscriber key bootstrap when only the relay (which has no keys) is online.
- Migration: existing relays already hold plaintext public cores and plaintext
  ledgers; what is the cleanup story?
