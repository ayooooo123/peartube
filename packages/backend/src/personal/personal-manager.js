/**
 * PersonalManager
 *
 * Owns the lifecycle of per-identity {@link PersonalStore} instances and wires
 * them into the backend context. Each identity gets one private multi-writer
 * store that syncs the user's subscriptions, playlists, watch history, and app
 * settings across all of their paired devices.
 *
 * The owner device re-derives its store deterministically from a fixed
 * corestore namespace (`peartube-personal:<identityPublicKey>`), so no key
 * needs to be persisted for it to reopen writable across restarts. Paired
 * devices open the same store by its bootstrap key (received during pairing)
 * and become writable once the owner adds them as an Autobase writer.
 */

import { PersonalStore } from './personal-store.js'
import { logger } from '../logger.js'

const log = logger('PersonalManager')

function personalNamespace(publicKey) {
  return `peartube-personal:${publicKey}`
}

export function createPersonalManager({ ctx, identityManager }) {
  /** @type {Map<string, PersonalStore>} */
  const stores = new Map()
  let activePublicKey = null

  async function openForIdentity(identity) {
    if (!identity?.publicKey) return null
    const pk = identity.publicKey
    if (stores.has(pk)) return stores.get(pk)

    const store = new PersonalStore(ctx.store, {
      namespace: personalNamespace(pk),
      key: identity.personalKey || null,
      swarm: ctx.swarm || null
    })
    await store.ready()
    stores.set(pk, store)

    // Persist the bootstrap key on the identity so it can be shared with the
    // user's other devices during pairing (and so paired devices can reopen).
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

    log.info(' Opened personal store for', pk.slice(0, 16), 'writable=', store.writable)
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

  return {
    /** Open the active identity's personal store and expose it on ctx. */
    async init() {
      try {
        const active = identityManager?.getActiveIdentity?.()
        if (!active) {
          log.info(' No active identity; personal store deferred')
          return
        }
        const full = identityManager.getIdentities?.().find((i) => i.publicKey === active.publicKey) || active
        const store = await openForIdentity(full)
        activePublicKey = active.publicKey
        ctx.personal = store
      } catch (err) {
        log.warn(' init failed (non-fatal):', err?.message)
      }
    },

    /** Get the active personal store, opening it lazily if needed. */
    async getActive() {
      if (activePublicKey && stores.has(activePublicKey)) return stores.get(activePublicKey)
      const active = identityManager?.getActiveIdentity?.()
      if (!active) return null
      const full = identityManager.getIdentities?.().find((i) => i.publicKey === active.publicKey) || active
      const store = await openForIdentity(full)
      activePublicKey = active.publicKey
      ctx.personal = store
      return store
    },

    /** Switch the active personal store when the active identity changes. */
    async setActive(publicKey) {
      const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === publicKey)
      if (!identity) return null
      const store = await openForIdentity(identity)
      activePublicKey = publicKey
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
