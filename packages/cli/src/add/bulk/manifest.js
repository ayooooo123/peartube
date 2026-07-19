export const BULK_MANIFEST_VERSION = 1

export function createManifest ({
  channelDraft,
  targets = [],
  sources = [],
  assignments = [],
  exclusions = [],
  classifications = [],
  createdAt = Date.now(),
  updatedAt = createdAt
} = {}) {
  if (!channelDraft) throw new Error('manifest requires a channel draft')

  const manifest = {
    version: BULK_MANIFEST_VERSION,
    channelDraft,
    targets: sortById(targets).map((target) => Object.freeze({ ...target })),
    sources: sortById(sources).map((source) => Object.freeze({ ...source })),
    assignments: sortAssignments(assignments).map((assignment) => Object.freeze({ ...assignment })),
    exclusions: [...exclusions].sort().map(String),
    classifications: sortById(classifications, 'sourceId').map((entry) => Object.freeze({ ...entry })),
    createdAt,
    updatedAt
  }
  return deepFreeze(manifest)
}

export function serializeManifest (manifest) {
  return JSON.stringify(manifest, canonicalReplacer(manifest))
}

export function isReadyForUpload (manifest) {
  return unresolvedRows(manifest).length === 0
}

// Every selected target needs exactly one assignment; every non-excluded source
// must be assigned or explicitly excluded/classified.
export function unresolvedRows (manifest) {
  const assignedTargets = new Map()
  const assignedSources = new Set()
  for (const assignment of manifest.assignments) {
    assignedTargets.set(assignment.targetId, (assignedTargets.get(assignment.targetId) || 0) + 1)
    assignedSources.add(assignment.sourceId)
  }
  const excluded = new Set(manifest.exclusions)
  const classified = new Set(manifest.classifications.map((entry) => entry.sourceId))

  const unresolved = []
  for (const target of manifest.targets) {
    const count = assignedTargets.get(target.id) || 0
    if (count === 0) unresolved.push({ type: 'unassigned-target', id: target.id })
    else if (count > 1) unresolved.push({ type: 'duplicate-target', id: target.id })
  }
  for (const source of manifest.sources) {
    if (assignedSources.has(source.id) || excluded.has(source.id) || classified.has(source.id)) continue
    unresolved.push({ type: 'unassigned-source', id: source.id })
  }
  // A source may not map to two targets.
  const sourceCounts = new Map()
  for (const assignment of manifest.assignments) {
    sourceCounts.set(assignment.sourceId, (sourceCounts.get(assignment.sourceId) || 0) + 1)
  }
  for (const [sourceId, count] of sourceCounts) {
    if (count > 1) unresolved.push({ type: 'duplicate-source', id: sourceId })
  }
  return unresolved
}

function sortById (items, key = 'id') {
  return [...items].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0))
}

function sortAssignments (assignments) {
  return [...assignments].sort((a, b) => {
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0
  })
}

function canonicalReplacer () {
  return (key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted, prop) => {
        sorted[prop] = value[prop]
        return sorted
      }, {})
    }
    return value
  }
}

function deepFreeze (value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}
