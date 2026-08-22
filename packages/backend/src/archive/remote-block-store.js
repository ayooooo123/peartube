import crypto from 'hypercore-crypto'
import b4a from 'b4a'

// A relay's capacity is its disk. Cover art and metadata are small, but the
// media blocks are the whole title, so a relay that must hold every block it
// serves can only ever archive as much as its volume holds.
//
// This store moves block DATA to an object store and leaves everything that
// makes the block verifiable — the merkle tree and the bitfield — on disk. The
// tree is hashes, so it stays small no matter how large the title is. A peer's
// authorized request is answered exactly as before: `has()` reads the bitfield,
// `proof()` reads the block, and the block arrives from the object store
// instead of the local volume.
//
// The object store is never trusted. Bytes coming back are hashed and compared
// against the leaf the tree already committed to, so a truncated, swapped or
// tampered object fails here rather than being served to a peer and earning the
// relay a quarantine.

// One object per block, addressed by the core's discovery key and the block
// index. The index is zero-padded so a plain lexicographic listing of a
// prefix walks the title in order, which is what makes an offloaded core
// auditable with nothing but the object store's own list operation.
const INDEX_DIGITS = 12

export function remoteBlockKey({ prefix = '', coreKey, blockIndex }) {
  const core = normalizeCoreKey(coreKey)
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    throw new Error('blockIndex must be a non-negative safe integer')
  }
  const padded = String(blockIndex).padStart(INDEX_DIGITS, '0')
  const head = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
  return `${head}blocks/${core}/${padded}`
}

function normalizeCoreKey(coreKey) {
  const hex = b4a.isBuffer(coreKey) ? b4a.toString(coreKey, 'hex') : String(coreKey || '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('coreKey must be a 32-byte hex key')
  return hex.toLowerCase()
}

/**
 * A verifying block store over an object provider.
 *
 * `provider` is the transport and nothing more: putBlock/getBlock/hasBlock/
 * deleteBlock as implemented by src/archive/s3-provider.js. Verification,
 * addressing and the refusal to serve unverifiable bytes live here, so a second
 * provider (another S3-compatible vendor, a test double) inherits all of it.
 */
export function createRemoteBlockStore({ provider, prefix = '', coreKey } = {}) {
  if (!provider || typeof provider.getBlock !== 'function' || typeof provider.putBlock !== 'function') {
    throw new Error('a block provider with getBlock and putBlock is required')
  }
  const core = normalizeCoreKey(coreKey)
  const keyFor = (blockIndex) => remoteBlockKey({ prefix, coreKey: core, blockIndex })

  return {
    coreKey: core,

    // The object key for a block, so a caller that has to report an object it
    // could not delete can name it.
    key (blockIndex) {
      return keyFor(blockIndex)
    },

    async put(blockIndex, data) {
      if (!b4a.isBuffer(data) || data.byteLength === 0) {
        throw new Error('a block must be a non-empty buffer')
      }
      return provider.putBlock({
        key: keyFor(blockIndex),
        data,
        // Handed to the provider so the object carries its own checksum where
        // the vendor supports one. It is not what we verify against on read:
        // that is the tree, which the provider never sees.
        contentHash: b4a.toString(crypto.data(data), 'hex')
      })
    },

    async has(blockIndex) {
      if (typeof provider.hasBlock !== 'function') return false
      return provider.hasBlock({ key: keyFor(blockIndex) })
    },

    async delete(blockIndex) {
      if (typeof provider.deleteBlock !== 'function') return { success: false }
      return provider.deleteBlock({ key: keyFor(blockIndex) })
    },

    /**
     * Delete every object this store holds for blocks [0, length).
     *
     * Staging objects exist only to carry a title between the two passes of a
     * bounded ingest, so once the finished core is verified they are garbage
     * that still costs the operator money. A delete that does not stick is
     * REPORTED rather than assumed: the keys come back so an orphan is
     * something an operator can go and find, not something the bucket keeps
     * forever in silence.
     *
     * Deletes run a few at a time because a title is blocks by the hundred
     * thousand and a round trip each way, sequentially, is a cleanup nobody
     * waits for.
     */
    async purge ({ length, concurrency = 8 } = {}) {
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error('length must be a non-negative safe integer')
      }
      const orphaned = []
      let deleted = 0
      let next = 0

      const lanes = Math.min(Math.max(1, concurrency), Math.max(1, length))
      await Promise.all(Array.from({ length: lanes }, async () => {
        while (next < length) {
          const blockIndex = next++
          const key = keyFor(blockIndex)
          try {
            const result = typeof provider.deleteBlock === 'function'
              ? await provider.deleteBlock({ key })
              : { success: false }
            if (result && result.success === false) {
              orphaned.push({ blockIndex, key, error: new Error('the provider cannot delete objects') })
            } else {
              deleted++
            }
          } catch (error) {
            orphaned.push({ blockIndex, key, error })
          }
        }
      }))

      orphaned.sort((a, b) => a.blockIndex - b.blockIndex)
      return { deleted, orphaned }
    },

    /**
     * Fetch one block and prove it is the block the tree committed to.
     *
     * expectedHash is the leaf hash read from the core's own merkle tree. A
     * caller that cannot supply it gets nothing: serving a block nobody can
     * check is the failure this store exists to prevent.
     */
    async get(blockIndex, { expectedHash } = {}) {
      if (!b4a.isBuffer(expectedHash) || expectedHash.byteLength !== 32) {
        throw new Error('a 32-byte expected leaf hash is required to restore a block')
      }
      const raw = await provider.getBlock({ key: keyFor(blockIndex) })
      if (raw === null || raw === undefined) return null
      const data = b4a.isBuffer(raw) ? raw : b4a.from(raw)
      if (data.byteLength === 0) return null
      if (!b4a.equals(crypto.data(data), expectedHash)) {
        const error = new Error('restored block does not match the tree')
        error.code = 'REMOTE_BLOCK_CORRUPT'
        throw error
      }
      return data
    }
  }
}
