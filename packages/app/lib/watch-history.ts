/**
 * Device-local watch state — position, completion, and saved-library flag.
 *
 * This used to be a second database: a plaintext JSON file on native and a
 * localStorage blob on web, sitting next to the encrypted personal store and
 * holding precisely the data that most deserved the encryption. It is now a
 * thin adapter over that store. Writes go through `logWatchHistory`, reads come
 * from `listResumePositions` and `getWatchHistory`, and an in-memory cache
 * answers the UI without waiting on a round trip.
 *
 * Nothing here reports anything. There is no analytics call, and progress
 * leaves the device only as encrypted personal-store replication to the
 * viewer's own explicitly paired devices.
 *
 * Ordering is deterministic rather than wall-clock: a replay of a finished
 * title starts a strictly higher `playbackGeneration`, and inside one
 * generation completion is monotonic, so a rewind can never un-finish a title
 * and two devices resolve the same way in either order. A delete outranks the
 * record it removes the same way, and bars further writes to those coordinates
 * until a new watch of them begins: the player the viewer deleted out from
 * under goes on playing, but it does not put the record back.
 */
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import type * as PlatformRpc from '@peartube/platform/rpc'

type PlatformRpcModule = typeof PlatformRpc

/**
 * The platform RPC client is loaded on first use, never at module scope. It
 * drags the whole HRPC runtime behind it, and this module is imported by the
 * player, which server-renders in route tests and in the desktop web export.
 */
let platformRpcModule: PlatformRpcModule | null = null
let platformRpcLoad: Promise<PlatformRpcModule | null> | null = null

async function platformRpc(): Promise<PlatformRpcModule | null> {
  if (platformRpcModule) return platformRpcModule
  if (platformRpcLoad) return platformRpcLoad
  const loading = import('@peartube/platform/rpc')
    .then((loaded) => {
      platformRpcModule = loaded
      return loaded
    })
    .catch(() => {
      // One transient module-load failure must not disable every write for the
      // life of the process. Drop the latch so the next call retries the
      // import: otherwise the cache goes on rendering progress that is never
      // written anywhere.
      platformRpcLoad = null
      return null
    })
  platformRpcLoad = loading
  return loading
}

/**
 * A stored progress record as either wire shape presents it: the history event
 * carries `timestamp` and a title, the resume row carries `updatedAt` and the
 * authoritative position. Fields are `unknown` because they arrive from the
 * backend and are validated one at a time on the way in.
 */
type StoredProgressRecord = {
  channelKey?: unknown
  videoId?: unknown
  videoKey?: unknown
  stateKey?: unknown
  title?: unknown
  position?: unknown
  positionSec?: unknown
  duration?: unknown
  durationSec?: unknown
  completed?: unknown
  saved?: unknown
  updatedAt?: unknown
  timestamp?: unknown
  identity?: { entityRef?: unknown; editionRef?: unknown; memberRef?: unknown } | null
  order?: { playbackGeneration?: unknown; tombstone?: unknown } | null
  playbackGeneration?: unknown
}

/** Media identity for one piece of progress. A series episode needs the member ref. */
export interface WatchIdentity {
  entityRef?: string | null
  editionRef?: string | null
  memberRef?: string | null
}

export interface WatchHistoryEntry {
  videoId: string
  channelKey: string
  publicBeeKey?: string | null
  title: string
  channelName?: string
  /**
   * Session-only. The personal-store record carries no artwork field, so this
   * survives until the app restarts and is then re-resolved from the catalog
   * rather than duplicated into the viewer's private state.
   */
  thumbnailUrl?: string | null
  positionSec: number
  durationSec: number
  /** epoch ms of the last progress update */
  updatedAt: number
  completed?: boolean
  /** Library state: the viewer put this on their own shelf. */
  saved?: boolean
  identity?: WatchIdentity | null
  playbackGeneration?: number
}

export type WatchProgressInput = {
  videoId?: string
  channelKey?: string
  publicBeeKey?: string | null
  title?: string
  channelName?: string
  thumbnailUrl?: string | null
  positionSec: number
  durationSec: number
  identity?: WatchIdentity | null
  saved?: boolean
}

