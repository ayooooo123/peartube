# Local-Client Content Moderation — Design

**Status:** Draft / proposal — revision 4 (second review pass)
**Date:** 2026-06-26
**Author:** Claude (with @ayooooo123)
**Branch:** `claude/local-client-moderation-spec-fh5rnx`

---

## 0. Revision history

- **Rev 1** — pure composable moderation (local self-classification + opt-in subscribed
  labelers + local enforcement); deliberately excluded crowd signals.
- **Rev 2** — design dialogue: fail-open + mandatory visibility badge; crowd signal added
  but split into sybil-resistant trusted-set enforcement vs forgeable advisory-only counts;
  local model = ground truth, instant only for on-device content; thumbnails are a weak
  first pass; classifier fed raw RGB to dodge transformers.js image-decode fragility.
- **Rev 3** — hardened against a structured spec review. Material changes:
  1. **Connected peers removed from the enforcement trust set** (a connection is not a
     scarce identity → sybil hole). Trust set = default relays ∪ explicit subscriptions
     only; connected peers may be *manually promoted*, never auto-counted (§2).
  2. **Effective verdict is now a severity lattice, not "first hit wins."** Affirmative
     signals only ever *raise* severity; weak/unknown/safe never lowers it; advisory counts
     never enter enforcement; the final action is mapped through `mode` + per-category
     policy + thresholds. Removes the case where a sparse local false-negative suppressed a
     dense trusted relay label (§3.3).
  3. **Advisory `flagSummary` can never influence enforcement** — the resolver's `action`
     is the *only* enforcement output; advisory data is display-only (§3.3, §11).
  4. **Concrete label transport.** Each labeler owns an append-only **label feed**
     (Hyperbee on a Hypercore) advertised by labeler key; subscribers replicate selected
     feeds; relays serve a bounded `get-content-labels`. Replaces the hand-wavy "pull RPC"
     (§3.2).
  5. **Revocation / expiry / model-version invalidation.** Labels carry id + `expiresAt` +
     supersession; local verdict cache is keyed by `classifierVersion` and invalidated on
     model upgrade. Nothing is "trusted forever" (§3.1, §3.2, §8).
  6. **Seeding is fail-*closed* for relays/CLI**, opposite of the viewer's fail-open: a
     relay downloads the whole file, so it classifies densely and **quarantines** content
     until a verdict exists; flagged or (by default) unknown content is never durably
     seeded; a verdict-change hook unseeds already-active blobs (§3.3, §6).
  7. **A runtime-feasibility spike (Phase 1a) gates Phase 1.** transformers.js still imports
     `sharp`/`onnxruntime-node`/`onnxruntime-web` at module scope; bypassing image-decode
     does not prove ORT-WASM loads in BareKit. Phase 1 is contingent on a measured spike;
     on failure we go straight to native bindings (§5.1, §10).
- **Rev 4 (this)** — second review pass refinements: the resolver is now a **total**
  function with an exact category→action table (weak/thumb-only never `hide`; D9); labels
  drop the redundant `id`, supersede by the `(labeler,target,category)` triple ordered by
  `seq` (D10); a labeler's identity **is** its label-feed core key, self-labels separated
  onto the channel-writer path (§9, D11); thresholds count **distinct trusted labeler keys**
  (D14); seeder quarantine respecified as a **pre-admission state** against the real
  `addSeed` (which commits immediately) with the Corestore global-replicate caveat, and
  Phase 1 scoped **strictly local** (§3.3, D15); resolved-cache gains wall-clock `validUntil`
  (§8).

Decision log + open questions: §13.

---

## 1. Problem & goals

PearTube discovers *all* public content via gossip on `peartube-public-feed-v1`. There is
no central authority and we never want one: anyone can publish anything, and we cannot —
and do not want to be able to — prevent uploads or sharing.

But "no central authority" must not mean "every user is force-fed explicit content."
A user who opts out of sexually explicit material should not see it; the app must make it
*clear* when content might be NSFW; and **relays/seeders must be able to decline to
replicate** content they don't want to host.

### Goals

- **G1 — Local-first ground truth.** Every client can decide, on its own, whether content
  it has on disk is NSFW, with zero trust in anyone else.
- **G2 — Invisible & efficient.** No 2 GB model. Single-digit-MB classifier, runs off
  frames we *already* decode, on a background thread, never blocking playback or the feed.
- **G3 — Viewer fail-open.** On *viewer* clients, unrated content is shown. A verdict only
  ever removes/blurs content *after* it exists. No "classifying…" gates. (Seeders are the
  opposite — see G7.)
- **G4 — Always make NSFW-likelihood visible.** When any signal (local model, trusted
  label, advisory crowd count) suggests NSFW, surface a clear badge — even in show mode.
