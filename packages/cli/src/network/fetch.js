import { createHash } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import {
  NetworkCommandError,
  availabilityFacts,
  collectCatalogItems,
  failureLine,
  finishNetworkCommand,
  networkFailure,
  openNetworkSession,
  progress
} from './query.js'

// Same wording as the backend's playback vocabulary (packages/backend/src/playback/errors.js).
// The CLI cannot import it — the backend does not export that module — so it is
// repeated here the way the app's player copy is.
const AVAILABILITY_BOUNDARY_MESSAGE = 'Unavailable - no peer currently serves the required ranges.'

// How long one chunk may take before the transfer is declared boundary-limited.
// `core.get` waits for replication forever, so without this a title nobody
// serves would hang the command instead of failing.
const DEFAULT_STALL_TIMEOUT_MS = 120_000
const PROGRESS_INTERVAL_MS = 1_000
const SIDECAR_FLUSH_BYTES = 4 * 1024 * 1024

const EXTENSIONS = new Map([
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/x-matroska', 'mkv'],
  ['video/quicktime', 'mov'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg', 'ogg']
])

function availabilityBoundary (detail = null) {
  return new NetworkCommandError('AVAILABILITY_BOUNDARY', AVAILABILITY_BOUNDARY_MESSAGE, detail)
}

function integrityMismatch (detail) {
  return new NetworkCommandError('INTEGRITY_MISMATCH', `Retrieved bytes do not match the signed rendition: ${detail}`)
}

function renditionIdOf (source) {
  return source?.renditionId || source?.availability?.renditionId || null
}

/**
 * Pick one source. The backend already ranked these with the single playback
 * selector, and `selected` is its answer — this reads that answer instead of
 * scoring sources a second time.
 */
function pickSource (sources, { publicationId, renditionId }) {
  const scoped = publicationId ? sources.filter(source => source?.publicationId === publicationId) : sources
  if (renditionId) {
    const match = scoped.find(source => renditionIdOf(source) === renditionId)
    if (!match) throw new NetworkCommandError('MEDIA_RENDITION_NOT_FOUND', `No source serves rendition "${renditionId}"`)
    return match
  }
  return scoped.find(source => source?.selected === true) ||
    scoped.find(source => renditionIdOf(source)) ||
    scoped[0] ||
    null
}

async function resolveTarget (api, target, flags) {
  let entityId = null
  let title = null
  let publicationId = null

  const entity = await api.getMediaEntity({ entityId: target })
  if (entity?.success) {
    entityId = entity.entity?.entityId || target
    title = entity.entity?.title || null
  } else {
    // A bare publication id is resolved through the same catalog projection
    // rather than a separate publication lookup.
    const match = (await collectCatalogItems(api))
      .find(item => (item.sources || []).some(source => source?.publicationId === target))
    if (!match) throw new NetworkCommandError('MEDIA_TARGET_NOT_FOUND', `No entity or publication matches "${target}"`)
    entityId = match.entityId
    title = match.title || null
    publicationId = target
  }

  const page = await api.getPublicationSources({ entityId })
  if (!page?.success) {
    throw new NetworkCommandError(
      page?.errorCode || 'MEDIA_SOURCES_UNAVAILABLE',
      page?.error || 'Publication sources are unavailable'
    )
  }

  const source = pickSource(page.items || [], { publicationId, renditionId: flags.rendition || null })
  if (!source) throw availabilityBoundary()

  const chosenRendition = flags.rendition || renditionIdOf(source)
  if (!chosenRendition) {
    throw new NetworkCommandError('MEDIA_RENDITION_UNRESOLVED', 'The selected source names no readable rendition yet')
  }

  return {
    entityId,
    title,
    publicationId: source.publicationId,
    renditionId: chosenRendition,
    availability: availabilityFacts(source.availability)
  }
}

async function openReader (api, resolved) {
  let response
  try {
    response = await api.openMediaRendition({
      publicationId: resolved.publicationId,
      renditionId: resolved.renditionId
    })
  } catch (error) {
    throw new NetworkCommandError('MEDIA_RENDITION_UNAVAILABLE', error?.message || 'The rendition could not be opened')
  }
  if (!response?.success) {
    if (response?.errorCode === 'MEDIA_RENDITION_UNAVAILABLE') throw availabilityBoundary()
    throw new NetworkCommandError(
      response?.errorCode || 'MEDIA_RENDITION_UNAVAILABLE',
      response?.error || 'The rendition could not be opened'
    )
  }
  return response
}

function slug (value) {
  const cleaned = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'peartube-download'
}

function outputPathFor (flags, resolved, contentType) {
  if (flags.output) return resolvePath(String(flags.output))
  const extension = EXTENSIONS.get(String(contentType || '').toLowerCase()) || 'bin'
  return resolvePath(`${slug(resolved.title || resolved.entityId)}.${extension}`)
}

async function discard (tempPath, sidecarPath) {
  await rm(tempPath, { force: true })
  await rm(sidecarPath, { force: true })
}

async function readSidecar (sidecarPath) {
  try {
    return JSON.parse(await readFile(sidecarPath, 'utf8'))
  } catch {
    return null
  }
}

async function hashFileInto (path, hash, byteLength) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < byteLength) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, byteLength - position), position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return position
  } finally {
    await handle.close()
  }
}

