import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('P2PStatsBar does not report video connected from global swarm fallback', () => {
  const source = read('app/video/[id].tsx')

  assert.doesNotMatch(
    source,
    /swarmStatus\?\.swarmPeers/,
    'global discovered swarm peers must not be used as a connected/video peer fallback',
  )
  assert.doesNotMatch(
    source,
    /if \(global(?:Peers|Connections) > 0\) return \{ color: '#60a5fa', label: 'Connected' \}/,
    'missing video stats must not label the video as Connected from global network state',
  )
  assert.match(
    source,
    /label: 'Waiting for video peers'/,
    'missing video stats should keep the video-specific status waiting for video peers',
  )
  assert.match(
    source,
    /Network online: \{globalConnections\} connection/,
    'global network state may be shown only as a separate diagnostic',
  )
  assert.match(
    source,
    /const connectionCount = swarmStatus\?\.swarmConnections \?\? 0/,
    'network diagnostics should use explicit connection counts, not discovered peer candidates',
  )
})
