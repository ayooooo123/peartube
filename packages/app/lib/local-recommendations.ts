/**
 * Local recommendations.
 *
 * One ranker, one file, no network. Everything it needs is already on this
 * device: the catalog page the app is holding and the watch state this device
 * wrote. There is no request to issue, no identity to attach, no score to
 * fetch, and no event to report — a recommendation here is arithmetic over
 * local rows.
 *
 * Two properties are load-bearing and are asserted by
 * `tests/local-recommendations.test.mjs`:
 *
 * - Purity. `now` arrives as an argument, never from the clock, so the same
 *   inputs always produce the same shelf and a test can pin time.
 * - Locality. The only signals are the tags and the creator the catalog row
 *   already carries plus what this device watched. Peer counts, publisher
 *   claims, and popularity are deliberately unused: a recommendation must not
 *   become a covert view counter.
 */
import { describeAvailability } from './media-availability.js'

/** One row of this device's own watch state, as written by `watch-history`. */
export type LocalWatchEntry = {
  entityId?: string | null
  entityRef?: string | null
  identity?: { entityRef?: string | null } | null
  title?: string | null
  tags?: readonly (string | null | undefined)[] | null
  creator?: string | null
  subtitle?: string | null
  positionSeconds?: number | null
  position?: number | null
  positionSec?: number | null
  durationSeconds?: number | null
  duration?: number | null
  durationSec?: number | null
  completed?: boolean | null
  saved?: boolean | null
  updatedAt?: number | null
}

/** A catalog row, held loosely: only these fields are ever read. */
export type RankableItem = {
  entityId?: string | null
  entityRef?: string | null
  title?: string | null
  subtitle?: string | null
  creator?: string | null
  creatorName?: string | null
  tags?: readonly (string | null | undefined)[] | null
  blocked?: boolean | null
  moderation?: { action?: string | null } | null
  policyDecision?: { action?: string | null } | null
  decision?: string | null
  availability?: unknown
  availabilityView?: { state?: string | null; offlinePlayable?: boolean | null } | null
}

/**
 * Why a title scored, in a form a surface can render without recomputing
 * anything. `kind` is the machine-readable discriminant; `label` is the copy.
 */
export type RecommendationReason = {
  kind: 'creator' | 'tag' | 'creator-and-tag'
  label: string
  creator: string | null
  tags: string[]
  /** The watched title that contributed the strongest matching signal. */
  sourceTitle: string | null
}

export type LocalRecommendation<TItem extends RankableItem = RankableItem> = TItem & {
  entityId: string
  recommendation: { score: number; reason: RecommendationReason }
}

export type RankLocalRecommendationsOptions<TItem extends RankableItem = RankableItem> = {
  items?: readonly TItem[] | null
  watchState?: readonly LocalWatchEntry[] | null
  /** Entity ids the caller already shows elsewhere, e.g. Continue Watching. */
  exclude?: Iterable<string> | null
  /**
   * Epoch ms, required. Supplied by the caller so ranking never reads the
   * clock. It is not optional and has no default: coercing a missing `now` to
   * zero silently put every watched title in the most recent bucket and turned
   * recency weighting off, so omitting it is a programming error.
   */
  now: number
  limit?: number | null
}

/** A shared creator is a stronger signal than a single shared tag. */
const TAG_WEIGHT = 1
const CREATOR_WEIGHT = 3

const DAY_MS = 86_400_000

/**
 * Recency is bucketed rather than continuous so every score stays an integer:
 * ties are then exact, and "stable ordering for ties" is a property of the
 * arithmetic instead of a float comparison that happens to work.
 */
const RECENCY_BUCKETS = Object.freeze([
  Object.freeze({ withinMs: 7 * DAY_MS, weight: 4 }),
  Object.freeze({ withinMs: 30 * DAY_MS, weight: 3 }),
  Object.freeze({ withinMs: 90 * DAY_MS, weight: 2 }),
])
const OLDEST_RECENCY_WEIGHT = 1

/** Finishing a title says more about taste than opening it does. */
const COMPLETED_ENGAGEMENT = 3
const HALF_WATCHED_ENGAGEMENT = 2
const STARTED_ENGAGEMENT = 1
const HALF_WATCHED_FRACTION = 0.5

/** Retention is bounded on both sides: history in, recommendations out. */
export const MAX_LOCAL_RECOMMENDATIONS = 40
export const MAX_WATCH_ENTRIES_CONSIDERED = 200
const DEFAULT_RECOMMENDATION_LIMIT = 20

