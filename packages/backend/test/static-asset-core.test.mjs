import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Hypercore from 'hypercore'
import Corestore from 'corestore'

import * as assets from '../src/assets/index.js'

const {
  ASSET_BLOCK_SIZE,
  createStaticAssetManifest,
  deriveStaticAssetId,
  deriveStaticAssetTopic,
  verifyStaticAssetDescriptor,
  writeStaticAsset,
} = assets

async function completedCoreState(bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-static-identity-'))
  const core = new Hypercore(directory)

  try {
    await core.ready()
    for (let offset = 0; offset < bytes.byteLength; offset += ASSET_BLOCK_SIZE) {
      await core.append(bytes.subarray(offset, Math.min(offset + ASSET_BLOCK_SIZE, bytes.byteLength)))
    }
    return {
      treeHash: await core.treeHash(),
      blockLength: core.length,
      byteLength: core.byteLength,
    }
  } finally {
    await core.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function openedCoreFor(descriptor, overrides = {}) {
  return {
    key: descriptor.key,
    length: descriptor.length,
    byteLength: descriptor.byteLength,
    async ready() {},
    async treeHash() {
      return descriptor.treeHash
    },
    ...overrides,
  }
}

async function storedCoreKeys(store) {
  const keys = []
  for await (const discoveryKey of store.list()) keys.push(b4a.toString(discoveryKey, 'hex'))
  return keys
}

async function storedAliases(store) {
  const aliases = []
  for await (const entry of store.storage.createAliasStream(store.ns)) aliases.push(entry.alias)
  return aliases
}

function liveSessionCount(store) {
  return store.sessions.list().filter((session) => !session.closed).length
}

function interceptFinalCore(store, patch) {
  const get = store.get.bind(store)
  let finalCore = null

  store.get = (options) => {
    const core = get(options)
    if (options?.manifest) {
      finalCore = core
      const ready = core.ready.bind(core)
      let patched = false
      core.ready = async () => {
        await ready()
        if (patched) return
        patched = true
        patch(core)
      }
    }
    return core
  }

  return () => finalCore
}

function oneShotSource(chunks) {
  let iterations = 0
  return {
    get iterations() {
      return iterations
    },
    async *[Symbol.asyncIterator]() {
      iterations++
      if (iterations > 1) throw new Error('source iterated more than once')
      yield* chunks
    },
  }
}

test('static asset materialization converges across stores and preserves canonical blocks', async (t) => {
  const leftDirectory = mkdtempSync(join(tmpdir(), 'peartube-static-left-'))
  const rightDirectory = mkdtempSync(join(tmpdir(), 'peartube-static-right-'))
  const storeA = new Corestore(leftDirectory)
  const storeB = new Corestore(rightDirectory)
  const bytes = b4a.alloc(ASSET_BLOCK_SIZE * 2 + 17, 23)
  const changed = b4a.from(bytes)
  changed[ASSET_BLOCK_SIZE + 1] ^= 1
  const source = oneShotSource([
    bytes.subarray(0, 13),
    bytes.subarray(13, ASSET_BLOCK_SIZE + 29),
    bytes.subarray(ASSET_BLOCK_SIZE + 29),
  ])

  t.teardown(async () => {
    await Promise.all([storeA.close(), storeB.close()])
    rmSync(leftDirectory, { recursive: true, force: true })
    rmSync(rightDirectory, { recursive: true, force: true })
  })

  const left = await writeStaticAsset({ store: storeA, source })
  const right = await writeStaticAsset({ store: storeB, source: [bytes] })
  const mutation = await writeStaticAsset({ store: storeB, source: [changed] })

  t.is(source.iterations, 1)
  t.is(left.descriptor.kind, 'static-prologue-v1')
  t.is(left.descriptor.key.toString('hex'), right.descriptor.key.toString('hex'))
  t.is(left.descriptor.assetId, right.descriptor.assetId)
  t.not(left.descriptor.assetId, mutation.descriptor.assetId)
  t.is(left.descriptor.assetId, left.core.key.toString('hex'))
  t.is(left.core.length, 3)
  t.is(left.core.byteLength, bytes.byteLength)
  t.is((await left.core.get(0)).byteLength, ASSET_BLOCK_SIZE)
  t.is((await left.core.get(1)).byteLength, ASSET_BLOCK_SIZE)
  t.is((await left.core.get(2)).byteLength, 17)
  t.alike(b4a.concat([
    await left.core.get(0),
    await left.core.get(1),
    await left.core.get(2),
  ]), bytes)
  t.ok(await verifyStaticAssetDescriptor(left.core, left.descriptor))
  t.absent(left.core.secretKey)
  await t.exception(left.core.append(b4a.from('forbidden')))
  await t.exception(left.core.append(b4a.from('still-forbidden'), { writable: true }))
  t.is((await storedCoreKeys(storeA)).length, 1)
  t.is((await storedCoreKeys(storeB)).length, 2)
  t.is((await storedAliases(storeA)).length, 0)
  t.is((await storedAliases(storeB)).length, 0)
})

test('static asset materialization purges staging cores after cancellation and source failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-static-cleanup-'))
  const store = new Corestore(directory)
  const controller = new AbortController()

  t.teardown(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  async function *cancelledSource() {
    yield b4a.alloc(ASSET_BLOCK_SIZE, 31)
    controller.abort()
    yield b4a.from('not-written')
  }

  async function *failedSource() {
    yield b4a.from('partial')
    throw new Error('source failed')
  }

  await t.exception(
    writeStaticAsset({ store, source: cancelledSource(), signal: controller.signal }),
    /cancel/
  )
  t.is((await storedCoreKeys(store)).length, 0)
  t.is((await storedAliases(store)).length, 0)
  await t.exception(writeStaticAsset({ store, source: failedSource() }), /source failed/)
  t.is((await storedCoreKeys(store)).length, 0)
  t.is((await storedAliases(store)).length, 0)
})

