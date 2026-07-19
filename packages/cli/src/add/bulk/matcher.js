// Evidence precedence: lower rank is stronger. Ranks 1-3 auto-assign when unique
// and injective; ranks 4-6 always stay review-required.
export const EVIDENCE_RANK = {
  stableId: 1,
  providerCoords: 2,
  embedded: 3,
  title: 4,
  date: 5,
  order: 6
}

const AUTO_MAX_RANK = 3
const EXTRA_PATTERN = /\b(trailer|teaser|extra|behind[\s._-]?the[\s._-]?scenes|bts|featurette|deleted[\s._-]?scene)\b/i

export function classifySource (source) {
  const haystack = `${source.title || ''} ${source.filename || source.path || ''}`
  if (source.classification) return source.classification
  const match = haystack.match(EXTRA_PATTERN)
  if (match) {
    const token = match[1].toLowerCase()
    if (token.startsWith('trailer') || token.startsWith('teaser')) return 'trailer'
    return 'extra'
  }
  return 'episode'
}

export function parseSeasonEpisode (value) {
  const text = String(value || '')
  let match = text.match(/s(\d{1,2})[._\s-]?e(\d{1,3})/i)
  if (match) return { seasonNumber: Number(match[1]), episodeNumber: Number(match[2]) }
  match = text.match(/\b(\d{1,2})x(\d{1,3})\b/)
  if (match) return { seasonNumber: Number(match[1]), episodeNumber: Number(match[2]) }
  return null
}

export function normalizeTitle (value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function evaluatePair (source, target) {
  if (source.sourceVideoId && target.sourceVideoId &&
      source.sourceProvider === target.sourceProvider &&
      source.sourceVideoId === target.sourceVideoId) {
    return 'stableId'
  }

  const targetHasCoords = target.seasonNumber != null && target.episodeNumber != null

  if (targetHasCoords && source.providerCoords &&
      source.seasonNumber === target.seasonNumber &&
      source.episodeNumber === target.episodeNumber) {
    return 'providerCoords'
  }

  if (targetHasCoords) {
    const embedded = source.embedded || parseSeasonEpisode(source.filename || source.path || source.title)
    if (embedded && embedded.seasonNumber === target.seasonNumber && embedded.episodeNumber === target.episodeNumber) {
      return 'embedded'
    }
  }

  if (target.title && source.title && normalizeTitle(source.title) === normalizeTitle(target.title)) {
    return 'title'
  }

  if (target.airDate && source.airDate && source.airDate === target.airDate) {
    return 'date'
  }

  return null
}

export function matchSources ({ sources = [], targets = [], alreadyAdded = {} } = {}) {
  const addedIds = new Set(alreadyAdded.sourceIds || [])
  const addedFingerprints = new Set(alreadyAdded.fingerprints || [])

  const rows = sources.map((source) => ({
    sourceId: source.id,
    source,
    classification: classifySource(source),
    status: rowStatus(source, addedIds, addedFingerprints)
  }))

  const assignable = rows.filter((row) => row.status === 'pending' && row.classification === 'episode')

  // Build ranked candidate edges.
  const edges = []
  for (const row of assignable) {
    for (const target of targets) {
      const evidence = evaluatePair(row.source, target)
      if (evidence) edges.push({ sourceId: row.sourceId, targetId: target.id, evidence, rank: EVIDENCE_RANK[evidence] })
    }
  }

  const assignments = []
  const assignedSources = new Set()
  const assignedTargets = new Set()

  for (let rank = 1; rank <= AUTO_MAX_RANK; rank += 1) {
    const rankEdges = edges.filter((edge) => edge.rank === rank &&
      !assignedSources.has(edge.sourceId) && !assignedTargets.has(edge.targetId))
    const bySource = groupBy(rankEdges, (edge) => edge.sourceId)
    const byTarget = groupBy(rankEdges, (edge) => edge.targetId)
    // Only unique-both-ways edges auto-assign; ties stay for review.
    const chosen = rankEdges.filter((edge) =>
      bySource.get(edge.sourceId).length === 1 && byTarget.get(edge.targetId).length === 1)
    chosen.sort((a, b) => compareIds(a, b))
    for (const edge of chosen) {
      if (assignedSources.has(edge.sourceId) || assignedTargets.has(edge.targetId)) continue
      assignments.push({ sourceId: edge.sourceId, targetId: edge.targetId, evidence: edge.evidence, confidence: 'exact', auto: true })
      assignedSources.add(edge.sourceId)
      assignedTargets.add(edge.targetId)
    }
  }

  // Remaining edges (any rank) become review suggestions.
  const suggestions = []
  for (const edge of edges) {
    if (assignedSources.has(edge.sourceId) || assignedTargets.has(edge.targetId)) continue
    suggestions.push({ sourceId: edge.sourceId, targetId: edge.targetId, evidence: edge.evidence, confidence: 'review', auto: false })
  }
  suggestions.sort((a, b) => a.rank - b.rank || compareIds(a, b))

  const unassignedSources = rows
    .filter((row) => row.status === 'pending' && row.classification === 'episode' && !assignedSources.has(row.sourceId))
    .map((row) => row.sourceId)
  const unmatchedTargets = targets.filter((target) => !assignedTargets.has(target.id)).map((target) => target.id)
  const alreadyAddedRows = rows.filter((row) => row.status === 'already-added').map((row) => row.sourceId)
  const classified = rows
    .filter((row) => row.classification !== 'episode')
    .map((row) => ({ sourceId: row.sourceId, classification: row.classification }))

  return {
    assignments,
    suggestions,
    unassignedSources,
    unmatchedTargets,
    alreadyAdded: alreadyAddedRows,
    classified,
    rows: rows.map((row) => ({ sourceId: row.sourceId, status: row.status, classification: row.classification }))
  }
}

function rowStatus (source, addedIds, addedFingerprints) {
  if (source.sourceVideoId && addedIds.has(`${source.sourceProvider || ''}:${source.sourceVideoId}`)) return 'already-added'
  if (source.sourceVideoId && addedIds.has(source.sourceVideoId)) return 'already-added'
  if (source.fingerprint && addedFingerprints.has(source.fingerprint)) return 'already-added'
  return 'pending'
}

function groupBy (items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    const group = map.get(key)
    if (group) group.push(item)
    else map.set(key, [item])
  }
  return map
}

function compareIds (a, b) {
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1
  if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1
  return 0
}
