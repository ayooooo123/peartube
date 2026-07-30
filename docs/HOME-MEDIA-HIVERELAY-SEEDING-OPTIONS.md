# PearTube × Home Media × HiveRelay — Seeding Design (Synthesis)

**Status:** reviewed synthesis — options ratified into a recommended architecture (v0.2)
**Date:** 2026-07-24
**Owner:** product + architecture review
**Audience:** PearTube, HiveRelay packaging, home-operator UX
**Method:** v0.1 options doc audited in *design-review* mode per the brain's P2P App Audit Framework (Mafintosh + DMC lens stack + developer lenses), grounded against the live HiveRelay contract docs and the actual PearTube codebase.

**Related:**

- `docs/superpowers/specs/2026-07-24-peartube-seeder-spec.md` — **implementable spec derived from this synthesis** (config/CLI/inventory/unseed/quota contracts)
- `docs/superpowers/specs/2026-03-28-peartube-relay-design.md` — PearTube private/public relay appliance (substantially implemented in `packages/cli`)
- `docs/upload-offload-relay-anchor.md` — durable relay full-copy as offload anchor (offload math built; `RELAY_ANNOUNCE` unbuilt)
- `packages/cli/src/local-drive-mirror.js` — folder → channel import + seed (shipped)
- HiveRelay seed API: `00-core/hiverelay/packages/core/core/protocol/seed-request.js`, `relay-node/seeder.js`, client SDK `p2p-hiverelay-client`
- HiveRelay contracts: `00-core/hiverelay/docs/SERVICE-CONTRACT.md` (production, 2026-07-08), `00-core/v1-integration/docs/SERVICE-CONTRACT.md` (blind revision, 2026-07-12)
- HomeHive: `00-core/hiverelay/docs/HOMEHIVE.md`
- Blind trajectory: `00-core/v1-integration/docs/BLIND-ECOSYSTEM-MIGRATION-MATRIX.md` (PearTube entry: families `CELL, INBOX, CORE, FORWARD`)
- Audit method: `00-brain/compiled-vault-brain-2026-06-23/Topics/P2P App Audit Framework.md` + `Reports/2026-06-30 - Hiverelay - P2P App Audit.md`

---

## 0. What changed v0.1 → v0.2

v0.1 was an honest options doc written before checking the ecosystem brain and the live code on both sides. The audit changed four load-bearing things:

1. **The #1 open technical question is already answered.** v0.1 asked "what is the exact glue for HiveRelay holds PearTube cores?" and proposed a spike. The glue **ships today**: HiveRelay's publisher-signed **seed-request API** — Protomux channel `hiverelay-seed` and HTTPS `POST /api/v1/seed` / `POST /api/v1/unseed`, operator `POST /seed-core` for bare Hypercores, SDK `seed() / unseed() / getDurableStatus() / waitForDurable() / verifySeeded() / proveSeeded()`. `media` is a first-class content type (`CONTENT_TYPES` in `constants.js`). The spike becomes an *integration proof*, not a discovery.

2. **The sidecar must be reframed or it repeats a deprecated pattern.** The ecosystem already built "sidecar daemon replicates user data and pins it on HiveRelay" — `peerit-seeder` — and **deprecated it** ("durability moved to the HiveRelay fleet + OutboxLog", `00-brain/CONTINUOUS-DEVELOPMENT-PLAN.md`). v0.2 therefore recasts the component as a **publisher agent**: it owns app meaning (scan, import, channel keys, publish, inventory, unseed) and *delegates durability* to HiveRelay via seed requests. It is not a second always-on custodian.

3. **Several v0.1 assumptions were stale against the code.** `mode: home|friends` doesn't exist (`private|public` only — `packages/cli/src/config.js` throws on anything else); the gossip topic `peartube-public-feed-v1` was deliberately removed (single-topic `peartube-network` + Protomux `peartube-feed`; the relay-stability contract says *do not reintroduce*); relay-side quota is tracked but **never enforced** (`CacheManager.enforceQuota` has no callers; blind peer runs `enableGc: false`); **unseed does not exist** anywhere in the PearTube relay/mirror path; mirror idempotence is in-memory per-process only.

4. **PearTube is not parked.** The brain has no parking Decision for PearTube (parking is an explicit, recorded state in this ecosystem). Actual status: stable, on the current dependency generation, targeted for Lane D promotion, and **last in the Lane C live-wiring queue** with "bridge drafts exist, no live relay." This design *is* PearTube's live-wiring step — D8 changes accordingly.

Full findings with evidence are in §10; answered decisions in §12.

---

## 1. Executive read

| | |
|---|---|
| **App / component** | `peartube-seeder` — a PearTube publisher agent co-installed with HiveRelay (Blindspark) on home appliances (TrueNAS, Umbrel, StartOS, Unraid, …) |
| **Mode** | Design review (pre-implementation) |
| **Recommendation** | Build the **publisher-agent composite**: A′ (publisher agent + shipped seed-request API) + D (watch/mounted folders — already implemented as `--local-mirror-path`) + E′ (audience modes mapped to the *real* `private|public` relay modes) + F (capacity donation — mostly shipped as the public relay Docker image), with the blind `CORE`/`CELL` adapter as the migration target already inventoried for PearTube in the blind ecosystem migration matrix. |
| **Current risk level** | Medium — architecture is sound and most plumbing exists on both sides, but two of the doc's non-negotiable safety features (unseed, quota enforcement) currently have **zero working implementation**, and "home/LAN-only" overpromises against unbuilt LAN discovery. |
| **Fastest compounding next step** | Spike S2 (§13): seeder → local Blindspark `POST /api/v1/seed` in review mode → operator approve → `waitForDurable()` → **stop the seeder → fresh client streams the video**. This one proof exercises admission, custody, trust wiring, and the durable-anchor claim end-to-end. |

