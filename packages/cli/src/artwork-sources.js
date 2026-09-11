import b4a from 'b4a'
import {
  ARTWORK_RENDITION_PURPOSES,
  MAX_ARTWORK_BYTES,
  createBufferSourceReader,
  createFileSourceReader,
  imageMimeType
} from '@peartube/backend/assets'

export function normalizePrivateArtwork (input = []) {
  if (!Array.isArray(input) || input.length > ARTWORK_RENDITION_PURPOSES.size) {
    throw new Error('artwork must contain at most four image roles')
  }
  const roles = new Set()
  return Object.freeze(input.map(entry => {
    if (!ARTWORK_RENDITION_PURPOSES.has(entry?.role) || roles.has(entry.role)) {
      throw new Error('artwork roles must be supported and unique')
    }
    roles.add(entry.role)
    // Providers can carry a remote path alongside their full URL. Only a
    // path-only input is a local file; no locator enters publication metadata.
    if (typeof entry.url === 'string' && entry.url) {
      if (entry.url.length > 8192) throw new Error('artwork URL is too long')
      const url = new URL(entry.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('artwork URL must use HTTP without embedded credentials')
      }
      return Object.freeze({ role: entry.role, url: url.href })
    }
    if (typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 || entry.path.includes('\0')) {
      throw new Error('artwork requires a URL or a local file path')
    }
    return Object.freeze({ role: entry.role, path: entry.path })
  }))
}


async function readBoundedImage (body, signal) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('artwork source must provide a bounded byte stream')
  }
  const chunks = []
  let length = 0
  for await (const chunk of body) {
    if (signal?.aborted) throw signal.reason || new Error('artwork read aborted')
    if (!(chunk instanceof Uint8Array)) throw new Error('artwork stream must contain bytes')
    length += chunk.byteLength
    if (length > MAX_ARTWORK_BYTES) throw new Error('artwork exceeds the byte limit')
    if (chunk.byteLength > 0) chunks.push(chunk)
  }
  if (signal?.aborted) throw signal.reason || new Error('artwork read aborted')
  if (length === 0) throw new Error('artwork is empty')
  return chunks.length === 1 ? chunks[0] : b4a.concat(chunks, length)
}

async function readArtwork (entry, { fs, fetch, signal }) {
  if (entry.path) {
    const source = createFileSourceReader({ fs, path: entry.path })
    try {
      const description = await source.describe({ signal })
      if (description.byteLength > MAX_ARTWORK_BYTES) throw new Error('artwork exceeds the byte limit')
      const bytes = await readBoundedImage(source.open({ offset: 0, length: description.byteLength, signal }), signal)
      await source.describe({ signal })
      return bytes
    } finally {
      await source.close()
    }
  }
  const response = await fetch(entry.url, { signal })
  try {
    if (!response.ok) throw new Error(`artwork request failed with HTTP ${response.status}`)
    const length = response.headers?.get?.('content-length')
    if (length !== null && length !== undefined && Number(length) > MAX_ARTWORK_BYTES) {
      throw new Error('artwork exceeds the byte limit')
    }
    return await readBoundedImage(response.body, signal)
  } finally {
    if (typeof response.body?.cancel === 'function') await response.body.cancel().catch(() => {})
    else response.body?.destroy?.()
  }
}

export async function openPrivateArtworkSources (entries, { fs, fetch, signal } = {}) {
  const sources = []
  try {
    for (const entry of entries) {
      if (signal?.aborted) throw signal.reason || new Error('artwork read aborted')
      const bytes = await readArtwork(entry, { fs, fetch, signal })
      const mimeType = imageMimeType(bytes)
      sources.push({ role: entry.role, mimeType, reader: createBufferSourceReader(bytes, { mimeType }) })
    }
    return sources
  } catch (error) {
    for (const source of sources) await source.reader.close(error).catch(() => {})
    throw error
  }
}
