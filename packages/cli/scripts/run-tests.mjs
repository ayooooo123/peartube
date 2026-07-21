#!/usr/bin/env node
/**
 * Run each brittle test file in its own process.
 *
 * The relay test suite mixes pure unit tests with backend-backed tests that
 * spin up real Hyperswarm/DHT instances. brittle runs every file passed on one
 * command line in a single process, so an async teardown timer leaked by one
 * file (e.g. a swarm close that outlives brittle's 250ms teardown watchdog) can
 * fire during a *later* file and crash the whole run with "Can't comment after
 * end". That made the suite fragile to test ordering/timing — any change could
 * move the crash. Isolating each file in its own process removes the shared
 * event loop, so a leak in one file can never affect another.
 *
 * Add new test files to TEST_FILES below (runtime.test.mjs is intentionally
 * excluded — it needs native deps not available in the CI test env).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const TEST_FILES = [
  'admission.test.mjs',
  'archive-console-creators.test.mjs',
  'archive-ui.test.mjs',
  'archive.test.mjs',
  'blob-downloader.test.mjs',
  'classification.test.mjs',
  'cli.test.mjs',
  'config.test.mjs',
  'creators.test.mjs',
  'local-drive-mirror.test.mjs',
  'relay-seeding.test.mjs',
  'seed-pin-admission.test.mjs',
  'seed-pin-runtime.test.mjs',
  'service.test.mjs',
  'tmdb-fetch-injection.test.mjs',
  'status.test.mjs',
  'trusted-clients.test.mjs',
  // Interactive `peartube add` CLI suites.
  'add-argv.test.mjs',
  'peartube-entry.test.mjs',
  'add-picker-state.test.mjs',
  'add-terminal.test.mjs',
  'add-render.test.mjs',
  'add-preferences.test.mjs',
  'content-config-command.test.mjs',
  'tmdb-provider.test.mjs',
  'add-yt-dlp-provider.test.mjs',
  'add-discovery.test.mjs',
  'add-bulk-matcher.test.mjs',
  'add-bulk-property.test.mjs',
  'add-job-store.test.mjs',
  'add-executor.test.mjs',
  'add-command.test.mjs',
  'add-process-output.test.mjs'
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brittleName = process.platform === 'win32' ? 'brittle.cmd' : 'brittle'
const brittleCandidates = [
  join(root, 'node_modules', '.bin', brittleName),
  join(root, '..', '..', 'node_modules', '.bin', brittleName)
]
const brittleBin = brittleCandidates.find((candidate) => existsSync(candidate)) || brittleCandidates[0]

const files = TEST_FILES

const failed = []
for (const file of files) {
  const relative = join('test', file)
  console.log(`\n── ${relative} ──`)
  const result = spawnSync(brittleBin, [relative], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`Failed to launch brittle for ${relative}:`, result.error.message)
    failed.push(file)
  } else if (result.status !== 0) {
    failed.push(file)
  }
}

if (failed.length > 0) {
  console.error(`\n${failed.length}/${files.length} test file(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\nAll ${files.length} test files passed.`)
