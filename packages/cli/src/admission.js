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

export function evaluateCandidate({ candidate, config, acceptedChannels = new Set(), ownerCounts = new Map() }) {
  if (!candidate?.channelKey) {
    return { accepted: false, reason: 'missing-channel-key', retentionClass: null }
  }

  if (acceptedChannels.has(candidate.channelKey)) {
    return { accepted: false, reason: 'already-accepted', retentionClass: null }
  }

  if (hasAllowlistedChannel(candidate, config)) {
    return {
      accepted: true,
      reason: 'channel-allowlist',
      retentionClass: config.mode === 'private' ? 'private' : 'allowlist'
    }
  }

  if (hasAllowlistedOwner(candidate, config)) {
    return {
      accepted: true,
      reason: 'owner-allowlist',
      retentionClass: config.mode === 'private' ? 'private' : 'allowlist'
    }
  }

  if (config.mode === 'private' || config.policy === 'allowlist') {
    return { accepted: false, reason: 'not-allowlisted', retentionClass: null }
  }

  if (!config.discovery?.enabled) {
    return { accepted: false, reason: 'discovery-disabled', retentionClass: null }
  }

  if (acceptedChannels.size >= config.discovery.maxChannels) {
    return { accepted: false, reason: 'channel-limit', retentionClass: null }
  }

  if (candidate.ownerKey) {
    const ownerChannelCount = ownerCounts.get(candidate.ownerKey) || 0
    if (ownerChannelCount >= config.discovery.maxChannelsPerOwner) {
      return { accepted: false, reason: 'owner-limit', retentionClass: null }
    }
  }

  return { accepted: true, reason: 'discovery', retentionClass: 'discovery' }
}
