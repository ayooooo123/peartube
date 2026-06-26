# Local-Client Content Moderation — Design

**Status:** Draft / proposal — revision 2 (design dialogue resolved)
**Date:** 2026-06-26
**Author:** Claude (with @ayooooo123)
**Branch:** `claude/local-client-moderation-spec-fh5rnx`

---

## 0. Revision 2 — what changed and why

Revision 1 proposed pure composable moderation (local self-classification + opt-in
subscribed labelers + local enforcement) and **deliberately excluded crowd/consensus
signals** to avoid a censorship lever. The design dialogue reshaped four things:

1. **Fail-open, not fail-closed.** Moderation is a *silent background pass*. It never
   blocks the feed, never shows a "classifying…" gate. Unrated content is shown. A verdict
   only ever *removes/blurs* content once it exists.
2. **Visibility is a first-class goal.** Whenever *any* signal suggests content may be
   NSFW, the UI must say so clearly — a badge — even when the content is still shown.
3. **Crowd signal is in — but split into two paths.** Users want "if N people flagged it,
   hide it." Raw P2P counts are a brigading weapon (keypairs are free → sybils). So:
   - **Enforcement path = trusted-set counting** (sybil-resistant): only labels the client
     itself verified, signed by keys in a *trust set* (default relay labelers + user
     subscriptions + connected peers), are counted toward auto-blur/auto-hide thresholds.
   - **Advisory path = raw anonymous count** (forgeable): shown as a badge ("N peers
     flagged"), **never** auto-enforces.
4. **The local model is ground truth but only *instant for on-device content*.** Inference
   is milliseconds; the cost is fetching+decoding frames. So the local model protects
   cached / currently-playing content invisibly, and **labels cover content not yet
   downloaded**. Thumbnails are a *weak* first-pass signal (a dumb mid-point grab can be a
   black frame in an otherwise explicit video), never the authoritative verdict.

The decision log is in §13.

---

## 1. Problem & goals

PearTube discovers *all* public content via gossip on `peartube-public-feed-v1`. There is
no central authority and we never want one: anyone can publish anything, and we cannot —
and do not want to be able to — prevent uploads or sharing.

But "no central authority" must not mean "every user is force-fed explicit content."
We want **strong, user-controlled protection that is invisible when it works**: a user who
opts out of sexually explicit material should not see it, the app should make it *clear*
when content might be NSFW, and **relays/seeders should be able to decline to replicate**
content they don't want to host.

### Goals

- **G1 — Local-first ground truth.** Every client can decide, on its own, whether content
  it has on disk is NSFW, with zero trust in anyone else.
- **G2 — Invisible & efficient.** No 2 GB model. Single-digit-MB classifier, runs off
  frames we *already* decode, on a background thread, never blocking playback or the feed.
- **G3 — Fail-open, never block.** Unrated content is shown. A verdict only ever removes or
  blurs content *after* it exists. No "classifying…" gates.
- **G4 — Always make NSFW-likelihood visible.** When any signal (local model, trusted
  label, advisory crowd count) suggests NSFW, surface a clear badge — even in show mode.
- **G5 — Shareable hints (labels).** A client (especially a relay that downloaded the whole
  file) can publish a signed label so other clients pre-hide content *before downloading
  frames*.
- **G6 — Trust is opt-in and composable; crowd signal is sybil-resistant.** Auto-enforcing
  thresholds count only verified labels from a *trust set*. Raw anonymous counts are
  advisory-only and never auto-enforce.
- **G7 — Seeding control.** A relay/seeder/CLI can flip one switch to refuse to replicate
  flagged content.
- **G8 — User override always wins.** Local "show this anyway" / "hide this" beats any
  classifier or label, in both directions.

### Non-goals

- Preventing uploads or takedowns of content from the network (impossible and undesired in
  a P2P system).
- A global reputation/consensus system, or treating raw anonymous crowd counts as
  authoritative. The label format leaves room for reputation later (§13, Q-open).
- Perfect classification. We target high-recall NSFW-explicit detection with a conservative
  bias, not legal-grade accuracy.

---

## 2. The hard part: trust, not detection

NSFW *detection* is a solved, small problem (§5). The architectural risk is the **trust
model**. In a decentralized network a "flag" is just a claim by some peer. Get it wrong and
you build either a **censorship lever** (one actor's flag hides content for everyone) or
**noise** (flags nobody trusts).

We adopt the **AT Protocol / Bluesky "composable moderation"** model — content carries no
authoritative rating; independent labelers emit signed labels; each client enforces
locally and can always override — and **extend it with a sybil-resistant crowd signal**:

> **Enforcement signals, in precedence order, are all things the client can verify or
> compute itself:** (1) the user's explicit override, (2) the client's own local model
> verdict, (3) the count of *verified signed labels from the client's trust set*. A raw
> count of anonymous flags is shown to the user but never auto-enforces.

This maps onto primitives PearTube already has: gossip feed, per-client `metaDb`, selective
seeding, signed channel/relay writers.

### Why a trust set instead of raw counts

"Hide if 10 people flagged it" is trivially defeated: a single attacker generates 10 (or
10,000) keypairs at zero cost and buries any target. The fix is to **only count flags from
keys that cost something to be**:

- **Relays** run real infrastructure and seed content → expensive to sybil at scale. A
  small **default set of relay labeler keys** ships with the app (editable/removable).
- **Subscribed labelers** the user explicitly added.
- **Connected peers** the client has actually exchanged data with (weaker, optional).

Counts *within this set* are meaningful; flags from outside it are advisory-only.

---

## 3. Architecture: three layers

```
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 1 — LOCAL SELF-CLASSIFICATION  (zero trust)        │
            │  bare-ffmpeg RGB frames → tiny NSFW model (bare-worker)   │
            │  multi-frame; thumbnail = cheap first pass, not verdict   │
            │  → verdict cached in metaDb[moderation:self:<blobsKey>]   │
            └──────────────────────────────────────────────────────────┘
                                   │ produces
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 2 — SIGNED LABELS  (trust set + advisory crowd)    │
            │  content-label{ targetBlobsCoreKey, category, score,      │
            │                 labelerKeyHex, signature }                │
            │  self-label rides feed-entry; 3rd-party via pull RPC;     │
            │  advisory count summary rides HAVE_FEED (forgeable)       │
            └──────────────────────────────────────────────────────────┘
                                   │ informs
                                   ▼
            ┌──────────────────────────────────────────────────────────┐
            │  Layer 3 — LOCAL ENFORCEMENT  (fail-open + visible badge) │
            │  effective verdict = override ?? localModel ??            │
            │      trustedLabelThreshold ?? unknown(show + maybe badge) │
            │  • view filter: show+badge | blur | hide                  │
            │  • seed filter: refuse to seed flagged (relays/CLI)       │
            └──────────────────────────────────────────────────────────┘
```

### Layer 1 — Local self-classification (zero trust)

A tiny vision classifier runs **on-device** against frames we already decode. This is
**ground truth for that user** — the uploader cannot game it because *the user ran it
themselves*.

- **Input — multi-frame, not thumbnail-only.** The thumbnail (a single mid-point grab) is
  too dumb to trust: an explicit video can have a black frame at `frameIndex 300`. So:
  - **Cheap first pass:** classify the thumbnail blob (already decoded for display) for an
    *immediate* feed signal. Cheap because the thumbnail is a separate, content-addressed
    Hyperblobs blob (`thumbnailBlobsCoreKey`) fetched in a few KB independently of the
    video.
  - **Authoritative pass:** sample N frames across the duration from whatever video bytes
    are local (default 3–5 viewer-side), extending `generateThumbnail`
    (`packages/backend/src/thumbnail.js:215`) to loop the same `ff.InputFormatContext` /
    `ff.Scaler` / `ff.Frame` pipeline over several frame indices.
  - **Relays sample densely.** A relay/seeder downloads the *whole* file, so it can sample
    many frames → high-confidence verdict → becomes the natural high-signal labeler (§2).
- **Output:** per-frame `{ category → score }`; the video verdict is the **max over
  frames** (conservative: any explicit frame ⇒ explicit).
- **Cache:** verdict written to `metaDb`, keyed `moderation:self:<blobsCoreKey>` (the
  authoritative video pass) and `moderation:self:<thumbnailBlobsCoreKey>` (the cheap pass).
  `blobsCoreKey` is content-addressed, so a verdict can never be redirected to other
  content. Computed **once per blob**, reused forever.
- **Thread:** runs in the existing `bare-worker` pool so it never blocks playback or the
  RPC loop. **Fail-open:** failures (or model-unavailable) leave the verdict `unknown` and
  the content is shown; model-load failure is surfaced in diagnostics, not to the feed.

### Layer 2 — Signed labels (trust set + advisory crowd)

Any peer may publish a signed `content-label`. A label is a verifiable, standalone claim —
**not** stored on the uploader's channel — so an uploader can neither forge nor suppress
it.

```
content-label {
  targetBlobsCoreKey : string   // content-addressed identity of the video blob
  videoId            : string
  channelKey         : string
  category           : string   // see taxonomy §6
  score              : float     // classifier confidence 0..1
  classifierVersion  : string   // e.g. "nsfw-mnv2-int8@1"  (or "self-report" / "manual")
  labelerKeyHex      : string   // public key of the labeler
  createdAt          : uint
  signature          : string   // sign(labelerKeyHex_secret, canonical(label))
}
```

- **Binding:** the signature covers all fields including `targetBlobsCoreKey`, so a label
  cannot be lifted onto different content.
- **Propagation (kept cheap — HAVE_FEED is already a memory concern, see
  `public-feed.js:1906`):**
  - **Self-label** rides in the channel's `feed-entry` (at most one tiny label per video,
    by the uploader).
  - **Third-party labels** (relays, opt-in users) are fetched **on demand** via a pull RPC
    `get-content-labels { channelKey | blobsCoreKey }` and cached in `metaDb`. They do
    **not** bloat `HAVE_FEED`.
  - **Advisory crowd summary** — a few bytes per entry in `HAVE_FEED`
    (`{ nsfwExplicitFlags, nsfwSuggestiveFlags }`) as a *forgeable hint only*. It feeds the
    "N peers flagged" badge; it **never** drives enforcement.
- **Import / counting policy:**
  - **Self-label asymmetry:** honor a self-label only when it flags content *up* (more
    restrictive: explicit/suggestive). A self-label claiming "safe" is ignored (an uploader
    can't vouch their own content down). Honest creators self-tagging adult content is the
    happy path.
  - **Enforcement counting:** count a label toward auto-blur/auto-hide thresholds **only
    if** the client verified its signature **and** `labelerKeyHex` is in the trust set
    (default relays ∪ subscriptions ∪ connected peers).
  - **Advisory counting:** flags from outside the trust set increment the advisory badge
    count only.

### Layer 3 — Local enforcement + override

Each client holds a **moderation policy** (local, in `metaDb`):

```
moderation-policy {
  mode               : "off" | "blur" | "hide"   // master switch; default "blur"
  categories         : { <category>: "show"|"blur"|"hide" }
  trustLocalModel    : bool                        // default true
  trustedLabelers    : string[]                    // labelerKeyHex; seeded w/ default relays
  blurThreshold      : uint                         // trusted flags → blur; default 1
  hideThreshold      : uint                         // trusted flags → hide; default 10
  countConnectedPeers: bool                         // include connected peers in trust set; default false
  showAdvisoryCount  : bool                         // show "N peers flagged" badge; default true
  seedFlagged        : bool                         // relays/CLI: replicate flagged? default false
}
```

**Effective verdict** for a video (first hit wins; everything below is fail-open):

1. **User override** (`moderation:override:<blobsCoreKey>` = `show` | `hide`) — always wins.
2. **Local model verdict** (`moderation:self:*`) — if present and `trustLocalModel`.
3. **Trusted-label threshold** — count verified trusted-set labels per category; if
   `count ≥ hideThreshold` → hide, else if `≥ blurThreshold` → blur. (Also: the *max score*
   of a trusted relay label can hide directly, since a relay's dense multi-frame pass is
   higher-confidence than any single threshold.)
4. **Unknown** → **show**, but attach an advisory badge if `showAdvisoryCount` and the raw
   crowd count > 0, or if a self-label flagged it.

Enforcement points:

1. **View filter** — in `api.js` `listVideos()` / feed assembly (`api.js:1428`). Each video
   gets a `moderation` field: `{ action: "show"|"blur"|"hide", category, source, score,
   advisoryCount }`. `hide` drops it; `blur` returns it flagged for a tap-to-reveal blur;
   `show` passes through (UI still renders the badge when `advisoryCount`/self-label
   present).
2. **Seed filter** — in `SeedingManager.addSeed()` (`seeding.js:214`). Before admitting a
   blob to the cache/quota, consult the effective verdict; if flagged and
   `seedFlagged === false`, decline to seed. Satisfies "flip a switch and never seed
   explicit" for relays and CLI.
3. **Override** — `set-content-override { blobsCoreKey, action }` in `metaDb`. Always wins.

This generalizes the existing local `hideChannel` mechanism (`api.js:2818`,
`PUBLIC_FEED_HIDDEN_CHANNELS_KEY`) from whole-channel to per-video, category-aware hiding.

---

## 4. Why this can't be weaponized

- **Raw flag brigading is defused** — anonymous counts are advisory-only (a badge); they
  never hide anything. Auto-hide counts only verified labels from the trust set, where
  identities cost real infra (relays) or explicit user choice (subscriptions).
- A **malicious trusted labeler** only affects clients that *chose* to trust it (or shipped
  it as a default relay they can remove). No global hide.
- The **uploader cannot poison** the local model — the user runs it themselves.
- The **uploader cannot suppress** labels — they live independently of the channel, signed
  by the labeler.
- The **uploader cannot mislabel themselves "safe"** — self-labels are honored only when
  they flag *up*.
- **User autonomy is preserved** — override always wins, both directions.

Threat summary: the worst a bad actor can do is (a) mislabel content *for their own
subscribers*, who opted in and can leave, or (b) inflate the advisory badge count, which
never auto-hides anything. The worst a bad uploader can do is publish content — which the
network always allowed — that each client independently classifies and filters.

---

## 5. The model (PoC: ONNX from raw RGB; target: native)

For images the right tool is a small **vision** classifier — far smaller and more mature
than any LLM.

### 5.1 PoC runtime — transformers.js / ONNX, fed raw RGB (ship first)

Reuse `@xenova/transformers` (already a `packages/backend` dependency, used by
`search/semantic-finder.js`). One codepath across iOS (BareKit), Android (BareKit), and
desktop (Electrobun), in the `bare-worker` pool.

**Critical robustness change vs. the search path.** `semantic-finder.js` loads the model
lazily and **silently falls back to a hash stub** when load fails — fine for search, fatal
for a moderation guarantee (it would quietly become "show everything"). Two mitigations:

1. **Bundle the model as a versioned app asset** (`classifierVersion`), no network fetch at
   inference time — removes the download-failure path the search code hits.
2. **Feed pre-resized raw RGB straight into the pipeline**, bypassing transformers.js's
   image *decode* (sharp/jimp/canvas), which is the fragile part under Bare. We already
   produce decoded RGB via `ff.Scaler`; scale to the model's input (e.g. 224×224, RGB),
   wrap the buffer in a transformers.js `RawImage(data, width, height, channels)`, and run
   `image-classification`. Only the WASM ONNX runtime + normalize/tensor steps remain —
   pure compute, no I/O.

If the model still cannot load, the verdict stays `unknown` (fail-open) and the failure is
reported via diagnostics so we know coverage dropped.

Candidate models (quantized int8):

| Model | Approx size | Notes |
|-------|-------------|-------|
| MobileNetV2 NSFW classifier | **2–5 MB** | fastest, lowest footprint; recommended default |
| `Falconsai/nsfw_image_detection` (ViT) | ~22 MB | higher accuracy, heavier |

Per-frame inference is single-digit ms on desktop, tens of ms on mobile; we classify a
handful of frames once per blob, in the background.

### 5.2 Target runtime — native Neural Engine / GPU

Once the PoC validates the pipeline, swap the inference backend per platform behind a stable
interface. Frame extraction, caching, labels, and enforcement are **runtime-agnostic**.

- **iOS / macOS — Core ML** (`.mlmodelc`, Apple Neural Engine). Swift module on the native
  desktop shell (`packages/desktop-native/Sources/Services/`); native bridge from the
  BareKit worklet on mobile.
- **Android — TFLite / NNAPI** (or GPU delegate).
- **Desktop (Electrobun) — ONNX Runtime EPs** (CoreML on macOS, DirectML on Windows,
  CUDA/ROCm where available; WASM/CPU fallback).

```
interface NsfwClassifier {
  version: string                              // -> classifierVersion in labels
  classifyFrames(frames: RGBImage[]): Promise<{ category: string, score: number }[]>
}
```

Native classifiers must produce the **same taxonomy and comparable score calibration** so
labels stay interoperable; `classifierVersion` records which backend/threshold produced a
label so consumers can weight or re-evaluate.

---

## 6. Category taxonomy (v1)

Start small and conservative; the field is a string so we can extend without a wire break.

| category | meaning | default policy |
|----------|---------|----------------|
| `nsfw-explicit` | sexually explicit / pornographic | `blur` (tap-to-reveal; strict users: `hide`) |
| `nsfw-suggestive` | suggestive but not explicit | `show` + badge (opt-in `blur`) |
| `unknown` | not yet classified / model failure | `show` (fail-open) |

`violence`, `gore`, etc. are reserved for later and intentionally **not** auto-detected in
v1 to keep the model tiny and false-positives low.

Threshold defaults (tunable): `nsfw-explicit` if max-frame score ≥ 0.85; `nsfw-suggestive`
if ≥ 0.60. Conservative = bias toward protecting opted-out users.

### Default policy out of the box

Ship `mode: "blur"` with `nsfw-explicit → blur` **on by default**: protective, but
non-destructive (one tap reveals) and always accompanied by the visible badge (G4). Relays
and CLI default to `seedFlagged: false`. This is the conservative middle between "force
strict hide" and "show everything"; users flip to `off` or `hide` per taste. *(Flagged for
review — see §13 D4.)*

---

## 7. Schema additions (`packages/spec/schema.cjs`)

New message types (names indicative):

- `content-label` — the signed label record (§3).
- `moderation-policy` — local policy (also persisted to `metaDb`, typed for RPC so the UI
  can read/write it).
- `moderation-verdict` — `{ action, category, score, source: "override"|"local"|"label",
  advisoryCount, classifierVersion }`, attached to `video` results when present.

Extend existing types:

- `video` — add optional `moderation: moderation-verdict` (populated by the view filter).
- `feed-entry` — add optional `selfLabel: content-label` (≤1, tiny) and a compact
  `flagSummary: { nsfwExplicit: uint, nsfwSuggestive: uint }` advisory count.

New RPC endpoints:

- `classify-video { blobsCoreKey, videoId, channelKey }` → trigger/return a local verdict.
- `get-content-labels { channelKey | blobsCoreKey }` → `content-label[]` (pull path).
- `publish-content-label { ... }` → sign + gossip a label (relays / opt-in users).
- `get-moderation-policy` / `set-moderation-policy`.
- `set-content-override { blobsCoreKey, action }`.
- `subscribe-labeler { labelerKeyHex }` / `unsubscribe-labeler`.

Regenerate JS **and** Swift codegen after editing (`cd packages/spec && node schema.cjs`,
then copy generated Swift into `desktop-native` per `AGENTS.md`/`CLAUDE.md`). Because labels
are signed, the canonical signing encoding must be deterministic and identical in JS and
Swift — reuse the compact-encoding wire bytes of `content-label` (minus `signature`) as the
signing payload.

---

## 8. Storage & keys (`metaDb`, per client)

| key | value |
|-----|-------|
| `moderation:policy` | `moderation-policy` |
| `moderation:self:<blobsCoreKey>` | local verdict + `classifierVersion` + timestamp |
| `moderation:override:<blobsCoreKey>` | `"show"` \| `"hide"` |
| `moderation:labels:<blobsCoreKey>` | verified signed labels (trusted + advisory, tagged) |
| `moderation:labelers` | trust set (default relays ∪ subscriptions) |

All per-client and local. Nothing here is authoritative for anyone else.

---

## 9. Identity for labelers

Reuse the existing channel/device keypair model (`VALID_WRITER_ROLES` etc. in
`packages/backend/src/channel/multi-writer-channel.js`). A labeler key is just a Hypercore
keypair; a relay signs with its relay identity, a user who opts in to publishing signs with
their channel key. Subscribing = adding a public key to `moderation:labelers`. The default
relay labeler keys ship with the app and are editable/removable. No new PKI.

---

## 10. Phasing

- **Phase 0 (this doc).** Design sign-off.
- **Phase 1 — Local classifier + visible badge (PoC).** Multi-frame extraction in
  `thumbnail.js`; bundled ONNX MobileNet NSFW model fed raw RGB, run in `bare-worker`;
  `metaDb` verdict cache; `moderation-policy` + fail-open view filter (show+badge / blur /
  hide) in `listVideos`; user override; UI badge + tap-to-reveal blur. No network labels.
  **Smallest end-to-end slice that protects a user and shows the signal.**
- **Phase 2 — Signed labels + trusted-set crowd + seeding control.** `content-label` schema
  + signing; self-label on feed-entry; `get-content-labels` pull; advisory `flagSummary` in
  HAVE_FEED; trust set + thresholds; seed filter in `SeedingManager.addSeed()`; relay
  discovery-mode dense auto-labeling.
- **Phase 3 — Native acceleration.** Core ML (iOS/macOS), TFLite/NNAPI (Android), ONNX
  Runtime EPs (desktop) behind `NsfwClassifier`. No changes above the interface.
- **Phase 4 (optional, later).** Labeler reputation/weighting, more categories
  (violence/gore), richer labeler-subscription UI.

---

## 11. Testing strategy

- **Classifier unit tests** (backend, `bare`-runnable): feed known-RGB fixtures (a few
  bundled benign + synthetic explicit-proxy frames) through `NsfwClassifier`; assert
  category/score and the max-over-frames verdict. Assert **fail-open** when the model is
  forced unavailable (verdict `unknown`, content shown).
- **Effective-verdict logic** (pure function, no model): table-driven over
  {override, local, trusted-count, advisory-count, policy} → expected `{action, source,
  badge}`. This is where the trust precedence + thresholds live; test it hard.
- **Label signing/verify** round-trip in JS; cross-check the canonical signing bytes match
  Swift codegen output (golden vector committed).
- **Seed filter**: `addSeed` declines a flagged blob when `seedFlagged=false`, admits when
  `true` or `unknown`.
- **No network mocks for classification** — use real bundled frame fixtures and the real
  model in PoC tests.

---

## 12. Files this will touch (forward reference)

| Area | File | Change |
|------|------|--------|
| Frame extraction | `packages/backend/src/thumbnail.js` | multi-frame sampling helper |
| Classifier | `packages/backend/src/moderation/classifier.js` *(new)* | `NsfwClassifier` (ONNX, raw RGB) |
| Verdict logic | `packages/backend/src/moderation/verdict.js` *(new)* | pure effective-verdict resolver |
| Verdict cache / policy | `packages/backend/src/moderation/store.js` *(new)* | `metaDb` read/write |
| Labels | `packages/backend/src/moderation/labels.js` *(new)* | sign / verify / trust-set count |
| Worker offload | existing `bare-worker` usage | run inference off main thread |
| View filter | `packages/backend/src/api.js` (`listVideos`, feed) | apply effective verdict |
| Seed filter | `packages/backend/src/seeding.js` (`addSeed`) | decline flagged blobs |
| Labels gossip | `packages/backend/src/public-feed.js` | self-label + advisory summary; pull RPC |
| Schema | `packages/spec/schema.cjs` | new types + RPC; regen JS + Swift |
| Native (Phase 3) | `packages/desktop-native/Sources/Services/` | Core ML classifier |
| UI | `packages/app/` | NSFW badge, blur overlay, policy settings, override toggle |

---

## 13. Decision log & open questions

**Decisions adopted this session (D#):**

- **D1 — Fail-open.** Unrated content is always shown; verdicts only ever remove/blur.
- **D2 — Visible badge is mandatory** whenever any NSFW signal exists, even in show mode.
- **D3 — Crowd signal split:** trusted-set verified-label counting drives auto-blur/hide
  (sybil-resistant); raw anonymous counts are advisory-only (badge), never auto-enforce.
- **D5 — Local model = ground truth, instant only for on-device content;** labels cover
  not-yet-downloaded content; relays are the dense, high-confidence labelers.
- **D6 — Thumbnail is a weak first pass, not the verdict;** authoritative verdict is
  multi-frame; relays sample the whole file.
- **D7 — Classifier robustness:** bundle the model, feed raw RGB into ONNX (bypass
  transformers.js image decode), fail-open with diagnostics on load failure.
- **D8 — Self-label asymmetry:** honor self-labels only when they flag *up*.

**Flagged for your review:**

- **D4 — Default policy.** Proposed: `nsfw-explicit → blur` ON by default (protective,
  reversible, badge-visible); relays/CLI `seedFlagged=false`. Alternative: ship `off` by
  default (pure opt-in switch). *Pick one before implementation.*
- **D3a — Default trust set.** Proposed: ship a small set of default relay labeler keys
  (the one mild centralization point; editable/removable). Alternative: no defaults
  (B-only), accepting that auto-hide-on-crowd can't function until the user subscribes to a
  labeler. *Pick one.*

**Open questions (revisit with PoC numbers):**

- **Q1 — Frame budget.** How many keyframes per video balances recall vs. mobile cost?
  (Proposed 3–5 viewer-side; relays dense.)
- **Q2 — Calibration across backends.** Keeping Core ML / TFLite / ONNX scores comparable
  enough that `score ≥ threshold` means the same thing everywhere.
- **Q3 — Reputation (Phase 4).** Whether/how to weight labelers beyond binary trust-set
  membership.
- **Q4 — Advisory count provenance.** The HAVE_FEED `flagSummary` is forgeable; do we cap
  the displayed number, or only show the badge boolean to avoid implying precision?

---

*Adapts AT Protocol composable moderation (self-labels + subscribable labelers + local
override) to the Hypercore stack, extended with a sybil-resistant trusted-set crowd signal
and a forgeable advisory count. The detection is the easy, tiny part; the opt-in trust
model — and refusing to let raw counts auto-hide anything — is what keeps "local
moderation" from quietly becoming "decentralized censorship."*
