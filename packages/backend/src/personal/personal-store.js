import ReadyResource from 'ready-resource'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import BlindPairing from 'blind-pairing'
import Protomux from 'protomux'
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
 *
 * Viewer progress (position, completion, saved-library flag) is device-local
 * state that converges across the user's own devices without any wall-clock
 * comparison: every progress write carries an ordering triple
 * `(playbackGeneration, lamport, writerKey)` and the highest triple wins.
 */

const COLLECTIONS = {
  SUBSCRIPTION: 'sub',
  PLAYLIST: 'playlist',
  PLAYLIST_ITEM: 'playlist-item',
  HISTORY: 'history',
  RESUME: 'resume',
  PROGRESS: 'progress',
  SETTING: 'setting',
  WRITER: 'writer',
  INVITE: 'invite',
  META: 'meta'
}

// Reverse-chronological history keys: newest sorts first. Pad the descending
// timestamp so lexicographic order matches numeric order.
const MAX_TS = 9999999999999 // ~year 2286, 13 digits

/** Bounded retention: viewer state never grows without limit. */
export const PERSONAL_PROGRESS_RECORD_LIMIT = 2000
export const PERSONAL_HISTORY_EVENT_LIMIT = 5000
/** Device-pairing invites are user-initiated, single-use and short-lived. */
export const PERSONAL_INVITE_MAX_TTL_MS = 5 * 60 * 1000
export const PERSONAL_OUTSTANDING_INVITE_LIMIT = 8
export const PERSONAL_STATE_EXPORT_VERSION = 1

const META_PROGRESS_COUNT = `${COLLECTIONS.META}/progress-count`
const META_HISTORY_COUNT = `${COLLECTIONS.META}/history-count`
const META_LAMPORT = `${COLLECTIONS.META}/lamport`
const LEGACY_INVITE_SETTING_PREFIX = '__invite__/'

const DEFAULT_LIMITS = Object.freeze({
  progress: PERSONAL_PROGRESS_RECORD_LIMIT,
  history: PERSONAL_HISTORY_EVENT_LIMIT
})

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

function toUint(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

function toText(value) {
  return typeof value === 'string' ? value : ''
}

/** First defined, non-empty candidate (used to inherit metadata on update). */
function inheritText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

function inheritUint(value, fallback) {
  if (value === undefined || value === null) return toUint(fallback)
  return toUint(value)
}

export function personalSettingDigest(value) {
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify(value))), 'hex')
}

function personalSettingRevision(entry, digest) {
  if (typeof entry?.value?.revision === 'string' && /^[0-9a-f]{32}$/.test(entry.value.revision)) {
    return entry.value.revision
  }
  if (Number.isSafeInteger(entry?.seq) && entry.seq >= 0) return `legacy-seq:${entry.seq}`
  return `legacy-time:${Number(entry?.value?.updatedAt || 0)}:${digest}`
}

// --- viewer progress identity / ordering ------------------------------------

function normalizeProgressIdentity(identity) {
  const entityRef = toText(identity?.entityRef)
  const editionRef = toText(identity?.editionRef)
  const memberRef = toText(identity?.memberRef)
  if (!entityRef && !editionRef && !memberRef) return null
  return { entityRef, editionRef, memberRef }
}

/**
 * Canonical progress key. Media identity (entity/edition/member) is the primary
 * coordinate; the legacy `channelKey:videoId` pair is only a fallback so
 * pre-existing device state can be migrated.
 */
export function personalProgressStateKey({ identity, videoKey } = {}) {
  const id = normalizeProgressIdentity(identity)
  if (id) return `${id.entityRef}|${id.editionRef}|${id.memberRef}`
  return toText(videoKey)
}

export function parsePersonalProgressStateKey(stateKey) {
  const key = toText(stateKey)
  if (!key.includes('|')) return { identity: null, videoKey: key }
  const [entityRef = '', editionRef = '', memberRef = ''] = key.split('|')
  return { identity: { entityRef, editionRef, memberRef }, videoKey: '' }
}

function normalizeProgressOrder(order) {
  return {
    playbackGeneration: toUint(order?.playbackGeneration),
    lamport: toUint(order?.lamport),
    writerKey: toText(order?.writerKey),
    tombstone: Boolean(order?.tombstone)
  }
}

function isCompleteProgressOrder(order) {
  if (!order || typeof order !== 'object') return false
  return order.playbackGeneration !== undefined &&
    order.lamport !== undefined &&
    order.writerKey !== undefined
}

/**
 * Deterministic total order over concurrent progress writes. Wall-clock time is
 * never consulted: `(playbackGeneration, lamport, writerKey)` is compared
 * lexicographically, so every device converges on the same winner.
 *
 * @returns {-1|0|1} negative when `a` loses, 0 when the triples are identical.
 */
export function comparePersonalProgressOrder(a, b) {
  const left = normalizeProgressOrder(a)
  const right = normalizeProgressOrder(b)
  if (left.playbackGeneration !== right.playbackGeneration) {
    return left.playbackGeneration < right.playbackGeneration ? -1 : 1
  }
  if (left.lamport !== right.lamport) return left.lamport < right.lamport ? -1 : 1
  if (left.writerKey !== right.writerKey) return left.writerKey < right.writerKey ? -1 : 1
  return 0
}

