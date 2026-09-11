import { RETENTION_PRIORITY } from './constants.js'

function hasAllowlistedChannel(candidate, config) {
  return Boolean(candidate.channelKey) && config.admission.channels.includes(candidate.channelKey)
}

function hasAllowlistedOwner(candidate, config) {
  return Boolean(candidate.ownerKey) && config.admission.owners.includes(candidate.ownerKey)
}

export function retentionClassPriority(retentionClass) {
  return RETENTION_PRIORITY[retentionClass] || 0
}

function evaluateAllowlistAdmission(candidate, config) {
  const retentionClass = config.mode === 'private' ? 'private' : 'allowlist'
  if (hasAllowlistedChannel(candidate, config)) {
    return {
      accepted: true,
      reason: 'channel-allowlist',
      retentionClass
    }
  }
  if (hasAllowlistedOwner(candidate, config)) {
    return {
      accepted: true,
      reason: 'owner-allowlist',
      retentionClass
    }
  }
  return null
}

function evaluateDiscoveryAdmission(candidate, config, acceptedChannels, ownerCounts) {
  if (!config.discovery?.enabled) {
    return { accepted: false, reason: 'discovery-disabled', retentionClass: null }
  }

  const maxChannels = Number(config.discovery.maxChannels || 0)
  if (maxChannels > 0 && acceptedChannels.size >= maxChannels) {
    return { accepted: false, reason: 'channel-limit', retentionClass: null }
  }

  if (candidate.ownerKey) {
    const maxPerOwner = Number(config.discovery.maxChannelsPerOwner || 0)
    const ownerChannelCount = ownerCounts.get(candidate.ownerKey) || 0
    if (maxPerOwner > 0 && ownerChannelCount >= maxPerOwner) {
      return { accepted: false, reason: 'owner-limit', retentionClass: null }
    }
  }

  return { accepted: true, reason: 'discovery', retentionClass: 'discovery' }
}

export function evaluateCandidate({ candidate, config, acceptedChannels = new Set(), ownerCounts = new Map() }) {
  if (!candidate?.channelKey) {
    return { accepted: false, reason: 'missing-channel-key', retentionClass: null }
  }

  if (acceptedChannels.has(candidate.channelKey)) {
    return { accepted: false, reason: 'already-accepted', retentionClass: null }
  }

  const allowlistResult = evaluateAllowlistAdmission(candidate, config)
  if (allowlistResult) {
    return allowlistResult
  }

  if (config.mode === 'private' || config.policy === 'allowlist') {
    return { accepted: false, reason: 'not-allowlisted', retentionClass: null }
  }

  return evaluateDiscoveryAdmission(candidate, config, acceptedChannels, ownerCounts)
}
