import { rmSync } from '#fs'
import { isArtworkRendition } from '@peartube/backend/assets'
import { assertPublicHttpUrl, parsePublicHttpUrl, PublicUrlError, URL_INVALID } from './media/public-url-guard.js'

// Machine-facing relay API, mounted beside the browser console.
//
// The console answers a submission with a 303 because a browser follows it. A
// program cannot: a redirect to success and a redirect to failure look the same,
// carry no job id, and leave nothing to poll. Every route here answers JSON with
// an explicit status instead, and shares the console's parsing and enqueue path
// so the two entry points cannot drift.
//
// Trust model: nothing here is authenticated, so the only thing standing between
// a caller and this API is how the relay is bound. Submission answers whoever
// can reach the console form on the same interface, and a caller can never name
// a path on the relay's disk.
//
// A submission is either bytes the caller uploads or a URL the relay fetches,
// and exactly one of the two. The URL form exists because the caller often
// cannot send the bytes: a client that resolved a playable link from a debrid
// provider has a source the relay can reach, and pulling gigabytes down to the
// client only to push them back up is the one thing a permissionless CDN should
// not require. This replaces the earlier rule that a submitted url was always
// refused because it "would describe bytes nobody sent" — that reasoning holds
// for a caller naming a source it never supplies, and is exactly wrong for a
// caller asking the relay to fetch a source the relay can reach itself.
//
// The console form has accepted a url since before this API existed, so URL
// ingest is not a capability the relay lacked. It is still treated here as a
// NEW one: the console is a person typing a single link, while an
// unauthenticated JSON endpoint is a general-purpose downloader any program can
// drive on a loop. So this path carries its own guard rather than inheriting
// the console's, and the console's own behaviour is left exactly as it was.
//
// That guard is SSRF, and it is the real consideration on this route: the relay
// makes the request, from inside a network the caller is not in, so a URL is an
// instruction to reach something the caller cannot reach itself. See
// media/public-url-guard.js — http(s) only, no embedded credentials, and every
// address the host RESOLVES to must be public, so a name pointed at 127.0.0.1
// is refused at the door. media/direct-download.js re-applies the same check on
// every redirect hop and against the address the socket actually connected to,
// and states plainly what remains unsolved.
//
// URL ingest is NOT behind an opt-in switch of its own, which was the
// alternative to building the guard. The guard is enforced at the door, on
// every hop and against the connected socket, so the relay only ever fetches
// public hosts; what a caller can still do is make the relay spend bandwidth
// and disk on media it did not ask for, and that is bounded by the same
// archive storage gate plus live archive-temp and persisted-volume headroom
// checks that stop console uploads filling the disk.
// A switch defaulting off would buy nothing beyond that and would make the ordinary
// case — a client seeding what it is watching — require an operator to flip it
// on every relay, which is how a switch becomes blanket-on and stops meaning
// anything.
//
// Enumeration and byte serving are gated, because they are what this API added.
// /catalog lists every publication and /stream serves its bytes; neither is a
// confidentiality leak — published media is already served to anyone holding the
// core key, which is the point of the network — but a caller no longer needs the
// key, and the relay spends its own bandwidth on the request. Fine on a trusted
// LAN, wrong on a public interface. So:
//
//   bound to loopback        -> both routes answer as they always have
//   bound anywhere else      -> both refuse 403 OPEN_ACCESS_NOT_ENABLED, naming
//                               the switch, unless the operator set it
//
// The switch is one explicit flag (--api-open / PEARTUBE_ARCHIVE_API_OPEN), and a
// bind this module cannot read counts as exposed: assuming loopback is the single
// mistake that would serve bytes to a network nobody meant to serve.

export const ARCHIVE_API_PREFIX = '/api/v1'

// The one switch that opens enumeration and byte serving on a non-loopback bind.
// Named here rather than at the call sites so the refusal, the startup line and
// the CLI help can never disagree about what an operator has to set.
export const API_OPEN_FLAG = '--api-open'
export const API_OPEN_ENV = 'PEARTUBE_ARCHIVE_API_OPEN'

