import { readFileSync } from 'node:fs'
import { resolveAddPreferences } from '../add/preferences.js'

// The consumer catalog pages at most 50 entities per call, so a full sweep is a
// bounded loop rather than one unbounded request. The page cap keeps a hostile
// or runaway catalog from turning `peartube search` into an infinite walk.
const CATALOG_PAGE_SIZE = 50
const CATALOG_PAGE_LIMIT = 40
const DEFAULT_SEARCH_LIMIT = 20

/**
 * A failure with a code the CLI can print verbatim. Codes are the backend's own
 * where one exists; nothing here invents a friendlier synonym.
 */
export class NetworkCommandError extends Error {
  constructor (errorCode, message, detail = null) {
    super(message)
    this.name = 'NetworkCommandError'
    this.errorCode = errorCode
    // What actually happened, when the code is a category the caller must not
    // have to guess behind.
    this.detail = detail
  }
}

export function write (stream, text) {
  if (stream && typeof stream.write === 'function') stream.write(text)
}

// Progress and backend chatter go to stderr so stdout carries exactly one
// result line, which is what makes `--json` pipeable.
export function progress (context, line) {
  write(context?.stderr, `${line}\n`)
}

function stderrLogger (stderr) {
  const emit = (...args) => write(stderr, `${args.map(String).join(' ')}\n`)
  return { log: emit, info: emit, warn: emit, error: emit, debug: emit }
}

