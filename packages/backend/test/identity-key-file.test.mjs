import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import {
  identityKeyFileExists,
  migrateLegacyIdentityKeyFile,
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

test('migrateLegacyIdentityKeyFile preserves plaintext source until privileged import acknowledges continuity', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-migrate-pending-'))
  const legacyDir = path.join(tmpRoot, 'db')
  const legacyPath = path.join(legacyDir, 'identity-key')
  const payload = {
    version: 1,
    primaryKey: '77'.repeat(32),
    identityPublicKey: '88'.repeat(32),
    createdAt: Date.now(),
  }

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify(payload), { mode: 0o600 })

  const result = await migrateLegacyIdentityKeyFile(tmpRoot, {
    async importLegacyRoot(record) {
      t.alike(record.primaryKey, Buffer.from(payload.primaryKey, 'hex'))
      t.alike(record.identityPublicKey, Buffer.from(payload.identityPublicKey, 'hex'))
      return { acknowledged: false, identityPublicKey: record.identityPublicKey }
    },
  })

  t.is(result.status, 'pending-ack')
  t.ok(fs.existsSync(legacyPath), 'legacy source is preserved until durable acknowledgement')
  t.is((fs.statSync(legacyPath).mode & 0o777), 0o600, 'legacy mode remains 0600 while preserved')
  t.absent(fs.existsSync(path.join(tmpRoot, '.identity-key-migration-ack')))

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('migrateLegacyIdentityKeyFile writes durable ack before deleting legacy plaintext and resumes idempotently', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-migrate-ack-'))
  const legacyDir = path.join(tmpRoot, 'db')
  const legacyPath = path.join(legacyDir, 'identity-key')
  const ackPath = path.join(tmpRoot, '.identity-key-migration-ack')
  const payload = {
    version: 1,
    primaryKey: '99'.repeat(32),
    identityPublicKey: 'aa'.repeat(32),
    createdAt: Date.now(),
  }

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify(payload), { mode: 0o600 })

  const result = await migrateLegacyIdentityKeyFile(tmpRoot, {
    async importLegacyRoot(record) {
      return { acknowledged: true, identityPublicKey: record.identityPublicKey, ackId: 'vault-import-1' }
    },
  })

  t.is(result.status, 'migrated')
  t.ok(fs.existsSync(ackPath), 'durable acknowledgement is written')
  t.absent(fs.existsSync(legacyPath), 'legacy plaintext is deleted after ack')

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify(payload), { mode: 0o600 })
  const resumed = await migrateLegacyIdentityKeyFile(tmpRoot, {
    async importLegacyRoot() {
      throw new Error('import must not repeat after durable ack')
    },
  })

  t.is(resumed.status, 'deleted-after-ack')
  t.absent(fs.existsSync(legacyPath), 'restart after ack completes deletion idempotently')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('migrateLegacyIdentityKeyFile rejects continuity mismatch and keeps legacy source', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-identity-key-migrate-mismatch-'))
  const legacyDir = path.join(tmpRoot, 'db')
  const legacyPath = path.join(legacyDir, 'identity-key')
  const payload = {
    version: 1,
    primaryKey: 'bb'.repeat(32),
    identityPublicKey: 'cc'.repeat(32),
    createdAt: Date.now(),
  }

  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify(payload), { mode: 0o600 })

  const result = await migrateLegacyIdentityKeyFile(tmpRoot, {
    async importLegacyRoot() {
      return { acknowledged: true, identityPublicKey: Buffer.from('dd'.repeat(32), 'hex') }
    },
  })

  t.is(result.status, 'continuity-mismatch')
  t.ok(fs.existsSync(legacyPath))
  t.absent(fs.existsSync(path.join(tmpRoot, '.identity-key-migration-ack')))

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
