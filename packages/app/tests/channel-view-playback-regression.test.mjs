import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readApp(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('native channel view resolves remote thumbnails through the shared thumbnail RPC helper', () => {
  const source = readApp('app/channel/[key].tsx')

  assert.match(source, /fetchThumbnailUrlWithRetry/, 'channel view should request blob-backed thumbnail URLs instead of only trusting listVideos thumbnail fields')
  assert.match(source, /const \{ rpc: appRpc, blobServerPort \} = useApp\(\)/, 'channel view should use app RPC/blob server state for thumbnail resolution')
  assert.match(source, /thumbnailCache\[`\$\{channelKey\}:\$\{channelVideo\.id\}`\]/, 'rendered channel cards should use resolved thumbnail cache entries')
})

test('native channel video cards disable spring scale feedback that conflicts with route transitions', () => {
  const source = readApp('app/channel/[key].tsx')

  assert.match(source, /enableMotion\?: boolean/, 'press feedback should allow motion to be disabled')
  assert.match(source, /enableMotion=\{false\}/, 'channel video cards should not use the spring scale press animation')
})
