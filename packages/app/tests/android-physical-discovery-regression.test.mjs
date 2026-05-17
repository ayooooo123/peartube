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

test('Android native discovery module owns MulticastLock lifecycle and status diagnostics', () => {
  const moduleSource = readAppFile('android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscoveryModule.kt')
  const packageSource = readAppFile('android/app/src/main/java/com/peartube/app/PeartubeNetworkDiscoveryPackage.kt')
  const applicationSource = readAppFile('android/app/src/main/java/com/peartube/app/MainApplication.kt')

  assert.match(moduleSource, /WifiManager\.MulticastLock/)
  assert.match(moduleSource, /createMulticastLock\("peartube-network-discovery"\)/)
  assert.match(moduleSource, /setReferenceCounted\(false\)/)
  assert.match(moduleSource, /fun acquireMulticastLock\(/)
  assert.match(moduleSource, /fun releaseMulticastLock\(/)
  assert.match(moduleSource, /fun getDiscoveryNetworkStatus\(/)
  assert.match(packageSource, /PeartubeNetworkDiscoveryModule\(reactContext\)/)
  assert.match(applicationSource, /add\(PeartubeNetworkDiscoveryPackage\(\)\)/)
})

test('root layout requests Android discovery permissions, records results, and acquires MulticastLock before backend startup', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(source, /NativeModules/)
  assert.match(source, /PeartubeNetworkDiscovery/)
  assert.match(source, /requestAndroidDiscoveryPermissions/)
  assert.match(source, /PermissionsAndroid\.request\(PermissionsAndroid\.PERMISSIONS\.NEARBY_WIFI_DEVICES\)/)
  assert.match(source, /setAndroidDiscoveryPermissionStatus/)
  assert.match(source, /acquireMulticastLock\?\.\(\)/)
  assert.match(source, /initNativeBackend\(\)/)
  assert.match(source, /Android discovery permission status|Android discovery access|getDiscoveryNetworkStatus|doctor: \(status as any\)\.doctor \|\| undefined/)
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

  const discoverSource = readAppFile('app/(tabs)/discover.tsx')
  const homeSource = readAppFile('app/(tabs)/index.tsx')
  assert.match(discoverSource, /classifyFeedDiscoveryState/)
  assert.match(discoverSource, /Looking for peers/)
  assert.match(discoverSource, /peerCount: \${peerCount}. Keep the app open or pull to refresh./)
  assert.match(discoverSource, /Network boundary: \${discoveryReason \|\| 'unknown'}. Pull to retry the feed path./)

  assert.match(homeSource, /const backendPeerSignal = Math\.max\([\s\S]*swarmStatus\?\.swarmConnections[\s\S]*swarmStatus\?\.feedConnections[\s\S]*swarmStatus\?\.swarmPeers[\s\S]*snapshotChannelKeys\.size/, 'Home should derive peer status from all backend/feed/snapshot signals')
  assert.match(homeSource, /const visibleChannelCount = Math\.max\(feedEntries\.length, snapshotChannelKeys\.size, Number\(swarmStatus\?\.channels \|\| 0\)\)/, 'Home channel count should include cached snapshot channels and backend-loaded channels')
  assert.match(homeSource, /peerCount: backendPeerSignal/, 'Home feed discovery classification should use aggregate backend signals, not stale public-feed peerCount only')
  assert.match(homeSource, /Peers: \{discoveryPeerLabel\}/, 'Home status pill should not show 0 peers when swarm or feed signals are nonzero')
  assert.match(homeSource, /Channels: \{visibleChannelCount\}/, 'Home status pill should not show 0 channels when cached playable feed channels exist')
  assert.match(homeSource, /peer\/feed signals detected; waiting for playable previews/, 'Home empty copy should acknowledge backend/feed activity instead of claiming zero live peers')
})
