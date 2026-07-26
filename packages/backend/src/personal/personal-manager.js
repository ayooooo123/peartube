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
import { logger } from '../logger.js'
import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../moderation/profile.js'

const log = logger('PersonalManager')
const DEVICE_LOCAL_PERSONAL_ID = 'device-local'

function personalNamespace(publicKey) {
  return `peartube-personal:${publicKey}`
}

export function createPersonalManager({ ctx, identityManager, onActiveStoreChanged = null }) {
  /** @type {Map<string, PersonalStore>} */
  const stores = new Map()
  /** @type {Map<string, Buffer>} */
  const secrets = new Map()
  let activePublicKey = null
  let anonymousBootstrapKey = null
  let activeChanges = Promise.resolve()

  if (onActiveStoreChanged !== null && typeof onActiveStoreChanged !== 'function') {
    throw new TypeError('onActiveStoreChanged must be a function')
  }

  function enqueueActiveChange(operation) {
    const next = activeChanges.then(operation, operation)
    activeChanges = next.catch(() => {})
    return next
  }

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

    if (
      pk !== DEVICE_LOCAL_PERSONAL_ID &&
      store.keyHex &&
      identity.personalKey !== store.keyHex &&
      typeof identityManager?.setPersonalKey === 'function'
    ) {
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

  async function prepareAnonymousProfileMigration(target) {
    const anonymous = stores.get(DEVICE_LOCAL_PERSONAL_ID)
    if (!anonymous || anonymous === target || !target?.writable) return null
    const localState = await anonymous.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (localState === undefined) return null
    const targetState = await target.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    if (targetState === undefined) {
      await target.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, localState)
    }
    return { anonymous, localState, targetState }
  }

  async function restoreProfileSetting(store, value) {
    if (!store?.writable) return
    if (value === undefined) {
      await store.deleteSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
    } else {
      await store.setSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY, value)
    }
  }

  async function activateStore(publicKey, store, { migrateAnonymous = false } = {}) {
    if (!store) return { store: null, profileReconciled: false }
    if (ctx.personal === store && activePublicKey === publicKey) {
      return { store, profileReconciled: false }
    }

    const previous = {
      publicKey: activePublicKey,
      store: ctx.personal || null,
    }
    const targetProfile = store.writable
      ? await store.getSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
      : undefined
    let migration = null
    let profileReconciled = false

    try {
      if (migrateAnonymous) migration = await prepareAnonymousProfileMigration(store)
      // The profile repository resolves through ctx.personal, so expose the
      // candidate store only for the duration of the reconciliation. The
      // externally observable active key is committed after every side effect.
      ctx.personal = store
      if (onActiveStoreChanged) {
        await onActiveStoreChanged({
          publicKey,
          previousPublicKey: previous.publicKey,
          store,
          previousStore: previous.store,
        })
        profileReconciled = true
      }
      if (migration) {
        await migration.anonymous.deleteSetting(CONSUMER_MODERATION_PROFILE_SETTING_KEY)
      }
      activePublicKey = publicKey
      return { store, profileReconciled }
    } catch (error) {
      await restoreProfileSetting(store, targetProfile).catch(() => {})
      if (migration) {
        await restoreProfileSetting(migration.anonymous, migration.localState).catch(() => {})
      }
      activePublicKey = previous.publicKey
      ctx.personal = previous.store
      if (onActiveStoreChanged && previous.store) {
        await onActiveStoreChanged({
          publicKey: previous.publicKey,
          previousPublicKey: publicKey,
          store: previous.store,
          previousStore: store,
          rollback: true,
        }).catch(() => {})
      }
      throw error
    }
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
      return enqueueActiveChange(async () => {
        const active = activeIdentityRecord()
        if (!active) {
          log.info(' No active identity; personal store deferred')
          return
        }
        // If a secret was already provisioned this process, open now.
        if (secrets.has(active.publicKey)) {
          const store = await openForIdentity(active)
          await activateStore(active.publicKey, store, { migrateAnonymous: true })
        }
      })
    },

    /**
     * Provision the at-rest encryption secret (from the device keychain) for an
     * identity. Must be called before the store is first opened to take effect.
     * @param {Object} opts
     * @param {string} [opts.publicKey] - identity (defaults to active)
     * @param {string} opts.secret - platform-generated 32-byte secret hex
     */
    async provisionSecret({ publicKey, secret, deviceLocal = false, bootstrapKey } = {}) {
      const pk = deviceLocal
        ? DEVICE_LOCAL_PERSONAL_ID
        : (publicKey || identityManager?.getActivePublicKey?.() || DEVICE_LOCAL_PERSONAL_ID)
      const isDeviceLocal = pk === DEVICE_LOCAL_PERSONAL_ID
      if (
        !(b4a.isBuffer(secret) && secret.byteLength === 32) &&
        !(typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret))
      ) {
        return { success: false, error: 'personal-secret-required' }
      }

      return enqueueActiveChange(async () => {
        const existingStore = stores.get(pk)
        if (existingStore && !existingStore.encrypted) {
          // Cannot retro-encrypt an already-created unencrypted store.
          log.warn(' Personal store already open unencrypted for', pk.slice(0, 16), '- secret applies to new stores only')
          return { success: false, error: 'store-already-unencrypted' }
        }

        const buf = b4a.isBuffer(secret) ? b4a.from(secret) : b4a.from(secret, 'hex')
        secrets.set(pk, buf)

        let store = existingStore || null
        let activation = { profileReconciled: false }
        if (isDeviceLocal) {
          anonymousBootstrapKey = bootstrapKey || anonymousBootstrapKey
          const identity = {
            publicKey: DEVICE_LOCAL_PERSONAL_ID,
            personalKey: anonymousBootstrapKey,
          }
          store = store || await openForIdentity(identity)
          anonymousBootstrapKey = store?.keyHex || anonymousBootstrapKey
          if (store && (!ctx.personal || activePublicKey === DEVICE_LOCAL_PERSONAL_ID)) {
            activation = await activateStore(DEVICE_LOCAL_PERSONAL_ID, store)
          }
        } else if (pk === (identityManager?.getActivePublicKey?.() || activePublicKey)) {
          const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === pk) || activeIdentityRecord()
          store = store || await openForIdentity(identity)
          activation = await activateStore(pk, store, { migrateAnonymous: true })
        }
        return {
          success: true,
          bootstrapKey: store?.keyHex || bootstrapKey,
          encrypted: Boolean(store?.encrypted),
          alreadyOpen: Boolean(existingStore),
          profileReconciled: activation.profileReconciled === true,
        }
      })
    },

    /** Whether an encryption secret is known for an identity this process. */
    hasSecret(publicKey) {
      const pk = publicKey || activePublicKey
      return Boolean(pk && secrets.has(pk))
    },

    /** Open the active store unencrypted (fallback for platforms without a keychain). */
    async ensureActiveUnencrypted() {
      return enqueueActiveChange(async () => {
        const active = activeIdentityRecord()
        if (!active) return null
        const store = await openForIdentity(active, { allowUnencrypted: true })
        await activateStore(active.publicKey, store, { migrateAnonymous: true })
        return store
      })
    },

    /** Get the active personal store if open. */
    getActive() {
      return (activePublicKey ? stores.get(activePublicKey) : null) ||
        stores.get(DEVICE_LOCAL_PERSONAL_ID) ||
        null
    },

    /** Device-local encrypted store used before an identity/pairing is active. */
    getAnonymous() {
      return stores.get(DEVICE_LOCAL_PERSONAL_ID) || null
    },

    /** Switch the active personal store when the active identity changes. */
    async setActive(publicKey) {
      return enqueueActiveChange(async () => {
        const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === publicKey)
        if (!identity) return null
        const store = await openForIdentity(identity)
        await activateStore(publicKey, store, { migrateAnonymous: true })
        return store
      })
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
