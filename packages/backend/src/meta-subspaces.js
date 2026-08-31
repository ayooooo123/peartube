import SubEncoder from 'sub-encoder'

/**
 * Sub-encoded keyspaces for the metadata Hyperbee (metaDb).
 *
 * Historically the prefixed collections below shared the flat metaDb keyspace
 * via hand-rolled string prefixes (`download-intent:…`, `mw-channel:…`,
 * `playback-profile!…`). sub-encoder gives each its own binary-prefixed
 * keyspace, so range scans can't collide with unrelated keys and a sub can be
 * iterated wholesale without `gte/lt` sentinels.
 *
 * A one-time, idempotent migration (`migrateMetaSubspaces`) relocates any
 * existing legacy-prefixed keys into their sub before normal operation. The
 * legacy keys are deleted after the copy; all three collections are
 * regenerable caches/markers, so a forward-only move is safe.
 */

export const META_SUBSPACES_MIGRATION_KEY = 'meta-subspaces-migrated-v1'

/**
 * @typedef {Object} CollectionDef
 * @property {string} name - accessor name on the returned subspaces object
 * @property {string} namespace - sub-encoder prefix
 * @property {string} legacyPrefix - flat-key prefix used before subspaces
 */

/** @type {CollectionDef[]} */
export const META_SUBSPACE_COLLECTIONS = [
  // `download-intent:${driveKey}:${videoPath}` -> sub key `${driveKey}:${videoPath}`
  { name: 'downloadIntents', namespace: 'download-intent', legacyPrefix: 'download-intent:' },
  // `mw-channel:${channelKey}` -> sub key `${channelKey}`
  { name: 'channelKinds', namespace: 'mw-channel', legacyPrefix: 'mw-channel:' },
  // `playback-profile!${blobsCoreKey}!${blobId}` -> sub key `${blobsCoreKey}!${blobId}`
  { name: 'playbackProfiles', namespace: 'playback-profile', legacyPrefix: 'playback-profile!' },
  // Durable deferred-publication activation marker keyed by canonical channel key.
  { name: 'publicProjectionStates', namespace: 'public-projection-state', legacyPrefix: 'public-projection-state:' },
  // Local media graph claim/projection records keyed by deterministic graph keys.
  { name: 'mediaGraphClaims', namespace: 'media-graph-claim', legacyPrefix: 'media-graph-claim:' },
]

// Smallest string strictly greater than every key starting with `prefix`:
// bump the final byte. Used to scan the legacy flat-key range.
function bumpPrefix(prefix) {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

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

/**
 * Relocate legacy flat-prefixed keys into their subspaces. Idempotent: sets a
 * marker when complete and no-ops thereafter; if interrupted (no marker), it
 * safely resumes on the next run since already-moved legacy keys are gone.
 * @param {import('hyperbee')} metaDb
 * @param {ReturnType<typeof createMetaSubspaces>} subspaces
 * @param {{ logger?: { info?: Function, warn?: Function } }} [opts]
 * @returns {Promise<{ migrated: number, skipped: boolean, incomplete?: boolean, error?: string }>}
 */
export async function migrateMetaSubspaces(metaDb, subspaces, { logger = console } = {}) {
  const marker = await metaDb.get(META_SUBSPACES_MIGRATION_KEY).catch(() => null)
  if (marker?.value?.done) return { migrated: 0, skipped: true }

  let migrated = 0
  for (const c of META_SUBSPACE_COLLECTIONS) {
    const accessor = subspaces[c.name]
    const lt = bumpPrefix(c.legacyPrefix)
    try {
      // Collect first, then copy+delete, so we never mutate a range we're still
      // streaming.
      const legacy = []
      for await (const node of metaDb.createReadStream({ gte: c.legacyPrefix, lt, wait: false })) {
        if (typeof node.key === 'string' && node.key.startsWith(c.legacyPrefix)) legacy.push(node)
      }
      for (const node of legacy) {
        const subKey = node.key.slice(c.legacyPrefix.length)
        if (!subKey) continue
        await accessor.put(subKey, node.value)
        await metaDb.del(node.key)
        migrated++
      }
    } catch (err) {
      logger?.warn?.('[meta-subspaces] migration failed', { collection: c.name, error: err?.message || String(err) })
      // Leave the marker unset so the next startup retries from where it stopped.
      return { migrated, skipped: false, incomplete: true, error: err?.message || String(err) }
    }
  }

  await metaDb.put(META_SUBSPACES_MIGRATION_KEY, { done: true, version: 1, at: Date.now() })
  if (migrated > 0) logger?.info?.('[meta-subspaces] migrated legacy keys', { migrated })
  return { migrated, skipped: false }
}
