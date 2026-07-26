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
    authPublicKey: identityManager.getActivePublicKey(),
    get transportFeeds() { return transportFeeds.slice() },
  }
}

function installAtomicActivation(runtime) {
  return installSeedPinIdentityMutationHooks({
    identityManager: runtime.identityManager,
    onMutation: async mutation => {
      if (mutation.method === 'setActiveIdentity') {
        await runtime.personalManager.setActive(runtime.identityManager.getActivePublicKey())
        runtime.authPublicKey = runtime.identityManager.getActivePublicKey()
      }
    },
    onRollback: async rollback => {
      if (rollback.mutation.method === 'setActiveIdentity') {
        await runtime.personalManager.setActive(rollback.previousPublicKey)
        runtime.authPublicKey = rollback.previousPublicKey
      }
    },
  })
}

test('identity activation without its PersonalStore secret fails closed through restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-missing-secret-'))
  const metaDb = createMetaDb()
  let runtime
  let removeHooks = null
  try {
    runtime = await createRuntime({ directory, metaDb })
    await runtime.personalManager.provisionSecret({ publicKey: identityA.publicKey, secret: secretA })
    await runtime.transaction.apply({
      profile: { ...DEFAULT_CONSUMER_MODERATION_PROFILE, curatorSubscriptions: [feedA] },
    })
    const storeA = runtime.ctx.personal
    removeHooks = installAtomicActivation(runtime)

    await t.exception(
      runtime.identityManager.setActiveIdentity(identityB.publicKey),
      /PersonalStore secret.*unavailable/i,
      'an identity cannot commit over the previous store when its secret is unavailable',
    )
    t.is(runtime.identityManager.getActivePublicKey(), identityA.publicKey, 'in-memory identity remains A')
    t.is(runtime.authPublicKey, identityA.publicKey, 'transport authentication remains A')
    t.is(runtime.ctx.personal, storeA, 'the active PersonalStore remains exactly A')
    t.alike(runtime.controller.getEffectiveCuratorSubscriptions(), [feedA], 'profile remains A')
    t.alike(runtime.transportFeeds, [feedA], 'transport subscriptions remain A')

    const persistedAfterFailure = createIdentityManager({ ctx: { metaDb } })
    await persistedAfterFailure.loadIdentities()
    t.is(persistedAfterFailure.getActivePublicKey(), identityA.publicKey, 'persisted identity remains A')

    removeHooks()
    removeHooks = null
    await runtime.personalManager.close()
    await runtime.store.close()
    runtime = null

    runtime = await createRuntime({ directory, metaDb })
    t.is(runtime.identityManager.getActivePublicKey(), identityA.publicKey, 'restart reads identity A')
    await runtime.personalManager.provisionSecret({ publicKey: identityA.publicKey, secret: secretA })
    t.alike(runtime.controller.getEffectiveCuratorSubscriptions(), [feedA], 'restart restores profile A')
    t.alike(runtime.transportFeeds, [feedA], 'restart restores transport A')

    const restartedStoreA = runtime.ctx.personal
    await runtime.personalManager.provisionSecret({ publicKey: identityB.publicKey, secret: secretB })
    removeHooks = installAtomicActivation(runtime)
    await runtime.identityManager.setActiveIdentity(identityB.publicKey)
    t.is(runtime.identityManager.getActivePublicKey(), identityB.publicKey, 'identity B commits after secret provision')
    t.is(runtime.authPublicKey, identityB.publicKey, 'transport authentication commits B')
    t.not(runtime.ctx.personal, restartedStoreA, 'B never reuses the old A PersonalStore')
    t.is(runtime.ctx.personal, runtime.personalManager.getActive(), 'the active PersonalStore commits B')
    t.alike(
      runtime.controller.getEffectiveCuratorSubscriptions(),
      DEFAULT_CONSUMER_MODERATION_PROFILE.curatorSubscriptions,
      'B loads its own default profile, not A',
    )
    t.alike(
      runtime.transportFeeds,
      DEFAULT_CONSUMER_MODERATION_PROFILE.curatorSubscriptions,
      'B transport follows B profile, not A',
    )
  } finally {
    removeHooks?.()
    await runtime?.personalManager.close().catch(() => {})
    await runtime?.store.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

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
