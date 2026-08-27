import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'

import { createImmutableRenditionWriter } from '../src/assets/rendition-writer.js'
import { createBufferSourceReader, createOneShotSourceReader } from '../src/assets/source-reader.js'

function bytes(value, length) {
  return b4a.alloc(length, value)
}

async function storedCoreCount(store) {
  let count = 0
  for await (const _ of store.list()) count++
  return count
}

function liveSessionCount(store) {
  return store.sessions.list().filter((session) => !session.closed).length
}

test('rendition writer requires a store and reader and embeds the real static descriptor', async (t) => {
  const leftDirectory = mkdtempSync(join(tmpdir(), 'peartube-rendition-left-'))
  const rightDirectory = mkdtempSync(join(tmpdir(), 'peartube-rendition-right-'))
  const storeA = new Corestore(leftDirectory)
  const storeB = new Corestore(rightDirectory)
  const writer = createImmutableRenditionWriter()
  const chunks = [bytes(1, 8), bytes(2, 8)]

  t.teardown(async () => {
    await Promise.all([storeA.close(), storeB.close()])
    rmSync(leftDirectory, { recursive: true, force: true })
    rmSync(rightDirectory, { recursive: true, force: true })
  })

  await t.exception(() => writer.writeRendition({
    store: storeA,
    reader: createBufferSourceReader(b4a.concat(chunks)),
    purpose: 'original',
    format: 'video/mp4',
  }), /initialize/)
  await writer.initialize()
  await t.exception(() => writer.writeRendition({
    reader: createBufferSourceReader(b4a.concat(chunks)),
    purpose: 'original',
    format: 'video/mp4',
  }), /store/)
  await t.exception(() => writer.writeRendition({
    store: storeA,
    purpose: 'original',
    format: 'video/mp4',
  }), /reader/)

  const first = await writer.writeRendition({
    store: storeA,
    reader: createBufferSourceReader(b4a.concat(chunks)),
    purpose: 'original',
    format: 'video/mp4',
    segments: [
      { timeStartMs: 0, durationMs: 1000, byteStart: 0, byteEnd: 8, independent: true },
      { timeStartMs: 1000, durationMs: 1000, byteStart: 8, byteEnd: 16, independent: true },
    ],
  })
  const second = await writer.writeRendition({
    store: storeB,
    reader: createBufferSourceReader(b4a.concat(chunks)),
    purpose: 'original',
    format: 'video/mp4',
    segments: first.segmentIndex.entries,
  })

  t.ok(first.sealed)
  t.ok(first.readOnly)
  t.is(first.staticAsset.kind, 'static-prologue-v1')
  t.is(first.staticAsset.assetId, second.staticAsset.assetId)
  t.is(first.descriptor.core.key, first.staticAsset.assetId)
  t.is(first.descriptor.core.treeHash, first.staticAsset.treeHash.toString('hex'))
  t.is(first.descriptor.core.length, first.staticAsset.length)
  t.is(first.descriptor.core.byteLength, 16)
  t.is(first.descriptor.segmentIndex.entryCount, 2)
  t.is(first.descriptor.renditionId, second.descriptor.renditionId)
  t.absent(first.core.secretKey)
  await t.exception(first.core.append(b4a.from('forbidden')))
})
test('rendition writer accepts explicit multi-segment bounds against realized bytes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-rendition-segments-'))
  const store = new Corestore(directory)
  const writer = createImmutableRenditionWriter()
  await writer.initialize()

  t.teardown(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const result = await writer.writeRendition({
    store,
    reader: createBufferSourceReader(b4a.concat([bytes(3, 6), bytes(4, 6)])),
    purpose: 'original',
    format: 'video/mp4',
    segments: [
      { timeStartMs: 0, durationMs: 500, byteStart: 0, byteEnd: 6, independent: true },
      { timeStartMs: 500, durationMs: 500, byteStart: 6, byteEnd: 12, independent: true },
    ],
  })

  t.is(result.staticAsset.byteLength, 12)
  t.is(result.segmentIndex.mediaByteLength, 12)
  t.is(result.segmentIndex.entryCount, 2)
  t.alike(result.segmentIndex.entries.map(entry => [entry.byteStart, entry.byteEnd]), [[0, 6], [6, 12]])
  await result.core.close()
})


test('rendition writer releases write state and staging storage after cancellation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-rendition-cancel-'))
  const store = new Corestore(directory)
  const writer = createImmutableRenditionWriter()
  await writer.initialize()
  const controller = new AbortController()

  t.teardown(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function *source() {
    yield bytes(7, 16)
    controller.abort()
    yield bytes(8, 16)
  }

  await t.exception(() => writer.writeRendition({
    store,
    reader: createOneShotSourceReader({
      source: source(),
      identity: { kind: 'etag', value: 'cancelled-rendition' },
      byteLength: 32,
    }),
    purpose: 'original',
    format: 'video/mp4',
    signal: controller.signal,
  }), /cancel/)
  t.is(writer.getOpenWriteCount(), 0)
  t.is(await storedCoreCount(store), 0)
})

test('rendition writer validates metadata before materialization and closes cores on range failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-rendition-validation-'))
  const store = new Corestore(directory)
  const writer = createImmutableRenditionWriter()
  let sourceIterations = 0
  const source = {
    async *[Symbol.asyncIterator]() {
      sourceIterations++
      yield bytes(9, 16)
    },
  }
  const reader = createOneShotSourceReader({
    source,
    identity: { kind: 'etag', value: 'validation-rendition' },
    byteLength: 16,
  })

  await writer.initialize()
  t.teardown(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  await t.exception(writer.writeRendition({
    store,
    reader,
    purpose: '',
    format: 'video/mp4',
  }), /purpose/)
  await t.exception(writer.writeRendition({
    store,
    reader,
    purpose: 'original',
    format: '',
  }), /format/)
  await t.exception(writer.writeRendition({
    store,
    reader,
    purpose: 'original',
    format: 'video/mp4',
    segments: [
      { timeStartMs: 0, durationMs: 10, byteStart: 0, byteEnd: 10, independent: true },
      { timeStartMs: 10, durationMs: 10, byteStart: 9, byteEnd: 12, independent: true },
    ],
  }), /ranges/)

  t.is(sourceIterations, 0)
  t.is(await storedCoreCount(store), 0)
  t.is(liveSessionCount(store), 0)

  await t.exception(writer.writeRendition({
    store,
    reader,
    purpose: 'original',
    format: 'video/mp4',
    segments: [
      { timeStartMs: 0, durationMs: 10, byteStart: 0, byteEnd: 17, independent: true },
    ],
  }), /exceed/)

  t.is(sourceIterations, 1)
  t.is(await storedCoreCount(store), 1)
  t.is(liveSessionCount(store), 0)
  t.is(writer.getOpenWriteCount(), 0)
})
