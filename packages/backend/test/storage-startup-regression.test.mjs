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

test('storage creates an offline swarm fallback when Hyperswarm is unavailable', () => {
  assert.match(
    storageSource,
    /function createOfflineSwarm\(keyPair, reason = 'unavailable'\)/,
    'storage should define an offline swarm fallback'
  )
  assert.match(
    storageSource,
    /typeof Hyperswarm !== 'function'[\s\S]*?createOfflineSwarm\(keyPair, 'module-unavailable'\)/,
    'storage init should continue with offline swarm when Hyperswarm module did not load'
  )
  assert.match(
    storageSource,
    /Hyperswarm creation failed; continuing with offline P2P networking[\s\S]*?createOfflineSwarm\(keyPair, err\?\.message \|\| 'create-failed'\)/,
    'storage init should continue with offline swarm when Hyperswarm constructor throws'
  )
})

test('offline swarm fallback exposes the swarm methods orchestrator and managers require', () => {
  const fallbackBody =
    storageSource.match(/function createOfflineSwarm\(keyPair, reason = 'unavailable'\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(fallbackBody, 'createOfflineSwarm should exist')
  for (const method of ['on', 'off', 'emit', 'join']) {
    assert.match(fallbackBody, new RegExp(`${method}\\(`), `offline swarm should implement ${method}`)
  }
  for (const method of ['listen', 'suspend', 'resume', 'destroy']) {
    assert.match(fallbackBody, new RegExp(`${method}: async`), `offline swarm should implement ${method}`)
  }
  assert.match(fallbackBody, /connections: new Set\(\)/)
  assert.match(fallbackBody, /peers: new Set\(\)/)
  assert.match(fallbackBody, /keyPair,/)
})

test('offline swarm fallback skips peer pool discovery instead of joining noop topics at startup', () => {
  assert.match(
    storageSource,
    /if \(!swarm\._peartubeOffline\) \{[\s\S]*?swarm\.join\(PEARTUBE_NETWORK_TOPIC/,
    'real swarm should still join the peer pool topic'
  )
  assert.match(
    storageSource,
    /Skipping peer pool discovery; P2P networking is offline/,
    'offline swarm should skip peer pool discovery'
  )
})
