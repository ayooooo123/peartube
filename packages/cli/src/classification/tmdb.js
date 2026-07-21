import { DEFAULT_TMDB_BASE_URL, DEFAULT_TMDB_LANGUAGE } from '../constants.js'

const YEAR_RE = /\b(19\d{2}|20\d{2})\b/

// Tokens that commonly trail archived/ripped titles and hurt TMDB matching.
const NOISE_RE = new RegExp([
  '\\b(1080p|2160p|720p|480p|4k|uhd|hd|hdr|web[- ]?dl|webrip|bluray|brrip|bdrip|dvdrip|hdrip|x264|x265',
  'h264|h265|hevc|aac|ac3|dts|remux|proper|repack|extended|unrated|directors? cut|remastered',
  'official (video|trailer|audio)|lyric video|music video|full movie|full episode)\\b'
].join('|'), 'ig')

/**
 * Reduce a raw archived title into a TMDB-friendly query plus an optional year.
 * Pure and deterministic so it can be unit-tested without network access.
 */
export function parseTitleForTmdb(rawTitle) {
  const original = String(rawTitle || '').trim()
  if (!original) return { query: '', year: null }

  const yearMatch = original.match(YEAR_RE)
  const year = yearMatch ? Number(yearMatch[1]) : null

  let query = original
    // Strip bracketed/parenthesised qualifiers: (2019), [1080p], etc.
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(NOISE_RE, ' ')

  // Drop a trailing "SxxEyy" / "Season N" marker but remember it was episodic.
  query = query
    .replace(/\bS\d{1,2}\s?E\d{1,3}\b/ig, ' ')
    .replace(/\bSeason\s+\d+\b/ig, ' ')
    .replace(/\bEpisode\s+\d+\b/ig, ' ')
    // Collapse separators and trailing dashes left behind by stripping.
    .replace(/\s*[-|–—:]+\s*$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // Drop a bare trailing year ("Some Movie 2020") so it does not over-constrain
  // the search query — but only when other text precedes it, so a title that is
  // itself a year (e.g. "2012", "1917") is preserved.
  query = query.replace(/^(.+\S)\s+(19\d{2}|20\d{2})$/, '$1').trim()

  return { query: query || original, year }
}

function pickResult(results = []) {
  if (!Array.isArray(results) || results.length === 0) return null
  // Prefer the most popular candidate; TMDB returns them roughly in that order.
  return [...results].sort((a, b) => (Number(b?.popularity || 0) - Number(a?.popularity || 0)))[0]
}

function shapeResult(type, result) {
  if (!result) return null
  return {
    type,
    tmdbId: result.id ?? null,
    title: type === 'movie'
      ? (result.title || result.original_title || null)
      : (result.name || result.original_name || null),
    year: (() => {
      const date = type === 'movie' ? result.release_date : result.first_air_date
      const match = String(date || '').match(YEAR_RE)
      return match ? Number(match[1]) : null
    })(),
    posterPath: result.poster_path || null,
    popularity: Number(result.poster_path ? result.popularity || 0 : result.popularity || 0) || 0
  }
}


function createTimeoutSignal(timeoutMs) {
  if (typeof AbortController !== 'function') return { signal: undefined, cancel: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer?.unref?.()
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

function normalizeMediaType(type) {
  return type === 'tv' ? 'tv' : 'movie'
}

function shapeDiscoverItem(result = {}, fallbackType = null) {
  // /search/{type} responses omit media_type (only /trending and /multi carry
  // it), so fall back to the endpoint's known type — otherwise TV search rows
  // are mistyped as movies, lose their `name`-based title, and get dropped.
  const mediaType = normalizeMediaType(result.media_type || result.type || fallbackType)
  const title = mediaType === 'movie'
    ? (result.title || result.original_title || null)
    : (result.name || result.original_name || null)
  const date = mediaType === 'movie' ? result.release_date : result.first_air_date
  const match = String(date || '').match(YEAR_RE)
  return {
    type: mediaType,
    tmdbId: result.id ?? null,
    title,
    year: match ? Number(match[1]) : null,
    overview: result.overview || '',
    posterPath: result.poster_path || null,
    backdropPath: result.backdrop_path || null,
    popularity: Number(result.popularity || 0) || 0,
    voteAverage: Number(result.vote_average || 0) || 0,
    releaseDate: date || null
  }
}

export function createTmdbDiscoverClient({
  apiKey,
  baseUrl = DEFAULT_TMDB_BASE_URL,
  language = DEFAULT_TMDB_LANGUAGE,
  fetchFn = (typeof fetch === 'function' ? fetch : null),
  timeoutMs = 6000,
  enabled: configuredEnabled = true
} = {}) {
  const enabled = Boolean(configuredEnabled) && Boolean(apiKey) && typeof fetchFn === 'function'
  const apiBase = String(baseUrl || DEFAULT_TMDB_BASE_URL).replace(/\/$/, '')

  async function request(path, params = {}) {
    if (!enabled) return null
    const query = new URLSearchParams({ api_key: apiKey, language, ...params })
    const { signal, cancel } = createTimeoutSignal(timeoutMs)
    try {
      const res = await fetchFn(`${apiBase}${path}?${query.toString()}`, { signal })
      if (!res?.ok) return null
      return await res.json()
    } catch {
      return null
    } finally {
      cancel()
    }
  }

  function normalizeResults(body, fallbackType = null) {
    return (Array.isArray(body?.results) ? body.results : [])
      .map((result) => shapeDiscoverItem(result, fallbackType))
      .filter((item) => item.tmdbId && item.title)
      .sort((a, b) => b.popularity - a.popularity)
  }

  return {
    enabled,
    async trending({ type = 'movie', page = 1 } = {}) {
      const mediaType = normalizeMediaType(type)
      const body = await request(`/trending/${mediaType}/week`, { page: String(Math.max(1, Number(page) || 1)) })
      return normalizeResults(body, mediaType)
    },
    async search({ query, type = 'movie', page = 1 } = {}) {
      const q = String(query || '').trim()
      if (!q) return this.trending({ type, page })
      const mediaType = normalizeMediaType(type)
      const body = await request(`/search/${mediaType}`, {
        query: q,
        include_adult: 'false',
        page: String(Math.max(1, Number(page) || 1))
      })
      return normalizeResults(body, mediaType)
    },
    posterUrl(path, size = 'w342') {
      return path ? `https://image.tmdb.org/t/p/${size}${path}` : null
    }
  }
}

/**
 * Best-effort movie/TV classifier backed by TMDB's `search` endpoints.
 * `fetchFn` is injectable for testing and defaults to the global fetch (absent
 * in some Bare builds, in which case classification cleanly returns `unknown`).
 */
export function createTmdbClassifier({
  apiKey,
  baseUrl = DEFAULT_TMDB_BASE_URL,
  language = DEFAULT_TMDB_LANGUAGE,
  fetchFn = (typeof fetch === 'function' ? fetch : null),
  timeoutMs = 6000,
  enabled: configuredEnabled = true
} = {}) {
  const enabled = Boolean(configuredEnabled) && Boolean(apiKey) && typeof fetchFn === 'function'

  async function searchOne(kind, query, year) {
    const params = new URLSearchParams({ api_key: apiKey, query, language, include_adult: 'false' })
    if (year) params.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(year))
    const url = `${baseUrl.replace(/\/$/, '')}/search/${kind}?${params.toString()}`

    let signal
    let timer = null
    if (typeof AbortController === 'function') {
      const controller = new AbortController()
      signal = controller.signal
      timer = setTimeout(() => controller.abort(), timeoutMs)
      timer?.unref?.()
    }
    try {
      const res = await fetchFn(url, { signal })
      if (!res?.ok) return null
      const body = await res.json()
      return shapeResult(kind, pickResult(body?.results))
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    enabled,
    async classify({ title, year = null } = {}) {
      const parsed = parseTitleForTmdb(title)
      const effectiveYear = year || parsed.year
      if (!enabled || !parsed.query) {
        return { type: 'unknown', tmdbId: null, title: null, year: effectiveYear, posterPath: null }
      }

      const [movie, tv] = await Promise.all([
        searchOne('movie', parsed.query, effectiveYear),
        searchOne('tv', parsed.query, effectiveYear)
      ])

      const candidates = [movie, tv].filter(Boolean)
      if (candidates.length === 0) {
        return { type: 'unknown', tmdbId: null, title: null, year: effectiveYear, posterPath: null }
      }
      const best = candidates.sort((a, b) => (b.popularity - a.popularity))[0]
      return { ...best, classifiedAt: Date.now() }
    }
  }
}
