export type UploadPermission = 'disabled' | 'manual' | 'enabled'
export type NetworkMode = 'pause-network' | 'local-only' | 'allow'
export type RetentionMode = 'none' | 'local-pin' | 'archive-pledges'
export type AiAnalysisMode = 'disabled' | 'local-only' | 'enabled'

/**
 * How much this device is willing to contribute. One viewer-facing choice that
 * the backend turns into every ceiling; the app never derives a ceiling or an
 * eligibility decision from it. Mirrors PARTICIPATION_MODES in
 * packages/backend/src/playback/resource-policy.js.
 */
export type ParticipationMode = 'data-saver' | 'balanced' | 'help-more'

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
  participationMode: ParticipationMode
}

export type NetworkPolicyPatch = Partial<NetworkPolicy>

export type NetworkPolicyRpc = {
  getNetworkPolicy?: (request?: Record<string, never>) => Promise<unknown>
  setNetworkPolicy?: (request: Record<string, unknown>) => Promise<unknown>
  getParticipationStatus?: (request?: Record<string, never>) => Promise<unknown>
}

export const DEFAULT_NETWORK_POLICY: Readonly<NetworkPolicy> = Object.freeze({
  // Mirrors DEFAULT_NETWORK_POLICY in packages/backend/src/api/policy.js: a
  // device that holds a title serves it. This copy is the fallback whenever a
  // field is absent, so leaving it at 'manual' would quietly restore a
  // download-only peer.
  uploadPermission: 'enabled',
  meteredNetwork: 'pause-network',
  // The participation decision owns the background gates now, so the shipped
  // default no longer narrows the transport here. This must track the backend
  // default exactly: the screen resubmits the whole policy on save, and a
  // backgroundMode that differs from the stored value is recorded as a
  // deliberate operator narrowing — so a save made from a stale fallback would
  // pin 'local-only' for good and kill background contribution on this device.
  backgroundMode: 'allow',
  // Balanced is the fresh-install mode, so its ceilings are the fallback here:
  // 20 GiB of cache and 1 GiB of upload per rolling 24 hours, matching
  // PARTICIPATION_LIMITS.balanced in packages/backend/src/playback/resource-policy.js.
  diskCeilingBytes: 20 * 1024 * 1024 * 1024,
  uploadCeilingBytes: 1024 * 1024 * 1024,
  retentionMode: 'none',
  followedPublishers: Object.freeze([]) as unknown as string[],
  followedIndexes: Object.freeze([]) as unknown as string[],
  trustedModerationFeeds: Object.freeze([]) as unknown as string[],
  aiAnalysis: 'disabled',
  participationMode: 'balanced',
})

const UPLOAD_PERMISSIONS = new Set<UploadPermission>(['disabled', 'manual', 'enabled'])
const NETWORK_MODES = new Set<NetworkMode>(['pause-network', 'local-only', 'allow'])
const RETENTION_MODES = new Set<RetentionMode>(['none', 'local-pin', 'archive-pledges'])
const AI_MODES = new Set<AiAnalysisMode>(['disabled', 'local-only', 'enabled'])

export const PARTICIPATION_MODE_LABELS: Readonly<Record<ParticipationMode, string>> = Object.freeze({
  'data-saver': 'Data Saver',
  balanced: 'Balanced',
  'help-more': 'Help More',
})

/**
 * The viewer-facing choice, in the order it is presented. The copy states what
 * each mode actually does and never states a byte ceiling: the ceilings are the
 * backend's, they differ per mode, and repeating them here would be a promise
 * this screen cannot keep. Exact ceilings live in Developer Settings.
 */
export const PARTICIPATION_MODE_OPTIONS: readonly Readonly<{
  value: ParticipationMode
  label: string
  detail: string
}>[] = Object.freeze([
  Object.freeze({
    value: 'data-saver' as const,
    label: PARTICIPATION_MODE_LABELS['data-saver'],
    detail: 'Shares only while you are watching. Nothing is uploaded once playback stops, and nothing runs in the background.',
  }),
  Object.freeze({
    value: 'balanced' as const,
    label: PARTICIPATION_MODE_LABELS.balanced,
    detail: 'Shares while you watch and for a short while after. It may also help for a few minutes in the background when your device is idle, on an unmetered network, charged, and cool.',
  }),
  Object.freeze({
    value: 'help-more' as const,
    label: PARTICIPATION_MODE_LABELS['help-more'],
    detail: 'Raises your own upload and cache limits so this device can carry more. It cannot override your device or operating system: whatever your system reports about battery, temperature, free storage, metered networks, and background permission still stops it.',
  }),
])

