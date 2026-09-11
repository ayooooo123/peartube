import { derivePublisherId } from '@peartube/backend/publisher'
import { publisherRootSignaturePreimage } from '../../lib/publisher-signer-bridge'

export const BUN_PUBLISHER_ROOT_SERVICE = 'peartube.publisher-root.v1'
export const BUN_PUBLISHER_ROOT_RECORD_VERSION = 1
const LEGACY_ROOT_MIGRATION_VERSION = 1
const LEGACY_ROOT_CHALLENGE_DOMAIN = 'peartube:legacy-publisher-root-migration:v1\0'
const PUBLISHER_PUBLIC_KEY_BYTES = 32
const PUBLISHER_SECRET_KEY_BYTES = 64
const MIGRATION_NONCE_BYTES = 32

type PublisherVaultError = Error & { code: string; redacted: true }

type B4aApi = {
  from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Uint8Array
  toString(data: Uint8Array, encoding?: string): string
  isBuffer?(obj: unknown): boolean
  equals(left: Uint8Array, right: Uint8Array): boolean
}

type PublisherCrypto = {
  keyPair(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array }
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array
  verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean
}

type AsyncKeyringEntry = {
  getPassword(): Promise<string | null | undefined>
  setPassword(value: string): Promise<void>
  deletePassword?: () => Promise<unknown>
  deleteCredential?: () => Promise<unknown>
}

type AsyncKeyringConstructor = new (service: string, account: string) => AsyncKeyringEntry

type BytesLike = string | Uint8Array | ArrayBuffer

