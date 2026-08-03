import { describeAvailability } from './media-availability.js'
import { rankLocalRecommendations } from './local-recommendations.ts'

/**
 * Home rail derivation.
 *
 * Every rail here is a pure, deterministic projection of one catalog page plus
 * this device's own state. Nothing in this file fetches, ranks remotely, or
 * reports anything: a recommendation is a local computation over local history,
 * and it stays that way.
 */

export const HOME_RAIL_IDS = Object.freeze([
  'continue-watching',
  'recommended',
  'trending',
  'recently-added',
  'movies',
  'series',
  'collections',
])

const RAIL_TITLES = Object.freeze({
  'continue-watching': 'Continue Watching',
  recommended: 'Recommended for You',
  trending: 'Trending',
  'recently-added': 'Recently Added',
  movies: 'Movies',
  series: 'Series',
  collections: 'Collections',
})

const RAIL_SUBTITLES = Object.freeze({
  'continue-watching': 'Kept on this device',
  recommended: 'Worked out on this device from what you have watched',
  // PearTube collects no viewing analytics, so "trending" cannot mean view
  // counts. The honest signal is how many independent peers are serving a
  // title right now, and the subtitle says so rather than implying otherwise.
  trending: 'Most peers sharing right now',
  'recently-added': 'New to your catalog',
  movies: null,
  series: null,
  collections: null,
})

const RESUME_MIN_FRACTION = 0.02
const RESUME_MAX_FRACTION = 0.95
const DEFAULT_RAIL_LIMIT = 20

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function entityIdOf(item) {
  return text(item?.entityId) || text(item?.entityRef) || null
}

function compareByTitleThenId(left, right) {
  const leftTitle = text(left.title) || ''
  const rightTitle = text(right.title) || ''
  return leftTitle.localeCompare(rightTitle) || String(left.entityId).localeCompare(String(right.entityId))
}

function peerCount(item) {
  const availability = item?.availability
  const complete = Number(availability?.completePeerCount) || 0
  const independent = Number(availability?.independentPeerCount) || 0
  return Math.max(complete, independent)
}

/**
 * A watch entry is resumable when it is genuinely mid-title: a few seconds in
 * is not "continue watching", and a title watched to the end belongs in
 * history, not on the shelf.
 */
export function isResumable(entry) {
  if (!entry || entry.completed === true) return false
  const position = Number(entry.positionSeconds ?? entry.position)
  const duration = Number(entry.durationSeconds ?? entry.duration)
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return false
  const fraction = position / duration
  return fraction >= RESUME_MIN_FRACTION && fraction <= RESUME_MAX_FRACTION
}

export function resumeFraction(entry) {
  const position = Number(entry?.positionSeconds ?? entry?.position)
  const duration = Number(entry?.durationSeconds ?? entry?.duration)
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(1, Math.max(0, position / duration))
}

function normalizeItems(items, now) {
  const seen = new Set()
  const normalized = []
  for (const item of Array.isArray(items) ? items : []) {
    const entityId = entityIdOf(item)
    if (!entityId || seen.has(entityId)) continue
    seen.add(entityId)
    normalized.push({
      ...item,
      entityId,
      title: text(item.title) || 'Untitled',
      entityKind: text(item.entityKind) || 'work',
      availabilityView: describeAvailability(item.availability ?? null, now),
    })
  }
  return normalized
}

function watchedEntityId(entry) {
  return text(entry?.entityId) || text(entry?.entityRef) || text(entry?.identity?.entityRef) || null
}

/**
 * Continue Watching is device-local by construction: it is the intersection of
 * this device's watch history with what the catalog can still show. It never
 * consults the network and never leaves the device.
 */
function continueWatching(items, watchState) {
  const byEntity = new Map(items.map(item => [item.entityId, item]))
  const entries = Array.isArray(watchState) ? watchState : []
  return entries
    .filter(isResumable)
    .map(entry => {
      const entityId = watchedEntityId(entry)
      const item = entityId ? byEntity.get(entityId) : null
      return item ? { ...item, resume: { fraction: resumeFraction(entry), updatedAt: Number(entry.updatedAt) || 0 } } : null
    })
    .filter(Boolean)
    .sort((left, right) => right.resume.updatedAt - left.resume.updatedAt || compareByTitleThenId(left, right))
}

/**
 * The personal store keeps progress, not metadata: a stored row knows what was
 * watched and how far, never its tags or its creator. Those come back off the
 * catalog row this device already holds, so the ranker has something to work
 * with without anything being asked of the network. Whatever the entry already
 * carries wins — the catalog only fills gaps.
 */
