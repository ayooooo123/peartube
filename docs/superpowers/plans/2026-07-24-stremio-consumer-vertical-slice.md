# PearTube Consumer Streaming and Strict-P2P Vertical Slice Plan

> **For agentic workers:** REQUIRED: use `superpowers:subagent-driven-development` when subagents are available, otherwise use `superpowers:executing-plans`. Execute tasks in order. Use tests first for behavioral contracts, run focused verification for each task, and keep commits atomic.

**Goal:** Turn the completed permissionless media-network foundation into a simple Stremio-like consumer application: one moderated global catalog, one Play action with automatic source selection, strict-P2P playback with honest availability, local-first library and recommendations, and all publisher/operator controls hidden behind Developer Settings or exposed through the CLI/relay.

**Architecture:** The consumer shell reads one local projection assembled from bounded permissionless publisher and index feeds. Client-selected community moderation filters that projection before work is scheduled. A deterministic local ranker builds Home rows from network catalog signals plus device-local watch state. Playback selects a currently reachable immutable rendition, downloads media only from peers, and fails over between equivalent sources without exposing operational complexity. Public media plays directly. Protected media uses public opaque ciphertext plus provider-owned authentication/license services; license services are control-plane only and may never become media origins. Viewer history, recommendations, and resource accounting stay on device; PearTube emits no CDN telemetry.

**Prerequisite:** `docs/superpowers/plans/2026-07-23-permissionless-media-cdn.md` and the release-blocker hardening recorded in `docs/superpowers/progress/2026-07-24-permissionless-media-cdn-progress.md` are complete. This plan changes product projection and adds protected playback; it does not restore the deleted global-feed data plane.

**Tech stack:** Expo Router, React Native, Electrobun, Node/Bare JavaScript, Hypercore/Corestore/Hyperbee/Hyperblobs, Hyperswarm/Protomux, HRPC/Hyperschema, platform-native media DRM bridges, `brittle`, and `node:test`.

---

## Locked Product Decisions

1. **Primary surface:** consumer streaming. Publisher, archive, identity, network, moderation-administration, and diagnostics surfaces do not appear in normal navigation.
2. **Catalog:** one seamless global catalog. Anyone may publish signed records into permissionless discovery. Default community moderation determines normal visibility; it never changes ownership or deletes underlying records.
3. **Initial content UX:** movies and episodic series first. The underlying graph remains universal for later creator video, live, music, and other entity kinds.
4. **Navigation:** mobile has Home, Search/Discover, and Library. Desktop/TV exposes the same destinations in a compact sidebar. Settings live behind the profile/avatar.
5. **Source choice:** Play automatically selects the best currently playable source and may fail over. An optional Other Sources panel explains alternatives.
6. **Participation:** Balanced is the default. A viewer uploads during playback, briefly after playback, and in bounded background windows only when local policy permits. Metered, battery, thermal, disk, and upload ceilings are hard constraints.
7. **Identity:** no account is required. Watch state, library, and recommendations are local. Optional encrypted device pairing synchronizes user state only after explicit opt-in.
8. **Protected media:** public and protected titles coexist. Peers and relays distribute opaque ciphertext. Only entitled viewers obtain short-lived provider-issued playback licenses.
9. **Analytics:** PearTube collects no viewing, engagement, recommendation, or CDN-savings analytics and sends no playback telemetry to publishers. Provider authentication/license services necessarily observe their own requests; the UI and privacy copy must say so.
10. **Availability:** no HTTP media-origin fallback and no mandatory provider-operated seed. Playback can fail when peers disappear. The product must never claim conventional CDN availability.
11. **Publication visibility:** new records appear immediately with one of Awaiting replication, Limited availability, Healthy, or Unavailable. Healthy requires fresh evidence from independent transport identities; metadata existence alone is insufficient.
12. **Relay role:** permissionless discovery/archive nodes. Relays may gossip records, cache opaque media, satisfy archive pledges, and seed ranges. They receive no publication, moderation, entitlement, or global-ranking authority.
13. **Publishing access:** Studio lives inside Developer Settings and remains available through the CLI. Relay deployments may archive/seed published content but are not authoritative publisher infrastructure.

---

## Non-Negotiable Reality Checks

- **Strict P2P means no availability SLA.** New, rare, and unpopular titles can be unplayable. Product copy, search results, and Play controls must reflect this before a viewer commits to playback.
- **A peer count is not durability.** Healthy requires fresh, complete-range evidence from independent transport identities and must decay when evidence expires.
- **Do not invent DRM.** A JavaScript-delivered content key cannot be made meaningfully short-lived after disclosure. Commercial protected playback must use encrypted CMAF/CENC renditions and platform DRM/CDM APIs (Widevine on Android, FairPlay on Apple platforms, and an available CDM path on desktop). ClearKey is test/development only and cannot satisfy production acceptance.
- **A license service is not a media fallback.** It may authenticate, authorize, and return a license. It must not return media segments, redirect to an origin, or receive peer/range telemetry from PearTube.
- **Permissionless does not mean unfiltered.** Signed spam is still spam. Moderation and bounded ingestion must execute before artwork fetch, asset discovery, download, archive, or playback work.
- **No analytics means no hidden compromise.** Do not add telemetry SDKs, playback beacons, remote recommendation calls, stable cross-provider viewer IDs, or “anonymous” event batches.

## Execution Clarifications

### Consumer moderation order

Every catalog path uses one order:

1. enforce frame, signature, publisher authorization, replay, and ingest-budget checks;
2. apply the active local moderation policy before consumer projection or any external artwork/asset work;
3. resolve and deduplicate only accepted claims into media entities;
4. apply device codec/DRM capability and current availability gates when selecting a playback source.

Blocked publications are absent from normal Home, Search/Discover, Library recommendations, and detail navigation. Developer Mode alone changes no moderation decision. A user must explicitly change local moderation policy to reveal a blocked publication. Developer diagnostics may show bounded record IDs and rejection reasons, but must not fetch blocked artwork, join asset topics, download, seed, or archive. Invalid or unsigned introductions are rejected at discovery admission; a valid signed publisher record remains discoverable through another valid introduction. A failed/404 artwork request uses a placeholder, while an artwork locator rejected by policy is quarantined without necessarily hiding an otherwise accepted media entity.

### Catalog consistency and partitions

“Appears immediately” means after this client receives, bounds-checks, authenticates, and durably ingests the signed record; it is not a global-time guarantee. A partitioned client cannot see records it has not received. Already verified immutable records remain in the local catalog through a partition and retain their original publisher signatures; relays and indexes may gossip only the exact signed envelope and cannot synthesize publisher updates, retractions, or freshness. Availability is assessed separately and decays even while metadata remains visible. A stale publisher feed is labeled with its last verified checkpoint rather than silently deleting media or pretending a retraction was observed.

### Availability evidence and limits

