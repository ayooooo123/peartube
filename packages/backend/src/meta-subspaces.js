import SubEncoder from 'sub-encoder'

/**
 * Sub-encoded keyspaces for the metadata Hyperbee (metaDb).
 *
 * sub-encoder gives each collection its own binary-prefixed keyspace, so range
 * scans can't collide with unrelated keys and a sub can be iterated wholesale
 * without `gte/lt` sentinels.
 */

/**
 * @typedef {Object} CollectionDef
 * @property {string} name - accessor name on the returned subspaces object
 * @property {string} namespace - sub-encoder prefix
 */

/** @type {CollectionDef[]} */
export const META_SUBSPACE_COLLECTIONS = [
  // `${driveKey}:${videoPath}`
  { name: 'downloadIntents', namespace: 'download-intent' },
  // `${channelKey}`
  { name: 'channelKinds', namespace: 'mw-channel' },
  // `${blobsCoreKey}!${blobId}`
  { name: 'playbackProfiles', namespace: 'playback-profile' },
  // Durable deferred-publication activation marker keyed by canonical channel key.
  { name: 'publicProjectionStates', namespace: 'public-projection-state' },
  // Local media graph claim/projection records keyed by deterministic graph keys.
  { name: 'mediaGraphClaims', namespace: 'media-graph-claim' },
]

function makeAccessor(metaDb, namespace, enc) {
  const sub = enc.sub(namespace, 'utf-8')
  return {
    sub,
    namespace,
    get(key) {
      return metaDb.get(key, { keyEncoding: sub, valueEncoding: 'json' })
    },
    put(key, value) {
      return metaDb.put(key, value, { keyEncoding: sub, valueEncoding: 'json' })
    },
    del(key) {
      return metaDb.del(key, { keyEncoding: sub })
    },
    /**
     * Iterate the whole sub (default) or a sub-range. Range bounds are encoded
     * within the sub automatically.
     * @param {{ gte?: string, gt?: string, lte?: string, lt?: string }} [range]
     */
    createReadStream(range = {}) {
      return metaDb.createReadStream({ ...range, keyEncoding: sub, valueEncoding: 'json' })
    },
  }
}

/**
 * Build the sub-encoded accessors for the metaDb. Cheap/synchronous — safe to
 * call once at metaDb init.
 * @param {import('hyperbee')} metaDb
 */
export function createMetaSubspaces(metaDb) {
  const enc = new SubEncoder()
  /** @type {Record<string, ReturnType<typeof makeAccessor>>} */
  const subspaces = {}
  for (const c of META_SUBSPACE_COLLECTIONS) {
    subspaces[c.name] = makeAccessor(metaDb, c.namespace, enc)
  }
  return subspaces
}

