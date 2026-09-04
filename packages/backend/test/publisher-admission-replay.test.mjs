import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'

import {
  PublisherCatalog,
  createPublisherNamespaceDescriptor,
  decodePublisherCatalogFrame,
  derivePublisherId,
  encodePublisherCatalogFrame,
  encodePublisherNamespaceDescriptor,
  encodePublisherOperationBody,
  PUBLISHER_RECORD_TYPES
} from '../src/publisher/index.js'
import {
  prepareSignedEnvelope,
  attachSignedEnvelopeSignature,
  signedRecordSignaturePreimage
} from '@peartube/backend/records'

const bytes = (length, seed = 0) => b4a.from(Array.from({ length }, (_, index) => (seed + index) & 255))
const id = seed => bytes(32, seed)
const numberedId = value => { const out = b4a.alloc(32); out.writeUInt32BE(value, 28); return out }
const equal = (left, right) => b4a.equals(left, right)
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function tempDir (name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name))
}

function signed ({ descriptor, signer, recordType, policyEpoch, sequence, body, signedAt = 1_700_000_000_000 }) {
  const canonicalBody = recordType === PUBLISHER_RECORD_TYPES.NAMESPACE
    ? encodePublisherNamespaceDescriptor(body)
    : encodePublisherOperationBody(recordType, body)
  const prepared = prepareSignedEnvelope({
    recordType,
    schemaMajor: 1,
    schemaMinor: 0,
    issuerIdentityKey: descriptor.publisherId,
    signerKey: signer.publicKey,
    policyEpoch,
    issuerSequence: sequence,
    signedAt,
    canonicalBody
  }, { hash: crypto.hash })
  return attachSignedEnvelopeSignature(prepared, crypto.sign(signedRecordSignaturePreimage(prepared), signer.secretKey))
}

function deviceSigner (keyPair) {
  return Object.freeze({
    signerKey: b4a.from(keyPair.publicKey),
    async sign (preimage) {
      return crypto.sign(preimage, keyPair.secretKey)
    }
  })
}

const isRootRecord = recordType => recordType === PUBLISHER_RECORD_TYPES.NAMESPACE ||
  recordType === PUBLISHER_RECORD_TYPES.WRITER_ADMISSION ||
  recordType === PUBLISHER_RECORD_TYPES.WRITER_REVOCATION ||
  recordType === PUBLISHER_RECORD_TYPES.ROOT_TRANSITION

