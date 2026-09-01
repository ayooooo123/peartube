import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = readJson('../package.json')
const lock = readJson('../package-lock.json')

assert.equal(manifest.dependencies?.['udx-native'], '1.20.7')
assert.equal(manifest.devDependencies?.['bare-process'], '4.5.1')
assert.equal(lock.packages?.['node_modules/udx-native']?.version, '1.20.7')
assert.equal(lock.packages?.['node_modules/bare-process']?.version, '4.5.1')

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}