const PARTICIPATION_MODES = new Set<ParticipationMode>(PARTICIPATION_MODE_OPTIONS.map((option) => option.value))
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
    participationMode: enumValue(value.participationMode, PARTICIPATION_MODES, base.participationMode, 'participation mode'),
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
    participationMode: normalized.participationMode,
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

/**
 * Live contribution state, decided entirely by the backend resource policy. The
 * app renders it; it never derives it. `suspended` means this device is not
 * contributing right now, and the copy below must never say otherwise.
 */
export type ParticipationState = 'uploading' | 'eligible' | 'suspended'

export type ParticipationStatus = {
  mode: ParticipationMode
  state: ParticipationState
  uploadEligible: boolean
  uploading: boolean
  backgroundEligible: boolean
  cacheCeilingBytes: number
  uploadCeilingBytesPer24h: number
  uploadedBytesLast24h: number
  outboundBytesPerSecond: number
  postPlaybackGraceMs: number
  backgroundRemainingSessionMs: number
  backgroundRemainingDailyMs: number
  reasonCodes: string[]
  /**
   * Set when the backend could not read its own policy. It still answers with a
   * complete suspended decision, so the screen reports the suspension it is
   * actually in rather than an empty "unavailable" — but it says why.
   */
  errorCode: string | null
}

const PARTICIPATION_STATES = new Set<ParticipationState>(['uploading', 'eligible', 'suspended'])

/** Mirrors MAX_PARTICIPATION_REASON_CODES in the backend resource policy. */
export const MAX_PARTICIPATION_REASON_CODES = 8
const MAX_REASON_CODE_LENGTH = 64

/**
 * Viewer-language rendering of the backend's canonical reason codes. A reason
 * explains what this device is not doing and why; none of them is a fault.
 *
 * A reason is not the same as a suspension. A signal the device could read and
 * that came back bad — metered, warm, low battery, low storage — stops every
 * kind of contribution. A signal the device could not read at all stops only
 * the opportunistic background work, because that is where the acceptance puts
 * those five requirements; upload during playback and its grace window is
 * promised outright. So an unknown-signal sentence names background sharing as
 * the thing that is off and never claims the device has stopped contributing —
 * it is routinely listed beside "Actively uploading".
 */
export const PARTICIPATION_REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  USER_DECLINED_P2P: 'Sharing is turned off for this device.',
  NETWORK_METERED: 'This connection is metered, so nothing is uploaded over it.',
  NETWORK_SIGNAL_UNKNOWN: 'This device cannot tell whether its connection is metered, so it will not share in the background.',
  THERMAL_PRESSURE: 'The device is running warm, so sharing is paused.',
  THERMAL_SIGNAL_UNKNOWN: 'This device cannot read its temperature, so it will not share in the background.',
  BATTERY_BELOW_FLOOR: 'Battery is low and the device is not plugged in.',
  POWER_SIGNAL_UNKNOWN: 'This device cannot read its battery or power state, so it will not share in the background.',
  DISK_BELOW_FLOOR: 'Free storage on this device is low.',
  DISK_SIGNAL_UNKNOWN: 'This device cannot read how much storage is free, so it will not share in the background.',
  BACKGROUND_NOT_PERMITTED: 'The system is not allowing background work right now.',
  BACKGROUND_SESSION_BUDGET_EXHAUSTED: 'This session has used up its background time.',
  BACKGROUND_DAILY_BUDGET_EXHAUSTED: 'Today has used up its background time.',
  MODE_BACKGROUND_DISABLED: 'Data Saver only shares while you are watching.',
  UPLOAD_QUOTA_EXHAUSTED: 'Today\u2019s upload allowance is used up.',
  OUTSIDE_PLAYBACK_WINDOW: 'Nothing is playing, so there is nothing to share right now.',
  // The backend falls back to its most constrained mode, never to the default
  // one, so this must not name a mode: naming one would promise the wrong
  // ceilings the moment that fallback changes.
  MODE_UNRECOGNIZED: 'This device did not recognise the saved sharing choice, so it is sharing as little as possible until you pick one again.',
})

