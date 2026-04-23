import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const storageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage.js'), 'utf8')

test('storage startup does not eagerly load HTTP before backend ready', () => {
  const initStorageModulesBody =
    storageSource.match(/async function initStorageModules\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(initStorageModulesBody, 'initStorageModules should exist')
  assert.doesNotMatch(initStorageModulesBody, /loadBareOrNodeHttpModule\(\)/)
})

test('blob server watchdog lazily loads HTTP only when cast probing is needed', () => {
  const watchdogBody =
    storageSource.match(/export function startBlobServerWatchdog\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(watchdogBody, 'startBlobServerWatchdog should exist')
  assert.match(storageSource, /async function ensureHttpModule\(\)/)
  assert.match(watchdogBody, /await ensureHttpModule\(\)/)
})

test('blob server startup does not await listen before storage init can finish', () => {
  const blobServerBody =
    storageSource.match(/try \{\n    const desiredPort = blobServerPortOverride \|\| 0;([\s\S]*?)\n  \} catch \(err\) \{/ )?.[1] ?? ''

  assert.ok(blobServerBody, 'blob server startup block should exist')
  assert.doesNotMatch(blobServerBody, /await blobServer\.listen\(\)/)
  assert.match(blobServerBody, /const blobServerListenPromise = blobServer\.listen\(\)/)
  assert.match(blobServerBody, /blobServerListenPromise\s*\.then\(/)
})
