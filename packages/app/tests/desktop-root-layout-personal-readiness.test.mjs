import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadReadinessModule(name) {
  const result = await build({
    entryPoints: [path.join(appRoot, 'lib/desktop-backend-readiness.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['expo-secure-store', 'expo-file-system'],
    write: false,
  })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-desktop-readiness-'))
  const output = path.join(directory, `${name}.cjs`)
  fs.writeFileSync(output, result.outputFiles[0].text)
  const loaded = await import(`${pathToFileURL(output).href}?instance=${Date.now()}-${Math.random()}`)
  fs.rmSync(directory, { recursive: true, force: true })
  return loaded
}

test('desktop root readiness provisions once, reuses the keyring on restart, and exposes no secret', async () => {
  const values = new Map()
  let profileReady = false
  globalThis.window = {
    bridge: {
      async personalSecureGet(key) { return values.get(key) ?? null },
      async personalSecureSet(key, value) { values.set(key, value) },
      async personalSecureDelete(key) { values.delete(key) },
    },
  }
  const provisionRequests = []
  const rpc = {
    async provisionPersonalEncryption(request) {
      provisionRequests.push(request)
      profileReady = true
      return { success: true, encrypted: true, bootstrapKey: '56'.repeat(32) }
    },
  }

  const first = await loadReadinessModule('first')
  let firstReady = false
  const firstResult = await first.ensureDesktopBackendReadiness(rpc, () => {
    assert.equal(profileReady, true, 'default backend profile is ready before the shell')
    firstReady = true
  })
  assert.equal(firstReady, true)
  assert.equal(firstResult, undefined, 'the readiness surface returns no encryption material')
  assert.equal(provisionRequests.length, 1)
  assert.match(provisionRequests[0].secret, /^[0-9a-f]{64}$/)

  profileReady = false
  const restarted = await loadReadinessModule('restart')
  let restartReady = false
  await restarted.ensureDesktopBackendReadiness(rpc, () => {
    assert.equal(profileReady, true)
    restartReady = true
  })
  assert.equal(restartReady, true)
  assert.equal(provisionRequests.length, 2)
  assert.equal(provisionRequests[1].secret, provisionRequests[0].secret)
  assert.equal(typeof globalThis.window.bridge.personalSecureExport, 'undefined')
  delete globalThis.window
})

test('desktop root readiness rejects a failed provision and permits an honest retry', async () => {
  const values = new Map()
  globalThis.window = {
    bridge: {
      async personalSecureGet(key) { return values.get(key) ?? null },
      async personalSecureSet(key, value) { values.set(key, value) },
      async personalSecureDelete(key) { values.delete(key) },
    },
  }
  let succeed = false
  let readyCalls = 0
  const rpc = {
    async provisionPersonalEncryption() {
      return succeed
        ? { success: true, encrypted: true, bootstrapKey: '78'.repeat(32) }
        : { success: false, error: 'keyring-unavailable' }
    },
  }
  const module = await loadReadinessModule('retry')
  await assert.rejects(
    module.ensureDesktopBackendReadiness(rpc, () => { readyCalls++ }),
    /keyring-unavailable/,
  )
  assert.equal(readyCalls, 0)
  succeed = true
  await module.ensureDesktopBackendReadiness(rpc, () => { readyCalls++ })
  assert.equal(readyCalls, 1)
  delete globalThis.window
})
