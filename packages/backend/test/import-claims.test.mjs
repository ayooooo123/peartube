import test from 'brittle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import { MultiWriterChannel } from '../src/channel/multi-writer-channel.js'
import { deriveImportClaimantId, normalizeImportClaim } from '../src/channel/structured-content.js'

const DAY = 24 * 60 * 60 * 1000
const WRITER_A = '11'.repeat(32)
const WRITER_B = '22'.repeat(32)
const WRITER_C = '33'.repeat(32)
const WRITER_D = '44'.repeat(32)

async function withChannel (t) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-import-claims-'))
  const store = new Corestore(dir)
  await store.ready()
  const channel = new MultiWriterChannel(store, { key: null, encrypt: false })
  await channel.ready()
  t.teardown(async () => {
    await channel.close().catch(() => {})
    await store.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })
  return channel
}

function claim ({ identityKey = 'youtube:episode:source-1', writerKey = WRITER_A, jobId = 'job-1', ...rest } = {}) {
  return {
    identityKey,
    claimantId: deriveImportClaimantId(writerKey, jobId),
    writerKey,
    jobId,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  }
}

async function replicateClaim (channel, value) {
  await channel.db.insert('@peartubeChannel/importClaims', normalizeImportClaim(value))
  await channel.db.flush()
}

async function replicateRelease (channel, value, releasedAt) {
  await replicateClaim(channel, { ...value, state: 'released', updatedAt: releasedAt, releasedAt })
}

test('import claims validate authenticated identity, retry idempotently, and reject contender grinding', async (t) => {
  const channel = await withChannel(t)
  const writerKey = channel.localWriterKeyHex
  const first = claim({ writerKey, state: 'reserved', createdAt: 10, updatedAt: 10 })

  await channel.putImportClaim(first)
  await channel.putImportClaim({ ...first, videoId: 'draft-a', updatedAt: 20 })
  await t.exception(
    channel.putImportClaim({ ...first, videoId: 'draft-a-retry', updatedAt: 30 }),
    /videoId.*cannot change/i,
    'durable claim video ID cannot be replaced once assigned',
  )
  const claims = await channel.listImportClaims(first.identityKey)
  t.is(claims.length, 1, 'one durable job upserts one row')
  t.is(claims[0].claimantId, first.claimantId)
  t.is(claims[0].videoId, 'draft-a')
  t.is(claims[0].createdAt, 10, 'retry preserves durable creation time')

  await t.exception(
    channel.putImportClaim({ ...first, claimantId: '00'.repeat(32) }),
    /claimantId must match/,
    'mismatched derived claimant ID fails',
  )
  await t.exception(
    channel.putImportClaim({ ...first, claimantId: 'malformed' }),
    /claimantId/,
    'malformed claimant ID fails',
  )
  await t.exception(
    channel.putImportClaim(claim({ identityKey: 'forged-writer', writerKey: WRITER_A, jobId: 'forged-job' })),
    /authenticated writer/i,
    'caller cannot forge an arbitrary writer identity',
  )
  const remote = claim({ identityKey: 'remote-owned', writerKey: WRITER_B, jobId: 'remote-owned' })
  await replicateClaim(channel, remote)
  await t.exception(
    channel.releaseImportClaim(remote.identityKey, remote.claimantId, 25),
    /authenticated writer/i,
    'caller cannot release another writer claim',
  )
  await t.exception(
    channel.putImportClaim(claim({ identityKey: first.identityKey, writerKey, jobId: 'job-2' })),
    /active import claim.*same writer/i,
    'same writer cannot grind another active contender',
  )
  const concurrentIdentity = 'youtube:episode:concurrent'
  const concurrent = await Promise.allSettled([
    channel.putImportClaim(claim({ identityKey: concurrentIdentity, writerKey, jobId: 'concurrent-1' })),
    channel.putImportClaim(claim({ identityKey: concurrentIdentity, writerKey, jobId: 'concurrent-2' })),
  ])
  t.is(concurrent.filter((result) => result.status === 'fulfilled').length, 1, 'check and insert are serialized')
  t.is((await channel.listImportClaims(concurrentIdentity)).length, 1)

  const publishedFinal = claim({
    identityKey: 'youtube:episode:published-final',
    writerKey,
    jobId: 'published-final',
    videoId: 'final-video',
    state: 'published',
    createdAt: 10,
    updatedAt: 40,
  })
  await channel.putImportClaim(publishedFinal)
  const staleResult = await channel.putImportClaim({
    ...publishedFinal,
    state: 'reserved',
    updatedAt: 30,
  })
  t.is(staleResult.state, 'published', 'stale retry cannot regress published state')
  t.is(staleResult.videoId, 'final-video', 'stale retry preserves final video payload')
  t.is(staleResult.updatedAt, 40)
  await t.exception(
    channel.putImportClaim({
      ...publishedFinal,
      videoId: 'draft-video',
      state: 'reserved',
      updatedAt: 30,
    }),
    /videoId.*cannot change/i,
    'stale published-final to reserved-draft retry cannot replace payload',
  )
  await t.exception(
    channel.putImportClaim({
      ...publishedFinal,
      state: 'reserved',
      updatedAt: 40,
    }),
    /equal timestamp.*conflict/i,
    'equal-timestamp conflicting payload is rejected',
  )
  await channel.releaseImportClaim(first.identityKey, first.claimantId, 30)
  await channel.releaseImportClaim(first.identityKey, first.claimantId, 5)
  const retainedRelease = (await channel.listImportClaims(first.identityKey))
    .find((entry) => entry.claimantId === first.claimantId)
  t.is(retainedRelease.releasedAt, 30, 'stale release retry cannot shorten retention')
  t.is(retainedRelease.updatedAt, 30, 'release update time remains monotonic')
  const futureUpdated = claim({
    identityKey: 'future-updated',
    writerKey,
    jobId: 'future-updated',
    state: 'reserved',
    updatedAt: 100,
  })
  await channel.putImportClaim(futureUpdated)
  await t.exception(
    channel.releaseImportClaim(futureUpdated.identityKey, futureUpdated.claimantId, 50),
    /cannot precede/,
    'first release cannot predate the durable claim update',
  )
  await t.exception(
    channel.putImportClaim({ ...futureUpdated, state: 'released', releasedAt: 50 }),
    /releasedAt cannot precede/,
    'put cannot bypass first-release timestamp ordering',
  )
  await channel.putImportClaim(first)
  t.is((await channel.listImportClaims(first.identityKey))[0].state, 'released', 'stale retry cannot resurrect a tombstone')
  await channel.putImportClaim(claim({ identityKey: first.identityKey, writerKey, jobId: 'job-2' }))
  t.is((await channel.listImportClaims(first.identityKey)).length, 2, 'released tombstone permits a later durable job')
})

