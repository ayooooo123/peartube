// A second peer, under our own control, exercising exactly what a phone does:
// discover the publisher, sync its catalog, then ask for a title's cover over
// the authorized asset path. Two local processes make the byte transfer
// observable in seconds instead of a four-minute device build, and every step
// prints what it saw so a stall is attributable to a side rather than guessed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayRuntime } from '../src/runtime.js'

const storage = mkdtempSync(join(tmpdir(), 'peartube-artwork-peer-'))
const deadlineMs = Number(process.argv[2] || 180_000)

const log = (...args) => console.log('[peer]', ...args)

function summarize(items) {
  return items.map(item => ({
    entityId: String(item.entityId || '').slice(0, 12),
    title: String(item.title || '').slice(0, 20),
    year: item.releaseYear ?? null,
    poster: item.posterBlobId ? `${String(item.posterBlobsCoreKey || '').slice(0, 8)}@${item.posterBlobId}` : null,
  }))
}

const runtime = await createRelayRuntime({
  config: {
    storage: { path: storage },
    network: { bootstrapEnabled: true },
    discovery: { enabled: true },
  },
  logger: { archive: { info() {}, warn() {}, error() {} } },
})

try {
  log('storage', storage)
  const started = Date.now()
  let catalog = { items: [] }

  while (Date.now() - started < deadlineMs) {
    catalog = await runtime.api.getMediaCatalog({}).catch(error => ({ items: [], error: error?.message }))
    if (catalog.items?.length) break
    await new Promise(resolve => setTimeout(resolve, 3_000))
  }

  log('catalog items:', catalog.items?.length || 0)
  log(JSON.stringify(summarize(catalog.items || []), null, 1))

  // Older publications advertise a cover on the claim but predate carrying one
  // on the manifest, so ask every candidate rather than trusting the first.
  const targets = (catalog.items || []).filter(item => item.posterBlobId)
  log('entries advertising a cover:', targets.length)
  if (targets.length === 0) {
    log('RESULT no catalog entry advertises a cover; nothing to transfer')
    process.exit(2)
  }

  const artworkStarted = Date.now()
  while (Date.now() - artworkStarted < deadlineMs) {
    for (const target of targets) {
      const answer = await runtime.api.getEntityArtwork({ entityId: target.entityId })
        .catch(error => ({ success: false, exists: false, errorCode: error?.message }))
      if (answer?.exists) {
        log('RESULT cover transferred over the swarm ->', answer.url)
        process.exit(0)
      }
      log('  not yet', String(target.entityId).slice(0, 12), JSON.stringify(answer))
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  log('RESULT no cover arrived for any of', targets.length, 'entries')
  process.exit(1)
} finally {
  try { await runtime.close?.() } catch {}
  try { rmSync(storage, { recursive: true, force: true }) } catch {}
}
