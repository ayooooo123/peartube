# Local-Client Moderation — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use subagent-driven-development (if subagents available) or executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the *local-only* content-moderation slice of PearTube: an on-device NSFW
classifier whose verdicts (plus a local policy and per-video user override) drive a
fail-open view filter that blurs/hides/badges videos — entirely client-side, no network
labels.

**Architecture:** Five backend modules under `packages/backend/src/moderation/` (pure
`verdict` resolver, `policy`, metaDb `store`, raw-RGB `frames` sampler, `classifier`) plus an
`index` orchestrator wired into `api.js` `listVideos`; HRPC schema additions for policy /
override / verdict; an opt-in settings toggle + NSFW badge + tap-to-reveal blur in the app.
Moderation ships **OFF by default** (per spec §13 D4) and uses **no network trust set** (D3a)
— the local model is the sole enforcer once enabled.

**Tech Stack:** Node/Bare (backend), `bare-ffmpeg` (frame decode), `@xenova/transformers`
ONNX (classifier PoC), Hyperbee `metaDb` (storage), Hyperschema/HRPC (`packages/spec`),
Expo/React Native + Expo-web (app), `brittle` (backend tests).

**Spec:** `docs/superpowers/specs/2026-06-26-local-client-moderation-design.md` (rev 5,
review-approved). This plan implements **Phase 1 + Phase 1a only**; signed labels, trusted-set
crowd, and seeding control are Phase 2 (separate plan).

---

## File structure (Phase 1)

| File | Responsibility |
|------|----------------|
| `packages/backend/src/moderation/verdict.js` *(new)* | Pure severity-lattice resolver + category constants. No I/O. |
| `packages/backend/src/moderation/policy.js` *(new)* | `defaultPolicy()`, `validatePolicy()`, `normalizePolicy()`. Pure. |
| `packages/backend/src/moderation/store.js` *(new)* | metaDb read/write: policy, self-verdict (version-keyed), override. |
| `packages/backend/src/moderation/frames.js` *(new)* | Raw-RGB24 multi-frame sampler (reuses the `thumbnail.js` decode pipeline). |
| `packages/backend/src/moderation/classifier.js` *(new)* | `NsfwClassifier` interface, ONNX impl (spike-gated), deterministic test stub. |
| `packages/backend/src/moderation/index.js` *(new)* | Orchestrator: `classifyVideo`, `getEffectiveVerdict`, `applyModeration`. |
| `packages/backend/src/api.js` *(modify)* | View filter in `listVideos`; RPC method handlers; background classify trigger. |
| `packages/spec/schema.cjs` *(modify)* | `moderation-policy`, `moderation-verdict` types; `video.moderation`; RPC methods. |
| `packages/protocol/src/create-client.js` *(modify)* | Expose `moderation` namespace methods. |
| `packages/platform/src/rpc.shared.ts` *(modify)* | App-facing facade for moderation RPC. |
| `packages/app/...` *(modify)* | Settings toggle, NSFW badge, blur overlay, override action. |
| `packages/backend/test/moderation-*.test.mjs` *(new)* | brittle tests for verdict/policy/store/classifier. |

---

## Chunk 0: Phase 1a feasibility spike (go/no-go gate)

**Purpose:** Prove the bundled-ONNX-on-raw-RGB classifier actually runs in the BareKit
(mobile) and Electrobun (desktop) worker runtimes before building on it (spec §5.1). This is
exploratory; its output is a decision + the chosen classifier backend, not shipped product
code. **Do not start Chunk 3 until this passes or routes to native.**

- [ ] **Step 0.1 — Pick + fetch a small int8 model.** Choose a MobileNetV2-class NSFW
  image-classification model exported to ONNX int8 (2–5 MB). Place it under
  `packages/backend/assets/moderation/nsfw-mnv2-int8/` (model + `config.json` +
  `preprocessor_config.json` as transformers.js expects for a local model). Record the
  chosen `classifierVersion` string (e.g. `nsfw-mnv2-int8@1`).

- [ ] **Step 0.2 — Write a standalone spike script** `scripts/moderation-spike.mjs` that, in a
  `bare-worker` (mirror the worker-spawn pattern in `packages/backend/src/mirror/seeder.js`):
  - sets `env.allowRemoteModels = false`, `env.localModelPath = <assets dir>`, and
    `env.backends.onnx.wasm.wasmPaths = <bundled ort-wasm dir>`;
  - decodes one RGB24 224×224 frame from a sample video via `bare-ffmpeg` (reuse
    `thumbnail.js` decode; force `dstPixelFormat = RGB24`);
  - builds a transformers.js `RawImage(buffer, 224, 224, 3)` and runs
    `pipeline('image-classification', localModelId)`;
  - logs: cold-load ms, per-frame ms, peak RSS, and the label output.

- [ ] **Step 0.3 — Run on desktop (Electrobun/Node-Bare).** `node scripts/moderation-spike.mjs`.
  Expected: a label + scores printed, load < ~3 s, per-frame < ~50 ms. Capture numbers.

