import { useCallback, useEffect, useState, type ReactNode } from 'react'
import React from 'react'
import { Redirect } from 'expo-router'
import { developerModeGateState } from './developer-mode-gate'
import {
  DEVELOPER_MODE_STORAGE_KEY,
  readDeveloperModePreference,
  writeDeveloperModePreference,
} from './developer-mode-storage'
import { createDeveloperModeState } from './developer-mode-state'

/** Local-only presentation preference. It is intentionally not an RPC setting. */
export { DEVELOPER_MODE_STORAGE_KEY }

const developerModeState = createDeveloperModeState({
  read: readDeveloperModePreference,
  write: writeDeveloperModePreference,
})

export async function setDeveloperMode(enabled: boolean): Promise<void> {
  await developerModeState.set(enabled)
}

export function useDeveloperMode() {
  const [enabled, setEnabled] = useState(() => developerModeState.cached() ?? false)
  const [isLoading, setIsLoading] = useState(() => developerModeState.cached() === null)

  useEffect(() => {
    let active = true
    const listener = (value: boolean) => {
      if (active) setEnabled(value)
    }
    const unsubscribe = developerModeState.subscribe(listener)
    void developerModeState.read()
      .then((value) => {
        if (active) setEnabled(value)
      })
      .catch(() => {
        if (active) setEnabled(false)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return {
    enabled,
    isLoading,
    setEnabled: useCallback((value: boolean) => setDeveloperMode(value), []),
  }
}

/**
 * Presentation gate for operator screens. Turning the local switch off updates
 * every mounted gate and returns the user to Developer Settings immediately.
 */
export function DeveloperModeGate({ children }: { children: ReactNode }) {
  const { enabled, isLoading } = useDeveloperMode()
  const state = developerModeGateState({ enabled, isLoading })
  if (state.kind === 'loading') return null
  if (state.kind === 'redirect') return React.createElement(Redirect, { href: state.href })
  return children
}
