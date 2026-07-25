import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadMediaEntity } from '../components/routes/media-entity-loaders.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8')

test('media entity loader exposes sources, provenance, conflicts, and archive evidence', async () => {
  const rpc = {
    async getMediaEntity(request) {
      assert.deepEqual(request, { entityId: 'work-one', includeClaims: true, includeConflicts: true })
      return {
        success: true,
        entity: { entityId: 'work-one', title: 'Work One', archiveStatus: { pledgeCount: 2 } },
        claims: [{ claimId: 'claim-one', publisherId: 'publisher-one' }],
        conflicts: [{ field: 'title' }],
      }
    },
    async getPublicationSources(request) {
      assert.deepEqual(request, { entityId: 'work-one', limit: 64 })
      return {
        success: true,
        items: [{ publicationId: 'publication-one', renditionId: 'rendition-one', publisherId: 'publisher-one' }],
        nextCursor: null,
      }
    },
  }

  const result = await loadMediaEntity({ rpc, entityId: 'work-one' })

  assert.equal(result.sources[0].publicationId, 'publication-one')
  assert.equal(result.provenance[0].claimId, 'claim-one')
  assert.equal(result.conflicts[0].field, 'title')
  assert.equal(result.archiveStatus.pledgeCount, 2)
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
