import * as SecureStore from 'expo-secure-store'

export const DEVELOPER_MODE_STORAGE_KEY = 'peartube.developer-mode.v1'

/**
 * Native-only, device-local Developer Mode preference. This module is selected
 * by Metro on Android and iOS so expo-secure-store is included statically in
 * the native bundle. It remains a local device preference.
 */
export async function readDeveloperModePreference(): Promise<boolean> {
  return (await SecureStore.getItemAsync(DEVELOPER_MODE_STORAGE_KEY)) === 'enabled'
}

export async function writeDeveloperModePreference(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(DEVELOPER_MODE_STORAGE_KEY, enabled ? 'enabled' : 'disabled')
}
