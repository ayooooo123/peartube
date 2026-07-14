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
