import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classifyFeedDiscoveryState,
  getAndroidDiscoveryPermissionRequests,
} from '../lib/android-discovery-diagnostics.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('Android native discovery module exposes status helpers while the application lifecycle owns the MulticastLock', () => {
  const moduleSource = readAppFile('android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscoveryModule.kt')
  const packageSource = readAppFile('android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscoveryPackage.kt')
  const applicationSource = readAppFile('android/app/src/main/java/com/peartube/app/MainApplication.kt')

  assert.match(moduleSource, /fun acquireMulticastLock\(/)
  assert.match(moduleSource, /fun releaseMulticastLock\(/)
  assert.match(moduleSource, /fun getDiscoveryNetworkStatus\(/)
  assert.doesNotMatch(moduleSource, /private var multicastLock/)
  assert.match(packageSource, /PeartubeNetworkDiscoveryModule\(reactContext\)/)
  assert.match(applicationSource, /registerActivityLifecycleCallbacks\(/)
  assert.match(applicationSource, /networkDiscovery\.start\(\)/)
  assert.match(applicationSource, /networkDiscovery\.stop\(\)/)
  assert.match(applicationSource, /networkDiscovery\.logException\("startup", t\)/)
})

test('root layout requests Android discovery permissions, records results, and reads multicast lock status before backend startup', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(source, /NativeModules/)
  assert.match(source, /requestAndroidDiscoveryPermissions/)
  assert.match(source, /PermissionsAndroid\.request\(PermissionsAndroid\.PERMISSIONS\.NEARBY_WIFI_DEVICES\)/)
  assert.match(source, /setAndroidDiscoveryPermissionStatus/)
  assert.match(source, /requirePeartubeNetworkDiscovery\(\)/)
  assert.match(source, /await discoveryModule\.getDiscoveryNetworkStatus\(\)/)
  assert.doesNotMatch(source, /acquireMulticastLock\(\)/)
  assert.doesNotMatch(source, /releaseMulticastLock\(\)/)
  assert.match(source, /initNativeBackend\(\)/)
  const helperIndex = source.indexOf('const requestAndroidDiscoveryPermissions = useCallback')
  const effectCallIndex = source.indexOf('await requestAndroidDiscoveryPermissions()')
  assert.ok(
    helperIndex >= 0 && effectCallIndex > helperIndex,
    'permissions helper should be defined before the native backend boot effect uses it',
  )
})

test('Android discovery permission helper requests Nearby Wi-Fi only on Android 33+', () => {
  const permissions = {
    POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS',
    NEARBY_WIFI_DEVICES: 'android.permission.NEARBY_WIFI_DEVICES',
  }

  assert.deepEqual(getAndroidDiscoveryPermissionRequests({ platformOS: 'ios', platformVersion: 17, permissions }), [])
  assert.deepEqual(getAndroidDiscoveryPermissionRequests({ platformOS: 'android', platformVersion: 32, permissions }), [])
  assert.deepEqual(getAndroidDiscoveryPermissionRequests({ platformOS: 'android', platformVersion: 33, permissions }), [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.NEARBY_WIFI_DEVICES',
  ])
})

test('feed discovery state distinguishes permission, transport, cached fallback, and empty discovery states', () => {
  assert.deepEqual(classifyFeedDiscoveryState({ ready: false }), {
    state: 'backend-starting',
    recoverable: true,
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    permissionStatus: { nearbyWifi: 'denied' },
  }), {
    state: 'permission-degraded',
    recoverable: true,
    reason: 'nearby-wifi-denied',
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    entries: [],
    videos: [],
    swarmStatus: { doctor: { recommendedBoundary: 'transport-socket' } },
  }), {
    state: 'network-degraded',
    recoverable: true,
    reason: 'transport-socket',
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    entries: [],
    videos: [],
    hasCachedSnapshot: true,
  }), {
    state: 'cached-fallback',
    recoverable: true,
    reason: 'zero-peers-no-entries',
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    entries: [],
    videos: [],
  }), {
    state: 'discovery-waiting',
    recoverable: true,
    reason: 'zero-peers-no-entries',
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    entries: [{ driveKey: 'live-feed' }],
    videos: [],
    swarmStatus: { feedEntries: 88, feedConnections: 0, swarmPeers: 8 },
  }), {
    state: 'hydrating',
    recoverable: true,
  })

  assert.deepEqual(classifyFeedDiscoveryState({
    ready: true,
    entries: [],
    videos: [],
    swarmStatus: { swarmPeers: 8, swarmConnections: 0, feedConnections: 0, doctor: { recommendedBoundary: 'transport-socket' } },
  }), {
    state: 'network-degraded',
    recoverable: true,
    reason: 'transport-socket',
  })
})

