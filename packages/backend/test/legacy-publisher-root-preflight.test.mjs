import test from 'brittle'
import {
  loadBareOrNodeFsModule,
  loadBareOrNodePathModule,
} from '../src/runtime-modules.js'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'

import { writeIdentityKeyFile } from '../src/identity-key-file.js'
import {
  migrateLegacyPublisherRootsInMetaDb,
  runLegacyPublisherRootPreflight,
} from '../src/legacy-publisher-root-preflight.js'

const fs = await loadBareOrNodeFsModule()
const path = await loadBareOrNodePathModule()
let os
try {
  os = (await import('bare-os')).default
} catch {
  os = (await import('node:' + 'os')).default
}

const CHALLENGE_DOMAIN = Buffer.from('peartube:legacy-publisher-root-migration:v1\0')

function legacyIdentity (keyPair, overrides = {}) {
  return {
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    driveKey: 'ab'.repeat(32),
    channelKey: 'ab'.repeat(32),
    name: 'Legacy',
    createdAt: 1,
    secretKey: Buffer.from(keyPair.secretKey),
    ...overrides,
  }
}

function validAcknowledgement (request, keyPair) {
  return {
    version: 1,
    durable: true,
    publicKey: request.identityPublicKey,
    challengeSignature: crypto.sign(request.challenge, keyPair.secretKey),
  }
}

async function closeMetadata ({ metaDb, core, store }) {
  try { await metaDb?.close() } catch {}
  try { await core?.close() } catch {}
  try { await store?.close() } catch {}
}

async function openMetadata (storagePath, primaryKey, { wait = false } = {}) {
  const store = new Corestore(storagePath, {
    primaryKey,
    unsafe: true,
    wait,
    allowBackup: false,
  })
  let core = null
  let metaDb = null
  try {
    await store.ready()
    core = store.get({ name: 'peartube-meta' })
    await core.ready()
    metaDb = new Hyperbee(core, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
    })
    await metaDb.ready()
    return { store, core, metaDb }
  } catch (error) {
    await closeMetadata({ metaDb, core, store })
    throw error
  }
}

async function seedStorage (identities) {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-legacy-root-preflight-'))
  const primaryKey = Buffer.from(crypto.randomBytes(32))
  const identityPublicKey = Buffer.from(crypto.randomBytes(32))
  const resources = await openMetadata(storagePath, primaryKey)
  try {
    await resources.metaDb.put('identities', identities)
    await resources.metaDb.put('activeIdentity', identities[0]?.publicKey ?? null)
  } finally {
    await closeMetadata(resources)
  }
  await writeIdentityKeyFile(storagePath, { primaryKey, identityPublicKey })


  return { storagePath, primaryKey }
}

async function readStoredIdentities (storagePath, primaryKey) {
  const resources = await openMetadata(storagePath, primaryKey)
  try {
    return (await resources.metaDb.get('identities'))?.value ?? []
  } finally {
    await closeMetadata(resources)
  }
}

function removeStorage (storagePath) {
  fs.rmSync(storagePath, { recursive: true, force: true })
}

test('metaDb migration transfers the exact source and atomically records completion', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair, {
    unrelatedSecret: 'keep-me',
    profile: { title: 'Legacy title' },
  })
  const expectedSecret = Buffer.from(source.secretKey)
  const { storagePath, primaryKey } = await seedStorage([source, {
    publicKey: 'cd'.repeat(32),
    driveKey: 'ef'.repeat(32),
    name: 'Current',
    createdAt: 2,
  }])
  const resources = await openMetadata(storagePath, primaryKey)

  try {
    let callbackRequest = null
    const result = await migrateLegacyPublisherRootsInMetaDb({
      metaDb: resources.metaDb,
      migrateLegacyPublisherRoot: async request => {
        callbackRequest = request
        t.alike(Buffer.from(request.secretKey), expectedSecret, 'exact legacy source is transferred')
        t.ok(request.challenge.subarray(0, CHALLENGE_DOMAIN.length).equals(CHALLENGE_DOMAIN), 'challenge is domain separated')
        return validAcknowledgement(request, keyPair)
      },
    })

    t.alike(result, {
      status: 'complete',
      scanned: 2,
      migrated: 1,
      remaining: 0,
    })
    t.ok(callbackRequest, 'migration callback was invoked')

    const stored = (await resources.metaDb.get('identities')).value
    t.absent(stored[0].secretKey, 'source deletion and marker are committed together')
    t.is(stored[0].unrelatedSecret, 'keep-me')
    t.alike(stored[0].profile, { title: 'Legacy title' })
    t.alike(stored[0].legacyPublisherRootMigration, {
      version: 1,
      status: 'completed',
      publicKey: source.publicKey,
    })
  } finally {
    await closeMetadata(resources)
    removeStorage(storagePath)
  }
})

