const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/
const DECIMAL_ID = /^[0-9]{1,20}$/
const SLUG = /^[A-Za-z0-9_-]{1,128}$/
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/
const TWITCH_ACCOUNT = /^[A-Za-z0-9_]{1,25}$/
const DAILYMOTION_ID = /^[A-Za-z0-9]{1,32}$/

const KNOWN_NAMESPACES = Object.freeze({
  'youtube-video': normalizeYouTubeVideo,
  'youtube-channel': normalizeYouTubeChannel,
  'twitch-vod': normalizeTwitchVod,
  'twitch-clip': normalizeTwitchClip,
  'twitch-channel': normalizeTwitchChannel,
  'chaturbate-room': normalizeChaturbateRoom,
  'vimeo-video': normalizeVimeoVideo,
  'dailymotion-video': normalizeDailymotionVideo,
  'kick-channel': normalizeKickChannel,
})

export const EXTERNAL_MEDIA_NAMESPACES = Object.freeze(Object.keys(KNOWN_NAMESPACES))

export function normalizeExternalIdentifier(namespace, value) {
  const normalize = KNOWN_NAMESPACES[String(namespace || '').toLowerCase()]
  if (!normalize) return null
  if (typeof value !== 'string') throw new Error('external identifier must be a string')
  const input = value.trim()
  if (input.length === 0 || input.length > 512) throw new Error('external identifier must be bounded')
  return normalize(input)
}

function parseHttpsUrl(input) {
  if (!/^https:\/\//i.test(input)) return null
  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('external identifier URL is invalid')
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('external identifier URL must use canonical HTTPS authority')
  }
  url.hash = ''
  return url
}

function hostIs(url, ...hosts) {
  return hosts.includes(url.hostname.toLowerCase())
}

function pathParts(url) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.some(part => /%2f|%5c/i.test(part))) throw new Error('external identifier URL path is ambiguous')
  return parts.map(part => decodeURIComponent(part))
}

