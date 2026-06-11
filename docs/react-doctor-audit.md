# React Doctor Audit — 2026-06-11

Tool: [react-doctor](https://github.com/millionco/react-doctor) (`npx react-doctor@latest -y --no-telemetry --verbose`), run across the workspace (monorepo root, `@peartube/app`, `@peartube/core`).

The raw report shows 2,187 issues, but the monorepo scan and the `@peartube/app` scan overlap, so most issues are counted twice. **After deduplication: 1,228 unique issues, of which 46 are errors.** Each error was spot-checked against the source; findings below are triaged into real bugs, judgement calls, and false positives.

## Deduplicated totals

| Category | Errors | Warnings |
|---|---|---|
| Bugs | 46 | 257 |
| Performance | — | 402 |
| Maintainability | — | 494 |
| Accessibility | — | 26 |
| Security | — | 2 |
| Correctness | — | 1 |

## Confirmed real bugs (fix these)

1. **`packages/app/app/profile.tsx:9` — `Clipboard` imported from `react-native`.**
   `Clipboard` was removed from React Native core (this repo is on RN 0.85). `Clipboard.setString(...)` at line 304 will throw at runtime when copying an invite code or recovery phrase. Fix: use `expo-clipboard` (already an Expo app) or `@react-native-clipboard/clipboard`.

2. **`packages/app/app/(tabs)/index.tsx:1499` — memoization defeated by fresh-array dependency.**
   The `useCallback` for `renderVideoRow` depends on `categories`, which is rebuilt every render, so the callback (and everything memoized downstream of it on the home feed) re-creates on every render. Fix: memoize `categories` with `useMemo` or hoist it.

3. **No lock file committed (`expo-lockfile`, Correctness).**
   There is a `pnpm-workspace.yaml` but no `pnpm-lock.yaml` (or any lock file) in the repo. Installs are not reproducible and EAS Build cannot infer the package manager. Fix: commit the lock file.

## Worth reviewing (real pattern, intentional-looking code)

4. **`no-adjust-state-on-prop-change` ×17** — resetting state inside `useEffect` when a prop/key changes:
   - `components/video-player/hooks/useCommentsPolling.ts:308-316` and `lib/shorts-social.ts:125-131` — comment/reaction state is cleared in an effect when the video key changes. Between the prop change and the effect running, one frame renders the *previous* video's comments/reactions against the new video. The React-idiomatic fix is a `key` prop on the consuming component or deriving reset state during render.
   - `components/video/ThumbnailImage.tsx:78-82`, `components/cast/CastRemoteModal.tsx:60-65`, `app/(tabs)/index.web.tsx:548-549` — same pattern, lower stakes (loading/seek flags).
   These are not crashes, but the comments-polling one can briefly show stale social data on the wrong video.

5. **`exhaustive-deps` ×58** — missing or unstable hook dependencies across the app. Worth a pass, since several are in playback and feed code where stale closures cause subtle bugs.

6. **Security (2 warnings)** — `pnpm-workspace.yaml` is missing `minimumReleaseAge` and `trustPolicy: no-downgrade` supply-chain hardening. Cheap to add.

## False positives (verified — no action needed)

- **`rn-no-raw-text` ×26 "crash" errors** — 25 are in `components/VideoPlayerOverlayImpl.tsx`, all inside `<div>`/`<span>` desktop-web-only render branches, so the "raw text outside `<Text>` crashes native" claim doesn't apply. The remaining one (`DiagnosticsPanel.ios.tsx:91`) is a label child of the custom `<Gauge>` component, which handles its own text rendering.
- **`effect-needs-cleanup` at `app/video/[id].tsx:407`** — the effect *does* return the `navigation.addListener` unsubscribe function; the rule misfired.
- **`unused-file` ×115 / `unused-export` ×99** — the dead-code analysis doesn't understand bare-pack bundling (it flags `backend/index.mjs`, the mobile worklet entry) or Metro platform extensions (`.ios.tsx`/`.android.tsx`/`.web.tsx` variants). Treat this whole category as unreliable for this repo, or configure `doctor.config.ts` entry points before trusting it.
- **`no-react19-deprecated-apis` ×211** — almost entirely `forwardRef` (396 raw hits), concentrated in the vendored gluestack-ui library under `components/ui/`. Valid for React 19 but low value to churn vendored code.

## Lower-priority themes (warnings, by volume)

- **Performance:** `rendering-svg-precision` ×126 (long decimal coordinates in SVGs — mostly generated assets), `async-await-in-loop` ×89 and `async-parallel`/`async-defer-await` ×55 (sequential awaits in backend loops — some may be intentional for backpressure on P2P streams), `js-flatmap-filter`/`js-combine-iterations` ×61.
- **React structure:** `prefer-useReducer` ×19, `no-derived-state` ×18, `no-giant-component` ×16 (e.g. `VideoPlayerOverlayImpl.tsx` at ~2,700 lines), `rerender-state-only-in-handlers` ×15.
- **Accessibility (web):** `button-has-type` ×34, plus missing key handlers/labels on clickable elements in the desktop web UI.
- **Maintainability:** ~17 unused (dev)dependencies flagged across package.json files — several (e.g. `bare-*` addons) are likely loaded dynamically by the Bare runtime, so verify before removing.

## Suggested order of attack

1. Fix the `Clipboard` import (user-facing crash on profile screen).
2. Commit the lock file; add pnpm hardening settings.
3. Memoize `categories` on the home tab.
4. Review the comments-polling reset-on-prop-change effects.
5. Schedule an `exhaustive-deps` cleanup pass for playback/feed code.
