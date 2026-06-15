import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const thumbnailLibPath = new URL('../lib/thumbnail.ts', import.meta.url)
const homeScreenPath = new URL('../app/(tabs)/index.tsx', import.meta.url)

test('thumbnail RPC timeout tolerates a busy mobile worklet', async () => {
  const src = await readFile(thumbnailLibPath, 'utf8')
  const match = src.match(/const THUMBNAIL_TIMEOUT_MS = ([\d_]+)/)
  assert.ok(match, 'expected THUMBNAIL_TIMEOUT_MS constant')
  const timeoutMs = Number(match[1].replace(/_/g, ''))
  // The backend handler can spend up to 1.5s on a bounded network wait before
  // replying, and Android cold start saturates the worklet — a 1.5s JS timeout
  // abandoned replies that were about to arrive, leaving permanent placeholders.
  assert.ok(timeoutMs >= 4000, `THUMBNAIL_TIMEOUT_MS must be at least 4000ms to outlast the backend's own bounded waits, got ${timeoutMs}`)
})

test('home feed re-sweeps thumbnails that missed their initial fetch window', async () => {
  const src = await readFile(homeScreenPath, 'utf8')

  assert.match(src, /THUMBNAIL_RESWEEP_MAX_ATTEMPTS/, 'expected a bounded thumbnail re-sweep')
  const sweepStart = src.indexOf('const thumbnailResweepAttemptsRef')
  assert.notEqual(sweepStart, -1, 'expected the re-sweep effect — initial fetches run while the backend is busiest and can exhaust their retries, with nothing else re-triggering them during the session')
  const sweep = src.slice(sweepStart, sweepStart + 1600)

  assert.match(sweep, /fetchThumbnailsForVideos\(missing\)/, 're-sweep must refetch only the videos still missing thumbnails')
  assert.match(sweep, /getRenderableThumbnailUrl\(v\)/, 're-sweep must retry cards whose current thumbnail field exists but is not renderable on native, such as stale loopback blob-server URLs from a previous session')
  assert.doesNotMatch(sweep, /!v\.thumbnailUrl && !\(v as any\)\.thumbnail/, 're-sweep must not treat any non-empty thumbnail field as renderable; stale loopback URLs can be present but intentionally suppressed')
  assert.match(sweep, /setThumbnailResweepNonce/, 're-sweep must reschedule itself even when every fetch misses (no state change would otherwise re-run the effect)')
  assert.match(sweep, /clearTimeout\(timer\)/, 're-sweep timer must be cleaned up')
})
