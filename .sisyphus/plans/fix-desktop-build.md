# Fix Desktop (Pear) Build — SSR Native Module Crash

## TL;DR

> **Quick Summary**: The Pear desktop build fails during `expo export --platform web` because native React Native modules crash when evaluated during static rendering (SSR in Node.js). The root cause is the `extraNodeModules['react-native']` entry in `metro.config.js` overriding Expo's `react-native` → `react-native-web` aliasing for the web platform, combined with top-level `configureReanimatedLogger()` import/call that triggers native module evaluation at module load time.
> 
> **Deliverables**:
> - Fix `metro.config.js` to not override web-platform aliasing
> - Guard top-level `configureReanimatedLogger` to not evaluate during SSR
> - Working `npm run pear:build` pipeline
> 
> **Estimated Effort**: Short (1-2 hours)
> **Parallel Execution**: NO - sequential (each fix depends on testing the previous)
> **Critical Path**: Task 1 → Task 2 (conditional) → Task 3

---

## Context

### Original Request
Desktop build (`npm run pear`) fails at the `pear:export` step with:
```
Invariant Violation: __fbBatchedBridgeConfig is not set, cannot invoke native modules
```

Stack trace:
```
NativeModules.js:187 → TurboModuleRegistry.js:15 → NativeReactNativeFeatureFlags.js:24
```

### Root Cause Analysis

**The crash chain:**
1. `app.json` has `"web": { "output": "static" }` — enables SSR for web export
2. `expo export --platform web` bundles the app for web, then evaluates it in **Node.js** to generate static HTML
3. `app/_layout.tsx` (root layout, always evaluated during SSR) has:
   ```typescript
   import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated'  // line 25
   configureReanimatedLogger({ level: ReanimatedLogLevel.warn, strict: false })  // line 26-29 — EXECUTES AT MODULE EVAL TIME
   ```
4. `react-native-reanimated` → `react-native-worklets` → `PlatformChecker.js` → `import { Platform } from 'react-native'`
5. During SSR, Metro SHOULD alias `react-native` → `react-native-web` (which has a safe `TurboModuleRegistry.get()` stub returning `null`)
6. **BUT** `metro.config.js:32` has `extraNodeModules['react-native']` pointing to the native `react-native` package — this overrides the aliasing during SSR module resolution
7. The native `react-native` tries to access `__fbBatchedBridgeConfig` in Node.js → **CRASH**

**Key insight**: Expo's `withMetroMultiPlatform.js` sets up `requestAlias` to remap `react-native` → `react-native-web` for web platform. But `extraNodeModules` provides a hard override in the Metro resolver context that can interfere during the static rendering bundling phase.

### Research Findings

| Finding | Source | Implication |
|---------|--------|-------------|
| `react-native-web/TurboModuleRegistry.js` returns `null` (safe) | `node_modules/react-native-web/src/vendor/.../TurboModuleRegistry.js` | If aliasing works, no crash |
| `extraNodeModules['react-native']` forces native package | `packages/app/metro.config.js:32` | Overrides Expo's web aliasing |
| `react-native-worklets/PlatformChecker.js` imports `Platform` from `react-native` | `node_modules/react-native-worklets/lib/module/PlatformChecker/PlatformChecker.js:3` | This is the actual import that crashes |
| `configureReanimatedLogger` executes at module eval time (top-level) | `packages/app/app/_layout.tsx:26-29` | Can't be avoided with runtime checks alone |
| Expo's `withMetroMultiPlatform.js:186` aliases `'react-native': 'react-native-web'` for web | `@expo/cli/build/src/start/server/metro/withMetroMultiPlatform.js` | Confirms aliasing exists but may be overridden |
| `react-native-gesture-handler` and `expo-screen-orientation` have web support | Package analysis | These are NOT the crash sources |

### Metis Review

**Identified Gaps (addressed):**
- **Risk of breaking native builds**: Removing `extraNodeModules['react-native']` could cause duplicate module instances on iOS/Android. Addressed by using `resolveRequest` instead.
- **Static import triggers evaluation**: Even wrapping the `configureReanimatedLogger()` *call* in a platform check won't help — the `import` statement itself triggers the entire `react-native-reanimated` module tree evaluation. Must use dynamic `require()`.
- **`react-native-worklets` at import time**: Its `init()` function runs at module load via `react-native-worklets/index.js:6`. If `react-native` resolves correctly to `react-native-web`, `SHOULD_BE_USE_WEB` will be `true` and native paths are skipped.

---

## Work Objectives

