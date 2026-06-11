/**
 * PersonalManager
 *
 * Owns the lifecycle of per-identity {@link PersonalStore} instances and wires
 * them into the backend context. Each identity gets one private multi-writer
 * store that syncs the user's subscriptions, playlists, watch history, and app
 * settings across all of their paired devices.
 *
 * At-rest encryption: the store is encrypted with a 32-byte secret held in the
 * device's native keychain. Because encryption is fixed at store-creation time,
 * the platform must *provision* the secret (via `provisionSecret`) before the
 * store opens — typically: read-or-generate the secret in the keychain, then
 * provision it, then create/use the identity. If no secret is provisioned, the
 * store can be opened unencrypted as a fallback for platforms that have not yet
 * wired a keychain.
 *
 * The owner device re-derives its store deterministically from a fixed corestore
 * namespace (`peartube-personal:<identityPublicKey>`), so the bootstrap key is
 * stable across restarts without persisting it. Paired devices open by key and
 * receive the secret through the pairing handshake.
 */

import b4a from 'b4a'

import { PersonalStore } from './personal-store.js'
import { generateSecret } from './personal-crypto.js'
import { logger } from '../logger.js'

const log = logger('PersonalManager')

function personalNamespace(publicKey) {
  return `peartube-personal:${publicKey}`
}

export function createPersonalManager({ ctx, identityManager }) {
  /** @type {Map<string, PersonalStore>} */
  const stores = new Map()
  /** @type {Map<string, Buffer>} */
  const secrets = new Map()
  let activePublicKey = null

  async function openForIdentity(identity, { allowUnencrypted = false } = {}) {
    if (!identity?.publicKey) return null
    const pk = identity.publicKey
    if (stores.has(pk)) return stores.get(pk)

    const secret = secrets.get(pk) || null
    if (!secret && !allowUnencrypted) {
      log.info(' Personal store for', pk.slice(0, 16), 'deferred: awaiting keychain secret')
      return null
    }

    const store = new PersonalStore(ctx.store, {
      namespace: personalNamespace(pk),
      key: identity.personalKey || null,
      secret: secret || undefined,
      swarm: ctx.swarm || null
    })
    await store.ready()
    stores.set(pk, store)

    if (store.keyHex && identity.personalKey !== store.keyHex && typeof identityManager?.setPersonalKey === 'function') {
      try { await identityManager.setPersonalKey(pk, store.keyHex) } catch (err) {
        log.warn(' Failed to persist personal key:', err?.message)
      }
    }

    if (ctx.swarm) {
      try { await store.setupPairing(ctx.swarm) } catch (err) { log.debug(' Pairing setup skipped:', err?.message) }
    }

    if (store.writable) {
      await migrateSubscriptions(store).catch((err) => log.warn(' Subscription migration skipped:', err?.message))
    }

    log.info(' Opened personal store for', pk.slice(0, 16), 'encrypted=', store.encrypted, 'writable=', store.writable)
    return store
  }

  /**
   * One-time read-through migration of legacy device-local subscriptions
   * (metaDb `subscriptions` array) into the synced personal store.
   */
  async function migrateSubscriptions(store) {
    if (!ctx.metaDb) return
    const flag = await ctx.metaDb.get('personal-subs-migrated').catch(() => null)
    if (flag?.value) return
    const existing = await ctx.metaDb.get('subscriptions').catch(() => null)
    const subs = existing?.value || []
    for (const sub of subs) {
      const channelKey = sub.driveKey || sub.channelKey
      if (!channelKey) continue
      await store.subscribe(channelKey, { name: sub.name || '' }).catch(() => {})
    }
    await ctx.metaDb.put('personal-subs-migrated', true)
    if (subs.length) log.info(' Migrated', subs.length, 'subscriptions into personal store')
  }

  function activeIdentityRecord() {
    const active = identityManager?.getActiveIdentity?.()
    if (!active) return null
    return identityManager.getIdentities?.().find((i) => i.publicKey === active.publicKey) || active
  }

  return {
    /**
     * Record the active identity. Opening is deferred until the platform
     * provisions a keychain secret (so the store can be created encrypted).
     */
    async init() {
      const active = activeIdentityRecord()
      activePublicKey = active?.publicKey || null
      if (!active) {
        log.info(' No active identity; personal store deferred')
        return
      }
      // If a secret was already provisioned this process, open now.
      if (secrets.has(active.publicKey)) {
        ctx.personal = await openForIdentity(active)
      }
    },

    /**
     * Provision the at-rest encryption secret (from the device keychain) for an
     * identity. Must be called before the store is first opened to take effect.
     * Returns the secret hex so a freshly generated one can be persisted by the
     * caller into the keychain.
     *
     * @param {Object} opts
     * @param {string} [opts.publicKey] - identity (defaults to active)
     * @param {string} [opts.secret] - 32-byte secret hex; generated if omitted
     */
    async provisionSecret({ publicKey, secret } = {}) {
      const pk = publicKey || identityManager?.getActivePublicKey?.()
      if (!pk) throw new Error('No identity to provision a personal secret for')

      const existingStore = stores.get(pk)
      if (existingStore && existingStore.encrypted) {
        return { success: true, secret: existingStore.secretHex, alreadyOpen: true }
      }
      if (existingStore && !existingStore.encrypted) {
        // Cannot retro-encrypt an already-created unencrypted store.
        log.warn(' Personal store already open unencrypted for', pk.slice(0, 16), '- secret applies to new stores only')
        return { success: false, error: 'store-already-unencrypted' }
      }

      const buf = secret ? (b4a.isBuffer(secret) ? secret : b4a.from(secret, 'hex')) : generateSecret()
      secrets.set(pk, buf)

      let store = null
      if (pk === (identityManager?.getActivePublicKey?.() || activePublicKey)) {
        const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === pk) || activeIdentityRecord()
        store = await openForIdentity(identity)
        if (store) { activePublicKey = pk; ctx.personal = store }
      }
      return { success: true, secret: b4a.toString(buf, 'hex'), encrypted: Boolean(store?.encrypted) }
    },

    /** Whether an encryption secret is known for an identity this process. */
    hasSecret(publicKey) {
      const pk = publicKey || activePublicKey
      return Boolean(pk && secrets.has(pk))
    },

    /**
     * The active store's secret hex — used by a freshly *paired* device to read
     * the secret it received over the pairing handshake and persist it to its
     * own keychain. Returns null when unknown or unencrypted.
     */
    getActiveSecretHex() {
      const store = activePublicKey ? stores.get(activePublicKey) : null
      return store?.secretHex || (activePublicKey && secrets.has(activePublicKey) ? b4a.toString(secrets.get(activePublicKey), 'hex') : null)
    },

    /** Open the active store unencrypted (fallback for platforms without a keychain). */
    async ensureActiveUnencrypted() {
      const active = activeIdentityRecord()
      if (!active) return null
      const store = await openForIdentity(active, { allowUnencrypted: true })
      if (store) { activePublicKey = active.publicKey; ctx.personal = store }
      return store
    },

    /** Get the active personal store if open. */
    getActive() {
      return activePublicKey ? stores.get(activePublicKey) || null : null
    },

    /** Switch the active personal store when the active identity changes. */
    async setActive(publicKey) {
      const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === publicKey)
      if (!identity) return null
      activePublicKey = publicKey
      const store = await openForIdentity(identity)
      ctx.personal = store
      return store
    },

    openForIdentity,

    async close() {
      for (const store of stores.values()) {
        try { await store.close() } catch { /* best effort */ }
      }
      stores.clear()
      ctx.personal = null
    }
  }
}
