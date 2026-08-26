### Task 1: Define signed service announcements and index-purpose handshake

**Files:**
- Create: `packages/backend/src/indexer/service-announcement.js`
- Create: `packages/backend/src/indexer/protocol.js`
- Modify: `packages/backend/src/network/scoped-runtime.js`
- Modify: `packages/backend/src/network/topics.js`
- Test: `packages/backend/test/index-service-announcement.test.mjs`
- Test: `packages/backend/test/index-service-protocol.test.mjs`

**Interfaces:**
- Produces `IndexServiceAnnouncementV1` encode/decode/sign/verify helpers.
- Adds scoped purpose `index` and capability `index-query:v1`.
- Produces `attachIndexServiceProtocol({ connection, announcement, indexStore, limits })`.

- [ ] **Step 1: Write failing announcement and handshake tests**

```js
const signed = await createIndexServiceAnnouncement({
  indexerId, transportPublicKey, dimensions: ['external-ref'],
  shardRanges: [{ dimension: 'external-ref', start: null, end: null }],
  queryCapabilities: ['exact-external-ref'], policyDigest, issuedAt, expiresAt
}, signer)
t.ok(await verifyIndexServiceAnnouncement(signed, { now: issuedAt + 1 }))
t.not(await verifyIndexServiceAnnouncement(signed, { now: expiresAt + 1 }))
```

Reject a handshake whose transport key differs from the signed announcement.

- [ ] **Step 2: Implement bounded signing and connection authorization**

Bind `indexerId` to the signing key/domain, validate monotonic sequence and expiry, cap dimensions/ranges/capabilities, add `index` to `PURPOSE_CODES`, and authorize the Protomux channel only after the remote transport key matches.

- [ ] **Step 3: Run focused protocol tests**

Run: `cd packages/backend && npx brittle test/index-service-announcement.test.mjs test/index-service-protocol.test.mjs test/scoped-network-runtime.test.mjs`

Expected: PASS for valid handshake, wrong transport, expired announcement, unsupported capability, and teardown.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/indexer/service-announcement.js packages/backend/src/indexer/protocol.js packages/backend/src/network/scoped-runtime.js packages/backend/src/network/topics.js packages/backend/test/index-service-announcement.test.mjs packages/backend/test/index-service-protocol.test.mjs
git commit -m "feat(indexer): authorize direct index service channels"
```

