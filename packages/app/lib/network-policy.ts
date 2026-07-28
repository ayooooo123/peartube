export type UploadPermission = 'disabled' | 'manual' | 'enabled'
export type NetworkMode = 'pause-network' | 'local-only' | 'allow'
export type RetentionMode = 'none' | 'local-pin' | 'archive-pledges'
export type AiAnalysisMode = 'disabled' | 'local-only' | 'enabled'

export type NetworkPolicy = {
  uploadPermission: UploadPermission
  meteredNetwork: NetworkMode
  backgroundMode: NetworkMode
  diskCeilingBytes: number
  uploadCeilingBytes: number
  retentionMode: RetentionMode
  followedPublishers: string[]
  followedIndexes: string[]
  trustedModerationFeeds: string[]
  aiAnalysis: AiAnalysisMode
}

export type NetworkPolicyPatch = Partial<NetworkPolicy>

export type NetworkPolicyRpc = {
  getNetworkPolicy?: (request?: Record<string, never>) => Promise<unknown>
  setNetworkPolicy?: (request: Record<string, unknown>) => Promise<unknown>
}

export const DEFAULT_NETWORK_POLICY: Readonly<NetworkPolicy> = Object.freeze({
  // Mirrors DEFAULT_NETWORK_POLICY in packages/backend/src/api/policy.js: a
  // device that holds a title serves it. This copy is the fallback whenever a
  // field is absent, so leaving it at 'manual' would quietly restore a
  // download-only peer.
  uploadPermission: 'enabled',
  meteredNetwork: 'pause-network',
  backgroundMode: 'local-only',
  diskCeilingBytes: 5 * 1024 * 1024 * 1024,
  uploadCeilingBytes: Number.MAX_SAFE_INTEGER,
  retentionMode: 'none',
  followedPublishers: Object.freeze([]) as unknown as string[],
  followedIndexes: Object.freeze([]) as unknown as string[],
  trustedModerationFeeds: Object.freeze([]) as unknown as string[],
  aiAnalysis: 'disabled',
})

const UPLOAD_PERMISSIONS = new Set<UploadPermission>(['disabled', 'manual', 'enabled'])
const NETWORK_MODES = new Set<NetworkMode>(['pause-network', 'local-only', 'allow'])
const RETENTION_MODES = new Set<RetentionMode>(['none', 'local-pin', 'archive-pledges'])
const AI_MODES = new Set<AiAnalysisMode>(['disabled', 'local-only', 'enabled'])
const MAX_LIST_ITEMS = 256
const MAX_LIST_ITEM_LENGTH = 512

function requireMethod<T extends keyof NetworkPolicyRpc>(rpc: NetworkPolicyRpc | null | undefined, method: T) {
  const fn = rpc?.[method]
  if (typeof fn !== 'function') throw new Error('Network policy is unavailable in this build')
  return fn.bind(rpc) as Exclude<NetworkPolicyRpc[T], undefined>
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T, name: string): T {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new Error(`Invalid ${name}`)
  return value as T
}

function byteValue(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${name}`)
  return number
}

function boundedList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) throw new Error(`Invalid ${name}`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`Invalid ${name}`)
    const normalized = item.trim()
    if (!normalized || normalized.length > MAX_LIST_ITEM_LENGTH) throw new Error(`Invalid ${name}`)
    return normalized
  })
}

function parseList(value: unknown, fallback: readonly string[], name: string): string[] {
  if (value === undefined || value === null || value === '') return [...fallback]
  if (Array.isArray(value)) return boundedList(value, name)
  if (typeof value !== 'string' || value.length > MAX_LIST_ITEMS * (MAX_LIST_ITEM_LENGTH + 4)) {
    throw new Error(`Invalid ${name}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`Invalid ${name}`)
  }
  return boundedList(parsed, name)
}