### Core Objective
Make `npm run pear:export` (and full `npm run pear:build`) succeed by ensuring native React Native modules don't crash during SSR.

### Concrete Deliverables
- Modified `packages/app/metro.config.js` — platform-aware `react-native` resolution
- Modified `packages/app/app/_layout.tsx` — guarded reanimated import (if needed after Task 1)
- Working Pear desktop build pipeline

### Definition of Done
- [ ] `npm run pear:export` exits with code 0
- [ ] `npm run pear:build` exits with code 0
- [ ] `pear/index.html` exists and contains `<script` tags
- [ ] No regression in iOS build capability

### Must Have
- `expo export --platform web` succeeds without `__fbBatchedBridgeConfig` error
- Native (iOS/Android) builds still work — no duplicate `react-native` instances
- All existing Pear desktop functionality preserved (no behavioral changes)

### Must NOT Have (Guardrails)
- DO NOT change `app.json` web output from `"static"` to `"single"` (workaround, not fix)
- DO NOT add polyfills/shims for `__fbBatchedBridgeConfig` (masks root cause)
- DO NOT create a separate `_layout.web.tsx` (maintenance burden, not needed)
- DO NOT refactor `_layout.tsx` beyond the minimal fix
- DO NOT touch `react-native-reanimated` imports in non-layout components (VideoPlayerOverlay, SeekBar, etc.) unless proven necessary
- DO NOT remove `extraNodeModules` entries for `react` or `react-native-nitro-modules`
- DO NOT upgrade any dependency versions

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: NO (no unit test framework configured for build tooling)
- **Automated tests**: NO (this is a build config fix, not application logic)
- **Framework**: N/A
- **Agent-Executed QA**: ALWAYS (mandatory for all tasks)

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| Metro config | Bash | Load config, check for errors |
| Web export | Bash | Run `pear:export`, check exit code and output |
| Full build | Bash | Run `pear:build`, check exit code and output files |
| Regression | Bash | Verify metro config loads for iOS platform |

---

## Execution Strategy

### Sequential Execution (Required)

