# Multi-Process Operational Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the complete Phase 1 path under real process boundaries, deterministic DHT conditions, churn, restart, partition, spam, disk pressure, and MediaStorm fallback.

**Architecture:** A reusable `@hyperswarm/testnet` harness launches bootstrap peers, two publishers, two indexers, seeders, a fresh watch-only companion, and optional contributor/archive companions as separate processes with independent stores. Scenario tests drive real signed discovery/query/transfer traffic and collect bounded operability/adoption metrics.

**Tech Stack:** `@hyperswarm/testnet`, child processes, existing chaos harness patterns, Brittle, Go integration tests, companion API.

## Global Constraints

- Depends on Plans 12 and 17.
- Use real process/store/network boundaries; in-memory mocks do not satisfy final proof.
- Tests must be deterministic, time-bounded, isolated, and clean all processes/stores/sockets.
- Metrics contain counts/timings/bounded error codes only; no titles, selectors, external IDs, capabilities, credentials, or source URLs.
- Watch-only upload/publication assertions are measured from network/backend events, not inferred from config.
- Run full suites only after focused scenarios pass.

---

### Task 1: Build the deterministic multi-process testnet harness

**Files:**
- Modify: `packages/backend/package.json`
- Create: `packages/backend/test/helpers/distributed-archive-harness.mjs`
- Create: `packages/backend/test/fixtures/distributed-archive-node.mjs`
- Reuse: `packages/backend/test/helpers/process-chaos-harness.mjs`
- Reuse: `packages/backend/test/fixtures/p2p-network-harness.mjs`
- Test: `packages/backend/test/distributed-archive-testnet.test.mjs`

**Interfaces:**
- Produces `createDistributedArchiveHarness({ publishers, indexers, seeders, companions, limits })`.
- Harness operations: `start`, `publish`, `register`, `search`, `openStream`, `readRange`, `partition`, `heal`, `stopNode`, `restartNode`, `snapshotMetrics`, and `close`.

- [ ] **Step 1: Add and pin the testnet dependency**

Install a version compatible with Hyperswarm 4.17.x in `packages/backend` and record it in package lock. Do not change production swarm dependencies.

- [ ] **Step 2: Write a failing process-isolation smoke test**

```js
const net = await createDistributedArchiveHarness({ publishers: 1, indexers: 2, seeders: 2, companions: 1 })
await net.start()
t.is(new Set(net.nodes().map(node => node.pid)).size, 6)
await net.close()
t.is(net.liveProcessCount(), 0)
```

- [ ] **Step 3: Implement harness control and readiness**

Use structured JSON lines over stdio, per-node temporary Corestores, deterministic testnet addresses/keys, explicit readiness events, bounded operation deadlines, process-tree cleanup, and artifact capture on failure.

- [ ] **Step 4: Run harness smoke**

Run: `cd packages/backend && npx brittle test/distributed-archive-testnet.test.mjs`

Expected: all nodes become ready, exchange one control message, and close without leaked process/socket/store handles.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/package.json packages/backend/package-lock.json packages/backend/test/helpers/distributed-archive-harness.mjs packages/backend/test/fixtures/distributed-archive-node.mjs packages/backend/test/distributed-archive-testnet.test.mjs
git commit -m "test(p2p): add deterministic archive testnet harness"
```

### Task 2: Encode the Phase 1 correctness, churn, and resource scenarios

**Files:**
- Create: `packages/backend/test/distributed-archive-e2e.test.mjs`
- Create: `packages/backend/test/distributed-archive-chaos.test.mjs`
- Create: `packages/backend/test/distributed-archive-pressure.test.mjs`
- Modify: `packages/backend/src/api/operability.js`
- Modify: `packages/cli/src/status.js`

**Interfaces:**
- Produces metrics `searchLatencyMs`, `sourceVerificationMs`, `firstByteMs`, `streamCompletionRate`, `verifiedPeerFailures`, `indexServiceFailures`, `fallbackCount`, `jobsByState`, `uploadedAssetBytes`, `retainedBytesByClass`, and bounded error counts.

- [ ] **Step 1: Write the complete vertical correctness scenario**

Publish one movie and one episode, register with two indexers, stop the publisher origin, boot a fresh watch-only companion, search by exact external refs, resolve through the MediaStorm-shaped API, read sparse ranges from two seeders, kill one seeder during a seek, and assert exact output bytes plus zero companion uploads/public records.

- [ ] **Step 2: Write partition/restart/anti-entropy scenarios**

Partition indexers/bootstrap peers, publish different valid records on each side, inject replay/equivocation/spam, heal, and assert accepted/quarantined convergence. Restart one publisher across rollover and one indexer during cursor commit; assert no duplicate projection rows and bounded checkpoint recovery.

- [ ] **Step 3: Write disk/upload-pressure scenarios**

Drive sustained untrusted publisher records and watched media into bounded nodes. Assert durable row/byte ceilings, local eviction semantics, watch-only zero uploads, contributor upload ceilings, independent archive budget, and continued query/playback responsiveness.

- [ ] **Step 4: Run the operational scenarios**

Run: `cd packages/backend && npx brittle test/distributed-archive-e2e.test.mjs test/distributed-archive-chaos.test.mjs test/distributed-archive-pressure.test.mjs`

Expected: every scenario passes within its deadline and reports no leaked process, active transfer, pending query, socket, or capability.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/test/distributed-archive-e2e.test.mjs packages/backend/test/distributed-archive-chaos.test.mjs packages/backend/test/distributed-archive-pressure.test.mjs packages/backend/src/api/operability.js packages/cli/src/status.js
git commit -m "test(p2p): cover archive churn and pressure"
```

### Task 3: Prove MediaStorm fallback and run final verification

**Files:**
- Create: `/Users/jd/projects/mediastorm-backend/backend/services/peartube/companion_e2e_test.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/services/debrid/scraper_peartube_test.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/services/playback/service_test.go`
- Create: `packages/cli/test/mediastorm-companion-e2e.test.mjs`

**Interfaces:**
- Cross-repository fixture contract is the checked-in `CompanionCandidateV2`, stream-open, job, status, and error JSON used by both Go and JS tests.

- [ ] **Step 1: Test optional-provider behavior**

Run the same MediaStorm search/resolve suite with companion absent, empty, slow, returning malformed data, and unreachable. Assert existing debrid/other candidates are returned and selected normally with no PearTube-induced delay beyond its configured independent timeout.

- [ ] **Step 2: Test contribution lifecycle**

With explicit consent off, play a non-PearTube winner past no threshold and assert no job/public state. Enable consent, cross the threshold, complete one idempotent spool/callback job, then search from a second install and resolve the newly seeded exact asset from PearTube.

- [ ] **Step 3: Run all verification commands**

```bash
npm run schema:full
npm run typecheck
npm test
npm test --prefix packages/cli
cd /Users/jd/projects/mediastorm-backend/backend && go test ./services/peartube ./services/debrid ./services/playback ./handlers ./config
```

Expected: all commands exit 0. The live scenario additionally proves origin-offline playback, multi-peer churn, restart repair, watch-only zero upload, explicit contribution, and normal fallback.

- [ ] **Step 4: Commit in each repository**

```bash
cd /Users/jd/projects/mediastorm-backend && git add backend && git commit -m "test(peartube): prove optional companion integration"
cd /Users/jd/projects/peartube && git add packages/backend packages/cli && git commit -m "test(p2p): prove distributed archive under churn"
```