function loadConfigFile (path) {
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

async function loadNetworkDeps (context) {
  if (context.deps) return context.deps
  const modulePath = context.env?.PEARTUBE_NETWORK_DEPS_MODULE
  if (modulePath) {
    const module = await import(modulePath)
    return (module.createDeps ? await module.createDeps(context) : module.default) || {}
  }
  return import('../add/runtime.js')
}

/**
 * Join the network exactly the way `peartube add` does: same storage and trust
 * resolution, same universal backend, same diagnostic routing. There is no
 * second bootstrap and no account.
 */
export async function openNetworkSession (context = {}) {
  const flags = context.flags || {}
  const config = typeof context.resolveConfig === 'function'
    ? await context.resolveConfig(context)
    : loadConfigFile(flags.config || context.env?.PEARTUBE_CONFIG || null)
  const preferences = resolveAddPreferences({ flags, env: context.env || {}, config })

  const deps = await loadNetworkDeps(context)
  if (typeof deps.openAddRuntime !== 'function') {
    throw new NetworkCommandError('NETWORK_RUNTIME_UNAVAILABLE', 'No backend runtime is available')
  }

  const runtime = await deps.openAddRuntime({
    storagePath: preferences.storagePath,
    network: preferences.network,
    logger: stderrLogger(context.stderr)
  })

  const api = runtime.api || runtime.backend?.api || null
  if (!api) {
    await runtime.close?.()
    throw new NetworkCommandError('NETWORK_RUNTIME_UNAVAILABLE', 'The backend runtime exposes no api surface')
  }

  return {
    runtime,
    api,
    preferences,
    async close () {
      await runtime.close?.()
    }
  }
}

/**
 * The one consumer catalog projection the app reads, walked to the end. The
 * catalog has no server-side text query, so matching happens here over what it
 * already returned rather than through a second index.
 */
export async function collectCatalogItems (api, { pageSize = CATALOG_PAGE_SIZE, pageLimit = CATALOG_PAGE_LIMIT } = {}) {
  const items = []
  let cursor = null
  for (let page = 0; page < pageLimit; page += 1) {
    const request = cursor == null ? { limit: pageSize } : { limit: pageSize, cursor }
    const response = await api.getMediaCatalog(request)
    if (!response?.success) {
      throw new NetworkCommandError(
        response?.errorCode || 'MEDIA_CATALOG_UNAVAILABLE',
        response?.error || 'The consumer catalog is unavailable'
      )
    }
    for (const item of response.items || []) items.push(item)
    cursor = response.nextCursor || null
    if (!cursor) break
  }
  return items
}

/**
 * Only what the catalog actually measured. A missing field stays missing: a peer
 * count is evidence, and absent evidence is not zero peers or a durability claim.
 */
export function availabilityFacts (availability) {
  if (!availability || typeof availability !== 'object') return null
  const facts = {}
  if (typeof availability.state === 'string' && availability.state.length > 0) facts.state = availability.state
  if (Number.isFinite(availability.independentPeerCount)) facts.independentPeerCount = availability.independentPeerCount
  if (Number.isFinite(availability.completePeerCount)) facts.completePeerCount = availability.completePeerCount
  return Object.keys(facts).length > 0 ? facts : null
}

function catalogAvailability (item) {
  const fromEntity = availabilityFacts(item?.availability)
  if (fromEntity) return fromEntity
  for (const source of item?.sources || []) {
    const facts = availabilityFacts(source?.availability)
    if (facts) return facts
  }
  return null
}

// What the publisher categorized this entry as, from the catalog entry itself:
// the entity kind the projection assigned it, plus the content kind of every
// publication behind it. Both are needed — a series is an entity kind and the
// episodes under it are a content kind, and a viewer looking for one of those
// should not have to know which of the two the catalog happened to record.
function itemKinds (item) {
  const kinds = new Set()
  if (typeof item?.entityKind === 'string' && item.entityKind) kinds.add(item.entityKind.toLowerCase())
  for (const source of item?.sources || []) {
    const kind = source?.mediaCoordinates?.contentKind
    if (typeof kind === 'string' && kind) kinds.add(kind.toLowerCase())
  }
  return kinds
}

function itemGenres (item) {
  return new Set(
    (Array.isArray(item?.genres) ? item.genres : [])
      .filter(genre => typeof genre === 'string' && genre)
      .map(genre => genre.toLowerCase())
  )
}

/**
 * The filters the caller asked for, or null when it asked for none. Each one is
 * kept verbatim so the result can report exactly what was applied rather than a
 * cleaned-up restatement of it.
 */
export function searchFilters (flags = {}) {
  const kind = typeof flags.kind === 'string' && flags.kind.trim() ? flags.kind.trim() : null
  const genres = (Array.isArray(flags.genres) ? flags.genres : [])
    .filter(genre => typeof genre === 'string' && genre.trim())
    .map(genre => genre.trim())
  if (!kind && genres.length === 0) return null
  return { ...(kind ? { kind } : {}), ...(genres.length > 0 ? { genres } : {}) }
}

// A repeated --genre narrows: every genre named has to be one the catalog
// reported for that entry. A filter naming a kind or a genre nothing carries
// matches nothing, which is an empty result, not an error.
function passesFilters (item, filters) {
  if (!filters) return true
  if (filters.kind && !itemKinds(item).has(filters.kind.toLowerCase())) return false
  if (filters.genres) {
    const genres = itemGenres(item)
    if (!filters.genres.every(genre => genres.has(genre.toLowerCase()))) return false
  }
  return true
}

export function matchCatalogItems (items, query, limit = DEFAULT_SEARCH_LIMIT, filters = null) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const hits = []
  for (const item of items) {
    const title = typeof item?.title === 'string' ? item.title : ''
    if (title.length === 0) continue
    const haystack = title.toLowerCase()
    if (!tokens.every(token => haystack.includes(token))) continue
    // Filtering before the limit is what makes `--limit 20 --genre Drama`
    // twenty dramas rather than however many of the first twenty titles
    // happened to be one.
    if (!passesFilters(item, filters)) continue
    hits.push(item)
    if (hits.length >= limit) break
  }
  return hits
}

