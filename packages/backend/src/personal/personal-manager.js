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
 * provision it, then create/use the identity. The backend never generates a
 * secret and never opens the store unencrypted: a device without a secure vault
 * keeps its viewer state device-local and pairing stays disabled.
 *
 * The owner device re-derives its store deterministically from a fixed corestore
 * namespace (`peartube-personal:<identityPublicKey>`), so the bootstrap key is
 * stable across restarts without persisting it. Paired devices open by key and
 * receive the secret through the pairing handshake.
 *
 * Revoking a paired device rotates forward into a new encrypted *epoch*: bounded
 * state is copied into a fresh store keyed by a fresh platform secret, the old
 * epoch stops replicating, and every retained device must re-pair. The epoch's
 * corestore namespace and bootstrap key (never the secret) are recorded in
 * metaDb so a restart reopens the same epoch.
 */

import Autobase from 'autobase'
import BlindPairing from 'blind-pairing'
import b4a from 'b4a'
import z32 from 'z32'

import {
  PersonalStore,
  PERSONAL_INVITE_MAX_TTL_MS,
  encodePersonalPairingUserData,
} from './personal-store.js'
import { migrateDeviceLocalProfile } from './profile-migration.js'
import { logger } from '../logger.js'
import { CONSUMER_MODERATION_PROFILE_SETTING_KEY } from '../moderation/profile.js'

const log = logger('PersonalManager')
const DEVICE_LOCAL_PERSONAL_ID = 'device-local'
const HEX_32_BYTES = /^[0-9a-f]{64}$/
// Bounded so a redemption that never gets confirmed (expired, replayed, or lost
// to a concurrent redeemer) fails structurally instead of hanging the caller.
const PERSONAL_PAIRING_TIMEOUT_MS = 60 * 1000
const PERSONAL_PAIRING_WRITABLE_TIMEOUT_MS = 30 * 1000

function personalNamespace(publicKey) {
  return `peartube-personal:${publicKey}`
}

/** Epoch 0 keeps the legacy namespace so existing stores reopen unchanged. */
function epochNamespace(publicKey, epoch) {
  return epoch > 0 ? `${personalNamespace(publicKey)}#${epoch}` : personalNamespace(publicKey)
}

function epochMetaKey(publicKey) {
  return `personal-epoch:${publicKey}`
}

function toSecretBuffer(secret) {
  if (b4a.isBuffer(secret) && secret.byteLength === 32) return b4a.from(secret)
  if (typeof secret === 'string' && HEX_32_BYTES.test(secret)) return b4a.from(secret, 'hex')
  return null
}

/** Invites are user-initiated and short-lived; a longer ask is clamped, never honored. */
function clampInviteTtl(requested) {
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return PERSONAL_INVITE_MAX_TTL_MS
  return Math.min(Math.floor(value), PERSONAL_INVITE_MAX_TTL_MS)
}

