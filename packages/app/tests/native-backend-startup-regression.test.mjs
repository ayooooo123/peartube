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

test('native platform RPC probes the blob server before reusing an initialized bridge', () => {
  const source = readWorkspaceFile('platform/src/rpc.native.ts')
  const probeIndex = source.indexOf('async function probeBlobServerHealth')
  const resetIndex = source.indexOf('async function resetStaleMainBridge')
  const reuseIndex = source.indexOf('async function canReuseMainBridge')
  const initIndex = source.indexOf('export async function initPlatformRPC')
  const oldFastPath = source.indexOf("console.log('[Platform RPC] Already initialized')")

  assert.notEqual(probeIndex, -1, 'native RPC should define a blob-server health probe')
  assert.notEqual(resetIndex, -1, 'native RPC should be able to reset stale bridge state')
  assert.notEqual(reuseIndex, -1, 'native RPC should centralize bridge reuse checks')
  assert.ok(probeIndex < reuseIndex, 'reuse checks should call the health probe')
  assert.ok(resetIndex < reuseIndex, 'reuse checks should be able to reset stale bridge state')
  assert.ok(reuseIndex < initIndex, 'reuse guard should be available before initPlatformRPC')
  assert.match(source, /\/\?pt_health=1/)
  assert.match(source, /await mainBridge\.terminate\(\)/)
  assert.match(source, /if \(_isInitialized && await canReuseMainBridge\('already initialized'\)\)/)
  assert.match(source, /if \(await canReuseMainBridge\('shared bridge initialized'\)\)/)
  assert.equal(oldFastPath, -1, 'initPlatformRPC must not trust initialized flags without probing the blob server')
})

test('native root layout verifies the backend on Android foreground even when bridge state is ready', () => {
  const source = readAppFile('app/_layout.tsx')
  const foregroundBlock = source.match(/const handleAppStateChange = useCallback\(\(nextState: AppStateStatus\) => \{([\s\S]*?)\n\s*\}, \[/)?.[1] ?? ''

  assert.ok(foregroundBlock, 'foreground handler should exist')
  assert.match(foregroundBlock, /startupState === 'ready'/)
  assert.match(foregroundBlock, /console\.log\('\[App\] Verifying native backend after foreground\.\.\.'\)/)
  assert.match(foregroundBlock, /initNativeBackend\(\)/)
})

test('mobile backend entry avoids runtime imports for startup-critical QJS modules', () => {
  const source = readAppFile('backend/index.mjs')
  const runtimeModulesSource = readWorkspaceFile('backend/src/runtime-modules.js')
  const backendPackage = JSON.parse(readWorkspaceFile('backend/package.json'))
  const loadBackendModulesBody =
    source.match(/async function loadBackendModules\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.ok(loadBackendModulesBody, 'loadBackendModules should exist')
  assert.match(source, /import HyperswarmModule from 'hyperswarm'/, 'mobile backend should statically import Hyperswarm for QJS')
  assert.equal(backendPackage.exports['./runtime-modules'], './src/runtime-modules.js')
  assert.equal(backendPackage.exports['./blob-request-cancellation'], './src/blob-request-cancellation.js')
  assert.match(source, /setHyperswarmModuleForRuntime\(HyperswarmModule\)/, 'mobile backend should preload Hyperswarm before storage startup')
  assert.match(runtimeModulesSource, /export function setHyperswarmModuleForRuntime\(mod\)/)
  assert.match(runtimeModulesSource, /if \(preloadedHyperswarmModule\) return preloadedHyperswarmModule/)
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
  assert.match(source, /import \{ attachCastHandlers as importedAttachCastHandlers \} from '\.\/mobile-cast\.mjs'/, 'mobile cast handlers should be statically bundled for QJS')
  assert.match(source, /import \{ isExpectedBlobRequestCancellation \} from '@peartube\/backend\/blob-request-cancellation'/)
  assert.match(source, /if \(consumeExpectedCancellation\(reason\)\) return true/, 'BareKit should consume expected Hypercore range cancellations')
  assert.doesNotMatch(source, /require\('\.\/mobile-cast\.mjs'\)/, 'libqjs ESM worklets do not expose CommonJS require')
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
    /platform:\s*'mobile'/,
    'createBackendContext should receive mobile platform policy',
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

test('native player compat is enabled from launch player with an opt-out env flag', () => {
  const source = readAppFile('backend/index.mjs')
  const handlersSource = readWorkspaceFile('backend/src/mobile-handlers.js')
  const runtimeSource = readWorkspaceFile('backend/src/transcode/playback-compat-runtime.mjs')

  assert.match(source, /PEARTUBE_NATIVE_PLAYER_COMPAT === '0'/)
  assert.match(source, /PEARTUBE_AVPLAYER_COMPAT === '0'/)
  assert.doesNotMatch(source, /PEARTUBE_AVPLAYER_COMPAT\) === '1'/)
  assert.match(source, /!nativePlayerCompatDisabled && launchOptions\?\.player/)
  assert.match(runtimeSource, /new Set\(\['avplayer', 'exoplayer'\]\)/)
  assert.match(handlersSource, /player === 'exoplayer' && isPearTubeLoopbackBlobUrl\(url\)/)
  assert.doesNotMatch(handlersSource, /forceMode: force \? 'remux' : null/)
  assert.doesNotMatch(handlersSource, /forceMode:\s*'remux'/)
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

test('mobile backend registers host-owned timers and locks on the backend cleanup stack', () => {
  const source = readAppFile('backend/index.mjs')

  assert.match(source, /ctx\.registerCleanup\?\.\('mobile feed refresh interval'/)
  assert.match(source, /ctx\.registerCleanup\?\.\('mobile backend owner lock'/)
})

test('desktop worker registers cast proxy and transcode cleanup on the backend cleanup stack', () => {
  const source = readAppFile('workers/desktop/index.ts')

  assert.match(source, /ctx\.registerCleanup\?\.\('desktop cast proxy'/)
  assert.match(source, /ctx\.registerCleanup\?\.\('desktop transcode sessions'/)
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
    'startupTiming',
    'doctor',
    'directPeerDial',
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
    'startupTiming',
    'doctor',
    'directPeerDial',
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
