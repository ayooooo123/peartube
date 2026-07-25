import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createIdentityManager } from '../src/identity.js'

const CHALLENGE_DOMAIN = Buffer.from('peartube:legacy-publisher-root-migration:v1\0')

function legacyIdentity (keyPair = crypto.keyPair(), overrides = {}) {
  const publicKey = Buffer.from(keyPair.publicKey).toString('hex')
  return {
    publicKey,
    driveKey: 'ab'.repeat(32),
    channelKey: 'ab'.repeat(32),
    name: 'Legacy',
    createdAt: 1,
    secretKey: Buffer.from(keyPair.secretKey),
    ...overrides,
  }
}

function createMetaDb (identities, { failPuts = false } = {}) {
  const values = new Map([
    ['identities', identities],
    ['activeIdentity', identities[0]?.publicKey ?? null],
  ])
  let puts = 0
  return {
    async get (key) {
      return values.has(key) ? { value: values.get(key) } : null
    },
    async put (key, value) {
      puts++
      if (failPuts) throw new Error('sensitive filesystem detail /Users/alice/vault')
      values.set(key, value)
    },
    identities () { return values.get('identities') },
    puts () { return puts },
  }
}

function validAck (request, keyPair, overrides = {}) {
  return {
    version: 1,
    durable: true,
    publicKey: request.identityPublicKey,
    challengeSignature: crypto.sign(request.challenge, keyPair.secretKey),
    ...overrides,
  }
}

function assertSourceRetained (t, metaDb, expectedSecret, message = 'source secret remains durable') {
  const stored = metaDb.identities()
  t.is(stored.length, 1, 'no replacement identity is created')
  t.ok(stored[0].secretKey, message)
  if (stored[0].secretKey) t.alike(Buffer.from(stored[0].secretKey), expectedSecret, message)
  t.absent(stored[0].legacyPublisherRootMigration, 'completion is not recorded')
}

test('missing migration callback keeps the legacy root durable without exposing it', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  const manager = createIdentityManager({ ctx: { metaDb } })

  await manager.loadIdentities()

  assertSourceRetained(t, metaDb, expectedSecret)
  const listed = manager.getIdentities()
  t.is(listed.length, 1)
  t.absent(listed[0].secretKey, 'list projection never exposes the legacy root')
  t.absent(manager.getActiveIdentity().secretKey, 'active projection never exposes the legacy root')
})

test('locked and denied migration callbacks keep the exact source root', async (t) => {
  for (const response of [
    async () => ({ status: 'locked' }),
    async () => { throw new Error('denied: secret=should-never-escape') },
  ]) {
    const keyPair = crypto.keyPair()
    const source = legacyIdentity(keyPair)
    const expectedSecret = Buffer.from(source.secretKey)
    const metaDb = createMetaDb([source])
    const manager = createIdentityManager({
      ctx: { metaDb },
      migrateLegacyPublisherRoot: response,
    })

    await manager.loadIdentities()
    assertSourceRetained(t, metaDb, expectedSecret)
  }
})

test('public-key mismatch retains the legacy root without a completion marker', async (t) => {
  const keyPair = crypto.keyPair()
  const other = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => validAck(request, keyPair, {
      publicKey: Buffer.from(other.publicKey).toString('hex'),
    }),
  })

  await manager.loadIdentities()
  assertSourceRetained(t, metaDb, expectedSecret)
})

test('invalid signature and stale acknowledgement retain the source and use fresh domain-separated challenges', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  const challenges = []
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => {
      challenges.push(Buffer.from(request.challenge))
      return validAck(request, keyPair, {
        challengeSignature: crypto.sign(Buffer.from('stale challenge'), keyPair.secretKey),
      })
    },
  })

  await manager.loadIdentities()
  await manager.loadIdentities()

  assertSourceRetained(t, metaDb, expectedSecret)
  t.is(challenges.length, 2)
  if (challenges.length === 2) {
    t.ok(challenges[0].subarray(0, CHALLENGE_DOMAIN.length).equals(CHALLENGE_DOMAIN), 'challenge is domain separated')
    t.ok(challenges[1].subarray(0, CHALLENGE_DOMAIN.length).equals(CHALLENGE_DOMAIN), 'retry remains domain separated')
    t.not(challenges[0].toString('hex'), challenges[1].toString('hex'), 'every attempt gets a fresh challenge')
  }
})

