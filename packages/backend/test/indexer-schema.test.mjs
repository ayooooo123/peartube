import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Corestore from 'corestore'
import HypercoreID from 'hypercore-id-encoding'
import {
  COLLECTIONS,
  INDEXES,
  INDEX_KEY_FIELDS,
  INDEX_SCHEMA_LIMITS,
  openIndexerDatabase,
} from '../src/indexer/schema.js'

const PUBLISHER_A = '11'.repeat(32)
const PUBLISHER_B = '22'.repeat(32)
const PUBLISHER_C = '33'.repeat(32)
const SOURCE = 'source-1'
const RECORD_ID = '55'.repeat(32)
const PUBLICATION_ID = '66'.repeat(32)
const MANIFEST_ID = '77'.repeat(32)
const RENDITION_ID = '88'.repeat(32)
const ASSET_ID = '99'.repeat(32)
const REPLACEMENT_MANIFEST_ID = 'aa'.repeat(32)
const SOURCE_2 = 'source-2'
const OTHER_RECORD_ID = 'ab'.repeat(32)
const OTHER_PUBLICATION_ID = 'bc'.repeat(32)
const OTHER_RENDITION_ID = 'cd'.repeat(32)
const OTHER_ASSET_ID = 'de'.repeat(32)

async function withDatabase(run) {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-index-schema-'))
  const store = new Corestore(dir)
  await store.ready()
  const db = await openIndexerDatabase(store, { name: 'indexer-test' })
  try {
    await run(db, store)
  } finally {
    await db.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const rows = (stream) => stream.toArray()

function records(publisherId = PUBLISHER_A) {
  return {
    sourceRecords: {
      publisherId, catalogEpoch: 1, recordId: RECORD_ID, recordType: 'publication',
      sourceSequence: 1, canonicalEnvelope: Buffer.from([0, 1, 2, 255]),
      projectionState: 'active', ingestedAt: 10,
    },
    sourceCursors: {
      publisherId, catalogEpoch: 1, catalogBootstrapKey: '33'.repeat(32),
      viewFork: 0, viewVersion: 1, sourceHead: 4,
      lastVerifiedDescriptor: 'descriptor-1',
    },
    externalReferenceProjections: {
      publisherId, sourceRecordRef: SOURCE, namespace: 'imdb',
      normalizedIdentifier: 'tt123', entityKind: 'work', entityId: 'work-1', evidenceWeight: 1,
    },
    publicationProjections: {
      publisherId, sourceRecordRef: SOURCE, publicationId: PUBLICATION_ID,
      workEntityId: 'work-1', normalizedTitle: 'a title', releaseYear: 2020,
      manifestId: MANIFEST_ID, provenanceSummary: 'publisher claim',
    },
    renditionProjections: {
      publisherId, sourceRecordRef: SOURCE, renditionId: RENDITION_ID, assetId: ASSET_ID,
      format: 'mp4', codec: 'avc1', dimensions: '1920x1080', mediaFeatures: 'hdr,en', byteLength: 42,
    },
    availabilityProjections: {
      publisherId, sourceRecordRef: SOURCE, assetId: ASSET_ID, observerId: '44'.repeat(32),
      observedSeeders: 2, observedCompleteSeeders: 1, observedAt: 100, expiresAt: 200,
      availabilityState: 'available',
    },
    relationshipEdges: {
      publisherId, sourceRecordRef: SOURCE, relationType: 'work-rendition',
      fromId: 'work-1', toId: 'rendition-1',
    },
  }
}

test('all seven normalized collections round trip publisher and source attribution', async () => {
  await withDatabase(async (db) => {
    const expected = records()
    assert.deepEqual(Object.keys(COLLECTIONS).sort(), Object.keys(expected).sort())
    for (const [shortName, record] of Object.entries(expected)) {
      await db.insert(COLLECTIONS[shortName], record)
      assert.deepEqual(await db.get(COLLECTIONS[shortName], record), record)
    }
  })
})

test('exact search dimensions federate matching rows across publishers', async () => {
  await withDatabase(async (db) => {
    const a = records(PUBLISHER_A)
    const b = records(PUBLISHER_B)
    const nonmatching = records(PUBLISHER_C)
    Object.assign(nonmatching.externalReferenceProjections, {
      normalizedIdentifier: 'tt999',
      entityId: 'work-other',
    })
    Object.assign(nonmatching.publicationProjections, {
      publicationId: OTHER_PUBLICATION_ID,
      workEntityId: 'work-other',
    })
    Object.assign(nonmatching.renditionProjections, {
      renditionId: OTHER_RENDITION_ID,
      assetId: OTHER_ASSET_ID,
    })
    nonmatching.availabilityProjections.assetId = OTHER_ASSET_ID
    Object.assign(nonmatching.relationshipEdges, {
      relationType: 'publication-work',
      fromId: 'publication-other',
      toId: 'work-other',
    })

    const collectionNames = [
      'externalReferenceProjections',
      'publicationProjections',
      'renditionProjections',
      'availabilityProjections',
      'relationshipEdges',
    ]
    for (const data of [a, b, nonmatching]) {
      for (const name of collectionNames) await db.insert(COLLECTIONS[name], data[name])
    }

    const cases = [
      [INDEXES.externalReferenceExact, { namespace: 'imdb', normalizedIdentifier: 'tt123' }],
      [INDEXES.entityExact, { entityKind: 'work', entityId: 'work-1' }],
      [INDEXES.publicationExact, { publicationId: PUBLICATION_ID }],
      [INDEXES.publicationByWork, { workEntityId: 'work-1' }],
      [INDEXES.assetExact, { assetId: ASSET_ID }],
      [INDEXES.renditionExact, { renditionId: RENDITION_ID }],
      [INDEXES.availabilityByAsset, { assetId: ASSET_ID }],
      [INDEXES.relationshipByType, { relationType: 'work-rendition' }],
      [INDEXES.relationshipByFrom, { relationType: 'work-rendition', fromId: 'work-1' }],
      [INDEXES.relationshipByTo, { relationType: 'work-rendition', toId: 'rendition-1' }],
    ]
    for (const [index, selector] of cases) {
      const found = await rows(db.find(index, selector))
      assert.deepEqual(found.map((row) => row.publisherId).sort(), [PUBLISHER_A, PUBLISHER_B], index)
    }
  })
})

test('normalized title and title-token selectors stay bounded across publishers', async () => {
  await withDatabase(async (db) => {
    const publication = records().publicationProjections
    for (const publisherId of [PUBLISHER_A, PUBLISHER_B]) {
      await db.insert(COLLECTIONS.publicationProjections, { ...publication, publisherId })
      await db.insert(COLLECTIONS.relationshipEdges, {
        publisherId, sourceRecordRef: SOURCE, relationType: 'title-token',
        fromId: 'tit', toId: publication.workEntityId,
      })
    }
    await db.insert(COLLECTIONS.publicationProjections, {
      ...publication,
      publisherId: PUBLISHER_C,
      normalizedTitle: 'something else',
    })
    await db.insert(COLLECTIONS.relationshipEdges, {
      publisherId: PUBLISHER_C, sourceRecordRef: SOURCE, relationType: 'title-token',
      fromId: 'oth', toId: 'work-other',
    })

    const titleRows = await rows(db.find(INDEXES.normalizedTitle, {
      normalizedTitle: 'a title',
      limit: 10,
    }))
    assert.deepEqual(titleRows.map((row) => row.publisherId).sort(), [PUBLISHER_A, PUBLISHER_B])

    const tokenRows = await rows(db.find(INDEXES.tokenPrefix, {
      relationType: 'title-token',
      fromId: 'tit',
      limit: 10,
    }))
    assert.deepEqual(tokenRows.map((row) => row.publisherId).sort(), [PUBLISHER_A, PUBLISHER_B])
  })
})

test('publisher-prefix indexes enumerate complete isolated deletion candidates', async () => {
  await withDatabase(async (db) => {
    const a = records(PUBLISHER_A)
    const b = records(PUBLISHER_B)
    const secondA = {
      sourceRecords: { ...a.sourceRecords, recordId: OTHER_RECORD_ID },
      sourceCursors: { ...a.sourceCursors, catalogEpoch: 2 },
      externalReferenceProjections: { ...a.externalReferenceProjections, sourceRecordRef: SOURCE_2 },
      publicationProjections: { ...a.publicationProjections, sourceRecordRef: SOURCE_2 },
      renditionProjections: { ...a.renditionProjections, sourceRecordRef: SOURCE_2 },
      availabilityProjections: { ...a.availabilityProjections, sourceRecordRef: SOURCE_2 },
      relationshipEdges: { ...a.relationshipEdges, sourceRecordRef: SOURCE_2 },
    }

    for (const name of Object.keys(a)) {
      await db.insert(COLLECTIONS[name], a[name])
      await db.insert(COLLECTIONS[name], secondA[name])
      await db.insert(COLLECTIONS[name], b[name])

      const candidates = await rows(db.find(INDEXES.publisherPrefix[name], { publisherId: PUBLISHER_A }))
      assert.equal(candidates.length, 2, name)
      assert.ok(candidates.every((row) => row.publisherId === PUBLISHER_A), name)
      await db.validatedTransaction(async (tx) => {
        for (const candidate of candidates) await tx.delete(COLLECTIONS[name], candidate)
      })
      assert.equal((await rows(db.find(INDEXES.publisherPrefix[name], { publisherId: PUBLISHER_A }))).length, 0, name)
      const retained = await rows(db.find(INDEXES.publisherPrefix[name], { publisherId: PUBLISHER_B }))
      assert.equal(retained.length, 1, name)
      assert.equal(retained[0].publisherId, PUBLISHER_B, name)
    }
  })
})

test('direct selectors adapt to actual index prefixes while explicit ranges pass through unchanged', async () => {
  await withDatabase(async (db) => {
    const a = records(PUBLISHER_A).relationshipEdges
    const b = records(PUBLISHER_B).relationshipEdges
    await db.insert(COLLECTIONS.relationshipEdges, a)
    await db.insert(COLLECTIONS.relationshipEdges, b)

    const exact = await rows(db.find(INDEXES.relationshipByType, {
      relationType: 'work-rendition', publisherId: PUBLISHER_A, limit: 10, reverse: false,
    }))
    assert.equal(exact.length, 1)
    assert.equal(exact[0].publisherId, PUBLISHER_A)

    const range = {
      relationType: 'work-rendition',
      publisherId: PUBLISHER_A,
    }
    const ranged = await rows(db.find(INDEXES.relationshipByType, {
      gte: range,
      lte: range,
      limit: 10,
    }))
    assert.equal(ranged.length, 1)
    assert.equal(ranged[0].publisherId, PUBLISHER_A)
    assert.throws(() => db.find(INDEXES.relationshipByType, {
      relationType: 'work-rendition',
      gte: range,
    }), /cannot be mixed/)

    await db.validatedTransaction(async (tx) => {
      const found = await rows(tx.find(INDEXES.relationshipByType, {
        relationType: 'work-rendition',
      }))
      assert.equal(found.length, 2)
      assert.equal((await tx.findOne(INDEXES.relationshipByType, {
        relationType: 'work-rendition',
      })).relationType, 'work-rendition')
    })
  })
})

test('public insert rejects duplicate complete keys and invalid publisher identities', async () => {
  await withDatabase(async (db) => {
    const record = records().relationshipEdges
    await db.insert(COLLECTIONS.relationshipEdges, record)
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, record), /already exists/)
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, { ...record, publisherId: undefined }), /publisherId/)
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, { ...record, publisherId: 'AA'.repeat(32) }), /publisherId/)
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, { ...record, publisherId: 'abc' }), /publisherId/)
  })
})

