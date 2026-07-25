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
    "item.entityKind === 'collection'",
    "item.entityKind === 'agent'",
    "'/collection/[id]'",
    "'/creator/[id]'",
    "'/media/[id]'",
    'encodeMediaEntityRouteParam(item',
    'getMediaEntityRouteId(item',
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
  assert.match(source, /onEntityPress\(item\.entityId, item\)/)
})


test('shared entity details preserve inspectable media evidence without RPC dependencies', () => {
  const detail = readApp('components/media/MediaEntityDetailScreen.tsx')
  const sourceSelector = readApp('components/media/SourceSelector.tsx')
  const provenancePanel = readApp('components/media/ProvenancePanel.tsx')
  const archiveStatus = readApp('components/media/ArchiveStatus.tsx')

  for (const required of [
    'SourceSelector',
    'ProvenancePanel',
    'ConflictNotice',
    'ArchiveStatus',
  ]) {
    assert.ok(detail.includes(required), `shared media details should contain ${required}`)
  }
  assert.ok(sourceSelector.includes('Playable publications and renditions'))
  assert.ok(provenancePanel.includes('Publisher claims'))
  assert.ok(archiveStatus.includes('No archive evidence yet'))
  assert.doesNotMatch(detail, /getMediaGraph\(|resolveMediaEntity\(|rpc\./)
})
