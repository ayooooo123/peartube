import test from 'brittle'

import {
  CONSUMER_MODERATION_PROFILE_SETTING_KEY,
  createConsumerModerationPolicy,
  createConsumerModerationProfileController,
  DEFAULT_CONSUMER_MODERATION_PROFILE,
} from '../src/moderation/profile.js'
import { createPersonalApi } from '../src/api/personal.js'

function memoryRepository(initial = null) {
  let value = initial == null ? null : structuredClone(initial)
  return {
    async load() { return value == null ? null : structuredClone(value) },
    async save(next) { value = structuredClone(next) },
    snapshot() { return value == null ? null : structuredClone(value) },
  }
}

function bundle(version, feeds) {
  return {
    ...DEFAULT_CONSUMER_MODERATION_PROFILE,
    version,
    curatorSubscriptions: feeds,
  }
}

test('fresh backend initializes and persists the current bundled moderation profile', async (t) => {
  const repository = memoryRepository()
  const bundledProfile = bundle(4, ['curator-current'])
  const controller = createConsumerModerationProfileController({ repository, bundledProfile })

  const state = await controller.ready

  t.alike(state, { profile: bundledProfile, customized: false })
  t.alike(repository.snapshot(), { profile: bundledProfile, customized: false })
  t.alike(controller.getEffectiveCuratorSubscriptions(), ['curator-current'])
})

test('profile restart and bundle upgrade preserve user choices and adopt only uncustomized defaults', async (t) => {
  const repository = memoryRepository()
  const v1 = createConsumerModerationProfileController({
    repository,
    bundledProfile: bundle(1, ['curator-v1']),
  })
  await v1.ready

  const upgradedDefault = createConsumerModerationProfileController({
    repository,
    bundledProfile: bundle(2, ['curator-v2']),
  })
  t.alike(await upgradedDefault.ready, {
    profile: bundle(2, ['curator-v2']),
    customized: false,
  })

  await upgradedDefault.replace({
    ...bundle(2, ['my-curator']),
    enabled: true,
  })
  const customizedRestart = createConsumerModerationProfileController({
    repository,
    bundledProfile: bundle(3, ['curator-v3']),
  })
  t.alike(await customizedRestart.ready, {
    profile: bundle(2, ['my-curator']),
    customized: true,
  })

  await customizedRestart.disable()
  const disabledRestart = createConsumerModerationProfileController({
    repository,
    bundledProfile: bundle(4, ['curator-v4']),
  })
  t.alike(await disabledRestart.ready, {
    profile: { ...bundle(2, []), enabled: false },
    customized: true,
  }, 'disabled-empty is a durable user choice')
  t.alike(disabledRestart.getEffectiveCuratorSubscriptions(), [])

  t.alike(await disabledRestart.restoreDefaults(), {
    profile: bundle(4, ['curator-v4']),
    customized: false,
  }, 'restore explicitly selects the current bundle')
})

test('removing every curator subscription removes every feed effect without protocol authority', async (t) => {
  const repository = memoryRepository()
  const controller = createConsumerModerationProfileController({
    repository,
    bundledProfile: bundle(7, ['curator-a', 'curator-b']),
  })
  await controller.ready
  await controller.replace({
    ...bundle(7, []),
    enabled: true,
  })

  t.alike(controller.getEffectiveCuratorSubscriptions(), [])
  t.is(controller.isCuratorSubscribed('curator-a'), false)
  t.is((await controller.inspect()).profile.protocolAuthority, false)
})

test('production moderation policy applies records only from backend-profile subscriptions', async (t) => {
  const controller = createConsumerModerationProfileController({
    repository: memoryRepository(),
    bundledProfile: bundle(3, ['curator-a']),
  })
  await controller.ready
  const manager = {
    getRecords() {
      return [
        { sourceId: 'curator-a:page-1', targetType: 'work', targetId: 'blocked', action: 'hide' },
        { sourceId: 'curator-b:page-1', targetType: 'work', targetId: 'other', action: 'hide' },
      ]
    },
  }
  const policy = createConsumerModerationPolicy({ profileController: controller, moderationManager: manager })

  t.is(policy.evaluate({ entityRef: 'blocked' }).action, 'hidden')
  t.is(policy.evaluate({ entityRef: 'other' }).action, 'visible', 'an unsubscribed curator has no local effect')
  await controller.disable()
  t.is(policy.evaluate({ entityRef: 'blocked' }).action, 'visible', 'disabling the profile reveals retained network truth locally')
})

test('existing personal settings RPC reads and mutates the backend-authoritative profile', async (t) => {
  const controller = createConsumerModerationProfileController({
    repository: memoryRepository(),
    bundledProfile: bundle(5, ['curator-default']),
  })
  await controller.ready
  const operations = []
  const ctx = {
    personal: {
      writable: true,
      async getSettings() { return { unrelated: true } },
      async setSetting() { t.fail('profile RPC must not bypass the authoritative controller') },
    },
    consumerModerationProfile: controller,
    async setConsumerModerationProfile(input) {
      operations.push(input)
      if (input?.operation === 'restore-defaults') return controller.restoreDefaults()
      if (input?.profile?.enabled === false) return controller.disable()
      return controller.replace(input.profile)
    },
  }
  const api = createPersonalApi({ ctx })

  const initial = await api.getPersonalSettings()
  const profileSetting = initial.settings.find(setting => setting.key === CONSUMER_MODERATION_PROFILE_SETTING_KEY)
  t.ok(profileSetting)
  t.is(JSON.parse(profileSetting.value).profile.version, 5)

  await api.setPersonalSetting({
    key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
    value: JSON.stringify({ profile: bundle(5, ['mine']) }),
  })
  t.alike(controller.getEffectiveCuratorSubscriptions(), ['mine'])
  await api.setPersonalSetting({
    key: CONSUMER_MODERATION_PROFILE_SETTING_KEY,
    value: JSON.stringify({ operation: 'restore-defaults' }),
  })
  t.alike(controller.getEffectiveCuratorSubscriptions(), ['curator-default'])
  t.is(operations.length, 2)
})
