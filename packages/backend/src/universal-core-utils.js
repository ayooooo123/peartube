export const ROLE_MOBILE = 'mobile'
export const ROLE_RELAY = 'relay'
export const ROLE_HYBRID = 'hybrid'

export const PLAYER_SHORTS = 'shorts'
export const PLAYER_MAIN = 'main'

export const TRANSITION_RANK = {
  discovered: 0,
  verified: 1,
  active: 2,
  quarantined: 3,
  tombstoned: 4,
}

export const DEFAULT_POLICY = {
  minDescriptorFreshnessMs: 10 * 60 * 1000,
  longTailWindowMs: 12 * 60 * 60 * 1000,
  proofFreshnessMs: 20 * 60 * 1000,
  minReachableCopies: 2,
  mobile: {
    maxFanout: 2,
    maxRequestsPerWindow: 4,
    syncIntervalMs: 20 * 60 * 1000,
    maxBytesPerDay: 50 * 1024 * 1024,
    proofIntervalMs: 45 * 60 * 1000,
    refreshIntervalMs: 90 * 60 * 1000,
    maxFeedEntries: 64,
  },
  relay: {
    maxFanout: 16,
    maxRequestsPerWindow: 64,
    syncIntervalMs: 2 * 60 * 1000,
    maxBytesPerDay: 5 * 1024 * 1024 * 1024,
    proofIntervalMs: 10 * 60 * 1000,
    refreshIntervalMs: 20 * 60 * 1000,
    maxFeedEntries: 512,
  },
}

export const DEFAULT_PLAYER_POLICY = {
  main: {
    priority: 100,
    activeBudget: 100,
    backgroundBudget: 15,
    maxConcurrentDecodes: 2,
    maxConcurrentPrefetches: 4,
    suspendAfterMs: 0,
    pipAllowed: true,
  },
  shorts: {
    priority: 20,
    activeBudget: 35,
    backgroundBudget: 8,
    maxConcurrentDecodes: 1,
    maxConcurrentPrefetches: 1,
    suspendAfterMs: 30 * 1000,
    pipAllowed: false,
  },
}

export function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function safeBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value)
    } catch {
      return fallback
    }
  }
  return fallback
}

export function toHex(bytes) {
  if (!bytes) return ''
  if (typeof bytes === 'string') return bytes.toLowerCase().replace(/^0x/, '')
  if (bytes instanceof Uint8Array) return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (bytes instanceof ArrayBuffer) return toHex(new Uint8Array(bytes))
  return String(bytes)
}

export function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Uint8Array) return `u8:${toHex(value)}`
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function hashText(input) {
  const str = stableStringify(input)
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function nowMs(value = Date.now()) {
  return safeBigInt(value, BigInt(Date.now()))
}

export function normalizeRole(role) {
  if (role === ROLE_RELAY || role === ROLE_MOBILE || role === ROLE_HYBRID) return role
  return ROLE_HYBRID
}

export function descriptorIdOf(value) {
  return toHex(value?.descriptorId || value?.id || value?.driveKey || value)
}

export function maxBigInt(...values) {
  return values.reduce((acc, value) => {
    const next = safeBigInt(value, 0n)
    return next > acc ? next : acc
  }, 0n)
}
