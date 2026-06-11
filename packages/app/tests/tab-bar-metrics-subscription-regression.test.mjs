import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const tabBarHeightPath = new URL('../lib/tabBarHeight.ts', import.meta.url)

test('tab bar metrics hook re-reads the store snapshot when subscribing', async () => {
  const src = await readFile(tabBarHeightPath, 'utf8')

  // The video overlay mounts after the tab navigator in the root layout, so
  // PillTabBar publishes its measured metrics BEFORE the overlay's
  // subscription effect attaches. A useState+useEffect subscription misses
  // that update and keeps the 42px default all session — docking the mini
  // player on top of the pill tab bar. useSyncExternalStore re-reads the
  // snapshot at subscription time, closing that gap.
  assert.match(src, /useSyncExternalStore\(/, 'useTabBarMetrics must use useSyncExternalStore so updates published before subscription are not lost')
  assert.doesNotMatch(src, /useEffect\(/, 'subscription must not be effect-based — effects attach after sibling-subtree effects have already published metrics')

  // The snapshot must be replaced, not mutated, or useSyncExternalStore
  // cannot detect the change by reference.
  assert.match(src, /currentMetrics = \{/, 'setTabBarMetrics must replace the snapshot object')
})