- [ ] **Step 0.4 — Run inside the mobile BareKit worklet** (iOS + Android dev client). Expected:
  same — model loads, classification returns. Capture numbers + any module-load failures
  (transformers.js imports `sharp`/`onnxruntime-node` at module scope; note whether the Bare
  bundler tolerates the dynamic, string-concatenated import used in `semantic-finder.js:65`).

- [ ] **Step 0.5 — Decide & record.** Append a "Phase 1a results" note to the spec's §5.1 with
  the measured numbers and the decision: **PASS** (use ONNX `classifier.js` everywhere that
  passed) or **PER-PLATFORM FALLBACK** (that platform skips to native Core ML/TFLite behind the
  same `NsfwClassifier` interface — file a Phase-3 task; for Phase 1 that platform reports the
  verdict as `unknown` = fail-open). Commit the assets + spike script + results note.

```bash
git add packages/backend/assets/moderation scripts/moderation-spike.mjs docs/superpowers/specs/2026-06-26-local-client-moderation-design.md
git commit -m "spike(moderation): validate bundled ONNX raw-RGB classifier on Bare/Electrobun"
```

---

## Chunk 1: Pure core — verdict resolver + policy

The heart of the design (spec §3.3). Pure functions, zero I/O, fully unit-testable. Build
this first; everything else depends on it.

### Task 1: Category constants + severity helpers

**Files:**
- Create: `packages/backend/src/moderation/verdict.js`
- Test: `packages/backend/test/moderation-verdict.test.mjs`

- [ ] **Step 1.1 — Write the failing test** (`moderation-verdict.test.mjs`):

```js
import test from 'brittle'
import { CATEGORY, severity, maxCategory } from '../src/moderation/verdict.js'

test('severity orders categories explicit > suggestive > none', (t) => {
  t.ok(severity(CATEGORY.EXPLICIT) > severity(CATEGORY.SUGGESTIVE))
  t.ok(severity(CATEGORY.SUGGESTIVE) > severity(CATEGORY.NONE))
  t.is(severity('garbage'), 0) // unknown treated as none
})

test('maxCategory picks the strongest', (t) => {
  t.is(maxCategory([CATEGORY.NONE, CATEGORY.SUGGESTIVE, CATEGORY.EXPLICIT]), CATEGORY.EXPLICIT)
  t.is(maxCategory([CATEGORY.NONE]), CATEGORY.NONE)
  t.is(maxCategory([]), CATEGORY.NONE)
})
```

- [ ] **Step 1.2 — Run, verify it fails:** `cd packages/backend && npx brittle test/moderation-verdict.test.mjs` → FAIL (module not found).

- [ ] **Step 1.3 — Implement** (`verdict.js`, part 1):

```js
// Pure moderation verdict resolver — no I/O. Implements spec §3.3 severity lattice.
export const CATEGORY = Object.freeze({
  NONE: 'none',
  SUGGESTIVE: 'nsfw-suggestive',
  EXPLICIT: 'nsfw-explicit'
})

const SEVERITY = Object.freeze({
  [CATEGORY.NONE]: 0,
  [CATEGORY.SUGGESTIVE]: 1,
  [CATEGORY.EXPLICIT]: 2
})

export function severity (category) {
  return SEVERITY[category] || 0
}

export function maxCategory (categories) {
  let best = CATEGORY.NONE
  for (const c of categories) if (severity(c) > severity(best)) best = c
  return best
}
```

- [ ] **Step 1.4 — Run, verify pass.** Then commit:

```bash
git add packages/backend/src/moderation/verdict.js packages/backend/test/moderation-verdict.test.mjs
git commit -m "feat(moderation): category constants + severity helpers"
```

### Task 2: The resolver (`resolveModerationAction`)

**Files:**
- Modify: `packages/backend/src/moderation/verdict.js`
- Test: `packages/backend/test/moderation-verdict.test.mjs`

- [ ] **Step 2.1 — Write the failing table-driven test.** Cover every spec §3.3 case:

