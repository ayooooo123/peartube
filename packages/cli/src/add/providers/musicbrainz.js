const DEFAULT_BASE_URL = 'https://musicbrainz.org/ws/2'
const DEFAULT_COVER_ART_BASE_URL = 'https://coverartarchive.org'
const DEFAULT_SEARCH_LIMIT = 20

// MusicBrainz asks every client for two things a key-based API would enforce
// for it: identify yourself, and stay under roughly one request per second.
// Both are policy, not suggestion — an anonymous or bursting client is served
// 503s — so both are built into this provider rather than left to callers.
const DEFAULT_USER_AGENT = 'PearTube/0.1 ( https://github.com/ayooooo123/peartube )'
const DEFAULT_MIN_INTERVAL_MS = 1000

// MusicBrainz runs its own hardware and answers a full release lookup in
// seconds, not milliseconds; a ten-second budget copied from a CDN-fronted API
// times out on it under load. Measured, not guessed.
const DEFAULT_TIMEOUT_MS = 20000

// `inc` is percent-encoded on the way out (`%2B`), which decodes to a literal
// `+` under both URI and form rules — the one spelling MusicBrainz cannot read
// as a space.
//
// A recording lookup takes `release-groups` even though the task only needs
// releases: it is the same request, and it is what puts the release group's
// MBID in reach without a second round trip. Its genres, however, are NOT
// included at that depth (verified live: the group whose own lookup lists
// thirteen genres reports none as a sub-entity of a recording), so a recording
// with no genres of its own still costs one extra lookup.
const RECORDING_INC = 'artist-credits+releases+release-groups+genres'
const RELEASE_INC = 'artist-credits+recordings+genres+release-groups'
const RELEASE_GROUP_INC = 'genres'

const SEARCH_ENDPOINTS = Object.freeze({
  track: Object.freeze({ path: '/recording', collection: 'recordings', badge: 'Track' }),
  release: Object.freeze({ path: '/release', collection: 'releases', badge: 'Release' })
})

