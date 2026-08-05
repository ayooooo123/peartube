const DEFAULT_BASE_URL = 'https://api4.thetvdb.com/v4'
// v4 records normally carry absolute artwork urls; the host is only needed for
// the payloads (notably /search) that still hand back a bare /banners/... path.
const DEFAULT_ARTWORK_BASE_URL = 'https://artworks.thetvdb.com'
const DEFAULT_SEARCH_LIMIT = 20

// TheTVDB serves one rendition per artwork, so there is nothing to choose the
// way TMDB's wNNN buckets are chosen; naming it keeps the shared shape honest.
const ARTWORK_SIZE = 'original'

// Artwork type ids from GET /artwork/types, collapsed onto the three roles the
// rest of `add` knows about. Unlisted types (icons, banners, clear logos) have
// no home in the shared shape and are dropped.
const ARTWORK_TYPE_ROLES = new Map([
  [2, 'poster'], [7, 'poster'], [14, 'poster'],
  [3, 'backdrop'], [8, 'backdrop'], [15, 'backdrop'],
  [11, 'still'], [12, 'still']
])

const VIDEO_ROLES = ['poster', 'backdrop']

// /search answers with series, movies, people, companies and lists; only the
// first two are addressable as peartube coordinates.
const SEARCH_KINDS = new Map([['series', 'tv'], ['movie', 'movie']])

export class TvdbProviderError extends Error {
  constructor (message, { code, status } = {}) {
    super(message)
    this.name = 'TvdbProviderError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function createTvdbProvider ({
  apiKey,
  pin,
  fetch: fetchImpl,
  baseUrl = DEFAULT_BASE_URL,
  artworkBaseUrl = DEFAULT_ARTWORK_BASE_URL,
  searchLimit = DEFAULT_SEARCH_LIMIT,
  timeoutMs = 10000
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch

  // TheTVDB authenticates by exchanging the key for a bearer token that lives
  // about a month, so the token — never the key — travels with each request.
  // Cached here for the life of the provider; a 401 is the only thing that
  // invalidates it.
  let token = null
  let tokenExchange = null

  function requireKey () {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new TvdbProviderError('TVDB API key is not configured', { code: 'ERR_TVDB_MISSING_KEY' })
    }
  }

  // One shared fetch so every path maps transport faults identically, and so
  // the caller's signal and our own deadline compose into a single abort.
  async function send (url, init, signal) {
    const controller = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null
    const forwardAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    try {
      return await doFetch(url, { ...init, signal: controller.signal })
    } catch (cause) {
      if (cause && cause.name === 'AbortError') {
        throw new TvdbProviderError('TVDB request timed out', { code: 'ERR_TVDB_TIMEOUT' })
      }
      // Deliberately not interpolating `cause.message`: a failing agent can
      // echo the request it tried to make, and that request holds the key.
      throw new TvdbProviderError('TVDB request failed', { code: 'ERR_TVDB_NETWORK' })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', forwardAbort)
    }
  }

  async function decode (response, { allowUnauthorized = false } = {}) {
    if (response.status === 429) {
      throw new TvdbProviderError('TVDB rate limit exceeded', { code: 'ERR_TVDB_RATE_LIMIT', status: 429 })
    }
    if (response.status === 401 && allowUnauthorized) return null
    if (!response.ok) {
      throw new TvdbProviderError(`TVDB responded with ${response.status}`, { code: 'ERR_TVDB_HTTP', status: response.status })
    }
    try {
      return await response.json()
    } catch {
      throw new TvdbProviderError('TVDB returned invalid JSON', { code: 'ERR_TVDB_INVALID_JSON' })
    }
  }

