import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const thumbnailLibPath = new URL('../lib/thumbnail.ts', import.meta.url)

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
