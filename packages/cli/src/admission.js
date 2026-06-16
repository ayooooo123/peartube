import { RETENTION_PRIORITY } from './constants.js'
import { matchModerationRule } from './moderation.js'

function hasAllowlistedChannel(candidate, config) {
  return Boolean(candidate.channelKey) && config.admission.channels.includes(candidate.channelKey)
}

function hasAllowlistedOwner(candidate, config) {
  return Boolean(candidate.ownerKey) && config.admission.owners.includes(candidate.ownerKey)
}

export function retentionClassPriority(retentionClass) {
  return RETENTION_PRIORITY[retentionClass] || 0
}

export function evaluateCandidate({ candidate, config, acceptedChannels = new Set(), ownerCounts = new Map() }) {
  if (!candidate?.channelKey) {
    return { accepted: false, reason: 'missing-channel-key', retentionClass: null }
  }

  const moderation = matchModerationRule(candidate, config.moderation?.rules)
  if (moderation?.action === 'block') {
    return { accepted: false, reason: 'moderation-blocked', retentionClass: null, moderation }
  }
  if (moderation?.action === 'quarantine') {
    return { accepted: false, reason: 'moderation-quarantined', retentionClass: null, moderation }
  }
  if (moderation?.action === 'allow') {
    return {
      accepted: true,
      reason: 'moderation-allow',
      retentionClass: config.mode === 'private' ? 'private' : 'allowlist',
      moderation
    }
  }
  const watchedModeration = moderation?.action === 'watch' ? moderation : null
  const watchedDecision = watchedModeration ? { moderation: watchedModeration } : {}

  if (acceptedChannels.has(candidate.channelKey)) {
    return { accepted: false, reason: 'already-accepted', retentionClass: null, ...watchedDecision }
  }

  if (hasAllowlistedChannel(candidate, config)) {
    return {
      accepted: true,
      reason: 'channel-allowlist',
      retentionClass: config.mode === 'private' ? 'private' : 'allowlist',
      ...watchedDecision
    }
  }

  if (hasAllowlistedOwner(candidate, config)) {
    return {
      accepted: true,
      reason: 'owner-allowlist',
      retentionClass: config.mode === 'private' ? 'private' : 'allowlist',
      ...watchedDecision
    }
  }

  if (config.mode === 'private' || config.policy === 'allowlist') {
    return { accepted: false, reason: 'not-allowlisted', retentionClass: null, ...watchedDecision }
  }

  if (!config.discovery?.enabled) {
    return { accepted: false, reason: 'discovery-disabled', retentionClass: null, ...watchedDecision }
  }

  if (Number(config.discovery.maxChannels || 0) > 0 && acceptedChannels.size >= config.discovery.maxChannels) {
    return { accepted: false, reason: 'channel-limit', retentionClass: null, ...watchedDecision }
  }

  if (candidate.ownerKey) {
    const ownerChannelCount = ownerCounts.get(candidate.ownerKey) || 0
    if (Number(config.discovery.maxChannelsPerOwner || 0) > 0 && ownerChannelCount >= config.discovery.maxChannelsPerOwner) {
      return { accepted: false, reason: 'owner-limit', retentionClass: null, ...watchedDecision }
    }
  }

  return { accepted: true, reason: 'discovery', retentionClass: 'discovery', ...watchedDecision }
}
