import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { getWatchPageKey, shouldUseMseBackendForWatch } from '../lib/watch-page-mse-backend-mode.mjs'

test('shouldUseMseBackendForWatch only enables MSE for the currently active watch page', () => {
  const staleWatchKey = getWatchPageKey('channel-a', 'video-a')
  const currentWatchKey = getWatchPageKey('channel-b', 'video-b')

  assert.equal(shouldUseMseBackendForWatch(null, currentWatchKey), false)
  assert.equal(shouldUseMseBackendForWatch(staleWatchKey, currentWatchKey), false)
  assert.equal(shouldUseMseBackendForWatch(currentWatchKey, currentWatchKey), true)
})

test('WatchPageView scopes the MSE fallback state to the current watch key instead of resetting it in an effect', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const sourcePath = path.resolve(testDir, '../app/(tabs)/index.web.tsx')
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /const watchPageKey = getWatchPageKey\(channelKey, videoId\)/)
  assert.match(source, /const \[mseBackendWatchKey, setMseBackendWatchKey\] = useState<string \| null>\(null\)/)
  assert.match(source, /const useMseBackend = shouldUseMseBackendForWatch\(mseBackendWatchKey, watchPageKey\)/)
  assert.match(source, /webPlaybackBackend=\{useMseBackend \? 'mse' : 'native'\}/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{ setUseMsePlayer\(false\) \}, \[channelKey, videoId\]\)/)
})
