import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'

import { createIdentityManager } from '../src/identity.js'
import {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  createConsumerModerationProfileController,
  createConsumerModerationProfileTransaction,
  DEFAULT_CONSUMER_MODERATION_PROFILE,
} from '../src/moderation/profile.js'
import { createPersonalManager } from '../src/personal/personal-manager.js'
import { installSeedPinIdentityMutationHooks } from '../src/seed-pin/index.js'

const identityA = {
  publicKey: '41'.repeat(32),
  driveKey: '51'.repeat(32),
  channelKey: '51'.repeat(32),
  name: 'Identity A',
  createdAt: 1,
}
const identityB = {
  publicKey: '42'.repeat(32),
  driveKey: '52'.repeat(32),
  channelKey: '52'.repeat(32),
  name: 'Identity B',
  createdAt: 2,
}
const secretA = '61'.repeat(32)
const secretB = '62'.repeat(32)
const feedA = 'a1'.repeat(32)
const feedB = 'b2'.repeat(32)

function createMetaDb() {
  const values = new Map([
    ['identities', [identityA, identityB]],
    ['activeIdentity', identityA.publicKey],
  ])
  return {
    async get(key) {
      return values.has(key) ? { value: values.get(key) } : null
    },
    async put(key, value) {
      values.set(key, value)
    },
  }
}

function profileRepository(ctx) {
  return {
    async load() {
      return ctx.personal?.getSetting
        ? ctx.personal.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
        : null
    },
    async save(state) {
      if (ctx.personal?.writable) {
        await ctx.personal.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state)
      }
    },
  }
}

async function createRuntime({ directory, metaDb, rejectedFeed = null }) {
  const store = new Corestore(directory)
  await store.ready()
  const ctx = { store, metaDb, metaSubspaces: null, swarm: null, personal: null }
  const identityManager = createIdentityManager({ ctx })
  await identityManager.loadIdentities()
  const controller = createConsumerModerationProfileController({
    repository: profileRepository(ctx),
  })
  await controller.ready
  let transportFeeds = []
  let reloadProfile = async () => {}
  const personalManager = createPersonalManager({
    ctx,
    identityManager,
    onActiveStoreChanged: () => reloadProfile(),
  })
  const transaction = createConsumerModerationProfileTransaction({
    profileController: controller,
    applyState: async state => {
      const feeds = state.profile.enabled === false
        ? []
        : state.profile.curatorSubscriptions.slice()
      if (feeds.includes(rejectedFeed?.value)) throw new Error('B transport reconciliation rejected')
      transportFeeds = feeds
    },
  })
  reloadProfile = () => transaction.reload()
  await personalManager.init()
  return {
    store,
    ctx,
    identityManager,
    controller,
    personalManager,
    transaction,
    get transportFeeds() { return transportFeeds.slice() },
  }
}

function installAtomicActivation(runtime) {
  return installSeedPinIdentityMutationHooks({
    identityManager: runtime.identityManager,
    onMutation: async mutation => {
      if (mutation.method === 'setActiveIdentity') {
        await runtime.personalManager.setActive(runtime.identityManager.getActivePublicKey())
      }
    },
    onRollback: async rollback => {
      if (rollback.mutation.method === 'setActiveIdentity') {
        await runtime.personalManager.setActive(rollback.previousPublicKey)
      }
    },
  })
}

test('identity and PersonalStore profile activation roll back together and survive restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-personal-atomicity-'))
  const metaDb = createMetaDb()
  const rejectedFeed = { value: null }
  let runtime
  let removeHooks = null
  try {
    runtime = await createRuntime({ directory, metaDb, rejectedFeed })
    await runtime.personalManager.provisionSecret({ publicKey: identityA.publicKey, secret: secretA })
    await runtime.transaction.apply({
      profile: { ...DEFAULT_CONSUMER_MODERATION_PROFILE, curatorSubscriptions: [feedA] },
    })
    await runtime.personalManager.provisionSecret({ publicKey: identityB.publicKey, secret: secretB })

    // Seed a distinct durable profile for B, then return every layer to A
    // before exercising the hooked app-facing identity mutation.
    await runtime.identityManager.setActiveIdentity(identityB.publicKey)
    await runtime.personalManager.setActive(identityB.publicKey)
    await runtime.transaction.apply({
      profile: { ...DEFAULT_CONSUMER_MODERATION_PROFILE, curatorSubscriptions: [feedB] },
    })
    await runtime.identityManager.setActiveIdentity(identityA.publicKey)
    await runtime.personalManager.setActive(identityA.publicKey)

    removeHooks = installAtomicActivation(runtime)
    rejectedFeed.value = feedB
    await t.exception(
      runtime.identityManager.setActiveIdentity(identityB.publicKey),
      /B transport reconciliation rejected/,
      'a rejected B transport reconciliation rejects the whole switch',
    )
    t.is(runtime.identityManager.getActivePublicKey(), identityA.publicKey, 'in-memory identity rolls back to A')
    t.is(runtime.ctx.personal, runtime.personalManager.getActive(), 'PersonalStore rolls back to A')
    t.alike(runtime.controller.getEffectiveCuratorSubscriptions(), [feedA], 'profile rolls back to A')
    t.alike(runtime.transportFeeds, [feedA], 'transport rolls back to A')

    removeHooks()
    removeHooks = null
    await runtime.personalManager.close()
    await runtime.store.close()
    runtime = null

    runtime = await createRuntime({ directory, metaDb, rejectedFeed })
    t.is(runtime.identityManager.getActivePublicKey(), identityA.publicKey, 'restart reads durable identity A')
    if (runtime.identityManager.getActivePublicKey() !== identityA.publicKey) return
    await runtime.personalManager.provisionSecret({ publicKey: identityA.publicKey, secret: secretA })
    await runtime.personalManager.provisionSecret({ publicKey: identityB.publicKey, secret: secretB })
    t.is(runtime.ctx.personal, runtime.personalManager.getActive(), 'restart opens A PersonalStore')
    t.alike(runtime.controller.getEffectiveCuratorSubscriptions(), [feedA], 'restart reloads exact profile A')
    t.alike(runtime.transportFeeds, [feedA], 'restart subscribes exact transport A')

    rejectedFeed.value = null
    removeHooks = installAtomicActivation(runtime)
    await runtime.identityManager.setActiveIdentity(identityB.publicKey)
    t.is(runtime.identityManager.getActivePublicKey(), identityB.publicKey, 'successful switch commits identity B')
    t.is(runtime.ctx.personal, runtime.personalManager.getActive(), 'successful switch commits B PersonalStore')
    t.alike(runtime.controller.getEffectiveCuratorSubscriptions(), [feedB], 'successful switch commits profile B')
    t.alike(runtime.transportFeeds, [feedB], 'successful switch commits transport B')

    const restartedIdentityManager = createIdentityManager({ ctx: { metaDb } })
    await restartedIdentityManager.loadIdentities()
    t.is(restartedIdentityManager.getActivePublicKey(), identityB.publicKey, 'successful B identity is durable')
  } finally {
    removeHooks?.()
    await runtime?.personalManager.close().catch(() => {})
    await runtime?.store.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