test('mixed acknowledgements report exact migrated and remaining counts', async (t) => {
  const migratedKeyPair = crypto.keyPair()
  const pendingKeyPair = crypto.keyPair()
  const migratedSource = legacyIdentity(migratedKeyPair)
  const pendingSource = legacyIdentity(pendingKeyPair, {
    driveKey: 'bc'.repeat(32),
    channelKey: 'bc'.repeat(32),
  })
  const current = {
    publicKey: 'cd'.repeat(32),
    driveKey: 'ef'.repeat(32),
    name: 'Current',
    createdAt: 2,
  }
  const { storagePath, primaryKey } = await seedStorage([
    migratedSource,
    pendingSource,
    current,
  ])
  const resources = await openMetadata(storagePath, primaryKey)

  try {
    const result = await migrateLegacyPublisherRootsInMetaDb({
      metaDb: resources.metaDb,
      migrateLegacyPublisherRoot: async request => {
        if (request.identityPublicKey === migratedSource.publicKey) {
          return validAcknowledgement(request, migratedKeyPair)
        }
        return { version: 1, durable: false }
      },
    })
    t.alike(result, {
      status: 'pending',
      scanned: 3,
      migrated: 1,
      remaining: 1,
    })

    const stored = (await resources.metaDb.get('identities')).value
    t.absent(stored[0].secretKey)
    t.ok(stored[1].secretKey)
    t.absent(stored[2].secretKey)
  } finally {
    await closeMetadata(resources)
    removeStorage(storagePath)
  }
})

test('missing, denied, and invalid callbacks preserve the exact source', async (t) => {
  const callbacks = [
    undefined,
    async () => { throw new Error('denied with private storage detail') },
    async () => ({ version: 1, durable: true, publicKey: 'ff'.repeat(32), challengeSignature: Buffer.alloc(64) }),
  ]

  for (const migrateLegacyPublisherRoot of callbacks) {
    const keyPair = crypto.keyPair()
    const source = legacyIdentity(keyPair)
    const expectedSecret = Buffer.from(source.secretKey)
    const { storagePath, primaryKey } = await seedStorage([source])
    const resources = await openMetadata(storagePath, primaryKey)
    try {
      const result = await migrateLegacyPublisherRootsInMetaDb({
        metaDb: resources.metaDb,
        migrateLegacyPublisherRoot,
      })
      t.alike(result, {
        status: 'pending',
        scanned: 1,
        migrated: 0,
        remaining: 1,
      })
      const [stored] = (await resources.metaDb.get('identities')).value
      t.alike(Buffer.from(stored.secretKey), expectedSecret, 'the persisted source is unchanged')
      t.absent(stored.legacyPublisherRootMigration)
    } finally {
      await closeMetadata(resources)
      removeStorage(storagePath)
    }
  }
})

test('preflight migrates once, suppresses restart sends, stays offline, and releases storage', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const { storagePath, primaryKey } = await seedStorage([source])
  const legacyIdentityKeyPath = path.join(storagePath, 'db', 'identity-key')
  const legacyIdentityKeyBytes = fs.readFileSync(path.join(storagePath, 'identity-key'))
  fs.writeFileSync(legacyIdentityKeyPath, legacyIdentityKeyBytes)
  let sends = 0
  const migrateLegacyPublisherRoot = async request => {
    sends++
    return validAcknowledgement(request, keyPair)
  }

  try {
    const normalStartup = await openMetadata(storagePath, primaryKey)
    try {
      const preserved = await migrateLegacyPublisherRootsInMetaDb({
        metaDb: normalStartup.metaDb,
      })
      t.alike(preserved, {
        status: 'pending',
        scanned: 1,
        migrated: 0,
        remaining: 1,
      })
      const [stored] = (await normalStartup.metaDb.get('identities')).value
      t.alike(
        Buffer.from(stored.secretKey),
        Buffer.from(source.secretKey),
        'normal startup without a callback preserves the source for preflight'
      )
    } finally {
      await closeMetadata(normalStartup)
    }

    const first = await runLegacyPublisherRootPreflight({
      storagePath,
      migrateLegacyPublisherRoot,
    })
    t.alike(first, {
      status: 'complete',
      scanned: 1,
      migrated: 1,
      remaining: 0,
    })
    t.is(sends, 1)
    t.ok(fs.existsSync(path.join(storagePath, 'identity-key')), 'Corestore infrastructure key is retained')
    t.alike(
      fs.readFileSync(legacyIdentityKeyPath),
      legacyIdentityKeyBytes,
      'legacy Corestore infrastructure key is not deleted or rewritten'
    )
    t.absent(fs.existsSync(path.join(storagePath, 'swarm-key.json')), 'preflight does not initialize Hyperswarm')

    const second = await runLegacyPublisherRootPreflight({
      storagePath,
      migrateLegacyPublisherRoot,
    })
    t.alike(second, {
      status: 'no-legacy-roots',
      scanned: 1,
      migrated: 0,
      remaining: 0,
    })
    t.is(sends, 1, 'durable completion suppresses sends after restart')

    const stored = await readStoredIdentities(storagePath, primaryKey)
    t.is(stored.length, 1, 'the same storage path can be reopened after preflight cleanup')
    t.absent(stored[0].secretKey)
  } finally {
    removeStorage(storagePath)
  }
})

