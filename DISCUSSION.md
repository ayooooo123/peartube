# Task: Fix relay CLI/container restart error: device-file 'Invalid device file, was modified'

## Symptom
Starting and stopping the relay in the user's container runtime throws during Corestore open:

```
Error: Invalid device file, was modified
  at device-file/index.js
  at RocksDBState._open
  at hypercore-storage
  at Corestore._open
```

## Interpretation
This usually means the storage metadata in `device-file` thinks the underlying device/inode identity changed between runs. In container environments this often happens with:
- bind mounts / overlayfs / ephemeral writable layers
- volume paths recreated between runs
- file locking/device identity assumptions not surviving container restart patterns

## Goal
Find the relay CLI storage path and startup behavior, then determine the safest fix.
Likely options:
1. change relay storage path strategy
2. avoid device-file verification mode in container env if supported
3. ensure persistent volume path is stable
4. wipe/recreate only the specific invalid store metadata when corrupt/incompatible

## Files to inspect
- packages/cli/src/service.js
- packages/backend/src/storage.js
- any relay startup command / docker / container scripts

## Discussion

## Codex Proposal

### Independent diagnosis
The relay CLI is opening Corestore directly against `config.storage.path` (`packages/cli/src/runtime.js`), and that path is also where the container image sets `WORKDIR`, `PEARTUBE_STORAGE_PATH`, and the Docker `VOLUME` (`packages/cli/Dockerfile`). Corestore itself is created as `new Corestore(storagePath, options)` in `packages/backend/src/storage.js`, so RocksDB/device-file metadata is anchored to the filesystem identity of that exact mounted directory.

`Invalid device file, was modified` is more consistent with a storage-root identity change than with a logical relay config problem. In practice that means one of these is likely happening between container runs:
- the relay data directory is landing on a different underlying device/inode after restart
- the container is using a bind mount or overlay-backed path whose reported device metadata changes across restarts
- the storage root was recreated/rebound while preserving some files, so `device-file` sees the old metadata and aborts before Corestore can open

A notable code-path difference: the backend/orchestrator path has persistence and retry logic around Corestore seed selection (`packages/backend/src/orchestrator.js`, `identity-key-file.js`, `corestore-error-utils.js`), but the relay CLI does not use that path. The CLI calls `initializeStorage()` directly with only `{ storagePath, wrapTimeout: true }` (`packages/cli/src/runtime.js`). That means:
- no standalone primary-key persistence/reuse in the CLI path
- no orchestrator-style retry/fallback behavior
- no classification of the device-file failure into a safer recovery mode

This does not prove the primary key is the cause of the error; the immediate failure still looks like filesystem identity verification in `device-file`. But it does mean the CLI currently has no controlled recovery path once the mount identity changes.

### What looks safe to change
1. Separate app metadata from Corestore data
   - Today the relay uses one root for everything: Corestore internals plus `relay-catalog.json` and `relay-status.json` (`packages/cli/src/config.js`, `packages/cli/src/catalog.js`).
   - Safer layout: keep `config.storage.path` as the relay home, but open Corestore under a dedicated child such as `<storage>/corestore` or `<storage>/db/corestore`.
   - Benefit: if device-file metadata becomes invalid, we can surgically reset only the Corestore subtree without deleting relay catalog/status/config artifacts.
   - This is the cleanest safe code change because it does not weaken integrity checks; it just narrows the blast radius.

2. Add explicit CLI startup checks for stable persistent storage
   - Before opening Corestore, detect and warn/refuse when `storage.path` is relative, inside obviously ephemeral locations, or equals the container working directory without a mounted volume.
   - The backend already warns on default/relative storage in `packages/backend/src/storage.js`; the relay container path should go further and document/recommend named volumes over bind mounts for restarts.
   - In docs/examples, strongly prefer the existing named-volume pattern from `packages/cli/docker-compose.example.yml` and explicitly warn that bind-mounting overlay-backed or recreated host directories can trip device-file validation.

3. Reuse the backend identity/primary-key persistence logic in the relay CLI
   - Even though the current error is probably not caused by seed mismatch, the CLI should still persist and reuse the Corestore primary key the same way the backend does.
   - Lowest-risk implementation: factor a small shared helper from `packages/backend/src/orchestrator.js` + `identity-key-file.js` and use it in `packages/cli/src/runtime.js` before `initializeStorage()`.
   - Benefit: makes container restarts more deterministic and aligns relay behavior with the more battle-tested backend path.
   - Limitation: this alone probably will not fix `Invalid device file, was modified` if the mount identity itself changes.

