const WHITESPACE_RE = /\s+/g

function normalizeText(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
    .normalize('NFC')
    .replace(WHITESPACE_RE, ' ')
    .trim()
  return text
}

function flattenTextSource(value, out = []) {
  if (value === null || value === undefined) return out

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = normalizeText(value)
    if (text) out.push(text)
    return out
  }

  if (Array.isArray(value)) {
    for (const item of value) flattenTextSource(item, out)
    return out
  }

  if (typeof value === 'object') {
    const preferredFields = [
      value.text,
      value.body,
      value.content,
      value.description,
      value.transcript,
      value.caption,
      value.cue,
      value.subtitle,
      value.line,
      value.value,
    ]
    let found = false
    for (const field of preferredFields) {
      if (field !== null && field !== undefined) {
        const text = normalizeText(field)
        if (text) {
          out.push(text)
          found = true
        }
      }
    }

    if (!found) {
      for (const field of Object.values(value)) flattenTextSource(field, out)
    }
  }

  return out
}

function uniqueTextParts(parts) {
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const text = normalizeText(part)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function collectEnvelopeTextSources(input = {}) {
  const subtitles = flattenTextSource(input.subtitles ?? input.subtitleText ?? input.transcript ?? input.captions)
  const comments = flattenTextSource(input.comments ?? input.commentTexts ?? input.commentBodies)
  const tags = flattenTextSource(input.tags ?? input.categories)

  return {
    title: normalizeText(input.title),
    description: normalizeText(input.description),
    subtitles: uniqueTextParts(subtitles),
    comments: uniqueTextParts(comments),
    tags: uniqueTextParts(tags),
  }
}

export function buildMetadataEnvelope(video = {}, extras = {}) {
  const source = collectEnvelopeTextSources({
    title: extras.title ?? video.title,
    description: extras.description ?? video.description,
    subtitles: extras.subtitles ?? video.subtitles ?? video.subtitleText ?? video.transcript ?? video.captions,
    comments: extras.comments ?? video.comments,
    tags: extras.tags ?? video.tags,
    categories: extras.categories ?? video.categories ?? video.category,
  })

  const searchText = uniqueTextParts([
    source.title,
    source.description,
    ...source.subtitles,
    ...source.comments,
    ...source.tags,
  ]).join(' ')

  const videoId = normalizeText(extras.videoId ?? video.id)
  const channelKey = normalizeText(extras.channelKey ?? video.channelKey)
  const publicBeeKey = normalizeText(extras.publicBeeKey ?? video.publicBeeKey)

  return {
    envelopeType: 'video-search',
    schemaVersion: 1,
    videoId,
    channelKey: channelKey || null,
    publicBeeKey: publicBeeKey || null,
    title: source.title,
    description: source.description,
    subtitles: source.subtitles,
    comments: source.comments,
    tags: source.tags,
    searchText,
    sourceFields: {
      title: Boolean(source.title),
      description: Boolean(source.description),
      subtitles: source.subtitles.length > 0,
      comments: source.comments.length > 0,
      tags: source.tags.length > 0,
    },
    updatedAt: Number.isFinite(Number(extras.updatedAt ?? video.updatedAt)) ? Number(extras.updatedAt ?? video.updatedAt) : null,
    indexedAt: Date.now(),
  }
}

export function buildSearchText(envelope = {}) {
  return uniqueTextParts([
    envelope?.title,
    envelope?.description,
    ...(Array.isArray(envelope?.subtitles) ? envelope.subtitles : []),
    ...(Array.isArray(envelope?.comments) ? envelope.comments : []),
    ...(Array.isArray(envelope?.tags) ? envelope.tags : []),
    envelope?.searchText,
  ]).join(' ')
}
