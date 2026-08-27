import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from '../node_modules/typescript/lib/typescript.js'

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/default-moderation-profile.ts'), 'utf8')
const developerSettingsSource = fs.readFileSync(path.resolve(import.meta.dirname, '../app/developer-settings.tsx'), 'utf8')
const profileActionsSource = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/moderation-profile.ts'), 'utf8')
const personalEncryptionSource = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/personal-encryption.ts'), 'utf8')
const layoutSource = fs.readFileSync(path.resolve(import.meta.dirname, '../app/_layout.tsx'), 'utf8')

async function loadProfileModule() {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

test('bundled moderation profile is local and carries no hardcoded curator authority', async () => {
  const profile = await loadProfileModule()
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.version, 1)
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.enabled, true)
  assert.ok(Array.isArray(profile.DEFAULT_MODERATION_PROFILE.curatorSubscriptions))
  assert.deepEqual(profile.DEFAULT_MODERATION_PROFILE.curatorSubscriptions, [])
  assert.match(profile.DEFAULT_MODERATION_PROFILE.scope, /local/i)
  assert.equal(profile.DEFAULT_MODERATION_PROFILE.protocolAuthority, false)
})

test('the app exports no second moderation-profile persistence facade', async () => {
  const profile = await loadProfileModule()
  assert.equal(typeof profile.createDefaultModerationProfileStore, 'undefined')
  assert.equal(typeof profile.DEFAULT_MODERATION_PROFILE_STORAGE_KEY, 'undefined')
})

test('Developer Settings reads and mutates the backend PersonalStore profile through existing RPC state', () => {
  const implementation = `${developerSettingsSource}\n${profileActionsSource}`
  assert.match(implementation, /getPersonalSettings/)
  assert.match(implementation, /setPersonalSetting/)
  assert.match(implementation, /CONSUMER_MODERATION_PROFILE_SETTING_KEY/)
  assert.match(developerSettingsSource, /customized/)
  assert.match(developerSettingsSource, /curatorSubscriptions[\s\S]*\.map/)
  assert.match(developerSettingsSource, /ModerationFeedEditor/)
  assert.doesNotMatch(implementation, /secureGet|secureSet/)
  assert.doesNotMatch(implementation, /createDefaultModerationProfileStore/)
  assert.doesNotMatch(implementation, /setNetworkPolicy/)
})

test('desktop startup provisions a device-local encrypted PersonalStore before identity or pairing', () => {
  assert.match(personalEncryptionSource, /deviceLocal:\s*true/)
  assert.match(personalEncryptionSource, /bootstrapKey/)
  assert.match(layoutSource, /await ensurePersonalEncryption\(platformRPC\.rpc\)/)
})