function withCatalogAffinities(items, watchState) {
  const entries = Array.isArray(watchState) ? watchState : []
  if (entries.length === 0) return entries
  const byEntity = new Map(items.map(item => [item.entityId, item]))
  return entries.map(entry => {
    const item = byEntity.get(watchedEntityId(entry))
    if (!item) return entry
    const tags = Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags : item.tags
    return {
      ...entry,
      tags,
      title: text(entry.title) || item.title,
      creator: text(entry.creator) || text(entry.subtitle) || text(item.subtitle) || text(item.creator) || undefined,
    }
  })
}

function railOf(id, items, limit) {
  return {
    id,
    title: RAIL_TITLES[id],
    subtitle: RAIL_SUBTITLES[id],
    // Private rails are computed from device-local state only and must never
    // be influenced by, or reported to, the network.
    private: id === 'continue-watching' || id === 'recommended',
    items: items.slice(0, limit),
  }
}

/**
 * Build every Home rail from one catalog page and this device's own state.
 *
 * `firstSeen` maps entity id to the epoch ms this device first admitted the
 * record. It is a local observation, never a publisher's claimed publish date,
 * so "Recently Added" means new to you rather than new to the world.
 *
 * The parameter is spelled out for callers: without it the empty defaults below
 * infer `never[]`, and every typed caller is rejected for passing real state.
 *
 * @param {{
 *   items?: readonly unknown[],
 *   watchState?: readonly unknown[],
 *   firstSeen?: Record<string, number>,
 *   now?: number,
 *   limit?: number,
 * }} [options]
 */
export function projectHomeRails({ items, watchState = [], firstSeen = {}, now = Date.now(), limit = DEFAULT_RAIL_LIMIT } = {}) {
  const normalized = normalizeItems(items, now)
  const resuming = continueWatching(normalized, watchState)
  const resumingIds = new Set(resuming.map(item => item.entityId))

  const works = normalized.filter(item => item.entityKind !== 'collection' && item.entityKind !== 'agent')
  const collections = normalized.filter(item => item.entityKind === 'collection')

  const rails = [
    railOf('continue-watching', resuming, limit),
    // Recommended has exactly one implementation, and it lives in
    // local-recommendations.ts: a pure function over this device's own state.
    railOf('recommended', rankLocalRecommendations({
      items: normalized,
      watchState: withCatalogAffinities(normalized, watchState),
      exclude: resumingIds,
      now,
      limit,
    }), limit),
    railOf(
      'trending',
      normalized
        .filter(item => peerCount(item) > 0)
        .sort((left, right) => peerCount(right) - peerCount(left) || compareByTitleThenId(left, right)),
      limit,
    ),
    railOf(
      'recently-added',
      // On a fresh install nothing has a recorded first-seen yet, and every
      // title genuinely is new to this catalog. Rather than hide the rail, fall
      // back to the stable comparator so it is present and deterministic from
      // the first run and sharpens as real first-seen times accumulate.
      normalized
        .slice()
        .sort((left, right) => (
          (Number(firstSeen[right.entityId]) || 0) - (Number(firstSeen[left.entityId]) || 0) ||
          compareByTitleThenId(left, right)
        )),
      limit,
    ),
    railOf('movies', works.filter(item => item.contentKind === 'movie' || item.entityKind === 'work').sort(compareByTitleThenId), limit),
    railOf('series', collections.filter(item => item.contentKind !== 'playlist').sort(compareByTitleThenId), limit),
    railOf('collections', collections.sort(compareByTitleThenId), limit),
  ]

  return rails.filter(rail => rail.items.length > 0)
}

/**
 * Search returns merged entities, never publisher uploads: one row per work or
 * collection, with the number of sources behind it available as detail rather
 * than as a list of separate results.
 *
 * @param {{ items?: readonly unknown[], query?: string | null, now?: number, limit?: number }} [options]
 */
export function projectSearchResults({ items, query, now = Date.now(), limit = 50 } = {}) {
  const needle = text(query)?.toLowerCase()
  const normalized = normalizeItems(items, now)
  const matched = needle
    ? normalized.filter(item => (
      item.title.toLowerCase().includes(needle) ||
      (text(item.subtitle) || '').toLowerCase().includes(needle)
    ))
    : normalized
  return matched
    .map(item => ({ ...item, sourceCount: Array.isArray(item.sources) ? item.sources.length : 0 }))
    .sort(compareByTitleThenId)
    .slice(0, limit)
}