```
Task 1: Fix metro.config.js (extraNodeModules)
    ↓ Test: Does pear:export succeed now?
    ↓
[If YES] → Task 3: Full build verification
[If NO]  → Task 2: Guard configureReanimatedLogger import
    ↓
Task 3: Full Pear build pipeline verification + regression check
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3 | None |
| 2 | 1 (only if 1 is insufficient) | 3 | None |
| 3 | 1 (or 1+2) | None | None (final) |

### Agent Dispatch Summary

| Step | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | Task 1 | task(category="quick", load_skills=["react-native-best-practices"]) |
| 2 | Task 2 (conditional) | task(category="quick", load_skills=["react-native-best-practices"]) |
| 3 | Task 3 | task(category="quick", load_skills=[]) |

---

## TODOs

- [ ] 1. Fix `metro.config.js` — Make `react-native` resolution web-aware

  **What to do**:
  Replace the static `extraNodeModules['react-native']` entry with a `resolveRequest` override that only redirects `react-native` to the local copy for **non-web** platforms, letting Expo's built-in aliasing work for web/SSR.

  **Approach A (Preferred — resolveRequest)**:
  Add a custom `resolveRequest` to `metro.config.js` that:
  - For platform `web` (or `undefined`/SSR): returns `null` (let Expo's aliasing handle it)
  - For platform `ios`/`android`: resolves `react-native` to `projectRoot/node_modules/react-native`

  ```javascript
  // In metro.config.js, REPLACE the extraNodeModules 'react-native' entry
  // with a resolveRequest that's platform-aware:
  
  // Remove this line from extraNodeModules:
  // 'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
  
  // Add resolveRequest:
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    // For non-web platforms, force react-native to app's copy to prevent
    // duplicate instances in monorepo. For web, let Expo's built-in
    // react-native → react-native-web aliasing handle it.
    if (
      moduleName === 'react-native' &&
      platform !== 'web' &&
      !context.originModulePath.includes('node_modules/react-native/')
    ) {
      return context.resolveRequest(context, moduleName, platform)
    }
    
    // Default resolution
    return context.resolveRequest(context, moduleName, platform)
  }
  ```

  **IMPORTANT**: Expo's `withMetroMultiPlatform` wraps `resolveRequest` via `withMetroResolvers`. Our custom resolver runs FIRST (Expo checks for `originalResolveRequest` and calls it first — see `withMetroResolvers.js:87`). So our resolver should only override when needed and fall through to `context.resolveRequest` otherwise.

  **Actually, the simplest approach may be even simpler**: Just remove `'react-native'` from `extraNodeModules` entirely. The monorepo's hoisted `node_modules` should still resolve correctly because `config.resolver.nodeModulesPaths` already includes the local `node_modules` (line 18) which takes priority. The `extraNodeModules` entry was a belt-and-suspenders precaution that's now causing harm.

  **Must NOT do**:
  - Don't remove `react` or `react-native-nitro-modules` from `extraNodeModules`
  - Don't restructure the entire metro config
  - Don't add a `resolveRequest` that's overly complex

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-file config change with clear instructions
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Understands Metro resolver behavior and monorepo patterns

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — must test before proceeding
  - **Blocks**: Tasks 2, 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `packages/app/metro.config.js:27-35` — Current `extraNodeModules` config (the problematic entry is line 32)
  - `packages/app/metro.config.js:17-19` — `nodeModulesPaths` already provides local resolution

  **API/Type References**:
  - `node_modules/@expo/cli/build/src/start/server/metro/withMetroMultiPlatform.js:184-189` — Expo's web aliasing (`'react-native': 'react-native-web'`)
  - `node_modules/@expo/cli/build/src/start/server/metro/withMetroResolvers.js:87` — How Expo chains custom resolvers (calls `originalResolveRequest` first)

  **WHY Each Reference Matters**:
  - `metro.config.js:32` — This is the exact line to remove/modify. The `'react-native'` entry forces native `react-native` for ALL platforms including web
  - `metro.config.js:17-19` — Shows that `nodeModulesPaths` already resolves local `node_modules`, making the `extraNodeModules` entry redundant for native
  - `withMetroMultiPlatform.js:184-189` — Proves Expo's aliasing exists and would work if not overridden
  - `withMetroResolvers.js:87` — Shows that any custom `resolveRequest` we set runs before Expo's resolvers, so we must fall through properly

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Pear web export succeeds after metro.config.js fix
    Tool: Bash
    Preconditions: Working directory is packages/app
    Steps:
      1. Run: EXPO_NO_METRO_WORKSPACE_ROOT=1 npx expo export --platform web --output-dir /tmp/pear-build-test 2>&1
      2. Assert: Exit code is 0
      3. Assert: Output does NOT contain "Invariant Violation"
      4. Assert: Output does NOT contain "__fbBatchedBridgeConfig"
      5. Assert: Output contains "Exporting static files" or similar success message
      6. Assert: /tmp/pear-build-test/index.html exists
    Expected Result: Web export completes without native module errors
    Evidence: Command output captured

  Scenario: Metro config loads without errors
    Tool: Bash
    Preconditions: Working directory is packages/app
    Steps:
      1. Run: node -e "const config = require('./metro.config.js'); console.log('Config loaded, extraNodeModules keys:', Object.keys(config.resolver?.extraNodeModules || {}).join(', '))"
      2. Assert: Exit code is 0
      3. Assert: Output shows remaining extraNodeModules keys (should NOT include 'react-native')
    Expected Result: Metro config is valid JavaScript
    Evidence: Command output captured
  ```

  **Evidence to Capture:**
  - [ ] Command output from `expo export --platform web`
  - [ ] Metro config validation output

  **Commit**: YES
  - Message: `fix(metro): remove react-native from extraNodeModules to fix web SSR crash`
  - Files: `packages/app/metro.config.js`
  - Pre-commit: `node -e "require('./metro.config.js')"` in packages/app

---