### Product intuition (unchanged from v0.1)

People who already run home media infrastructure often install HiveRelay/Blindspark as an always-on availability node, and separately hold large local video libraries. Operators should be able to **opt in** to seed selected media into the PearTube world through the same home box — without uploading a personal library to a company server, and without turning HiveRelay into a PearTube app server.

| Stakeholder | Value |
|-------------|--------|
| Home operator | Always-on seed origin from hardware they already own; private family share or public contribution |
| PearTube network | Real residential capacity and origin diversity for content that is *meant* to be available |
| HiveRelay | Stronger home-appliance narrative ("my box does something useful for video") without learning what video is |
| Creators / archives | NAS as durable origin; phones/laptops offload once a full copy is anchored at home |

### Core architectural constraint (now contract-verified)

The HiveRelay service contract is stricter than v0.1 assumed, and it is enforced text, not aspiration:

> *"The relay owns plumbing; the app owns meaning."* … triage test: *"Any-tenant → relay-side. One-app → app-side, full stop."* (`00-core/hiverelay/docs/SERVICE-CONTRACT.md`)
>
> *"There is intentionally no relay-side adapter API."* A seeder is client code, packaged with the app; it never asks the operator to add a namespace, endpoint, key, or allowlist entry to the relay itself. (`BLIND-SUBSTRATE-APPLICATION-ADOPTION.md`)

So the durable design rule from v0.1 survives, sharpened:

> **HiveRelay must not learn "video" or "PearTube channel" — and it doesn't need to.** The seeder hands it opaque core/drive keys through the generic, already-shipped seed-request surface. All meaning (channels, manifests, metadata, moderation, playback) stays in PearTube code on PearTube's release cadence.

---

## 2. Problem statement (revised)

### Today's gaps — reverified against code

1. **PearTube clients** (phone/desktop) are not reliable always-on seeders. *(Unchanged, structural.)*
2. **PearTube relay CLI is further along than v0.1 assumed** — `peartube-relay` ships private/public modes, allowlist/discovery admission (`packages/cli/src/admission.js`), `mirror-local`, status JSON, and a published multi-arch Docker image (`ghcr.io/ayooooo123/peartube-relay`) with compose examples including a read-only local-mirror mount. What's missing is not the seeder — it's **unseed, enforced quotas, persistent import state, and the HiveRelay handoff**.
3. **HiveRelay home installs** have the generic seed-request admission surface, but no PearTube integration exercises it yet, and appliance packaging defaults to accept-mode `review` (operator approves), not auto-accept.
4. **Upload offload** treats a relay full copy as a durable anchor only via manually configured `trustedRelayKeys` — `RELAY_ANNOUNCE` client discovery from the spec is unbuilt (`packages/backend/src/api.js` `getKnownDurableRelayKeys` reads config only).
5. **Privacy risk is existential and currently under-tooled:** auto-seeding a whole pool would leak private content, *and* the two mechanisms that make opt-in reversible — unseed and quota eviction — do not exist / are dead code today.

### The three jobs (unchanged, now with real owners)

| Job | Meaning | Owner in v0.2 |
|-----|---------|---------------|
| **Publish my files** | Local file becomes a PearTube video on some channel | `peartube-seeder` publisher agent (existing `local-drive-mirror` + publisher) |
| **Keep content available** | Cores/blobs stay online when clients sleep | HiveRelay via seed-request admission (`type:'media'`, `durability:1`); seeder retires to writer-only duty once durable |
| **Donate capacity** | Home disk helps *other people's* channels | Existing `peartube-relay --mode public` (allowlist or discovery policy) — parallel toggle, mostly shipped |

---

## 3. Goals and non-goals

### Goals (v0.2)

1. Ship home-media → PearTube seeding on the **existing** packaging assets: `peartube-relay` Docker image + Blindspark appliance bundles.
2. Preserve the HiveRelay service contract to the letter: zero relay-side changes; opaque keys only; feature-detect and degrade.
3. Make operator control first-class **and real**: folders, modes, caps, inventory, unseed — with the currently-missing enforcement built before public mode ships.
4. Reuse PearTube work as verified in §4, and HiveRelay's shipped seed-request/custody surface.
5. Support two audience modes at launch mapped to real config: **private** (home) and **public**; friends/invite deferred until read-capability sharing exists.
6. Land on the blind-substrate trajectory *as already inventoried*: PearTube's migration-matrix entry (`CELL, INBOX, CORE, FORWARD`; client-side channels/manifests/comments/moderation) is the end-state contract — don't invent a parallel one.

### Non-goals (unchanged from v0.1)

- Payment/marketplace for residential seeding. **Sharpened:** HiveRelay's seeding economics (bounties, leases, HiveMesh custody/witness) are explicitly deferred on their side too — the design must not *depend* on incentives existing.
- Jellyfin/Plex plugin parity in v1.
- Replacing PearTube's public feed or channel model.
- Making HiveRelay understand codecs, thumbnails, or channel identity.
- Legal advice on operator libraries.

---

## 4. Existing building blocks — verified state

Legend: ✅ shipped and works · 🟡 partial · ❌ missing (v0.1 assumed otherwise where marked ⚠️)

### 4.1 PearTube

