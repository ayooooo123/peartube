/**
 * Local watch history — source of truth for "Continue Watching".
 *
 * The backend's logWatchEvent is write-only and in-memory (it only feeds the
 * recommender), so resume positions are persisted app-side: a JSON file on
 * native (same dual-import pattern as feed-snapshot-storage.ts) and
 * localStorage on web/desktop.
 */
import { Platform } from 'react-native'

export interface WatchHistoryEntry {
  videoId: string
  channelKey: string
  publicBeeKey?: string | null
  title: string
  channelName?: string
  thumbnailUrl?: string | null
  positionSec: number
  durationSec: number
  /** epoch ms of the last progress update */
  updatedAt: number
  completed?: boolean
}

const HISTORY_FILE = 'peartube-watch-history.json'
const WEB_STORAGE_KEY = 'peartube-watch-history'
const MAX_ENTRIES = 50

/** Watched ≥95% counts as completed; below 2% isn't worth resuming. */
const COMPLETED_RATIO = 0.95
const MIN_RESUME_RATIO = 0.02

function normalizeFsModule(mod: any): any {
  return mod?.default ?? mod
}

async function getFileSystem(): Promise<any | null> {
  if (Platform.OS === 'web') return null
  try {
    const legacy = await import('expo-file-system/legacy')
    return normalizeFsModule(legacy)
  } catch {
    try {
      const fs = await import('expo-file-system')
      return normalizeFsModule(fs)
    } catch {
      return null
    }
  }
}

function getHistoryUri(fs: any): string | null {
  const base = fs?.documentDirectory || fs?.Paths?.document?.uri || fs?.cacheDirectory || fs?.Paths?.cache?.uri
  if (typeof base !== 'string' || base.length === 0) return null
  return `${base.replace(/\/?$/, '/')}${HISTORY_FILE}`
}

let cache: WatchHistoryEntry[] | null = null
let writeQueue: Promise<void> = Promise.resolve()

async function readAll(): Promise<WatchHistoryEntry[]> {
  if (cache) return cache

  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return (cache = [])
      const raw = localStorage.getItem(WEB_STORAGE_KEY)
      cache = raw ? JSON.parse(raw) : []
    } else {
      const fs = await getFileSystem()
      if (!fs || typeof fs.readAsStringAsync !== 'function') return (cache = [])
      const uri = getHistoryUri(fs)
      if (!uri) return (cache = [])
      const text = await fs.readAsStringAsync(uri, { encoding: 'utf8' })
      cache = JSON.parse(text)
    }
  } catch {
    cache = []
  }

  if (!Array.isArray(cache)) cache = []
  return cache
}

async function persist(entries: WatchHistoryEntry[]): Promise<void> {
  cache = entries
  // Serialize writes so rapid progress ticks can't interleave file writes.
  writeQueue = writeQueue.then(async () => {
    try {
      const payload = JSON.stringify(entries)
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.setItem(WEB_STORAGE_KEY, payload)
        return
      }
      const fs = await getFileSystem()
      if (!fs || typeof fs.writeAsStringAsync !== 'function') return
      const uri = getHistoryUri(fs)
      if (!uri) return
      await fs.writeAsStringAsync(uri, payload, { encoding: 'utf8' })
    } catch {
      // Persistence is best-effort; never let it surface into playback.
    }
  })
  await writeQueue
}

function entryKey(e: { videoId: string; channelKey: string }): string {
  return `${e.channelKey}:${e.videoId}`
}

export async function recordProgress(entry: Omit<WatchHistoryEntry, 'updatedAt' | 'completed'>): Promise<void> {
  try {
    if (!entry.videoId || !entry.channelKey) return
    const entries = await readAll()
    const key = entryKey(entry)
    const completed = entry.durationSec > 0 && entry.positionSec / entry.durationSec >= COMPLETED_RATIO
    const next: WatchHistoryEntry = { ...entry, updatedAt: Date.now(), completed }
    const filtered = entries.filter((e) => entryKey(e) !== key)
    filtered.unshift(next)
    await persist(filtered.slice(0, MAX_ENTRIES))
  } catch {
    // best-effort
  }
}

/** Most-recent-first history, including completed videos. */
export async function getHistory(): Promise<WatchHistoryEntry[]> {
  const entries = await readAll()
  return [...entries]
}

/** Entries worth resuming: meaningfully started but not finished. */
export async function getContinueWatching(limit = 10): Promise<WatchHistoryEntry[]> {
  const entries = await readAll()
  return entries
    .filter((e) => {
      if (e.completed) return false
      if (!(e.durationSec > 0)) return false
      const ratio = e.positionSec / e.durationSec
      return ratio >= MIN_RESUME_RATIO && ratio < COMPLETED_RATIO
    })
    .slice(0, limit)
}

export async function removeEntry(channelKey: string, videoId: string): Promise<void> {
  const entries = await readAll()
  await persist(entries.filter((e) => entryKey(e) !== `${channelKey}:${videoId}`))
}

export async function clearHistory(): Promise<void> {
  await persist([])
}