test('Home Discover separates feed counts from peers and does not call hydrating entries peerless', () => {
  const source = readAppFile('app/(tabs)/index.tsx')

  assert.match(source, /Feed: \{displayFeedEntries\}/, 'Home should show feed entries as Feed, not overload Channels or Peers')
  assert.match(source, /Channels: \{displayChannels\}/, 'Home should still show visible/discovered channel count separately')
  assert.doesNotMatch(source, /5 feed\/channel signals detected; waiting for playable previews/, 'Home should not show stale feed-channel signal copy from older builds')
  assert.match(source, /state === 'hydrating'[\s\S]*\? 'Loading video previews'/, 'hydrating feed entries should not be labeled as looking for peers')
  assert.match(source, /Feed entries detected; resolving video preview metadata\./, 'hydrating detail should mention feed entries being resolved')
})

test('Android registers network discovery as a legacy BaseReactPackage so release new-architecture builds expose NativeModules.PeartubeNetworkDiscovery', () => {
  const packageSource = readAppFile('android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscoveryPackage.kt')

  assert.match(packageSource, /BaseReactPackage/, 'release new-architecture builds should register the plain native module in the legacy registry')
  assert.doesNotMatch(packageSource, /TurboReactPackage/, 'plain ReactContextBaseJavaModule instances should not be advertised as TurboModules')
  assert.match(packageSource, /override fun getModule\(name: String, reactContext: ReactApplicationContext\): NativeModule\?/, 'package should expose getModule lookup by module name')
  assert.match(packageSource, /if \(name == "PeartubeNetworkDiscovery"\)/, 'package should return the discovery module by exported name')
  assert.match(packageSource, /ReactModuleInfoProvider/, 'package should provide ReactModuleInfo metadata for the custom module')
  assert.match(packageSource, /PeartubeNetworkDiscoveryModule::class\.java\.name/, 'metadata should reference the module class name')
  assert.match(packageSource, /PeartubeNetworkDiscoveryModule::class\.java\.name,[\s\S]*false,[\s\S]*\)/, 'metadata should keep isTurboModule=false so NativeModules can instantiate it')
})

test('Expo prebuild regenerates Android network discovery native sources and MainApplication wiring', () => {
  const appConfig = JSON.parse(readAppFile('app.json'))
  const plugins = appConfig.expo.plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin)

  assert.ok(
    plugins.includes('./plugins/withAndroidNetworkDiscovery.js'),
    'clean Android prebuilds must run the network discovery config plugin',
  )

  const pluginSource = readAppFile('plugins/withAndroidNetworkDiscovery.js')

  assert.match(pluginSource, /withDangerousMod/, 'plugin should write native Kotlin files during prebuild')
  assert.match(pluginSource, /PeartubeNetworkDiscovery\.kt/, 'plugin should regenerate discovery lifecycle source')
  assert.match(pluginSource, /PeartubeNetworkDiscoveryModule\.kt/, 'plugin should regenerate the React Native module')
  assert.match(pluginSource, /PeartubeNetworkDiscoveryPackage\.kt/, 'plugin should regenerate the package registration')
  assert.match(pluginSource, /PeartubeNetworkDiscoveryPackage\(\)/, 'plugin should patch MainApplication package registration')
  assert.match(pluginSource, /registerActivityLifecycleCallbacks/, 'plugin should patch MainApplication lifecycle callbacks')
  assert.match(pluginSource, /networkDiscovery\.start\(\)/, 'plugin should start discovery from the application lifecycle')
  assert.match(pluginSource, /networkDiscovery\.stop\(\)/, 'plugin should stop discovery when the app leaves foreground')
})
