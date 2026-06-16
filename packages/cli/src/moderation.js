import {
  MODERATION_ACTION_ALLOW,
  MODERATION_ACTION_BLOCK,
  MODERATION_ACTION_QUARANTINE,
  MODERATION_ACTION_WATCH,
  MODERATION_MODE_REPORT_AND_ALERT,
  VALID_MODERATION_ACTIONS,
  VALID_MODERATION_MODES
} from './constants.js'

const VALID_TARGET_TYPES = ['channelKey', 'ownerKey', 'videoId', 'blobsCoreKey', 'source', 'descriptorHash']

function normalizeTargetType(targetType) {
  if (targetType === 'channel') return 'channelKey'
  if (targetType === 'owner') return 'ownerKey'
  if (targetType === 'blobCore') return 'blobsCoreKey'
  if (targetType === 'feedEntry') return 'descriptorHash'
  return targetType
}

function normalizeRule(rule) {
  const targetType = normalizeTargetType(rule?.targetType)
  const target = typeof rule?.target === 'string' ? rule.target.trim() : ''
  const action = typeof rule?.action === 'string' ? rule.action.trim() : ''

  if (!VALID_TARGET_TYPES.includes(targetType)) {
    throw new Error(`Unsupported moderation target type "${targetType}"`)
  }
  if (!target) throw new Error('moderation rules require a target')
  if (!VALID_MODERATION_ACTIONS.includes(action)) {
    throw new Error(`Unsupported moderation action "${action}"`)
  }

  return {
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
    ? raw.rules.map(normalizeRule)
    : []

  return { mode, rules }
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

export function matchModerationRule(candidate = {}, rules = []) {
  for (const rule of rules || []) {
    if (rule.targetType === 'channelKey' && candidate.channelKey === rule.target) return rule
    if (rule.targetType === 'ownerKey' && candidate.ownerKey === rule.target) return rule
    if (rule.targetType === 'videoId' && candidate.videoId === rule.target) return rule
    if (rule.targetType === 'blobsCoreKey' && candidate.blobsCoreKey === rule.target) return rule
    if (rule.targetType === 'source' && candidate.source === rule.target) return rule
    if (rule.targetType === 'descriptorHash' && candidate.descriptorHash === rule.target) return rule
  }
  return null
}
