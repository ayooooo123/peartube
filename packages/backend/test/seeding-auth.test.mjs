import b4a from 'b4a'
import test from 'brittle'

import { createApi } from '../src/api.js'
import { SeedingAuthorizationError, SeedingManager } from '../src/seeding.js'

function createMetaDb(seed = {}) {
  const state = new Map(Object.entries(seed))
  return {
    state,
    async get(key) {
      return state.has(key) ? { value: state.get(key) } : null
    },
    async put(key, value) {
      state.set(key, value)
    },
    async del(key) {
      state.delete(key)
    },
    createReadStream({ gte, lt } = {}) {
      const entries = Array.from(state.entries())
        .filter(([key]) => (!gte || key >= gte) && (!lt || key < lt))
        .map(([key, value]) => ({ key, value }))

      return {
        async *[Symbol.asyncIterator]() {
          yield * entries
        }
      }
    }
  }
}

function createStore() {
  const cores = new Map()
  return {
    storage: {
      async flush() {},
      async compact() {}
    },
    get(input) {
      const key = b4a.isBuffer(input)
        ? b4a.toString(input, 'hex')
        : b4a.isBuffer(input?.key)
          ? b4a.toString(input.key, 'hex')
          : String(input)
      if (!cores.has(key)) {
        cores.set(key, {
          async ready() {},
          async clear() {}
        })
      }
      return cores.get(key)
    }
  }
}

function createIdentityManager(activeIdentity = null) {
  return {
    getActiveIdentity() {
      return activeIdentity
    }
  }
}

test('SeedingManager rejects explicit seeding mutations without an active identity', async (t) => {
  const manager = new SeedingManager(createStore(), createMetaDb(), {
    identityManager: createIdentityManager(null)
  })

  await t.exception(
    () => manager.pinChannel('aa'.repeat(32)),
    SeedingAuthorizationError
  )
  await t.exception(
    () => manager.setMaxStorageGB(10),
    SeedingAuthorizationError
  )
  await t.exception(
    () => manager.clearCache(),
    SeedingAuthorizationError
  )
})

test('SeedingManager allows automatic watched seeds but requires active identity for explicit pins', async (t) => {
  const metaDb = createMetaDb()
  const manager = new SeedingManager(createStore(), metaDb, {
    identityManager: createIdentityManager(null)
  })

  t.is(await manager.addSeed('drive-a', 'videos/watched.mp4', 'watched', { byteLength: 1024 }), true)
  t.is(manager.getActiveSeeds().length, 1)

  await t.exception(
    () => manager.addSeed('drive-a', 'videos/pinned.mp4', 'pinned', { byteLength: 1024 }),
    SeedingAuthorizationError
  )
})

test('SeedingManager allows explicit seeding mutations for the active channel identity', async (t) => {
  const active = { publicKey: 'identity-a', driveKey: 'channel-a' }
  const manager = new SeedingManager(createStore(), createMetaDb(), {
    identityManager: createIdentityManager(active)
  })

  await manager.pinChannel('channel-a')
  t.alike(manager.getPinnedChannels(), ['channel-a'])

  await manager.addSeed('channel-a', 'videos/pinned.mp4', 'pinned', { byteLength: 2048 })
  t.is(manager.getActiveSeeds().length, 1)
  t.is(manager.getActiveSeeds()[0].reason, 'pinned')

  await manager.setMaxStorageGB(8)
  t.is(manager.config.maxStorageGB, 8)
})

test('seeding API mutation endpoints return unauthorized without active identity', async (t) => {
  const manager = new SeedingManager(createStore(), createMetaDb(), {
    identityManager: createIdentityManager(null)
  })
  const api = createApi({ ctx: { store: createStore(), metaDb: createMetaDb() }, seedingManager: manager })

  t.alike(await api.pinChannel('aa'.repeat(32)), { success: false, error: 'Unauthorized seeding mutation' })
  t.alike(await api.setStorageLimit(5), { success: false, error: 'Unauthorized seeding mutation' })
  t.alike(await api.clearCache(), { success: false, clearedBytes: 0, error: 'Unauthorized seeding mutation' })
})
