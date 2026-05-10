import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'app', '(tabs)', 'settings.tsx'), 'utf8')

test('settings renders storage controls before account onboarding', () => {
  const noIdentityStart = settingsSource.indexOf('if (!identity) {')
  const signedInStart = settingsSource.indexOf('  return (', noIdentityStart + 20)
  const noIdentityBlock = noIdentityStart >= 0 && signedInStart >= 0
    ? settingsSource.slice(noIdentityStart, signedInStart)
    : ''
  const storageStart = settingsSource.indexOf('const renderStorageSection = () => (')
  const storageEnd = settingsSource.indexOf('// Onboarding', storageStart + 1)
  const storageSection = storageStart >= 0 && storageEnd >= 0
    ? settingsSource.slice(storageStart, storageEnd)
    : ''

  assert.match(noIdentityBlock, /renderStorageSection\(\)/)
  assert.match(storageSection, /Storage/)
  assert.match(storageSection, /Peer Content Cache/)
  assert.match(storageSection, /handleStorageLimitChange/)
  assert.match(storageSection, /handleClearCache/)
})

test('settings exposes a custom cache limit input rather than only preset buttons', () => {
  assert.match(settingsSource, /customStorageLimit/)
  assert.match(settingsSource, /parseStorageLimitGB/)
  assert.match(settingsSource, /Apply Limit/)
  assert.match(settingsSource, /keyboardType="numeric"/)
})
