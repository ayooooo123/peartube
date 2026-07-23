// @ts-nocheck

export const BUN_PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const BUN_PUBLISHER_ROOT_RECORD_VERSION = 1

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

function accountName(publisherId) {
  if (typeof publisherId !== 'string' || !/^[a-z0-9._:-]{16,160}$/i.test(publisherId)) {
    throw new Error('invalid publisherId')
  }
  return publisherId
}

function serializeRoot({ publicKey, secretKey, b4a }) {
  return JSON.stringify({
    version: BUN_PUBLISHER_ROOT_RECORD_VERSION,
    publicKey: toHex(publicKey, b4a, 'publicKey'),
    secretKey: toHex(secretKey, b4a, 'secretKey'),
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
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        const keyPair = input.seed ? crypto.keyPair(toBuffer(input.seed, b4a, 'seed')) : crypto.keyPair()
        const publicKey = toHex(keyPair.publicKey, b4a, 'publicKey')
        const publisherId = input.publisherId || `publisher:${publicKey}`
        const entry = await entryFor(publisherId)
        await entry.setPassword(serializeRoot({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, b4a }))
        return { publisherId, publicKey }
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },

    async importRoot(input = {}) {
      try {
        const b4a = await loadB4a(options.b4aLoader)
        const publicKey = toBuffer(input.publicKey, b4a, 'publicKey')
        const secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
        const publisherId = input.publisherId || `publisher:${toHex(publicKey, b4a, 'publicKey')}`
        const entry = await entryFor(publisherId)
        await entry.setPassword(serializeRoot({ publicKey, secretKey, b4a }))
        return { publisherId, publicKey: toHex(publicKey, b4a, 'publicKey') }
      } catch (error) {
        throw redactPublisherVaultError(error)
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

    async signDigest(input = {}) {
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
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