/**
 * Decide where this transfer starts. A resume only counts when the sidecar names
 * the same signed rendition and the bytes on disk still hash to what this CLI
 * wrote after reading them through the verified core; anything else is thrown
 * away rather than silently trusted.
 */
async function planResume (tempPath, sidecarPath, identity) {
  const fresh = { start: 0, hash: createHash('sha256') }
  const sidecar = await readSidecar(sidecarPath)
  if (
    !sidecar ||
    sidecar.publicationId !== identity.publicationId ||
    sidecar.renditionId !== identity.renditionId ||
    sidecar.byteLength !== identity.byteLength
  ) {
    await discard(tempPath, sidecarPath)
    return fresh
  }

  const bytesWritten = Number(sidecar.bytesWritten)
  if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > identity.byteLength) {
    await discard(tempPath, sidecarPath)
    return fresh
  }

  const info = await stat(tempPath).catch(() => null)
  if (!info?.isFile() || info.size < bytesWritten) {
    await discard(tempPath, sidecarPath)
    return fresh
  }
  // A crash between the write and the sidecar leaves the file long, not short.
  if (info.size > bytesWritten) await truncate(tempPath, bytesWritten)

  const hash = createHash('sha256')
  const hashed = await hashFileInto(tempPath, hash, bytesWritten)
  if (hashed !== bytesWritten || hash.copy().digest('hex') !== sidecar.sha256) {
    await discard(tempPath, sidecarPath)
    return fresh
  }
  return { start: bytesWritten, hash }
}

async function flushSidecar (handle, sidecarPath, identity, bytesWritten, hash) {
  await handle.sync()
  await writeFile(sidecarPath, JSON.stringify({ ...identity, bytesWritten, sha256: hash.copy().digest('hex') }))
}

