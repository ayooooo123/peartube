export const DEVELOPER_MODE_STORAGE_KEY = 'peartube.developer-mode.v1'

type LocalPreferenceStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function webPreferenceStorage(): LocalPreferenceStorage | null {
  try {
    const storage = (globalThis as { localStorage?: LocalPreferenceStorage }).localStorage
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
    return storage
  } catch {
    return null
  }
}

/**
 * This preference deliberately lives only on the current browser or desktop
 * client. Native platforms resolve developer-mode-storage.native.ts, which
 * uses the device-local secure store without involving HRPC or synchronized
 * publisher state.
 */
export async function readDeveloperModePreference(): Promise<boolean> {
  const storage = webPreferenceStorage()
  if (storage) return storage.getItem(DEVELOPER_MODE_STORAGE_KEY) === 'enabled'
  return false
}

export async function writeDeveloperModePreference(enabled: boolean): Promise<void> {
  const storage = webPreferenceStorage()
  if (storage) {
    storage.setItem(DEVELOPER_MODE_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
  }
}
