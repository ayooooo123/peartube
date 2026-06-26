# Local-Client Content Moderation — Design

**Status:** Draft / proposal
**Date:** 2026-06-26
**Author:** Claude (with @ayooooo123)
**Branch:** `claude/local-client-moderation-q7totc`

---

## 1. Problem & goals

PearTube discovers *all* public content via gossip on `peartube-public-feed-v1`. There is
no central authority and we never want one: anyone can publish anything, and we cannot —
and do not want to be able to — prevent uploads or sharing.

But "no central authority" must not mean "every user is force-fed explicit content."
We want **strict, user-controlled protection**: a normal user who opts out of sexually
explicit material should never see it, and ideally never even download the frames. We also
want **relays and seeders** to be able to decline to replicate content they don't want to
host.

### Goals

- **G1 — Local-first.** Every client can decide, on its own, whether a given video is
  NSFW, with zero trust in anyone else.
- **G2 — Unobtrusive & efficient.** No 2 GB model. Single-digit-MB classifier, runs off
  frames we *already* extract, on a background thread, never blocking playback.
- **G3 — Shareable hints.** A client (especially a relay) that has classified content can
  publish a signed label so other clients can pre-hide it *before downloading frames*.
- **G4 — Trust is opt-in and composable.** A label only affects a client that chose to
  trust its author. No label can globally hide anything for anyone.
- **G5 — Seeding control.** A relay/seeder can refuse to replicate flagged content.
- **G6 — User override always wins.** Local "show this anyway" / "hide this" beats any
  classifier or label.

### Non-goals

- Preventing uploads or takedowns of content from the network (impossible and undesired
  in a P2P system).
- A global reputation/consensus system. Out of scope for v1; the label format leaves room
  for it later.
- Perfect classification. We target high-recall NSFW-explicit detection with a
  conservative default, not legal-grade accuracy.

---

## 2. The hard part: trust, not detection

NSFW *detection* is a solved, small problem (Section 5). The architectural risk is the
**trust model**. In a decentralized network a "flag" is just a claim by some peer. If we
get this wrong we build either:

- a **censorship lever** — one actor's flag hides content for everyone, or
- **noise** — flags nobody trusts, so nobody uses them.

We avoid both by adopting the **AT Protocol / Bluesky "composable moderation"** model,
adapted to Hypercore:

> Content carries no authoritative rating. Instead, **independent labelers** emit signed
> labels, and **each client subscribes** to the labelers it trusts. Enforcement is local.
> The user can always override.

This maps cleanly onto primitives PearTube already has (gossip feed, per-client `metaDb`,
selective seeding, signed channel writers).

---

## 3. Architecture: three layers

```
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 1 — LOCAL SELF-CLASSIFICATION  (zero trust)        │
            │  keyframes (bare-ffmpeg) → tiny NSFW model (bare-worker)  │
            │  → verdict cached in metaDb[blobsCoreKey]                 │
            └──────────────────────────────────────────────────────────┘
                                   │ produces
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 2 — SIGNED LABELS  (opt-in trust)                 │
            │  content-label{ targetBlobsCoreKey, category, score,     │
            │                 labelerKeyHex, signature }               │
            │  gossiped over peartube-public-feed-v1; imported only    │
            │  from subscribed labelers                                │
            └──────────────────────────────────────────────────────────┘
                                   │ informs
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 3 — LOCAL ENFORCEMENT  (+ user override)          │
            │  • view filter (listVideos / feed): hide | blur | show   │
            │  • seed filter (SeedingManager.addSeed): refuse to seed  │
            └──────────────────────────────────────────────────────────┘
```

### Layer 1 — Local self-classification (zero trust)

A tiny vision classifier runs **on-device** against the keyframes we already decode for
thumbnails. This is **ground truth for that user** — the uploader cannot game it because
*the user ran it themselves*.

- **Input:** N keyframes (default: extend the existing single-thumbnail extraction at
  `frameIndex 300` to a small set, e.g. 3–5 frames sampled across the duration). See
  `packages/backend/src/thumbnail.js:215` (`generateThumbnail`) — same `ff.InputFormatContext`
  / `ff.Scaler` / `ff.Frame` pipeline, looped over several frame indices.
- **Output:** per-frame `{ category → score }`; the video verdict is the max over frames
  (conservative: any explicit frame ⇒ explicit).
- **Cache:** verdict written to `metaDb` keyed by `moderation:self:<blobsCoreKey>`.
  `blobsCoreKey` is content-addressed, so a verdict can never be redirected to other
  content. Computed **once per blob**, reused forever.
