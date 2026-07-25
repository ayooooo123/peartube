import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')
const readApp = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), 'utf8')

test('desktop Home uses the resolved media entity catalog', () => {
  const source = readApp('app/(tabs)/index.web.tsx')
  for (const required of [
    'useMediaCatalog',
    'MediaCatalogView',
    'state={catalog}',
    'diagnostic={catalog.diagnostic}',
    'catalog.refresh()',
    'catalog.loadNext()',
    "pathname: '/media/[id]'",
  ]) {
    assert.ok(source.includes(required), `desktop Home should contain ${required}`)
  }
  assert.doesNotMatch(source, /getContentCatalog|getRecommendations|setInterval|setTimeout/)
})

test('desktop catalog cards expose unified source, archive, and trust signals', () => {
  const source = readApp('components/media/MediaCatalogView.tsx')
  assert.match(source, /sourceForDisplay/)
  assert.match(source, /Archive: \{archiveState\}/)
  assert.match(source, /verified \{claimCount === 1 \? 'claim' : 'claims'\}/)
  assert.match(source, /conflictCount/)
  assert.match(source, /onEntityPress\(item\.entityId\)/)
})