- **G5 — Shareable hints (labels).** A client (especially a relay that downloaded the whole
  file) can publish a signed label so other clients pre-hide content *before downloading
  frames*.
- **G6 — Trust is opt-in and composable; crowd signal is sybil-resistant.** Auto-enforcing
  thresholds count only verified labels from a *trust set* (default relays ∪ explicit
  subscriptions). Raw anonymous counts are advisory-only and never auto-enforce.
- **G7 — Seeder fail-closed.** A relay/seeder/CLI flips one switch (`seedFlagged=false`,
  default) and never durably replicates flagged content; by default it also declines
  *unknown* content until it classifies it. It quarantines while classifying and unseeds on
  an adverse later verdict.
- **G8 — User override always wins**, in both directions (reveal hidden, hide shown).

### Non-goals

- Preventing uploads or takedowns of content from the network (impossible and undesired in
  a P2P system).
- A global reputation/consensus system, or treating raw anonymous crowd counts as
  authoritative. The label format leaves room for reputation later (§13 Q3).
- Perfect classification. We target high-recall NSFW-explicit detection with a conservative
  bias, not legal-grade accuracy.

---

## 2. The hard part: trust, not detection

NSFW *detection* is a solved, small problem (§5). The architectural risk is the **trust
model**. A "flag" in a decentralized network is just a claim by some peer. Get it wrong and
you build either a **censorship lever** (one actor hides content for everyone) or **noise**
(flags nobody trusts).

We adopt **AT Protocol / Bluesky "composable moderation"** — content carries no
authoritative rating; independent labelers emit signed labels; each client enforces locally
and can always override — extended with a **sybil-resistant** crowd signal.

> **Enforcement uses only signals the client can verify or compute itself**, combined by a
> severity lattice (§3.3): the user's override, the client's own local-model verdict, a
> verified uploader self-label that flags *up*, and the count of *verified signed labels
> from the trust set*. Raw anonymous flag counts are shown but **never** auto-enforce.

### The trust set (enforcement)

"Hide if N people flagged it" is trivially defeated: one attacker mints N keypairs at zero
cost and buries any target. So auto-enforcing thresholds count flags **only** from keys
that cost something to be:

- **Default relay labelers** — relays run real infrastructure and seed content → expensive
  to sybil at scale. A small set of relay labeler keys ships with the app
  (editable/removable). *(Default-set choice flagged for review — §13 D3a.)*
- **Explicit subscriptions** — labelers the user added by key.

**Connected peers are NOT in the enforcement trust set** — a peer connection is not a
scarce identity (an attacker opens many connections cheaply). A connected peer's flags are
advisory-only unless the user *manually promotes* that peer's key into `trustedLabelers`.

Flags from outside the trust set are advisory-only (§3.2).

---

## 3. Architecture: three layers

```
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 1 — LOCAL SELF-CLASSIFICATION  (zero trust)        │
            │  bare-ffmpeg RGB24 frames → tiny NSFW model (bare-worker) │
            │  multi-frame; thumbnail = weak first pass, not verdict    │
            │  → verdict cached in metaDb, keyed by classifierVersion   │
            └──────────────────────────────────────────────────────────┘
                                   │ produces
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 2 — SIGNED LABELS  (trust set + advisory crowd)    │
            │  labeler-owned append-only label FEED (Hyperbee/Hypercore)│
            │  self-label rides feed-entry (verified writer);           │
            │  advisory boolean rides HAVE_FEED (forgeable, display-only)│
            └──────────────────────────────────────────────────────────┘
                                   │ informs
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 3 — LOCAL ENFORCEMENT (severity lattice + override)│
            │  action = resolve(override, local, selfLabelUp, trusted)  │
            │  • view filter (viewer): show+badge | blur | hide         │
            │  • seed filter (relay/CLI): quarantine → seed | evict     │
            └──────────────────────────────────────────────────────────┘
```

### 3.1 Layer 1 — Local self-classification (zero trust)

A tiny vision classifier runs **on-device** against frames we already decode. This is
**ground truth for that user** — the uploader cannot game it because *the user ran it
themselves*.

- **Frame source — a NEW raw-RGB helper, not the thumbnail encoder.** `generateThumbnail`
  (`packages/backend/src/thumbnail.js:215`) selects an image-encoder pixel format and
  encodes a still (JPEG/WebP). The classifier needs *raw* pixels, so add a sibling helper
  that reuses the `ff.InputFormatContext` / `ff.Scaler` / `ff.Frame` decode but:
  - scales to the model input (e.g. 224×224, **RGB24**, no encoder),
  - samples by **timestamp/keyframe across the duration** (not a fixed frame index),
  - **copies frame bytes before `unref`**, and transfers the `ArrayBuffer`s to the worker
    (zero-copy handoff, no extra allocation).
