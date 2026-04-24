# CI Workflows Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure PearTube CI into cheap always-on validation, path-aware build coverage, and explicit per-surface release workflows without making frequent pushes rebuild every platform.

**Architecture:** Replace the current `test.yml`, `android-build.yml`, `android-release.yml`, and `relay.yml` split with a surface-oriented workflow set: `ci-fast`, `build-mobile`, `build-desktop`, `build-relay`, and isolated release workflows for Android, iOS, desktop, and relay. Extract duplicated Android/mobile setup into thin local composite actions under `.github/actions`, keep publish logic out of build-only workflows, and update the repo’s CI regression tests to assert the new contract.

**Tech Stack:** GitHub Actions YAML, local composite actions, Node.js test runner, Android Gradle, Expo/iOS/macOS build scripts

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `.github/actions/setup-node-workspace/action.yml` | Shared Node setup + repo install helper for CI workflows |
| **Create** | `.github/actions/prepare-mobile-backend/action.yml` | Shared `npm run prepare:mobile-backend` helper for mobile workflows |
| **Create** | `.github/actions/validate-submodules/action.yml` | Shared git submodule validation/init helper for Android workflows |
| **Create** | `.github/workflows/ci-fast.yml` | Cheap always-on CI replacing `test.yml` |
| **Create** | `.github/workflows/build-mobile.yml` | Non-publishing Android/iOS build coverage |
| **Create** | `.github/workflows/build-desktop.yml` | Non-publishing Electrobun + native desktop build coverage |
| **Create** | `.github/workflows/build-relay.yml` | Non-publishing relay tests/build coverage |
| **Create** | `.github/workflows/release-android.yml` | Android tag/manual release workflow |
| **Create** | `.github/workflows/release-ios.yml` | iOS tag/manual release workflow |
| **Create** | `.github/workflows/release-desktop.yml` | Desktop tag/manual release workflow |
| **Create** | `.github/workflows/release-relay.yml` | Relay tag/manual publish workflow |
| **Modify** | `packages/app/tests/android-apk-build-pipeline-regression.test.mjs` | Assert new Android workflow names still prepare the mobile backend correctly |
| **Modify** | `packages/app/tests/ci-lockfile-install-regression.test.mjs` | Assert `ci-fast.yml` keeps the safe install behavior |
| **Create** | `packages/app/tests/ci-workflow-split-regression.test.mjs` | Assert build-only workflows stay separate from publish workflows |
| **Delete** | `.github/workflows/test.yml` | Superseded by `ci-fast.yml` |
| **Delete** | `.github/workflows/android-build.yml` | Superseded by `build-mobile.yml` |
| **Delete** | `.github/workflows/android-release.yml` | Superseded by `release-android.yml` |
| **Delete** | `.github/workflows/relay.yml` | Superseded by `build-relay.yml` + `release-relay.yml` |

---

## Chunk 1: Shared CI Building Blocks

### Task 1: Add shared Node workspace setup action

**Files:**
- Create: `.github/actions/setup-node-workspace/action.yml`

- [ ] **Step 1: Write the failing regression test expectation mentally and scope the action**

This action must stay thin: set up Node and optionally run the repo’s `npm run install:all` flow without switching CI to root `npm ci` or npm cache behavior.

- [ ] **Step 2: Create `.github/actions/setup-node-workspace/action.yml`**

Include:
- `node-version` input with a repo-default value
- `install` boolean input
- `actions/setup-node@v4`
- optional `npm run install:all`

- [ ] **Step 3: Sanity-check the action structure**

Run: `sed -n '1,220p' .github/actions/setup-node-workspace/action.yml`
Expected: composite action with no root `npm ci` and no `cache: 'npm'`

---

### Task 2: Add shared mobile backend preparation action

**Files:**
- Create: `.github/actions/prepare-mobile-backend/action.yml`

- [ ] **Step 1: Create the action**

Wrap only:
- `npm run prepare:mobile-backend`

This action exists so Android/iOS workflows share one preparation step without hiding the build logic.

- [ ] **Step 2: Sanity-check the action**

Run: `sed -n '1,200p' .github/actions/prepare-mobile-backend/action.yml`
Expected: composite action invoking only the mobile backend preparation command

---

### Task 3: Add shared Android submodule validation action

**Files:**
- Create: `.github/actions/validate-submodules/action.yml`

- [ ] **Step 1: Create the action**

Move the current Android workflow’s submodule validation/init bash into a reusable composite action.

- [ ] **Step 2: Verify expected URLs stay explicit**

Run: `rg -n 'bare-ffmpeg|bare-mpv|Unexpected submodule URL' .github/actions/validate-submodules/action.yml`
Expected: the action hard-codes the expected `packages/bare-ffmpeg` and `packages/bare-mpv` URLs and fails on drift

---

## Chunk 2: Replace Fast CI + Mobile/Relay Workflows

### Task 4: Replace `test.yml` with `ci-fast.yml`

**Files:**
- Create: `.github/workflows/ci-fast.yml`
- Delete: `.github/workflows/test.yml`

- [ ] **Step 1: Write the workflow**

Include:
- `pull_request` and `push` to `main`
- workflow-level concurrency with cancel-in-progress
- `lint`, `backend-test`, `platform-typecheck`, and `workflow-regressions` jobs
- Linux runners only
- shared Node setup action usage

- [ ] **Step 2: Make workflow regressions explicit**

Run the targeted Node tests from `packages/app/tests` instead of relying only on backend/package checks.

- [ ] **Step 3: Verify no unsafe install/cache behavior regresses**

Run: `node --test packages/app/tests/ci-lockfile-install-regression.test.mjs`
Expected: PASS