test('non-durable and oversized acknowledgements retain the source', async (t) => {
  for (const overrides of [
    { durable: false },
    { challengeSignature: Buffer.alloc(65) },
    { publicKey: 'aa'.repeat(33) },
  ]) {
    const keyPair = crypto.keyPair()
    const source = legacyIdentity(keyPair)
    const expectedSecret = Buffer.from(source.secretKey)
    const metaDb = createMetaDb([source])
    const manager = createIdentityManager({
      ctx: { metaDb },
      migrateLegacyPublisherRoot: async request => validAck(request, keyPair, overrides),
    })

    await manager.loadIdentities()
    assertSourceRetained(t, metaDb, expectedSecret)
  }
})

test('persistence I/O failure retains the source after a valid acknowledgement', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source], { failPuts: true })
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => validAck(request, keyPair),
  })

  let loadError = null
  try {
    await manager.loadIdentities()
  } catch (error) {
    loadError = error
  }
  t.absent(loadError, 'migration persistence failure is contained and redacted')

  assertSourceRetained(t, metaDb, expectedSecret)
  t.is(metaDb.puts(), 1, 'one atomic commit was attempted')
})

test('interrupted migration retains the exact source root', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async () => {
      const error = new Error('interrupted while handling secret bytes')
      error.name = 'AbortError'
      throw error
    },
  })

  await manager.loadIdentities()
  assertSourceRetained(t, metaDb, expectedSecret)
})

test('valid durable continuity proof deletes only the migrated root and commits a per-identity marker', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair, { unrelatedSecret: 'keep-me', profile: { title: 'Legacy title' } })
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  let callbackSecret
  let callbackChallenge
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => {
      callbackSecret = request.secretKey
      callbackChallenge = request.challenge
      t.alike(Buffer.from(request.secretKey), expectedSecret, 'callback receives the exact legacy root')
      t.is(request.identityPublicKey, source.publicKey)
      return validAck(request, keyPair)
    },
  })

  await manager.loadIdentities()

  const [stored] = metaDb.identities()
  t.absent(stored.secretKey, 'only the migrated legacy source is deleted')
  t.is(stored.unrelatedSecret, 'keep-me')
  t.alike(stored.profile, { title: 'Legacy title' })
  t.alike(stored.legacyPublisherRootMigration, {
    version: 1,
    status: 'completed',
    publicKey: source.publicKey,
  })
  t.ok(callbackSecret, 'callback receives a mutable secret copy')
  t.ok(callbackChallenge, 'callback receives a mutable challenge')
  if (callbackSecret) t.ok(callbackSecret.every(byte => byte === 0), 'mutable secret copy is zeroed')
  if (callbackChallenge) t.ok(callbackChallenge.every(byte => byte === 0), 'mutable challenge is zeroed')
})

test('a completion marker cannot suppress migration while its source secret still exists', async (t) => {
  const keyPair = crypto.keyPair()
  const publicKey = Buffer.from(keyPair.publicKey).toString('hex')
  const marker = {
    version: 1,
    status: 'completed',
    publicKey,
  }
  const source = legacyIdentity(keyPair, { legacyPublisherRootMigration: marker })
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  let sends = 0
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => {
      sends++
      if (sends === 1) return { version: 1, durable: false }
      return validAck(request, keyPair)
    },
  })

  await manager.loadIdentities()

  let [stored] = metaDb.identities()
  t.is(sends, 1, 'persisted source remains authoritative and is dispatched')
  t.ok(stored.secretKey, 'failed fresh acknowledgement retains the source')
  if (stored.secretKey) t.alike(Buffer.from(stored.secretKey), expectedSecret)
  t.alike(stored.legacyPublisherRootMigration, marker, 'failed acknowledgement safely retains the existing marker')

  await manager.loadIdentities()

  stored = metaDb.identities()[0]
  t.is(sends, 2, 'source remains retryable despite the pre-existing marker')
  t.absent(stored.secretKey, 'fresh durable continuity proof permits deletion')
  t.alike(stored.legacyPublisherRootMigration, marker)
})

