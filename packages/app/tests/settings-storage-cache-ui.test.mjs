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
  assert.match(storageSection, /PearTube Storage/)
  assert.match(storageSection, /GB total/)
  assert.match(storageSection, /GB cached/)
  assert.match(storageSection, /app\/P2P data outside tracked peer cache/)
  assert.match(settingsSource, /totalStorageGB \?\? storageStats\?\.usedGB/)
  assert.match(settingsSource, /totalStorageBytes \?\? storageStats\?\.usedBytes/)
  assert.match(storageSection, /handleStorageLimitChange/)
  assert.match(storageSection, /handleClearCache/)
})

test('native diagnostics cache meter prefers measured storage totals', () => {
  const androidSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'DiagnosticsPanel.android.tsx'), 'utf8')
  const iosSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'DiagnosticsPanel.ios.tsx'), 'utf8')
  const webSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'DiagnosticsPanel.web.tsx'), 'utf8')
  const typesSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'native-diagnostics', 'types.ts'), 'utf8')

  for (const source of [androidSource, iosSource, webSource]) {
    assert.match(source, /totalStorageGB \?\? storageStats\?\.usedGB/)
  }
  assert.match(androidSource, /totalStorageBytes \?\? storageStats\?\.usedBytes/)
  assert.match(iosSource, /totalStorageBytes \?\? storageStats\?\.usedBytes/)
  assert.match(typesSource, /totalStorageBytes\?: number/)
  assert.match(typesSource, /untrackedStorageGB\?: string/)
})

test('settings exposes a custom cache limit input rather than only preset buttons', () => {
  assert.match(settingsSource, /customStorageLimit/)
  assert.match(settingsSource, /parseStorageLimitGB/)
  assert.match(settingsSource, /Apply Limit/)
  assert.match(settingsSource, /keyboardType="numeric"/)
})
