import { DEVELOPER_SETTINGS_PATH } from './developer-mode-routes'

export type DeveloperModeGateState = {
  enabled: boolean
  isLoading: boolean
}

export type DeveloperModeGateResult =
  | { kind: 'loading' }
  | { kind: 'redirect', href: typeof DEVELOPER_SETTINGS_PATH }
  | { kind: 'content' }

/** Pure gate policy, shared by the React gate and regression tests. */
export function developerModeGateState({ enabled, isLoading }: DeveloperModeGateState): DeveloperModeGateResult {
  if (isLoading) return { kind: 'loading' }
  if (!enabled) return { kind: 'redirect', href: DEVELOPER_SETTINGS_PATH }
  return { kind: 'content' }
}
