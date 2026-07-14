import test from 'brittle'
import b4a from 'b4a'

import {
  ACTOR_CONTROL_KIND,
  ASYNC_CIRCUIT_STATE,
  ASYNC_REGISTRATION_STATE,
  AsyncRouteControlSession,
  CIRCUIT_DESTROY_REASON,
  PrivateRouteError
} from '../index.js'

function bytes(size, value) {
  return b4a.alloc(size, value)
}

function remote() {
  const calls = []
  return {
    calls,
    request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, actorId, circuitId, generation, body, options })
      return Promise.resolve(kind === 0 ? bytes(195, 1) : kind === 8 ? bytes(305, 2) : b4a.alloc(0))
    }
  }
}

async function rejectionCode(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err && err.code
  }
}

function session(peer, now = () => 1_000) {
  return new AsyncRouteControlSession({ remote: peer, actorId: bytes(16, 1), now })
}

function registration(seed = 2) {
  return {
    stage: bytes(64, seed),
    prepare: bytes(64, seed + 1),
    finalize: bytes(64, seed + 2),
    abort: bytes(64, seed + 3)
  }
}

function abortedSignal() {
  return {
    aborted: true,
    addEventListener() {},
    removeEventListener() {}
  }
}

function cancellableSignal() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener(name, listener) {
      if (name === 'abort') listeners.add(listener)
    },
    removeEventListener(name, listener) {
      if (name === 'abort') listeners.delete(listener)
    }
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of Array.from(listeners)) listener()
      listeners.clear()
    }
  }
}

test('async registration follows the exact linear state table', async (t) => {
  const peer = remote()
  const session = new AsyncRouteControlSession({
    remote: peer,
    actorId: bytes(16, 1),
    now: () => 1_000
  })

  t.is(session.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  await session.register({
    stage: bytes(64, 2),
    prepare: bytes(64, 3),
    finalize: bytes(64, 4),
    abort: bytes(64, 5)
  })
  t.is(session.registrationState, ASYNC_REGISTRATION_STATE.FINALIZED)
  t.alike(
    peer.calls.map((call) => call.options.deadline),
    [6_000, 6_000, 6_000],
    'one absolute deadline is propagated through every request'
  )
  t.alike(session.stats, {
    waits: 0,
    timers: 0,
    ownedBytes: 0,
    registrationState: ASYNC_REGISTRATION_STATE.FINALIZED,
    circuitState: ASYNC_CIRCUIT_STATE.NEW,
    stopped: false
  })
})

test('registration abort is allowed only from staged or prepared and repeats idempotently', async (t) => {
  const first = session(remote())
  t.is(await rejectionCode(first.abort(bytes(64, 1))), 'CIRCUIT_STATE')

  const staged = session(remote())
  await staged.stage(bytes(64, 2), { abort: bytes(64, 3) })
  t.is(staged.registrationState, ASYNC_REGISTRATION_STATE.STAGED)
  t.is(await staged.abort(), true)
  t.is(staged.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(await staged.abort(), true)

  const prepared = session(remote())
  await prepared.stage(bytes(64, 4), { abort: bytes(64, 5) })
  await prepared.prepare(bytes(64, 6))
  t.is(prepared.registrationState, ASYNC_REGISTRATION_STATE.PREPARED)
  t.is(await prepared.abort(), true)
  t.is(prepared.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)

  t.is(await rejectionCode(prepared.prepare(bytes(64, 7))), 'CIRCUIT_STATE')
})

test('finalized registration expires or revokes once without skipped transitions', async (t) => {
  const expired = session(remote())
  await expired.register(registration())
  t.is(await expired.expire(), true)
  t.is(expired.registrationState, ASYNC_REGISTRATION_STATE.EXPIRED)
  t.is(await rejectionCode(expired.expire()), 'CIRCUIT_STATE')

  const revoked = session(remote())
  await revoked.register(registration(10))
  t.is(await revoked.revoke(), true)
  t.is(revoked.registrationState, ASYNC_REGISTRATION_STATE.REVOKED)
  t.is(await rejectionCode(revoked.revoke()), 'CIRCUIT_STATE')
})

test('activation opens only after reply and destroy is the sole idempotent repeat', async (t) => {
  const peer = remote()
  const control = session(peer)
  const proof = await control.activate({
    body: bytes(512, 9),
    circuitId: bytes(16, 10),
    generation: 3n,
    activationVerifier: Object.freeze({})
  })
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.OPEN)
  t.is(proof.byteLength, 305)
  t.is(
    await control.destroy(CIRCUIT_DESTROY_REASON.REQUESTED),
    true,
    'authenticated destroy reply closes the local circuit'
  )
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  t.is(await control.destroy(), true)
  t.is(await rejectionCode(control.activate({})), 'CIRCUIT_STATE')
  t.alike(
    peer.calls.map((call) => call.kind),
    [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.CIRCUIT_DESTROY]
  )
  proof.fill(0)
})

test('one deadline covers registration and a failed partial transaction attempts remote abort', async (t) => {
  const calls = []
  const peer = {
    request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, options })
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
      if (kind === ACTOR_CONTROL_KIND.REGISTER_PREPARE)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      if (kind === ACTOR_CONTROL_KIND.REGISTER_ABORT) return Promise.resolve(b4a.alloc(0))
      return Promise.reject(new Error('unexpected'))
    }
  }
  const control = session(peer)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.alike(
    calls.map(({ kind }) => kind),
    [
      ACTOR_CONTROL_KIND.REGISTER_STAGE,
      ACTOR_CONTROL_KIND.REGISTER_PREPARE,
      ACTOR_CONTROL_KIND.REGISTER_ABORT
    ]
  )
  t.alike(
    calls.map(({ options }) => options.deadline),
    [6_000, 6_000, 6_000]
  )
  t.is(control.stats.waits, 0)
  t.is(control.stats.ownedBytes, 0)
})

