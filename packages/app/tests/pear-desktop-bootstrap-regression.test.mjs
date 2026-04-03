import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(appRoot, '..', '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('protocol package uses package imports instead of workspace-relative source paths', () => {
  const protocolIndex = readWorkspaceFile('packages/protocol/src/index.js')
  const createClient = readWorkspaceFile('packages/protocol/src/create-client.js')
  const backendEntry = readWorkspaceFile('packages/backend/src/backend-entry.js')
  const mobileBackendEntry = readWorkspaceFile('packages/app/backend/index.mjs')
  const hostStart = readWorkspaceFile('packages/host/src/start-host.js')

  assert.doesNotMatch(protocolIndex, /\.\.\/\.\.\/host\/src\//)
  assert.doesNotMatch(createClient, /\.\.\/\.\.\/host\/src\//)
  assert.doesNotMatch(createClient, /\.\.\/\.\.\/spec\/spec\//)
  assert.doesNotMatch(backendEntry, /\.\.\/\.\.\/spec\/spec\//)
  assert.doesNotMatch(mobileBackendEntry, /\.\.\/\.\.\/host\/src\//)
  assert.doesNotMatch(hostStart, /\.\.\/\.\.\/backend\/src\//)
})

test('pear desktop package declares the host dependency needed by worker-client protocol imports', () => {
  const pearPackage = JSON.parse(readAppFile('pear-src/package.json'))

  assert.equal(
    pearPackage.dependencies['@peartube/host'],
    'file:../../host',
  )
})

test('mobile backend bundle watcher tracks host and protocol package changes', () => {
  const ensureBundlesScript = readAppFile('scripts/ensure-backend-bundles.js')

  assert.match(ensureBundlesScript, /packages', 'host', 'src'/)
  assert.match(ensureBundlesScript, /packages', 'protocol', 'src'/)
  assert.match(ensureBundlesScript, /packages', 'host', 'package\.json'/)
  assert.match(ensureBundlesScript, /packages', 'protocol', 'package\.json'/)
})

test('pear desktop bootstrap waits for and injects worker-client ahead of the Expo entry bundle', () => {
  const rpcWeb = readWorkspaceFile('packages/platform/src/rpc.web.ts')
  const injectScript = readAppFile('pear-src/scripts/inject-pear-bar.js')

  assert.match(rpcWeb, /async function waitForPearWorkerClient/)
  assert.match(rpcWeb, /await waitForPearWorkerClient\(\)/)
  assert.match(injectScript, /EXPO_ENTRY_SCRIPT_PATTERN/)
  assert.match(injectScript, /\\\/_expo\\\/static\\\/js\\\/web\\\//)
})

function lineOf(source, needle) {
  const offset = source.indexOf(needle)
  assert.notEqual(offset, -1, `Expected source to contain: ${needle}`)
  return source.slice(0, offset).split('\n').length
}

test('VideoPlayerContext declares callback helpers before effect sites that reference them', () => {
  const source = readAppFile('lib/VideoPlayerContext.tsx')
  const closeSessionLine = lineOf(source, 'const closeSession = useCallback(')
  const enterBackgroundAudioLine = lineOf(source, 'const enterBackgroundAudio = useCallback(')
  const launchSplitPlayerActivityLine = lineOf(source, 'const launchSplitPlayerActivity = useCallback(')

  assert.ok(
    launchSplitPlayerActivityLine < lineOf(source, "void launchSplitPlayerActivity(true, 'background')"),
    'launchSplitPlayerActivity should be declared before the AppState background effect uses it',
  )
  assert.ok(
    launchSplitPlayerActivityLine < lineOf(source, "void launchSplitPlayerActivity(true, 'minimize')"),
    'launchSplitPlayerActivity should be declared before the minimize flow uses it',
  )
  assert.ok(
    enterBackgroundAudioLine < lineOf(source, 'enterBackgroundAudio()'),
    'enterBackgroundAudio should be declared before the remote command effect uses it',
  )
  assert.ok(
    closeSessionLine < lineOf(source, "closeSession('pip-close')"),
    'closeSession should be declared before the remote stop handler uses it',
  )
  assert.ok(
    closeSessionLine < lineOf(source, "closeSession('android-minimize-close')"),
    'closeSession should be declared before the Android minimize cleanup effect uses it',
  )
})

test('VideoPlayerOverlay declares overlay helpers before render/effect sites that use them', () => {
  const source = readAppFile('components/VideoPlayerOverlayImpl.tsx')
  const showControlsTemporarilyLine = lineOf(source, 'const showControlsTemporarily = useCallback(')
  const miniPlayerSizeModeLine = lineOf(source, "const [miniPlayerSizeMode, setMiniPlayerSizeMode] = useState<'compact' | 'expanded'>('compact')")

  assert.ok(
    showControlsTemporarilyLine < lineOf(source, 'showControlsTemporarily()'),
    'showControlsTemporarily should be declared before the PiP exit effect uses it',
  )
  assert.ok(
    miniPlayerSizeModeLine < lineOf(source, 'const { width: dynMiniWidth, height: dynMiniHeight } = computeMiniSize(screenWidth, effectiveAR, miniPlayerSizeMode)'),
    'miniPlayerSizeMode should be declared before dynamic mini-player size is computed',
  )
})
