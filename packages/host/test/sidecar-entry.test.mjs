import test from 'brittle'
import { PassThrough } from 'node:stream'
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
  const parsed = parseSidecarArgv(['/tmp/peartube-host', 'custom-entry', '--inspect'])
  t.is(parsed.storagePath, '/tmp/peartube-host')
  t.is(parsed.entrypoint, 'custom-entry')
  t.alike(parsed.args, ['--inspect'])
  t.absent(parsed.network)
  t.absent(parsed.swarmOptions)
})

test('parseSidecarArgv decodes network launch options from trailing JSON arg', async (t) => {
  const launchOptions = {
    network: { relayPeers: ['a'.repeat(64)] },
    swarmOptions: { knownPeers: ['b'.repeat(64)] }
  }

  const parsed = parseSidecarArgv([
    '/tmp/peartube-host',
    'mobile-entry',
    JSON.stringify(launchOptions)
  ])
  t.is(parsed.storagePath, '/tmp/peartube-host')
  t.is(parsed.entrypoint, 'mobile-entry')
  t.alike(parsed.args, [])
  t.alike(parsed.network, launchOptions.network)
  t.alike(parsed.swarmOptions, launchOptions.swarmOptions)
})

test('process transport releases streams and emits close once after input ends', async (t) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createProcessTransport({ input, output })
  t.teardown(() => transport.destroy())
  const noop = () => {}
  t.is(transport.on('data', noop), transport)
  t.is(transport.once('drain', noop), transport)
  t.is(transport.off('data', noop), transport)
  t.is(transport.removeListener('drain', noop), transport)
  const received = []
  const written = []
  let closes = 0
  transport.on('data', bytes => received.push(bytes.toString()))
  transport.on('close', () => { closes++ })
  output.on('data', bytes => written.push(bytes.toString()))
  input.write('request')
  transport.write('response')
  t.alike(received, ['request'])
  t.alike(written, ['response'])
  const ended = new Promise(resolve => transport.once('close', resolve))
  input.end()
  await ended
  input.emit('data', Buffer.from('late'))
  t.alike(received, ['request'], 'closed transports cannot deliver more requests')
  transport.destroy()
  transport.destroy()
  t.is(closes, 1, 'EOF and repeated destroy share one close transition')
  t.is(input.listenerCount('data'), 0)
  t.is(output.listenerCount('drain'), 0)
})

test('throwing EOF listeners still close the transport and detach both streams', (t) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createProcessTransport({ input, output })
  t.teardown(() => transport.destroy())
  const failure = new Error('EOF listener failed')
  let closes = 0
  transport.on('end', () => { throw failure })
  transport.on('close', () => { closes++ })
  t.exception(() => input.emit('end'), failure, 'listener failures remain observable')
  transport.destroy()
  input.emit('close')
  output.emit('close')
  t.is(closes, 1, 'EOF cleanup and later close signals share one transition')
  for (const event of ['data', 'end', 'close', 'error']) {
    t.is(input.listenerCount(event), 0, `input ${event} listener is detached`)
  }
  for (const event of ['drain', 'close', 'error']) {
    t.is(output.listenerCount(event), 0, `output ${event} listener is detached`)
  }
})
