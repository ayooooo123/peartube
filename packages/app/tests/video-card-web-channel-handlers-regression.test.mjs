import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

test('VideoCard.web builds channel interaction handlers once and spreads them onto both targets', () => {
  const source = fs.readFileSync(
    path.join(appRoot, 'components/video/VideoCard.web.tsx'),
    'utf8',
  )

  assert.match(
    source,
    /const channelInteractiveProps = onChannelPress\s*\?\s*\{/,
    'channel handlers should be extracted into a single channelInteractiveProps object',
  )

  const spreadMatches = source.match(/\{\.\.\.\(channelInteractiveProps \?\? \{\}\)\}/g) || []
  assert.equal(
    spreadMatches.length,
    2,
    'channelInteractiveProps should be spread onto both the avatar container and the channel name',
  )

  assert.doesNotMatch(
    source,
    /onClick=\{onChannelPress \?\s*\(e\)\s*=>\s*\{\s*e\.stopPropagation\(\);?\s*onChannelPress\(\)\s*\}\s*:\s*undefined\}/,
    'inline onChannelPress click ternary should not be duplicated on individual elements',
  )
})