type BunPublisherKeyVaultOptions = {
  keyringLoader?: () => Promise<{ AsyncEntry?: AsyncKeyringConstructor }>
  cryptoLoader?: () => Promise<PublisherCrypto | { default?: PublisherCrypto }>
  b4aLoader?: () => Promise<B4aApi | { default?: B4aApi }>
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

export function redactPublisherVaultError(_error: unknown, code = 'publisher-vault-error'): PublisherVaultError {
  const safe = new Error(code) as PublisherVaultError
  safe.code = code
  safe.redacted = true
  return safe
}

async function loadKeyring(
  // Platform optional: OS keyring is desktop-Bun only.
  loader: BunPublisherKeyVaultOptions['keyringLoader'] =
    () => import('@napi-rs/keyring') as Promise<{ AsyncEntry?: AsyncKeyringConstructor }>,
): Promise<{ AsyncEntry: AsyncKeyringConstructor }> {
  try {
    const keyring = await loader()
    if (typeof keyring?.AsyncEntry !== 'function') throw new Error('AsyncEntry unavailable')
    return keyring as { AsyncEntry: AsyncKeyringConstructor }
  } catch (error) {
    throw redactPublisherVaultError(error, 'publisher-keyring-unavailable')
  }
}

async function loadCrypto(
  // Platform optional: hypercore-crypto is native and injected in tests.
  loader: BunPublisherKeyVaultOptions['cryptoLoader'] = () => import('hypercore-crypto') as Promise<PublisherCrypto>,
): Promise<PublisherCrypto> {
  const mod = await loader()
  return ((mod as { default?: PublisherCrypto })?.default || mod) as PublisherCrypto
}

async function loadB4a(
  // Platform optional: b4a resolution differs across runtimes; tests inject their own.
  loader: BunPublisherKeyVaultOptions['b4aLoader'] = () => import('b4a') as Promise<B4aApi>,
): Promise<B4aApi> {
  const mod = await loader()
  return ((mod as { default?: B4aApi })?.default || mod) as B4aApi
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

function publisherIdFor(publicKey: Uint8Array, b4a: B4aApi): string {
  return b4a.toString(derivePublisherId(toBuffer(publicKey, b4a, 'publicKey')), 'hex')
}

function assertPublisherId(publisherId: string | undefined, publicKey: Uint8Array, b4a: B4aApi): string {
  const derived = publisherIdFor(publicKey, b4a)
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


const BUN_PUBLISHER_ROOT_ACCOUNT = 'active-publisher-root'

function serializeRoot({ publicKey, secretKey, b4a }: {
  publicKey: Uint8Array
  secretKey: Uint8Array
  b4a: B4aApi
}): string {
  return JSON.stringify({
    version: BUN_PUBLISHER_ROOT_RECORD_VERSION,
    publicKey: b4a.toString(publicKey, 'hex'),
    secretKey: b4a.toString(secretKey, 'hex'),
  })
}

function parseRoot(raw: string | null | undefined, b4a: B4aApi): RootRecord | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as { version?: number; publicKey?: string; secretKey?: string }
  if (parsed?.version !== BUN_PUBLISHER_ROOT_RECORD_VERSION) throw new Error('unsupported publisher root record')
  return {
    publicKey: toBuffer(parsed.publicKey, b4a, 'publicKey'),
    secretKey: toBuffer(parsed.secretKey, b4a, 'secretKey'),
  }
}

export function createBunPublisherKeyVault(options: BunPublisherKeyVaultOptions = {}) {
  async function entryFor(): Promise<AsyncKeyringEntry> {
    const keyring = await loadKeyring(options.keyringLoader)
    return new keyring.AsyncEntry(BUN_PUBLISHER_ROOT_SERVICE, BUN_PUBLISHER_ROOT_ACCOUNT)
  }

  async function loadRoot(publisherId?: string) {
    const [entry, b4a] = await Promise.all([entryFor(), loadB4a(options.b4aLoader)])
    const raw = await entry.getPassword()
    const root = parseRoot(raw, b4a)
    if (root && publisherId !== undefined) assertPublisherId(publisherId, root.publicKey, b4a)
    return { root, b4a, entry }
  }

  async function createRoot(input: CreateRootInput = {}) {
    let keyPair: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined
    let existingRoot: RootRecord | null | undefined
    try {
      const [crypto, b4a, loaded] = await Promise.all([
        loadCrypto(options.cryptoLoader),
        loadB4a(options.b4aLoader),
        loadRoot(input.publisherId),
      ])
      existingRoot = loaded.root
      if (existingRoot) {
        if (input.seed) {
          keyPair = crypto.keyPair(toBuffer(input.seed, b4a, 'seed'))
          if (!b4a.equals(keyPair.publicKey, existingRoot.publicKey)) throw new Error('active publisher root mismatch')
        }
        const publisherId = assertPublisherId(input.publisherId, existingRoot.publicKey, b4a)
        return { publisherId, publicKey: toHex(existingRoot.publicKey, b4a, 'publicKey') }
      }
      keyPair = input.seed ? crypto.keyPair(toBuffer(input.seed, b4a, 'seed')) : crypto.keyPair()
      const publisherId = assertPublisherId(input.publisherId, keyPair.publicKey, b4a)
      const entry = await entryFor()
      await entry.setPassword(serializeRoot({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey, b4a }))
      return { publisherId, publicKey: toHex(keyPair.publicKey, b4a, 'publicKey') }
    } catch (error) {
      throw redactPublisherVaultError(error)
    } finally {
      keyPair?.secretKey?.fill?.(0)
      existingRoot?.secretKey?.fill?.(0)
    }
  }

  return {
    createRoot,

    async getOrCreateRoot() {
      return createRoot({})
    },

    async importRoot(input: ImportRootInput = {}) {
      let secretKey: Uint8Array | undefined
      try {
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        const publicKey = toBuffer(input.publicKey, b4a, 'publicKey')
        secretKey = toBuffer(input.secretKey, b4a, 'secretKey')
        assertKeyContinuity(publicKey, secretKey, crypto, b4a)
        const publisherId = assertPublisherId(input.publisherId, publicKey, b4a)
        const { root: existing, entry } = await loadRoot()
        try {
          if (existing && !b4a.equals(existing.publicKey, publicKey)) throw new Error('active publisher root mismatch')
          await entry.setPassword(serializeRoot({ publicKey, secretKey, b4a }))
        } finally {
          existing?.secretKey?.fill?.(0)
        }
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
        const [crypto, b4a] = await Promise.all([loadCrypto(options.cryptoLoader), loadB4a(options.b4aLoader)])
        const validated = validateLegacyRootMigrationRequest(input, crypto, b4a)
        secretKey = validated.secretKey
        challenge = validated.challenge
        const publicKey = validated.publicKey
        const publisherId = assertPublisherId(undefined, publicKey, b4a)
        const { root: existing, entry } = await loadRoot()
        try {
          if (existing && !b4a.equals(existing.publicKey, publicKey)) throw new Error('active publisher root mismatch')
          await entry.setPassword(serializeRoot({ publicKey, secretKey, b4a }))
        } finally {
          existing?.secretKey?.fill?.(0)
        }
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
      let root: RootRecord | null | undefined
      try {
        const loaded = await loadRoot(input.publisherId)
        root = loaded.root
        return root ? loaded.b4a.from(root.publicKey) : null
      } catch (error) {
        throw redactPublisherVaultError(error)
      } finally {
        root?.secretKey?.fill?.(0)
      }
    },

    async signProtocolRecord(input: SignProtocolRecordInput = {}) {
      let root: RootRecord | null | undefined
      let preimage: Uint8Array | undefined
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

    async deleteRoot(input: { publisherId?: string } = {}) {
      let root: RootRecord | null | undefined
      try {
        const loaded = await loadRoot(input.publisherId)
        root = loaded.root
        if (typeof loaded.entry.deletePassword === 'function') await loaded.entry.deletePassword()
        else await loaded.entry.deleteCredential!()
        return { ok: true }
      } catch (error) {
        throw redactPublisherVaultError(error)
      }
      finally {
        root?.secretKey?.fill?.(0)
      }
    },
  }
}
