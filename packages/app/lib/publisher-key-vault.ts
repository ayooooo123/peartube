import { publisherRootSignaturePreimage } from './publisher-signer-bridge'

export const PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const PUBLISHER_ROOT_RECORD_VERSION = 1
const LEGACY_ROOT_MIGRATION_VERSION = 1
const LEGACY_ROOT_CHALLENGE_DOMAIN = 'peartube:legacy-publisher-root-migration:v1\0'
const PUBLISHER_PUBLIC_KEY_BYTES = 32
const PUBLISHER_SECRET_KEY_BYTES = 64
const PUBLISHER_ID_DOMAIN = 'peartube/publisher-id/v1'
const MIGRATION_NONCE_BYTES = 32

type PublisherVaultError = Error & { code: string; redacted: true }

type B4aApi = {
  from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Uint8Array
  toString(data: Uint8Array, encoding?: string): string
  concat(buffers: Uint8Array[]): Uint8Array
  isBuffer?(obj: unknown): boolean
  equals(left: Uint8Array, right: Uint8Array): boolean
}

type PublisherCrypto = {
  hash(input: Uint8Array): Uint8Array
  keyPair(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array }
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array
  verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean
}

type SecureStoreModule = {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: unknown
}

type BytesLike = string | Uint8Array | ArrayBuffer

type PublisherKeyVaultOptions = {
  secureStoreLoader?: () => Promise<SecureStoreModule>
  crypto?: PublisherCrypto | Promise<PublisherCrypto | { default?: PublisherCrypto }> | { default?: PublisherCrypto }
  b4a?: B4aApi | Promise<B4aApi | { default?: B4aApi }> | { default?: B4aApi }
  requireAuthentication?: boolean
  authenticationPrompt?: string
}

type RootRecord = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

type CreateRootInput = {
  seed?: BytesLike
  publisherId?: string
}

type ImportRootInput = {
  publicKey?: BytesLike
  secretKey?: BytesLike
  publisherId?: string
}

type LegacyRootMigrationInput = {
  version?: number
  identityPublicKey?: BytesLike
  secretKey?: BytesLike
  challenge?: BytesLike
}

type SignProtocolRecordInput = {
  publisherId?: string
  recordType?: string
  recordId?: Uint8Array
  transitionId?: Uint8Array
}

function redactPublisherVaultError(_error: unknown, code = 'publisher-vault-error'): PublisherVaultError {
  const safe = new Error(code) as PublisherVaultError
  safe.code = code
  safe.redacted = true
  return safe
}

export { redactPublisherVaultError }

// Platform optional: expo-secure-store is native-only and must not be a static app import.
async function defaultSecureStoreLoader() {
  return import('expo-secure-store') as Promise<SecureStoreModule>
}

// Platform optional: mobile crypto stays behind the vault boundary for tree-shaking.
async function defaultCryptoLoader(): Promise<PublisherCrypto> {
  const mod = await import('./publisher-mobile-crypto')
  return unwrapModule(mod)
}

// Platform optional: b4a resolution differs across RN/web bundlers.
async function defaultB4aLoader(): Promise<B4aApi> {
  const mod = await import('b4a')
  return unwrapModule(mod) as B4aApi
}

function unwrapModule<T>(mod: T | { default?: T } | null | undefined): T {
  if (mod && typeof mod === 'object' && 'default' in mod && mod.default) return mod.default
  return mod as T
}

async function loadPublisherSecureStore(
  loader: () => Promise<SecureStoreModule> = defaultSecureStoreLoader,
): Promise<SecureStoreModule> {
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

async function loadCryptoPair(options: PublisherKeyVaultOptions = {}) {
  const [cryptoMod, b4aMod] = await Promise.all([
    options.crypto ? Promise.resolve(options.crypto) : defaultCryptoLoader(),
    options.b4a ? Promise.resolve(options.b4a) : defaultB4aLoader(),
  ])
  return {
    crypto: unwrapModule(cryptoMod) as PublisherCrypto,
    b4a: unwrapModule(b4aMod) as B4aApi,
  }
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{2})+$/i.test(value)
}

function toBuffer(value: unknown, b4a: B4aApi, name: string): Uint8Array {
  if (value instanceof Uint8Array || b4a.isBuffer?.(value)) return b4a.from(value as Uint8Array)
  if (isHex(value)) return b4a.from(value, 'hex')
  throw new Error(`${name} must be bytes or hex`)
}

function toHex(value: unknown, b4a: B4aApi, name: string): string {
  return b4a.toString(toBuffer(value, b4a, name), 'hex')
}

