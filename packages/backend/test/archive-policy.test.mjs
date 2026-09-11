import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createArchivePolicy } from '../src/archive/policy.js'
import { createArchivePledge } from '../src/archive/pledge.js'

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
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 9 })).reason, 'reservation-exceeded')
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 4 })).accepted, true)
  t.is(await policy.availableBytes(), 2, 'partial writes retain the full reservation')
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 8, complete: true })).accepted, true)
  t.is(await policy.availableBytes(), 2, 'commitment against capacity is preserved')
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
  await first.reconcile({ pledgeId: 'p1', verifiedBytes: 5 })

  const restarted = createArchivePolicy({ capacityBytes: 10, now: () => 2, repository })
  await restarted.ready
  t.is(await restarted.availableBytes(), 3)
  t.alike((await restarted.snapshot()).reservations, [{ pledgeId: 'p1', reservedBytes: 7, verifiedBytes: 5, complete: false, verifiedRanges: [], expiresAt: 20 }])
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
    verifiedBytes: 0,
    complete: false,
    verifiedRanges: [],
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

test('archive policy rejects malformed or excess verifiedRanges fail-closed', async (t) => {
  const policy = createArchivePolicy({ capacityBytes: 20, now: () => 1 })
  await policy.reserve({ pledgeId: 'p1', bytes: 10, expiresAt: 20 })
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 5, verifiedRanges: [{ start: 5, end: 2 }] })).reason, 'invalid-verified-ranges')
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 5, verifiedRanges: [{ start: -1, end: 5 }] })).reason, 'invalid-verified-ranges')
  const excess = Array.from({ length: 65 }, (_, i) => ({ start: i, end: i + 1 }))
  t.is((await policy.reconcile({ pledgeId: 'p1', verifiedBytes: 5, verifiedRanges: excess })).reason, 'invalid-verified-ranges')
})

test('archive policy decode ignores legacy actualBytes and initializes verifiedBytes conservatively', async (t) => {
  const legacy = {
    version: 1,
    capacityBytes: 10,
    reservations: [{
      pledgeId: 'legacy-p1',
      reservedBytes: 8,
      actualBytes: 8,
      expiresAt: 20,
    }],
  }
  const repository = memoryRepository(legacy)
  const policy = createArchivePolicy({ capacityBytes: 10, now: () => 1, repository })
  await policy.ready
  const snap = await policy.snapshot()
  t.is(snap.reservations[0].reservedBytes, 8)
  t.is(snap.reservations[0].verifiedBytes, 0, 'legacy actualBytes is not migrated into verifiedBytes')
  t.is(snap.reservations[0].complete, false)
  t.is(snap.reservations[0].actualBytes, undefined, 'actualBytes is deleted from live state')
})

test('archive policy complete requires exact coreKey coverage across multi-range pledges', async (t) => {
  const archivist = crypto.keyPair(b4a.alloc(32, 44))
  const coreA = 'a'.repeat(64)
  const coreB = 'b'.repeat(64)
  const pledge = createArchivePledge({
    archivistId: archivist.publicKey,
    publicationId: 'd'.repeat(64),
    renditionId: 'e'.repeat(64),
    ranges: [
      { coreKey: coreA, start: 0, end: 100 },
      { coreKey: coreB, start: 0, end: 50 },
    ],
    retentionUntil: 100_000,
    uploadCeilingBytes: 1024,
    keyPair: archivist,
    issuedAt: 1,
  })
  // envelope.body is encoded canonical bytes — policy must decode, not read .ranges on bytes
  t.ok(pledge.envelope.body?.byteLength > 0 || typeof pledge.envelope.body === 'string' || Buffer.isBuffer(pledge.envelope.body))
  t.is(pledge.envelope.body?.ranges, undefined)

  const policy = createArchivePolicy({ capacityBytes: 1000, now: () => 1 })
  await policy.reserve({
    pledgeId: pledge.pledgeId,
    bytes: 150,
    expiresAt: 100_000,
    pledgeEnvelope: pledge.envelope,
  })

  const withoutKeys = await policy.reconcile({
    pledgeId: pledge.pledgeId,
    verifiedBytes: 150,
    verifiedRanges: [
      { start: 0, end: 100 },
      { start: 0, end: 50 },
    ],
    complete: true,
  })
  t.is(withoutKeys.accepted, true)
  t.is(withoutKeys.complete, false, 'missing coreKey cannot complete multi-range pledge')

  const partialCore = await policy.reconcile({
    pledgeId: pledge.pledgeId,
    verifiedBytes: 150,
    verifiedRanges: [
      { coreKey: coreA, start: 0, end: 100 },
      { coreKey: coreA, start: 0, end: 50 },
    ],
    complete: true,
  })
  t.is(partialCore.complete, false, 'wrong coreKey identity cannot complete')

  const covered = await policy.reconcile({
    pledgeId: pledge.pledgeId,
    verifiedBytes: 150,
    verifiedRanges: [
      { coreKey: coreA, start: 0, end: 100 },
      { coreKey: coreB, start: 0, end: 50 },
    ],
    complete: true,
  })
  t.is(covered.accepted, true)
  t.is(covered.complete, true, 'exact coreKey coverage from decoded signed envelope completes')
})
