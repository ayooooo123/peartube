import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import crypto from 'hypercore-crypto'

import {
  INDEXER_CORE_NAME,
  INDEXES,
  createCatalogIngestor,
  COLLECTIONS,
  createIndexerStore,
  openIndexerDatabase,
} from '../src/indexer/index.js'
import {
  PUBLISHER_RECORD_TYPES,
  createPublisherAuthorizationState,
  createPublisherNamespaceDescriptor,
  encodePublisherAuthorizationState,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
} from '../src/publisher/index.js'
import {
  createPublicationManifest,
  createRenditionDescriptor,
  createStaticAssetManifest,
  encodePublicationManifest,
} from '../src/assets/index.js'
import {
  attachSignedEnvelopeSignature,
  prepareSignedEnvelope,
  signedRecordSignaturePreimage,
} from '../src/records/index.js'

const hex = value => b4a.toString(value, 'hex')
const bytes = value => b4a.from(value, 'hex')
const high = () => ({ maxRetainedBytes: 20_000_000, maxRows: 2_000 })
const limits = () => ({
  global: high(),
  shard: high(),
  publisher: high(),
  trustClasses: { untrusted: high(), trusted: high() },
})

function signPublication(source, manifest, sequence) {
  const prepared = prepareSignedEnvelope({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: source.descriptor.publisherId,
    signerKey: source.device.publicKey,
    policyEpoch: 0,
    issuerSequence: sequence,
    signedAt: 100,
    canonicalBody: encodePublisherOperationBody(PUBLISHER_RECORD_TYPES.PUBLICATION, {
      publicationId: bytes(manifest.publicationId),
      manifestId: bytes(manifest.body.manifestId),
      payload: encodePublicationManifest(manifest),
    }),
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(
    prepared,
    crypto.sign(signedRecordSignaturePreimage(prepared), source.device.secretKey),
  )
}

function publication(source, sequence, title) {
  const asset = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 100 + sequence),
    blockLength: 1,
    byteLength: 1_000 + sequence,
  })
  const rendition = createRenditionDescriptor({
    purpose: 'original',
    format: 'video/mp4',
    core: {
      kind: asset.kind,
      key: asset.key,
      treeHash: asset.treeHash,
      length: asset.length,
      byteLength: asset.byteLength,
      blockSize: asset.blockSize,
      assetId: asset.assetId,
    },
  })
  return createPublicationManifest({
    publisherId: source.descriptor.publisherId,
    sequence,
    title,
    description: title,
    renditions: [rendition],
    artwork: [],
    subtitles: [],
    claims: [],
    provenance: [{ type: 'upload', source: 'fork-repair-test' }],
    keyPair: source.device,
    signedAt: 100,
  })
}

async function putPublication(source, sequence, title) {
  const manifest = publication(source, sequence, title)
  await source.view.put(
    `projection/publication/${manifest.publicationId}`,
    encodePublisherCatalogFrame(signPublication(source, manifest, sequence)),
  )
  return manifest
}

async function addSource(catalogStore, seed) {
  const core = catalogStore.get({ name: `fork-repair-source-${seed}` })
  const view = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'binary', extension: false })
  await view.ready()
  const root = crypto.keyPair(b4a.alloc(32, seed))
  const device = crypto.keyPair(b4a.alloc(32, seed + 20))
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: view.key,
  })
  const authorization = createPublisherAuthorizationState(descriptor)
  const writer = {
    writerKey: b4a.from(view.key),
    signerKey: b4a.from(device.publicKey),
    capabilities: ['claim', 'publish'],
    firstAcceptedSequence: 1,
    lastAcceptedSequence: Number.MAX_SAFE_INTEGER,
    expiresAt: Number.MAX_SAFE_INTEGER,
    admissionNonce: b4a.alloc(32, seed + 40),
    admissionPolicyEpoch: 0,
    revocation: null,
  }
  authorization.writers.set(hex(writer.writerKey), writer)
  authorization.signers.set(hex(writer.signerKey), writer)
  await view.put('state/descriptor', encodePublisherNamespaceDescriptor(descriptor))
  await view.put('state/authorization', encodePublisherAuthorizationState(authorization))
  return {
    view,
    descriptor,
    device,
    publisherId: hex(descriptor.publisherId),
    catalog: {
      key: view.key,
      view,
      async update() {},
      async getViewHead() { return { fork: view.core.fork, length: view.version } },
      async getAuthorizationState() { return authorization },
    },
  }
}

async function publisherRows(store, publisherId) {
  const db = await openIndexerDatabase(store, { name: INDEXER_CORE_NAME })
  try {
    const rows = {}
    for (const [name, index] of Object.entries(INDEXES.publisherPrefix)) {
      rows[name] = await db.find(index, { publisherId }).toArray()
    }
    return rows
  } finally {
    await db.close()
  }
}