test('UTF-8 limits are measured in bytes, including multibyte input', async () => {
  await withDatabase(async (db) => {
    const record = records().relationshipEdges
    const within = 'é'.repeat(INDEX_SCHEMA_LIMITS.maxEntityIdBytes / 2)
    await db.insert(COLLECTIONS.relationshipEdges, { ...record, toId: within })
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, {
      ...record, sourceRecordRef: 'source-2', toId: `${within}é`,
    }), /toId.*byte limit/)
    await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, {
      ...record, sourceRecordRef: 'x'.repeat(INDEX_SCHEMA_LIMITS.maxSourceRecordRefBytes + 1),
    }), /sourceRecordRef.*byte limit/)
  })
})

test('buffer, uint and enum state validation is strict and envelopes round trip unchanged', async () => {
  await withDatabase(async (db) => {
    const record = records().sourceRecords
    await db.insert(COLLECTIONS.sourceRecords, record)
    const stored = await db.get(COLLECTIONS.sourceRecords, record)
    assert.deepEqual(stored.canonicalEnvelope, record.canonicalEnvelope)
    await assert.rejects(db.insert(COLLECTIONS.sourceRecords, { ...record, recordId: '01'.repeat(32), canonicalEnvelope: 'bytes' }), /canonicalEnvelope/)
    await assert.rejects(db.insert(COLLECTIONS.sourceRecords, {
      ...record, recordId: '02'.repeat(32), canonicalEnvelope: Buffer.alloc(INDEX_SCHEMA_LIMITS.maxEnvelopeBytes + 1),
    }), /canonicalEnvelope.*byte limit/)
    await assert.rejects(db.insert(COLLECTIONS.sourceRecords, { ...record, recordId: '03'.repeat(32), sourceSequence: -1 }), /sourceSequence/)
    await assert.rejects(db.insert(COLLECTIONS.sourceRecords, { ...record, recordId: '04'.repeat(32), projectionState: 'unknown' }), /projectionState/)
    await assert.rejects(db.insert(COLLECTIONS.availabilityProjections, {
      ...records().availabilityProjections, observedSeeders: 1.5,
    }), /observedSeeders/)
    await assert.rejects(db.insert(COLLECTIONS.availabilityProjections, {
      ...records().availabilityProjections, availabilityState: 'maybe',
    }), /availabilityState/)
  })
})

