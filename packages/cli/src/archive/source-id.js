import { ARCHIVE_TYPE_YOUTUBE } from '../constants.js'

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be'
])

const RUMBLE_HOSTS = new Set([
  'rumble.com',
  'www.rumble.com'
])

function parseUrl(input) {
  if (typeof input !== 'string') return null
  try {
    return new URL(input.trim())
  } catch {
    return null
  }
}

function pickYoutubeChannelId(url) {
  if (!url) return null

  const host = url.hostname.toLowerCase()
  if (!YOUTUBE_HOSTS.has(host)) return null

  const path = url.pathname.replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)

  if (segments[0] === 'channel' && segments[1]) {
    return { kind: 'channel', id: segments[1] }
  }
  if (segments[0] && segments[0].startsWith('@')) {
    return { kind: 'handle', id: segments[0] }
  }
  if (segments[0] === 'c' && segments[1]) {
    return { kind: 'custom', id: segments[1] }
  }
  if (segments[0] === 'user' && segments[1]) {
    return { kind: 'user', id: segments[1] }
  }
  if (segments[0] === 'playlist') {
    const list = url.searchParams.get('list')
    if (list) return { kind: 'playlist', id: list }
  }

  return null
}

function pickRumbleSource(url) {
  if (!url) return null

  const host = url.hostname.toLowerCase()
  if (!RUMBLE_HOSTS.has(host)) return null

  const path = url.pathname.replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'c' && segments[1]) {
    return { kind: 'channel', id: segments[1] }
  }
  if (segments[0] === 'playlists' && segments[1]) {
    return { kind: 'playlist', id: segments[1] }
  }
  const videoSlug = segments[0]
  if (videoSlug && /^v[0-9a-z]+/i.test(videoSlug)) {
    return { kind: 'video', id: videoSlug.replace(/\.html$/i, '') }
  }
  return null
}

export function classifySourceUrl(input) {
  const url = parseUrl(input)
  if (!url) {
    return { type: null, normalizedUrl: null, identifier: null, kind: null }
  }

  const yt = pickYoutubeChannelId(url)
  if (yt) {
    return {
      type: ARCHIVE_TYPE_YOUTUBE,
      normalizedUrl: input.trim(),
      identifier: yt.id,
      kind: yt.kind
    }
  }

  const rumble = pickRumbleSource(url)
  if (rumble) {
    return {
      type: ARCHIVE_TYPE_YOUTUBE,
      normalizedUrl: input.trim(),
      identifier: `rumble:${rumble.kind}:${rumble.id}`,
      kind: `rumble-${rumble.kind}`
    }
  }

  return { type: null, normalizedUrl: null, identifier: null, kind: null }
}

export function buildSourceId(type, identifier) {
  if (!type || !identifier) return null
  return `${type}:${identifier}`
}

export function buildWriterKeyName(sourceId) {
  if (!sourceId) return null
  return `peartube-archive-writer:${sourceId}`
}
