import crypto from 'node:crypto'

const textEncoder = new TextEncoder()
const ZERO_32 = new Uint8Array(32)
const ZERO_64 = new Uint8Array(64)
const DEFAULT_LANGUAGE_TAG = 'und'
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_PROOF_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_CONTENT_BYTES_ESTIMATE = 0n

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return textEncoder.encode(value)
  return textEncoder.encode(String(value ?? ''))
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const out = new Uint8Array(Math.ceil(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    const start = i * 2
    out[i] = parseInt(clean.slice(start, start + 2).padEnd(2, '0'), 16) || 0
  }
  return out
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function ensureFixed32(bytes) {
  const out = new Uint8Array(32)
  out.set(toUint8Array(bytes).slice(0, 32))
  return out
}

function ensureFixed64(bytes) {
  const out = new Uint8Array(64)
  out.set(toUint8Array(bytes).slice(0, 64))
  return out
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Uint8Array) return `u8:${bytesToHex(value)}`
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']'
  if (value instanceof Date) return `date:${value.toISOString()}`
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}'
  }
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

async function sha256Bytes(input) {
  const data = toUint8Array(input)
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
    return new Uint8Array(digest)
  }

  return new Uint8Array(crypto.createHash('sha256').update(Buffer.from(data)).digest())
}

async function digest32(value) {
  return ensureFixed32(await sha256Bytes(stableSerialize(value)))
}

function safeBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)))
  if (typeof value === 'string' && value.trim()) {
    try { return BigInt(value) } catch { /* ignore invalid bigint */ }
  }
  return fallback
}

function safeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
}

function stripTrackingParams(url) {
  const u = new URL(url)
  const keep = new Set(['v', 't', 'list', 'index', 'start'])
  for (const key of [...u.searchParams.keys()]) {
    if (!keep.has(key)) u.searchParams.delete(key)
  }
  if (u.hash) u.hash = ''
  return u.toString()
}

function canonicalYouTubeUrl(inputUrl) {
  const url = new URL(inputUrl)
  const host = normalizeHost(url.hostname)
  let videoId = ''

  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] || ''
  } else if (host.endsWith('youtube.com')) {
    if (url.pathname.startsWith('/shorts/')) {
      videoId = url.pathname.split('/')[2] || ''
    } else if (url.pathname.startsWith('/embed/')) {
      videoId = url.pathname.split('/')[2] || ''
    } else {
      videoId = url.searchParams.get('v') || ''
    }
  }

  if (!videoId) return stripTrackingParams(url.toString())
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
}

function canonicalTikTokUrl(inputUrl) {
  const url = new URL(inputUrl)
  const host = normalizeHost(url.hostname)

  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    return stripTrackingParams(url.toString())
  }

  const pathParts = url.pathname.split('/').filter(Boolean)
  const index = pathParts.findIndex((part) => part === 'video')
  if (index >= 0 && pathParts[index + 1]) {
    return `https://www.tiktok.com/@${pathParts[index - 1] || 'unknown'}/video/${encodeURIComponent(pathParts[index + 1])}`
  }

  return stripTrackingParams(url.toString())
}

export function normalizeMirrorUrl(inputUrl) {
  if (typeof inputUrl !== 'string' || !inputUrl.trim()) {
    throw new TypeError('normalizeMirrorUrl: inputUrl must be a non-empty string')
  }

  const url = new URL(inputUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`normalizeMirrorUrl: unsupported protocol ${url.protocol}`)
  }

  const host = normalizeHost(url.hostname)
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    return {
      sourceType: 'youtube',
      normalizedUrl: canonicalYouTubeUrl(url.toString()),
      provider: 'youtube',
    }
  }

  if (host.endsWith('tiktok.com')) {
    return {
      sourceType: 'tiktok',
      normalizedUrl: canonicalTikTokUrl(url.toString()),
      provider: 'tiktok',
    }
  }

  return {
    sourceType: 'directUrl',
    normalizedUrl: stripTrackingParams(url.toString()),
    provider: 'direct',
  }
}

function parseMetaTag(html, selectors) {
  for (const selector of selectors) {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${selector}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${selector}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${selector}["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${selector}["']`, 'i'),
    ]

    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match?.[1]) return decodeHtmlEntities(match[1].trim())
    }
  }

  return ''
}

