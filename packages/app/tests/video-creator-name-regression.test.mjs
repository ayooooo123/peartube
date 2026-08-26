import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const appRoot = path.join(repoRoot, 'packages/app')

function readApp(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

test('VideoCard display falls back to archived creatorName before generic channel labels', () => {
  const nativeCard = readApp('components/video/VideoCard.tsx')
  const webCard = readApp('components/video/VideoCard.web.tsx')

  assert.match(nativeCard, /creatorName\?: string \| null/)
  assert.match(nativeCard, /video\.creatorName \|\| video\.channel\?\.name/)
  assert.match(nativeCard, /prev\.creatorName === next\.creatorName/)

  assert.match(webCard, /creatorName\?: string \| null/)
  assert.match(webCard, /video\.creatorName \|\| video\.channel\?\.name/)
})

test('Search renders publisher attribution from projected media summaries', () => {
  const search = readApp('app/search.tsx')

  assert.match(search, /MediaCatalogView/)
  assert.match(search, /MediaEntitySummary/)
  assert.doesNotMatch(search, /\bmetadata\b|creatorName:/)
})
