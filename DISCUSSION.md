# Task: Fix relay startup failing with "Invalid device file, was modified"

## Symptom
Relay container on existing storage path now fails during Corestore ready with:

Error: Invalid device file, was modified
  at device-file/index.js
  at RocksDBState._open
  at CorestoreStorage._migrateStore
  at CorestoreStorage.getSeed
  at Corestore._getOrSetSeed

## Context
We already fixed one storage-path issue by switching relay runtime to use the canonical storage root and normalizing old nested `corestore/` layouts.
Now startup gets further, but Corestore/RocksDB detects an invalid device file in existing storage.

## Goal
Make relay startup robust on reused storage paths without destroying valid data unnecessarily.

## Need to inspect
- `packages/backend/src/storage.js`
- `packages/backend/src/corestore-cleanup.js`
- relay runtime storage normalization in `packages/cli/src/runtime.js`
- any existing handling for device-file / RocksDB corruption markers

## Deliverable
Find the smallest safe recovery path for this specific error on relay startup.

## Discussion
