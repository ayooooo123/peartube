import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import {
  identityKeyFileExists,
  readIdentityKeyFile,
  writeIdentityKeyFile,
} from '../src/identity-key-file.js'

test('readIdentityKeyFile falls back to legacy db/identity-key path before corestore exists', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-legacy-'))
  const legacyDir = path.join(tmpRoot, 'db')
  const payload = {
    version: 1,
    primaryKey: '11'.repeat(32),
    identityPublicKey: '22'.repeat(32),
    createdAt: Date.now(),
  }

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'identity-key'), JSON.stringify(payload))

  t.is(await identityKeyFileExists(tmpRoot), true)

  const result = await readIdentityKeyFile(tmpRoot)
  t.alike(result, {
    primaryKey: Buffer.from(payload.primaryKey, 'hex'),
    identityPublicKey: Buffer.from(payload.identityPublicKey, 'hex'),
  })

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('readIdentityKeyFile ignores legacy db/identity-key after canonical corestore exists', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-corestore-'))
  const legacyDir = path.join(tmpRoot, 'db')
  const payload = {
    version: 1,
    primaryKey: '55'.repeat(32),
    identityPublicKey: '66'.repeat(32),
    createdAt: Date.now(),
  }

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'identity-key'), JSON.stringify(payload))
  fs.writeFileSync(path.join(tmpRoot, 'CORESTORE'), '')

  t.is(await identityKeyFileExists(tmpRoot), false)
  t.is(await readIdentityKeyFile(tmpRoot), null)

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('writeIdentityKeyFile persists the canonical top-level identity-key path', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-write-'))
  const primaryKey = Buffer.from('33'.repeat(32), 'hex')
  const identityPublicKey = Buffer.from('44'.repeat(32), 'hex')

  await writeIdentityKeyFile(tmpRoot, { primaryKey, identityPublicKey })

  t.ok(fs.existsSync(path.join(tmpRoot, 'identity-key')))
  t.absent(fs.existsSync(path.join(tmpRoot, 'db', 'identity-key')))

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
