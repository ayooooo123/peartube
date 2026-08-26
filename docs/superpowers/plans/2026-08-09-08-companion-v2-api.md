# Authenticated Companion v2 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the universal backend to client application through a versioned authenticated local machine API with bounded request and response contracts.

**Architecture:** A dedicated companion server listens on a filesystem-protected Unix-domain socket by default. Explicit TCP/container mode requires a pre-shared constant-time MAC challenge capability or mTLS; there is no open-access toggle. Route handlers call Plan 07 search/verification and existing runtime APIs without creating a second backend.

**Tech Stack:** Node/Bare HTTP shims, Unix sockets, `sodium-universal` authenticated MACs, existing CLI relay service, Brittle.

## Global Constraints

- Depends on Plans 03 and 07.
- Control credentials never appear in stream URLs, logs, catalog records, or job records.
- Reject unknown JSON fields, oversized bodies, missing auth, nonce replay, clock skew, and wrong protocol version before backend work.
- Keep the existing archive console UI separate from `/api/v2`; do not add route branches to its already-large handler.
- TCP is disabled unless authenticated transport configuration is complete.

---

### Task 1: Add transport configuration and request authentication

**Files:**
- Create: `packages/cli/src/companion/auth.js`
- Create: `packages/cli/src/companion/config.js`
- Create: `packages/cli/src/companion/server.js`
- Modify: `packages/cli/src/config.js`
- Modify: `packages/cli/src/service.js`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/package-lock.json`
- Test: `packages/cli/test/companion-auth.test.mjs`
- Test: `packages/cli/test/companion-server.test.mjs`

**Interfaces:**
- Produces `createCompanionServer({ service, config, clock, nonceStore, logger })`.
- Produces canonical auth headers `X-PearTube-Client`, `X-PearTube-Timestamp`, `X-PearTube-Nonce`, and `X-PearTube-MAC`.
- Produces `verifyControlRequest({ method, path, bodyHash, headers })`.

- [ ] **Step 1: Write failing authentication tests**

```js
const response = await request(server, signedRequest({ method: 'GET', path: '/api/v2/status' }))
t.is(response.statusCode, 200)
t.is((await request(server, unsignedRequest('/api/v2/status'))).statusCode, 401)
t.is((await request(server, replayedNonceRequest)).statusCode, 409)
```

Assert TCP startup fails when no mutual auth mode is configured and UDS mode creates a socket with owner-only permissions.

- [ ] **Step 2: Implement canonical MAC verification**

```js
const canonical = b4a.from([
  request.method.toUpperCase(),
  canonicalizePathAndQuery(request.url),
  String(timestamp),
  nonce,
  bodyHash
].join('\n'))
if (Math.abs(clock() - timestamp) > MAX_CONTROL_CLOCK_SKEW_MS) throw authError('STALE_REQUEST')
if (nonceStore.has(client.id, nonce)) throw authError('NONCE_REPLAY')
const mac = b4a.from(headers['x-peartube-mac'], 'hex')
if (!sodium.crypto_auth_verify(mac, canonical, client.key)) throw authError('INVALID_MAC')
nonceStore.add(client.id, nonce, timestamp)
```

Use constant-time comparison, a bounded replay window/store, canonical path/query ordering, streaming body hashing, and redacted errors. Do not accept `apiOpen` or network location as authentication.

- [ ] **Step 3: Implement server lifecycle**

Create/clean the UDS path safely, set filesystem permissions, refuse symlink/socket ownership mismatches, close in-flight requests during service shutdown, and integrate lifecycle with `createRelayService()`.

- [ ] **Step 4: Run focused transport tests**

Run: `cd packages/cli && npx brittle test/companion-auth.test.mjs test/companion-server.test.mjs test/service-universal.test.mjs`

Expected: valid UDS/MAC calls pass; unauthenticated, replayed, stale, oversized, and misconfigured TCP calls fail before route dispatch.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/companion/auth.js packages/cli/src/companion/config.js packages/cli/src/companion/server.js packages/cli/src/config.js packages/cli/src/service.js packages/cli/package.json packages/cli/package-lock.json packages/cli/test/companion-auth.test.mjs packages/cli/test/companion-server.test.mjs
git commit -m "feat(cli): authenticate companion transport"
```

### Task 2: Implement bounded v2 search, open, status, and job routing shells

**Files:**
- Create: `packages/cli/src/companion/routes.js`
- Create: `packages/cli/src/companion/contracts.js`
- Modify: `packages/cli/src/companion/server.js`
- Modify: `packages/cli/src/index.js`
- Test: `packages/cli/test/companion-v2-contract.test.mjs`

**Interfaces:**
- Routes: `GET /api/v2/search`, `GET /api/v2/publications/{publicationId}`, `POST /api/v2/streams/open`, `GET|HEAD /api/v2/stream/{publicationId}/{renditionId}`, `POST /api/v2/ingest/jobs`, `GET|DELETE /api/v2/ingest/jobs/{jobId}`, and `GET /api/v2/status`.
- Produces structured errors `{ error: { code, message, field } }` with bounded codes.

- [ ] **Step 1: Write shared contract fixtures before handlers**

```js
const query = decodeSearchQuery(new URLSearchParams('namespace=tmdb&identifier=348&kind=movie&limit=64'))
t.alike(query, { selector: { namespace: 'tmdb', identifier: '348', kind: 'movie' }, limit: 64, cursor: null })
t.exception(() => decodeSearchQuery(new URLSearchParams('season=1&kind=episode')))
```

Cover exact movie, exact episode, bounded fallback title/year, positive season/episode numbers, pagination, and unknown fields.

- [ ] **Step 2: Implement routing and backend delegation**

Search calls `runtime.searchIndexCandidates()`. Stream-open verifies the selected candidate, issues a concrete 256-bit random token stored only by hash in a bounded lease map, binds it to the authenticated client plus publication/rendition/asset and `GET|HEAD`, and returns `{ url, expiresAt, publicationId, renditionId }`; the stream route rejects any scope mismatch before backend delegation. Plan 10 extracts this lifecycle into its dedicated capability module and adds complete RFC 7233, cancellation, and concurrency behavior. Job routes delegate to the durable store completed by Plan 11. Status reports effective transport/auth mode and runtime diagnostics without secrets.

- [ ] **Step 3: Run contract and lifecycle tests**

Run: `cd packages/cli && npx brittle test/companion-v2-contract.test.mjs test/companion-auth.test.mjs test/companion-server.test.mjs`

Expected: all documented routes reject malformed input consistently and never expose a playback URL during search.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/companion packages/cli/src/config.js packages/cli/src/service.js packages/cli/src/index.js packages/cli/package.json packages/cli/package-lock.json packages/cli/test/companion-auth.test.mjs packages/cli/test/companion-server.test.mjs packages/cli/test/companion-v2-contract.test.mjs
git commit -m "feat(cli): add authenticated companion v2 API"
```