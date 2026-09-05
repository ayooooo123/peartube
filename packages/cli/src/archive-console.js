import { createServer } from '#http'
import { createReadStream, rmSync, statSync } from '#fs'
import { basename, dirname, relative, resolve } from '#path'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { isArtworkRendition } from '@peartube/backend/assets'
import { renderArchiveTui, renderArchiveWebHome } from './archive-ui.js'
import { renderReleaseConsole, renderReleaseRows } from './release-console-ui.js'
import { resolveTmdbOptions } from './settings.js'
import { parseBoundary, receiveMultipartUpload } from './multipart.js'
// The relay's own HTTP client rather than fetch(): Bare ships no global fetch,
// so a fetch() here would be a ReferenceError the moment the relay runs.
import { openResponse, readBody } from './media/http-get.js'


// Rendered as a banner after a submission that carried neither a file nor a
// source URL, so an ignored form is visibly ignored.
const EMPTY_SUBMISSION_NOTICE = 'Nothing was archived: attach a video file or paste a source URL first.'
const EMPTY_SUBMISSION_QUERY = 'notice=empty-submission'

// One row of the operator console: a release is a file this relay archived or
// is archiving, not a title. A work groups releases; it is a column, never the
// row. States are the acquisition's own vocabulary plus `seeding`, which is a
// published release with verified local bytes and no job left to run.
const RELEASE_STATES = new Set(['queued', 'acquiring', 'verifying', 'publishing', 'seeding', 'completed', 'failed', 'cancelled'])
const RELEASE_SORTS = new Set(['attention', 'file', 'work', 'size', 'progress', 'state', 'reach', 'backups', 'residency', 'age'])
const ATTENTION_RANK = { acquiring: 0, verifying: 0, publishing: 0, queued: 1, failed: 2, cancelled: 4, seeding: 3, completed: 3 }
const MAX_RELEASE_PAGE = 200
const TERMINAL_RELEASE_STATES = new Set(['completed', 'failed', 'cancelled'])

// An operator reads "why did nothing happen", not a stack. The provider's own
// error code is kept because it is the one thing that names the refusal.
function friendlyVerbError(error) {
  const code = error?.code || error?.errorCode
  if (code === 'ACQUISITION_JOB_ACTIVE') return 'still running: cancel it first'
  return code ? String(code) : (error?.message || 'the relay refused it')
}

// Coordinates arrive in two shapes: the acquisition's own media context
// (`season`/`episode`/`namespace`), and the catalog source's signed
// `mediaCoordinates` (`seasonNumber`/`episodeNumber`/`mediaProvider`). One
// normalizer so a catalogued episode reads the same as one this relay fetched.
function normalizeCoordinates(context = {}) {
  if (!context || typeof context !== 'object') return {}
  const season = Number(context.season ?? context.seasonNumber)
  const episode = Number(context.episode ?? context.episodeNumber)
  return {
    kind: context.kind || context.contentKind || null,
    season: Number.isSafeInteger(season) && season > 0 ? season : null,
    episode: Number.isSafeInteger(episode) && episode > 0 ? episode : null,
    year: Number(context.releaseYear) > 0 ? Number(context.releaseYear) : null,
    namespace: context.namespace || context.mediaProvider || null,
    identifier: context.identifier || context.mediaId || null
  }
}

// What an episode is called on the shelf. A show's row is its season and
// episode number; a film's is its year. Nothing is guessed: a work with neither
// renders neither.
export function releaseWorkLabel(context = {}) {
  const { season, episode, year } = normalizeCoordinates(context)
  if (season !== null && episode !== null) return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
  if (season !== null) return `Season ${season}`
  return year !== null ? String(year) : ''
}

// The full coordinate, for search and for the drawer: what it is, then who
// named it.
function releaseCoordinateLabel(context = {}) {
  const { namespace, identifier } = normalizeCoordinates(context)
  const parts = []
  const label = releaseWorkLabel(context)
  if (label) parts.push(label)
  if (namespace && identifier) parts.push(`${namespace}:${identifier}`)
  return parts.join(' · ')
}

// Three facts an operator must never see merged, per the relay contract:
// catalog presence (a signed manifest says this file exists and is this big),
// current reachability (someone observed peers that could serve it), and local
// residency (the bytes are on this disk).
//
// Local residency is proven only by this relay's own acquisition record, or by
// the local range probe the console runs over the visible page. Catalog
// availability is playback and network evidence about peers, and `candidateRef`
// comes from an index search, so neither is proof that these bytes are on this
// disk. `offlinePlayable` would be the right signal, but nothing in the backend
// ever calls `recordLocalRanges`, so it can never be true - reading it would be
// reading a field that is structurally always false.
function releaseResidency(job) {
  if (!job) {
    return { residency: 'unproven', residencyDetail: 'Catalogued here, but no acquisition record on this relay proves the bytes.' }
  }
  const accepted = Number(job.bytesAcquired) || 0
  if (job.state === 'seeding' || job.state === 'completed' || job.status === 'completed') {
    return accepted > 0
      ? { residency: 'local', residencyDetail: `This relay accepted ${accepted} bytes for this release.` }
      : { residency: 'unproven', residencyDetail: 'The acquisition completed without recording accepted bytes.' }
  }
  if (job.state === 'failed' || job.state === 'cancelled') {
    return accepted > 0
      ? { residency: 'partial', residencyDetail: `${accepted} bytes were accepted before the attempt ended; the relay does not report how many it still holds.` }
      : { residency: 'none', residencyDetail: 'No bytes were accepted on this relay.' }
  }
  return { residency: 'transferring', residencyDetail: `${accepted} bytes accepted so far.` }
}

// Reachability, read from the media catalog's own availability response
// (`packages/backend/src/api/media-graph.js` → `availabilityResponse`): the
// peers an assessment reached, when it looked, and when that evidence expires.
// Absent when nothing assessed this release - unknown reach is not zero reach,
// and none of it says whether the bytes are on this disk.
function releaseReach(availability) {
  // Older console fixtures carried a bare state string rather than an
  // assessment; it is a state, so it is reported as one.
  if (typeof availability === 'string') {
    return availability
      ? { reach: availability, reachDetail: `Availability state: ${availability}.` }
      : { reach: null, reachDetail: null }
  }
  if (!availability || typeof availability !== 'object') return { reach: null, reachDetail: null }
  const complete = Number(availability.completePeerCount) || 0
  const independent = Number(availability.independentPeerCount) || 0
  const observedAt = Number(availability.observedAt) || 0
  const expiresAt = Number(availability.expiresAt) || 0
  const notes = [`${complete} complete peer(s) of ${independent} independent peer(s)`]
  if (availability.state) notes.push(`state ${availability.state}`)
  if (observedAt > 0) notes.push(`observed ${new Date(observedAt).toISOString()}`)
  if (expiresAt > 0) notes.push(`evidence expires ${new Date(expiresAt).toISOString()}`)
  if (availability.archivePledged === true) notes.push('archive pledged')
  if ((availability.reasonCodes || []).length > 0) notes.push(availability.reasonCodes.join(', '))
  return { reach: `${complete}/${independent}`, reachDetail: `${notes.join('; ')}.` }
}

function releaseSearchText(row) {
  return [row.file, row.work, row.coordinates, row.state, row.id].filter(Boolean).join(' ').toLowerCase()
}

// Attention order is the console's default: what is moving, then what broke and
// can be retried, then the shelf. Every other column is a plain key.
const RESIDENCY_RANK = { local: 0, partial: 1, transferring: 2, unproven: 3, none: 4 }
const NUMERIC_SORTS = {
  size: row => Number(row.sizeBytes) || 0,
  progress: row => Number(row.progressPercent) || 0,
  backups: row => Number(row.backups) || 0,
  age: row => Number(row.updatedAt) || 0,
  // Reach sorts by complete seeders first: an observation of five peers and no
  // complete copy is worth less than one complete seeder.
  reach: row => {
    const [complete, peers] = String(row.reach || '').split('/')
    return (Number(complete) || 0) * 1000 + (Number(peers) || 0)
  },
  residency: row => -(RESIDENCY_RANK[row.residency] ?? 5)
}
const TEXT_SORTS = { file: 'file', work: 'work', state: 'state' }

function compareAttention(left, right) {
  const rank = (ATTENTION_RANK[left.state] ?? 5) - (ATTENTION_RANK[right.state] ?? 5)
  return rank === 0 ? (right.updatedAt || 0) - (left.updatedAt || 0) : rank
}

function compareReleases(sort, direction) {
  if (sort === 'attention') return compareAttention
  const order = direction === 'asc' ? 1 : -1
  const numeric = NUMERIC_SORTS[sort]
  if (numeric) return (left, right) => (numeric(left) - numeric(right)) * order
  const field = TEXT_SORTS[sort] || 'file'
  return (left, right) => String(left[field] || '').localeCompare(String(right[field] || '')) * order
}