const BLOCKING_MODERATION_ACTIONS: Record<string, true> = { blocked: true, hidden: true }

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function finite(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function entityIdOf(row: LocalWatchEntry | RankableItem | null | undefined): string | null {
  const identity = (row as LocalWatchEntry | null)?.identity
  return text(row?.entityId) || text(row?.entityRef) || text(identity?.entityRef) || null
}

function tagKeysOf(row: LocalWatchEntry | RankableItem): { key: string; label: string }[] {
  const tags = Array.isArray(row?.tags) ? row.tags : []
  const seen = new Set<string>()
  const out: { key: string; label: string }[] = []
  for (const tag of tags) {
    const label = text(tag)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, label })
  }
  return out
}

function creatorOf(row: LocalWatchEntry | RankableItem): string | null {
  return (
    text(row?.creator) ||
    text((row as RankableItem)?.creatorName) ||
    text(row?.subtitle) ||
    null
  )
}

/**
 * Ordering has to be total and input-order independent, or "deterministic"
 * would only mean "deterministic for the order the catalog happened to arrive
 * in". Title first because it is what a viewer sees, entity id as the final
 * tiebreak because it is unique.
 */
function compareStable(left: LocalRecommendation, right: LocalRecommendation): number {
  const leftTitle = text(left.title) || ''
  const rightTitle = text(right.title) || ''
  return leftTitle.localeCompare(rightTitle) || left.entityId.localeCompare(right.entityId)
}

function recencyWeight(entry: LocalWatchEntry, now: number): number {
  const updatedAt = finite(entry.updatedAt)
  if (updatedAt <= 0) return OLDEST_RECENCY_WEIGHT
  const age = now - updatedAt
  for (const bucket of RECENCY_BUCKETS) {
    if (age <= bucket.withinMs) return bucket.weight
  }
  return OLDEST_RECENCY_WEIGHT
}

/**
 * How much a watched title should count. Finishing something is the strongest
 * statement of taste available locally; opening it is the weakest.
 */
function engagementWeight(entry: LocalWatchEntry): number {
  if (entry.completed === true) return COMPLETED_ENGAGEMENT
  const duration = finite(entry.durationSeconds ?? entry.duration ?? entry.durationSec)
  const position = finite(entry.positionSeconds ?? entry.position ?? entry.positionSec)
  const fraction = duration > 0 ? position / duration : 0
  return fraction >= HALF_WATCHED_FRACTION ? HALF_WATCHED_ENGAGEMENT : STARTED_ENGAGEMENT
}

/**
 * Blocked or gone titles are never recommended. Moderation and availability
 * are read through the descriptions the rest of the app already uses, so a
 * viewer never sees the recommender disagree with the card it produced.
 */
function isUnrecommendable(item: RankableItem, now: number): boolean {
  if (item.blocked === true) return true
  const action = text(item.moderation?.action) || text(item.policyDecision?.action) || text(item.decision)
  if (action && BLOCKING_MODERATION_ACTIONS[action.toLowerCase()] === true) return true

  const view = item.availabilityView ?? describeAvailability(item.availability ?? null, now)
  return view?.state === 'unavailable' && view?.offlinePlayable !== true
}

/**
 * The most recent slice of watch state, capped. A long history must not make
 * ranking cost grow without bound, and the cap has to be deterministic rather
 * than "whatever order the store returned".
 */
function boundedWatchState(watchState: readonly LocalWatchEntry[] | null | undefined): LocalWatchEntry[] {
  const entries: { entry: LocalWatchEntry; entityId: string; updatedAt: number }[] = []
  for (const entry of Array.isArray(watchState) ? watchState : []) {
    const entityId = entityIdOf(entry)
    if (!entityId) continue
    entries.push({ entry, entityId, updatedAt: finite(entry.updatedAt) })
  }
  entries.sort((left, right) => right.updatedAt - left.updatedAt || left.entityId.localeCompare(right.entityId))
  return entries.slice(0, MAX_WATCH_ENTRIES_CONSIDERED).map(row => row.entry)
}

/**
 * One accumulated local signal — a tag or a creator. `weight` is the whole
 * affinity; `bestWeight` remembers the single strongest contributor so the
 * rendered reason can name a real watched title rather than a sum.
 */
type Signal = { weight: number; bestWeight: number; sourceTitle: string | null; sourceId: string }

function recordSignal(signals: Map<string, Signal>, key: string, weight: number, entry: LocalWatchEntry, entityId: string): void {
  const existing = signals.get(key)
  if (!existing) {
    signals.set(key, { weight, bestWeight: weight, sourceTitle: text(entry.title), sourceId: entityId })
    return
  }
  existing.weight += weight
  // Equal contributors resolve by entity id so the reason cannot flap with
  // whatever order the store happened to return.
  const stronger = weight > existing.bestWeight ||
    (weight === existing.bestWeight && entityId.localeCompare(existing.sourceId) < 0)
  if (!stronger) return
  existing.bestWeight = weight
  existing.sourceTitle = text(entry.title)
  existing.sourceId = entityId
}

