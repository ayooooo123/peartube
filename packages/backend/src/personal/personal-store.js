import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import BlindPairing from 'blind-pairing'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import z32 from 'z32'

import { fromHex } from '../channel/util.js'
import { toSecret, deriveKeys, makeBlindEncryption } from './personal-crypto.js'

/**
 * PersonalStore
 *
 * A private, per-identity multi-writer database that syncs a user's own data
 * (subscriptions, playlists, watch history, app settings) across all of their
 * paired devices.
 *
 * Unlike the public channel ({@link MultiWriterChannel}), which is a
 * single-writer Hyperbee (HyperDB.bee) whose key is published for discovery,
 * the personal store is a genuine multi-writer database built on Autobase with
 * a Hyperbee view (the "autobee" pattern). Each of the user's devices is an
 * Autobase writer, so every device can write and changes converge across all
 * of them. The bootstrap key is never published — only the user's own devices
 * receive it through the device-pairing flow — so the data stays private.
 *
 * Wire/value encoding is JSON for simplicity; the data volumes here (a user's
 * own subscriptions/playlists/history) are small relative to channel content.
 */

const COLLECTIONS = {
  SUBSCRIPTION: 'sub',
  PLAYLIST: 'playlist',
  PLAYLIST_ITEM: 'playlist-item',
  HISTORY: 'history',
  RESUME: 'resume',
  SETTING: 'setting',
  WRITER: 'writer',
  INVITE: 'invite'
}

// Reverse-chronological history keys: newest sorts first. Pad the descending
// timestamp so lexicographic order matches numeric order.
const MAX_TS = 9999999999999 // ~year 2286, 13 digits

function descendingTimeKey(timestamp) {
  const inverted = MAX_TS - Math.min(timestamp, MAX_TS)
  return String(inverted).padStart(13, '0')
}

function randomId() {
  return b4a.toString(crypto.randomBytes(16), 'hex')
}

