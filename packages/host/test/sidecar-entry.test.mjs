import test from 'brittle'

import * as host from '../src/index.js'
import { parseSidecarArgv, runHostSidecar } from '../src/sidecar-entry.js'

test('host root export stays web-safe and excludes sidecar helpers', async (t) => {
  t.absent(host.startHost)
  t.absent(host.runHostSidecar)
  t.absent(host.parseSidecarArgv)
})

test('sidecar entry exports sidecar helpers', async (t) => {
  t.is(typeof runHostSidecar, 'function')
  t.is(typeof parseSidecarArgv, 'function')
})

test('parseSidecarArgv preserves entrypoint and trailing args', async (t) => {
  t.alike(parseSidecarArgv(['/tmp/peartube-host', 'custom-entry', '--inspect']), {
    storagePath: '/tmp/peartube-host',
    entrypoint: 'custom-entry',
    args: ['--inspect']
  })
})