```js
import { resolveModerationAction } from '../src/moderation/verdict.js'

const POLICY = {
  mode: 'blur',
  categories: { 'nsfw-explicit': 'blur', 'nsfw-suggestive': 'show' },
  trustLocalModel: true,
  blurThreshold: 1,
  hideThreshold: 3
}
const off = (p) => ({ ...POLICY, ...p })

test('override show beats everything', (t) => {
  const r = resolveModerationAction({ override: 'show', localVideo: { category: 'nsfw-explicit', score: 1 } }, POLICY)
  t.is(r.action, 'show'); t.is(r.source, 'override')
})

test('override hide beats everything', (t) => {
  const r = resolveModerationAction({ override: 'hide' }, POLICY)
  t.is(r.action, 'hide'); t.is(r.source, 'override')
})

test('mode off shows everything', (t) => {
  const r = resolveModerationAction({ localVideo: { category: 'nsfw-explicit', score: 1 } }, off({ mode: 'off' }))
  t.is(r.action, 'show'); t.is(r.source, 'policy-off')
})

test('no signal -> show', (t) => {
  const r = resolveModerationAction({}, POLICY)
  t.is(r.action, 'show'); t.is(r.category, 'none')
})

test('thumbnail-only explicit caps at blur (never hide) even with categories=hide', (t) => {
  const r = resolveModerationAction(
    { localThumb: { category: 'nsfw-explicit', score: 1 } },
    off({ mode: 'hide', categories: { 'nsfw-explicit': 'hide', 'nsfw-suggestive': 'show' } })
  )
  t.is(r.action, 'blur') // weakOnly downgrades hide->blur
})

test('authoritative local explicit under default blur policy -> blur', (t) => {
  const r = resolveModerationAction({ localVideo: { category: 'nsfw-explicit', score: 0.9 } }, POLICY)
  t.is(r.action, 'blur'); t.is(r.source, 'local')
})

test('authoritative local explicit + user categories=hide + mode hide -> hide', (t) => {
  const r = resolveModerationAction(
    { localVideo: { category: 'nsfw-explicit', score: 0.9 } },
    off({ mode: 'hide', categories: { 'nsfw-explicit': 'hide', 'nsfw-suggestive': 'show' } })
  )
  t.is(r.action, 'hide')
})

test('single trusted label -> blur, never hide', (t) => {
  const r = resolveModerationAction({ trustedCount: { 'nsfw-explicit': 1, 'nsfw-suggestive': 1 } }, POLICY)
  t.is(r.action, 'blur')
})

test('hideThreshold distinct trusted labelers -> hide when mode allows', (t) => {
  const r = resolveModerationAction(
    { trustedCount: { 'nsfw-explicit': 3, 'nsfw-suggestive': 3 } },
    off({ mode: 'hide' })
  )
  t.is(r.action, 'hide')
})

test('hideThreshold trusted labelers but mode blur clamps to blur', (t) => {
  const r = resolveModerationAction({ trustedCount: { 'nsfw-explicit': 3, 'nsfw-suggestive': 3 } }, POLICY)
  t.is(r.action, 'blur')
})

test('advisory count never changes action, only badge', (t) => {
  const r = resolveModerationAction({ advisoryCount: 999 }, POLICY)
  t.is(r.action, 'show'); t.ok(r.badge)
})

test('sparse local negative does not lower a trusted positive', (t) => {
  // localVideo says none/safe, trusted says explicit -> must still raise
  const r = resolveModerationAction(
    { localVideo: { category: 'none', score: 0.1 }, trustedCount: { 'nsfw-explicit': 3, 'nsfw-suggestive': 3 } },
    off({ mode: 'hide' })
  )
  t.is(r.action, 'hide')
})
```

- [ ] **Step 2.2 — Run, verify it fails** (resolver not defined).

- [ ] **Step 2.3 — Implement `resolveModerationAction`** (append to `verdict.js`):

```js
const DEFAULT_CATEGORY_POLICY = { 'nsfw-explicit': 'blur', 'nsfw-suggestive': 'show' }

/**
 * Pure resolver. `inputs` may include: override ('show'|'hide'|null),
 * localVideo {category,score}|null (authoritative), localThumb {category,score}|null (weak),
 * selfLabelUp {category}|null, trustedCount { <category>: distinctLabelerKeys }, advisoryCount uint.
 * Returns { action:'show'|'blur'|'hide', category, source, score, badge }.
 */
export function resolveModerationAction (inputs = {}, policy = {}) {
  const {
    override = null, localVideo = null, localThumb = null,
    selfLabelUp = null, trustedCount = {}, advisoryCount = 0
  } = inputs
  const mode = policy.mode || 'off'
  const cats = policy.categories || DEFAULT_CATEGORY_POLICY
  const trustLocalModel = policy.trustLocalModel !== false
  const blurThreshold = Math.max(1, policy.blurThreshold || 1)
  const hideThreshold = Math.max(blurThreshold, policy.hideThreshold || 3)
  const badge = makeBadge({ localVideo, localThumb, selfLabelUp, trustedCount, advisoryCount, trustLocalModel })

  if (override === 'show') return { action: 'show', category: CATEGORY.NONE, source: 'override', score: 0, badge }
  if (override === 'hide') return { action: 'hide', category: CATEGORY.NONE, source: 'override', score: 0, badge }
  if (mode === 'off') return { action: 'show', category: CATEGORY.NONE, source: 'policy-off', score: 0, badge }

  // Collect contributors as { category, strong, source, score }.
  const contributors = []
  if (trustLocalModel && localVideo && severity(localVideo.category) > 0) {
    contributors.push({ category: localVideo.category, strong: true, source: 'local', score: localVideo.score || 0 })
  }
  if (trustLocalModel && localThumb && severity(localThumb.category) > 0) {
    contributors.push({ category: localThumb.category, strong: false, source: 'local', score: localThumb.score || 0 })
  }
  if (selfLabelUp && severity(selfLabelUp.category) > 0) {
    contributors.push({ category: selfLabelUp.category, strong: true, source: 'label', score: 1 })
  }
  for (const c of [CATEGORY.EXPLICIT, CATEGORY.SUGGESTIVE]) {
    const n = trustedCount[c] || 0
    if (n >= blurThreshold) contributors.push({ category: c, strong: n >= hideThreshold, source: 'label', score: 1 })
  }

  const C = maxCategory(contributors.map((c) => c.category))
  if (C === CATEGORY.NONE) return { action: 'show', category: CATEGORY.NONE, source: 'none', score: 0, badge }

  const atC = contributors.filter((c) => c.category === C)
  const weakOnly = !atC.some((c) => c.strong)
  const winner = atC.find((c) => c.strong) || atC[0]

  // base action
  let action
  if ((trustedCount[C] || 0) >= hideThreshold) action = 'hide'
  else action = cats[C] || DEFAULT_CATEGORY_POLICY[C] || 'show'
  if (weakOnly && action === 'hide') action = 'blur'           // weak signals never hide
  if (mode === 'blur' && action === 'hide') action = 'blur'     // mode clamp

  return { action, category: C, source: winner.source, score: winner.score, badge }
}

function makeBadge ({ localVideo, localThumb, selfLabelUp, trustedCount, advisoryCount, trustLocalModel }) {
  const anyLocal = trustLocalModel && ((localVideo && severity(localVideo.category) > 0) || (localThumb && severity(localThumb.category) > 0))
  const anyTrusted = (trustedCount[CATEGORY.EXPLICIT] || 0) > 0 || (trustedCount[CATEGORY.SUGGESTIVE] || 0) > 0
  const anyAdvisory = (advisoryCount || 0) > 0
  if (!anyLocal && !anyTrusted && !selfLabelUp && !anyAdvisory) return null
  return { local: !!anyLocal, trusted: !!anyTrusted, selfReported: !!selfLabelUp, advisory: !!anyAdvisory }
}
```

