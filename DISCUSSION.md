# Task: Relay restart cleanup — docs + regression testing

## Goal
Now that the relay restart issue is fixed, do follow-up cleanup:
1. Document why relay runtime uses the single-writer device-file bypass (`corestoreAllowBackup: true`)
2. Add a regression test for stop/start on a reused storage path
3. Evaluate use of `corestore-snapshot` for stable CI snapshot/restore of relay storage

## Context
The working relay fix stack now includes:
- canonical storage root handling
- persisted/reused Corestore primary key
- explicit graceful shutdown
- device-file enforcement disabled for relay single-writer mounted volumes

## User suggestion
Use `https://github.com/holepunchto/corestore-snapshot` to help with the regression test / CI utility.

## Deliverable
- inspect suitability of corestore-snapshot
- add the best practical regression coverage
- update docs/comments so future debugging is easier

## Discussion

## Hermes Review

Current coverage is still missing the two places the restart fix actually lives:
- packages/cli/src/runtime.js is not exercised by the CLI test suite
- packages/cli/bin.js only has string-presence checks, not shutdown behavior checks

What I inspected
- runtime.js now does four restart-relevant things:
  - uses config.storage.path as the top-level storage root
  - reads and reuses a persisted primary-key file before initializeStorage()
  - writes the primary-key file after first successful open
  - passes corestoreAllowBackup: true to tolerate single-writer Docker/bind-mounted restart cases
- bin.js now adds explicit SIGTERM/SIGINT/beforeExit handlers and calls relay.close() during shutdown
- existing tests in packages/cli/test mostly cover config, catalog, status, and service behavior with fakes; they do not currently prove storage reopen or signal-driven shutdown

Best practical regression strategy now

1. Add one real no-Docker runtime integration test first
This is the highest-value test to add immediately because it directly exercises the storage-path + primary-key reuse fix without needing containers.

Suggested shape:
- create a temp relay storage dir
- call createRelayRuntime({ config, logger }) with the real runtime
- await runtime.start()
- assert the primary-key file now exists in the storage root
- capture its contents/hex
- await runtime.close()
- create a second runtime against the same storage path
- await secondRuntime.start()
- assert restart succeeds on the reused path
- assert the primary-key file contents are unchanged
- await secondRuntime.close()

That test proves the most important local invariant: a relay can cleanly stop and reopen the same storage root without generating a new Corestore identity.

2. Add a second no-Docker integration test around graceful shutdown
The runtime fix and the bin.js fix solve different failure modes. The first test covers storage reopen; this one should cover process shutdown wiring.

Most practical version:
- spawn node packages/cli/bin.js run with a temp config/storage path
- wait until startup log output indicates the relay is running
- send SIGTERM
- assert process exits successfully
- start the same command again with the same storage path
- assert second startup also succeeds

This is still a local test, not a Docker test, but it verifies that the explicit signal handlers actually drive relay.close() instead of relying only on graceful-goodbye.

3. Keep service-level fake-runtime tests for relay policy logic, but do not treat them as restart coverage
The existing service tests are useful for admission/mirroring/status behavior. They should stay fast and fake-driven. They are not enough for this bug because the bug is below the service layer, in storage open/close semantics.

What we can test immediately without Docker
- primary-key persistence on first runtime start
- primary-key reuse across close/reopen on the same storage path
- repeated createRelayRuntime/start/close cycles on a temp dir
- bin.js signal handling via a spawned local process and SIGTERM/SIGINT
- status/catalog persistence before and after restart on the same local path

What still really needs Docker to be fully proven
- the exact bind-mount/device-file restart condition that motivated corestoreAllowBackup: true
- container stop/start timing around SIGTERM delivery and process exit in the standalone image
- platform/image differences (distroless runtime, mounted volumes, filesystem inode/mtime behavior)

So the practical split is:
- local CI: real runtime reopen test(s) + spawned-process shutdown test
- Docker smoke test: one stop/restart test using a mounted host volume

Recommended Docker smoke test
- run the relay container with a host-mounted storage directory
- wait for startup
- stop the container cleanly
- start a new container with the same mounted directory
- assert no Corestore/device-file failure appears in logs
- optionally assert the persisted primary-key file is still present and unchanged
- optionally assert relay status/catalog files remain readable after restart

Would corestore-snapshot help?
Short answer: useful later for fixtures, but not the primary regression tool for this bug.

Why it is not the main answer here:
- the bug is about reopening a real persisted store across process/container restarts
- corestore-snapshot helps capture/restore store contents, but it does not naturally reproduce Docker bind-mount inode/device-file behavior
- it also does not replace a spawned-process shutdown test, which is needed for the explicit signal-handler fix in bin.js

Where corestore-snapshot could still be useful:
- building deterministic pre-seeded relay fixtures for slower integration tests
- restoring a known mirrored-channel state so tests can focus on restart behavior instead of spending time preparing data
- future tests that want a stable "store already contains feeds/channels" baseline in CI

Recommendation on corestore-snapshot
- do not block regression coverage on adopting it
- first add the direct temp-dir reopen test and local spawned-process shutdown test
- consider corestore-snapshot only as a follow-up convenience for fixture setup if runtime integration tests become too slow or too setup-heavy

Priority order
1. real createRelayRuntime close/reopen test on one temp dir
2. spawned bin.js SIGTERM restart test on one temp dir
3. optional Docker mounted-volume smoke test in CI
4. optional corestore-snapshot adoption for fixture preparation, not for first-line regression proof