// Hostnames and addresses that mean "this machine only". Anything else — a LAN
// address, 0.0.0.0, :: — is a network, and a bind that is absent or unreadable is
// treated as a network too.
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', '::1'])
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  // A config file may bracket an IPv6 literal and a link-local one carries a
  // zone; both are the same address as far as this question goes.
  const bare = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%')[0]
  if (!bare) return false
  if (LOOPBACK_HOSTNAMES.has(bare)) return true
  // Node reports the IPv4-mapped form on a dual-stack listener.
  return LOOPBACK_IPV4.test(bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare)
}

const CONTENT_KINDS = new Set(['movie', 'episode'])
// The id/title/part bounds the upload contract enforces
// (packages/backend/src/upload-video-contract.js), applied at the door so a
// malformed submission is refused before it becomes a background job that fails
// minutes later with nobody watching.
const TMDB_ID = /^[1-9][0-9]{0,19}$/
const MAX_TITLE_BYTES = 512
const MAX_EPISODE_PART = 100000
const MAX_JOB_ID_LENGTH = 128
// A JSON submission carries coordinates, not media, so a body past this is a
// caller doing something other than describing one title.
export const MAX_JSON_BODY_BYTES = 64 * 1024
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
// How many distinct catalog pages a relay keeps as its last known-good answer.
// A polling client reads the first page; the rest are there so paging through a
// stall does not restart from nothing.
const MAX_CACHED_CATALOG_PAGES = 8
// A rendition open resolves the manifest and takes custody of the core; it must
// not hold the caller's connection open if the runtime is wedged.
const STREAM_OPEN_DEADLINE_MS = 10_000
const DEADLINE_EXPIRED = Symbol('deadline-expired')

function withDeadline(promise, timeoutMs) {
  let timer = null
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE_EXPIRED), timeoutMs) })
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

// The gate, decided from the bind alone. Shared so the warming surface a
// starting relay answers from refuses exactly what a started relay refuses: a
// relay that is not ready yet must never be the easier way in.
export function createOpenAccessGate({ bindHost = null, apiOpen = false } = {}) {
  const exposed = !isLoopbackHost(bindHost)
  const allowed = !exposed || Boolean(apiOpen)
  const boundTo = typeof bindHost === 'string' && bindHost.trim() ? bindHost.trim() : 'every interface'
  return {
    exposed,
    enabled: allowed && exposed,
    boundTo,
    flag: API_OPEN_FLAG,
    env: API_OPEN_ENV,
    // A refusal that does not name the switch is a support ticket, so the
    // message carries both spellings of it and the bind that triggered it.
    refusal: allowed
      ? null
      : invalid(
        'OPEN_ACCESS_NOT_ENABLED',
        `the relay is bound to ${boundTo} rather than loopback, so ${ARCHIVE_API_PREFIX}/catalog and ${ARCHIVE_API_PREFIX}/stream refuse to enumerate or serve media; restart the relay with ${API_OPEN_FLAG} (or ${API_OPEN_ENV}=1) to serve media bytes to this network`,
        null,
        403
      )
  }
}

// The two routes the switch guards: enumeration and byte serving, the half of
// this API a key holder did not already have.
export function isGatedArchiveApiRoute(path) {
  return path === '/catalog' || String(path || '').startsWith('/stream/')
}

