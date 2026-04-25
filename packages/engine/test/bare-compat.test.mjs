import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('engine core has no static Node-only imports so Bare/mobile can load the module', async () => {
  const source = await readFile(join(__dirname, '../src/engine.mjs'), 'utf8')

  assert.equal(source.includes("from 'node:fs/promises'"), false)
  assert.equal(source.includes('from "node:fs/promises"'), false)
  assert.equal(source.includes("from 'node:crypto'"), false)
  assert.equal(source.includes('from "node:crypto"'), false)
})