// Waiting on the swarm is bounded per chunk, not per transfer: a slow but live
// peer keeps going, a title nobody serves stops.
async function nextChunk (iterator, timeoutMs) {
  const pending = iterator.next()
  pending.catch(() => {})
  let timer = null
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(availabilityBoundary()), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function streamRendition ({ context, reader, identity, tempPath, sidecarPath, start, hash, stallTimeoutMs, label }) {
  const handle = await open(tempPath, start > 0 ? 'r+' : 'w')
  let written = start
  let flushedAt = start
  let reportedAt = 0
  try {
    const iterator = reader.read({ start, length: identity.byteLength - start })[Symbol.asyncIterator]()
    try {
      while (written < identity.byteLength) {
        // A block the swarm cannot produce is the availability boundary, not a
        // generic failure. The reader's own words ride along as the detail.
        let step
        try {
          step = await nextChunk(iterator, stallTimeoutMs)
        } catch (error) {
          throw error?.errorCode ? error : availabilityBoundary(error?.message || String(error))
        }
        if (step.done) break
        const chunk = step.value
        if (!chunk || chunk.byteLength === 0) continue
        if (written + chunk.byteLength > identity.byteLength) {
          throw integrityMismatch(`the source served more than the signed ${identity.byteLength} bytes`)
        }
        await handle.write(chunk, 0, chunk.byteLength, written)
        hash.update(chunk)
        written += chunk.byteLength

        if (written - flushedAt >= SIDECAR_FLUSH_BYTES) {
          await flushSidecar(handle, sidecarPath, identity, written, hash)
          flushedAt = written
        }
        const now = Date.now()
        if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
          reportedAt = now
          progress(context, `${label}: ${Math.floor((written / identity.byteLength) * 100)}% (${written}/${identity.byteLength} bytes)`)
        }
      }
    } finally {
      // Never awaited: after a stall the generator is parked on a block read
      // that only settles once the reader below closes the core.
      Promise.resolve().then(() => iterator.return?.()).catch(() => {})
    }

    if (written !== identity.byteLength) {
      throw integrityMismatch(`expected ${identity.byteLength} bytes, retrieved ${written}`)
    }
    await handle.sync()
    return written
  } catch (error) {
    // A verified prefix is worth keeping so the next run resumes; bytes that
    // failed verification are not.
    if (error?.errorCode === 'INTEGRITY_MISMATCH' || written === 0) {
      await handle.close().catch(() => {})
      await discard(tempPath, sidecarPath)
    } else {
      await flushSidecar(handle, sidecarPath, identity, written, hash).catch(() => {})
    }
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

async function retrieve ({ context, api, resolved, flags }) {
  const reader = await openReader(api, resolved)
  try {
    const byteLength = Number(reader.byteLength)
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new NetworkCommandError('MEDIA_RENDITION_UNRESOLVED', 'The signed rendition names no readable byte length yet')
    }

    const outputPath = outputPathFor(flags, resolved, reader.contentType)
    const tempPath = `${outputPath}.part`
    const sidecarPath = `${tempPath}.json`
    const identity = {
      publicationId: resolved.publicationId,
      renditionId: resolved.renditionId,
      byteLength
    }

    await mkdir(dirname(outputPath), { recursive: true })
    const { start, hash } = await planResume(tempPath, sidecarPath, identity)
    const label = `Retrieving ${resolved.title || resolved.entityId}`
    progress(context, start > 0
      ? `${label}: resuming at ${start}/${byteLength} bytes`
      : `${label}: ${byteLength} bytes from publication ${resolved.publicationId}`)

    const stallTimeoutMs = Number.isSafeInteger(flags.timeout) && flags.timeout > 0
      ? flags.timeout * 1000
      : DEFAULT_STALL_TIMEOUT_MS

    let written = start
    if (start < byteLength) {
      written = await streamRendition({
        context, reader, identity, tempPath, sidecarPath, start, hash, stallTimeoutMs, label
      })
    }

    // Nothing is at the destination until the bytes are complete and counted
    // against the length the publisher signed.
    await rename(tempPath, outputPath)
    await rm(sidecarPath, { force: true })

    return {
      command: 'get',
      status: 'complete',
      entityId: resolved.entityId,
      publicationId: resolved.publicationId,
      renditionId: resolved.renditionId,
      contentType: reader.contentType || null,
      path: outputPath,
      byteLength,
      bytesWritten: written,
      resumedFrom: start,
      sha256: hash.digest('hex'),
      ...(resolved.availability ? { availability: resolved.availability } : {})
    }
  } finally {
    await reader.close?.()
  }
}

export async function runGetCommand (context = {}) {
  const flags = context.flags || {}
  const target = String(context.query || '').trim()
  let session = null
  try {
    if (target.length === 0) {
      throw new NetworkCommandError('INVALID_GET_TARGET', 'Get requires an entity or publication id')
    }
    progress(context, 'Joining the network...')
    session = await openNetworkSession(context)
    const resolved = await resolveTarget(session.api, target, flags)
    const result = await retrieve({ context, api: session.api, resolved, flags })
    return finishNetworkCommand(context, result, [
      `Retrieved ${result.path} (${result.bytesWritten} bytes, sha256 ${result.sha256})`
    ])
  } catch (error) {
    const result = networkFailure('get', error)
    return finishNetworkCommand(context, result, [failureLine(result)])
  } finally {
    await session?.close()
  }
}