- **Two passes:**
  - **Weak first pass:** classify the thumbnail blob (already decoded for display) for an
    *immediate* feed signal. Cheap — the thumbnail is a separate content-addressed
    Hyperblobs blob (`thumbnailBlobsCoreKey`), a few KB, fetched independently. **The
    thumbnail pass may only raise severity to `blur`, never `hide`** (it's a single dumb
    frame).
  - **Authoritative pass:** sample N frames (default 3–5 viewer-side) from whatever video
    bytes are local; verdict = **max over frames**. May reach full policy (incl. hide).
  - **Relays sample densely** across the whole file (§6) → high-confidence labeler.
- **Cache & invalidation:** verdict stored in `metaDb` under
  `moderation:self:<blobsCoreKey>` with the producing `classifierVersion` and a timestamp.
  On model upgrade (`currentClassifierVersion !== cached.classifierVersion`) the cached
  verdict is treated as stale and recomputed in the background; it is **not** "trusted
  forever." `blobsCoreKey` is content-addressed so a verdict can never be redirected.
- **Thread & failure mode:** runs in the `bare-worker` pool; never blocks the RPC/feed loop.
  **Viewer fail-open:** model failure / not-yet-run ⇒ verdict `unknown` ⇒ content shown.
  Model-load failure is surfaced via diagnostics (coverage dropped), not to the feed.

### 3.2 Layer 2 — Signed labels (trust set + advisory crowd)

A `content-label` is a verifiable, standalone claim — **not** stored on the uploader's
channel — so an uploader can neither forge nor suppress third-party labels.

```
content-label {
  // Identity: a third-party labeler IS its label-feed Hypercore key; a self-label uses the
  // channel-writer key. labelerKeyHex == that public key; the signature verifies against it.
  labelerKeyHex      : string    // labeler identity = label-feed core key | channel-writer key
  source             : string     // "relay" | "user" | "self"
  seq                : uint        // labeler's monotonic sequence; latest wins per (labeler,target,category)
  targetBlobsCoreKey : string      // content-addressed identity of the video blob
  videoId            : string
  channelKey         : string
  category           : string      // taxonomy §6
  score              : float        // classifier confidence 0..1
  classifierVersion  : string       // "nsfw-mnv2-int8@1" | "self-report" | "manual"
  createdAt          : uint
  expiresAt          : uint          // 0 = no expiry; clients ignore expired labels
  revoked            : bool           // higher-seq revoked record tombstones the (labeler,target,category) triple
  signature          : string         // sign(labeler secret, canonical(label-minus-signature))
}
```

- **Binding:** the signature covers all fields incl. `targetBlobsCoreKey`, so a label can't
  be lifted onto other content. Canonical signing bytes = compact-encoding of all fields
  except `signature`, identical in JS and Swift (golden vector committed, §7).
- **Transport — labeler-owned feeds (concrete):**
  - **A third-party labeler's identity *is* its label-feed core.** Each labeler maintains an
    append-only label feed (a Hyperbee over a Hypercore); the feed's public key *is*
    `labelerKeyHex` and the key labels are signed with. Discovery, replication, and
    signature verification all key off this one identity — no separate signing/feed keys, no
    new PKI.
  - **Subscribing** = replicating that feed (selectively, by the blobs/channels the client
    cares about) and adding its key to `trustedLabelers`.
  - **Relays** (the high-signal default labelers) expose a bounded `get-content-labels`
    `{ channelKey | blobsCoreKey }` over the existing RPC, backed by their own label feed.
  - **Self-labels take a *separate* path** — they ride the channel's `feed-entry` (≤1 tiny
    label by the uploader), are *not* third-party feed labels, and carry `source:"self"`
    with `labelerKeyHex` = the authorizing channel-writer key (authz below).
  - **Advisory hint** in `HAVE_FEED`: a *boolean-ish capped* `flagHint`
    (`{ nsfwExplicit: bool, nsfwSuggestive: bool }`, optionally a coarse bucket) — forgeable,
    **display-only**, feeds the badge, never enforcement. (We deliberately do *not* gossip
    exact counts; see §13 Q4.)
- **Import / verification (done at import time, off the hot path):**
  - **Verify signature**, drop on failure.
  - **Self-label authorization:** honor a self-label only if `labelerKeyHex` is an
    authorized writer for `channelKey` (per `multi-writer-channel.js` `VALID_WRITER_ROLES`)
    **and** it flags *up* (toward more restrictive). A self-label claiming "safe", or from a
    non-writer, is ignored.
  - **Supersession/expiry:** per `(labelerKeyHex, targetBlobsCoreKey, category)` keep only
    the **highest-`seq`** record; a higher-`seq` `revoked` record tombstones it; expired
    (`expiresAt` past) records are ignored. There is no separate `id` — the triple is the
    stable identity and `seq` the order.
  - **Quotas (§8):** store one effective record per `(labeler, category)` (latest seq);
    cap untrusted labelers per blob; bounded canonical payload; verify-before-persist.
  - **Counting:** thresholds count **distinct trusted labeler keys** (not labels) holding an
    effective ≥-category record — so one labeler can't inflate a count. A labeler counts only
    if its key ∈ `trustedLabelers`; every other verified label is advisory-only.

