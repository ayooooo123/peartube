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
  const source = readAppFile('backend/mobile-start.mjs')
  const pattern = new RegExp('export function parseMobileLaunchArgsForTest\\(args = \\[\\]\\) \\{([\\s\\S]*?)\\n\\}')
  const match = source.match(pattern)
  assert.ok(match, 'parseMobileLaunchArgsForTest should exist')
  return Function(`return function parseMobileLaunchArgsForTest(args = []) {${match[1]}
}`)()
}
function loadBuildMobileBackendContextOptions() {
  const source = readAppFile('backend/index.mjs')
  const match = source.match(/export function buildMobileBackendContextOptions\(options = \{\}\) \{([\s\S]*?)\n\}/)
  assert.ok(match, 'buildMobileBackendContextOptions should exist in the bundled mobile runtime')
  return Function(`return function buildMobileBackendContextOptions(options = {}) {${match[1]}
}`)()
}



test('native hosts explicitly select their backend platform policy', () => {
  const mobileSource = readAppFile('backend/mobile-start.mjs')
  const desktopSource = readAppFile('workers/desktop/index.ts')
  const mobileRuntimeSource = readAppFile('backend/index.mjs')

  assert.match(
    mobileSource,
    /createBackendImpl\(\{[\s\S]*?platform: 'mobile'/,
    'mobile host must pass mobile into createBackend',
  )
  assert.match(
    desktopSource,
    /createBackend\(\{[\s\S]*?platform: 'desktop'/,
    'desktop worker must pass desktop into createBackend',
  )
  assert.doesNotMatch(
    mobileRuntimeSource,
    /setIsShuttingDown/,
    'mobile runtime must use its backend context lifecycle instead of module-global shutdown state',
  )
  assert.match(
    mobileRuntimeSource,
    /await shutdownBackend\(ctx\)/,
    'mobile runtime shutdown must delegate to the backend context lifecycle owner',
  )
  const buildMobileBackendContextOptions = loadBuildMobileBackendContextOptions()
  const network = { bootstrap: ['mobile-bootstrap'] }
  const contextOptions = buildMobileBackendContextOptions({ platform: 'mobile', network })
  assert.equal(contextOptions.platform, 'mobile')
  assert.equal(contextOptions.network, network)
  assert.equal(contextOptions.expectedProtocolVersion, undefined)
  assert.match(
    mobileRuntimeSource,
    /createBackendContext\(buildMobileBackendContextOptions\(\{/,
    'bundled mobile runtime must apply its platform policy to createBackendContext',
  )
})

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

test('native root layout bounds Android network resume before probing a ready backend', () => {
  const source = readAppFile('app/_layout.tsx')
  const foregroundBlock = source.match(/const handleAppStateChange = useCallback\(\(nextState: AppStateStatus\) => \{([\s\S]*?)\n\s*\}, \[/)?.[1] ?? ''

  assert.ok(foregroundBlock, 'foreground handler should exist')
  assert.match(source, /const FOREGROUND_RESUME_TIMEOUT_MS = \d+/)
  assert.match(foregroundBlock, /startupState === 'ready'/)
  assert.match(
    foregroundBlock,
    /await Promise\.race\(\[/,
    'foreground health verification must wait for network resume without hanging forever',
  )
  assert.match(foregroundBlock, /platformRPC\.rpc\?\.resumeNetwork\?\.\(\)/)
  assert.match(foregroundBlock, /FOREGROUND_RESUME_TIMEOUT_MS/)
  const resumeIndex = foregroundBlock.indexOf('platformRPC.rpc?.resumeNetwork?.()')
  const verifyIndex = foregroundBlock.indexOf("console.log('[App] Verifying native backend after foreground...')")
  assert.ok(resumeIndex < verifyIndex, 'network resume wait must precede backend health verification')
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

test('mobile rejects unsupported stored protocol before lock cleanup or backend data readiness', () => {
  const source = readAppFile('backend/index.mjs')
  const preflightIndex = source.indexOf('prepareStoredProtocolState({')
  const mkdirIndex = source.indexOf('fs.mkdirSync(storageDir')
  const ownerLockIndex = source.indexOf('await acquireOwnerLock(storageDir)')
  const staleLockIndex = source.indexOf('\n  removeStaleLocks(storageDir)')
  const handlerReadyIndex = source.indexOf('handlersRegistered = true')

  assert.notEqual(preflightIndex, -1)
  assert.ok(preflightIndex < mkdirIndex)
  assert.ok(preflightIndex < ownerLockIndex)
  assert.ok(preflightIndex < staleLockIndex)
  assert.ok(preflightIndex < handlerReadyIndex)
  assert.match(source, /rpc\?\.eventError\?\.\(\{ code, message: readinessMessage, retryable: false \}\)/)
  assert.match(source, /storedVersion=.*expectedVersion=/)
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
    /expectedProtocolVersion: protocolVersion/,
    'createBackendContext should receive the protocol version validated by the host',
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

test('mobile backend registers the owner lock without a global refresh timer', () => {
  const source = readAppFile('backend/index.mjs')

  assert.match(source, /ctx\.registerCleanup\?\.\('mobile backend owner lock'/)
  assert.doesNotMatch(source, /feed refresh interval|setInterval/)
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

test('backend orchestrator starts scoped discovery and accounts for scoped peer sessions', () => {
  const orchestrator = readWorkspaceFile('backend/src/orchestrator.js')
  const runtime = readWorkspaceFile('backend/src/network/scoped-runtime.js')

  assert.match(orchestrator, /createScopedNetworkRuntime/)
  assert.match(orchestrator, /await scopedNetwork\.start\(\)/)
  assert.match(runtime, /activeConnections\.set\(connection, info\)/)
  assert.match(runtime, /scope\.sessions\.set\(remoteKey,\s*tracked\)/)
  assert.match(runtime, /for\s*\(const session of scope\.sessions\.values\(\)\)\s*sessions\.push\(\{/)
  assert.doesNotMatch(orchestrator, /publicFeed\.handleDiscoveredPeer/)
})

test('mobile getSwarmStatus forwards low-level network diagnostics', () => {
  const source = readWorkspaceFile('backend/src/mobile-handlers.js')
  const handlerBlock = source.match(/B\.getSwarmStatus = async \(\) => \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''

  assert.ok(handlerBlock, 'mobile getSwarmStatus handler should exist')
  for (const field of [
    'network',
    'startupTiming',
    'doctor',
    'swarmOffline',
    'swarmOfflineReason',
    'swarmListenResolved',
    'peerPoolJoined',
  ]) {
    assert.match(handlerBlock, new RegExp(field), `getSwarmStatus should expose ${field}`)
  }
  assert.doesNotMatch(handlerBlock, /feedConnections|feedEntries|directPeerDial/)
})

test('desktop worker forwards media graph updates and scoped swarm diagnostics', () => {
  const source = readAppFile('workers/desktop/index.ts')

  assert.match(source, /onMediaGraphUpdate:\s*\(update: \{ revision: string; changedCount: number \}\) => \{[\s\S]*?eventMediaGraphUpdate/)

  const swarmStatusBlock = source.match(/B\.getSwarmStatus = async \(\) => \{([\s\S]*?)\n\}/)?.[1] ?? ''
  assert.ok(swarmStatusBlock, 'desktop getSwarmStatus handler should exist')
  assert.match(swarmStatusBlock, /api\.getSwarmStatus\(\)/)
  for (const field of [
    'scopedDiagnostics',
    'networkJson',
    'startupTimingJson',
    'swarmOffline',
    'swarmOfflineReason',
    'swarmListenResolved',
    'peerPoolJoined',
  ]) {
    assert.match(swarmStatusBlock, new RegExp(field), `desktop getSwarmStatus should expose ${field}`)
  }
  assert.doesNotMatch(swarmStatusBlock, /feedConnections|feedEntries|directPeerDial/)
})

test('desktop upload relies on the catalog publication path without feed re-submission', () => {
  const source = readAppFile('workers/desktop/index.ts')
  const uploadStart = source.indexOf('B.uploadVideo = async (r: any) => {')
  const uploadEnd = source.indexOf('B.pickVideoFile = async', uploadStart)
  const uploadBlock = uploadStart >= 0 && uploadEnd > uploadStart ? source.slice(uploadStart, uploadEnd) : ''

  assert.ok(uploadBlock, 'desktop uploadVideo handler should exist')
  assert.doesNotMatch(source, /refreshPublishedChannelFeed|submitToFeed/)
  assert.doesNotMatch(uploadBlock, /refreshPublishedChannelFeed|submitToFeed/)
})

test('backend orchestrator starts scoped networking without a legacy feed startup or sync gate', () => {
  const source = readWorkspaceFile('backend/src/orchestrator.js')

  assert.match(source, /await scopedNetwork\.start\(\)/)
  assert.match(source, /scoped-network startup gate timed out; continuing backend warmup offline/)
  assert.doesNotMatch(source, /publicFeed startup gate/)
  assert.doesNotMatch(source, /publicFeed\.requestFeedsFromPeers\(\)/)
  assert.doesNotMatch(source, /startupGate\.noteFeedSync\(\)/)
})

test('publisher root vault stays privileged while desktop exposes only bounded catalog lifecycle', () => {
  const bunMain = readAppFile('src/bun/index.ts')
  const mobileBackend = readAppFile('backend/mobile-start.mjs')
  const desktopWorker = readAppFile('workers/desktop/index.ts')
  const webRpc = readWorkspaceFile('platform/src/rpc.web.ts')
  const rpcStart = bunMain.indexOf('BrowserView.defineRPC')
  const rpcEnd = bunMain.indexOf('// ── Static File Server', rpcStart)
  const rendererRpcBlock = rpcStart >= 0 && rpcEnd > rpcStart
    ? bunMain.slice(rpcStart, rpcEnd)
    : ''

  assert.match(bunMain, /createBunPublisherKeyVault/)
  assert.match(bunMain, /createPublisherSignerBridge/)
  assert.match(bunMain, /runtime: 'desktop-main'/)
  assert.match(bunMain, /getPrivilegedPublisherSignerBridge/)
  assert.doesNotMatch(bunMain, /globalThis.*PublisherKeyVault/, 'root vault must not be exposed as mutable process-global state')
  assert.ok(rendererRpcBlock, 'desktop renderer RPC block should exist')
  assert.match(rendererRpcBlock, /publisherEnsureLocalCatalog:\s*async/)
  assert.doesNotMatch(
    rendererRpcBlock,
    /publisherCreateRoot|publisherBeginUserIntent|publisherSignPreparedRecord|publisherCompleteIntent|publisherCancelIntent/,
  )
  assert.doesNotMatch(rendererRpcBlock, /signDigest|vault|secretKey|privateKey|rootSecret|seed/i)
  assert.doesNotMatch(mobileBackend, /publisher-key-vault|expo-secure-store/)
  assert.doesNotMatch(desktopWorker, /publisher-key-vault|signDigest|getSecret/)
  assert.match(webRpc, /runtime: 'renderer'/)
  assert.match(webRpc, /window\.bridge\?\.ensureLocalPublisher/)
  assert.doesNotMatch(webRpc, /publisherSigner === window\.bridge\?\.publisherSigner/)
})