function exact(value, pattern, label, transform = input => input) {
  const normalized = transform(value)
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`)
  return normalized
}

function normalizeYouTubeVideo(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input, YOUTUBE_ID, 'YouTube video ID')
  let candidate = null
  if (hostIs(url, 'youtu.be')) {
    const parts = pathParts(url)
    if (parts.length !== 1) throw new Error('YouTube short URL is invalid')
    candidate = parts[0]
  } else if (hostIs(url, 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com')) {
    const parts = pathParts(url)
    if (parts.length === 1 && parts[0] === 'watch') {
      const ids = url.searchParams.getAll('v')
      if (ids.length !== 1) throw new Error('YouTube watch URL must identify exactly one video')
      candidate = ids[0]
    } else if (parts.length === 2 && ['shorts', 'embed', 'live'].includes(parts[0])) {
      candidate = parts[1]
    } else {
      throw new Error('YouTube video URL path is unsupported')
    }
  } else {
    throw new Error('YouTube video URL host is invalid')
  }
  return exact(candidate, YOUTUBE_ID, 'YouTube video ID')
}

function normalizeYouTubeChannel(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input, YOUTUBE_CHANNEL_ID, 'YouTube channel ID')
  if (!hostIs(url, 'youtube.com', 'www.youtube.com', 'm.youtube.com')) throw new Error('YouTube channel URL host is invalid')
  const parts = pathParts(url)
  if (parts.length !== 2 || parts[0] !== 'channel') throw new Error('YouTube channel URL path is invalid')
  return exact(parts[1], YOUTUBE_CHANNEL_ID, 'YouTube channel ID')
}

function normalizeTwitchVod(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input.replace(/^v/, ''), DECIMAL_ID, 'Twitch VOD ID')
  if (!hostIs(url, 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv')) throw new Error('Twitch VOD URL host is invalid')
  const parts = pathParts(url)
  if (parts.length !== 2 || parts[0] !== 'videos') throw new Error('Twitch VOD URL path is invalid')
  return exact(parts[1], DECIMAL_ID, 'Twitch VOD ID')
}

function normalizeTwitchClip(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input, SLUG, 'Twitch clip ID')
  const parts = pathParts(url)
  let candidate
  if (hostIs(url, 'clips.twitch.tv')) {
    if (parts.length !== 1) throw new Error('Twitch clip URL path is invalid')
    candidate = parts[0]
  } else if (hostIs(url, 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv')) {
    if (parts.length !== 3 || parts[1] !== 'clip') throw new Error('Twitch clip URL path is invalid')
    candidate = parts[2]
  } else {
    throw new Error('Twitch clip URL host is invalid')
  }
  return exact(candidate, SLUG, 'Twitch clip ID')
}

function normalizeTwitchChannel(input) {
  const url = parseHttpsUrl(input)
  let candidate = input
  if (url) {
    if (!hostIs(url, 'twitch.tv', 'www.twitch.tv', 'm.twitch.tv')) throw new Error('Twitch channel URL host is invalid')
    const parts = pathParts(url)
    if (parts.length !== 1) throw new Error('Twitch channel URL path is invalid')
    candidate = parts[0]
  }
  return exact(candidate, TWITCH_ACCOUNT, 'Twitch channel', value => value.toLowerCase())
}

function normalizeChaturbateRoom(input) {
  const url = parseHttpsUrl(input)
  let candidate = input
  if (url) {
    if (!hostIs(url, 'chaturbate.com', 'www.chaturbate.com')) throw new Error('Chaturbate room URL host is invalid')
    const parts = pathParts(url)
    if (parts.length !== 1) throw new Error('Chaturbate room URL path is invalid')
    candidate = parts[0]
  }
  return exact(candidate, ACCOUNT, 'Chaturbate room', value => value.toLowerCase())
}

function normalizeVimeoVideo(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input, DECIMAL_ID, 'Vimeo video ID')
  const parts = pathParts(url)
  let candidate
  if (hostIs(url, 'vimeo.com', 'www.vimeo.com')) {
    if (parts.length < 1 || parts.length > 2) throw new Error('Vimeo video URL path is invalid')
    candidate = parts[0]
  } else if (hostIs(url, 'player.vimeo.com')) {
    if (parts.length !== 2 || parts[0] !== 'video') throw new Error('Vimeo player URL path is invalid')
    candidate = parts[1]
  } else {
    throw new Error('Vimeo video URL host is invalid')
  }
  return exact(candidate, DECIMAL_ID, 'Vimeo video ID')
}

function normalizeDailymotionVideo(input) {
  const url = parseHttpsUrl(input)
  if (!url) return exact(input, DAILYMOTION_ID, 'Dailymotion video ID')
  const parts = pathParts(url)
  let candidate
  if (hostIs(url, 'dai.ly')) {
    if (parts.length !== 1) throw new Error('Dailymotion short URL path is invalid')
    candidate = parts[0]
  } else if (hostIs(url, 'dailymotion.com', 'www.dailymotion.com')) {
    if (parts.length !== 2 || parts[0] !== 'video') throw new Error('Dailymotion video URL path is invalid')
    candidate = parts[1].split('_', 1)[0]
  } else {
    throw new Error('Dailymotion video URL host is invalid')
  }
  return exact(candidate, DAILYMOTION_ID, 'Dailymotion video ID')
}

function normalizeKickChannel(input) {
  const url = parseHttpsUrl(input)
  let candidate = input
  if (url) {
    if (!hostIs(url, 'kick.com', 'www.kick.com')) throw new Error('Kick channel URL host is invalid')
    const parts = pathParts(url)
    if (parts.length !== 1) throw new Error('Kick channel URL path is invalid')
    candidate = parts[0]
  }
  return exact(candidate, ACCOUNT, 'Kick channel', value => value.toLowerCase())
}
