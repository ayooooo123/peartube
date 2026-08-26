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
  for (const item of (catalog.items || []).slice(0, 12)) {
    log('  entity', String(item.entityId || '').slice(0, 10), 'sources', (item.sources || []).length, String(item.title || '').slice(0, 30))
  }
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
        log('cover resolved ->', answer.url)
        // A URL only proves the reference resolved. Read it to prove the bytes
        // themselves crossed the swarm and are a decodable image.
        const response = await fetch(answer.url)
        const bytes = Buffer.from(await response.arrayBuffer())
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
        log('RESULT bytes', bytes.byteLength, 'type', response.headers.get('content-type'), jpeg ? 'JPEG-OK' : 'NOT-JPEG')

        // The cover proves the transport. Playback is the same path with a
        // bigger rendition, so ask for it plainly rather than inferring.
        const playback = await runtime.api.prepareMediaPlayback({ entityId: target.entityId })
          .catch(error => ({ success: false, errorCode: error?.message }))
        log('PLAYBACK', JSON.stringify({
          success: playback?.success ?? null,
          errorCode: playback?.errorCode ?? null,
          attempts: (playback?.attempts || []).map(a => a?.errorCode || a?.status || a),
          url: playback?.url || playback?.source?.url || playback?.playback?.url || null,
        }).slice(0, 400))
        // Why a source was refused matters more than that it was: a probe that
        // declares no codecs is refused for reasons a real client would not hit.
        // Why a source is refused is the whole answer; ask the entity view,
        // which carries the per-source diagnostics the selector produced.
        const entity = await runtime.api.getMediaEntity({ entityId: target.entityId })
          .catch(error => ({ error: error?.message }))
        log('SOURCES', JSON.stringify((entity?.entity?.sources || entity?.sources || []).slice(0, 3).map(source => ({
          publicationId: String(source.publicationId || '').slice(0, 10),
          availability: source.availability?.state ?? source.availability ?? null,
          codes: source.rejectionReasonCodes || source.diagnostics?.rejectionReasonCodes || null,
        }))))
        // Proof of playback is bytes through the same HTTP blob server the
        // player reads, on a peer whose store never held this file - not a
        // core.get() behind the player's back.
        let played = false
        if (playback?.success === true) {
          const entitySources = entity?.entity?.sources || entity?.sources || []
          const rendition = entitySources.map(source => source.rendition || (source.renditions || [])[0])
            .find(candidate => candidate?.coreKey)
            || (playback.coreKey ? { coreKey: playback.coreKey, coreLength: 0, byteLength: 0 } : null)
          log('RENDITION', JSON.stringify(rendition && {
            coreKey: String(rendition.coreKey || '').slice(0, 12),
            coreLength: rendition.coreLength ?? null,
            byteLength: rendition.byteLength ?? null,
          }))
          if (playback.url) {
            try {
              log('VIDEO URL', String(playback.url).slice(0, 90))
              const clip = await fetch(playback.url, { headers: { Range: 'bytes=0-1048575' } })
              const body = Buffer.from(await clip.arrayBuffer())
              const ftyp = body.length > 12 && body.subarray(4, 8).toString('latin1') === 'ftyp'
              played = clip.status === 206 && ftyp && body.length > 65536
              log('PLAYED', JSON.stringify({
                status: clip.status,
                bytes: body.length,
                brand: body.subarray(8, 12).toString('latin1'),
                ftyp,
              }))
            } catch (error) { log('PLAYED failed', error?.message) }
          }
        }
        process.exit(jpeg && played ? 0 : 1)
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
