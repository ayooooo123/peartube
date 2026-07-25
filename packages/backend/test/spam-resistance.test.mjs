import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

import { createBootstrapLocator } from '../src/discovery/bootstrap-protocol.js'
import { createBootstrapManager } from '../src/discovery/bootstrap-manager.js'
import { createIndexFeedPage } from '../src/indexing/feed-contract.js'
import { createIndexFeedManager } from '../src/indexing/feed-manager.js'
import { createLocalMediaIndex } from '../src/indexing/local-index.js'
import { createEntityReference, createMediaClaim } from '../src/media-graph/index.js'
import { createMediaGraphStore } from '../src/media-graph/store.js'
import { createModerationFeedPage } from '../src/moderation/feed-contract.js'
import { createModerationManager } from '../src/moderation/manager.js'

const curatorA = crypto.keyPair(Buffer.alloc(32, 21))
const curatorB = crypto.keyPair(Buffer.alloc(32, 22))
const moderator = crypto.keyPair(Buffer.alloc(32, 23))
const publisherA = crypto.keyPair(Buffer.alloc(32, 24))
const publisherB = crypto.keyPair(Buffer.alloc(32, 25))

const curatorAId = b4a.toString(curatorA.publicKey, 'hex')
const curatorBId = b4a.toString(curatorB.publicKey, 'hex')
const moderatorId = b4a.toString(moderator.publicKey, 'hex')
const publisherAId = b4a.toString(publisherA.publicKey, 'hex')
const publisherBId = b4a.toString(publisherB.publicKey, 'hex')

function indexRecord(id, overrides = {}) {
  return {
    kind: 'publication-reference',
    entityRef: `work:${id}`,
    publicationId: id.padStart(64, '0'),
    publisherId: publisherAId,
    title: `Title ${id}`,
    creator: 'agent:alice',
    collectionId: 'collection:one',
    tags: ['demo'],
    ...overrides,
  }
}

function indexPage(keyPair, cursor, nextCursor, records) {
  return createIndexFeedPage({
    curatorId: b4a.toString(keyPair.publicKey, 'hex'),
    pageCursor: cursor,
    nextCursor,
    records,
    keyPair,
    expiresAt: 100_000,
  })
}

function bootstrapLocator(keyPair, overrides = {}) {
  return createBootstrapLocator({
    publisherId: overrides.publisherId || publisherAId,
    catalogBootstrapKey: overrides.catalogBootstrapKey || 'b'.repeat(64),
    catalogHead: overrides.catalogHead || 'c'.repeat(64),
    catalogEpoch: overrides.catalogEpoch ?? 1,
    authorizationChainDigest: 'd'.repeat(64),
    issuedAt: overrides.issuedAt ?? 10_000,
    expiresAt: 20_000,
    label: overrides.label,
    keyPair,
  })
}

function workRef(id = 'episode-1') {
  return createEntityReference({ entityKind: 'work', namespace: 'spam-test', normalizedIdentifier: id })
}

function collectionRef(id = 'season-1') {
  return createEntityReference({ entityKind: 'collection', namespace: 'issuer-native', issuerRootKey: publisherA.publicKey, issuerLocalId: id })
}

function agentRef(id = 'alice') {
  return createEntityReference({ entityKind: 'agent', namespace: 'issuer-native', issuerRootKey: publisherA.publicKey, issuerLocalId: id })
}