function stripUndefined(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export class PersonalStore extends ReadyResource {
  /**
   * @param {import('corestore')} store - Corestore (will be namespaced internally)
   * @param {Object} [opts]
   * @param {Buffer|string} [opts.key] - Autobase bootstrap key (omit to create a new store)
   * @param {Buffer|string} [opts.secret] - 32-byte at-rest encryption secret, held in the
   *   device's native keychain and shared with paired devices. When set, every Autobase
   *   core (including the Hyperbee view) is encrypted on disk and the data-encryption key
   *   is stored wrapped (blind encryption), so the data is unreadable from disk alone —
   *   only a holder of the keychain secret can decrypt it.
   * @param {import('hyperswarm')} [opts.swarm]
   * @param {string} [opts.namespace] - Corestore namespace (default derived from key)
   */
  constructor(store, opts = {}) {
    super()
    this.opts = opts
    this.swarm = opts.swarm || null

    const bootstrap = opts.key ? (b4a.isBuffer(opts.key) ? opts.key : b4a.from(opts.key, 'hex')) : null
    const ns = opts.namespace || (bootstrap ? `peartube-personal:${b4a.toString(bootstrap, 'hex')}` : `peartube-personal:${randomId()}`)
    this.store = typeof store.namespace === 'function' ? store.namespace(ns) : store
    this._bootstrap = bootstrap
    this._secret = opts.secret ? toSecret(opts.secret) : null

    this.base = null
    this.pairing = null
    this.pairingMember = null
    this._discovery = null
    this._pairingSetupDone = false

    this.ready().catch(() => {})
  }

  async _open() {
    const handlers = {
      valueEncoding: 'json',
      ackInterval: 1000,
      open: (viewStore) => new Hyperbee(viewStore.get('peartube-personal-view'), {
        keyEncoding: 'utf-8',
        valueEncoding: 'json',
        extension: false
      }),
      apply: PersonalStore._apply
    }
    // When a keychain secret is present, encrypt every core with a derived
    // data-encryption key and store that key wrapped (blind encryption) so it
    // never lands on disk in plaintext. Autobase treats a present encryptionKey
    // as "encrypted" and a null/absent one as plaintext.
    if (this._secret) {
      const { dek, wrapKey } = deriveKeys(this._secret)
      handlers.encryptionKey = dek
      handlers.blindEncryption = makeBlindEncryption(wrapKey)
    }

    this.base = new Autobase(this.store, this._bootstrap, handlers)

    await this.base.ready()
  }

  static async _apply(nodes, view, host) {
    for (const node of nodes) {
      const op = node.value
      if (!op || typeof op !== 'object') continue

      if (op.type === 'add-writer') {
        if (op.key) await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
        // Also record the writer in the view for roster/UX purposes.
        await view.put(`${COLLECTIONS.WRITER}/${op.key}`, stripUndefined({
          keyHex: op.key,
          deviceName: op.deviceName || '',
          addedAt: op.addedAt || Date.now()
        }))
        continue
      }

      if (op.type === 'remove-writer') {
        if (op.key) {
          await host.removeWriter(b4a.from(op.key, 'hex')).catch(() => {})
          await view.del(`${COLLECTIONS.WRITER}/${op.key}`)
        }
        continue
      }

      await PersonalStore._applyData(view, op)
    }
  }

  static async _applyData(view, op) {
    switch (op.type) {
      case 'subscribe':
        await view.put(`${COLLECTIONS.SUBSCRIPTION}/${op.channelKey}`, stripUndefined({
          channelKey: op.channelKey,
          name: op.name || '',
          subscribedAt: op.subscribedAt || Date.now()
        }))
        break
      case 'unsubscribe':
        await view.del(`${COLLECTIONS.SUBSCRIPTION}/${op.channelKey}`)
        break
      case 'put-playlist':
        await view.put(`${COLLECTIONS.PLAYLIST}/${op.id}`, stripUndefined({
          id: op.id,
          name: op.name || '',
          description: op.description || '',
          createdAt: op.createdAt || Date.now(),
          updatedAt: op.updatedAt || Date.now()
        }))
        break
      case 'delete-playlist': {
        await view.del(`${COLLECTIONS.PLAYLIST}/${op.id}`)
        const prefix = `${COLLECTIONS.PLAYLIST_ITEM}/${op.id}/`
        for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
          await view.del(entry.key)
        }
        break
      }
      case 'add-playlist-item':
        await view.put(`${COLLECTIONS.PLAYLIST_ITEM}/${op.playlistId}/${op.videoKey}`, stripUndefined({
          playlistId: op.playlistId,
          videoKey: op.videoKey,
          channelKey: op.channelKey || '',
          videoId: op.videoId || '',
          addedAt: op.addedAt || Date.now()
        }))
        break
      case 'remove-playlist-item':
        await view.del(`${COLLECTIONS.PLAYLIST_ITEM}/${op.playlistId}/${op.videoKey}`)
        break
      case 'log-history': {
        const eventId = op.eventId || randomId()
        const ts = op.timestamp || Date.now()
        await view.put(`${COLLECTIONS.HISTORY}/${descendingTimeKey(ts)}/${eventId}`, stripUndefined({
          eventId,
          channelKey: op.channelKey || '',
          videoId: op.videoId || '',
          videoKey: op.videoKey || '',
          title: op.title || '',
          duration: op.duration || 0,
          position: op.position || 0,
          completed: !!op.completed,
          timestamp: ts
        }))
        if (op.videoKey) {
          await view.put(`${COLLECTIONS.RESUME}/${op.videoKey}`, stripUndefined({
            videoKey: op.videoKey,
            channelKey: op.channelKey || '',
            videoId: op.videoId || '',
            position: op.position || 0,
            duration: op.duration || 0,
            completed: !!op.completed,
            updatedAt: ts
          }))
        }
        break
      }
      case 'set-setting':
        await view.put(`${COLLECTIONS.SETTING}/${op.key}`, { key: op.key, value: op.value, updatedAt: op.updatedAt || Date.now() })
        break
      case 'delete-setting':
        await view.del(`${COLLECTIONS.SETTING}/${op.key}`)
        break
      default:
        break
    }
  }

  // --- identity / lifecycle -------------------------------------------------

  get key() {
    return this.base?.key || null
  }

  get keyHex() {
    return this.key ? b4a.toString(this.key, 'hex') : null
  }

  get discoveryKey() {
    return this.base?.discoveryKey || null
  }

  get secret() {
    return this._secret || null
  }

  get secretHex() {
    return this._secret ? b4a.toString(this._secret, 'hex') : null
  }

  get encrypted() {
    return Boolean(this._secret)
  }

  get writable() {
    return Boolean(this.base?.writable)
  }

  get localKey() {
    return this.base?.local?.key || null
  }

  get localKeyHex() {
    return this.localKey ? b4a.toString(this.localKey, 'hex') : null
  }

  get view() {
    return this.base?.view || null
  }

  async update() {
    await this.base?.update()
  }

  async _append(op) {
    if (!this.writable) throw new Error('Personal store is not writable on this device')
    await this.base.append(op)
    await this.base.update()
  }

  // --- writers / device linking --------------------------------------------

  /** Add another of the user's devices as a writer (call on a writable device). */
  async addWriter(localKeyHex, { deviceName = '' } = {}) {
    if (!localKeyHex) throw new Error('Writer key required')
    await this._append({ type: 'add-writer', key: localKeyHex, deviceName, addedAt: Date.now() })
  }

  async removeWriter(localKeyHex) {
    if (!localKeyHex) throw new Error('Writer key required')
    await this._append({ type: 'remove-writer', key: localKeyHex })
  }

  async listWriters() {
    await this.update()
    return this._collect(COLLECTIONS.WRITER)
  }

  /** Wait until this device has been granted write access by an existing writer. */
  async waitForWritable(timeoutMs = 30000) {
    if (this.writable) return true
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      await this.base.update().catch(() => {})
      if (this.writable) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return this.writable
  }

  // --- subscriptions --------------------------------------------------------

  async subscribe(channelKey, { name = '' } = {}) {
    await this._append({ type: 'subscribe', channelKey, name, subscribedAt: Date.now() })
  }

  async unsubscribe(channelKey) {
    await this._append({ type: 'unsubscribe', channelKey })
  }

  async listSubscriptions() {
    await this.update()
    return this._collect(COLLECTIONS.SUBSCRIPTION)
  }

  // --- playlists ------------------------------------------------------------

  async createPlaylist({ id = randomId(), name = '', description = '' } = {}) {
    const now = Date.now()
    await this._append({ type: 'put-playlist', id, name, description, createdAt: now, updatedAt: now })
    return id
  }

  async updatePlaylist(id, { name, description } = {}) {
    const existing = await this.view.get(`${COLLECTIONS.PLAYLIST}/${id}`)
    if (!existing?.value) throw new Error('Playlist not found: ' + id)
    await this._append({
      type: 'put-playlist',
      id,
      name: name ?? existing.value.name,
      description: description ?? existing.value.description,
      createdAt: existing.value.createdAt,
      updatedAt: Date.now()
    })
  }

  async deletePlaylist(id) {
    await this._append({ type: 'delete-playlist', id })
  }

  async addToPlaylist(playlistId, { channelKey, videoId, videoKey }) {
    const key = videoKey || `${channelKey}:${videoId}`
    await this._append({ type: 'add-playlist-item', playlistId, videoKey: key, channelKey, videoId, addedAt: Date.now() })
  }

  async removeFromPlaylist(playlistId, videoKey) {
    await this._append({ type: 'remove-playlist-item', playlistId, videoKey })
  }

  async listPlaylists() {
    await this.update()
    return this._collect(COLLECTIONS.PLAYLIST)
  }

  async listPlaylistItems(playlistId) {
    await this.update()
    return this._collect(`${COLLECTIONS.PLAYLIST_ITEM}/${playlistId}`)
  }

  // --- watch history --------------------------------------------------------

  async logHistory(event) {
    const eventId = event.eventId || randomId()
    await this._append({ type: 'log-history', ...event, eventId, timestamp: event.timestamp || Date.now() })
    return eventId
  }

  /** Reverse-chronological history (newest first). */
  async listHistory({ limit = 100 } = {}) {
    await this.update()
    const out = []
    const prefix = `${COLLECTIONS.HISTORY}/`
    for await (const entry of this.view.createReadStream({ gte: prefix, lt: prefix + '\xff', limit })) {
      out.push(entry.value)
    }
    return out
  }

  /** Resume position for a given video (continue-watching). */
  async getResume(videoKey) {
    await this.update()
    const entry = await this.view.get(`${COLLECTIONS.RESUME}/${videoKey}`)
    return entry?.value || null
  }

  async listResume() {
    await this.update()
    return this._collect(COLLECTIONS.RESUME)
  }

  // --- settings -------------------------------------------------------------

  async setSetting(key, value) {
    await this._append({ type: 'set-setting', key, value, updatedAt: Date.now() })
  }

  async deleteSetting(key) {
    await this._append({ type: 'delete-setting', key })
  }

  async getSetting(key) {
    await this.update()
    const entry = await this.view.get(`${COLLECTIONS.SETTING}/${key}`)
    return entry?.value?.value
  }

  async getSettings() {
    await this.update()
    const rows = await this._collect(COLLECTIONS.SETTING)
    const out = {}
    for (const row of rows) out[row.key] = row.value
    return out
  }

  // --- pairing (BlindPairing over swarm) ------------------------------------

  /**
   * Create an invite another of the user's devices can redeem to join this
   * personal store as a writer. Returns a z32 invite string.
   */
  async createInvite({ expires = 0 } = {}) {
    if (this.swarm) this.setupPairing(this.swarm).catch(() => {})
    await this.update()
    const existing = await this._collect(COLLECTIONS.INVITE)
    const current = existing.find((i) => i.current)
    if (current?.inviteZ32) return current.inviteZ32

    const inv = BlindPairing.createInvite(this.key, { expires })
    const invite = {
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32: z32.encode(inv.invite),
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      expires,
      createdAt: Date.now(),
      current: true
    }
    await this._append({ type: 'set-setting', key: `__invite__/${invite.idHex}`, value: invite })
    return invite.inviteZ32
  }

  async _listInvites() {
    await this.update()
    const out = []
    const prefix = `${COLLECTIONS.SETTING}/__invite__/`
    for await (const entry of this.view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      if (entry.value?.value) out.push(entry.value.value)
    }
    return out
  }

  setupPairing(swarm) {
    if (!swarm || this._pairingSetupDone) return Promise.resolve()
    this._pairingSetupDone = true
    this.swarm = swarm
    if (this.discoveryKey) {
      try {
        this._discovery = swarm.join(this.discoveryKey)
        this._discovery?.flushed?.().catch(() => {})
      } catch { /* best effort */ }
    }
    if (!this.writable) return Promise.resolve()

    this.pairing = new BlindPairing(swarm)
    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: async (req) => {
        try {
          const invites = await this._listInvites()
          const inv = invites.find((candidate) => candidate.current)
          if (!inv) return
          if (inv.expires > 0 && Date.now() > inv.expires) return
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          if (candidateIdHex !== inv.idHex) return
          const userData = req.open(fromHex(inv.publicKeyHex))
          const newWriterKeyHex = b4a.toString(userData, 'hex')
          await this.addWriter(newWriterKeyHex, { deviceName: '' })
          // Hand the joining device the keychain secret (in the encryptionKey
          // slot of the confirm payload) so it can decrypt the synced cores and
          // persist the secret into its own native keychain.
          req.confirm({ key: this.key, encryptionKey: this._secret || undefined })
          await this._append({ type: 'delete-setting', key: `__invite__/${inv.idHex}` })
        } catch (err) {
          console.error('[PersonalStore] Pairing error:', err)
        }
      }
    })
    return Promise.resolve()
  }

  // --- helpers --------------------------------------------------------------

  async _collect(prefix) {
    const out = []
    const lo = `${prefix}/`
    for await (const entry of this.view.createReadStream({ gte: lo, lt: lo + '\xff' })) {
      out.push(entry.value)
    }
    return out
  }

  async _close() {
    const closeSafe = async (r) => { try { await r?.close?.() } catch { /* best effort */ } }
    if (this.pairingMember) { await closeSafe(this.pairingMember); this.pairingMember = null }
    if (this.pairing) { await closeSafe(this.pairing); this.pairing = null }
    if (this._discovery) { await closeSafe(this._discovery); this._discovery = null }
    if (this.base) { await closeSafe(this.base); this.base = null }
  }
}