| Building block | Verified state | Evidence |
|----------------|----------------|----------|
| Universal P2P backend | ✅ | `@peartube/backend` |
| Local drive mirror | ✅ scan/fingerprint/import/publish/seed, yt-dlp sidecar metadata, per-creator channel grouping | `packages/cli/src/local-drive-mirror.js`; flags `--local-mirror-path`, `--local-mirror-poll`, `--local-mirror-channel-name` |
| Mirror idempotence | 🟡 in-memory only — restart re-imports (downstream import dedup is the real guard) ⚠️ | `packages/cli/src/service.js` creates fresh `createLocalDriveMirrorState()` |
| Relay modes / admission | ✅ `private|public` × `allowlist|discovery`, retention classes | `packages/cli/src/admission.js`, `config.js` |
| `home` / `friends` modes | ❌ do not exist — config validation throws ⚠️ | `config.js` `VALID_MODES` |
| Relay quota enforcement | ❌ tracked + reported, never enforced; `enforceQuota()` has zero callers; blind peer `enableGc:false` ⚠️ | `packages/cli/src/cache-manager.js`, `relay-blind-peer.js` |
| Backend app cache quota | ✅ enforced with eviction + tests (this is the *client* cache, not the relay) | `packages/backend/src/seeding.js` |
| Unseed | ❌ no unseed/remove path anywhere in relay or mirror ⚠️ | grep-verified |
| Upload offload math | ✅ eligibility, full-copy peer detection, own-device anchor | `packages/backend/src/upload-offload.js` |
| Relay-key auto-discovery | ❌ `RELAY_ANNOUNCE` unbuilt; manual `trustedRelayKeys` only ⚠️ | `packages/backend/src/api.js:643` |
| Public feed | ✅ but single topic `peartube-network` + Protomux `peartube-feed`; `peartube-public-feed-v1` removed ⚠️ | `types.js`; `docs/plans/2026-05-08-relay-stability-contract.md` |
| Friends/invite crypto | 🟡 same-owner multi-device **write** pairing (BlindPairing invites, full encryption key handover); no read-capability sharing | `packages/backend/src/channel/multi-writer-channel.js`, `pairer.js` |
| LAN discovery | ❌ plan only (`docs/LAN_DISCOVERY_PLAN.md` "FUTURE") ⚠️ | no `lan-discovery.js` in backend |
| Docker packaging | ✅ multi-arch relay image + compose incl. local-mirror mount | `packages/cli/Dockerfile`, `docker-compose.local-relay.yml` |

### 4.2 HiveRelay

| Building block | Verified state | Evidence |
|----------------|----------------|----------|
| Generic seed API | ✅ **shipped** — publisher-signed seed requests (Ed25519, domain `hiverelay.seed-request.v3`) over Protomux `hiverelay-seed` or `POST /api/v1/seed`; `unseedRequest` / `POST /api/v1/unseed`; operator `POST /seed-core` for bare cores | `00-core/hiverelay/packages/core/core/protocol/seed-request*.js`, `relay-node/seeder.js` |
| Request vocabulary | ✅ `appKey`, `discoveryKeys[]`, `replicationFactor` (3), `maxStorageBytes` (default **500 MiB** — media must set explicit sizes), `ttlSeconds` (30 d), `durability` (1 = archive), `type:'media'`, `storageClass`, `availabilityClass`, `privacyTier`, `revocable`, `unseedFreezeMs` | `seed-request-builder.js`, `constants.js` |
| Accept modes | ✅ `open / review / allowlist / closed`; **appliance default `review`** (HomeHive doc claims auto-accept for local requests — discrepancy to resolve in packaging, see PT-SEED-006) | `accept-mode.js`; packaging env `HIVERELAY_ACCEPT_MODE=review` |
| Client SDK | ✅ `seed() / unseed() / getDurableStatus() / waitForDurable()`; trustless `verifySeeded()` / `proveSeeded()` (proof-of-retrievability) | `p2p-hiverelay-client` README |
| HomeHive mode | ✅ 32 conn / 25 Mbps / 10 GB defaults; mDNS `_hiverelay._tcp.local`; 16-byte 5-min single-use pairing tokens; transport-level allowlist gating (unknown devices silently dropped); encrypted config backups | `00-core/hiverelay/docs/HOMEHIVE.md` |
| Six operating modes | ✅ Standard / HomeHive / Seed Only / Relay Only / Stealth (Tor) / Gateway, live-switchable | HOMEHIVE.md, `POST /api/manage/mode` |
| Appliance packaging | 🟡 Umbrel/StartOS/TrueNAS/Unraid/ZimaOS/HexOS/Runtipi bundles exist in-repo and validated, but **none accepted in official stores yet**; live distribution = npm/GHCR + raw systemd fleet | `hiverelay-truenas-community/README.md` status table |
| Blind substrate (`CORE.MIRROR/PROVE/OPEN_REPLICATION`, `CELL`) | 🟡 spec complete, implementation underway, `@hiverelay/blind-daemon` at `0.0.0-draft.1` — **not a shippable dependency** | `v1-integration/packages/blind-daemon/` |
| Seeding economics | ❌ deliberately deferred (bounty/lease primitives exist without billing; HiveMesh custody/witness = "not next release") | Hiverelay audit report, options section |

### 4.3 Conceptual stack (unchanged, with the glue now named)

```text
┌──────────────────────────────────────────────────────────┐
│ 1. LIBRARY — files on disk (TrueNAS pool, Umbrel volume) │
│    Operator owns selection and retention of originals    │
└────────────────────────────┬─────────────────────────────┘
                             │ opt-in read-only mounts
┌────────────────────────────▼─────────────────────────────┐
│ 2. MEANING — peartube-seeder (publisher agent)           │
│    scan → import → channel keys → publish → inventory    │
│    → unseed · owned by PearTube, PearTube release cadence│
└────────────────────────────┬─────────────────────────────┘
                             │ publisher-signed seed requests
                             │ (opaque core/drive keys, type:'media')
┌────────────────────────────▼─────────────────────────────┐
│ 3. AVAILABILITY — HiveRelay seed-request admission,      │
│    custody, proof-of-retrievability · blind to content   │
└──────────────────────────────────────────────────────────┘
```

