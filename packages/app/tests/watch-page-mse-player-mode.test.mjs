import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { getWatchPageKey, shouldUseMsePlayerForWatch } from '../lib/watch-page-player-mode.mjs'

test('shouldUseMsePlayerForWatch only enables MSE for the currently active watch page', () => {
  const staleWatchKey = getWatchPageKey('channel-a', 'video-a')
  const currentWatchKey = getWatchPageKey('channel-b', 'video-b')

  assert.equal(shouldUseMsePlayerForWatch(null, currentWatchKey), false)
  assert.equal(shouldUseMsePlayerForWatch(staleWatchKey, currentWatchKey), false)
  assert.equal(shouldUseMsePlayerForWatch(currentWatchKey, currentWatchKey), true)
})

test('WatchPageView scopes the MSE fallback state to the current watch key instead of resetting it in an effect', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const sourcePath = path.resolve(testDir, '../app/(tabs)/index.web.tsx')
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /const watchPageKey = getWatchPageKey\(channelKey, videoId\)/)
  assert.match(source, /const \[msePlayerWatchKey, setMsePlayerWatchKey\] = useState<string \| null>\(null\)/)
  assert.match(source, /const useMsePlayer = shouldUseMsePlayerForWatch\(msePlayerWatchKey, watchPageKey\)/)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{ setUseMsePlayer\(false\) \}, \[channelKey, videoId\]\)/)
})
