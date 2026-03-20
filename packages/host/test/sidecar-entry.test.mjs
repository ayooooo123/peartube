import test from 'brittle'

import { parseSidecarArgv, runHostSidecar } from '../src/index.js'

test('host package exports sidecar helpers', async (t) => {
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