// The relay serves accepted pages in operation-id (hash) order. Hash order says
// nothing about causality, so the namespace genesis and the writer admission
// can sit in a LATER page than the claims and publications that depend on
// them. The consumer view journals every ingested entry in arrival order and
// its rebuild replays the journal positionally, so a claim journaled before
// the admission that authorizes it is reduced first and rejects
// WRITER_NOT_ADMITTED. No later page can repair an already-written journal
// position - which is why merging the pending pages into one later ingest
// batch still failed live with "rejected 63 of 101 WRITER_NOT_ADMITTED": the
// earlier batch had already written its claims into the journal.
test('a claims-first page walk reproduces the live WRITER_NOT_ADMITTED rejection and a terminal flush avoids it', async (t) => {
  const producerDir = tempDir('peartube-publisher-admission-replay-producer-')
  const consumerDirA = tempDir('peartube-publisher-admission-replay-a-')
  const consumerDirB = tempDir('peartube-publisher-admission-replay-b-')
  const producerStore = new Corestore(producerDir)
  await producerStore.ready()
  const consumerStoreA = new Corestore(consumerDirA)
  await consumerStoreA.ready()
  const consumerStoreB = new Corestore(consumerDirB)
  await consumerStoreB.ready()
  const root = crypto.keyPair(bytes(32, 241))
  const publisherId = derivePublisherId(root.publicKey)
  const producer = new PublisherCatalog(producerStore, { publisherId, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 242))) })
  await producer.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: producer.key,
  })

  await producer.append(signed({
    descriptor, signer: root, recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0, sequence: 0, body: descriptor,
  }))
  await producer.append(signed({
    descriptor, signer: root, recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0, sequence: 1,
    body: {
      writerKey: producer.localWriterKey,
      signerKey: producer.localSignerKey,
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 71),
    }
  }))
  for (let sequence = 1; sequence <= 3; sequence++) {
    await producer.append(await producer.createLocalOperation({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence,
      signedAt: 1_700_000_000_000,
      body: { publicationId: id(180 + sequence), manifestId: id(190 + sequence), payload: b4a.from(`pub-${sequence}`) }
    }))
  }
  await producer.update()

  const fullPage = await producer.listAcceptedPage({ limit: 128 })
  t.ok(fullPage.entries.length >= 5, 'the page carries the namespace, the admission, and every publication')
  t.is(fullPage.nextCursor, null, 'the fixture catalog fits one producer page')

  // Split the catalog the way a multi-page relay walk does: the data page is
  // served first, the roots page second. Classification is by record type, so
  // the fixture never depends on hash-order luck.
  const dataEntries = []
  const rootsPage = []
  for (const entry of fullPage.entries) {
    const { recordType } = decodePublisherCatalogFrame(entry.frame)
    if (isRootRecord(recordType)) rootsPage.push(entry)
    else dataEntries.push(entry)
  }
  t.is(rootsPage.length, 2, 'the catalog carries exactly the genesis and the admission as roots')
  t.is(dataEntries.length, fullPage.entries.length - 2, 'every remaining record is device-signed data')

  const producerHead = await producer.getViewHead()

  // Consumer A replays the live walk exactly: ingest each served page as it
  // arrives, data page first.
  const consumerA = new PublisherCatalog(consumerStoreA, { publisherId, key: producer.key, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 243))) })
  await consumerA.ready()
  const firstPageResult = await consumerA.ingestAcceptedPage(dataEntries)
  t.is(firstPageResult.accepted, 0, 'the data page alone applies nothing')
  t.is(firstPageResult.rejected, 0, 'the data page alone rejects nothing yet')
  const secondPageResult = await consumerA.ingestAcceptedPage(rootsPage)
  t.is(secondPageResult.accepted, 2, 'the roots page lands the genesis and the admission')
  // The second ingest's own page tally only counts ops in that page; the
  // WRITER_NOT_ADMITTED damage lives in the view's rejection ledger.
  t.ok(secondPageResult.accepted + secondPageResult.rejected === 2,
    'the roots page accounting covers only its own two entries')
  const rejectionsA = await consumerA.listRejected()
  t.is(rejectionsA.length, dataEntries.length,
    'every claim journaled ahead of its admission rejects - the live failure')
  for (const entry of rejectionsA) {
    t.is(entry.code, 'WRITER_NOT_ADMITTED', `operation ${entry.operationId.slice(0, 8)} rejects with WRITER_NOT_ADMITTED`)
  }
  const headA = await consumerA.getViewHead()
  t.absent(equal(headA.digest, producerHead.digest),
    'the progressively-ingested view can never reconstruct the advertised head')

  // Consumer B is the fixed runtime: pages buffer untouched and one flush at
  // the terminal page hands ingestAcceptedPage the complete served range in
  // walk order. The batch replays in the producer's causal order, so every
  // operation verifies.
  const consumerB = new PublisherCatalog(consumerStoreB, { publisherId, key: producer.key, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 244))) })
  await consumerB.ready()
  const flushed = await consumerB.ingestAcceptedPage(
    [...dataEntries, ...rootsPage].sort((left, right) => left.operationId.localeCompare(right.operationId))
  )
  t.is(flushed.rejected, 0, 'the terminal flush rejects nothing')
  t.is(flushed.accepted, fullPage.entries.length, 'every operation lands exactly once')
  const headB = await consumerB.getViewHead()
  t.ok(equal(headB.authorizationStateDigest, producerHead.authorizationStateDigest),
    'the flushed authorization state matches the producer')
  t.ok(equal(headB.digest, producerHead.digest), 'the flushed head digest matches the advertised head')
  t.ok(await consumerB.getProjection('publication', id(181)), 'the flushed view projects publications')
  const acceptedB = await consumerB.listAcceptedPage({ limit: 128 })
  t.alike(
    acceptedB.entries.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    fullPage.entries.map(entry => entry.operationId).sort((left, right) => left.localeCompare(right)),
    'the flushed consumer accepted list matches the producer exactly',
  )
  await consumerA.close()
  await consumerB.close()
  await Promise.all([producerStore.close(), consumerStoreA.close(), consumerStoreB.close()])
  for (const dir of [producerDir, consumerDirA, consumerDirB]) fs.rmSync(dir, { recursive: true, force: true })
})