function publisherIdFor(publicKey: Uint8Array, crypto: PublisherCrypto, b4a: B4aApi): string {
  const input = b4a.concat([
    b4a.from(PUBLISHER_ID_DOMAIN),
    toBuffer(publicKey, b4a, 'publicKey'),
  ])
  return b4a.toString(crypto.hash(input), 'hex')
}

function assertPublisherId(
  publisherId: string | undefined,
  publicKey: Uint8Array,
  crypto: PublisherCrypto,
  b4a: B4aApi,
): string {
  const derived = publisherIdFor(publicKey, crypto, b4a)
  if (publisherId !== undefined && publisherId !== derived) throw new Error('publisherId does not match root public key')
  return derived
}

function assertKeyContinuity(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  crypto: PublisherCrypto,
  b4a: B4aApi,
): void {
  const challenge = b4a.from('peartube/publisher-root-import/v1')
  const signature = crypto.sign(challenge, secretKey)
  if (crypto.verify(challenge, signature, publicKey) !== true) throw new Error('publisher root key mismatch')
}

function validateLegacyRootMigrationRequest(
  input: LegacyRootMigrationInput,
  crypto: PublisherCrypto,
  b4a: B4aApi,
): { publicKey: Uint8Array; secretKey: Uint8Array; challenge: Uint8Array } {
  if (input?.version !== LEGACY_ROOT_MIGRATION_VERSION) throw new Error('unsupported legacy root migration')

  let secretKey: Uint8Array | undefined
  let challenge: Uint8Array | undefined
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


function storageKey(publisherId: unknown): string {
  if (typeof publisherId !== 'string' || !/^[a-z0-9._:-]{16,160}$/i.test(publisherId)) {
    throw new Error('invalid publisherId')
  }
  return `${PUBLISHER_ROOT_SERVICE}:${publisherId}`
}

function secureStoreOptions(
  SecureStore: SecureStoreModule,
  overrides: Pick<PublisherKeyVaultOptions, 'requireAuthentication' | 'authenticationPrompt'> = {},
) {
  return {
    keychainService: PUBLISHER_ROOT_SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    requireAuthentication: overrides.requireAuthentication !== false,
    authenticationPrompt: overrides.authenticationPrompt || 'Authorize PearTube publisher root signing',
  }
}

function encodeRootRecord({ publicKey, secretKey, b4a }: {
  publicKey: Uint8Array
  secretKey: Uint8Array
  b4a: B4aApi
}): string {
  return JSON.stringify({
    version: PUBLISHER_ROOT_RECORD_VERSION,
    publicKey: b4a.toString(publicKey, 'hex'),
    secretKey: b4a.toString(secretKey, 'hex'),
  })
}

function decodeRootRecord(raw: string | null | undefined, b4a: B4aApi): RootRecord | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as { version?: number; publicKey?: string; secretKey?: string }
  if (parsed?.version !== PUBLISHER_ROOT_RECORD_VERSION) throw new Error('unsupported publisher root record')
  return {
    publicKey: toBuffer(parsed.publicKey, b4a, 'publicKey'),
    secretKey: toBuffer(parsed.secretKey, b4a, 'secretKey'),
  }
}

export function createPublisherKeyVault(options: PublisherKeyVaultOptions = {}) {
  const secureStoreLoader = options.secureStoreLoader || defaultSecureStoreLoader

  async function loadRoot(publisherId: unknown) {
    const [{ b4a }, SecureStore] = await Promise.all([
      loadCryptoPair(options),
      loadPublisherSecureStore(secureStoreLoader),
    ])
    const raw = await SecureStore.getItemAsync(storageKey(publisherId), secureStoreOptions(SecureStore, options))
    return { root: decodeRootRecord(raw, b4a), b4a, SecureStore }
  }

  return {
    async createRoot(input: CreateRootInput = {}) {
      let keyPair: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined
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

    async importRoot(input: ImportRootInput = {}) {
      let secretKey: Uint8Array | undefined
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

    async importLegacyRootMigration(input: LegacyRootMigrationInput = {}) {
      let secretKey: Uint8Array | undefined
      let challenge: Uint8Array | undefined
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

    async getPublicKey(input: { publisherId?: string } = {}) {
      try {
        const { root } = await loadRoot(input.publisherId)
        return root ? root.publicKey : null
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
    },

    async signProtocolRecord(input: SignProtocolRecordInput = {}) {
      let root: RootRecord | null | undefined
      let preimage: Uint8Array | undefined
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

    async deleteRoot(input: { publisherId?: string } = {}) {
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
