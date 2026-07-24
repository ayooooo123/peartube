function targets(entity = {}, record = {}) {
  const id = String(record.targetId)
  switch (record.targetType) {
    case 'publisher': return entity.publisherId === id
    case 'publication': return entity.publicationId === id
    case 'work': return entity.workId === id || entity.entityId === id
    case 'creator': return (entity.creatorIds || []).includes(id)
    case 'rendition': return entity.renditionId === id
    default: return false
  }
}

function normalizeAction(record = {}) {
  if (record.action === 'hide') return 'hidden'
  if (record.action === 'not-seeded') return 'not-seeded'
  if (record.action === 'allow') return 'visible'
  return 'not-downloaded'
}

function firstMatch(entity, records = []) {
  return (records || []).find(record => targets(entity, record)) || null
}

export function evaluateModerationPolicy(entity = {}, policy = {}) {
  const local = firstMatch(entity, policy.localBlocks)
  if (local) return { action: normalizeAction(local), reason: 'local-block', evidence: [{ source: 'local', record: local }] }
  const allow = firstMatch(entity, policy.localAllows)
  if (allow) return { action: 'visible', reason: 'local-allow', evidence: [{ source: 'local', record: allow }] }
  const feedBlock = firstMatch(entity, policy.feedBlocks)
  if (feedBlock) return { action: normalizeAction(feedBlock), reason: 'feed-block', evidence: [{ source: 'feed', record: feedBlock }] }
  const feedAllow = firstMatch(entity, policy.feedAllows)
  if (feedAllow) return { action: 'visible', reason: 'feed-allow', evidence: [{ source: 'feed', record: feedAllow }] }
  return { action: 'visible', reason: 'default', evidence: [] }
}
