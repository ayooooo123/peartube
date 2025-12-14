import { useEffect, useState } from 'react'

let currentTabBarHeight = 42
let currentTabBarPaddingBottom = 0
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((cb) => cb())
}

export function setTabBarMetrics(height: number, paddingBottom: number) {
  let updated = false
  if (typeof height === 'number' && height > 0 && height !== currentTabBarHeight) {
    currentTabBarHeight = height
    updated = true
  }
  if (typeof paddingBottom === 'number' && paddingBottom >= 0 && paddingBottom !== currentTabBarPaddingBottom) {
    currentTabBarPaddingBottom = paddingBottom
    updated = true
  }
  if (updated) notify()
}

export function getTabBarMetrics() {
  return {
    height: currentTabBarHeight,
    paddingBottom: currentTabBarPaddingBottom,
  }
}

export function useTabBarMetrics() {
  const [metrics, setMetrics] = useState(getTabBarMetrics())

  useEffect(() => {
    const listener = () => setMetrics(getTabBarMetrics())
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, [])

  return metrics
}