---

## 5. Product loop (unchanged narrative, honest mechanics)

```text
Home media library
        │  operator picks folders (read-only mounts; never whole pools)
        ▼
peartube-seeder publisher agent
        │  import → channels → publish; signed seed request per drive/core
        ▼
Local HiveRelay (Blindspark)  ──  operator approves once (review mode)
        │  durable custody; verifySeeded/proveSeeded on demand
        ▼
PearTube consumers (watch, reseed, offload against trusted home anchor)
```

**One-line pitch (unchanged):** Install HiveRelay on your NAS. Optionally enable PearTube Seeding. Choose folders and a mode. Your box keeps those videos online for the audience you chose — without shipping your library to a company server.

---

## 6. Architecture decision (was: implementation options)

v0.1's options A–F were reviewed. The matrix survives (§7 of v0.1) but the evidence collapses it to one composite with named components. Recorded verdicts:

### A′ — Publisher agent + shipped seed-request API ✅ **adopted (A revised)**

v0.1's Option A ("sidecar seeder + HiveRelay durability") survives with one decisive reframe. The deprecation of `peerit-seeder` established that a *durability sidecar* is the wrong shape — durability belongs to the fleet. But PearTube's problem is not (only) durability: **library import, channel identity, publish, inventory, and unseed are app meaning that must run somewhere client-side**, and no fleet service may own them under the service contract. That somewhere is the publisher agent.

- Seeder mounts selected media read-only; runs `local-drive-mirror` scan/import/publish.
- For every published drive/core it issues a **publisher-signed seed request** to the local HiveRelay (`type:'media'`, `durability:1`, explicit `maxStorageBytes`, `storageClass:'persistent'`, `availabilityClass:'always-on'`).
- After `waitForDurable()`, the agent's job for that content is *writer-only* (updates, unseed); the relay is the always-on origin. Proof standard: fresh client streams while the seeder process is stopped (the Peerit audit's PI-AUDIT-001 bar).
- Failure domains stay separate (agent crash ≠ relay crash); versions decouple exactly as the service contract requires (feature-detect, degrade).

### B — HiveRelay-native plugin ❌ **rejected, now by contract not just taste**

The adoption contract says "there is intentionally no relay-side adapter API" and the audit's HR-AUDIT-002 finding pushes the appliance the other way (narrower, not broader). Not a time-boxed compromise candidate anymore; simply out.

### C — Blind adapter ✅ **confirmed trajectory, now with a named contract**

PearTube is already inventoried in the blind ecosystem migration matrix: families `CELL, INBOX, CORE, FORWARD`; retained client-side semantics "channels, video manifests, comments, subscriptions, moderation, playback policy"; legacy deps to migrate off (`seed-storage-gateway`, `catalog-federation-index`, `notify`); rollout track `content-publication`. The publisher agent is the natural home of the future adapter — encrypted media chunks become `CELL`s, catalogs ride signed `CORE`s. **Do not build against the draft blind daemon yet** (`0.0.0-draft.1`); do keep the agent's relay-facing surface behind one small module so the seed-request path can be swapped for `CORE.MIRROR` later without touching operator UX.

### D — Watch-folder / mounted-folder ✅ **adopted; it already exists**

`--local-mirror-path` + `docker-compose.local-relay.yml` (read-only `~/peartube-local-videos:/mirror:ro`) *is* Option D. It remains both the v0 path and the permanent advanced mode.

### E′ — Audience modes, mapped to real config ✅ **adopted with renames**