---

### Task 5: Replace Android workflows with `build-mobile.yml` and `release-android.yml`

**Files:**
- Create: `.github/workflows/build-mobile.yml`
- Create: `.github/workflows/release-android.yml`
- Delete: `.github/workflows/android-build.yml`
- Delete: `.github/workflows/android-release.yml`

- [ ] **Step 1: Write `build-mobile.yml`**

Include:
- path-filtered PR coverage
- `push` to `main`, nightly, and manual dispatch coverage
- shared submodule validation and mobile backend prepare actions
- `android-debug` PR-safe job
- heavier `android-release-artifacts` gated off PRs
- `ios-build` macOS validation job

- [ ] **Step 2: Write `release-android.yml`**

Carry forward:
- tag/manual triggers
- keystore validation
- ABI matrix build
- GitHub release upload behavior

Keep publish-only behavior out of `build-mobile.yml`.

- [ ] **Step 3: Verify the Android prep contract still holds**

Run: `node --test packages/app/tests/android-apk-build-pipeline-regression.test.mjs`
Expected: PASS with assertions now pointing at `build-mobile.yml` and `release-android.yml`

---

### Task 6: Split relay validation from relay publishing

**Files:**
- Create: `.github/workflows/build-relay.yml`
- Create: `.github/workflows/release-relay.yml`
- Delete: `.github/workflows/relay.yml`

- [ ] **Step 1: Write `build-relay.yml`**

Include:
- path-filtered PR trigger
- `relay-test`
- `relay-docker-build`
- `relay-standalone` gated to `main`, nightly, and manual full-coverage runs

- [ ] **Step 2: Write `release-relay.yml`**

Move GHCR publish logic here with tag/manual triggers and minimal publish permissions.

- [ ] **Step 3: Add a regression test for split responsibilities**

Create a focused test that asserts:
- build workflows do not contain publish steps
- release workflows own publish behavior

Run: `node --test packages/app/tests/ci-workflow-split-regression.test.mjs`
Expected: PASS

---

## Chunk 3: Add Desktop + iOS Release Workflows and Verify

### Task 7: Add `build-desktop.yml`

**Files:**
- Create: `.github/workflows/build-desktop.yml`

- [ ] **Step 1: Write the workflow**

Include:
- path-filtered PR trigger
- `push` to `main`, nightly, and manual full-coverage triggers
- `electrobun-desktop-build`
- `native-desktop-test`
- `native-desktop-archive` gated to non-PR full-coverage runs

- [ ] **Step 2: Keep workflow permissions minimal**

Use read-only permissions and upload artifacts only.

- [ ] **Step 3: Sanity-check YAML structure**

Run: `sed -n '1,260p' .github/workflows/build-desktop.yml`
Expected: PR-safe validation jobs plus gated archive job

---

### Task 8: Add `release-ios.yml`

**Files:**
- Create: `.github/workflows/release-ios.yml`

- [ ] **Step 1: Write the workflow**

Include:
- tag/manual triggers
- macOS runner
- early secret validation for publish mode
- clear failure when Apple release credentials are missing

- [ ] **Step 2: Make build-vs-publish distinction explicit**

Coverage behavior belongs in `build-mobile.yml`; this workflow should fail loudly if a publish request cannot be satisfied.

- [ ] **Step 3: Sanity-check the failure path wording**

Run: `rg -n 'missing|credentials|signing|publish' .github/workflows/release-ios.yml`
Expected: clear error text for missing release credentials

---

### Task 9: Add `release-desktop.yml`

**Files:**
- Create: `.github/workflows/release-desktop.yml`

- [ ] **Step 1: Write the workflow**

Include:
- tag/manual triggers
- Electrobun desktop release artifact job
- native desktop Release archive/app artifact job
- publish/release attachment behavior only to the extent current scripts support it

- [ ] **Step 2: Make the unsigned/notarization limit explicit if needed**

If the repo cannot notarize/sign in CI today, upload/publish the artifacts that do exist and document the limitation in workflow naming/comments rather than pretending release is fully automated.

- [ ] **Step 3: Sanity-check the workflow**

Run: `sed -n '1,260p' .github/workflows/release-desktop.yml`
Expected: release-only trigger and artifact-oriented jobs with no PR trigger

---

### Task 10: Update regression tests and final verification

**Files:**
- Modify: `packages/app/tests/ci-lockfile-install-regression.test.mjs`
- Modify: `packages/app/tests/android-apk-build-pipeline-regression.test.mjs`
- Create: `packages/app/tests/ci-workflow-split-regression.test.mjs`

- [ ] **Step 1: Update workflow path references**

Point existing tests at:
- `ci-fast.yml`
- `build-mobile.yml`
- `release-android.yml`
- `build-relay.yml`
- `release-relay.yml`

- [ ] **Step 2: Run the targeted regression suite**

Run:
```bash
node --test \
  packages/app/tests/ci-lockfile-install-regression.test.mjs \
  packages/app/tests/android-apk-build-pipeline-regression.test.mjs \
  packages/app/tests/ci-workflow-split-regression.test.mjs
```

Expected: all tests PASS

- [ ] **Step 3: Validate workflow YAML for basic parse errors**

Run one of:
- `ruby -e "require 'yaml'; Dir['.github/workflows/*.yml'].each { |f| YAML.load_file(f); puts f }"`
- or another local YAML parse check available in the environment

Expected: all workflow files parse successfully

- [ ] **Step 4: Review the git diff for accidental scope creep**

Run: `git diff -- .github/workflows .github/actions packages/app/tests`
Expected: only workflow split, shared setup helpers, and CI regression updates
