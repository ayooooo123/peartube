import { PROTOCOL_VERSION } from '@peartube/host'
import { createApi } from './api.js'
import { createEngineAdapter } from './engine-adapter.js'
import { createIdentityManager } from './identity.js'
import { loadBareOrNodeFsModule, loadBareOrNodePathModule } from './runtime-modules.js'

export async function createBackendContext({ storagePath, onFeedUpdate, onStatsUpdate } = {}) {
  if (!storagePath) throw new Error('storagePath is required')

  const pathModule = await loadBareOrNodePathModule()
  const metaDb = await createJsonMetaDb(pathModule.join(storagePath, 'engine-meta.json'), pathModule)
  const ctx = {
    storagePath,
    metaDb,
    channels: new Map(),
    blobServerPort: 0,
    blobServerHost: '127.0.0.1',
    protocolVersion: PROTOCOL_VERSION,
    onFeedUpdate,
    onStatsUpdate,
  }

  const engineAdapter = createEngineAdapter({ storagePath, ctx })
  ctx.engineAdapter = engineAdapter

  const identityManager = createIdentityManager({ ctx, engineAdapter })
  await identityManager.loadIdentities()

  const api = createApi({ ctx, engineAdapter, identityManager })
  const publicFeed = createPublicFeedStub(api)
  const seedingManager = createSeedingStub()
  const videoStats = createVideoStatsStub(api)

  return {
    ctx,
    api,
    publicFeed,
    seedingManager,
    videoStats,
    identityManager,
    engineAdapter,
    async initializeIdentityFromMnemonic(mnemonic) {
      await identityManager.recoverIdentity(mnemonic, 'Recovered Channel')
      return { needsRestart: false }
    }
  }
}

export function setIsShuttingDown() {}

function createPublicFeedStub(api) {
  return {
    setAvailabilityHintProvider() {},
    setFeedSnapshotProvider() {},
    setOnFeedUpdate() {},
    async start() {},
    async stop() {},
    addEntry() {},
    requestFeedsFromPeers() { return 0 },
    getFeed() { return [] },
    getStats() { return { totalEntries: 0, hiddenCount: 0, peerCount: 0 } },
    async _persistDiscoveredNow() {}
  }
}

function createSeedingStub() {
  return {
    getPinnedChannels() { return [] },
    getActiveSeeds() { return [] },
    getStatus() { return { config: { autoSeedWatched: false }, activeSeeds: 0, storageUsedBytes: 0 } }
  }
}

function createVideoStatsStub(api) {
  return {
    getStats(channelKey, videoId) { return api.getVideoStats(channelKey, videoId) },
    updateStats() {},
    clearStats() {}
  }
}

async function createJsonMetaDb(filePath, pathModule) {
  const fs = await loadBareOrNodeFsModule()
  await mkdirRecursive(fs, pathModule.dirname(filePath))
  let data = {}
  try { data = JSON.parse(readTextFile(fs, filePath)) } catch {}

  async function persist() {
    writeTextFile(fs, filePath, JSON.stringify(data, null, 2))
  }

  return {
    async get(key) { return Object.hasOwn(data, key) ? { value: data[key] } : null },
    async put(key, value) { data[key] = value; await persist() },
    async del(key) { delete data[key]; await persist() },
    async close() { await persist() }
  }
}

async function mkdirRecursive(fs, dirPath) {
  if (fs?.promises?.mkdir) {
    await fs.promises.mkdir(dirPath, { recursive: true })
    return
  }

  if (typeof fs?.mkdirSync === 'function') {
    fs.mkdirSync(dirPath, { recursive: true })
    return
  }

  throw new Error('File system module does not support mkdir')
}

function readTextFile(fs, filePath) {
  if (typeof fs?.readFileSync === 'function') return fs.readFileSync(filePath, 'utf8')
  throw new Error('File system module does not support readFileSync')
}

function writeTextFile(fs, filePath, contents) {
  if (typeof fs?.writeFileSync === 'function') {
    fs.writeFileSync(filePath, contents)
    return
  }
  throw new Error('File system module does not support writeFileSync')
}
