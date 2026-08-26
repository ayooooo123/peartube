import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
// The settings tab is now a redirect to the Profile screen, which owns the
// storage card (renderStorageCard). Assert the storage UI lives there.
const profileSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'profile.tsx'), 'utf8')

test('profile storage card surfaces real disk usage, not only the tracked cache quota', () => {
  const storageStart = profileSource.indexOf('function renderStorageCard()')
  // The card body ends where the main component render begins.
  const storageEnd = profileSource.indexOf('<View style={styles.screen}>', storageStart + 1)
  const storageSection = storageStart >= 0 && storageEnd >= 0
    ? profileSource.slice(storageStart, storageEnd)
    : ''

  assert.ok(storageSection.length > 0, 'expected renderStorageCard in profile.tsx')
  // Real on-disk total + tracked cache + the untracked remainder must all be shown
  // so the user can see what is actually consuming space (the reported bug: the
  // card only ever showed the tracked-seed subset).
  assert.match(storageSection, /GB total/)
  assert.match(storageSection, /GB cached/)
  assert.match(storageSection, /app\/P2P data outside tracked peer cache/)
  assert.match(storageSection, /totalStorageGB/)
  assert.match(storageSection, /untrackedStorageGB/)
  // The cache budget itself is now the participation mode's; the card only
  // reports usage, points at that choice, and can still clear the cache.
  assert.match(storageSection, /Your sharing choice above sets this budget/)
  assert.match(storageSection, /handleCustomStorageLimitApply/)
  assert.match(storageSection, /handleClearCache/)
})

test('the exact cache limit input survives, gated behind Developer Mode', () => {
  assert.match(profileSource, /customStorageLimit/)
  assert.match(profileSource, /handleCustomStorageLimitApply/)
  assert.match(profileSource, /keyboardType="numeric"/)
  assert.match(profileSource, /\{developerMode\.enabled \? \([\s\S]*?keyboardType="numeric"/)
})
