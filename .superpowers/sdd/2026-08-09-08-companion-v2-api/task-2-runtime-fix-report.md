# Task 2 runtime canonicalization fix report

## Files

- `packages/cli/src/companion/auth.js`
- `packages/cli/test/companion-auth.test.mjs`
- `packages/cli/test/fixtures/companion-bare-uds.mjs`
- `.superpowers/sdd/2026-08-09-08-companion-v2-api/task-2-runtime-fix-report.md`

## Decisions

- Preserved URL parsing, decoded key/value sorting, duplicate entries, request-target validation, authentication bounds, headers, and protocol version.
- Replaced only runtime-dependent `URLSearchParams` serialization with an explicit bounded form encoder over the already-decoded entries. The existing 8192-byte raw request-target bound limits encoder work and output.
- Encoded decoded strings as UTF-8 bytes; ASCII alphanumerics and `*-._` remain literal, spaces become `+`, and every other byte uses uppercase `%HH` escapes.
- Added Node and Bare regression fixtures for `/api/v2/search?title=M*A*S*H%20~&kind=movie`, requiring `/api/v2/search?kind=movie&title=M*A*S*H+%7E` and MAC `af59194bdbdaf97c20fa751e81f34e6533bc57cdcad8ab6a4cabb75c5feaf3a1`.
- Self-review covered UTF-8 multibyte values, spaces, the `*-._` allowlist, decoded key/value sorting, duplicate preservation, and uppercase escapes.

## Commit

- Parent: `e91afa14d`
- Commit: `fix(cli): canonicalize companion queries across runtimes` (the single child commit containing this report; final SHA is returned after creation).

## Validation

A focused non-test Bare runtime smoke check produced the required canonical target and MAC. It also produced `/x?a=._-*&a=._-*&space=+&z=%C3%A9+%F0%9F%8E%AC` for duplicate, allowlist, space, Unicode, and ordering coverage.

Node/Brittle tests, the Bare test fixture runner, formatters, linters, builds, and all test suites were intentionally not run because validation is controller-owned.
