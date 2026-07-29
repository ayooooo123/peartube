import { rmSync } from '#fs'

// Machine-facing relay API, mounted beside the browser console.
//
// The console answers a submission with a 303 because a browser follows it. A
// program cannot: a redirect to success and a redirect to failure look the same,
// carry no job id, and leave nothing to poll. Every route here answers JSON with
// an explicit status instead, and shares the console's parsing and enqueue path
// so the two entry points cannot drift.
//
// Trust model: identical to the console this is mounted beside — the relay's
// HTTP surface is unauthenticated, so whoever can reach the console can reach
// this. Nothing here widens that. A caller submits the bytes it wants published
// and can never name a path on the relay's disk.

export const ARCHIVE_API_PREFIX = '/api/v1'

const CONTENT_KINDS = new Set(['movie', 'episode'])
// The id/title/part bounds the upload contract enforces
// (packages/backend/src/upload-video-contract.js), applied at the door so a
// malformed submission is refused before it becomes a background job that fails
// minutes later with nobody watching.
const TMDB_ID = /^[1-9][0-9]{0,19}$/
const MAX_TITLE_BYTES = 512
const MAX_EPISODE_PART = 100000
const MAX_JOB_ID_LENGTH = 128
// The media graph's own ceiling for a source page (MAX_PAGE_LIMIT), asked for
// explicitly so an entity with many publishers is not silently truncated to the
// default 50.
const MAX_SOURCE_PAGE_LIMIT = 100
// Both catalog implementations bound a page at 1..50 (MAX_CATALOG_PAGE_LIMIT and
// the consumer projection's CONSUMER_MAX_LIMIT). Checked here because the
// consumer projection reports an out-of-range limit as its own update failure,
// which would tell the caller the relay is broken instead of naming the field.
const MAX_CATALOG_PAGE_LIMIT = 50
// A catalog read walks every bound publisher catalog, and one that is waiting on
// a peer can wait indefinitely. Observed on a live relay: /api/v1/catalog held
// the connection open forever while an unfinished catalog walk blocked the
// projection rebuild. A caller polling for what has been published needs an
// answer it can retry, so the read gets a deadline.
const CATALOG_DEADLINE_MS = 10_000
const CATALOG_TIMEOUT = Symbol('catalog-timeout')

function withDeadline(promise, timeoutMs) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(CATALOG_TIMEOUT), timeoutMs) })
  ]).then((value) => {
    clearTimeout(timer)
    return value
  }, (err) => {
    clearTimeout(timer)
    throw err
  })
}

