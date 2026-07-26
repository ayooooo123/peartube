import { ensurePersonalEncryption } from './personal-encryption'

/**
 * The Electrobun renderer may expose the app only after the privileged desktop
 * keyring has durably supplied the PersonalStore encryption secret and the
 * backend has reloaded its local moderation profile.
 */
export async function ensureDesktopBackendReadiness(
  rpc: any,
  markReady: () => void | Promise<void>,
): Promise<void> {
  // A backend retry can restart the worker without reloading the renderer
  // module, so force a keyring read/provision for every backend-ready session.
  await ensurePersonalEncryption(rpc, null, { force: true, required: true })
  await markReady()
}