function totals(rows) {
  return Object.values(rows).reduce((result, values) => {
    result.count += values.length
    result.bytes += values.reduce((sum, value) => sum + b4a.byteLength(JSON.stringify(value)), 0)
    return result
  }, { count: 0, bytes: 0 })
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peartube-fork-repair-'))
  const catalogStore = new Corestore(path.join(directory, 'catalog'))
  const indexStore = new Corestore(path.join(directory, 'index'))
  await Promise.all([catalogStore.ready(), indexStore.ready()])
  const index = await createIndexerStore({ store: indexStore, limits: limits() })
  const primary = await addSource(catalogStore, 21)
  const other = await addSource(catalogStore, 22)
  t.teardown(async () => {
    await index.close().catch(() => {})
    await primary.view.close().catch(() => {})
    await other.view.close().catch(() => {})
    await Promise.all([catalogStore.close().catch(() => {}), indexStore.close().catch(() => {})])
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { index, indexStore, primary, other }
}

function ingest(index, source) {
  return createCatalogIngestor({ index, now: () => 1_000 }).ingest({
    publisherId: source.publisherId,
    descriptor: source.descriptor,
    catalog: source.catalog,
  })
}

test('a Hyperbee fork with reordered replacement projections repairs only that publisher', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Old first')
  await putPublication(f.primary, 2, 'Old second')
  await putPublication(f.other, 1, 'Other publisher')
  await ingest(f.index, f.primary)
  await ingest(f.index, f.other)
  const otherBefore = await publisherRows(f.indexStore, f.other.publisherId)
  const otherTotals = totals(otherBefore)
  const stateLength = f.primary.view.version - 2

  await f.primary.view.core.truncate(stateLength)
  await putPublication(f.primary, 2, 'Replacement second')
  await putPublication(f.primary, 1, 'Replacement first')
  const repaired = await ingest(f.index, f.primary)

  t.is(repaired.status, 'repaired')
  t.is(repaired.mode, 'repair')
  t.is(repaired.reason, 'source-fork-changed')
  const primaryRows = await publisherRows(f.indexStore, f.primary.publisherId)
  t.alike(primaryRows.publicationProjections.map(row => row.normalizedTitle).sort(), ['replacement first', 'replacement second'])
  t.alike(totals(await publisherRows(f.indexStore, f.other.publisherId)), otherTotals)
})

test('an unavailable prior source version falls back only for the proven stale-history error', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Before unavailable history')
  await ingest(f.index, f.primary)
  await putPublication(f.primary, 2, 'After unavailable history')
  const checkout = f.primary.view.checkout.bind(f.primary.view)
  f.primary.view.checkout = (...args) => {
    const pinned = checkout(...args)
    pinned.createDiffStream = () => ({
      async *[Symbol.asyncIterator]() {
        const error = new Error('snapshot not available')
        error.code = 'SNAPSHOT_NOT_AVAILABLE'
        throw error
      },
    })
    return pinned
  }

  const repaired = await ingest(f.index, f.primary)
  t.is(repaired.status, 'repaired')
  t.is(repaired.reason, 'source-history-unavailable')
  t.is((await publisherRows(f.indexStore, f.primary.publisherId)).publicationProjections.length, 2)

  await putPublication(f.primary, 3, 'Unrelated failure')
  f.primary.view.checkout = (...args) => {
    const pinned = checkout(...args)
    pinned.createDiffStream = () => ({
      async *[Symbol.asyncIterator]() { throw new Error('unrelated source failure') },
    })
    return pinned
  }
  await t.exception(ingest(f.index, f.primary), /unrelated source failure/)
})

test('a stored catalog epoch discontinuity repairs through the publisher-wide cursor surface', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Epoch repair')
  await ingest(f.index, f.primary)
  const prior = await f.index.getPublisherSourceCursor({ publisherId: f.primary.publisherId })
  const storedRows = await publisherRows(f.indexStore, f.primary.publisherId)
  const rows = Object.entries(storedRows).flatMap(([shortName, records]) => (
    shortName === 'sourceCursors'
      ? []
      : records.map(record => ({ collection: COLLECTIONS[shortName], record }))
  ))
  const otherEpoch = { ...prior, catalogEpoch: prior.catalogEpoch + 1 }
  await f.index.replacePublisherSlice({
    publisherId: f.primary.publisherId,
    rows,
    cursor: otherEpoch,
    expectedCursor: prior,
  })
  let publisherCursorReads = 0
  const wrappedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor(input) {
      publisherCursorReads++
      return f.index.getPublisherSourceCursor(input)
    },
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    replacePublisherSlice: input => f.index.replacePublisherSlice(input),
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
  }

  const repaired = await ingest(wrappedIndex, f.primary)
  t.is(publisherCursorReads, 1)
  t.is(repaired.status, 'repaired')
  t.is(repaired.reason, 'source-identity-changed')
  t.is(repaired.cursor.catalogEpoch, prior.catalogEpoch)
  t.alike(await f.index.getPublisherSourceCursor({ publisherId: f.primary.publisherId }), repaired.cursor)
})

