export const DEVELOPER_SETTINGS_PATH = '/developer-settings'

const PRIVILEGED_PREFIXES = [
  '/studio',
  '/publisher-security',
  '/network-policy',
  '/subscriptions',
  '/moderation',
  '/maintenance',
] as const

export function developerModeDestination(enabled: boolean, path: string): string | null {
  if (enabled) return null
  if (path.startsWith('/profile?developer=')) return DEVELOPER_SETTINGS_PATH
  return PRIVILEGED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`))
    ? DEVELOPER_SETTINGS_PATH
    : null
}

export function canShowIdentityTools(enabled: boolean): boolean {
  return enabled
}