/** One row shaped for `home-rails` / `local-recommendations`. */
export type LocalWatchStateRow = {
  entityId: string | null
  identity: WatchIdentity | null
  channelKey: string
  videoId: string
  title: string
  positionSeconds: number
  durationSeconds: number
  completed: boolean
  saved: boolean
  updatedAt: number
}

const LEGACY_HISTORY_FILE = 'peartube-watch-history.json'
const LEGACY_WEB_STORAGE_KEY = 'peartube-watch-history'

/** Bounded retention: the cache mirrors a bounded slice of the store. */
const MAX_ENTRIES = 50

/** Watched ≥95% counts as completed; below 2% isn't worth resuming. */
const COMPLETED_RATIO = 0.95
const MIN_RESUME_RATIO = 0.02

const cache = new Map<string, WatchHistoryEntry>()
/** Writes the store has not accepted yet, keyed like the cache. */
const pending = new Map<string, { entry: WatchHistoryEntry; tombstone: boolean }>()
/**
 * Keys the viewer deleted, and the generation each delete was written at.
 *
 * `blocked` is the delete barrier. Deleting a record does not stop the player
 * that is still mounted on it, and that player's next progress tick would
 * otherwise put back exactly what the viewer just removed. Only a deliberate
 * new watch lifts the barrier, through `beginWatchSession`. The generation
 * outlives the barrier: whatever writes here next starts strictly above the
 * delete, so it wins on every device instead of racing the tombstone by
 * timestamp.
 */
const tombstones = new Map<string, { generation: number; blocked: boolean }>()
let writeQueue: Promise<void> = Promise.resolve()
let hydrated = false
let hydrating: Promise<void> | null = null

/** Surfaces that render watch state, so Home reflects a write without a remount. */
const listeners = new Set<() => void>()

function notifyChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener that throws must not stop the others or the write.
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function finite(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function uint(value: unknown): number {
  return Math.max(0, Math.round(finite(value)))
}

/**
 * The canonical progress key. Media identity wins when the caller knows it;
 * the legacy channel/video pair remains only so existing device state and the
 * publisher-channel surfaces keep working.
 */
function stateKeyOf(row: { identity?: WatchIdentity | null; channelKey?: string | null; videoId?: string | null }): string | null {
  const entityRef = text(row.identity?.entityRef)
  if (entityRef) return `${entityRef}|${text(row.identity?.editionRef) ?? ''}|${text(row.identity?.memberRef) ?? ''}`
  const channelKey = text(row.channelKey)
  const videoId = text(row.videoId)
  return channelKey && videoId ? `${channelKey}:${videoId}` : null
}

function legacyVideoKey(row: { channelKey?: string | null; videoId?: string | null }): string | null {
  const channelKey = text(row.channelKey)
  const videoId = text(row.videoId)
  return channelKey && videoId ? `${channelKey}:${videoId}` : null
}

function isResumableEntry(entry: WatchHistoryEntry): boolean {
  if (entry.completed) return false
  if (!(entry.durationSec > 0)) return false
  const ratio = entry.positionSec / entry.durationSec
  return ratio >= MIN_RESUME_RATIO && ratio < COMPLETED_RATIO
}

/**
 * Resolve the platform module, loading it on first call. The store is only
 * reachable once the backend has come up: before that a write stays pending
 * and a read reports nothing rather than reporting empty.
 *
 * This hands back the module, never the `rpc` client itself: the client is a
 * proxy that answers every property with a call, so awaiting it would invoke
 * `then` as a backend method and hang.
 */
async function readyPlatform(): Promise<PlatformRpcModule | null> {
  const platform = await platformRpc()
  if (!platform) return null
  try {
    if (!platform.isInitialized()) return null
  } catch {
    return null
  }
  return platform
}

function identityOf(record: StoredProgressRecord | null | undefined): WatchIdentity | null {
  const entityRef = text(record?.identity?.entityRef)
  if (!entityRef) return null
  return {
    entityRef,
    editionRef: text(record?.identity?.editionRef),
    memberRef: text(record?.identity?.memberRef),
  }
}

/**
 * One stored record — history event or resume row — as a cache entry. The two
 * wire shapes differ (`timestamp` versus `updatedAt`, and only history carries
 * a title), so both are read leniently and merged by order rather than by
 * whichever arrived last.
 */
function fromRecord(record: StoredProgressRecord): { key: string; entry: WatchHistoryEntry; tombstone: boolean } | null {
  const identity = identityOf(record)
  const channelKey = text(record?.channelKey) ?? ''
  const videoId = text(record?.videoId) ?? ''
  const key = stateKeyOf({ identity, channelKey, videoId }) ?? text(record?.videoKey)
  if (!key) return null
  return {
    key,
    tombstone: record?.order?.tombstone === true,
    entry: {
      videoId,
      channelKey,
      publicBeeKey: null,
      title: text(record?.title) ?? '',
      thumbnailUrl: null,
      positionSec: finite(record?.position ?? record?.positionSec),
      durationSec: finite(record?.duration ?? record?.durationSec),
      updatedAt: finite(record?.updatedAt ?? record?.timestamp),
      completed: record?.completed === true,
      saved: record?.saved === true,
      identity,
      playbackGeneration: uint(record?.order?.playbackGeneration ?? record?.playbackGeneration),
    },
  }
}

/**
 * Deterministic merge, never wall-clock first: a higher playback generation
 * wins outright, and only inside one generation does the update time decide.
 * A stale read must not overwrite what this device just wrote.
 */
function isNewer(candidate: WatchHistoryEntry, existing: WatchHistoryEntry): boolean {
  const candidateGeneration = candidate.playbackGeneration ?? 0
  const existingGeneration = existing.playbackGeneration ?? 0
  if (candidateGeneration !== existingGeneration) return candidateGeneration > existingGeneration
  return candidate.updatedAt > existing.updatedAt
}

/**
 * Remember a delete. `blocked` says whether it also has to stop a player that
 * may still be running on these coordinates — true for a delete the viewer
 * just made, false for one being read back out of the store, which is history
 * rather than an instruction to the session in progress.
 *
 * Bounded like everything else here: the map is insertion-ordered, so the
 * oldest delete is the first forgotten.
 */
function rememberTombstone(key: string, generation: number, blocked: boolean): void {
  const existing = tombstones.get(key)
  tombstones.delete(key)
  tombstones.set(key, {
    generation: Math.max(generation, existing?.generation ?? 0),
    blocked: blocked || existing?.blocked === true,
  })
  for (const oldest of tombstones.keys()) {
    if (tombstones.size <= MAX_ENTRIES) break
    tombstones.delete(oldest)
  }
}

function admit(key: string, entry: WatchHistoryEntry, tombstone: boolean): void {
  if (tombstone) {
    const existing = cache.get(key)
    if (existing && !isNewer(entry, existing)) return
    cache.delete(key)
    rememberTombstone(key, entry.playbackGeneration ?? 0, false)
    return
  }
  const existing = cache.get(key)
  if (!existing) {
    cache.set(key, entry)
    return
  }
  if (!isNewer(entry, existing)) {
    // The stored copy is behind, but it can still supply detail this device no
    // longer holds in memory.
    if (!existing.title && entry.title) existing.title = entry.title
    return
  }
  cache.set(key, {
    ...entry,
    // Presentation detail the wire shape cannot carry stays with the session.
    title: entry.title || existing.title,
    channelName: entry.channelName ?? existing.channelName,
    thumbnailUrl: entry.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    publicBeeKey: entry.publicBeeKey ?? existing.publicBeeKey ?? null,
    channelKey: entry.channelKey || existing.channelKey,
    videoId: entry.videoId || existing.videoId,
  })
}

function prune(): void {
  if (cache.size <= MAX_ENTRIES) return
  const ordered = [...cache.entries()].sort((left, right) => right[1].updatedAt - left[1].updatedAt || left[0].localeCompare(right[0]))
  for (const [key] of ordered.slice(MAX_ENTRIES)) cache.delete(key)
}

/** The write-path request, exactly as `log-watch-history-request` defines it. */
type LogWatchHistoryRequest = {
  channelKey?: string
  videoId?: string
  videoKey?: string
  title?: string
  duration?: number
  position?: number
  completed?: boolean
  timestamp?: number
  identity?: { entityRef?: string; editionRef?: string; memberRef?: string }
  saved?: boolean
  playbackGeneration?: number
  tombstone?: boolean
}

function requestFor(entry: WatchHistoryEntry, tombstone: boolean): LogWatchHistoryRequest {
  const identity = entry.identity?.entityRef
    ? {
      entityRef: entry.identity.entityRef,
      editionRef: entry.identity.editionRef ?? undefined,
      memberRef: entry.identity.memberRef ?? undefined,
    }
    : undefined
  return {
    channelKey: entry.channelKey || undefined,
    videoId: entry.videoId || undefined,
    videoKey: legacyVideoKey(entry) ?? undefined,
    title: entry.title || undefined,
    duration: uint(entry.durationSec),
    position: uint(entry.positionSec),
    completed: entry.completed === true,
    timestamp: uint(entry.updatedAt),
    identity,
    saved: typeof entry.saved === 'boolean' ? entry.saved : undefined,
    playbackGeneration: uint(entry.playbackGeneration),
    tombstone: tombstone ? true : undefined,
  }
}

/**
 * Hand every unaccepted write to the store. A write that fails stays pending
 * and is retried on the next one, so a backend that is not up yet costs
 * responsiveness rather than the viewer's progress.
 *
 * A refusal is not a failure to reach the store, so it does not throw: while
 * the personal store is rotating its epoch it answers `success: false` and the
 * write has to be replayed against the new epoch. Only `success: true` retires
 * a queued write.
 */
async function flushPending(): Promise<void> {
  if (pending.size === 0) return
  const platform = await readyPlatform()
  if (!platform) return
  for (const [key, job] of [...pending]) {
    try {
      const result = await platform.rpc.logWatchHistory(requestFor(job.entry, job.tombstone))
      if (result?.success === true) pending.delete(key)
    } catch {
      // Leave it pending; the next write retries it.
    }
  }
}

/**
 * The unwritten queue is bounded exactly like the cache it mirrors. A backend
 * that never comes up must cost the oldest unwritten progress, not unbounded
 * memory, so the least recently updated writes are the ones dropped.
 */
function prunePending(): void {
  if (pending.size <= MAX_ENTRIES) return
  const ordered = [...pending.entries()].sort((left, right) => right[1].entry.updatedAt - left[1].entry.updatedAt || left[0].localeCompare(right[0]))
  for (const [key] of ordered.slice(MAX_ENTRIES)) pending.delete(key)
}

/**
 * Queue a write and hand back the attempt, so a caller that awaits it is told
 * the store has been tried rather than merely that the cache changed.
 */
function enqueue(key: string, entry: WatchHistoryEntry, tombstone: boolean): Promise<void> {
  pending.set(key, { entry, tombstone })
  prunePending()
  // Serialize so rapid progress ticks cannot interleave store writes.
  const attempted = writeQueue.then(() => flushPending()).catch(() => {})
  writeQueue = attempted
  // The cache already changed, so surfaces can render the new state now rather
  // than after the store acknowledges the write.
  notifyChanged()
  return attempted
}

/** The old plaintext entry shape, read leniently field by field. */
type LegacyWatchRecord = StoredProgressRecord & {
  thumbnailUrl?: unknown
  channelName?: unknown
  publicBeeKey?: unknown
}

type LegacySource = { entries: LegacyWatchRecord[]; clear(): Promise<void> }

/**
 * The slice of expo-file-system this file touches. Two module generations are
 * in play, so the shape is described structurally instead of imported.
 */
type LegacyFileSystem = {
  documentDirectory?: string | null
  cacheDirectory?: string | null
  Paths?: { document?: { uri?: string }; cache?: { uri?: string } }
  readAsStringAsync?(uri: string, options?: { encoding?: string }): Promise<string>
  deleteAsync?(uri: string, options?: { idempotent?: boolean }): Promise<void>
}

/**
 * Dynamic because the module is platform-specific and versioned: web has no
 * filesystem at all, and the legacy entry point exists only in some installs.
 * A static import would fail to resolve on the platforms that lack it.
 */
async function getFileSystem(): Promise<LegacyFileSystem | null> {
  if (Platform.OS === 'web') return null
  for (const load of [() => import('expo-file-system/legacy'), () => import('expo-file-system')]) {
    try {
      const mod: unknown = await load()
      const resolved = (mod as { default?: unknown } | null)?.default ?? mod
      // Two module generations with incompatible published types; the shape
      // this file needs is narrowed by the checks at each call site.
      if (resolved) return resolved as LegacyFileSystem
    } catch {
      // Try the next entry point.
    }
  }
  return null
}

function legacyHistoryUri(fs: LegacyFileSystem): string | null {
  const base = fs.documentDirectory || fs.Paths?.document?.uri || fs.cacheDirectory || fs.Paths?.cache?.uri
  if (typeof base !== 'string' || base.length === 0) return null
  return `${base.replace(/\/?$/, '/')}${LEGACY_HISTORY_FILE}`
}

async function readLegacySource(): Promise<LegacySource | null> {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null
      const raw = localStorage.getItem(LEGACY_WEB_STORAGE_KEY)
      if (raw === null) return null
      // Every field of `LegacyWatchRecord` is `unknown`, so this asserts only
      // "an array of rows" and each value is still validated on the way in.
      const parsed: unknown = JSON.parse(raw)
      return {
        entries: Array.isArray(parsed) ? (parsed as LegacyWatchRecord[]) : [],
        async clear() { localStorage.removeItem(LEGACY_WEB_STORAGE_KEY) },
      }
    }
    const fs = await getFileSystem()
    if (typeof fs?.readAsStringAsync !== 'function') return null
    const uri = legacyHistoryUri(fs)
    if (!uri) return null
    const parsed: unknown = JSON.parse(await fs.readAsStringAsync(uri, { encoding: 'utf8' }))
    return {
      entries: Array.isArray(parsed) ? (parsed as LegacyWatchRecord[]) : [],
      async clear() {
        if (typeof fs.deleteAsync === 'function') await fs.deleteAsync(uri, { idempotent: true })
      },
    }
  } catch {
    // No legacy state, or unreadable state. Either way there is nothing to move.
    return null
  }
}

