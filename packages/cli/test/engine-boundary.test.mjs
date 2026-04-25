import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cliRoot = new URL('..', import.meta.url)

function readCliSource(relativePath) {
  return readFileSync(new URL(relativePath, cliRoot), 'utf8')
}

test('cli no longer imports legacy PublicBee/backend storage internals', () => {
  const checkedFiles = [
    'src/index.js',
    'src/init.js',
    'src/blob-downloader.js',
    'src/runtime.js',
    'src/cache-manager.js'
  ]

  for (const file of checkedFiles) {
    const source = readCliSource(file)
    assert.equal(source.includes('@peartube/backend/public-feed'), false, `${file} should not import public-feed`)
    assert.equal(source.includes('loadPublicBee'), false, `${file} should not reference loadPublicBee`)
    assert.equal(source.includes('PublicFeedManager'), false, `${file} should not reference PublicFeedManager`)
    assert.equal(source.includes('ctx.store.get('), false, `${file} should not pull raw Hypercores from ctx.store`)
    assert.equal(source.includes("import('corestore')"), false, `${file} should not type against raw Corestore`)
    assert.equal(source.includes("import('hyperbee')"), false, `${file} should not type against raw Hyperbee`)
  }
})
