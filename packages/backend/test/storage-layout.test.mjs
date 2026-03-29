import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { relocateLegacyLogsDir } from '../src/storage-layout.js'

test('relocateLegacyLogsDir archives conflicting top-level logs into db', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  const legacyLogsDir = path.join(tmpRoot, 'logs')
  const dbLogsDir = path.join(tmpRoot, 'db', 'logs')

  fs.mkdirSync(legacyLogsDir, { recursive: true })
  fs.mkdirSync(dbLogsDir, { recursive: true })
  fs.writeFileSync(path.join(legacyLogsDir, 'peartube.log'), 'legacy-log')

  const relocatedDir = relocateLegacyLogsDir(tmpRoot, fs, path)

  t.ok(relocatedDir)
  t.absent(fs.existsSync(legacyLogsDir))
  t.ok(relocatedDir.startsWith(path.join(tmpRoot, 'db', 'logs-legacy-')))
  t.is(fs.readFileSync(path.join(relocatedDir, 'peartube.log'), 'utf8'), 'legacy-log')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('relocateLegacyLogsDir is a no-op without db/logs', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  const legacyLogsDir = path.join(tmpRoot, 'logs')

  fs.mkdirSync(legacyLogsDir, { recursive: true })

  const relocatedDir = relocateLegacyLogsDir(tmpRoot, fs, path)

  t.is(relocatedDir, null)
  t.ok(fs.existsSync(legacyLogsDir))

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
