/**
 * Thumbnail file cache (native).
 *
 * Android's RN <Image> cannot load the worklet's loopback blob-server URL, and a
 * large base64 `data:` URI decodes (onLoad fires) but never paints. The one image
 * source that renders reliably on Android here is a `file://` URI under the app's
 * OWN sandbox (the same kind expo-image-picker returns) — NOT the worklet's
 * bare-storage dir, which Fresco won't open.
 *
 * So when the backend hands us the thumbnail bytes inline as a `data:` URL, we
 * write them to a file in expo-file-system's cacheDirectory and render that path.
 * Non-data URIs (and web) pass straight through.
 */

let fsPromise: Promise<any> | null = null

async function loadExpoFs(): Promise<any> {
  if (!fsPromise) {
    fsPromise = (async () => {
      // Match the rest of the app: prefer the legacy API (writeAsStringAsync +
      // *Directory uris), fall back to the current module shape.
      try {
        const legacy: any = await import('expo-file-system/legacy')
        const fs = legacy?.default ?? legacy
        if (fs && typeof fs.writeAsStringAsync === 'function') return fs
      } catch {}
      try {
        const mod: any = await import('expo-file-system')
        const fs = mod?.default ?? mod
        if (fs && typeof fs.writeAsStringAsync === 'function') return fs
      } catch {}
      return null
    })()
  }
  return fsPromise
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match || !match[2]) return null
  return { mime: (match[1] || 'image/jpeg').toLowerCase(), base64: match[3] }
}

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  return 'jpg'
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
}

const inflight = new Map<string, Promise<string | null>>()

/**
 * Convert a backend thumbnail result into a URI RN's <Image> can render.
 * - `data:` URLs are written to a cache file and returned as `file://…`.
 * - Anything else (already a file:///http:// URI, or web) is returned unchanged.
 * Returns null only when a data URL could not be persisted (caller should not
 * cache that, so it retries).
 */
export async function resolveRenderableThumbnailUri(
  uri: string | null | undefined,
  cacheKey: string
): Promise<string | null> {
  if (!uri) return null
  if (!uri.startsWith('data:')) return uri

  const existing = inflight.get(cacheKey)
  if (existing) return existing

  const job = (async (): Promise<string | null> => {
    const fs = await loadExpoFs()
    if (!fs || typeof fs.writeAsStringAsync !== 'function') return null

    const base: string | undefined =
      fs.cacheDirectory || fs.documentDirectory || fs?.Paths?.cache?.uri || fs?.Paths?.document?.uri
    if (!base) return null

    const parsed = parseDataUrl(uri)
    if (!parsed || !parsed.base64) return null

    const dir = `${base}peartube-thumbs/`
    try {
      if (typeof fs.makeDirectoryAsync === 'function') {
        await fs.makeDirectoryAsync(dir, { intermediates: true })
      }
    } catch {
      // Directory may already exist; ignore.
    }

    const fileUri = `${dir}${safeName(cacheKey)}.${extForMime(parsed.mime)}`

    try {
      // Reuse an already-written file (thumbnails are immutable per video).
      const info =
        typeof fs.getInfoAsync === 'function' ? await fs.getInfoAsync(fileUri) : null
      if (!info?.exists) {
        await fs.writeAsStringAsync(fileUri, parsed.base64, { encoding: 'base64' })
      }
      return fileUri
    } catch {
      try {
        await fs.writeAsStringAsync(fileUri, parsed.base64, { encoding: 'base64' })
        return fileUri
      } catch {
        return null
      }
    }
  })()

  inflight.set(cacheKey, job)
  try {
    return await job
  } finally {
    inflight.delete(cacheKey)
  }
}
