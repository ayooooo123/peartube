import b4a from 'b4a'

import {
  createBlockOffloader,
  createOffloadStorage,
  createRemoteBlockStore,
  createS3ArchiveProvider
} from '@peartube/backend/archive'

// Relay-side wiring for block offload. The mechanism lives in the backend:
//   * archive/block-offloader.js  puts a block in the bucket and drops the
//     local copy once the bucket confirms it holds it,
//   * archive/remote-block-store.js  addresses and verifies one block,
//   * archive/offload-storage.js  brings an offloaded block back on a local
//     miss, so `core.has()` and `core.proof()` answer an authorized peer
//     exactly as they did before.
//
// This module is the operator's side of it: turn the resolved relay config into
// the two things the backend needs — a storage wrapper for the read path and an
// asset hook for the write path — or nothing at all when offload is off.

const REQUIRED_S3_FIELDS = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']

function missingS3Fields (s3) {
  return REQUIRED_S3_FIELDS.filter((field) => !(typeof s3?.[field] === 'string' && s3[field].trim()))
}

function keyHexOf (core) {
  const key = core?.key
  if (!b4a.isBuffer(key) || key.byteLength !== 32) {
    throw new Error('block offload needs a ready core with a 32-byte public key')
  }
  return b4a.toString(key, 'hex')
}

/**
 * Per-block byte lengths of a canonical static asset, straight from its
 * descriptor. Every block is `blockSize` except the last, which is the
 * remainder. Reading each block back just to measure it would be the one extra
 * pass over the whole title that the window exists to avoid.
 */
function assetBlockLength (descriptor, index) {
  const blockSize = Number(descriptor.blockSize)
  const byteLength = Number(descriptor.byteLength)
  return Math.min(blockSize, byteLength - (index * blockSize))
}

/**
 * Build the relay's block offload, or return null when the operator has not
 * asked for it.
 *
 * Throws when offload is enabled and the bucket is only half configured. That
 * is deliberate: the alternative is a relay that quietly keeps every block on
 * the volume the operator was trying to stop filling.
 */
export async function createRelayBlockOffload ({
  config,
  logger = null,
  fetchImpl = globalThis.fetch,
  createSigner = null
} = {}) {
  const s3 = config?.archive?.s3 || {}
  if (s3.offload !== true) return null

  const missing = missingS3Fields(s3)
  if (missing.length) {
    throw new Error(`archive.s3.offload is enabled but archive.s3 is incomplete: missing ${missing.join(', ')}`)
  }
  if (s3.enabled === false) {
    throw new Error('archive.s3.offload is enabled but archive.s3.enabled is false')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('archive.s3.offload is enabled but this runtime has no fetch implementation')
  }

  let sign = createSigner
  if (typeof sign !== 'function') {
    // The SigV4 signer is Node-only (node:crypto). Say so rather than letting a
    // module resolution failure be the operator's first clue.
    if (!globalThis.process?.versions?.node) {
      throw new Error('archive.s3.offload is enabled but S3 request signing needs the Node runtime')
    }
    const { createS3Signer } = await import('../s3-signer.js')
    sign = createS3Signer(s3)
  }

  const windowBytes = Number(s3.offloadWindowBytes)
  const prefix = typeof s3.prefix === 'string' ? s3.prefix : ''
  const provider = createS3ArchiveProvider({ fetch: fetchImpl, sign, bucket: s3.bucket, prefix })
  const log = (message) => logger?.archive?.debug?.(message)

  let blocksOffloaded = 0
  let bytesOffloaded = 0
  let offloadStats = () => ({ restored: 0, missing: 0, failed: 0, corrupt: 0 })

  function storeFor (coreKey) {
    return createRemoteBlockStore({ provider, prefix, coreKey })
  }

  return {
    enabled: true,
    windowBytes,
    prefix,

    /**
     * Wraps the CorestoreStorage so a local block miss is answered from the
     * bucket, verified against the core's own merkle tree.
     *
     * `resolveStore` answers for every core with a real public key rather than
     * for a remembered set of offloaded ones. A remembered set would be
     * in-memory state, so the first restart would blind the relay to every
     * block it had already offloaded. The cost of answering for all of them is
     * bounded: offload-storage.js only reaches the bucket for a block the core
     * has a merkle leaf for and does not hold locally, which is exactly an
     * offloaded block, and a stray 404 costs one HEAD-shaped GET.
     */
    wrapStorage (storage) {
      const wrapped = createOffloadStorage({
        storage,
        resolveStore: ({ keyHex }) => (
          typeof keyHex === 'string' && keyHex.length === 64 ? storeFor(keyHex) : null
        ),
        log
      })
      offloadStats = wrapped.offloadStats
      return wrapped
    },

    /**
     * The writeStaticAsset hook. Declares every block of the finished asset
     * oldest-first, then offloads from the oldest end until what is left
     * resident is within the window.
     */
    async offloadAsset ({ core, descriptor }) {
      const offloader = createBlockOffloader({
        core,
        store: storeFor(keyHexOf(core)),
        windowBytes,
        log
      })
      for (let index = 0; index < descriptor.length; index++) {
        offloader.track(index, assetBlockLength(descriptor, index))
      }
      const result = await offloader.drain()
      blocksOffloaded += result.blocksOffloaded
      bytesOffloaded += result.bytesOffloaded
      if (result.blocksOffloaded > 0) {
        logger?.archive?.info?.('Offloaded asset block data to S3', {
          assetId: descriptor.assetId,
          blocks: result.blocksOffloaded,
          bytes: result.bytesOffloaded,
          residentBytes: result.residentBytes,
          windowBytes
        })
      }
      return result
    },

    stats () {
      return {
        enabled: true,
        windowBytes,
        blocksOffloaded,
        bytesOffloaded,
        restored: offloadStats().restored
      }
    }
  }
}

export { missingS3Fields }
