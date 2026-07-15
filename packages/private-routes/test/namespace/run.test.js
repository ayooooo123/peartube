import { EventEmitter } from 'node:events'

import test from 'brittle'
import b4a from 'b4a'

import {
  calibrateNegativeControl,
  assertRelayFailure,
  cleanupNamespaceResources,
  createNamespaceFixture,
  createTcpdumpCapture,
  finalizeNamespaceGate,
  formatNamespaceAuditSummary,
  tcpdumpLaunch
} from './run.js'
import { createNamespaceLayout } from './netns.js'

class FakeChild extends EventEmitter {
  constructor(options = {}) {
    super()
    this.stderr = new EventEmitter()
    this.kills = []
    this.closeOnKill = options.closeOnKill !== false
  }

  kill(signal) {
    this.kills.push(signal)
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', 0, null))
    return true
  }
}

test('tcpdump launch captures every IPv4 and IPv6 packet without an address or port prefilter', (t) => {
  t.alike(tcpdumpLaunch('/tmp/private-route.pcap'), {
    command: 'tcpdump',
    args: [
      '--immediate-mode',
      '-U',
      '-Q',
      'in',
      '-s',
      '0',
      '-w',
      '/tmp/private-route.pcap',
      '-i',
      'any',
      'ip or ip6'
    ]
  })
})

test('namespace success summary exposes only aggregate capture evidence', async (t) => {
  t.is(
    formatNamespaceAuditSummary({
      packetCount: 94,
      rolePacketCount: 92,
      observedEdges: [
        'destination->private-final',
        'private-final->destination',
        'private-final->private-middle'
      ],
      sentinels: { start: 0, stop: 93 }
    }),
    '{"event":"namespace-private-route-pass","packetCount":94,"rolePacketCount":92,"edgeCount":3}\n'
  )
  await t.exception.all(
    () => formatNamespaceAuditSummary({ packetCount: 1, rolePacketCount: 1, observedEdges: [] }),
    /invalid namespace audit summary/
  )
})

test('tcpdump capture requires listening output and a valid PCAP header before ready', async (t) => {
  const child = new FakeChild()
  const launches = []
  const capture = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess(command, args, options) {
      launches.push({ command, args, options })
      return child
    },
    async statFile() {
      return { size: 24 }
    },
    deadline: 100
  })
  const starting = capture.start()
  child.stderr.emit('data', 'tcpdump: listening on any, link-type LINUX_SLL2\n')
  t.is(await starting, true)
  t.alike(launches, [
    {
      command: 'tcpdump',
      args: [
        '--immediate-mode',
        '-U',
        '-Q',
        'in',
        '-s',
        '0',
        '-w',
        '/tmp/private-route.pcap',
        '-i',
        'any',
        'ip or ip6'
      ],
      options: { stdio: ['ignore', 'ignore', 'pipe'] }
    }
  ])
  t.is(await capture.stop(), true)
  t.alike(child.kills, ['SIGINT'])
  t.is(await capture.stop(), false)
})

test('tcpdump capture observes a packet record before shutdown', async (t) => {
  const child = new FakeChild()
  let stats = 0
  const capture = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess: () => child,
    async statFile() {
      stats++
      return { size: stats < 3 ? 24 : 96 }
    },
    deadline: 100
  })
  const starting = capture.start()
  child.stderr.emit('data', 'tcpdump: listening on any, link-type LINUX_SLL2\n')
  await starting
  t.is(await capture.observe(), true)
  t.ok(stats >= 3)
  t.is(await capture.stop(), true)
})

test('tcpdump capture fails bounded when no packet record becomes visible', async (t) => {
  const child = new FakeChild()
  const capture = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess: () => child,
    statFile: async () => ({ size: 24 }),
    deadline: 10
  })
  const starting = capture.start()
  child.stderr.emit('data', 'tcpdump: listening on any, link-type LINUX_SLL2\n')
  await starting
  await t.exception(capture.observe(), /packet deadline/)
  t.is(await capture.stop(), true)
})

test('tcpdump capture fails bounded on missing readiness or header', async (t) => {
  const silent = new FakeChild()
  const missingReady = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess: () => silent,
    statFile: async () => ({ size: 24 }),
    deadline: 10
  })
  await t.exception(missingReady.start(), /readiness deadline/)
  t.alike(silent.kills, ['SIGINT'])

  const noHeader = new FakeChild()
  const missingHeader = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess: () => noHeader,
    statFile: async () => ({ size: 0 }),
    deadline: 20
  })
  const starting = missingHeader.start()
  noHeader.stderr.emit('data', 'listening on any\n')
  await t.exception(starting, /PCAP header deadline/)
  t.alike(noHeader.kills, ['SIGINT'])
})

test('tcpdump capture rejects an early process exit', async (t) => {
  const child = new FakeChild({ closeOnKill: false })
  const capture = createTcpdumpCapture({
    path: '/tmp/private-route.pcap',
    spawnProcess: () => child,
    statFile: async () => ({ size: 24 }),
    deadline: 100
  })
  const starting = capture.start()
  child.emit('close', 1, null)
  await t.exception(starting, /exited before readiness/)
})

