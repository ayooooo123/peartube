import test from 'brittle'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { relocateLegacyCorestoreDir } from '../src/storage-layout.js'

test('relocateLegacyCorestoreDir archives stale top-level corestore when db/corestore exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.mkdirSync(path.join(dir, 'corestore'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'corestore', 'legacy-file'), 'legacy')
  fs.mkdirSync(path.join(dir, 'corestore', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'corestore', 'nested', 'legacy-nested'), 'legacy-nested')

  fs.mkdirSync(path.join(dir, 'db', 'corestore'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'db', 'corestore', 'current-file'), 'current')

  const archiveDir = relocateLegacyCorestoreDir(dir, fs, path)

  t.ok(archiveDir, 'returns archive directory')
  t.absent(fs.existsSync(path.join(dir, 'corestore')), 'removes stale top-level corestore')
  t.is(fs.readFileSync(path.join(dir, 'db', 'corestore', 'current-file'), 'utf8'), 'current', 'keeps canonical db/corestore data')
  t.is(fs.readFileSync(path.join(archiveDir, 'legacy-file'), 'utf8'), 'legacy', 'archives legacy file')
  t.is(fs.readFileSync(path.join(archiveDir, 'nested', 'legacy-nested'), 'utf8'), 'legacy-nested', 'archives nested legacy file')
})

test('relocateLegacyCorestoreDir no-ops unless both legacy and canonical dirs exist', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.mkdirSync(path.join(dir, 'corestore'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'corestore', 'only-copy'), 'legacy')

  const archiveDir = relocateLegacyCorestoreDir(dir, fs, path)

  t.absent(archiveDir, 'returns null')
  t.is(fs.readFileSync(path.join(dir, 'corestore', 'only-copy'), 'utf8'), 'legacy', 'keeps sole corestore copy in place')
})