function reasonLabel(kind: RecommendationReason['kind'], creator: string | null, sourceTitle: string | null, tags: string[]): string {
  if (kind !== 'tag' && creator) return `More from ${creator}`
  if (sourceTitle) return `Because you watched ${sourceTitle}`
  if (tags.length > 0) return `Shares ${tags[0]} with what you have watched`
  return 'From what you have watched on this device'
}

/**
 * Rank catalog rows against this device's watch state.
 *
 * Returns a bounded, stably ordered list. Every entry carries the score and
 * the reason it earned, so a surface renders the explanation instead of
 * inventing one. Anything with no local evidence behind it is absent rather
 * than present with a zero: an empty local state produces an empty list, which
 * is what keeps a fresh install from rendering a private rail at all.
 *
 * `now` is required. This function is pure and deliberately cannot reach the
 * clock, so a caller that forgets it has no sensible answer available: the old
 * coercion to zero made every entry look like it was watched minutes ago and
 * quietly disabled recency weighting. It throws instead.
 *
 * @throws {TypeError} when `now` is missing or not a finite epoch.
 */
export function rankLocalRecommendations<TItem extends RankableItem = RankableItem>(
  options: RankLocalRecommendationsOptions<TItem>,
): LocalRecommendation<TItem>[] {
  const now = options?.now
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`rankLocalRecommendations requires a finite \`now\` in epoch ms, received ${String(now)}`)
  }
  const limit = Math.max(
    0,
    Math.min(
      MAX_LOCAL_RECOMMENDATIONS,
      Math.floor(Number.isFinite(Number(options.limit)) ? Number(options.limit) : DEFAULT_RECOMMENDATION_LIMIT),
    ),
  )
  if (limit === 0) return []

  const watched = boundedWatchState(options.watchState)
  if (watched.length === 0) return []

  const excluded = new Set<string>()
  for (const id of options.exclude ?? []) {
    const value = text(id)
    if (value) excluded.add(value)
  }

  const tagSignals = new Map<string, Signal>()
  const creatorSignals = new Map<string, Signal>()
  for (const entry of watched) {
    const entityId = entityIdOf(entry)
    if (!entityId) continue
    // Already-watched titles are never recommended back, completed or not.
    excluded.add(entityId)
    const weight = recencyWeight(entry, now) * engagementWeight(entry)
    for (const tag of tagKeysOf(entry)) recordSignal(tagSignals, tag.key, weight, entry, entityId)
    const creator = creatorOf(entry)
    if (creator) recordSignal(creatorSignals, creator.toLowerCase(), weight, entry, entityId)
  }
  if (tagSignals.size === 0 && creatorSignals.size === 0) return []

  const seen = new Set<string>()
  const ranked: LocalRecommendation<TItem>[] = []
  for (const item of Array.isArray(options.items) ? options.items : []) {
    const entityId = entityIdOf(item)
    if (!entityId || seen.has(entityId)) continue
    seen.add(entityId)
    if (excluded.has(entityId)) continue
    if (isUnrecommendable(item, now)) continue

    let score = 0
    const matchedTags: string[] = []
    let strongestTag: Signal | null = null
    for (const tag of tagKeysOf(item)) {
      const signal = tagSignals.get(tag.key)
      if (!signal) continue
      score += TAG_WEIGHT * signal.weight
      matchedTags.push(tag.label)
      if (!strongestTag || signal.weight > strongestTag.weight) strongestTag = signal
    }

    const creator = creatorOf(item)
    const creatorSignal = creator ? creatorSignals.get(creator.toLowerCase()) ?? null : null
    if (creatorSignal) score += CREATOR_WEIGHT * creatorSignal.weight

    if (score <= 0) continue

    matchedTags.sort((left, right) => left.localeCompare(right))
    const kind: RecommendationReason['kind'] = creatorSignal
      ? (matchedTags.length > 0 ? 'creator-and-tag' : 'creator')
      : 'tag'
    const sourceTitle = (creatorSignal ?? strongestTag)?.sourceTitle ?? null
    ranked.push({
      ...item,
      entityId,
      recommendation: {
        score,
        reason: {
          kind,
          label: reasonLabel(kind, creatorSignal ? creator : null, sourceTitle, matchedTags),
          creator: creatorSignal ? creator : null,
          tags: matchedTags,
          sourceTitle,
        },
      },
    })
  }

  ranked.sort((left, right) => right.recommendation.score - left.recommendation.score || compareStable(left, right))
  return ranked.slice(0, limit)
}
