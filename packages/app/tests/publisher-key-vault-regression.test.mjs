import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { derivePublisherId } from '../../backend/src/publisher/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

async function loadVault(relativePath) {
  const result = await build({
    entryPoints: [path.join(appRoot, relativePath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['@napi-rs/keyring', '@peartube/backend/publisher', 'expo-secure-store', 'react-native', 'hypercore-crypto', 'sodium-native'],
    write: false,
  })
  const tempDir = fs.mkdtempSync(path.join(appRoot, '.tmp-publisher-vault-'))
  const tempFile = path.join(tempDir, 'publisher-key-vault.cjs')
  fs.writeFileSync(tempFile, result.outputFiles[0].text)
  const mod = await import(pathToFileURL(tempFile).href)
  fs.rmSync(tempDir, { recursive: true, force: true })
  return mod
}

test('mobile publisher root vault is SecureStore-only and exposes no secret export path', () => {
  const source = readAppFile('lib/publisher-key-vault.ts')
  const pkg = readJson('packages/app/package.json')

  assert.equal(pkg.dependencies['expo-secure-store'], '~56.0.4')
  assert.match(source, /import\('expo-secure-store'\)/)
  assert.match(source, /createPublisherKeyVault/)
  assert.match(source, /createRoot/)
  assert.match(source, /importRoot/)
  assert.match(source, /getPublicKey/)
  assert.match(source, /signProtocolRecord/)
  assert.doesNotMatch(source, /signDigest/)
  assert.match(source, /deleteRoot/)
  assert.match(source, /AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/)
  assert.match(source, /keychainService:\s*PUBLISHER_ROOT_SERVICE/)
  assert.match(source, /redactPublisherVaultError/)

  assert.doesNotMatch(source, /secure-storage/)
  assert.doesNotMatch(source, /expo-file-system/)
  assert.doesNotMatch(source, /fallback(Get|Set|Delete|Uri)/)
  assert.doesNotMatch(source, /export\s+.*getSecret/)
  assert.doesNotMatch(source, /getSecret\s*\(/)
  assert.doesNotMatch(source, /console\.(log|warn|error)/)
})

test('native publisher signer bundles without Bare sodium addons', async () => {
  const result = await build({
    entryPoints: [path.join(appRoot, 'lib/publisher-shell-signer.native.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['expo-secure-store'],
    write: false,
  })
  const bundled = result.outputFiles[0].text
  assert.doesNotMatch(bundled, /sodium-native|hypercore-crypto/)
})

test('desktop publisher root vault lives in the privileged Bun process and uses an OS keyring dependency', () => {
  const vaultSource = readAppFile('src/bun/publisher-key-vault.ts')
  const bunSource = readAppFile('src/bun/index.ts')
  const pkg = readJson('packages/app/package.json')

  assert.equal(pkg.dependencies['@napi-rs/keyring'], '^1.3.0')
  assert.match(vaultSource, /import\('@napi-rs\/keyring'\)/)
  assert.match(vaultSource, /new keyring\.AsyncEntry\(/)
  assert.match(vaultSource, /setPassword/)
  assert.match(vaultSource, /getPassword/)
  assert.match(vaultSource, /deletePassword|deleteCredential/)
  assert.match(vaultSource, /createBunPublisherKeyVault/)
  assert.match(vaultSource, /signProtocolRecord/)
  assert.doesNotMatch(vaultSource, /signDigest/)
  assert.match(vaultSource, /redactPublisherVaultError/)
  assert.match(bunSource, /createBunPublisherKeyVault/)
  assert.match(bunSource, /const publisherKeyVault = createBunPublisherKeyVault/)

  assert.doesNotMatch(vaultSource, /from 'fs'|from "fs"|from 'path'|from "path"|homedir\(/)
  assert.doesNotMatch(vaultSource, /getSecret\s*\(/)
  assert.doesNotMatch(vaultSource, /export\s+.*getSecret/)
  assert.doesNotMatch(bunSource, /getSecret|publisherVaultGetSecret|rootSecret/)
})

test('mobile and Bun vaults derive canonical publisher ids and reject mismatched identity imports', async () => {
  const [mobileModule, bunModule] = await Promise.all([
    loadVault('lib/publisher-key-vault.ts'),
    loadVault('src/bun/publisher-key-vault.ts'),
  ])
  const mobileValues = new Map()
  const SecureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    async getItemAsync(key) { return mobileValues.get(key) ?? null },
    async setItemAsync(key, value) { mobileValues.set(key, value) },
    async deleteItemAsync(key) { mobileValues.delete(key) },
  }
  const bunValues = new Map()
  class AsyncEntry {
    constructor(service, name) { this.key = `${service}:${name}` }
    async getPassword() { return bunValues.get(this.key) ?? null }
    async setPassword(value) { bunValues.set(this.key, value) }
    async deletePassword() { bunValues.delete(this.key) }
  }
  const adapters = [
    mobileModule.createPublisherKeyVault({
      secureStoreLoader: async () => SecureStore,
      crypto,
      b4a,
      requireAuthentication: false,
    }),
    bunModule.createBunPublisherKeyVault({
      keyringLoader: async () => ({ AsyncEntry }),
      cryptoLoader: async () => crypto,
      b4aLoader: async () => b4a,
    }),
  ]

  for (const [index, vault] of adapters.entries()) {
    const seed = b4a.alloc(32, index + 20)
    const pair = crypto.keyPair(seed)
    const expectedPublisherId = b4a.toString(derivePublisherId(pair.publicKey), 'hex')
    const created = await vault.createRoot({ seed })
    assert.equal(created.publisherId, expectedPublisherId)
    assert.match(created.publisherId, /^[0-9a-f]{64}$/)
    await assert.rejects(
      vault.createRoot({ seed, publisherId: 'f'.repeat(64) }),
      (error) => error?.redacted === true && !error.message.includes(expectedPublisherId),
    )
    const other = crypto.keyPair(b4a.alloc(32, index + 80))
    await assert.rejects(
      vault.importRoot({
        publicKey: pair.publicKey,
        secretKey: other.secretKey,
        publisherId: expectedPublisherId,
      }),
      (error) => error?.redacted === true,
    )
    const imported = await vault.importRoot({
      publicKey: pair.publicKey,
      secretKey: pair.secretKey,
      publisherId: expectedPublisherId,
    })
    assert.equal(imported.publisherId, expectedPublisherId)
  }
})

test('mobile and Bun vaults only import and acknowledge the exact legacy-root migration challenge', async () => {
  const [mobileModule, bunModule] = await Promise.all([
    loadVault('lib/publisher-key-vault.ts'),
    loadVault('src/bun/publisher-key-vault.ts'),
  ])
  const mobileValues = new Map()
  const SecureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    async getItemAsync(key) { return mobileValues.get(key) ?? null },
    async setItemAsync(key, value) { mobileValues.set(key, value) },
    async deleteItemAsync(key) { mobileValues.delete(key) },
  }
  const bunValues = new Map()
  class AsyncEntry {
    constructor(service, name) { this.key = `${service}:${name}` }
    async getPassword() { return bunValues.get(this.key) ?? null }
    async setPassword(value) { bunValues.set(this.key, value) }
    async deletePassword() { bunValues.delete(this.key) }
  }
  const adapters = [
    {
      values: mobileValues,
      vault: mobileModule.createPublisherKeyVault({
        secureStoreLoader: async () => SecureStore,
        crypto,
        b4a,
        requireAuthentication: false,
      }),
    },
    {
      values: bunValues,
      vault: bunModule.createBunPublisherKeyVault({
        keyringLoader: async () => ({ AsyncEntry }),
        cryptoLoader: async () => crypto,
        b4aLoader: async () => b4a,
      }),
    },
  ]
  const challengeDomain = b4a.from('peartube:legacy-publisher-root-migration:v1\0')

  for (const [index, { values, vault }] of adapters.entries()) {
    const pair = crypto.keyPair(b4a.alloc(32, index + 41))
    const other = crypto.keyPair(b4a.alloc(32, index + 91))
    const nonce = b4a.alloc(32, index + 7)
    const challenge = b4a.concat([challengeDomain, pair.publicKey, nonce])
    const validRequest = {
      version: 1,
      identityPublicKey: pair.publicKey,
      secretKey: pair.secretKey,
      challenge,
    }
    const invalidRequests = [
      { ...validRequest, version: 2 },
      {
        ...validRequest,
        challenge: b4a.concat([
          b4a.from('peartube:legacy-publisher-root-migration:v2\0'),
          pair.publicKey,
          nonce,
        ]),
      },
      {
        ...validRequest,
        challenge: b4a.concat([challengeDomain, other.publicKey, nonce]),
      },
      {
        ...validRequest,
        challenge: b4a.concat([challengeDomain, pair.publicKey, nonce.subarray(1)]),
      },
      { ...validRequest, identityPublicKey: pair.publicKey.subarray(1) },
      { ...validRequest, secretKey: pair.secretKey.subarray(1) },
      { ...validRequest, secretKey: other.secretKey },
    ]

    for (const request of invalidRequests) {
      await assert.rejects(
        vault.importLegacyRootMigration(request),
        (error) => error?.redacted === true && !String(error?.message).includes(b4a.toString(pair.secretKey, 'hex')),
      )
      assert.equal(values.size, 0, 'invalid migration requests must not persist a root')
    }

    const acknowledgement = await vault.importLegacyRootMigration(validRequest)
    assert.deepEqual(Object.keys(acknowledgement).sort(), [
      'challengeSignature',
      'durable',
      'publicKey',
      'version',
    ])
    assert.equal(acknowledgement.version, 1)
    assert.equal(acknowledgement.durable, true)
    assert.deepEqual(Buffer.from(acknowledgement.publicKey), Buffer.from(pair.publicKey))
    assert.equal(
      crypto.verify(challenge, acknowledgement.challengeSignature, pair.publicKey),
      true,
      'acknowledgement must sign the exact validated challenge',
    )
    assert.equal(values.size, 1, 'valid migration must durably persist one root before acknowledging')
    const persisted = JSON.parse([...values.values()][0])
    assert.equal(persisted.publicKey, b4a.toString(pair.publicKey, 'hex'))
    assert.equal(persisted.secretKey, b4a.toString(pair.secretKey, 'hex'))
  }
})

test('mobile and Bun migration imports zero mutable secret and challenge copies on denial and success', async () => {
  const [mobileModule, bunModule] = await Promise.all([
    loadVault('lib/publisher-key-vault.ts'),
    loadVault('src/bun/publisher-key-vault.ts'),
  ])
  const mobileValues = new Map()
  const SecureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
    async getItemAsync(key) { return mobileValues.get(key) ?? null },
    async setItemAsync(key, value) { mobileValues.set(key, value) },
    async deleteItemAsync(key) { mobileValues.delete(key) },
  }
  const bunValues = new Map()
  class AsyncEntry {
    constructor(service, name) { this.key = `${service}:${name}` }
    async getPassword() { return bunValues.get(this.key) ?? null }
    async setPassword(value) { bunValues.set(this.key, value) }
    async deletePassword() { bunValues.delete(this.key) }
  }
  const domain = b4a.from('peartube:legacy-publisher-root-migration:v1\0')

  for (const [index, createVault] of [
    (trackedB4a) => mobileModule.createPublisherKeyVault({
      secureStoreLoader: async () => SecureStore,
      crypto,
      b4a: trackedB4a,
      requireAuthentication: false,
    }),
    (trackedB4a) => bunModule.createBunPublisherKeyVault({
      keyringLoader: async () => ({ AsyncEntry }),
      cryptoLoader: async () => crypto,
      b4aLoader: async () => trackedB4a,
    }),
  ].entries()) {
    let watchedSecret = null
    let watchedChallenge = null
    let secretCopy = null
    let challengeCopy = null
    const sensitiveCopies = []

    const trackedB4a = new Proxy(b4a, {
      get(target, property) {
        if (property !== 'from') return target[property]
        return (value, ...args) => {
          const copy = target.from(value, ...args)
          if (value === watchedSecret) secretCopy = copy
          if (value === watchedChallenge) challengeCopy = copy
          if (
            value instanceof Uint8Array &&
            (value.byteLength === 64 || value.byteLength === domain.byteLength + 64)
          ) {
            sensitiveCopies.push(copy)
          }
          return copy
        }
      },
    })
    const vault = createVault(trackedB4a)
    const pair = crypto.keyPair(b4a.alloc(32, index + 121))
    const wrongPair = crypto.keyPair(b4a.alloc(32, index + 141))
    watchedSecret = pair.secretKey
    watchedChallenge = null
    await assert.rejects(vault.importLegacyRootMigration({
      version: 1,
      identityPublicKey: pair.publicKey,
      secretKey: watchedSecret,
      challenge: null,
    }))
    assert.ok(secretCopy?.every((byte) => byte === 0), 'secret copy must be zeroed when challenge decoding fails')

    secretCopy = null
    challengeCopy = null
    watchedSecret = wrongPair.secretKey
    watchedChallenge = b4a.concat([domain, pair.publicKey, b4a.alloc(32, index + 12)])

    await assert.rejects(vault.importLegacyRootMigration({
      version: 1,
      identityPublicKey: pair.publicKey,
      secretKey: watchedSecret,
      challenge: watchedChallenge,
    }))
    assert.ok(secretCopy?.every((byte) => byte === 0), 'denied secret copy must be zeroed')
    assert.ok(challengeCopy?.every((byte) => byte === 0), 'denied challenge copy must be zeroed')

    watchedSecret = pair.secretKey
    watchedChallenge = b4a.concat([domain, pair.publicKey, b4a.alloc(32, index + 22)])
    secretCopy = null
    challengeCopy = null
    await vault.importLegacyRootMigration({
      version: 1,
      identityPublicKey: pair.publicKey,
      secretKey: watchedSecret,
      challenge: watchedChallenge,
    })
    assert.ok(secretCopy?.every((byte) => byte === 0), 'persisted secret copy must be zeroed')
    assert.ok(challengeCopy?.every((byte) => byte === 0), 'signed challenge copy must be zeroed')
    assert.ok(
      sensitiveCopies.every((copy) => copy.every((byte) => byte === 0)),
      'every mutable secret or challenge copy must be zeroed',
    )
  }
})

test('Bun vault reuses one active publisher root across fresh startup and legacy upgrade', async () => {
  const bunModule = await loadVault('src/bun/publisher-key-vault.ts')
  const values = new Map()
  class AsyncEntry {
    constructor(service, name) { this.key = `${service}:${name}` }
    async getPassword() { return values.get(this.key) ?? null }
    async setPassword(value) { values.set(this.key, value) }
    async deletePassword() { values.delete(this.key) }
  }
  const options = {
    keyringLoader: async () => ({ AsyncEntry }),
    cryptoLoader: async () => crypto,
    b4aLoader: async () => b4a,
  }
  const freshVault = bunModule.createBunPublisherKeyVault(options)
  const first = await freshVault.getOrCreateRoot()
  const again = await freshVault.getOrCreateRoot()
  assert.deepEqual(again, first)
  assert.equal(values.size, 1, 'fresh startup persists exactly one active root')

  values.clear()
  const pair = crypto.keyPair(b4a.alloc(32, 123))
  const nonce = b4a.alloc(32, 124)
  const challenge = b4a.concat([
    b4a.from('peartube:legacy-publisher-root-migration:v1\0'),
    pair.publicKey,
    nonce,
  ])
  const upgradeVault = bunModule.createBunPublisherKeyVault(options)
  await upgradeVault.importLegacyRootMigration({
    version: 1,
    identityPublicKey: pair.publicKey,
    secretKey: pair.secretKey,
    challenge,
  })
  const upgraded = await upgradeVault.getOrCreateRoot()
  assert.equal(upgraded.publisherId, b4a.toString(derivePublisherId(pair.publicKey), 'hex'))
  assert.equal(upgraded.publicKey, b4a.toString(pair.publicKey, 'hex'))
  assert.equal(values.size, 1, 'upgrade imports and reuses exactly one active root')
})
