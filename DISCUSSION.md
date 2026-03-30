# Task: Android PiP auto-enter stops working after first return from PiP

## User report
After the first return from PiP, leaving the app no longer re-enters PiP automatically. Need a targeted patch, not a broad refactor.

## Constraints
- Preserve uncommitted work. Do NOT use git checkout or git restore.
- Follow root-cause-first debugging.
- Focus on existing MainActivity + PipBridge + VideoPlayerOverlay / VideoPlayerContext flow.
- Prefer a small targeted fix.

## Key evidence

### MainActivity hooks
```kt
override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    PipBridge.onUserLeaveHint(this)
}

override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    PipBridge.notifyPipModeChanged(this, isInPictureInPictureMode, newConfig)
}
```

### Native PiP entry gate
```kt
private var pipEnabled: Boolean = false

fun setPipEnabled(enabled: Boolean) {
    pipEnabled = enabled
    moduleInstance?.updateActivityPipParams(enabled)
}

fun onUserLeaveHint(activity: Activity) {
    if (!pipEnabled) return
    if (activity.isInPictureInPictureMode) return
    if (!isPipHostActivity(activity)) return
    markPipTransition()
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(getPipAspectRatio())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setSeamlessResizeEnabled(true)
    }
    builder.setActions(moduleInstance?.buildPipActions(activity) ?: emptyList())
    activity.enterPictureInPictureMode(builder.build())
}
```

### JS auto-PiP effect
```tsx
const shouldAutoPip = Platform.OS === 'android'
  ? currentVideo !== null && !isCasting && (playerMode === 'fullscreen' || playerMode === 'mini')
  : ...
autoPipEnabledRef.current = shouldAutoPip
if (isInPipMode) return
await MediaSession.setAutoPictureInPicture(enabled)
```

### JS PiP exit callback
```tsx
const handlePipStatusChanged = useCallback((event) => {
  setIsInPipMode(event.isInPictureInPicture)
  if (!event.isInPictureInPicture) {
    setPipWindowSize(null)
    if (AppState.currentState === 'active') {
      maximizePlayer()
    }
  }
}, ...)
```

### Context PiP listener
```tsx
if (event.isInPictureInPicture) {
  dispatch({ type: 'PIP_ENTERED_ANDROID', ... })
}
...
} else if (wasInPip) {
  dispatch({ type: 'PIP_EXITED_ANDROID', restoreMode: modeBeforePipRef.current, ... })
  setIsPlaying(shouldResume)
}
```

## Suspicions to test
1. `pipEnabled` may get disabled during/after PiP exit and never reliably re-enabled.
2. `onUserLeaveHint()` direct-entry builder may be missing sourceRect / autoEnter refresh, causing first entry to work and later ones not.
3. PiP exit ordering between overlay `setIsInPipMode(false)` and context/state-machine restore may create a transient false auto-PiP disable.

## What to add
Please append your findings under a new heading with your agent name, then recommend the smallest safe patch.

## Codex Review

### Hermes Agent

Findings:
- The Android PiP lifecycle currently has two JS owners for the same transition:
  - `VideoPlayerContext` listens to `MediaSession.addPictureInPictureListener(...)` and drives the state machine (`PIP_ENTERED_ANDROID` / `PIP_EXITED_ANDROID`), AppState suppression, resume behavior, and `isInPipModeRef`.
  - `VideoPlayerOverlayImpl.handlePipStatusChanged(...)` also calls `setIsInPipMode(...)`, which on Android dispatches the same state-machine transitions again.
