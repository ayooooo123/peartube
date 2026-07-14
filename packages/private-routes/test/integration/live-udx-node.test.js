import test from 'brittle'
import { fileURLToPath } from 'node:url'

import { cryptoSuite } from '../../index.js'
import { createLiveRouteFixture, LIVE_ROUTE_CONTACTS } from '../live-route-fixture.js'
import { createProcessCoordinator } from '../process/coordinator.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('seven Node role processes authenticate, report, and close independently', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 50_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 10_000
  })
  try {
    const ready = await coordinator.start()
    t.is(ready.length, 7)
    for (const event of ready) {
      t.is(event.runtime, 'node', event.role)
      t.is(event.adapter, 'node-process', event.role)
      t.is(event.udxVersion, '1.20.7', event.role)
      t.is(event.state, 'OPEN', event.role)
      t.is(event.links, LIVE_ROUTE_CONTACTS[event.role].length, event.role)
      t.is(event.resources.openSockets, 1, event.role)
      t.is(
        event.milestone,
        event.role === 'source'
          ? 'created-and-traffic-verified'
          : event.role === 'destination'
            ? 'traffic-exchanged'
            : event.role.startsWith('private-')
              ? 'actor-registered'
              : 'transport-open',
        event.role
      )
      if (event.role === 'source' || event.role === 'destination') {
        t.ok(event.traffic.streamBytes > 0, event.role)
        t.ok(event.traffic.datagramBytes > 0, event.role)
      } else {
        t.alike(event.traffic, { streamBytes: 0, datagramBytes: 0 }, event.role)
      }
    }
    const snapshots = await coordinator.snapshot()
    t.is(snapshots.length, 7)
    const closed = await coordinator.stop()
    t.is(closed.length, 7)
    for (const event of closed) {
      t.is(event.state, 'CLOSED', event.role)
      t.alike(event.resources, {
        bindings: 0,
        waits: 0,
        timers: 0,
        openSockets: 0
      })
    }
  } finally {
    await coordinator.destroy()
  }
})

test('killing the private middle during setup fails closed within the cleanup budget', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 51_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    const starting = coordinator.start()
    const outcome = starting.then(
      () => null,
      (err) => err
    )
    const killed = coordinator.kill('private-middle')
    const failure = await outcome
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
    t.alike(await killed, { code: null, signal: 'SIGTERM' })
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('delaying authenticated CREATED at the private final fails setup closed', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 52_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.fault('private-final', 'delay-created')
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('closing the private middle UDX socket after connect fails setup closed', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 53_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.fault('private-middle', 'close-socket')
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('spoofing the source tuple prevents UDX bootstrap from authenticating', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 54_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.fault('source', 'spoof-source')
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('replayed authenticated UDX cells cannot keep setup alive', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 55_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.fault('source', 'replay')
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('revoking an opened private-middle grant fails setup closed', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 56_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const grantDigest32 = cryptoSuite.hash(fixture.projections.get('private-middle').grants[0])
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.revoke('private-middle', grantDigest32)
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    grantDigest32.fill(0)
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})

test('ordered stop interrupts all seven roles while setup is pending', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 57_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  const starting = coordinator.start()
  const outcome = starting.then(
    () => null,
    (err) => err
  )
  const closed = await coordinator.stop()
  t.ok(await outcome)
  t.ok(Date.now() - startedAt < 6_500)
  t.is(closed.length, 7)
  for (const event of closed) {
    t.is(event.state, 'CLOSED', event.role)
    t.alike(event.resources, {
      bindings: 0,
      waits: 0,
      timers: 0,
      openSockets: 0
    })
  }
  t.alike(await coordinator.destroy(), [])
})

test('overflowing the source UDX send queue fails setup closed', async (t) => {
  t.timeout(15_000)
  const random = crypto.getRandomValues(new Uint16Array(1))[0]
  const portBase = 58_000 + (random % 1_000)
  const now = BigInt(Date.now())
  const fixture = createLiveRouteFixture({
    portBase,
    distinctHosts: process.platform !== 'darwin',
    now,
    expiresAt: now + 30_000n
  })
  const coordinator = await createProcessCoordinator({
    fixture,
    cwd: PACKAGE_ROOT,
    timeout: 6_500
  })
  const startedAt = Date.now()
  let exits = null
  try {
    await coordinator.fault('source', 'overflow-queue')
    const failure = await coordinator.start().then(
      () => null,
      (err) => err
    )
    t.ok(failure)
    t.ok(Date.now() - startedAt < 6_500)
  } finally {
    exits = await coordinator.destroy()
  }
  t.is(exits.length, 7)
  t.ok(exits.every((exit) => exit.status === 'fulfilled'))
})
