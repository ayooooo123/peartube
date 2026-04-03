# Task: Fix relay EEXIST corestore reuse on existing storage path

## Symptom
Running the new relay container against an existing relay storage path fails with:

FileError: EEXIST: file already exists, mkdir "/var/lib/peartube-relay/corestore"
... from hypercore-storage/corestore initialization

## Key suspicion
Relay runtime currently passes `config.paths.corestore` (storage path + '/corestore') into `initializeStorage()`.
Need to determine whether:
1. the relay should be passing `config.storage.path` instead, and let backend storage manage layout itself, or
2. initializeStorage needs an idempotent existing-directory workaround for the relay bare runtime

## Goal
Make relay startup idempotent on an existing storage path, without deleting relay data.

## Discussion

## Hermes Review
Most likely root cause: the relay runtime is passing `config.paths.corestore` (`<storage>/corestore`) into `initializeStorage()`, but `initializeStorage()` is written to own the full storage root, not a pre-nested corestore subdirectory.

Why that looks wrong from the code:
- `packages/backend/src/storage.js` treats `storagePath` as the top-level backend storage root. It derives sibling files/directories from it such as `db`, `swarm-key.json`, legacy `logs`, and canonical `CORESTORE` state.
- `packages/backend/src/identity-key-file.js` also treats the canonical corestore layout as `join(storagePath, 'CORESTORE')`, which only makes sense if `storagePath` is the relay root.
- Other CLI state already uses `config.storage.path` as the relay root (`relay-catalog.json`, `relay-status.json`). Passing `config.paths.corestore` makes backend state live under `<storage>/corestore/...` while relay metadata lives under `<storage>/...`, which is an inconsistent split layout.

So the smallest likely correct fix is: in `packages/cli/src/runtime.js`, pass `config.storage.path` to `initializeStorage()`, not `config.paths.corestore`.

Why this is the safest interpretation of the EEXIST failure:
- The backend storage layer already encapsulates corestore layout decisions.
- The relay CLI adding its own extra `/corestore` nesting is the outlier.
- That extra nesting is the most plausible reason reused relay storage now collides with corestore initialization on an existing path.

Compatibility implication:
- Changing runtime to use `config.storage.path` is probably correct for new installs, but it may break relay instances that have already initialized backend state inside `<storage>/corestore`.
- After the change, those installs would look in `<storage>` for `CORESTORE`, `db`, `swarm-key.json`, etc, and would not automatically see data previously written under `<storage>/corestore`.

So the smallest safe fix is really two parts conceptually:
1. Make the normal path passed to `initializeStorage()` be `config.storage.path`.
2. Preserve existing-layout compatibility by detecting whether the old nested `<storage>/corestore` layout already exists and either:
   - temporarily continue using it for that installation, or
   - perform an explicit one-time migration.

If we want the absolute minimum-risk change for users with existing relay data, runtime should prefer `config.storage.path` for fresh/canonical layouts but retain a compatibility fallback when `<storage>/corestore` already contains the actual backend state.

I would not make `initializeStorage()` itself special-case this relay-only path mismatch unless necessary; the cleaner fix is at the caller, because the caller is what currently passes the wrong level of the storage tree.
