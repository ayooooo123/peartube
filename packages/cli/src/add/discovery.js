import { normalizeIdentityUrl } from './content-model.js'

// Monotonic request tokens: a late provider response for a stale token is dropped.
export function createDiscoverySession ({ initialToken = 0 } = {}) {
  let latest = initialToken
  return {
    begin () {
      latest += 1
      return latest
    },
    isCurrent (token) {
      return token === latest
    },
    accept (token, value) {
      return token === latest ? value : null
    }
  }
}

export function discoveryIdentity (candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  const provider = candidate.provider || candidate.platform || candidate.sourceProvider || null
  const sourceId = candidate.sourceId ?? candidate.sourceVideoId ?? candidate.mediaId ?? null
  if (provider && sourceId != null) return `${provider}:id:${sourceId}`
  const url = candidate.canonicalUrl || candidate.identityUrl
  const normalized = url ? normalizeIdentityUrl(url) : null
  if (provider && normalized) return `${provider}:url:${normalized}`
  if (candidate.id != null) return `id:${candidate.id}`
  return null
}

export function mergeDiscovery ({ remembered = [], providerResults = [], fallbackActions = [] } = {}) {
  const seen = new Set()
  const candidates = []
  const errors = []

  const push = (candidate, origin) => {
    const identity = discoveryIdentity(candidate)
    const dedupeKey = identity || `anon:${candidates.length}`
    if (identity && seen.has(identity)) return
    if (identity) seen.add(identity)
    candidates.push({ ...candidate, origin, discoveryIdentity: identity })
  }

  // Remembered creators always rank first so relevant repeats win dedup.
  for (const creator of remembered) push({ ...creator, kind: creator.kind || 'creator' }, 'remembered')

  for (const result of providerResults) {
    if (!result) continue
    if (result.ok === false || result.error) {
      errors.push({ provider: result.provider || 'unknown', error: normalizeError(result.error) })
      continue
    }
    for (const item of result.items || []) push(item, result.provider || 'provider')
  }

  // Direct URL / local-file actions are always available, even when providers fail.
  for (const action of fallbackActions) candidates.push({ ...action, origin: 'fallback', discoveryIdentity: null })

  return { candidates, errors }
}

// Auto-reuse a creator channel only on an exact stable identity match; name
// similarity never merges. Otherwise offer explicit new/attach options.
export function resolveCreatorAttachment ({ creator, existingChannels = [] } = {}) {
  const creatorKey = creatorIdentityKey(creator)
  for (const channel of existingChannels) {
    for (const source of channel.sources || []) {
      if (source.identityKey && creatorKey && source.identityKey === creatorKey) {
        return { auto: true, channelTarget: { mode: 'existing', channelKey: channel.channelKey } }
      }
    }
  }
  const options = [{ mode: 'new', label: 'Create creator channel' }]
  for (const channel of existingChannels) {
    if (channel.profileKind && channel.profileKind !== 'creator') continue
    options.push({ mode: 'existing', channelKey: channel.channelKey, label: `Attach to ${channel.name || channel.channelKey}` })
  }
  return { auto: false, options }
}

function creatorIdentityKey (creator) {
  if (!creator) return null
  return creator.identityKey || null
}

function normalizeError (error) {
  if (!error) return { message: 'unknown error' }
  const out = { message: error.message != null ? String(error.message) : String(error) }
  if (error.code != null) out.code = error.code
  return out
}