// A category the catalog did not report is left out, exactly like a peer count
// it did not measure. A blank genre row or a `0 min` runtime would be the CLI
// asserting something about someone else's publication that nobody claimed.
function describeHit (item) {
  const availability = catalogAvailability(item)
  const genres = (Array.isArray(item.genres) ? item.genres : []).filter(genre => typeof genre === 'string' && genre)
  return {
    title: item.title,
    entityId: item.entityId,
    entityKind: item.entityKind || null,
    publicationCount: Array.isArray(item.sources) ? item.sources.length : 0,
    ...(availability ? { availability } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(Number.isSafeInteger(item.releaseYear) && item.releaseYear > 0 ? { releaseYear: item.releaseYear } : {}),
    ...(Number.isSafeInteger(item.runtimeMinutes) && item.runtimeMinutes > 0 ? { runtimeMinutes: item.runtimeMinutes } : {})
  }
}

// Every field here is a measurement the catalog reported. A count that is not
// there is left out rather than printed as zero, and none of them is restated
// as a durability claim.
function hitLine (hit) {
  const parts = [`${hit.title} [${hit.entityId}]`]
  if (hit.availability?.state) parts.push(`availability=${hit.availability.state}`)
  if (Number.isFinite(hit.availability?.independentPeerCount)) {
    parts.push(`independent-peers=${hit.availability.independentPeerCount}`)
  }
  if (Number.isFinite(hit.availability?.completePeerCount)) {
    parts.push(`complete-peers=${hit.availability.completePeerCount}`)
  }
  if (hit.releaseYear) parts.push(`year=${hit.releaseYear}`)
  if (hit.runtimeMinutes) parts.push(`runtime=${hit.runtimeMinutes}m`)
  if (hit.genres) parts.push(`genres=${hit.genres.join(',')}`)
  return parts.join(' ')
}

// A filtered search that says only "no titles match" is indistinguishable from
// an empty catalog, so both the hit and the miss name what was narrowed. `+`
// between genres because a repeated --genre requires all of them.
function filterClause (filters) {
  if (!filters) return ''
  const parts = []
  if (filters.kind) parts.push(`kind=${filters.kind}`)
  if (filters.genres) parts.push(`genre=${filters.genres.join('+')}`)
  return ` (${parts.join(', ')})`
}

export function finishNetworkCommand (context, result, lines) {
  const flags = context.flags || {}
  if (flags.json) write(context.stdout, `${JSON.stringify(result)}\n`)
  else write(context.stdout, `${lines.join('\n')}\n`)
  return result.status === 'failed' ? 1 : 0
}

export function networkFailure (command, error) {
  return {
    command,
    status: 'failed',
    errorCode: error?.errorCode || 'NETWORK_COMMAND_FAILED',
    error: error?.message || String(error),
    ...(error?.detail ? { detail: error.detail } : {})
  }
}

export function failureLine (result) {
  return `Failed: ${result.error} (${result.errorCode}${result.detail ? `: ${result.detail}` : ''})`
}

function searchLimit (flags) {
  return Number.isSafeInteger(flags.limit) && flags.limit > 0 ? flags.limit : DEFAULT_SEARCH_LIMIT
}

export async function runSearchCommand (context = {}) {
  const flags = context.flags || {}
  const query = String(context.query || '').trim()
  let session = null
  try {
    if (query.length === 0) throw new NetworkCommandError('INVALID_SEARCH_QUERY', 'Search requires a query')
    progress(context, 'Joining the network...')
    session = await openNetworkSession(context)
    progress(context, 'Reading the consumer catalog...')
    const items = await collectCatalogItems(session.api)
    const filters = searchFilters(flags)
    const results = matchCatalogItems(items, query, searchLimit(flags), filters).map(describeHit)
    const clause = filterClause(filters)
    const result = {
      command: 'search',
      status: 'ok',
      query,
      ...(filters ? { filters } : {}),
      count: results.length,
      results
    }
    const lines = results.length === 0
      ? [`No titles match "${query}"${clause}.`]
      : [...results.map(hitLine), `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"${clause}.`]
    return finishNetworkCommand(context, result, lines)
  } catch (error) {
    const result = networkFailure('search', error)
    return finishNetworkCommand(context, result, [failureLine(result)])
  } finally {
    await session?.close()
  }
}
