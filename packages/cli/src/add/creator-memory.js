import { deriveContentIdentityKey, normalizeIdentityUrl } from './content-model.js'

const PREFIX = 'content-add/v1/creator/'

// Only these safe fields are ever persisted. Tokens, cookies, fetchUrl, and
// displayUrl must never reach remembered-creator storage.
const PERSISTED_FIELDS = ['provider', 'sourceId', 'identityUrl', 'name', 'handle', 'updatedAt']

export function createCreatorMemory ({ bee, now = () => Date.now() } = {}) {
  if (!bee) throw new Error('creator memory requires a hyperbee')

  function keyFor (provider, identityKey) {
    return `${PREFIX}${encodeURIComponent(provider)}/${encodeURIComponent(identityKey)}`
  }

  return {
    async remember (creator) {
      const provider = creator.platform || creator.provider
      if (!provider) throw new Error('remembered creator requires a provider')
      const sourceId = creator.sourceId != null ? String(creator.sourceId) : null
      const identityUrl = creator.canonicalUrl || creator.identityUrl
        ? normalizeIdentityUrl(creator.canonicalUrl || creator.identityUrl)
        : null
      if (!sourceId && !identityUrl) throw new Error('remembered creator requires sourceId or identityUrl')
      const identityKey = deriveContentIdentityKey({ provider, sourceId, identityUrl })
      const record = {
        provider,
        sourceId,
        identityUrl,
        name: creator.name || creator.displayName || null,
        handle: creator.handle || null,
        updatedAt: now()
      }
      await bee.put(keyFor(provider, identityKey), safeRecord(record))
      return { identityKey, ...record }
    },

    async list () {
      const out = []
      for await (const entry of bee.createReadStream({ gte: PREFIX, lt: `${PREFIX}\uffff` })) {
        const value = decodeValue(entry.value)
        if (value) out.push(value)
      }
      out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      return out
    },

    async match (query) {
      const term = String(query || '').trim().toLowerCase()
      const all = await this.list()
      if (!term) return all
      return all.filter((creator) => {
        return (creator.name && creator.name.toLowerCase().includes(term)) ||
          (creator.handle && creator.handle.toLowerCase().includes(term))
      })
    },

    async forget (provider, identityKey) {
      await bee.del(keyFor(provider, identityKey))
    }
  }
}

function safeRecord (record) {
  const out = {}
  for (const field of PERSISTED_FIELDS) {
    if (record[field] !== undefined && record[field] !== null) out[field] = record[field]
  }
  return out
}

function decodeValue (value) {
  if (value == null) return null
  if (typeof value === 'object') return safeRecord(value)
  try {
    return safeRecord(JSON.parse(String(value)))
  } catch {
    return null
  }
}
