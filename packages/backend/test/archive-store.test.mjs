import test from 'brittle'
import crypto from 'hypercore-crypto'

import { createArchivePledge } from '../src/archive/pledge.js'
import { createArchiveStore } from '../src/archive/store.js'

const archivist = crypto.keyPair(Buffer.alloc(32, 1))
const archivistId = Buffer.from(archivist.publicKey).toString('hex')

test('archive store records local observations without converting challenge success into guarantees', async (t) => {
  const store = createArchiveStore({ maxObservations: 2 })
  const pledge = createArchivePledge({ archivistId, publicationId: 'a'.repeat(64), renditionId: 'b'.repeat(64), ranges: [{ coreKey: 'c'.repeat(64), start: 0, end: 1 }], retentionUntil: 1000, uploadCeilingBytes: 1, keyPair: archivist }).envelope
  await store.putPledge(pledge)
  store.putObservation({ pledgeId: pledge.recordId, status: 'challenge-passed', observedAt: 1 })
  store.putObservation({ pledgeId: pledge.recordId, status: 'challenge-passed', observedAt: 2 })
  store.putObservation({ pledgeId: pledge.recordId, status: 'challenge-passed', observedAt: 3 })
  t.is(store.getPledge(pledge.recordId).recordId, pledge.recordId)
  t.is(store.getObservations(pledge.recordId).length, 2)
  t.is(store.getAvailabilityJudgement(pledge.recordId).guaranteed, false)
})
