import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import {
  identityKeyFileExists,
  readIdentityKeyFile,
  writeIdentityKeyFile,
} from '../src/identity-key-file.js'

test('readIdentityKeyFile reads the canonical top-level identity-key path', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-canonical-'))
  const payload = {
    version: 1,
    primaryKey: '11'.repeat(32),
    identityPublicKey: '22'.repeat(32),
    createdAt: Date.now(),
  }

  t.is(await identityKeyFileExists(tmpRoot), false)
  t.is(await readIdentityKeyFile(tmpRoot), null)

  fs.writeFileSync(path.join(tmpRoot, 'identity-key'), JSON.stringify(payload))

  t.is(await identityKeyFileExists(tmpRoot), true)

  const result = await readIdentityKeyFile(tmpRoot)
  t.alike(result, {
    primaryKey: Buffer.from(payload.primaryKey, 'hex'),
    identityPublicKey: Buffer.from(payload.identityPublicKey, 'hex'),
  })

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('writeIdentityKeyFile persists the canonical top-level identity-key path', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-write-'))
  const primaryKey = Buffer.from('33'.repeat(32), 'hex')
  const identityPublicKey = Buffer.from('44'.repeat(32), 'hex')

  await writeIdentityKeyFile(tmpRoot, { primaryKey, identityPublicKey })

  t.ok(fs.existsSync(path.join(tmpRoot, 'identity-key')))
  t.alike(await readIdentityKeyFile(tmpRoot), { primaryKey, identityPublicKey })

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