test('index feed budgets are cumulative across pages, fair across indexes, and recover after reset', async (t) => {
  let time = 10
  const manager = createIndexFeedManager({
    now: () => time,
    budgetWindowMs: 100,
    maxRecordsPerSync: 20,
    maxRecordsPerIndexPerWindow: 2,
  })
  manager.subscribe(curatorAId)
  manager.subscribe(curatorBId)

  const pagesA = new Map([
    ['0', indexPage(curatorA, '0', '1', [indexRecord('1')])],
    ['1', indexPage(curatorA, '1', '2', [indexRecord('2')])],
    ['2', indexPage(curatorA, '2', null, [indexRecord('3')])],
  ])
  const first = await manager.syncFeed({ curatorId: curatorAId, fetchPage: async cursor => pagesA.get(cursor) })
  t.is(first.status, 'partial')
  t.is(first.errorCode, 'INDEX_WINDOW_BUDGET_EXCEEDED')
  t.is(first.nextCursor, '2')
  t.is(manager.getRecords().length, 2)

  const retry = await manager.syncFeed({ curatorId: curatorAId, startCursor: '2', fetchPage: async cursor => pagesA.get(cursor) })
  t.is(retry.errorCode, 'INDEX_WINDOW_BUDGET_EXCEEDED')
  t.is(manager.getRecords().length, 2)

  const fair = await manager.syncFeed({
    curatorId: curatorBId,
    fetchPage: async () => indexPage(curatorB, '0', null, [indexRecord('4', { publisherId: publisherBId, collectionId: 'collection:two' })]),
  })
  t.is(fair.status, 'complete')
  t.is(manager.getRecords().length, 3)

  time = 110
  const recovered = await manager.syncFeed({ curatorId: curatorAId, startCursor: '2', fetchPage: async cursor => pagesA.get(cursor) })
  t.is(recovered.status, 'complete')
  t.is(manager.getRecords().length, 4)
})

test('signed index feeds remain subject to local policy and publisher, agent, and collection budgets', async (t) => {
  const policyManager = createIndexFeedManager({ now: () => 10, acceptRecord: record => record.title !== 'unwanted' })
  policyManager.subscribe(curatorAId)
  const unwanted = await policyManager.syncFeed({
    curatorId: curatorAId,
    fetchPage: async () => indexPage(curatorA, '0', null, [indexRecord('5', { title: 'unwanted' })]),
  })
  t.is(unwanted.status, 'rejected')
  t.is(unwanted.errorCode, 'LOCAL_POLICY_REJECTED')
  t.is(policyManager.getRecords().length, 0)

  const boundedPolicyManager = createIndexFeedManager({
    now: () => 10,
    maxRecordsPerSync: 1,
    acceptRecord: () => false,
  })
  boundedPolicyManager.subscribe(curatorAId)
  const boundedUnwanted = await boundedPolicyManager.syncFeed({
    curatorId: curatorAId,
    fetchPage: async () => indexPage(curatorA, '0', null, [indexRecord('12'), indexRecord('13')]),
  })
  t.is(boundedUnwanted.status, 'partial')
  t.is(boundedUnwanted.errorCode, 'SYNC_RECORD_BUDGET_EXCEEDED')
  t.is(boundedUnwanted.nextCursor, '0')
  t.is(boundedPolicyManager.getRecords().length, 0)

  for (const [option, expected] of [
    ['maxRecordsPerPublisherPerWindow', 'PUBLISHER_WINDOW_BUDGET_EXCEEDED'],
    ['maxRecordsPerAgentPerWindow', 'AGENT_WINDOW_BUDGET_EXCEEDED'],
    ['maxRecordsPerCollectionPerWindow', 'COLLECTION_WINDOW_BUDGET_EXCEEDED'],
  ]) {
    const manager = createIndexFeedManager({ now: () => 10, [option]: 1 })
    manager.subscribe(curatorAId)
    const result = await manager.syncFeed({
      curatorId: curatorAId,
      fetchPage: async () => indexPage(curatorA, '0', null, [indexRecord('6'), indexRecord('7')]),
    })
    t.is(result.status, 'partial')
    t.is(result.errorCode, expected)
    t.is(manager.getRecords().length, 1)
  }
})

