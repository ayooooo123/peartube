import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('native startup timeout exits the connecting screen and marks loading false in degraded mode', () => {
  const source = readAppFile('app/_layout.tsx')
  const timeoutIndex = source.indexOf("console.warn('[App] Backend startup timeout after'")
  assert.notEqual(timeoutIndex, -1, 'native backend startup timeout handler should exist')

  const timeoutBlock = source.slice(timeoutIndex, source.indexOf('}, BACKEND_STARTUP_TIMEOUT_MS)', timeoutIndex))
  assert.match(timeoutBlock, /setReady\(true\)/, 'timeout should allow the app shell to render')
  assert.match(timeoutBlock, /setLoading\(false\)/, 'timeout must clear loading so screens stop showing Connecting to P2P network')
})

test('native init failure exits the connecting screen even when backend startup throws', () => {
  const source = readAppFile('app/_layout.tsx')
  const catchIndex = source.indexOf("console.error('[App] Failed to initialize platform RPC:'")
  assert.notEqual(catchIndex, -1, 'native init failure catch should exist')

  const catchBlock = source.slice(catchIndex, source.indexOf('    }', source.indexOf('setLoading(false)', catchIndex)))
  assert.match(catchBlock, /setReady\(true\)/, 'init failure should allow the app shell to render')
  assert.match(catchBlock, /setLoading\(false\)/, 'init failure must clear loading so screens stop showing Connecting to P2P network')
})

test('native backend error event cannot cancel degraded startup fallback while leaving loading true', () => {
  const source = readAppFile('app/_layout.tsx')
  const errorIndex = source.indexOf('platformRPC.events.onError')
  assert.notEqual(errorIndex, -1, 'native backend error event handler should exist')

  const errorBlock = source.slice(errorIndex, source.indexOf('      platformRPC.events.onVideoStats', errorIndex))
  assert.doesNotMatch(errorBlock, /clearTimeout\(startupTimerRef\.current\)/, 'backend errors before ready must not cancel the timeout fallback unless they also clear loading')
  assert.match(errorBlock, /setReady\(true\)/, 'backend errors should release the app shell')
  assert.match(errorBlock, /setLoading\(false\)/, 'backend errors must clear the startup spinner')
})

test('backend ready clears loading before initial data loading begins', () => {
  const source = readAppFile('app/_layout.tsx')
  const markerIndex = source.indexOf('const markBackendReady = useCallback')
  assert.notEqual(markerIndex, -1, 'markBackendReady should exist')

  const readyBlock = source.slice(markerIndex, source.indexOf('  // Subscribe to video load events', markerIndex))
  const setLoadingIndex = readyBlock.indexOf('setLoading(false)')
  const loadInitialDataIndex = readyBlock.indexOf('loadInitialData().catch')
  assert.notEqual(setLoadingIndex, -1, 'backend ready should clear loading')
  assert.notEqual(loadInitialDataIndex, -1, 'backend ready should load initial data')
  assert.ok(setLoadingIndex < loadInitialDataIndex, 'loading should clear before initial data fetches can hang or retry')
})

test('initial data loading does not re-enable the startup loading spinner after backend ready', () => {
  const source = readAppFile('app/_layout.tsx')
  const markerIndex = source.indexOf('const loadInitialData = useCallback')
  assert.notEqual(markerIndex, -1, 'loadInitialData should exist')

  const loadBlock = source.slice(markerIndex, source.indexOf('  const markBackendReady = useCallback', markerIndex))
  assert.doesNotMatch(loadBlock, /setLoading\(true\)/, 'initial data should run in the background without restoring the startup spinner')
})

test('desktop web startup timeout stays unavailable and offers an honest retry', () => {
  const source = readAppFile('app/_layout.web.tsx')
  assert.match(source, /const DESKTOP_BACKEND_STARTUP_TIMEOUT_MS = 30000/)

  const timeoutIndex = source.indexOf("console.warn('[App] Desktop backend startup timeout after'")
  assert.notEqual(timeoutIndex, -1, 'desktop backend startup timeout handler should exist')

  const timeoutBlock = source.slice(timeoutIndex, source.indexOf('}, DESKTOP_BACKEND_STARTUP_TIMEOUT_MS)', timeoutIndex))
  assert.match(timeoutBlock, /setBackendError\(/, 'desktop timeout should surface a backend status message')
  assert.match(timeoutBlock, /setReady\(false\)/, 'desktop timeout must not expose an unprovisioned PersonalStore')
  assert.match(timeoutBlock, /setLoading\(false\)/, 'desktop timeout must clear loading so Home stops showing Starting P2P network')
})

test('desktop web init failure stays unavailable instead of silently entering the shell', () => {
  const source = readAppFile('app/_layout.web.tsx')
  const catchIndex = source.indexOf("console.error('[App] Failed to initialize Pear backend:'")
  assert.notEqual(catchIndex, -1, 'desktop init failure catch should exist')

  const catchBlock = source.slice(catchIndex, source.indexOf('  }, [markDesktopBackendReady])', catchIndex))
  assert.match(catchBlock, /setBackendError\(/, 'desktop init failure should expose the failure')
  assert.match(catchBlock, /setReady\(false\)/, 'desktop init failure must not expose an unprovisioned PersonalStore')
  assert.match(catchBlock, /setLoading\(false\)/, 'desktop init failure must clear loading so Home stops showing Starting P2P network')
})

test('desktop web backend readiness provisions encryption before exposing initial data', () => {
  const source = readAppFile('app/_layout.web.tsx')
  const readyIndex = source.indexOf('const markDesktopBackendReady = useCallback')
  assert.notEqual(readyIndex, -1, 'desktop readiness handler should exist')

  const readyBlock = source.slice(readyIndex, source.indexOf('  const initPearBackend', readyIndex))
  const provisionIndex = readyBlock.indexOf('ensureDesktopBackendReadiness')
  const setReadyIndex = readyBlock.indexOf('setReady(true)')
  const setLoadingIndex = readyBlock.indexOf('setLoading(false)')
  const loadInitialDataIndex = readyBlock.indexOf('loadInitialData().catch')
  assert.notEqual(provisionIndex, -1, 'desktop readiness should await PersonalStore encryption')
  assert.notEqual(setReadyIndex, -1, 'desktop readiness should expose the shell only after provisioning')
  assert.notEqual(setLoadingIndex, -1, 'desktop backend ready should clear loading')
  assert.notEqual(loadInitialDataIndex, -1, 'desktop backend ready should load initial data in the background')
  assert.ok(provisionIndex < setReadyIndex, 'PersonalStore encryption must precede shell readiness')
  assert.ok(setLoadingIndex < loadInitialDataIndex, 'desktop loading should clear before initial data fetches can hang or retry')
})
