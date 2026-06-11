/**
 * Provisioning for the personal store's at-rest encryption.
 *
 * The personal store (subscriptions, playlists, watch history, settings) is
 * encrypted on disk with a 32-byte secret held in the device's native keychain.
 * Because encryption is fixed at store-creation time, this must run as early as
 * possible after the backend is ready and the active identity is known —
 * before any personal feature is used.
 *
 * Flow per identity:
 *   1. If the keychain already holds the secret -> provision it to the backend.
 *   2. Else if the backend already holds it (a freshly *paired* device receives
 *      the secret over the pairing handshake) -> persist it to the keychain.
 *   3. Else (first device for this identity) -> have the backend generate one,
 *      then persist the returned secret to the keychain.
 */

import { secureGet, secureSet } from './secure-storage'

function keychainKey(publicKey: string): string {
  return `peartube.personal.enc.${publicKey}`
}

const provisioned = new Set<string>()

export async function ensurePersonalEncryption(rpc: any, publicKey?: string | null): Promise<void> {
  if (!rpc || !publicKey) return
  if (provisioned.has(publicKey)) return
  const k = keychainKey(publicKey)

  try {
    // 1. Keychain already has the secret for this identity.
    const existing = await secureGet(k)
    if (existing) {
      await rpc.provisionPersonalEncryption({ secret: existing })
      provisioned.add(publicKey)
      return
    }

    // 2. Paired device: the backend received the secret during pairing.
    try {
      const got = await rpc.getPersonalEncryptionSecret?.()
      if (got?.provisioned && got?.secret) {
        await secureSet(k, got.secret)
        provisioned.add(publicKey)
        return
      }
    } catch {
      // older backend without the getter — fall through to generate
    }

    // 3. First device for this identity: backend generates, we persist it.
    const res = await rpc.provisionPersonalEncryption({})
    if (res?.success && res?.secret) {
      await secureSet(k, res.secret)
      provisioned.add(publicKey)
    } else if (res && res.error) {
      console.warn('[PersonalEncryption] provisioning returned error:', res.error)
    }
  } catch (err: any) {
    // Non-fatal: personal features still work unencrypted; encryption can be
    // provisioned on a later launch once the keychain is reachable.
    console.warn('[PersonalEncryption] provisioning skipped:', err?.message || err)
  }
}
