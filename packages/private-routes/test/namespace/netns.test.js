import test from 'brittle'

import { createLiveRouteFixture } from '../live-route-fixture.js'
import { resolveRoleLaunch } from '../process/coordinator.js'
import {
  NAMESPACE_ROLES,
  createCaptureMatrix,
  createNamespaceLayout,
  createNamespaceManager,
  namespaceExecLaunch,
  namespaceLaunch
} from './netns.js'

const CONTACTS = Object.freeze({
  source: Object.freeze(['safety-guard']),
  'safety-guard': Object.freeze(['source', 'safety-final']),
  'safety-final': Object.freeze(['safety-guard', 'private-entry']),
  'private-entry': Object.freeze(['safety-final', 'private-middle']),
  'private-middle': Object.freeze(['private-entry', 'private-final']),
  'private-final': Object.freeze(['private-middle', 'destination']),
  destination: Object.freeze(['private-final'])
})

function command(value) {
  return [value.command, ...value.args].join(' ')
}

test('namespace layout locks eight fully reachable synthetic bridge members', (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  t.alike(layout.roles, NAMESPACE_ROLES)
  t.is(layout.bridge.name, 'pbabc123')
  t.is(layout.bridge.address, '10.203.77.1')
  t.is(layout.members.length, 8)
  t.alike(
    layout.members.map((value) => [value.role, value.namespace, value.address, value.port]),
    [
      ['source', 'prsabc123', '10.203.77.2', 48_100],
      ['safety-guard', 'prsgabc123', '10.203.77.3', 48_101],
      ['safety-final', 'prsfabc123', '10.203.77.4', 48_102],
      ['private-entry', 'prpeabc123', '10.203.77.5', 48_103],
      ['private-middle', 'prpmabc123', '10.203.77.6', 48_104],
      ['private-final', 'prpfabc123', '10.203.77.7', 48_105],
      ['destination', 'prdabc123', '10.203.77.8', 48_106],
      ['decoy', 'prxabc123', '10.203.77.9', 48_200]
    ]
  )
  for (const member of layout.members) {
    t.ok(member.hostVeth.length <= 15, member.hostVeth)
    t.ok(member.peerVeth.length <= 15, member.peerVeth)
  }
  const matrix = createCaptureMatrix(layout, CONTACTS, {
    captureStartedAtNs: 1n,
    closedAtNs: 2n,
    captureStoppedAtNs: 3n
  })
  t.is(matrix.roles.decoy.route, false)
  t.alike(matrix.roles.auditor, {
    addresses: ['10.203.77.1'],
    port: 48_201,
    route: false
  })
  t.is(matrix.roles.source.route, true)
  t.alike(matrix.requiredEdges, [
    ['source', 'safety-guard'],
    ['safety-guard', 'source'],
    ['safety-guard', 'safety-final'],
    ['safety-final', 'safety-guard'],
    ['safety-final', 'private-entry'],
    ['private-entry', 'safety-final'],
    ['private-entry', 'private-middle'],
    ['private-middle', 'private-entry'],
    ['private-middle', 'private-final'],
    ['private-final', 'private-middle'],
    ['private-final', 'destination'],
    ['destination', 'private-final']
  ])
})

