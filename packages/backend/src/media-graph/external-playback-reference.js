import { EXTERNAL_MEDIA_NAMESPACES, normalizeExternalIdentifier } from './external-identifiers.js'

export const EXTERNAL_PLAYBACK_REFERENCE_VERSION = 1

const SUPPORTED_NAMESPACES = new Set(EXTERNAL_MEDIA_NAMESPACES)
const EMBED_PARENT = /^(?:localhost|(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/i

const ARCHIVAL_POLICY = Object.freeze({
  automaticAcquisition: false,
  requiredAuthority: 'rights-holder-or-license',
  p2pIngest: 'publisher-supplied-bytes',
})

function normalizeEmbedParent(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !EMBED_PARENT.test(value)) throw new Error('embedParent must be a bare DNS hostname')
  return value.toLowerCase()
}

function officialEmbed(embedUrl, requiresParent = false) {
  return Object.freeze({ mode: 'official-embed', embedUrl, requiresParent })
}

function externalLink() {
  return Object.freeze({ mode: 'external-link', embedUrl: null, requiresParent: false })
}

function twitchPlayer(parameters, parent) {
  if (!parent) return officialEmbed(null, true)
  const embedAddress = new URL('https://player.twitch.tv/')
  for (const [name, value] of parameters) embedAddress.searchParams.set(name, value)
  embedAddress.searchParams.set('parent', parent)
  embedAddress.searchParams.set('autoplay', 'false')
  return officialEmbed(embedAddress.toString(), true)
}

function resolveProvider(namespace, identifier, parent) {
  const encoded = encodeURIComponent(identifier)
  switch (namespace) {
    case 'youtube-video':
      return {
        canonicalUrl: `https://www.youtube.com/watch?v=${encoded}`,
        playback: officialEmbed(`https://www.youtube.com/embed/${encoded}`),
      }
    case 'youtube-channel':
      return {
        canonicalUrl: `https://www.youtube.com/channel/${encoded}`,
        playback: externalLink(),
      }
    case 'twitch-vod':
      return {
        canonicalUrl: `https://www.twitch.tv/videos/${encoded}`,
        playback: twitchPlayer([['video', `v${identifier}`]], parent),
      }
    case 'twitch-clip': {
      let playback = officialEmbed(null, true)
      if (parent) {
        const embedAddress = new URL('https://clips.twitch.tv/embed')
        embedAddress.searchParams.set('clip', identifier)
        embedAddress.searchParams.set('parent', parent)
        embedAddress.searchParams.set('autoplay', 'false')
        playback = officialEmbed(embedAddress.toString(), true)
      }
      return {
        canonicalUrl: `https://clips.twitch.tv/${encoded}`,
        playback,
      }
    }
    case 'twitch-channel':
      return {
        canonicalUrl: `https://www.twitch.tv/${encoded}`,
        playback: twitchPlayer([['channel', identifier]], parent),
      }
    case 'chaturbate-room':
      return {
        canonicalUrl: `https://chaturbate.com/${encoded}/`,
        playback: externalLink(),
        contentPolicy: 'adult-age-gated',
      }
    case 'vimeo-video':
      return {
        canonicalUrl: `https://vimeo.com/${encoded}`,
        playback: officialEmbed(`https://player.vimeo.com/video/${encoded}`),
      }
    case 'dailymotion-video':
      return {
        canonicalUrl: `https://www.dailymotion.com/video/${encoded}`,
        playback: officialEmbed(`https://www.dailymotion.com/embed/video/${encoded}`),
      }
    case 'kick-channel':
      return {
        canonicalUrl: `https://kick.com/${encoded}`,
        playback: externalLink(),
      }
    default:
      throw new Error('external playback namespace is unsupported')
  }
}

/**
 * Resolve a stable proprietary-platform identity to the provider's public URL or
 * official embed. This never discovers media URLs or grants archival authority.
 * P2P publication starts only after a rights holder supplies authorized bytes.
 */
export function createExternalPlaybackReference(namespace, value, options = {}) {
  const normalizedNamespace = String(namespace || '').toLowerCase()
  if (!SUPPORTED_NAMESPACES.has(normalizedNamespace)) throw new Error('external playback namespace is unsupported')
  const identifier = normalizeExternalIdentifier(normalizedNamespace, value)
  const parent = normalizeEmbedParent(options.embedParent)
  const provider = resolveProvider(normalizedNamespace, identifier, parent)
  return Object.freeze({
    version: EXTERNAL_PLAYBACK_REFERENCE_VERSION,
    namespace: normalizedNamespace,
    identifier,
    canonicalUrl: provider.canonicalUrl,
    playback: provider.playback,
    archival: ARCHIVAL_POLICY,
    contentPolicy: provider.contentPolicy || 'provider-controlled',
  })
}
