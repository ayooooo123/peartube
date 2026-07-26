import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

const moduleUrl = path.resolve(import.meta.dirname, '../lib/moderation-profile.ts')

async function loadModule() {
  assert.ok(fs.existsSync(moduleUrl), 'the backend-authoritative moderation profile action module must exist')
  const result = await build({
    entryPoints: [moduleUrl],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  const compiled = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`)
}

const defaultSigner = '01'.repeat(32)
const customSigner = '02'.repeat(32)

function setting(state) {
  return {
    settings: [{
      key: 'consumer-moderation-profile:v1',
      value: JSON.stringify(state),
    }],
  }
}

test('Developer Settings profile actions inspect and replace the backend profile without network-policy writes', async () => {
  const profile = await loadModule()
  let active = {
    profile: {
      version: 7,
      enabled: true,
      curatorSubscriptions: [defaultSigner],
      scope: 'local-device',
      protocolAuthority: false,
    },
    customized: false,
  }
  const calls = []
  const rpc = {
    async getPersonalSettings() {
      calls.push({ method: 'getPersonalSettings' })
      return setting(active)
    },
    async setPersonalSetting(request) {
      calls.push({ method: 'setPersonalSetting', request })
      const input = JSON.parse(request.value)
      active = input.operation === 'restore-defaults'
        ? {
            profile: {
              ...active.profile,
              version: 8,
              enabled: true,
              curatorSubscriptions: [defaultSigner],
            },
            customized: false,
          }
        : { profile: input.profile, customized: true }
      return { success: true }
    },
    async setNetworkPolicy() {
      assert.fail('profile replacement must not call generic network policy RPC')
    },
  }
  const actions = profile.createModerationProfileActions(rpc)

  assert.deepEqual(await actions.load(), active)
  const replaced = await actions.replace(active, [customSigner])
  assert.equal(replaced.customized, true)
  assert.deepEqual(replaced.profile.curatorSubscriptions, [customSigner])
  assert.equal(replaced.profile.enabled, true)
  assert.deepEqual(await actions.replace(replaced, []), {
    profile: { ...replaced.profile, curatorSubscriptions: [] },
    customized: true,
  })
  const restored = await actions.restoreDefaults()
  assert.equal(restored.profile.version, 8)
  assert.equal(restored.customized, false)
  assert.ok(calls.some(call => call.method === 'setPersonalSetting'))
  assert.ok(calls.every(call => call.method !== 'setNetworkPolicy'))
})

test('profile parsing bounds and canonicalizes inspectable full signer identifiers', async () => {
  const profile = await loadModule()
  const many = Array.from({ length: 257 }, (_, index) =>
    index.toString(16).padStart(64, '0'))
  assert.throws(() => profile.normalizeModerationProfileState({
    profile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: many,
    },
    customized: true,
  }), /bounded|subscriptions/i)
  assert.throws(() => profile.normalizeModerationProfileState({
    profile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: ['not-a-signer'],
    },
    customized: true,
  }), /signer|subscription/i)
  const normalized = profile.normalizeModerationProfileState({
    profile: {
      version: 1,
      enabled: true,
      curatorSubscriptions: [customSigner.toUpperCase(), customSigner],
    },
    customized: true,
  })
  assert.deepEqual(normalized.profile.curatorSubscriptions, [customSigner])
})