const UNKNOWN_PARTICIPATION_REASON = 'This device reported a limit this version does not recognise.'

/**
 * Rendered when the backend answered with a failed envelope. It reports the
 * suspension that failure actually produces, not a softer "try again later".
 */
export const PARTICIPATION_UNAVAILABLE_COPY = 'This device could not read its own sharing policy, so it is contributing nothing until it can.'

export function participationReasonCopy(code: string): string {
  return PARTICIPATION_REASON_COPY[code] ?? UNKNOWN_PARTICIPATION_REASON
}

/**
 * What each state is allowed to claim. `eligible` is explicitly not a claim
 * that bytes are moving, and `suspended` never softens into one.
 */
export const PARTICIPATION_STATE_COPY: Readonly<Record<ParticipationState, Readonly<{ label: string; detail: string }>>> = Object.freeze({
  uploading: Object.freeze({
    label: 'Actively uploading',
    detail: 'This device is serving video to other viewers right now.',
  }),
  eligible: Object.freeze({
    label: 'Eligible to upload',
    detail: 'Nothing is being uploaded at this moment. This device will serve peers when they ask for something it holds.',
  }),
  suspended: Object.freeze({
    label: 'Suspended',
    detail: 'This device is not contributing right now.',
  }),
})

function requiredEnum<T extends string>(value: unknown, allowed: Set<T>, name: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new Error(`Invalid ${name}`)
  return value as T
}

function requiredCount(value: unknown, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${name}`)
  return number
}

function reasonCodes(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('Invalid participation reason codes')
  const codes: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Invalid participation reason codes')
    const code = item.trim()
    if (!code || code.length > MAX_REASON_CODE_LENGTH) continue
    if (!codes.includes(code)) codes.push(code)
    if (codes.length === MAX_PARTICIPATION_REASON_CODES) break
  }
  return codes
}

/**
 * Decode `get-participation-status`. Anything the backend did not actually say
 * is an error, not a default: a screen that guesses here would tell the viewer
 * their device is helping when it is not.
 *
 * A backend that could not read its own policy still answers with a complete
 * decision, and that decision is always `suspended`. That payload is accepted
 * and carries its `errorCode` through, because "suspended, and here is why" is
 * both true and more useful than a blank status. Any other state arriving on a
 * failed envelope is refused outright.
 */
export function normalizeParticipationStatus(input: unknown): ParticipationStatus {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid participation status response')
  const value = input as Record<string, unknown>
  const errorCode = typeof value.errorCode === 'string' ? value.errorCode.trim().slice(0, 120) : ''
  const failed = value.success !== true
  const state = requiredEnum(value.state, PARTICIPATION_STATES, 'participation state')
  if (failed && state !== 'suspended') throw new Error(errorCode || 'Contribution status is unavailable')
  return {
    mode: requiredEnum(value.mode, PARTICIPATION_MODES, 'participation mode'),
    state,
    uploadEligible: !failed && value.uploadEligible === true,
    uploading: !failed && value.uploading === true,
    backgroundEligible: !failed && value.backgroundEligible === true,
    cacheCeilingBytes: requiredCount(value.cacheCeilingBytes, 'cache ceiling'),
    uploadCeilingBytesPer24h: requiredCount(value.uploadCeilingBytesPer24h, 'upload ceiling'),
    uploadedBytesLast24h: requiredCount(value.uploadedBytesLast24h, 'uploaded bytes'),
    outboundBytesPerSecond: requiredCount(value.outboundBytesPerSecond, 'outbound rate'),
    postPlaybackGraceMs: requiredCount(value.postPlaybackGraceMs, 'post-playback grace'),
    backgroundRemainingSessionMs: requiredCount(value.backgroundRemainingSessionMs, 'background session remaining'),
    backgroundRemainingDailyMs: requiredCount(value.backgroundRemainingDailyMs, 'background daily remaining'),
    reasonCodes: reasonCodes(value.reasonCodes),
    errorCode: failed ? errorCode || 'PARTICIPATION_UNAVAILABLE' : null,
  }
}

export async function loadParticipationStatus(rpc: NetworkPolicyRpc | null | undefined): Promise<ParticipationStatus> {
  const response = await requireMethod(rpc, 'getParticipationStatus')({})
  return normalizeParticipationStatus(response)
}
