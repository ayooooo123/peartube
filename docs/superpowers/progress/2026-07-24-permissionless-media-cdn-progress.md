# Permissionless Media CDN Progress — 2026-07-24

Branch: `feat/permissionless-media-cdn`

Plan: `docs/superpowers/plans/2026-07-23-permissionless-media-cdn.md`

Latest pushed implementation commit at the time of this note:

- `644394ef feat(protocol): remove legacy global feed data plane`

## Completed since `11d6ed7e`

- `9cba6316 feat(app): expose local network and moderation policy`
  - Added local app controls for network policy, retention policy, followed publisher/index feeds, moderation feeds, and AI analysis mode.
  - Kept retention/moderation copy local-only: archive pledges are evidence only, and moderation controls do not affect other libraries.

- `d89639f0 feat(live): scope events by epoch and seal recordings`
  - Added signed live event descriptors, epoch descriptors, epoch chain verification, and live network session metadata.
  - Bound live topics to scoped `live` topics with event/epoch/protocol-major inputs.

- `f38c6ad2 test(p2p): add adversarial multi-peer network coverage`
  - Added deterministic adversarial P2P harness and tests for protocol skew, moderation-before-work, archive/offload integration, and entity graph/index/moderation integration.
  - Added backend script `test:adversarial`.

- `644394ef feat(protocol): remove legacy global feed data plane`
  - Added `packages/backend/src/migrations/publication-v1.js` and migration coverage.
  - Added `packages/backend/test/legacy-global-feed-absence.test.mjs` to keep production source clear of legacy global-feed identifiers and unrestricted data-plane callsites.
  - Removed legacy `public-feed`, `canonical-feed`, blind relay, relay-links, and app/backend compatibility surfaces.
  - Removed app discovery/profile callsites for deleted `getPublicFeed`, `getCanonicalFeed`, and relay-link RPCs.
  - Regenerated schema and mobile backend bundle.

## Verification already run for the latest pushed state

These passed before `644394ef` was pushed:

```bash
npm exec --prefix packages/backend -- brittle test/publication-v1-migration.test.mjs test/legacy-global-feed-absence.test.mjs test/holepunch-major-migration.test.mjs
npm test --prefix packages/spec
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs packages/app/tests/desktop-preview-regression.test.mjs
npm test --prefix packages/backend
npm run typecheck
npm run bundle:backend --prefix packages/app
git diff --check
```

Earlier slices in the same branch also passed their focused suites, including:

```bash
node --test packages/app/tests/network-policy-controls-regression.test.mjs
npm exec --prefix packages/backend -- brittle test/live-descriptor.test.mjs test/live-network-session.test.mjs test/live-stream.test.mjs
npm exec --prefix packages/backend -- brittle test/adversarial-network.test.mjs test/entity-graph-integration.test.mjs test/archive-integration.test.mjs test/protocol-version-skew.test.mjs
npm run test:adversarial --prefix packages/backend
```

## Important caveats

- The implementation plan checklist has not been edited in place for Tasks 19–22. Treat this progress note plus commit history as the current handoff until the plan checklist is deliberately reconciled.
- Task 22 Step 6 still requires product smoke checks on desktop and one physical mobile platform. The code/test cutover is pushed, but the plan's end-to-end product smoke gate is not yet complete.
- The full monorepo root `npm test` was not rerun after the final Task 22 cutover. Targeted backend/spec/app checks and typecheck passed.

## Remaining work before claiming the whole plan complete

1. Reconcile the authored plan checklist for completed Tasks 19–22.
2. Run the Task 22 product smoke checklist on desktop and one physical mobile platform:
   - create/import and unlock shell-custodied publisher identity;
   - publish standalone video;
   - publish partial season and album;
   - discover through explicit publisher/index feeds;
   - resolve duplicate media and creator contributions from another publisher;
   - stream with two peers, then from complete local cache with no peers;
   - observe structured unavailability for a missing range with no peer;
   - archive and answer a possession challenge;
   - reject stale/unconfirmed source offload, then complete one fresh confirmed action;
   - apply local moderation and confirm blocked media is neither downloaded nor served;
   - restart and verify graph, archive, policy, subscription, and migration state;
   - reopen the same storage path without lock recovery.
3. Run final broad validation:

```bash
npm run schema:full
npm test --prefix packages/backend
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
npm run typecheck
npm run test:adversarial --prefix packages/backend
node --test packages/app/tests/native-backend-startup-regression.test.mjs packages/app/tests/vertical-discovery-regression.test.mjs packages/app/tests/desktop-preview-regression.test.mjs
git diff --check
git status --short
```

4. Inspect the plan's Completion Criteria one by one before making any final completion claim.
