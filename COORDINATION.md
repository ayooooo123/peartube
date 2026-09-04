# Active work notice (2026-09-04)

745f626ec committed the multi-page catalog sync fix (buffered ingest, frame-bound
trim, locator gossip). If your work touches packages/backend/src/network/,
packages/backend/src/publisher/, or packages/backend/test/, run:
  node packages/backend/test/scoped-network-runtime.test.mjs
  node packages/backend/test/publisher-admission-replay.test.mjs
Do not revert buffered-ingest, frame-bound trim, or locator gossip code — they
fix a live sync bug and were verified against a real relay. The live relay
(peartube-relay-live) is mid re-seed: do not restart it.