test('every protocol ID field requires canonical lowercase 64-hex', async () => {
  await withDatabase(async (db) => {
    const cases = [
      [COLLECTIONS.sourceRecords, records().sourceRecords, 'recordId'],
      [COLLECTIONS.publicationProjections, records().publicationProjections, 'publicationId'],
      [COLLECTIONS.publicationProjections, records().publicationProjections, 'manifestId'],
      [COLLECTIONS.renditionProjections, records().renditionProjections, 'renditionId'],
      [COLLECTIONS.renditionProjections, records().renditionProjections, 'assetId'],
      [COLLECTIONS.availabilityProjections, records().availabilityProjections, 'assetId'],
    ]
    for (const [collection, record, name] of cases) {
      await assert.rejects(db.insert(collection, { ...record, [name]: 'AA'.repeat(32) }), new RegExp(name))
      await assert.rejects(db.insert(collection, { ...record, [name]: 'abc' }), new RegExp(name))
    }
  })
})

test('every direct index selector requires a non-empty contiguous prefix of its selected key', async () => {
  await withDatabase(async (db) => {
    const a = records(PUBLISHER_A)
    const b = records(PUBLISHER_B)
    for (const name of Object.keys(a)) {
      await db.insert(COLLECTIONS[name], a[name])
      await db.insert(COLLECTIONS[name], b[name])
    }

    const firstFieldSelectors = {
      [COLLECTIONS.sourceRecords]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.sourceCursors]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.externalReferenceProjections]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.publicationProjections]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.renditionProjections]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.availabilityProjections]: { publisherId: PUBLISHER_A },
      [COLLECTIONS.relationshipEdges]: { publisherId: PUBLISHER_A },
      [INDEXES.externalReferenceExact]: { namespace: 'imdb' },
      [INDEXES.entityExact]: { entityKind: 'work' },
      [INDEXES.publicationExact]: { publicationId: PUBLICATION_ID },
      [INDEXES.publicationByWork]: { workEntityId: 'work-1' },
      [INDEXES.normalizedTitle]: { normalizedTitle: 'a title' },
      [INDEXES.assetExact]: { assetId: ASSET_ID },
      [INDEXES.renditionExact]: { renditionId: RENDITION_ID },
      [INDEXES.availabilityByAsset]: { assetId: ASSET_ID },
      [INDEXES.relationshipByType]: { relationType: 'work-rendition' },
      [INDEXES.relationshipByFrom]: { relationType: 'work-rendition' },
      [INDEXES.relationshipByTo]: { relationType: 'work-rendition' },
      [INDEXES.tokenPrefix]: { relationType: 'work-rendition' },
      [INDEXES.publisherPrefix.sourceRecords]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.sourceCursors]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.externalReferenceProjections]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.publicationProjections]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.renditionProjections]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.availabilityProjections]: { publisherId: PUBLISHER_A },
      [INDEXES.publisherPrefix.relationshipEdges]: { publisherId: PUBLISHER_A },
    }
    assert.deepEqual(Object.keys(firstFieldSelectors).sort(), Object.keys(INDEX_KEY_FIELDS).sort())
    for (const [index, selector] of Object.entries(firstFieldSelectors)) {
      assert.ok((await rows(db.find(index, selector))).length > 0, index)
    }

    assert.throws(() => db.find(INDEXES.externalReferenceExact, { limit: 1 }), (error) => {
      assert.match(error.message, /non-empty index prefix/)
      assert.doesNotMatch(error.message, /publisherId/)
      return true
    })
    assert.throws(() => db.find(`${COLLECTIONS.sourceRecords}-missing`, { publisherId: PUBLISHER_A }), /unknown index/)
    assert.throws(() => db.find(`${COLLECTIONS.sourceRecords}-missing`, {
      gte: { publisherId: PUBLISHER_A },
    }), /unknown index/)
    assert.throws(() => db.find(INDEXES.entityExact, {
      entityKind: 'work',
      publisherId: PUBLISHER_A,
    }), /beginning with entityKind/)
    assert.throws(() => db.find(INDEXES.publicationExact, {
      publicationId: PUBLICATION_ID,
      publisherId: PUBLISHER_A,
      sourceRecordRef: SOURCE,
      typo: 'x',
    }), /contiguous/)
    assert.throws(() => db.find(INDEXES.externalReferenceExact, {
      namespace: undefined,
    }), /beginning with namespace/)
  })
})

