import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { relocateLegacyBlindPeerDir, relocateLegacyLogsDir } from '../src/storage-layout.js'

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

test('relocateLegacyBlindPeerDir moves top-level blind-peer into corestore namespace', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  const legacyBlindPeerDir = path.join(tmpRoot, 'blind-peer')

  fs.mkdirSync(legacyBlindPeerDir, { recursive: true })
  fs.writeFileSync(path.join(legacyBlindPeerDir, 'state'), 'blind-peer-state')

  const relocatedDir = relocateLegacyBlindPeerDir(tmpRoot, fs, path)

  t.is(relocatedDir, path.join(tmpRoot, 'corestore', 'blind-peer'))
  t.absent(fs.existsSync(legacyBlindPeerDir))
  t.is(fs.readFileSync(path.join(relocatedDir, 'state'), 'utf8'), 'blind-peer-state')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('relocateLegacyBlindPeerDir archives top-level blind-peer when db copy exists', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-storage-layout-'))
  const legacyBlindPeerDir = path.join(tmpRoot, 'blind-peer')
  const dbBlindPeerDir = path.join(tmpRoot, 'db', 'blind-peer')

  fs.mkdirSync(legacyBlindPeerDir, { recursive: true })
  fs.mkdirSync(dbBlindPeerDir, { recursive: true })
  fs.writeFileSync(path.join(legacyBlindPeerDir, 'state'), 'legacy-blind-peer-state')
  fs.writeFileSync(path.join(dbBlindPeerDir, 'state'), 'db-blind-peer-state')

  const relocatedDir = relocateLegacyBlindPeerDir(tmpRoot, fs, path)

  t.ok(relocatedDir)
  t.ok(relocatedDir.startsWith(path.join(tmpRoot, 'db', 'blind-peer-legacy-')))
  t.absent(fs.existsSync(legacyBlindPeerDir))
  t.is(fs.readFileSync(path.join(relocatedDir, 'state'), 'utf8'), 'legacy-blind-peer-state')
  t.is(fs.readFileSync(path.join(dbBlindPeerDir, 'state'), 'utf8'), 'db-blind-peer-state')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
})