- [ ] 2. (CONDITIONAL) Guard `configureReanimatedLogger` import in `_layout.tsx`

  **ONLY DO THIS IF Task 1 alone doesn't fix the export.** Test Task 1 first.

  **What to do**:
  The `configureReanimatedLogger` import and call at the top of `_layout.tsx` (lines 25-29) triggers the entire `react-native-reanimated` → `react-native-worklets` module chain at module evaluation time. If the `extraNodeModules` fix alone doesn't resolve the SSR crash, convert this to a lazy `require()` behind a runtime platform check.

  **Implementation**:
  Replace lines 25-29:
  ```typescript
  // BEFORE (crashes during SSR):
  import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated'
  configureReanimatedLogger({
    level: ReanimatedLogLevel.warn,
    strict: false,
  })
  ```
  
  With:
  ```typescript
  // AFTER (safe during SSR — only loads reanimated on native/Pear runtime):
  if (Platform.OS !== 'web' || (typeof window !== 'undefined' && (window as any).Pear)) {
    try {
      const { configureReanimatedLogger, ReanimatedLogLevel } = require('react-native-reanimated')
      configureReanimatedLogger({
        level: ReanimatedLogLevel.warn,
        strict: false,
      })
    } catch {}
  }
  ```

  **Why `Platform.OS !== 'web' || Pear`**: On native (iOS/Android), we always want reanimated configured. On Pear desktop (web with `window.Pear`), we also want it since the app runs in a real browser context (not SSR). During SSR (`typeof window === 'undefined'`), we skip it entirely.

  **CRITICAL**: The `Platform` import from `react-native` (line 9) is already in the file and resolves correctly via `react-native-web` for web platform. So `Platform.OS` is safe to use here.

  **Must NOT do**:
  - Don't move other imports (gesture-handler, screen-orientation) behind platform checks — they have web support
  - Don't restructure the layout component
  - Don't change how other components import `react-native-reanimated`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single targeted change in one file
  - **Skills**: [`react-native-best-practices`]
    - `react-native-best-practices`: Understands platform-specific import patterns

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — conditional on Task 1 result
  - **Blocks**: Task 3
  - **Blocked By**: Task 1 (only execute if Task 1's QA shows the export still fails)

  **References**:

  **Pattern References**:
  - `packages/app/app/_layout.tsx:25-29` — Current `configureReanimatedLogger` import and call (the code to change)
  - `packages/app/app/_layout.tsx:35-36` — Existing platform detection pattern (`const isNative = Platform.OS !== 'web'`)
  - `packages/app/app/_layout.tsx:9` — Existing `Platform` import from `react-native` (safe on web)

  **API/Type References**:
  - `node_modules/react-native-reanimated/lib/module/ConfigHelper.js:25-34` — `configureReanimatedLogger` implementation (checks `SHOULD_BE_USE_WEB` before native calls)
  - `node_modules/react-native-worklets/lib/module/PlatformChecker/PlatformChecker.js:3-7` — Where `Platform` from `react-native` is imported (this is the actual crash point)

  **WHY Each Reference Matters**:
  - `_layout.tsx:25-29` — The exact lines to modify. The `import` statement is the trigger, not just the function call
  - `_layout.tsx:35-36` — Proves the platform check pattern is already established in this file
  - `PlatformChecker.js:3` — Shows the actual crash originates from `import { Platform } from 'react-native'` in the worklets package

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Pear web export succeeds after reanimated guard
    Tool: Bash
    Preconditions: Task 1 fix already applied, working directory is packages/app
    Steps:
      1. Run: EXPO_NO_METRO_WORKSPACE_ROOT=1 npx expo export --platform web --output-dir /tmp/pear-build-test2 2>&1
      2. Assert: Exit code is 0
      3. Assert: Output does NOT contain "Invariant Violation"
      4. Assert: Output does NOT contain "__fbBatchedBridgeConfig"
      5. Assert: /tmp/pear-build-test2/index.html exists
    Expected Result: Web export succeeds
    Evidence: Command output captured

  Scenario: Reanimated logger still configures on native
    Tool: Bash
    Preconditions: packages/app/app/_layout.tsx has the new guarded code
    Steps:
      1. Run: grep -n "configureReanimatedLogger" packages/app/app/_layout.tsx
      2. Assert: The call exists (not removed, just guarded)
      3. Assert: It's wrapped in a Platform.OS check
    Expected Result: configureReanimatedLogger is present but conditionally loaded
    Evidence: Grep output captured
  ```

  **Evidence to Capture:**
  - [ ] Command output from `expo export --platform web`
  - [ ] Grep output showing the guarded code

  **Commit**: YES (group with Task 1 if both needed)
  - Message: `fix(layout): guard configureReanimatedLogger for web SSR compatibility`
  - Files: `packages/app/app/_layout.tsx`
  - Pre-commit: `npx expo export --platform web --output-dir /tmp/pear-test` in packages/app

---

- [ ] 3. Full Pear build pipeline verification + regression check

  **What to do**:
  Run the complete `pear:build` pipeline and verify all output files exist and are valid. Also verify that the metro config still works for native (iOS) platform to catch any regressions.

  **Steps**:
  1. Run `npm run pear:build` (full pipeline: export → merge → copy → install → worker → inject)
  2. Verify output files exist
  3. Verify metro config loads correctly for both web and native platforms
  4. Clean up test artifacts

  **Must NOT do**:
  - Don't actually run `pear run` (requires Pear Runtime installed)
  - Don't run iOS builds (too slow for verification)
  - Don't modify any files

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Just running commands and checking outputs
  - **Skills**: []
    - No special skills needed — just bash commands

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — final verification
  - **Blocks**: None (final task)
  - **Blocked By**: Task 1 (and conditionally Task 2)

  **References**:

  **Pattern References**:
  - `packages/app/package.json:24` — `pear:build` script definition showing the full pipeline
  - `packages/app/pear-src/scripts/inject-pear-bar.js` — Final build step that injects Pear bar into HTML

  **WHY Each Reference Matters**:
  - `package.json:24` — Shows the exact command sequence: `pear:export && pear:merge && pear:copy && pear:install && pear:worker && pear:inject`
  - The inject script shows the final transformation applied to the built HTML

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios (MANDATORY):**

  ```
  Scenario: Full Pear build pipeline succeeds
    Tool: Bash
    Preconditions: Task 1 (and optionally Task 2) fixes applied, working directory is packages/app
    Steps:
      1. Run: npm run pear:build 2>&1
      2. Assert: Exit code is 0
      3. Assert: Output does NOT contain "Invariant Violation"
      4. Assert: Output does NOT contain "Error:" (except harmless warnings)
      5. Run: ls -la pear/index.html
      6. Assert: pear/index.html exists and has size > 0
      7. Run: ls pear/_expo/ 2>/dev/null || ls pear/assets/ 2>/dev/null
      8. Assert: Static assets directory exists
      9. Run: ls pear/build/workers/core/index.js
      10. Assert: Worker file exists
      11. Run: grep -c '<script' pear/index.html
      12. Assert: Count > 0 (HTML contains script tags)
    Expected Result: Complete Pear build with all expected output files
    Evidence: Command outputs and file listing captured

  Scenario: Metro config still resolves react-native for iOS
    Tool: Bash
    Preconditions: metro.config.js has been modified
    Steps:
      1. Run: node -e "
        const config = require('./metro.config.js');
        console.log('Config loaded successfully');
        console.log('nodeModulesPaths:', config.resolver.nodeModulesPaths);
        console.log('extraNodeModules keys:', Object.keys(config.resolver.extraNodeModules || {}));
        console.log('sourceExts includes bundle.js:', config.resolver.sourceExts.includes('bundle.js'));
        "
      2. Assert: Exit code is 0
      3. Assert: Output shows config loaded successfully
      4. Assert: nodeModulesPaths includes local node_modules
      5. Assert: extraNodeModules does NOT include 'react-native'
      6. Assert: sourceExts includes 'bundle.js'
    Expected Result: Metro config is valid and correctly configured
    Evidence: Config validation output captured

  Scenario: Built HTML references Pear-compatible paths
    Tool: Bash
    Preconditions: pear:build completed successfully
    Steps:
      1. Run: head -50 pear/index.html
      2. Assert: HTML uses relative paths (./_expo/ not /_expo/)
      3. Assert: script tags do NOT have type="module"
      4. Assert: HTML contains "pear" bar injection (from pear:inject step)
    Expected Result: HTML is properly configured for Pear Runtime
    Evidence: HTML head content captured
  ```

  **Evidence to Capture:**
  - [ ] Full `pear:build` command output
  - [ ] File listing of pear/ directory
  - [ ] Metro config validation output
  - [ ] HTML head content

  **Commit**: NO (no file changes in this task — verification only)

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `fix(metro): remove react-native from extraNodeModules to fix web SSR crash` | `packages/app/metro.config.js` | `npm run pear:export` |
| 2 (if needed) | `fix(layout): guard configureReanimatedLogger for web SSR compatibility` | `packages/app/app/_layout.tsx` | `npm run pear:export` |
| 3 | No commit — verification only | — | `npm run pear:build` |

---

## Success Criteria

### Verification Commands
```bash
# Primary: Pear export succeeds
cd packages/app && npm run pear:export
# Expected: Exit code 0, no "Invariant Violation"

# Secondary: Full Pear build succeeds
cd packages/app && npm run pear:build
# Expected: Exit code 0, pear/ directory populated

# Regression: Metro config valid
cd packages/app && node -e "require('./metro.config.js')"
# Expected: No errors
```

### Final Checklist
- [ ] `npm run pear:export` succeeds (exit code 0)
- [ ] `npm run pear:build` succeeds (exit code 0)
- [ ] `pear/index.html` exists with script tags
- [ ] `pear/build/workers/core/index.js` exists
- [ ] Metro config loads without errors
- [ ] No `__fbBatchedBridgeConfig` error in any output
- [ ] `extraNodeModules` still has `react` and `react-native-nitro-modules`
- [ ] `configureReanimatedLogger` still works on native (guarded, not removed)
