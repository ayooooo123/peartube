const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3'
const DEFAULT_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p'
const DEFAULT_LANGUAGE = 'en-US'
const DEFAULT_SEARCH_LIMIT = 20

const ARTWORK_SIZES = { poster: 'w500', backdrop: 'w780', still: 'w300' }

export class TmdbProviderError extends Error {
  constructor (message, { code, status } = {}) {
    super(message)
    this.name = 'TmdbProviderError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function createTmdbProvider ({
  apiKey,
  fetch: fetchImpl,
  baseUrl = DEFAULT_BASE_URL,
  imageBaseUrl = DEFAULT_IMAGE_BASE_URL,
  language = DEFAULT_LANGUAGE,
  searchLimit = DEFAULT_SEARCH_LIMIT,
  timeoutMs = 10000
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch

  async function request (path, params = {}, { signal } = {}) {
    if (!apiKey) {
      throw new TmdbProviderError('TMDB API key is not configured', { code: 'ERR_TMDB_MISSING_KEY' })
    }
    const url = buildUrl(baseUrl, path, { language, ...params })
    let response
    try {
      response = await doFetch(url, {
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      })
    } catch (cause) {
      if (cause && cause.name === 'AbortError') {
        throw new TmdbProviderError('TMDB request timed out', { code: 'ERR_TMDB_TIMEOUT' })
      }
      throw new TmdbProviderError(`TMDB request failed: ${cause.message}`, { code: 'ERR_TMDB_NETWORK' })
    }
    if (response.status === 429) {
      throw new TmdbProviderError('TMDB rate limit exceeded', { code: 'ERR_TMDB_RATE_LIMIT', status: 429 })
    }
    if (!response.ok) {
      throw new TmdbProviderError(`TMDB responded with ${response.status}`, { code: 'ERR_TMDB_HTTP', status: response.status })
    }
    try {
      return await response.json()
    } catch (cause) {
      throw new TmdbProviderError('TMDB returned invalid JSON', { code: 'ERR_TMDB_INVALID_JSON' })
    }
  }

  function artwork (role, path) {
    if (!path) return null
    return {
      role,
      provider: 'tmdb',
      path,
      size: ARTWORK_SIZES[role],
      url: `${imageBaseUrl}/${ARTWORK_SIZES[role]}${path}`
    }
  }

  function collectArtwork (record, roles) {
    const out = []
    for (const [role, key] of roles) {
      const entry = artwork(role, record[key])
      if (entry) out.push(entry)
    }
    return out
  }

  return {
    async search (query, options = {}) {
      const data = await request('/search/multi', { query, page: 1 }, options)
      const results = Array.isArray(data.results) ? data.results : []
      return results
        .filter((item) => item.media_type === 'tv' || item.media_type === 'movie')
        .slice(0, searchLimit)
        .map((item) => {
          const isTv = item.media_type === 'tv'
          return {
            kind: item.media_type,
            provider: 'tmdb',
            mediaProvider: 'tmdb',
            mediaId: String(item.id),
            id: `tmdb:${item.media_type}:${item.id}`,
            title: isTv ? item.name : item.title,
            year: parseYear(isTv ? item.first_air_date : item.release_date),
            description: item.overview || '',
            badge: isTv ? 'TV' : 'Movie',
            artwork: collectArtwork(item, [['poster', 'poster_path'], ['backdrop', 'backdrop_path']])
          }
        })
    },

    async getShow (id, options = {}) {
      const data = await request(`/tv/${id}`, {}, options)
      const seasons = Array.isArray(data.seasons) ? data.seasons : []
      return {
        kind: 'channel',
        profileKind: 'tvShow',
        provider: 'tmdb',
        mediaProvider: 'tmdb',
        mediaId: String(data.id),
        name: data.name,
        description: data.overview || '',
        year: parseYear(data.first_air_date),
        originalLanguage: data.original_language || null,
        artwork: collectArtwork(data, [['poster', 'poster_path'], ['backdrop', 'backdrop_path']]),
        seasons: seasons
          .map((season) => ({
            seasonNumber: season.season_number,
            name: season.name,
            episodeCount: season.episode_count,
            airDate: season.air_date || null
          }))
          .sort((left, right) => left.seasonNumber - right.seasonNumber)
      }
    },

    async getSeason (id, seasonNumber, options = {}) {
      const data = await request(`/tv/${id}/season/${seasonNumber}`, {}, options)
      const episodes = Array.isArray(data.episodes) ? data.episodes : []
      return episodes
        .map((episode) => ({
          seasonNumber: episode.season_number,
          episodeNumber: episode.episode_number,
          title: episode.name,
          description: episode.overview || '',
          airDate: episode.air_date || null,
          artwork: collectArtwork(episode, [['still', 'still_path']])
        }))
        .sort((left, right) => left.episodeNumber - right.episodeNumber)
    },

    async getMovie (id, options = {}) {
      const data = await request(`/movie/${id}`, {}, options)
      return {
        kind: 'channel',
        profileKind: 'movie',
        provider: 'tmdb',
        mediaProvider: 'tmdb',
        mediaId: String(data.id),
        title: data.title,
        description: data.overview || '',
        year: parseYear(data.release_date),
        originalLanguage: data.original_language || null,
        runtime: Number.isFinite(data.runtime) ? data.runtime : null,
        artwork: collectArtwork(data, [['poster', 'poster_path'], ['backdrop', 'backdrop_path']])
      }
    }
  }
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

function parseYear (date) {
  if (typeof date !== 'string' || date.length < 4) return null
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : null
}
