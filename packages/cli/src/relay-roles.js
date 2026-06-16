import {
  DEFAULT_RELAY_ROLES,
  RELAY_ROLE_ARCHIVER,
  RELAY_ROLE_CACHE,
  RELAY_ROLE_PUBLIC_INDEX,
  VALID_RELAY_ROLES
} from './constants.js'

function splitRoleList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitRoleList(entry))
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function canonicalizeRoles(roles) {
  const roleSet = new Set(roles)
  return VALID_RELAY_ROLES.filter((role) => roleSet.has(role))
}

export function normalizeRelayRoles(value, { archiveEnabled = false } = {}) {
  const requested = splitRoleList(value)
  const roles = requested.length ? requested : [...DEFAULT_RELAY_ROLES]

  for (const role of roles) {
    if (!VALID_RELAY_ROLES.includes(role)) {
      throw new Error(`Unsupported relay role "${role}"`)
    }
  }

  if (archiveEnabled && !roles.includes(RELAY_ROLE_ARCHIVER)) {
    roles.push(RELAY_ROLE_ARCHIVER)
  }

  return canonicalizeRoles(roles)
}

export function buildRelayPosture(roles = DEFAULT_RELAY_ROLES) {
  const normalizedRoles = normalizeRelayRoles(roles)

  return {
    storesPublicMetadata: normalizedRoles.includes(RELAY_ROLE_PUBLIC_INDEX),
    storesMediaCache: normalizedRoles.includes(RELAY_ROLE_CACHE),
    storesArchivePublisherContent: normalizedRoles.includes(RELAY_ROLE_ARCHIVER),
    storesDecryptionKeys: false,
    nonKnowledgeRelay: false
  }
}

export function describeRelayPosture(posture = {}) {
  const parts = []

  parts.push(posture.storesPublicMetadata ? 'stores public metadata' : 'stores no public metadata')
  parts.push(posture.storesMediaCache ? 'stores public media cache' : 'stores no public media cache')
  if (posture.storesArchivePublisherContent) parts.push('stores archive publisher content')
  parts.push(posture.storesDecryptionKeys ? 'stores keys' : 'stores no keys')
  if (posture.nonKnowledgeRelay) parts.push('non-knowledge relay')

  return parts.join('; ')
}