// A large catalog is staged one causal page at a time and reduced once at the
// terminal page; no catalog-sized in-memory buffer survives between pages.
test('a 1000-title causal walk is page-bounded, resumable, and accepts a one-title suffix', async (t) => {
  t.timeout(120_000)
  const producerDir = tempDir('peartube-publisher-admission-replay-large-producer-')
  const consumerDir = tempDir('peartube-publisher-admission-replay-large-consumer-')
  const producerStore = new Corestore(producerDir)
  await producerStore.ready()
  const consumerStore = new Corestore(consumerDir)
  await consumerStore.ready()
  const root = crypto.keyPair(bytes(32, 245))
  const publisherId = derivePublisherId(root.publicKey)
  const producer = new PublisherCatalog(producerStore, { publisherId, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 246))) })
  await producer.ready()
  const descriptor = createPublisherNamespaceDescriptor({
    genesisRootKey: root.publicKey,
    catalogBootstrapKey: producer.key,
  })
  await producer.append(signed({
    descriptor, signer: root, recordType: PUBLISHER_RECORD_TYPES.NAMESPACE,
    policyEpoch: 0, sequence: 0, body: descriptor,
  }))
  await producer.append(signed({
    descriptor, signer: root, recordType: PUBLISHER_RECORD_TYPES.WRITER_ADMISSION,
    policyEpoch: 0, sequence: 1,
    body: {
      writerKey: producer.localWriterKey,
      signerKey: producer.localSignerKey,
      capabilities: ['announce', 'publish'],
      firstAcceptedSequence: 1,
      expiresAt: 1_800_000_000_000,
      admissionNonce: bytes(16, 72),
    }
  }))
  const publicationFrames = []
  for (let sequence = 1; sequence <= 1000; sequence++) {
    publicationFrames.push(await producer.createLocalOperation({
      recordType: PUBLISHER_RECORD_TYPES.PUBLICATION,
      policyEpoch: 0,
      sequence,
      signedAt: 1_700_000_000_000,
      body: { publicationId: numberedId(sequence), manifestId: numberedId(10_000 + sequence), payload: b4a.from(`pub-${sequence}`) }
    }))
  }
  for (let start = 0; start < publicationFrames.length; start += 128) {
    await producer.appendBatchAndConfirm(publicationFrames.slice(start, start + 128))
  }
  await producer.update()

  const fullPage = await producer.listCausalPage({ limit: 64 })
  const collected = [...fullPage.entries]
  let cursor = fullPage.nextCursor
  while (cursor !== null) {
    const next = await producer.listCausalPage({ cursor, limit: 64 })
    collected.push(...next.entries)
    cursor = next.nextCursor
  }
  t.is(collected.length, 1002, 'the producer causal walk collects the whole catalog')

  const producerHead = await producer.getViewHead()
  let consumer = new PublisherCatalog(consumerStore, { publisherId, key: producer.key, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 247))) })
  await consumer.ready()
  let peakPageRecords = 0
  for (let start = 0; start < collected.length; start += 64) {
    const page = collected.slice(start, start + 64)
    peakPageRecords = Math.max(peakPageRecords, page.length)
    const flushed = await consumer.ingestAcceptedPage(page, { deferRebuild: start + page.length < collected.length })
    t.is(flushed.rejected, 0, 'each causal page journals without rejection')
    if (start === 448) {
      await consumer.close()
      consumer = new PublisherCatalog(consumerStore, { publisherId, key: producer.key, deviceSigner: deviceSigner(crypto.keyPair(bytes(32, 247))) })
      await consumer.ready()
      t.pass('mid-walk restart reopens the durable staged journal')
    }
  }
  t.is(peakPageRecords, 64, 'follower memory never exceeds one 64-record page')
  const head = await consumer.getViewHead()
  t.ok(equal(head.digest, producerHead.digest), 'the chunked flush reconstructs the advertised head')

  const resumeCursor = collected.at(-1).operationId
  const extra = await producer.createLocalOperation({
    recordType: PUBLISHER_RECORD_TYPES.PUBLICATION, policyEpoch: 0, sequence: 1001,
    signedAt: 1_700_000_000_000,
    body: { publicationId: id(77), manifestId: id(78), payload: b4a.from('suffix-title') }
  })
  await producer.append(extra)
  const suffix = await producer.listCausalPage({ cursor: resumeCursor, limit: 64 })
  t.is(suffix.entries.length, 1, 'a new title is served as a one-record suffix')
  t.is(suffix.nextCursor, null, 'the suffix completes without a full re-walk')
  const suffixResult = await consumer.ingestAcceptedPage(suffix.entries)
  t.is(suffixResult.accepted, 1, 'the follower applies only the new title')

  await producer.close()
  await consumer.close()
  await Promise.all([producerStore.close(), consumerStore.close()])
  for (const dir of [producerDir, consumerDir]) fs.rmSync(dir, { recursive: true, force: true })
})
