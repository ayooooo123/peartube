import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.resolve(appRoot, '..', relativePath), 'utf8')
}

function loadParseMobileLaunchArgsForTest() {
  const source = readAppFile('backend/index.mjs')
  const pattern = new RegExp('export function parseMobileLaunchArgsForTest\\(args = \\[\\]\\) \\{([\\s\\S]*?)\\n\\}')
  const match = source.match(pattern)
  assert.ok(match, 'parseMobileLaunchArgsForTest should exist')
  return Function(`return function parseMobileLaunchArgsForTest(args = []) {${match[1]}
}`)()
}


test('native root layout passes versioned bundle loaders into initPlatformRPC instead of eagerly reading source at the call site', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(source, /backendVersionKey:/)
  assert.match(source, /loadBackendSource:/)
  assert.match(source, /loadDownloaderWorkerSource:/)
})

test('native root layout arms the backend startup timeout before awaiting initPlatformRPC and falls back to markBackendReady when init resolves first', () => {
  const source = readAppFile('app/_layout.tsx')

  const timerIndex = source.indexOf("startupTimerRef.current = setTimeout(() => {")
  const initIndex = source.indexOf('await platformRPC.initPlatformRPC({')
  const fallbackIndex = source.indexOf("await markBackendReady('initPlatformRPC', readyPort)")

  assert.notEqual(timerIndex, -1, 'startup timeout should be armed in initNativeBackend')
  assert.notEqual(initIndex, -1, 'initPlatformRPC call should exist')
  assert.notEqual(fallbackIndex, -1, 'initNativeBackend should mark ready if init resolves before eventReady')
  assert.ok(timerIndex < initIndex, 'startup timeout must be armed before awaiting initPlatformRPC')
  assert.ok(initIndex < fallbackIndex, 'fallback ready mark should happen after initPlatformRPC resolves')
})

