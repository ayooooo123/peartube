import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import sodium from 'sodium-universal'

// S3's `x-amz-checksum-sha256` is the base64 of a raw SHA-256 digest. Hypercore
// hashes are BLAKE2b, so none of them can stand in for it. Taken from
// sodium-universal rather than node:crypto so this stays usable under Bare.
function sha256Base64 (data) {
  const digest = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(digest, data)
  return b4a.toString(digest, 'base64')
}

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

export function contentBlockKey(hashOrOptions, maybeHash) {
  let prefix = ''
  let hash = hashOrOptions
  if (hashOrOptions && typeof hashOrOptions === 'object' && !b4a.isBuffer(hashOrOptions)) {
    prefix = hashOrOptions.prefix || ''
    hash = hashOrOptions.hash
  } else if (typeof hashOrOptions === 'string' && maybeHash !== undefined) {
    prefix = hashOrOptions
    hash = maybeHash
  }
  const hex = b4a.isBuffer(hash) ? b4a.toString(hash, 'hex') : String(hash || '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('hash must be a 32-byte hex hash')
  const head = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
  return `${head}blocks/v2/${hex.toLowerCase()}`
}

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
  const core = coreKey ? normalizeCoreKey(coreKey) : null
  const keyFor = (blockIndex) => {
    if (!core) throw new Error('coreKey is required for legacy block index key')
    return remoteBlockKey({ prefix, coreKey: core, blockIndex })
  }
  const contentKeyFor = (hash) => contentBlockKey({ prefix, hash })
  const knownKeys = new Set()

  return {
    coreKey: core,

    // The object key for a block, or content-addressed key for a leaf hash.
    key (blockIndexOrHash) {
      if (b4a.isBuffer(blockIndexOrHash) || (typeof blockIndexOrHash === 'string' && /^[0-9a-f]{64}$/i.test(blockIndexOrHash))) {
        return contentKeyFor(blockIndexOrHash)
      }
      return keyFor(blockIndexOrHash)
    },

    contentKey (hash) {
      return contentKeyFor(hash)
    },
    async put(blockIndexOrHash, data, options = {}) {
      let blockData = data
      let hash = options?.hash || null
      let key = null

      if (b4a.isBuffer(blockIndexOrHash) && (data === undefined || !b4a.isBuffer(data))) {
        blockData = blockIndexOrHash
        hash = crypto.data(blockData)
        key = contentKeyFor(hash)
      } else if ((b4a.isBuffer(blockIndexOrHash) && blockIndexOrHash.byteLength === 32) || (typeof blockIndexOrHash === 'string' && /^[0-9a-f]{64}$/i.test(blockIndexOrHash))) {
        hash = blockIndexOrHash
        blockData = data
        key = contentKeyFor(hash)
      } else if (Number.isSafeInteger(blockIndexOrHash)) {
        blockData = data
        if (core) {
          key = keyFor(blockIndexOrHash)
        } else if (options?.hash) {
          hash = options.hash
          key = contentKeyFor(hash)
        } else {
          hash = hash || crypto.data(blockData)
          key = contentKeyFor(hash)
        }
      } else if (b4a.isBuffer(data)) {
        blockData = data
        hash = hash || crypto.data(data)
        key = contentKeyFor(hash)
      }

      if (!b4a.isBuffer(blockData) || blockData.byteLength === 0) {
        throw new Error('a block must be a non-empty buffer')
      }

      const checksumSha256Base64 = sha256Base64(blockData)
      knownKeys.add(key)
      return provider.putBlock({
        key,
        data: blockData,
        // Vendor-side integrity, in the one format S3 accepts: the BASE64 of a
        // raw SHA-256 digest.
        checksumSha256Base64
      })
    },

    async has(blockIndexOrHash, { expectedHash } = {}) {
      if (typeof provider.hasBlock !== 'function') return false

      if ((b4a.isBuffer(blockIndexOrHash) && blockIndexOrHash.byteLength === 32) || (typeof blockIndexOrHash === 'string' && /^[0-9a-f]{64}$/i.test(blockIndexOrHash))) {
        return provider.hasBlock({ key: contentKeyFor(blockIndexOrHash) })
      }

      if (Number.isSafeInteger(blockIndexOrHash) && core) {
        const exists = await provider.hasBlock({ key: keyFor(blockIndexOrHash) })
        if (exists) return true
      }

      if (expectedHash) {
        return provider.hasBlock({ key: contentKeyFor(expectedHash) })
      }

      return false
    },

    async delete(blockIndexOrHash, { hash } = {}) {
      if (typeof provider.deleteBlock !== 'function') return { success: false }

      if (b4a.isBuffer(blockIndexOrHash) || (typeof blockIndexOrHash === 'string' && /^[0-9a-f]{64}$/i.test(blockIndexOrHash))) {
        const k = contentKeyFor(blockIndexOrHash)
        knownKeys.delete(k)
        return provider.deleteBlock({ key: k })
      }
      if (Number.isSafeInteger(blockIndexOrHash) && core) {
        const k = keyFor(blockIndexOrHash)
        knownKeys.delete(k)
        return provider.deleteBlock({ key: k })
      }
      if (hash) {
        const k = contentKeyFor(hash)
        knownKeys.delete(k)
        return provider.deleteBlock({ key: k })
      }
      return { success: false }
    },

    /**
     * Delete every object this store holds for blocks [0, length).
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
          let key = null
          try {
            key = keyFor(blockIndex)
            const result = typeof provider.deleteBlock === 'function'
              ? await provider.deleteBlock({ key })
              : { success: false }
            if (result && result.success === false) {
              orphaned.push({ blockIndex, key, error: new Error('the provider cannot delete objects') })
            } else {
              deleted++
            }
          } catch (error) {
            orphaned.push({ blockIndex, key: key || String(blockIndex), error })
          }
        }
      }))

      orphaned.sort((a, b) => a.blockIndex - b.blockIndex)
      return { deleted, orphaned }
    },

    /**
     * Fetch one block and prove it is the block the tree committed to.
     *
     * expectedHash is the leaf hash read from the core's own merkle tree.
     */
    async get(blockIndexOrHash, { expectedHash } = {}) {
      let hash = expectedHash
      let blockIndex = null
      if (b4a.isBuffer(blockIndexOrHash) && blockIndexOrHash.byteLength === 32) {
        hash = blockIndexOrHash
      } else if (typeof blockIndexOrHash === 'string' && /^[0-9a-f]{64}$/i.test(blockIndexOrHash)) {
        hash = b4a.from(blockIndexOrHash, 'hex')
      } else if (Number.isSafeInteger(blockIndexOrHash)) {
        blockIndex = blockIndexOrHash
      }

      if (!b4a.isBuffer(hash) || hash.byteLength !== 32) {
        throw new Error('a 32-byte expected leaf hash is required to restore a block')
      }

      const contentKey = contentKeyFor(hash)
      const legacyKey = core && blockIndex !== null ? keyFor(blockIndex) : null

      let raw = null
      if (core && blockIndex !== null) {
        try {
          raw = await provider.getBlock({ key: legacyKey })
        } catch (error) {
          if (error?.statusCode !== 404 && !/404/.test(error?.message || '')) throw error
        }
        if ((raw === null || raw === undefined) && contentKey !== null) {
          try {
            raw = await provider.getBlock({ key: contentKey })
          } catch (error) {
            if (error?.statusCode !== 404 && !/404/.test(error?.message || '')) throw error
          }
        }
      } else if (contentKey !== null) {
        try {
          raw = await provider.getBlock({ key: contentKey })
        } catch (error) {
          if (error?.statusCode !== 404 && !/404/.test(error?.message || '')) throw error
        }
      }
      if (raw === null || raw === undefined) return null
      const data = b4a.isBuffer(raw) ? raw : b4a.from(raw)
      if (data.byteLength === 0) return null
      if (!b4a.equals(crypto.data(data), hash)) {
        const error = new Error('restored block does not match the tree')
        error.code = 'REMOTE_BLOCK_CORRUPT'
        throw error
      }
      return data
    }
  }
}