- That duplication is risky specifically on repeated PiP cycles because `VideoPlayerContext` mutates `isInPipModeRef.current` immediately when the native MediaSession PiP event arrives, before its delayed exit finalization runs. If the overlay callback runs after that, `setIsInPipMode(false)` computes `wasInPip` from an already-cleared ref and emits a second `PIP_EXITED_ANDROID` with `wasInPip: false`.
- In the reducer, `PIP_EXITED_ANDROID` with `wasInPip: false` is treated as an invalid/partial exit and falls back to `mode: 'loading'` instead of restoring the prior playable mode. Even if the later context-owned timeout restores fullscreen, this creates a noisy transient state during the PiP exit tail.
- The auto-PiP effect in `VideoPlayerOverlayImpl` is also separate from the context PiP state logic. It computes its own `shouldAutoPip`, writes `autoPipEnabledRef.current`, and calls `MediaSession.setAutoPictureInPicture(enabled)`, but it early-returns while `isInPipMode` is true. That means the native `pipEnabled` flag is only refreshed again after the JS restore path settles cleanly.
- Because native `onUserLeaveHint()` is gated entirely by sticky `pipEnabled`, any exit-path race that leaves JS briefly in the wrong mode / wrong PiP state can suppress the re-enable window for the next backgrounding. This matches the symptom: first PiP works, return succeeds, subsequent leave-app does not auto-enter PiP.
- `handlePipStatusChanged(...)` appears to be doing two different jobs:
  - true PiP state transitions (`setIsInPipMode`) which are already owned by `VideoPlayerContext`
  - overlay/UI cleanup (`setPipWindowSize(null)`, `maximizePlayer()` when foregrounded)
  The first job is redundant on Android; the second is still useful.
- `VideoPlayerContext.shouldEnablePip` already exists as a central PiP eligibility signal, but the overlay effect does not use it. Instead there are two separate eligibility calculations (`shouldEnablePip` in context, `shouldAutoPip` in overlay), increasing the odds of re-enable drift after PiP exit.

Most likely JS/state root cause:
- Repeated-entry failure is more likely caused by duplicated Android PiP transition handling and ref/state races than by the native `onUserLeaveHint()` builder itself. The native side only checks `pipEnabled`; the JS side is what decides whether that flag gets re-armed consistently after returning from PiP.

Proposed minimal patch (do not refactor broadly):
1. Make `VideoPlayerContext` the sole owner of Android PiP enter/exit state transitions.
   - In `VideoPlayerOverlayImpl.handlePipStatusChanged`, stop calling `setIsInPipMode(...)` on Android.
   - Keep only UI/layout cleanup there (`setPipWindowSize`, `maximizePlayer` on active foreground), or restrict the direct `setIsInPipMode(...)` path to non-Android platforms.
2. Keep the Android auto-PiP enable/disable logic driven from one eligibility source.
   - Prefer using `shouldEnablePip` from `VideoPlayerContext` (or matching its exact conditions) for the overlay auto-PiP effect, so native `setAutoPictureInPicture(...)` is re-armed from the restored fullscreen state instead of a separate overlay-only condition set.
3. Do not change native PiP entry code unless JS-only cleanup above proves insufficient.
   - I do not see strong evidence here that `MainActivity` / `PipBridge.onUserLeaveHint()` is the primary failure point for repeated entry.

Why this is the smallest safe patch:
- It removes the Android-only duplicated PiP state transition path without changing the native PiP flow.
- It preserves the existing context listener, which already contains the more complete handling for AppState ordering, resume, and `modeBeforePip` restoration.
- It minimizes risk to iOS / web because the recommendation is specifically to stop double-driving Android PiP state, not to redesign the player state machine.

## Claude Proposal

### Hermes Agent
- MainActivity is just a thin pass-through: `onUserLeaveHint()` always calls `PipBridge.onUserLeaveHint(this)`, and `onPictureInPictureModeChanged(...)` always calls `PipBridge.notifyPipModeChanged(...)`. So the repeat-entry failure is most likely inside bridge/module state, not in MainActivity itself.
- I do not see native code that explicitly disables PiP on exit. `pipEnabled` in `PipBridge` is only changed from JS through `MediaSessionModule.setAutoPiP()` -> `PipBridge.setPipEnabled(enabled)`. `notifyPipModeChanged(false, ...)` does not clear it. So the native side does not appear to permanently turn auto-PiP off by itself.
- The most suspicious native state is `lastIsInPip`. In `notifyPipModeChanged(...)`, exit handling does this:
  - set `lastIsInPip = isInPip` (so `false` on exit), then
  - if the restored window still looks PiP-sized, overwrite it back to `true` with `lastIsInPip = true  // Pretend we're still in PiP`.
