/* eslint-disable no-empty */
import test from 'brittle'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'

import {
  derivePrimaryKey,
  deriveIdentity,
  generateMnemonic
} from '../src/peartube-identity.js'

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function toHex(buf) {
  return b4a.toString(buf, 'hex')
}

async function closeSilently(resource, method) {
  if (!resource || typeof resource[method] !== 'function') return
  try {
    await resource[method]()
  } catch {}
}

async function deriveChannelKeyForMnemonic({ mnemonic, label }) {
  const dir = mkTmpDir(`peartube-identity-recovery-${label}-`)
  let store = null
  let base = null

  try {
    const primaryKey = await derivePrimaryKey(mnemonic)
    const { identityPublicKey } = await deriveIdentity(mnemonic)
    const identityPublicKeyHex = toHex(identityPublicKey)
    const writerKeyName = `peartube-channel-writer:${identityPublicKeyHex}`

    store = new Corestore(dir, { primaryKey, unsafe: true })
    await store.ready()

    const writerKeyPair = await store.createKeyPair(writerKeyName)
    base = new Autobase(store, null, { keyPair: writerKeyPair })
    await base.ready()

    return {
      channelKeyHex: toHex(base.key),
      writerPublicKeyHex: toHex(writerKeyPair.publicKey),
      writerKeyName
    }
  } finally {
    await closeSilently(base, 'close')
    await closeSilently(store, 'close')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function report(ok, message) {
  if (ok) {
    console.log(`[PASS] ${message}`)
  } else {
    console.error(`[FAIL] ${message}`)
  }
  return ok
}

async function testCreateIdentityDeterministicFromMnemonic() {
  const mnemonic = generateMnemonic()

  const runA = await deriveChannelKeyForMnemonic({ mnemonic, label: 'create-a' })
  const runB = await deriveChannelKeyForMnemonic({ mnemonic, label: 'create-b' })

  assert.equal(runA.writerKeyName, runB.writerKeyName)
  assert.equal(runA.writerPublicKeyHex, runB.writerPublicKeyHex)
  assert.equal(runA.channelKeyHex, runB.channelKeyHex)

  return { mnemonic, createFlowChannelKeyHex: runA.channelKeyHex }
}

async function testRecoverIdentityRederivesSameChannelKey(createFlowChannelKeyHex, mnemonic) {
  const recoveryRun = await deriveChannelKeyForMnemonic({ mnemonic, label: 'recover' })
  assert.equal(recoveryRun.channelKeyHex, createFlowChannelKeyHex)

  const identitySourcePath = new URL('../src/identity.js', import.meta.url).pathname
  const source = fs.readFileSync(identitySourcePath, 'utf8')
  const recoverStart = source.indexOf('async recoverIdentity')
  const bootstrapStart = source.indexOf('async bootstrapDevice')
  assert.ok(recoverStart !== -1 && bootstrapStart !== -1 && bootstrapStart > recoverStart)
  const recoverFnBody = source.slice(recoverStart, bootstrapStart)

  assert.ok(recoverFnBody.includes('loadChannel'), 'recoverIdentity must call loadChannel')
  assert.ok(!recoverFnBody.includes('createChannel'), 'recoverIdentity must not call createChannel')
}

async function testInvalidMnemonicThrows() {
  const invalidMnemonic = 'not a valid mnemonic phrase with broken checksum'
  await assert.rejects(() => deriveIdentity(invalidMnemonic))
}

function testKeychainImportIsBundleVisible() {
  const identitySourcePath = new URL('../src/peartube-identity.js', import.meta.url).pathname
  const source = fs.readFileSync(identitySourcePath, 'utf8')

  assert.match(
    source,
    /import\s+KeyChainImport\s+from\s+['"]keet-identity-key\/lib\/keychain\.js['"]/,
    'mobile bare-pack must see the keet-identity-key keychain dependency as a static import'
  )
  assert.doesNotMatch(
    source,
    /import\s*\(\s*['"]keet-identity-key\/lib\/keychain\.js['"]\s*\)/,
    'do not use a dynamic keychain import; libqjs mobile bundles can omit it'
  )
}

async function main() {
  let failures = 0

  try {
    console.log('[INFO] Running identity recovery determinism tests')

    try {
      const { mnemonic, createFlowChannelKeyHex } = await testCreateIdentityDeterministicFromMnemonic()
      report(true, 'createIdentity() flow derives deterministic channel key from mnemonic')

      try {
        await testRecoverIdentityRederivesSameChannelKey(createFlowChannelKeyHex, mnemonic)
        report(true, 'recoverIdentity() flow re-derives same channel key and uses loadChannel()')
      } catch (err) {
        failures++
        report(false, `recoverIdentity() flow re-derives same channel key and uses loadChannel(): ${err.message}`)
      }
    } catch (err) {
      failures++
      report(false, `createIdentity() flow derives deterministic channel key from mnemonic: ${err.message}`)
    }

    try {
      await testInvalidMnemonicThrows()
      report(true, 'invalid mnemonic throws an error')
    } catch (err) {
      failures++
      report(false, `invalid mnemonic throws an error: ${err.message}`)
    }

    try {
      testKeychainImportIsBundleVisible()
      report(true, 'keet-identity-key keychain import is visible to the mobile bundler')
    } catch (err) {
      failures++
      report(false, `keet-identity-key keychain import is visible to the mobile bundler: ${err.message}`)
    }

    return failures
  } catch (err) {
    console.error('[FAIL] identity-recovery.test unexpected error:', err)
    throw err
  }
}

// Every file in this directory shares one brittle process. Reporting through
// brittle rather than an exit code is what keeps this file from deciding the
// run is over: a bare process.exit(0) here used to end the suite at the
// letter i, silently skipping every test file that sorts after it.
test('identity recovery, mnemonic validation, and keychain bundling', async t => {
  t.is(await main(), 0, 'every identity recovery assertion holds')
})