  async function login (signal) {
    requireKey()
    const credentials = { apikey: apiKey }
    // An unset pin must be absent, not null: TVDB rejects a null pin outright,
    // and company keys have no pin at all.
    if (typeof pin === 'string' && pin.trim().length > 0) credentials.pin = pin
    else if (typeof pin === 'number' && Number.isFinite(pin)) credentials.pin = String(pin)
    const response = await send(`${baseUrl}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    }, signal)
    const payload = await decode(response)
    const next = payload?.data?.token
    if (typeof next !== 'string' || next.length === 0) {
      throw new TvdbProviderError('TVDB login returned no token', { code: 'ERR_TVDB_INVALID_JSON' })
    }
    return next
  }

  // Concurrent first calls share one exchange; a failure is never cached, so a
  // later call retries the login rather than inheriting the old rejection.
  async function authorize (signal, { refresh = false } = {}) {
    if (refresh) {
      token = null
      tokenExchange = null
    }
    if (token) return token
    if (!tokenExchange) {
      tokenExchange = login(signal).then(
        (next) => { token = next; tokenExchange = null; return next },
        (error) => { tokenExchange = null; throw error }
      )
    }
    return tokenExchange
  }

  async function request (path, params = {}, { signal } = {}) {
    requireKey()
    const url = buildUrl(baseUrl, path, params)
    const bearer = await authorize(signal)
    const first = await send(url, { headers: authHeaders(bearer) }, signal)
    const payload = await decode(first, { allowUnauthorized: true })
    if (payload !== null) return payload
    // Expired or revoked token: refresh exactly once and replay. A second 401
    // is a real authorization failure and is surfaced as one.
    const refreshed = await authorize(signal, { refresh: true })
    const retry = await send(url, { headers: authHeaders(refreshed) }, signal)
    return decode(retry)
  }

  function artwork (role, raw) {
    const url = absoluteHttpsUrl(raw, artworkBaseUrl)
    if (!url) return null
    return { role, provider: 'tvdb', path: raw, size: ARTWORK_SIZE, url }
  }

  // `image` is the record's own pick and always wins its role; anything else
  // comes from `artworks[]`, best score per role, in a stable role order.
  function collectArtwork (record, { primaryRole, roles }) {
    const chosen = new Map()
    const scores = new Map()
    const primary = artwork(primaryRole, record?.image)
    if (primary) {
      chosen.set(primaryRole, primary)
      scores.set(primaryRole, Infinity)
    }
    const candidates = Array.isArray(record?.artworks) ? record.artworks : []
    for (const candidate of candidates) {
      const role = ARTWORK_TYPE_ROLES.get(Number(candidate?.type))
      if (!role || !roles.includes(role)) continue
      const score = Number.isFinite(candidate?.score) ? candidate.score : 0
      if (chosen.has(role) && scores.get(role) >= score) continue
      const entry = artwork(role, candidate.image)
      if (!entry) continue
      chosen.set(role, entry)
      scores.set(role, score)
    }
    return roles.map((role) => chosen.get(role)).filter(Boolean)
  }

  return {
    async search (query, options = {}) {
      // No `type` filter: one round trip returns the mixed ranking and the
      // unusable kinds are dropped here, which is how the TMDB client reads
      // /search/multi. `limit` is left off so filtering cannot be starved of
      // results by high-ranking people or companies.
      const data = await request('/search', { query }, options)
      const results = Array.isArray(data?.data) ? data.data : []
      return results
        .filter((item) => SEARCH_KINDS.has(item?.type))
        .slice(0, searchLimit)
        .map((item) => {
          const kind = SEARCH_KINDS.get(item.type)
          const mediaId = searchMediaId(item)
          return {
            kind,
            provider: 'tvdb',
            mediaProvider: 'tvdb',
            mediaId,
            id: `tvdb:${kind}:${mediaId}`,
            title: item.name,
            year: parseYear(item.first_air_time) ?? parseYear(item.year),
            description: item.overview || '',
            badge: kind === 'tv' ? 'TV' : 'Movie',
            artwork: [artwork('poster', item.image_url)].filter(Boolean)
          }
        })
    },

    async getShow (id, options = {}) {
      const data = (await request(`/series/${id}/extended`, {}, options))?.data ?? {}
      return {
        kind: 'channel',
        profileKind: 'tvShow',
        provider: 'tvdb',
        mediaProvider: 'tvdb',
        mediaId: String(data.id ?? id),
        name: data.name,
        description: data.overview || '',
        year: parseYear(data.firstAired) ?? parseYear(data.year),
        originalLanguage: data.originalLanguage || null,
        artwork: collectArtwork(data, { primaryRole: 'poster', roles: VIDEO_ROLES }),
        seasons: officialSeasons(data.seasons)
      }
    },

    async getSeason (id, seasonNumber, options = {}) {
      // `default` is the aired-order season type. The api accepts a `season`
      // filter, but the same route also answers unfiltered for some series, so
      // the season is enforced on the decoded episodes too.
      const data = await request(`/series/${id}/episodes/default`, { season: seasonNumber }, options)
      const episodes = Array.isArray(data?.data?.episodes) ? data.data.episodes : []
      const wanted = Number(seasonNumber)
      return episodes
        .filter((episode) => !Number.isFinite(wanted) || Number(episode?.seasonNumber) === wanted)
        .map((episode) => ({
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.number,
          title: episode.name,
          description: episode.overview || '',
          airDate: episode.aired || null,
          artwork: collectArtwork(episode, { primaryRole: 'still', roles: ['still'] })
        }))
        .sort((left, right) => left.episodeNumber - right.episodeNumber)
    },

    async getMovie (id, options = {}) {
      const data = (await request(`/movies/${id}/extended`, {}, options))?.data ?? {}
      return {
        kind: 'channel',
        profileKind: 'movie',
        provider: 'tvdb',
        mediaProvider: 'tvdb',
        mediaId: String(data.id ?? id),
        title: data.name,
        description: data.overview || '',
        year: parseYear(data.first_release?.date) ?? parseYear(data.year),
        originalLanguage: data.originalLanguage || null,
        runtime: Number.isFinite(data.runtime) ? data.runtime : null,
        artwork: collectArtwork(data, { primaryRole: 'poster', roles: VIDEO_ROLES })
      }
    }
  }
}

function authHeaders (bearer) {
  return { Accept: 'application/json', Authorization: `Bearer ${bearer}` }
}

// The extended series record lists every ordering (aired, dvd, absolute) as
// separate season rows, so the same number can appear more than once; only the
// official ordering is offered to a publisher. Season names and per-season
// episode counts are not part of the record, so the name is derived and the
// count is honestly absent.
function officialSeasons (seasons) {
  const byNumber = new Map()
  for (const season of Array.isArray(seasons) ? seasons : []) {
    const type = season?.type
    const official = !type || type.type === 'official' || type.id === 1
    if (!official) continue
    const seasonNumber = Number(season.number)
    if (!Number.isInteger(seasonNumber) || byNumber.has(seasonNumber)) continue
    byNumber.set(seasonNumber, {
      seasonNumber,
      name: season.name || (seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`),
      episodeCount: null,
      airDate: null
    })
  }
  return [...byNumber.values()].sort((left, right) => left.seasonNumber - right.seasonNumber)
}

function searchMediaId (item) {
  if (item.tvdb_id != null && String(item.tvdb_id).length > 0) return String(item.tvdb_id)
  // Search rows are keyed `series-81189` / `movie-604` when tvdb_id is absent.
  const objectId = String(item.objectID ?? item.id ?? '')
  const suffix = objectId.slice(objectId.lastIndexOf('-') + 1)
  return suffix.length > 0 ? suffix : objectId
}

function buildUrl (baseUrl, path, params) {
  const search = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.push(`${key}=${encodeURIComponent(value)}`)
  }
  const query = search.length > 0 ? `?${search.join('&')}` : ''
  return `${baseUrl}${path}${query}`
}

function absoluteHttpsUrl (raw, artworkBaseUrl) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (raw.startsWith('https://')) return raw
  if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('/')) return `${artworkBaseUrl}${raw}`
  return null
}

function parseYear (date) {
  if (typeof date === 'number' && Number.isInteger(date)) return date
  if (typeof date !== 'string' || date.length < 4) return null
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : null
}
