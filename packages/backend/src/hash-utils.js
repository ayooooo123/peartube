function canonicalize(value) {
  if (value === null || value === undefined) return String(value)

  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']'
  }

  if (value instanceof Date) {
    return 'date:' + value.toISOString()
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}'
  }

  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}

export function hashValue(value) {
  const input = canonicalize(value)
  let hash = 0x811c9dc5

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function hashPreviewVideos(videos) {
  const normalized = Array.isArray(videos)
    ? videos.map((video) => ({
        id: video?.id ?? null,
        title: video?.title ?? null,
        uploadedAt: Number(video?.uploadedAt || 0) || 0,
        duration: Number(video?.duration || 0) || 0,
        thumbnail: video?.thumbnail ?? null,
        blobId: video?.blobId ?? null,
        blobsCoreKey: video?.blobsCoreKey ?? null,
        mimeType: video?.mimeType ?? null,
        availability: video?.availability ?? null,
        thumbnailBlobId: video?.thumbnailBlobId ?? null,
        thumbnailBlobsCoreKey: video?.thumbnailBlobsCoreKey ?? null,
        thumbnailMimeType: video?.thumbnailMimeType ?? null,
      }))
    : []

  return hashValue(normalized)
}

export function hashFeedEntries(entries) {
  const normalized = Array.isArray(entries)
    ? entries.map((entry) => ({
        driveKey: entry?.driveKey ?? null,
        publicBeeKey: entry?.publicBeeKey ?? null,
        channelName: entry?.channelName ?? null,
        videoCount: Number(entry?.videoCount || 0) || 0,
        manifestUpdatedAt: Number(entry?.manifestUpdatedAt || 0) || 0,
        version: Number(entry?.version || 0) || 0,
        previewVideosHash: entry?.previewVideosHash ?? null,
      }))
    : []

  return hashValue(normalized)
}
