# PearTube cleanup plan

Audited 2026-08-21 against the Holepunch stack's own rules. This is a work list, not a design
doc — every item names files and lines. Ordered by correctness risk first, cosmetics last.

Context: the goal is a codebase that survives a Holepunch maintainer reading it. Two items below
are real correctness bugs; the rest is noise reduction and honesty.

---

## P0 — Correctness. Do these before anything else.

### 1. `apply` is non-deterministic. Peers will diverge permanently.

`packages/backend/src/personal/personal-store.js`

Autobase rolls back and reapplies as history reorders. `apply` must be a pure function of the ops.
It isn't:

| Line | Code | Problem |
|---|---|---|
| 192 | `const eventId = op.eventId \|\| randomId()` | `randomId()` is `crypto.randomBytes(16)` (line 51-53). **Randomness inside `apply`.** |
| 193 | `const ts = op.timestamp \|\| Date.now()` | Wall clock inside `apply`. |
| 194 | `view.put(\`${COLLECTIONS.HISTORY}/${descendingTimeKey(ts)}/${eventId}\`, …)` | Both non-deterministic values feed the **view key**. |
| 133 | `addedAt: op.addedAt \|\| Date.now()` | Wall clock in `apply` (add-writer). |
| 156 | `subscribedAt: op.subscribedAt \|\| Date.now()` | Wall clock in `apply`. |
| 167-168 | `createdAt`/`updatedAt: … \|\| Date.now()` | Wall clock in `apply`. |
| 185 | `addedAt: op.addedAt \|\| Date.now()` | Wall clock in `apply`. |

Because line 194 puts the record at a key derived from a random id and the wall clock, replaying
the same log twice writes to **two different keys**. Two peers replaying the same history produce
different views, and a single peer produces a different view after a reorder. History entries
duplicate and orphan. This does not heal.

**Fix:** every value that reaches the view must come from the op. Stamp `eventId` and timestamps
at *append* time, in the caller, and make `apply` reject an op that lacks them rather than
inventing a fallback. Grep the whole `apply` path for `Date.now`, `Math.random`, `randomBytes`,
`crypto.random` and treat every hit as a bug.

Also line 140: `await host.removeWriter(...).catch(() => {})` — swallowing an error inside `apply`
hides log corruption. Let it throw.

**Size:** M. **Buys:** the difference between a multi-writer store that converges and one that
silently doesn't.

### 2. `multi-writer-channel.js` is single-writer.

`packages/backend/src/channel/multi-writer-channel.js:344`

```js
this.db = HyperDB.bee(this.core, channelDbDefinition, { autoUpdate: true, … })
```

One core, `HyperDB.bee`, no Autobase, no linearizer. `packages/backend/src/channel/pairer.js:116`
says so outright: *"HyperDB has no Autobase waitForWritable path."* Autobase 7.27.3 is a dependency
but only `PersonalStore` and the publisher/catalog path use it.

So `mergeStagedRecords` (lines 209-230) resolving conflicts on `updatedAt` — where `updatedAt` is
`Date.now()` at write time (lines 1117, 1243) — is a hand-rolled last-write-wins over a
single-writer database, using unsynchronised clocks. It is not multi-writer conflict resolution.

**Fix, pick one and be able to defend it:**
- **(a)** The channel genuinely needs multiple writers → move it to Autobase, with an `apply` that
  obeys item 1, and let the linearizer order writes. This is the real fix and it is a migration.
- **(b)** The channel is single-writer by design (one publisher, devices paired via
  `blind-pairing`) → **rename the file and the class**, delete `mergeStagedRecords`, and drop the
  clock comparison. Single-writer needs no merge.

Do not leave it named `multi-writer-channel.js` while it is single-writer. That name is the first
thing a reviewer greps.

**Size:** L for (a), S for (b). **Buys:** the architecture matching its own labels.

---

## P1 — Rule violations that cause silent stalls.

### 3. 79 swallowed promise rejections

`grep -rn '\.catch(() => {})' packages/backend/src | wc -l` → 79.

Worst: `archive/permissionless-network.js` (10+ at 353, 383-384, 415, 431, 444-445, 458, 523-524,
674-675, 713), `channel/multi-writer-channel.js:508,1336`, `channel/public-channel-bee.js:289,298`,
`api/policy.js:188,288,311`.

In a P2P system these are exactly where a partition turns into an indefinite hang with no log line.
`discovery?.flushed?.().catch(() => {})` means a failed join is indistinguishable from success.

**Fix:** two helpers — `bestEffort(promise, context)` which logs and moves on, and
`mustNotFail(promise, onError)` which surfaces. Classify all 79. A bare `() => {}` is only correct
when the operation owns nothing downstream.

**Size:** M.

### 4. `findingPeers()` released on a timer instead of `swarm.flush()`

`packages/backend/src/blob-playback-service.js:82-113`

`retainFindingPeers` calls `core.findingPeers()` then schedules `done()` on a `setTimeout`
(`findingPeerLeaseMs`). The documented pairing is `findingPeers()` + `await swarm.flush()` + `done()`.
A timer either fires before peers are found — `core.update()` resolves empty and playback reports no
peers — or holds the replicator in finding-peers state longer than needed.

**Fix:** drive `done()` off `swarm.flush()`, keeping the timer only as a backstop.

