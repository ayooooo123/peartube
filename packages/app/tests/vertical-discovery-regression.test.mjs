import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const appRoot = path.resolve(import.meta.dirname, '..')
const readAppFile = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), 'utf8')

test('Discover uses the shared paged media catalog without route-local caches', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  assert.match(source, /useMediaCatalog/)
  assert.match(source, /MediaCatalogView/)
  assert.match(source, /catalog\.refresh\(\)/)
  assert.match(source, /catalog\.loadNext\(\)/)
  assert.doesNotMatch(source, /cache|setInterval|setTimeout|getContentCatalog/)
})

test('Discover navigates resolved entities through the media route', () => {
  const source = readAppFile('app/(tabs)/discover.tsx')
  assert.match(source, /const openEntity = useCallback\(\(entityId: string\)/)
  assert.match(source, /pathname: '\/media\/\[id\]'/)
  assert.match(source, /params: \{ id: entityId \}/)
  assert.match(source, /onEntityPress=\{openEntity\}/)
})

test('catalog update and foreground lifecycle are centralized in the shared hook', () => {
  const source = readAppFile('hooks/useMediaCatalog.ts')
  assert.match(source, /onMediaGraphUpdate/)
  assert.match(source, /handleGraphUpdate\(update\)/)
  assert.match(source, /AppState\.addEventListener\('change'/)
  assert.match(source, /handleForeground\(\)/)
  assert.doesNotMatch(source, /setInterval|setTimeout/)
})
