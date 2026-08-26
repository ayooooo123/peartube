import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const appRoot = path.resolve(import.meta.dirname, '..')

async function loadModule(entry, outputName) {
  const result = await build({
    entryPoints: [path.join(appRoot, entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['@napi-rs/keyring', 'expo-secure-store', 'expo-file-system'],
    write: false,
  })
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-custody-'))
  const output = path.join(tempDirectory, outputName)
  fs.writeFileSync(output, result.outputFiles[0].text)
  const loaded = await import(`${pathToFileURL(output).href}?instance=${Date.now()}-${Math.random()}`)
  fs.rmSync(tempDirectory, { recursive: true, force: true })
  return loaded
}

test('desktop personal secret survives an app restart through the Bun keyring adapter', async () => {
  const { createBunPersonalSecretVault, BUN_PERSONAL_SECRET_SERVICE } =
    await loadModule('src/bun/personal-secret-vault.ts', 'personal-secret-vault.cjs')
  const keyring = new Map()
  class AsyncEntry {
    constructor(service, account) {
      assert.equal(service, BUN_PERSONAL_SECRET_SERVICE)
      this.key = `${service}:${account}`
    }
    async getPassword() { return keyring.get(this.key) ?? null }
    async setPassword(value) { keyring.set(this.key, value) }
    async deletePassword() { keyring.delete(this.key) }
  }
  const options = { keyringLoader: async () => ({ AsyncEntry }) }

  const firstProcess = createBunPersonalSecretVault(options)
  await firstProcess.set('peartube.personal.enc.device-local', JSON.stringify({
    secret: '12'.repeat(32),
    bootstrapKey: '34'.repeat(32),
  }))

  const restartedProcess = createBunPersonalSecretVault(options)
  assert.equal(
    await restartedProcess.get('peartube.personal.enc.device-local'),
    JSON.stringify({ secret: '12'.repeat(32), bootstrapKey: '34'.repeat(32) }),
  )
})

test('platform generates and durably stores the personal secret before provisioning it', async () => {
  const vaultValues = new Map()
  let writes = 0
  globalThis.window = {
    bridge: {
      async personalSecureGet(key) { return vaultValues.get(key) ?? null },
      async personalSecureSet(key, value) {
        writes++
        vaultValues.set(key, value)
      },
      async personalSecureDelete(key) { vaultValues.delete(key) },
    },
  }
  const calls = []
  const rpc = {
    async provisionPersonalEncryption(request) {
      calls.push(request)
      return { success: true, encrypted: true, bootstrapKey: '56'.repeat(32) }
    },
  }

  const firstLaunch = await loadModule('lib/personal-encryption.ts', 'first-launch.cjs')
  await firstLaunch.ensurePersonalEncryption(rpc)
  assert.equal(calls.length, 1)
  assert.match(calls[0].secret, /^[0-9a-f]{64}$/)
  assert.equal(writes, 2, 'secret is persisted before provisioning and bootstrap metadata after')

  const restartedLaunch = await loadModule('lib/personal-encryption.ts', 'restarted-launch.cjs')
  await restartedLaunch.ensurePersonalEncryption(rpc)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].secret, calls[0].secret, 'restart reads the keyring instead of supplying a key manually')
  delete globalThis.window
})

test('a failed durable desktop write never provisions or marks a secret provisioned', async () => {
  globalThis.window = {
    bridge: {
      async personalSecureGet() { return null },
      async personalSecureSet() { throw new Error('keyring write failed') },
      async personalSecureDelete() {},
    },
  }
  let calls = 0
  const rpc = {
    async provisionPersonalEncryption() {
      calls++
      return { success: true, encrypted: true }
    },
  }
  const module = await loadModule('lib/personal-encryption.ts', 'failed-write.cjs')
  await module.ensurePersonalEncryption(rpc, 'ab'.repeat(32))
  await module.ensurePersonalEncryption(rpc, 'ab'.repeat(32))
  assert.equal(calls, 0)
  delete globalThis.window
})