- `MIN_HEALTHY_PEERS = 2` and `AVAILABILITY_EVIDENCE_TTL_MS = 60_000` are versioned protocol constants, not user-tunable ranking knobs.
- A transport identity is the authenticated remote Noise public key on an active Hyperswarm connection. One key counts once regardless of duplicate sockets. Publisher/writer keys, IP addresses, DHT nodes, and claimed device IDs do not count.
- Complete-range evidence means the peer advertises every required immutable rendition block and, after that advertisement, successfully serves valid hash-verified sampled blocks selected by an unpredictable local challenge. Evidence acquisition is lazy and budgeted to visible, selected, cached, or explicitly audited titles; catalog rendering must not open every asset swarm.
- Healthy requires two active transport identities, each with fresh complete-range evidence for the same rendition. Limited requires current hash-verified reachability of every required range but lacks two complete peers; coverage may come from one complete peer or the union of partial active peers. A static archive pledge is separate durability evidence and does not advance network availability. A fresh possession-challenge response from an archivist may contribute only while that same authenticated transport is active and can serve the challenged rendition.
- A validation mismatch, timeout past the assessment deadline, or disconnect removes that peer from current evidence and feeds the existing local peer scorer. Expiry without replacement downgrades a previously observed source to Unavailable; a never-assessed new publication remains Awaiting replication.
- A local complete copy is exposed separately as offline-playable and never inflates network peer counts. Availability is a local, point-in-time assessment—not consensus, durability, or Sybil-proof truth. Multiple Noise keys controlled by one adversary remain a known limitation, so product copy must not translate Healthy into a durability or SLA claim.

### Protected-media key boundary

The backend, HRPC, Hypercore/Hyperbee state, relay, archive protocols, and JavaScript persistence handle only signed public DRM descriptors, opaque ciphertext, and non-secret status. Provider credentials may exist transiently in the app-owned authentication coordinator and at rest only in SecureStore/keychain or the privileged desktop vault. The platform DRM/CDM creates the license challenge, receives the license response, and owns decrypted keys. JavaScript may pass origin-pinned license request headers into the platform player but must not receive a license response or raw content key.

Key-isolation verification uses both structural and canary checks: generated schemas contain no key/license payload fields; a distinctive development key/license marker is absent from captured HRPC frames, logs, crash reports, databases, app-state serialization, archive evidence, and relay storage after the complete protected playback flow. This proves the implemented boundary, not freedom from side channels. Peers still observe requested topics/ranges, and provider authentication/license services observe their own requests.

### Platform acceptance matrix

- The public strict-P2P slice must pass on Electrobun desktop plus physical Android and iOS devices.
- Protected production support requires observed Widevine on Android and FairPlay on iOS.
- Electrobun protected playback requires a confirmed usable CDM/EME path. If the runtime has none, protected sources are explicitly unsupported on desktop; public playback must still pass. PearTube must not advertise protected desktop support until that path exists.


---

## Program Gates

1. **Surface gate:** an anonymous user sees only Home, Search/Discover, Library, playback, and basic preferences. Studio and technical controls require an explicit local Developer Mode.
2. **Catalog gate:** a signed publication discovered through bounded permissionless bootstrap/index paths resolves into the one consumer catalog; blocked records cause no media or artwork work.
3. **Availability gate:** all four availability states are deterministic, evidence-backed, expiring, and rendered consistently across cards, detail screens, source explanations, and player errors.
4. **Playback gate:** Play never requests HTTP media bytes; it selects and fails over only among compatible, currently reachable P2P sources; missing ranges fail promptly with structured reasons.
5. **Participation gate:** Balanced mode contributes useful bytes without violating metered, battery, thermal, disk, background, or user upload constraints.
6. **Privacy gate:** watch history, library, ranking inputs, and recommendations remain local; network inspection shows no PearTube analytics traffic.
7. **Protected-media gate:** relays seed ciphertext without licenses; only the platform DRM path receives a provider license; decrypted keys never enter backend, HRPC, logs, JavaScript persistence, archive metadata, or relay state.
8. **Public vertical-slice gate:** on Electrobun desktop and physical Android/iOS, a fresh anonymous install can discover, search, inspect, play, resume after process restart, and save one multi-source movie or episode. The two serving peers use distinct authenticated Noise keys over real transport sessions. Disconnecting both produces `AVAILABILITY_BOUNDARY` and the visible message “Unavailable — no peer currently serves the required ranges,” with no HTTP fallback.
9. **Commercial protected-media gate:** real Widevine on Android and FairPlay on iOS play peer-delivered ciphertext while the key-isolation canaries remain absent from backend/HRPC/storage/relay boundaries. Protected Electrobun support is claimed only if its real CDM/EME probe passes; otherwise the desktop UI reports DRM unsupported. ClearKey-only coverage is explicitly insufficient.

---

## Milestone 1: Consumer Shell and Public Strict-P2P Slice

### Task 1: Introduce explicit local Developer Mode and remove operator UI from normal navigation

**Files:**

- Create: `packages/app/lib/developer-mode.ts`
- Create: `packages/app/app/developer-settings.tsx`
- Modify: `packages/app/app/(tabs)/_layout.tsx`
- Modify: `packages/app/components/PillTabBar.tsx`
- Modify: `packages/app/components/desktop/DesktopSidebar.web.tsx`
- Modify: `packages/app/components/desktop/DesktopHeader.web.tsx`
- Modify: `packages/app/app/profile.tsx`
- Move or route behind Developer Settings: `packages/app/app/(tabs)/studio.tsx`, `packages/app/app/network-policy.tsx`, `packages/app/app/subscriptions.tsx`, `packages/app/app/moderation.tsx`, `packages/app/app/maintenance.tsx`, and `packages/app/app/publisher-security.tsx`
- Create: `packages/app/tests/consumer-navigation-regression.test.mjs`
- Create: `packages/app/tests/developer-mode-regression.test.mjs`

**Acceptance:** A fresh install exposes Home, Search/Discover, and Library only. Desktop upload affordances and the mobile Studio tab are absent. A local, non-synchronized Developer Mode toggle under Profile reveals a Developer Settings route containing Studio, publishing security, network policy, archive/maintenance, feed trust, moderation administration, identity tools, and diagnostics. Deep links to privileged routes redirect to Developer Settings while the mode is off. Disabling the mode closes privileged routes and does not stop consumer playback or erase publisher state. Developer Mode is a presentation gate, not an authorization boundary: publisher mutations still require the existing shell-custodied signer, valid writer capability, and backend admission checks.

**Steps:**

1. Write failing navigation tests for mobile tabs, desktop sidebar/header, privileged deep-link guards, local persistence, and disable-while-open behavior.
2. Implement a small local settings store. Do not put Developer Mode in HRPC, pairing sync, publisher catalogs, or network policy.
3. Replace normal Studio navigation with Developer Settings links. Do not duplicate Studio or policy screens.
4. Exercise fresh-install, enable, deep-link, disable, and restart paths on web and one physical mobile device.
5. Run:

```bash
node --test packages/app/tests/consumer-navigation-regression.test.mjs packages/app/tests/developer-mode-regression.test.mjs
npm run typecheck
```

6. Commit:

```bash
git add packages/app/lib/developer-mode.ts packages/app/app/developer-settings.tsx packages/app/app/'(tabs)'/_layout.tsx packages/app/components/PillTabBar.tsx packages/app/components/desktop/DesktopSidebar.web.tsx packages/app/components/desktop/DesktopHeader.web.tsx packages/app/app/profile.tsx packages/app/app/'(tabs)'/studio.tsx packages/app/app/network-policy.tsx packages/app/app/subscriptions.tsx packages/app/app/moderation.tsx packages/app/app/maintenance.tsx packages/app/app/publisher-security.tsx packages/app/tests/consumer-navigation-regression.test.mjs packages/app/tests/developer-mode-regression.test.mjs
git commit -m "feat(app): separate consumer and developer surfaces"
```

### Task 2: Define the one-catalog projection and safe default moderation profile

**Files:**

- Modify: `packages/backend/src/indexing/feed-manager.js`
- Modify: `packages/backend/src/indexing/local-index.js`
- Modify: `packages/backend/src/discovery/bootstrap-manager.js`
- Modify: `packages/backend/src/media-graph/catalog-projection.js`
- Modify: `packages/backend/src/media-graph/resolver.js`
- Modify: `packages/backend/src/api/media-graph.js`
- Modify: `packages/app/lib/media-catalog-controller.mjs`
- Create: `packages/app/lib/default-moderation-profile.ts`
- Modify: `packages/app/lib/content-catalog.js`
- Create: `packages/backend/test/consumer-catalog-projection.test.mjs`
- Create: `packages/backend/test/default-moderation-before-work.test.mjs`
- Create: `packages/backend/test/default-moderation-non-authority.test.mjs`
- Create: `packages/app/tests/one-catalog-regression.test.mjs`
- Create: `packages/app/tests/default-moderation-profile.test.mjs`

**Acceptance:** The app returns one paginated consumer catalog assembled from bounded publisher and index introductions, with movies and series projected first. No user has to add a source to see discovered candidates. The bundled default is a versioned local policy plus an initial replaceable set of curated moderation-feed subscriptions. Curator keys authenticate those optional feeds only; they are not protocol trust roots and cannot determine whether publisher records, discovery, replication, or playback are valid. The profile can be disabled, inspected, replaced, or restored in Developer Settings. An app update never overwrites a user-customized profile; Restore Defaults selects the current bundled version explicitly. It filters the normal projection before artwork fetch, asset topic join, playback preparation, cache, seeding, or archive work. Disabling it reveals records locally without changing network truth. No default index, relay, or moderation signer gains ownership, deletion, discovery, or media authority.

**Steps:**

1. Add fixtures for duplicate movie publications, partial episode collections, spam storms, blocked artwork URLs, conflicting metadata, unsigned introductions, a local moderation override, and removal of every bundled curator subscription.
2. Define bounded candidate intake, dedupe keys, cursor ordering, accepted entity kinds, and a versioned local default-profile descriptor. Test bundled-profile upgrade with and without user customization, disable/restore, and curator-key removal.
3. Reuse the media graph resolver; do not create a second “consumer catalog” database or restore a global Hypercore feed.
4. Prove blocked candidates trigger zero downstream media/artwork work. Separately prove that deleting or replacing the bundled profile changes only local projection: signed publisher records remain discoverable, valid, replicable, and playable when local policy permits, and no peer protocol handler requires a bundled curator key.
5. Run:

```bash
npm exec --prefix packages/backend -- brittle packages/backend/test/consumer-catalog-projection.test.mjs packages/backend/test/default-moderation-before-work.test.mjs packages/backend/test/default-moderation-non-authority.test.mjs packages/backend/test/moderation-enforcement.test.mjs packages/backend/test/media-entity-resolver.test.mjs
node --test packages/app/tests/one-catalog-regression.test.mjs packages/app/tests/default-moderation-profile.test.mjs packages/app/tests/content-catalog.test.mjs
```

6. Commit:

```bash
git add packages/backend/src/indexing packages/backend/src/discovery/bootstrap-manager.js packages/backend/src/media-graph packages/backend/src/api/media-graph.js packages/backend/test/consumer-catalog-projection.test.mjs packages/backend/test/default-moderation-before-work.test.mjs packages/backend/test/default-moderation-non-authority.test.mjs packages/app/lib/default-moderation-profile.ts packages/app/lib/media-catalog-controller.mjs packages/app/lib/content-catalog.js packages/app/tests/one-catalog-regression.test.mjs packages/app/tests/default-moderation-profile.test.mjs
git commit -m "feat(catalog): project one moderated consumer catalog"
```

### Task 3: Make availability a first-class expiring contract

**Files:**

- Modify: `packages/backend/src/assets/availability.js`
- Modify: `packages/backend/src/assets/manifest-store.js`
- Modify: `packages/backend/src/archive/confidence.js`
- Modify: `packages/backend/src/media-graph/catalog-projection.js`
- Modify: `packages/backend/src/media-graph/source-selector.js`
- Modify: `packages/backend/src/api/media-graph.js`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/host/src/index.d.ts`
- Modify: `packages/platform/src/rpc.shared.ts`
- Modify: `packages/core/src/types/index.ts`
- Regenerate: generated schema, HRPC, Swift quarantine artifacts, and app backend bundles
- Create: `packages/backend/test/consumer-availability.test.mjs`
- Create: `packages/app/tests/availability-state-regression.test.mjs`

**Contract:**

```text
awaiting-replication  publication exists; no fresh complete-range evidence
limited               required ranges are reachable, but evidence is below health threshold
healthy               required ranges have fresh complete-range evidence from the configured
                      minimum number of independent transport identities
