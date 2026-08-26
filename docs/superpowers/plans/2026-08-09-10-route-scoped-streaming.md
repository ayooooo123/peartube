# Route-Scoped Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve verified asset bytes through short-lived route capabilities with correct GET/HEAD and HTTP Range behavior.

**Architecture:** Successful deferred open creates a random route capability bound to companion identity, publication, rendition, asset, allowed methods, expiry, and maximum concurrent streams. The stream route redeems that capability and delegates byte acquisition to Plan 03's verified playback service.

**Tech Stack:** Companion HTTP server, capability URL patterns, existing blob playback service, Node/Bare streams, Brittle, Go HTTP client tests.

## Global Constraints

- Depends on Plan 09 selection/open flow.
- Control credentials never appear in route URLs.
- A route capability cannot open a different publication/rendition/asset or invoke control/job APIs.
- Implement RFC 7233 single-range GET/HEAD behavior; reject multi-range requests explicitly.
- Never buffer a full media file in the HTTP server.
- Client disconnect cancels backend acquisition immediately.

---

### Task 1: Mint and validate route-scoped capabilities

**Files:**
- Create: `packages/cli/src/companion/stream-capabilities.js`
- Modify: `packages/cli/src/companion/routes.js`
- Modify: `packages/cli/src/companion/server.js`
- Test: `packages/cli/test/companion-stream-capability.test.mjs`

**Interfaces:**
- Produces `openStream({ candidateRef, clientIdentity }) -> { url, expiresAt, publicationId, renditionId }`.
- Produces `consumeStreamCapability({ token, method, publicationId, renditionId, clientIdentity })`.

- [ ] **Step 1: Write failing scope and expiry tests**

```js
const opened = await api.openStream({ candidateRef, clientIdentity: 'client-a' })
t.ok(opened.url.includes('/api/v2/stream/pub-1/rend-1?cap='))
t.ok(capabilities.consume(parseCap(opened.url), exactRequest))
t.exception(() => capabilities.consume(parseCap(opened.url), wrongRenditionRequest))
t.exception(() => capabilities.consume(parseCap(opened.url), requestAfterExpiry))
```

- [ ] **Step 2: Implement capability lifecycle**

Use 256-bit random tokens stored only as hashes, bind immutable scope fields, cap lifetime and concurrent uses, permit repeated range requests within the active playback lease, and delete entries on expiry, explicit close, or server shutdown.

- [ ] **Step 3: Run capability tests**

Run: `cd packages/cli && npx brittle test/companion-stream-capability.test.mjs test/companion-v2-contract.test.mjs`

Expected: exact-scope requests pass; forged, expired, cross-client, wrong-method, and over-concurrency requests fail.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/companion/stream-capabilities.js packages/cli/src/companion/routes.js packages/cli/src/companion/server.js packages/cli/test/companion-stream-capability.test.mjs
git commit -m "feat(companion): bind stream route capabilities"
```

### Task 2: Stream verified ranges with correct HTTP semantics

**Files:**
- Create: `packages/cli/src/companion/stream-route.js`
- Modify: `packages/cli/src/companion/routes.js`
- Modify: `packages/backend/src/blob-playback-service.js`
- Modify: `/Users/jd/projects/client-backend/backend/services/peartube/client.go`
- Test: `packages/cli/test/companion-stream-range.test.mjs`
- Test: `packages/backend/test/playback-api.test.mjs`
- Test: `/Users/jd/projects/client-backend/backend/services/peartube/peartube_test.go`

**Interfaces:**
- Consumes: verified candidate lease and `requestRange()` from Plan 03.
- Produces GET/HEAD response with `Accept-Ranges`, `Content-Length`, `Content-Range`, immutable `ETag`, and media `Content-Type`.

- [ ] **Step 1: Write failing GET/HEAD/range tests**

```js
const head = await request(opened.url, { method: 'HEAD' })
t.is(head.statusCode, 200)
t.is(head.headers['content-length'], String(assetLength))
const part = await request(opened.url, { headers: { range: 'bytes=100-199' } })
t.is(part.statusCode, 206)
t.is(part.headers['content-range'], `bytes 100-199/${assetLength}`)
t.is(part.body.byteLength, 100)
```

Cover suffix range, open-ended range, unsatisfiable `416`, `If-Range`, multi-range rejection, and disconnect cancellation.

- [ ] **Step 2: Implement streaming response behavior**

Parse one range, call the backend only for requested bytes, write headers before streaming verified chunks, honor backpressure, avoid chunked transfer when exact length is known, and map verified-source exhaustion to a bounded pre-header error or connection termination after headers.

- [ ] **Step 3: Update client application ownership validation**

Replace origin-only `OwnsURL()` with exact companion route/capability validation. Reject redirects and any returned URL outside the authenticated companion base/UDS proxy.

- [ ] **Step 4: Run cross-repository stream checks**

Run: `cd packages/cli && npx brittle test/companion-stream-capability.test.mjs test/companion-stream-range.test.mjs`

Run: `cd packages/backend && npx brittle test/playback-api.test.mjs test/multi-peer-playback.test.mjs`

Run: `cd /Users/jd/projects/client-backend/backend && go test ./services/peartube ./services/playback`

Expected: correct range headers/bytes, no full-file buffering, and cancellation reaches the peer scheduler.

- [ ] **Step 5: Commit in each repository**

```bash
cd /Users/jd/projects/client-backend && git add backend/services/peartube/client.go backend/services/peartube/peartube_test.go && git commit -m "fix(peartube): restrict companion stream capabilities"
cd /Users/jd/projects/peartube && git add packages/cli/src/companion packages/cli/test packages/backend/src/blob-playback-service.js packages/backend/test/playback-api.test.mjs && git commit -m "feat(companion): stream verified bytes with scoped capabilities"
```