test('claim resolution ignores released rows and converges independent of insertion order', async (t) => {
  const channel = await withChannel(t)
  const identityKey = 'youtube:episode:partitioned'
  const a = claim({ identityKey, writerKey: channel.localWriterKeyHex, jobId: 'partition-a', state: 'reserved' })
  const b = claim({ identityKey, writerKey: WRITER_B, jobId: 'partition-b', state: 'reserved' })
  const [expected, losingClaim] = [a, b].sort((left, right) => left.claimantId.localeCompare(right.claimantId))
  expected.videoId = 'winning-draft'
  losingClaim.videoId = 'losing-draft'

  await channel.putImportClaim(a)
  await replicateClaim(channel, b)
  t.is((await channel.resolveImportClaim(identityKey)).claimantId, expected.claimantId, 'lowest claimant wins')

  t.is(losingClaim.videoId, 'losing-draft')
  await channel.addVideo({
    id: losingClaim.videoId,
    title: 'Partition loser',
    publicationState: 'replicationPending',
  })
  t.is((await channel.getVideo(losingClaim.videoId)).title, 'Partition loser', 'losing draft remains logically private-readable')
  t.absent(await channel.publicBee.getVideo(losingClaim.videoId), 'losing pending draft is not public')

  if (expected.writerKey === channel.localWriterKeyHex) {
    await channel.releaseImportClaim(identityKey, expected.claimantId, 100)
  } else {
    await replicateRelease(channel, expected, 100)
  }
  t.is((await channel.resolveImportClaim(identityKey)).claimantId, losingClaim.claimantId, 'released winner never wins')

  const reverseIdentity = 'youtube:episode:partitioned-reverse'
  const reverseA = { ...a, identityKey: reverseIdentity }
  const reverseB = { ...b, identityKey: reverseIdentity }
  await replicateClaim(channel, reverseB)
  await replicateClaim(channel, reverseA)
  t.is(
    (await channel.resolveImportClaim(reverseIdentity)).claimantId,
    expected.claimantId,
    'partition-like convergence is insertion-order independent',
  )
})

