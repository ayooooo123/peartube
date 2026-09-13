import { ensurePersonalEncryption } from './personal-encryption'

/**
 * The Electrobun renderer provisions the PersonalStore encryption secret
 * before exposing personal features. A failed OS-vault read must not hold the
 * rest of the desktop app behind an unrelated optional store.
 */
export async function ensureDesktopBackendReadiness(
  rpc: any,
  markReady: () => void | Promise<void>,
): Promise<void> {
  // A backend retry can restart the worker without reloading the renderer
  // module, so force a keyring read/provision for every backend-ready session.
  await ensurePersonalEncryption(rpc, null, { force: true })
  await markReady()
}
