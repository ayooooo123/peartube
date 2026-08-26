## Task 2 implementation report — 2026-08-11

### Commits

- client application: `a389a1a638b06f5201361c31d31629332041f735` — `fix(peartube): require explicit contribution consent`
- PearTube: `5c8c356f4778f095f3e8e7671699efc58a0f3a04` — `feat(policy): enforce watch-only and separate retention budgets`

Both are append-only commits in the specified isolated worktrees. No amend, rebase, squash, or earlier-history modification was performed.

### Files committed

client application:

- `backend/handlers/peartube.go`
- `backend/handlers/autoseed_test.go`
- `backend/handlers/playback_observer_test.go`
- `backend/services/peartube/autoseed.go`
- `backend/services/peartube/autoseed_test.go`
- `backend/services/peartube/client.go`
- `backend/services/peartube/source_callback.go`

PearTube:

- `packages/backend/src/api/policy.js`
- `packages/backend/src/playback/resource-policy.js`
- `packages/backend/src/seeding.js`
- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/src/orchestrator.js`
- `packages/backend/test/playback-resource-policy.test.mjs`
- `packages/backend/test/network-policy-runtime.test.mjs`
- `packages/backend/test/scoped-network-runtime.test.mjs`
- `packages/backend/test/seeding-storage-accounting.test.mjs`
- `packages/cli/src/archive-manager.js`
- `packages/cli/src/local-drive-mirror.js`
- `packages/cli/src/companion/ingest-manager.js`
- `packages/cli/src/companion/ingest-job-store.js`
- `packages/cli/src/service.js`
- `packages/cli/src/runtime.js`
- `packages/cli/src/status.js`
- `packages/cli/test/companion-ingest-jobs.test.mjs`
- `packages/cli/test/companion-source-capability.test.mjs`
- `packages/cli/test/status.test.mjs`

### Decisions

- Meaningful-watch qualification is a bounded, expiring client application state machine keyed by stable playback and hashed source identity. It accumulates only bounded monotonic foreground evidence, ignores duplicate/out-of-order/seek/background noise, emits one qualified transition per source, and treats explicit stop/abandon as cancellation rather than qualification.
- Qualification schedules the existing authenticated Plan 11 local-source ingest flow outside the playback path. Automatic contribution does not hand remote/debrid URLs to the relay. Playback never waits on observation, submission, cancellation, status, or relay outcomes.
- Consent withdrawal synchronously revokes live source grants, then cancels active contribution jobs out of band. Submission and cancellation bookkeeping is bounded and status exposes only state counts and bounded error codes.
- Persisted PearTube network policy is schema version 2. Missing, legacy, unsupported, or migration-required policy evaluates watch-only. Contribution and archive permissions are explicit independent booleans; nonzero budgets do not grant either permission.
- Contribution-cache and archive-pin retain independent configured/used byte accounting. Seeding admission rechecks effective permission and the matching budget; contribution eviction cannot evict protected archive pins.
- Scoped network policy controls serving, publisher/catalog publication, rendition retention, archive envelopes/pledges, and discovery join roles at the source. A downgrade closes public sessions, rejects new mutation/serving, revokes public discovery, and rejoins only private client discovery used by watch-only playback.
- Companion ingest rejects before durable job creation when the requested retention class lacks current explicit permission/budget, and rechecks during acquisition, verification, and publication. Publication carries the retention class through publisher/catalog/asset calls.
- CLI runtime/status reports the effective policy version, migration state, consent version, role, independent configured/used budgets, active public sessions/uploads, bounded jobs by state, selected indexers, and bounded error codes. It does not include callback origins, capabilities, keys, source URLs, or paths.

### Validation

**NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status validation were run. Only narrow source reads and structural parser summaries were used while editing; those are not declared as validation.

### Exact concerns for controller validation

- Run Go compile/focused tests to confirm the new playback lifecycle and cancellation interfaces match every producer and that settings-test cleanup never exercises a handler without a source-grant registry.
- Run the focused Brittle files to catch any remaining JavaScript module/syntax or fixture assumptions after the clean policy-v2 cutover.
- Exercise a real policy downgrade during an active upload and companion acquisition to confirm source-grant revocation, session closure, cancellation, and client-only discovery rejoin ordering under the actual swarm implementation.
- Exercise restart with real persisted policy and seeding metadata to confirm legacy records remain watch-only and contribution/archive usage is reconstructed into separate quotas.
- Confirm the trusted Plan 12 Task 1 configuration source supplies the expected policy/consent version and byte-budget values in the deployed integration; no permissive compatibility path was added.


### Controller-validation fix round — 2026-08-11

New append-only commits:

- client application: `a177015c0eccda1dda5d0c08a820d6105fa7a064` — `fix(peartube): align consent-gated test fixtures`
- PearTube: `b0301e0d3a9b49d1c27bab12779935e74f75aad3` — `fix(policy): settle watch-only asset rejection safely`

client application files:

- `backend/handlers/peartube.go`
- `backend/handlers/peartube_settings_test.go`
- `backend/handlers/peartube_test.go`
- `backend/handlers/playback_observer_test.go`
- `backend/services/peartube/autoseed.go`

The production/observer files above preserve the controller's gofmt-only edits. Settings and relay-status tests now assert readiness/reachability and trusted environment attribution without expecting the relay URL or detail text in the response. Manual seed fixtures grant current explicit archive consent and a nonzero archive budget, while a dedicated watch-only regression proves refusal occurs before any relay request.

PearTube files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`
- `packages/cli/src/companion/ingest-manager.js`
- `packages/cli/test/companion-ingest-jobs.test.mjs`
- `packages/cli/test/archive-grouping.test.mjs`
- `packages/cli/test/archive-media-coordinates.test.mjs`
- `packages/cli/test/archive-upload.test.mjs`
- `packages/cli/test/archive-ui.test.mjs`

Focused fixtures now explicitly grant the role they exercise instead of weakening fail-closed production defaults. Contributor fixtures cover local publisher and asset serving; archive fixtures cover pledges, discovery, deterministic channels, and publisher imports. A watch-only peer regression attaches rejection immediately, expects bounded `UNAVAILABLE` through the returned request promise, and asserts both runtimes remain active. The runtime marks its internally owned promise handled immediately because an in-memory Protomux peer can answer synchronously before the async API returns it; callers still receive the original rejection. Companion publication now invokes protected `retainAssets` only for `archive-pin`; `contribution-cache` remains evictable. The disk-admission fixture permits initial policy admission, then deterministically denies the acquisition-stage storage recheck.