unavailable           evidence expired or current sessions prove required ranges unreachable
```

Each response carries `state`, `observedAt`, `expiresAt`, `requiredRangeCount`, `reachableRangeCount`, `independentPeerCount`, and bounded reason codes. It follows the constants and evidence rules in **Availability evidence and limits** above. Catalog and archive signatures are evidence inputs, not proof of present reachability.

**Acceptance:** State calculation is deterministic under fixed time, uses two distinct authenticated Noise keys for Healthy, expires after 60 seconds, distinguishes local completeness and static archive pledges from network reachability, deduplicates repeated sockets from one transport key, and never labels metadata-only content Healthy. A static pledge alone leaves a never-assessed title Awaiting replication; Limited requires current hash-verified reachability of all required ranges. Validation mismatch, timeout, disconnect, partition, fresh archivist challenge, and lazy assessment budgets have explicit fixtures. The same response instance and timestamp appear on catalog cards, entity details, Other Sources, and player preparation errors; the design does not claim global consensus.

**Steps:**

1. Add failing tests for zero peers, one complete peer, two complete peers, several partial peers, duplicate sockets from one Noise key, local complete copy, static archive pledge, fresh archivist challenge, invalid served bytes, 60-second expiry, partition/disconnect during preparation, lazy assessment budgets, and recovery after a new peer arrives.
2. Implement the pure assessment before wiring it into the graph projection.
3. Update schema first, run `npm run schema:full`, then update host/platform/core consumers.
4. Regenerate native/backend artifacts immediately; omitted wire fields must have explicit defaults rather than decode as zero.
5. Run:

```bash
npm run schema:full
npm exec --prefix packages/backend -- brittle packages/backend/test/consumer-availability.test.mjs packages/backend/test/archive-confidence.test.mjs packages/backend/test/media-graph-api.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
node --test packages/app/tests/availability-state-regression.test.mjs
npm run typecheck
npm run bundle:backend --prefix packages/app
```

6. Commit:

```bash
git add packages/backend/src/assets packages/backend/src/archive/confidence.js packages/backend/src/media-graph packages/backend/src/api/media-graph.js packages/backend/test/consumer-availability.test.mjs packages/spec packages/host packages/platform packages/core/src/types/index.ts packages/app/backend packages/app/tests/availability-state-regression.test.mjs
git commit -m "feat(playback): expose honest expiring availability"
```

### Task 4: Implement automatic source selection and bounded failover

**Files:**

- Modify: `packages/backend/src/media-graph/source-selector.js`
- Modify: `packages/backend/src/media-graph/selection-diagnostics.js`
- Modify: `packages/backend/src/playback/multi-peer-scheduler.js`
- Modify: `packages/backend/src/playback/resource-policy.js`
- Modify: `packages/backend/src/api/media-graph.js`
- Modify: playback preparation in `packages/backend/src/api.js`
- Modify: `packages/app/lib/media-source-selection.js`
- Modify: `packages/app/components/media/SourceSelector.tsx`
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/components/VideoPlayerOverlay.web.tsx`
- Create: `packages/backend/test/automatic-source-failover.test.mjs`
- Create: `packages/app/tests/automatic-play-regression.test.mjs`

**Selection order:** reject moderation failures, incompatible encryption/DRM, unsupported codec/container, stale manifests, incomplete collection member bindings, and unavailable required ranges before scoring. Score eligible sources by local completeness, startup-range reachability, format support, fresh peer evidence, expected startup latency, and user override. Publisher popularity and paid placement are not score inputs.

**Acceptance:** One Play action selects a source without opening a picker. If the selected source fails before irreversible player state, preparation may try the next compatible source within one overall deadline and a strict attempt cap. Failover never crosses to a different edition/cut/episode, never downgrades protected to public lookalikes, never bypasses moderation, and never loops. Other Sources remains optional and explains why each source won, lost, or was rejected.

**Steps:**

1. Add deterministic selection vectors and failures for source equivalence, codec mismatch, stale health, moderation, DRM capability, timeout, disconnect, and exhausted alternatives.
2. Implement one pure selector shared by API and explanation UI. Remove presentation-only fallback rankings.
3. Put one deadline and one cancellation tree around all attempts; close every abandoned asset session.
4. Drive playback with a selected source disappearing during startup and verify the second equivalent source starts.
5. Run:

```bash
npm exec --prefix packages/backend -- brittle packages/backend/test/automatic-source-failover.test.mjs packages/backend/test/media-source-selector.test.mjs packages/backend/test/multi-peer-playback.test.mjs packages/backend/test/playback-service.test.mjs packages/backend/test/playback-api.test.mjs
node --test packages/app/tests/automatic-play-regression.test.mjs packages/app/tests/video-player-overlay-source-regression.test.mjs packages/app/tests/media-source-selection.test.mjs
```

6. Commit:

```bash
git add packages/backend/src/media-graph packages/backend/src/playback packages/backend/src/api/media-graph.js packages/backend/src/api.js packages/backend/test/automatic-source-failover.test.mjs packages/app/lib/media-source-selection.js packages/app/components/media/SourceSelector.tsx packages/app/components/VideoPlayerOverlayImpl.tsx packages/app/components/VideoPlayerOverlay.web.tsx packages/app/tests/automatic-play-regression.test.mjs
git commit -m "feat(playback): select and fail over P2P sources"
```

### Task 5: Enforce strict-P2P media transport end to end

**Files:**

- Modify: `packages/backend/src/assets/asset-session.js`
- Modify: `packages/backend/src/playback/index.js`
- Modify: `packages/backend/src/playback/multi-peer-scheduler.js`
- Modify: playback URL generation in `packages/backend/src/storage.js`
- Modify: `packages/backend/src/api/status.js`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/lib/video-player/playerPort.ts`
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/components/VideoPlayerOverlay.web.tsx`
- Create: `packages/backend/test/strict-p2p-playback.test.mjs`
- Create: `packages/backend/src/playback/errors.js`
- Modify: `packages/core/src/types/index.ts`
- Create: `packages/app/tests/strict-p2p-player-regression.test.mjs`

**Acceptance:** Remote media bytes enter only through authorized scoped asset sessions. The loopback blob server may expose already-local Hypercore bytes to the player, but it is not an origin and cannot fetch HTTP media. Manifests, artwork, provider authentication, and DRM license requests are separately classified control-plane traffic. Define and transport bounded errors `AVAILABILITY_BOUNDARY`, `NO_COMPATIBLE_SOURCE`, `PEER_TIMEOUT`, `PEER_DISCONNECT`, `RANGE_MISMATCH`, and `SESSION_LIMIT`; provider-player errors additionally include `DRM_UNSUPPORTED`, `LICENSE_DENIED`, and `LICENSE_EXPIRED`. Each code has one user message and retry policy. A missing startup range returns `AVAILABILITY_BOUNDARY`, leaves no half-open session, and never points to a publisher origin/CDN.

**Steps:**

1. Add transport-spy tests that reject HTTP(S) segment fetches, redirects, manifest URLs that smuggle media, and fallback after peer loss. Add error mapping tests: timeout, disconnect, and session pressure may retry within the overall attempt cap; availability boundary, range mismatch, unsupported DRM, denied license, and expired license require new evidence, capability, or user action and cannot loop.
2. Prove local complete playback works with networking disabled and remote playback works with peer transport only.
3. Add timeout/cancellation tests for startup, seek, peer loss, app backgrounding, and shutdown.
4. Exercise with an HTTP trap server and two peers; the trap must receive zero media requests.
5. Run:

```bash
npm exec --prefix packages/backend -- brittle packages/backend/test/strict-p2p-playback.test.mjs packages/backend/test/asset-session.test.mjs packages/backend/test/playback-service.test.mjs packages/backend/test/playback-api.test.mjs packages/backend/test/multi-peer-playback.test.mjs
node --test packages/app/tests/strict-p2p-player-regression.test.mjs packages/app/tests/video-player-streaming-seek-regression.test.mjs packages/app/tests/mse-player-seek-regression.test.mjs
```