4. Add a narrowly-scoped recovery path for device-file invalidation
   - Treat this error as a distinct startup failure class.
   - Provide an explicit opt-in mode/env var for the relay, e.g. `PEARTUBE_CORESTORE_RESET_ON_DEVICE_MISMATCH=1`.
   - On that specific error only, close any partial store and move aside only the Corestore subtree (`corestore/`, `db/`, `cores/`, `primary-key`, `CORESTORE` depending on final layout), preserving `relay-catalog.json` and `relay-status.json`, then reopen.
   - If we first isolate Corestore into its own subdirectory, this becomes much safer and easier to reason about.
   - I would avoid unconditional auto-delete on this error in the current mixed-layout design.

5. Add a preflight marker for operator diagnostics
   - Write a tiny plain JSON marker in the relay home on clean startup containing the resolved storage path and a snapshot of `stat()` data for the storage root.
   - On next boot, if the marker exists but the root device/inode changed, log a targeted message explaining that the persistent volume identity changed and that Corestore/device-file may reject the store.
   - This is safe and helps confirm whether the problem is Docker volume identity versus internal corruption.

### Recommended mitigation order
A. Operational fix first
- Ensure the relay is restarted with the same named Docker volume, not a recreated bind mount or ephemeral writable layer.
- Keep `PEARTUBE_STORAGE_PATH` pointed at the mounted volume path, not a path copied into the image layer.

B. Safe code fix next
- Refactor the CLI to use a dedicated Corestore subdirectory under `config.storage.path`.
- Keep relay catalog/status files at the top level.
- Add a targeted error message for the device-file mismatch case.

C. Optional controlled recovery
- After the layout split, add an opt-in reset/move-aside path for only the Corestore subtree on this exact error.

### Bottom line
My second-opinion diagnosis is that the root issue is most likely persistent-volume identity instability across container restarts, not relay admission logic or catalog corruption. The safest code change is not to bypass `device-file`, but to isolate Corestore into its own subdirectory and add a controlled, opt-in recovery path around that subtree. The relay CLI should also adopt the backend's primary-key persistence pattern so restart behavior is more deterministic overall.

## Claude Proposal
The relay CLI passes `config.storage.path` straight through to backend `initializeStorage()` via `packages/cli/src/runtime.js`, and `packages/cli/src/service.js` also uses that same directory for relay sidecar files (`relay-catalog.json` and `relay-status.json`). In `packages/backend/src/storage.js`, Corestore is opened directly at that exact path with `new Corestore(storagePath, options)` and no container-specific override. The default relay path is also relative (`./peartube-relay`).

Most likely cause:
- in container restarts, the directory backing `config.storage.path` is not the same underlying filesystem identity that RocksDB/device-file saw on first boot
- this is especially likely with overlayfs writable layers, recreated bind-mount targets, changing working directories with a relative path, or a volume mount that resolves to a fresh device/inode after restart
- once `device-file` detects that identity mismatch, Corestore open fails early with `Invalid device file, was modified`

Safest fix:
1. require/document a stable absolute persistent volume for relay storage in containers
2. store Corestore/RocksDB in its own dedicated subdirectory under the relay storage root (for example `<storage>/corestore`), while keeping relay JSON files alongside it
3. add a one-time migration or explicit compatibility handling from the old flat layout to the dedicated subdirectory

Why this is safest:
- it avoids weakening Corestore/device-file integrity checks
- it avoids automatically deleting RocksDB metadata on open failure
- it makes the runtime less sensitive to relative-path/container cwd changes
- it separates Corestore’s internal database from relay-managed JSON/status files and any future sidecar files

What I would not do first:
- do not disable device-file verification globally just to make containers pass
- do not auto-wipe the store on this error unless there is an explicit recovery path and operator opt-in, because that risks silent data loss

If we need an additional short-term mitigation, it should be documentation/config validation that rejects or warns on relative storage paths in container mode, but the primary code fix should be moving Corestore to a stable dedicated subdirectory and ensuring operators mount that directory persistently.
