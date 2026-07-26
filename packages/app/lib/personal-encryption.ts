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
 *   2. Else (first device for this identity) -> have the backend generate one,
 *      then persist the returned secret to the keychain.
 *
 * Paired-device imports must provision an explicit secret received through the
 * pairing flow. Do not export the active backend secret over shared app RPC.
 */

import { secureGet, secureSet } from './secure-storage'

const DEVICE_LOCAL_PERSONAL_KEY = 'device-local'

function keychainKey(publicKey: string): string {
  return `peartube.personal.enc.${publicKey}`
}

const provisioned = new Set<string>()

export async function ensurePersonalEncryption(rpc: any, publicKey?: string | null): Promise<void> {
  if (!rpc) return
  const owner = publicKey || DEVICE_LOCAL_PERSONAL_KEY
  if (provisioned.has(owner)) return
  const k = keychainKey(owner)

  try {
    // 1. Keychain already has the secret for this identity.
    const existing = await secureGet(k)
    if (existing) {
      let stored: { secret?: string; bootstrapKey?: string }
      try {
        stored = JSON.parse(existing)
      } catch {
        stored = { secret: existing }
      }
      await rpc.provisionPersonalEncryption({
        ...stored,
        ...(publicKey ? {} : { deviceLocal: true }),
      })
      provisioned.add(owner)
      return
    }

    // 2. First device for this identity: backend generates, we persist it.
    const res = await rpc.provisionPersonalEncryption(
      publicKey ? {} : { deviceLocal: true },
    )
    if (res?.success && res?.secret) {
      await secureSet(k, publicKey
        ? res.secret
        : JSON.stringify({ secret: res.secret, bootstrapKey: res.bootstrapKey }))
      provisioned.add(owner)
    } else if (res && res.error) {
      console.warn('[PersonalEncryption] provisioning returned error:', res.error)
    }
  } catch (err: any) {
    // Non-fatal: personal features still work unencrypted; encryption can be
    // provisioned on a later launch once the keychain is reachable.
    console.warn('[PersonalEncryption] provisioning skipped:', err?.message || err)
  }
}