/**
 * Every canonical key a stored record answers to. The resume row carries the
 * state key the store filed it under and, for a legacy row, the video key it
 * was filed under before; an identity-only record has no video key at all.
 * Reading back under any of them is proof the record is durable.
 */
function storedKeysOf(record: StoredProgressRecord): string[] {
  const keys: string[] = []
  const stateKey = text(record?.stateKey)
  if (stateKey) keys.push(stateKey)
  const videoKey = text(record?.videoKey)
  if (videoKey) keys.push(videoKey)
  const derived = fromRecord(record)
  if (derived && !derived.tombstone) keys.push(derived.key)
  return keys
}

/**
 * Move the plaintext device file into the encrypted store, exactly once.
 *
 * The legacy copy is deleted only once every row it holds reads back out of
 * the store under its canonical state key, so an interrupted migration is
 * retried on the next launch instead of losing the viewer's history. The
 * read-back covers rows a previous run already moved as well as the ones this
 * run wrote: "we did not write it this time" is not evidence that it is safe.
 * Only a row carrying no identity at all is exempt, because there is nothing
 * in it to preserve.
 */
async function migrateLegacyState(): Promise<void> {
  const legacy = await readLegacySource()
  if (!legacy) return

  const required = new Set<string>()
  for (const raw of legacy.entries) {
    const identity = identityOf(raw)
    const channelKey = text(raw?.channelKey) ?? ''
    const videoId = text(raw?.videoId) ?? ''
    const key = stateKeyOf({ identity, channelKey, videoId })
    if (!key) continue
    required.add(key)
    if (cache.has(key)) continue
    const entry: WatchHistoryEntry = {
      videoId,
      channelKey,
      publicBeeKey: text(raw?.publicBeeKey),
      title: text(raw?.title) ?? 'Untitled',
      channelName: text(raw?.channelName) ?? undefined,
      thumbnailUrl: text(raw?.thumbnailUrl),
      positionSec: finite(raw?.positionSec ?? raw?.position),
      durationSec: finite(raw?.durationSec ?? raw?.duration),
      updatedAt: finite(raw?.updatedAt),
      completed: raw?.completed === true,
      saved: raw?.saved === true,
      identity,
      playbackGeneration: 0,
    }
    const platform = await readyPlatform()
    if (!platform) return
    try {
      await platform.rpc.logWatchHistory(requestFor(entry, false))
    } catch {
      // A failed migration write means the legacy file stays exactly where it is.
      return
    }
    cache.set(key, entry)
  }
  prune()

  if (required.size > 0) {
    const platform = await readyPlatform()
    if (!platform) return
    const stored = new Set<string>()
    try {
      const readback = await platform.rpc.listResumePositions()
      for (const record of readback?.entries ?? []) {
        for (const key of storedKeysOf(record)) stored.add(key)
      }
    } catch {
      return
    }
    for (const key of required) {
      if (!stored.has(key)) return
    }
  }
  try {
    await legacy.clear()
  } catch {
    // The records are safe in the store; a stubborn legacy file is retried later.
  }
}

