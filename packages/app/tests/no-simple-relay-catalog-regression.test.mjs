import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

function read(rel) {
  return readFileSync(join(appRoot, rel), 'utf8')
}

test('Home feed no longer imports or merges Simple relay catalog entries', () => {
  const source = read('app/(tabs)/index.tsx')
  assert.doesNotMatch(source, /simple-relay-catalog/)
  assert.doesNotMatch(source, /fetchRelayCatalogEntries/)
  assert.doesNotMatch(source, /readRelayCatalogUrlFromDisk/)
})

test('Settings no longer exposes Simple relay catalog URL as discovery UX', () => {
  const source = read('app/(tabs)/settings.tsx')
  assert.doesNotMatch(source, /Simple relay catalog URL/)
  assert.doesNotMatch(source, /catalog\.json/)
  assert.doesNotMatch(source, /saveRelayCatalogUrl/)
})