- [ ] **Step 2.4 — Run, verify all cases pass.** Commit:

```bash
git add packages/backend/src/moderation/verdict.js packages/backend/test/moderation-verdict.test.mjs
git commit -m "feat(moderation): severity-lattice resolver with full case coverage"
```

### Task 3: Policy defaults + validation

**Files:**
- Create: `packages/backend/src/moderation/policy.js`
- Test: `packages/backend/test/moderation-policy.test.mjs`

- [ ] **Step 3.1 — Failing test:**

```js
import test from 'brittle'
import { defaultPolicy, validatePolicy, normalizePolicy } from '../src/moderation/policy.js'

test('default policy is OFF and B-only', (t) => {
  const p = defaultPolicy()
  t.is(p.mode, 'off')
  t.alike(p.trustedLabelers, [])
  t.is(p.categories['nsfw-explicit'], 'blur')
  t.is(p.blurThreshold, 1); t.is(p.hideThreshold, 3)
})

test('validatePolicy rejects bad thresholds and enums', (t) => {
  t.ok(validatePolicy(defaultPolicy()).ok)
  t.absent(validatePolicy({ ...defaultPolicy(), blurThreshold: 0 }).ok)
  t.absent(validatePolicy({ ...defaultPolicy(), hideThreshold: 0 }).ok) // < blurThreshold
  t.absent(validatePolicy({ ...defaultPolicy(), mode: 'wat' }).ok)
  t.absent(validatePolicy({ ...defaultPolicy(), categories: { 'nsfw-explicit': 'nuke' } }).ok)
})

test('normalizePolicy fills missing fields from defaults', (t) => {
  const p = normalizePolicy({ mode: 'blur' })
  t.is(p.mode, 'blur'); t.is(p.hideThreshold, 3)
})
```

- [ ] **Step 3.2 — Run, verify fail.**

- [ ] **Step 3.3 — Implement `policy.js`:**

```js
import { CATEGORY } from './verdict.js'

const MODES = new Set(['off', 'blur', 'hide'])
const ACTIONS = new Set(['show', 'blur', 'hide'])

export function defaultPolicy () {
  return {
    mode: 'off',                                  // spec §13 D4: ships OFF
    categories: { [CATEGORY.EXPLICIT]: 'blur', [CATEGORY.SUGGESTIVE]: 'show' },
    trustLocalModel: true,
    trustedLabelers: [],                          // spec §13 D3a: no defaults
    blurThreshold: 1,
    hideThreshold: 3,
    showAdvisoryBadge: true,
    seedFlagged: false,                            // seeder-only (Phase 2)
    seedUnknown: false
  }
}

export function validatePolicy (p) {
  const errors = []
  if (!MODES.has(p.mode)) errors.push('mode must be off|blur|hide')
  if (!(p.blurThreshold >= 1)) errors.push('blurThreshold must be >= 1')
  if (!(p.hideThreshold >= p.blurThreshold)) errors.push('hideThreshold must be >= blurThreshold')
  for (const [k, v] of Object.entries(p.categories || {})) {
    if (!ACTIONS.has(v)) errors.push(`category ${k} action must be show|blur|hide`)
  }
  return { ok: errors.length === 0, errors }
}

export function normalizePolicy (partial = {}) {
  const merged = { ...defaultPolicy(), ...partial }
  merged.categories = { ...defaultPolicy().categories, ...(partial.categories || {}) }
  return merged
}
```