test('mobile backend entry keeps cast, thumbnail, and native-lock modules out of the mandatory startup import batch', () => {
  const source = readAppFile('backend/index.mjs')
  const loadBackendModulesBody =
    source.match(/async function loadBackendModules\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(loadBackendModulesBody, 'loadBackendModules should exist')
  assert.doesNotMatch(loadBackendModulesBody, /import\(/, 'loadBackendModules should not use dynamic import in libqjs worklets')
  assert.doesNotMatch(loadBackendModulesBody, /import\('\.\/transcoder\.mjs'\)/)
  assert.doesNotMatch(loadBackendModulesBody, /import\('@peartube\/backend\/transcode\/cast-transcoder'\)/)
  assert.doesNotMatch(loadBackendModulesBody, /import\('@peartube\/backend\/thumbnail'\)/)
  assert.doesNotMatch(loadBackendModulesBody, /import\('bare-http1'\)/)
  assert.doesNotMatch(loadBackendModulesBody, /import\('fs-native-extensions'\)/)
  assert.doesNotMatch(source, /await import\('@peartube\/backend\/mobile-handlers'\)/, 'mobile handlers are startup-critical and must be statically imported')
  assert.doesNotMatch(source, /await import\('@peartube\/backend\/hrpc-handlers'\)/, 'shared HRPC handlers are startup-critical and must be statically imported')
  assert.match(source, /attachLazyCastHandlers/)
  assert.match(source, /attachCastHandlers/)
  assert.doesNotMatch(source, /import\('\.\/mobile-cast\.mjs'\)/, 'libqjs does not support dynamically importing mobile cast handlers')
  assert.match(source, /ensureBackendThumbnailModule/)
  assert.match(source, /ensureHttpModule/)
  assert.match(source, /ensureFsNativeExtensionsModule/)
})

test('mobile backend startup lock cleanup removes db LOCK files before orchestrator init', () => {
  const source = readAppFile('backend/index.mjs')
  const removeLocksBody =
    source.match(/function removeStaleLocks\(storageDir\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(removeLocksBody, 'removeStaleLocks should exist')
  assert.match(removeLocksBody, /path\.join\(storageDir, 'db', 'LOCK'\)/)
})

test('mobile backend consumes launch options before downloader worker args', () => {
  const source = readAppFile('backend/index.mjs')
  const parseMobileLaunchArgsForTest = loadParseMobileLaunchArgsForTest()
  const launchOptions = { __peartubeLaunchOptions: true, network: { relayPeers: ['relay-a'] }, swarmOptions: { knownPeers: ['relay-a'] } }

  assert.deepEqual(
    parseMobileLaunchArgsForTest([JSON.stringify(launchOptions), '/tmp/downloader.bundle']),
    { launchOptions, workerArgs: ['/tmp/downloader.bundle'] },
    'mobile backend entry should peel launchOptions off argv before reading downloader worker args',
  )
  assert.match(
    source,
    /const \{ launchOptions, workerArgs \} = parseMobileLaunchArgs\(args\)/,
    'createMobileRuntimeBackend should parse launchOptions from BareKit worker args',
  )
  assert.match(
    source,
    /network: launchOptions\?\.network/,
    'createBackendContext should receive launchOptions.network',
  )
  assert.match(
    source,
    /swarmOptions: launchOptions\?\.swarmOptions/,
    'createBackendContext should receive launchOptions.swarmOptions',
  )
  assert.match(
    source,
    /const workerBundlePath = workerArgs\[0\] \|\| ''/,
    'downloader worker path should be read after launchOptions are removed',
  )
})

test('mobile backend parses launch options after entrypoint and preserves downloader worker path', () => {
  const parseMobileLaunchArgsForTest = loadParseMobileLaunchArgsForTest()
  const launchOptions = {
    __peartubeLaunchOptions: true,
    network: { relayPeers: ['relay-a'] },
    swarmOptions: { knownPeers: ['relay-a'] },
  }

  const parsed = parseMobileLaunchArgsForTest([
    'mobile-entry',
    JSON.stringify(launchOptions),
    '/tmp/downloader.bundle',
  ])

  assert.deepEqual(parsed.launchOptions.network, launchOptions.network)
  assert.deepEqual(parsed.launchOptions.swarmOptions, launchOptions.swarmOptions)
  assert.deepEqual(parsed.workerArgs, ['/tmp/downloader.bundle'])
})

test('native root layout clears startup timeout and releases loading on explicit startup errors', () => {
  const source = readAppFile('app/_layout.tsx')
  const onErrorBlock = source.match(/platformRPC\.events\.onError\(\(data: any\) => \{([\s\S]*?)\n\s*\}\)/)?.[1] ?? ''
  const catchBlock = source.match(/\} catch \(err\) \{([\s\S]*?)\n\s*\}\n\s*\}\)\(\)/)?.[1] ?? ''

  assert.ok(onErrorBlock, 'native startup onError handler should exist')
  assert.ok(catchBlock, 'native startup init catch block should exist')
  assert.match(onErrorBlock, /setReady\(true\)/)
  assert.match(onErrorBlock, /setLoading\(false\)/)
  assert.match(catchBlock, /clearTimeout\(startupTimerRef\.current\)/)
  assert.match(catchBlock, /startupTimerRef\.current = null/)
  assert.match(catchBlock, /setReady\(true\)/)
  assert.match(catchBlock, /setLoading\(false\)/)
})

test('native root layout does not expose RPC context before the platform bridge is initialized', () => {
  const source = readAppFile('app/_layout.tsx')
  const contextStart = source.indexOf('const contextValue: AppContextType = {')
  const contextEnd = source.indexOf('\n  }', contextStart)
  const contextBlock = contextStart >= 0 && contextEnd > contextStart
    ? source.slice(contextStart, contextEnd)
    : ''

  assert.ok(contextBlock, 'contextValue should exist')
  assert.match(
    contextBlock,
    /rpc:\s*platformRPC\?\.isInitialized\?\.\(\)\s*\?\s*platformRPC\.rpc\s*:\s*null/,
    'AppContext should not expose an RPC facade while native startup is still registering backend handlers',
  )
})

test('backend orchestrator records peers discovered on the single shared topic', () => {
  const source = readWorkspaceFile('backend/src/orchestrator.js')

  assert.match(source, /ctx\.swarm\.on\('peer'/)
  assert.match(source, /publicFeed\.handleDiscoveredPeer\(peer, topic\)/)
})

test('mobile getSwarmStatus forwards low-level network diagnostics', () => {
  const source = readWorkspaceFile('backend/src/mobile-handlers.js')
  const handlerBlock = source.match(/B\.getSwarmStatus = async \(\) => \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''

  assert.ok(handlerBlock, 'mobile getSwarmStatus handler should exist')
  for (const field of [
    'network',
    'swarmOffline',
    'swarmOfflineReason',
    'swarmListenResolved',
    'peerPoolJoined',
    'publicFeedDiscoveryJoined',
    'feedTopicHex',
  ]) {
    assert.match(handlerBlock, new RegExp(field), `getSwarmStatus should expose ${field}`)
  }
})

test('desktop worker forwards feed update events and full swarm diagnostics', () => {
  const source = readAppFile('workers/desktop/index.ts')

  assert.match(source, /onFeedUpdate:\s*\(\) => \{[\s\S]*?eventFeedUpdate\?\.\(\{ channelKey: 'feed', action: 'update' \}\)/)
  assert.match(source, /B\.getCanonicalFeed = B\.getPublicFeed/)

  const swarmStatusBlock = source.match(/B\.getSwarmStatus = async \(\) => \{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(swarmStatusBlock, 'desktop getSwarmStatus handler should exist')
  assert.match(swarmStatusBlock, /api\.getSwarmStatus\(\)/)
  for (const field of [
    'network',
    'swarmOffline',
    'swarmOfflineReason',
    'swarmListenResolved',
    'peerPoolJoined',
    'publicFeedDiscoveryJoined',
    'feedTopicHex',
    'feedConnections',
    'feedEntries',
  ]) {
    assert.match(swarmStatusBlock, new RegExp(field), `desktop getSwarmStatus should expose ${field}`)
  }
})

test('desktop worker re-gossips already-published channels after upload metadata settles', () => {
  const source = readAppFile('workers/desktop/index.ts')
  const uploadStart = source.indexOf('B.uploadVideo = async (r: any) => {')
  const uploadEnd = source.indexOf('B.pickVideoFile = async', uploadStart)
  const uploadBlock = uploadStart >= 0 && uploadEnd > uploadStart ? source.slice(uploadStart, uploadEnd) : ''

  assert.ok(uploadBlock, 'desktop uploadVideo handler should exist')
  assert.match(source, /const refreshPublishedChannelFeed = async/)
  assert.match(uploadBlock, /await refreshPublishedChannelFeed\(active\.driveKey\)/)
  assert.ok(
    uploadBlock.indexOf('channel.updateVideo') < uploadBlock.indexOf('await refreshPublishedChannelFeed(active.driveKey)'),
    'desktop feed gossip refresh should happen after thumbnail metadata update',
  )
})

test('backend orchestrator defers warm-up behind startup gates and does not force a boot-time feed sync request', () => {
  const source = readWorkspaceFile('backend/src/orchestrator.js')

  assert.match(source, /createStartupGate/)
  assert.match(source, /STARTUP_GATE_WARMUP_WAIT_MS/)
  assert.match(source, /startupGate\.waitUntilOpen\(\{ timeoutMs: STARTUP_GATE_WARMUP_WAIT_MS \}\)/)
  assert.match(source, /publicFeed startup gate timed out; continuing backend warmup offline/)
  assert.doesNotMatch(source, /publicFeed\.requestFeedsFromPeers\(\)/)
})
