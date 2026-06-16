import {
  DEFAULT_REPORT_ALERT_THRESHOLD,
  MODERATION_ACTION_ALLOW,
  MODERATION_ACTION_BLOCK,
  MODERATION_ACTION_QUARANTINE,
  MODERATION_ACTION_WATCH,
  MODERATION_MODE_REPORT_AND_ALERT,
  VALID_MODERATION_ACTIONS,
  VALID_MODERATION_MODES
} from './constants.js'

export const VALID_MODERATION_TARGET_TYPES = ['channelKey', 'ownerKey', 'videoId', 'blobsCoreKey', 'source', 'descriptorHash']

export function normalizeModerationTargetType(targetType) {
  if (targetType === 'channel') return 'channelKey'
  if (targetType === 'owner') return 'ownerKey'
  if (targetType === 'blobCore') return 'blobsCoreKey'
  if (targetType === 'feedEntry') return 'descriptorHash'
  return targetType
}

export function normalizeModerationRule(rule) {
  const targetType = normalizeModerationTargetType(rule?.targetType)
  const target = typeof rule?.target === 'string' ? rule.target.trim() : ''
  const action = typeof rule?.action === 'string' ? rule.action.trim() : ''

  if (!VALID_MODERATION_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Unsupported moderation target type "${targetType}"`)
  }
  if (!target) throw new Error('moderation rules require a target')
  if (!VALID_MODERATION_ACTIONS.includes(action)) {
    throw new Error(`Unsupported moderation action "${action}"`)
  }

  return {
    ...(typeof rule.id === 'string' && rule.id.trim() ? { id: rule.id.trim() } : {}),
    targetType,
    target,
    action,
    source: typeof rule.source === 'string' && rule.source.trim() ? rule.source.trim() : 'local',
    ...(typeof rule.reason === 'string' && rule.reason.trim() ? { reason: rule.reason.trim() } : {}),
    ...(Number.isFinite(Number(rule.createdAt)) ? { createdAt: Number(rule.createdAt) } : {}),
    ...(Number.isFinite(Number(rule.expiresAt)) ? { expiresAt: Number(rule.expiresAt) } : {})
  }
}

export function normalizeModerationConfig(raw = {}) {
  const mode = typeof raw.mode === 'string' && raw.mode.trim()
    ? raw.mode.trim()
    : MODERATION_MODE_REPORT_AND_ALERT

  if (!VALID_MODERATION_MODES.includes(mode)) {
    throw new Error(`Unsupported moderation mode "${mode}"`)
  }

  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(normalizeModerationRule)
    : []
  const reportThreshold = Number(raw.reportThreshold ?? DEFAULT_REPORT_ALERT_THRESHOLD)

  if (!Number.isFinite(reportThreshold) || reportThreshold < 0) {
    throw new Error('moderation.reportThreshold must be a non-negative number')
  }

  return { mode, rules, reportThreshold }
}

export function summarizeModerationRules(rules = []) {
  const summary = {
    [MODERATION_ACTION_ALLOW]: 0,
    [MODERATION_ACTION_BLOCK]: 0,
    [MODERATION_ACTION_QUARANTINE]: 0,
    [MODERATION_ACTION_WATCH]: 0
  }

  for (const rule of rules || []) {
    if (Object.hasOwn(summary, rule?.action)) summary[rule.action] += 1
  }

  return summary
}

function sourceHost(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function sourceDomain(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized.startsWith('www.') ? normalized.slice(4) : normalized
}

export function buildSourceModerationCandidate(source = {}) {
  const raw = typeof source === 'string' ? { url: source } : source
  const sourceUrl = typeof raw?.url === 'string' ? raw.url.trim() : ''
  const sourceId = typeof raw?.sourceId === 'string' ? raw.sourceId.trim() : ''
  const host = sourceHost(sourceUrl)
  return {
    source: sourceUrl || sourceId,
    sourceUrl,
    sourceHost: host,
    sourceDomain: sourceDomain(host),
    sourceId
  }
}

function sourceRuleMatches(candidate = {}, target = '') {
  const rawTarget = String(target || '').trim()
  if (!rawTarget) return false

  const targetHost = sourceHost(rawTarget)
  const targetDomain = sourceDomain(targetHost || rawTarget)
  const values = [
    candidate.source,
    candidate.sourceUrl,
    candidate.sourceHost,
    candidate.sourceDomain,
    candidate.sourceId
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)

  if (values.includes(rawTarget)) return true
  const lowered = values.map((value) => value.toLowerCase())
  if (lowered.includes(rawTarget.toLowerCase())) return true
  if (targetHost && lowered.includes(targetHost)) return true
  if (targetDomain && lowered.includes(targetDomain)) return true
  if (targetDomain && candidate.sourceHost) {
    const host = String(candidate.sourceHost).toLowerCase()
    if (host === targetDomain || host.endsWith(`.${targetDomain}`)) return true
  }
  return false
}

export function matchModerationRule(candidate = {}, rules = []) {
  for (const rule of rules || []) {
    if (rule.targetType === 'channelKey' && candidate.channelKey === rule.target) return rule
    if (rule.targetType === 'ownerKey' && candidate.ownerKey === rule.target) return rule
    if (rule.targetType === 'videoId' && candidate.videoId === rule.target) return rule
    if (rule.targetType === 'blobsCoreKey' && candidate.blobsCoreKey === rule.target) return rule
    if (rule.targetType === 'source' && sourceRuleMatches(candidate, rule.target)) return rule
    if (rule.targetType === 'descriptorHash' && candidate.descriptorHash === rule.target) return rule
  }
  return null
}