- [ ] **Step 3.4 — Run, verify pass.** Commit:

```bash
git add packages/backend/src/moderation/policy.js packages/backend/test/moderation-policy.test.mjs
git commit -m "feat(moderation): policy defaults (off, B-only) + validation"
```

**→ Plan review checkpoint: dispatch the reviewer on Chunk 1 before continuing.**

---

## Chunk 2: metaDb store

Persistence for policy, version-keyed self-verdicts, and overrides (spec §8). Hyperbee
`metaDb` `.get` returns `{ value }`; `.put(key, value)` stores it.

### Task 4: Store read/write + version invalidation

**Files:**
- Create: `packages/backend/src/moderation/store.js`
- Test: `packages/backend/test/moderation-store.test.mjs`

- [ ] **Step 4.1 — Failing test** (reuse the metaDb mock shape from
  `test/api-comments-hyperdb.test.mjs`):

```js
import test from 'brittle'
import { ModerationStore } from '../src/moderation/store.js'

function fakeMetaDb () {
  const m = new Map()
  return {
    async get (k) { return m.has(k) ? { value: m.get(k) } : null },
    async put (k, v) { m.set(k, v) },
    async del (k) { m.delete(k) }
  }
}

test('policy round-trips and defaults when absent', async (t) => {
  const s = new ModerationStore({ metaDb: fakeMetaDb() })
  t.is((await s.getPolicy()).mode, 'off')             // default
  await s.setPolicy({ mode: 'blur' })
  t.is((await s.getPolicy()).mode, 'blur')
})

test('self-verdict invalidates on classifierVersion change', async (t) => {
  const s = new ModerationStore({ metaDb: fakeMetaDb(), classifierVersion: 'v1' })
  await s.putSelfVerdict('blob1', { category: 'nsfw-explicit', score: 0.9 })
  t.is((await s.getSelfVerdict('blob1')).category, 'nsfw-explicit')
  const s2 = new ModerationStore({ metaDb: s.metaDb, classifierVersion: 'v2' })
  t.is(await s2.getSelfVerdict('blob1'), null)        // stale -> null
})

test('override round-trips', async (t) => {
  const s = new ModerationStore({ metaDb: fakeMetaDb() })
  await s.setOverride('blob1', 'show')
  t.is(await s.getOverride('blob1'), 'show')
  await s.setOverride('blob1', null)
  t.is(await s.getOverride('blob1'), null)
})
```

- [ ] **Step 4.2 — Run, verify fail.**

- [ ] **Step 4.3 — Implement `store.js`:**

```js
import { normalizePolicy, validatePolicy } from './policy.js'

const K_POLICY = 'moderation:policy'
const kSelf = (blob) => `moderation:self:${blob}`
const kOverride = (blob) => `moderation:override:${blob}`

export class ModerationStore {
  constructor ({ metaDb, classifierVersion = 'unknown' } = {}) {
    this.metaDb = metaDb
    this.classifierVersion = classifierVersion
  }

  async getPolicy () {
    const row = await this.metaDb?.get(K_POLICY)
    return normalizePolicy(row?.value || {})
  }

  async setPolicy (partial) {
    const next = normalizePolicy(partial)
    const v = validatePolicy(next)
    if (!v.ok) throw new Error(`invalid moderation policy: ${v.errors.join('; ')}`)
    await this.metaDb?.put(K_POLICY, next)
    return next
  }

  async getSelfVerdict (blobsCoreKey) {
    const row = await this.metaDb?.get(kSelf(blobsCoreKey))
    const val = row?.value
    if (!val) return null
    if (val.classifierVersion !== this.classifierVersion) return null // stale -> recompute
    return val
  }

  async putSelfVerdict (blobsCoreKey, verdict) {
    await this.metaDb?.put(kSelf(blobsCoreKey), {
      ...verdict, classifierVersion: this.classifierVersion, ts: Date.now()
    })
  }

  async getOverride (blobsCoreKey) {
    const row = await this.metaDb?.get(kOverride(blobsCoreKey))
    return row?.value?.action || null
  }

  async setOverride (blobsCoreKey, action) {
    if (action == null) { await this.metaDb?.del(kOverride(blobsCoreKey)); return }
    await this.metaDb?.put(kOverride(blobsCoreKey), { action })
  }
}
```

- [ ] **Step 4.4 — Run, verify pass.** Commit:

```bash
git add packages/backend/src/moderation/store.js packages/backend/test/moderation-store.test.mjs
git commit -m "feat(moderation): metaDb store with version-keyed verdict invalidation"
```

