import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'

import { createPersonalManager } from '../src/personal/personal-manager.js'
import {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  createConsumerModerationProfileTransaction,
  createConsumerModerationProfileController,
  DEFAULT_CONSUMER_MODERATION_PROFILE,
} from '../src/moderation/profile.js'
import { createPersonalApi } from '../src/api/personal.js'

function createIdentityManager() {
  let active = null
  const identities = []
  return {
    activate(identity) {
      if (!identities.includes(identity)) identities.push(identity)
      active = identity
    },
    getActiveIdentity() { return active },
    getActivePublicKey() { return active?.publicKey || null },
    getIdentities() { return identities },
    async setPersonalKey(publicKey, personalKey) {
      const identity = identities.find(candidate => candidate.publicKey === publicKey)
      if (identity) identity.personalKey = personalKey
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

function wireProfileApi(ctx, controller) {
  ctx.consumerModerationProfile = controller
  ctx.setConsumerModerationProfile = async input => {
    if (input?.operation === 'restore-defaults') return controller.restoreDefaults()
    if (input?.profile?.enabled === false) return controller.disable()
    return controller.replace(input.profile)
  }
  return createPersonalApi({ ctx })
}

test('anonymous desktop profile uses one encrypted PersonalStore across restart and later identity activation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-anonymous-personal-'))
  const anonymousSecret = '11'.repeat(32)
  const identitySecret = '22'.repeat(32)
  let bootstrapKey

  {
    const store = new Corestore(directory)
    await store.ready()
    const identityManager = createIdentityManager()
    const ctx = { store, metaDb: null, swarm: null, personal: null }
    const manager = createPersonalManager({ ctx, identityManager })
    ctx.personalManager = manager
    const controller = createConsumerModerationProfileController({ repository: profileRepository(ctx) })
    await controller.ready
    const api = wireProfileApi(ctx, controller)

    await manager.init()
    t.absent(ctx.personal, 'fresh anonymous backend has no unencrypted fallback store')
    const provisioned = await manager.provisionSecret({
      deviceLocal: true,
      secret: anonymousSecret,
    })
    bootstrapKey = provisioned.bootstrapKey
    t.ok(provisioned.encrypted)
    t.is(typeof bootstrapKey, 'string')
    t.is(bootstrapKey.length, 64)
    await controller.reload()

    await api.setPersonalSetting({
      key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      value: JSON.stringify({
        profile: {
          ...DEFAULT_CONSUMER_MODERATION_PROFILE,
          curatorSubscriptions: ['aa'.repeat(32)],
        },
      }),
    })
    t.alike(controller.getEffectiveCuratorSubscriptions(), ['aa'.repeat(32)])
    await api.setPersonalSetting({
      key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      value: JSON.stringify({ profile: { ...controller.getProfile(), enabled: false } }),
    })
    t.alike(controller.getEffectiveCuratorSubscriptions(), [])
    await api.setPersonalSetting({
      key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      value: JSON.stringify({ operation: 'restore-defaults' }),
    })
    t.alike(controller.getEffectiveCuratorSubscriptions(), DEFAULT_CONSUMER_MODERATION_PROFILE.curatorSubscriptions)
    await api.setPersonalSetting({
      key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      value: JSON.stringify({
        profile: {
          ...DEFAULT_CONSUMER_MODERATION_PROFILE,
          curatorSubscriptions: ['bb'.repeat(32)],
        },
      }),
    })

    await manager.close()
    await store.close()
  }

  {
    const store = new Corestore(directory)
    await store.ready()
    const identityManager = createIdentityManager()
    const ctx = { store, metaDb: null, swarm: null, personal: null }
    const manager = createPersonalManager({ ctx, identityManager })
    ctx.personalManager = manager
    const controller = createConsumerModerationProfileController({ repository: profileRepository(ctx) })
    await controller.ready
    wireProfileApi(ctx, controller)

    await manager.provisionSecret({
      deviceLocal: true,
      secret: anonymousSecret,
      bootstrapKey,
    })
    await controller.reload()
    t.alike(controller.getEffectiveCuratorSubscriptions(), ['bb'.repeat(32)], 'anonymous choice survives restart')

    const identity = { publicKey: 'cc'.repeat(32), personalKey: null }
    identityManager.activate(identity)
    await manager.setActive(identity.publicKey)
    t.ok(ctx.personal, 'anonymous authority remains active until identity encryption is provisioned')
    await manager.provisionSecret({ secret: identitySecret })
    await controller.reload()

    t.alike(controller.getEffectiveCuratorSubscriptions(), ['bb'.repeat(32)], 'identity activation preserves the profile')
    t.ok(ctx.personal.writable)
    t.alike(
      await ctx.personal.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY),
      await controller.inspect(),
      'profile exists in the active identity store',
    )
    t.absent(
      await manager.getAnonymous()?.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY),
      'durable migration clears the device-local duplicate',
    )

    await manager.close()
    await store.close()
  }

  fs.rmSync(directory, { recursive: true, force: true })
})

test('profile settings RPC is not gated on unrelated personal-store pairing readiness', async t => {
  const operations = []
  const ctx = {
    personal: null,
    consumerModerationProfile: {
      async inspect() {
        return { profile: DEFAULT_CONSUMER_MODERATION_PROFILE, customized: false }
      },
    },
    async setConsumerModerationProfile(input) {
      operations.push(input)
    },
  }
  const api = createPersonalApi({ ctx })

  await api.setPersonalSetting({
    key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
    value: JSON.stringify({ operation: 'restore-defaults' }),
  })

  t.is(operations.length, 1)
  t.is(operations[0].operation, 'restore-defaults')
})

