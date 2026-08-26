# Generic Client PearTube Candidate Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PearTube a first-class URL-less service that participates in a client application's normal ranking and resolves only after that client selects it.

**Architecture:** Replace the v1 full-catalog scan with exact `/api/v2/search`. Search maps factual `CompanionCandidateV2` data into `NZBResult` with `ServiceTypePearTube` and an opaque candidate reference, leaving `Link`, `DownloadURL`, `stream_url`, and `preresolved` empty. The playback service dispatches the chosen PearTube result to `/api/v2/streams/open`.

**Tech Stack:** Go, a client application's result model, existing provider aggregation/ranking, authenticated companion client, standard `net/http`.

## Global Constraints

- This plan originally covered a separate client repository as well as PearTube fixtures.
- Depends on Plan 08 API contracts.
- The client application retains cross-provider filtering, ranking, and final selection.
- PearTube verification/probing occurs only after selection.
- No fallback path may reinterpret a PearTube result as `ServiceTypeDebrid`.
- Existing non-PearTube playback behavior must remain byte-for-byte compatible at the API boundary.

---

### Task 1: Replace the v1 client/search contract

**Files:**
- Modify: `/Users/jd/projects/client-backend/backend/models/indexer.go`
- Modify: `/Users/jd/projects/client-backend/backend/services/peartube/client.go`
- Modify: `/Users/jd/projects/client-backend/backend/services/peartube/search.go`
- Modify: `/Users/jd/projects/client-backend/backend/services/debrid/scraper_peartube.go`
- Test: `/Users/jd/projects/client-backend/backend/services/peartube/peartube_test.go`
- Test: `/Users/jd/projects/client-backend/backend/services/debrid/scraper_peartube_test.go`

**Interfaces:**
- Adds `models.ServiceTypePearTube ContentServiceType = "peartube"`.
- Produces `Client.Search(ctx, SearchRequest) ([]CompanionCandidateV2, error)` over `/api/v2/search`.
- Maps `attributes["peartube_candidate_ref"]` and factual rendition/availability attributes.

- [ ] **Step 1: Write failing URL-less result tests**

```go
if got.ServiceType != models.ServiceTypePearTube { t.Fatalf("service type = %q", got.ServiceType) }
if got.Link != "" || got.DownloadURL != "" { t.Fatal("search minted a playback URL") }
if got.Attributes["peartube_candidate_ref"] == "" { t.Fatal("missing deferred candidate reference") }
if got.Attributes["preresolved"] != "" { t.Fatal("PearTube was routed through debrid") }
```

Also assert exact episode fields reach the HTTP query instead of being reconstructed from release text.

- [ ] **Step 2: Run the focused Go tests**

Run: `cd /Users/jd/projects/client-backend/backend && go test ./services/peartube ./services/debrid -run 'PearTube|Search'`

Expected: FAIL because current code emits v1 direct URLs with `ServiceTypeDebrid`.

- [ ] **Step 3: Implement v2 client auth and mapping**

Add a bounded candidate DTO, exact selector query encoding, control MAC headers matching Plan 08, and deterministic mapping. Delete v1 catalog scanning, `StreamURL()` search use, open-access sentinel logic, and catalog cache behavior that no longer applies.

- [ ] **Step 4: Run focused search tests**

Expected: PASS for movie, episode, fallback title, multiple candidates, empty companion, timeout, and malformed candidate.

- [ ] **Step 5: Commit**

```bash
cd /Users/jd/projects/client-backend && git add backend/models/indexer.go backend/services/peartube/client.go backend/services/peartube/search.go backend/services/debrid/scraper_peartube.go backend/services/peartube/peartube_test.go backend/services/debrid/scraper_peartube_test.go && git commit -m "feat(peartube): return deferred companion candidates"
```

### Task 2: Add deferred playback resolution

**Files:**
- Modify: `/Users/jd/projects/client-backend/backend/services/playback/service.go`
- Create: `/Users/jd/projects/client-backend/backend/services/peartube/resolver.go`
- Modify: `/Users/jd/projects/client-backend/backend/main.go`
- Test: `/Users/jd/projects/client-backend/backend/services/playback/service_test.go`
- Test: `/Users/jd/projects/client-backend/backend/services/debrid/playback_resolve_test.go`

**Interfaces:**
- Produces `peartube.Resolver.Open(ctx, candidateRef) (*models.PlaybackResolution, error)`.
- `Service.Resolve()` dispatches `ServiceTypePearTube` before the debrid branch and never passes it to torrent preflight or debrid health checks.

- [ ] **Step 1: Write a failing dispatch test**

```go
resolution, err := service.Resolve(ctx, models.NZBResult{
  ServiceType: models.ServiceTypePearTube,
  Attributes: map[string]string{"peartube_candidate_ref": "candidate-1"},
})
if err != nil { t.Fatal(err) }
if resolver.OpenCalls() != 1 || debrid.ResolveCalls() != 0 { t.Fatal("wrong resolver dispatch") }
```

- [ ] **Step 2: Implement `POST /api/v2/streams/open`**

Send only `candidateRef`, authenticate the call, require a route-scoped URL owned by the configured companion, map structured `candidate-expired`, `source-not-current`, `unavailable`, and `unsupported` errors, and return the normal client application playback resolution shape.

- [ ] **Step 3: Protect non-PearTube paths**

Run existing debrid/usenet resolver tests and assert PearTube candidates are skipped by debrid batch resolution, torrent preflight, cache health, and magnet parsing.

- [ ] **Step 4: Verify both repositories' fixtures**

Run: `cd /Users/jd/projects/client-backend/backend && go test ./services/peartube ./services/debrid ./services/playback`

Run: `cd packages/cli && npx brittle test/companion-v2-contract.test.mjs`

Expected: URL-less search, deferred open, and every existing non-PearTube resolver test pass.

- [ ] **Step 5: Commit in each repository**

```bash
cd /Users/jd/projects/client-backend && git add backend/models backend/services/peartube backend/services/debrid backend/services/playback backend/main.go && git commit -m "feat(peartube): resolve selected candidates after ranking"
cd /Users/jd/projects/peartube && git add packages/cli/test/companion-v2-contract.test.mjs && git commit -m "test(cli): share client application v2 candidate fixtures"
```