function normalizeProgressRecord(input) {
  const identity = normalizeProgressIdentity(input?.identity)
  const positionSec = toUint(input?.positionSec ?? input?.position)
  const durationSec = toUint(input?.durationSec ?? input?.duration)
  const record = {
    stateKey: toText(input?.stateKey),
    channelKey: toText(input?.channelKey),
    videoId: toText(input?.videoId),
    videoKey: toText(input?.videoKey),
    title: toText(input?.title),
    positionSec,
    position: positionSec,
    durationSec,
    duration: durationSec,
    completed: Boolean(input?.completed),
    saved: Boolean(input?.saved),
    updatedAt: toUint(input?.updatedAt),
    order: normalizeProgressOrder(input?.order)
  }
  if (identity) record.identity = identity
  return record
}

/**
 * Content fingerprint of a progress record, ordering triple excluded. Two ops
 * that carry the same triple are only interchangeable when their content also
 * matches; the digest is what tells a replay apart from a genuine collision.
 */
function progressContentDigest(record) {
  const r = normalizeProgressRecord(record)
  return b4a.toString(crypto.hash(b4a.from(JSON.stringify([
    r.stateKey, r.channelKey, r.videoId, r.videoKey, r.title,
    r.positionSec, r.durationSec, r.completed, r.saved, r.updatedAt,
    r.identity?.entityRef || '', r.identity?.editionRef || '', r.identity?.memberRef || ''
  ]))), 'hex')
}

/**
 * Resolve one progress write against the stored record.
 *
 * Two devices can mint the same triple (same generation, same Lamport stamp,
 * and — after a state import — even the same writer key). An equal triple is
 * therefore only an idempotent replay when the content matches too; otherwise
 * it is a real collision, resolved on the content digest so every device picks
 * the same winner instead of each keeping whatever it saw first.
 *
 * @returns the record to store, or `null` when the incoming write loses (stale)
 *   or is an exact replay of the stored triple and content (idempotent).
 */
export function mergePersonalProgress(existing, incoming) {
  const next = normalizeProgressRecord(incoming)
  if (!existing) return next
  const stored = normalizeProgressRecord(existing)
  const ordering = comparePersonalProgressOrder(next.order, stored.order)
  if (ordering < 0) return null
  if (ordering === 0 && progressContentDigest(next) <= progressContentDigest(stored)) return null
  // Completion is monotonic inside one playback generation: a later low-position
  // ping cannot un-complete a title. Only an explicit replay (a strictly higher
  // generation) may reset completion.
  if (next.order.playbackGeneration === stored.order.playbackGeneration && stored.completed) {
    next.completed = true
  }
  return next
}

function progressToResumeEntry(record) {
  const normalized = normalizeProgressRecord(record)
  // `resume-entry.videoKey` is a required wire field; identity-only records fall
  // back to their canonical state key so the field is always populated.
  const entry = {
    videoKey: normalized.videoKey || normalized.stateKey,
    stateKey: normalized.stateKey,
    channelKey: normalized.channelKey,
    videoId: normalized.videoId,
    title: normalized.title,
    position: normalized.positionSec,
    positionSec: normalized.positionSec,
    duration: normalized.durationSec,
    durationSec: normalized.durationSec,
    completed: normalized.completed,
    saved: normalized.saved,
    updatedAt: normalized.updatedAt,
    order: normalized.order
  }
  if (normalized.identity) entry.identity = normalized.identity
  return entry
}

function legacyResumeToEntry(row) {
  return progressToResumeEntry({
    stateKey: toText(row?.stateKey) || toText(row?.videoKey),
    videoKey: row?.videoKey,
    channelKey: row?.channelKey,
    videoId: row?.videoId,
    title: row?.title,
    positionSec: row?.position,
    durationSec: row?.duration,
    completed: row?.completed,
    saved: false,
    updatedAt: row?.updatedAt,
    order: null
  })
}

// --- pairing user data ------------------------------------------------------

/**
 * Encode the payload a joining device sends through BlindPairing. A bare 32-byte
 * writer key stays supported for older devices; the JSON form additionally lets
 * the joining device name itself in the roster.
 */
export function encodePersonalPairingUserData(keyHex, deviceName = '') {
  const key = toText(keyHex).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Writer key must be 32-byte hex')
  const name = toText(deviceName).slice(0, 64)
  if (!name) return b4a.from(key, 'hex')
  return b4a.from(JSON.stringify({ keyHex: key, deviceName: name }))
}

