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
 *
 * The platform is the only secret generator in the system; the backend never
 * mints one. `generatePersonalSecretHex` and `persistPersonalSecret` exist so
 * the pairing screen can rotate an epoch (revocation) or adopt a paired secret
 * without duplicating custody rules.
 *
 * Every read and write here goes through the vault-only secure storage, which
 * throws rather than degrading to a file. So a device with no vault — or one
 * whose vault refuses the write — never reaches `provisionPersonalEncryption`
 * at all, and the backend, which refuses to open a store without a secret,
 * leaves that device viewer-local with pairing disabled. That is the intended
 * outcome, not a failure to work around.
 */

import { secureGet, secureSet } from './secure-storage'

const DEVICE_LOCAL_PERSONAL_KEY = 'device-local'

/** Keychain slot holding the personal-store secret for one identity (or this device). */
export function personalSecretKeychainKey(publicKey?: string | null): string {
  return `peartube.personal.enc.${publicKey || DEVICE_LOCAL_PERSONAL_KEY}`
}

const provisioned = new Set<string>()

/**
 * Set once provisioning ran and left this device with no store to open. An
 * owner that does provision later lands in `provisioned` and outranks it.
 */
let provisioningFailed = false

/**
 * Whether this device has a personal store that can hold viewer state.
 *
 * False only once provisioning has been tried and left it without one: a vault
 * that refuses the secret leaves the backend with no store, so every write is
 * refused. Best-effort viewer state (watch progress) skips instead of asking
 * once per playback tick; an explicit action still asks, and still fails
 * loudly.
 */
export function hasPersonalStore(): boolean {
  return provisioned.size > 0 || !provisioningFailed
}

const SECRET_HEX = /^[0-9a-f]{64}$/i

/**
 * 32 bytes of platform CSPRNG entropy, hex encoded. Never derived from a name,
 * clock, or anything the network can observe.
 */
export function generatePersonalSecretHex(): string {
  const random = new Uint8Array(32)
  const crypto = globalThis.crypto
  if (!crypto || typeof crypto.getRandomValues !== 'function') {
    throw new Error('secure-random-unavailable')
  }
  crypto.getRandomValues(random)
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** What one vault slot holds for an owner. */
export type PersonalSecretRecord = {
  secret: string
  bootstrapKey?: string
  /**
   * Set only while a revocation is in flight or finished ambiguously. Rotation
   * is forward-only, so the new secret always wins; this is the single fallback
   * the next launch may try if the new epoch turns out never to have been
   * created. It is cleared the moment one of them opens the store.
   */
  previousSecret?: string
}

/**
 * Durably store a personal-store secret in the device vault and confirm it
 * reads back before the caller relies on it. Used when this device adopts a
 * paired secret and when revocation rotates to a new epoch secret; the next
 * provisioning call re-reads the vault rather than trusting the process cache.
 */
export async function persistPersonalSecret(
  secret: string,
  options: { publicKey?: string | null; bootstrapKey?: string | null; previousSecret?: string | null } = {},
): Promise<void> {
  if (typeof secret !== 'string' || !SECRET_HEX.test(secret)) {
    throw new Error('personal-secret-malformed')
  }
  const owner = options.publicKey || DEVICE_LOCAL_PERSONAL_KEY
  const value: PersonalSecretRecord = { secret }
  if (options.bootstrapKey) value.bootstrapKey = options.bootstrapKey
  if (options.previousSecret && options.previousSecret !== secret) value.previousSecret = options.previousSecret
  const record = JSON.stringify(value)
  await secureSet(personalSecretKeychainKey(options.publicKey), record)
  const readBack = await secureGet(personalSecretKeychainKey(options.publicKey))
  if (readBack !== record) throw new Error('personal-secret-not-durable')
  provisioned.delete(owner)
}

/**
 * The secret currently in the vault for this owner, in either stored shape: a
 * JSON record, or a bare secret written by an older build. Rotation reads this
 * first so a rotation the backend refused can be rolled back instead of
 * leaving the device holding a key no store was ever opened with.
 */
export async function readPersonalSecretRecord(
  publicKey?: string | null,
): Promise<PersonalSecretRecord | null> {
  const stored = await secureGet(personalSecretKeychainKey(publicKey))
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored)
    return typeof parsed?.secret === 'string' ? parsed : null
  } catch {
    return { secret: stored }
  }
}

export type EnsurePersonalEncryptionOptions = {
  force?: boolean
  required?: boolean
}

export async function ensurePersonalEncryption(
  rpc: any,
  publicKey?: string | null,
  options: EnsurePersonalEncryptionOptions = {},
): Promise<void> {
  if (!rpc) {
    if (options.required) throw new Error('personal-encryption-rpc-unavailable')
    return
  }
  const owner = publicKey || DEVICE_LOCAL_PERSONAL_KEY
  if (provisioned.has(owner) && !options.force) return

  try {
    // 1. Keychain already has a secret for this identity. An interrupted
    //    revocation can leave two candidates: the rotated-to secret, which
    //    always wins, and the pre-rotation one, tried only if the new epoch
    //    turns out never to have been created.
    const stored = await readPersonalSecretRecord(owner)
    if (stored) {
      const candidates = stored.previousSecret ? [stored.secret, stored.previousSecret] : [stored.secret]
      let failure: string | undefined
      for (const candidate of candidates) {
        const result = await rpc.provisionPersonalEncryption({
          secret: candidate,
          ...(stored.bootstrapKey ? { bootstrapKey: stored.bootstrapKey } : {}),
          ...(publicKey ? {} : { deviceLocal: true }),
        })
        if (!result?.success) {
          failure = result?.error
          continue
        }
        // Whichever one opened the store is now the only one worth keeping.
        if (stored.previousSecret) {
          await persistPersonalSecret(candidate, {
            publicKey,
            bootstrapKey: result.bootstrapKey || stored.bootstrapKey,
          })
        }
        provisioned.add(owner)
        return
      }
      throw new Error(failure || 'personal-encryption-provision-failed')
    }

    // 2. First device: mint it here, prove it is durable in the vault, and only
    //    then let the backend see it. This goes through persistPersonalSecret
    //    for the read-back — a write nobody confirmed is not custody, and a
    //    store opened against a key that did not survive is unreadable at the
    //    next launch. One shape for every owner: the JSON record.
    const secret = generatePersonalSecretHex()
    await persistPersonalSecret(secret, { publicKey })
    const res = await rpc.provisionPersonalEncryption({
      secret,
      ...(publicKey ? {} : { deviceLocal: true }),
    })
    if (res?.success) {
      if (res.bootstrapKey) await persistPersonalSecret(secret, { publicKey, bootstrapKey: res.bootstrapKey })
      provisioned.add(owner)
    } else {
      throw new Error(res?.error || 'personal-encryption-provision-failed')
    }
  } catch (err) {
    provisioningFailed = true
    console.warn('[PersonalEncryption] provisioning skipped:', err instanceof Error ? err.message : err)
    if (options.required) throw err
  }
}
