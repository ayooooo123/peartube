import test from 'brittle'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childCase = process.env.PEARTUBE_COMPAT_CHILD_CASE
const cases = {
  traversal: 'compatibility IDs cannot delete a sibling temporary directory',
  denied: 'forbidden compatibility playback launches no transcoder',
  offset: 'nonfinite compatibility offsets launch no transcoder',
  shutdown: 'console shutdown drains transcoders and releases compatibility timers',
}

function fixtureService() {
  return {
    runtime: { ctx: { metaDb: {} } },
    async requestLocalFileAcquisition() { throw new Error('unexpected acquisition') },
    async listAcquisitions() { return [] },
    async getVerifiedMediaCatalog() { return { items: [] } },
  }
}

function installResourceTracking() {
  const spawn = childProcess.spawn
  const setInterval = globalThis.setInterval
  const clearInterval = globalThis.clearInterval
  const children = []
  const timers = new Set()
  childProcess.spawn = (...args) => {
    const child = spawn(...args)
    children.push(child)
    return child
  }
  globalThis.setInterval = (...args) => {
    const handle = setInterval(...args)
    timers.add(handle)
    return handle
  }
  globalThis.clearInterval = handle => {
    timers.delete(handle)
    return clearInterval(handle)
  }
  syncBuiltinESMExports()
  return {
    children,
    timers,
    stopTrackingNewTimers() { globalThis.setInterval = setInterval },
    async restore() {
      childProcess.spawn = spawn
      globalThis.setInterval = setInterval
      globalThis.clearInterval = clearInterval
      syncBuiltinESMExports()
      for (const handle of timers) clearInterval(handle)
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) })
        child.kill('SIGKILL')
        await exited
      }
    },
  }
}

function createTranscoderFixture(sandbox) {
  const binary = join(sandbox, 'ffmpeg-fixture.cjs')
  writeFileSync(binary, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const playlist = process.argv.at(-1)',
    'fs.mkdirSync(path.dirname(playlist), { recursive: true })',
    "fs.writeFileSync(playlist, '#EXTM3U\\n#EXTINF:1,\\nseg0.ts\\n')",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'), { mode: 0o755 })
  return binary
}

async function checkCase(mode, archive, tracking, temporaryRoot, sentinel) {
  const publication = mode === 'traversal' ? 'a/../../' : 'publication'
  const query = mode === 'offset' ? '?t=Infinity' : ''
  const url = `http://127.0.0.1:${archive.server.address().port}/play/compat/${encodeURIComponent(publication)}/victim/index.m3u8${query}`
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  await response.text()
  if (mode === 'denied' || mode === 'offset') {
    assert.equal(response.status, mode === 'denied' ? 404 : 400)
    assert.equal(tracking.children.length, 0, 'rejected playback must not create an OS process')
    return
  }
  assert.equal(response.status, 200)
  if (mode === 'traversal') {
    assert.ok(existsSync(sentinel), 'the sibling directory and its sentinel must survive decoded IDs')
    return
  }
  await archive.close()
  assert.equal(tracking.timers.size, 0, 'all console-owned intervals must be released')
  assert.ok(tracking.children.every(child => child.exitCode !== null || child.signalCode !== null), 'close must await actual child exit, not merely signal delivery')
  assert.deepEqual(readdirSync(temporaryRoot), [], 'shutdown removes all temporary output it owns')
}

async function exercise(mode) {
  assert.ok(Object.hasOwn(cases, mode))
  const sandbox = mkdtempSync(join(tmpdir(), 'peartube-compat-regression-'))
  const temporaryRoot = join(sandbox, 'tmp')
  const sentinel = join(sandbox, '-victim-0', 'sentinel')
  mkdirSync(temporaryRoot)
  mkdirSync(dirname(sentinel))
  writeFileSync(sentinel, 'owned test sentinel')
  process.env.TMPDIR = temporaryRoot
  process.env.PEARTUBE_FFMPEG_PATH = createTranscoderFixture(sandbox)
  const tracking = installResourceTracking()
  let archive
  try {
    const { createArchiveConsole } = await import('../src/archive-console.js')
    archive = await createArchiveConsole({ service: fixtureService(), host: '127.0.0.1', port: 0, allowsPlaybackRequest: () => mode !== 'denied' })
    tracking.stopTrackingNewTimers()
    await archive.start()
    await checkCase(mode, archive, tracking, temporaryRoot, sentinel)
  } finally {
    if (archive) await archive.close()
    await tracking.restore()
    rmSync(sandbox, { recursive: true, force: true })
  }
}

if (childCase) {
  await exercise(childCase)
} else {
  for (const [mode, name] of Object.entries(cases)) {
    test(name, t => {
      const result = childProcess.spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, PEARTUBE_COMPAT_CHILD_CASE: mode },
        encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
      })
      t.is(result.status, 0, result.stderr || result.stdout || result.error?.message || name)
    })
  }
}