function decodePairingUserData(userData) {
  if (!userData?.length) return null
  if (userData.length === 32) return { keyHex: b4a.toString(userData, 'hex'), deviceName: '' }
  try {
    const parsed = JSON.parse(b4a.toString(userData, 'utf-8'))
    const keyHex = toText(parsed?.keyHex || parsed?.key).toLowerCase()
    if (/^[0-9a-f]{64}$/.test(keyHex)) {
      return { keyHex, deviceName: toText(parsed?.deviceName).slice(0, 64) }
    }
  } catch { /* not the JSON form */ }
  return null
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
   * @param {number} [opts.progressLimit] - retained progress records (test knob; all of a
   *   user's devices must agree on the caps or they prune each other's records)
   * @param {number} [opts.historyLimit] - retained history events
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
    this._limits = Object.freeze({
      progress: toUint(opts.progressLimit) || DEFAULT_LIMITS.progress,
      history: toUint(opts.historyLimit) || DEFAULT_LIMITS.history
    })

    this.base = null
    this.pairing = null
    this.pairingMember = null
    this._discovery = null
    this._pairingSetupDone = false
    this._replicatedConnections = new WeakSet()
    this._replicateConnection = null
    // Redemption is serialized in-process so two concurrent BlindPairing
    // requests cannot both pass the invite check before either consumes it.
    this._pairingQueue = Promise.resolve()
    this._lamport = 0
    // Set while an epoch rotation is exporting state: reads stay open, writes
    // are refused so the app can replay them against the new epoch.
    this._frozenReason = null

    this.ready().catch(() => {})
  }

  async _open() {
    const limits = this._limits
    const handlers = {
      valueEncoding: 'json',
      ackInterval: 1000,
      open: (viewStore) => new Hyperbee(viewStore.get('peartube-personal-view'), {
        keyEncoding: 'utf-8',
        valueEncoding: 'json',
        extension: false
      }),
      apply: (nodes, view, host) => PersonalStore._apply(nodes, view, host, limits)
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

    // Seed the Lamport clock from the view so a restarted device never re-issues
    // a stamp it has already observed.
    try {
      const entry = await this.base.view?.get(META_LAMPORT)
      this._lamport = toUint(entry?.value?.lamport)
    } catch { /* fresh or unreadable view */ }
  }

  static async _apply(nodes, view, host, limits = DEFAULT_LIMITS) {
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

      await PersonalStore._applyData(view, op, limits)
    }
  }

  static async _applyData(view, op, limits = DEFAULT_LIMITS) {
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
        // Ops written before canonical progress records carried their fields
        // flat and maintained the legacy `resume/` rows; the whole log is
        // re-applied on rebuild, so both shapes must stay supported.
        const legacy = !op.event
        const event = op.event || op
        const eventId = event.eventId || randomId()
        const ts = toUint(event.timestamp) || Date.now()
        const entry = stripUndefined({
          eventId,
          channelKey: event.channelKey || '',
          videoId: event.videoId || '',
          videoKey: event.videoKey || '',
          title: event.title || '',
          duration: toUint(event.duration ?? event.durationSec),
          position: toUint(event.position ?? event.positionSec),
          completed: !!event.completed,
          timestamp: ts,
          identity: op.record?.identity ?? normalizeProgressIdentity(event.identity) ?? undefined,
          saved: op.record ? !!op.record.saved : (event.saved === undefined ? undefined : !!event.saved),
          order: op.record?.order ?? (isCompleteProgressOrder(event.order) ? normalizeProgressOrder(event.order) : undefined)
        })
        await PersonalStore._putHistoryEvent(view, `${COLLECTIONS.HISTORY}/${descendingTimeKey(ts)}/${eventId}`, entry, limits)
        if (op.record) {
          await PersonalStore._mergeProgress(view, op.record, limits)
        } else if (legacy && event.videoKey) {
          await view.put(`${COLLECTIONS.RESUME}/${event.videoKey}`, stripUndefined({
            videoKey: event.videoKey,
            channelKey: event.channelKey || '',
            videoId: event.videoId || '',
            position: toUint(event.position),
            duration: toUint(event.duration),
            completed: !!event.completed,
            updatedAt: ts
          }))
        }
        break
      }
      case 'put-progress':
        await PersonalStore._mergeProgress(view, op.record, limits)
        break
      case 'delete-resume':
        if (op.videoKey) await view.del(`${COLLECTIONS.RESUME}/${op.videoKey}`)
        break
      case 'put-invite': {
        const invite = op.invite
        if (!invite?.idHex) break
        await view.put(`${COLLECTIONS.INVITE}/${invite.idHex}`, {
          idHex: invite.idHex,
          inviteZ32: toText(invite.inviteZ32),
          publicKeyHex: toText(invite.publicKeyHex),
          createdAt: toUint(invite.createdAt),
          expiresAt: toUint(invite.expiresAt),
          consumedAt: 0,
          consumeId: '',
          consumedBy: ''
        })
        break
      }
      case 'consume-invite': {
        // Single use, enforced by op order rather than by the requesting device:
        // the first consume wins and any later or replayed consume is a no-op.
        // Expiry is checked against the timestamp carried by the op so every
        // device reaches the same verdict.
        const key = `${COLLECTIONS.INVITE}/${op.idHex}`
        const invite = (await view.get(key))?.value
        if (!invite) break
        if (toUint(invite.consumedAt) > 0) break
        const at = toUint(op.at)
        if (toUint(invite.expiresAt) > 0 && at > toUint(invite.expiresAt)) break
        await view.put(key, {
          ...invite,
          consumedAt: Math.max(at, 1),
          consumeId: toText(op.consumeId),
          consumedBy: toText(op.writerKey)
        })
        break
      }
      case 'delete-invite':
        if (op.idHex) await view.del(`${COLLECTIONS.INVITE}/${op.idHex}`)
        break
      case 'set-setting': {
        const setting = {
          key: op.key,
          value: op.value,
          updatedAt: op.updatedAt || Date.now(),
        }
        if (typeof op.revision === 'string' && /^[0-9a-f]{32}$/.test(op.revision)) {
          setting.revision = op.revision
        }
        await view.put(`${COLLECTIONS.SETTING}/${op.key}`, setting)
        break
      }
      case 'delete-setting':
        await view.del(`${COLLECTIONS.SETTING}/${op.key}`)
        break
      case 'delete-setting-if-version-and-digest': {
        const entry = await view.get(`${COLLECTIONS.SETTING}/${op.key}`)
        const digest = entry?.value ? personalSettingDigest(entry.value.value) : null
        const revision = entry?.value ? personalSettingRevision(entry, digest) : null
        if (digest === op.expectedDigest && revision === op.expectedRevision) {
          await view.del(`${COLLECTIONS.SETTING}/${op.key}`)
        }
        break
      }
      default:
        break
    }
  }

  // --- apply helpers (deterministic, view-only) -----------------------------

  static async _readCount(view, key) {
    return toUint((await view.get(key))?.value?.count)
  }

  static async _writeCount(view, key, count) {
    await view.put(key, { count: Math.max(count, 0) })
  }

  static async _observeLamport(view, lamport) {
    const seen = toUint(lamport)
    if (!seen) return
    const current = toUint((await view.get(META_LAMPORT))?.value?.lamport)
    if (seen > current) await view.put(META_LAMPORT, { lamport: seen })
  }

  static async _putHistoryEvent(view, key, entry, limits) {
    const existed = Boolean(await view.get(key))
    await view.put(key, entry)
    if (existed) return
    const count = (await PersonalStore._readCount(view, META_HISTORY_COUNT)) + 1
    await PersonalStore._writeCount(view, META_HISTORY_COUNT, count)
    if (count <= limits.history) return
    // History keys sort newest-first, so the reverse tail is the oldest.
    const prefix = `${COLLECTIONS.HISTORY}/`
    const doomed = []
    for await (const row of view.createReadStream({
      gte: prefix,
      lt: prefix + '\xff',
      reverse: true,
      limit: count - limits.history
    })) {
      doomed.push(row.key)
    }
    for (const doomedKey of doomed) await view.del(doomedKey)
    await PersonalStore._writeCount(view, META_HISTORY_COUNT, count - doomed.length)
  }

  static async _mergeProgress(view, incoming, limits) {
    const record = normalizeProgressRecord(incoming)
    if (!record.stateKey) return
    await PersonalStore._observeLamport(view, record.order.lamport)
    const key = `${COLLECTIONS.PROGRESS}/${record.stateKey}`
    const existing = (await view.get(key))?.value || null
    const winner = mergePersonalProgress(existing, record)
    if (!winner) return
    await view.put(key, winner)
    if (existing) return
    const count = (await PersonalStore._readCount(view, META_PROGRESS_COUNT)) + 1
    await PersonalStore._writeCount(view, META_PROGRESS_COUNT, count)
    if (count <= limits.progress) return
    // Tombstones are dead weight, so they go before any live record; within a
    // rank the oldest updatedAt loses, with the state key as a deterministic
    // tiebreak so every device prunes exactly the same rows. The record that
    // triggered this pass is never a candidate — evicting the write we just
    // accepted would drop the user's newest state.
    const prefix = `${COLLECTIONS.PROGRESS}/`
    const rows = []
    for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      if (entry.key === key) continue
      rows.push({
        key: entry.key,
        live: entry.value?.order?.tombstone ? 0 : 1,
        updatedAt: toUint(entry.value?.updatedAt)
      })
    }
    rows.sort((a, b) =>
      (a.live - b.live) ||
      (a.updatedAt - b.updatedAt) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const doomed = rows.slice(0, Math.max(count - limits.progress, 0))
    for (const row of doomed) await view.del(row.key)
    await PersonalStore._writeCount(view, META_PROGRESS_COUNT, count - doomed.length)
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

  get retentionLimits() {
    return this._limits
  }

  async update() {
    await this.base?.update()
  }

  /**
   * Refuse writes for the duration of an epoch rotation. Reads are unaffected,
   * so {@link exportState} still works while frozen.
   *
   * @param {string} [reason] - surfaced as the rejection message
   */
  freeze(reason = 'personal-store-rotating') {
    this._frozenReason = toText(reason) || 'personal-store-rotating'
  }

  unfreeze() {
    this._frozenReason = null
  }

  get frozen() {
    return this._frozenReason !== null
  }

  _assertNotFrozen() {
    if (this._frozenReason === null) return
    const err = new Error(this._frozenReason)
    err.code = 'PERSONAL_STORE_FROZEN'
    throw err
  }

  async _append(op) {
    this._assertNotFrozen()
    if (!this.writable) throw new Error('Personal store is not writable on this device')
    await this.base.append(op)
    await this.base.update()
  }

  async _appendMany(ops) {
    this._assertNotFrozen()
    if (!ops.length) return
    if (!this.writable) throw new Error('Personal store is not writable on this device')
    await this.base.append(ops)
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

  // --- watch history / viewer progress --------------------------------------

  /**
   * Log a watch event. Writes the append-only history event *and* the canonical
   * progress record, so position/completion/library state stay in one place.
   *
   * @param {Object} event
   * @param {Object} [event.identity] - {entityRef, editionRef, memberRef}
   * @param {boolean} [event.saved] - library flag (inherited when omitted)
   * @param {number} [event.playbackGeneration] - explicit generation
   * @param {boolean} [event.replay] - bump to the next generation
   * @param {boolean} [event.tombstone] - logical delete
   * @returns {Promise<string>} eventId
   */
  async logHistory(event = {}) {
    const eventId = event.eventId || randomId()
    const timestamp = toUint(event.timestamp) || Date.now()
    const record = await this._buildProgressWrite({ ...event, updatedAt: timestamp })
    await this._append({
      type: 'log-history',
      event: {
        eventId,
        channelKey: toText(event.channelKey),
        videoId: toText(event.videoId),
        videoKey: toText(event.videoKey) || record?.videoKey || '',
        title: toText(event.title) || record?.title || '',
        duration: toUint(event.duration ?? event.durationSec),
        position: toUint(event.position ?? event.positionSec),
        completed: Boolean(event.completed),
        timestamp
      },
      record
    })
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

  /**
   * Write the canonical progress record for one title.
   *
   * The ordering triple is stamped locally; pass a complete `order`
   * ({playbackGeneration, lamport, writerKey}) only to replay a foreign record
   * verbatim (state import / merge tests).
   *
   * @returns {Promise<string>} the canonical state key
   */
  async putProgress(record = {}) {
    const built = await this._buildProgressWrite(record)
    if (!built) throw new Error('Progress record requires identity refs or a videoKey')
    await this._append({ type: 'put-progress', record: built })
    return built.stateKey
  }

  /** Progress records, tombstoned ones excluded. */
  async listProgress({ includeTombstoned = false, savedOnly = false } = {}) {
    await this.update()
    const out = []
    for (const record of await this._collect(COLLECTIONS.PROGRESS)) {
      if (!includeTombstoned && record?.order?.tombstone) continue
      if (savedOnly && !record?.saved) continue
      out.push(record)
    }
    return out
  }

  async getProgress(stateKey) {
    const record = await this._readProgressRecord(stateKey)
    if (!record || record.order?.tombstone) return null
    return record
  }

  /**
   * Set (or clear) the library flag. Works for a title that has never been
   * played: the record is created from the state key.
   */
  async setSaved(stateKey, saved, extra = {}) {
    const key = toText(stateKey)
    if (!key) throw new Error('Progress state key required')
    const existing = await this._readProgressRecord(key)
    return this.putProgress({
      ...extra,
      stateKey: key,
      identity: extra.identity || existing?.identity,
      saved: Boolean(saved),
      tombstone: false
    })
  }

  /**
   * Logically delete a progress record. The record is retained (tombstoned) so
   * a slower device cannot resurrect it, and is hidden from every read.
   */
  async deleteProgress(stateKey) {
    const key = toText(stateKey)
    if (!key) throw new Error('Progress state key required')
    const existing = await this._readProgressRecord(key)
    if (!existing) return false
    await this.putProgress({ stateKey: key, saved: false, tombstone: true })
    return true
  }

  /**
   * Resume state for a video key or canonical state key, shaped for the
   * `resume-entry` wire type. Falls back to a not-yet-migrated legacy row.
   */
  async getResume(videoKey) {
    const key = toText(videoKey)
    if (!key) return null
    const record = await this.getProgress(key)
    if (record) return progressToResumeEntry(record)
    const legacy = (await this.view.get(`${COLLECTIONS.RESUME}/${key}`))?.value
    return legacy ? legacyResumeToEntry(legacy) : null
  }

  async listResume() {
    const entries = []
    const seen = new Set()
    for (const record of await this.listProgress()) {
      entries.push(progressToResumeEntry(record))
      seen.add(record.stateKey)
    }
    for (const legacy of await this._collect(COLLECTIONS.RESUME)) {
      const stateKey = toText(legacy?.stateKey) || toText(legacy?.videoKey)
      if (!stateKey || seen.has(stateKey)) continue
      entries.push(legacyResumeToEntry(legacy))
    }
    return entries
  }

  /**
   * Convert legacy `resume/<videoKey>` rows into canonical progress records.
   * The legacy row is only dropped once the progress record reads back, so an
   * interrupted migration never loses watch state.
   *
   * @returns {Promise<{migrated: number, retained: number}>}
   */
  async migrateLegacyResume() {
    await this.update()
    const rows = await this._collect(COLLECTIONS.RESUME)
    let migrated = 0
    for (const row of rows) {
      const videoKey = toText(row?.videoKey)
      const stateKey = toText(row?.stateKey) || videoKey
      if (!stateKey || !videoKey) continue
      if (!(await this._readProgressRecord(stateKey))) {
        await this.putProgress({
          stateKey,
          videoKey,
          channelKey: row.channelKey,
          videoId: row.videoId,
          title: row.title,
          positionSec: row.position,
          durationSec: row.duration,
          completed: row.completed,
          saved: false,
          updatedAt: row.updatedAt
        })
      }
      // Durability gate: only drop the source once the replacement reads back.
      if (!(await this._readProgressRecord(stateKey))) continue
      await this._append({ type: 'delete-resume', videoKey })
      migrated++
    }
    return { migrated, retained: (await this._collect(COLLECTIONS.RESUME)).length }
  }

  async _readProgressRecord(stateKey) {
    const key = toText(stateKey)
    if (!key || !this.view) return null
    await this.update()
    return (await this.view.get(`${COLLECTIONS.PROGRESS}/${key}`))?.value || null
  }

  /**
   * Raise the in-memory Lamport clock to whatever the view has observed. The
   * clock is seeded once in `_open` and advanced from remote ops by
   * {@link PersonalStore._observeLamport}; this pulls that value back in.
   */
  async _syncLamport() {
    try {
      const seen = toUint((await this.view?.get(META_LAMPORT))?.value?.lamport)
      if (seen > this._lamport) this._lamport = seen
    } catch { /* unreadable view */ }
  }

  /**
   * Mint the next Lamport stamp. Synchronous by contract: splitting the
   * read-modify-write across an await hands two overlapping writes the same
   * stamp, and two ops carrying the same triple collide on arrival.
   */
  _nextLamport() {
    return ++this._lamport
  }

  /**
   * Normalize a progress write against the stored record: inherit metadata,
   * resolve the playback generation and stamp the ordering triple.
   */
  async _buildProgressWrite(input = {}) {
    const identity = normalizeProgressIdentity(input.identity)
    const stateKey = toText(input.stateKey) || personalProgressStateKey({ identity, videoKey: input.videoKey })
    if (!stateKey) return null
    const existing = await this._readProgressRecord(stateKey)
    await this._syncLamport()
    const parsed = parsePersonalProgressStateKey(stateKey)
    const currentGeneration = toUint(existing?.order?.playbackGeneration)

    let order
    if (isCompleteProgressOrder(input.order)) {
      order = normalizeProgressOrder(input.order)
    } else {
      let generation = currentGeneration
      if (input.playbackGeneration !== undefined && input.playbackGeneration !== null) {
        generation = toUint(input.playbackGeneration)
      } else if (input.replay) {
        generation = currentGeneration + 1
      }
      // A delete is sticky. Only an explicit `tombstone: false` or a strictly
      // higher playback generation (the title really was played again) brings a
      // deleted record back; an ordinary position ping must not resurrect it
      // with its old title and position.
      const tombstone = input.tombstone === undefined || input.tombstone === null
        ? Boolean(existing?.order?.tombstone) && generation <= currentGeneration
        : Boolean(input.tombstone)
      // Nothing may await between the sync above and this stamp.
      order = {
        playbackGeneration: generation,
        lamport: this._nextLamport(),
        writerKey: this.localKeyHex || '',
        tombstone
      }
    }

    // A replay starts a fresh generation, so position and completion reset
    // unless the caller states otherwise. Title/library metadata always carries.
    const baseline = order.playbackGeneration > currentGeneration ? null : existing

    return normalizeProgressRecord({
      stateKey,
      identity: identity || existing?.identity || parsed.identity,
      channelKey: inheritText(input.channelKey, existing?.channelKey),
      videoId: inheritText(input.videoId, existing?.videoId),
      videoKey: inheritText(input.videoKey, existing?.videoKey, parsed.videoKey),
      title: inheritText(input.title, existing?.title),
      positionSec: inheritUint(input.positionSec ?? input.position, baseline?.positionSec),
      durationSec: inheritUint(input.durationSec ?? input.duration, existing?.durationSec),
      completed: input.completed === undefined || input.completed === null
        ? Boolean(baseline?.completed)
        : Boolean(input.completed),
      saved: input.saved === undefined || input.saved === null
        ? Boolean(existing?.saved)
        : Boolean(input.saved),
      updatedAt: toUint(input.updatedAt) || Date.now(),
      order
    })
  }

  // --- settings -------------------------------------------------------------

  async setSetting(key, value) {
    await this._append({
      type: 'set-setting',
      key,
      value,
      updatedAt: Date.now(),
      revision: randomId(),
    })
  }

  async deleteSetting(key) {
    await this._append({ type: 'delete-setting', key })
  }

  async deleteSettingIfVersionAndDigest(key, expectedRevision, expectedDigest) {
    if (
      typeof expectedRevision !== 'string' ||
      expectedRevision.length < 1 ||
      expectedRevision.length > 128
    ) {
      throw new Error('expected setting revision is invalid')
    }
    if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
      throw new Error('expected setting digest is invalid')
    }
    await this._append({
      type: 'delete-setting-if-version-and-digest',
      key,
      expectedRevision,
      expectedDigest,
    })
  }

  async getSetting(key) {
    return (await this.getSettingRecord(key))?.value
  }

  async getSettingRecord(key) {
    await this.update()
    const entry = await this.view.get(`${COLLECTIONS.SETTING}/${key}`)
    if (!entry?.value) return null
    const digest = personalSettingDigest(entry.value.value)
    return {
      value: entry.value.value,
      updatedAt: Number(entry.value.updatedAt || 0),
      revision: personalSettingRevision(entry, digest),
      digest,
    }
  }

  async getSettings() {
    await this.update()
    const rows = await this._collect(COLLECTIONS.SETTING)
    const out = {}
    for (const row of rows) {
      if (toText(row.key).startsWith(LEGACY_INVITE_SETTING_PREFIX)) continue
      out[row.key] = row.value
    }
    return out
  }

  // --- pairing (BlindPairing over swarm) ------------------------------------

  /**
   * Mint a single-use invite another of the user's devices can redeem to join
   * this personal store as a writer. A fresh invite is created on every call —
   * a stored invite is never handed out twice — and expiry is clamped to
   * {@link PERSONAL_INVITE_MAX_TTL_MS}.
   *
   * @returns {Promise<{inviteCode: string, expiresAt: number, idHex: string}>}
   */
  async createInvite({ expiresInMs = 0, expires = 0 } = {}) {
    if (this.swarm) this.setupPairing(this.swarm).catch(() => {})
    await this.update()
    const now = Date.now()
    const requested = toUint(expiresInMs) || Math.max(toUint(expires) - now, 0)
    const ttl = requested > 0 ? Math.min(requested, PERSONAL_INVITE_MAX_TTL_MS) : PERSONAL_INVITE_MAX_TTL_MS
    const expiresAt = now + ttl

    const inv = BlindPairing.createInvite(this.key, { expires: expiresAt })
    const invite = {
      idHex: b4a.toString(inv.id, 'hex'),
      inviteZ32: z32.encode(inv.invite),
      publicKeyHex: b4a.toString(inv.publicKey, 'hex'),
      createdAt: now,
      expiresAt
    }

    const ops = [{ type: 'put-invite', invite }]
    for (const op of await this._staleInviteOps(now, { incoming: 1 })) ops.push(op)
    await this._appendMany(ops)
    return { inviteCode: invite.inviteZ32, expiresAt, idHex: invite.idHex }
  }

  /**
   * Drop consumed/expired invites and cap the outstanding set. Cheap enough to
   * run whenever pairing is touched, so a device that mints an invite and never
   * mints another still sheds it once it expires.
   *
   * @returns {Promise<number>} number of cleanup ops appended
   */
  async _sweepStaleInvites() {
    if (!this.writable || this.frozen) return 0
    await this.update()
    const ops = await this._staleInviteOps(Date.now())
    if (!ops.length) return 0
    await this._appendMany(ops)
    return ops.length
  }

  /** Bounded invite state: drop consumed/expired rows and cap the outstanding set. */
  async _staleInviteOps(now, { incoming = 0 } = {}) {
    const ops = []
    const invites = await this._collect(COLLECTIONS.INVITE)
    const live = []
    for (const invite of invites) {
      if (toUint(invite.consumedAt) > 0 || (toUint(invite.expiresAt) > 0 && now > toUint(invite.expiresAt))) {
        ops.push({ type: 'delete-invite', idHex: invite.idHex })
        continue
      }
      live.push(invite)
    }
    live.sort((a, b) => toUint(a.createdAt) - toUint(b.createdAt))
    const overflow = live.length + incoming - PERSONAL_OUTSTANDING_INVITE_LIMIT
    for (let i = 0; i < overflow; i++) ops.push({ type: 'delete-invite', idHex: live[i].idHex })
    // Sweep invites left in the settings collection by older versions.
    const prefix = `${COLLECTIONS.SETTING}/${LEGACY_INVITE_SETTING_PREFIX}`
    for await (const entry of this.view.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
      ops.push({ type: 'delete-setting', key: entry.value?.key || entry.key.slice(`${COLLECTIONS.SETTING}/`.length) })
    }
    return ops
  }

  async listInvites() {
    await this.update()
    return this._collect(COLLECTIONS.INVITE)
  }

  /**
   * Claim an invite. The consume op is ordered against every other writer's
   * ops, so exactly one redemption wins; a replay or an expired invite loses.
   *
   * @returns the consumed invite record, or null when the claim failed.
   */
  async _consumeInvite(idHex) {
    const id = toText(idHex)
    if (!id) return null
    const stored = (await this.view.get(`${COLLECTIONS.INVITE}/${id}`))?.value
    if (!stored) return null
    if (toUint(stored.consumedAt) > 0) return null
    const at = Date.now()
    if (toUint(stored.expiresAt) > 0 && at > toUint(stored.expiresAt)) return null
    const consumeId = randomId()
    await this._append({ type: 'consume-invite', idHex: id, at, consumeId, writerKey: this.localKeyHex || '' })
    const invite = (await this.view.get(`${COLLECTIONS.INVITE}/${id}`))?.value
    if (!invite || invite.consumeId !== consumeId) return null
    return invite
  }

  /** Serialize pairing work so concurrent requests cannot both claim an invite. */
  _serializePairing(fn) {
    const run = this._pairingQueue.then(fn, fn)
    this._pairingQueue = run.then(() => {}, () => {})
    return run
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
    // Replicate the Autobase (every writer core plus the wakeup protocol) over
    // each swarm connection. This must also run on a device that is not yet a
    // writer: a freshly paired device has to sync before it becomes writable.
    this._replicateConnection = (connection) => {
      if (!connection || connection.destroyed || !this.base) return
      if (this._replicatedConnections.has(connection)) return
      this._replicatedConnections.add(connection)
      try {
        this.base.replicate(Protomux.from(connection))
      } catch { /* best effort */ }
    }
    swarm.on('connection', this._replicateConnection)
    for (const connection of swarm.connections || []) this._replicateConnection(connection)

    if (!this.writable) return Promise.resolve()

    this.pairing = new BlindPairing(swarm)
    this.pairingMember = this.pairing.addMember({
      discoveryKey: this.discoveryKey,
      onadd: (req) => this._serializePairing(async () => {
        try {
          await this.update()
          const candidateIdHex = b4a.toString(req.inviteId, 'hex')
          const stored = (await this.view.get(`${COLLECTIONS.INVITE}/${candidateIdHex}`))?.value
          if (!stored) return
          if (toUint(stored.expiresAt) > 0 && Date.now() > toUint(stored.expiresAt)) return
          // Consume before granting write access: a replayed or concurrent
          // redemption of the same invite finds it already spent.
          const invite = await this._consumeInvite(candidateIdHex)
          if (!invite) return
          const payload = decodePairingUserData(req.open(fromHex(invite.publicKeyHex)))
          if (!payload) return
          await this.addWriter(payload.keyHex, { deviceName: payload.deviceName })
          // Hand the joining device the keychain secret (in the encryptionKey
          // slot of the confirm payload) so it can decrypt the synced cores and
          // persist the secret into its own native keychain.
          req.confirm({ key: this.key, encryptionKey: this._secret || undefined })
          await this._append({ type: 'delete-invite', idHex: invite.idHex })
          // A redemption is the other moment invite state goes stale, so sweep
          // here too rather than waiting for the next mint.
          await this._sweepStaleInvites()
        } catch (err) {
          // This handler runs in scope of the keychain secret and the invite
          // key material; log the message only, never the error object.
          console.error('[PersonalStore] Pairing error:', err?.message || 'unknown error')
        }
      })
    })
    // Invites are short-lived, so whatever this device minted before it went
    // offline is almost certainly stale by the time pairing comes back up.
    return this._sweepStaleInvites().then(() => {}, () => {})
  }

  // --- epoch rotation (forward-only device revocation) ----------------------

  /**
   * Snapshot the bounded state a new encrypted epoch should carry. Never
   * includes the keychain secret or any pairing invite.
   */
  async exportState() {
    await this.update()
    const settings = []
    for (const row of await this._collect(COLLECTIONS.SETTING)) {
      if (toText(row.key).startsWith(LEGACY_INVITE_SETTING_PREFIX)) continue
      settings.push({ key: row.key, value: row.value, updatedAt: toUint(row.updatedAt), revision: row.revision })
    }
    return {
      version: PERSONAL_STATE_EXPORT_VERSION,
      exportedAt: Date.now(),
      subscriptions: await this._collect(COLLECTIONS.SUBSCRIPTION),
      playlists: await this._collect(COLLECTIONS.PLAYLIST),
      playlistItems: await this._collect(COLLECTIONS.PLAYLIST_ITEM),
      progress: await this.listProgress(),
      history: await this.listHistory({ limit: this._limits.history }),
      settings,
      devices: (await this._collect(COLLECTIONS.WRITER)).map((row) => ({
        keyHex: toText(row.keyHex),
        deviceName: toText(row.deviceName),
        addedAt: toUint(row.addedAt)
      }))
    }
  }

  /**
   * Replay an {@link exportState} snapshot into this (fresh) store.
   *
   * Devices are deliberately not restored: revocation is forward-only, so every
   * retained device must re-pair into the new epoch. Their keys are reported as
   * `droppedDevices` rather than silently granted write access.
   */
  async importState(state = {}) {
    const summary = {
      subscriptions: 0,
      playlists: 0,
      playlistItems: 0,
      progress: 0,
      history: 0,
      settings: 0,
      droppedDevices: (state.devices || []).map((device) => toText(device?.keyHex)).filter(Boolean)
    }
    const ops = []
    for (const sub of state.subscriptions || []) {
      if (!sub?.channelKey) continue
      ops.push({ type: 'subscribe', channelKey: sub.channelKey, name: sub.name || '', subscribedAt: toUint(sub.subscribedAt) || Date.now() })
      summary.subscriptions++
    }
    for (const playlist of state.playlists || []) {
      if (!playlist?.id) continue
      ops.push({
        type: 'put-playlist',
        id: playlist.id,
        name: playlist.name || '',
        description: playlist.description || '',
        createdAt: toUint(playlist.createdAt) || Date.now(),
        updatedAt: toUint(playlist.updatedAt) || Date.now()
      })
      summary.playlists++
    }
    for (const item of state.playlistItems || []) {
      if (!item?.playlistId || !item?.videoKey) continue
      ops.push({
        type: 'add-playlist-item',
        playlistId: item.playlistId,
        videoKey: item.videoKey,
        channelKey: item.channelKey || '',
        videoId: item.videoId || '',
        addedAt: toUint(item.addedAt) || Date.now()
      })
      summary.playlistItems++
    }
    for (const record of state.progress || []) {
      const normalized = normalizeProgressRecord(record)
      if (!normalized.stateKey || normalized.order.tombstone) continue
      ops.push({ type: 'put-progress', record: normalized })
      summary.progress++
    }
    for (const event of state.history || []) {
      if (!event) continue
      ops.push({
        type: 'log-history',
        event: { ...event, eventId: event.eventId || randomId(), timestamp: toUint(event.timestamp) || Date.now() },
        record: null
      })
      summary.history++
    }
    for (const setting of state.settings || []) {
      if (!setting?.key) continue
      ops.push({
        type: 'set-setting',
        key: setting.key,
        value: setting.value,
        updatedAt: toUint(setting.updatedAt) || Date.now(),
        revision: typeof setting.revision === 'string' && /^[0-9a-f]{32}$/.test(setting.revision) ? setting.revision : randomId()
      })
      summary.settings++
    }
    await this._appendMany(ops)
    return summary
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
    // Read the topic before the base goes away: `discoveryKey` is derived from it.
    const topic = this.discoveryKey
    if (this._replicateConnection && this.swarm) {
      this.swarm.off?.('connection', this._replicateConnection)
      this.swarm.removeListener?.('connection', this._replicateConnection)
      this._replicateConnection = null
    }
    if (this.pairingMember) { await closeSafe(this.pairingMember); this.pairingMember = null }
    if (this.pairing) { await closeSafe(this.pairing); this.pairing = null }
    // Hyperswarm's PeerDiscovery has no `close()`, so the old `closeSafe` call
    // was a silent no-op and an abandoned epoch kept announcing itself.
    // `destroy()` is the real teardown and `leave()` drops the topic from the
    // swarm's own session table.
    if (this._discovery) {
      const discovery = this._discovery
      this._discovery = null
      try { await discovery.destroy?.() } catch { /* best effort */ }
    }
    if (topic && this.swarm?.leave) {
      try { await this.swarm.leave(topic) } catch { /* best effort */ }
    }
    if (this.base) { await closeSafe(this.base); this.base = null }
  }
}