test('released claim compaction enforces retention, active jobs, and winner safety', async (t) => {
  const channel = await withChannel(t)
  const now = 50 * DAY

  const writerKey = channel.localWriterKeyHex
  const defaultOld = claim({ identityKey: 'default-old', writerKey, jobId: 'default-old', state: 'reserved' })
  const defaultRecent = claim({ identityKey: 'default-recent', writerKey, jobId: 'default-recent', state: 'reserved' })
  const activeOld = claim({ identityKey: 'active-old', writerKey, jobId: 'active-job', state: 'reserved' })
  await channel.putImportClaim(defaultOld)
  await channel.putImportClaim(defaultRecent)
  await channel.putImportClaim(activeOld)
  await channel.releaseImportClaim(defaultOld.identityKey, defaultOld.claimantId, now - 31 * DAY)
  await channel.releaseImportClaim(defaultRecent.identityKey, defaultRecent.claimantId, now - 29 * DAY)
  await channel.releaseImportClaim(activeOld.identityKey, activeOld.claimantId, now - 40 * DAY)

  let activePredicateAwaited = false
  const firstResult = await channel.compactReleasedImportClaims({
    now,
    isJobActive: async (jobId) => {
      await Promise.resolve()
      if (jobId === 'active-job') activePredicateAwaited = true
      return jobId === 'active-job'
    },
  })
  t.is(firstResult.deleted, 1, 'default retention is 30 days')
  t.ok(activePredicateAwaited, 'active-job predicate is awaited')
  t.is((await channel.listImportClaims('default-old')).length, 0)
  t.is((await channel.listImportClaims('default-recent')).length, 1, 'recent tombstone is retained')
  t.is((await channel.listImportClaims('active-old')).length, 1, 'active job protects old tombstone')

  const configurable = claim({ identityKey: 'configurable', writerKey, jobId: 'configurable', state: 'reserved' })
  await channel.putImportClaim(configurable)
  await channel.releaseImportClaim(configurable.identityKey, configurable.claimantId, now - 2_000)
  t.is((await channel.compactReleasedImportClaims({
    now,
    retentionMs: 1_000,
    isJobActive: async (jobId) => jobId !== 'configurable',
  })).deleted, 1)
  t.is((await channel.listImportClaims('configurable')).length, 0, 'configurable retention is honored')

  const unsafeReleased = claim({ identityKey: 'unsafe-contender', writerKey, jobId: 'unsafe-released', state: 'reserved' })
  const unsafeContender = claim({ identityKey: 'unsafe-contender', writerKey: WRITER_B, jobId: 'unsafe-active', state: 'reserved' })
  await channel.putImportClaim(unsafeReleased)
  await replicateClaim(channel, unsafeContender)
  await channel.releaseImportClaim(unsafeReleased.identityKey, unsafeReleased.claimantId, now - 40 * DAY)
  await channel.compactReleasedImportClaims({ now, isJobActive: async () => false })
  t.is((await channel.listImportClaims('unsafe-contender')).length, 2, 'unpublished contender blocks tombstone compaction')

  const safeReleased = claim({ identityKey: 'published-winner', writerKey, jobId: 'safe-released', state: 'reserved' })
  const published = claim({ identityKey: 'published-winner', writerKey: WRITER_D, jobId: 'published', state: 'published' })
  const [winner, loser] = [safeReleased, published].sort((left, right) => left.claimantId.localeCompare(right.claimantId))
  const publishedWinner = { ...winner, state: 'published' }
  const releasedLoser = { ...loser, state: 'reserved' }
  if (publishedWinner.writerKey === writerKey) await channel.putImportClaim(publishedWinner)
  else await replicateClaim(channel, publishedWinner)
  if (releasedLoser.writerKey === writerKey) await channel.putImportClaim(releasedLoser)
  else await replicateClaim(channel, releasedLoser)
  if (releasedLoser.writerKey === writerKey) {
    await channel.releaseImportClaim(releasedLoser.identityKey, releasedLoser.claimantId, now - 40 * DAY)
  } else {
    await replicateRelease(channel, releasedLoser, now - 40 * DAY)
  }
  await channel.compactReleasedImportClaims({ now, isJobActive: async () => false })
  t.is((await channel.listImportClaims('published-winner')).length, 1, 'published resolved winner makes old loser tombstone safe')
  t.is((await channel.resolveImportClaim('published-winner')).state, 'published')

  await t.exception(channel.compactReleasedImportClaims({ now: Number.NaN, isJobActive: async () => false }), /now/)
  await t.exception(channel.compactReleasedImportClaims({ now, retentionMs: -1, isJobActive: async () => false }), /retentionMs/)
  await t.exception(channel.compactReleasedImportClaims({ now }), /isJobActive/)
})
