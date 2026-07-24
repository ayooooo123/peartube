function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeSource(source = {}, index = 0) {
  const publicationId = String(source.publicationId || source.id || `source:${index}`)
  const renditionId = source.renditionId == null ? null : String(source.renditionId)
  return {
    ...source,
    publicationId,
    renditionId,
    publisherId: source.publisherId ?? null,
    sourceProvider: source.sourceProvider ?? source.provider ?? null,
    playable: source.playable === true,
    score: Number.isFinite(source.score) ? source.score : 0,
    playbackRef: renditionId ? { publicationId, renditionId } : null,
  }
}

export function projectMediaEntityGraph(input = {}) {
  const entity = input.entity || {}
  const sources = asArray(input.publications ?? input.sources).map(normalizeSource)
  const playable = sources.filter(source => source.playable).sort((a, b) => b.score - a.score || a.publicationId.localeCompare(b.publicationId))
  const primarySource = playable[0] || sources[0] || null
  const collectionItems = asArray(input.collectionItems).map((item, index) => ({
    entityId: String(item.entityId || item.id || `item:${index}`),
    title: item.title ?? null,
    position: Number.isFinite(item.position) ? item.position : index + 1,
    edition: item.edition ?? null,
    available: item.available !== false,
    sourceCount: asArray(item.sources).length,
    item,
  }))
  return {
    id: entity.entityId || input.entityId || null,
    title: entity.title || entity.metadata?.title || null,
    entity,
    sources,
    primarySource,
    playbackRef: primarySource?.playbackRef || null,
    creatorRoles: asArray(input.contributions).map(role => ({ agentId: role.agentId ?? null, name: role.name ?? null, role: role.role ?? 'contributor', provenance: role.provenance ?? null })),
    provenance: asArray(input.provenance),
    conflicts: asArray(input.conflicts),
    collection: { items: collectionItems, completeness: collectionItems.length === 0 ? 'none' : collectionItems.every(item => item.available) ? 'complete' : 'partial' },
    archiveStatus: input.archiveStatus || null,
  }
}