test('local projection bounds duplicate, fork, collection, and metadata storms without starving independent sources', (t) => {
  let time = 0
  const index = createLocalMediaIndex({
    now: () => time,
    budgetWindowMs: 100,
    maxRecords: 8,
    maxRecordsPerIndexPerWindow: 2,
    maxRecordsPerPublisherPerWindow: 2,
    maxRecordsPerAgentPerWindow: 2,
    maxRecordsPerCollectionPerWindow: 2,
    maxRecordsPerCollection: 2,
    maxMetadataChangesPerEntityPerWindow: 1,
    maxPublicationsPerEntity: 2,
    maxTagsPerEntity: 2,
    maxProvenancePerEntity: 2,
  })
  const poisonIndex = createLocalMediaIndex()
  const cyclicTags = []
  cyclicTags.push(cyclicTags)
  const poisoned = poisonIndex.ingestRecords([{ ...indexRecord('14'), tags: cyclicTags }])
  t.is(poisoned.status, 'rejected')
  t.is(poisoned.errorCode, 'INVALID_INDEX_RECORD')
  t.is(poisonIndex.records().length, 0)

  const first = { ...indexRecord('8'), indexId: 'index:a', sourceId: 'page:1' }
  t.is(index.ingestRecords([first]).status, 'accepted')
  for (let i = 0; i < 20; i++) t.is(index.ingestRecords([first]).status, 'duplicate')
  t.is(index.records().length, 1)

  const fork = index.ingestRecords([{ ...first, sourceId: 'page:2', entityRef: 'work:fork' }])
  t.is(fork.status, 'rejected')
  t.is(fork.errorCode, 'INDEX_RECORD_FORK')
  t.is(index.records().length, 1)

  const rename = index.ingestRecords([{ ...first, sourceId: 'page:3', title: 'Renamed once' }])
  t.is(rename.status, 'accepted')
  const renameStorm = index.ingestRecords([{ ...first, sourceId: 'page:4', title: 'Renamed twice' }])
  t.is(renameStorm.status, 'rejected')
  t.is(renameStorm.errorCode, 'METADATA_WINDOW_BUDGET_EXCEEDED')
  t.is(index.records().length, 1)

  const collectionMember = { ...indexRecord('9'), indexId: 'index:a', sourceId: 'page:5' }
  t.is(index.ingestRecords([collectionMember]).status, 'rejected')
  time = 100
  t.is(index.ingestRecords([collectionMember]).status, 'accepted')
  const hugeCollection = index.ingestRecords([{ ...indexRecord('10'), indexId: 'index:a', sourceId: 'page:6' }])
  t.is(hugeCollection.status, 'rejected')
  t.is(hugeCollection.errorCode, 'COLLECTION_PROJECTION_BUDGET_EXCEEDED')

  const fair = index.ingestRecords([{
    ...indexRecord('11'),
    indexId: 'index:b',
    sourceId: 'page:7',
    publisherId: publisherBId,
    creator: 'agent:bob',
    collectionId: 'collection:two',
  }])
  t.is(fair.status, 'accepted')
  t.ok(index.records().length <= 8)
  const projection = index.search('')
  for (const row of projection) {
    t.ok(row.publications.length <= 2)
    t.ok(row.tags.length <= 2)
    t.ok(row.provenance.length <= 2)
  }
})

test('moderation feed budget cannot be bypassed with repeated page syncs and resets cleanly', async (t) => {
  let time = 10
  const manager = createModerationManager({ now: () => time, budgetWindowMs: 100, maxRecordsPerModeratorPerWindow: 1 })
  manager.subscribe(moderatorId)
  const firstPage = createModerationFeedPage({
    moderatorId,
    pageCursor: '0',
    nextCursor: '1',
    records: [{ action: 'block', targetType: 'publisher', targetId: publisherAId }],
    keyPair: moderator,
    expiresAt: 100_000,
  })
  const secondPage = createModerationFeedPage({
    moderatorId,
    pageCursor: '1',
    nextCursor: null,
    records: [{ action: 'hide', targetType: 'collection', targetId: 'collection:one' }],
    keyPair: moderator,
    expiresAt: 100_000,
  })
  t.is((await manager.syncFeed({ moderatorId, fetchPage: async () => firstPage })).status, 'partial')
  const blocked = await manager.syncFeed({ moderatorId, startCursor: '1', fetchPage: async () => secondPage })
  t.is(blocked.status, 'partial')
  t.is(blocked.errorCode, 'MODERATION_INDEX_WINDOW_BUDGET_EXCEEDED')
  t.is(manager.getRecords().length, 1)
  time = 110
  t.is((await manager.syncFeed({ moderatorId, startCursor: '1', fetchPage: async () => secondPage })).status, 'complete')
  t.is(manager.getRecords().length, 2)
})