- That means the bridge can intentionally leave itself in a stale "still in PiP" state after a real exit. If Android never sends another compensating `onPictureInPictureModeChanged(false, ...)` once the window fully expands, the next real PiP entry sees `didStateChange = (true != true) == false`. That suppresses the bridge's transition bookkeeping on re-entry.
- Even though `onUserLeaveHint()` itself does not check `lastIsInPip`, this stale state is still risky because it short-circuits the only native state-change path that refreshes transition timing / player view notifications during the next PiP cycle. It is the clearest piece of native state that can remain logically "stuck" after PiP exit.
- `onUserLeaveHint()` is also asymmetrical with the module's other PiP entry paths:
  - it builds fresh params and calls `enterPictureInPictureMode(...)`,
  - but unlike `updateActivityPipParams(...)` / `enterPiP()`, it does not set a `sourceRectHint`, and
  - on Android 12+ it does not re-assert `autoEnterEnabled` before entering.
- That asymmetry is not as strong a root cause as the stale `lastIsInPip`, but it does make repeated entries more fragile because the direct-entry path is not reusing the same fully-populated params that the module uses elsewhere.
- `updateActivityPipParams(enabled)` itself looks stateless/safe: every call rebuilds aspect ratio, source rect, actions, and `setAutoEnterEnabled(enabled && isPipHostActivity)`. I do not see it caching a disabled native flag after exit. The bigger risk is simply that it is not being refreshed from the same place that does the actual direct entry.

Proposed minimal patch:
1. In `PipBridge.notifyPipModeChanged(...)`, stop restoring `lastIsInPip = true` inside the `stillPipSized` branch. Keep the guard that skips dismissal/pause work while the window is still small, but do not falsify the bridge's authoritative PiP state.
2. Optionally, make `onUserLeaveHint()` reuse the same params shape as `updateActivityPipParams(...)` before calling `enterPictureInPictureMode(...)` (at minimum: include `sourceRectHint`, and on Android 12+ re-assert `autoEnterEnabled(true)` for the host activity). This is a small follow-up hardening change, but the first patch is the smallest fix for native state getting stuck after exit.

Why this is the smallest safe patch:
- It avoids a broad PiP refactor.
- It targets the one native variable that can remain incorrectly "disabled/stuck" across exits (`lastIsInPip` behaving as if PiP never ended).
- It preserves the existing dismissal guard logic while removing the state lie that can poison the next PiP cycle.

---

# Task: sanitize public repo history and ignore sensitive local artifact dirs

## User request
Remove any sensitive info from the public repo. Add entries like `.tmp-device-crashes` and `.sisyphus` to `.gitignore`, stop tracking them, and purge them from git history.

## Constraints
- Preserve all existing uncommitted work in the main repo. Do NOT use `git checkout` or `git restore` on modified files.
- Prefer a safe workflow that rewrites history in a separate mirror clone rather than destructively in the dirty working tree.
- Keep `DISCUSSION.md` itself intact; append only.
- Need concrete commands and verification steps.

## Observed facts
- Main repo has many unrelated uncommitted changes.
- `git ls-files` shows tracked sensitive/unwanted paths including `.sisyphus/**`, `.tmp-device-crashes/**`, and `logfile`.
- `.gitignore` already ignores `.sisyphus/` but history and current index still contain these files; `.tmp-device-crashes/` is not yet ignored.
- `git filter-repo` is installed at `/opt/homebrew/bin/git-filter-repo`.
- Remote is `origin https://github.com/ayooooo123/peartube.git`.

