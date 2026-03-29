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
