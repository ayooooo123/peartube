export function getFeedThumbnailResolveKey(feedVideos = []) {
  return feedVideos.map((video) => {
    const channelKey = video?.channelKey || video?.driveKey || ''
    const id = video?.id || ''
    const hasThumbnailUrl = video?.thumbnailUrl ? '1' : '0'
    const thumbnailBlobId = video?.thumbnailBlobId || ''
    const thumbnailBlobsCoreKey = video?.thumbnailBlobsCoreKey || ''

    return `${channelKey}:${id}:${hasThumbnailUrl}:${thumbnailBlobId}:${thumbnailBlobsCoreKey}`
  }).join(',')
}
