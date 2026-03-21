import test from 'brittle'

import * as host from '../src/index.js'
import { createProcessTransport, parseSidecarArgv, runHostSidecar } from '../src/sidecar-entry.js'

test('host root export stays web-safe and excludes sidecar helpers', async (t) => {
  t.absent(host.startHost)
  t.absent(host.runHostSidecar)
  t.absent(host.parseSidecarArgv)
})

test('sidecar entry exports sidecar helpers', async (t) => {
  t.is(typeof runHostSidecar, 'function')
  t.is(typeof parseSidecarArgv, 'function')
  t.is(typeof createProcessTransport, 'function')
})

test('parseSidecarArgv preserves entrypoint and trailing args', async (t) => {
  t.alike(parseSidecarArgv(['/tmp/peartube-host', 'custom-entry', '--inspect']), {
    storagePath: '/tmp/peartube-host',
    entrypoint: 'custom-entry',
    args: ['--inspect']
  })
})

test('createProcessTransport exposes a chainable stream-like API', async (t) => {
  const transport = createProcessTransport()
  const noop = () => {}

  t.is(transport.on('data', noop), transport)
  t.is(transport.once('drain', noop), transport)
  t.is(transport.off('data', noop), transport)
  t.is(transport.removeListener('drain', noop), transport)
  t.is(typeof transport.write, 'function')
  t.is(typeof transport.destroy, 'function')
})
