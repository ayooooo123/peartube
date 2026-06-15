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

test('Android release manifest disables legacy storage and backup while allowing scoped local cleartext', () => {
  const manifest = readAppFile('android/app/src/main/AndroidManifest.xml')
  const appJson = JSON.parse(readAppFile('app.json'))
  const androidPipPlugin = readAppFile('plugins/withAndroidPiP.js')
  const buildPropertiesPlugin = appJson.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties')

  assert.match(manifest, /android:allowBackup="false"/)
  assert.match(manifest, /android:requestLegacyExternalStorage="false"/)
  assert.match(manifest, /android:usesCleartextTraffic="true"/)
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/)
  assert.match(manifest, /android:name="android\.permission\.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation"/)
  assert.match(manifest, /android:name="android\.permission\.POST_NOTIFICATIONS"/)
  assert.equal(buildPropertiesPlugin?.[1]?.android?.usesCleartextTraffic, true)
  assert.ok(appJson.expo.android.permissions.includes('android.permission.POST_NOTIFICATIONS'))
  assert.match(androidPipPlugin, /android:networkSecurityConfig'\] = '@xml\/network_security_config'/)
  assert.match(androidPipPlugin, /NETWORK_SECURITY_CONFIG/)
  assert.match(androidPipPlugin, /android:usesPermissionFlags'\] = 'neverForLocation'/)
})

test('Android network security config blocks cleartext except local development loopbacks', () => {
  const config = readAppFile('android/app/src/main/res/xml/network_security_config.xml')

  assert.match(config, /<base-config cleartextTrafficPermitted="false"\s*\/>/)
  assert.match(config, /<domain-config cleartextTrafficPermitted="true">/)
  assert.match(config, /<domain includeSubdomains="false">localhost<\/domain>/)
  assert.match(config, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/)
  assert.match(config, /<domain includeSubdomains="false">10\.0\.2\.2<\/domain>/)
})

test('root layout suspends native networking on background and resumes it on foreground', () => {
  const source = readAppFile('app/_layout.tsx')
  const handlerStart = source.indexOf('const handleAppStateChange = useCallback((nextState: AppStateStatus) => {')
  const handlerEnd = source.indexOf('  useEffect(() => {', handlerStart)
  const handlerBody = handlerStart >= 0 && handlerEnd > handlerStart ? source.slice(handlerStart, handlerEnd) : ''

  assert.ok(handlerBody, 'handleAppStateChange callback should exist')
  assert.match(source, /AppState\.addEventListener\('change', handleAppStateChange\)/)
  assert.match(handlerBody, /nextState === 'background'/)
  assert.match(handlerBody, /nextState === 'inactive' && Platform\.OS !== 'android'/)
  assert.match(handlerBody, /playbackActiveEmitter\.isActive/)
  assert.match(handlerBody, /platformRPC\.rpc\?\.suspendNetwork\?\.\(\)/)
  assert.match(handlerBody, /nextState === 'active'/)
  assert.match(handlerBody, /platformRPC\.rpc\?\.resumeNetwork\?\.\(\)/)
})

test('root layout mirrors local playback activity into the backend suspend guard', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(source, /setPlaybackActive/)
  assert.match(source, /playbackActiveEmitter\.isActive/)
  assert.match(source, /platformRPC\.rpc\?\.setPlaybackActive\?\.\(\{ active: nextActive \}\)/)
})