Fix-round validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after these commits. Narrow structural source reads are not validation.

Remaining controller concerns:

- Re-run the focused Go tests to confirm the preserved gofmt changes plus revised secret-free/manual-consent fixtures.
- Re-run scoped-runtime tests to confirm two watch-only client scopes establish the expected in-memory session and deliver a peer-attributed bounded error without process-level rejection.
- Re-run companion and archive publisher tests to confirm contribution-cache never takes protected retention while archive-pin still does exactly once.
- Keep the existing real downgrade/restart checks from the first report; this round did not exercise a live swarm or persisted store.

### Controller-validation fix round 2 — 2026-08-11

PearTube append-only commit:

- `806525dcd90e513929840eedbc6244f1c282febe` — `fix(policy): correct consent-gated focused fixtures`

Files:

- `packages/backend/test/scoped-network-runtime.test.mjs`
- `packages/cli/test/companion-ingest-jobs.test.mjs`

The scoped asset refusal regression now models the real role topology rather than two non-serving peers: the source has explicit current contribution permission and joins the asset scope as a server; the requester remains default watch-only and joins only as a client. Both establish the scoped asset session. The empty contributor answers the client's block request with bounded protocol `UNAVAILABLE`; the assertion keeps peer attribution and verifies both runtimes remain active.

Every direct ingest-manager construction after the focused companion test's persistence boundary now supplies an explicit admission callback matching the invariant under test. Persistence failure, abort, close/restart, and multipart tests explicitly admit their contribution-cache requests. The dedicated default-deny watch-only test is unchanged and still constructs a manager whose admission callback returns false. No production role gate or permissive default was added.

Fix-round-2 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this commit. Narrow structural source reads are not validation.

Remaining controller concerns:

- Re-run the corrected scoped-runtime refusal followed by the three-real-runtime test to confirm no pending request or peer-session state cascades into the next fixture.
- Continue the focused companion test beyond the prior persistence-failure boundary to confirm all direct fixtures now reach their intended invariant while the dedicated watch-only default denial remains fail-closed.

### Controller-validation fix round 3 — 2026-08-11

PearTube append-only commit:

- `39cbc6882a9df5748a757ca3b8f98e3958e6296a` — `fix(policy): model unavailable scoped asset correctly`

File:

- `packages/backend/test/scoped-network-runtime.test.mjs`

The asymmetric contributor/server and watch-only/client roles remain unchanged. The test store now exposes the manifest-declared core length and byte length while returning false from `has` for the requested block. This is a minimally valid unavailable source: scoped inventory and handshake can activate against the exact descriptor, but the contributor has no block to serve and therefore returns protocol `UNAVAILABLE`. The peer-attribution, bounded-error, active-session, and active-runtime assertions are preserved.

Fix-round-3 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this commit. Controller validation before this fix found the invalid zero-length fixture; controller also reported the CLI focused suite passing 46/46 tests and 285/285 assertions.

Remaining controller concern:

- Re-run the corrected scoped refusal and immediately following three-real-runtime fixture to confirm the valid core state activates both sessions, attributes the unavailable responder, and leaves no cascading pending request.

### Controller-validation fix round 4 — 2026-08-11

PearTube append-only commit:

- `1ec3b57533978bf582893591635fd55eb200bc61` — `fix(policy): serialize scoped asset fixture setup`

File:

- `packages/backend/test/scoped-network-runtime.test.mjs`

The controller established that the valid unavailable core was not the remaining activation failure: unlike the known-passing transfer fixture, this regression opened both scopes concurrently and raced the synchronous in-memory Protomux channel. The test now follows the proven ordering exactly: start source then requester, emit both connections, yield once for connection setup, retain the contributor scope, then retain the requester scope. The valid unavailable core, asymmetric contributor/server and watch-only/client roles, active-session assertions, peer-attributed bounded `UNAVAILABLE`, and active-runtime assertions remain unchanged.

Fix-round-4 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this commit.

Remaining controller concern:

- Re-run the corrected scoped refusal immediately before the three-real-runtime fixture to confirm the proven ordering activates both sides and eliminates the prior deadlock cascade.

### Controller-validation fix round 5 — 2026-08-11

PearTube append-only commit:

- `b257ac4d1069c6c730649d48eb92573338aa63e8` — `fix(network): bind scoped sessions to connections`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

The controller confirmed the asymmetric contributor/watch-only refusal regression passes all 10 assertions, then isolated the three-peer hang to a reconnect using the same authenticated peer key. Session lookup was keyed only by peer ID, so `attachScope` reused a session owned by a destroyed connection; after replacement, the delayed old connection close callback could close whichever newer session occupied that peer key.

Scoped sessions now have connection identity as well as the stable peer key. `attachScope` reuses only a non-closed session owned by the same still-active connection. A different connection for the same peer closes and replaces the old owned session. Protocol activation and frame callbacks use their captured owned session rather than looking up a potentially newer peer-key occupant. Protocol close deletes and cleans only its owned session. Connection close likewise acts only when the current session still belongs to that exact connection. Ownership-sensitive asynchronous archive, catalog, and inventory closure callsites pass the expected session. Replacement still fails the old pending asset request with `DISCONNECTED`; cleanup and the closed-session counter remain exactly once.

The three-real-runtime regression now reconnects the same-key replacement before destroying the old transport, waits for the replacement to become active, then delivers the delayed old close. It asserts the old reader/source sessions each close exactly once, delayed close cannot increment either counter or remove either replacement, the second verified transfer succeeds, the subsequent corrupt proof remains peer-attributed `INVALID_PROOF`, and both runtimes settle active.

Fix-round-5 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this commit.

Remaining controller concerns:

- Re-run the full scoped-runtime file to confirm same-key replacement completes the second transfer, corrupt-proof rejection, and later fixtures without deadlock.
- Exercise a real Hyperswarm reconnect with the same remote key to confirm its close/open scheduling matches the identity-safe in-memory regression.

### Controller-validation fix round 6 — 2026-08-11

PearTube append-only commit:

