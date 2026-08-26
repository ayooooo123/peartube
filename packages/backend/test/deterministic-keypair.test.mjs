/**
 * Deterministic Keypair Test Suite
 *
 * Proves that the mnemonic → primaryKey → Corestore → createKeyPair → Autobase key
 * chain is fully deterministic and reproducible across instances.
 */

import brittle from 'brittle'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'
import { derivePrimaryKey } from '../src/peartube-identity.js'

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    passed++
  } catch (err) {
    console.error(`FAIL: ${name}`)
    console.error(`  ${err.message}`)
    failed++
  }
}

function mkTmpDir (prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function closeSilently (resource) {
  if (!resource || typeof resource.close !== 'function') return
  try { await resource.close() } catch {}
}

// ---------------------------------------------------------------------------
// Test 1: Same primaryKey → same createKeyPair output
// ---------------------------------------------------------------------------
await test('Same primaryKey + same name → identical createKeyPair output', async () => {
  const primaryKey = b4a.alloc(32, 0x01)
  const dirA = mkTmpDir('det-test1a-')
  const dirB = mkTmpDir('det-test1b-')
  const storeA = new Corestore(dirA, { primaryKey, unsafe: true })
  const storeB = new Corestore(dirB, { primaryKey, unsafe: true })

  try {
    await storeA.ready()
    await storeB.ready()

    const kpA = await storeA.createKeyPair('test-writer')
    const kpB = await storeB.createKeyPair('test-writer')

    assert(b4a.equals(kpA.publicKey, kpB.publicKey), 'publicKeys must match')
    assert(b4a.equals(kpA.secretKey, kpB.secretKey), 'secretKeys must match')
  } finally {
    await closeSilently(storeA)
    await closeSilently(storeB)
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 2: Different primaryKey → different createKeyPair output
// ---------------------------------------------------------------------------
await test('Different primaryKey + same name → different createKeyPair output', async () => {
  const primaryKeyA = b4a.alloc(32, 0x01)
  const primaryKeyB = b4a.alloc(32, 0x02)
  const dirA = mkTmpDir('det-test2a-')
  const dirB = mkTmpDir('det-test2b-')
  const storeA = new Corestore(dirA, { primaryKey: primaryKeyA, unsafe: true })
  const storeB = new Corestore(dirB, { primaryKey: primaryKeyB, unsafe: true })

  try {
    await storeA.ready()
    await storeB.ready()

    const kpA = await storeA.createKeyPair('test-writer')
    const kpB = await storeB.createKeyPair('test-writer')

    assert(!b4a.equals(kpA.publicKey, kpB.publicKey), 'publicKeys must differ')
  } finally {
    await closeSilently(storeA)
    await closeSilently(storeB)
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 3: Autobase base.key is deterministic across instances
// ---------------------------------------------------------------------------
await test('Autobase base.key is deterministic from same primaryKey', async () => {
  const primaryKey = b4a.alloc(32, 0x01)
  const writerName = 'peartube-channel-writer:test'

  const dirA = mkTmpDir('det-test3a-')
  const dirB = mkTmpDir('det-test3b-')
  const storeA = new Corestore(dirA, { primaryKey, unsafe: true })
  const storeB = new Corestore(dirB, { primaryKey, unsafe: true })
  let baseA = null
  let baseB = null

  try {
    await storeA.ready()
    await storeB.ready()

    const kpA = await storeA.createKeyPair(writerName)
    baseA = new Autobase(storeA, null, { keyPair: kpA })
    await baseA.ready()

    const kpB = await storeB.createKeyPair(writerName)
    baseB = new Autobase(storeB, null, { keyPair: kpB })
    await baseB.ready()

    assert(b4a.equals(baseA.key, baseB.key),
      `base.key mismatch: ${b4a.toString(baseA.key, 'hex')} vs ${b4a.toString(baseB.key, 'hex')}`)
  } finally {
    await closeSilently(baseA)
    await closeSilently(baseB)
    await closeSilently(storeA)
    await closeSilently(storeB)
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Test 4: Full chain — mnemonic → derivePrimaryKey → Corestore → Autobase key
// ---------------------------------------------------------------------------
await test('Full mnemonic → channel key chain is deterministic end-to-end', async () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  const primaryKey = await derivePrimaryKey(mnemonic)
  assert(b4a.isBuffer(primaryKey), 'primaryKey must be a Buffer')
  assert.strictEqual(primaryKey.length, 32, 'primaryKey must be 32 bytes')

  // Verify derivePrimaryKey itself is deterministic
  const primaryKey2 = await derivePrimaryKey(mnemonic)
  assert(b4a.equals(primaryKey, primaryKey2), 'derivePrimaryKey must return same key for same mnemonic')

  const writerName = 'peartube-channel-writer:test'
  const dirA = mkTmpDir('det-test4a-')
  const dirB = mkTmpDir('det-test4b-')
  const storeA = new Corestore(dirA, { primaryKey, unsafe: true })
  const storeB = new Corestore(dirB, { primaryKey, unsafe: true })
  let baseA = null
  let baseB = null

  try {
    await storeA.ready()
    await storeB.ready()

    const kpA = await storeA.createKeyPair(writerName)
    baseA = new Autobase(storeA, null, { keyPair: kpA })
    await baseA.ready()
    const channelKeyA = b4a.from(baseA.key)

    const kpB = await storeB.createKeyPair(writerName)
    baseB = new Autobase(storeB, null, { keyPair: kpB })
    await baseB.ready()
    const channelKeyB = b4a.from(baseB.key)

    assert(b4a.equals(channelKeyA, channelKeyB),
      `channel keys mismatch: ${b4a.toString(channelKeyA, 'hex')} vs ${b4a.toString(channelKeyB, 'hex')}`)

    console.log(`  mnemonic → primaryKey: ${b4a.toString(primaryKey, 'hex').slice(0, 16)}...`)
    console.log(`  primaryKey → channelKey: ${b4a.toString(channelKeyA, 'hex').slice(0, 16)}...`)
  } finally {
    await closeSilently(baseA)
    await closeSilently(baseB)
    await closeSilently(storeA)
    await closeSilently(storeB)
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
// Reported through brittle rather than an exit code: this file shares its
// process with every other test file in the directory.
brittle(`deterministic keypair derivation`, t => {
  t.is(failed, 0, `${failed} of ${passed + failed} assertions failed`)
})