**→ Plan review checkpoint.**

---

## Chunk 3: Frames + classifier (spike-gated)

### Task 5: Raw-RGB24 multi-frame sampler

**Files:**
- Create: `packages/backend/src/moderation/frames.js`
- Reference: `packages/backend/src/thumbnail.js:215-323` (decode loop to mirror);
  `api.js:2290` (`ctx.blobServer.getLink(coreKey, {...})` → local blob URL)

- [ ] **Step 5.1 — Implement `extractRgbFrames(filePath, { count = 4, size = 224 })`** by
  adapting the `thumbnail.js` pipeline (via `createFileReadIOContext`): open
  `InputFormatContext`, best video stream, decoder; compute `count` indices spread across the
  duration; for each, scale via `ff.Scaler(inFmt, srcW, srcH, RGB24, size, size)` into a fresh
  `Frame`; **copy the buffer before `unref`** and push `{ data: Buffer, width: size, height:
  size, channels: 3 }`. Return `[]` on any failure (fail-open). Differences from
  `thumbnail.js`: `dstPixelFormat = RGB24`, multiple indices, no encoding.

- [ ] **Step 5.2 — Implement `resolveClassifiableSource({ blobsCoreKey, blobId, thumbnailBlobsCoreKey, thumbnailBlobId, blobServer, kind })`**
  → a local file path or null. P2P/playback code only has blob refs + a blob-server URL, **not**
  a filesystem path, so materialize bytes into a bounded temp file:
  - `kind:'thumb'` → fetch the small thumbnail blob from
    `blobServer.getLink(thumbnailBlobsCoreKey, { blob: thumbnailBlobId })` to a temp file.
  - `kind:'video'` → only if bytes are already local (seeded/cached); stream a **bounded
    prefix** (covering the sampled frame range) from `blobServer.getLink(blobsCoreKey, { blob:
    blobId })` to a temp file; if not local yet, return null (fail-open, classify later).
  Caller deletes the temp file after `extractRgbFrames`.

- [ ] **Step 5.3 — Test** `moderation-frames.test.mjs` (red → green): against a tiny bundled
  fixture (`packages/backend/test/fixtures/sample.mp4`), assert `extractRgbFrames` returns N
  frames of `size*size*3` bytes; assert `[]` for a missing file. Run `npx brittle
  test/moderation-frames.test.mjs`. Commit.

### Task 6: NsfwClassifier (ONNX impl + test stub)

**Files:**
- Create: `packages/backend/src/moderation/classifier.js`
- Test: `packages/backend/test/moderation-classifier.test.mjs`

- [ ] **Step 6.1 — Define the interface + a deterministic stub** for tests (no model):

```js
export class StubClassifier {
  constructor (map = {}) { this.version = 'stub@1'; this.map = map } // map: frameTag -> {category,score}
  async classifyFrames (frames) {
    return frames.map((f, i) => this.map[i] || { category: 'none', score: 0 })
  }
}
```

- [ ] **Step 6.2 — Test fail-open + max-over-frames** using the stub + the orchestrator's
  reduce (see Task 7): a classifier that throws → verdict `unknown`(=none); frames with one
  explicit → video verdict explicit (max). Run, fail, then implement reduce in `index.js`
  (Task 7) and re-run.

- [ ] **Step 6.3 — Implement `OnnxClassifier`** (only if Chunk 0 PASSED for the platform):
  mirror `packages/backend/src/search/semantic-finder.js:60-110` lazy-load with its string-concatenated import,
  `env.allowRemoteModels=false`, `env.localModelPath`, `env.backends.onnx.wasm.wasmPaths`, a
  load timeout, and **fail-open** (`classifyFrames` returns `none` scores + sets an
  `available=false` diagnostic flag if load failed — never throws to the caller). Build
  `RawImage(frame.data, frame.width, frame.height, 3)` and run `image-classification`; map the
  model's labels to `CATEGORY` + threshold (explicit ≥ 0.85, suggestive ≥ 0.60). `version` =
  the `classifierVersion` from Chunk 0.

- [ ] **Step 6.4 — Run tests, commit.**

```bash
git add packages/backend/src/moderation/frames.js packages/backend/src/moderation/classifier.js packages/backend/test/moderation-frames.test.mjs packages/backend/test/moderation-classifier.test.mjs
git commit -m "feat(moderation): raw-RGB frame sampler + NsfwClassifier (ONNX + stub, fail-open)"
```

**→ Plan review checkpoint.**

---

## Chunk 4: Orchestrator + api.js + schema/RPC

### Task 7: Orchestrator (`index.js`)

**Files:**
- Create: `packages/backend/src/moderation/index.js`
- Test: `packages/backend/test/moderation-orchestrator.test.mjs`

