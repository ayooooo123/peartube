export const SIMPLE_RELAY_CATALOG_URL_FILE = 'peartube-simple-relay-catalog-url.txt'

function normalizeFsModule(mod: any): any {
  return mod?.default ?? mod
}

export async function getFileSystem(): Promise<any | null> {
  if (typeof process !== 'undefined' && process?.versions?.node && !(globalThis as any)?.navigator?.product) return null
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

function getConfigUri(fs: any): string | null {
  const base = fs?.documentDirectory || fs?.Paths?.document?.uri || fs?.cacheDirectory || fs?.Paths?.cache?.uri
  if (typeof base !== 'string' || base.length === 0) return null
  return `${base.replace(/\/?$/, '/')}${SIMPLE_RELAY_CATALOG_URL_FILE}`
}

export function normalizeRelayCatalogUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

export async function readRelayCatalogUrlFromDisk(): Promise<string | null> {
  const fs = await getFileSystem()
  if (!fs || typeof fs.readAsStringAsync !== 'function') return null
  const uri = getConfigUri(fs)
  if (!uri) return null
  try {
    return normalizeRelayCatalogUrl(await fs.readAsStringAsync(uri, { encoding: 'utf8' }))
  } catch {
    return null
  }
}

export async function writeRelayCatalogUrlToDisk(value: string): Promise<boolean> {
  const normalized = normalizeRelayCatalogUrl(value)
  if (!normalized) return false
  const fs = await getFileSystem()
  if (!fs || typeof fs.writeAsStringAsync !== 'function') return false
  const uri = getConfigUri(fs)
  if (!uri) return false
  try {
    await fs.writeAsStringAsync(uri, normalized, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

export async function clearRelayCatalogUrlFromDisk(): Promise<boolean> {
  const fs = await getFileSystem()
  if (!fs) return false
  const uri = getConfigUri(fs)
  if (!uri) return false
  try {
    if (typeof fs.deleteAsync === 'function') {
      await fs.deleteAsync(uri, { idempotent: true })
      return true
    }
    if (typeof fs.writeAsStringAsync === 'function') {
      await fs.writeAsStringAsync(uri, '', { encoding: 'utf8' })
      return true
    }
    return false
  } catch {
    return false
  }
}

export function entriesFromRelayCatalog(catalog: any): any[] {
  const channels = Array.isArray(catalog?.channels)
    ? catalog.channels
    : Object.values(catalog?.channels || {})

  return channels
    .map((channel: any) => {
      const channelKey = channel?.channelKey || channel?.driveKey
      const publicBeeKey = channel?.publicBeeKey || null
      if (typeof channelKey !== 'string' || channelKey.length === 0) return null
      const previewVideos = (Array.isArray(channel?.previewVideos)
        ? channel.previewVideos
        : Array.isArray(channel?.videos)
          ? channel.videos
          : [])
        .filter((video: any) => video && typeof video.id === 'string' && video.id.length > 0)
        .map((video: any) => ({
          ...video,
          channelKey,
          driveKey: channelKey,
          publicBeeKey: video.publicBeeKey || publicBeeKey,
          availability: video.availability || 'playable',
        }))
      return {
        driveKey: channelKey,
        channelKey,
        publicBeeKey,
        channelName: channel?.channelName || channel?.name || 'Relay Archive',
        source: 'relay-cache',
        relayRole: 'cache',
        relayServing: true,
        peerCount: Number(channel?.peerCount || 0) || 0,
        videoCount: Number(channel?.videoCount || previewVideos.length || 0) || 0,
        manifestUpdatedAt: Number(channel?.manifestUpdatedAt || channel?.mirroredAt || channel?.updatedAt || Date.now()) || Date.now(),
        lastSeen: Number(channel?.lastSeen || channel?.lastSeenAt || channel?.mirroredAt || Date.now()) || Date.now(),
        previewVideos,
      }
    })
    .filter(Boolean)
}

export async function fetchRelayCatalogEntries(catalogUrl: string, timeoutMs = 4000): Promise<any[]> {
  const normalized = normalizeRelayCatalogUrl(catalogUrl)
  if (!normalized || typeof fetch !== 'function') return []

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(normalized, {
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    } as any)
    if (!response?.ok) return []
    const catalog = await response.json()
    return entriesFromRelayCatalog(catalog)
  } catch {
    return []
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