**Size:** S. **Note:** this is currently described on a résumé as a "bounded discovery lease." It is
a workaround for not using `flush()`. Fix the code before claiming it.

### 5. `federated-search.js` joins before wiring the handler, then hides the failure

`packages/backend/src/search/federated-search.js:57-67`

```js
try { this.discovery = this.swarm.join(this.searchTopic, …) } catch {}   // 58
if (!this._connectionHandler) { … this.swarm.on('connection', …) }       // 62-67
```

Three things:
- `join` before `on('connection')`. Currently survives only because lines 58-67 are synchronous, so
  the event loop cannot deliver a connection in between. Add one `await` in that window and pairing
  breaks silently. Wire the handler first.
- `catch {}` on line 59 — if `join` throws, `this.discovery` is undefined and federated search never
  works, with no error anywhere.
- The channel uses **`json` encoding** (line ~135-145) on a stack that ships `compact-encoding`, in a
  repo that already generates hyperschema codecs. Move it to `compact-encoding` with a versioned
  codec and a frame bound, matching the other five protocols.

**Size:** S.

---

## P2 — Noise. Cheap, and it is what a reviewer sees first.

### 6. 473 `console.*` calls across 203 files

`storage.js` 145, `api.js` 69, `cast/chromecast.js` 46, `orchestrator.js` 34, `seeding.js` 22,
`upload.js` 22, `channel/pairer.js` 20. No debug gate.

**Fix:** route through the existing logger with levels and a `DEBUG` gate. Delete the ones that were
scaffolding. Chromecast receiver chatter does not belong in backend logs.

**Size:** M.

### 7. Duplication

- `normalizeRange` ×4 — `archive/challenge.js:31`, `archive/pledge.js:19`, `archive/request.js:20`,
  `assets/availability.js:3` → `archive/normalize-utils.js`
- `isBytes` ×2 — `api/publisher.js:54`, `blob-request-cancellation.js:10`
- scattered validators — `isCatalogKey` (api.js:175), `isValidHypercoreHex` (api.js:1591),
  `isMultiWriterChannelKey` (api.js:779), `isFiniteNonNegativeInteger` (blob-range-priority.js:156)
  → `shared/validators.js`

**Size:** S.

---

## P3 — Structure and honesty.

### 8. 16 files over 1,000 lines

`api.js` 3,791 · `storage.js` 3,128 · `network/scoped-runtime.js` 1,966 ·
`channel/public-channel-bee.js` 1,646 · `cast/chromecast.js` 1,497 · `content-replication.js` 1,471 ·
`channel/multi-writer-channel.js` 1,466 · `seed-pin/pin-worker.js` 1,318 · plus
`universal-core.js`, `api/publisher.js`, `seed-pin/pin-store.js`, `seed-pin/protocol.js`,
`seeding.js`, `identity.js` (~1,000-1,100 each). Two of the largest are generated hyperdb specs and
should be excluded.

Split `api.js` into the domain factories it already contains, and `storage.js` into core / identity /
blob layers. Do this **last** — it is the lowest-value, highest-churn item, and it conflicts with
everything above.

**Size:** L.

### 9. Delete or mark the 41 plan docs in `docs/superpowers/plans/`

Spot-checked four: `2026-08-09-02-asset-manifest-ingestion` **not implemented**,
`2026-08-09-10-route-scoped-streaming` **not implemented**,
`2026-03-28-native-studio-channel-implementation` **not implemented**,
`2026-07-17-seed-pin-durability` **partially** (protocol/store/worker exist; relay registration
incomplete).

A directory where three of four documents describe code that does not exist is worse than no
directory. Anyone reading it cannot tell design from intent.

**Fix:** move unimplemented plans to `docs/plans/abandoned/` or delete them, and add an `INDEX.md`
marking each shipped / partial / abandoned.

**Size:** S. **Buys:** the repo stops overstating itself.

---

## What is actually good — keep and do not touch

Verified in code, not in plan docs:

- **Five versioned `compact-encoding` peer protocols** with frame caps and pre-decode bounds
  checking — `network/frame.js:68` validates the declared length against the negotiated ceiling
  before reading. `seed-pin/protocol.js` computes node and string budgets before encode.
- **Admission control with paired release** — `network/scoped-runtime.js:225-263`, reserve before
  hello/frame, release in `finally`, release the peer on close.
- **Capacity accounting** — `archive/policy.js:34-37`, `sum(max(reserved, actual))` against a
  ceiling, serialized through a promise tail, persisted across restart.
- **Attestation bound to the live transport** — `seed-pin/auth.js:371-374` verifies with
  `expectedIdentity` *and* `expectedDevice: remotePublicKey`, so an attestation lifted onto another
  connection fails. This is the strongest thing in the repo.
- **One schema, two languages** — 2,700-line source generating wire-compatible JS and Swift codecs.
- **Comment hygiene** — 3 TODO/HACK/workaround comments in 109k lines.
- **1,977 tests across 333 files.**

---

## Order

1. Item 1 (apply determinism) — correctness, and it is contained.
2. Item 2 (decide (a) or (b)) — everything else in `channel/` depends on the answer.
3. Items 4, 5 — small, mechanical, remove rule violations.
4. Item 3 — classify the 79, fix the archive ones first.
5. Items 6, 7, 9 — noise and honesty, cheap.
6. Item 8 — last, or never.