test('static asset materialization closes the final session when aborting during copy or verification', async (t) => {
  for (const phase of ['copy', 'verification']) {
    const directory = mkdtempSync(join(tmpdir(), `peartube-static-abort-${phase}-`))
    const store = new Corestore(directory)
    const controller = new AbortController()
    const getFinalCore = interceptFinalCore(store, (core) => {
      if (phase === 'copy') {
        const copyPrologue = core.core.copyPrologue.bind(core.core)
        core.core.copyPrologue = async (sourceState) => {
          await copyPrologue(sourceState)
          controller.abort()
        }
      } else {
        const treeHash = core.treeHash.bind(core)
        core.treeHash = async (...args) => {
          const hash = await treeHash(...args)
          controller.abort()
          return hash
        }
      }
    })

    t.teardown(async () => {
      await store.close()
      rmSync(directory, { recursive: true, force: true })
    })

    await t.exception(
      writeStaticAsset({
        store,
        source: [b4a.alloc(ASSET_BLOCK_SIZE + 11, 41)],
        signal: controller.signal,
      }),
      /cancel/
    )

    t.ok(getFinalCore().closed)
    t.is(liveSessionCount(store), 0)
    t.is((await storedCoreKeys(store)).length, 1)
    t.is((await storedAliases(store)).length, 0)
  }
})

test('static asset materialization uses zero-copy source views and rejects non-byte chunks', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'peartube-static-zero-copy-'))
  const store = new Corestore(directory)
  const chunk = new Uint8Array(ASSET_BLOCK_SIZE)
  chunk.fill(43)
  const from = b4a.from

  t.teardown(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  b4a.from = (value, ...args) => {
    if (value === chunk) throw new Error('full source chunk copied')
    return from(value, ...args)
  }

  try {
    const written = await writeStaticAsset({ store, source: [chunk] })
    t.ok(b4a.equals(await written.core.get(0), chunk))
  } finally {
    b4a.from = from
  }

  await t.exception(
    writeStaticAsset({ store, source: ['not a byte chunk'] }),
    /Buffer or Uint8Array/
  )
})

