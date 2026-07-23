// @ts-nocheck

export const PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const PUBLISHER_ROOT_RECORD_VERSION = 1

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
  return import('hypercore-crypto')
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
    publicKey: toHex(publicKey, b4a, 'publicKey'),
    secretKey: toHex(secretKey, b4a, 'secretKey'),
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
      try {
        const { crypto, b4a } = await loadCryptoPair(options)
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        const keyPair = input.seed ? crypto.keyPair(toBuffer(input.seed, b4a, 'seed')) : crypto.keyPair()
        const publicKey = toHex(keyPair.publicKey, b4a, 'publicKey')
        const publisherId = input.publisherId || `publisher:${publicKey}`
        await SecureStore.setItemAsync(
          storageKey(publisherId),
          encodeRootRecord({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, b4a }),
          secureStoreOptions(SecureStore, options),
        )
        return { publisherId, publicKey }
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },

    async importRoot(input = {}) {
      try {
        const { b4a } = await loadCryptoPair(options)
        const SecureStore = await loadPublisherSecureStore(secureStoreLoader)
        const publicKey = toBuffer(input.publicKey, b4a, 'publicKey')
        const secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
        const publisherId = input.publisherId || `publisher:${toHex(publicKey, b4a, 'publicKey')}`
        await SecureStore.setItemAsync(
          storageKey(publisherId),
          encodeRootRecord({ publicKey, secretKey, b4a }),
          secureStoreOptions(SecureStore, options),
        )
        return { publisherId, publicKey: toHex(publicKey, b4a, 'publicKey') }
      } catch (error) {
        throw redactPublisherVaultError(error)
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

    async signDigest(input = {}) {
      try {
        const { crypto, b4a } = await loadCryptoPair(options)
        const { root } = await loadRoot(input.publisherId)
        if (!root) throw new Error('publisher root missing')
        return {
          signer: root.publicKey,
          signature: crypto.sign(toBuffer(input.signingDigest, b4a, 'signingDigest'), root.secretKey),
        }
      } catch (error) {
        throw redactPublisherVaultError(error)
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