test('failed attempt retries, while committed success permanently suppresses sends', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const metaDb = createMetaDb([source])
  let sends = 0
  const migrateLegacyPublisherRoot = async request => {
    sends++
    if (sends === 1) return { durable: false }
    return validAck(request, keyPair)
  }
  const manager = createIdentityManager({ ctx: { metaDb }, migrateLegacyPublisherRoot })

  await manager.loadIdentities()
  t.is(sends, 1)
  t.ok(metaDb.identities()[0].secretKey, 'failed attempt stays retryable')
  await manager.loadIdentities()
  t.is(sends, 2)
  t.absent(metaDb.identities()[0].secretKey)
  await manager.loadIdentities()

  const restarted = createIdentityManager({ ctx: { metaDb }, migrateLegacyPublisherRoot })
  await restarted.loadIdentities()
  t.is(sends, 2, 'committed completion is permanent across reload and restart')
})

test('concurrent loads share one migration and never send twice', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair)
  const metaDb = createMetaDb([source])
  let sends = 0
  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => {
      sends++
      markStarted()
      await gate
      return validAck(request, keyPair)
    },
  })

  const first = manager.loadIdentities()
  const second = manager.loadIdentities()
  await started
  t.is(sends, 1, 'only one send starts')
  release()
  await Promise.all([first, second])
  t.is(sends, 1, 'concurrent load joins the same state-machine run')
  t.absent(metaDb.identities()[0].secretKey)
})

test('malformed legacy secret is bounded, retained, and never sent', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair, { secretKey: Buffer.alloc(65, 7) })
  const expectedSecret = Buffer.from(source.secretKey)
  const metaDb = createMetaDb([source])
  let sends = 0
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async () => { sends++; return null },
  })

  await manager.loadIdentities()
  t.is(sends, 0, 'out-of-bounds secret is rejected before callback')
  assertSourceRetained(t, metaDb, expectedSecret)
})

test('Bare JSON array encoding of a valid legacy secret remains migratable', async (t) => {
  const keyPair = crypto.keyPair()
  const source = legacyIdentity(keyPair, {
    secretKey: Array.from(keyPair.secretKey),
  })
  const expectedSecret = Buffer.from(keyPair.secretKey)
  const metaDb = createMetaDb([source])
  let sends = 0
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async request => {
      sends++
      t.alike(Buffer.from(request.secretKey), expectedSecret, 'Bare JSON bytes are transferred exactly')
      return validAck(request, keyPair)
    },
  })

  await manager.loadIdentities()

  t.is(sends, 1)
  t.absent(metaDb.identities()[0].secretKey)
  t.alike(metaDb.identities()[0].legacyPublisherRootMigration, {
    version: 1,
    status: 'completed',
    publicKey: source.publicKey,
  })
})

test('malformed Bare JSON byte arrays remain durable and are never sent', async (t) => {
  const keyPair = crypto.keyPair()
  const malformedSecret = Array(64).fill(0)
  malformedSecret[31] = 256
  const source = legacyIdentity(keyPair, { secretKey: malformedSecret })
  const metaDb = createMetaDb([source])
  let sends = 0
  const manager = createIdentityManager({
    ctx: { metaDb },
    migrateLegacyPublisherRoot: async () => {
      sends++
      return null
    },
  })

  await manager.loadIdentities()

  t.is(sends, 0, 'invalid Bare JSON bytes are rejected before callback')
  t.alike(metaDb.identities()[0].secretKey, malformedSecret)
  t.absent(metaDb.identities()[0].legacyPublisherRootMigration)
})