async function loadFromStore(): Promise<void> {
  const platform = await readyPlatform()
  if (!platform) return

  try {
    const history = await platform.rpc.getWatchHistory({ limit: MAX_ENTRIES })
    for (const record of history?.entries ?? []) {
      const admitted = fromRecord(record)
      if (admitted) admit(admitted.key, admitted.entry, admitted.tombstone)
    }
  } catch {
    // A store that cannot be read yet is not an empty store; stay unhydrated.
  }
  try {
    // Resume rows are the authoritative position, so they land last.
    const resume = await platform.rpc.listResumePositions()
    for (const record of resume?.entries ?? []) {
      const admitted = fromRecord(record)
      if (admitted) admit(admitted.key, admitted.entry, admitted.tombstone)
    }
  } catch {
    return
  }

  hydrated = true
  prune()
  notifyChanged()
  await migrateLegacyState()
  await flushPending()
}

async function hydrate(): Promise<void> {
  if (hydrated) return
  if (!hydrating) {
    hydrating = loadFromStore()
      .catch(() => {})
      .finally(() => { hydrating = null })
  }
  await hydrating
}

/**
 * A new watch of these coordinates has begun.
 *
 * The player calls this the moment it starts playback, and it is the only
 * thing that lifts the barrier a delete puts on a key. Without it the session
 * that was already running when the viewer deleted a record would write the
 * record straight back on its next progress tick. The tombstone's generation
 * survives the barrier, so the first write of the new watch still lands
 * strictly above the delete.
 */