- **Thread:** runs in the existing `bare-worker` pool so it never blocks playback or the
  RPC loop. Best-effort; failures leave the verdict `unknown`.

**Limitation that motivates Layer 2:** self-classification only protects a user *after*
they've fetched and decoded a frame. A user who opted out of explicit content shouldn't
fetch the blob at all. Hence subscribed labels.

### Layer 2 — Signed labels (opt-in trust)

Any peer may publish a signed `content-label`. **Relays are the natural high-signal
labelers** because, in discovery mode, they classify everything they replicate. A label is
a verifiable, standalone claim — it is **not** stored on the uploader's channel, so an
uploader can neither forge nor suppress it.

```
content-label {
  targetBlobsCoreKey : string   // content-addressed identity of the video blob
  videoId            : string
  channelKey         : string
  category           : string   // see taxonomy §6
  score              : float     // classifier confidence 0..1
  classifierVersion  : string   // e.g. "nsfw-mnv2-int8@1"
  labelerKeyHex      : string   // public key of the labeler
  createdAt          : uint
  signature          : string   // sign(labelerKeyHex_secret, canonical(label))
}
```

- **Binding:** the signature covers all fields including `targetBlobsCoreKey`, so a label
  cannot be lifted onto different content.
- **Propagation:** piggyback on the existing feed gossip (`public-feed.js` `HAVE_FEED` /
  `SUBMIT_CHANNEL`, see `packages/backend/src/public-feed.js:1781`, `:1894`). Labels for a
  channel ride alongside its `feed-entry`, plus a pull RPC (`get-content-labels`) for
  on-demand fetch. Labels are small; we cap and tail them like feed entries already do.
- **Import policy:** a client imports a label **only if `labelerKeyHex` is in its
  subscribed-labelers set.** Unsubscribed labels are ignored (but may be counted purely
  for an optional, off-by-default "N peers flagged this" hint — never auto-enforced).

### Layer 3 — Local enforcement + override

Each client holds a **moderation policy** (local, in `metaDb`):

```
moderation-policy {
  mode            : "off" | "blur" | "hide"      // default: "blur" for nsfw-explicit
  categories      : { <category>: "show"|"blur"|"hide" }
  trustLocalModel : bool                          // default true
  subscribedLabelers : string[]                   // labelerKeyHex list; default []
  seedFlagged     : bool                          // relays: replicate flagged? default false
}
```

Enforcement points:

1. **View filter** — in `api.js` `listVideos()` / feed assembly. For each video, resolve an
   **effective verdict** = userOverride ?? localSelfVerdict ?? max(subscribedLabelVerdicts).
   Apply policy: `hide` removes it from results; `blur` returns it with a `moderation`
   field the UI uses to blur the thumbnail behind a tap-to-reveal; `show` passes through.
2. **Seed filter** — in `SeedingManager.addSeed()` (`packages/backend/src/seeding.js:214`).
   Before admitting a blob to the cache/quota, consult the effective verdict; if flagged
   and `seedFlagged === false`, decline to seed (return without registering). This satisfies
   the "ignore it for seeding purposes" requirement for both normal users and relays.
3. **Override** — `set-content-override { blobsCoreKey, action: "show"|"hide" }` stored in
   `metaDb` under `moderation:override:<blobsCoreKey>`. Always wins.

This generalizes the existing local `hideChannel` mechanism
(`packages/backend/src/api.js:2818`, `PUBLIC_FEED_HIDDEN_CHANNELS_KEY`) from
whole-channel to per-video, category-aware hiding.

---

## 4. Why this can't be weaponized

- A **malicious labeler** only affects clients that *chose* to subscribe to it. There is no
  global hide.
- The **uploader cannot poison** self-classification — the user runs the model locally.
- The **uploader cannot suppress** labels — they live independently of the channel and are
  signed by the labeler, not the uploader.
- **No consensus = no majority attack.** v1 deliberately does not auto-trust crowd counts;
  the optional "N peers flagged" hint is advisory only and off by default.
- **User autonomy is preserved** — override always wins, in both directions (reveal hidden,
  or hide shown).

Threat summary: the worst a bad actor can do is mislabel content *for their own
subscribers*, who opted in and can unsubscribe. The worst a bad uploader can do is publish
content — which the network was always going to allow — that each client independently
classifies and filters.

---

## 5. The model (PoC: ONNX; target: native)

