import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import b4a from 'b4a'
import test from 'brittle'
import Hypercore from 'hypercore'

import {
  ASSET_BLOCK_SIZE,
  createStaticAssetManifest,
  deriveStaticAssetId,
  deriveStaticAssetTopic,
  verifyStaticAssetDescriptor,
} from '../src/assets/index.js'

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