### 3.3 Layer 3 — Local enforcement, severity lattice, override

Each client holds a **moderation policy** (local, in `metaDb`):

```
moderation-policy {
  mode             : "off" | "blur" | "hide"   // master switch; default "blur"
  categories       : { <category>: "show"|"blur"|"hide" }
  trustLocalModel  : bool                        // default true
  trustedLabelers  : string[]                    // labelerKeyHex; seeded w/ default relays
  blurThreshold    : uint                         // trusted labels (per category) → at least blur; default 1
  hideThreshold    : uint                         // trusted labels (per category) → hide; default 3
  showAdvisoryBadge: bool                          // show "unverified peers flagged" badge; default true
  // seeder-only (relays/CLI):
  seedFlagged      : bool                          // replicate flagged content? default false
  seedUnknown      : bool                          // replicate not-yet-classified content? default false
}
```

**Effective verdict — a total resolver over a severity lattice (replaces "first hit
wins").** Pure and **local-cache-only** (no model exec, no network, no signature
verification — those happen at import time). Inputs per video: `override`, `localVideo`
(authoritative pass verdict | none), `localThumb` (weak pass | none), `selfLabelUp`
(verified | none), and `trustedCount[c]` = distinct trusted labeler keys with an effective
label of category ≥ `c`.

1. **Override short-circuits:** `show` ⇒ `{action:"show"}`; `hide` ⇒ `{action:"hide"}`.
2. If `mode=="off"` ⇒ `{action:"show", badge}`.
3. **Pick the strongest category** `C ∈ {explicit, suggestive, none}` by *raising* over the
   affirmative signals — `localVideo` and `localThumb` (if `trustLocalModel`), `selfLabelUp`,
   and any `c` with `trustedCount[c] ≥ blurThreshold`. Unknown / "safe" / expired / advisory /
   negative signals contribute nothing (the lattice only raises). Set `weakOnly = true` iff
   every signal contributing to `C` is weak — i.e. only `localThumb` and/or
   `trustedCount[C] < hideThreshold`, with no authoritative `localVideo` and no `selfLabelUp`.
4. If `C == none` ⇒ `{action:"show", badge}`.
5. **Map `C` to an action via this exact table, then clamp:**

   | condition (for category `C`) | base action |
   |------------------------------|-------------|
   | `trustedCount[C] ≥ hideThreshold` | `hide` |
   | otherwise | `policy.categories[C]` (default: explicit→`blur`, suggestive→`show`) |

   then, in order: if `weakOnly` and the action is `hide`, **downgrade to `blur`** (weak
   signals never hide); finally **clamp by `mode`** — `mode=="blur"` caps the result at
   `blur`, so `hideThreshold` and a per-category `"hide"` only produce an actual `hide` when
   `mode=="hide"`. (Default `mode:"blur"` therefore never hides, only blurs.)

   Consequences: a single trusted label ⇒ `blur`, never `hide`; `hide` needs `hideThreshold`
   distinct trusted labelers **or** the user setting `categories[C]="hide"` (their own choice,
   applied to their own authoritative/self signals — not `weakOnly`, so not downgraded). The
   local model never auto-hides under the default `blur` policy. See §13 D3a/NB2.

**Advisory counts never affect `action`.** They populate only `moderation.badge`.

**Enforcement points:**

1. **View filter (viewer)** — `api.js` `listVideos()` / feed assembly (`api.js:1428`). This
   path is hot and cached, so it calls only the pure resolver against pre-computed local
   caches — **no model run, no network pull, no bulk verification here.** Each video gets a
   `moderation` field `{ action, category, source, score, badge }`. `hide` drops it; `blur`
   returns it flagged for tap-to-reveal; `show` passes through (badge still rendered).
   Policy/label/verdict changes **invalidate** cached lists (or post-filter) rather than
   caching already-filtered results.
