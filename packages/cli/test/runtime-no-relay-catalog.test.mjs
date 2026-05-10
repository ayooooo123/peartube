import test from 'brittle'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeSource = readFileSync(join(here, '../src/runtime.js'), 'utf8')

test('relay runtime does not restore cached channels as relay catalog feed entries', (t) => {
  t.absent(runtimeSource.includes('submitRelayCatalogEntry'))
  t.absent(runtimeSource.includes('relayRole'))
  t.absent(runtimeSource.includes('relayServing'))
  t.absent(runtimeSource.includes('relayCatalogEntries'))
})