function decodeHtmlEntities(input) {
  return String(input)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function parseJsonFromHtml(html, markerPattern) {
  const match = html.match(markerPattern)
  if (!match?.[1]) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function extractDurationMsFromHtml(html) {
  const candidates = [
    parseMetaTag(html, ['video:duration']),
    parseMetaTag(html, ['duration']),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const seconds = Number(candidate)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  }

  const lengthSecondsMatch = html.match(/"lengthSeconds"\s*:\s*"?(\d+)"?/i)
  if (lengthSecondsMatch?.[1]) return Number(lengthSecondsMatch[1]) * 1000

  const durationMatch = html.match(/"duration"\s*:\s*(\d+)/i)
  if (durationMatch?.[1]) return Number(durationMatch[1]) * 1000

  const msMatch = html.match(/"durationMs"\s*:\s*"?(\d+)"?/i)
  if (msMatch?.[1]) return Number(msMatch[1])

  return 0
}

function extractContentBytesFromHeaders(headers) {
  const length = headers.get('content-length')
  if (length && Number.isFinite(Number(length))) return BigInt(Math.max(0, Number(length)))

  const contentRange = headers.get('content-range')
  if (contentRange) {
    const match = contentRange.match(/\/(\d+)$/)
    if (match?.[1]) return BigInt(match[1])
  }

  return null
}

async function fetchWithTimeout(fetchImpl, input, init = {}, timeoutMs = 15000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(new Error('fetch timeout')), timeoutMs) : null

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller ? controller.signal : init.signal,
      redirect: init.redirect || 'follow',
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchText(fetchImpl, url, init = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(fetchImpl, url, init, timeoutMs)
  const text = await response.text()
  return { response, text }
}

async function fetchOEmbed(fetchImpl, canonicalUrl, provider, timeoutMs) {
  const endpoint = provider === 'youtube'
    ? `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`
    : provider === 'tiktok'
      ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl)}`
      : null

  if (!endpoint) return null

  try {
    const { response, text } = await fetchText(fetchImpl, endpoint, {
      headers: { accept: 'application/json' },
    }, timeoutMs)

    if (!response.ok) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function extractFinalResponseInfo(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: {
        'user-agent': 'PeartubeRelay/1.0 (+https://peartube.example)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, timeoutMs)

    const contentType = response.headers.get('content-type') || ''
    const body = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') ? await response.text() : ''
    const contentBytes = extractContentBytesFromHeaders(response.headers)

    return { response, body, contentBytes }
  } catch (error) {
    return {
      response: null,
      body: '',
      contentBytes: null,
      error,
    }
  }
}

function cleanText(value, fallback = '') {
  const text = decodeHtmlEntities(String(value || '')).replace(/\s+/g, ' ').trim()
  return text || fallback
}

function inferLanguageTag(html, fallback = DEFAULT_LANGUAGE_TAG) {
  const langMatch = html.match(/<html[^>]+lang=["']([^"']+)["']/i)
  if (langMatch?.[1]) return cleanText(langMatch[1], fallback)

  const ogLocale = parseMetaTag(html, ['og:locale'])
  if (ogLocale) return ogLocale.replace('_', '-').toLowerCase()

  return fallback
}

function pickTitle(oembed, html, fallbackId) {
  return cleanText(
    oembed?.title ||
      parseMetaTag(html, ['og:title', 'twitter:title', 'title']) ||
      (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '') ||
      fallbackId,
    fallbackId,
  )
}

function pickDescription(oembed, html) {
  return cleanText(
    oembed?.description ||
      parseMetaTag(html, ['og:description', 'description', 'twitter:description']) ||
      '',
    '',
  )
}

function parseProviderSpecificData(sourceType, html) {
  if (sourceType === 'youtube') {
    const playerResponse = parseJsonFromHtml(
      html,
      /ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;\s*(?:var|let|const)?\s/si,
    )

    const videoDetails = playerResponse?.videoDetails || null
    return {
      title: videoDetails?.title ? cleanText(videoDetails.title) : '',
      description: videoDetails?.shortDescription ? cleanText(videoDetails.shortDescription) : '',
      durationMs: Number.isFinite(Number(videoDetails?.lengthSeconds)) ? Number(videoDetails.lengthSeconds) * 1000 : 0,
      channelName: videoDetails?.author ? cleanText(videoDetails.author) : '',
      thumbnails: Array.isArray(videoDetails?.thumbnail?.thumbnails) ? videoDetails.thumbnail.thumbnails : [],
    }
  }

  if (sourceType === 'tiktok') {
    const universalData = parseJsonFromHtml(
      html,
      /__UNIVERSAL_DATA_FOR_REHYDRATION__\s*=\s*(\{.*?\})\s*;\s*<\/script>/si,
    )
    const itemModule = universalData?.__DEFAULT_SCOPE__ || universalData || null
    const title = itemModule?.seo?.title || itemModule?.itemInfo?.itemStruct?.desc || ''
    const description = itemModule?.seo?.description || itemModule?.itemInfo?.itemStruct?.desc || ''
    const durationMs = Number.isFinite(Number(itemModule?.itemInfo?.itemStruct?.video?.duration))
      ? Number(itemModule.itemInfo.itemStruct.video.duration) * 1000
      : 0

    return {
      title: cleanText(title),
      description: cleanText(description),
      durationMs,
      channelName: cleanText(itemModule?.itemInfo?.itemStruct?.author?.uniqueId || ''),
      thumbnails: [],
    }
  }

  return { title: '', description: '', durationMs: 0, channelName: '', thumbnails: [] }
}

async function deriveDescriptorIds(metadata, options = {}) {
  const sourceRefHash = await digest32(metadata.normalizedUrl)
  const titleHash = await digest32(metadata.title)
  const descriptionHash = await digest32(metadata.description)
  const contentRoot = await digest32({
    sourceRefHash: bytesToHex(sourceRefHash),
    titleHash: bytesToHex(titleHash),
    descriptionHash: bytesToHex(descriptionHash),
    durationMs: metadata.durationMs,
    contentBytes: metadata.contentBytes.toString(),
    sourceType: metadata.sourceType,
  })
  const dasRoot = await digest32({
    contentRoot: bytesToHex(contentRoot),
    sourceType: metadata.sourceType,
    normalizedUrl: metadata.normalizedUrl,
  })
  const swarmTopic = await digest32({
    provider: metadata.provider,
    contentRoot: bytesToHex(contentRoot),
  })
  const descriptorId = await digest32({
    contentRoot: bytesToHex(contentRoot),
    dasRoot: bytesToHex(dasRoot),
    swarmTopic: bytesToHex(swarmTopic),
    normalizedUrl: metadata.normalizedUrl,
    sourceType: metadata.sourceType,
  })
  const proofSeed = await digest32({
    descriptorId: bytesToHex(descriptorId),
    title: metadata.title,
    durationMs: metadata.durationMs,
  })

  return {
    sourceRefHash,
    titleHash,
    descriptionHash,
    contentRoot,
    dasRoot,
    swarmTopic,
    descriptorId,
    proofSeed,
  }
}

function sourceTypeToCode(sourceType) {
  if (sourceType === 'youtube') return 0
  if (sourceType === 'tiktok') return 1
  if (sourceType === 'directUrl') return 2
  return 3
}

function buildFlags(metadata, published = false, seeded = false, quarantined = false) {
  let flags = 0
  if (published) flags |= 1 << 0
  if (metadata.allowPublicSourceUrl) flags |= 1 << 0
  if (metadata.allowDescriptorPublish) flags |= 1 << 0
  flags |= 1 << 2
  if (seeded) flags |= 1 << 3
  if (quarantined) flags |= 1 << 4
  flags |= 1 << 6
  return flags
}

export async function extractMirrorMetadata(inputUrl, options = {}) {
  const normalized = normalizeMirrorUrl(inputUrl)
  const fetchImpl = options.fetch || globalThis.fetch

  if (typeof fetchImpl !== 'function') {
    throw new Error('extractMirrorMetadata requires a fetch implementation or global fetch')
  }

  const timeoutMs = safeNumber(options.timeoutMs, 15000)
  const oembed = await fetchOEmbed(fetchImpl, normalized.normalizedUrl, normalized.provider, timeoutMs)
  const { response, body, contentBytes: responseContentBytes, error } = await extractFinalResponseInfo(fetchImpl, normalized.normalizedUrl, timeoutMs)
  const html = body || ''
  const providerSpecific = parseProviderSpecificData(normalized.sourceType, html)
  const finalUrl = response?.url || normalized.normalizedUrl
  const parsedUrl = new URL(finalUrl)
  const fallbackId = parsedUrl.pathname.split('/').filter(Boolean).pop() || parsedUrl.hostname

  const title = pickTitle(providerSpecific.title ? { title: providerSpecific.title } : oembed, html, fallbackId)
  const description = pickDescription(providerSpecific.description ? { description: providerSpecific.description } : oembed, html)
  const durationMs = providerSpecific.durationMs || extractDurationMsFromHtml(html)
  const contentBytes = responseContentBytes ?? DEFAULT_CONTENT_BYTES_ESTIMATE
  const languageTag = inferLanguageTag(html)

  return {
    inputUrl,
    sourceType: normalized.sourceType,
    provider: normalized.provider,
    normalizedUrl: normalized.normalizedUrl,
    finalUrl,
    title,
    description,
    durationMs,
    contentBytes,
    languageTag,
    html,
    headers: response?.headers || null,
    oembed,
    error: error || null,
    channelName: providerSpecific.channelName || oembed?.author_name || '',
  }
}

export async function buildVideoDescriptor(metadata, options = {}) {
  const now = safeBigInt(options.now, BigInt(Date.now()))
  const retentionMs = safeBigInt(options.retentionMs, BigInt(DEFAULT_RETENTION_MS))
  const proofWindowMs = safeBigInt(options.proofWindowMs, BigInt(DEFAULT_PROOF_WINDOW_MS))
  const ids = await deriveDescriptorIds(metadata, options)

  const descriptor = {
    version: 1,
    descriptorId: ids.descriptorId,
    contentRoot: ids.contentRoot,
    dasRoot: ids.dasRoot,
    swarmTopic: ids.swarmTopic,
    sourceRefHash: ids.sourceRefHash,
    sourceType: sourceTypeToCode(metadata.sourceType),
    mirrorOrigin: 1,
    contentBytes: safeBigInt(metadata.contentBytes, DEFAULT_CONTENT_BYTES_ESTIMATE),
    segmentCount: Math.max(1, Math.ceil(Math.max(1, Number(safeBigInt(metadata.durationMs, 0n))) / 10000)),
    durationMs: safeBigInt(metadata.durationMs, 0n),
    publishAt: now,
    expiresAt: now + retentionMs,
    availabilityEpoch: Number((now / (proofWindowMs || 1n)) & 0xffffffffn),
    publisherIdentity: ensureFixed32(options.publisherIdentity || options.signer || ZERO_32),
    parentDescriptorId: ensureFixed32(options.parentDescriptorId || ZERO_32),
    titleHash: ids.titleHash,
    descriptionHash: ids.descriptionHash,
    languageTag: cleanText(metadata.languageTag || DEFAULT_LANGUAGE_TAG, DEFAULT_LANGUAGE_TAG),
    codecProfile: safeNumber(options.codecProfile, 0),
    flags: buildFlags(metadata, Boolean(options.allowDescriptorPublish || options.allowPublicSourceUrl), Boolean(options.seeded), Boolean(options.quarantined)),
    signer: ensureFixed32(options.signer || options.publisherIdentity || ZERO_32),
    signature: ensureFixed64(options.signature || ZERO_64),
  }

  return {
    descriptor,
    ids,
    metadata,
    isSigned: Boolean(options.signature),
  }
}

export async function fetchMirrorDescriptor(inputUrl, options = {}) {
  const metadata = await extractMirrorMetadata(inputUrl, options)
  const descriptorDraft = await buildVideoDescriptor(metadata, options)
  return {
    ...metadata,
    ...descriptorDraft,
  }
}

export function createMirrorFetcher(options = {}) {
  return {
    normalizeMirrorUrl,
    extractMirrorMetadata: (inputUrl, nextOptions = {}) => extractMirrorMetadata(inputUrl, { ...options, ...nextOptions }),
    buildVideoDescriptor: (metadata, nextOptions = {}) => buildVideoDescriptor(metadata, { ...options, ...nextOptions }),
    fetchMirrorDescriptor: (inputUrl, nextOptions = {}) => fetchMirrorDescriptor(inputUrl, { ...options, ...nextOptions }),
  }
}

export const MirrorFetcher = {
  normalizeMirrorUrl,
  extractMirrorMetadata,
  buildVideoDescriptor,
  fetchMirrorDescriptor,
  createMirrorFetcher,
}