test('concurrent in-process preflights join one migration promise', async (t) => {
  const keyPair = crypto.keyPair()
  const { storagePath } = await seedStorage([legacyIdentity(keyPair)])
  let sends = 0
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  const migrateLegacyPublisherRoot = async request => {
    sends++
    markStarted()
    await gate
    return validAcknowledgement(request, keyPair)
  }

  try {
    const first = runLegacyPublisherRootPreflight({ storagePath, migrateLegacyPublisherRoot })
    await started
    const second = runLegacyPublisherRootPreflight({ storagePath, migrateLegacyPublisherRoot })
    t.is(first, second, 'concurrent callers receive the same in-flight promise')
    t.is(sends, 1, 'only one transfer starts')
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    t.alike(firstResult, secondResult)
    t.is(sends, 1, 'joined caller does not open or transfer again')
  } finally {
    release?.()
    removeStorage(storagePath)
  }
})

test('storage lock contention fails closed without exposing an error', async (t) => {
  const keyPair = crypto.keyPair()
  const { storagePath, primaryKey } = await seedStorage([legacyIdentity(keyPair)])
  const held = await openMetadata(storagePath, primaryKey)

  try {
    const result = await runLegacyPublisherRootPreflight({
      storagePath,
      migrateLegacyPublisherRoot: async request => validAcknowledgement(request, keyPair),
      waitForLock: false,
    })
    t.alike(result, {
      status: 'unavailable',
      scanned: 0,
      migrated: 0,
      remaining: 0,
      errorCode: 'STORAGE_LOCKED',
    })
    const [stored] = (await held.metaDb.get('identities')).value
    t.ok(stored.secretKey, 'locked storage preserves the source')
  } finally {
    await closeMetadata(held)
    removeStorage(storagePath)
  }
})

test('waitForLock waits for storage ownership before migrating', async (t) => {
  const keyPair = crypto.keyPair()
  const { storagePath, primaryKey } = await seedStorage([legacyIdentity(keyPair)])
  const held = await openMetadata(storagePath, primaryKey)
  let sends = 0

  try {
    const pending = runLegacyPublisherRootPreflight({
      storagePath,
      migrateLegacyPublisherRoot: async request => {
        sends++
        return validAcknowledgement(request, keyPair)
      },
      waitForLock: true,
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    t.is(sends, 0, 'no source is read or transferred while the storage lock is held')

    await closeMetadata(held)
    const result = await pending
    t.alike(result, {
      status: 'complete',
      scanned: 1,
      migrated: 1,
      remaining: 0,
    })
    t.is(sends, 1)
  } finally {
    await closeMetadata(held)
    removeStorage(storagePath)
  }
})

test('unavailable migration input returns only bounded status fields', async (t) => {
  const result = await migrateLegacyPublisherRootsInMetaDb({ metaDb: null })
  t.alike(result, {
    status: 'unavailable',
    scanned: 0,
    migrated: 0,
    remaining: 0,
    errorCode: 'MIGRATION_UNAVAILABLE',
  })
  t.is(Object.keys(result).length, 5, 'no raw error, path, or key is projected')
  for (const field of ['scanned', 'migrated', 'remaining']) {
    t.ok(Number.isSafeInteger(result[field]), `${field} is a safe integer`)
  }
})

test('package root and explicit subpath export the preflight API', async (t) => {
  const root = await import('@peartube/backend')
  const subpath = await import('@peartube/backend/legacy-publisher-root-preflight')
  t.is(subpath.runLegacyPublisherRootPreflight, runLegacyPublisherRootPreflight)
  t.is(subpath.migrateLegacyPublisherRootsInMetaDb, migrateLegacyPublisherRootsInMetaDb)
  t.is(root.runLegacyPublisherRootPreflight, runLegacyPublisherRootPreflight)
  t.is(root.migrateLegacyPublisherRootsInMetaDb, migrateLegacyPublisherRootsInMetaDb)
})
