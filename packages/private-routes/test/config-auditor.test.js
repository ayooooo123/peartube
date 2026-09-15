import test from 'brittle'
import b4a from 'b4a'

import { createConfigurationAuditor } from './process/config-auditor.js'
import { createProcessCodecVectors } from './process/codec-vectors.js'
import { CONTROL_COMMAND, encodeControlFrame } from './process/control-channel.js'
import { LIVE_ROUTE_ROLES, createLiveRouteFixture } from './live-route-fixture.js'

function clone(value) {
  if (b4a.isBuffer(value)) return b4a.from(value)
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
  }
  return value
}

function fails(run) {
  try {
    run()
    return false
  } catch {
    return true
  }
}

test('independent auditor accepts exact semantic and serialized role projections', (t) => {
  const fixture = createLiveRouteFixture()
  const auditor = createConfigurationAuditor(fixture)
  for (const role of LIVE_ROUTE_ROLES) {
    const projection = fixture.projections.get(role)
    const frame = encodeControlFrame({ command: CONTROL_COMMAND.CONFIGURE, projection })
    const result = auditor.auditConfiguration(role, projection, frame)
    t.is(result.role, role)
    t.is(result.fingerprints.length, projection.grants.length)
    t.is(result.bytes, frame.byteLength)
    frame.fill(0)
  }
  auditor.destroy()
})

test('auditor policy cannot be widened by the fixture it audits', (t) => {
  const fixture = createLiveRouteFixture()
  const projections = new Map(fixture.projections)
  const source = clone(projections.get('source'))
  source.known.push({
    role: 'destination',
    identity32: b4a.from(projections.get('destination').local.identity32)
  })
  projections.set('source', source)
  t.ok(
    fails(() => createConfigurationAuditor({ ...fixture, projections })),
    'independent role policy rejects a self-authorized knowledge expansion'
  )
})

test('auditor rejects a nested source activation leak before the fixture can self-authorize it', (t) => {
  const fixture = createLiveRouteFixture()
  const projections = new Map(fixture.projections)
  const source = clone(projections.get('source'))
  source.route.activation.leakedPath = ['source', 'destination']
  source.route.activation.leakedSecret = b4a.alloc(32, 0xa7)
  projections.set('source', source)
  t.ok(
    fails(() => createConfigurationAuditor({ ...fixture, projections })),
    'independent nested schema rejects path and secret fields even when expected input is mutated'
  )
})

test('auditor recursively locks every role-specific route structure and secret size', (t) => {
  const mutations = [
    [
      'source registration',
      'source',
      (route) => (route.registrations[0].leakedSecret = b4a.alloc(32))
    ],
    ['safety advertisement', 'safety-guard', (route) => (route.leakedPath = [])],
    [
      'private registration',
      'private-middle',
      (route) => (route.registration.leakedAddress = '127.0.0.1')
    ],
    ['destination payload', 'destination', (route) => (route.payload.leakedGrant = b4a.alloc(32))],
    [
      'destination secret size',
      'destination',
      (route) => (route.routeSigningSecretKey = b4a.alloc(63))
    ]
  ]
  for (const [name, role, mutate] of mutations) {
    const fixture = createLiveRouteFixture()
    const projections = new Map(fixture.projections)
    const projection = clone(projections.get(role))
    mutate(projection.route)
    projections.set(role, projection)
    t.ok(
      fails(() => createConfigurationAuditor({ ...fixture, projections })),
      name
    )
  }
})

test('auditor rejects duplicate grants that omit a required adjacent peer', (t) => {
  const fixture = createLiveRouteFixture()
  const projections = new Map(fixture.projections)
  const safetyGuard = clone(projections.get('safety-guard'))
  safetyGuard.grants = [b4a.from(safetyGuard.grants[0]), b4a.from(safetyGuard.grants[0])]
  projections.set('safety-guard', safetyGuard)
  t.ok(
    fails(() => createConfigurationAuditor({ ...fixture, projections })),
    'duplicate source grant cannot stand in for the omitted safety-final grant'
  )
})

test('auditor requires the complete role set independently of the fixture', (t) => {
  const fixture = createLiveRouteFixture()
  t.ok(
    fails(() =>
      createConfigurationAuditor({
        ...fixture,
        roles: fixture.roles.filter((role) => role !== 'destination')
      })
    ),
    'a fixture cannot remove a policy role from the audit'
  )
})

test('auditor rejects every forbidden non-adjacent address and topology expansion', (t) => {
  const fixture = createLiveRouteFixture()
  const auditor = createConfigurationAuditor(fixture)
  for (const role of LIVE_ROUTE_ROLES) {
    const expected = fixture.projections.get(role)
    const direct = new Set(expected.contacts.map((value) => value.role))
    for (const leakedRole of LIVE_ROUTE_ROLES) {
      if (leakedRole === role || direct.has(leakedRole)) continue
      const leaked = clone(expected)
      leaked.leakedAddress = fixture.projections.get(leakedRole).bind.host
      const frame = encodeControlFrame({ command: CONTROL_COMMAND.CONFIGURE, projection: leaked })
      t.ok(
        fails(() => auditor.auditConfiguration(role, leaked, frame)),
        `${role} -> ${leakedRole}`
      )
      frame.fill(0)
    }
    for (const field of ['path', 'projections', 'addresses']) {
      const expanded = clone(expected)
      expanded[field] = []
      const frame = encodeControlFrame({ command: CONTROL_COMMAND.CONFIGURE, projection: expanded })
      t.ok(
        fails(() => auditor.auditConfiguration(role, expanded, frame)),
        `${role} ${field}`
      )
      frame.fill(0)
    }
  }
  auditor.destroy()
})

test('auditor locks event schemas and rejects address-bearing output', (t) => {
  const fixture = createLiveRouteFixture()
  const auditor = createConfigurationAuditor(fixture)
  const role = 'source'
  const projection = fixture.projections.get(role)
  const configured = {
    event: 'configured',
    role,
    state: 'CONFIGURED',
    runtime: 'node',
    runtimeVersion: 'v22.19.0',
    adapter: 'node-process',
    udxVersion: '1.20.7',
    codecVectors: createProcessCodecVectors()
  }
  t.is(auditor.auditEvent(role, configured), true)
  t.ok(
    fails(() =>
      auditor.auditEvent(role, {
        ...configured,
        runtimeVersion: `v22.19.0-LEAK-${'ab'.repeat(32)}`
      })
    ),
    'runtime metadata cannot carry an encoded secret suffix'
  )
  t.is(
    auditor.auditEvent(role, {
      event: 'error',
      role,
      state: 'OPEN',
      phase: 'source-register',
      code: 'ROUTE_UNAVAILABLE'
    }),
    true
  )
  t.ok(
    fails(() =>
      auditor.auditEvent(role, {
        event: 'error',
        role,
        state: 'OPEN',
        phase: '10.203.77.3',
        code: 'ROUTE_UNAVAILABLE'
      })
    )
  )
  const leaked = { ...configured, address: projection.bind.host }
  t.ok(fails(() => auditor.auditEvent(role, leaked)))
  t.is(auditor.auditDiagnostic(role, { role, code: 'ROUTE_UNAVAILABLE' }), true)
  t.ok(
    fails(() =>
      auditor.auditDiagnostic(role, {
        role,
        code: 'ROUTE_UNAVAILABLE',
        address: projection.contacts[0].identity32
      })
    )
  )
  auditor.destroy()
})
