/**
 * PearTube-specific wrapper around keet-identity-key
 *
 * Provides HD key derivation for PearTube with:
 * - PEARTUBE_TYPE = 5340 (distinct from Keet's 5338)
 * - Identity key derivation via KeyChain with PearTube-specific SLIP-48 paths
 * - Corestore primaryKey derivation via SLIP-21 symmetric key
 * - Mnemonic generation (12 words) and validation
 *
 * @module peartube-identity
 */

import b4a from 'b4a'
import * as bip39 from 'bip39-mnemonic'

let KeyChain = null

// Lazy-load keet-identity-key/lib/keychain (may not be installed yet)
async function ensureLoaded () {
  if (KeyChain) return
  try {
    const keyChainMod = await import('keet-identity-key/lib/keychain.js')
    KeyChain = keyChainMod.default || keyChainMod
  } catch (err) {
    throw new Error(
      'keet-identity-key not installed. Install with: npm install keet-identity-key'
    )
  }
}

/**
 * PearTube SLIP-48 type constant
 * Distinct from Keet's type (5338) to ensure separate key derivation paths
 * @type {number}
 */
export const PEARTUBE_TYPE = 5340

/**
 * Build a SLIP-48 key path for PearTube
 * Path: m/48'/PEARTUBE_TYPE'/role'/accountIndex'/index'
 *
 * @param {number} accountIndex
 * @param {number} index - 0 = identity key, 1 = discovery core
 * @param {number} [role=0]
 * @returns {number[]}
 */
function peartubeKeyPath (accountIndex, index, role = 0) {
  const purpose = 48 // SLIP-48 wallet
  return [purpose, PEARTUBE_TYPE, role, accountIndex, index]
}

/**
 * Generate a new BIP39 mnemonic phrase (12 words)
 *
 * @returns {string} Space-separated 12-word mnemonic
 */
export function generateMnemonic () {
  // Generate 16 bytes of entropy for 12 words (consistent with existing identity.js behavior)
  const entropy = bip39.generateEntropy(16)
  return bip39.entropyToMnemonic(entropy)
}

/**
 * Validate a BIP39 mnemonic phrase
 *
 * @param {string} mnemonic - Space-separated mnemonic phrase
 * @returns {boolean} True if valid BIP39 mnemonic
 */
export function validateMnemonic (mnemonic) {
  if (!mnemonic || typeof mnemonic !== 'string') return false
  return bip39.validateMnemonic(mnemonic)
}

/**
 * Derive an identity keypair from a mnemonic using PearTube-specific SLIP-48 paths
 *
 * Uses PEARTUBE_TYPE = 5340 (not Keet's 5338) to ensure separate derivation.
 *
 * @param {string} mnemonic - BIP39 mnemonic phrase
 * @returns {Promise<{identityPublicKey: Buffer, identityKeyPair: {publicKey: Buffer, secretKey: Buffer}, keyChain: object}>}
 * @throws {Error} If mnemonic is invalid or keet-identity-key is not installed
 */
export async function deriveIdentity (mnemonic) {
  await ensureLoaded()

  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase')
  }

  const seed = await KeyChain.deriveSeed(mnemonic)
  const keyChain = new KeyChain(seed)

  // Derive identity keypair using PearTube-specific SLIP-48 path
  const identityPath = peartubeKeyPath(0, 0) // m/48'/5340'/0'/0'/0'
  const identityKeyPair = keyChain.get(identityPath)

  return {
    identityPublicKey: identityKeyPair.publicKey,
    identityKeyPair,
    keyChain
  }
}

/**
 * Derive a 32-byte Corestore primaryKey from a mnemonic
 *
 * Uses SLIP-21 symmetric key derivation with path:
 * ['SLIP-0021', 'peartube', 'corestore-primary-key']
 *
 * This key is separate from the identity key and is used to initialize
 * Corestore, which makes all derived channel keys deterministic and recoverable.
 *
 * @param {string} mnemonic - BIP39 mnemonic phrase
 * @returns {Promise<Buffer>} 32-byte Buffer for Corestore primaryKey
 * @throws {Error} If mnemonic is invalid or keet-identity-key is not installed
 */
export async function derivePrimaryKey (mnemonic) {
  await ensureLoaded()

  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase')
  }

  const seed = await KeyChain.deriveSeed(mnemonic)
  const keyChain = new KeyChain(seed)

  // Use SLIP-21 symmetric key derivation to get a 32-byte key.
  // getSymmetricKey returns the 32-byte 'key' subarray (last 32 bytes of internal 64-byte buffer).
  const primaryKey = keyChain.getSymmetricKey([
    'SLIP-0021',
    'peartube',
    'corestore-primary-key'
  ])

  // Clear the keyChain to avoid leaking secrets
  keyChain.clear()

  // Return a copy as a Buffer (getSymmetricKey returns a subarray view into cleared memory)
  return b4a.from(primaryKey)
}