## Requested discussion output
Please append your findings under your own heading. Recommend the safest minimal plan to:
1. update ignore rules in the main repo,
2. untrack current sensitive artifacts without touching unrelated files,
3. rewrite full history safely,
4. verify purge results,
5. state exact push/follow-up steps.

## Claude Proposal

### Claude Code
Safest plan:

1. Preserve the dirty working tree before any history work.
   - Use `git stash push --include-untracked -m "pre-sanitize-working-tree"` in the main repo.
   - This keeps all uncommitted tracked and untracked work out of the way without `git checkout`/`git restore`.
   - After the history rewrite is pushed and the local repo is resynced, restore with `git stash pop`.

2. Update ignore rules in the main repo.
   - Add `.tmp-device-crashes/` to `.gitignore`.
   - Keep/retain `.sisyphus/` and `logfile` ignore entries.

3. Stop tracking the unwanted artifacts in the current branch tip without deleting local files.
   - Run:
     `git rm -r --cached -- .sisyphus .tmp-device-crashes logfile || true`
   - Then commit the index cleanup in the main repo after the stash is restored or in a clean branch state.

4. Rewrite history in a separate bare mirror clone, not in the dirty working tree.
   - Commands:
     `tmpdir=$(mktemp -d /tmp/peartube-sanitize.XXXXXX)`
     `git clone --mirror origin "$tmpdir/repo.git"`
     `cd "$tmpdir/repo.git"`
     `git filter-repo --force \
       --path .sisyphus --invert-paths \
       --path .tmp-device-crashes --invert-paths \
       --path logfile --invert-paths`
   - Using `--mirror` ensures every ref is rewritten, including branches/tags.

5. Verify the purge inside the mirror clone before pushing.
   - Check names in commit history:
     `git log --all --name-only --pretty=format: | sort -u | egrep '(^|/)(\.sisyphus($|/)|\.tmp-device-crashes($|/)|logfile$)'`
     expected: no output
   - Check object graph:
     `git rev-list --objects --all | egrep '(^| )(\.sisyphus/|\.tmp-device-crashes/|logfile$)'`
     expected: no output

6. Force-push rewritten refs from the mirror clone.
   - Dry run first:
     `git push --force --mirror --dry-run origin`
   - Real push:
     `git push --force --mirror origin`
   - This is the safest way to keep the destructive operation isolated from the main working repo.

7. Resync the main working repo to the rewritten remote, then restore local work.
   - In the main repo after the push:
     `git fetch origin --prune`
     `git reset --hard origin/main`
     `git stash pop`
   - If there are conflicts on `.gitignore`, resolve them manually and keep the new ignore entries.

8. Cleanup temp mirror clone.
   - `rm -rf "$tmpdir"`

Notes:
- Do not run `git filter-repo` directly in the dirty working repo.
- Warn collaborators that all rewritten branches/tags will require recloning or hard-resetting to the new history.
- If GitHub cached large/sensitive blobs, also open a support request only if necessary after verifying the refs are gone.

## Codex Review

### Codex

Risks in Claude's proposal:
- `git stash push --include-untracked` in the user's dirty repo is the wrong safety boundary here. It sweeps unrelated tracked and untracked work into one stash, creates a conflict-prone `stash pop` after history is rewritten, and unnecessarily creates another local ref (`refs/stash`) containing the sensitive blobs.
- `git reset --hard origin/main` in the dirty checkout is exactly the destructive step this task is trying to avoid. Even if the stash exists, restoring onto rewritten history is brittle and easy to get wrong.
- The ordering is incomplete: the proposal says to change `.gitignore` / untrack files in the main repo, but then rewrites a mirror cloned from `origin`. Unless that cleanup commit is incorporated into the source being rewritten, the final rewritten public history will not include the new ignore rule or the tip cleanup commit.
- `git rm ... || true` masks mistakes. If one of the paths is misspelled or unexpectedly absent, the command still "succeeds" and hides the failure. `--ignore-unmatch` is the safer form.