test('bootstrap locator budgets bound publisher fork storms, isolate peers, and recover after reset', async (t) => {
  let time = 15_000
  const manager = createBootstrapManager({
    now: () => time,
    trustedSigners: [publisherA.publicKey, publisherB.publicKey],
    budgetWindowMs: 100,
    maxLocatorsPerPeer: 2,
    maxLocatorsPerPublisherPerWindow: 1,
    maxPublishers: 2,
  })
  const first = bootstrapLocator(publisherA, { catalogHead: '1'.repeat(64), issuedAt: 10_000 })
  const fork = bootstrapLocator(publisherA, { catalogHead: '2'.repeat(64), issuedAt: 11_000, catalogEpoch: 2 })
  t.is((await manager.ingestLocator('peer:a', first.envelope)).status, 'accepted')
  const rejected = await manager.ingestLocator('peer:a', fork.envelope)
  t.is(rejected.status, 'rejected')
  t.is(rejected.errorCode, 'PUBLISHER_LOCATOR_WINDOW_BUDGET_EXCEEDED')
  t.is(manager.listLocators().length, 1)

  const independent = bootstrapLocator(publisherB, { publisherId: publisherBId, catalogHead: '3'.repeat(64), issuedAt: 10_000 })
  t.is((await manager.ingestLocator('peer:b', independent.envelope)).status, 'accepted')
  t.is(manager.listLocators().length, 2)

  time = 15_100
  t.is((await manager.ingestLocator('peer:a', fork.envelope)).status, 'accepted')
  t.is(manager.getLocator(publisherAId).catalogHead, '2'.repeat(64))
})

test('bootstrap local policy rejects signed-but-unwanted locators without creating authority', async (t) => {
  const manager = createBootstrapManager({
    now: () => 15_000,
    trustedSigners: [publisherA.publicKey],
    acceptLocator: body => body.label !== 'spam',
  })
  const result = await manager.ingestLocator('peer:a', bootstrapLocator(publisherA, { label: 'spam' }).envelope)
  t.is(result.status, 'rejected')
  t.is(result.errorCode, 'LOCAL_POLICY_REJECTED')
  t.alike(manager.listLocators(), [])
})