function policyFields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid network policy response')
  const record = input as Record<string, unknown>
  if (record.policy && typeof record.policy === 'object' && !Array.isArray(record.policy)) {
    return { ...(record.policy as Record<string, unknown>), ...record }
  }
  return record
}

export function normalizeNetworkPolicyResponse(input: unknown, base: Readonly<NetworkPolicy> = DEFAULT_NETWORK_POLICY): NetworkPolicy {
  const value = policyFields(input)
  return {
    uploadPermission: enumValue(value.uploadPermission, UPLOAD_PERMISSIONS, base.uploadPermission, 'upload permission'),
    meteredNetwork: enumValue(value.meteredNetwork, NETWORK_MODES, base.meteredNetwork, 'metered network mode'),
    backgroundMode: enumValue(value.backgroundMode, NETWORK_MODES, base.backgroundMode, 'background mode'),
    diskCeilingBytes: byteValue(value.diskCeilingBytes, base.diskCeilingBytes, 'disk ceiling'),
    uploadCeilingBytes: byteValue(value.uploadCeilingBytes, base.uploadCeilingBytes, 'upload ceiling'),
    retentionMode: enumValue(value.retentionMode, RETENTION_MODES, base.retentionMode, 'retention mode'),
    followedPublishers: parseList(value.followedPublishersJson ?? value.followedPublishers, base.followedPublishers, 'followed publishers'),
    followedIndexes: parseList(value.followedIndexesJson ?? value.followedIndexes, base.followedIndexes, 'followed indexes'),
    trustedModerationFeeds: parseList(value.trustedModerationFeedsJson ?? value.trustedModerationFeeds, base.trustedModerationFeeds, 'trusted moderation feeds'),
    aiAnalysis: enumValue(value.aiAnalysis, AI_MODES, base.aiAnalysis, 'AI analysis mode'),
  }
}

export function mergeNetworkPolicy(current: Readonly<NetworkPolicy>, patch: NetworkPolicyPatch): NetworkPolicy {
  return normalizeNetworkPolicyResponse({ ...current, ...patch }, current)
}

export function networkPolicyRequest(policy: Readonly<NetworkPolicy>): Record<string, unknown> {
  const normalized = normalizeNetworkPolicyResponse(policy)
  return {
    uploadPermission: normalized.uploadPermission,
    meteredNetwork: normalized.meteredNetwork,
    backgroundMode: normalized.backgroundMode,
    diskCeilingBytes: normalized.diskCeilingBytes,
    diskCeilingBytesPresent: true,
    uploadCeilingBytes: normalized.uploadCeilingBytes,
    uploadCeilingBytesPresent: true,
    retentionMode: normalized.retentionMode,
    followedPublishersJson: JSON.stringify(normalized.followedPublishers),
    followedIndexesJson: JSON.stringify(normalized.followedIndexes),
    trustedModerationFeedsJson: JSON.stringify(normalized.trustedModerationFeeds),
    aiAnalysis: normalized.aiAnalysis,
  }
}

function resultError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return 'Network policy update returned an invalid response'
  const value = result as Record<string, unknown>
  if (value.success === true) return null
  const message = typeof value.error === 'string' ? value.error.trim().slice(0, 240) : ''
  return message || 'Network policy update was rejected'
}

export function createNetworkPolicyActions(rpc: NetworkPolicyRpc | null | undefined) {
  return Object.freeze({
    async load(): Promise<NetworkPolicy> {
      const response = await requireMethod(rpc, 'getNetworkPolicy')({})
      return normalizeNetworkPolicyResponse(response)
    },
    async save(current: Readonly<NetworkPolicy>, patch: NetworkPolicyPatch): Promise<NetworkPolicy> {
      const updated = mergeNetworkPolicy(current, patch)
      const result = await requireMethod(rpc, 'setNetworkPolicy')(networkPolicyRequest(updated))
      const error = resultError(result)
      if (error) throw new Error(error)
      return updated
    },
  })
}
