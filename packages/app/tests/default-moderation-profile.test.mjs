import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../node_modules/typescript/lib/typescript.js'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/default-moderation-profile.ts'), 'utf8')
const developerSettingsSource = fs.readFileSync(path.resolve(import.meta.dirname, '../app/developer-settings.tsx'), 'utf8')
const personalEncryptionSource = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/personal-encryption.ts'), 'utf8')
const layoutSource = fs.readFileSync(path.resolve(import.meta.dirname, '../app/_layout.tsx'), 'utf8')

async function loadProfileModule() {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
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

test('the app exports no second moderation-profile persistence facade', async () => {
  const profile = await loadProfileModule()
  assert.equal(typeof profile.createDefaultModerationProfileStore, 'undefined')
  assert.equal(typeof profile.DEFAULT_MODERATION_PROFILE_STORAGE_KEY, 'undefined')
})

test('Developer Settings reads and mutates the backend PersonalStore profile through existing RPC state', () => {
  assert.match(developerSettingsSource, /getPersonalSettings/)
  assert.match(developerSettingsSource, /setPersonalSetting/)
  assert.match(developerSettingsSource, /CONSUMER_MODERATION_PROFILE_SETTING_KEY/)
  assert.doesNotMatch(developerSettingsSource, /secureGet|secureSet/)
  assert.doesNotMatch(developerSettingsSource, /createDefaultModerationProfileStore/)
})

test('desktop startup provisions a device-local encrypted PersonalStore before identity or pairing', () => {
  assert.match(personalEncryptionSource, /deviceLocal:\s*true/)
  assert.match(personalEncryptionSource, /bootstrapKey/)
  assert.match(layoutSource, /await ensurePersonalEncryption\(platformRPC\.rpc\)/)
})