test('a lost stage reply still attempts abort without claiming staged ownership', async (t) => {
  const calls = []
  const peer = {
    request(kind) {
      calls.push(kind)
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE)
        return Promise.reject(PrivateRouteError.ROUTE_UNAVAILABLE())
      return Promise.resolve(b4a.alloc(0))
    }
  }
  const control = session(peer)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
  t.is(control.stats.ownedBytes, 0)
})

test('an exact-deadline response is late, tombstoned remotely, and rolled back', async (t) => {
  let now = 1_000
  const calls = []
  const peer = {
    request(kind) {
      calls.push(kind)
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) {
        now = 6_000
        return Promise.resolve(bytes(195, 1))
      }
      return Promise.reject(PrivateRouteError.INVALID_ROUTE())
    }
  }
  const control = session(peer, () => now)
  t.is(await rejectionCode(control.register(registration())), 'ROUTE_UNAVAILABLE')
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.stats.waits, 0)
})

test('transport exceptions map stably and activation failure attempts destroy', async (t) => {
  const calls = []
  const peer = {
    request(kind) {
      calls.push(kind)
      if (kind === ACTOR_CONTROL_KIND.ACTIVATE_CREATE) throw new Error('socket died')
      return Promise.reject(new Error('socket remains dead'))
    }
  }
  const control = session(peer)
  t.is(
    await rejectionCode(
      control.activate({
        body: bytes(128, 1),
        circuitId: bytes(16, 2),
        generation: 1n,
        activationVerifier: Object.freeze({})
      })
    ),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(calls, [ACTOR_CONTROL_KIND.ACTIVATE_CREATE, ACTOR_CONTROL_KIND.CIRCUIT_DESTROY])
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  t.is(control.stats.ownedBytes, 0)
})

test('stop during setup cancels the installed wait before remote completion', async (t) => {
  let observedSignal = null
  const peer = {
    request(kind, actorId, circuitId, generation, body, options) {
      if (options.signal) observedSignal = options.signal
      return new Promise((resolve, reject) => {
        if (!options.signal) return reject(PrivateRouteError.ROUTE_UNAVAILABLE())
        const cancelled = () => reject(PrivateRouteError.ROUTE_UNAVAILABLE())
        options.signal.addEventListener('abort', cancelled, { once: true })
      })
    }
  }
  const control = session(peer)
  const pending = control.activate({
    body: bytes(128, 1),
    circuitId: bytes(16, 2),
    generation: 1n,
    activationVerifier: Object.freeze({})
  })
  const stopped = control.stop()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.is(await stopped, true)
  t.is(observedSignal.aborted, true)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.DESTROYED)
  t.alike(control.stats, {
    waits: 0,
    timers: 0,
    ownedBytes: 0,
    registrationState: ASYNC_REGISTRATION_STATE.NEW,
    circuitState: ASYNC_CIRCUIT_STATE.DESTROYED,
    stopped: true
  })
})

