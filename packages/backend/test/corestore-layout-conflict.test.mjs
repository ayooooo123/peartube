import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { relocateLegacyCorestoreDir } from '../src/storage-layout.js'

test('relocateLegacyCorestoreDir archives stale top-level corestore when db/corestore exists', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-corestore-layout-'))
  const legacyCorestoreDir = path.join(tmpRoot, 'corestore')
  const dbCorestoreDir = path.join(tmpRoot, 'db', 'corestore')

  fs.mkdirSync(legacyCorestoreDir, { recursive: true })
  fs.mkdirSync(dbCorestoreDir, { recursive: true })
  fs.writeFileSync(path.join(legacyCorestoreDir, 'legacy-block'), 'legacy-corestore')
  fs.writeFileSync(path.join(dbCorestoreDir, 'current-block'), 'current-corestore')

  const relocatedDir = relocateLegacyCorestoreDir(tmpRoot, fs, path)

  t.ok(relocatedDir)
  t.ok(relocatedDir.startsWith(path.join(tmpRoot, 'db', 'corestore-legacy-')))
  t.absent(fs.existsSync(legacyCorestoreDir))
  t.is(fs.readFileSync(path.join(relocatedDir, 'legacy-block'), 'utf8'), 'legacy-corestore')
  t.is(fs.readFileSync(path.join(dbCorestoreDir, 'current-block'), 'utf8'), 'current-corestore')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('relocateLegacyCorestoreDir is a no-op when only top-level corestore exists', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-corestore-layout-'))
  const legacyCorestoreDir = path.join(tmpRoot, 'corestore')

  fs.mkdirSync(legacyCorestoreDir, { recursive: true })
  fs.writeFileSync(path.join(legacyCorestoreDir, 'state'), 'only-corestore')

  const relocatedDir = relocateLegacyCorestoreDir(tmpRoot, fs, path)

  t.is(relocatedDir, null)
  t.ok(fs.existsSync(legacyCorestoreDir))
  t.is(fs.readFileSync(path.join(legacyCorestoreDir, 'state'), 'utf8'), 'only-corestore')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
