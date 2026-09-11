import test from 'brittle'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { createMediaGraphApi } from '../src/api/media-graph.js'
import { createScopedNetworkRuntime } from '../src/network/scoped-runtime.js'
import { ASSET_BLOCK_SIZE, writeStaticAsset, createPublicationManifest, createRenditionDescriptor } from '../src/assets/index.js'
import { createBufferSourceReader } from '../src/assets/source-reader.js'

for (const sourceCanUpload of [true, false]) {
test(sourceCanUpload ? 'a relay reads a cold rendition over its existing peer stream' : 'a watch-only relay does not serve its retained media over that stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'peartube-relay-read-'))
  const sourceStore = new Corestore(join(root, 'source'))
  const readerStore = new Corestore(join(root, 'reader'))
  const sourceSwarm = new Hyperswarm({ bootstrap: [] })
  const readerSwarm = new Hyperswarm({ bootstrap: [] })
  let sourceRuntime, readerRuntime, reader, asset
  t.teardown(async () => {
    await reader?.close()
    await sourceRuntime?.close()
    await readerRuntime?.close()
    await Promise.all([sourceSwarm.destroy(), readerSwarm.destroy()])
    await asset?.core.close()
    await Promise.all([sourceStore.close(), readerStore.close()])
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([sourceStore.ready(), readerStore.ready(), sourceSwarm.listen()])
  const bytes = b4a.alloc(ASSET_BLOCK_SIZE * 2 + 31)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  asset = await writeStaticAsset({ store: sourceStore, reader: createBufferSourceReader(bytes) })
  const publisher = crypto.keyPair()
  const manifest = createPublicationManifest({
    publisherId: publisher.publicKey,
    title: 'Remote range',
    renditions: [createRenditionDescriptor({ purpose: 'video', format: 'video/mp4', core: asset.descriptor })],
    keyPair: publisher,
    signedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const rendition = manifest.body.renditions[0]
  const policy = {
    networkEnabled: true, uploadPermission: 'enabled', uploadCeilingBytes: 1024 * 1024,
    diskCeilingBytes: 1024 * 1024, permissions: { contribute: true, archive: false },
    publicServingAllowed: true, contributionBudgetBytes: 1024 * 1024, archiveBudgetBytes: 0,
  }
  sourceRuntime = createScopedNetworkRuntime({
    swarm: sourceSwarm, store: sourceStore, bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    initialNetworkPolicy: sourceCanUpload ? policy : { ...policy, uploadPermission: 'disabled', publicServingAllowed: false },
  })
  readerRuntime = createScopedNetworkRuntime({
    swarm: readerSwarm, store: readerStore, bootstrapEnabled: false,
    authorizePublication: async request => request.manifest === manifest,
    peerAddresses: [{ publicKey: sourceSwarm.keyPair.publicKey.toString('hex'), host: '127.0.0.1', port: sourceSwarm.dht.io.serverSocket.address().port }],
    initialNetworkPolicy: policy,
  })
  await sourceRuntime.start()
  await sourceRuntime.retainAuthorizedRendition({ manifest, renditionId: rendition.renditionId })
  const coldCore = readerStore.get({ key: asset.descriptor.key, manifest: asset.descriptor.hypercoreManifest, writable: false })
  await coldCore.ready()
  t.is(await coldCore.has(0), false, 'the receiving relay has no media block')
  await coldCore.close()
  await readerRuntime.start()
  if (sourceCanUpload) {
    const nativeController = globalThis.AbortController
    globalThis.AbortController = undefined
    t.teardown(() => { globalThis.AbortController = nativeController })
  }
  const api = createMediaGraphApi({
    store: readerStore, scopedNetwork: readerRuntime,
    verifiedQueryView: {
      getRendition: async () => ({ manifest, rendition }),
      getPublication: async () => ({ workEntityId: null }),
      authorizeRendition: async () => true,
    },
  })
  reader = await api.openMediaRendition({ publicationId: manifest.publicationId, renditionId: rendition.renditionId })
  t.is(reader.success, true)
  const start = ASSET_BLOCK_SIZE - 7
  const length = ASSET_BLOCK_SIZE + 19
  const chunks = []
  // No peer-ready delay: a cold read itself must wait for replication.
  const read = (async () => { for await (const chunk of reader.read({ start, length })) chunks.push(chunk) })()
    .then(() => null, error => error)
  let timer
  try {
    const failure = await Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('relay read did not settle')), 5000) })])
    if (sourceCanUpload && failure) throw failure
    if (!sourceCanUpload) t.is(failure?.code, 'NO_VERIFIED_SOURCE', 'the peer refuses to serve without upload permission')
  } finally { clearTimeout(timer) }
  if (sourceCanUpload) t.alike(b4a.concat(chunks), bytes.subarray(start, start + length), 'the requested cross-block bytes arrive intact')
  else t.is(chunks.length, 0, 'uploads remain disabled on the watch-only relay')
})
}
