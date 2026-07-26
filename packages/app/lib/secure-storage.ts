/**
 * Secure key/value storage backed by the device's native keychain.
 *
 * - iOS:      Keychain Services (via expo-secure-store)
 * - Android:  Keystore-backed encrypted store (via expo-secure-store)
 * - Electrobun desktop: the privileged Bun process stores records in the
 *   operating-system keyring. The renderer never writes a plaintext file.
 * - Web fallback: a file in the app's document directory when available.
 *
 * Used to hold the personal-store at-rest encryption secret.
 */

let SecureStore: any = null
let secureStoreLoaded = false

async function loadSecureStore(): Promise<any> {
  if (secureStoreLoaded) return SecureStore
  secureStoreLoaded = true
  try {
    // Dynamic import so platforms without the module (web/desktop) don't crash.
    SecureStore = await import('expo-secure-store')
  } catch {
    SecureStore = null
  }
  return SecureStore
}

type DesktopPersonalSecretBridge = {
  personalSecureGet(key: string): Promise<string | null>
  personalSecureSet(key: string, value: string): Promise<void>
  personalSecureDelete(key: string): Promise<void>
}

function desktopBridge(): DesktopPersonalSecretBridge | null {
  const bridge = (globalThis as any)?.window?.bridge
  if (
    bridge &&
    typeof bridge.personalSecureGet === 'function' &&
    typeof bridge.personalSecureSet === 'function' &&
    typeof bridge.personalSecureDelete === 'function'
  ) {
    return bridge
  }
  return null
}

// --- file fallback (document directory) -----------------------------------

let FileSystem: any = null
async function loadFileSystem(): Promise<any> {
  if (FileSystem) return FileSystem
  try {
    FileSystem = await import('expo-file-system')
  } catch {
    FileSystem = null
  }
  return FileSystem
}

function fallbackUri(fs: any, key: string): string | null {
  const dir = fs?.documentDirectory
  if (!dir) return null
  // Keep the filename filesystem-safe.
  return `${dir}.secure-${encodeURIComponent(key)}`
}

async function fallbackGet(key: string): Promise<string | null> {
  const fs = await loadFileSystem()
  const uri = fs && fallbackUri(fs, key)
  if (!uri || typeof fs.readAsStringAsync !== 'function') return null
  try {
    return await fs.readAsStringAsync(uri, { encoding: 'utf8' })
  } catch {
    return null
  }
}

async function fallbackSet(key: string, value: string): Promise<void> {
  const fs = await loadFileSystem()
  const uri = fs && fallbackUri(fs, key)
  if (!uri || typeof fs.writeAsStringAsync !== 'function') {
    throw new Error('secure-storage-unavailable')
  }
  await fs.writeAsStringAsync(uri, value, { encoding: 'utf8' })
}

async function fallbackDelete(key: string): Promise<void> {
  const fs = await loadFileSystem()
  const uri = fs && fallbackUri(fs, key)
  if (!uri || typeof fs.deleteAsync !== 'function') return
  try {
    await fs.deleteAsync(uri, { idempotent: true })
  } catch {
    // best effort
  }
}

// --- public API ------------------------------------------------------------

export async function secureGet(key: string): Promise<string | null> {
  const desktop = desktopBridge()
  if (desktop) return desktop.personalSecureGet(key)
  const store = await loadSecureStore()
  if (store?.getItemAsync) {
    try {
      const value = await store.getItemAsync(key)
      if (value != null) return value
    } catch {
      // fall through to fallback
    }
  }
  return fallbackGet(key)
}

export async function secureSet(key: string, value: string): Promise<void> {
  const desktop = desktopBridge()
  if (desktop) {
    await desktop.personalSecureSet(key, value)
    return
  }
  const store = await loadSecureStore()
  if (store?.setItemAsync) {
    try {
      await store.setItemAsync(key, value)
      return
    } catch {
      // fall through to fallback
    }
  }
  await fallbackSet(key, value)
}

export async function secureDelete(key: string): Promise<void> {
  const desktop = desktopBridge()
  if (desktop) {
    await desktop.personalSecureDelete(key)
    return
  }
  const store = await loadSecureStore()
  if (store?.deleteItemAsync) {
    try {
      await store.deleteItemAsync(key)
    } catch {
      // ignore
    }
  }
  await fallbackDelete(key)
}

/** True when a hardware-backed keychain is available on this platform. */
export async function hasNativeKeychain(): Promise<boolean> {
  const store = await loadSecureStore()
  return Boolean(store?.getItemAsync)
}