| v0.1 said | v0.2 reality | Notes |
|-----------|--------------|-------|
| `home` | PearTube `--mode private` (+ HiveRelay HomeHive posture) — content published to channels but **never announced** on the public feed; access via paired devices | LAN-only delivery is **not** available in v1 (PearTube LAN discovery unbuilt); pairing works over DHT and needs internet. Honest label: "Private (my devices)", not "LAN-only". |
| `public` | PearTube `--mode public` + public feed announce over `peartube-network` | Typed confirmation before first public publish (non-negotiable #6). |
| `friends` | **Deferred (v1.1+)** — existing crypto is same-owner *write* pairing; sharing with friends needs a read-capability layer that doesn't exist | Under blind substrate this likely arrives as sealed-`CELL` capability sharing; don't hand-roll a interim scheme. |
| `hybrid` | Deferred with friends | |

### F — Capacity donation ✅ **adopted as parallel toggle; mostly shipped**

`peartube-relay --mode public --policy allowlist|discovery` with the published Docker image is Option F today, minus quota *enforcement* (PT-SEED-004 must land first — a donation node that can't evict will eat the disk). Two independent toggles, exactly as v0.1 proposed:

- Toggle 1: *Publish selected local media as my channels* (the new work)
- Toggle 2: *Donate capacity to network channels* (existing relay, needs eviction wired)

---

## 7. Detailed near-term architecture (A′ composite)

### 7.1 Components

| Component | Responsibility | Does not |
|-----------|----------------|----------|
| **Media volumes** | Store originals (read-only into agent) | Know about PearTube |
| **peartube-seeder (publisher agent)** | Scan, fingerprint (persisted), import, channel keys, publish, issue/withdraw seed requests, inventory + status API, unseed, caps | Hold long-term custody once relay is durable; own relay policy |
| **hiverelay (Blindspark)** | Generic admission (review/allowlist), custody, proof-of-retrievability, capacity/mode management, accounting | Parse video, folders, channels, codecs — receives opaque keys only |
| **PearTube clients** | Discover (if public), stream sparse, verify, offload against trusted home anchor, manage inventory via pairing | Require the NAS UI |

### 7.2 Minimal viable data flow

```text
1. Operator mounts /mnt/media/Movies/Public read-only into peartube-seeder.
2. Agent scans (poll; inotify later), imports, publishes channels
   (per-folder channel keys under one operator identity — see D5).
3. Agent sends publisher-signed seed request per drive to local HiveRelay:
   { type:'media', durability:1, maxStorageBytes:<real size>, ttl, revocable:true }.
4. First run in appliance `review` mode: operator approves the agent's
   publisher key once; packaging may flip that folder of requests to
   allowlist thereafter.
5. mode=public → announce channel on peartube-network public feed.
   mode=private → no feed announce; paired devices only.
6. Agent polls getDurableStatus()/waitForDurable(); marks inventory rows
   "durable @ relay <key>"; exposes verifySeeded() re-checks in status.
7. Clients with the home relay key in trustedRelayKeys treat it as a
   standalone durable anchor for upload offload.
8. Operator sees inventory: N videos, X GB, mode, durable-state, last errors.
   Unseed = agent withdraws seed request (unseedRequest) + unpublishes
   + removes inventory row. Originals untouched.
```

### 7.3 Volume and identity layout (unchanged from v0.1, with one addition)

```text
/data/peartube-seeder/
  identity/          # operator identity + per-folder channel keys (secret)
  state/             # PERSISTED fingerprints + inventory DB  ← was in-memory
  cache/             # optional derived assets
/media/              # read-only operator-selected mounts
/data/hiverelay/     # relay data (opaque cores) — separate corestore, never shared
```

Principles (v0.1's, plus):

- Read-only media mounts. Keys never only in ephemeral container layers.
- **Separate Corestores** for agent and relay — the relay ingests via replication under seed requests, not via a shared store (blast-radius isolation; also what the contract implies).
- Inventory supports unseed without touching originals.
- Keys live in the agent process, managed from the PearTube app over RPC — never in a renderer/UI layer (brain decision: *Renderer Delegates P2P Control To Bare Backend*).

### 7.4 Trust / offload wiring (aligned with reality)

| Source of relay key | Effect | Status |
|---------------------|--------|--------|
| Operator-configured `trustedRelayKeys` (local HiveRelay key) | Standalone durable anchor | ✅ works today — **the v1 mechanism** |
| `RELAY_ANNOUNCE` connection-bound gossip | Counts toward redundancy only | ❌ unbuilt; do not depend on it in v1 |
| Signed network allowlist | Standalone anchor for public fleet | Future |

First-run appliance glue does **both** directions: copy the local HiveRelay public key into the agent's + paired clients' `trustedRelayKeys`, and register the agent's publisher key with the relay's accept-mode allowlist (operator-approved).

### 7.5 What HiveRelay must not do (contract-verified, unchanged)

No video parsing, no channel identities, no PearTube ffmpeg policy, no PearTube-specific service in the blind ABI — and per the adoption contract, **no relay-side changes at all** for this feature to ship.

### 7.6 What the agent must do (v0.1 list + audit additions)

- Scan + content fingerprint + import idempotence — **persisted across restarts**.
- Channel publish / seed request / **unseed** (build it; it exists nowhere today).
- Retention knobs: originals always kept; optional local-cache drop after `waitForDurable()`.
- Status API: seeded count, bytes, mode, durable-state per item, errors — plus `verifySeeded` spot checks so "durable" is observable, not asserted.
- Hard caps: max GB / files / bandwidth / concurrent imports — **enforced, with tests** (the relay-side `CacheManager.enforceQuota` dead code gets wired for the donation toggle).
- Explicit lifecycle: teardown of swarm sessions, streams, and watch handles on stop (Mafintosh lens; required failure-path test).

---

## 8. Operator model and UX

### 8.1 Non-negotiable safety contract (v0.1's six + two new)

1. Opt-in folders only — never whole pools.
2. Per-folder audience mode.
3. Visible inventory (timestamps, sizes, durable-state).
4. One-click unseed — **now a build item, not an assumption (PT-SEED-003)**.
5. Caps with HomeHive-conservative defaults — **enforcement wired, not just reported (PT-SEED-004)**.
6. No silent mode escalation — public requires typed confirmation.
7. **Catalog hygiene:** anything the NAS announces (titles, thumbnails, descriptions from yt-dlp sidecars or filenames) is untrusted input to clients — normalize through the constrained DTO path before render (brain decision: *Treat Catalogue Data As Untrusted Until Normalized*).
8. **Name provenance:** clients label the home relay and its channels through the petname stack (my alias → contact → raw key), so "Dad's NAS" is visibly a petname, not a global claim (brain decision: *Use Petname-First Naming*).

### 8.2 Where the UI lives — split, as v0.1 recommended, sharpened by HR-AUDIT-002

- **Appliance (Blindspark dashboard + install questions):** capacity, paths, enable toggle, seeder status link, show relay key for trust setup. It must *not* grow a PearTube catalog UI — the Hiverelay audit explicitly pushes the appliance narrower.
- **PearTube app (paired):** catalog, per-folder modes, identity, failures, unseed. Pairing uses the existing BlindPairing invite flow (works today over DHT).

### 8.3 Identity model — decision D5 recommended: per-folder channel keys under one operator identity

| Model | Verdict |
|-------|---------|
| Single house key | Rejected — muddles attribution, bad multi-user story |
| **Per-folder channel keys, one operator identity** | **Recommended** — matches how `local-drive-mirror` already groups channels (`ensureAnonymousChannel` with `sourceIdentity`), keeps key management shallow, maps 1:1 to per-folder audience modes |
| Per-user sub-identities | Correct for true multi-tenant NAS; defer until demand |

### 8.4 Transcoding — decision D6 recommended: originals-only v1

Originals-only keeps the appliance image thin (no ffmpeg in the agent container; the archive image already carries it for the yt-dlp path where needed), avoids NAS heat/CPU surprises, and matches "faithful origin" positioning. Label honestly in the client: "may require download/transcode on your device." Lazy derivatives can arrive later behind the same inventory model. Public-mode-mandatory-derivative is rejected for v1 (it couples publish latency to NAS CPU).

---

## 9. Security, privacy, and abuse (v0.1 table upheld; deltas only)

| Threat | v0.2 delta |
|--------|-----------|
| Accidental public publish | The blind-era relay *rejects* plaintext in blind namespaces — but **today's** public path is plaintext-by-design, so the only guard is the mode model: default private, typed public confirm, per-folder audience, inventory. Treat mode-handling code as security-critical with tests. |
| Malicious peer claims to be home relay | Unchanged: manual trusted key + connection-bound checks. Don't ship `RELAY_ANNOUNCE` half-built. |
| Container escape → pool write | Read-only mounts; agent runs unprivileged; separate corestores. |
| Key theft / NAS reinstall | Document identity backup; HomeHive already does encrypted config backups (XSalsa20-Poly1305) — mirror that pattern for agent identity. Losing identity orphans channels (v0.1 risk #6 stands). |
| Bandwidth shock | HomeHive defaults (25 Mbps) + agent caps; schedule windows later. |
| Illegal content on public seed | Operator responsibility UX; relay accept-mode `review` gives the *relay* operator a veto on custody; app-side moderation stays app-side. |
| Multi-tenant leakage | Per-folder keys now; per-user identities when demanded. |

Privacy defaults table from v0.1 stands verbatim (everything off/private/none by default).

---

## 10. Lens audit — findings

Design-review pass per the brain's audit framework (Mafintosh + DMC hard lenses, developer lenses from `Topics/*Engineering Lens.md`). Severity: Blocker / High / Medium / Low.

### Developer lens read

| Lens | What it asks here | Verdict | Notes |
|------|-------------------|---------|-------|
| Mafintosh (small primitives) | Is the agent one small primitive with explicit lifecycle/teardown? | watch | A′ is small; teardown + failure-path tests are named build items, not yet code |
| DMC (performance-first) | Hot paths measured? Diagnostics inspectable? | watch | Playback/import hot paths exist; status JSON good; add `verifySeeded` probes + RSS/throughput measurements (relay budgets were tuned for tiny records, media will stress them) |
| Arvid Norberg (seeding pragmatics) | Real-world seeding economics honest? | pass | Durability via fleet, no incentive dependency, full-copy proof standard |
| Filippo Valsorda (no footguns) | Can a default config leak? | pass w/ conditions | Defaults all-off/private; conditional on unseed + typed public confirm shipping |
| Kleppmann / Gritzko (state convergence) | Is import state well-defined across restarts/replicas? | fail today | In-memory fingerprints re-import on restart; persist state (PT-SEED-008) |
| trevp / Yawning (keys, metadata) | Key custody, pairing, metadata leakage | pass | BlindPairing invites, HomeHive transport gating, Stealth/Tor mode available; agent keys backend-only |
| Frazee (protocol + shippable app) | Typed schema boundary between app and agent? | watch | Reuse HRPC/spec discipline for the agent's status/control API |
| Felix Lange / Szilágyi (wire boundaries) | Stable vs experimental labeled? | pass | Seed-request v3 = stable target; blind `CORE` explicitly draft-labeled |
| Feross (cross-platform, README promise) | One-paragraph explainable? | pass | "Pick folders, pick audience, box keeps them online" |
| Juan Benet (verifiability) | Availability claims verifiable? | pass | `verifySeeded`/`proveSeeded` + fresh-client proof standard |

### Findings

| ID | Sev | Area | Evidence | Finding | Recommendation | Validation |
|----|-----|------|----------|---------|----------------|------------|
| PT-SEED-001 | High | Availability glue | `seed-request.js`, SDK README | v0.1 treated the relay handoff as unknown; it ships today, but nothing exercises it from PearTube | Build agent → `POST /api/v1/seed` integration (`type:'media'`, explicit `maxStorageBytes` — default is 500 MiB, media exceeds it) | Spike S2: fresh client streams with seeder stopped |
| PT-SEED-002 | Blocker | Modes / privacy | `config.js` VALID_MODES | `home`/`friends` modes in v0.1 config sketch don't exist; config throws | Map home→`private`, defer friends; rename UX labels honestly (no "LAN-only" claim) | Config-validation test + mode-escalation test |
| PT-SEED-003 | Blocker | Safety contract | grep: no unseed in `packages/cli` | "One-click unseed" is non-negotiable but has zero implementation; HiveRelay side (`unseedRequest`) exists | Build agent unseed: withdraw seed request + unpublish + inventory removal | Unseed round-trip test (Spike S3) |
| PT-SEED-004 | High | Quotas | `cache-manager.js` `enforceQuota` zero callers; `enableGc:false` | Relay quota reported but never enforced — donation toggle would eat the disk | Wire eviction into service loop honoring retention classes | Over-quota eviction test (Spike S4) |
| PT-SEED-005 | High | Architecture precedent | `CONTINUOUS-DEVELOPMENT-PLAN.md` (peerit-seeder deprecated) | Durability-sidecar shape was tried and reversed ecosystem-wide | Adopted A′ reframe: publisher agent delegates durability via seed requests | Design review sign-off; S2 proves the delegation |
| PT-SEED-006 | Medium | Admission UX | `accept-mode.js`; packaging `HIVERELAY_ACCEPT_MODE=review`; HOMEHIVE.md says auto-accept local | Accept-mode discrepancy: docs promise auto-accept, appliances default `review` | First-run flow assumes `review`: one operator approval of agent publisher key, then allowlist | Fresh-install walkthrough on Umbrel test device |
| PT-SEED-007 | Medium | Stale docs | `CLAUDE.md:99`, v0.1 §related | `peartube-public-feed-v1` referenced but removed ("do not reintroduce") | Fix CLAUDE.md + any docs; this doc now names `peartube-network` | grep for stale topic string |
| PT-SEED-008 | Medium | State | `service.js` fresh mirror state | Import idempotence is per-process; restart re-imports everything | Persist fingerprint/inventory DB in `/data/peartube-seeder/state/` | Restart-without-reimport test |
| PT-SEED-009 | Medium | Home mode honesty | `LAN_DISCOVERY_PLAN.md` "FUTURE" | LAN-only delivery impossible today; pairing needs internet DHT | Label private mode "my devices", note internet requirement; HiveRelay mDNS helps relay discovery, not PearTube peer discovery | UX copy review |
| PT-SEED-010 | Low | Catalog trust / naming | Brain decisions (catalogue-untrusted, petname-first) | NAS-announced metadata is a new wide untrusted catalog source | Normalize sidecar/filename metadata into constrained DTO pre-render; petname provenance for home relay identity | Malformed-sidecar fuzz test |

### Audit dimension checklist (12 dimensions)

| Dimension | Status | Note |
|-----------|--------|------|
| Product boundary | pass | One sentence: "publisher agent that turns opted-in folders into PearTube channels and delegates availability to HiveRelay" |
| P2P topology | pass | Discovery/replication/relay/offline states all named; single-topic model respected |
| Data ownership | pass | Writers (agent), readers, keys, storage roots, revocation (unseed) explicit |
| Lifecycle & backpressure | watch | Teardown + failure tests are planned, must land in Phase 1 |
| API & package surface | watch | Agent status/control API should ride the existing HRPC/spec codegen |
| Hot-path performance | watch | Media sizes vs relay budgets need measurement (S2 collects numbers) |
| Runtime compatibility | pass | Bare/Node surfaces named; multi-arch image exists |
| Security & privacy | watch | Blocked on PT-SEED-002/003 closing |
| Availability & relay | pass | Observable: durable-state per item, verifySeeded probes, fresh-client proof |
| Diagnostics & operations | pass | Status JSON + relay accounting; add probe results to status |
| Tests & proofs | fail today | The named validations don't exist yet; each finding carries one |
| Docs & examples | watch | This doc + compose examples; needs operator quickstart at Phase 2 |

---

## 11. Packaging (revised by HR-AUDIT-001 lesson)

The Hiverelay audit's only Blocker was external distribution evidence (npm latest, GHCR digests, Umbrel/StartOS review) — the slowest, most fragile part of appliance shipping. Consequences:

1. **Do not gate this feature on any store approval.** No Blindspark bundle is in an official store yet; PearTube shouldn't queue behind that. The live paths are GHCR images + compose.
2. **Two apps, one compose profile.** `ghcr.io/ayooooo123/peartube-relay` already exists and is multi-arch; ship an umbrella compose (peartube-seeder + blindspark, shared network, read-only media mounts) as the reference install, and per-platform templates (TrueNAS chart, Umbrel app) as they mature *alongside* HiveRelay's store submissions — riding the same evidence sidecars rather than creating a second backlog.
3. **Version coupling rule (unchanged, contract-mandated):** agent feature-detects relay capabilities (seed API present? blind CORE present?) and degrades gracefully; neither side's upgrade forces the other.

---

## 12. Decisions D1–D8 — recommended answers

| # | Decision | Recommendation | Grounding |
|---|----------|----------------|-----------|
| D1 | Primary v1 story | **Both, as separate toggles** — publish (new work) + donate (mostly shipped, needs eviction) | §6 F; existing public relay |
| D2 | Default audience | **Private default, public opt-in with typed confirm** | Privacy defaults; PT-SEED-002 |
| D3 | Process topology | **Sidecar publisher agent (A′)** — plugin rejected by contract | Adoption contract; PT-SEED-005 |
| D4 | UI ownership | **Split** — appliance: capacity/paths/enable; PearTube app: catalog/meaning | HR-AUDIT-002; §8.2 |
| D5 | Identity | **Per-folder channel keys under one operator identity** | Matches `ensureAnonymousChannel` grouping; petname-first |
| D6 | Transcode v1 | **Originals only**, honest playback labeling; lazy derivatives later | §8.4; image weight; NAS CPU |
| D7 | Media-server integration | **Folder mounts + watch-folder v1** (already implemented); Jellyfin/Plex export helper later | §6 D |
| D8 | Programme priority | **Not parked — schedule as PearTube's Lane C live-wiring step.** PearTube sits last in the live-wiring queue with "bridge drafts, no live relay"; this design is precisely that wiring. Recommend: run spikes S1–S4 under the existing queue slot rather than as a new programme | Brain: CONTINUOUS-DEVELOPMENT-PLAN Lane C/D; no parking Decision exists |

---

## 13. Phased delivery (proof-driven rewrite)

### Phase 0 — Spikes with exit criteria (each maps to a finding)

| Spike | Exit criterion | Closes |
|-------|----------------|--------|
| S1 | `peartube-relay mirror-local` against a sample mount: import + seed N videos, stable status JSON | baseline (exists — verify) |
| S2 | Agent seed request → local Blindspark (`review` mode) → operator approve → `waitForDurable()` → **stop agent → fresh client streams** | PT-SEED-001, -005, -006 |
| S3 | Unseed round-trip: agent withdraws (`unseedRequest`), unpublishes, inventory row gone, originals untouched | PT-SEED-003 |
| S4 | Wire `CacheManager.enforceQuota`; over-quota channel evicted by retention class, test green | PT-SEED-004 |

### Phase 1 — Headless publisher-agent MVP
Persistent fingerprint/inventory state (PT-SEED-008); config schema with real modes (`private|public`, per-folder audience); manual `trustedRelayKeys`; caps enforced; status API on HRPC codegen; lifecycle teardown + failure-path tests.

### Phase 2 — Appliance glue
Umbrella compose next to Blindspark; first-run bidirectional trust (relay key → agent+clients trusted set; agent publisher key → relay allowlist via one operator approval); HomeHive-aligned cap defaults; operator quickstart doc.

### Phase 3 — Client pairing UX
PearTube app pairs to agent (existing BlindPairing invites); inventory/modes/unseed from the app; offload treats trusted home relay as standalone durable anchor (already supported by `trustedRelayKeys` path).

### Phase 4 — Hardening & trajectory
Friends read-capability sharing (aligned with blind-substrate capability model — don't hand-roll); optional lazy transcode; public capacity donation polish; swap agent's relay-facing module from seed-request v3 to blind `CORE.MIRROR` when the daemon leaves draft — operator story unchanged.

---

## 14. Remaining open questions (was 8, now 3)

1. **Sparse vs full on donated capacity** — the public relay design mandates full mirror per admitted channel; for *donated* capacity that may be too heavy on 10 GB HomeHive defaults. Options: keep full-mirror + small `maxChannels`, or wait for blind-era per-cell admission. (v0.1 Q3, still open.)
2. **Accept-mode packaging default** — resolve the HOMEHIVE.md "auto-accept local" vs packaging `review` discrepancy: recommend `review` for first approval then per-publisher allowlist; needs HiveRelay packaging owner's sign-off (their repo, their call — the fix is packaging config, not relay code).
3. **Multi-tenant NAS identities** — per-user sub-identities deferred; revisit when a real multi-user request appears.

Resolved since v0.1: glue mechanism (shipped seed API), corestore layout (separate stores, replication handoff), NAT/connectivity posture (HomeHive tunnel + Stealth mode exist relay-side; PearTube LAN discovery honestly deferred), multi-arch/ffmpeg (originals-only keeps agent image thin), programme status (not parked; Lane C slot), blind-cutover alignment (migration-matrix entry is the contract).

---

## 15. Appendix A — Config sketch (v0.2, aligned to real modes)

```yaml
# peartube-seeder.yml (illustrative — not normative)
mode: private              # private | public   (v0.1's home/friends removed)
media:
  - path: /media/PublicMovies
    recursive: true
    audience: public       # per-folder override; requires typed confirm once
  - path: /media/Family
    recursive: true
    audience: private
caps:
  maxBytes: 500_000_000_000
  maxFiles: 5000
  maxBandwidthMbps: 25     # HomeHive-aligned default
  pollSeconds: 300
identity:
  dir: /data/peartube-seeder/identity   # operator identity + per-folder channel keys
state:
  dir: /data/peartube-seeder/state      # persisted fingerprints + inventory
trust:
  durableRelayKeys:
    - "<local-hiverelay-swarm-public-key-hex>"   # injected on first-run pairing
seedRequest:
  durability: 1            # archive
  ttlSeconds: 2592000
  revocable: true
publish:
  requireExplicitPublic: true
```

## 16. Appendix B — Glossary (v0.1's, three updates)

| Term | Meaning |
|------|---------|
| **Publisher agent** | The `peartube-seeder`: app-side importer/publisher that delegates availability via seed requests (replaces v0.1's "seeder-as-custodian" framing) |
| **Seed request** | HiveRelay's shipped, publisher-signed admission message (`hiverelay.seed-request.v3`) carrying opaque core/drive keys + capacity terms |
| **Durable anchor** | Trusted full-copy relay that alone justifies upload offload — v1 mechanism is manual `trustedRelayKeys` |
| *(all other v0.1 glossary entries stand)* | |

## 17. Appendix C — Document history

| Version | Date | Notes |
|---------|------|-------|
| 0.1 | 2026-07-24 | Initial options doc for review from product exploration |
| 0.2 | 2026-07-24 | Synthesis: lens audit (design-review mode) against ecosystem brain + live HiveRelay contracts + PearTube code. Options collapsed to A′+D+E′+F composite with C trajectory; D1–D8 answered; findings PT-SEED-001..010; proof-driven phase plan. v0.1 preserved in session archive. |

## 18. Review checklist (for commenters)

- [ ] A′ reframe (publisher agent, durability delegated) acceptable vs deprecated sidecar precedent
- [ ] Mode mapping (`private|public`, friends deferred, no LAN-only claim) acceptable
- [ ] Blockers PT-SEED-002/003 agreed as ship-gates for any release
- [ ] Spike S2 agreed as the first proof
- [ ] D1–D8 recommended answers ratified or amended
- [ ] Packaging: umbrella compose now, stores later, no new evidence backlog

**Comment template:**

```text
Decision: ratify composite | amend (specify) | spike first | defer
D1-D8 deltas: ...
Blockers: ...
Must-change in doc: ...
```
