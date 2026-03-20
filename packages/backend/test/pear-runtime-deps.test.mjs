import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const backendPackagePath = path.resolve(import.meta.dirname, '../package.json')
const pearPackagePath = path.resolve(import.meta.dirname, '../../app/pear-src/package.json')

const PEAR_RUNTIME_DEP_OVERRIDES = new Set([
  '@peartube/backend',
  '@peartube/core',
  '@peartube/platform',
  '@peartube/protocol',
  '@peartube/spec'
])

const backendPackage = JSON.parse(fs.readFileSync(backendPackagePath, 'utf8'))
const pearPackage = JSON.parse(fs.readFileSync(pearPackagePath, 'utf8'))

const missing = Object.keys(backendPackage.dependencies)
  .filter((name) => !PEAR_RUNTIME_DEP_OVERRIDES.has(name))
  .filter((name) => !(name in pearPackage.dependencies))
  .sort()

assert.deepStrictEqual(
  missing,
  [],
  `Pear desktop manifest is missing backend runtime deps: ${missing.join(', ')}`
)

console.log('PASS: pear desktop manifest includes backend runtime dependencies')