"Tiny language model to view frames" — for images the right tool is a small **vision**
classifier, which is far smaller and more mature than any LLM.

### 5.1 PoC runtime — transformers.js / ONNX (ship first)

Reuse `@xenova/transformers`, already a `packages/backend` dependency (used by the semantic
search finder). One codepath across iOS (BareKit), Android (BareKit), and desktop
(Electrobun). Runs in the `bare-worker` thread pool already in the stack.

Candidate models (quantized int8):

| Model | Approx size | Notes |
|-------|-------------|-------|
| MobileNetV2 NSFW classifier | **2–5 MB** | fastest, lowest footprint; recommended default |
| `Falconsai/nsfw_image_detection` (ViT) | ~22 MB | higher accuracy, heavier |

A few MB, not 2 GB. Per-frame inference is single-digit milliseconds on desktop, tens of ms
on mobile — and we only classify a handful of keyframes, once per blob, in the background.

The model file ships with the app (bundled asset), versioned via `classifierVersion`. No
network fetch at inference time (unlike the current search-embeddings download path), so it
works offline and on first run.

### 5.2 Target runtime — native Neural Engine / GPU

Once the PoC validates the pipeline, swap the inference backend per platform behind a stable
interface (`classifyFrames(frames) → verdict`). The frame extraction, caching, labels, and
enforcement layers are **runtime-agnostic** and do not change.

- **iOS / macOS — Core ML.** Compile the classifier to a `.mlmodelc`, run via the Apple
  Neural Engine. On the native desktop shell this is a Swift module
  (`packages/desktop-native/Sources/Services/`); on mobile, a small native bridge from the
  BareKit worklet. Sub-millisecond per frame, near-zero battery.
- **Android — TFLite / NNAPI (or GPU delegate).** Ship a `.tflite` model, run through the
  NNAPI or GPU delegate.
- **Desktop (Electrobun) — ONNX Runtime with execution providers.** Use CoreML EP on macOS,
  DirectML on Windows, CUDA/ROCm where available; fall back to WASM/CPU.

The interface contract (so PoC ↔ native are drop-in):

```
interface NsfwClassifier {
  version: string                              // -> classifierVersion in labels
  classifyFrames(frames: RGBImage[]): Promise<{ category: string, score: number }[]>
}
```

Native classifiers must produce the **same category taxonomy and comparable score
calibration** so labels remain interoperable across clients regardless of which backend
generated them. `classifierVersion` records which backend/threshold produced a label so
consumers can weight or re-evaluate.

---

## 6. Category taxonomy (v1)

Start small and conservative; the field is a string so we can extend without a wire break.

| category | meaning | default policy |
|----------|---------|----------------|
| `nsfw-explicit` | sexually explicit / pornographic | `blur` (strict users: `hide`) |
| `nsfw-suggestive` | suggestive but not explicit | `show` (opt-in `blur`) |
| `unknown` | not yet classified / model failure | `show` |

`violence`, `gore`, etc. are reserved for later and intentionally **not** auto-detected in
v1 to keep the model tiny and the false-positive surface small.

Threshold defaults (tunable): `nsfw-explicit` if max-frame score ≥ 0.85; `nsfw-suggestive`
if ≥ 0.60. Conservative = bias toward protecting opted-out users.

---

## 7. Schema additions (`packages/spec/schema.cjs`)

New message types (names indicative):

- `content-label` — as in §3, the signed label record.
- `moderation-policy` — local policy (also persisted to `metaDb`, but typed for RPC so UI
  can read/write it).
- `moderation-verdict` — `{ category, score, source: "local"|"label"|"override", classifierVersion }`,
  attached to `video` results when present.

Extend existing types:

- `video` — add optional `moderation: moderation-verdict` (populated by the view filter).
- `feed-entry` — add optional `labels: content-label[]` (small, tailed) so labels gossip
  with the feed.

New RPC endpoints:

- `classify-video { blobsCoreKey, videoId, channelKey }` → triggers/returns a local verdict.
- `get-content-labels { channelKey | blobsCoreKey }` → `content-label[]` (pull path).
- `publish-content-label { ... }` → sign + gossip a label (relays / opt-in users).
- `get-moderation-policy` / `set-moderation-policy`.
- `set-content-override { blobsCoreKey, action }`.
- `subscribe-labeler { labelerKeyHex }` / `unsubscribe-labeler`.