test('namespace setup disables only kernel noise and adds no adjacency firewall', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const commands = []
  const manager = createNamespaceManager({
    layout,
    async execute(command, args) {
      commands.push({ command, args })
    }
  })
  await manager.setup()
  t.alike(commands.slice(0, 3).map(command), [
    'ip link add name pbabc123 type bridge',
    'ip address add 10.203.77.1/24 dev pbabc123',
    'ip link set pbabc123 up'
  ])
  for (const member of layout.members) {
    t.ok(commands.some((value) => command(value) === `ip netns add ${member.namespace}`))
    t.ok(
      commands.some(
        (value) =>
          command(value) ===
          `ip netns exec ${member.namespace} sysctl -q -w net.ipv6.conf.all.autoconf=0`
      )
    )
    t.ok(
      commands.some(
        (value) =>
          command(value) ===
          `ip netns exec ${member.namespace} ip link set dev eth0 addrgenmode none`
      )
    )
    t.ok(
      commands.some(
        (value) =>
          command(value) ===
          `ip netns exec ${member.namespace} iptables -I OUTPUT -p icmp --icmp-type port-unreachable -j DROP`
      )
    )
  }
  const drops = commands.filter((value) => value.args.includes('DROP'))
  t.is(drops.length, layout.members.length)
  t.absent(commands.some((value) => value.args.some((entry) => entry.includes('disable_ipv6'))))
  t.absent(commands.some((value) => value.args.includes('FORWARD')))
  t.absent(commands.some((value) => value.args.includes('REJECT')))
  await manager.cleanup()
  const cleanup = commands.slice(-17).map(command)
  t.is(cleanup[0], 'ip link delete ph7abc123')
  t.is(cleanup[1], 'ip netns delete prxabc123')
  t.is(cleanup[cleanup.length - 1], 'ip link delete pbabc123')
  const count = commands.length
  await manager.cleanup()
  t.is(commands.length, count, 'cleanup is idempotent')
})

test('namespace setup failure cleans every created resource in reverse order', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'fail01', subnetId: 78, portBase: 48_300 })
  const commands = []
  const manager = createNamespaceManager({
    layout,
    async execute(commandValue, args) {
      const value = { command: commandValue, args }
      commands.push(value)
      if (command(value) === 'ip netns add prsffail01') throw new Error('injected setup failure')
    }
  })
  await t.exception(manager.setup(), /injected setup failure/)
  t.alike(commands.slice(-5).map(command), [
    'ip link delete ph1fail01',
    'ip netns delete prsgfail01',
    'ip link delete ph0fail01',
    'ip netns delete prsfail01',
    'ip link delete pbfail01'
  ])
  const count = commands.length
  await manager.cleanup()
  t.is(commands.length, count)
})

test('namespace launches each role through ip netns exec without a shell', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const launch = namespaceLaunch(layout, 'private-middle', '/usr/bin/node', ['--no-warnings'])
  t.alike(launch, {
    command: 'ip',
    args: ['netns', 'exec', 'prpmabc123', '/usr/bin/node', '--no-warnings']
  })
  await t.exception.all(() => namespaceLaunch(layout, 'decoy', '/usr/bin/node', []), /route role/)
})

test('namespace launches an explicit auxiliary command in the decoy without widening route launch', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  t.alike(namespaceExecLaunch(layout, 'decoy', '/usr/bin/node', ['probe.js']), {
    command: 'ip',
    args: ['netns', 'exec', 'prxabc123', '/usr/bin/node', 'probe.js']
  })
  await t.exception.all(
    () => namespaceExecLaunch(layout, 'external', '/usr/bin/node', []),
    /configuration/
  )
})

test('process coordinator resolves and copies one launch command per role', async (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const calls = []
  const options = {
    launchRole(role) {
      calls.push(role)
      return namespaceLaunch(layout, role, '/usr/bin/node', ['--no-warnings'])
    }
  }
  const launch = resolveRoleLaunch(options, 'private-final')
  t.alike(launch, {
    command: 'ip',
    args: ['netns', 'exec', 'prpfabc123', '/usr/bin/node', '--no-warnings'],
    cwd: undefined
  })
  t.alike(calls, ['private-final'])
  await t.exception.all(
    () => resolveRoleLaunch({ launchRole: () => ({ command: 'ip', args: 'unsafe' }) }, 'source'),
    /process launch/
  )
})

test('live route fixture signs the explicit namespace address vector', (t) => {
  const layout = createNamespaceLayout({ suffix: 'abc123', subnetId: 77, portBase: 48_100 })
  const hosts = layout.members.filter((value) => value.route).map((value) => value.address)
  const fixture = createLiveRouteFixture({
    hosts,
    portBase: layout.portBase,
    now: 1_000n,
    expiresAt: 30_000n
  })
  t.alike(
    fixture.roles.map((role) => fixture.projections.get(role).bind.host),
    hosts
  )
})