test('internal transaction seam validates then atomically upserts an admitted source slice', async () => {
  await withDatabase(async (db) => {
    const initial = records().publicationProjections
    await db.insert(COLLECTIONS.publicationProjections, initial)
    await db.validatedTransaction(async (tx) => {
      await tx.upsert(COLLECTIONS.publicationProjections, { ...initial, manifestId: REPLACEMENT_MANIFEST_ID })
      await tx.upsert(COLLECTIONS.relationshipEdges, records().relationshipEdges)
    })
    assert.equal((await db.get(COLLECTIONS.publicationProjections, initial)).manifestId, REPLACEMENT_MANIFEST_ID)
    assert.ok(await db.get(COLLECTIONS.relationshipEdges, records().relationshipEdges))
  })
})

test('strict create is atomic across surfaces sharing one named core', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-index-schema-race-'))
  const store = new Corestore(dir)
  await store.ready()
  const first = await openIndexerDatabase(store, { name: 'shared-race' })
  const second = await openIndexerDatabase(store, { name: 'shared-race' })
  const base = records().publicationProjections
  try {
    const sameKey = await Promise.allSettled([
      first.insert(COLLECTIONS.publicationProjections, { ...base, manifestId: MANIFEST_ID }),
      second.insert(COLLECTIONS.publicationProjections, { ...base, manifestId: REPLACEMENT_MANIFEST_ID }),
    ])
    assert.equal(sameKey.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(sameKey.filter(({ status }) => status === 'rejected').length, 1)
    assert.match(sameKey.find(({ status }) => status === 'rejected').reason.message, /already exists/)

    await Promise.all([
      first.insert(COLLECTIONS.relationshipEdges, { ...records().relationshipEdges, sourceRecordRef: 'distinct-a' }),
      second.insert(COLLECTIONS.relationshipEdges, { ...records().relationshipEdges, sourceRecordRef: 'distinct-b' }),
    ])
    await Promise.all([first.close(), second.close()])

    const reopened = await openIndexerDatabase(store, { name: 'shared-race' })
    const stored = await reopened.get(COLLECTIONS.publicationProjections, base)
    assert.ok(stored.manifestId === MANIFEST_ID || stored.manifestId === REPLACEMENT_MANIFEST_ID)
    assert.ok(await reopened.get(COLLECTIONS.relationshipEdges, { ...records().relationshipEdges, sourceRecordRef: 'distinct-a' }))
    assert.ok(await reopened.get(COLLECTIONS.relationshipEdges, { ...records().relationshipEdges, sourceRecordRef: 'distinct-b' }))
    await reopened.close()
  } finally {
    await first.close()
    await second.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})


test('canonical core serialization covers Corestore sessions and name/key aliases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-index-schema-alias-'))
  const store = new Corestore(dir)
  await store.ready()
  const session = store.session()
  await session.ready()
  try {
    const rootSurface = await openIndexerDatabase(store, { name: 'session-alias' })
    const sessionSurface = await openIndexerDatabase(session, { name: 'session-alias' })
    const base = records().publicationProjections
    const sessionRace = await Promise.allSettled([
      rootSurface.insert(COLLECTIONS.publicationProjections, base),
      sessionSurface.insert(COLLECTIONS.publicationProjections, {
        ...base, manifestId: REPLACEMENT_MANIFEST_ID,
      }),
    ])
    assert.equal(sessionRace.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(sessionRace.filter(({ status }) => status === 'rejected').length, 1)
    await Promise.all([
      rootSurface.insert(COLLECTIONS.relationshipEdges, {
        ...records().relationshipEdges, sourceRecordRef: 'session-distinct-a',
      }),
      sessionSurface.insert(COLLECTIONS.relationshipEdges, {
        ...records().relationshipEdges, sourceRecordRef: 'session-distinct-b',
      }),
    ])
    await Promise.all([rootSurface.close(), sessionSurface.close()])

    const locator = store.get({ name: 'name-key-alias' })
    await locator.ready()
    const key = Buffer.from(locator.key)
    const z32 = HypercoreID.encode(key)
    const keyedLocators = [
      ['buffer', key],
      ['hex', key.toString('hex')],
      ['z32', z32],
      ['pear', `pear://${z32}`],
    ]
    await locator.close()

    for (const [index, [label, keyedLocator]] of keyedLocators.entries()) {
      const nameSurface = await openIndexerDatabase(index % 2 === 0 ? store : session, {
        name: 'name-key-alias',
      })
      const keySurface = await openIndexerDatabase(store, { key: keyedLocator })
      const keyedBase = {
        ...base,
        sourceRecordRef: `locator-race-${label}`,
      }
      try {
        const race = await Promise.allSettled([
          nameSurface.insert(COLLECTIONS.publicationProjections, keyedBase),
          keySurface.insert(COLLECTIONS.publicationProjections, {
            ...keyedBase, manifestId: REPLACEMENT_MANIFEST_ID,
          }),
        ])
        assert.equal(race.filter(({ status }) => status === 'fulfilled').length, 1)
        assert.equal(race.filter(({ status }) => status === 'rejected').length, 1)
        assert.match(race.find(({ status }) => status === 'rejected').reason.message, /already exists/)
        await Promise.all([
          nameSurface.insert(COLLECTIONS.relationshipEdges, {
            ...records().relationshipEdges, sourceRecordRef: `locator-distinct-${label}-name`,
          }),
          keySurface.insert(COLLECTIONS.relationshipEdges, {
            ...records().relationshipEdges, sourceRecordRef: `locator-distinct-${label}-key`,
          }),
        ])
      } finally {
        await Promise.all([nameSurface.close(), keySurface.close()])
      }
    }

    await assert.rejects(
      openIndexerDatabase(store, { key: 'not-a-hypercore-locator' }),
      /Invalid Hypercore key/,
    )

    for (const [label, keyedLocator] of keyedLocators) {
      const reopened = await openIndexerDatabase(store, { key: keyedLocator })
      try {
        assert.ok(await reopened.get(COLLECTIONS.relationshipEdges, {
          ...records().relationshipEdges, sourceRecordRef: `locator-distinct-${label}-name`,
        }))
        assert.ok(await reopened.get(COLLECTIONS.relationshipEdges, {
          ...records().relationshipEdges, sourceRecordRef: `locator-distinct-${label}-key`,
        }))
      } finally {
        await reopened.close()
      }
    }
  } finally {
    await session.close()
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('close drains accepted queued work, rejects new work, and shares one close promise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-index-schema-drain-'))
  const store = new Corestore(dir)
  await store.ready()
  const db = await openIndexerDatabase(store, { name: 'drain-close' })
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let entered
  const transactionEntered = new Promise((resolve) => { entered = resolve })
  const accepted = db.validatedTransaction(async (tx) => {
    entered()
    await gate
    await tx.upsert(COLLECTIONS.relationshipEdges, records().relationshipEdges)
  })
  await transactionEntered
  const closeA = db.close()
  const closeB = db.close()
  assert.strictEqual(closeA, closeB)
  let closed = false
  closeA.then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.throws(() => db.find(INDEXES.relationshipByType, { publisherId: PUBLISHER_A }), /closed/)
  await assert.rejects(db.insert(COLLECTIONS.relationshipEdges, {
    ...records().relationshipEdges, sourceRecordRef: 'too-late',
  }), /closed/)
  releaseGate()
  await accepted
  await closeA

  const reopened = await openIndexerDatabase(store, { name: 'drain-close' })
  assert.ok(await reopened.get(COLLECTIONS.relationshipEdges, records().relationshipEdges))
  await reopened.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('closing the index database does not close its caller-owned Corestore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peartube-index-schema-close-'))
  const store = new Corestore(dir)
  await store.ready()
  const db = await openIndexerDatabase(store, { name: 'close-test' })
  await db.close()
  const core = store.get({ name: 'still-open' })
  await core.ready()
  assert.ok(core.key)
  await core.close()
  await store.close()
  rmSync(dir, { recursive: true, force: true })
})