2. **Seed filter (relay/CLI) — fail-closed, Phase 2.** `addSeed` (`seeding.js:214`)
   *immediately* commits to `activeSeeds` + `persistSeeds()`, and Corestore replicates all
   cores globally — so "quarantine" is a **new pre-admission state**, not a flag on an active
   seed: download the blob into a *quarantine* set that is **never** added to `activeSeeds`,
   never announced on the swarm/feed, and excluded from the relay catalog, availability hints,
   warmup, and durable-quota accounting. Classify densely (the whole file is present). Then:
   flagged & `seedFlagged=false`, or unknown & `seedUnknown=false` ⇒ delete blocks + drop;
   acceptable ⇒ promote via the normal `addSeed` path. A **verdict-change hook** evicts an
   already-active seed when a later trusted/local verdict turns adverse.
   *(Open caveat — Corestore's global `store.replicate` means true upload-suppression for a
   quarantined core needs a per-core upload gate or simply not joining its discovery topic;
   validated in Phase 2. Viewer caches stay fail-open; this strict policy is seeder-only and
   out of scope for Phase 1.)*
3. **Override** — `set-content-override { blobsCoreKey, action }` in `metaDb`. Always wins.

Generalizes the existing local `hideChannel` (`api.js:2818`,
`PUBLIC_FEED_HIDDEN_CHANNELS_KEY`) from whole-channel to per-video, category-aware hiding.

---

## 4. Why this can't be weaponized

- **Raw brigading is defused** — anonymous flags are advisory-only (a badge), never hide
  anything. The advisory hint is even degraded to boolean/coarse so a number can't imply
  precision (§13 Q4).
- **Connected-peer sybil is closed** — connections aren't counted; only default relays and
  explicit subscriptions are, and connected peers must be *manually* promoted.
- **Sparse-local suppression is closed** — the severity lattice only raises; a weak local
  pass can't cancel a dense trusted relay label.
- **A malicious trusted labeler** only affects clients that *chose* it (or shipped it as a
  removable default). A single default relay can `blur` but not unilaterally `hide` (§3.3).
- **The uploader can't poison** the local model (the user runs it), **can't suppress**
  third-party labels (labeler-owned feeds), and **can't self-label "safe"** (flags only
  honored *up*, and only from authorized channel writers).
- **Stale enforcement is bounded** — labels expire / can be revoked; local verdicts
  invalidate on model upgrade.
- **User autonomy** — override always wins, both directions.

Worst case: a bad actor mislabels content *for their own subscribers* (who opted in and can
leave) or inflates an advisory badge that hides nothing; a bad uploader publishes content
the network always allowed, which each client independently classifies and filters.

---

## 5. The model (PoC: ONNX from raw RGB; target: native)

For images the right tool is a small **vision** classifier — far smaller and more mature
than any LLM.

### 5.1 Phase 1a — runtime-feasibility spike (GATES Phase 1)

`@xenova/transformers ^2.17.2` is already a backend dep, but `search/semantic-finder.js`
loads it lazily, hides the import from `bare-pack`, sets only `allowLocalModels`, races a
10 s load, and **silently falls back to a hash stub** — proving the module is *not reliably*
loadable in these runtimes. transformers.js also imports `sharp`, `onnxruntime-node`, and
`onnxruntime-web` at module scope; feeding raw RGB skips image *decode* but does **not**
prove ORT-WASM initializes under BareKit.

**Before committing to the ONNX PoC, run a spike** that, on desktop (Electrobun) **and** iOS
**and** Android BareKit workers:

- bundles a small int8 NSFW model + the ORT-WASM assets as app assets;
- sets `env.allowRemoteModels = false`, `env.localModelPath`, and
  `env.backends.onnx.wasm.wasmPaths` to the bundled paths;
- constructs a `RawImage(data, width, height, channels)` from a bare-ffmpeg RGB24 frame and
  runs the `image-classification` pipeline in a `bare-worker`;
- measures cold-load time, per-frame latency, peak memory, and ArrayBuffer transfer cost.

**Gate:** if the spike passes on all targets, proceed with the ONNX PoC (§5.2). If it fails
on a target, that target skips straight to native bindings (§5.3) behind the same
`NsfwClassifier` interface — the rest of the design is unchanged.

### 5.2 PoC runtime — transformers.js / ONNX, fed raw RGB

Candidate models (quantized int8):

| Model | Approx size | Notes |
|-------|-------------|-------|
| MobileNetV2 NSFW classifier | **2–5 MB** | fastest, lowest footprint; recommended default |
| `Falconsai/nsfw_image_detection` (ViT) | ~22 MB | higher accuracy, heavier |

Bundled (not downloaded) so it works offline and on first run; `classifierVersion` records
the asset. Per-frame inference is single-digit ms desktop / tens of ms mobile; we classify a
handful of frames once per blob in the background.

### 5.3 Target runtime — native Neural Engine / GPU

Frame extraction, caching, labels, and enforcement are **runtime-agnostic**; only the
backend swaps behind:

```
interface NsfwClassifier {
  version: string                              // -> classifierVersion in labels
  classifyFrames(frames: RGBImage[]): Promise<{ category: string, score: number }[]>
}
```

