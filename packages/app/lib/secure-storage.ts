/**
 * Secret storage backed by the device's OS vault, and nothing else.
 *
 * - iOS:      Keychain Services (via expo-secure-store)
 * - Android:  Keystore-backed encrypted store (via expo-secure-store)
 * - Electrobun desktop: the privileged Bun process keeps records in the
 *   operating-system keyring. The renderer never holds the bytes.
 *
 * There is deliberately no file fallback. The only value stored here is the
 * personal-store master secret, and a copy of it under the app's document
 * directory would sit next to the very cores it encrypts — that is not a
 * fallback, it is disclosure, and it is worse than the failure it papers over
 * because every durability check downstream would happily read it back. When
 * no vault will take the write these functions throw, the caller stays
 * device-local, and pairing stays disabled.
 */

import type * as ExpoSecureStore from 'expo-secure-store'

export const SECURE_VAULT_UNAVAILABLE = 'secure-vault-unavailable'
export const SECURE_VAULT_READ_FAILED = 'secure-vault-read-failed'
export const SECURE_VAULT_WRITE_FAILED = 'secure-vault-write-failed'

/** Thrown instead of quietly degrading, so callers can tell custody apart from an empty slot. */
export class SecureVaultError extends Error {
  readonly code: string

  constructor(code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause })
    this.code = code
    this.name = 'SecureVaultError'
  }
}

type Vault = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

type DesktopPersonalSecretBridge = {
  personalSecureGet(key: string): Promise<string | null>
  personalSecureSet(key: string, value: string): Promise<void>
  personalSecureDelete(key: string): Promise<void>
}

function desktopBridge(): DesktopPersonalSecretBridge | null {
  // The Electrobun preload installs `window.bridge`; neither DOM nor RN types it.
  const host = globalThis as unknown as { window?: { bridge?: Partial<DesktopPersonalSecretBridge> } }
  const bridge = host.window?.bridge
  if (
    bridge &&
    typeof bridge.personalSecureGet === 'function' &&
    typeof bridge.personalSecureSet === 'function' &&
    typeof bridge.personalSecureDelete === 'function'
  ) {
    return bridge as DesktopPersonalSecretBridge
  }
  return null
}

let secureStoreImport: Promise<typeof ExpoSecureStore | null> | null = null

function loadSecureStore(): Promise<typeof ExpoSecureStore | null> {
  if (!secureStoreImport) {
    // Dynamic import so platforms without the module (web/desktop) don't crash.
    // A rejected import must not stick: caching the failure would downgrade a
    // device that does have a keychain to "no vault" for the rest of the session.
    secureStoreImport = import('expo-secure-store').catch(() => {
      secureStoreImport = null
      return null
    })
  }
  return secureStoreImport
}

let bridgeOwner: DesktopPersonalSecretBridge | null = null
let bridgeVault: Vault | null = null
let storeVault: Vault | null = null

/** The OS vault this device actually has, or null when it has none. */
async function resolveVault(): Promise<Vault | null> {
  const bridge = desktopBridge()
  if (bridge) {
    if (bridgeOwner !== bridge) {
      bridgeOwner = bridge
      bridgeVault = {
        get: (key) => bridge.personalSecureGet(key),
        set: (key, value) => bridge.personalSecureSet(key, value),
        delete: (key) => bridge.personalSecureDelete(key),
      }
    }
    return bridgeVault
  }
  if (storeVault) return storeVault
  const store = await loadSecureStore()
  if (typeof store?.getItemAsync !== 'function' || typeof store.setItemAsync !== 'function') return null
  storeVault = {
    get: (key) => store.getItemAsync(key),
    set: (key, value) => store.setItemAsync(key, value),
    delete: (key) =>
      typeof store.deleteItemAsync === 'function' ? store.deleteItemAsync(key) : Promise.resolve(),
  }
  return storeVault
}

/**
 * Read a secret from the vault. Null means the slot is empty; a throw means we
 * could not ask the vault at all, which is never the same thing as "no secret
 * is stored" and must not be collapsed into it.
 */
export async function secureGet(key: string): Promise<string | null> {
  const vault = await resolveVault()
  if (!vault) throw new SecureVaultError(SECURE_VAULT_UNAVAILABLE)
  try {
    const value = await vault.get(key)
    return value == null ? null : value
  } catch (cause) {
    throw new SecureVaultError(SECURE_VAULT_READ_FAILED, cause)
  }
}

/** Write a secret to the vault, or fail loudly. There is nowhere else to put it. */
export async function secureSet(key: string, value: string): Promise<void> {
  const vault = await resolveVault()
  if (!vault) throw new SecureVaultError(SECURE_VAULT_UNAVAILABLE)
  try {
    await vault.set(key, value)
  } catch (cause) {
    throw new SecureVaultError(SECURE_VAULT_WRITE_FAILED, cause)
  }
}

/** Best effort: a slot we cannot reach is a slot we could never have written. */
export async function secureDelete(key: string): Promise<void> {
  const vault = await resolveVault()
  if (!vault) return
  try {
    await vault.delete(key)
  } catch {
    // Nothing to escalate: the caller is discarding a secret, not relying on one.
  }
}

const VAULT_PROBE_KEY = 'peartube.secure-vault.probe'

let custodyProven = false

/**
 * True only when this device demonstrably holds a secret for us.
 *
 * The presence of a keychain module is not custody: a policy-locked keystore, a
 * revoked entitlement, or a platform stub that swallows writes all look
 * identical until something is written and read back. So we round-trip a
 * throwaway probe through the same vault-only path the personal secret takes,
 * and answer false unless the exact bytes come back. False means the caller
 * must refuse secret-bearing flows — provisioning, pairing — rather than
 * degrade to something that only looks like storage.
 */
export async function hasSecureVault(): Promise<boolean> {
  if (custodyProven) return true
  const vault = await resolveVault()
  if (!vault) return false
  const probe = `${Date.now().toString(16)}.${Math.random().toString(16).slice(2)}`
  try {
    await vault.set(VAULT_PROBE_KEY, probe)
    custodyProven = (await vault.get(VAULT_PROBE_KEY)) === probe
  } catch {
    custodyProven = false
  }
  try {
    await vault.delete(VAULT_PROBE_KEY)
  } catch {
    // The probe is not a secret; a slot we cannot clear is not worth failing over.
  }
  return custodyProven
}
