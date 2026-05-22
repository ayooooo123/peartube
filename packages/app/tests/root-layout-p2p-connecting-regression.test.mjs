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

test('desktop web startup timeout exits the P2P connecting screen when initPlatformRPC hangs', () => {
  const source = readAppFile('app/_layout.web.tsx')
  const timeoutIndex = source.indexOf("console.warn('[App] Pear desktop backend startup timeout after'")
  assert.notEqual(timeoutIndex, -1, 'desktop web backend startup timeout handler should exist')

  const timeoutBlock = source.slice(timeoutIndex, source.indexOf('}, BACKEND_STARTUP_TIMEOUT_MS)', timeoutIndex))
  assert.match(timeoutBlock, /setReady\(true\)/, 'timeout should allow the desktop shell to render')
  assert.match(timeoutBlock, /setLoading\(false\)/, 'timeout must clear loading so Home stops showing Starting P2P network')
})

test('desktop web init resolution marks ready if the ready event was missed', () => {
  const source = readAppFile('app/_layout.web.tsx')

  const initIndex = source.indexOf('await platformRPC.initPlatformRPC()')
  const fallbackIndex = source.indexOf("await markPearBackendReady('initPlatformRPC', readyPort)")

  assert.notEqual(initIndex, -1, 'desktop web initPlatformRPC call should exist')
  assert.notEqual(fallbackIndex, -1, 'desktop web init should mark ready if init resolves before eventReady')
  assert.ok(initIndex < fallbackIndex, 'fallback ready mark should happen after initPlatformRPC resolves')
})
