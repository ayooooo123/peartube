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

for (const [label, relativePath] of [
  ['native', 'app/channel/[key].tsx'],
  ['web', 'app/channel/[key].web.tsx'],
]) {
  test(`${label} channel page bounds independent metadata/video hydration`, () => {
    const source = read(relativePath)

    assert.match(source, /CHANNEL_PAGE_RPC_TIMEOUT_MS = 4500/, `${label} channel page should define a bounded RPC timeout`)
    assert.match(source, /withChannelPageTimeout/, `${label} channel page should wrap RPC hydration in a timeout`)
    assert.match(source, /Promise\.allSettled/, `${label} channel page should hydrate metadata and videos independently`)
    assert.doesNotMatch(
      source,
      /await Promise\.all\(\[\s*\n\s*rpc\.getChannelMeta[\s\S]*?rpc\.listVideos/s,
      `${label} channel page must not block the whole skeleton on one Promise.all`,
    )
    assert.match(
      source,
      /success\) === false|success === false/,
      `${label} channel page should treat unsuccessful video-list responses as degraded, not empty`,
    )
    assert.match(source, /Retry/, `${label} channel page should leave a retry path in degraded state`)
  })
}
