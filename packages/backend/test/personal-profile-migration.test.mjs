import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'

import { PersonalStore } from '../src/personal/personal-store.js'
import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../src/moderation/profile.js'

const secret = '71'.repeat(32)

function state(version) {
  return {
    profile: {
      version,
      enabled: true,
      curatorSubscriptions: [String(version).repeat(64)],
      scope: 'local-device',
      protocolAuthority: false,
    },
    customized: true,
  }
}

async function loadMigrationModule(t) {
  const module = await import('../src/personal/profile-migration.js').catch(() => null)
  t.ok(module, 'journaled profile migration module exists')
  return module
}

function injectCrash(source, target, phase, migration, targetId) {
  if (phase === 'prepared') {
    const original = target.setSetting.bind(target)
    target.setSetting = async (key, value) => {
      if (key === CONSUMER_MODERATION_PROFILE_SETTING_KEY) {
        throw new Error('migration crash after prepared')
      }
      return original(key, value)
    }
    return () => { target.setSetting = original }
  }
  if (phase === 'copied') {
    const original = target.setSetting.bind(target)
    target.setSetting = async (key, value) => {
      if (key === migration.profileMigrationMarkerKey(targetId)) {
        throw new Error('migration crash after copied')
      }
      return original(key, value)
    }
    return () => { target.setSetting = original }
  }
  if (phase === 'committed') {
    const original = source.deleteSettingIfVersionAndDigest.bind(source)
    source.deleteSettingIfVersionAndDigest = async () => {
      throw new Error('migration crash after committed')
    }
    return () => { source.deleteSettingIfVersionAndDigest = original }
  }
  const original = source.deleteSetting.bind(source)
  source.deleteSetting = async key => {
    if (key === migration.profileMigrationJournalKey(targetId)) {
      throw new Error('migration crash after source-deleted')
    }
    return original(key)
  }
  return () => { source.deleteSetting = original }
}

test('journaled encrypted profile migration recovers every crash phase to the newest source', async t => {
  const migration = await loadMigrationModule(t)
  if (!migration) return

  for (const phase of ['prepared', 'copied', 'committed', 'source-deleted']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `peartube-profile-migration-${phase}-`))
    const sourceNamespace = `profile-migration-source-${phase}`
    const targetNamespace = `profile-migration-target-${phase}`
    let corestore
    let source
    let target
    try {
      corestore = new Corestore(directory)
      await corestore.ready()
      source = new PersonalStore(corestore, { namespace: sourceNamespace, secret })
      target = new PersonalStore(corestore, { namespace: targetNamespace, secret })
      await Promise.all([source.ready(), target.ready()])
      await source.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state(1))

      const targetId = `identity-${phase}`
      const restore = injectCrash(source, target, phase, migration, targetId)
      await t.exception(
        migration.migrateDeviceLocalProfile({
          source,
          target,
          sourceId: 'device-local',
          targetId,
        }),
        new RegExp(`migration crash after ${phase}`),
      )
      restore()
      await Promise.all([source.close(), target.close()])
      await corestore.close()

      corestore = new Corestore(directory)
      await corestore.ready()
      source = new PersonalStore(corestore, { namespace: sourceNamespace, secret })
      target = new PersonalStore(corestore, { namespace: targetNamespace, secret })
      await Promise.all([source.ready(), target.ready()])
      await source.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state(2))
      await migration.migrateDeviceLocalProfile({
        source,
        target,
        sourceId: 'device-local',
        targetId,
      })

      t.alike(
        await target.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY),
        state(2),
        `${phase}: target converges to exact newest source`,
      )
      t.absent(
        await source.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY),
        `${phase}: source is deleted only after newest value commits`,
      )
      const marker = await target.getSetting(migration.profileMigrationMarkerKey(targetId))
      t.is(marker.phase, 'committed')
      t.is(marker.sourceProfileVersion, 2)
      t.ok(marker.sourceVersion, `${phase}: marker binds the durable source revision`)
      t.is(marker.sourceDigest, migration.personalSettingDigest(state(2)))
    } finally {
      await source?.close().catch(() => {})
      await target?.close().catch(() => {})
      await corestore?.close().catch(() => {})
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('setting compare-and-delete preserves an identical newer rewrite', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-profile-migration-aba-'))
  const corestore = new Corestore(directory)
  let source
  try {
    await corestore.ready()
    source = new PersonalStore(corestore, {
      namespace: 'profile-migration-source-aba',
      secret,
    })
    await source.ready()
    await source.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state(1))
    const observed = await source.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    await source.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, state(1))
    const rewritten = await source.getSettingRecord(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    t.not(rewritten.revision, observed.revision, 'identical rewrites have distinct durable revisions')

    await source.deleteSettingIfVersionAndDigest(
      CONSUMER_MODERATION_PROFILE_SETTING_KEY,
      observed.revision,
      observed.digest,
    )

    t.alike(
      await source.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY),
      state(1),
      'stale CAS cannot delete the identical newer rewrite',
    )
  } finally {
    await source?.close().catch(() => {})
    await corestore.close().catch(() => {})
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
