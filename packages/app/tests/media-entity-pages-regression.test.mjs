import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8')

test('media entity page exposes sources, provenance, conflicts, archive state, and contribution roles', () => {
  const route = read('components/routes/MediaEntityPage.tsx')
  for (const token of ['SourceSelector', 'ProvenancePanel', 'ConflictNotice', 'ArchiveStatus', 'ContributionList', 'mediaGraph.getMediaEntity', 'mediaGraph.getPublicationSources']) {
    assert.ok(route.includes(token), `missing ${token}`)
  }
  assert.match(route, /publisher/i)
  assert.match(route, /uploader|performer|director/i)
})

test('source selector preserves playback source identity while route identity remains entity id', () => {
  const component = read('components/media/SourceSelector.tsx')
  assert.match(component, /publicationId/)
  assert.match(component, /renditionId/)
  assert.match(component, /entityId/)
  assert.match(component, /onSelectSource/)
})

test('archive status explains uncertainty and never claims guaranteed permanence', () => {
  const component = read('components/media/ArchiveStatus.tsx')
  assert.match(component, /not guaranteed|not a guarantee|uncertain/i)
  assert.doesNotMatch(component, /guaranteed permanence/i)
})
