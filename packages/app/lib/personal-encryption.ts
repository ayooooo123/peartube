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
 *   2. Else (first device for this identity) -> generate it in the platform,
 *      durably persist it, and only then provision the backend.
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

function generateSecretHex(): string {
  const random = new Uint8Array(32)
  const crypto = globalThis.crypto
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('secure-random-unavailable')
  }
  crypto.getRandomValues(random)
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
}

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
      const result = await rpc.provisionPersonalEncryption({
        ...stored,
        ...(publicKey ? {} : { deviceLocal: true }),
      })
      if (result?.success) provisioned.add(owner)
      return
    }

    // 2. First device: generate and persist before the backend ever sees it.
    const secret = generateSecretHex()
    await secureSet(k, publicKey ? secret : JSON.stringify({ secret }))
    const res = await rpc.provisionPersonalEncryption({
      secret,
      ...(publicKey ? {} : { deviceLocal: true }),
    })
    if (res?.success) {
      if (!publicKey && res.bootstrapKey) {
        await secureSet(k, JSON.stringify({ secret, bootstrapKey: res.bootstrapKey }))
      }
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
