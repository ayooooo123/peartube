import { useSyncExternalStore } from 'react'

export interface TabBarMetrics {
  height: number
  paddingBottom: number
}

// Snapshot object is replaced (never mutated) so useSyncExternalStore can
// detect changes by reference.
let currentMetrics: TabBarMetrics = { height: 42, paddingBottom: 0 }
const listeners = new Set<() => void>()

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

export function setTabBarMetrics(height: number, paddingBottom: number) {
  const nextHeight = typeof height === 'number' && height > 0 ? height : currentMetrics.height
  const nextPaddingBottom = typeof paddingBottom === 'number' && paddingBottom >= 0
    ? paddingBottom
    : currentMetrics.paddingBottom
  if (nextHeight === currentMetrics.height && nextPaddingBottom === currentMetrics.paddingBottom) return
  currentMetrics = { height: nextHeight, paddingBottom: nextPaddingBottom }
  listeners.forEach((cb) => cb())
}

export function getTabBarMetrics(): TabBarMetrics {
  return currentMetrics
}

// useSyncExternalStore re-reads the snapshot when the subscription attaches,
// so consumers that render before the tab bar reports its measurement (the
// video overlay mounts after the tab navigator in the root layout) still pick
// up metrics published between their initial render and their subscription.
// The previous useState+useEffect version lost that window: the overlay kept
// the 42px default all session and docked the mini player on top of the pill
// tab bar until some later inset change made the bar re-report.
export function useTabBarMetrics(): TabBarMetrics {
  return useSyncExternalStore(subscribe, getTabBarMetrics, getTabBarMetrics)
}