- `6d3921e338d10a729cb45555a53700c24aff0932` — `fix(network): settle denied asset uploads`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

The controller rerun confirmed the watch-only regression passes and the same-key replacement sessions survive delayed old close. It also clarified that the global closed-session counter correctly increases by two per runtime because replacement closes one bootstrap scope and one asset scope; the regression now asserts `+2` and names both scopes rather than weakening production accounting.

The remaining second-transfer deadlock was a production fail-closed settlement bug. After preparing a verified local block, `sendAssetBlocks` could fail upload reservation because the current policy budget was exhausted and return without a block or protocol error, leaving the accepted requester pending until timeout. A denied reservation now sends bounded `asset-block-error` `UNAVAILABLE` only if the response is still uncancelled, the scope/session remains current, and its policy epoch is unchanged. No payload or uploaded-byte accounting is committed.

The real asset transfer regression lowers the explicit contribution upload ceiling to one byte after a successful transfer, clears one requester block, and attaches rejection before issuing a peer-evidence request. It asserts bounded peer-attributed `UNAVAILABLE`, unchanged uploaded bytes, no received block, and both runtimes active. The three-peer contributor budget is raised explicitly above the deliberate interrupted plus replacement transfer volume so second transfer and later corrupt-proof rejection exercise their intended branches rather than quota exhaustion.

Fix-round-6 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this commit.

Remaining controller concerns:

- Re-run the full scoped-runtime file to confirm quota refusal settles immediately, second transfer completes, corrupt proof rejects, and all later fixtures finish.
- Exercise a real upload-budget exhaustion while a peer request is active to confirm Hyperswarm delivery of the bounded control error before teardown.

### Controller-validation fix round 7 — 2026-08-11

PearTube append-only test-only commit:

- `5a90dc036aecda1c1910b3d448af39e12aadbf69` — `test(status): assert bounded policy contract`

File:

- `packages/cli/test/status-universal.test.mjs`

Controller validation now reports client application full 72 packages passing, PearTube backend focused 38/38 tests with 278/278 assertions passing, and companion/status focused 46/46 tests with 285/285 assertions passing. The remaining exact CLI status command found only this stale universal fixture, which expected the intentionally removed legacy `status.runtime` subtree and old formatter lines.

The fixture now supplies explicit current policy v2, consent and migration metadata, independent contribution/archive permissions and configured/used budgets, active uploads/announcements/acquisitions, all bounded job states, selected indexers, retention, network, channel, creator, and client counts. It asserts the current `effectivePolicy`, `budgets`, `publicWork`, placeholder indexer list, bounded error codes, network, summary, creators, and exact formatter output. Protected sentinel publisher IDs, indexer IDs, keys/capabilities, local paths, source URLs, callback origins, and overflow indexers are recursively absent. It explicitly asserts the legacy `runtime` subtree is not restored.

Fix-round-7 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this test-only commit.

Remaining controller concern:

- Re-run the exact two CLI status files to confirm the updated universal fixture matches the current bounded contract without weakening redaction.

### Controller-validation fix round 8 — 2026-08-11

PearTube append-only source-only style commit:

- `5e0c7edc32cdac78a829759cedffc92b4dd0998a` — `style(network): document best-effort cleanup`

File:

- `packages/backend/src/network/scoped-runtime.js`

Exact Task 2 ESLint reported only 12 `no-empty` findings, all intentional best-effort cleanup catches. Each catch now contains a concise operation-specific comment covering session cleanup hooks, normal/rejected/handshake channel close, archive protection release, candidate/superseded index expiry timers, failed asset-session close, and failed archive-retention core close. No control flow, error handling, state, network behavior, or tests changed.

Fix-round-8 validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run after this source-only style commit.

Remaining controller concern:

- Re-run exact Task 2 ESLint to confirm all 12 documented best-effort catches satisfy `no-empty`.

### Final review remediation round — 2026-08-11

Append-only commits:

- client application: `2444900f6308f699ae550ab95aa079d2b74991db` — `fix(peartube): require explicit contribution consent`
- PearTube: `5b568ad0d4e0091602eca8f6d287bc8027c561b5` — `feat(policy): enforce watch-only and separate retention budgets`

client application files:

- `backend/handlers/peartube.go`
- `backend/handlers/peartube_test.go`
- `backend/handlers/playback_observer_test.go`
- `backend/services/peartube/autoseed.go`
- `backend/services/peartube/client.go`
- `backend/services/peartube/peartube_test.go`
- `backend/services/peartube/source_callback.go`
- `backend/services/peartube/source_callback_test.go`

PearTube files:

- `packages/backend/src/api/policy.js`
- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/src/playback/resource-policy.js`
- `packages/backend/src/seeding.js`
- `packages/backend/test/network-policy-runtime.test.mjs`
- `packages/backend/test/playback-resource-policy.test.mjs`
- `packages/backend/test/scoped-network-runtime.test.mjs`
- `packages/backend/test/seeding-quota-budget.test.mjs`
- `packages/cli/src/companion/contracts.js`
- `packages/cli/src/companion/ingest-manager.js`
- `packages/cli/src/companion/routes.js`
- `packages/cli/src/runtime.js`
- `packages/cli/src/service.js`
- `packages/cli/src/status.js`
- `packages/cli/test/companion-server.test.mjs`
- `packages/cli/test/companion-v2-contract.test.mjs`
- `packages/cli/test/service-universal.test.mjs`
- `packages/cli/test/status-universal.test.mjs`

Decisions and fixes:

- The authenticated companion control route now requires a complete current policy-v2 snapshot. Relay startup remains fail-closed until that exact control operation succeeds, and missing/partial direct or persisted policy cannot synthesize consent from defaults.
- client application reconciles the complete trusted policy before each Plan 11 submission. Manual and automatic local-source handoffs recheck the matching independent role at submission, and source grants carry a revocation epoch so a prepared file cannot cross a concurrent consent withdrawal.
- Source callback delivery is chunked and checks revocation between bounded reads/writes. Active acquired readers stop after at most the already in-flight chunk.
- Scoped serving separates contribution and archive upload reservations, counters, and ceilings; disabled upload permission cannot announce or serve even when a role budget is nonzero. Role or upload-policy changes close the affected asset, publisher, and archive sessions and rejoin discovery client-only.
- Local publisher publication now requires explicit contribution plus upload permission. Archive range allocation requires explicit archive permission and remaining archive budget. Watch-only following, catalog resolution, discovery, and private playback fetch remain available.
- Contribution eviction is strictly limited to `contribution-cache`; `archive-pin` records are never reclassified or released by contribution pressure. Archive policy changes are applied before seeding admission, with rollback on failure.
- Playback resource policy exposes an acquisition generation that invalidates public acquisition on consent/environment transitions while leaving local playback available.
- Runtime status now reports actual bounded public announcement/upload counts, uploaded bytes, and bounded selected-indexer status using synthetic identifiers. Recursive protected material remains absent.

Validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run for this remediation round. Narrow source reads and commit operations are not validation.

Exact remaining controller concerns:

- Run focused Go compile/tests because controller-owned gofmt was intentionally not run after the source-grant epoch and submission-race changes.
- Run the focused backend and CLI JavaScript tests to catch syntax/fixture assumptions in the stricter startup policy, downgrade session closure, active archive proof, service startup race, and selected-indexer status shapes.
- Exercise real Hyperswarm downgrade during an active asset and archive proof response to confirm immediate session teardown and client-only rejoin outside the in-memory fixtures.
- Exercise real companion policy apply concurrently with a prepared local-source handoff to confirm the stale source epoch rejects before any callback byte or public job survives.
- Archive range storage capacity remains dependent on the production archive allocator/storage accounting for exact downloaded-byte usage; the scoped range boundary rejects absent role/zero remaining archive budget and separates upload accounting, but controller should verify end-to-end disk usage reconstruction across restart.

### Source-boundary closure round — 2026-08-11

Append-only commits:

- client application: `5c4c46d7dff910aaf04e63381871a38ff5a4f223` — `fix(peartube): close consent races and preserve claims`
- PearTube: `4c3b044a6c6bc691bb80fb64a9809b75208befca` — `fix(policy): enforce role-scoped serving boundaries`

client application files:

- `backend/handlers/peartube.go`
- `backend/handlers/peartube_test.go`
- `backend/services/peartube/autoseed.go`
- `backend/services/peartube/client.go`
- `backend/services/peartube/source_callback.go`
- `backend/services/peartube/source_callback_test.go`

PearTube files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/src/seeding.js`
- `packages/backend/src/upload.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`
- `packages/backend/test/seeding-quota-budget.test.mjs`
- `packages/backend/test/upload-playback-support.test.mjs`
- `packages/cli/src/archive-manager.js`
- `packages/cli/src/service.js`
- `packages/cli/test/service-universal.test.mjs`

Decisions and fixes:

- client application serializes the short authenticated Plan 11 source handoff against live settings cutover without putting playback on that lock. The source-grant epoch still rejects prepared stale grants, and the new race fixture holds consent withdrawal until an already-started control handoff settles.
- Automatic contribution keeps its bounded claim after a non-seedable private remote source or relay refusal, preserving one qualified attempt per guard window and the recovered TMDB entity claim. Catalog unavailability still releases the claim because no submission decision was reached.
- Watch-only scoped asset sessions remain eligible as download clients; role checks now govern only announcement/upload serving. Publisher follower sessions likewise remain client-capable while local publication stays role-gated.
- Contribution and archive assets/catalogs carry an explicit retention class through archive import, immutable upload finalization, rendition retention, catalog publication, discovery, byte reservation, and live policy transitions. Archive-only nodes can publish archive-pin data without acquiring contribution permission, and zero class budget cannot announce or upload it.
- Role or class-budget changes invalidate active response epochs, close affected sessions, and rejoin scopes with current client/server eligibility. Contribution and archive uploaded-byte reservations remain separate.
- Generic seed removal cannot release an archive pin; explicit `removeArchivePin` is required. Contribution eviction remains unable to touch archive pins.
- Service startup and heartbeat logging now consume the bounded top-level `network` and `publicWork` status contract instead of the removed `runtime` subtree. Status source reads accept synchronous or asynchronous providers and fail to bounded error codes.

Validation: **NOT RUN.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status commands were run. Narrow source inspection, diff summaries, and commit operations are not validation.

Exact remaining controller concerns:

- Run controller-owned gofmt and focused client application tests, especially the source-handoff/settings race and the two automatic-claim regressions.
- Run the focused backend/CLI suites for watch-only asset download sessions, archive-only catalog/asset publication, class-budget transition quiescence, explicit archive-pin removal, and top-level startup/heartbeat status.
- Exercise a real companion source callback while policy is withdrawn and real Hyperswarm asset serving while role/budget changes, confirming no post-cutover byte or announcement survives.
- Verify archive downloaded-byte storage reconstruction across restart against the production archive allocator.

### Controller-rerun closure round — 2026-08-11

Append-only commits:

- client application: `f65c2918022c9466fee783095c2d7b10a7bb6cb1` — `fix(peartube): reject stale grants before relay mutation`
- PearTube: `c671221a7688fa3c5e3e55004c4c363113193df5` — `fix(policy): resume scoped transfers across policy changes`

Files:

- client application: `backend/handlers/peartube.go`, `backend/handlers/peartube_test.go`
- PearTube: `packages/backend/src/network/scoped-runtime.js`, `packages/backend/test/scoped-network-runtime.test.mjs`, `packages/backend/test/seeding-quota-budget.test.mjs`

Decisions and fixes:

- A prepared client application source grant now captures its policy epoch at preparation. The closure checks current relay, current explicit consent/version/migration state, and the unchanged epoch before policy reconciliation, then rechecks after reconciliation while settings cutover is excluded. A stale/withdrawn grant therefore causes zero companion control or ingest mutation. The controller's gofmt changes were preserved in the follow-up commit.
- The outward contribution publication error remains `explicit contribution upload permission is required`; retention-class separation does not churn the established API/test contract.
- Asset responses accepted before a role/upload/class-budget transition receive bounded `UNAVAILABLE` before affected teardown. Budget-only changes stop byte reservation and change announcement eligibility without converting a settled request into `DISCONNECTED`.
- Scoped sessions are reattached across every live authenticated connection direction. Restoring archive consent can therefore reopen the custody channel and resume its retained pledge even when the surviving transport was accepted rather than initiated locally.
- Quota-accounting fixtures explicitly install contributor policy before adding watched contribution-cache records; production remains fail-closed by default.

