// What a viewer reads before pressing play: year, runtime, synopsis, genre.
//
// A consumer holds no metadata-provider credentials and cannot look any of it
// up, so a category that stays with the publisher is a category nobody
// downstream will ever see. It therefore travels on the same signed metadata
// claim as the title.
//
// One normalizer, used at both ends of that trip. At ingest it bounds what the
// publisher is about to sign, because the claim is size-capped and every peer
// on the network replays it, so an unbounded plot summary costs everyone. On
// the read side it bounds what somebody else signed, because a claim arriving
// over the wire never passed through this publisher's ingest and is a
// stranger's assertion, not trusted input. Two copies of these bounds would
// drift, and the read side is exactly where drifting is expensive: the bounded
// local index refuses a record carrying more than MAX_GENRES genres outright,
// so relaying an over-described claim unchanged does not over-report a title,
// it deletes the title from the consumer catalog.
//
// A category the publisher did not supply is absent. Never guessed, never an
// empty string, never a zero.
const MAX_OVERVIEW_BYTES = 2048
const MAX_GENRES = 8
const MAX_GENRE_BYTES = 64
const MIN_RELEASE_YEAR = 1870
const MAX_RELEASE_YEAR = 2200
const MAX_RUNTIME_MINUTES = 100000

export function describeMedia(input) {
  if (!input || typeof input !== 'object') return {}
  const out = {}
  const year = Number(input.releaseYear)
  if (Number.isSafeInteger(year) && year >= MIN_RELEASE_YEAR && year <= MAX_RELEASE_YEAR) out.releaseYear = year
  const runtime = Number(input.runtimeMinutes)
  if (Number.isSafeInteger(runtime) && runtime > 0 && runtime <= MAX_RUNTIME_MINUTES) out.runtimeMinutes = runtime
  if (typeof input.overview === 'string') {
    const overview = input.overview.trim()
    if (overview.length > 0) out.overview = overview.slice(0, MAX_OVERVIEW_BYTES)
  }
  if (Array.isArray(input.genres)) {
    const genres = []
    for (const genre of input.genres) {
      if (typeof genre !== 'string') continue
      const name = genre.trim()
      if (!name || name.length > MAX_GENRE_BYTES) continue
      if (!genres.includes(name)) genres.push(name)
      if (genres.length >= MAX_GENRES) break
    }
    if (genres.length > 0) out.genres = genres
  }
  return out
}