// The sub-path under the prefix, or null when the request is not ours.
export function archiveApiRoute(url) {
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
//
// Synchronous by design — every check that does not need the network lives
// here, and the one that does (resolving the source host) runs in postArchive
// against the url this hands back.
export function normalizeArchiveSubmission(fields = {}, file = null) {
  const submittedUrl = text(fields, 'url')
  // A file and a url are two different answers to "where are the bytes", and
  // honouring one would silently discard the other.
  if (file && submittedUrl) {
    return invalid('AMBIGUOUS_SOURCE', 'a submission carries either a multipart file or a url, never both', 'url')
  }
  if (!file && !submittedUrl) {
    return invalid('SOURCE_REQUIRED', 'a submission requires either a multipart file part or a url the relay can fetch', 'url')
  }

  let remoteSource = null
  if (submittedUrl) {
    try {
      remoteSource = parsePublicHttpUrl(submittedUrl).toString()
    } catch (err) {
      if (!(err instanceof PublicUrlError)) throw err
      return invalid(err.code, err.message, 'url')
    }
  }

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
    // The url still needs its host resolved before anything is enqueued; the
    // caller of this function owns that step.
    remoteSource,
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
      // free text: a submitted source id would name a different title than the
      // one checked. The url is the sole exception, and only after the guard
      // has cleared it — it says where the bytes are, never who they are.
      url: remoteSource || '',
      sourceUrl: '',
      sourceVideoId: '',
      // Marks the job as fetching a stranger's url, which makes the downloader
      // re-check every redirect hop and enforce live storage headroom while it streams.
      requirePublicSource: Boolean(remoteSource)
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

// The rendition behind one source, read off the publication's signed asset
// manifest. A catalog page carries renditions only when it is served straight
// from the media graph; through the consumer projection every device uses, it
// does not, and the manifest is where those bytes are named.
//
// A source that arrives without a renditionId is resolved to the publication's
// primary rendition rather than left unresolvable. That case is not exotic — it
// is every episode. The projection lists the SERIES entity, while the
// publication's availability claim is anchored to the EPISODE entity, so the
// per-entity source lookup below asks about a subject that holds no claim and
// comes back empty. Picking the first playable rendition is what the media graph
// itself does when it builds a source (api/media-graph.js:301), so this agrees
// with the graph rather than inventing a second rule.
function isPlayableRendition(rendition) {
  return Boolean(
    rendition?.renditionId &&
    rendition.blocked !== true &&
    rendition.superseded !== true &&
    !isArtworkRendition(rendition)
  )
}

function manifestRendition(assetManifest, source) {
  if (typeof assetManifest !== 'function' || !source?.publicationId) return null
  const renditions = assetManifest(source.publicationId)?.body?.renditions || []
  const rendition = source.renditionId
    ? renditions.find((candidate) => candidate?.renditionId === source.renditionId)
    : renditions.find(isPlayableRendition)
  if (!rendition) return null
  return {
    renditionId: rendition.renditionId || null,
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
    if (page !== DEADLINE_EXPIRED && page?.success === true && page.items?.length > 0) sources = page.items
  }

  return sources.map((source) => {
    const rendition = renditions.get(source?.renditionId) || manifestRendition(assetManifest, source)
    return {
      publicationId: source?.publicationId || null,
      publisherId: source?.publisherId || null,
      // A publication with no resolvable rendition is worse than absent: a
      // consumer drops the source (it cannot address the stream route) while the
      // seeder's own catalog check reads the title as unseeded and re-seeds it.
      renditionId: source?.renditionId || rendition?.renditionId || null,
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

// One byte range, which is the only form a seeking player sends. A header this
// does not understand is ignored rather than refused (RFC 9110: an unsatisfiable
// range is a 416, an unparseable one is not a range at all), so a caller that
// asks for something exotic still gets the whole rendition.
export function parseByteRange(header, byteLength) {
  if (typeof header !== 'string') return null
  const match = /^bytes=([0-9]*)-([0-9]*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  // `bytes=-N`: the last N bytes. A suffix longer than the rendition is the whole
  // rendition, never an error.
  if (rawStart === '') {
    const suffix = uint(rawEnd)
    if (!suffix) return null
    if (byteLength === 0) return { unsatisfiable: true }
    return { start: Math.max(0, byteLength - suffix), end: byteLength - 1 }
  }

  const start = uint(rawStart)
  if (start === null) return null
  if (start >= byteLength) return { unsatisfiable: true }
  const requestedEnd = rawEnd === '' ? byteLength - 1 : uint(rawEnd)
  if (requestedEnd === null) return null
  const end = Math.min(requestedEnd, byteLength - 1)
  if (end < start) return { unsatisfiable: true }
  return { start, end }
}

// Map a submission-parsing failure onto a status a client can act on. The
// multipart receiver and the JSON reader report these as plain errors; without
// the mapping every one of them would read as a generic 500 that the caller
// cannot distinguish from a relay bug.
function submissionFailure(err) {
  const message = err?.message || String(err)
  // JSON is checked first: its own oversize message would otherwise be read as
  // an oversize upload and blamed on a file part the caller never sent.
  if (/json body exceeds/i.test(message)) {
    return invalid('PAYLOAD_TOO_LARGE', message, null, 413)
  }
  if (/json body/i.test(message)) {
    return invalid('INVALID_JSON', message, null, 400)
  }
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

export function createArchiveApi({ readSubmission, enqueue, store, mediaCatalog, publicationSources = null, assetManifest = null, openRendition = null, bindHost = null, apiOpen = false, lookup = null, logger = null }) {
  if (typeof readSubmission !== 'function') throw new Error('readSubmission is required')
  if (typeof enqueue !== 'function') throw new Error('enqueue is required')
  if (!store) throw new Error('store is required')

  // Decided once, at construction: the bind cannot change while the server is
  // listening, and a per-request re-check would only invite a way to skip it.
  const openAccess = createOpenAccessGate({ bindHost, apiOpen })
  const openAccessRefusal = openAccess.refusal

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
      sendError(res, submissionFailure(err))
      return
    }

    const normalized = normalizeArchiveSubmission(submission.fields, submission.file)
    if (normalized.error) {
      discardStagedUpload(submission.file)
      sendError(res, normalized)
      return
    }

    // Resolving the host is the half of the guard that needs the network, and
    // it runs before the enqueue: a job that exists is a job that will be
    // fetched, so a url pointed at the operator's LAN must never become one.
    if (normalized.remoteSource) {
      try {
        await assertPublicHttpUrl(normalized.remoteSource, lookup ? { lookup } : {})
      } catch (err) {
        if (!(err instanceof PublicUrlError)) throw err
        sendError(res, invalid(err.code || URL_INVALID, err.message, 'url'))
        return
      }
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

  // The last page the media graph actually produced, per page key.
  //
  // A catalog read walks every bound publisher catalog, so a single publisher
  // waiting on a peer stalls the read for everyone. The deadline below keeps
  // that from holding the caller's connection open, but a relay whose graph
  // stalls would then answer 503 forever, and a client cannot tell "this relay
  // has published nothing" from "this relay is stuck". Answering with what the
  // graph last said — marked stale, so nobody mistakes it for a live read —
  // keeps a polling client working through a stall it can do nothing about.
  const lastGoodPages = new Map()

  function rememberPage(key, payload) {
    lastGoodPages.delete(key)
    lastGoodPages.set(key, payload)
    // Cursors are caller-supplied, so the cache is bounded by eviction rather
    // than by trusting whoever is paging.
    while (lastGoodPages.size > MAX_CACHED_CATALOG_PAGES) {
      lastGoodPages.delete(lastGoodPages.keys().next().value)
    }
  }

  function sendLastGoodPage(res, key) {
    const cached = lastGoodPages.get(key)
    if (!cached) return false
    const staleForMs = Date.now() - cached.updatedAt
    logger?.archive?.warn?.('Relay media catalog answered from its last good read', { staleForMs })
    send(res, 200, { ...cached, stale: true, staleForMs })
    return true
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

    const pageKey = `${request.cursor || ''}|${request.limit || ''}`
    const page = await withDeadline(mediaCatalog(request), CATALOG_DEADLINE_MS)
    if (page === DEADLINE_EXPIRED) {
      logger?.archive?.warn?.('Relay media catalog read timed out', { timeoutMs: CATALOG_DEADLINE_MS })
      if (sendLastGoodPage(res, pageKey)) return
      sendError(res, invalid('CATALOG_TIMEOUT', `relay media catalog did not answer within ${CATALOG_DEADLINE_MS}ms; retry`, null, 503))
      return
    }
    if (!page) {
      if (sendLastGoodPage(res, pageKey)) return
      sendError(res, invalid('CATALOG_UNAVAILABLE', 'relay media catalog is not available yet', null, 503))
      return
    }
    if (page.success !== true) {
      const code = page.errorCode || 'CATALOG_UNAVAILABLE'
      // A malformed request is the caller's to fix and must never be answered
      // with a cached page; a relay-side failure is what the cache is for.
      if (code === 'INVALID_CURSOR' || code === 'INVALID_LIMIT') {
        const field = code === 'INVALID_CURSOR' ? 'cursor' : 'limit'
        sendError(res, invalid(code, page.error || 'relay media catalog is unavailable', field, 400))
        return
      }
      if (sendLastGoodPage(res, pageKey)) return
      sendError(res, invalid(code, page.error || 'relay media catalog is unavailable', null, 503))
      return
    }
    const payload = {
      schema: 'peartube.relayMediaCatalog',
      version: 1,
      updatedAt: Date.now(),
      entities: await Promise.all((page.items || []).map((item) => portableCatalogEntity(item, { publicationSources, assetManifest }))),
      nextCursor: page.nextCursor || null
    }
    rememberPage(pageKey, payload)
    send(res, 200, payload)
  }

  // Backpressure matters here in a way it does not for a JSON body: a rendition
  // is a film, and writing it faster than the socket drains would buffer it all
  // in the relay's memory.
  async function writeChunk(res, chunk) {
    if (res.write(chunk) !== false) return
    await new Promise((resolve) => {
      const done = () => {
        res.off?.('drain', done)
        res.off?.('close', done)
        res.off?.('error', done)
        resolve()
      }
      res.once('drain', done)
      res.once('close', done)
      res.once('error', done)
    })
  }

  // Serve one published rendition's bytes.
  //
  // The catalog names cores, which only a PearTube node can resolve. A consumer
  // that is not one - a media server, a browser, a player asking for byte ranges
  // - needs an origin it can range-request, and the relay's own blob server
  // answers on 127.0.0.1, so it cannot be that origin for anyone else. This is.
  //
  // Trust model: unauthenticated, so the dispatch below only reaches this on a
  // loopback bind or with the operator's switch set. Whoever gets here can read
  // what the relay has published.
  async function getStream(req, res, publicationId, renditionId) {
    if (typeof openRendition !== 'function') {
      sendError(res, invalid('MEDIA_GRAPH_UNAVAILABLE', 'relay media graph is not bound yet', null, 503))
      return
    }

    const opened = await withDeadline(openRendition({ publicationId, renditionId }), STREAM_OPEN_DEADLINE_MS)
    if (opened === DEADLINE_EXPIRED) {
      logger?.archive?.warn?.('Relay rendition open timed out', { publicationId, renditionId, timeoutMs: STREAM_OPEN_DEADLINE_MS })
      sendError(res, invalid('STREAM_TIMEOUT', `relay media graph did not open ${publicationId}/${renditionId} within ${STREAM_OPEN_DEADLINE_MS}ms; retry`, null, 503))
      return
    }
    if (!opened) {
      sendError(res, invalid('MEDIA_GRAPH_UNAVAILABLE', 'relay media graph is not bound yet', null, 503))
      return
    }
    if (opened.success !== true) {
      // A publication or rendition this relay does not hold is the caller's
      // mistake (404); anything else is the relay not being ready (503).
      const code = opened.errorCode || 'MEDIA_GRAPH_UNAVAILABLE'
      const missing = code === 'MEDIA_PUBLICATION_NOT_FOUND' || code === 'MEDIA_RENDITION_NOT_FOUND'
      sendError(res, invalid(code, opened.error || `no rendition ${renditionId} on publication ${publicationId}`, null, missing ? 404 : 503))
      return
    }

    try {
      const byteLength = uint(opened.byteLength)
      if (byteLength === null) {
        sendError(res, invalid('MEDIA_RENDITION_UNRESOLVED', `rendition ${renditionId} declares no byte length yet`, null, 503))
        return
      }
      const contentType = typeof opened.contentType === 'string' && opened.contentType ? opened.contentType : 'video/mp4'
      const range = parseByteRange(req.headers?.range, byteLength)
      if (range?.unsatisfiable) {
        sendError(
          res,
          invalid('RANGE_NOT_SATISFIABLE', `requested range is outside the ${byteLength} bytes of rendition ${renditionId}`, null, 416),
          { 'accept-ranges': 'bytes', 'content-range': `bytes */${byteLength}` }
        )
        return
      }

      const start = range ? range.start : 0
      const end = range ? range.end : Math.max(0, byteLength - 1)
      const length = byteLength === 0 ? 0 : end - start + 1
      const headers = {
        'content-type': contentType,
        'content-length': String(length),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store'
      }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${byteLength}`
      res.writeHead(range ? 206 : 200, headers)
      if (length === 0) {
        res.end()
        return
      }

      // The blocks behind this window may still be replicating; the reader waits
      // on each one, so the response streams as the bytes land rather than
      // failing because the relay has not finished pulling the title.
      for await (const chunk of opened.read({ start, length })) {
        if (res.writableEnded || res.destroyed) break
        await writeChunk(res, chunk)
      }
      if (!res.writableEnded && !res.destroyed) res.end()
    } catch (err) {
      logger?.archive?.error?.('Relay rendition stream failed', { publicationId, renditionId, error: err?.message || String(err) })
      // Once a body has started there is no status left to send: cutting the
      // response is what tells the client the range is incomplete.
      if (res.headersSent) {
        try { res.destroy?.() } catch { /* best effort */ }
        return
      }
      sendError(res, invalid('STREAM_FAILED', err?.message || String(err), null, 503))
    } finally {
      await opened.close?.()
    }
  }

  function jobIdFrom(path) {
    const raw = path.slice('/archive/'.length)
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  // /stream/<publicationId>/<renditionId> — both coordinates, exactly as the
  // catalog reported them.
  function streamTargetFrom(path) {
    const segments = path.slice('/stream/'.length).split('/')
    if (segments.length !== 2) return null
    const [publicationId, renditionId] = segments.map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    if (!publicationId || !renditionId) return null
    return { publicationId, renditionId }
  }

  return {
    prefix: ARCHIVE_API_PREFIX,
    // How the gated routes will answer, so whatever started this server can say
    // so once at boot instead of leaving an operator to discover it as a 403.
    openAccess,
    owns(url) {
      return archiveApiRoute(url) !== null
    },
    // Answers every /api/v1 request itself, including its own failures: an
    // unknown path or a wrong method must not fall through to the HTML console,
    // which would hand a program a page it cannot read.
    async handle(req, res) {
      const path = archiveApiRoute(req.url)
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
          // Enumeration is the half of this API that a key holder did not
          // already have; on an exposed relay it waits for the switch.
          if (openAccessRefusal) {
            sendError(res, openAccessRefusal)
            return
          }
          await getCatalog(res, new URL(req.url, 'http://relay.local').searchParams)
          return
        }

        if (path.startsWith('/stream/')) {
          if (req.method !== 'GET') {
            sendError(res, invalid('METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${ARCHIVE_API_PREFIX}/stream/:publicationId/:renditionId`, null, 405), { allow: 'GET' })
            return
          }
          if (openAccessRefusal) {
            sendError(res, openAccessRefusal)
            return
          }
          const target = streamTargetFrom(path)
          if (!target) {
            sendError(res, invalid('NOT_FOUND', `stream requests are ${ARCHIVE_API_PREFIX}/stream/:publicationId/:renditionId`, null, 404))
            return
          }
          await getStream(req, res, target.publicationId, target.renditionId)
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