export function beginWatchSession(coordinates: { channelKey?: string | null; videoId?: string | null; identity?: WatchIdentity | null }): void {
  const key = stateKeyOf(coordinates)
  if (!key) return
  const grave = tombstones.get(key)
  if (grave) grave.blocked = false
}

export async function recordProgress(input: WatchProgressInput): Promise<void> {
  try {
    const key = stateKeyOf(input)
    if (!key) return
    await hydrate()

    const grave = tombstones.get(key)
    // The viewer deleted this while a player was still mounted on it. That
    // player does not get to undo the delete; only a deliberate new watch does.
    if (grave?.blocked) return

    const durationSec = finite(input.durationSec)
    const positionSec = finite(input.positionSec)
    const previous = cache.get(key) ?? null
    const fraction = durationSec > 0 ? positionSec / durationSec : 0
    // Restarting a finished title is a new generation; anything else inside the
    // current generation can move the position but never un-complete it. A
    // write to a deleted key is a new watch too, and starts strictly above the
    // tombstone so it wins outright rather than out-timestamping the delete.
    const replaying = previous?.completed === true && fraction < MIN_RESUME_RATIO
    const playbackGeneration = grave
      ? grave.generation + 1
      : (previous?.playbackGeneration ?? 0) + (replaying ? 1 : 0)
    const completedNow = durationSec > 0 && fraction >= COMPLETED_RATIO

    const entry: WatchHistoryEntry = {
      videoId: text(input.videoId) ?? previous?.videoId ?? '',
      channelKey: text(input.channelKey) ?? previous?.channelKey ?? '',
      publicBeeKey: input.publicBeeKey ?? previous?.publicBeeKey ?? null,
      title: text(input.title) ?? previous?.title ?? 'Untitled',
      channelName: input.channelName ?? previous?.channelName,
      thumbnailUrl: input.thumbnailUrl ?? previous?.thumbnailUrl ?? null,
      positionSec,
      durationSec,
      updatedAt: Date.now(),
      completed: replaying ? completedNow : previous?.completed === true || completedNow,
      saved: input.saved ?? previous?.saved,
      identity: input.identity ?? previous?.identity ?? null,
      playbackGeneration,
    }

    cache.set(key, entry)
    tombstones.delete(key)
    prune()
    // Resolve once the store has actually been tried, not once the cache has
    // changed: a caller awaiting progress is asking about the write.
    await enqueue(key, entry, false)
  } catch {
    // Progress is best-effort; it never surfaces into playback.
  }
}

