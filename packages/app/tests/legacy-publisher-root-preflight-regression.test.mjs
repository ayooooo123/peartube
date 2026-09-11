import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readApp(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

async function loadInitPlatformRPC(events) {
  const source = readRepo('packages/platform/src/rpc.native.ts')
  const start = source.indexOf('async function runLegacyPublisherRootMigration')
  const end = source.indexOf('export function terminatePlatformRPC', start)
  assert.ok(start >= 0 && end > start, 'native RPC init should be available for runtime instrumentation')
  const result = await transform([
    'let _publisherSignerBridge = null',
    'let _initPromise = null',
    'let _isInitialized = false',
    "let _startupState = 'idle'",
    'let _blobServerPort = null',
    'const nativeRuntimeConfig = {}',
    'const canReuseMainBridge = async () => false',
    'const normalizeFsModule = value => value',
    'const resolveStorageUri = () => "file:///peartube"',
    'const cleanupHeadlessCastIfActive = async () => {}',
    'const resolveBundleLaunchFiles = async () => { events.push("resolve"); return { backendPath: "/bundle", backendSource: "", downloaderWorkerPath: "" } }',
    'const buildNativeWorkerArgs = () => []',
    'const runNativeLegacyPublisherRootPreflight = async options => { events.push("preflight"); await options.migrateLegacyPublisherRoot({ status: "complete", migrated: 0 }); return { status: "complete", migrated: 0 } }',
    'const mainBridge = { init: async () => events.push("init"), getBlobServerPort: () => 4321, terminate: async () => {}, isInitialized: () => false }',
    'const require = moduleName => moduleName === "react-native-bare-kit" ? { Worklet: class Worklet {} } : { EncodingType: { UTF8: "utf8" } }',
    source.slice(start, end).replace('export async function initPlatformRPC', 'async function initPlatformRPC'),
  ].join('\n'), { loader: 'ts', target: 'node22' })
  return new Function('events', `${result.code}\nreturn initPlatformRPC`)(events)
}

test('mobile bundle statically includes a migration-only preflight entrypoint while normal backend boot has no migration callback', () => {
  const source = readApp('backend/index.mjs')

  assert.match(
    source,
    /import \{ runLegacyPublisherRootPreflight \} from '@peartube\/backend\/legacy-publisher-root-preflight'/,
    'the Bare bundle must statically include preflight code for libqjs',
  )
  assert.match(source, /legacy-publisher-root-preflight/)
  assert.match(source, /startLegacyPublisherRootPreflightWorklet/)
  assert.match(source, /runLegacyPublisherRootPreflight\(\{[\s\S]*storagePath:[\s\S]*migrateLegacyPublisherRoot[,:\s]/)

  const normalContextCall = source.match(/createBackendContext\(buildMobileBackendContextOptions\(\{([\s\S]*?)\n\s*\}\)\)/)?.[1] ?? ''
  assert.ok(normalContextCall, 'normal mobile backend context call should remain present')
  assert.doesNotMatch(normalContextCall, /migrateLegacyPublisherRoot|secretKey|challengeSignature/)
})

test('native platform runs the short-lived preflight after bundle resolution and before mainBridge.init, and skips it without a callback', async () => {
  const events = []
  let callbackCalled = 0
  const initPlatformRPC = await loadInitPlatformRPC(events)
  await initPlatformRPC({
    backendSource: 'backend-source',
    storagePath: '/storage',
    migrateLegacyPublisherRoot: async () => { callbackCalled += 1 },
  })
  assert.deepEqual(events, ['resolve', 'preflight', 'init'])
  assert.equal(callbackCalled, 1)

  const skippedEvents = []
  const skippedInit = await loadInitPlatformRPC(skippedEvents)
  await skippedInit({ backendSource: 'backend-source', storagePath: '/storage' })
  assert.deepEqual(skippedEvents, ['resolve', 'init'])
})

test('native layout supplies the privileged migration callback directly from the SecureStore vault', () => {
  const source = readApp('app/_layout.tsx')

  assert.match(source, /getNativePublisherKeyVault/)
  assert.match(
    source,
    /migrateLegacyPublisherRoot:\s*async \(request[^)]*\)\s*=>[\s\S]*importLegacyRootMigration\(request\)/,
  )
})

test('desktop preflight is created after stale-lock cleanup and vault creation, and gates every PearRuntime spawn', () => {
  const source = readApp('src/bun/index.ts')
  const staleLockIndex = source.indexOf('killStaleLocks()')
  const vaultIndex = source.indexOf('const publisherKeyVault = createBunPublisherKeyVault()')
  const promiseIndex = source.indexOf('const legacyPublisherRootPreflightPromise')
  const gateIndex = source.indexOf('if (!legacyPublisherRootPreflightSettled)')
  const spawnIndex = source.indexOf('const worker = PearRuntime.run(')
  const createWindowIndex = source.indexOf('async function createWindow()')
  const windowWaitIndex = source.indexOf('await legacyPublisherRootPreflightPromise', createWindowIndex)
  const websocketStartIndex = source.indexOf('startIPCWebSocket()', createWindowIndex)

  assert.ok(staleLockIndex >= 0 && staleLockIndex < vaultIndex)
  assert.ok(vaultIndex < promiseIndex, 'vault must exist before the privileged preflight starts')
  assert.ok(gateIndex > promiseIndex && gateIndex < spawnIndex, 'getWorker must refuse to spawn while preflight is pending')
  assert.ok(windowWaitIndex > createWindowIndex && windowWaitIndex < websocketStartIndex, 'renderer transport must stay closed until preflight settles')
  assert.doesNotMatch(source, /async open\(ws\)/, 'worker creation must finish in the WebSocket open callback before messages can arrive')
  assert.match(source, /runLegacyPublisherRootPreflight\(\{[\s\S]*storagePath,[\s\S]*migrateLegacyPublisherRoot:/)
  assert.match(source, /publisherKeyVault\.importLegacyRootMigration\(request\)/)
  assert.match(source, /\.catch\(\(\) => \(\{[\s\S]*status: 'unavailable'/)
})

test('migration remains absent from renderer schemas, web bridge, HRPC, and desktop publisher request handlers', () => {
  const forbidden = /importLegacyRootMigration|migrateLegacyPublisherRoot|legacyPublisherRootMigration|legacy-publisher-root-preflight/i
  const sources = [
    ['desktop request schema', readApp('src/shared/rpc-types.ts')],
    ['web bridge', readRepo('packages/platform/src/rpc.web.ts')],
    ['HRPC schema', readRepo('packages/spec/spec/hrpc/hrpc.json')],
    ['HRPC handlers', readRepo('packages/backend/src/hrpc-handlers.js')],
    ['desktop publisher shell handlers', readApp('lib/publisher-shell-service.ts')],
  ]

  for (const [label, source] of sources) {
    assert.doesNotMatch(source, forbidden, `${label} must not expose legacy root migration`)
  }
})