function unavailablePersonalStoreSecret(publicKey) {
  const error = new Error(`PersonalStore secret is unavailable for identity ${publicKey}`)
  error.code = 'PERSONAL_STORE_SECRET_UNAVAILABLE'
  return error
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

  /**
   * Which encrypted epoch this identity's store lives in. Only the corestore
   * namespace and the bootstrap key are recorded — never the keychain secret.
   */
  async function readEpoch(publicKey) {
    const row = await ctx.metaDb?.get?.(epochMetaKey(publicKey)).catch(() => null)
    const value = row?.value
    if (!value || typeof value !== 'object') return null
    const epoch = Number.isSafeInteger(value.epoch) && value.epoch > 0 ? value.epoch : 0
    const bootstrapKey = typeof value.bootstrapKey === 'string' && HEX_32_BYTES.test(value.bootstrapKey)
      ? value.bootstrapKey
      : null
    return {
      epoch,
      namespace: typeof value.namespace === 'string' && value.namespace
        ? value.namespace
        : epochNamespace(publicKey, epoch),
      bootstrapKey,
      joined: value.joined === true,
    }
  }

  async function writeEpoch(publicKey, { epoch, namespace, bootstrapKey, joined }) {
    if (typeof ctx.metaDb?.put !== 'function') return
    await ctx.metaDb.put(epochMetaKey(publicKey), {
      epoch,
      namespace,
      bootstrapKey: bootstrapKey || null,
      joined: joined === true,
      updatedAt: Date.now(),
    })
  }

  async function openForIdentity(identity) {
    if (!identity?.publicKey) return null
    const pk = identity.publicKey
    if (stores.has(pk)) return stores.get(pk)

    const secret = secrets.get(pk) || null
    if (!secret) {
      // No secure vault, no store: an unencrypted personal store is never a
      // fallback. Viewer state stays device-local and pairing stays disabled.
      log.info(' Personal store for', pk.slice(0, 16), 'deferred: awaiting keychain secret')
      return null
    }

    const epoch = await readEpoch(pk)
    const store = new PersonalStore(ctx.store, {
      namespace: epoch?.namespace || personalNamespace(pk),
      key: epoch?.bootstrapKey || identity.personalKey || null,
      secret,
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
      await migrateLegacyResume(store).catch((err) => log.warn(' Resume migration skipped:', err?.message))
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
    await migrateDeviceLocalProfile({
      source: anonymous,
      target,
      sourceId: DEVICE_LOCAL_PERSONAL_ID,
      targetId: target.keyHex || 'identity-personal-store',
    })
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

  /**
   * One-time migration of the legacy `resume/<videoKey>` rows written before
   * canonical progress records existed. The store drops each legacy row only
   * once its replacement reads back, so the once-per-device flag is recorded
   * only when nothing was left behind: an interrupted migration is retried on
   * the next open instead of stranding watch state in a shape nothing reads.
   */
  async function migrateLegacyResume(store) {
    if (!ctx.metaDb) return
    const flag = await ctx.metaDb.get('personal-resume-migrated').catch(() => null)
    if (flag?.value) return
    const { migrated, retained } = await store.migrateLegacyResume()
    if (retained > 0) {
      log.warn(' Legacy resume migration retained', retained, 'rows; retrying on next open')
      return
    }
    await ctx.metaDb.put('personal-resume-migrated', true)
    if (migrated) log.info(' Migrated', migrated, 'legacy resume rows into progress records')
  }

  function activeIdentityRecord() {
    const active = identityManager?.getActiveIdentity?.()
    if (!active) return null
    return identityManager.getIdentities?.().find((i) => i.publicKey === active.publicKey) || active
  }

  /** The active personal store and the authority it belongs to. */
  function activePersonalContext() {
    if (activePublicKey && stores.has(activePublicKey)) {
      return { publicKey: activePublicKey, store: stores.get(activePublicKey) }
    }
    const deviceLocal = stores.get(DEVICE_LOCAL_PERSONAL_ID) || null
    if (deviceLocal) return { publicKey: DEVICE_LOCAL_PERSONAL_ID, store: deviceLocal }
    return { publicKey: null, store: null }
  }

  /**
   * Personal-store pairing requires an encrypted, writable store: a device
   * without a secure vault keeps its state device-local with pairing disabled.
   */
  function requirePairableStore() {
    const { publicKey, store } = activePersonalContext()
    if (!store) return { error: 'personal-store-unavailable' }
    if (!store.encrypted) return { error: 'personal-encryption-required' }
    if (!store.writable) return { error: 'personal-store-not-writable' }
    return { publicKey, store }
  }

  /**
   * Join an existing personal store as a BlindPairing candidate. Nothing is
   * written to disk here: the confirm payload carries the bootstrap key and the
   * keychain secret straight back to the caller.
   */
  function pairPersonalCandidate({ invite, userData, timeoutMs }) {
    return new Promise((resolve) => {
      let pairing = null
      let candidate = null
      let timer = null
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const closeSafe = async (resource) => { try { await resource?.close?.() } catch { /* best effort */ } }
        closeSafe(candidate)
          .then(() => closeSafe(pairing))
          .then(() => resolve(result), () => resolve(result))
      }

      try {
        pairing = new BlindPairing(ctx.swarm)
        candidate = pairing.addCandidate({
          invite,
          userData,
          onadd: (result) => {
            if (!result?.key || !result?.encryptionKey) return finish({ error: 'personal-pairing-rejected' })
            finish({ key: b4a.from(result.key), secret: b4a.from(result.encryptionKey) })
          }
        })
      } catch (err) {
        log.warn(' Personal pairing candidate failed:', err?.message)
        return finish({ error: 'personal-pairing-failed' })
      }

      timer = setTimeout(() => finish({ error: 'personal-pairing-timeout' }), timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
    })
  }

  /**
   * Swap the active store for `publicKey` to `next`, closing the store it
   * replaces only once the new one is live. On failure the previous store is
   * put back so the caller is never left without viewer state.
   */
  async function replaceActiveStore(publicKey, previous, next) {
    stores.set(publicKey, next)
    try {
      await activateStore(publicKey, next)
    } catch (error) {
      if (previous) stores.set(publicKey, previous)
      else stores.delete(publicKey)
      throw error
    }
    if (previous && previous !== next) {
      // Stop joining and replicating the epoch we just left.
      try { await previous.close() } catch { /* best effort */ }
    }
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
        // Every store this manager opens is encrypted, so an already-open store
        // can only be a store already keyed by a provisioned secret.
        const existingStore = stores.get(pk)
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

    /**
     * Mint a fresh, single-use invite another of the user's own devices can
     * redeem to join this personal store. Expiry is clamped to five minutes.
     */
    async createPersonalDeviceInvite({ expiresInMs } = {}) {
      const target = requirePairableStore()
      if (target.error) return { success: false, error: target.error }
      if (!ctx.swarm) return { success: false, error: 'personal-pairing-unavailable' }

      const ttl = clampInviteTtl(expiresInMs)
      const ceiling = Date.now() + ttl
      try {
        const created = await target.store.createInvite({ expiresInMs: ttl })
        const inviteCode = typeof created === 'string' ? created : (created?.inviteCode || '')
        if (!inviteCode) return { success: false, error: 'personal-invite-failed' }
        const reported = Number(created?.expiresAt)
        const expiresAt = Number.isFinite(reported) && reported > 0 ? Math.min(reported, ceiling) : ceiling
        return { success: true, inviteCode, expiresAt }
      } catch (err) {
        log.warn(' Personal device invite failed:', err?.message)
        return { success: false, error: 'personal-invite-failed' }
      }
    },

    /**
     * Redeem an invite on the joining device. The confirm payload carries the
     * bootstrap key and the keychain secret; the secret is handed back to the
     * platform exactly once here and is never persisted by the backend.
     */
    async redeemPersonalDeviceInvite({ inviteCode, deviceName, timeoutMs } = {}) {
      if (typeof inviteCode !== 'string' || inviteCode.length === 0) {
        return { success: false, error: 'invalid-invite-code' }
      }
      // Validate the code itself before anything else: a malformed invite is
      // caller error, not a capability problem.
      let invite = null
      try {
        invite = z32.decode(inviteCode)
        BlindPairing.decodeInvite(invite)
      } catch { return { success: false, error: 'invalid-invite-code' } }

      if (!ctx.swarm || !ctx.store) return { success: false, error: 'personal-pairing-unavailable' }

      const pk = identityManager?.getActivePublicKey?.() || activePublicKey || DEVICE_LOCAL_PERSONAL_ID
      const current = await readEpoch(pk)
      // A joined store always lands in a fresh epoch namespace so it never
      // collides with a local core this device already owns.
      const epoch = (current?.epoch || 0) + 1
      const namespace = epochNamespace(pk, epoch)

      let userData = null
      try {
        const writerKey = await Autobase.getLocalKey(ctx.store.namespace(namespace), {})
        userData = encodePersonalPairingUserData(b4a.toString(writerKey, 'hex'), deviceName || '')
      } catch (err) {
        log.warn(' Personal pairing writer key failed:', err?.message)
        return { success: false, error: 'personal-pairing-failed' }
      }

      const paired = await pairPersonalCandidate({
        invite,
        userData,
        timeoutMs: Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
          ? Number(timeoutMs)
          : PERSONAL_PAIRING_TIMEOUT_MS,
      })
      if (paired.error) return { success: false, error: paired.error }

      const secret = toSecretBuffer(paired.secret)
      if (!secret) return { success: false, error: 'personal-pairing-rejected' }
      const bootstrapKey = b4a.toString(paired.key, 'hex')

      return enqueueActiveChange(async () => {
        const previousStore = stores.get(pk) || null
        const previousSecret = secrets.get(pk) || null
        stores.delete(pk)
        secrets.set(pk, secret)
        try {
          await writeEpoch(pk, { epoch, namespace, bootstrapKey, joined: true })
          const store = await openForIdentity({ publicKey: pk, personalKey: bootstrapKey })
          if (!store) throw new Error('joined personal store did not open')
          await store.waitForWritable(PERSONAL_PAIRING_WRITABLE_TIMEOUT_MS).catch(() => false)
          await replaceActiveStore(pk, previousStore, store)
          return { success: true, secret: b4a.toString(secret, 'hex'), bootstrapKey: store.keyHex || bootstrapKey }
        } catch (err) {
          log.warn(' Personal pairing activation failed:', err?.message)
          stores.delete(pk)
          if (previousStore) stores.set(pk, previousStore)
          if (previousSecret) secrets.set(pk, previousSecret)
          else secrets.delete(pk)
          await writeEpoch(pk, {
            epoch: current?.epoch || 0,
            namespace: current?.namespace || personalNamespace(pk),
            bootstrapKey: current?.bootstrapKey || null,
            joined: current?.joined === true,
          }).catch(() => {})
          return { success: false, error: 'personal-pairing-failed' }
        }
      })
    },

    /** The user's own devices that can write this personal store. */
    async listPersonalDevices() {
      const { store } = activePersonalContext()
      if (!store) return { success: false, error: 'personal-store-unavailable' }
      if (!store.encrypted) return { success: false, error: 'personal-encryption-required' }
      try {
        const localKeyHex = store.localKeyHex
        const devices = (await store.listWriters()).map((writer) => ({
          keyHex: String(writer.keyHex || ''),
          deviceName: String(writer.deviceName || ''),
          addedAt: Number(writer.addedAt) || 0,
          self: Boolean(localKeyHex) && writer.keyHex === localKeyHex,
        })).filter((device) => device.keyHex !== '')
        // The founding device never appends an add-writer op for itself.
        if (localKeyHex && !devices.some((device) => device.self)) {
          devices.unshift({ keyHex: localKeyHex, deviceName: '', addedAt: 0, self: true })
        }
        return { success: true, devices }
      } catch (err) {
        log.warn(' Personal device list failed:', err?.message)
        return { success: false, error: 'personal-device-list-failed' }
      }
    },

    /**
     * Forward-only revocation: bounded state is copied into a new encrypted
     * epoch keyed by a freshly generated platform secret, the old epoch stops
     * replicating, and every retained device must re-pair. Nothing the revoked
     * device already read is erased.
     *
     * Two distinct failures, because the platform has to react differently:
     * `personal-revoke-failed` means nothing was rotated and the caller should
     * keep using the secret it already had, while `personal-revoke-incomplete`
     * means the new epoch is already durable — the caller must keep the secret
     * it just supplied, since a restart reopens the rotated store.
     */
    async revokePersonalDevice({ keyHex, secret, deviceName } = {}) {
      const revokedKey = typeof keyHex === 'string' ? keyHex.toLowerCase() : ''
      if (!HEX_32_BYTES.test(revokedKey)) return { success: false, error: 'invalid-device-key' }
      const nextSecret = toSecretBuffer(secret)
      if (!nextSecret) return { success: false, error: 'personal-secret-required' }

      const target = requirePairableStore()
      if (target.error) return { success: false, error: target.error }
      const { publicKey: pk, store } = target
      if (!ctx.store) return { success: false, error: 'personal-store-unavailable' }
      if (store.localKeyHex && revokedKey === store.localKeyHex) {
        return { success: false, error: 'cannot-revoke-local-device' }
      }
      if (store.secret && b4a.equals(nextSecret, store.secret)) {
        return { success: false, error: 'personal-secret-reused' }
      }
      // The new epoch lives in its own corestore namespace, so a restart can
      // only find it if that namespace is recorded. Refuse to rotate into an
      // epoch this device would lose track of.
      if (typeof ctx.metaDb?.put !== 'function') {
        return { success: false, error: 'personal-epoch-unavailable' }
      }

      const previousSecret = secrets.get(pk) || null

      return enqueueActiveChange(async () => {
        let next = null
        let epochRecorded = false
        let frozen = false
        try {
          const writers = await store.listWriters()
          if (!writers.some((writer) => writer.keyHex === revokedKey)) {
            return { success: false, error: 'device-not-found' }
          }

          // Drop the writer before the snapshot, so the exported roster no
          // longer carries the revoked device and a peer still replicating the
          // abandoned epoch stops accepting its ops.
          await store.removeWriter(revokedKey).catch(() => {})

          // The old epoch is being abandoned: anything appended to it from here
          // is invisible to the snapshot below and dies with the store. Refuse
          // writes for the length of the rotation — reads, exportState
          // included, stay open — so the caller replays them against the new
          // epoch instead of losing them.
          store.freeze('personal-store-rotating')
          frozen = true

          const state = await store.exportState()
          const current = await readEpoch(pk)
          const epoch = (current?.epoch || 0) + 1
          const namespace = epochNamespace(pk, epoch)

          next = new PersonalStore(ctx.store, { namespace, secret: nextSecret, swarm: ctx.swarm || null })
          await next.ready()
          await next.importState(state)

          secrets.set(pk, b4a.from(nextSecret))
          await writeEpoch(pk, { epoch, namespace, bootstrapKey: next.keyHex, joined: false })
          // Past this line the rotation is durable: a restart reopens the new
          // epoch, so the platform must keep the secret it supplied.
          epochRecorded = true
          if (pk !== DEVICE_LOCAL_PERSONAL_ID && typeof identityManager?.setPersonalKey === 'function') {
            await identityManager.setPersonalKey(pk, next.keyHex).catch(() => {})
          }
          if (pk === DEVICE_LOCAL_PERSONAL_ID) anonymousBootstrapKey = next.keyHex

          await replaceActiveStore(pk, store, next)
          // The swap is committed and the abandoned epoch closed: the write
          // window is shut, and writes now reach the new epoch.
          frozen = false
          if (ctx.swarm) await next.setupPairing(ctx.swarm).catch(() => {})

          log.info(' Rotated personal store to epoch', epoch, 'after revoking', revokedKey.slice(0, 16), deviceName || '')
          const remaining = (await next.listWriters()).length + (next.localKeyHex ? 1 : 0)
          return { success: true, bootstrapKey: next.keyHex, remainingDeviceCount: remaining }
        } catch (err) {
          log.warn(' Personal device revocation failed:', err?.message)
          if (next && stores.get(pk) !== next) { try { await next.close() } catch { /* best effort */ } }
          if (!epochRecorded) {
            // Nothing durable happened, so leave this device exactly as it was
            // and let the platform restore the secret it was holding.
            if (previousSecret) secrets.set(pk, previousSecret)
            else secrets.delete(pk)
            return { success: false, error: 'personal-revoke-failed' }
          }
          return { success: false, error: 'personal-revoke-incomplete' }
        } finally {
          // Every failure path leaves the old store active, so it has to take
          // writes again; the success path closed it already.
          if (frozen) { try { store.unfreeze() } catch { /* best effort */ } }
        }
      })
    },

    /** Get the active personal store if open. */
    getActive() {
      return (activePublicKey ? stores.get(activePublicKey) : null) ||
        stores.get(DEVICE_LOCAL_PERSONAL_ID) ||
        null
    },

    /** Identity or explicit device-local authority owning the active store. */
    getActivePublicKey() {
      return activePublicKey
    },

    /** Device-local encrypted store used before an identity/pairing is active. */
    getAnonymous() {
      return stores.get(DEVICE_LOCAL_PERSONAL_ID) || null
    },

    /** Switch the active personal store when the active identity changes. */
    async setActive(publicKey, { allowDeviceLocal = false } = {}) {
      return enqueueActiveChange(async () => {
        const identity = identityManager?.getIdentities?.().find((i) => i.publicKey === publicKey)
        if (!identity) return null
        const store = await openForIdentity(identity)
        if (!store) {
          const deviceLocal = stores.get(DEVICE_LOCAL_PERSONAL_ID) || null
          if (
            allowDeviceLocal &&
            deviceLocal &&
            activePublicKey === DEVICE_LOCAL_PERSONAL_ID &&
            ctx.personal === deviceLocal
          ) {
            return deviceLocal
          }
          throw unavailablePersonalStoreSecret(publicKey)
        }
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
