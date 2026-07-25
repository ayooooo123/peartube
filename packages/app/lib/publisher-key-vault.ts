// @ts-nocheck
import { publisherRootSignaturePreimage } from './publisher-signer-bridge'

export const PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const PUBLISHER_ROOT_RECORD_VERSION = 1
const LEGACY_ROOT_MIGRATION_VERSION = 1
const LEGACY_ROOT_CHALLENGE_DOMAIN = 'peartube:legacy-publisher-root-migration:v1\0'
const PUBLISHER_PUBLIC_KEY_BYTES = 32
const PUBLISHER_SECRET_KEY_BYTES = 64
const PUBLISHER_ID_DOMAIN = 'peartube/publisher-id/v1'
const MIGRATION_NONCE_BYTES = 32


function redactPublisherVaultError(error, code = 'publisher-vault-error') {
  const safe = new Error(code)
  safe.code = code
  safe.redacted = true
  return safe
}

export { redactPublisherVaultError }

async function defaultSecureStoreLoader() {
  return import('expo-secure-store')
}

async function defaultCryptoLoader() {
  return import('./publisher-mobile-crypto')
}

async function defaultB4aLoader() {
  return import('b4a')
}

function unwrapModule(mod) {
  return mod?.default || mod
}

async function loadPublisherSecureStore(loader = defaultSecureStoreLoader) {
  try {
    const store = await loader()
    if (!store?.getItemAsync || !store?.setItemAsync || !store?.deleteItemAsync) {
      throw new Error('expo-secure-store unavailable')
    }
    return store
  } catch (error) {
    throw redactPublisherVaultError(error, 'publisher-vault-unavailable')
  }
}

export { loadPublisherSecureStore }

async function loadCryptoPair(options = {}) {
  const [cryptoMod, b4aMod] = await Promise.all([
    options.crypto ? Promise.resolve(options.crypto) : defaultCryptoLoader(),
    options.b4a ? Promise.resolve(options.b4a) : defaultB4aLoader(),
  ])
  return { crypto: unwrapModule(cryptoMod), b4a: unwrapModule(b4aMod) }
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

function publisherIdFor(publicKey, crypto, b4a) {
  const input = b4a.concat([
    b4a.from(PUBLISHER_ID_DOMAIN),
    toBuffer(publicKey, b4a, 'publicKey'),
  ])
  return b4a.toString(crypto.hash(input), 'hex')
}

function assertPublisherId(publisherId, publicKey, crypto, b4a) {
  const derived = publisherIdFor(publicKey, crypto, b4a)
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


function storageKey(publisherId) {
  if (typeof publisherId !== 'string' || !/^[a-z0-9._:-]{16,160}$/i.test(publisherId)) {
    throw new Error('invalid publisherId')
  }
  return `${PUBLISHER_ROOT_SERVICE}:${publisherId}`
}

function secureStoreOptions(SecureStore, overrides = {}) {
  return {
    keychainService: PUBLISHER_ROOT_SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    requireAuthentication: overrides.requireAuthentication !== false,
    authenticationPrompt: overrides.authenticationPrompt || 'Authorize PearTube publisher root signing',
  }
}

function encodeRootRecord({ publicKey, secretKey, b4a }) {
  return JSON.stringify({
    version: PUBLISHER_ROOT_RECORD_VERSION,
    publicKey: b4a.toString(publicKey, 'hex'),
    secretKey: b4a.toString(secretKey, 'hex'),
  })
}

function decodeRootRecord(raw, b4a) {
  if (!raw) return null
  const parsed = JSON.parse(raw)
  if (parsed?.version !== PUBLISHER_ROOT_RECORD_VERSION) throw new Error('unsupported publisher root record')
  return {
    publicKey: toBuffer(parsed.publicKey, b4a, 'publicKey'),
    secretKey: toBuffer(parsed.secretKey, b4a, 'secretKey'),
  }
}

export function createPublisherKeyVault(options = {}) {
  const secureStoreLoader = options.secureStoreLoader || defaultSecureStoreLoader

  async function loadRoot(publisherId) {
    const [{ b4a }, SecureStore] = await Promise.all([
      loadCryptoPair(options),
      loadPublisherSecureStore(secureStoreLoader),
    ])
    const raw = await SecureStore.getItemAsync(storageKey(publisherId), secureStoreOptions(SecureStore, options))
    return { root: decodeRootRecord(raw, b4a), b4a, SecureStore }
  }

  return {
    async createRoot(input = {}) {
      let keyPair
      try {
        const { crypto, b4a } = await loadCryptoPair(options)
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        keyPair = input.seed ? crypto.keyPair(toBuffer(input.seed, b4a, 'seed')) : crypto.keyPair()
        const publisherId = assertPublisherId(input.publisherId, keyPair.publicKey, crypto, b4a)
        await SecureStore.setItemAsync(
          storageKey(publisherId),
          encodeRootRecord({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, b4a }),
          secureStoreOptions(SecureStore, options),
        )
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
        const { crypto, b4a } = await loadCryptoPair(options)
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        const publicKey = toBuffer(input.publicKey, b4a, 'publicKey')
        secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
        assertKeyContinuity(publicKey, secretKey, crypto, b4a)
        const publisherId = assertPublisherId(input.publisherId, publicKey, crypto, b4a)
        await SecureStore.setItemAsync(
          storageKey(publisherId),
          encodeRootRecord({ publicKey, secretKey, b4a }),
          secureStoreOptions(SecureStore, options),
        )
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
        const { crypto, b4a } = await loadCryptoPair(options)
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        const validated = validateLegacyRootMigrationRequest(input, crypto, b4a)
        secretKey = validated.secretKey
        challenge = validated.challenge
        const publicKey = validated.publicKey
        const publisherId = assertPublisherId(undefined, publicKey, crypto, b4a)
        await SecureStore.setItemAsync(
          storageKey(publisherId),
          encodeRootRecord({ publicKey, secretKey, b4a }),
          secureStoreOptions(SecureStore, options),
        )
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
        const { root, b4a } = await loadRoot(input.publisherId)
        return root ? root.publicKey : null
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },

    async signProtocolRecord(input = {}) {
      let root
      let preimage
      try {
        const { crypto } = await loadCryptoPair(options)
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
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        await SecureStore.deleteItemAsync(storageKey(input.publisherId), secureStoreOptions(SecureStore, options))
        return { ok: true }
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },
  }
}