- [ ] **Step 7.1 — Implement `Moderation`** holding `{ store, classifier }` with:
  - `async classifyOne({ blobKey, sourceRefs, kind, blobServer })` → if
    `store.getSelfVerdict(blobKey)` hits, return it; else `resolveClassifiableSource(...)` →
    `extractRgbFrames(path)` → `classifier.classifyFrames` → reduce to `maxCategory` + max
    score → `store.putSelfVerdict(blobKey, verdict)` → delete temp → return. Fail-open: on any
    throw or null source, return `{ category:'none', score:0 }` and do **not** cache it.
    `kind:'thumb'` keys on `thumbnailBlobsCoreKey`; `kind:'video'` on `blobsCoreKey` (spec §3.1).
  - `async getEffectiveVerdict({ blobsCoreKey, thumbnailBlobsCoreKey })` → read policy +
    override + `store.getSelfVerdict(blobsCoreKey)` (authoritative `localVideo`) +
    `store.getSelfVerdict(thumbnailBlobsCoreKey)` (weak `localThumb`) →
    `resolveModerationAction({ override, localVideo, localThumb }, policy)` → return the result
    (with its nested `badge`).
  - `async applyModeration(videos)` → for each, `getEffectiveVerdict(...)`, attach a
    **flattened wire** `moderation` `{ action, category, source, score, badgeLocal,
    badgeTrusted, badgeSelfReported, badgeAdvisory }` (map the resolver's nested `badge.*`), and
    drop `action === 'hide'`. **Pure local-cache reads only** (spec §3.3) — no classify, no
    network here.
- [ ] **Step 7.2 — Tests:** classifyVideo caches + reuses; getEffectiveVerdict honors override;
  applyModeration drops `hide` and keeps `blur`/`show` with the field. Run, commit.

### Task 8: Wire into api.js + background classify

**Files:**
- Modify: `packages/backend/src/api.js` (construct `Moderation` near
  `context.semanticFinder = new SemanticFinder(...)` at `api.js:292`; apply filter inside
  `listVideos` at `api.js:1428` after `withAvailability` is built and before returning/caching)
- Test: extend an api test or add `moderation-api.test.mjs`

- [ ] **Step 8.1 — Construct** `context.moderation = new Moderation({ store: new ModerationStore({ metaDb: context.metaDb, classifierVersion }), classifier })`.
- [ ] **Step 8.2 — Apply the filter** in `listVideos`: replace the returned/cached
  `withAvailability` value with `await context.moderation.applyModeration(withAvailability)`.
  Keep the existing cache, but cache the **unfiltered** list and apply moderation on read (so a
  policy change doesn't serve stale filtered results — spec §3.3), or invalidate
  `listVideosCache` on `setPolicy`/`setOverride`. Choose invalidation: simplest correct option
  is to apply `applyModeration` *after* reading from `listVideosCache`.
- [ ] **Step 8.3 — Background classify trigger:** when a thumbnail resolves
  (`getVideoThumbnail`, `api.js:2290`) fire-and-forget `moderation.classifyOne({ blobKey:
  thumbnailBlobsCoreKey, kind:'thumb', sourceRefs, blobServer: ctx.blobServer })`; on playback,
  when video bytes are local, schedule the `kind:'video'` pass. Run in the `bare-worker`; never
  block playback/thumbnail. Skip entirely when `policy.mode === 'off'` (dormant, spec §6).
- [ ] **Step 8.4 — Add RPC handlers** (methods object in `api.js`): `getModerationPolicy`,
  `setModerationPolicy` (validates), `setContentOverride`, `classifyVideo`. Follow the existing
  method-registration pattern in the `api.js` returned object.
- [ ] **Step 8.5 — Tests + commit.**

### Task 9: Schema + protocol + platform plumbing

**Files:**
- Modify: `packages/spec/schema.cjs` (types near other `ns.register` blocks; RPC near
  `rpcNs` at `schema.cjs:2682`)
- Modify: `packages/protocol/src/create-client.js`, `packages/platform/src/rpc.shared.ts`

- [ ] **Step 9.1 — Register types** in `schema.cjs`:

```js
ns.register({
  name: 'moderation-verdict',
  fields: [
    { name: 'action', type: 'string', required: true },     // show|blur|hide
    { name: 'category', type: 'string', required: false },
    { name: 'source', type: 'string', required: false },
    { name: 'score', type: 'float', required: false },
    { name: 'badgeLocal', type: 'bool', required: false },
    { name: 'badgeTrusted', type: 'bool', required: false },
    { name: 'badgeSelfReported', type: 'bool', required: false },
    { name: 'badgeAdvisory', type: 'bool', required: false }
  ]
})
ns.register({
  name: 'moderation-policy',
  fields: [
    { name: 'mode', type: 'string', required: true },
    { name: 'explicitAction', type: 'string', required: false },
    { name: 'suggestiveAction', type: 'string', required: false },
    { name: 'trustLocalModel', type: 'bool', required: false },
    { name: 'blurThreshold', type: 'uint', required: false },
    { name: 'hideThreshold', type: 'uint', required: false },
    { name: 'showAdvisoryBadge', type: 'bool', required: false }
  ]
})
```

  Add optional `moderation` (`moderation-verdict`) to the existing `video` type. (Flatten the
  category map to `explicitAction`/`suggestiveAction` for the wire; the backend re-inflates to
  `categories`.)

- [ ] **Step 9.2 — Register named request types** in `schema.cjs` (HRPC needs named types,
  not inline shapes): `set-content-override-request { blobsCoreKey: string, action: string }`
  and `classify-video-request { blobsCoreKey, videoId, channelKey, thumbnailBlobsCoreKey }`.

- [ ] **Step 9.3 — Register RPC methods** on `rpcNs` (~`schema.cjs:2682`):
  `getModerationPolicy` (empty → moderation-policy), `setModerationPolicy` (moderation-policy →
  moderation-policy), `setContentOverride` (set-content-override-request → empty),
  `classifyVideo` (classify-video-request → moderation-verdict). Match the existing method
  pattern.

- [ ] **Step 9.4 — Register the app-facing namespace (REQUIRED).** Add a `moderation` entry
  listing these commands to `APP_RPC_NAMESPACES` in
  `packages/spec/lib/app-rpc-adapter-codegen.cjs` (line 7). An HRPC command absent from this
  map makes `schema:full` fail as an *unclassified command* and leaves
  `NAMESPACE_METHODS.moderation` undefined.

- [ ] **Step 9.5 — Regenerate:** `npm run schema:full` (JS + Swift). Expected: clean, no
  "unclassified command" error; generated `app-rpc-adapter.mjs` lists `moderation`.

- [ ] **Step 9.6 — Expose** the `moderation` namespace through `create-client.js` and
  `rpc.shared.ts`, following the `video`/`feed` wiring. The api handler (Task 8.4) returns the
  **flattened** `moderation-verdict` (`badge.local → badgeLocal`, etc.).

- [ ] **Step 9.7 — Commit** (schema, generated output, adapter codegen, protocol, platform).

**→ Plan review checkpoint.**

---

## Chunk 5: App UI (opt-in)

**Files (read first to match patterns):** the feed/list component that renders thumbnails
(grep `getVideoThumbnail`/`thumbnailBlobsCoreKey` usage in `packages/app/`), the settings
screen, and the video card component.

- [ ] **Step 10.1 — Settings: moderation toggle.** Add a "Content moderation" section: a master
  switch (off→blur), and when on, an "explicit content" choice (blur/hide) and a
  "blur suggestive" toggle. Wire to `getModerationPolicy`/`setModerationPolicy` via the
  platform facade. Default reflects OFF.
- [ ] **Step 10.2 — NSFW badge.** On each video card, if any of
  `video.moderation?.badgeLocal | badgeTrusted | badgeSelfReported | badgeAdvisory` is set,
  render a small "NSFW / may be explicit" badge (always visible, even in show mode — spec G4).
- [ ] **Step 10.3 — Blur overlay.** If `video.moderation?.action === 'blur'`, render the
  thumbnail behind a blur + tap-to-reveal overlay. (`hide` videos are already absent from the
  list — filtered server-side.)
- [ ] **Step 10.4 — Override.** Add a long-press / menu action "Always show" / "Always hide"
  calling `setContentOverride`; refresh the affected card.
- [ ] **Step 10.5 — Manual QA** (see Verification) + commit.

**→ Plan review checkpoint (final).**

---

## Verification (whole-feature, after all chunks)

- [ ] `cd packages/backend && npm test` — all `moderation-*.test.mjs` green (run the full
  suite once at the end, per harness policy).
- [ ] `npm run typecheck` at root (covers `platform`/`app` TS).
- [ ] `npm run schema` clean (no drift).
- [ ] **Manual E2E (desktop, `npm run desktop`):** moderation OFF by default → feed shows
  everything, no badges, classifier dormant. Turn ON (blur) → seed/playback a known-explicit
  test clip → after background classify, its card blurs + shows the badge; tap reveals. Set
  override "Always show" → stays revealed across refresh. Set explicit→hide + mode hide → the
  card disappears from the feed. Turn moderation OFF again → everything shows.
- [ ] **Fail-open check:** with the model asset removed/renamed, enabling moderation must NOT
  empty or freeze the feed (verdict `unknown` → shown); a diagnostic logs the load failure.

---

## Notes for the implementer

- **DRY/YAGNI:** Phase 1 has no labels, no trusted set, no seeding control — do **not** build
  `label-feed.js`, label signing, or seed quarantine here (Phase 2). The resolver already
  accepts `trustedCount`/`selfLabelUp` for forward-compat; leave them unfed in Phase 1.
- **Fail-open is load-bearing.** Every classifier/frame path returns a benign `unknown` on
  error; the feed must never break because moderation failed.
- **Hot path purity (spec §3.3):** `listVideos` must only read cached verdicts via the pure
  resolver — never classify or hit the network inside it.
- **Dormant when off (spec §6):** when `policy.mode === 'off'`, skip classification entirely.
- Reference skills with @ as needed: @test-driven-development, @verification-before-completion.