test('active encrypted PersonalStore reconciles exact A/B profiles across switches, rollback, and restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-active-profile-switch-'))
  const secretA = '31'.repeat(32)
  const secretB = '32'.repeat(32)
  const feedA = 'a1'.repeat(32)
  const feedB = 'b2'.repeat(32)
  const identityA = { publicKey: '41'.repeat(32), personalKey: null }
  const identityB = { publicKey: '42'.repeat(32), personalKey: null }

  let store = new Corestore(directory)
  await store.ready()
  let manager
  try {
    const identityManager = createIdentityManager()
    identityManager.activate(identityA)
    const ctx = { store, metaDb: null, swarm: null, personal: null }
    let reloadActiveProfile = async () => {}
    manager = createPersonalManager({
      ctx,
      identityManager,
      onActiveStoreChanged: () => reloadActiveProfile(),
    })
    const controller = createConsumerModerationProfileController({ repository: profileRepository(ctx) })
    await controller.ready
    let appliedFeeds = []
    let rejectedFeed = null
    const transaction = createConsumerModerationProfileTransaction({
      profileController: controller,
      applyState: async state => {
        const nextFeeds = state.profile.enabled === false ? [] : state.profile.curatorSubscriptions
        if (nextFeeds.includes(rejectedFeed)) throw new Error('transport subscription rejected')
        appliedFeeds = nextFeeds.slice()
      },
    })
    reloadActiveProfile = () => transaction.reload()

    await manager.init()
    await manager.provisionSecret({ publicKey: identityA.publicKey, secret: secretA })
    await transaction.apply({
      profile: { ...DEFAULT_CONSUMER_MODERATION_PROFILE, curatorSubscriptions: [feedA] },
    })
    t.alike(appliedFeeds, [feedA], 'identity A owns its transport subscription')

    identityManager.activate(identityB)
    await manager.provisionSecret({ publicKey: identityB.publicKey, secret: secretB })
    await transaction.apply({
      profile: { ...DEFAULT_CONSUMER_MODERATION_PROFILE, curatorSubscriptions: [feedB] },
    })
    t.alike(appliedFeeds, [feedB], 'identity B owns a different transport subscription')

    identityManager.activate(identityA)
    await manager.setActive(identityA.publicKey)
    t.alike(controller.getEffectiveCuratorSubscriptions(), [feedA], 'switching to A reloads only A profile')
    t.alike(appliedFeeds, [feedA], 'transport reconciles to A')

    identityManager.activate(identityB)
    await manager.setActive(identityB.publicKey)
    t.alike(controller.getEffectiveCuratorSubscriptions(), [feedB], 'switching to B reloads only B profile')
    t.alike(appliedFeeds, [feedB], 'transport reconciles to B without stale A subscriptions')

    rejectedFeed = feedA
    identityManager.activate(identityA)
    await t.exception(
      manager.setActive(identityA.publicKey),
      /transport subscription rejected/,
      'failed reconciliation rejects the active-store switch',
    )
    t.is(ctx.personal, manager.getActive(), 'failed switch restores the previous PersonalStore')
    t.alike(controller.getEffectiveCuratorSubscriptions(), [feedB], 'failed switch restores B controller state')
    t.alike(appliedFeeds, [feedB], 'failed switch restores B transport state')
    rejectedFeed = null

    await manager.close()
    await store.close()
    manager = null

    store = new Corestore(directory)
    await store.ready()
    const restartedIdentityManager = createIdentityManager()
    restartedIdentityManager.activate({ ...identityB })
    const restartedCtx = { store, metaDb: null, swarm: null, personal: null }
    let reloadRestartedProfile = async () => {}
    manager = createPersonalManager({
      ctx: restartedCtx,
      identityManager: restartedIdentityManager,
      onActiveStoreChanged: () => reloadRestartedProfile(),
    })
    const restartedController = createConsumerModerationProfileController({
      repository: profileRepository(restartedCtx),
    })
    await restartedController.ready
    let restartedFeeds = []
    const restartedTransaction = createConsumerModerationProfileTransaction({
      profileController: restartedController,
      applyState: async state => {
        restartedFeeds = state.profile.enabled === false
          ? []
          : state.profile.curatorSubscriptions.slice()
      },
    })
    reloadRestartedProfile = () => restartedTransaction.reload()

    await manager.init()
    await manager.provisionSecret({ publicKey: identityB.publicKey, secret: secretB })
    t.alike(
      restartedController.getEffectiveCuratorSubscriptions(),
      [feedB],
      'restart loads the exact persisted B profile',
    )
    t.alike(restartedFeeds, [feedB], 'restart subscribes only to B with no stale A transport state')
  } finally {
    await manager?.close().catch(() => {})
    await store?.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('personal encryption provisioning requires a platform secret and never returns it', async t => {
  const suppliedSecret = '91'.repeat(32)
  const calls = []
  const ctx = {
    personalManager: {
      async provisionSecret(request) {
        calls.push(request)
        if (!request.secret) return { success: false, error: 'personal-secret-required' }
        return {
          success: true,
          secret: suppliedSecret,
          bootstrapKey: '92'.repeat(32),
          encrypted: true,
        }
      },
    },
  }
  const api = createPersonalApi({ ctx })

  const missing = await api.provisionPersonalEncryption({ deviceLocal: true })
  t.absent(missing.success)
  t.is(missing.error, 'personal-secret-required')

  const result = await api.provisionPersonalEncryption({
    deviceLocal: true,
    secret: suppliedSecret,
  })
  t.ok(result.success)
  t.absent(result.secret, 'backend response cannot export the encryption secret')
  t.is(result.bootstrapKey, '92'.repeat(32))
  t.is(calls[1].secret, suppliedSecret)
})
