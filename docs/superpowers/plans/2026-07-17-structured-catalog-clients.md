# Structured Catalog Protocol and Client Cutover Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one paginated rich channel catalog over HRPC and render the same YouTube/Netflix-style organization in the shared Expo mobile and Electrobun desktop client while preserving legacy channels.

**Architecture:** Define catalog/profile/group/item codecs in the schema source of truth, implement deterministic backend catalog grouping and opaque cursor pagination, expose it through the universal handler table and generated protocol facade, then cut all channel clients to that shared response. Legacy records map to a stable `latest` group instead of requiring migration.

**Tech Stack:** Hyperschema/HRPC codegen, Node/Bare backend, TypeScript/React Native/Expo Router, Brittle and `node:test`, browser/mobile smoke verification

**Spec:** `docs/superpowers/specs/2026-07-17-peartube-add-cli-design.md` sections “Rich Channel Model,” “Structured Catalog Protocol,” and “Schema and Compatibility”

**Depends on:** Plans 1 and 2 complete. This is implementation plan 3 of 4.

---

## Chunk 1: Schema-First Catalog Contract

### Task 1: Define rich profile, catalog, and cursor codecs

**Files:**
- Modify: `packages/spec/schema.cjs:230-310,2680-2780`
- Modify: `packages/spec/lib/app-rpc-adapter-codegen.cjs:42-75`
- Modify: `packages/host/src/contracts.js`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/host/test/mobile-entry.test.mjs`
- Modify: `packages/host/test/start-host.test.mjs`
- Modify: `packages/backend/test/swarm-status-diagnostics.test.mjs`
- Create: `packages/spec/test/channel-catalog-schema.test.mjs`
- Regenerate: `packages/spec/spec/schema/**`
- Regenerate: `packages/spec/spec/hrpc/**`

- [ ] **Step 1: Write a failing schema contract test**

Round-trip a response containing:

- `profileKind`, description, source links
- avatar/banner/poster/backdrop artwork with blob coordinates
- ordered `seasons`, `episodes`, `extras`, `movie`, `trailers`, and `latest` groups
- items with content/source/media/season/episode fields
- `nextCursor`

Assert the HRPC registry contains `get-content-catalog` and `get-content-items`, plus `APP_RPC_METHODS.channel.getContentCatalog` and `.getContentItems`.

- [ ] **Step 2: Run and verify missing contract**

Run from `packages/spec`:

```bash
npm exec -- brittle test/channel-catalog-schema.test.mjs test/app-rpc-adapter.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Register schema types**

Add explicit types rather than JSON blobs:

```js
ns.register({ name: 'content-artwork', fields: [
  { name: 'role', type: 'string', required: true },
  { name: 'blobId', type: 'string' },
  { name: 'blobsCoreKey', type: 'string' },
  { name: 'mimeType', type: 'string' },
  { name: 'remoteUrl', type: 'string' }
] })

ns.register({ name: 'channel-source', fields: [
  { name: 'provider', type: 'string', required: true },
  { name: 'identityKey', type: 'string', required: true },
  { name: 'sourceId', type: 'string' },
  { name: 'identityUrl', type: 'string' },
  { name: 'handle', type: 'string' },
  { name: 'displayName', type: 'string' }
] })
```
Define `channel-catalog-profile`, `channel-catalog-group-summary`, `channel-catalog-item`, catalog request/response, item-page request/response, and structured catalog error fields. Cursors are opaque strings. Both responses carry `{ success, errorCode, error }` so `INVALID_CURSOR` is not collapsed into a generic handler error.
The channel-source shape exactly matches Plan 1: provider + required normalized `identityKey`, optional stable `sourceId`, and optional persisted `identityUrl`. Catalog items expose `identityUrl` as provenance; they never expose `fetchUrl`, credentials, or diagnostic-only `displayUrl`.

- [ ] **Step 4: Register the two bounded universal RPC commands**

```js
rpcNs.register({
  name: 'get-content-catalog',
  request: { name: '@peartube/get-content-catalog-request', stream: false },
  response: { name: '@peartube/get-content-catalog-response', stream: false }
})
rpcNs.register({
  name: 'get-content-items',
  request: { name: '@peartube/get-content-items-request', stream: false },
  response: { name: '@peartube/get-content-items-response', stream: false }
})
```

Catalog request fields: `channelKey`, optional `publicBeeKey`; response: profile and stable ordered group summaries. Item request fields: channel identity, required `groupId`, optional `cursor`, optional `limit` (default 50, maximum 200; zero/negative/oversized rejected); response: one group page and `nextCursor`.

- [ ] **Step 5: Classify the command under `channel`**

Add both command names to `APP_RPC_NAMESPACES.channel`. Do not hand-edit generated facade files.

- [ ] **Step 6: Bump and migrate the shared protocol version once**

Update `PROTOCOL_VERSION` in `packages/host/src/contracts.js` and its literal declaration in `packages/host/src/index.d.ts`. Replace version-3 expectations in host/backend tests with the imported `PROTOCOL_VERSION` where possible; version-mismatch fixtures use a deliberately different value. Do not define a second runtime constant. Task 4 removes the platform facade's literal version types.

- [ ] **Step 7: Generate JavaScript schema and HRPC outputs atomically**

From repo root:

```bash
npm run schema:full
```

Expected: JavaScript schema, HRPC, and app-adapter outputs regenerate together. This checkout has no maintained Swift client or Swift generator; do not treat stale generated Swift artifacts as an implementation target.

- [ ] **Step 8: Run schema tests**

Run:

```bash
npm test --prefix packages/spec
npm test --prefix packages/host
```

Expected: PASS, including generated app-facade classification.

- [ ] **Step 9: Commit the contract atomically**

```bash
git add packages/spec packages/host packages/backend/test/swarm-status-diagnostics.test.mjs
git commit -m "feat(protocol): add structured channel catalog contract"
```

### Task 2: Implement deterministic catalog grouping and cursor pagination

**Files:**
- Create: `packages/backend/src/catalog/channel-catalog.js`
- Create: `packages/backend/test/channel-catalog.test.mjs`
- Modify: `packages/backend/src/index.js`
- Modify: `packages/backend/package.json`

- [ ] **Step 1: Write failing pure catalog tests**

Cover each profile kind and legacy fallback:

```js
const catalog = buildChannelCatalog({
  profile: { profileKind: 'tvShow' },
  videos: [episodeS2E1, episodeS1E2, episodeS1E1, extra, legacy]
})
assert.deepEqual(catalog.groups.map((g) => g.id), ['season:1', 'season:2', 'extras', 'latest'])
```

Assert:

- creator order: `latest`, `videos`, `streams`, `extras`
- TV order: ascending seasons, `extras`, conditional `latest`
- movie order: `movie`, `trailers`, `extras`, conditional `latest`
- standard: `latest`
- episode order within season: episode number, then effective date, then ID
- other groups: effective publication time descending, then ID
- empty optional groups omitted
- legacy/no `contentKind` reaches `latest`

- [ ] **Step 2: Write cursor boundary tests**

Encode the final stable sort tuple plus channel/group identity. Verify no overlaps/gaps across pages, insertion before the cursor does not corrupt decode, cursor for another channel/group is rejected, malformed/stale-version cursor returns `INVALID_CURSOR`, omitted limit uses 50, and zero/negative/>200 limits are rejected.

- [ ] **Step 3: Run and observe missing implementation**

Run: `npm exec -- brittle test/channel-catalog.test.mjs` from `packages/backend`

Expected: FAIL.

- [ ] **Step 4: Implement pure profile/group normalization**

Export `normalizeCatalogProfile`, `buildGroupSummaries`, `classifyCatalogItem`, and `compareCatalogItems`. Do not infer season/episode from filenames or titles.

- [ ] **Step 5: Implement validated opaque cursors**

Use a versioned base64url payload containing the channel key, group ID, stable final sort tuple, and version. Decode must enforce exact keys/types/length limits, match the requested channel and group, and reject malformed or unknown-version payloads. The cursor is a pagination position, not an authorization token, so do not invent or derive a signing secret.

- [ ] **Step 6: Implement catalog builder/page query**

Return summary counts for every group and items for one requested group. Default requested group is the first stable summary, or `latest` for an empty legacy channel. Avoid materializing/copying media buffers; operate on metadata records only.

- [ ] **Step 7: Run catalog tests**

Expected: PASS.

- [ ] **Step 8: Commit catalog logic**

```bash
git add packages/backend/src/catalog/channel-catalog.js packages/backend/src/index.js packages/backend/package.json packages/backend/test/channel-catalog.test.mjs
git commit -m "feat(backend): build deterministic channel catalogs"
```

## Chunk 2: Universal Backend and Protocol Exposure

### Task 3: Add backend catalog API and universal handler

**Files:**
- Modify: `packages/backend/src/api.js`
- Modify: `packages/backend/src/mobile-handlers.js`
- Modify: `packages/backend/src/hrpc-handlers.js`
- Modify: `packages/backend/test/mobile-handlers.test.mjs`
- Create: `packages/backend/test/channel-catalog-api.test.mjs`

- [ ] **Step 1: Write failing API tests**

Use a local owner channel and remote/public channel fixture. Assert `getContentCatalog` and `getContentItems`:

- accept `channelKey` or `publicBeeKey`
- share one channel-resolution helper and update the correct channel
- return rich public profile/group summaries, then one requested item page
- return `{ success: false, errorCode: 'INVALID_CURSOR' }` for a bad item cursor
- preserve empty/legacy channel behavior
- never expose `replicationPending` records or public rows marked `canonicalVisibility: 'suppressed'`
- [ ] **Step 2: Write failing shared handler registration tests**

Call `attachMobileHandlers(B, deps)` on an empty backend object and assert `B.getContentCatalog` and `B.getContentItems` exist and delegate to the API without platform-specific logic. Also assert `SHARED_HANDLER_NAMES` contains both `GetContentCatalog` and `GetContentItems`, so `attachBackendHrpcHandlers` registers the generated HRPC commands for Node and Bare hosts.

- [ ] **Step 3: Run focused tests**

```bash
npm exec -- brittle test/channel-catalog-api.test.mjs
node --test test/mobile-handlers.test.mjs
```

Expected: FAIL.

- [ ] **Step 4: Add backend API method**

Implement `async getContentCatalog(req = {})` and `async getContentItems(req = {})` beside `getChannel`/`listVideos`. Validate request bounds, share existing channel-loader resolution, read profile/source/artwork/video metadata, and call the pure catalog/group/page functions.

- [ ] **Step 5: Register through the actual shared handler surfaces**

Add `B.getContentCatalog` and `B.getContentItems` inside `attachMobileHandlers(B, deps)`, and add `GetContentCatalog` plus `GetContentItems` to `SHARED_HANDLER_NAMES` in `hrpc-handlers.js`. The same table serves Node and Bare universal hosts; do not invent `createMobileHandlers`, add desktop-only behavior, or hand-maintain a second RPC map.

- [ ] **Step 6: Run tests**

Expected: PASS.

- [ ] **Step 7: Commit backend exposure**

```bash
git add packages/backend/src/api.js packages/backend/src/mobile-handlers.js packages/backend/src/hrpc-handlers.js packages/backend/test/channel-catalog-api.test.mjs packages/backend/test/mobile-handlers.test.mjs
git commit -m "feat(backend): expose paginated channel catalogs"
```

### Task 4: Expose catalog through the host client and both platform facades

**Files:**
- Modify: `packages/host/src/create-client.js`
- Modify: `packages/host/test/create-client.test.mjs`
- Modify: `packages/platform/package.json`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/platform/src/rpc.native.ts:1-100`
- Modify: `packages/platform/src/rpc.web.ts:1-100`
- Create: `packages/platform/test/rpc.shared.test.mjs`

- [ ] **Step 1: Write failing facade tests**

Assert:

```js
await client.channel.getContentCatalog({ channelKey: 'abc' })
await client.channel.getContentItems({ channelKey: 'abc', groupId: 'latest', limit: 24 })
await platformRpc.getContentCatalog({ channelKey: 'abc' })
await platformRpc.getContentItems({ channelKey: 'abc', groupId: 'latest', limit: 24 })
```

All calls wait for readiness. `INVALID_CURSOR` from the item page remains structured.

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test --prefix packages/host
npm test --prefix packages/platform
```

Expected: FAIL on the missing platform method/type; generated protocol namespace should already expose the method after Task 1.

- [ ] **Step 3: Reuse generated protocol namespaces**

Do not add a hand-maintained method map to `create-client.js`; verify `APP_RPC_METHODS.channel` creates both generated methods. Add only test coverage/error normalization if needed.

- [ ] **Step 4: Add two platform bridge methods and typed request/responses**

Define shared catalog and item-page types in `rpc.shared.ts` and implement native/web forwarding consistently. Avoid duplicating grouping logic in platform files.

Add `type HostProtocolVersion = typeof import('@peartube/host').PROTOCOL_VERSION` and replace the three `protocolVersion: 3` literals in `rpc.shared.ts` with `protocolVersion: HostProtocolVersion`; runtime mismatch enforcement remains in `@peartube/host`, not the platform facade.

Add a focused `"test": "node --test test/*.test.mjs"` package script so the documented platform command is executable.

- [ ] **Step 5: Run host/platform tests and typecheck**

```bash
npm test --prefix packages/host
npm test --prefix packages/platform
npm run typecheck --prefix packages/platform
```

Expected: PASS.

- [ ] **Step 6: Commit facades**

```bash
git add packages/host packages/platform
git commit -m "feat(platform): expose structured channel catalog"
```

## Chunk 3: Expo Mobile and Electrobun Client Cutover

### Task 5: Build a shared catalog presentation mapper

**Files:**
- Create: `packages/app/lib/content-catalog.js`
- Create: `packages/app/tests/content-catalog.test.mjs`

- [ ] **Step 1: Write failing presentation tests**

Given protocol responses, assert the mapper produces stable tabs/sections, user-facing labels (`Season 1`, `Episodes`, `Trailers`, `Latest`), badges (`TV`, `Movie`, `Creator`), artwork fallback order, and legacy `Latest` behavior. This mapper must not parse titles.

- [ ] **Step 2: Run and observe missing module**

Run from `packages/app`:

```bash
node --test tests/content-catalog.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Implement the pure mapper**

Export only data transformation helpers. Preserve backend ordering exactly. Convert missing optional arrays to `[]`; never synthesize empty tabs.

- [ ] **Step 4: Run tests**

Expected: PASS.

- [ ] **Step 5: Commit mapper**

```bash
git add packages/app/lib/content-catalog.js packages/app/tests/content-catalog.test.mjs
git commit -m "feat(app): map structured channel catalogs"
```

### Task 6: Cut Expo channel pages to structured catalogs

**Files:**
- Modify: `packages/app/app/channel/[key].tsx`
- Modify: `packages/app/app/channel/[key].web.tsx`
- Modify: `packages/app/tests/channel-page-hydration-timeout-regression.test.mjs`
- Modify: `packages/app/tests/channel-view-playback-regression.test.mjs`

- [ ] **Step 1: Add behavioral regression coverage**

Update focused tests/fixtures to require `rpc.getContentCatalog` and `rpc.getContentItems`, retain thumbnail URL resolution/playback navigation, prohibit client-side season/title parsing, and assert creator group order is `Latest`, `Videos`, `Streams`, `Extras`. Do not assert source-text formatting.

- [ ] **Step 2: Run tests before implementation**

Run from `packages/app`:

```bash
node --test tests/content-catalog.test.mjs tests/channel-page-hydration-timeout-regression.test.mjs tests/channel-view-playback-regression.test.mjs
```

Expected: FAIL on old `getChannelMeta` + `listVideos` channel loading.

- [ ] **Step 3: Fetch profile/group summary and first page**

Fetch catalog profile/group summaries first, then the first item page for the selected non-empty group. Keep each item-page request and thumbnail resolution independently bounded so one failed page/thumbnail does not block the profile skeleton.

- [ ] **Step 4: Render profile-kind organization**

Use returned group summaries for tabs/sections:

- creator: Latest, Videos, Streams, Extras
- TV: Seasons, Episodes for selected season, Extras, conditional Latest
- movie: Movie, Trailers, Extras, conditional Latest
- standard: Latest

Add load-more using `nextCursor`; on `INVALID_CURSOR`, discard only that group page and refetch from the start once.

- [ ] **Step 5: Preserve owner/viewer actions and playback**

Keep subscribe/edit/publish actions, blob-backed thumbnail resolution, publicBeeKey propagation, and video navigation unchanged.

- [ ] **Step 6: Run focused tests and typecheck**

```bash
node --test tests/content-catalog.test.mjs tests/channel-page-hydration-timeout-regression.test.mjs tests/channel-view-playback-regression.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Smoke-test web and native Expo routes**

First launch the existing web/desktop dev target, navigate to one legacy channel and fixture-backed TV/movie/creator channels, switch every non-empty tab, load a second page, and open one video. Confirm pending/suppressed drafts are absent and artwork remains after remote-source unavailability.

Then launch the fixture-backed app with `npm run ios --prefix packages/app` (or the equivalent Android simulator command when iOS is unavailable). Navigate through the native `[key].tsx` route—not the `.web.tsx` route—switch a group, load the second page, and open one video into playback. Capture the simulator command and observed route/actions in the verification result; a web-only run does not satisfy this step.
- [ ] **Step 8: Commit Expo cutover**

```bash
git add packages/app/app/channel packages/app/tests
git commit -m "feat(app): render structured channel catalogs"
```

### Task 7: Verify the cross-client contract atomically

**Files:**
- Test only; no planned source changes

- [ ] **Step 1: Regenerate from a clean source schema invocation**

Run: `npm run schema:full` from repo root.

Expected: exit 0; no hand-maintained generated drift.

- [ ] **Step 2: Run focused backend/host/platform suites**

```bash
npm --prefix packages/backend exec -- brittle test/channel-catalog.test.mjs test/channel-catalog-api.test.mjs test/public-projection-state.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
```

Expected: PASS.

- [ ] **Step 3: Run Expo catalog verification**

```bash
node --test packages/app/tests/content-catalog.test.mjs packages/app/tests/channel-page-hydration-timeout-regression.test.mjs packages/app/tests/channel-view-playback-regression.test.mjs
npm run typecheck --prefix packages/app
```

Expected: PASS.


- [ ] **Step 4: Commit only generated drift or fixes**

Do not create an empty commit. Any generated output must be committed together with its schema source and shared protocol version.

## Plan 3 Completion Gate

The slice is complete when the two bounded HRPC operations drive Expo mobile and Electrobun channel views, pagination is deterministic and cursor failures are explicit/recoverable, legacy content remains reachable through `latest`, rich artwork/source fields survive generated JavaScript codecs, and browser/mobile smoke checks confirm navigation and playback.