test('repair replacement compares the exact prior cursor and cannot overwrite a concurrent publisher update', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Before CAS race')
  await putPublication(f.other, 1, 'Other publisher')
  await ingest(f.index, f.primary)
  await ingest(f.index, f.other)
  const otherBefore = totals(await publisherRows(f.indexStore, f.other.publisherId))
  const previous = await f.index.getSourceCursor({ publisherId: f.primary.publisherId, catalogEpoch: 0 })
  await f.primary.view.core.truncate(f.primary.view.version - 1)
  await putPublication(f.primary, 2, 'Repair contender')
  let replacements = 0
  const racingIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
    async replacePublisherSlice(input) {
      replacements++
      const winner = { ...input.cursor, viewVersion: input.cursor.viewVersion + 1, sourceHead: input.cursor.sourceHead + 1 }
      await f.index.replacePublisherSlice({ ...input, cursor: winner, expectedCursor: previous })
      return f.index.replacePublisherSlice(input)
    },
  }

  await t.exception(ingest(racingIndex, f.primary), /source cursor changed since ingestion preparation/)
  t.is(replacements, 1)
  t.alike(totals(await publisherRows(f.indexStore, f.other.publisherId)), otherBefore)
})

test('retry after a committed repair whose success was not observed is idempotent', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Before lost acknowledgement')
  await ingest(f.index, f.primary)
  await f.primary.view.core.truncate(f.primary.view.version - 1)
  await putPublication(f.primary, 2, 'After lost acknowledgement')
  let failAfterCommit = true
  const unobservedIndex = {
    getSourceCursor: input => f.index.getSourceCursor(input),
    getPublisherSourceCursor: input => f.index.getPublisherSourceCursor(input),
    getPublisherAdmissionLimits: input => f.index.getPublisherAdmissionLimits(input),
    applyPublisherChanges: input => f.index.applyPublisherChanges(input),
    async replacePublisherSlice(input) {
      const result = await f.index.replacePublisherSlice(input)
      if (failAfterCommit) {
        failAfterCommit = false
        throw new Error('connection closed before repair result')
      }
      return result
    },
  }

  await t.exception(ingest(unobservedIndex, f.primary), /connection closed before repair result/)
  const committedRows = await publisherRows(f.indexStore, f.primary.publisherId)
  const committedTotals = totals(committedRows)
  const committedUsage = await f.index.snapshotUsage()
  await f.index.close()
  const reopened = await createIndexerStore({ store: f.indexStore, limits: limits() })
  t.teardown(() => reopened.close().catch(() => {}))
  const retried = await ingest(reopened, f.primary)
  t.is(retried.mode, 'noop')
  t.alike(totals(await publisherRows(f.indexStore, f.primary.publisherId)), committedTotals)
  t.alike(await reopened.snapshotUsage(), committedUsage)
  t.is((await publisherRows(f.indexStore, f.primary.publisherId)).publicationProjections.length, 1)
})

test('explicit repair validates a bounded reason and replaces the publisher slice', async t => {
  const f = await fixture(t)
  await putPublication(f.primary, 1, 'Explicit repair')
  const catalogIngestor = createCatalogIngestor({ index: f.index, now: () => 1_000 })
  for (const reason of [null, undefined, 'operator supplied free form text']) {
    let invalidReasonError = null
    try {
      await catalogIngestor.repairPublisher({
        publisherId: f.primary.publisherId,
        descriptor: f.primary.descriptor,
        catalog: f.primary.catalog,
        reason,
      })
    } catch (error) {
      invalidReasonError = error
    }
    t.ok(invalidReasonError)
    t.ok(/repair reason/.test(invalidReasonError.message))
  }
  const result = await catalogIngestor.repairPublisher({
    publisherId: f.primary.publisherId,
    descriptor: f.primary.descriptor,
    catalog: f.primary.catalog,
    reason: 'source-identity-changed',
  })
  t.alike({ status: result.status, mode: result.mode, reason: result.reason }, {
    status: 'repaired',
    mode: 'repair',
    reason: 'source-identity-changed',
  })
})
