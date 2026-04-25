/**
 * Autobase Operation Signing & Verification
 *
 * Ensures operations are cryptographically authenticated:
 * - Sign operations with the local writer's keypair
 * - Verify that node.from.key matches the claimed author
 * - Prevent op forgery where someone claims to be a different author
 *
 * Security model:
 * - Each operation includes the author's public key
 * - On apply, we verify node.from.key === op's claimed author
 * - This prevents users from creating ops with fake authorKeyHex values
 */

import b4a from 'b4a'
import crypto from 'hypercore-crypto'

/**
 * Extract the author key from an operation.
 * Operations use different field names depending on type.
 *
 * @param {object} op - The operation
 * @returns {string|null} - Author key in hex, or null if not found
 */
export function getOpAuthorKey(op) {
  if (!op || typeof op !== 'object') return null

  // Check various author key field names used by different op types
  return op.authorKeyHex ||
         op.updatedBy ||
         op.uploadedBy ||
         op.moderatorKeyHex ||
         op.writerKeyHex ||
         null
}

/**
 * Verify that an operation was created by the node's writer.
 *
 * In Autobase, each node has a `from` property containing the writer core.
 * The node.from.key is the hypercore public key of whoever appended this op.
 * We verify that the operation's claimed author matches this key.
 *
 * @param {object} op - The operation payload
 * @param {object} node - The Autobase node (contains from.key)
 * @returns {{valid: boolean, reason?: string}} - Verification result
 */
export function verifyOpAuthor(op, node) {
  if (!op || typeof op !== 'object') {
    return { valid: false, reason: 'Invalid operation object' }
  }

  if (!node?.from?.key) {
    return { valid: false, reason: 'Node has no writer key' }
  }

  const claimedAuthor = getOpAuthorKey(op)
  if (!claimedAuthor) {
    // Some ops (like 'init') may not have an author - allow those
    const noAuthorOps = ['init', 'system', 'ack']
    if (noAuthorOps.includes(op.type)) {
      return { valid: true }
    }
    return { valid: false, reason: 'Operation has no author key' }
  }

  // Convert node.from.key to hex for comparison
  const actualWriterKeyHex = b4a.toString(node.from.key, 'hex')

  // Verify the claimed author matches the actual writer
  if (claimedAuthor !== actualWriterKeyHex) {
    return {
      valid: false,
      reason: `Author mismatch: claimed ${claimedAuthor.slice(0, 16)}... but node from ${actualWriterKeyHex.slice(0, 16)}...`
    }
  }

  return { valid: true }
}

/**
 * Create a nonce for replay prevention.
 * Combines timestamp with random bytes for uniqueness.
 *
 * @returns {string} - Nonce as hex string
 */
export function createNonce() {
  const timestamp = Buffer.alloc(8)
  const now = BigInt(Date.now())
  timestamp.writeBigUInt64BE(now, 0)

  const random = crypto.randomBytes(8)
  return b4a.toString(Buffer.concat([timestamp, random]), 'hex')
}

/**
 * Sign an operation payload for additional verification.
 * This adds an extra layer of security beyond node.from.key verification.
 *
 * @param {object} op - The operation to sign
 * @param {Buffer} secretKey - The 64-byte ed25519 secret key
 * @returns {object} - Operation with signature added
 */
export function signOp(op, secretKey) {
  if (!secretKey || secretKey.length !== 64) {
    throw new Error('Invalid secret key for signing')
  }

  // Create a canonical JSON representation for signing
  const payload = {
    type: op.type,
    ...op,
    nonce: op.nonce || createNonce()
  }

  // Remove any existing signature before signing
  delete payload.signature

  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = crypto.sign(payloadBytes, secretKey)

  return {
    ...payload,
    signature: b4a.toString(signature, 'hex')
  }
}

/**
 * Verify an operation's signature.
 *
 * @param {object} op - The operation with signature
 * @param {Buffer} publicKey - The 32-byte ed25519 public key
 * @returns {boolean} - True if signature is valid
 */
export function verifyOpSignature(op, publicKey) {
  if (!op?.signature || !publicKey) {
    return false
  }

  try {
    const signature = b4a.from(op.signature, 'hex')

    // Reconstruct the signed payload
    const payload = { ...op }
    delete payload.signature

    const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
    return crypto.verify(payloadBytes, signature, publicKey)
  } catch (err) {
    console.log('[op-signing] Signature verification error:', err?.message)
    return false
  }
}

/**
 * Full verification of an operation from an Autobase node.
 *
 * Checks:
 * 1. The claimed author matches node.from.key
 * 2. (Optional) The operation signature is valid
 *
 * @param {object} op - The operation payload
 * @param {object} node - The Autobase node
 * @param {object} [options]
 * @param {boolean} [options.requireSignature=false] - Require valid signature
 * @returns {{valid: boolean, reason?: string}}
 */
export function verifyOp(op, node, options = {}) {
  const { requireSignature = false } = options

  // Step 1: Verify author matches node writer
  const authorResult = verifyOpAuthor(op, node)
  if (!authorResult.valid) {
    return authorResult
  }

  // Step 2: Verify signature if required or present
  if (requireSignature || op.signature) {
    if (!op.signature) {
      return { valid: false, reason: 'Signature required but not present' }
    }

    const publicKey = node.from?.key
    if (!publicKey) {
      return { valid: false, reason: 'Cannot verify signature without public key' }
    }

    if (!verifyOpSignature(op, publicKey)) {
      return { valid: false, reason: 'Invalid signature' }
    }
  }

  return { valid: true }
}

export default {
  getOpAuthorKey,
  verifyOpAuthor,
  createNonce,
  signOp,
  verifyOpSignature,
  verifyOp
}