- **iOS / macOS — Core ML** (`.mlmodelc`, Apple Neural Engine): Swift module on the native
  desktop shell (`packages/desktop-native/Sources/Services/`); native bridge from the
  BareKit worklet on mobile.
- **Android — TFLite / NNAPI** (or GPU delegate).
- **Desktop (Electrobun) — ONNX Runtime EPs** (CoreML/DirectML/CUDA; WASM/CPU fallback).

Native backends must produce the **same taxonomy and comparable score calibration** so
labels stay interoperable; `classifierVersion` records which backend/threshold produced a
label so consumers can weight or re-evaluate (§13 Q2).

---

## 6. Category taxonomy & defaults (v1)

| category | meaning | default per-category policy |
|----------|---------|------------------------------|
| `nsfw-explicit` | sexually explicit / pornographic | `blur` (tap-to-reveal; strict: `hide`) |
| `nsfw-suggestive` | suggestive but not explicit | `show` + badge (opt-in `blur`) |
| `unknown` | not yet classified / model failure | `show` (viewer fail-open) |

`violence`, `gore`, etc. are reserved and intentionally **not** auto-detected in v1 (keeps
the model tiny, false positives low).

Score thresholds (tunable): explicit if max-frame score ≥ 0.85; suggestive if ≥ 0.60.

**Default policy out of the box (flagged — §13 D4):** `mode: "blur"`, `nsfw-explicit → blur`
ON by default — protective but non-destructive (one tap reveals) and always badge-visible.
Copy must say *"blurred after a signal is detected,"* **not** "guaranteed you'll never see
it" (fail-open means brand-new unrated content can appear before any signal exists).

**Seeder defaults:** `seedFlagged=false`, `seedUnknown=false` — relays/CLI durably seed only
content they verified acceptable (§3.3, G7).

**Default relay labelers (flagged — §13 D3a):** a single default relay may `blur` alone;
`hide` requires `hideThreshold` (default 3) trusted labelers or explicit user opt-in, so one
compromised default relay can't bury content.

---

## 7. Schema additions (`packages/spec/schema.cjs`)

New message types (names indicative):

- `content-label` — the signed label record (§3.2): `labelerKeyHex`, `source`, `seq`,
  `expiresAt`, `revoked` (no separate `id` — identity is the `(labeler,target,category)` triple).
- `moderation-policy` — local policy (persisted to `metaDb`, typed for RPC).
- `moderation-verdict` — `{ action, category, score, source: "override"|"local"|"label",
  badge }` attached to `video` results when present.

Extend existing types:

- `video` — optional `moderation: moderation-verdict` (populated by the view filter).
- `feed-entry` — optional `selfLabel: content-label` (≤1) and a forgeable, display-only
  `flagHint: { nsfwExplicit: bool, nsfwSuggestive: bool }`.

New RPC endpoints:

- `classify-video { blobsCoreKey, videoId, channelKey }` → trigger/return a local verdict.
- `get-content-labels { channelKey | blobsCoreKey }` → `content-label[]` (bounded pull).
- `publish-content-label { ... }` → sign + append to the labeler's own label feed
  (relays / opt-in users); **rate-limited** per labeler/target.
- `get-moderation-policy` / `set-moderation-policy` — `set` **validates** writes
  (`blurThreshold ≥ 1`, `hideThreshold ≥ blurThreshold`, known category/action enums) so a
  malformed policy can't undermine the lattice semantics.
- `set-content-override { blobsCoreKey, action }`.
- `subscribe-labeler { labelerKeyHex }` / `unsubscribe-labeler`.
- `promote-peer-labeler { peerKeyHex }` (manual; moves an advisory peer into the trust set).

Regenerate JS **and** Swift codegen after editing (`cd packages/spec && node schema.cjs`,
then copy generated Swift into `desktop-native` per `AGENTS.md`). The canonical signing
bytes (`content-label` minus `signature`) must be deterministic and identical in JS and
Swift — commit a golden vector and cross-check it in tests (§11).

---

## 8. Storage & keys (`metaDb`, per client)

| key | value |
|-----|-------|
| `moderation:policy` | `moderation-policy` |
| `moderation:self:<blobsCoreKey>` | local verdict + `classifierVersion` + timestamp (recomputed on version bump) |
| `moderation:override:<blobsCoreKey>` | `"show"` \| `"hide"` |
| `moderation:labels:<blobsCoreKey>` | verified labels (trusted + advisory, tagged), one effective record per `(labeler, category)` latest `seq` |
| `moderation:labelers` | trust set (default relays ∪ subscriptions ∪ manually-promoted peers) |
| `moderation:resolved:<blobsCoreKey>` | cached resolver output for the hot list path + `validUntil` (next label `expiresAt`); invalidated on policy/label/verdict change **or** when `validUntil` passes |

