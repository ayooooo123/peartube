import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

// Regression: v0.1.26-v0.1.28 backend fixes did not reach upgraded users
// because the persisted backend bundle cache key only used app metadata. The
// Android release metadata stayed at version 1.0.0 / versionCode 1, so in-place
// upgrades could keep launching the stale cached worklet bundle.
test('native backend version key includes embedded bundle fingerprint so upgrades invalidate the cached worklet bundle', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /from '@peartube\/platform\/native-bundle-cache'/,
    'root layout must consume the platform bundle-cache helpers',
  )

  assert.match(
    source,
    /buildBundleVersionKey\(/,
    'root layout must compute the backend version key via buildBundleVersionKey so it includes a content fingerprint',
  )

  const fnIndex = source.indexOf('function getNativeBackendVersionKey(')
  assert.notEqual(fnIndex, -1, 'getNativeBackendVersionKey should still exist')
  const fnBlock = source.slice(fnIndex, fnIndex + 1500)
  assert.match(
    fnBlock,
    /backendSource\?: string \| null/,
    'version key helper must accept an embedded backend source so cache busts on bundle changes',
  )
  assert.match(
    fnBlock,
    /buildBundleVersionKey\(\{[\s\S]*?backendSource[\s\S]*?downloaderWorkerSource/,
    'version key helper must thread backend + downloader sources into buildBundleVersionKey',
  )

  const initCallIndex = source.indexOf('platformRPC.initPlatformRPC(')
  assert.notEqual(initCallIndex, -1, 'initPlatformRPC call should exist')
  const initBlock = source.slice(initCallIndex, initCallIndex + 1200)
  assert.match(
    initBlock,
    /backendVersionKey:\s*getNativeBackendVersionKey\(\s*[a-zA-Z]/,
    'backend version key must be derived from loaded sources, not app metadata alone',
  )
})

test('initPlatformRPC forwards relay launch options into native backend startup', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /const MOBILE_RELAY_PEERS = \[[\s\S]*?[a-f0-9]{64}[\s\S]*?\]/,
    'mobile startup must define relay public keys for backend direct dialing',
  )

  assert.match(
    source,
    /launchOptions:\s*\{[\s\S]*?__peartubeLaunchOptions:\s*true[\s\S]*?network:\s*\{[\s\S]*?relayPeers:\s*MOBILE_RELAY_PEERS[\s\S]*?swarmOptions:\s*\{[\s\S]*?knownPeers:\s*MOBILE_RELAY_PEERS/s,
    'mobile startup must pass explicit relay peer launch options into the backend worklet',
  )
})
