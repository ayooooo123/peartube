import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import Corestore from 'corestore'
import b4a from 'b4a'

import { PersonalStore } from '../src/personal/personal-store.js'
import { generateSecret, deriveKeys, makeBlindEncryption } from '../src/personal/personal-crypto.js'

function tmpdir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-personal-enc-')) }

function diskContains (dir, needle) {
  let found = false
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      const s = fs.statSync(p)
      if (s.isDirectory()) walk(p)
      else if (b4a.toString(fs.readFileSync(p)).includes(needle)) found = true
    }
  }
  walk(dir)
  return found
}

test('encrypted personal store: derived keys are deterministic from the secret', (t) => {
  const secret = generateSecret()
  const a = deriveKeys(secret)
  const b = deriveKeys(b4a.toString(secret, 'hex'))
  t.is(b4a.toString(a.dek, 'hex'), b4a.toString(b.dek, 'hex'), 'dek deterministic')
  t.is(b4a.toString(a.wrapKey, 'hex'), b4a.toString(b.wrapKey, 'hex'), 'wrapKey deterministic')
  t.not(b4a.toString(a.dek, 'hex'), b4a.toString(a.wrapKey, 'hex'), 'dek and wrapKey differ')
})

test('encrypted personal store: cores are encrypted on disk; the data key is blind-wrapped under the secret', async (t) => {
  const dir = tmpdir()
  const ns = 'peartube-personal:enc'
  const secret = generateSecret()
  const PLAINTEXT = 'super-secret-subscription-name'

  const store = new Corestore(dir)
  await store.ready()

  const a = new PersonalStore(store, { namespace: ns, secret })
  await a.ready()
  t.ok(a.encrypted, 'store reports encrypted')
  t.ok(a.writable, 'creator writable')
  await a.subscribe('a'.repeat(64), { name: PLAINTEXT })
  await a.close()

  // Reopen WITH the secret -> readable.
  const withKey = new PersonalStore(store, { namespace: ns, secret })
  await withKey.ready()
  const subs = await withKey.listSubscriptions()
  t.is(subs[0].name, PLAINTEXT, 'reopen with secret reads the data')
  await withKey.close()

  // Raw disk scan: neither the plaintext nor the data-encryption key may appear
  // on disk in the clear. (Autobase additionally fails closed when reopened
  // without the secret — it cannot unwrap the blind-encrypted key.)
  t.absent(diskContains(dir, PLAINTEXT), 'plaintext never written to disk')
  t.absent(diskContains(dir, b4a.toString(deriveKeys(secret).dek, 'hex')), 'raw data-encryption key never on disk')

  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('blind wrapping: the data key can only be unwrapped with the correct keychain secret', (t) => {
  const secret = generateSecret()
  const { dek, wrapKey } = deriveKeys(secret)
  const blind = makeBlindEncryption(wrapKey)

  const wrapped = blind.encrypt(dek) // { type, value }
  t.ok(wrapped.value.length > dek.length, 'wrapped key is larger (nonce + MAC) and not the raw key')
  t.absent(b4a.equals(wrapped.value.subarray(0, dek.length), dek), 'wrapped bytes are not the plaintext key')

  const { value: unwrapped } = blind.decrypt({ type: wrapped.type, value: wrapped.value })
  t.ok(b4a.equals(unwrapped, dek), 'correct secret unwraps the data key')

  // A different secret derives a different wrapKey and must fail to unwrap.
  const { wrapKey: wrongWrap } = deriveKeys(generateSecret())
  const wrongBlind = makeBlindEncryption(wrongWrap)
  t.exception(() => wrongBlind.decrypt({ type: wrapped.type, value: wrapped.value }), 'wrong secret cannot unwrap the data key')
})

test('encrypted personal store: two devices sharing the secret sync', async (t) => {
  const dirA = tmpdir()
  const dirB = tmpdir()
  const secret = generateSecret()

  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  const a = new PersonalStore(storeA, { secret })
  await a.ready()
  const b = new PersonalStore(storeB, { key: a.key, secret })
  await b.ready()

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  await a.addWriter(b.localKeyHex, { deviceName: 'B' })
  t.ok(await b.waitForWritable(20000), 'B writable after addWriter')

  await a.setSetting('theme', 'dark')
  const start = Date.now()
  let synced = false
  while (Date.now() - start < 20000) {
    await b.update()
    if ((await b.getSetting('theme')) === 'dark') { synced = true; break }
    await new Promise((r) => setTimeout(r, 200))
  }
  t.ok(synced, 'encrypted data replicated to the second device')

  await a.close()
  await b.close()
  s1.destroy()
  s2.destroy()
  await storeA.close()
  await storeB.close()
  fs.rmSync(dirA, { recursive: true, force: true })
  fs.rmSync(dirB, { recursive: true, force: true })
})