test('pre-dispatch cancellation does not emit stage or abort traffic', async (t) => {
  const calls = []
  const control = session({
    request(kind) {
      calls.push(kind)
      return Promise.resolve(b4a.alloc(0))
    }
  })
  t.is(
    await rejectionCode(control.register({ ...registration(), signal: abortedSignal() })),
    'ROUTE_UNAVAILABLE'
  )
  t.alike(calls, [])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.stats.ownedBytes, 0)
})

test('cancellation after authenticated stage attempts abort with the original deadline', async (t) => {
  const controller = cancellableSignal()
  const calls = []
  const peer = {
    request(kind, actorId, circuitId, generation, body, options) {
      calls.push({ kind, deadline: options.deadline })
      if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE) return Promise.resolve(bytes(195, 1))
      if (kind === ACTOR_CONTROL_KIND.REGISTER_PREPARE) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(PrivateRouteError.ROUTE_UNAVAILABLE()),
            { once: true }
          )
        })
      }
      return Promise.resolve(b4a.alloc(0))
    }
  }
  const control = session(peer)
  const pending = control.register({ ...registration(), signal: controller.signal })
  for (let attempt = 0; attempt < 16 && calls.length < 2; attempt++) await Promise.resolve()
  t.is(calls.length, 2, 'prepare wait is installed before cancellation')
  controller.abort()
  t.is(await rejectionCode(pending), 'ROUTE_UNAVAILABLE')
  t.alike(calls, [
    { kind: ACTOR_CONTROL_KIND.REGISTER_STAGE, deadline: 6_000 },
    { kind: ACTOR_CONTROL_KIND.REGISTER_PREPARE, deadline: 6_000 },
    { kind: ACTOR_CONTROL_KIND.REGISTER_ABORT, deadline: 6_000 }
  ])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(control.stats.waits, 0)
  t.is(control.stats.ownedBytes, 0)
})

test('stop from staged state sends the retained abort before clearing resources', async (t) => {
  const calls = []
  const peer = remote()
  const request = peer.request
  peer.request = function (...args) {
    calls.push(args[0])
    return request.apply(this, args)
  }
  const control = session(peer)
  await control.stage(bytes(64, 1), { abort: bytes(64, 2) })
  t.is(await control.stop(), true)
  t.alike(calls, [ACTOR_CONTROL_KIND.REGISTER_STAGE, ACTOR_CONTROL_KIND.REGISTER_ABORT])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.ABORTED)
  t.is(control.stats.ownedBytes, 0)
})

test('remote stable errors survive cleanup while unknown failures become unavailable', async (t) => {
  for (const expected of ['UNAUTHORIZED', 'CIRCUIT_LIMIT', 'CIRCUIT_STATE']) {
    const peer = {
      request(kind) {
        if (kind === ACTOR_CONTROL_KIND.REGISTER_STAGE)
          return Promise.reject(new PrivateRouteError(expected))
        return Promise.resolve(b4a.alloc(0))
      }
    }
    t.is(await rejectionCode(session(peer).register(registration())), expected)
  }
})

test('session owns request copies and clears them after completion', async (t) => {
  const retained = []
  const peer = {
    request(kind, actorId, circuitId, generation, body) {
      retained.push(body)
      return Promise.resolve(
        kind === ACTOR_CONTROL_KIND.REGISTER_STAGE ? bytes(195, 1) : b4a.alloc(0)
      )
    }
  }
  const values = registration()
  const control = session(peer)
  await control.register(values)
  for (const value of Object.values(values))
    t.ok(
      value.some((byte) => byte !== 0),
      'caller input remains caller-owned'
    )
  for (const value of retained)
    t.ok(
      value.every((byte) => byte === 0),
      'transport-facing private copy is zeroized'
    )
})

test('late local validation failures transmit nothing and leave both tables at NEW', async (t) => {
  const peer = remote()
  const control = session(peer)
  t.is(
    await rejectionCode(
      control.register({
        stage: bytes(64, 1),
        prepare: bytes(64, 2),
        finalize: null,
        abort: bytes(64, 3)
      })
    ),
    'INVALID_ROUTE'
  )
  t.is(
    await rejectionCode(
      control.activate({
        body: bytes(64, 4),
        circuitId: bytes(16, 5),
        generation: -1n,
        activationVerifier: Object.freeze({})
      })
    ),
    'INVALID_ROUTE'
  )
  t.alike(peer.calls, [])
  t.is(control.registrationState, ASYNC_REGISTRATION_STATE.NEW)
  t.is(control.circuitState, ASYNC_CIRCUIT_STATE.NEW)
  t.is(control.stats.ownedBytes, 0)
})
