# PearTube CI Workflow Cleanup Design

Date: 2026-04-23
Status: Proposed
Owner: Codex + user

## Summary

PearTube's current GitHub Actions setup covers important surfaces, but it is uneven:

- Android build and release logic are duplicated across separate workflows.
- Relay jobs repeat the same setup and build steps.
- The repo has no clear split between cheap always-on CI and expensive artifact coverage.
- iOS, Electrobun desktop, and native desktop are not covered as first-class CI/release surfaces.

This design restructures CI around four tiers:

1. `fast-ci` for cheap signal on every PR and push to `main`
2. path-aware build coverage for mobile, desktop, and relay on PRs
3. full non-publishing artifact coverage on `main`, nightly, and manual runs
4. release-only publish workflows on tags and explicit manual dispatch

The goal is to widen build and release coverage without making frequent pushes fan out into every expensive platform build.

## Problem Statement

The current workflow inventory is:

- `/Users/jd/projects/peartube/.github/workflows/test.yml`
- `/Users/jd/projects/peartube/.github/workflows/android-build.yml`
- `/Users/jd/projects/peartube/.github/workflows/android-release.yml`
- `/Users/jd/projects/peartube/.github/workflows/relay.yml`
- `/Users/jd/projects/peartube/.github/workflows/bare-mpv-prebuilds.yml`

Observed issues:

1. Android setup is duplicated between build and release workflows, including submodule validation, Node setup, Java setup, SDK setup, dependency install, and mobile backend preparation.
2. Relay jobs repeat dependency install and standalone build preparation across test, build, and publish jobs.
3. `test.yml` is always-on but only covers backend tests, platform typecheck, and lint. That is good for speed, but it is disconnected from broader build confidence.
4. There is no explicit CI contract for:
   - iOS build coverage
   - Electrobun desktop build coverage
   - native desktop build/test coverage
   - tag/manual release flows for all app surfaces
5. The current workflow naming does not make it obvious which jobs are cheap validation versus which are artifact/release jobs.
6. Frequent pushes are likely to become too expensive if broader coverage is added without a trigger model that limits when heavy jobs run.

## Goals

- Preserve a fast, cheap CI path for frequent pushes and PR updates.
- Add first-class build coverage for:
  - Android
  - iOS
  - Electrobun desktop
  - native desktop
  - relay
- Keep release publishing isolated from ordinary CI.
- Remove obvious duplicated setup logic from workflows.
- Make workflow triggers understandable from file names and event definitions.
- Upload useful artifacts on coverage runs even when publish credentials are unavailable.
- Standardize concurrency, permissions, and artifact retention where practical.

## Non-Goals

- Replacing GitHub Actions with another CI platform.
- Converting the repo to a different package manager workflow.
- Introducing a fully abstract reusable-workflow architecture with deep `workflow_call` indirection.
- Solving Apple notarization, App Store submission, or EAS Store submission end-to-end if those credentials and scripts do not already exist.
- Reworking app/package build scripts unless a workflow needs a small supporting helper.

## Constraints

- The user pushes frequently, so always-on CI must stay cheap.
- Release/build coverage should exist for all app surfaces, but most of it should not run on every PR update.
- Existing repo scripts should remain the source of truth for platform builds whenever possible.
- Android release signing may be available through repository secrets.
- iOS and macOS release signing may or may not be available in CI at implementation time.
- Some existing tests assert CI-specific behavior, notably:
  - `/Users/jd/projects/peartube/packages/app/tests/android-apk-build-pipeline-regression.test.mjs`

## Decision Summary

Adopt a coverage-first CI structure with separate cheap CI, build-coverage, and release-publish workflows. Keep release workflows platform-specific. Extract repeated setup into small local composite actions or shell helpers under `.github/`.

The resulting workflow families will be:

- `ci-fast.yml`
- `build-mobile.yml`
- `build-desktop.yml`
- `build-relay.yml`
- `release-android.yml`
- `release-ios.yml`
- `release-desktop.yml`
- `release-relay.yml`

`bare-mpv-prebuilds.yml` remains separate because it serves a specialized maintenance function rather than general app CI.

## Why This Structure

This design deliberately separates three kinds of signal:

- "Is the repo obviously broken?" -> `ci-fast`
- "Can the changed surface still build?" -> path-aware build workflows
- "Can we ship or archive platform artifacts?" -> release workflows

That prevents the repo from paying desktop + iOS + Android + relay build cost on every push while still ensuring that:

- PRs validate the surfaces they touch
- `main` regularly proves broad build coverage
- releases stay explicit and easier to reason about

Within the build workflows themselves, expensive archive-oriented jobs should be gated so that PR runs stay focused on validation while `main`, nightly, and manual runs produce the broader artifact set.

## Trigger Model

### Tier 1: Fast CI

Run on:

- every PR to `main`
- every push to `main`

Purpose:

- give fast feedback on high-signal, low-cost checks

Jobs:

- lint
- backend tests
- platform typecheck
- lightweight CI/workflow regression tests

This workflow should finish quickly and should use `concurrency.cancel-in-progress: true`.

### Tier 2: Path-Aware Build Coverage

Run on:

- PRs to `main`, but only when the relevant surface changes
- manual dispatch

Purpose:

- validate buildability of the surfaces actually touched by a PR

Behavior:

- mobile workflow runs only for mobile-relevant changes
- desktop workflow runs only for desktop-relevant changes
- relay workflow runs only for relay-relevant changes

These workflows should also use `concurrency.cancel-in-progress: true` for PRs.

### Tier 3: Full Artifact Coverage

Run on:

- pushes to `main`
- scheduled nightly runs
- manual dispatch

Purpose:

- confirm the repo can build all major surfaces
- produce artifacts without publishing them

This is the broad-coverage safety net that compensates for path-filtered PR builds.

### Tier 4: Release Publish

Run on:

- version tags
- manual dispatch with explicit release inputs

Purpose:

- publish signed or distributable artifacts only when explicitly releasing

These workflows should not share `cancel-in-progress` behavior with PR CI.

## Workflow Topology

### `ci-fast.yml`

Responsibilities:

- replace `test.yml`
- remain the default always-on CI lane

Jobs:

- `lint`
- `backend-test`
- `platform-typecheck`
- `workflow-regressions`

Notes:

- Keep this workflow Linux-only.
- Keep it lightweight enough for frequent pushes.
- Move CI-specific regression tests here, including checks that workflows still prepare mobile backend artifacts before Android packaging.

### `build-mobile.yml`

Responsibilities:

- own non-publishing mobile build coverage

PR trigger paths should include:

- `packages/app/**`
- `packages/backend/**`
- `packages/core/**`
- `packages/platform/**`
- `packages/spec/**`
- `packages/host/**`
- `packages/bare-ffmpeg/**`
- `packages/bare-mpv/**`
- `.github/workflows/build-mobile.yml`
- local shared CI action/script paths used by this workflow

Jobs:

- `android-debug`
  - Linux
  - validate submodules
  - install deps
  - `npm run prepare:mobile-backend`
  - `npm run android:prebuild`
  - `./gradlew assembleDebug`
  - upload debug APK artifacts
- `android-release-artifacts`
  - Linux
  - build release APKs or AABs for coverage
  - upload artifacts
  - no publish
- `ios-build`
  - macOS
  - install deps
  - `npm run prepare:mobile-backend`
  - `npm run ios:prepare`
  - `npx pod-install`
  - run an iOS build command suitable for CI validation
  - upload derived artifact output when practical

Notes:

- On PRs, the workflow should run only when mobile-related paths change.
- On `main`, nightly, and manual dispatch, it should run regardless of path filtering.
- `android-debug` and `ios-build` are the default PR validation jobs.
- `android-release-artifacts` should be gated to `main`, nightly, and manual full-coverage runs unless later measurement shows the extra PR cost is acceptable.
- If iOS signing/export secrets are absent, the workflow should still perform unsigned build coverage rather than silently skipping the lane.

### `build-desktop.yml`

Responsibilities:

- own non-publishing desktop build coverage for both desktop stacks

PR trigger paths should include:

- `packages/app/**`
- `packages/desktop-native/**`
- `packages/backend/**`
- `packages/core/**`
- `packages/platform/**`
- `packages/spec/**`
- `packages/host/**`
- `packages/protocol/**`
- `packages/bare-mpv/**`
- `.github/workflows/build-desktop.yml`
- local shared CI action/script paths used by this workflow