Regenerate JS **and** Swift codegen after editing (`cd packages/spec && node schema.cjs`,
then copy generated Swift into `desktop-native` per `CLAUDE.md`). Because labels are signed,
the canonical encoding used for signing must be deterministic and identical in JS and Swift
— reuse the compact-encoding wire bytes of `content-label` (minus the `signature` field) as
the signing payload.

---

## 8. Storage & keys (`metaDb`, per client)

| key | value |
|-----|-------|
| `moderation:policy` | `moderation-policy` |
| `moderation:self:<blobsCoreKey>` | local verdict + `classifierVersion` + timestamp |
| `moderation:override:<blobsCoreKey>` | `"show"` \| `"hide"` |
| `moderation:labels:<blobsCoreKey>` | imported signed labels from subscribed labelers |
| `moderation:labelers` | subscribed labeler key set |

All per-client and local. Nothing here is authoritative for anyone else.

---

## 9. Identity for labelers

Reuse the existing channel/device keypair model (`VALID_WRITER_ROLES` etc. in
`packages/backend/src/channel/multi-writer-channel.js`). A labeler key is just a Hypercore
keypair; a relay signs with its relay identity, a user who opts in to publishing signs with
their channel key. Subscribing to a labeler = adding its public key to
`moderation:labelers`. No new PKI.

---

## 10. Phasing

- **Phase 0 (this doc).** Design sign-off.
- **Phase 1 — Local classifier (PoC).** Multi-frame extraction in `thumbnail.js`; ONNX
  MobileNet NSFW model bundled + run in `bare-worker`; `metaDb` verdict cache;
  `moderation-policy` + view filter (blur/hide) in `listVideos`; user override. No network
  labels. **Smallest end-to-end slice that protects a user.**
- **Phase 2 — Signed labels + seeding control.** `content-label` schema + signing; gossip
  on the feed + `get-content-labels`; subscribe-to-labeler trust; seed filter in
  `SeedingManager.addSeed()`; relay discovery-mode auto-labeling.
- **Phase 3 — Native acceleration.** Core ML (iOS/macOS), TFLite/NNAPI (Android), ONNX
  Runtime EPs (desktop) behind the `NsfwClassifier` interface. No changes above the
  interface.
- **Phase 4 (optional, later).** Crowd-signal heuristics, labeler reputation, additional
  categories (violence/gore), UI for managing labeler subscriptions.

---

## 11. Open questions

1. **Frame budget.** How many keyframes per video balances recall vs. cost on mobile?
   (Proposed: 3–5, sampled across duration; revisit with PoC numbers.)
2. **When does Layer-1 classification run?** On thumbnail generation (publish side) and/or
   on first playback (viewer side)? Proposed: viewer-side on first access *plus* publisher
   classifies its own uploads and can self-label.
3. **Default policy out of the box.** Ship `nsfw-explicit → blur` by default, or `show`
   with an onboarding prompt? Strict-by-default is safer but more opinionated.
4. **Label volume control.** How aggressively to cap/tail labels in the feed gossip to avoid
   ballooning `HAVE_FEED` (already a concern — see `public-feed.js:1906`).
5. **Calibration across backends.** Ensuring Core ML / TFLite / ONNX scores stay comparable
   enough that `score ≥ threshold` means the same thing everywhere.

---

## 12. Files this will touch (forward reference)

| Area | File | Change |
|------|------|--------|
| Frame extraction | `packages/backend/src/thumbnail.js` | multi-frame sampling helper |
| Classifier | `packages/backend/src/moderation/classifier.js` *(new)* | `NsfwClassifier` impl (ONNX) |
| Worker offload | existing `bare-worker` usage | run inference off main thread |
| Verdict cache / policy | `packages/backend/src/moderation/store.js` *(new)* | `metaDb` read/write |
| View filter | `packages/backend/src/api.js` (`listVideos`, feed) | apply effective verdict |
| Seed filter | `packages/backend/src/seeding.js` (`addSeed`) | decline flagged blobs |
| Labels gossip | `packages/backend/src/public-feed.js` | carry/pull `content-label`s |
| Schema | `packages/spec/schema.cjs` | new types + RPC; regen JS + Swift |
| Native (Phase 3) | `packages/desktop-native/Sources/Services/` | Core ML classifier |
| UI | `packages/app/` | blur overlay, policy settings, override toggle |

---

*Adapts AT Protocol composable moderation (self-labels + subscribable labelers + local
override) to the Hypercore stack. The detection is the easy, tiny part; the opt-in trust
model is what keeps "local moderation" from quietly becoming "decentralized censorship."*
