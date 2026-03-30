import test from 'node:test'
import assert from 'node:assert/strict'

import { attachLazyCastHandlers, CAST_HANDLER_NAMES } from './lazy-cast-handlers.mjs'

test('lazy cast handlers attach the real handlers on first use and reuse them afterwards', async () => {
  const backend = {}
  const calls = []
  let attachCount = 0

  attachLazyCastHandlers(backend, async () => {
    attachCount++
    backend.castAvailable = async (request) => {
      calls.push(request)
      return { available: request.available }
    }
  })

  const first = await backend.castAvailable({ available: true })
  const second = await backend.castAvailable({ available: false })

  assert.equal(attachCount, 1)
  assert.deepEqual(calls, [{ available: true }, { available: false }])
  assert.deepEqual(first, { available: true })
  assert.deepEqual(second, { available: false })
})

test('lazy cast handlers register the full cast surface expected by shared HRPC routing', () => {
  assert.deepEqual(CAST_HANDLER_NAMES, [
    'castAvailable',
    'castStartDiscovery',
    'castStopDiscovery',
    'castGetDevices',
    'castAddManualDevice',
    'castConnect',
    'castDisconnect',
    'castPause',
    'castResume',
    'castStop',
    'castSeek',
    'castSetVolume',
    'castGetState',
    'castIsConnected',
    'castPlay',
  ])
})