**Quotas:** one effective label per `(labeler, category)` (latest `seq`); max untrusted labels per
blob (e.g. 64); bounded canonical label size; signature verified before persistence. All
keys are per-client and local; nothing here is authoritative for anyone else.

---

## 9. Identity for labelers

There are two distinct label sources with two distinct identities:

- **Third-party labelers** (relays, opt-in users): the labeler identity **is** its
  append-only **label-feed Hypercore key** (§3.2). It signs with that core's keypair;
  `labelerKeyHex` = that public key; discovery, replication, signature verification, and
  trust-set membership all key off it. Default relay labeler keys ship with the app
  (editable/removable). No separate signing/feed keys, no new PKI.
- **Self-labels** (an uploader tagging its own video): authorized via the existing channel
  writer model (`VALID_WRITER_ROLES` in `multi-writer-channel.js`); `labelerKeyHex` = the
  channel-writer key, `source:"self"`. These ride the channel `feed-entry`, never a label
  feed, and are honored only when they flag *up* (§3.2).

Subscribing to a third-party labeler replicates its label feed and adds its key to
`trustedLabelers`.

---

## 10. Phasing

- **Phase 0 (this doc).** Design sign-off.
- **Phase 1a — runtime spike (gate).** §5.1; outcome chooses ONNX vs native per platform.
- **Phase 1 — Local classifier + visible badge (PoC).** Raw-RGB multi-frame helper;
  bundled model run in `bare-worker`; version-keyed `metaDb` verdict cache;
  `moderation-policy` + pure-resolver view filter (show+badge / blur / hide) in
  `listVideos`; override; UI badge + tap-to-reveal blur. No network labels. **Smallest
  end-to-end slice that protects a viewer and shows the signal.**
- **Phase 2 — Signed labels + trusted-set crowd + seeding control.** `content-label` schema
  + signing + golden vector; labeler-owned label feeds; self-label on feed-entry; bounded
  `get-content-labels`; advisory `flagHint` in HAVE_FEED; trust set + thresholds; seed
  quarantine/evict + verdict-change hook in `SeedingManager`; relay dense auto-labeling.
  **Acceptance gate:** a quarantined blob must be provably non-uploadable — assert via a
  per-core upload gate, or by keeping the quarantined core unopened/undiscoverable until
  promotion (resolves the Corestore global-replicate caveat, §3.3).
- **Phase 3 — Native acceleration.** Core ML / TFLite-NNAPI / ONNX-EP behind
  `NsfwClassifier`. No changes above the interface.
- **Phase 4 (optional).** Labeler reputation/weighting, more categories (violence/gore),
  richer subscription UI.

---

## 11. Testing strategy

- **Effective-verdict resolver** (pure function, no model/network) — table-driven over
  {override, local-video, local-thumb, self-label-up, trusted-count, advisory, mode,
  category-policy, thresholds} → expected `{action, source, badge}`. The trust logic lives
  here; test it hardest.
