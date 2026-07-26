import b4a from 'b4a'

function identity(value) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) return b4a.toString(b4a.from(value), 'hex')
  const text = String(value ?? '')
  return /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : text
}

function matches(id, values) {
  return values.some(value => value != null && identity(value) === id)
}

function targetValues(entity = {}, targetType) {
  const entityRef = entity.entityRef
  switch (targetType) {
    case 'publisher': return [entity.publisherId, entity.publisherRootKey, entityRef]
    case 'publication': return [entity.publicationId, entityRef]
    case 'work': return [...(entity.workIds || []), entity.workId, entity.entityId, entityRef]
    case 'creator': return [...(entity.creatorIds || []), entity.creatorId, entityRef]
    case 'rendition': return [entity.renditionId, entityRef]
    case 'collection': return [...(entity.collectionIds || []), entity.collectionId, entityRef]
    default: return []
  }
}

function targets(entity = {}, record = {}) {
  return matches(identity(record.targetId), targetValues(entity, record.targetType))
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

function compileRecords(records = []) {
  const byType = new Map()
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const id = identity(record?.targetId)
    let byId = byType.get(record?.targetType)
    if (!byId) {
      byId = new Map()
      byType.set(record?.targetType, byId)
    }
    if (!byId.has(id)) byId.set(id, { index, record })
  }
  return entity => {
    let winner = null
    for (const [targetType, byId] of byType) {
      for (const value of targetValues(entity, targetType)) {
        if (value == null) continue
        const candidate = byId.get(identity(value))
        if (candidate && (!winner || candidate.index < winner.index)) winner = candidate
      }
    }
    return winner?.record || null
  }
}

export function createModerationPolicyEvaluator(policy = {}) {
  const localBlock = compileRecords(policy.localBlocks)
  const localAllow = compileRecords(policy.localAllows)
  const feedBlock = compileRecords(policy.feedBlocks)
  const feedAllow = compileRecords(policy.feedAllows)
  return (entity = {}) => {
    const local = localBlock(entity)
    if (local) return { action: normalizeAction(local), reason: 'local-block', evidence: [{ source: 'local', record: local }] }
    const allow = localAllow(entity)
    if (allow) return { action: 'visible', reason: 'local-allow', evidence: [{ source: 'local', record: allow }] }
    const blocked = feedBlock(entity)
    if (blocked) return { action: normalizeAction(blocked), reason: 'feed-block', evidence: [{ source: 'feed', record: blocked }] }
    const feed = feedAllow(entity)
    if (feed) return { action: 'visible', reason: 'feed-allow', evidence: [{ source: 'feed', record: feed }] }
    return { action: 'visible', reason: 'default', evidence: [] }
  }
}