Improved plan:
1. Do not stash, reset, or otherwise mutate the current dirty checkout during sanitization.
2. Make the `.gitignore` change and `git rm --cached` commit in a separate temporary clean clone created from the current repo's committed `main` tip. That preserves the user's uncommitted work while ensuring the cleanup commit exists before the rewrite.
3. Clone `origin` as a mirror, fast-forward its `main` ref to the cleanup commit from the temp clone, then run `git filter-repo` there. That way the rewritten history contains both the purge and the ignore/untrack cleanup.
4. Force-push from the isolated mirror clone only after verification passes.
5. Leave the original dirty repo untouched afterward. For day-to-day work, make a fresh clone from the sanitized remote and port local WIP deliberately; do not `reset --hard` the existing checkout.

Exact safer command sequence:

```bash
repo=/Users/jd/projects/peartube
origin_url=$(git -C "$repo" remote get-url origin)
tmpdir=$(mktemp -d /tmp/peartube-sanitize.XXXXXX)

# 1) Prepare the tip-cleanup commit in a throwaway clean clone.
git clone --no-local "$repo" "$tmpdir/work"
git -C "$tmpdir/work" remote set-url origin "$origin_url"
git -C "$tmpdir/work" switch main

grep -qxF '.sisyphus/' "$tmpdir/work/.gitignore" || printf '\n.sisyphus/\n' >> "$tmpdir/work/.gitignore"
grep -qxF '.tmp-device-crashes/' "$tmpdir/work/.gitignore" || printf '\n.tmp-device-crashes/\n' >> "$tmpdir/work/.gitignore"
grep -qxF 'logfile' "$tmpdir/work/.gitignore" || printf '\nlogfile\n' >> "$tmpdir/work/.gitignore"

git -C "$tmpdir/work" rm -r --cached --ignore-unmatch -- .sisyphus .tmp-device-crashes logfile
git -C "$tmpdir/work" add .gitignore
git -C "$tmpdir/work" commit -m "Stop tracking local artifact files"

# Optional verification of the tip cleanup before history rewrite.
git -C "$tmpdir/work" ls-files | rg '(^|/)(\.sisyphus($|/)|\.tmp-device-crashes($|/)|logfile$)' || true
git -C "$tmpdir/work" check-ignore -v .sisyphus/example .tmp-device-crashes/example logfile

# 2) Rewrite history in an isolated mirror clone.
git clone --mirror "$origin_url" "$tmpdir/rewrite.git"
git -C "$tmpdir/work" push "$tmpdir/rewrite.git" HEAD:refs/heads/main

(
  cd "$tmpdir/rewrite.git" &&
  /opt/homebrew/bin/git-filter-repo --force \
    --path .sisyphus --invert-paths \
    --path .tmp-device-crashes --invert-paths \
    --path logfile --invert-paths
)

# 3) Verify the purge in the rewritten mirror.
git -C "$tmpdir/rewrite.git" ls-tree -r --name-only refs/heads/main | rg '(^|/)(\.sisyphus($|/)|\.tmp-device-crashes($|/)|logfile$)' || true
git -C "$tmpdir/rewrite.git" log --all --name-only --pretty=format: | sort -u | rg '(^|/)(\.sisyphus($|/)|\.tmp-device-crashes($|/)|logfile$)' || true
git -C "$tmpdir/rewrite.git" rev-list --objects --all | rg '(^| )(\.sisyphus/|\.tmp-device-crashes/|logfile$)' || true

# 4) Push only after the verification commands above return no matches.
git -C "$tmpdir/rewrite.git" push --force --mirror --dry-run origin
git -C "$tmpdir/rewrite.git" push --force --mirror origin

# 5) Post-push: keep the old dirty repo as-is; use a fresh clone for future work.
git clone "$origin_url" /Users/jd/projects/peartube-sanitized
```