test('namespace fixture gives only source an inert audited decoy capability', (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const payload = b4a.alloc(32, 0xa7)
  const fixture = createNamespaceFixture(layout, payload, 1_000n)
  t.alike(fixture.projections.get('source').negativeControl, {
    bind: { host: '10.203.77.2', port: 48_150 },
    target: { host: '10.203.77.9', port: 48_200 },
    payload
  })
  for (const role of fixture.roles.slice(1)) {
    t.absent('negativeControl' in fixture.projections.get(role), role)
  }
})

test('negative-control calibration owns a separate capture and removes it only after audit', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const payload = b4a.alloc(32, 0xa7)
  const sequence = []
  const parsed = { records: [] }
  const listener = {
    ready: Promise.resolve(true),
    received: Promise.resolve({ bytes: 32, sourcePort: 48_150 }),
    exited: Promise.resolve({ code: 0, signal: null, stderr: '' }),
    close() {
      sequence.push('listener-close')
      return false
    }
  }
  t.is(
    await calibrateNegativeControl({
      layout,
      payload,
      capturePath: '/tmp/preflight.pcap',
      createCapture(options) {
        t.alike(options, { path: '/tmp/preflight.pcap' })
        return {
          async start() {
            sequence.push('capture-start')
          },
          async observe() {
            sequence.push('capture-observe')
          },
          async stop() {
            sequence.push('capture-stop')
          }
        }
      },
      createListener() {
        sequence.push('listener-create')
        return listener
      },
      async sendProbe(_layout, role, bindPort, target, sentPayload) {
        sequence.push('probe')
        t.is(role, 'source')
        t.is(bindPort, 48_150)
        t.alike(target, { host: '10.203.77.9', port: 48_200 })
        t.alike(sentPayload, payload)
      },
      async readCapture(path) {
        sequence.push('capture-read')
        t.is(path, '/tmp/preflight.pcap')
        return b4a.alloc(24)
      },
      parseCapture(buffer) {
        t.is(buffer.byteLength, 24)
        sequence.push('capture-parse')
        return parsed
      },
      auditCapture(capture, expected) {
        sequence.push('capture-audit')
        t.is(capture, parsed)
        t.alike(expected, {
          source: '10.203.77.2',
          sourcePort: 48_150,
          destination: '10.203.77.9',
          destinationPort: 48_200,
          sourceInterfaceIndex: 101,
          payload
        })
      },
      async removeCapture(path) {
        sequence.push('capture-remove')
        t.is(path, '/tmp/preflight.pcap')
      },
      interfaceIndexes: { source: 101 }
    }),
    true
  )
  t.alike(sequence, [
    'capture-start',
    'listener-create',
    'probe',
    'listener-close',
    'capture-observe',
    'capture-stop',
    'capture-read',
    'capture-parse',
    'capture-audit',
    'capture-remove'
  ])
})

test('namespace resource cleanup attempts every action and rejects every cleanup failure', async (t) => {
  const actions = []
  const coordinator = {
    async destroy() {
      actions.push('coordinator')
      throw new Error('coordinator cleanup failed')
    }
  }
  const capture = {
    async stop() {
      actions.push('capture')
      throw new Error('capture cleanup failed')
    }
  }
  const manager = {
    async cleanup() {
      actions.push('manager')
      throw new Error('manager cleanup failed')
    }
  }
  await t.exception(
    cleanupNamespaceResources({
      coordinator,
      capture,
      captureOpen: true,
      manager,
      managerOpen: true
    }),
    /namespace cleanup failed/
  )
  t.alike(actions, ['coordinator', 'capture', 'manager'])
})

test('namespace finalization preserves the PCAP and propagates cleanup failure', async (t) => {
  const actions = []
  await t.exception(
    finalizeNamespaceGate({
      capturePath: '/tmp/private-route.pcap',
      async cleanup() {
        actions.push('cleanup')
        throw new Error('namespace cleanup failed')
      },
      async removeCapture() {
        actions.push('remove')
      }
    }),
    /namespace cleanup failed/
  )
  t.alike(actions, ['cleanup'])
})

test('relay failure oracle requires post-liveness failure on the dead relay and both neighbors', async (t) => {
  const snapshots = [
    ['source', 'OPEN', 1],
    ['safety-guard', 'OPEN', 1],
    ['safety-final', 'OPEN', 1],
    ['private-entry', 'FAILED', 1],
    ['private-middle', 'FAILED', 0],
    ['private-final', 'FAILED', 1],
    ['destination', 'OPEN', 1]
  ].map(([role, state, openSockets]) => ({ role, state, resources: { openSockets } }))
  t.is(assertRelayFailure(snapshots), true)
  t.is(
    assertRelayFailure(
      snapshots.map((value) =>
        value.role.startsWith('private-')
          ? { ...value, state: 'CLOSED', resources: { openSockets: 0 } }
          : value
      )
    ),
    true,
    'an autonomously closed relay segment is stronger terminal evidence'
  )
  await t.exception.all(
    () =>
      assertRelayFailure(
        snapshots.map((value) =>
          value.role === 'private-final'
            ? { ...value, state: 'CLOSED', resources: { openSockets: 1 } }
            : value
        )
      ),
    /relay failure did not propagate/
  )
  await t.exception.all(
    () =>
      assertRelayFailure(
        snapshots.map((value) =>
          value.role === 'private-final' ? { ...value, state: 'OPEN' } : value
        )
      ),
    /relay failure did not propagate/
  )
})
