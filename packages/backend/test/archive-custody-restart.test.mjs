// What an archivist does across a restart.
//
// A relay is unattended: nobody is watching when it reboots. An archive pledge
// is a promise to someone else, so the interesting question is not whether the
// happy path works while the process is up, but what the ledger says after it
// comes back — whether custody it promised survives, whether custody that
// lapsed is actually let go, and whether an operator who switched re-seeding
// off stops occupying the disk instead of quietly keeping the promise.
import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import {
  createArchivePolicy,
  createArchiveRequest,
  createPermissionlessArchiveNetwork,
} from '../src/archive/index.js'

const CAPACITY_BYTES = 1024 * 1024
const REQUESTED_BYTES = 4096

function bytes (length, fill) {
  return b4a.alloc(length, fill)
}

const requester = crypto.keyPair(bytes(32, 71))
const volunteer = crypto.keyPair(bytes(32, 72))
const publicationId = 'a'.repeat(64)
const renditionId = 'b'.repeat(64)
const coreKey = 'c'.repeat(64)
const ranges = [{ coreKey, start: 0, end: 4 }]

// The archivist's disk: it outlives each process, which is the whole point.
function createHost () {
  let reservations = null
  let participation = null
  const retained = []
  const released = []
  let clock = 1_000_000

  const scopedNetwork = {
    async retainAuthorizedArchive (input) {
      retained.push(input.pledge.pledgeId)
      return { status: 'retained' }
    },
    async releaseAuthorizedArchive (input) {
      released.push(input.archiveId)
      return { status: 'released', released: true }
    },
    async retainArchiveDiscovery () { return { status: 'retained' } },
    async releaseArchiveDiscovery () { return { status: 'released' } },
    async publishArchivePledge () { return { status: 'published', delivered: 1 } },
    getLocalTransportPeerId: () => b4a.toString(bytes(32, 201), 'hex'),
  }

  return {
    retained,
    released,
    now: () => clock,
    advanceTo (time) { clock = time },
    reservationCount () { return reservations?.reservations?.length ?? 0 },
    boot ({ enabled = true } = {}) {
      const archivePolicy = createArchivePolicy({
        capacityBytes: CAPACITY_BYTES,
        now: () => clock,
        repository: {
          async load () { return reservations },
          async save (state) { reservations = state },
        },
        participation: () => ({ archiveEligible: true }),
      })
      return createPermissionlessArchiveNetwork({
        keyPair: volunteer,
        scopedNetwork,
        archivePolicy,
        participationRepository: {
          async load () { return participation },
          async save (state) { participation = state },
        },
        enabled,
        capacityBytes: CAPACITY_BYTES,
        maxRequestBytes: CAPACITY_BYTES,
        acceptanceProbability: 1,
        now: () => clock,
        authorizeRequest: async request => ({
          accepted: true,
          requestedBytes: request.body.requestedBytes,
          ranges: request.body.ranges,
        }),
        authorizeConsumerVisibility: async () => true,
      })
    },
  }
}

function requestFor (host, { nonce, retentionUntil }) {
  return createArchiveRequest({
    requesterId: requester.publicKey,
    publicationId,
    renditionId,
    ranges,
    requestedBytes: REQUESTED_BYTES,
    retentionUntil,
    expiresAt: host.now() + 30_000,
    issuedAt: host.now(),
    nonce,
    keyPair: requester,
  })
}

test('custody survives a restart: the reservation and the retained range both come back', async (t) => {
  const host = createHost()

  const first = host.boot()
  await first.ready
  const accepted = await first.ingestRequest(
    requestFor(host, { nonce: 'restart-survives', retentionUntil: host.now() + 3_600_000 }).envelope,
  )
  t.is(accepted.status, 'accepted')
  t.is(first.getStatus().reservedBytes, REQUESTED_BYTES, 'the promise costs real capacity')
  const pledgeId = accepted.pledge.pledgeId
  await first.close()

  t.is(host.reservationCount(), 1, 'and it is written down before the process goes away')

  host.retained.length = 0
  const second = host.boot()
  await second.ready

  t.is(second.getStatus().reservedBytes, REQUESTED_BYTES, 'the reservation is still held after reboot')
  t.is(second.getStatus().acceptedRequests, 1, 'and the pledge is live again, not merely remembered')
  t.ok(host.retained.includes(pledgeId), 're-retaining the range is what makes the promise real again')
  await second.close()
})

test('custody whose retention has lapsed is released at boot, not silently carried', async (t) => {
  const host = createHost()
  const retentionUntil = host.now() + 60_000

  const first = host.boot()
  await first.ready
  const accepted = await first.ingestRequest(
    requestFor(host, { nonce: 'restart-lapses', retentionUntil }).envelope,
  )
  t.is(accepted.status, 'accepted')
  await first.close()

  // The relay was off for longer than it ever promised to keep the bytes.
  host.advanceTo(retentionUntil + 1)
  host.released.length = 0

  const second = host.boot()
  await second.ready
  t.is(second.getStatus().reservedBytes, 0, 'an expired promise stops occupying the disk')
  t.ok(host.released.includes(accepted.pledge.pledgeId), 'and the retained range is actually let go')
  t.is(host.reservationCount(), 0, 'the ledger is cleared rather than left to grow')
  t.is(second.getStatus().availableBytes, CAPACITY_BYTES, 'capacity is fully available again')
  await second.close()
})

test('booting with participation disabled releases persisted custody instead of keeping it', async (t) => {
  const host = createHost()

  const first = host.boot()
  await first.ready
  const accepted = await first.ingestRequest(
    requestFor(host, { nonce: 'restart-disabled', retentionUntil: host.now() + 3_600_000 }).envelope,
  )
  t.is(accepted.status, 'accepted')
  await first.close()

  host.released.length = 0
  const second = host.boot({ enabled: false })
  await second.ready

  // An operator who turned re-seeding off has withdrawn the offer. Continuing
  // to hold the bytes would be occupying their disk for a promise the node is
  // no longer willing to answer a challenge for.
  t.is(second.getStatus().reservedBytes, 0, 'a disabled archivist holds no reservation')
  t.ok(host.released.includes(accepted.pledge.pledgeId), 'persisted custody is released on the way up')
  t.is(host.reservationCount(), 0, 'and the ledger no longer claims the space')
  await second.close()
})