Push / follow-up notes:
- Coordinate a push freeze first. `git push --force --mirror` rewrites every branch and tag in the public remote.
- After the force-push, collaborators should reclone or hard-reset their own clean clones. Do not use the user's current dirty checkout as the place to resync.
- If the exposure is truly sensitive, GitHub pull-request refs and caches may still need separate cleanup/support follow-up even after the rewritten refs are gone.

---

# Task: sanitize .evidence directory from public repo

## User request
Remove `.evidence` like the earlier local-artifact directories: ignore it locally, stop tracking it, and purge it from public history.

## Observed facts
- `.evidence/` is currently present in the working tree.
- It is tracked in the current repo tip.
- It also appears in remote branch/tag history.
- Current branch setup has already been simplified to `main` only on both local and remote, which makes the rewrite smaller.

## Constraints
- Preserve current uncommitted work in the main checkout.
- Use the same safe pattern as before: temp clean clone for tip cleanup, isolated mirror clone for rewrite, verify, then push.

## Claude Proposal

### Claude Code
Safest plan:
- Add `.evidence/` to `.gitignore` in the real repo so future local files stay untracked.
- Do not run history rewrite in the dirty checkout.
- Create a throwaway clean clone from the committed repo state, add the ignore rule there, and run `git rm -r --cached --ignore-unmatch -- .evidence` to produce a tip cleanup commit.
- Create a separate mirror clone from `origin`, push that cleanup commit into `main`, then run `git filter-repo --force --path .evidence --invert-paths` in the mirror clone.
- Re-attach `origin` if filter-repo strips it, then push rewritten refs. If GitHub rejects hidden refs, push heads and tags separately.
- Verify from a fresh mirror clone of the remote that `.evidence` is absent from visible branches/tags and current `main`.

## Codex Review

### Codex

Gaps to fix in the plan:
- Do not do any part of the cleanup in the current dirty checkout, including `git stash`, `git reset --hard`, or a temporary `git rm --cached` there. Those steps either create another local ref that still contains the sensitive blobs or make recovery of unrelated WIP harder than necessary.
- The scope is understated. This repo is not effectively `main`-only right now: local refs still show multiple `origin/dependabot/...` branches and several tags, so a `--mirror` rewrite still has wider blast radius than the note implies.
- A mirror rewrite is necessary but not sufficient for GitHub. `git push --force --mirror` will not clean up GitHub hidden refs such as `refs/pull/*`, and local `git filter-repo` verification does not prove those server-side refs or PR caches are gone.
- If the plan injects the `.gitignore` and `git rm --cached` cleanup commit only onto `main`, that is fine for the durable branch, but it should say so explicitly instead of implying every surviving ref will inherit the ignore rule.

Improved plan:
1. Keep the existing checkout untouched end-to-end. Prepare the `.gitignore` addition and `git rm -r --cached --ignore-unmatch -- .evidence` commit in a throwaway clean clone created from the repo's committed `main` or `HEAD`, not from the dirty working tree state.
2. Feed that cleanup commit into an isolated mirror clone before running `git filter-repo`, so the rewritten `main` tip both drops `.evidence` from history and carries the ignore rule going forward.
3. Correct the rewrite scope in the write-up: visible remote branches and tags still exist, so the push-freeze warning should cover all rewritten refs, not just `main`.
4. Call out GitHub hidden refs as a separate post-rewrite concern. After the force-push, treat local verification as "public heads and tags look clean," not "GitHub is fully purged." If `.evidence` ever appeared in PRs, plan for a GitHub Support follow-up to clear hidden PR refs and caches.
5. Leave the old dirty checkout alone afterward. Use a fresh clone from the sanitized remote for future work, and migrate any WIP deliberately rather than resyncing the existing checkout with destructive commands.

This keeps focus on preserving the user's dirty repo while making the GitHub-side limitations explicit, which is the main gap in the current sanitization plan.