test('static asset manifests converge from the completed Hypercore tree', async (t) => {
  const state = await completedCoreState(b4a.alloc(600000, 7))
  const a = createStaticAssetManifest(state)
  const b = createStaticAssetManifest({
    treeHash: b4a.from(state.treeHash),
    blockLength: state.blockLength,
    byteLength: state.byteLength,
  })

  t.is(ASSET_BLOCK_SIZE, 256 * 1024)
  t.is(a.kind, 'static-prologue-v1')
  t.is(a.length, 3)
  t.is(a.blockSize, ASSET_BLOCK_SIZE)
  t.alike(a.hypercoreManifest, {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 0,
    signers: [],
    prologue: { hash: state.treeHash, length: 3 },
  })
  t.is(a.key.toString('hex'), b.key.toString('hex'))
  t.is(a.assetId, a.key.toString('hex'))
  t.is(deriveStaticAssetId(a), deriveStaticAssetId(b))
  t.is(a.assetId, deriveStaticAssetId(a))
  t.alike(deriveStaticAssetTopic(a.assetId), deriveStaticAssetTopic(b.assetId))
})

test('one changed byte produces a different static identity and topic', async (t) => {
  const original = b4a.alloc(600000, 11)
  const changed = b4a.from(original)
  changed[changed.byteLength - 1] ^= 1

  const left = createStaticAssetManifest(await completedCoreState(original))
  const right = createStaticAssetManifest(await completedCoreState(changed))

  t.unlike(left.treeHash, right.treeHash)
  t.not(left.key.toString('hex'), right.key.toString('hex'))
  t.not(left.assetId, right.assetId)
  t.unlike(deriveStaticAssetTopic(left.assetId), deriveStaticAssetTopic(right.assetId))
})

test('static asset manifests reject malformed tree and length metadata', (t) => {
  const treeHash = b4a.alloc(32, 3)

  t.exception(
    () => createStaticAssetManifest({ treeHash, blockLength: 2, byteLength: 600000 }),
    /blockLength does not match canonical asset blocks/
  )
  t.exception(
    () => createStaticAssetManifest({ treeHash, blockLength: -1, byteLength: 0 }),
    /blockLength/
  )
  t.exception(
    () => createStaticAssetManifest({ treeHash, blockLength: 0, byteLength: -1 }),
    /byteLength/
  )
  t.exception(
    () => createStaticAssetManifest({ treeHash: b4a.alloc(31), blockLength: 0, byteLength: 0 }),
    /treeHash/
  )
})

test('descriptor verification compares key, tree hash, block length, and byte length', async (t) => {
  const descriptor = createStaticAssetManifest({
    treeHash: b4a.alloc(32, 5),
    blockLength: 3,
    byteLength: 600000,
  })

  t.ok(await verifyStaticAssetDescriptor(openedCoreFor(descriptor), descriptor))
  t.absent(await verifyStaticAssetDescriptor(openedCoreFor(descriptor, { key: b4a.alloc(32, 6) }), descriptor))
  t.absent(await verifyStaticAssetDescriptor(openedCoreFor(descriptor, { length: 2 }), descriptor))
  t.absent(await verifyStaticAssetDescriptor(openedCoreFor(descriptor, { byteLength: 599999 }), descriptor))
  t.absent(await verifyStaticAssetDescriptor(openedCoreFor(descriptor, {
    async treeHash() {
      return b4a.alloc(32, 7)
    },
  }), descriptor))
})

test('static asset topics are stable 32-byte derivations of validated asset ids', (t) => {
  const assetId = b4a.alloc(32, 9).toString('hex')
  const topic = deriveStaticAssetTopic(assetId)

  t.is(topic.byteLength, 32)
  t.alike(topic, deriveStaticAssetTopic(b4a.from(assetId, 'hex')))
  t.exception(() => deriveStaticAssetTopic('abcd'), /assetId/)
})
