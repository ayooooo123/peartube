import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appRoot = path.resolve(__dirname, '..')

function readAppFile(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8')
}

for (const relativePath of ['app/(tabs)/index.tsx', 'app/(tabs)/index.web.tsx']) {
  test(`${relativePath} treats expected backend startup feed race as a log`, () => {
    const source = readAppFile(relativePath)

    assert.match(
      source,
      /message\.includes\('Backend not ready'\)[\s\S]*console\.log\('\[Home\] Public feed load deferred until backend ready'\)/,
      'expected startup feed load races should not surface as LogBox errors',
    )
    assert.match(
      source,
      /else \{[\s\S]*console\.error\('\[Home\] Failed to load public feed:', err\)/,
      'unexpected feed load failures should still be logged as errors',
    )
  })
}
