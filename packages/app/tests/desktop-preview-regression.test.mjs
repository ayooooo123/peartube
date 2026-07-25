import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const desktopHomeSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/(tabs)/index.web.tsx'), 'utf8')
const searchSource = fs.readFileSync(path.join(repoRoot, 'packages/app/app/search.tsx'), 'utf8')

test('desktop Home renders the shared paged media catalog', () => {
  assert.match(desktopHomeSource, /useMediaCatalog/)
  assert.match(desktopHomeSource, /MediaCatalogView/)
  assert.match(desktopHomeSource, /onRefresh=\{\(\) => \{ void catalog\.refresh\(\) \}\}/)
  assert.match(desktopHomeSource, /onLoadNext=\{\(\) => \{ void catalog\.loadNext\(\) \}\}/)
  assert.match(desktopHomeSource, /'\/collection\/\[id\]'[\s\S]*'\/creator\/\[id\]'[\s\S]*'\/media\/\[id\]'/)
  assert.match(desktopHomeSource, /getMediaEntityRouteId\(item as any\)/)
  assert.doesNotMatch(desktopHomeSource, /getContentCatalog|setInterval|setTimeout/)
})

test('desktop Search preserves direct blob refs from search metadata', () => {
  assert.match(searchSource, /blobId:\s*metadata\.blobId \|\| undefined/)
  assert.match(searchSource, /blobsCoreKey:\s*metadata\.blobsCoreKey \|\| undefined/)
  assert.match(searchSource, /thumbnailBlobId:\s*metadata\.thumbnailBlobId \|\| undefined/)
  assert.match(searchSource, /__peartubePendingWatchVideo = pendingWatch/)
  assert.match(searchSource, /peartube:watch-video/)
})