function text(fields, name) {
  const value = fields?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

function episodePart(value) {
  if (!/^[0-9]{1,6}$/.test(value)) return null
  const part = Number(value)
  return part >= 1 && part <= MAX_EPISODE_PART ? part : null
}

function uint(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function invalid(code, message, field = null, status = 400) {
  return { status, error: { code, message, field } }
}

// The canonical work key the publisher will derive from these coordinates (see
// upload.js `workIdentifier`). It is the name two uploads of the same title
// already agree on, so a caller can correlate its submission with the entity
// that appears in /api/v1/catalog before the job has finished publishing.
export function deriveEntityHint({ contentKind, tmdbId, tmdbSeason, tmdbEpisode }) {
  return contentKind === 'episode'
    ? `show:${tmdbId}:s${tmdbSeason}:e${tmdbEpisode}`
    : `movie:${tmdbId}`
}

// Validate a parsed submission and map it onto the console's archive form.
// Everything is checked here, BEFORE anything is enqueued: a half-specified
// episode that reached the pipeline would publish under the wrong identity or
// fail deep inside a job the caller can no longer correct.
export function normalizeArchiveSubmission(fields = {}, file = null) {
  if (!file) return invalid('FILE_REQUIRED', 'a multipart file part carrying the media bytes is required', 'file')

  const contentKind = text(fields, 'contentKind')
  if (!CONTENT_KINDS.has(contentKind)) {
    return invalid('INVALID_CONTENT_KIND', "contentKind must be 'movie' or 'episode'", 'contentKind')
  }

  const tmdbId = text(fields, 'tmdbId')
  if (!TMDB_ID.test(tmdbId)) {
    return invalid('INVALID_TMDB_ID', 'tmdbId must be a positive TMDB integer id', 'tmdbId')
  }

  const tmdbTitle = text(fields, 'tmdbTitle')
  if (!tmdbTitle || Buffer.byteLength(tmdbTitle) > MAX_TITLE_BYTES) {
    return invalid('INVALID_TMDB_TITLE', `tmdbTitle is required and must be at most ${MAX_TITLE_BYTES} bytes`, 'tmdbTitle')
  }

  let tmdbSeason = null
  let tmdbEpisode = null
  if (contentKind === 'episode') {
    tmdbSeason = episodePart(text(fields, 'tmdbSeason'))
    if (!tmdbSeason) {
      return invalid('INVALID_SEASON', `an episode upload requires tmdbSeason as an integer between 1 and ${MAX_EPISODE_PART}`, 'tmdbSeason')
    }
    tmdbEpisode = episodePart(text(fields, 'tmdbEpisode'))
    if (!tmdbEpisode) {
      return invalid('INVALID_EPISODE', `an episode upload requires tmdbEpisode as an integer between 1 and ${MAX_EPISODE_PART}`, 'tmdbEpisode')
    }
  } else {
    for (const field of ['tmdbSeason', 'tmdbEpisode']) {
      if (text(fields, field)) return invalid('UNEXPECTED_FIELD', `a movie upload cannot carry ${field}`, field)
    }
  }

  return {
    entityHint: deriveEntityHint({ contentKind, tmdbId, tmdbSeason, tmdbEpisode }),
    // Overrides on top of the console's own form. `tmdbType` is the vocabulary
    // the pipeline speaks; the catalogue title also names the grouped channel,
    // exactly as the console's Discover form does, so both entry points land in
    // one channel per title instead of two.
    form: {
      tmdbType: contentKind === 'episode' ? 'tv' : 'movie',
      tmdbId,
      tmdbTitle,
      tmdbSeason: tmdbSeason ? String(tmdbSeason) : '',
      tmdbEpisode: tmdbEpisode ? String(tmdbEpisode) : '',
      channelName: text(fields, 'channelName') || tmdbTitle,
      title: text(fields, 'title') || tmdbTitle,
      sourceType: 'tmdb',
      // Identity comes from the validated coordinates above, never from caller
      // free text: a submitted url would describe bytes nobody sent, and a
      // submitted source id would name a different title than the one checked.
      url: '',
      sourceUrl: '',
      sourceVideoId: ''
    }
  }
}

// Portable source references for a completed job: what a remote node needs to
// find and replicate the bytes itself. Never a loopback blob URL — that is this
// relay's own address and means nothing on the caller's machine.
export function jobSourceReference(job) {
  const publication = job?.previewVideo?.immutablePublication
  if (!publication?.publicationId) return null
  const rendition = (publication.manifest?.body?.renditions || [])
    .find((candidate) => candidate.renditionId === publication.renditionId)
  return {
    entityId: publication.entityRef || null,
    publicationId: String(publication.publicationId),
    manifestId: publication.manifestId ? String(publication.manifestId) : null,
    publisherId: publication.publisherId ? String(publication.publisherId) : (job.publisherId || null),
    renditionId: publication.renditionId ? String(publication.renditionId) : null,
    coreKey: rendition?.core?.key || null,
    coreLength: uint(rendition?.core?.length),
    byteLength: uint(rendition?.core?.byteLength)
  }
}

// The core behind one source, read off the publication's signed asset manifest.
// A catalog page carries renditions only when it is served straight from the
// media graph; through the consumer projection every device uses, it does not,
// and the manifest is where those bytes are named.
function manifestRendition(assetManifest, source) {
  if (typeof assetManifest !== 'function' || !source?.publicationId || !source?.renditionId) return null
  const rendition = (assetManifest(source.publicationId)?.body?.renditions || [])
    .find((candidate) => candidate.renditionId === source.renditionId)
  if (!rendition) return null
  return {
    coreKey: rendition.core?.key || null,
    coreLength: rendition.core?.length,
    byteLength: rendition.core?.byteLength
  }
}

// One entity's sources as references a remote node can act on.
//
// Deliberately no playback URL: the relay's blob server answers on
// http://127.0.0.1:<port>, which is unreachable and meaningless off this box. A
// consuming node resolves bytes through its own PearTube node from these
// references.
export async function portableEntitySources(item, { publicationSources = null, assetManifest = null } = {}) {
  const renditions = new Map((item?.renditions || [])
    .filter((rendition) => rendition?.renditionId)
    .map((rendition) => [rendition.renditionId, rendition]))

  let sources = item?.sources || []
  // The consumer projection reports which publications exist but not which
  // rendition each one offers. The source list does, so ask for it rather than
  // handing the caller a publication it cannot resolve to bytes.
  if (item?.entityId && typeof publicationSources === 'function' && sources.some((source) => !source?.renditionId)) {
    const page = await withDeadline(
      publicationSources({ entityId: item.entityId, limit: MAX_SOURCE_PAGE_LIMIT, limitProvided: true }),
      CATALOG_DEADLINE_MS
    )
    // A source list that has not arrived leaves the publication as the page
    // reported it, rather than holding the whole page open for one entity.
    if (page !== CATALOG_TIMEOUT && page?.success === true && page.items?.length > 0) sources = page.items
  }

  return sources.map((source) => {
    const rendition = renditions.get(source?.renditionId) || manifestRendition(assetManifest, source)
    return {
      publicationId: source?.publicationId || null,
      publisherId: source?.publisherId || null,
      renditionId: source?.renditionId || null,
      coreKey: rendition?.coreKey || null,
      coreLength: uint(rendition?.coreLength),
      byteLength: uint(rendition?.byteLength)
    }
  })
}

export async function portableCatalogEntity(item, resolvers = {}) {
  return {
    entityId: item?.entityId || null,
    entityKind: item?.entityKind || 'unknown',
    title: item?.title || null,
    year: uint(item?.releaseYear),
    sources: await portableEntitySources(item, resolvers)
  }
}

// Map a submission-parsing failure onto a status a client can act on. The
// multipart receiver reports these as plain errors; without the mapping every
// one of them would read as a generic 500 that the caller cannot distinguish
// from a relay bug.
function multipartFailure(err) {
  const message = err?.message || String(err)
  if (/exceeds max size|field too large/i.test(message)) {
    return invalid('PAYLOAD_TOO_LARGE', message, 'file', 413)
  }
  if (/upload directory is not configured/i.test(message)) {
    return invalid('UPLOAD_DIR_UNAVAILABLE', message, null, 503)
  }
  if (/boundary|malformed multipart/i.test(message)) {
    return invalid('MALFORMED_MULTIPART', message, null, 400)
  }
  return invalid('INVALID_MULTIPART', message, null, 400)
}

export function createArchiveApi({ readSubmission, enqueue, store, mediaCatalog, publicationSources = null, assetManifest = null, logger = null }) {
  if (typeof readSubmission !== 'function') throw new Error('readSubmission is required')
  if (typeof enqueue !== 'function') throw new Error('enqueue is required')
  if (!store) throw new Error('store is required')

  function send(res, status, body, headers = {}) {
    // No CORS headers: this is a server-to-server API on an unauthenticated
    // relay, so nothing here should be callable from a page the operator did
    // not open themselves.
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(body, null, 2))
  }

  function sendError(res, { status, error }, headers = {}) {
    send(res, status, { error }, headers)
  }

  // A submission refused after its bytes were staged must not leave them
  // behind: an unauthenticated caller could otherwise fill the relay's disk
  // with rejected uploads.
  function discardStagedUpload(file) {
    if (!file?.dir) return
    try {
      rmSync(file.dir, { recursive: true, force: true })
    } catch (err) {
      logger?.archive?.warn?.('Discarding a rejected upload failed', { error: err?.message || String(err) })
    }
  }

  async function postArchive(req, res) {
    let submission = null
    try {
      submission = await readSubmission(req)
    } catch (err) {
      sendError(res, multipartFailure(err))
      return
    }

    const normalized = normalizeArchiveSubmission(submission.fields, submission.file)
    if (normalized.error) {
      discardStagedUpload(submission.file)
      sendError(res, normalized)
      return
    }

    const job = await enqueue({ ...submission.form, ...normalized.form }, submission.file)
    send(res, 202, { jobId: job.id, status: job.status, entityHint: normalized.entityHint })
  }

  async function getJob(res, jobId) {
    if (!jobId || jobId.length > MAX_JOB_ID_LENGTH) {
      sendError(res, invalid('JOB_NOT_FOUND', `no archive job with id ${JSON.stringify(jobId)}`, 'jobId', 404))
      return
    }
    const job = (await store.listJobs()).find((candidate) => candidate.id === jobId)
    if (!job) {
      sendError(res, invalid('JOB_NOT_FOUND', `no archive job with id ${JSON.stringify(jobId)}`, 'jobId', 404))
      return
    }
    send(res, 200, {
      jobId: job.id,
      status: job.status,
      title: job.title || null,
      error: job.error || null,
      source: jobSourceReference(job)
    })
  }

  async function getCatalog(res, searchParams) {
    if (typeof mediaCatalog !== 'function') {
      sendError(res, invalid('CATALOG_UNAVAILABLE', 'relay media catalog is not available yet', null, 503))
      return
    }
    // Pagination is the media graph's own: cursor plus limit, and its bounds
    // stay its business rather than being re-guessed here.
    const request = {}
    const cursor = searchParams.get('cursor')
    if (cursor) request.cursor = cursor
    const limit = searchParams.get('limit')
    if (limit !== null) {
      const parsed = Number(limit)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CATALOG_PAGE_LIMIT) {
        sendError(res, invalid('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_CATALOG_PAGE_LIMIT}`, 'limit'))
        return
      }
      request.limit = parsed
      request.limitProvided = true
    }

    const page = await withDeadline(mediaCatalog(request), CATALOG_DEADLINE_MS)
    if (page === CATALOG_TIMEOUT) {
      logger?.archive?.warn?.('Relay media catalog read timed out', { timeoutMs: CATALOG_DEADLINE_MS })
      sendError(res, invalid('CATALOG_TIMEOUT', `relay media catalog did not answer within ${CATALOG_DEADLINE_MS}ms; retry`, null, 503))
      return
    }
    if (!page) {
      sendError(res, invalid('CATALOG_UNAVAILABLE', 'relay media catalog is not available yet', null, 503))
      return
    }
    if (page.success !== true) {
      const code = page.errorCode || 'CATALOG_UNAVAILABLE'
      const status = code === 'INVALID_CURSOR' || code === 'INVALID_LIMIT' ? 400 : 503
      const field = code === 'INVALID_CURSOR' ? 'cursor' : (code === 'INVALID_LIMIT' ? 'limit' : null)
      sendError(res, invalid(code, page.error || 'relay media catalog is unavailable', field, status))
      return
    }
    send(res, 200, {
      schema: 'peartube.relayMediaCatalog',
      version: 1,
      updatedAt: Date.now(),
      entities: await Promise.all((page.items || []).map((item) => portableCatalogEntity(item, { publicationSources, assetManifest }))),
      nextCursor: page.nextCursor || null
    })
  }

  // The sub-path under the prefix, or null when the request is not ours.
  function route(url) {
    let pathname = null
    try {
      pathname = new URL(String(url || '/'), 'http://relay.local').pathname
    } catch {
      // An unparseable request target was never ours; leave it to the console so
      // this dispatch cannot change how any existing route answers.
      return null
    }
    if (pathname === ARCHIVE_API_PREFIX) return '/'
    if (!pathname.startsWith(`${ARCHIVE_API_PREFIX}/`)) return null
    return pathname.slice(ARCHIVE_API_PREFIX.length)
  }

  function jobIdFrom(path) {
    const raw = path.slice('/archive/'.length)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  return {
    prefix: ARCHIVE_API_PREFIX,
    owns(url) {
      return route(url) !== null
    },
    // Answers every /api/v1 request itself, including its own failures: an
    // unknown path or a wrong method must not fall through to the HTML console,
    // which would hand a program a page it cannot read.
    async handle(req, res) {
      const path = route(req.url)
      try {
        if (path === '/archive') {
          if (req.method !== 'POST') {
            sendError(res, invalid('METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${ARCHIVE_API_PREFIX}/archive`, null, 405), { allow: 'POST' })
            return
          }
          await postArchive(req, res)
          return
        }

        if (path.startsWith('/archive/')) {
          if (req.method !== 'GET') {
            sendError(res, invalid('METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${ARCHIVE_API_PREFIX}/archive/:jobId`, null, 405), { allow: 'GET' })
            return
          }
          await getJob(res, jobIdFrom(path))
          return
        }

        if (path === '/catalog') {
          if (req.method !== 'GET') {
            sendError(res, invalid('METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${ARCHIVE_API_PREFIX}/catalog`, null, 405), { allow: 'GET' })
            return
          }
          await getCatalog(res, new URL(req.url, 'http://relay.local').searchParams)
          return
        }

        sendError(res, invalid('NOT_FOUND', `no such endpoint: ${ARCHIVE_API_PREFIX}${path}`, null, 404))
      } catch (err) {
        logger?.archive?.error?.('Relay API request failed', { url: req.url, error: err?.message || String(err) })
        sendError(res, invalid('INTERNAL_ERROR', err?.message || String(err), null, 500))
      }
    }
  }
}