export class MusicBrainzProviderError extends Error {
  constructor (message, { code, status } = {}) {
    super(message)
    this.name = 'MusicBrainzProviderError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function createMusicBrainzProvider ({
  fetch: fetchImpl,
  baseUrl = DEFAULT_BASE_URL,
  coverArtBaseUrl = DEFAULT_COVER_ART_BASE_URL,
  searchLimit = DEFAULT_SEARCH_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userAgent,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  // A caller may replace the agent; it may not remove it. Going out unnamed is
  // the one thing MusicBrainz asks us never to do.
  const agent = typeof userAgent === 'string' && userAgent.trim() !== '' ? userAgent.trim() : DEFAULT_USER_AGENT
  const headers = { Accept: 'application/json', 'User-Agent': agent }
  const enqueue = createRequestQueue({ minIntervalMs, now, sleep })

  function abortIfCancelled (signal) {
    if (signal && signal.aborted) {
      throw new MusicBrainzProviderError('MusicBrainz request was cancelled', { code: 'ERR_MUSICBRAINZ_TIMEOUT' })
    }
  }

  // The caller's signal wins when it exists; otherwise `timeoutMs` bounds the
  // request. The clock starts here, after the queue, so time spent waiting our
  // turn is not charged against the server's chance to answer.
  function requestSignal (signal) {
    if (signal) return signal
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
    return AbortSignal.timeout(timeoutMs)
  }

  async function send (url, { signal } = {}) {
    abortIfCancelled(signal)
    let response
    try {
      response = await doFetch(url, { signal: requestSignal(signal), headers })
    } catch (cause) {
      // A caller's AbortController raises AbortError; the deadline built from
      // `timeoutMs` raises TimeoutError. Both are "we stopped waiting".
      if (cause && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
        throw new MusicBrainzProviderError('MusicBrainz request timed out', { code: 'ERR_MUSICBRAINZ_TIMEOUT' })
      }
      throw new MusicBrainzProviderError(`MusicBrainz request failed: ${cause.message}`, { code: 'ERR_MUSICBRAINZ_NETWORK' })
    }
    // 503 is how MusicBrainz throttles; 429 is what a proxy in front of it
    // says. Both mean the same thing to a caller: wait, then try again.
    if (response.status === 503 || response.status === 429) {
      throw new MusicBrainzProviderError('MusicBrainz rate limit exceeded', {
        code: 'ERR_MUSICBRAINZ_RATE_LIMIT',
        status: response.status
      })
    }
    if (!response.ok) {
      throw new MusicBrainzProviderError(`MusicBrainz responded with ${response.status}`, {
        code: 'ERR_MUSICBRAINZ_HTTP',
        status: response.status
      })
    }
    try {
      return await response.json()
    } catch {
      throw new MusicBrainzProviderError('MusicBrainz returned invalid JSON', { code: 'ERR_MUSICBRAINZ_INVALID_JSON' })
    }
  }

  function request (path, params = {}, { signal } = {}) {
    return enqueue(() => send(buildUrl(baseUrl, path, { ...params, fmt: 'json' }), { signal }))
  }

  // Cover art lives on a different service with its own availability, and it
  // is decoration: a 404 (no art), a 500 (the archive is having a day) or a
  // dropped socket all mean "no artwork", never "no metadata". It is also not
  // queued behind the MusicBrainz interval, which governs musicbrainz.org.
  async function coverArt (releaseId, { signal } = {}) {
    if (typeof releaseId !== 'string' || releaseId === '') return []
    let response
    try {
      response = await doFetch(`${coverArtBaseUrl}/release/${encodeURIComponent(releaseId)}`, { signal, headers })
    } catch {
      return []
    }
    if (!response || !response.ok) return []
    let payload
    try {
      payload = await response.json()
    } catch {
      return []
    }
    return coverArtwork(payload)
  }

  // Only reached when the primary response answered with nothing. A failure
  // here is left to propagate: it means MusicBrainz just refused us, and
  // reporting that as "this album has no genres" would launder a rate limit
  // into a fact about the catalogue.
  async function releaseGroupGenres (releaseGroupId, options) {
    const data = await request(`/release-group/${encodeURIComponent(releaseGroupId)}`, { inc: RELEASE_GROUP_INC }, options)
    return genreNames(data && data.genres)
  }

  async function searchOne (kind, query, options) {
    const endpoint = SEARCH_ENDPOINTS[kind]
    const data = await request(endpoint.path, { query, limit: searchLimit }, options)
    const entries = Array.isArray(data && data[endpoint.collection]) ? data[endpoint.collection] : []
    return entries
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
      .slice(0, searchLimit)
      .map((entry) => toSearchItem(kind, entry))
  }

  return {
    async search (query, options = {}) {
      const requested = options.kind === undefined || options.kind === null
        ? Object.keys(SEARCH_ENDPOINTS)
        : [options.kind]
      for (const kind of requested) {
        if (!SEARCH_ENDPOINTS[kind]) {
          throw new MusicBrainzProviderError(
            `MusicBrainz describes ${Object.keys(SEARCH_ENDPOINTS).join(' and ')}, not ${String(kind)}`,
            { code: 'ERR_MUSICBRAINZ_UNKNOWN_KIND' }
          )
        }
      }
      const grouped = []
      for (const kind of requested) grouped.push(await searchOne(kind, query, options))
      return interleave(grouped).slice(0, searchLimit)
    },

    async getRecording (mbid, options = {}) {
      const data = await request(`/recording/${encodeURIComponent(mbid)}`, { inc: RECORDING_INC }, options)
      const releases = Array.isArray(data.releases) ? data.releases : []
      const primary = earliestRelease(releases)
      const releaseGroupId = firstReleaseGroupId(releases)
      const artist = artistCredit(data['artist-credit'])
      const own = genreNames(data.genres)
      const [genres, artwork] = await Promise.all([
        own !== null || releaseGroupId === null ? own : releaseGroupGenres(releaseGroupId, options),
        primary === null ? [] : coverArt(primary.id, options)
      ])
      const durationMs = Number.isFinite(data.length) ? data.length : null
      const firstReleaseDate = dateString(data['first-release-date']) ?? (primary === null ? null : dateString(primary.date))
      const id = typeof data.id === 'string' && data.id !== '' ? data.id : String(mbid)
      const recording = {
        kind: 'track',
        provider: 'musicbrainz',
        mediaProvider: 'musicbrainz',
        mediaId: id,
        id: `musicbrainz:track:${id}`,
        title: text(data.title),
        artist,
        description: describe(artist, primary === null ? null : text(primary.title)),
        year: parseYear(firstReleaseDate),
        firstReleaseDate,
        // Whole minutes are what the rest of the catalogue speaks; the exact
        // millisecond figure is the only precise number MusicBrainz gives, so
        // it is kept rather than rounded away.
        durationMs,
        runtime: durationMs === null ? null : Math.round(durationMs / 60000),
        release: primary === null
          ? null
          : { mediaId: primary.id, title: text(primary.title), date: dateString(primary.date) },
        releaseGroupId,
        artwork
      }
      if (genres !== null) recording.genres = genres
      return recording
    },

    async getRelease (mbid, options = {}) {
      const data = await request(`/release/${encodeURIComponent(mbid)}`, { inc: RELEASE_INC }, options)
      const group = data['release-group'] && typeof data['release-group'] === 'object' ? data['release-group'] : null
      // Verified against the live service: a release's own `genres` comes back
      // empty while its release group carries the whole taxonomy. The release
      // and recording lists are still read, because when they are populated
      // they are the more specific answer's only home.
      const genres = (group === null ? null : genreNames(group.genres)) ?? genreNames(data.genres)
      const artist = artistCredit(data['artist-credit'])
      const tracks = flattenTracks(data.media)
      const durationMs = totalDuration(tracks)
      const date = dateString(data.date)
      const id = typeof data.id === 'string' && data.id !== '' ? data.id : String(mbid)
      // The release itself says whether the archive holds anything, so a
      // coverless release costs no request at all.
      const archive = data['cover-art-archive']
      const hasArtwork = !(archive && typeof archive === 'object' && archive.artwork === false)
      const release = {
        kind: 'release',
        provider: 'musicbrainz',
        mediaProvider: 'musicbrainz',
        mediaId: id,
        id: `musicbrainz:release:${id}`,
        title: text(data.title),
        artist,
        // A release is named by its artist and nothing else; there is no
        // second work to place it against, as there is for a track.
        description: artist,
        year: parseYear(date ?? (group === null ? null : dateString(group['first-release-date']))),
        date,
        firstReleaseDate: group === null ? null : dateString(group['first-release-date']),
        releaseGroupId: group === null ? null : (typeof group.id === 'string' ? group.id : null),
        trackCount: tracks.length,
        durationMs,
        runtime: durationMs === null ? null : Math.round(durationMs / 60000),
        tracks,
        artwork: hasArtwork ? await coverArt(id, options) : []
      }
      if (genres !== null) release.genres = genres
      return release
    }
  }
}

// One request per second, measured from the moment each request *starts*: the
// policy bounds how often we knock, not how long an answer takes. Callers may
// fire concurrently; they queue here instead of bursting.
function createRequestQueue ({ minIntervalMs, now, sleep }) {
  let tail = Promise.resolve()
  let lastStartedAt = null
  const ignore = () => {}
  return function enqueue (start) {
    const turn = tail.then(async () => {
      if (lastStartedAt !== null) {
        const wait = minIntervalMs - (now() - lastStartedAt)
        if (wait > 0) await sleep(wait)
      }
      lastStartedAt = now()
    })
    // The queue survives a failing request: the next caller waits for its
    // turn, not for the last error to be handled.
    tail = turn.then(ignore, ignore)
    return turn.then(start)
  }
}

function toSearchItem (kind, entry) {
  const artist = artistCredit(entry['artist-credit'])
  const primary = kind === 'track' ? earliestRelease(entry.releases) : null
  const date = kind === 'track'
    ? (dateString(entry['first-release-date']) ?? (primary === null ? null : dateString(primary.date)))
    : dateString(entry.date)
  return {
    kind,
    provider: 'musicbrainz',
    mediaProvider: 'musicbrainz',
    mediaId: entry.id,
    id: `musicbrainz:${kind}:${entry.id}`,
    title: text(entry.title),
    year: parseYear(date),
    description: describe(artist, primary === null ? null : text(primary.title)),
    badge: SEARCH_ENDPOINTS[kind].badge,
    // Cover art is a request per release; a search result list is not worth
    // that many. Lookups fetch it, search does not.
    artwork: []
  }
}

function interleave (groups) {
  const out = []
  const longest = groups.reduce((max, group) => Math.max(max, group.length), 0)
  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      if (index < group.length) out.push(group[index])
    }
  }
  return out
}

