import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { PROTOCOL_MAJOR } from './version.js'

const TOPIC_DOMAIN_PREFIX = 'peartube.scoped-topic.v1'

function cleanString(value, name) {
  const next = String(value || '').trim()
  if (!next) throw new Error(`${name} is required`)
  if (next.length > 512) throw new Error(`${name} is too long`)
  return next
}

function cleanId32(value, name) {
  if (b4a.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = b4a.from(value)
    if (bytes.byteLength !== 32) throw new Error(`${name} must be 32 bytes`)
    return b4a.toString(bytes, 'hex')
  }
  const next = cleanString(value, name).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(next)) throw new Error(`${name} must be 32-byte hex`)
  return next
}

function cleanMajor(value) {
  const major = Number(value ?? PROTOCOL_MAJOR)
  if (!Number.isSafeInteger(major) || major < 1 || major > 255) throw new Error('protocolMajor must be between 1 and 255')
  return major
}

function topic(role, fields = {}) {
  const body = JSON.stringify({ role, ...fields })
  return crypto.data(b4a.from(`${TOPIC_DOMAIN_PREFIX}:${body}`, 'utf8'))
}

export function topicHex(value) {
  return b4a.toString(b4a.from(value), 'hex')
}

export function deriveBootstrapTopic(input = {}) {
  return topic('bootstrap', {
    protocolMajor: cleanMajor(input.protocolMajor),
    networkId: cleanString(input.networkId || 'peartube-main', 'networkId'),
  })
}

export function derivePublisherTopic(input = {}) {
  return topic('publisher', {
    protocolMajor: cleanMajor(input.protocolMajor),
    publisherId: cleanString(input.publisherId, 'publisherId').toLowerCase(),
    catalogEpoch: Number(input.catalogEpoch || 0),
  })
}

export function deriveAssetTopic(input = {}) {
  return topic('asset', {
    protocolMajor: cleanMajor(input.protocolMajor),
    renditionId: cleanString(input.renditionId, 'renditionId'),
  })
}

export function deriveIndexTopic(input = {}) {
  return topic('index', {
    protocolMajor: cleanMajor(input.protocolMajor),
    curatorId: cleanString(input.curatorId, 'curatorId').toLowerCase(),
  })
}

export function deriveModerationTopic(input = {}) {
  return topic('moderation', {
    protocolMajor: cleanMajor(input.protocolMajor),
    moderatorId: cleanString(input.moderatorId, 'moderatorId').toLowerCase(),
  })
}

export function deriveLiveTopic(input = {}) {
  return topic('live', {
    protocolMajor: cleanMajor(input.protocolMajor),
    eventId: cleanString(input.eventId, 'eventId'),
    epoch: Number(input.epoch || 0),
    descriptorDigest: input.descriptorDigest ? cleanString(input.descriptorDigest, 'descriptorDigest').toLowerCase() : null,
  })
}

export function deriveArchiveDiscoveryTopic(input = {}) {
  return topic('archive-discovery', {
    protocolMajor: cleanMajor(input.protocolMajor),
    networkId: cleanString(input.networkId || 'peartube-main', 'networkId'),
  })
}

export function deriveArchiveTopic(input = {}) {
  return topic('archive', {
    protocolMajor: cleanMajor(input.protocolMajor),
    archiveId: cleanString(input.archiveId, 'archiveId'),
  })
}

// The curator feed scope above and an index service are both 'index' purposes
// but they are addressed by different identities, so each keeps its own topic.
export function deriveIndexerTopic(input = {}) {
  return topic('index', {
    protocolMajor: cleanMajor(input.protocolMajor),
    indexerId: cleanId32(input.indexerId, 'indexerId'),
  })
}

export function describeScopedTopic(role, input = {}) {
  switch (role) {
    case 'bootstrap':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), topicHex: topicHex(deriveBootstrapTopic(input)) }
    case 'publisher':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), publisherId: cleanString(input.publisherId, 'publisherId').toLowerCase(), catalogEpoch: Number(input.catalogEpoch || 0), topicHex: topicHex(derivePublisherTopic(input)) }
    case 'asset':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), renditionId: cleanString(input.renditionId, 'renditionId'), topicHex: topicHex(deriveAssetTopic(input)) }
    case 'index':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), curatorId: cleanString(input.curatorId, 'curatorId').toLowerCase(), topicHex: topicHex(deriveIndexTopic(input)) }
    case 'moderation':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), moderatorId: cleanString(input.moderatorId, 'moderatorId').toLowerCase(), topicHex: topicHex(deriveModerationTopic(input)) }
    case 'live':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), eventId: cleanString(input.eventId, 'eventId'), epoch: Number(input.epoch || 0), topicHex: topicHex(deriveLiveTopic(input)) }
    case 'archive-discovery':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), networkId: cleanString(input.networkId || 'peartube-main', 'networkId'), topicHex: topicHex(deriveArchiveDiscoveryTopic(input)) }
    case 'archive':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), archiveId: cleanString(input.archiveId, 'archiveId'), topicHex: topicHex(deriveArchiveTopic(input)) }
    case 'index':
      return { role, protocolMajor: cleanMajor(input.protocolMajor), indexerId: cleanId32(input.indexerId, 'indexerId'), topicHex: topicHex(deriveIndexTopic(input)) }
    default:
      throw new Error('unknown topic role')
  }
}