- **Adversarial cases** (explicit tests): connected-peer sybil cannot reach a threshold;
  a single malicious default relay can blur but not hide; forged `flagHint` returns `show`
  and never changes seeding; self-label "safe" ignored; self-label-up from a non-writer
  ignored; self-label-up from a writer enforced; **sparse local false-negative + dense
  trusted relay positive ⇒ hidden** (lattice doesn't suppress); expired/revoked label
  ignored; model-version bump invalidates a cached verdict; late adverse verdict unseeds an
  active blob.
- **Classifier unit tests** (bare-runnable): known RGB24 fixtures (bundled benign +
  synthetic explicit-proxy) → category/score and max-over-frames; **fail-open** when the
  model is forced unavailable (verdict `unknown`, viewer shows content).
- **Label signing/verify** round-trip in JS; cross-check canonical bytes against committed
  Swift golden vector.
- **Seed filter:** `addSeed` quarantines unknown, evicts flagged when `seedFlagged=false`,
  evicts unknown when `seedUnknown=false`, promotes acceptable; verdict-change hook evicts.
- **Hot-path guard:** assert the `listVideos` resolver performs no model run, no network
  pull, and no signature verification (those happen at import time).
- No network mocks for classification — use real bundled frame fixtures + the real model.

---

## 12. Files this will touch (forward reference)

| Area | File | Change |
|------|------|--------|
| Raw-RGB frames | `packages/backend/src/moderation/frames.js` *(new)* | RGB24 multi-frame sampler (decode reuse from `thumbnail.js`) |
| Classifier | `packages/backend/src/moderation/classifier.js` *(new)* | `NsfwClassifier` (ONNX raw-RGB; native later) |
| Verdict logic | `packages/backend/src/moderation/verdict.js` *(new)* | pure severity-lattice resolver |
| Verdict cache / policy | `packages/backend/src/moderation/store.js` *(new)* | version-keyed `metaDb` read/write + quotas |
| Labels | `packages/backend/src/moderation/labels.js` *(new)* | sign/verify, self-label authz, supersession, trust-set count |
| Label feed | `packages/backend/src/moderation/label-feed.js` *(new)* | labeler-owned Hyperbee feed; replicate/pull |
| Worker offload | existing `bare-worker` usage | inference off main thread |
| View filter | `packages/backend/src/api.js` (`listVideos`, feed) | pure resolver + cache invalidation |
| Seed filter | `packages/backend/src/seeding.js` (`addSeed` + hook) | quarantine/evict + verdict-change hook |
| Labels gossip | `packages/backend/src/public-feed.js` | self-label + advisory `flagHint` |
| Schema | `packages/spec/schema.cjs` | new types + RPC; regen JS + Swift |
| Native (Phase 3) | `packages/desktop-native/Sources/Services/` | Core ML classifier |
| UI | `packages/app/` | NSFW badge, blur overlay, policy settings, override, labeler subs |

---

## 13. Decision log & open questions

**Adopted this session (D#):**

- **D1** Viewer fail-open; **seeder fail-closed/quarantine** (D11).
- **D2** Visible badge mandatory whenever any NSFW signal exists.
- **D3** Crowd split: trusted-set verified counting enforces; raw anonymous = advisory-only.
- **D3b** Connected peers are **not** auto-counted; manual promotion only.
- **D5** Local model = ground truth, instant only for on-device content; relays = dense
  labelers; labels cover not-yet-downloaded content.
- **D6** Thumbnail = weak first pass (blur-cap), not the verdict; authoritative = multi-frame.
- **D7** Classifier robustness: bundle model, feed raw RGB into ONNX, fail-open + diagnostics
  on load failure — **gated by the Phase 1a spike** (D12).
- **D8** Self-labels honored only when they flag *up* **and** come from an authorized
  channel writer.
- **D9** Effective verdict is a **total resolver** over a severity lattice (only ever
  *raises* severity; weak/thumb-only signals never `hide`; advisory never enforces; the
  C→action mapping is an exact table clamped by `mode`).
- **D10** Labels carry `seq`/`expiresAt`/`revoked` (no separate `id`); supersession is by the
  `(labeler, target, category)` triple ordered by `seq`; the local verdict cache invalidates
  on model-version bump and the resolved cache on `validUntil`. Nothing is trusted forever.
- **D11** A third-party labeler's identity **is** its append-only label-feed Hypercore key
  (Hyperbee over Hypercore); self-labels use the channel-writer key on a separate path.
  Relays expose a bounded `get-content-labels`.
- **D12** Phase 1 is gated by a measured BareKit/Electrobun ONNX-WASM spike (§5.1).
- **D13** `listVideos` stays hot: the view filter is a pure local-cache resolver only.
- **D14** Thresholds count **distinct trusted labeler keys** (not labels); one labeler can't
  inflate a count.
- **D15** Seeder quarantine is a **pre-admission state** (not a flag on an `activeSeed`);
  Phase 1 is strictly local (no labels, no seeding control). True upload-suppression under
  Corestore's global replicate is a Phase-2 caveat (§3.3).

**Flagged for your review:**

- **D4 — Default policy.** Proposed `nsfw-explicit → blur` ON by default (copy = "blur after
  a signal," not "guaranteed never see"). Alternative: ship `off` (pure opt-in). *Pick one.*
- **D3a — Default trust set.** Proposed: ship a small removable set of default relay labeler
  keys; a single default relay can blur but not hide. Alternative: no defaults (auto-hide
  -on-crowd won't function until the user subscribes). *Pick one.*

**Open questions (revisit with PoC numbers):**

- **Q1** Frame budget (proposed 3–5 viewer-side; relays dense).
- **Q2** Cross-backend score calibration (Core ML / TFLite / ONNX comparable).
- **Q3** Labeler reputation/weighting beyond binary trust-set membership (Phase 4).
- **Q4** Advisory provenance — ship the badge as a boolean "some unverified peers flagged"
  (proposed) vs a capped bucket; avoid exact counts (precision/brigading theater).
- **Q5** Label-publishing privacy — publishing a label leaks what you watched/seed. Proposed:
  user publishing is opt-in; durable publishing defaults to relays/seeders; batch/pad
  `get-content-labels` queries to limit per-video lookup leakage.

---

*Adapts AT Protocol composable moderation (self-labels + subscribable labelers + local
override) to the Hypercore stack, extended with a sybil-resistant trusted-set crowd signal
and a forgeable, display-only advisory hint. The detection is the easy, tiny part; the
opt-in trust model — a severity lattice that only ever raises, refusing to let raw counts or
weak signals auto-hide anything — is what keeps "local moderation" from quietly becoming
"decentralized censorship."*