Jobs:

- `electrobun-desktop-build`
  - macOS
  - install deps
  - run `npm run desktop:build --prefix packages/app`
  - run `npm run desktop:ebuild --prefix packages/app`
  - archive the resulting `.app` bundle as an artifact
- `native-desktop-test`
  - macOS
  - install deps
  - run `npm run desktop:native:test`
- `native-desktop-archive`
  - macOS
  - install deps
  - run a Release archive build for `packages/desktop-native`
  - upload archive/app artifacts

Notes:

- `native-desktop-test` is the main correctness lane.
- `electrobun-desktop-build` and `native-desktop-test` are the default PR validation jobs.
- `native-desktop-archive` should be gated to `main`, nightly, and manual full-coverage runs so PR validation stays cheaper.
- `native-desktop-archive` proves the Release configuration can be produced even before a publishing flow is enabled.

### `build-relay.yml`

Responsibilities:

- split relay validation from release publishing

PR trigger paths should include:

- `packages/cli/**`
- `packages/backend/**`
- `packages/bare-ffmpeg/**`
- `packages/spec/**`
- `.dockerignore`
- `packages/cli/Dockerfile`
- `.github/workflows/build-relay.yml`
- local shared CI action/script paths used by this workflow

Jobs:

- `relay-test`
  - install backend + relay deps
  - run relay tests
  - run owner metadata regression
- `relay-standalone`
  - build linux x64 and arm64 standalone outputs
  - upload them as artifacts
- `relay-docker-build`
  - build the image without push

Notes:

- This replaces the current mixed validation/publish behavior in `relay.yml`.
- `relay-test` and `relay-docker-build` are the default PR validation jobs.
- `relay-standalone` should be gated to `main`, nightly, and manual full-coverage runs unless it turns out to be cheap enough to keep on PRs.

### `release-android.yml`

Responsibilities:

- replace `android-release.yml`
- build and publish Android release artifacts only on tag/manual release flows

Behavior:

- keep the current ABI matrix
- keep keystore validation/signing behavior
- upload artifacts even before publish
- create GitHub release attachments on version tags

### `release-ios.yml`

Responsibilities:

- create an explicit release workflow for iOS

Behavior:

- manual/tag only
- if Apple signing/export credentials are configured, produce exportable release artifacts
- if those credentials are missing, fail early with a clear message for publish mode

Notes:

- This workflow is publish-oriented. Build-only coverage remains in `build-mobile.yml`.

### `release-desktop.yml`

Responsibilities:

- create release-time packaging for desktop surfaces

Behavior:

- manual/tag only
- build Electrobun desktop release artifacts
- build native desktop Release archive/app artifacts
- publish whichever release artifacts are actually supported by existing repo scripts and credentials

Notes:

- If notarization or signing is not yet automated, this workflow can initially publish unsigned archive artifacts and document that limit explicitly.
- The important cleanup is separating "desktop release artifact production exists" from "desktop release is fully notarized."

### `release-relay.yml`

Responsibilities:

- publish relay container and any standalone release artifacts

Behavior:

- manual/tag only
- keep GHCR publishing here, not in the build workflow

## Shared CI Building Blocks

Create small local composite actions or script helpers for repeated setup:

- `.github/actions/setup-node-workspace`
  - checkout assumptions stay in workflow
  - setup Node version
  - optionally install workspace dependencies with the repo-approved install flow
- `.github/actions/prepare-mobile-backend`
  - run `npm run prepare:mobile-backend`
- `.github/actions/validate-submodules`
  - validate expected submodule paths and URLs
  - init/sync required submodules

Guidelines:

- Keep these helpers thin and repo-specific.
- Do not hide full build logic inside actions.
- Use them only for setup that is currently duplicated across workflows.

## Path Ownership

The intent is to keep PR builds targeted, not perfect.

### Mobile ownership

Includes:

- app/mobile UI and native projects
- backend/spec/platform/core changes that affect mobile packaging
- mobile-related native dependencies and build helpers

### Desktop ownership

Includes:

- Electrobun desktop app
- native desktop app
- shared packages consumed by those desktop surfaces

### Relay ownership

Includes:

- CLI relay sources
- backend changes that affect relay runtime
- Docker packaging paths

On pushes to `main`, nightly, and manual dispatch, these ownership filters are bypassed in favor of broad coverage.

## Secrets and Publish Fallbacks

Differentiate between build coverage and publish requirements.

### Coverage workflows

- should not require release secrets
- should build unsigned or non-exported artifacts when possible
- should upload artifacts for inspection and debugging

### Release workflows

- should validate required secrets up front
- should fail clearly when publish-mode credentials are missing
- should not silently downgrade a publish request into a partial non-release build

This keeps CI honest while still allowing broad build validation.

## Concurrency, Permissions, and Retention

### Concurrency

For `ci-fast.yml`, `build-mobile.yml`, `build-desktop.yml`, and `build-relay.yml`:

- use workflow-level concurrency keyed by workflow name plus PR number or ref
- set `cancel-in-progress: true`

For release workflows:

- avoid aggressive cancellation

### Permissions

Default to minimum permissions.

- `contents: read` for ordinary build/test workflows
- `contents: write` only where GitHub Releases are created
- `packages: write` only for container publish workflows

### Artifact retention

Use a consistent baseline:

- short retention for PR artifacts
- longer retention for `main`/nightly/manual build artifacts
- release artifacts handled by GitHub Releases or published packages

## Caching Strategy

Keep caching conservative in the initial cleanup.

- Continue using Gradle caching through `actions/setup-java` where already supported.
- Avoid introducing aggressive npm caching until the monorepo install flow is normalized for that use case.
- Add CocoaPods or Xcode derived-data caching only if the implementation remains simple and reliable.

The main win for frequent pushes should come from trigger control and deduplication, not from complex cache tuning.

## Migration Plan

1. Add shared local CI helpers under `.github/actions/` or `.github/scripts/`.
2. Replace `test.yml` with `ci-fast.yml`.
3. Split current Android workflow logic into:
   - `build-mobile.yml`
   - `release-android.yml`
4. Split current relay workflow logic into:
   - `build-relay.yml`
   - `release-relay.yml`
5. Add `build-desktop.yml` for Electrobun desktop and native desktop coverage.
6. Add `release-ios.yml` and `release-desktop.yml` with the clearest supported release behavior available in the repo today.
7. Remove superseded workflows after the new set is green.
8. Update CI regression tests to match the new workflow names and responsibilities.

## Testing and Verification

Implementation should verify:

- workflow YAML parses cleanly
- path filters align with intended surface ownership
- Android build coverage still runs `npm run prepare:mobile-backend` before packaging
- relay build workflow still covers standalone artifacts and Docker build
- iOS and desktop coverage workflows produce actual build outputs on macOS runners
- release workflows fail clearly when required publish secrets are missing

Repo-level regression coverage should include at least:

- updated assertions for Android workflow preparation behavior
- assertions that publish logic is isolated from build-only workflows

## Rejected Alternatives

### 1. Keep the current workflows and only dedupe Android steps

Rejected because it does not solve the missing release/build coverage for iOS and desktop, and it leaves the repo without a clear CI trigger model.

### 2. Run all platform builds on every PR update

Rejected because it conflicts with the user's frequent-push workflow and would make CI too expensive and noisy.

### 3. Move everything to `workflow_call` reusable workflows immediately

Rejected for now because it adds indirection before the repo has a stable workflow split. Small local composite actions give most of the dedupe benefit with less debugging overhead.

## Open Implementation Notes

- The current repo already has build entrypoints for:
  - Android in `packages/app/package.json`
  - Electrobun desktop in `packages/app/package.json`
  - native desktop in `packages/desktop-native/package.json`
  - relay in `packages/cli/package.json`
- iOS release publishing details may require the most iteration because CI-safe build coverage and release/export behavior are separate concerns.
- `bare-mpv-prebuilds.yml` should stay isolated unless future maintenance work justifies a separate cleanup.

## Final Recommendation

Implement the coverage-first restructure with:

- one cheap always-on CI workflow
- three non-publishing build workflows split by surface
- four explicit release workflows
- thin local shared setup helpers

That gives PearTube broader release/build coverage across all app surfaces while keeping frequent pushes from triggering every expensive platform build.