Validation: **NOT RUN after these fixes.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status commands. The fixes respond to controller-reported focused rerun failures.

Exact remaining controller concerns:

- Re-run the focused client application packages to confirm stale prepared grants produce no policy/ingest request and that controller gofmt remains clean.
- Re-run the five focused PearTube files to confirm error compatibility, bounded quota refusal, archive resume, and explicit contributor quota fixtures.
- Exercise the same settlement/resume paths against real Protomux/Hyperswarm connections and verify archive downloaded-byte reconstruction across restart.

### Archive-session resume closure — 2026-08-11

Append-only PearTube commit:

- `9012587b209e14c2f4eab0960ce22ae5d7cbf84d` — `fix(policy): reopen retained archive sessions`

File:

- `packages/backend/src/network/scoped-runtime.js`

Decision and fix:

- A remote archive channel can close after its peer withdrew consent while the receiving runtime still retains the pledge and the underlying authenticated connection. If the replacement channel arrived before the old close callback had removed its same-peer session, it was ignored as an apparent duplicate; the later close then left no registered remote endpoint. Archive close now schedules a source-level reattach after exact old-session removal whenever the runtime, scope, role, and connection are still current.
- Peer failure suppression is cleared when a fresh archive session activates. The interrupted retained block is therefore retried on the new channel instead of remaining permanently excluded by the old same-peer failure record. Withdrawal still closes the forbidden side immediately; restoration resumes the retained pledge without requiring a new transport connection.

Validation: **NOT RUN after this fix.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status commands. The fix responds to the sole controller-reported second-rerun failure (49/50 tests, 341/346 assertions before this commit).

Remaining controller concern:

- Re-run the focused archive transfer regression, then exercise consent withdrawal/restoration over a real persistent Protomux/Hyperswarm connection.

### Interrupted archive-request ownership closure — 2026-08-11

Append-only PearTube commit:

- `2ec5fcf86f512aa828542798216c47f92e3b3321` — `fix(policy): preserve interrupted archive requests`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and fix:

- The prior channel-reopen fix did not repair locally owned request state. `nextArchiveBlock` advances the retained resource's `nextIndex` and records the requested block in `archivePending`. The remote-close callback moved an interrupted `archiveRequest` into `archiveRetries`, but the shared local `closeSession` path used by policy withdrawal marked the session closed and deleted it without clearing the pending key or retaining the request. The exact block therefore remained pending forever, and later pumps started after the already-advanced index.
- `closeSession` now queues an in-flight archive request before closing the locally owned session. That single path clears its pending marker, preserves the exact request for retry, discards partial transfer state, and clears its timer. Fresh-policy session activation and restoration then clear the old peer failure marker and retry the exact block over a fresh paired session.
- The existing held-proof regression now withdraws archive consent on both provider and requester, lets both old scoped sessions settle closed, restores both policies over the same unchanged physical connection, and still requires block 2 to arrive exactly once before later quota behavior proceeds. This specifically covers the local-request close path that the former one-sided fixture missed.

Validation: **NOT RUN after this fix.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status commands. Controller evidence before this commit remained 49/50 tests with received/upload/proof assertions failing.

Remaining controller concern:

- Re-run the focused archive transfer regression and exercise the same interrupted-request preservation over a real persistent Protomux/Hyperswarm connection.

### Service fixture and exact lint closure — 2026-08-11

Append-only PearTube commit:

- `a60c13e6b47303cb62eb46afd8a4373c6865631f` — `test(policy): apply archive consent in service fixture`

Files:

- `packages/cli/test/service-universal.test.mjs`
- `packages/backend/src/upload.js`

Decisions and fixes:

- The universal service fixture's fake `setNetworkPolicy` returned an effective archive role but did not update the runtime policy source read by production `retentionPermission`. The fixture now starts from an explicit migration-required watch-only policy, persists each policy-v2 control operation behind `networkPolicyRuntime.getPolicy`, and exposes zero class usage through the production seeding budget interface. Its existing pre-consent refusal remains fail-closed; the explicit archive consent and 4096-byte archive budget then authorize the expected publish, rendition retention, and archive retention calls without bypassing the source evaluator.
- The two upload failure paths now retain the caught exception in a local `failure` binding instead of assigning to the catch parameter. Rollback replacement errors, returned commit-uncertain/rollback metadata, and logs consistently use that binding. Both staged rendition-core close catches name their best-effort cleanup operation.

Validation: **NOT RUN after this fix.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status commands. Controller evidence before this commit was 46/47 CLI test files with the archive service fixture as the sole failure, plus four exact ESLint findings in `upload.js`.

Remaining controller concern:

- Re-run the full CLI suite and exact Task 2 ESLint to confirm the policy-aware fixture and upload cleanup lint closure.

### Final Plan 12 review closure — 2026-08-11

Append-only PearTube commit:

- `af3b873ee584f352a7e5bb2698eb822090bad234` — `fix(policy): close final retention serving gaps`

Files:

- `packages/cli/src/archive-manager.js`
- `packages/cli/src/service.js`
- `packages/cli/test/archive-upload.test.mjs`
- `packages/cli/test/service-universal.test.mjs`
- `packages/backend/src/seeding.js`
- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/seeding-quota-budget.test.mjs`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Decisions and fixes:

- The early archive WebUI keeps its deferred publisher but now binds the same live `retentionPermission` callback as local mirror, companion, and direct archive jobs. Contribution-only policy remains insufficient; current explicit archive consent and archive budget authorize the already-bound publisher without a permissive default.
- Archive publisher wrappers forward their validated retention class into catalog publication and rendition retention. Completed-job reconciliation supplies literal `archive-pin` to both calls. Dual-role regressions assert archive work never falls back to contribution ownership.
- Cached-byte updates admit the replacement video byte count together with the same seed's persisted thumbnail bytes, while excluding the seed's old video bytes exactly once. Rejected updates preserve committed accounting and the exact thumbnail-inclusive boundary remains admissible.
- Public serving now requires enabled upload permission, a positive global upload ceiling, the current matching role, and a positive matching role budget. Global ceiling and class-budget transitions settle accepted asset responses with bounded `UNAVAILABLE`, close and rejoin only affected serving scopes, suppress ineligible announcements, and preserve committed upload counters plus client-only watch/follow scopes.
- Archive custody and discovery serving/attachment now use the same complete serving predicate. Network-only pause/resume suspends the existing discovery handle; resume restores `serverAnnounced` from current eligibility so bounded announcement status matches the resumed DHT role.
- Focused regressions cover zero global ceiling, in-flight global reduction, publisher/asset/archive role-budget transitions, watch/follow scope preservation, resumed announcement accounting, and thumbnail-inclusive retention admission.

Validation: **NOT RUN.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The append-only commit and post-commit report/vault updates are the only operations after implementation.

Remaining controller concerns:

- Run the focused CLI archive/service and backend seeding/scoped-runtime files, then exact Task 2 ESLint, to catch JavaScript syntax, fixture timing, or style assumptions.
- Exercise global and role-budget reductions during real Hyperswarm asset/archive work, confirming the bounded error is delivered before teardown, the resumed discovery role matches status, and committed accounting survives restart.

### Deterministic discovery transition follow-up — 2026-08-11

Append-only PearTube commit:

- `dd01395c867a7c2788310ff56349457aaa1b3e9c` — `fix(policy): distinguish rejoin from network resume`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and fix:

- Controller focused backend evidence after `af3b873ee584f352a7e5bb2698eb822090bad234` was 12/13 scoped tests and 58/61 assertions. The new transition filter correctly preserved sessions for unaffected client-only scopes, but also skipped discovery rejoin for those scopes when upload/global/role state changed. The existing persisted-policy fixture therefore kept and suspended the pre-downgrade join instead of deterministically replacing it with current client-only discovery.
- Serving-policy changes now rejoin every retained discovery handle so its DHT server/client role is current, while session closure remains limited to contribution/archive scopes affected by the matching role. A pure network-only pause still enters no serving-policy transition, suspends the same public handle, and resumes it with `serverAnnounced` restored.
- The resume regression now locates the exact publisher join from the published scope diagnostic rather than re-deriving the topic with a differently normalized publisher identifier. A guarded failure path closes the runtime instead of cascading into asynchronous `undefined` access noise.

Validation: **NOT RUN after this follow-up.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The fix responds directly to the controller-reported focused failure.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm serving-role downgrade replaces discovery, pure network pause resumes the same public publisher handle, announcement count restores, and later fixtures receive no asynchronous cascade.

### Archive ceiling-transition reopen follow-up — 2026-08-11

Append-only PearTube commit:

- `aa87674f44d6a657666ceb3df2779bba2af50607` — `fix(policy): reopen archive after ceiling transition`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root causes and fixes:

- Controller focused evidence after `dd01395c867a7c2788310ff56349457aaa1b3e9c` was 29/31 scoped tests and 263/266 assertions. The asset failure was a stale test expectation: the affected serving session correctly closed on zero contribution budget, then the retained asset rejoined client-only over the same transport. The regression now proves the old session counter closes, the replacement has no active response, no announcement or upload succeeds, the request receives bounded `UNAVAILABLE`, committed bytes stay fixed, and the watch-only asset scope remains.
- The archive failure was a real same-transport reopen race. After the low global ceiling returned unavailable for exact pending blocks, raising the ceiling closed the serving session and immediately opened a replacement while the remote still owned its old same-key session. The remote rejected that early replacement before its close frame retired the old session, so pending blocks 3 and 4 never reached a fresh activation that clears peer-failure suppression.
- Archive protocol-close replacement now waits until the next event-loop turn. This lets the remote close frame retire the exact old same-key owner before reattachment. The existing common close path still preserves the exact in-flight request in `archiveRetries`, and fresh activation still clears the matching peer failure before pumping. The same authenticated transport can therefore resume pending exact blocks after global-ceiling or role transitions without resetting accounting.

Validation: **NOT RUN after this follow-up.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The changes respond directly to the two controller-reported focused failures.

Remaining controller concern:

- Re-run the full focused scoped-runtime file to confirm client-only asset rejoin/refusal and exact archive blocks 3/4 resume after both global and role-budget transitions without asynchronous cascade.

### Ordered scoped-session replacement follow-up — 2026-08-11

Append-only PearTube commit:

- `b49d1b0bc328ff49617a4dbea12b03336d26027b` — `fix(policy): order scoped session replacement`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root causes and fixes:

- Controller instrumentation after `aa87674f44d6a657666ceb3df2779bba2af50607` found an active provider archive replacement but a permanently handshaking requester replacement after 30 settlement turns, with only block 2 received and no protocol error. Retry bookkeeping and announcements were current; replacement channels were asymmetrically paired.
- The remaining race was the transition's local `restartTransferSessions(false)`: it attached immediately after local close/rejoin while the remote close callback was still retiring its old same-key Protomux session. Delaying only remote callback reattach could not order this local replacement.
- A serving-policy transition now records whether it actually closed an affected session and, after all discovery rejoins, waits one event-loop turn before network activation/restart can attach replacements. Protomux close callbacks therefore retire the old local/remote owners before either replacement opens. The remote delayed reattach remains as the complementary one-sided-close path.
- The archive regression removes controller `ARCHIVE_DEBUG*` instrumentation and requires both provider and requester replacement sessions to be active before exact pending blocks retry. The post-budget asset request now expects bounded `DISCONNECTED`, matching the closed serving session; the already-accepted global transition remains covered by bounded `UNAVAILABLE`, and the client-only assertion still proves no announcement, response, byte commit, or loss of watch scope.

Validation: **NOT RUN after this follow-up.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The fix responds directly to controller-instrumented runtime state.

Remaining controller concern:

- Re-run the full focused scoped-runtime file to confirm ordered active/active archive replacement, exact blocks 3/4 recovery, bounded client-only asset disconnect, no debug output, and no later asynchronous cascade.

### Deterministic client-only asset fixture follow-up — 2026-08-11

Append-only PearTube test commit:

- `d96dcb2b42829680329aabc476138d2ee2cf108f` — `test(policy): await client-only asset replacement`

File:

- `packages/backend/test/scoped-network-runtime.test.mjs`

Controller result and correction:

- The ordered archive replacement now passes. The sole remaining scoped fixture failed four assertions because it treated any asset session, including a stale or handshaking one, as completion before and after the contribution-budget cutover.
- The fixture now waits for an active serving asset session before recording the closed-session baseline. After applying zero contribution budget, it waits for both the old serving-session close counter and an active client-only replacement before taking diagnostics.
- The replacement is asserted active with zero response work and no public announcement. A fresh peer-evidence request receives the observed bounded `UNAVAILABLE`; uploaded bytes remain unchanged and the watch-only asset scope remains retained. No production code changed.

Validation: **NOT RUN after this test-only follow-up.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The correction is based on the controller's focused timing evidence.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm all fixtures and assertions pass without asynchronous cascade.

### Rapid double-transition handshake follow-up — 2026-08-11

Append-only PearTube commit:

- `114dcfc2a68d1dab3809a679b70c1f6d025916bc` — `fix(policy): preserve scoped handshakes across cutover`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and fix:

- Controller captured the remaining production failure after the in-flight global-ceiling cutover settled: its first transition closed the active serving asset session and started a client-only replacement, but returned while that replacement was still handshaking. An immediate ceiling restore closed and reopened the handshaking channel, colliding reused Protomux session IDs and destroying both duplexes with `Invalid open message`.
- Serving-policy transitions now close only matching sessions whose scoped protocol reached `state === 'active'`. Those are the only sessions that can have admitted public work. A handshaking replacement is role-neutral and remains mapped across a subsequent role/budget/global change; dynamic serving authorization adopts the latest policy when it activates, and restart attachment sees the occupied peer/scope map instead of opening a duplicate.
- Active sessions and in-flight responses retain the existing bounded `UNAVAILABLE`, close, event-loop ordering, and restart behavior. The rapid double-transition regression proves both duplexes survive immediate restore, both scoped asset replacements activate, and the later zero role-budget transition closes the active serving session before client-only rejoin.
- Controller `PAIR_*`, `AFTER_*`, and `ASSET_RESTORE_DEBUG` instrumentation is removed.

Validation: **NOT RUN after this follow-up.** Per controller instruction, the worker ran no tests, builds, formatters, linters, schemas, or git-status validation. The fix responds directly to the controller-captured Protomux exception and state trace.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm rapid double transition preserves both duplexes, restores active sessions, then closes the active serving session on budget zero without invalid-open or asynchronous cascade.

### Serialized scoped-session reattach correction — 2026-08-11

Append-only PearTube commit:

- `051e6118bb4e4bedfb8a3c538cbb59822d0212dc` — `fix(policy): serialize scoped session reattach`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and correction:

- Closing only active sessions was incorrect: a later publisher downgrade could leave a stale handshaking public session. Closing every affected session is required, but reopening from the policy transition or the old archive-only timer could reuse the same Protomux peer/scope ID before the old channel lifecycle drained.
- Each scope now owns one pending reattach gate per peer and connection. Policy-driven closes capture the old channel, remove the session immediately, and register an asynchronous promise that waits for `channel.fullyClosed()` plus the next event-loop turn. Policy application never awaits that promise, so accepted in-flight work can receive bounded cancellation and release its channel handler without deadlock.
- `attachScope` and transfer restart skip the same peer/connection while its gate is pending. After confirmed closure, the gate is cleared and the initiating side reattaches only if the runtime, scope, physical connection, current session map, and latest policy still allow it. A failed closure confirmation remains fail-closed.
- Remote channel closes for publisher, asset, archive, and archive-discovery scopes use the same gated scheduler; the archive-only reopen timer is removed. Different physical connections supersede stale gates.
- Connection close and scope leave clear their matching gates; runtime close reaches the same cleanup through scope leave. Server-side transport endpoints clear the gate and accept the next paired open rather than initiating a competing channel.
- The active-only close filter and policy-level event-loop reopen workaround are removed. Every affected publisher/asset/archive session closes immediately, including handshaking sessions; committed accounting and watch/follow scope ownership remain unchanged.

Focused regression refinements:

- The publisher downgrade assertion explicitly rejects a stale handshaking session immediately when policy application returns.
- The held asset-transfer regression asserts global cutover returns after removing the serving session before the proof handler is released; the pending reattach later activates under the restored policy and both duplexes must survive.

Validation: **NOT RUN after this correction.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status validation were run.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm the held transfer releases into one serialized replacement without Protomux invalid-open, stale publisher handshakes, or later asynchronous cascade.

### Explicit both-end transition gate follow-up — 2026-08-11

Append-only PearTube commit:

- `0a230d7a1934f77f0f541fa5d29180de1274af0b` — `fix(policy): gate both scoped channel ends`

File:

- `packages/backend/src/network/scoped-runtime.js`

Correction:

- The serving-policy transition now captures each affected session's old channel and physical connection before close, invokes `closeSession`, then explicitly registers the pending reattach gate after the session map deletion. This makes the local policy-close ordering unambiguous and idempotent with the close helper's gate.
- The pending scheduler no longer skips a transport endpoint whose Hyperswarm connection reports `client: false`. Both Protomux endpoints must create the same scoped channel to pair; incoming opens can queue while the gate is pending, and the per-peer/connection gate remains the deduplication authority.
- Every affected session still closes, policy apply still does not await `fullyClosed()`, and eventual attach still validates current runtime/scope/connection/latest-policy state.

Controller evidence before this follow-up: 29/31 focused scoped-runtime tests. Validation after this commit: **NOT RUN** per controller instruction.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm both archive and asset replacements pair after the held close drains, without invalid-open or asynchronous cascade.

### Single-owner reattach gate cleanup — 2026-08-11

Append-only PearTube commit:

- `4c3107679935085854f4f93f378866a06a65af35` — `fix(policy): assign reattach gate once`

File:

- `packages/backend/src/network/scoped-runtime.js`

Correction:

- Removed the generic network-policy scheduler call from `closeSession`. The serving-policy transition is now the sole local owner: it captures channel/connection, closes and removes the owned session, then registers exactly one pending gate.
- Remote `onClose` remains the sole remote-side scheduler. Neither path awaits `fullyClosed()` from `applyNetworkPolicy`, so held accepted work cannot deadlock policy application.

Validation: **NOT RUN** per controller instruction.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm one local and one remote gate serialize asset/archive pairing after held work releases.

### Fail-closed fresh-transport policy cutover — 2026-08-11

Append-only PearTube commit:

- `10fa8058c3874b49042c77098792dad35c614ffb` — `fix(policy): reconnect after serving cutover`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and final cutover design:

- Controller error listeners proved that even one ordered same-transport reopen can make Protomux reject reuse of the same protocol/topic channel ID with `Invalid open message`. Same-mux replacement is therefore removed rather than delayed again.
- On a contribution/archive serving-policy change, the runtime cancels accepted responses, closes every affected publisher/asset/archive session, records each physical connection, removes it from active attachment candidates, and destroys it. `applyNetworkPolicy` does not await held protocol work or transport replacement, so bounded cancellation cannot deadlock on a proof the caller releases after apply returns.
- Hyperswarm supplies a fresh authenticated transport. Normal `handleConnection` attachment reads the latest policy: public roles return only when globally and role eligible; retained assets can attach client-only; followed publisher scopes remain retained; archive retries remain queued until a fresh eligible archive session activates.
- All `pendingReattaches`, `fullyClosed` scheduling, gate cleanup, and remote same-transport reopen code is deleted. The hard cutover leaves local playback/storage and committed accounting untouched while accepting a brief peer reconnect for rare consent or budget changes.

Focused regression changes:

- Publisher contribution-budget, global-ceiling, and upload-permission cutovers assert destruction of the old provider/follower duplex and explicitly emit a fresh pair before continued public catalog assertions.
- The held asset cutover asserts the old duplex is destroyed while apply returns before proof release; ceiling restoration uses a fresh active pair, and role-budget loss destroys that pair before a third fresh pair activates client-only.
- Archive consent withdrawal, global-ceiling increase, and archive-budget loss each assert old duplex destruction. Fresh pairs resume the queued exact-range retry and later restore an eligible active archive session without resetting committed accounting.
- Controller `PAIR_A_ERROR` / `PAIR_B_ERROR` instrumentation is removed.

Validation: **NOT RUN after this commit.** Per controller instruction, no tests, builds, formatters, linters, schemas, or git-status validation were run. Controller evidence before this redesign remained 29/31 focused scoped-runtime tests with same-mux invalid-open failures.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm hard cutovers destroy old duplexes, fresh pairs activate under latest policy, bounded in-flight errors settle, exact archive retries resume, and no asynchronous cascade remains.

### Hard-cutover fake duplex correction — 2026-08-11

Append-only PearTube test commit:

- `64f6be21b2af41dda812057e060839bc09f2afd6` — `test(policy): model hard transport cutovers`

File:

- `packages/backend/test/scoped-network-runtime.test.mjs`

Fixture correction:

- `connectionPair()` now models a real socket: either fake duplex half closing destroys the counterpart with recursion guards. Previously `Duplex.from` left the remote half and its runtime `activeConnections` entry alive, so remote-destroy assertions failed and stale archive sessions competed with fresh retries.
- Policy fixtures settle one turn after each hard cutover before asserting both halves or emitting a replacement pair, allowing both close handlers to purge old active connections.
- The held asset request now expects bounded `DISCONNECTED`, the truthful result of a hard transport reset; the prior same-channel design's `UNAVAILABLE` expectation no longer applies.
- With stale remote halves removed, the archive fresh session owns the queued retry order: pledged blocks 3 and 4 can follow block 2, while cumulative global ceiling rejects block 5.

Production hard-reset behavior is unchanged. Validation: **NOT RUN** per controller instruction.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm 31/31 tests and the final assertion count without asynchronous cascade.

### Monotonic failed-peer archive retry correction — 2026-08-11

Append-only PearTube commit:

- `fed6abbc2d444214a6dae80cee4cf6eef87f2db4` — `fix(archive): block later failed-peer retries`

Files:

- `packages/backend/src/network/scoped-runtime.js`
- `packages/backend/test/scoped-network-runtime.test.mjs`

Root cause and fix:

- When the earliest queued archive retry had already failed on the current peer, `nextArchiveBlock` skipped that retry and advanced the same resource into later indexes. Under the low ceiling it skipped failed index 3, attempted 4/5, then a fresh connection cleared the peer failure and retried 3 after the provider had served 5, violating the per-session monotonic guard. Skipping 3 also left enough committed budget for block 5.
- The earliest failed retry now blocks that peer session by returning no next block. It cannot advance the resource past the failed hole. Fresh connection activation clears that peer failure, selects retry 3 first, then advances to 4; cumulative global upload accounting rejects 5.
- The focused fixture records proof indexes, waits for the failed index-3 attempt, and proves no later index is requested on the same failed peer session. Controller `ARCHIVE_FRESH_DEBUG` instrumentation is removed.

Validation: **NOT RUN** per controller instruction.

Remaining controller concern:

- Re-run the focused scoped-runtime file to confirm exact receive order 2/3/4, block 5 denial, no monotonic protocol error, and no asynchronous cascade.

### Controller validation closure — 2026-08-10

Final observed results after `fed6abbc2d444214a6dae80cee4cf6eef87f2db4`:

- `npx brittle test/seeding-quota-budget.test.mjs test/scoped-network-runtime.test.mjs test/upload-playback-support.test.mjs` in `packages/backend`: 31/31 scoped-runtime tests and 295/295 assertions passed; the combined command exited 0.
- `npm test` at the PearTube worktree root: spec, backend, and host suites passed.
- `npm test` in `packages/cli`: all 47 test files passed.
- `npm run typecheck` at the PearTube worktree root: `@peartube/platform` `tsc --noEmit` passed.
- Exact ESLint over the Plan 12 backend/CLI production files and focused tests passed with no output.
- `go test -p 2 ./...` in the client application backend: 72 packages passed; 20 packages had no tests.

The broad `npx eslint packages/backend/src packages/cli/src --quiet` probe still reports 103 existing diagnostics in 33 unrelated files. None are in the exact Plan 12 file set, which passes the same configured linter. No schema regeneration was required by the final lifecycle/retry fixes.

Validated invariants include fail-closed policy defaults, explicit role budgets, meaningful-watch submission, source-grant cancellation, hard Hyperswarm transport cutover on serving-policy changes, fresh-transport client-only reattachment, preserved committed quota accounting, monotonic archive retry order, block-5 denial at the cumulative ceiling, bounded/redacted status, and watch-only local playback.