6. Commit:

```bash
git add packages/backend/src/assets/asset-session.js packages/backend/src/playback packages/backend/src/storage.js packages/backend/src/api/status.js packages/backend/test/strict-p2p-playback.test.mjs packages/core/src/types/index.ts packages/app/lib/VideoPlayerContext.tsx packages/app/lib/video-player/playerPort.ts packages/app/components/VideoPlayerOverlayImpl.tsx packages/app/components/VideoPlayerOverlay.web.tsx packages/app/tests/strict-p2p-player-regression.test.mjs
git commit -m "feat(playback): enforce peer-only media delivery"
```

### Task 6: Build the simple Home, Search/Discover, Library, and detail experience

**Files:**

- Modify: `packages/app/app/(tabs)/index.tsx`
- Modify: `packages/app/app/(tabs)/index.web.tsx`
- Modify: `packages/app/app/(tabs)/discover.tsx`
- Modify: `packages/app/app/search.tsx`
- Modify: `packages/app/app/(tabs)/library.tsx`
- Modify: `packages/app/app/media/[id].tsx`
- Modify: `packages/app/app/media/[id].web.tsx`
- Modify: `packages/app/app/collection/[id].tsx`
- Modify: `packages/app/app/collection/[id].web.tsx`
- Modify: `packages/app/components/media/MediaCatalogView.tsx`
- Modify: `packages/app/components/media/MediaPosterCard.tsx`
- Modify: `packages/app/components/media/HeroFeatureCard.tsx`
- Modify: `packages/app/components/media/MediaRail.tsx`
- Modify: `packages/app/components/media/MediaEntityDetailScreen.tsx`
- Modify: `packages/app/components/media/ArchiveStatus.tsx`
- Create: `packages/app/tests/consumer-home-regression.test.mjs`
- Create: `packages/app/tests/consumer-media-detail-regression.test.mjs`

**Acceptance:** Home renders Continue Watching, Recommended for You, Trending, Recently Added, Movies, Series, and provider/editorial collection rails from one catalog. Continue Watching and recommendations use local state; network catalog signals may influence non-private rows. Search returns merged entities rather than publisher uploads. Detail screens lead with title, artwork, synopsis, availability, and one Play/Resume action. Publisher IDs, claim counts, archive mechanics, and source diagnostics are hidden under details/Other Sources. Library contains saved items, downloads/local copies, history, and playlists without exposing channels as the primary model.

**Steps:**

1. Add UI contract fixtures for a movie with duplicate sources, a partial series, no local history, a resumed episode, unavailable content, a blocked title, and missing artwork.
2. Implement rail derivation as pure, deterministic projection functions. Do not fetch remote recommendations.
3. Replace operational card copy such as raw publisher IDs, claim counts, and archive labels with consumer metadata and the four availability states.
4. Validate keyboard/TV focus, screen-reader labels, small mobile layout, and desktop sidebar layout.
5. Drive the complete Home → detail → Play → Library path in the desktop browser and on one physical mobile device.
6. Run:

```bash
node --test packages/app/tests/consumer-home-regression.test.mjs packages/app/tests/consumer-media-detail-regression.test.mjs packages/app/tests/media-entity-pages-regression.test.mjs packages/app/tests/collection-projection-regression.test.mjs packages/app/tests/mobile-ui-redesign-regression.test.mjs packages/app/tests/desktop-media-cockpit-regression.test.mjs
npm run typecheck
```

7. Commit:

```bash
git add packages/app/app packages/app/components/media packages/app/tests/consumer-home-regression.test.mjs packages/app/tests/consumer-media-detail-regression.test.mjs
git commit -m "feat(app): deliver the consumer media library"
```

### Task 7: Keep watch state and recommendations local, with optional encrypted pairing

**Files:**