/** Most-recent-first history, including completed videos. */
export async function getHistory(): Promise<WatchHistoryEntry[]> {
  await hydrate()
  return [...cache.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

/** Entries worth resuming: meaningfully started but not finished. */
export async function getContinueWatching(limit = 10): Promise<WatchHistoryEntry[]> {
  const entries = await getHistory()
  return entries.filter(isResumableEntry).slice(0, Math.max(0, limit))
}

/**
 * This device's watch state in the shape the Home rails and the local ranker
 * consume. Deliberately narrow: only what a private rail needs.
 */
export async function getLocalWatchState(): Promise<LocalWatchStateRow[]> {
  const entries = await getHistory()
  return entries.map(entry => ({
    entityId: text(entry.identity?.entityRef),
    identity: entry.identity ?? null,
    channelKey: entry.channelKey,
    videoId: entry.videoId,
    title: entry.title,
    positionSeconds: entry.positionSec,
    durationSeconds: entry.durationSec,
    completed: entry.completed === true,
    saved: entry.saved === true,
    updatedAt: entry.updatedAt,
  }))
}

/**
 * The store's own copy of one entry. Resuming reads through this rather than
 * trusting a position a list rendered some time ago.
 */
export async function getEntry(coordinates: { channelKey?: string | null; videoId?: string | null; identity?: WatchIdentity | null }): Promise<WatchHistoryEntry | null> {
  await hydrate()
  const key = stateKeyOf(coordinates)
  if (key) {
    const direct = cache.get(key)
    if (direct) return direct
  }
  const videoKey = legacyVideoKey(coordinates)
  if (!videoKey) return null
  for (const entry of cache.values()) {
    if (legacyVideoKey(entry) === videoKey) return entry
  }
  return null
}

/**
 * Tombstone one cached record and queue the delete.
 *
 * The tombstone outranks the record it removes rather than merely
 * out-timestamping it, so no write already in flight on any device can win by
 * arriving a millisecond later.
 */
function tombstoneEntry(key: string, entry: WatchHistoryEntry, now: number): Promise<void> {
  const generation = (entry.playbackGeneration ?? 0) + 1
  cache.delete(key)
  rememberTombstone(key, generation, true)
  return enqueue(key, { ...entry, updatedAt: now, playbackGeneration: generation }, true)
}

/**
 * Logical delete. The record is tombstoned rather than dropped so a paired
 * device cannot resurrect it by replaying an older write, and the player that
 * may still be mounted on it is barred from writing to these coordinates until
 * a new watch of them begins.
 */
export async function removeEntry(channelKey: string, videoId: string): Promise<void> {
  await hydrate()
  const videoKey = legacyVideoKey({ channelKey, videoId })
  if (!videoKey) return
  const now = Date.now()
  const deleted: Promise<void>[] = []
  for (const [key, entry] of [...cache.entries()]) {
    if (key !== videoKey && legacyVideoKey(entry) !== videoKey) continue
    deleted.push(tombstoneEntry(key, entry, now))
  }
  await Promise.all(deleted)
}

export async function clearHistory(): Promise<void> {
  await hydrate()
  const now = Date.now()
  const deleted: Promise<void>[] = []
  for (const [key, entry] of [...cache.entries()]) deleted.push(tombstoneEntry(key, entry, now))
  await Promise.all(deleted)
}

/** Watch for local changes. Returns the unsubscribe. */
export function subscribeWatchState(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * This device's watch state for a rendering surface. Home is a tab that stays
 * mounted, so it subscribes rather than reloading on focus: a progress tick
 * during playback shows up on Continue Watching without a remount.
 */
export function useLocalWatchState(): LocalWatchStateRow[] {
  const [rows, setRows] = useState<LocalWatchStateRow[]>([])
  useEffect(() => {
    let active = true
    const refresh = () => {
      void getLocalWatchState().then(next => { if (active) setRows(next) }).catch(() => {})
    }
    refresh()
    const unsubscribe = subscribeWatchState(refresh)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  return rows
}
