import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'

const PRIMARY_KEY_HEX = '9f9fdd7164b58f0dfba96f340f0ce07ecf4df1cc7d97da95d2f88bf7b0f15fd2'
const WRITER_KEY_NAME = 'test-writer'

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

async function createCase(label) {
  const dir = mkTmpDir(`peartube-autobase-key-${label}-`)
  const store = new Corestore(dir, { primaryKey: b4a.from(PRIMARY_KEY_HEX, 'hex'), unsafe: true })

  try {
    await store.ready()
    const keyPair = await store.createKeyPair(WRITER_KEY_NAME)
    const base = new Autobase(store, null, { keyPair })
    await base.ready()

    return {
      dir,
      store,
      base,
      keyPair,
      baseKeyHex: toHex(base.key),
      writerKeyHex: toHex(keyPair.publicKey)
    }
  } catch (err) {
    await closeSilently(store, 'close')
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

async function cleanupCase(testCase) {
  await closeSilently(testCase?.base, 'close')
  await closeSilently(testCase?.store, 'close')
  if (testCase?.dir) {
    fs.rmSync(testCase.dir, { recursive: true, force: true })
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

async function main() {
  let failures = 0
  let caseA = null
  let caseB = null

  try {
    console.log('[INFO] Validating Autobase key assumption with fixed Corestore primaryKey')
    console.log(`[INFO] primaryKey=${PRIMARY_KEY_HEX}`)

    caseA = await createCase('a')
    console.log(`[INFO] instanceA writerPublicKey=${caseA.writerKeyHex}`)
    console.log(`[INFO] instanceA baseKey=${caseA.baseKeyHex}`)
    if (!report(b4a.equals(caseA.base.key, caseA.keyPair.publicKey), 'Instance A: base.key equals keyPair.publicKey')) failures++

    caseB = await createCase('b')
    console.log(`[INFO] instanceB writerPublicKey=${caseB.writerKeyHex}`)
    console.log(`[INFO] instanceB baseKey=${caseB.baseKeyHex}`)
    if (!report(b4a.equals(caseB.base.key, caseB.keyPair.publicKey), 'Instance B: base.key equals keyPair.publicKey')) failures++

    if (!report(b4a.equals(caseA.keyPair.publicKey, caseB.keyPair.publicKey), 'Determinism: createKeyPair(name) matches across stores with same primaryKey')) failures++
    if (!report(b4a.equals(caseA.base.key, caseB.base.key), 'Determinism: Autobase base.key matches across stores with same primaryKey and keyPair name')) failures++

    if (failures > 0) {
      console.error(`[FAIL] Validation failed (${failures} assertion${failures === 1 ? '' : 's'})`)
      process.exit(1)
    }

    console.log('[PASS] Validation succeeded: bootstrapKey=null Autobase key equals keyPair.publicKey and is deterministic across instances')
    process.exit(0)
  } catch (err) {
    console.error('[FAIL] Spike execution error:', err)
    process.exit(1)
  } finally {
    await cleanupCase(caseA)
    await cleanupCase(caseB)
  }
}

main()
