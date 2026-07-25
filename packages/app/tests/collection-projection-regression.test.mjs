import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8')

test('collection page renders completeness and missing member placeholders from graph RPC', () => {
  const route = read('components/routes/CollectionPage.tsx')
  assert.match(route, /mediaGraph.getMediaCollection/)
  assert.match(route, /mediaGraph.getMediaCollectionItems/)
  assert.match(route, /CollectionCompleteness/)
  assert.match(route, /missing|placeholder/i)
})

test('creator page assembles roles across publisher claims without making publisher the global owner', () => {
  const route = read('components/routes/CreatorPage.tsx')
  assert.match(route, /mediaGraph.getMediaAgent/)
  assert.match(route, /mediaGraph.getAgentContributions/)
  assert.match(route, /publisher/i)
  assert.match(route, /performer|director|uploader/i)
  assert.doesNotMatch(route, /globalOwner/)
})