- Modify: `packages/app/lib/watch-history.ts`
- Modify: `packages/app/lib/playback-resume.ts`
- Modify: `packages/app/lib/store/appStore.tsx`
- Create: `packages/app/lib/local-recommendations.ts`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/lib/personal-encryption.ts`
- Modify: `packages/app/app/profile.tsx`
- Modify: `packages/backend/src/identity.js`
- Modify: `packages/backend/src/personal/personal-store.js`
- Modify: `packages/backend/src/personal/personal-crypto.js`
- Modify: `packages/backend/src/personal/personal-manager.js`
- Modify: `packages/backend/src/api/personal.js`
- Modify: `packages/spec/schema.cjs`
- Modify: host/platform/core types and regenerate all artifacts
- Create: `packages/app/tests/local-recommendations.test.mjs`
- Create: `packages/backend/test/private-watch-state-pairing.test.mjs`
- Create: `packages/app/tests/no-viewer-analytics-regression.test.mjs`
- Create: `packages/app/tests/personal-pairing-separation.test.mjs`

**Acceptance:** Reuse the existing encrypted `PersonalStore`; do not add a second user-state sync database or reuse publisher-channel pairing. Watch position, completion, saved-library state, and recommendation features are stored locally under bounded retention. Ranking uses no stable network identity and issues no remote recommendation/telemetry request. Anonymous use is complete. Optional user-state pairing uses the existing authenticated BlindPairing flow to transfer only the private personal-store bootstrap/writer authorization and 32-byte keychain secret to an explicitly paired device. Invites are user-initiated, single-use, serialized against concurrent redemption, and expire within five minutes. Autobase cores and the Hyperbee view remain encrypted with the existing derived keys; production viewer state never falls back to an unencrypted personal store. A device without a secure vault remains device-local with pairing disabled. The platform—not the backend—generates and persists the first-device secret, `ProvisionPersonalEncryptionRequest.secret` becomes required, and its response no longer contains a secret. A joining device may receive the secret exactly once in the explicit local pairing-completion response and must persist then erase it before enabling sync. Synced records exclude publisher roots and provider auth tokens, resolve concurrent progress deterministically, and support forward revocation: removing a device rotates to a new personal-store epoch and secret before any later state is written. A revoked device may retain plaintext it observed before revocation—no software can claw that back—but cannot decrypt or write the new epoch; retained devices must explicitly re-pair. Disabling pairing leaves local state usable. No other HRPC response exports the personal-store secret, and no relay, publisher catalog, moderation feed, or archive record contains raw viewing history. The profile’s “Your devices” UI calls only personal-store pairing RPCs; publisher-channel device pairing remains confined to Developer Settings → Studio.

**Steps:**

1. Add behavior tests for resume thresholds, completed-title removal from Continue Watching, deterministic recommendations, private-state schema rejection on public paths, encrypted store restart, rejection of production unencrypted fallback, five-minute invite expiry, concurrent/replayed invite rejection, pairing merge, forward revocation, and separation from publisher-channel pairing.
2. Extend the existing personal record shape with entity/edition/member identity, position, duration, completion, saved flag, playback generation, Lamport clock, writer key, and tombstone. Resolve concurrent records by `(playbackGeneration, lamport, writerKey)`; completion is monotonic within one generation, while an explicit replay starts a higher generation. Migrate legacy channel/video keys without deleting the source until the encrypted record is durable.
3. Keep key custody on the existing boundary: the platform generates the first 32-byte secret with a CSPRNG, persists it in SecureStore/keychain/privileged desktop vault, and sends it once in the local provisioning request; remove backend secret generation and the secret field from the provisioning response. During explicit pairing only, return the received secret once to the joining platform, persist it before opening the store, zero the response buffer where supported, and never log or serialize it. Backend memory derives the existing DEK/wrapping keys; peers receive only encrypted Autobase replication. Serialize invite redemption and consume the persisted invite before granting one writer. Implement revocation as a new encrypted store epoch containing only current bounded state; stop joining/replicating the old epoch before accepting new writes and require retained devices to re-pair. Never promise deletion of data already read by a revoked device.
4. Add dedicated personal-store create-invite, redeem, list-device, and revoke HRPC methods. Rewire Profile → Your devices to them; never pass an identity `driveKey` into publisher `createDeviceInvite`/`pairDevice`. Keep publisher pairing available only inside Studio.
5. Add an outbound-request harness that exercises browse, search, playback, pause, seek, complete, save, and recommend. Allow P2P, artwork, explicit provider auth/license, and user-triggered diagnostics export only; assert zero analytics/beacon traffic.
6. Update privacy copy with unavoidable P2P IP/topic leakage, provider license-service visibility, and the forward-only limit of paired-device revocation. Do not claim anonymity or retroactive erasure.
7. Run:

```bash
npm run schema:full
node --test packages/app/tests/local-recommendations.test.mjs packages/app/tests/no-viewer-analytics-regression.test.mjs packages/app/tests/personal-pairing-separation.test.mjs packages/app/tests/watch-history-adapter-regression.test.mjs packages/app/tests/player-watch-session-regression.test.mjs
npm exec --prefix packages/backend -- brittle packages/backend/test/private-watch-state-pairing.test.mjs packages/backend/test/personal-store.test.mjs packages/backend/test/personal-store-encryption.test.mjs packages/backend/test/personal-hrpc-wiring.test.mjs packages/backend/test/identity-recovery.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
npm run typecheck
```

8. Commit:

```bash
git add packages/app/lib packages/app/app packages/app/tests/local-recommendations.test.mjs packages/app/tests/no-viewer-analytics-regression.test.mjs packages/app/tests/personal-pairing-separation.test.mjs packages/app/tests/watch-history-adapter-regression.test.mjs packages/app/tests/player-watch-session-regression.test.mjs packages/backend/src/identity.js packages/backend/src/personal packages/backend/src/api/personal.js packages/backend/src/api.js packages/backend/test/private-watch-state-pairing.test.mjs packages/backend/test/personal-store.test.mjs packages/spec packages/host packages/platform packages/core/src/types/index.ts packages/app/backend
git commit -m "feat(privacy): keep viewer state local by default"
```

### Task 8: Implement Balanced participation as a resource policy, not a promise

**Files:**

- Modify: `packages/backend/src/api/policy.js`
- Modify: `packages/backend/src/api/network-lifecycle.js`
- Modify: `packages/backend/src/playback/resource-policy.js`
- Modify: `packages/backend/src/seeding.js`
- Modify: `packages/backend/src/budget-manager.js`
- Modify: archive policy under `packages/backend/src/archive/policy.js`
- Modify: `packages/app/app/profile.tsx`
- Modify: `packages/app/app/network-policy.tsx`
- Create: `packages/backend/test/balanced-participation-policy.test.mjs`
- Create: `packages/app/tests/consumer-participation-copy-regression.test.mjs`

**Acceptance:** Fresh installs select Balanced with a 20 GiB cache ceiling, 1 GiB rolling-24-hour upload ceiling, and 5 Mbit/s outbound cap. Upload is eligible during playback and for 10 minutes afterward. Background work is opportunistic, limited to 15 minutes per session and 60 minutes per rolling 24 hours, and requires an unmetered network, OS permission, nominal/fair thermal state, at least 50% battery or external power, and the greater of 2 GiB or 10% disk free. OS categorical thermal/power signals are authoritative; do not infer device temperature. Mobile backgrounding that cannot legally run work suspends rather than pretending to seed. Data Saver disables post-play/background contribution; Help More widens user ceilings but cannot override OS or explicit hard constraints. Archive pledges remain opt-in and are not created by Balanced mode.

**Steps:**

1. Add state-transition tests for playback, grace expiry, foreground/background, metered changes, battery/thermal pressure, disk pressure, quota exhaustion, and restart.
2. Make the policy decision pure and central. Managers consume it; they do not invent separate defaults.
3. Present Data Saver / Balanced / Help More in normal preferences; keep exact ceilings and archive controls in Developer Settings.
4. Verify the device contribution status distinguishes “eligible,” “actively uploading,” and “suspended.”
5. Run:

```bash
npm exec --prefix packages/backend -- brittle packages/backend/test/balanced-participation-policy.test.mjs packages/backend/test/network-policy-runtime.test.mjs packages/backend/test/playback-resource-policy.test.mjs
node --test packages/app/tests/consumer-participation-copy-regression.test.mjs packages/app/tests/network-policy-controls-regression.test.mjs
```

6. Commit:

```bash
git add packages/backend/src/api/policy.js packages/backend/src/api/network-lifecycle.js packages/backend/src/playback/resource-policy.js packages/backend/src/seeding.js packages/backend/src/budget-manager.js packages/backend/src/archive/policy.js packages/backend/test/balanced-participation-policy.test.mjs packages/app/app/profile.tsx packages/app/app/network-policy.tsx packages/app/tests/consumer-participation-copy-regression.test.mjs
git commit -m "feat(network): make balanced contribution the default"
```

---

## Milestone 2: Provider-Protected Ciphertext Playback

### Task 9: Add protected-rendition and entitlement contracts without exposing content keys

**Files:**

- Create: `packages/backend/src/access/protected-rendition.js`
- Create: `packages/backend/src/access/entitlement-descriptor.js`
- Modify: `packages/backend/src/assets/manifest.js`
- Modify: `packages/backend/src/assets/media-validation.js`
- Modify: `packages/backend/src/media-graph/source-selector.js`
- Modify: `packages/backend/src/content-publication.js`
- Modify: `packages/spec/schema.cjs`
- Modify: `packages/core/src/types/index.ts`
- Modify: host/platform types and regenerate all generated artifacts
- Create: `packages/backend/test/protected-rendition-contract.test.mjs`
- Create: `packages/backend/test/protected-publication-validation.test.mjs`
- Create: `packages/backend/test/protected-media-key-isolation.test.mjs`

**Acceptance:** The same ciphertext is cacheable by viewers and relays without entitlement. Tampered key IDs, init data, scheme, endpoint, or issuer invalidate publication/rendition selection. Unsupported DRM makes a source unavailable with `DRM_UNSUPPORTED` before asset download. Public renditions remain unchanged. ClearKey requires an injected `allowClearKeyForTests` capability available only to deterministic test/dev fixtures; production constructors and generated app contracts do not expose that capability and reject ClearKey manifests. Generated backend/HRPC schemas contain no bearer-token, license-payload, or content-key field. The distinctive key/license canary defined by the test is absent from captured frames, logs, crash reports, databases, archive evidence, and relay state.

**Steps:**

1. Add canonical Node/Bare vectors, malformed-manifest cases, schema-absence assertions, and a distinctive development key/license canary.
2. Extend the existing immutable manifest rather than adding a second protected catalog.
3. Keep content keys and provider tokens out of HRPC and backend storage by construction; capture and inspect every persisted/wire/log boundary exercised by the fixture.
4. Run:

```bash
npm run schema:full
npm exec --prefix packages/backend -- brittle packages/backend/test/protected-rendition-contract.test.mjs packages/backend/test/protected-publication-validation.test.mjs packages/backend/test/protected-media-key-isolation.test.mjs packages/backend/test/asset-manifest.test.mjs packages/backend/test/media-source-selector.test.mjs
npm test --prefix packages/spec
npm test --prefix packages/host
npm test --prefix packages/platform
npm run typecheck
```

5. Commit:

```bash
git add packages/backend/src/access packages/backend/src/assets packages/backend/src/media-graph/source-selector.js packages/backend/src/content-publication.js packages/backend/test/protected-rendition-contract.test.mjs packages/backend/test/protected-publication-validation.test.mjs packages/backend/test/protected-media-key-isolation.test.mjs packages/spec packages/core/src/types/index.ts packages/host packages/platform packages/app/backend
git commit -m "feat(access): define protected ciphertext renditions"
```

### Task 10: Put provider authentication and license acquisition in the privileged player boundary

**Files:**

- Create: `packages/app/lib/provider-auth/provider-session.ts`
- Create: `packages/app/lib/provider-auth/credential-vault.native.ts`
- Create: `packages/app/lib/provider-auth/credential-vault.web.ts`
- Create: `packages/app/lib/drm/drm-session.ts`
- Modify protected mobile `VideoSource` construction through the installed `expo-video` DRM contract
- Modify `packages/app/android/app/src/main/java/com/peartube/app/PlayerActivity.kt` and `packages/app/plugins/templates/PlayerActivity.kt.template` only if the custom Android playback handoff bypasses `expo-video`
- Modify: `packages/app/package.json` only if the supported `expo-video` DRM contract requires an upgrade
- Modify: `packages/app/lib/video-player/playerPort.ts`
- Modify: `packages/app/lib/VideoPlayerContext.tsx`
- Modify: `packages/app/components/VideoPlayerOverlayImpl.tsx`
- Modify: `packages/app/components/VideoPlayerOverlay.web.tsx`
- Create: `packages/app/tests/provider-auth-session.test.mjs`
- Create: `packages/app/tests/drm-boundary-regression.test.mjs`
- Create: `packages/app/tests/drm-platform-capability.test.mjs`

**Acceptance:** Anonymous catalog browsing remains possible. Pressing Play on protected media starts provider authentication only when no valid local provider session exists. The provider token is stored in SecureStore/keychain or the privileged desktop vault, scoped to the signed provider origin, and never sent to backend/HRPC/peers. The platform DRM/CDM creates the license challenge, receives the license response, and owns content keys. JavaScript may coordinate session state and supply origin-pinned license request headers but never receives or persists a license response or decrypted key. The dynamic canary flow rechecks every boundary listed in **Protected-media key boundary**. Capability negotiation runs before protected asset work and maps unsupported production DRM/ClearKey to `DRM_UNSUPPORTED`. Sign-out clears provider credentials and active licenses without deleting public ciphertext caches. License failure does not attempt an HTTP media fallback.

**Steps:**

1. Write boundary tests that fail if provider tokens, license responses, or key canaries cross HRPC, appear in logs/crash reports, enter app-state serialization, or reach backend/relay/archive code.
2. Implement provider auth with PKCE/device flow according to the signed descriptor; reject arbitrary redirect or license origins.
3. Use the installed `expo-video` `VideoSource.drm` contract for Android Widevine and iOS FairPlay; its documented license server, request headers, FairPlay certificate/content ID, and Android multi-key fields are the starting boundary. Set `useCaching: false` for protected sources because PearTube's Hypercore ciphertext cache is external to `expo-video` and Expo does not support its own cache for DRM media. If the custom Android `PlayerActivity` path bypasses `expo-video`, thread equivalent ExoPlayer DRM configuration through that path and its generated template without exposing keys to JavaScript.
4. Probe actual device DRM capability before asset download. Probe Electrobun's real CDM/EME support with an encrypted fixture before implementing desktop protected playback. If no usable CDM exists, return `DRM_UNSUPPORTED` rather than substituting ClearKey or JavaScript decryption.
5. Use ClearKey only for deterministic tests. Complete the gate with real provider-issued test licenses on supported devices.
6. Exercise expiry, renewal, cancellation, backgrounding, sign-out, provider denial, network loss after license acquisition, and peer loss before/after startup.
7. Run focused contract checks:

```bash
node --test packages/app/tests/provider-auth-session.test.mjs packages/app/tests/drm-boundary-regression.test.mjs packages/app/tests/drm-platform-capability.test.mjs
npm run typecheck
```

8. Build and exercise physical Android and iOS binaries with Widevine and FairPlay using `JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home npm run android --prefix packages/app` and `npm run build:ios:device --prefix packages/app`. Run the Electrobun encrypted-fixture probe and record supported/unsupported capability evidence.
9. Commit only after platform evidence is recorded:

```bash
git add packages/app/lib/provider-auth packages/app/lib/drm packages/app/lib/video-player packages/app/lib/VideoPlayerContext.tsx packages/app/components/VideoPlayerOverlayImpl.tsx packages/app/components/VideoPlayerOverlay.web.tsx packages/app/android/app/src/main/java/com/peartube/app/PlayerActivity.kt packages/app/plugins/templates/PlayerActivity.kt.template packages/app/package.json packages/app/tests/provider-auth-session.test.mjs packages/app/tests/drm-boundary-regression.test.mjs packages/app/tests/drm-platform-capability.test.mjs
git commit -m "feat(playback): acquire protected licenses in platform DRM"
```
Reference: Expo's official `expo-video` DRM contract documents `VideoSource.drm`, Android Widevine/PlayReady/ClearKey, iOS FairPlay, and the platform restriction that its own cache cannot store DRM-protected media: <https://docs.expo.dev/versions/latest/sdk/video/#drmoptions>.

### Task 11: Prove relays distribute protected bytes without gaining playback authority

**Files:**

- Modify: `packages/backend/src/archive/permissionless-network.js`
- Modify: `packages/backend/src/archive/manager.js`
- Modify: `packages/backend/src/assets/asset-session.js`
- Modify: `packages/cli/src/archive-manager.js`
- Modify: `packages/cli/src/service.js`
- Modify: `packages/cli/src/status.js`
- Modify: `packages/cli/scripts/run-tests.mjs`
- Create: `packages/backend/test/protected-ciphertext-archive.test.mjs`
- Create: `packages/cli/test/protected-ciphertext-relay.test.mjs`

**Acceptance:** A clean relay with no provider account or license can discover, retain, prove possession of, and seed complete ciphertext ranges. It cannot request a viewer license through PearTube, cannot decrypt the media, and cannot claim entitlement. Archive proofs bind ciphertext block hashes and immutable rendition identities. CLI status reports bytes, ranges, pledge health, and availability only—never viewer, subscriber, or license data.

**Steps:**

1. Add a three-process fixture: publisher, unentitled relay, and entitled viewer.
2. Verify the relay satisfies range requests and archive challenges using ciphertext only.
3. Search serialized relay state and logs for tokens, license blobs, content keys, auth callbacks, and provider identifiers beyond public signed descriptors.
4. Kill the publisher and prove playback continues through the relay while the viewer license remains valid; then expire the license and prove ciphertext remains seedable but unplayable.
5. Run:

```bash
npm exec --prefix packages/backend -- brittle packages/backend/test/protected-ciphertext-archive.test.mjs packages/backend/test/archive-integration.test.mjs
npm exec --prefix packages/cli -- brittle test/protected-ciphertext-relay.test.mjs
npm test --prefix packages/cli
```

6. Commit:

```bash
git add packages/backend/src/archive packages/backend/src/assets/asset-session.js packages/backend/test/protected-ciphertext-archive.test.mjs packages/cli/src packages/cli/test/protected-ciphertext-relay.test.mjs packages/cli/scripts/run-tests.mjs
git commit -m "feat(relay): archive protected ciphertext without entitlement"
```

---

## Milestone 3: End-to-End Acceptance and Cutover

### Task 12: Run the complete public and protected multi-device product matrix

**Files:**

- Create: `packages/backend/test/fixtures/consumer-strict-p2p-smoke.mjs`
- Create: `packages/backend/test/fixtures/http-trap.mjs`
- Create: `packages/app/tests/consumer-vertical-slice-regression.test.mjs`
- Modify focused fixtures only when they fail on a real contract defect
- Update: `docs/superpowers/progress/2026-07-24-permissionless-media-cdn-progress.md` after observed completion

**Required topology:**

- publisher A with a movie and episodes 1–3;
- publisher B with an equivalent movie rendition and episodes 4–6;
- two viewer/serving device processes with distinct authenticated Noise keys and real transport sessions;
- one clean volunteer relay;
- no HTTP media origin;
- one public title and one provider-protected title;
- a trap endpoint that records forbidden media fallback and analytics traffic.

**Acceptance scenarios:**

1. Fresh anonymous install opens a useful moderated Home without adding a source or creating an account.
2. Search resolves duplicate publications into one movie and partial episode claims into one series.
3. Blocked catalog entries trigger no artwork, asset, cache, archive, or playback work.
4. A new publication first shows Awaiting replication, then Limited, then Healthy only after fresh independent complete-range evidence.
5. Play automatically selects the best compatible source. Removing that source during startup causes one bounded failover to the equivalent source.
6. Removing every source returns `AVAILABILITY_BOUNDARY`, renders “Unavailable — no peer currently serves the required ranges,” disables immediate replay until retry/new evidence, and sends no HTTP media request.
7. Continue Watching survives restart and remains absent from network, publisher, relay, and analytics traces.
8. Balanced mode uploads useful bytes within hard policy limits and suspends on metered/background/thermal constraints.
9. The relay archives and seeds public and protected ciphertext without publisher, moderation, or entitlement authority.
10. Protected playback requires provider auth/license, succeeds through peer-delivered ciphertext, and stops after license expiry while the relay continues seeding.
11. Public playback remains functional after provider sign-out.
12. Developer Settings contains Studio and technical controls; normal mobile and desktop navigation do not.
13. No PearTube analytics endpoint, playback beacon, CDN-savings report, or remote recommendation request is observed.
14. Restart every process against the same storage; catalog, local watch state, policies, archive reservations, and availability expiry recover without stale Healthy claims.

**Verification:**

```bash
npm run schema:full
npm test
npm run typecheck
npm run test:adversarial --prefix packages/backend
node --test packages/app/tests/*.test.mjs
npm run desktop:smoke --prefix packages/app
npm run desktop:build --prefix packages/app
JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home npm run android --prefix packages/app
npm run build:ios:device --prefix packages/app
```

Run the public slice in Electrobun and on physical Android and iOS. Run protected Widevine on physical Android and FairPlay on physical iOS. Probe Electrobun with a real encrypted fixture; run protected desktop acceptance only if a usable CDM/EME path exists, otherwise verify the explicit `DRM_UNSUPPORTED` UI. Capture transport traces proving zero HTTP media fallback and zero analytics traffic. A green component suite without these observed scenarios does not pass the applicable gate.

Commit:

```bash
git add packages/backend/test/fixtures/consumer-strict-p2p-smoke.mjs packages/backend/test/fixtures/http-trap.mjs packages/app/tests/consumer-vertical-slice-regression.test.mjs docs/superpowers/progress/2026-07-24-permissionless-media-cdn-progress.md
git commit -m "test(product): prove strict P2P consumer vertical slice"
```

---

## Release Criteria

The revised direction is complete only when all statements below are observed:

- Normal users encounter a streaming library, not a P2P operations console.
- One moderated global catalog works anonymously and remains permissionless underneath.
- Movies and series merge across publishers without hiding source provenance in advanced views.
- Play is automatic, bounded, explainable, strict P2P, and honest about failure.
- Availability states are evidence-backed and expire; metadata is never treated as availability.
- Balanced participation contributes without violating device or user policy.
- Watch state and recommendations remain local unless the user explicitly pairs devices.
- PearTube emits no viewer analytics and makes no CDN-savings claim it cannot measure.
- Volunteer relays improve discovery and durability without gaining authority.
- Protected content uses opaque encrypted media plus platform DRM; no custom JavaScript key handling is shipped as production DRM.
- Provider authentication/license services never become media origins and receive no PearTube playback telemetry.
- Public and protected playback, failover, restart, privacy, and no-origin assertions pass on the supported physical platforms.
