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

test('native root layout provides safe-area context before the video overlay mounts', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /import \{ SafeAreaProvider \} from 'react-native-safe-area-context'/,
    'native root layout should import SafeAreaProvider because VideoPlayerOverlay uses useSafeAreaInsets',
  )
  assert.match(
    source,
    /<SafeAreaProvider>[\s\S]*<GluestackUIProvider[\s\S]*<VideoPlayerOverlay \/>[\s\S]*<\/SafeAreaProvider>/,
    'native root layout should wrap the provider tree in SafeAreaProvider before rendering VideoPlayerOverlay',
  )
})

test('native root layout installs dev warning filters before nativewind css interop loads', () => {
  const source = readAppFile('app/_layout.tsx')
  const warningSource = readAppFile('lib/ignoreDevWarnings.ts')

  assert.ok(
    source.indexOf("import '@/lib/ignoreDevWarnings'") >= 0,
    'native root layout should import warning filters',
  )
  assert.ok(
    source.indexOf("import '@/lib/ignoreDevWarnings'") < source.indexOf("import '../global.css'"),
    'warning filters should run before global.css can load nativewind css interop',
  )
  assert.match(
    warningSource,
    /SafeAreaView has been deprecated and will be removed in a future release\./,
    'warning filter should suppress the third-party SafeAreaView deprecation toast',
  )
  assert.match(
    warningSource,
    /LogBox\.ignoreLogs\(IGNORED_DEV_WARNINGS\)/,
    'warning filter should register ignored warnings with LogBox',
  )
  assert.match(
    warningSource,
    /setTimeout\(\(\) => LogBox\.clearAllLogs\(\), 0\)/,
    'warning filter should clear any early ignored warning collected during module startup',
  )
  assert.match(
    warningSource,
    /console\.warn = \(\.\.\.args: any\[\]\) =>/,
    'warning filter should patch early console warnings before LogBox receives them',
  )
})

test('native root layout does not warn for optional downloader worker absence', () => {
  const source = readAppFile('app/_layout.tsx')

  assert.match(
    source,
    /console\.log\('\[App\] Downloader worker bundle unavailable - continuing without downloader worker'\)/,
    'missing optional downloader worker should be a normal log',
  )
  assert.doesNotMatch(
    source,
    /console\.warn\('\[App\] Downloader worker bundle unavailable - continuing without downloader worker'\)/,
    'missing optional downloader worker should not trip LogBox',
  )
})
