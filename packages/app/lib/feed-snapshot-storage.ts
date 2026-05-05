import { Platform } from 'react-native'

const SNAPSHOT_FILE = 'peartube-feed-snapshot.json'

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

function getSnapshotUri(fs: any): string | null {
  const base = fs?.documentDirectory || fs?.Paths?.document?.uri || fs?.cacheDirectory || fs?.Paths?.cache?.uri
  if (typeof base !== 'string' || base.length === 0) return null
  return `${base.replace(/\/?$/, '/')}${SNAPSHOT_FILE}`
}

export async function readFeedSnapshotFromDisk(): Promise<any | null> {
  const fs = await getFileSystem()
  if (!fs || typeof fs.readAsStringAsync !== 'function') return null
  const uri = getSnapshotUri(fs)
  if (!uri) return null

  try {
    const text = await fs.readAsStringAsync(uri, { encoding: 'utf8' })
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function writeFeedSnapshotToDisk(snapshot: any): Promise<boolean> {
  const fs = await getFileSystem()
  if (!fs || typeof fs.writeAsStringAsync !== 'function') return false
  const uri = getSnapshotUri(fs)
  if (!uri) return false

  try {
    await fs.writeAsStringAsync(uri, JSON.stringify(snapshot), { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}
