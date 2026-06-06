import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

test('native VideoCard memo comparison treats onPress changes as render-relevant after video data matches', () => {
  const source = fs.readFileSync(
    path.join(appRoot, 'components/video/VideoCard.tsx'),
    'utf8',
  )

  const comparisonStart = source.indexOf('function arePropsEqual')
  assert.notEqual(comparisonStart, -1, 'VideoCard should define a custom memo comparator')
  const comparisonSource = source.slice(comparisonStart, source.indexOf('export const VideoCard', comparisonStart))

  const deepReturnStart = comparisonSource.indexOf('// Deep comparison of video data that affects rendering')
  assert.notEqual(deepReturnStart, -1, 'VideoCard comparator should have a deep comparison branch')
  const deepComparisonSource = comparisonSource.slice(deepReturnStart)

  assert.match(
    deepComparisonSource,
    /prevProps\.onPress\s*===\s*nextProps\.onPress/,
    'the deep memo comparison must return false when onPress changes; otherwise cards can keep a stale no-op press handler from before rpc readiness',
  )
})
