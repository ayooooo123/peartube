# Consent, Retention, and Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make watch-only the safe default, trigger contribution only after explicit consent and meaningful watch intent, and keep contribution-cache and archive retention independent.

**Architecture:** Effective policy is computed from versioned persisted settings. Missing or ambiguous legacy `AutoSeed` migrates to contribution-disabled plus `migration-required`; only a persisted explicit true may retain contribution consent. Playback observations feed a threshold state machine, which submits an out-of-band job only after qualification and never alters active playback.

**Tech Stack:** MediaStorm Go settings/migrations/playback events, PearTube resource policy and CLI status, Brittle, Go tests.

## Global Constraints

- Depends on Plan 11 job API.
- Before contribution consent: no publisher creation, catalog operation, claim, locator, asset announcement, or asset upload.
- A private bounded playback byte cache is allowed in watch-only mode but is not announced.
- `contribution-cache` is evictable; `archive-pin` is separately opted in and never selected automatically.
- Abandoned plays before threshold create no ingest job.
- MediaStorm remains functional when status or job submission fails.

---

### Task 1: Migrate MediaStorm settings to explicit consent

**Files:**
- Modify: `/Users/jd/projects/mediastorm-backend/backend/config/settings.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/config/migrations.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/services/peartube/config.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/handlers/admin_ui.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/handlers/admin_templates/settings.html`
- Test: `/Users/jd/projects/mediastorm-backend/backend/config/migrations_test.go`
- Test: `/Users/jd/projects/mediastorm-backend/backend/services/peartube/config_test.go`
- Test: `/Users/jd/projects/mediastorm-backend/backend/handlers/peartube_settings_test.go`

**Interfaces:**
- Replaces implicit `AutoSeed` with versioned settings `ContributeWatchedMedia`, `ContributionBudget`, `ArchiveEnabled`, and `ArchiveBudget`.
- Produces effective status `watch-only | contributor | archive-enabled | migration-required`.

- [ ] **Step 1: Write the migration truth table as failing tests**

```go
cases := []struct{
  name string
  legacy *bool
  persisted bool
  wantContribute bool
  wantMigration bool
}{
  {"missing", nil, false, false, true},
  {"implicit environment default", nil, false, false, true},
  {"persisted false", boolPtr(false), true, false, false},
  {"persisted true", boolPtr(true), true, true, false},
}
```

Assert archive remains false in every migrated case until separately enabled.

- [ ] **Step 2: Implement one-way migration and UI copy**

Persist a settings schema version, remove “defaults on whenever relay configured,” show explicit contribution and archive controls with separate budgets, and report `migration-required` until the user saves a choice.

- [ ] **Step 3: Run settings tests**

Run: `cd /Users/jd/projects/mediastorm-backend/backend && go test ./config ./services/peartube ./handlers -run 'PearTube|Migration|AutoSeed|Contribute'`

Expected: missing/ambiguous installs are watch-only; explicit persisted true remains contributor; archive is never inferred.

- [ ] **Step 4: Commit**

```bash
cd /Users/jd/projects/mediastorm-backend && git add backend/config/settings.go backend/config/migrations.go backend/services/peartube/config.go backend/handlers/admin_ui.go backend/handlers/admin_templates/settings.html backend/config/migrations_test.go backend/services/peartube/config_test.go backend/handlers/peartube_settings_test.go && git commit -m "fix(peartube): migrate to explicit contribution consent"
```

### Task 2: Gate jobs on meaningful watch intent and enforce backend role policy

**Files:**
- Modify: `/Users/jd/projects/mediastorm-backend/backend/services/peartube/autoseed.go`
- Modify: `/Users/jd/projects/mediastorm-backend/backend/handlers/peartube.go`
- Modify: `packages/backend/src/playback/resource-policy.js`
- Modify: `packages/backend/src/seeding.js`
- Modify: `packages/backend/src/api/policy.js`
- Modify: `packages/cli/src/status.js`
- Test: `/Users/jd/projects/mediastorm-backend/backend/services/peartube/autoseed_test.go`
- Test: `packages/backend/test/playback-resource-policy.test.mjs`
- Test: `packages/backend/test/network-policy-runtime.test.mjs`
- Test: `packages/cli/test/status.test.mjs`

**Interfaces:**
- Produces `observePlayback(event) -> unqualified | qualified | cancelled` keyed by stable playback identity.
- Produces backend effective roles `watch-only`, `contributor`, and `archive-enabled` with distinct byte/storage/upload budgets.

- [ ] **Step 1: Write failing threshold and zero-upload tests**

```go
tracker.Observe(PlaybackEvent{ID: "p1", PositionMs: 10000, DurationMs: 7200000})
if tracker.Qualified("p1") { t.Fatal("qualified too early") }
tracker.Observe(PlaybackEvent{ID: "p1", PositionMs: configuredThreshold, DurationMs: 7200000})
if !tracker.Qualified("p1") { t.Fatal("meaningful watch did not qualify") }
```

In backend tests, assert watch-only never calls asset-scope `join`, `announce`, `upload`, or publisher creation after playback.

- [ ] **Step 2: Implement threshold lifecycle**

Use configured elapsed-time and/or watched-fraction evidence, deduplicate one job per playback/source identity, cancel active acquisition when a qualified playback is explicitly abandoned, and do nothing for background progress noise before qualification.

- [ ] **Step 3: Enforce role policy at source**

Guard asset announcements, upload serving, publisher creation, locator publication, contribution-cache retention, and archive allocator entry in backend policy APIs. Do not rely only on UI/MediaStorm gating.

- [ ] **Step 4: Expand status without secrets**

Report effective mode, migration state, consent versions, configured/used budgets, active announcements/uploads, jobs by state, selected indexers, and last bounded errors. Never return control keys, capability values, or callback URLs.

- [ ] **Step 5: Run cross-repository consent proof**

Run: `cd /Users/jd/projects/mediastorm-backend/backend && go test ./services/peartube ./handlers`

Run: `cd packages/backend && npx brittle test/playback-resource-policy.test.mjs test/network-policy-runtime.test.mjs test/policy-api.test.mjs`

Run: `cd packages/cli && npx brittle test/status.test.mjs test/status-universal.test.mjs`

Expected: watch-only creates no public state and uploads zero bytes; explicit contribution qualifies once; archive stays separate.

- [ ] **Step 6: Commit in each repository**

```bash
cd /Users/jd/projects/mediastorm-backend && git add backend/config backend/services/peartube backend/handlers && git commit -m "fix(peartube): require explicit contribution consent"
cd /Users/jd/projects/peartube && git add packages/backend/src packages/backend/test packages/cli/src/status.js packages/cli/test && git commit -m "feat(policy): enforce watch-only and separate retention budgets"
```