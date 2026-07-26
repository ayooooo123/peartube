import b4a from 'b4a'

function identity(value) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(b4a.from(value), 'hex')
  const text = String(value ?? '')
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : text
}

function matches(id, values) {
  return values.some(value => value != null && identity(value) === id)
}

function targets(entity = {}, record = {}) {
  const id = identity(record.targetId)
  const entityRef = entity.entityRef
  switch (record.targetType) {
    case 'publisher': return matches(id, [entity.publisherId, entity.publisherRootKey, entityRef])
    case 'publication': return matches(id, [entity.publicationId, entityRef])
    case 'work': return matches(id, [entity.workId, entity.entityId, entityRef])
    case 'creator': return matches(id, [...(entity.creatorIds || []), entity.creatorId, entityRef])
    case 'rendition': return matches(id, [entity.renditionId, entityRef])
    case 'collection': return matches(id, [entity.collectionId, entityRef])
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