// Server-side because a node that auto-seeds continuously holds hundreds of
// releases, and the browser should never receive the whole table to filter it.
export function queryReleases(rows, params = {}) {
  const text = String(params.query || '').trim().toLowerCase()
  const states = new Set((Array.isArray(params.states) ? params.states : []).filter(state => RELEASE_STATES.has(state)))
  const retention = typeof params.retention === 'string' && params.retention ? params.retention : ''
  const sort = RELEASE_SORTS.has(params.sort) ? params.sort : 'attention'
  const direction = params.direction === 'asc' ? 'asc' : 'desc'
  const limit = Math.min(MAX_RELEASE_PAGE, Math.max(1, Number(params.limit) || 50))
  const offset = Math.max(0, Number(params.offset) || 0)
  const matched = rows.filter(row => {
    if (states.size > 0 && !states.has(row.state)) return false
    if (retention && row.retentionClass !== retention) return false
    if (text && !releaseSearchText(row).includes(text)) return false
    return true
  })
  const group = params.group === 'work' ? 'work' : ''
  const compare = compareReleases(sort, direction)
  // Grouping is a second key, never a replacement: within a work the operator
  // still sees the order they asked for.
  matched.sort(group
    ? (left, right) => String(left.work || '~').localeCompare(String(right.work || '~')) || compare(left, right)
    : compare)
  return {
    total: rows.length,
    matched: matched.length,
    offset,
    limit,
    sort,
    direction,
    group,
    rows: matched.slice(offset, offset + limit)
  }
}

// One reading of the console's URL, shared by the page, the row fragment and
// the JSON, so the three can never disagree about what the operator asked for.
export function releaseQuery(searchParams) {
  return {
    query: searchParams.get('q') || '',
    states: searchParams.getAll('state'),
    retention: searchParams.get('retention') || '',
    sort: searchParams.get('sort') || 'attention',
    direction: searchParams.get('dir') || 'desc',
    group: searchParams.get('group') || '',
    limit: searchParams.get('limit'),
    offset: searchParams.get('offset')
  }
}

function buildArchiveForm(get) {
  return {
    url: get('url') || '',
    invidiousInstance: get('invidiousInstance') || '',
    channelName: get('channelName') || 'Anonymous Archive',
    title: get('title') || '',
    description: get('description') || '',
    publish: get('publish') !== 'false',
    sourceType: get('sourceType') || '',
    sourceUrl: get('sourceUrl') || '',
    sourceVideoId: get('sourceVideoId') || '',
    tmdbType: get('tmdbType') || '',
    tmdbId: get('tmdbId') || '',
    tmdbSeason: get('tmdbSeason') || '',
    tmdbEpisode: get('tmdbEpisode') || '',
    tmdbPosterPath: get('tmdbPosterPath') || '',
    tmdbTitle: get('tmdbTitle') || '',
    tmdbYear: get('tmdbYear') || '',
    // A consumer cannot look a title up, so whatever the match resolved has to
    // travel with the job or it never reaches the claim.
    tmdbOverview: get('tmdbOverview') || '',
    tmdbRuntime: get('tmdbRuntime') || '',
    tmdbGenres: get('tmdbGenres') || ''
  }
}

// Preserve raw form fields for the browser submission parser.
function formFields(params) {
  const fields = {}
  for (const [key, value] of params) fields[key] = value
  return fields
}


function parseCreatorForm(body) {
  const params = new URLSearchParams(body)
  return {
    url: params.get('url') || '',
    label: params.get('label') || '',
    publish: params.get('publish') !== 'false'
  }
}

function parseTmdbForm(body) {
  const params = new URLSearchParams(body)
  const apiKey = (params.get('apiKey') || '').trim()
  return {
    // A blank key field means "keep the stored key" — the form placeholder
    // advertises exactly that ("•••••••• (set)"). Omitting the property makes
    // setTmdbSettings skip the key write; the enable checkbox stays authoritative.
    ...(apiKey ? { apiKey } : {}),
    enabled: params.get('enabled') === 'true' || params.get('enabled') === 'on'
  }
}

function parseClientForm(body) {
  const params = new URLSearchParams(body)
  return {
    key: params.get('key') || '',
    label: params.get('label') || ''
  }
}

async function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function createDefaultServer(handler) {
  return createServer(handler)
}

async function sha256File(filePath) {
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  for await (const chunk of createReadStream(filePath)) sodium.crypto_hash_sha256_update(state, chunk)
  const digest = b4a.alloc(32)
  sodium.crypto_hash_sha256_final(state, digest)
  return b4a.toString(digest, 'hex')
}


// What the relay answers with before its store is open.
//
// Everything the console reads — the job store, the catalog, the media graph —
// lives behind the universal backend, and bringing that up walks the whole
// store: the media-graph rebuild, the publication-v1 migration and seed-pin
// registration all run before it hands back a context. On a large store that
// takes minutes and can stall indefinitely on a core waiting for a peer. A
// socket opened only afterwards leaves an operator with a refused connection and
// no way to tell a warming relay from a wedged one — observed on a 46 GB relay
// whose P2P side was up with three peers while its console port never opened.
//

function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

// Playback is a same-machine capability: the blob-server link a play click
// hands the browser only answers on the relay's own loopback. Ask the socket
// who is calling, not a header a client can write - a LAN request to a
// 0.0.0.0-bound relay gets the table but never the playback route.
function requestAllowsPlayback(req) {
  const remote = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
  if (!remote) return false
  if (remote.startsWith('::ffff:')) return isLoopbackHost(remote.slice('::ffff:'.length))
  return remote === '::1' || isLoopbackHost(remote)
}

// So the socket is bound first and answers from the start, and the console
// adopts it once the store-dependent side exists.
const WARMING_NOTICE = 'The relay is starting. Its storage and verified media view are still opening, so the console is not answering yet.'

function warmingPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>PearTube relay — starting</title><meta http-equiv="refresh" content="5"></head>
<body>
<h1>PearTube relay is starting</h1>
<p>${WARMING_NOTICE}</p>
<p>This page reloads every five seconds and becomes the archive console as soon as the relay is ready.</p>
</body>
</html>
`
}


export function createArchiveHttpSurface({
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  serverFactory = createDefaultServer,
  now = Date.now
} = {}) {
  const createdAt = now()
  let listening = null
  let closed = false
  let boundPort = Number(port)

  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2))
  }


  function warmingHandler(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, ready: false, waitingFor: 'relay-storage' })
      return
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/ui' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(warmingPage())
      return
    }

    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${WARMING_NOTICE}\n`)
  }

  let handler = warmingHandler
  const server = serverFactory((req, res) => handler(req, res))

  return {
    server,
    host,
    get port() { return boundPort },
    get adopted() { return handler !== warmingHandler },
    // How long the surface answered as a warming relay, which is what tells an
    // operator "still opening the store" from "stuck".
    warmupMs() { return now() - createdAt },
    adopt(next) {
      if (typeof next !== 'function') throw new Error('archive http surface requires a request handler')
      handler = next
    },
    // Memoized rather than flagged: whoever calls this second — the service, a
    // console adopting the surface, a test — must get the bound port, not an
    // early return while the first bind is still in flight.
    listen() {
      if (!listening) {
        listening = (async () => {
          await new Promise((resolve) => server.listen(Number(port), host, resolve))
          boundPort = server.address?.()?.port || Number(port)
          logger?.archive?.info?.('Archive WebUI bound before the relay store is open', { host, port: boundPort })
          return boundPort
        })()
      }
      return listening
    },
    async close() {
      if (closed) return
      closed = true
      if (!listening) return
      await listening.catch(() => {})
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

const CANDIDATE_REF_PATTERN = /^[A-Za-z0-9_-]{43}$/

function normalizeTmdbEpisodePart(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function tmdbKey(type, id, season = null, episode = null) {
  if (!type || !id) return null
  const normalizedType = type === 'tv' ? 'tv' : 'movie'
  const base = `${normalizedType}:${id}`
  const normalizedSeason = normalizeTmdbEpisodePart(season)
  const normalizedEpisode = normalizeTmdbEpisodePart(episode)
  return normalizedType === 'tv' && normalizedSeason && normalizedEpisode
    ? `${base}:s${normalizedSeason}:e${normalizedEpisode}`
    : base
}

function tmdbKeyFromDiscoverItem(item = {}) {
  return tmdbKey(item.type, item.tmdbId, item.season, item.episode)
}

function tmdbKeyFromVerifiedSource(source = {}) {
  const coordinates = source.mediaCoordinates || source
  return tmdbKey(
    coordinates.contentKind === 'episode' ? 'tv' : coordinates.contentKind,
    coordinates.mediaId,
    coordinates.seasonNumber,
    coordinates.episodeNumber
  )
}

export function buildTmdbNetworkIndex(catalogItems = []) {
  const index = new Map()
  for (const item of catalogItems || []) {
    for (const source of item?.sources || []) {
      const key = tmdbKeyFromVerifiedSource(source)
      if (!key) continue
      const existing = index.get(key) || { status: 'missing', count: 0, seeded: 0, videos: [], seen: new Set() }
      const sourceKey = `${source.publicationId || ''}:${source.renditionId || ''}:${key}`
      if (existing.seen.has(sourceKey)) continue
      existing.seen.add(sourceKey)
      const candidateRef = CANDIDATE_REF_PATTERN.test(source.candidateRef || '') ? source.candidateRef : null
      const playable = candidateRef !== null || source.availability === 'playable' || source.byteAvailability === 'playable'
      existing.count += 1
      if (playable) existing.seeded += 1
      existing.status = playable || existing.seeded > 0 ? 'seeding' : 'in-network'
      existing.videos.push({
        id: source.publicationId || null,
        title: item.title || null,
        candidateRef,
        playable
      })
      index.set(key, existing)
    }
  }
  return index
}

export function annotateTmdbDiscoverItems(items = [], networkIndex = new Map()) {
  return (items || []).map((item) => {
    const found = networkIndex.get(tmdbKeyFromDiscoverItem(item))
    return {
      ...item,
      networkStatus: found?.status || 'missing',
      networkCopies: found?.count || 0,
      seededCopies: found?.seeded || 0,
      networkVideos: found?.videos || []
    }
  })
}

function reserveAdjustedHeadroom(snapshot, reservedBytes) {
  const reserved = Number.isFinite(reservedBytes) && reservedBytes > 0 ? Math.floor(reservedBytes) : 0
  if (reserved <= 0) return snapshot
  if (Number.isFinite(snapshot)) return Math.max(0, Math.floor(snapshot) - reserved)
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const storage = Number.isFinite(snapshot.storage) ? Math.max(0, Math.floor(snapshot.storage) - reserved) : snapshot.storage
  if (snapshot.sharedVolume === false) return { ...snapshot, storage }
  return {
    ...snapshot,
    tmp: Number.isFinite(snapshot.tmp) ? Math.max(0, Math.floor(snapshot.tmp) - reserved) : snapshot.tmp,
    storage
  }
}

// The shelf a viewer reads, as opposed to the operator sections below it.
//
// A relay that has been running for a while holds more titles than anybody
// scrolls through, and this list is rendered inline into the home page, so the
// shelf is capped: past the first screens the cost is real and the value is
// zero.
const LIBRARY_LIMIT = 60

// The verified query contract caps one page at 50, so the shelf fills its own
// bounded limit by paging rather than asking for unbounded inventory.
const CATALOG_PAGE_LIMIT = 50

// An entityId is a media-graph digest. The poster route takes one straight off
// a URL path, so it is character-checked and bounded before it is used for
// anything — it only ever selects which artwork the media graph resolves, and
// this pattern is what keeps it from ever being anything else.
const ENTITY_ID_PATTERN = /^[0-9a-f]{16,128}$/
const POSTER_ROUTE_PREFIX = '/poster/'

// A cover is a small image. Something larger is not one, and buffering it would
// stall the console for no viewer benefit.
const MAX_POSTER_BYTES = 8 * 1024 * 1024
const POSTER_READ_TIMEOUT_MS = 5000

function posterEntityId(url) {
  let pathname
  try {
    pathname = new URL(url, 'http://relay.local').pathname
  } catch {
    return null
  }
  if (!pathname.startsWith(POSTER_ROUTE_PREFIX)) return null
  // Deliberately not decoded first: a hex digest carries no escapes, so an
  // encoded traversal or separator fails the pattern instead of being unwrapped
  // into something that passes it.
  const raw = pathname.slice(POSTER_ROUTE_PREFIX.length)
  return ENTITY_ID_PATTERN.test(raw) ? raw : null
}

// A publication's video bytes as this relay actually holds them. The catalogue
// reports which publications exist but not how large they are, and the signed
// manifest is the only local answer; the cover rendition is skipped because a
// 40 KB poster is not the size a viewer is asking about.
function publicationBytes(manifest) {
  const rendition = (manifest?.body?.renditions || []).find((candidate) => (
    candidate?.renditionId &&
    candidate.blocked !== true &&
    candidate.superseded !== true &&
    !isArtworkRendition(candidate)
  ))
  const bytes = Number(rendition?.core?.byteLength)
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0
}

function jobRecency(job) {
  const stamp = Number(job?.completedAt || job?.updatedAt || job?.createdAt || 0)
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0
}

// An archive job is keyed by the work it was asked for — `movie:27205`,
// `show:71728:s2:e4` — not by the media-graph entity its publication later
// lands on. The provider id inside that hint is what a catalogue source carries
// as `mediaId`, which is what ties the two together; the title is the fallback
// for jobs seeded from a bare URL, which never had a hint.
function entityHintMediaId(hint) {
  if (typeof hint !== 'string') return null
  const mediaId = hint.split(':')[1]
  return mediaId || null
}

function libraryTitleKey(title) {
  return typeof title === 'string' ? title.trim().toLowerCase() : ''
}

// Which of several matching jobs describes the title. An in-flight job outranks
// a failure, a failure outranks a finished one, and among equals the newest
// wins: the shelf should say "adding" while a retry is running rather than
// report the attempt it replaced.
const JOB_INTEREST = { running: 3, queued: 3, failed: 2 }

function preferJob(current, candidate) {
  if (!current) return candidate
  const currentRank = JOB_INTEREST[current.status] || 1
  const candidateRank = JOB_INTEREST[candidate.status] || 1
  if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current
  return jobRecency(candidate) >= jobRecency(current) ? candidate : current
}

function indexJobsForLibrary(jobs = []) {
  const byPublicationId = new Map()
  const byMediaId = new Map()
  const byTitle = new Map()
  for (const job of jobs) {
    if (job?.publicationId) {
      const publicationId = String(job.publicationId)
      byPublicationId.set(publicationId, preferJob(byPublicationId.get(publicationId), job))
    }
    const mediaId = entityHintMediaId(job?.entityHint)
    if (mediaId) byMediaId.set(mediaId, preferJob(byMediaId.get(mediaId), job))
    const title = libraryTitleKey(job?.title)
    if (title) byTitle.set(title, preferJob(byTitle.get(title), job))
  }
  return { byPublicationId, byMediaId, byTitle }
}

function libraryJobFor(item, { byPublicationId, byMediaId, byTitle }) {
  for (const source of item?.sources || []) {
    const publicationId = source?.publicationId == null ? null : String(source.publicationId)
    const publicationJob = publicationId == null ? null : byPublicationId.get(publicationId)
    if (publicationJob) return publicationJob
    const mediaId = source?.mediaCoordinates?.mediaId
    const mediaJob = mediaId == null ? null : byMediaId.get(String(mediaId))
    if (mediaJob) return mediaJob
  }
  return byTitle.get(libraryTitleKey(item?.title)) || null
}

function mirroredLabel(devices) {
  return devices === 1 ? 'Backed up on 1 other device' : `Backed up on ${devices} other devices`
}

// How safe a title is, said to somebody who has never heard of a swarm, a peer
// or a pledge. archive-ui.js renders `label` verbatim, so this vocabulary lives
// here and nowhere else.
function libraryStatus({ job, freshArchivists, sizeBytes }) {
  if (job?.status === 'queued' || job?.status === 'running') {
    return {
      state: 'publishing',
      label: 'Adding to your library…',
      detail: 'The file is still being copied in. It will be playable once that finishes.'
    }
  }
  // A failed job only reads as a failure while the title has no bytes here. A
  // retry that worked leaves the failed attempt behind it, and reporting that
  // as broken would contradict the copy the viewer can already play.
  if (job?.status === 'failed' && sizeBytes <= 0) {
    return {
      state: 'failed',
      label: 'Could not be added',
      detail: 'The last attempt to add this title did not finish. Try adding it again.'
    }
  }
  if (freshArchivists > 0) {
    return {
      state: 'mirrored',
      label: mirroredLabel(freshArchivists),
      detail: 'Another device is holding a copy, so this title survives even if this one does not.'
    }
  }
  if (sizeBytes > 0) {
    return {
      state: 'stored',
      label: 'Saved on this relay',
      detail: 'The whole file is on this machine and ready to play.'
    }
  }
  return {
    state: 'waiting',
    label: 'Waiting for a backup',
    detail: 'This title is listed, but no copy of the file has arrived yet.'
  }
}

export async function createArchiveConsole({
  service,
  downloader,
  host = '127.0.0.1',
  port = 8174,
  logger = null,
  uploadDir = null,
  uploadStorageHeadroom = null,
  httpSurface = null,
  serverFactory = createDefaultServer,
  storageReservations = null,
  companionHandler = null,
  // Test seam: a console created without one asks the socket. Production code
  // never passes this; tests use it to simulate a LAN peer without needing a
  // second network interface.
  allowsPlaybackRequest = requestAllowsPlayback
}) {
  if (!service?.runtime?.ctx?.metaDb) throw new Error('archive console requires a relay service runtime')
  if (typeof service.requestLocalFileAcquisition !== 'function' ||
      typeof service.listAcquisitions !== 'function' ||
      typeof service.getVerifiedMediaCatalog !== 'function') {
    throw new Error('archive console requires the provider acquisition service')
  }
  let activeCompanionHandler = companionHandler
  const copyReservations = storageReservations || { bytes: 0 }
  const uploadReservations = new Map()
  const releaseUploadReservation = (reservation) => {
    if (!reservation || reservation.released) return
    reservation.released = true
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - reservation.bytes)
    reservation.bytes = 0
    copyReservations.invalidate?.()
  }
  const releaseUploadReservationByPath = (uploadPath) => {
    const release = uploadReservations.get(uploadPath)
    if (!release) return
    uploadReservations.delete(uploadPath)
    release()
  }
  const reserveUploadBytes = (reservation, bytes) => {
    const size = Math.max(0, Math.floor(Number(bytes) || 0))
    if (size <= 0) return
    reservation.bytes += size
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0)) + size
  }
  const releaseUploadBytes = (reservation, bytes) => {
    const size = Math.max(0, Math.min(reservation.bytes, Math.floor(Number(bytes) || 0)))
    if (size <= 0) return
    reservation.bytes -= size
    copyReservations.bytes = Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - size)
  }
  const stateForUi = state => ['acquiring', 'verifying', 'publishing'].includes(state) ? 'running' : state
  const entityHintFor = context => context?.kind === 'episode'
    ? `show:${context.identifier}:s${context.season}:e${context.episode}`
    : context?.kind === 'movie' ? `movie:${context.identifier}` : null
  const listJobs = async () => (await service.listAcquisitions()).map(job => {
    const expectedBytes = Math.max(0, Number(job.expectedBytes) || 0)
    const bytesAcquired = Math.max(0, Math.min(expectedBytes || Number.MAX_SAFE_INTEGER, Number(job.bytesAcquired) || 0))
    return {
      id: job.acquisitionId,
      jobId: job.acquisitionId,
      status: stateForUi(job.state),
      state: job.state,
      title: job.title || `Acquisition ${job.acquisitionId.slice(0, 12)}`,
      sourceFileName: job.sourceFileName || null,
      error: job.errorCode,
      errorCode: job.errorCode,
      entityHint: entityHintFor(job.mediaContext),
      mediaContext: job.mediaContext || null,
      retentionClass: job.retentionClass || null,
      bytesAcquired,
      expectedBytes,
      progressPercent: expectedBytes > 0 ? Math.min(100, Math.floor((bytesAcquired / expectedBytes) * 1000) / 10) : 0,
      publicationId: job.publicationId || null,
      manifestId: job.manifestId || null,
      renditionId: job.renditionId || null,
      assetId: job.assetId || null,
      recoverable: job.recoverable === true,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.state === 'completed' ? job.updatedAt : null
    }
  })
  const store = { listJobs }

  // Read an archive submission as a browser file upload (multipart/form-data,
  // streamed to disk), a machine API JSON body, or a URL-encoded form. Returns
  // the normalized archive form plus an optional uploaded file descriptor.
  async function readArchiveSubmission(req) {
    const contentType = req.headers?.['content-type'] || req.headers?.['Content-Type'] || ''
    if (/multipart\/form-data/i.test(contentType)) {
      const boundary = parseBoundary(contentType)
      if (!boundary) throw new Error('multipart upload is missing its boundary')
      if (!uploadDir) throw new Error('relay archive upload directory is not configured')
      const reservation = { bytes: 0, released: false }
      const storageHeadroom = typeof uploadStorageHeadroom === 'function'
        ? () => reserveAdjustedHeadroom(uploadStorageHeadroom(), Math.max(0, Math.floor(Number(copyReservations.bytes) || 0) - reservation.bytes))
        : null
      const { fields, file } = await receiveMultipartUpload(req, {
        boundary,
        uploadDir,
        storageHeadroom,
        reserveStorageBytes: (bytes) => reserveUploadBytes(reservation, bytes),
        releaseStorageBytes: (bytes) => releaseUploadBytes(reservation, bytes)
      })
      if (file?.path && typeof file.releaseStorageReservation === 'function') {
        const release = file.releaseStorageReservation
        file.releaseStorageReservation = () => {
          uploadReservations.delete(file.path)
          release()
        }
        uploadReservations.set(file.path, file.releaseStorageReservation)
      }
      return { form: buildArchiveForm((key) => fields[key] ?? ''), file, fields }
    }
    const params = new URLSearchParams(await collectBody(req))
    return { form: buildArchiveForm((key) => params.get(key) || ''), file: null, fields: formFields(params) }
  }


  function discardUploadFile(file) {
    if (!file) return
    try {
      if (file.dir) rmSync(file.dir, { recursive: true, force: true })
    } catch (err) {
      logger?.archive?.warn?.('Discarding a rejected upload failed', { error: err?.message || String(err) })
    } finally {
      if (typeof file.releaseStorageReservation === 'function') {
        try { file.releaseStorageReservation() } catch { /* Cleanup remains best effort. */ }
      } else if (file.path) {
        releaseUploadReservationByPath(file.path)
      }
    }
  }

  async function enqueueCatalogSubmission(form, file) {
    let staged = file
    let accepted = false
    try {
      if (!staged) {
        const downloaded = await downloader.download(form)
        staged = {
          path: downloaded.filePath,
          relativePath: relative(resolve(uploadDir), resolve(downloaded.filePath)).replaceAll('\\', '/'),
          filename: basename(downloaded.filePath),
          mimeType: downloaded.mimeType || 'application/octet-stream',
          size: statSync(downloaded.filePath).size,
          dir: dirname(downloaded.filePath),
          releaseStorageReservation: downloaded.releaseStorageReservation
        }
      }
      const relativePath = staged.relativePath || relative(resolve(uploadDir), resolve(staged.path)).replaceAll('\\', '/')
      if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('/')) {
        throw new Error('archive upload is outside the acquisition spool root')
      }
      const byteLength = Number(staged.size || statSync(staged.path).size)
      const sha256 = await sha256File(staged.path)
      const tmdbId = String(form.tmdbId || '').trim()
      const episode = form.tmdbType === 'tv' && tmdbId && Number(form.tmdbSeason) > 0 && Number(form.tmdbEpisode) > 0
      const selector = episode
        ? {
            kind: 'episode',
            namespace: 'tmdb',
            identifier: tmdbId,
            season: Number(form.tmdbSeason),
            episode: Number(form.tmdbEpisode)
          }
        : {
            kind: 'movie',
            namespace: tmdbId ? 'tmdb' : 'peartube-ui',
            identifier: tmdbId || sha256
          }
      const mimeType = staged.mimeType || 'application/octet-stream'
      const title = form.title || form.tmdbTitle || staged.filename || 'Uploaded video'
      const job = await service.requestLocalFileAcquisition({
        idempotencyKey: `archive-${Date.now()}-${sha256.slice(0, 24)}`,
        title,
        selector,
        expectedBytes: byteLength,
        retentionClass: 'archive-pin',
        path: staged.path,
        mimeType,
        sourceFileName: staged.filename || basename(staged.path),
        dispose: () => discardUploadFile(staged)
      })
      accepted = job.sourceAccepted === true
      if (!accepted) discardUploadFile(staged)
      return {
        id: job.acquisitionId,
        jobId: job.acquisitionId,
        status: stateForUi(job.state),
        title,
        entityHint: entityHintFor(selector)
      }
    } catch (err) {
      if (!accepted) discardUploadFile(staged)
      throw err
    }
  }
  const manager = { enqueue: enqueueCatalogSubmission }


  function creatorsView() {
    const creators = service.creators?.getCreators?.() || []
    return [...creators].sort((a, b) => (Number(b.videosUnseeded || 0) - Number(a.videosUnseeded || 0)) || (Number(b.videosArchived || 0) - Number(a.videosArchived || 0)))
  }

  function tmdbView() {
    const opts = service.settings
      ? resolveTmdbOptions(service.config || {}, service.settings)
      : { enabled: false, apiKey: '' }
    return { enabled: Boolean(opts.enabled), hasKey: Boolean(opts.apiKey) }
  }

  async function readVerifiedCatalog() {
    const items = []
    let cursor = null
    while (items.length < LIBRARY_LIMIT) {
      const request = { limit: Math.min(CATALOG_PAGE_LIMIT, LIBRARY_LIMIT - items.length), limitProvided: true }
      if (cursor) request.cursor = cursor
      const page = await service.getVerifiedMediaCatalog(request)
      if (page?.success !== true || !Array.isArray(page.items) || page.items.length === 0) break
      items.push(...page.items)
      cursor = page.nextCursor || null
      if (!cursor) break
    }
    const rawBlocked = service.settings?.get?.('blockedReleases', []) || []
    const blocked = new Set((Array.isArray(rawBlocked) ? rawBlocked : []).filter(Boolean).map(String))
    if (blocked.size > 0) {
      return items.filter(item => {
        if (item.entityId && blocked.has(String(item.entityId))) return false
        if (item.publicationId && blocked.has(String(item.publicationId))) return false
        if (Array.isArray(item.sources)) {
          item.sources = item.sources.filter(src => {
            const pubId = src?.publicationId ? String(src.publicationId) : null
            const rendId = src?.renditionId ? String(src.renditionId) : null
            if (pubId && blocked.has(pubId)) return false
            if (rendId && blocked.has(rendId)) return false
            if (pubId && rendId && blocked.has(`${pubId}:${rendId}`)) return false
            return true
          })
          if (item.sources.length === 0) return false
        }
        return true
      })
    }
    return items
  }

  async function discoverView({ query = '', type = 'movie', page = 1 } = {}, catalogItems = []) {
    const items = typeof service.discoverTmdb === 'function'
      ? await service.discoverTmdb({ query, type, page }).catch(() => [])
      : []
    return {
      query,
      type: type === 'tv' ? 'tv' : 'movie',
      items: annotateTmdbDiscoverItems(items, buildTmdbNetworkIndex(catalogItems))
    }
  }

  // The viewer-facing shelf is built only from the service's verified query
  // view. Jobs and mirror proofs add local status, but never invent a title or
  // a playback target.
  async function libraryView(items, jobs = [], { playbackAllowed = false } = {}) {
    try {
      if (!Array.isArray(items) || items.length === 0) return []

      const rawBlocked = service.settings?.get?.('blockedReleases', []) || []
      const blocked = new Set((Array.isArray(rawBlocked) ? rawBlocked : []).filter(Boolean).map(String))
      const releaseFileNames = service.settings?.get?.('releaseFileNames', {}) || {}
      const mirrors = new Map()
      for (const request of service.getArchiveMirrorRequests?.() || []) {
        if (!request?.publicationId) continue
        mirrors.set(String(request.publicationId), request)
      }
      const jobIndex = indexJobsForLibrary(jobs)
      const manifests = new Map()
      const publicationIds = new Set()
      for (const item of items) {
        for (const source of item?.sources || []) {
          if (source?.publicationId) publicationIds.add(String(source.publicationId))
        }
      }
      await Promise.all([...publicationIds].map(async publicationId => {
        const manifest = await service.getVerifiedManifest?.(publicationId)
        if (manifest) manifests.set(publicationId, manifest)
      }))

      // The verified view is ordered by its durable query key and carries no
      // display timestamp. Local jobs and mirror proofs provide recency when
      // available; titles without either retain verified query order.
      const ranked = items.map((item, order) => {
        const job = libraryJobFor(item, jobIndex)
        let sizeBytes = 0
        let freshArchivists = 0
        let recency = jobRecency(job)
        const itemPublicationIds = new Set()
        // A series entity collapses every episode this relay holds, so the
        // seasons and episodes are counted from the coordinates the publisher
        // signed rather than from how many publications happen to be here. Two
        // uploads of the same episode are one episode; an episode with no
        // ordinals is still held, so it is counted without a season.
        const seasons = new Map()
        let looseEpisodes = 0
        const releases = []
        for (const source of item?.sources || []) {
          if (!source?.publicationId) continue
          const publicationId = String(source.publicationId)
          const renditionId = source?.renditionId ? String(source.renditionId) : null
          if (blocked.has(publicationId) || (renditionId && blocked.has(renditionId)) || (renditionId && blocked.has(`${publicationId}:${renditionId}`))) continue
          const releaseBytes = publicationBytes(manifests.get(publicationId))
          sizeBytes += releaseBytes
          itemPublicationIds.add(publicationId)
          const releaseJob = jobIndex.byPublicationId.get(publicationId) || null
          const releaseMirror = mirrors.get(publicationId)
          const manifest = manifests.get(publicationId) || null
          const sourceFileName = releaseFileNames[`${publicationId}:${renditionId || ''}`] ||
            releaseFileNames[publicationId] ||
            releaseJob?.sourceFileName ||
            source?.sourceFileName ||
            manifest?.body?.sourceFileName ||
            source?.fileName ||
            source?.filename ||
            (manifest?.body?.title && manifest.body.title !== item?.title ? manifest.body.title : null) ||
            (source?.title && source.title !== item?.title ? source.title : null) ||
            manifest?.body?.title ||
            source?.title ||
            (releaseJob?.title && !releaseJob.title.startsWith('Acquisition ') ? releaseJob.title : null) ||
            null
          releases.push({
            publicationId,
            renditionId: source.renditionId || null,
            sizeBytes: releaseBytes > 0 ? releaseBytes : null,
            sourceFileName,
            title: manifest?.body?.title || source?.title || releaseJob?.title || null,
            acquisitionId: releaseJob?.id || null,
            availability: source.availability || null,
            mediaCoordinates: source.mediaCoordinates || null,
            freshArchivists: Math.max(0, Number(releaseMirror?.freshArchivists) || 0),
            acquiredAt: releaseJob?.completedAt || releaseJob?.updatedAt || null,
            candidateRef: playbackAllowed && CANDIDATE_REF_PATTERN.test(source?.candidateRef || '')
              ? source.candidateRef
              : null
          })
          const coordinates = source.mediaCoordinates || {}
          if (coordinates.contentKind === 'episode') {
            const season = Number(coordinates.seasonNumber)
            const episode = Number(coordinates.episodeNumber)
            if (Number.isSafeInteger(season) && season > 0 && Number.isSafeInteger(episode) && episode > 0) {
              if (!seasons.has(season)) seasons.set(season, new Set())
              seasons.get(season).add(episode)
            } else {
              looseEpisodes++
            }
          }
          const mirror = mirrors.get(String(source.publicationId))
          if (!mirror) continue
          // Max, not sum: one archivist holding three episodes of a series is
          // one other device, not three.
          freshArchivists = Math.max(freshArchivists, Number(mirror.freshArchivists) || 0)
          recency = Math.max(recency, Number(mirror.requestedAt) || 0)
        }
        const episodeCount = [...seasons.values()].reduce((sum, set) => sum + set.size, 0) + looseEpisodes
        return {
          order,
          recency,
          entry: {
            entityId: String(item?.entityId || ''),
            kind: item?.entityKind || 'unknown',
            title: item?.title || 'Untitled',
            channelName: item?.subtitle || null,
            year: Number.isSafeInteger(item?.releaseYear) ? item.releaseYear : null,
            runtimeMinutes: Number.isSafeInteger(item?.runtimeMinutes) ? item.runtimeMinutes : null,
            genres: Array.isArray(item?.genres) ? item.genres : [],
            overview: typeof item?.overview === 'string' && item.overview ? item.overview : null,
            // What the publisher signed a cover for. Whether its bytes have
            // replicated here is what /poster/<entityId> answers, and that
            // resolve can block on a transfer, so it is not run once per title
            // while a page render waits on it.
            hasPoster: Boolean(item?.posterBlobId || item?.posterUrl),
            sizeBytes: sizeBytes > 0 ? sizeBytes : null,
            publicationCount: itemPublicationIds.size,
            publicationIds: [...itemPublicationIds],
            releases,
            freshArchivists,
            acquisition: job
              ? {
                  id: job.id,
                  status: job.status,
                  progressPercent: job.progressPercent,
                  sourceFileName: job.sourceFileName,
                  bytesAcquired: job.bytesAcquired,
                  expectedBytes: job.expectedBytes,
                  retentionClass: job.retentionClass,
                  publicationId: job.publicationId,
                  recoverable: job.recoverable,
                  updatedAt: job.updatedAt
                }
              : null,
            // What this relay actually holds of a show, counted from signed
            // coordinates: which seasons, and how many distinct episodes. It
            // is deliberately not "how many episodes the show has" - nothing
            // here knows that, and implying it would be a guess.
            seasonNumbers: [...seasons.keys()].sort((left, right) => left - right),
            episodeCount,
            candidateRef: playbackAllowed
              ? (CANDIDATE_REF_PATTERN.test(item?.candidateRef || '')
                  ? item.candidateRef
                  : (item?.sources || []).find(source => CANDIDATE_REF_PATTERN.test(source?.candidateRef || ''))?.candidateRef || null)
              : null,
            status: libraryStatus({ job, freshArchivists, sizeBytes })
          }
        }
      })
      ranked.sort((left, right) => (right.recency - left.recency) || (left.order - right.order))
      return ranked.map((row) => row.entry)
    } catch (err) {
      logger?.archive?.warn?.('Building the relay library view failed', { error: err?.message || String(err) })
      return []
    }
  }

  // One published release. Three independent facts ride on it: the signed
  // manifest length (presence), the published availability observation (reach),
  // and this relay's own acquisition record (residency). `bytesAcquired` is the
  // relay's own count, never the manifest length, so a catalogued file this
  // relay never fetched cannot read as bytes held.
  // What this relay's own record adds to a catalogued release. Split out so the
  // row builder reads as one shape rather than a chain of optional lookups.
  function acquisitionFacts(acquisition) {
    if (!acquisition) {
      return { state: 'seeding', bytesAcquired: 0, progressPercent: 0, coordinates: '', retentionClass: null, acquisitionId: null }
    }
    return {
      state: acquisition.status === 'completed' ? 'seeding' : acquisition.state,
      bytesAcquired: Number(acquisition.bytesAcquired) || 0,
      progressPercent: Number(acquisition.progressPercent) || 0,
      coordinates: releaseCoordinateLabel(acquisition.mediaContext || {}),
      retentionClass: acquisition.retentionClass || null,
      acquisitionId: acquisition.id || null
    }
  }

  function publicationReleaseRow(work, release, acquisition) {
    const facts = acquisitionFacts(acquisition)
    // The publisher's signed coordinates lead: they describe the work the
    // catalog names. The acquisition's own context is the fallback for a
    // release published before coordinates rode along.
    const coordinates = release.mediaCoordinates || acquisition?.mediaContext || {}
    const file = release.sourceFileName ||
      acquisition?.sourceFileName ||
      (release.title && release.title !== work.title ? release.title : null) ||
      (acquisition?.title && !acquisition.title.startsWith('Acquisition ') && acquisition.title !== work.title ? acquisition.title : null) ||
      release.title ||
      null
    return {
      // A publication can carry more than one rendition, and each is its own
      // core with its own bytes. The row id has to tell them apart or the
      // drawer, the selection and the poll's row index would collapse them.
      id: release.renditionId ? `${release.publicationId}:${release.renditionId}` : release.publicationId,
      kind: 'release',
      file,
      work: work.title || null,
      workEntityId: work.entityId || null,
      catalogued: true,
      sizeBytes: Number(release.sizeBytes) || 0,
      backups: Math.max(0, Number(release.freshArchivists) || 0),
      ...facts,
      coordinates: releaseCoordinateLabel(coordinates),
      workLabel: releaseWorkLabel(coordinates),
      ...releaseReach(release.availability),
      ...releaseResidency(acquisition),
      updatedAt: Number(release.acquiredAt) || 0,
      candidateRef: release.candidateRef || null,
      publicationId: release.publicationId,
      renditionId: release.renditionId || null,
      errorCode: null,
      recoverable: false
    }
  }

  // An acquisition that produced no publication yet. Its title is only a title
  // when a publisher named the work; the generated `Acquisition <id>` label is
  // the absence of a name, and the table renders absence as absence.
  function acquisitionReleaseRow(job) {
    const bytesAcquired = Number(job.bytesAcquired) || 0
    return {
      id: job.id,
      kind: 'acquisition',
      file: job.sourceFileName || (job.title && !job.title.startsWith('Acquisition ') ? job.title : null),
      work: job.title && !job.title.startsWith('Acquisition ') ? job.title : null,
      workEntityId: null,
      coordinates: releaseCoordinateLabel(job.mediaContext || {}),
      workLabel: releaseWorkLabel(job.mediaContext || {}),
      // An acquisition names a publication only once it published one; until
      // then this relay holds bytes for a work no catalog lists.
      catalogued: Boolean(job.publicationId),
      sizeBytes: Number(job.expectedBytes) || 0,
      bytesAcquired,
      progressPercent: Number(job.progressPercent) || 0,
      state: job.state,
      backups: 0,
      reach: null,
      reachDetail: 'No availability observation names this acquisition.',
      ...releaseResidency(job),
      retentionClass: job.retentionClass || null,
      updatedAt: Number(job.updatedAt) || 0,
      candidateRef: null,
      publicationId: job.publicationId || null,
      renditionId: job.renditionId || null,
      acquisitionId: job.id,
      errorCode: job.errorCode || null,
      recoverable: job.recoverable === true
    }
  }

  // The operator table. Every archived file this relay holds becomes a row, and
  // so does every acquisition that has not produced one yet — a failure with no
  // publication is exactly the row an operator came here to act on.
  function releasesView(library = [], jobs = []) {
    const rows = []
    const claimed = new Set()
    const published = new Set()
    const rawBlocked = service.settings?.get?.('blockedReleases', []) || []
    const blocked = new Set((Array.isArray(rawBlocked) ? rawBlocked : []).filter(Boolean).map(String))
    for (const work of library) {
      for (const release of work.releases || []) {
        const pubId = release.publicationId ? String(release.publicationId) : null
        const rendId = release.renditionId ? String(release.renditionId) : null
        const releaseKey = rendId ? `${pubId}:${rendId}` : pubId
        if (pubId && blocked.has(pubId)) continue
        if (rendId && blocked.has(rendId)) continue
        if (releaseKey && blocked.has(releaseKey)) continue
        const acquisition = release.acquisitionId ? jobs.find(job => job.id === release.acquisitionId) : null
        if (acquisition) claimed.add(acquisition.id)
        if (pubId) published.add(pubId)
        rows.push(publicationReleaseRow(work, release, acquisition))
      }
    }
    for (const job of jobs) {
      const jobId = job.id ? String(job.id) : null
      const acqId = job.acquisitionId ? String(job.acquisitionId) : null
      const pubId = job.publicationId ? String(job.publicationId) : null
      if (jobId && blocked.has(jobId)) continue
      if (acqId && blocked.has(acqId)) continue
      if (pubId && blocked.has(pubId)) continue
      if (claimed.has(job.id) || (pubId && published.has(pubId))) continue
      rows.push(acquisitionReleaseRow(job))
    }
    return rows
  }
  const residencyProbes = new Map()
  const RESIDENCY_PROBE_TTL_MS = 30_000
  // say so, rather than silently reading as absent.
  const RESIDENCY_PROBE_BUDGET = 256
  const RESIDENCY_PROBE_CONCURRENCY = 8

  // Keyed by publication *and* rendition: one publication can carry more than
  // one rendition, and they are different cores with different local ranges.
  async function probeLocalResidency(publicationId, renditionId) {
    if (typeof service.getLocalResidency !== 'function') return null
    const key = `${publicationId}\n${renditionId || ''}`
    const cached = residencyProbes.get(key)
    if (cached && (Date.now() - cached.at) < RESIDENCY_PROBE_TTL_MS) return cached.result
    const result = await service.getLocalResidency({ publicationId, renditionId }).catch(() => null)
    residencyProbes.set(key, { at: Date.now(), result })
    if (residencyProbes.size > 512) residencyProbes.delete(residencyProbes.keys().next().value)
    return result
  }

  function applyResidencyProbe(row, probe) {
    if (probe.complete === true) {
      row.residency = 'local'
      row.residencyDetail = `A local range probe found all ${probe.requiredRangeCount} required range(s) on this relay.`
      return
    }
    // `core.has()` reads the local bitfield. On a relay with block offload on,
    // an evicted block is restored from the bucket on read, so a local miss is
    // not proof the relay cannot serve it - and this pass cannot prove it can.
    const offloaded = service.getStatus?.()?.blockOffload?.enabled === true
    row.residencyDetail = `A local range probe found ${probe.localRangeCount} of ${probe.requiredRangeCount} required range(s) on this volume.` +
      (offloaded
        ? ' Block offload is enabled, so blocks may live in the configured bucket; per-release offload residency is not measured yet.'
        : '')
  }

  // A verb answers for one release. Both refuse rather than report success they
  // cannot back: a relay whose provider is not up returns null, and a relay too
  // old to clear records has no method at all. Neither is "done".
  async function cancelRelease(acquisitionId) {
    if (typeof service.cancelAcquisition !== 'function') {
      return { acquisitionId, done: false, reason: 'this relay cannot cancel acquisitions' }
    }
    try {
      const job = await service.cancelAcquisition(acquisitionId)
      if (!job || typeof job.state !== 'string') {
        return { acquisitionId, done: false, reason: 'the relay reported no job to cancel' }
      }
      if (job.state === 'cancelled') return { acquisitionId, done: true, state: job.state }
      if (TERMINAL_RELEASE_STATES.has(job.state)) {
        return { acquisitionId, done: false, state: job.state, reason: `already ${job.state}` }
      }
      // The manager aborts in flight and re-reads the record; a job still in a
      // running state has not been cancelled yet, whatever the call returned.
      return { acquisitionId, done: false, state: job.state, reason: `still ${job.state}` }
    } catch (error) {
      return { acquisitionId, done: false, reason: friendlyVerbError(error) }
    }
  }
  async function retryRelease(acquisitionId) {
    if (typeof service.retryAcquisition !== 'function') {
      return { acquisitionId, done: false, reason: 'this relay cannot retry acquisitions' }
    }
    try {
      const job = await service.retryAcquisition(acquisitionId)
      if (!job || typeof job.state !== 'string') {
        return { acquisitionId, done: false, reason: 'the relay reported no job to retry' }
      }
      if (job.state === 'queued' || job.state === 'acquiring' || job.state === 'verifying' || job.state === 'publishing' || job.state === 'completed') {
        return { acquisitionId, done: true, state: job.state }
      }
      if (job.state === 'failed') {
        return { acquisitionId, done: false, state: job.state, reason: job.errorCode ? `${job.errorCode} (retry limit reached)` : 'retry failed' }
      }
      return { acquisitionId, done: false, state: job.state, reason: `unexpected state: ${job.state}` }
    } catch (error) {
      return { acquisitionId, done: false, reason: friendlyVerbError(error) }
    }
  }


  async function clearRelease(acquisitionId) {
    if (typeof service.forgetAcquisition !== 'function') {
      return { acquisitionId, done: false, reason: 'this relay cannot clear finished records' }
    }
    try {
      const result = await service.forgetAcquisition(acquisitionId)
      return result?.forgotten === true
        ? { acquisitionId, done: true, state: 'forgotten' }
        : { acquisitionId, done: false, reason: 'nothing to clear' }
    } catch (error) {
      return { acquisitionId, done: false, reason: friendlyVerbError(error) }
    }
  }

  async function deleteRelease(id) {
    if (typeof service.deleteRelease === 'function') {
      try {
        const result = await service.deleteRelease(id)
        if (result?.done) return { id, done: true, state: 'deleted' }
      } catch (error) {
        return { id, done: false, reason: friendlyVerbError(error) }
      }
    }
    if (typeof service.forgetAcquisition === 'function') {
      try {
        const result = await service.forgetAcquisition(id)
        if (result?.forgotten === true) return { id, done: true, state: 'forgotten' }
      } catch (error) {
        return { id, done: false, reason: friendlyVerbError(error) }
      }
    }
    return { id, done: false, reason: 'this relay cannot delete records' }
  }

  async function proveResidency(rows) {
    const pending = rows.filter(row => row.catalogued && row.residency === 'unproven' && row.publicationId)
    for (const row of pending.slice(RESIDENCY_PROBE_BUDGET)) {
      row.residencyDetail = 'Not probed in this pass: the relay reached its per-request local probe budget.'
    }
    const queue = pending.slice(0, RESIDENCY_PROBE_BUDGET)
    let next = 0
    const workers = Array.from({ length: Math.min(RESIDENCY_PROBE_CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        const row = queue[next++]
        const probe = await probeLocalResidency(row.publicationId, row.renditionId)
        if (probe) applyResidencyProbe(row, probe)
      }
    })
    await Promise.all(workers)
    return rows
  }

  // One read of the shelf, shared by the page, the poll fragment and the JSON.
  // Residency is proven first, so the query sorts and filters the same values
  // the header counts.
  async function releasePage(searchParams, { playbackAllowed = false } = {}) {
    const jobs = await store.listJobs()
    const catalogItems = await readVerifiedCatalog().catch(() => [])
    const releases = await proveResidency(releasesView(await libraryView(catalogItems, jobs, { playbackAllowed }), jobs))
    return { releases, page: queryReleases(releases, releaseQuery(searchParams)) }
  }

  // Cover bytes for one shelf entry, read back off the relay's own loopback
  // blob server. The URL is the runtime's own — the caller's entityId only ever
  // chooses which artwork the media graph resolves, and reaches no path, no
  // command and no origin this relay did not pick.
  async function readEntityPoster(entityId) {
    try {
      const artwork = await service.getVerifiedEntityArtwork?.({ entityId })
      if (artwork?.success !== true || artwork.exists !== true || typeof artwork.url !== 'string') return null
      const { res } = await openResponse(artwork.url, {
        timeoutMs: POSTER_READ_TIMEOUT_MS,
        timeoutMessage: 'poster read timed out'
      })
      if ((res.statusCode || 0) !== 200) {
        res.destroy?.()
        return null
      }
      const upstream = res.headers?.['content-type']
      return {
        contentType: typeof upstream === 'string' && upstream.startsWith('image/') ? upstream : 'image/jpeg',
        body: await readBody(res, { maxBytes: MAX_POSTER_BYTES })
      }
    } catch (err) {
      logger?.archive?.warn?.('Reading a library poster failed', { error: err?.message || String(err) })
      return null
    }
  }

  async function model(discoverParams = {}, { playbackAllowed = false } = {}) {
    const status = service.getStatus?.() || {}
    const jobs = await store.listJobs()
    const catalogItems = await readVerifiedCatalog().catch((err) => {
      logger?.archive?.warn?.('Reading the verified media catalog failed', { error: err?.message || String(err) })
      return []
    })
    const library = await libraryView(catalogItems, jobs, { playbackAllowed })
    return {
      status,
      jobs,
      library,
      releases: releasesView(library, jobs),
      creators: creatorsView(),
      unseededTargets: service.getCreatorTargets?.({ limit: 25 }) || status.creators?.unseededTargets || [],
      tmdb: tmdbView(),
      s3: service.s3 || {
        configured: false,
        endpoint: '',
        bucket: '',
        region: '',
        prefix: '',
        offload: { enabled: false, windowBytes: 0, restored: 0, residentBytes: 0 }
      },
      discover: await discoverView(discoverParams, catalogItems),
      trustedClients: service.getTrustedClients?.() || [],
      link: service.getLinkDescriptor?.() || null
    }
  }

  // A play link answers with the backend blob server's own loopback link: the
  // browser follows the 303 itself, and that server speaks HTTP Range with the
  // CORS headers a `<video>` element needs. Only that link's exact shape may
  // leave this route, so a compromised open cannot aim the operator's browser
  // at some other service on localhost.
  function playbackLocation(opened) {
    if (opened?.transport !== 'tcp' || typeof opened.url !== 'string') return null
    let url
    try {
      url = new URL(opened.url)
    } catch {
      return null
    }
    // Only the backend blob server's own link shape may leave this route: a
    // loopback http origin with the key/blob query `getLink` emits. Anything
    // else - a different path or service on localhost, credentials, a hash -
    // would let a bad descriptor aim the operator's browser somewhere else.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null
    if (url.pathname !== '/' || !url.searchParams.get('key') || !url.searchParams.get('blob')) return null
    if (url.username || url.password || url.hash) return null
    return url.toString()
  }
  function playbackCandidateRef(url) {
    let pathname
    try {
      pathname = new URL(url, 'http://relay.local').pathname
    } catch {
      return null
    }
    if (!pathname.startsWith('/play/')) return null
    try {
      const candidateRef = decodeURIComponent(pathname.slice('/play/'.length))
      return CANDIDATE_REF_PATTERN.test(candidateRef) ? candidateRef : null
    } catch {
      return null
    }
  }


  const handleRequest = async (req, res) => {
    try {
      if (typeof activeCompanionHandler === 'function' && (req.url === '/api/v2' || req.url.startsWith('/api/v2/') || req.url.startsWith('/api/v2?'))) {
        await activeCompanionHandler(req, res)
        return
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ready: true }))
        return
      }

      if (req.method === 'GET') {
        const parsed = new URL(req.url, 'http://relay.local')
        const playbackAllowed = allowsPlaybackRequest(req)
        // Playback is gated per request: the socket decides whether this
        // browser is on the relay's own machine.
        // `/` is the operator's release table. The catalog-browsing sections
        // moved to their own routes so a page is one job, not five.
        if (parsed.pathname === '/' || parsed.pathname === '/ui' || parsed.pathname === '/releases') {
          const { releases, page } = await releasePage(parsed.searchParams, { playbackAllowed })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(renderReleaseConsole({
            status: service.getStatus?.() || {},
            releases,
            localPlayback: playbackAllowed === true,
            page
          }, parsed.searchParams))
          return
        }

        if (parsed.pathname === '/releases.html') {
          const { page } = await releasePage(parsed.searchParams, { playbackAllowed })
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(renderReleaseRows(page))
          return
        }

        if (parsed.pathname === '/discover' || parsed.pathname === '/creators' || parsed.pathname === '/settings') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          const home = await model({
            query: parsed.searchParams.get('q') || '',
            type: parsed.searchParams.get('type') || 'movie',
            page: parsed.searchParams.get('page') || '1'
          }, { playbackAllowed })
          if (parsed.searchParams.get('notice') === 'empty-submission') home.notice = EMPTY_SUBMISSION_NOTICE
          res.end(renderArchiveWebHome(home, { view: parsed.pathname.slice(1) }))
          return
        }

        if (parsed.pathname.startsWith('/play/')) {
          if (!playbackAllowed) {
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('playback requires a loopback archive console')
            return
          }
          const candidateRef = playbackCandidateRef(req.url)
          const opened = candidateRef
            ? await service.openVerifiedPlayback?.(candidateRef).catch(() => null)
            : null
          const location = playbackLocation(opened)
          if (!location) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end('playback unavailable')
            return
          }
          res.writeHead(303, { location, 'cache-control': 'no-store' })
          res.end()
          return
        }
      }

      // A cover for one verified shelf entry. Every way of not having one
      // answers 404 so a missing thumbnail cannot make the library look broken.
      // Every way of not having a cover answers 404: an id that is not one, no
      // artwork on the claim, bytes that have not replicated yet, a blob server
      // that is not up. A 500 would paint the whole library as broken because
      // one thumbnail is missing.
      if (req.method === 'GET' && req.url.startsWith(POSTER_ROUTE_PREFIX)) {
        const entityId = posterEntityId(req.url)
        const poster = entityId ? await readEntityPoster(entityId) : null
        if (!poster) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        res.writeHead(200, {
          'content-type': poster.contentType,
          'content-length': String(poster.body.byteLength),
          // Private: the cover is only meaningful behind this relay's console,
          // and five minutes is long enough that a page reload does not re-read
          // every blob while still letting a newly arrived cover appear.
          'cache-control': 'private, max-age=300'
        })
        res.end(poster.body)
        return
      }

      if (req.method === 'GET' && req.url === '/tui') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(renderArchiveTui(await model()))
        return
      }

      if (req.method === 'GET' && req.url === '/jobs') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jobs: await store.listJobs() }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/releases.json')) {
        // The poll drives the table refresh in the browser. Gate it the same
        // way the page render is gated, or the first refresh would replace
        // enriched rows with rows the player cannot use.
        const playbackAllowed = allowsPlaybackRequest(req)
        const parsed = new URL(req.url, 'http://relay.local')
        const { page } = await releasePage(parsed.searchParams, { playbackAllowed })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ schema: 'peartube.relayReleases', version: 1, updatedAt: Date.now(), ...page }, null, 2))
        return
      }

      // Both verbs answer per id. A cancel that lands on a finished job changes
      // nothing, and the console has to say so rather than refresh and look
      // broken.
      if (req.method === 'POST' && (req.url === '/releases/cancel' || req.url === '/releases/clear' || req.url === '/releases/delete' || req.url === '/releases/retry')) {
        const verb = req.url === '/releases/cancel' ? 'cancel' : (req.url === '/releases/delete' ? 'delete' : (req.url === '/releases/retry' ? 'retry' : 'clear'))
        const params = new URLSearchParams(await collectBody(req))
        const ids = String(params.get('ids') || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 64)
        const results = []
        for (const id of ids) {
          if (verb === 'cancel') results.push(await cancelRelease(id))
          else if (verb === 'delete') results.push(await deleteRelease(id))
          else if (verb === 'retry') results.push(await retryRelease(id))
          else results.push(await clearRelease(id))
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          verb,
          done: results.filter(result => result.done).map(result => result.id || result.acquisitionId),
          refused: results.filter(result => !result.done),
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/creators.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayCreators',
          version: 1,
          updatedAt: Date.now(),
          creators: creatorsView()
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/unseeded.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayUnseededTargets',
          version: 1,
          updatedAt: Date.now(),
          targets: service.getCreatorTargets?.({ limit: 50 }) || []
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/clients.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayTrustedClients',
          version: 1,
          updatedAt: Date.now(),
          clients: service.getTrustedClients?.() || []
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url === '/link.json') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify(service.getLinkDescriptor?.() || { schema: 'peartube.relayLink', version: 2, seedPin: { enabled: false, authorizedClients: 0 } }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const catalogItems = await readVerifiedCatalog()
        const discover = await discoverView({
          query: parsed.searchParams.get('q') || '',
          type: parsed.searchParams.get('type') || 'movie',
          page: parsed.searchParams.get('page') || '1'
        }, catalogItems)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({
          schema: 'peartube.relayDiscover',
          version: 1,
          updatedAt: Date.now(),
          ...discover
        }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover/seasons.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const seasons = typeof service.discoverTmdbSeasons === 'function'
          ? await service.discoverTmdbSeasons({ tmdbId: parsed.searchParams.get('tmdbId') || '' }).catch(() => [])
          : []
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({ schema: 'peartube.relayTmdbSeasons', version: 1, seasons }, null, 2))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/discover/episodes.json')) {
        const parsed = new URL(req.url, 'http://relay.local')
        const episodes = typeof service.discoverTmdbEpisodes === 'function'
          ? await service.discoverTmdbEpisodes({
            tmdbId: parsed.searchParams.get('tmdbId') || '',
            season: parsed.searchParams.get('season') || ''
          }).catch(() => [])
          : []
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify({ schema: 'peartube.relayTmdbEpisodes', version: 1, episodes }, null, 2))
        return
      }


      if (req.method === 'POST' && req.url === '/discover/archive') {
        const { form, file } = await readArchiveSubmission(req)
        if (!file && !form.url) {
          // A submission with neither a file nor a URL enqueues nothing. Saying
          // so beats a bare redirect that looks exactly like success and leaves
          // the operator waiting for a job that was never created.
          logger?.archive?.warn?.('Archive submission ignored: no file and no source URL')
          res.writeHead(303, { location: `/?${EMPTY_SUBMISSION_QUERY}#discover` })
          res.end()
          return
        }
        await enqueueCatalogSubmission(form, file)
        res.writeHead(303, { location: '/#discover' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/archive') {
        const { form, file } = await readArchiveSubmission(req)
        if (!file && !form.url) {
          logger?.archive?.warn?.('Archive submission ignored: no file and no source URL')
          res.writeHead(303, { location: `/?${EMPTY_SUBMISSION_QUERY}` })
          res.end()
          return
        }
        await enqueueCatalogSubmission(form, file)
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/creators') {
        const form = parseCreatorForm(await collectBody(req))
        if (typeof service.addCreatorSource === 'function') {
          service.addCreatorSource(form).catch((err) => logger?.archive?.error?.('Add creator failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/settings/tmdb') {
        const form = parseTmdbForm(await collectBody(req))
        if (typeof service.setTmdbSettings === 'function') {
          await service.setTmdbSettings(form)
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/clients') {
        const form = parseClientForm(await collectBody(req))
        if (typeof service.authorizeClient === 'function') {
          await service.authorizeClient(form).catch((err) => logger?.archive?.error?.('Authorize client failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/clients/revoke') {
        const form = parseClientForm(await collectBody(req))
        if (typeof service.revokeClient === 'function') {
          await service.revokeClient(form.key).catch((err) => logger?.archive?.error?.('Revoke client failed', { error: err?.message || String(err) }))
        }
        res.writeHead(303, { location: '/' })
        res.end()
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    } catch (err) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(err?.message || String(err))
        } catch { /* ignored */ }
      }
    }
  }

  // Adopt the pre-bound socket, or open one when this console is the only thing
  // serving (tests, and any caller that builds a console on its own).
  const server = httpSurface ? httpSurface.server : await serverFactory(handleRequest)
  const boundPort = () => (httpSurface ? httpSurface.port : Number(port))

  return {
    store,
    manager,
    setCompanionHandler(handler) {
      activeCompanionHandler = handler
    },
    server,
    async start() {
      // Idempotent on an adopted surface: it is already listening as a warming
      // relay; only adopt the live handler once the provider acquisition service exists.
      if (httpSurface) {
        await httpSurface.listen()
        httpSurface.adopt(handleRequest)
      } else {
        await new Promise((resolve) => server.listen(Number(port), host, resolve))
      }
      logger?.archive?.info?.('Archive WebUI started', httpSurface
        ? { host, port: boundPort(), storeWarmupMs: httpSurface.warmupMs() }
        : { host, port: boundPort() })
      return this
    },
    async close() {
      if (httpSurface) {
        await httpSurface.close()
        return
      }
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
