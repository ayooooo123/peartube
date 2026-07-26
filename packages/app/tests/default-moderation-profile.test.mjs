import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../node_modules/typescript/lib/typescript.js'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/default-moderation-profile.ts'), 'utf8')

async function loadProfileModule() {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

function memoryStorage() {
  const values = new Map()
  return {
    async get(key) { return values.get(key) ?? null },
    async set(key, value) { values.set(key, value) },
  }
}

test('bundled moderation profile is a versioned local descriptor with replaceable curator subscriptions', async () => {
  const profile = await loadProfileModule()
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.version, 1)
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.enabled, true)
  assert.ok(Array.isArray(profile.DEFAULT_MODERATION_PROFILE.curatorSubscriptions))
  assert.ok(profile.DEFAULT_MODERATION_PROFILE.curatorSubscriptions.length > 0)
  assert.match(profile.DEFAULT_MODERATION_PROFILE.curatorSubscriptions[0], /^[a-f0-9]{64}$/)
  assert.match(profile.DEFAULT_MODERATION_PROFILE.scope, /local/i)
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.protocolAuthority, false)
})

test('custom profiles survive a bundled upgrade; disable, replace, inspect, and restore are explicit local operations', async () => {
  const profile = await loadProfileModule()
  const storage = memoryStorage()
  const v1 = { ...profile.DEFAULT_MODERATION_PROFILE, version: 1, curatorSubscriptions: ['curator-a'] }
  const v2 = { ...profile.DEFAULT_MODERATION_PROFILE, version: 2, curatorSubscriptions: ['curator-b'] }
  const store = profile.createDefaultModerationProfileStore({ storage, bundledProfile: v1 })

  assert.deepEqual(await store.inspect(), { profile: v1, customized: false })
  await store.replace({ ...v1, curatorSubscriptions: ['my-curator'] })
  assert.deepEqual(await store.inspect(), { profile: { ...v1, curatorSubscriptions: ['my-curator'] }, customized: true })
  const upgraded = profile.createDefaultModerationProfileStore({ storage, bundledProfile: v2 })
  assert.deepEqual((await upgraded.inspect()).profile.curatorSubscriptions, ['my-curator'])
  await upgraded.disable()
  assert.equal((await upgraded.inspect()).profile.enabled, false)
  await upgraded.restoreDefaults()
  assert.deepEqual(await upgraded.inspect(), { profile: v2, customized: false })
  await upgraded.replace({ ...v2, curatorSubscriptions: [] })
  assert.deepEqual((await upgraded.inspect()).profile.curatorSubscriptions, [])
})
