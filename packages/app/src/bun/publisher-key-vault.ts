// @ts-nocheck
import { derivePublisherId } from '@peartube/backend/publisher'
import { publisherRootSignaturePreimage } from '../../lib/publisher-signer-bridge'

export const BUN_PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const BUN_PUBLISHER_ROOT_RECORD_VERSION = 1
const LEGACY_ROOT_MIGRATION_VERSION = 1
const LEGACY_ROOT_CHALLENGE_DOMAIN = 'peartube:legacy-publisher-root-migration:v1\0'
const PUBLISHER_PUBLIC_KEY_BYTES = 32
const PUBLISHER_SECRET_KEY_BYTES = 64
const MIGRATION_NONCE_BYTES = 32


export function redactPublisherVaultError(error, code = 'publisher-vault-error') {
  const safe = new Error(code)
  safe.code = code
  safe.redacted = true
  return safe
}

async function loadKeyring(loader = () => import('@napi-rs/keyring')) {
  try {
    const keyring = await loader()
    if (typeof keyring?.AsyncEntry !== 'function') throw new Error('AsyncEntry unavailable')
    return keyring
  } catch (error) {
    throw redactPublisherVaultError(error, 'publisher-keyring-unavailable')
  }
}

async function loadCrypto(loader = () => import('hypercore-crypto')) {
  const mod = await loader()
  return mod?.default || mod
}

async function loadB4a(loader = () => import('b4a')) {
  const mod = await loader()
  return mod?.default || mod
}

function isHex(value) {
  return typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)
}

function toBuffer(value, b4a, name) {
  if (value instanceof Uint8Array || b4a.isBuffer?.(value)) return b4a.from(value)
  if (isHex(value)) return b4a.from(value, 'hex')
  throw new Error(`${name} must be bytes or hex`)
}

function toHex(value, b4a, name) {
  return b4a.toString(toBuffer(value, b4a, name), 'hex')
}

function publisherIdFor(publicKey, b4a) {
  return b4a.toString(derivePublisherId(toBuffer(publicKey, b4a, 'publicKey')), 'hex')
}

function assertPublisherId(publisherId, publicKey, b4a) {
  const derived = publisherIdFor(publicKey, b4a)
  if (publisherId !== undefined && publisherId !== derived) throw new Error('publisherId does not match root public key')
  return derived
}

function assertKeyContinuity(publicKey, secretKey, crypto, b4a) {
  const challenge = b4a.from('peartube/publisher-root-import/v1')
  const signature = crypto.sign(challenge, secretKey)
  if (crypto.verify(challenge, signature, publicKey) !== true) throw new Error('publisher root key mismatch')
}
function validateLegacyRootMigrationRequest(input, crypto, b4a) {
  if (input?.version !== LEGACY_ROOT_MIGRATION_VERSION) throw new Error('unsupported legacy root migration')

  let secretKey
  let challenge
  try {
    const publicKey = toBuffer(input.identityPublicKey, b4a, 'identityPublicKey')
    secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
    challenge = toBuffer(input.challenge, b4a, 'challenge')
    const domain = b4a.from(LEGACY_ROOT_CHALLENGE_DOMAIN)
    const expectedChallengeBytes = domain.byteLength + PUBLISHER_PUBLIC_KEY_BYTES + MIGRATION_NONCE_BYTES

    if (publicKey.byteLength !== PUBLISHER_PUBLIC_KEY_BYTES ||
        secretKey.byteLength !== PUBLISHER_SECRET_KEY_BYTES ||
        challenge.byteLength !== expectedChallengeBytes ||
        !b4a.equals(challenge.subarray(0, domain.byteLength), domain) ||
        !b4a.equals(
          challenge.subarray(domain.byteLength, domain.byteLength + PUBLISHER_PUBLIC_KEY_BYTES),
          publicKey,
        )) {
      throw new Error('invalid legacy root migration')
    }

    assertKeyContinuity(publicKey, secretKey, crypto, b4a)
    return { publicKey, secretKey, challenge }
  } catch (error) {
    secretKey?.fill?.(0)
    challenge?.fill?.(0)
    throw error
  }
}


function accountName(publisherId) {
  if (typeof publisherId !== 'string' || !/^[a-z0-9._:-]{16,160}$/i.test(publisherId)) {
    throw new Error('invalid publisherId')
  }
  return publisherId
}

