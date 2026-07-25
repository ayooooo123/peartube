import test from 'brittle'

import { createArchivePolicy } from '../src/archive/policy.js'

function memoryRepository(initial = null) {
  let state = initial
  return {
    async load () { return state == null ? null : structuredClone(state) },
    async save (next) { state = structuredClone(next) },
    state: () => structuredClone(state),
  }
}

test('archive reservations serialize concurrent capacity races and reject conflicting duplicates', async (t) => {
  const policy = createArchivePolicy({ capacityBytes: 10, now: () => 1 })
  const [one, two] = await Promise.all([
    policy.reserve({ pledgeId: 'p1', bytes: 6, expiresAt: 10 }),
    policy.reserve({ pledgeId: 'p2', bytes: 6, expiresAt: 10 }),
  ])
  t.is(Number(one.accepted) + Number(two.accepted), 1, 'only one concurrent reservation wins remaining capacity')
  const winner = one.accepted ? 'p1' : 'p2'
  t.is((await policy.reserve({ pledgeId: winner, bytes: 6, expiresAt: 10 })).idempotent, true)
  t.is((await policy.reserve({ pledgeId: winner, bytes: 5, expiresAt: 10 })).reason, 'reservation-conflict')
  t.is(await policy.availableBytes(), 4)
})

test('archive reservations bound partial writes, reconcile completion, cancellation, and expiry', async (t) => {
  const policy = createArchivePolicy({ capacityBytes: 10, now: () => 1 })
  t.is((await policy.reserve({ pledgeId: 'p1', bytes: 8, expiresAt: 5 })).accepted, true)
  t.is((await policy.reconcile({ pledgeId: 'p1', actualBytes: 9 })).reason, 'reservation-exceeded')
  t.is((await policy.reconcile({ pledgeId: 'p1', actualBytes: 4 })).accepted, true)
  t.is(await policy.availableBytes(), 2, 'partial writes retain the full reservation')
  t.is((await policy.reconcile({ pledgeId: 'p1', actualBytes: 4, complete: true })).accepted, true)
  t.is(await policy.availableBytes(), 6)
  t.alike((await policy.expire(5)).expired, ['p1'])
  t.is(await policy.availableBytes(), 10)
  t.is((await policy.reserve({ pledgeId: 'p2', bytes: 3, expiresAt: 9 })).accepted, true)
  t.is((await policy.release({ pledgeId: 'p2' })).released, true)
  t.is((await policy.release({ pledgeId: 'p2' })).released, false)
})

test('archive reservations restore atomically persisted capacity after restart', async (t) => {
  const repository = memoryRepository()
  const first = createArchivePolicy({ capacityBytes: 10, now: () => 1, repository })
  await first.reserve({ pledgeId: 'p1', bytes: 7, expiresAt: 20 })
  await first.reconcile({ pledgeId: 'p1', actualBytes: 5 })

  const restarted = createArchivePolicy({ capacityBytes: 10, now: () => 2, repository })
  await restarted.ready
  t.is(await restarted.availableBytes(), 3)
  t.alike((await restarted.snapshot()).reservations, [{ pledgeId: 'p1', reservedBytes: 7, actualBytes: 5, expiresAt: 20 }])
  t.is((await restarted.reserve({ pledgeId: 'p2', bytes: 4, expiresAt: 20 })).reason, 'capacity-exceeded')
})

test('archive reservation persists its signed pledge in the same state write', async (t) => {
  const repository = memoryRepository()
  const pledgeEnvelope = {
    recordId: 'f'.repeat(64),
    body: new Uint8Array([1, 2, 3]),
    signature: new Uint8Array([4, 5, 6]),
  }
  const policy = createArchivePolicy({ capacityBytes: 10, now: () => 1, repository })

  await policy.reserve({ pledgeId: 'p1', bytes: 7, expiresAt: 20, pledgeEnvelope })

  t.alike(repository.state().reservations, [{
    pledgeId: 'p1',
    reservedBytes: 7,
    actualBytes: 0,
    expiresAt: 20,
    pledgeEnvelope,
  }])
  const restarted = createArchivePolicy({ capacityBytes: 10, now: () => 2, repository })
  await restarted.ready
  t.alike((await restarted.snapshot()).reservations[0].pledgeEnvelope, pledgeEnvelope)
})

test('failed persistence never mutates admitted reservation state', async (t) => {
  let saves = 0
  const policy = createArchivePolicy({
    capacityBytes: 10,
    now: () => 1,
    repository: {
      async load () { return null },
      async save () {
        saves++
        if (saves === 1) throw new Error('disk full')
      },
    },
  })
  await t.exception(policy.reserve({ pledgeId: 'p1', bytes: 6, expiresAt: 10 }), /disk full/)
  t.is(await policy.availableBytes(), 10)
})