// MusicBrainz publishes no free-text summary for a recording or a release, so
// the description is assembled from the artist credit (and, for a track, the
// release it appeared on). Nothing here is invented: every word is a field.
function describe (artist, context) {
  if (artist === null) return context
  return context === null ? artist : `${artist} — ${context}`
}

// `artist-credit` is a sequence of names and the phrases that join them —
// "Radiohead", or "Portishead feat. Beth Gibbons" — and only the whole
// sequence is the credit.
function artistCredit (credits) {
  if (!Array.isArray(credits)) return null
  let out = ''
  for (const credit of credits) {
    if (!credit) continue
    const name = typeof credit.name === 'string' && credit.name !== ''
      ? credit.name
      : (credit.artist && typeof credit.artist.name === 'string' ? credit.artist.name : null)
    if (name === null || name === '') continue
    out += name
    if (typeof credit.joinphrase === 'string') out += credit.joinphrase
  }
  out = out.trim()
  return out === '' ? null : out
}

// Genre names, most-tagged first, or nothing at all: an empty list would claim
// the catalogue had been asked and had answered "none".
function genreNames (entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const named = entries.filter((entry) => entry && typeof entry.name === 'string' && entry.name !== '')
  if (named.length === 0) return null
  return named
    .slice()
    .sort((left, right) => {
      const byCount = (Number.isFinite(right.count) ? right.count : 0) - (Number.isFinite(left.count) ? left.count : 0)
      if (byCount !== 0) return byCount
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    .map((entry) => entry.name)
}

// The earliest dated release a recording appeared on is the one that dates it
// and the one whose cover is its cover. A dated release always beats an
// undated one.
function earliestRelease (releases) {
  if (!Array.isArray(releases)) return null
  let best = null
  let bestKey = null
  for (const release of releases) {
    if (!release || typeof release.id !== 'string' || release.id === '') continue
    const key = dateSortKey(release.date)
    if (best === null) {
      best = release
      bestKey = key
      continue
    }
    if (key !== null && (bestKey === null || key < bestKey)) {
      best = release
      bestKey = key
    }
  }
  return best
}

// MusicBrainz dates come at whatever precision the editor knew: "1997",
// "1997-05", "1997-05-21". Compared as plain strings the vaguest wins, because
// "1997" is a prefix of every day in it — which is how a bare-year compilation
// came to outrank the album a track was actually written for. Padding the
// unknown parts high keeps a precise date ahead of the year that contains it.
function dateSortKey (value) {
  const date = dateString(value)
  if (date === null) return null
  const [year, month, day] = date.split('-')
  return `${year}-${month || '99'}-${day || '99'}`
}

function firstReleaseGroupId (releases) {
  if (!Array.isArray(releases)) return null
  for (const release of releases) {
    const group = release && release['release-group']
    if (group && typeof group.id === 'string' && group.id !== '') return group.id
  }
  return null
}

function flattenTracks (media) {
  const out = []
  if (!Array.isArray(media)) return out
  for (const medium of media) {
    if (!medium) continue
    const discNumber = Number.isFinite(medium.position) ? medium.position : null
    const tracks = Array.isArray(medium.tracks) ? medium.tracks : []
    for (const track of tracks) {
      if (!track) continue
      const recording = track.recording && typeof track.recording === 'object' ? track.recording : null
      const length = Number.isFinite(track.length)
        ? track.length
        : (recording !== null && Number.isFinite(recording.length) ? recording.length : null)
      out.push({
        position: Number.isFinite(track.position) ? track.position : null,
        discNumber,
        number: typeof track.number === 'string' ? track.number : null,
        title: text(track.title) ?? (recording === null ? null : text(recording.title)),
        mediaId: recording !== null && typeof recording.id === 'string' ? recording.id : null,
        durationMs: length
      })
    }
  }
  return out
}

function totalDuration (tracks) {
  let total = null
  for (const track of tracks) {
    if (track.durationMs === null) continue
    total = (total ?? 0) + track.durationMs
  }
  return total
}

// The archive serves http:// urls and a front cover flagged among the rest.
// Everything it hands back is a poster; the largest thumbnail wins because it
// is the one a picker can actually show.
function coverArtwork (payload) {
  const images = payload && Array.isArray(payload.images) ? payload.images : []
  const front = images.find((image) => image && image.front === true) || images.find((image) => image)
  if (!front) return []
  const thumbnails = front.thumbnails && typeof front.thumbnails === 'object' ? front.thumbnails : {}
  const candidates = [['large', thumbnails.large], ['small', thumbnails.small], ['original', front.image]]
  for (const [size, candidate] of candidates) {
    const url = secureUrl(candidate)
    if (url === null) continue
    return [{ role: 'poster', provider: 'musicbrainz', path: urlPath(url), size, url }]
  }
  return []
}

function secureUrl (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`
  return null
}

function urlPath (url) {
  try {
    return new URL(url).pathname
  } catch {
    return null
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

function text (value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function dateString (value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function parseYear (date) {
  if (typeof date !== 'string' || date.length < 4) return null
  const year = Number(date.slice(0, 4))
  return Number.isInteger(year) ? year : null
}