function serializeRoot({ publicKey, secretKey, b4a }) {
  return JSON.stringify({
    version: BUN_PUBLISHER_ROOT_RECORD_VERSION,
    publicKey: b4a.toString(publicKey, 'hex'),
    secretKey: b4a.toString(secretKey, 'hex'),
  })
}

function parseRoot(raw, b4a) {
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (parsed?.version !== BUN_PUBLISHER_ROOT_RECORD_VERSION) throw new Error('unsupported publisher root record')
  return {
    publicKey: toBuffer(parsed.publicKey, b4a, 'publicKey'),
    secretKey: toBuffer(parsed.secretKey, b4a, 'secretKey'),
  }
}

export function createBunPublisherKeyVault(options = {}) {
  async function entryFor(publisherId) {
    const keyring = await loadKeyring(options.keyringLoader)
    return new keyring.AsyncEntry(BUN_PUBLISHER_ROOT_SERVICE, accountName(publisherId))
  }

  async function loadRoot(publisherId) {
    const [entry, b4a] = await Promise.all([entryFor(publisherId), loadB4a(options.b4aLoader)])
    const raw = await entry.getPassword()
    return { root: parseRoot(raw, b4a), b4a, entry }
  }

  return {
    async createRoot(input = {}) {
      let keyPair
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        keyPair = input.seed ? crypto.keyPair(toBuffer(input.seed, b4a, 'seed')) : crypto.keyPair()
        const publisherId = assertPublisherId(input.publisherId, keyPair.publicKey, b4a)
        const entry = await entryFor(publisherId)
        await entry.setPassword(serializeRoot({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, b4a }))
        return { publisherId, publicKey: toHex(keyPair.publicKey, b4a, 'publicKey') }
      } catch (error) {
        throw redactPublisherVaultError(error)
      } finally {
        keyPair?.secretKey?.fill?.(0)
      }
    },

    async importRoot(input = {}) {
      let secretKey
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        const publicKey = toBuffer(input.publicKey, b4a, 'publicKey')
        secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
        assertKeyContinuity(publicKey, secretKey, crypto, b4a)
        const publisherId = assertPublisherId(input.publisherId, publicKey, b4a)
        const entry = await entryFor(publisherId)
        await entry.setPassword(serializeRoot({ publicKey, secretKey, b4a }))
        return { publisherId, publicKey: toHex(publicKey, b4a, 'publicKey') }
      } catch (error) {
        throw redactPublisherVaultError(error)
      } finally {
        secretKey?.fill?.(0)
      }
    },

    async importLegacyRootMigration(input = {}) {
      let secretKey
      let challenge
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        const validated = validateLegacyRootMigrationRequest(input, crypto, b4a)
        secretKey = validated.secretKey
        challenge = validated.challenge
        const publicKey = validated.publicKey
        const publisherId = assertPublisherId(undefined, publicKey, b4a)
        const entry = await entryFor(publisherId)
        await entry.setPassword(serializeRoot({ publicKey, secretKey, b4a }))
        return {
          version: LEGACY_ROOT_MIGRATION_VERSION,
          durable: true,
          publicKey: b4a.from(publicKey),
          challengeSignature: crypto.sign(challenge, secretKey),
        }
      } catch (error) {
        throw redactPublisherVaultError(error)
      } finally {
        secretKey?.fill?.(0)
        challenge?.fill?.(0)
      }
    },

    async getPublicKey(input = {}) {
      try {
        const { root } = await loadRoot(input.publisherId)
        return root ? root.publicKey : null
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },

    async signProtocolRecord(input = {}) {
      let root
      let preimage
      try {
        const crypto = await loadCrypto(options.cryptoLoader)
        ;({ root } = await loadRoot(input.publisherId))
        if (!root) throw new Error('publisher root missing')
        const protocolRequest = input.recordType === 'publisher.root-transition'
          ? { recordType: input.recordType, transitionId: input.transitionId }
          : { recordType: input.recordType, recordId: input.recordId }
        preimage = publisherRootSignaturePreimage(protocolRequest)
        return {
          signerPublicKey: root.publicKey,
          signature: crypto.sign(preimage, root.secretKey),
        }
      } catch (error) {
        throw redactPublisherVaultError(error)
      } finally {
        root?.secretKey?.fill?.(0)
        preimage?.fill?.(0)
      }
    },

    async deleteRoot(input = {}) {
      try {
        const entry = await entryFor(input.publisherId)
        if (typeof entry.deletePassword === 'function') await entry.deletePassword()
        else await entry.deleteCredential()
        return { ok: true }
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },
  }
}
