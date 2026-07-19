import {
  YtDlpError,
  buildDownloadArgs,
  buildInspectArgs,
  buildListArgs,
  buildSearchArgs,
  parseReportedFilePath,
  parseYtDlpJson,
  runYtDlp
} from '../../media/yt-dlp.js'

const DEFAULT_CAPABILITIES = { search: true, profile: true, list: true, metadata: true, download: true }

export function createYtDlpProvider ({
  bin = 'yt-dlp',
  cookiesPath = null,
  run,
  capabilities = {}
} = {}) {
  const caps = { ...DEFAULT_CAPABILITIES, ...capabilities }
  const exec = typeof run === 'function'
    ? run
    : (file, args) => runYtDlp(file, args)

  function ensure (capability) {
    if (!caps[capability]) {
      throw new YtDlpError(`yt-dlp capability not supported: ${capability}`, { code: 'ERR_YTDLP_UNSUPPORTED' })
    }
  }

  async function call (args) {
    const { stdout } = await exec(bin, args)
    return parseYtDlpJson(stdout)
  }

  return {
    capabilities () {
      return { ...caps }
    },

    async search (query, { limit = 10 } = {}) {
      ensure('search')
      const data = await call(buildSearchArgs(query, limit, { cookiesPath }))
      return normalizeEntries(data)
    },

    async inspect (url) {
      ensure('metadata')
      const data = await call(buildInspectArgs(url, { cookiesPath }))
      return normalizeItem(data)
    },

    async listProfile (url, { limit = 25 } = {}) {
      ensure('list')
      const data = await call(buildListArgs(url, { limit, cookiesPath }))
      return {
        creator: normalizeCreator(data),
        items: normalizeEntries(data)
      }
    },

    async download ({ url, outputTemplate, format = 'bv*+ba/b', ffmpegPath = null, jsRuntime = null, extraArgs = [], cookiesPath: callCookies } = {}) {
      ensure('download')
      const args = buildDownloadArgs({
        format,
        outputTemplate,
        ffmpegPath,
        cookiesPath: callCookies !== undefined ? callCookies : cookiesPath,
        jsRuntime,
        extraArgs,
        sourceUrl: url
      })
      const { stdout } = await exec(bin, args)
      const filePath = parseReportedFilePath(stdout)
      if (!filePath) {
        throw new YtDlpError('yt-dlp did not report an output file', { code: 'ERR_YTDLP_INVALID_OUTPUT' })
      }
      return { filePath }
    }
  }
}

function normalizeEntries (data) {
  const entries = Array.isArray(data && data.entries) ? data.entries : (data ? [data] : [])
  return entries.map((entry) => normalizeItem(entry, data)).filter(Boolean)
}

function normalizeItem (entry, parent = null) {
  if (!entry || typeof entry !== 'object') return null
  const canonicalUrl = entry.webpage_url || entry.url || null
  const platform = detectPlatform(entry, parent, canonicalUrl)
  return {
    kind: 'item',
    contentKind: 'video',
    sourceProvider: platform,
    sourceVideoId: entry.id != null ? String(entry.id) : null,
    canonicalUrl,
    title: entry.title || null,
    description: typeof entry.description === 'string' ? entry.description : '',
    sourcePublishedAt: parseUploadDate(entry.upload_date, entry.timestamp),
    thumbnail: entry.thumbnail || firstThumbnail(entry.thumbnails) || null,
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    creator: {
      name: entry.uploader || entry.channel || (parent && (parent.uploader || parent.channel)) || null,
      sourceId: entry.channel_id || entry.uploader_id || null,
      canonicalUrl: entry.channel_url || entry.uploader_url || null
    }
  }
}

function normalizeCreator (data) {
  if (!data || typeof data !== 'object') return null
  const thumbnails = Array.isArray(data.thumbnails) ? data.thumbnails : []
  return {
    name: data.uploader || data.channel || data.title || null,
    platform: detectPlatform(data, null, data.webpage_url),
    sourceId: data.channel_id || data.id || null,
    canonicalUrl: data.webpage_url || data.channel_url || null,
    handle: data.uploader_id || null,
    avatarUrl: thumbnailById(thumbnails, 'avatar') || (thumbnails[0] && thumbnails[0].url) || null,
    bannerUrl: thumbnailById(thumbnails, 'banner') || null,
    biography: typeof data.description === 'string' ? data.description : ''
  }
}

function detectPlatform (entry, parent, url) {
  const extractor = (entry && (entry.extractor_key || entry.ie_key)) ||
    (parent && (parent.extractor_key || parent.ie_key)) || ''
  const normalized = String(extractor).toLowerCase()
  if (normalized.startsWith('youtube')) return 'youtube'
  if (normalized) return normalized.replace(/tab$|:.*$/, '')
  if (typeof url === 'string') {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      const label = host.split('.').slice(-2, -1)[0]
      if (label) return label
    } catch {}
  }
  return 'unknown'
}

function parseUploadDate (uploadDate, timestamp) {
  if (typeof uploadDate === 'string' && /^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
  }
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp * 1000).toISOString().slice(0, 10)
  }
  return null
}

function firstThumbnail (thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null
  return thumbnails[thumbnails.length - 1].url || null
}

function thumbnailById (thumbnails, id) {
  const match = thumbnails.find((thumbnail) => thumbnail && thumbnail.id === id)
  return match ? match.url : null
}
