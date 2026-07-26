import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const app = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8')

test('consumer navigation contains only Home, Discover, and Library tabs', () => {
  const tabs = app('app', '(tabs)', '_layout.tsx')
  const pill = app('components', 'PillTabBar.tsx')

  assert.match(tabs, /<Tabs\.Screen name="index"/)
  assert.match(tabs, /<Tabs\.Screen name="discover"/)
  assert.match(tabs, /<Tabs\.Screen name="library"/)
  assert.match(tabs, /<Tabs\.Screen name="studio" options=\{\{ href: null \}\}/)
  assert.doesNotMatch(pill, /label: 'Studio'/)
  assert.equal((pill.match(/label: '(?:Home|Discover|Library)'/g) || []).length, 3)
})

test('desktop consumer navigation has no Studio entry or upload affordance', () => {
  const sidebar = app('components', 'desktop', 'DesktopSidebar.web.tsx')
  const header = app('components', 'desktop', 'DesktopHeader.web.tsx')

  assert.doesNotMatch(sidebar, /label: 'Studio'/)
  assert.doesNotMatch(sidebar, /yourContentItems/)
  assert.match(sidebar, /\{ path: '\/discover', icon: \w+, label: 'Discover' \}/)
  assert.doesNotMatch(header, /UploadIcon/)
  assert.doesNotMatch(header, /aria-label="Upload video"/)
})

test('Profile exposes Developer Mode but keeps operator routes out of normal settings', () => {
  const profile = app('app', 'profile.tsx')

  assert.match(profile, /Developer Mode/)
  assert.match(profile, /router\.push\('\/developer-settings'\)/)
  for (const route of ['/maintenance', '/network-policy', '/subscriptions', '/moderation']) {
    assert.doesNotMatch(profile, new RegExp(`router\\.push\\('${route.replace('/', '\\/')}'\\)`))
  }
})
