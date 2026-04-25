import test from 'brittle'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const backendRoot = new URL('..', import.meta.url)
const repoRoot = new URL('../../..', import.meta.url)

const removedBackendExports = [
  './channel',
  './public-feed',
  './video-stats',
  './seeding',
  './upload',
  './hash-utils'
]

const removedBackendFiles = [
  'src/channel',
  'src/public-feed.js',
  'src/video-stats.js',
  'src/seeding.js',
  'src/seeding-tracker.js',
  'src/upload.js',
  'src/hash-utils.js',
  'src/public-bee-loader.js',
  'src/startup-gates.js',
  'src/storage-layout.js',
  'src/prefetch.js'
]

test('backend package exposes engine-first boundary without legacy feed/upload exports', (t) => {
  const packageJson = JSON.parse(readFileSync(new URL('package.json', backendRoot), 'utf8'))

  for (const exportName of removedBackendExports) {
    t.absent(packageJson.exports?.[exportName], `${exportName} export should be removed`)
  }
})

test('legacy Autobase/PublicBee/upload backend implementation files are deleted', (t) => {
  for (const relativePath of removedBackendFiles) {
    const path = join(repoRoot.pathname, 'packages/backend', relativePath)
    t.absent(existsSync(path), `${relativePath} should be deleted`)
  }
})