test('media graph bounds publisher, agent, collection, metadata, fork, and duplicate projection pressure', async (t) => {
  let time = 0
  const store = createMediaGraphStore({
    now: () => time,
    trustedSigners: [publisherA.publicKey, publisherB.publicKey],
    budgetWindowMs: 100,
    maxClaims: 8,
    maxClaimsPerPublisherPerWindow: 3,
    maxClaimsPerAgentPerWindow: 1,
    maxClaimsPerCollectionPerWindow: 2,
    maxClaimsPerCollection: 2,
    maxMetadataClaimsPerSubjectPerWindow: 1,
  })
  const metadata = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef('m1')], payload: { title: 'One' }, keyPair: publisherA, issuerSequence: 1 })
  t.is((await store.ingestClaim(metadata.envelope)).status, 'accepted')
  for (let i = 0; i < 20; i++) t.is((await store.ingestClaim(metadata.envelope)).status, 'duplicate')
  t.is(store.getClaims().length, 1)

  const sequenceFork = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef('m2')], payload: { title: 'Fork' }, keyPair: publisherA, issuerSequence: 1 })
  const forkResult = await store.ingestClaim(sequenceFork.envelope)
  t.is(forkResult.status, 'rejected')
  t.is(forkResult.errorCode, 'ISSUER_SEQUENCE_FORK')

  const rename = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef('m1')], payload: { title: 'Two' }, keyPair: publisherA, issuerSequence: 2 })
  const renameResult = await store.ingestClaim(rename.envelope)
  t.is(renameResult.status, 'rejected')
  t.is(renameResult.errorCode, 'METADATA_WINDOW_BUDGET_EXCEEDED')

  const collection = collectionRef()
  for (let i = 0; i < 2; i++) {
    const membership = createMediaClaim({
      claimType: 'CollectionMembershipClaim',
      subjectRefs: [collection],
      payload: { collectionRef: collection, memberRef: workRef(`member-${i}`), memberRole: 'episode', position: { episode: i }, insertionId: `member-${i}` },
      keyPair: publisherA,
      issuerSequence: i + 3,
    })
    t.is((await store.ingestClaim(membership.envelope)).status, 'accepted')
  }
  time = 100
  const collectionPoison = createMediaClaim({
    claimType: 'CollectionMembershipClaim',
    subjectRefs: [collection],
    payload: { collectionRef: collection, memberRef: workRef('member-3'), memberRole: 'episode', position: { episode: 3 }, insertionId: 'member-3' },
    keyPair: publisherA,
    issuerSequence: 5,
  })
  const collectionResult = await store.ingestClaim(collectionPoison.envelope)
  t.is(collectionResult.status, 'rejected')
  t.is(collectionResult.errorCode, 'COLLECTION_PROJECTION_BUDGET_EXCEEDED')
  t.is(store.getClaimsByCollection(collection.entityId).length, 2)

  const agent = agentRef()
  const contribution = i => createMediaClaim({
    claimType: 'ContributionClaim',
    subjectRefs: [workRef(`credit-${i}`)],
    payload: { agentRef: agent, subjectRef: workRef(`credit-${i}`), role: 'actor' },
    keyPair: publisherB,
    issuerSequence: i + 1,
  })
  t.is((await store.ingestClaim(contribution(0).envelope)).status, 'accepted')
  const agentStorm = await store.ingestClaim(contribution(1).envelope)
  t.is(agentStorm.status, 'rejected')
  t.is(agentStorm.errorCode, 'AGENT_WINDOW_BUDGET_EXCEEDED')
  t.ok(store.getClaims().length <= 8)
})

test('media graph bounds metadata bytes and retraction storms while allowing progress after reset', async (t) => {
  let time = 0
  const metadataStore = createMediaGraphStore({ trustedSigners: [publisherA.publicKey], maxMetadataBytes: 32 })
  const oversized = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef('large')], payload: { title: 'x'.repeat(64) }, keyPair: publisherA, issuerSequence: 1 })
  const oversizedResult = await metadataStore.ingestClaim(oversized.envelope)
  t.is(oversizedResult.status, 'rejected')
  t.is(oversizedResult.errorCode, 'METADATA_TOO_LARGE')
  t.is(metadataStore.getClaims().length, 0)

  const store = createMediaGraphStore({
    now: () => time,
    trustedSigners: [publisherA.publicKey],
    budgetWindowMs: 100,
    maxRetractionsPerPublisherPerWindow: 1,
  })
  const original = createMediaClaim({ claimType: 'EntityMetadataClaim', subjectRefs: [workRef('retract')], payload: { title: 'Original' }, keyPair: publisherA, issuerSequence: 1 })
  await store.ingestClaim(original.envelope)
  const retract = sequence => createMediaClaim({
    claimType: 'RetractionClaim',
    subjectRefs: [workRef('retract')],
    payload: { targetClaimIds: [original.claimId], reason: `reason-${sequence}` },
    keyPair: publisherA,
    issuerSequence: sequence,
  })
  t.is((await store.ingestClaim(retract(2).envelope)).status, 'accepted')
  const storm = await store.ingestClaim(retract(3).envelope)
  t.is(storm.status, 'rejected')
  t.is(storm.errorCode, 'RETRACTION_WINDOW_BUDGET_EXCEEDED')
  t.is(store.getClaims().length, 2)
  time = 100
  t.is((await store.ingestClaim(retract(3).envelope)).status, 'accepted')
  t.is(store.getClaims().length, 3)
})
